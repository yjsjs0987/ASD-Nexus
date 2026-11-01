use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use serde::Deserialize;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use which::which;

#[derive(Debug, Deserialize)]
struct ReadyMessage {
    #[serde(rename = "type")]
    msg_type: String,
    port: u16,
    token: String,
}

struct ServerProcess {
    child: Option<Child>,
}

impl ServerProcess {
    fn new() -> Self {
        Self { child: None }
    }

    fn spawn(&mut self, server_js_path: &Path) -> Result<ReadyMessage> {
        let node_exe = which("node").context("Node.js 22 이상이 필요합니다. PATH에서 node를 찾을 수 없습니다.")?;

        let mut cmd = Command::new(&node_exe);
        cmd.arg(server_js_path)
            .arg("--port")
            .arg("0")
            .arg("--no-open")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let mut child = cmd.spawn().context("Node.js 서버 프로세스 시작 실패")?;

        let stdout = child.stdout.take().context("stdout 캡처 실패")?;
        let reader = BufReader::new(stdout);

        let mut ready_msg: Option<ReadyMessage> = None;

        for line in reader.lines() {
            let line = line.context("stdout 읽기 실패")?;
            if line.trim().is_empty() {
                continue;
            }

            if let Ok(msg) = serde_json::from_str::<ReadyMessage>(&line) {
                if msg.msg_type == "asd-gui-ready" {
                    ready_msg = Some(msg);
                    break;
                }
            }
        }

        let ready_msg = ready_msg.context("서버 ready 메시지 파싱 실패: JSON 라인을 찾을 수 없음")?;

        self.child = Some(child);
        Ok(ready_msg)
    }

    fn kill(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for ServerProcess {
    fn drop(&mut self) {
        self.kill();
    }
}

fn find_server_js() -> Result<PathBuf> {
    let exe_path = std::env::current_exe().context("현재 실행 파일 경로 가져오기 실패")?;
    let exe_dir = exe_path.parent().context("실행 파일 디렉토리 가져오기 실패")?;

    let candidate = exe_dir.join("dist").join("server").join("server.js");
    if candidate.exists() {
        return Ok(candidate);
    }

    let candidate = exe_dir.join("..").join("dist").join("server").join("server.js");
    if candidate.exists() {
        return candidate.canonicalize().context("server.js 경로 정규화 실패");
    }

    anyhow::bail!(
        "dist/server/server.js를 찾을 수 없습니다. 빌드된 서버 파일이 exe와 함께 배포되어야 합니다."
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let server_js_path = find_server_js()?;

            let mut server_process = ServerProcess::new();
            let ready_msg = server_process.spawn(&server_js_path)?;

            let url = format!(
                "http://127.0.0.1:{}/?token={}",
                ready_msg.port, ready_msg.token
            )
            .parse()
            .context("URL 파싱 실패")?;

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("ASD GUI")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 768.0)
                .build()?;

            let app_handle = app.handle().clone();
            let server_process = Arc::new(Mutex::new(server_process));
            let server_process_clone = server_process.clone();

            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Ok(mut sp) = server_process_clone.lock() {
                        sp.kill();
                    }
                    app_handle.exit(0);
                }
            });

            app.manage(server_process);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tauri 애플리케이션 실행 실패");
}

fn main() {
    run();
}
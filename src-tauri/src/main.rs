#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
        let node_exe = which("node")
            .context("Node.js 22 이상이 필요합니다. PATH에서 node를 찾을 수 없습니다.")?;

        let mut cmd = Command::new(&node_exe);
        cmd.arg(server_js_path)
            .arg("--port")
            .arg("0")
            .arg("--no-open");

        if let Ok(home_dir) = std::env::var("ASD_GUI_HOME") {
            if !home_dir.trim().is_empty() {
                cmd.arg("--home").arg(home_dir);
            }
        }

        cmd.stdout(Stdio::piped()).stderr(Stdio::inherit());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let mut child = cmd.spawn().context("Node.js 서버 프로세스 시작 실패")?;

        let stdout = child.stdout.take().context("stdout 캡처 실패")?;
        let mut reader = BufReader::new(stdout);

        let mut ready_msg: Option<ReadyMessage> = None;

        for line in reader.by_ref().lines() {
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

        let ready_msg =
            ready_msg.context("서버 ready 메시지 파싱 실패: JSON 라인을 찾을 수 없음")?;

        // Node 서버가 이후 stdout에 로그를 쓸 때 EPIPE가 발생하지 않도록 파이프를 열어 두고 비운다
        std::thread::spawn(move || {
            for _ in reader.lines() {}
        });

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
    let mut search_roots: Vec<PathBuf> = Vec::new();

    if let Ok(exe_path) = std::env::current_exe() {
        let mut cur = exe_path.parent().map(|p| p.to_path_buf());
        for _ in 0..6 {
            if let Some(dir) = cur {
                search_roots.push(dir.clone());
                cur = dir.parent().map(|p| p.to_path_buf());
            } else {
                break;
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        let mut cur = Some(cwd);
        for _ in 0..4 {
            if let Some(dir) = cur {
                search_roots.push(dir.clone());
                cur = dir.parent().map(|p| p.to_path_buf());
            } else {
                break;
            }
        }
    }

    for root in search_roots {
        let candidate = root.join("dist").join("server").join("server.js");
        if candidate.exists() {
            let s = candidate.to_string_lossy();
            if let Some(stripped) = s.strip_prefix(r"\\?\") {
                return Ok(PathBuf::from(stripped));
            }
            return Ok(candidate);
        }
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

            let mut win_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("ASD GUI — Agent Swarm Director")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 768.0)
                .center()
                .visible(true);
            if let Some(default_icon) = app.default_window_icon().cloned() {
                win_builder = win_builder.icon(default_icon)?;
            }
            let window = win_builder.build()?;

            println!(
                "{{\"type\":\"asd-tauri-ready\",\"port\":{},\"token\":\"{}\"}}",
                ready_msg.port, ready_msg.token
            );
            let _ = std::io::stdout().flush();

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

            if std::env::var("ASD_TAURI_SMOKE_TEST").ok().as_deref() == Some("1") {
                let sp_smoke = server_process.clone();
                let handle_smoke = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(2500));
                    if let Ok(mut sp) = sp_smoke.lock() {
                        sp.kill();
                    }
                    handle_smoke.exit(0);
                });
            }

            app.manage(server_process);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tauri 애플리케이션 실행 실패");
}

fn main() {
    run();
}

# ASD GUI (`asd-gui`)

[**Agent Swarm Director (`agent-swarm-director`)**](https://github.com/yjsjs0987/agent-swarm-director)를 위한 **멀티에이전트 오케스트레이션 콘솔 및 다중 하네스 세션 관리 GUI**입니다.  
웹 브라우저 모드(Local Web Dashboard)와 **Tauri 2 네이티브 데스크톱 앱(`.exe`)** 모드를 동시에 지원하며, 5대 AI 코딩 하네스(`claude-code`, `opencode`, `codex`, `antigravity`, `cursor`)의 세션·플랜·서브에이전트·워크트리 Diff·라우팅·터미널을 한 화면에서 통합 제어합니다.

---

## ✨ 주요 특징 (Key Features)

1. **Elysium 리퀴드 글라스 3컬럼 콘솔 UI**
   - **왼쪽 도크 & 세션 레일 (`SessionRail`)**: 최근 프로젝트 탐색, 세션 검색·생성(`Ctrl+N`), 전경(Foreground) 세션 전환, 다크/라이트 테마 전환을 지원합니다.
   - **중앙 작업 공간 (`CenterPanel`)**:
     - **대화 탭 (`Thread` & `Composer`)**: 드라이버 프롬프트 전송, 다중 모델 블라인드 토론(`/debate`), 릴레이 리본 타임라인, 실시간 스트리밍 출력, 하네스 트랜스크립트 조회 및 CLI 재개 명령어 복사를 제공합니다.
     - **PLAN 탭 (`PlanBoard`)**: `.asd/PLAN.md` 실시간 편집·저장(`baseVersion` 낙관적 잠금 충돌 감지), SQLite 동기화(`sync_from_md`), 턴(Wave) 단위 디스패치(`parallel_spawn` / `claim_only`), 상태별 태스크 보드를 제공합니다.
     - **Routing 탭 (`RoutingConfigPanel`)**: 5개 에이전트 역할(`agents`)과 8개 작업 카테고리(`categories`)의 하네스·모델 매핑 및 폴백 체인을 편집하여 `.asd/routing.json`에 저장합니다.
   - **오른쪽 도크 & 서브에이전트 인스펙터 (`SubagentInspector`)**: 태스크 카드 클릭 시 즉시 연동되며, 서브에이전트 실시간 로그 테일링(`subscribe_log`)과 제어 액션(`approve`, `reject`, `abort`, `cleanup`)을 수행합니다.

2. **워크트리 Diff 모달 & 충돌 해결 (`WorktreeDiffModal`)**
   - 태스크별 Git 워크트리 변경 파일 및 Unified Diff(`working` / `committed` 모드)를 시각적으로 대조합니다.
   - 병합 충돌(`merge_conflict`) 상태인 태스크에 대해 **병합 승인(`approve`)**, **변경 거절(`reject`)**, **AI 자동 충돌 해결(`resolveConflict`)**을 지원합니다.

3. **내장 xterm.js 멀티탭 PTY 터미널 (`TerminalPane`)**
   - WebSocket PTY 프로토콜(`pty_spawn`, `pty_input`, `pty_resize`, `pty_kill`)을 통해 프로젝트 루트 또는 특정 하네스 드라이버 세션을 내장 터미널 탭으로 즉시 연결합니다.
   - `node-pty` 미설치 환경에서도 자동으로 폴백 모드로 동작합니다.

4. **드라이버 상태 바 (`DriverBar`)**
   - 현재 세션에 연결된 드라이버의 하네스·모델·부착 상태를 표시하고, 런타임 중 다른 하네스/모델로 드라이버를 교체(`attachDriver`)하거나 실행 중인 드라이버를 강제 중단(`cancelDriver`)할 수 있습니다.

5. **보안 및 단일 진실 공급원(SSOT) 아키텍처**
   - **낙관적 갱신 배제**: 모든 상태 변경은 REST API 호출 후 서버의 `StateWatcher`가 브로드캐스트하는 WebSocket `state_updated` 스냅샷으로만 확정됩니다.
   - **로컬 보안 가드**: 1회성 토큰 교환(`/?token=<hex>` → `HttpOnly; SameSite=Strict` 쿠키 발급)과 `Host`/`Origin` 헤더 검증으로 로컬 서버에 대한 외부 오리진 접근(CSRF/DNS Rebinding)을 차단합니다.

---

## 🛠️ 사전 요구 사항 (Prerequisites)

- **Node.js**: `v22.13.0` 이상 (권장: Node.js 22 LTS 또는 24+)
- **npm**: Node.js 기본 포함 패키지 매니저
- **Agent Swarm Director (`agent-swarm-director`) 관련 안내**:
  - **별도 로컬 폴더 불필요**: `package.json`에 `"agent-swarm-director": "github:yjsjs0987/agent-swarm-director"`로 설정되어 있어 `npm install` 시 GitHub 저장소에서 자동으로 설치됩니다.
  - **실행 시(Runtime) 단독 동작**: `npm run build:server` 실행 시 `esbuild`가 [`agent-swarm-director`](https://github.com/yjsjs0987/agent-swarm-director) 코어 엔진 전체를 `dist/server/server.js` 단일 번들 파일 안에 내장(인라인 번들링)하므로, 빌드 후에는 외부 코어 폴더 없이 독립 실행됩니다.
- **(선택) Tauri 데스크톱 `.exe` 빌드 시**:
  - Rust 툴체인 (`rustup`, `cargo` — `stable-x86_64-pc-windows-msvc`)
  - Microsoft Visual Studio 2022 Build Tools (`Desktop development with C++` / `vcvars64.bat`)
  - Windows WebView2 런타임 (Windows 10/11 기본 내장)

---

## 📦 설치 및 빌드 방법 (Build Guide)

### 1. 의존성 설치

```powershell
npm install
```

### 2. 서버 및 웹 프론트엔드 전체 빌드

Node.js 백엔드 번들(`dist/server/server.js`)과 Vite 프론트엔드 정적 에셋(`dist/web/`)을 함께 빌드합니다.

```powershell
npm run build
```

개별 빌드가 필요한 경우 아래 명령어를 사용할 수 있습니다:

```powershell
# 백엔드 서버만 번들링 (esbuild -> dist/server/server.js)
npm run build:server

# 웹 프론트엔드만 빌드 (vite build -> dist/web/)
npm run build:web
```

### 3. Tauri 2 데스크톱 `.exe` 빌드 (Windows)

`asd-gui`의 Tauri 래퍼(`src-tauri`)는 Node.js 런타임을 내장하지 않고, 실행 시 시스템 `PATH`의 `node`를 통해 `dist/server/server.js --port 0 --no-open`을 자식 프로세스로 스폰한 뒤 WebView2 창을 띄웁니다.

먼저 웹/서버 번들을 빌드한 뒤(`npm run build`), MSVC 환경 변수를 로드하는 배치 스크립트로 `.exe`를 빌드합니다:

```powershell
# 1) 서버 및 웹 에셋 빌드
npm run build

# 2) 디버그 실행 파일 빌드 (출력: src-tauri\target\debug\asd-gui.exe)
cmd /c src-tauri\cargo-build.bat

# 3) 릴리스 실행 파일 빌드 (출력: src-tauri\target\release\asd-gui.exe)
cmd /c src-tauri\cargo-build.bat --release
```

> **참고**: 타입/컴파일 빠른 점검만 수행하려면 `cmd /c src-tauri\cargo-check.bat`를 실행하세요.

---

## 🚀 실행 및 사용 방법 (Usage Guide)

### 방법 A: 로컬 웹 서버 + 브라우저 모드로 실행

가장 간편한 실행 방식으로, 서버 기동과 함께 기본 웹 브라우저가 인증 토큰 URL(`http://127.0.0.1:4173/?token=...`)로 자동 실행됩니다.

```powershell
npm start
```

주요 CLI 옵션(`dist/server/server.js`):
```powershell
# 포트 지정 및 브라우저 자동 열기 비활성화
node dist/server/server.js --port 4173 --no-open

# 임의 빈 포트(0) 자동 할당 및 커스텀 ASD 상태 홈 디렉토리 지정
node dist/server/server.js --port 0 --home "C:\path\to\custom-home"
```

### 방법 B: Tauri 데스크톱 앱(`.exe`)으로 실행

빌드된 `asd-gui.exe`를 직접 실행하면 백그라운드(콘솔 창 숨김)로 Node 서버를 자동 스폰하고 `1440×900` 데스크톱 창을 엽니다. 창을 닫으면 자식 Node 서버 프로세스도 자동으로 정리됩니다.

```powershell
.\src-tauri\target\debug\asd-gui.exe
# 또는 릴리스 빌드한 경우
.\src-tauri\target\release\asd-gui.exe
```

> **주의**: `.exe`를 다른 경로로 복사해 배포할 때는 실행 파일과 같은 폴더(또는 상위 폴더)에 `dist/server/server.js`와 `dist/web/`이 함께 위치해야 합니다.

### 방법 C: 프론트엔드 개발 서버 모드 (HMR)

UI 수정 시 실시간 반영(Hot Module Replacement)이 필요하다면 두 터미널에서 각각 백엔드와 Vite 개발 서버를 실행합니다:

```powershell
# 터미널 1: 백엔드 서버 (포트 4173, 개발 모드)
$env:ASD_GUI_DEV="1"
node dist/server/server.js --port 4173 --no-open

# 터미널 2: Vite 개발 서버 (/api 및 /ws 요청을 127.0.0.1:4173으로 프록시)
npm run dev
```

---

## 🧭 기본 워크플로우 (Step-by-Step)

1. **프로젝트 열기**
   - 첫 화면(`ASD 콘솔`)에서 최근 프로젝트 카드를 클릭하거나, **폴더 찾아보기** 버튼으로 로컬 Git 저장소 경로를 선택한 뒤 **폴더 열기**를 클릭합니다.
2. **세션 선택 또는 새 세션 생성**
   - 왼쪽 세션 레일에서 기존 세션을 클릭해 전경(Foreground)으로 전환하거나, 상단 `+` 버튼(`Ctrl+N`)을 눌러 메인 드라이버 하네스(`Claude Code`, `OpenCode`, `Codex`, `Antigravity`, `Cursor`)와 메모를 입력해 새 세션을 생성합니다.
3. **드라이버 프롬프트 & 블라인드 토론 (`대화` 탭)**
   - 하단 입력창(`Composer`)에 지시사항을 입력하고 전송하면 메인 드라이버가 실행되며 실시간 출력과 과정 타임라인이 카드 형태로 스트리밍됩니다.
   - `/debate` 슬래시 명령 또는 **토론** 모드를 사용해 다중 모델 블라인드 토론을 시작할 수 있습니다.
   - 상단 `DriverBar`에서 현재 세션의 드라이버 하네스/모델을 즉시 변경하거나 **CLI 터미널 열기**로 대화형 세션을 이어받을 수 있습니다.
4. **플랜 편집 및 턴 디스패치 (`PLAN` 탭)**
   - `.asd/PLAN.md` 에디터에서 마크다운 플랜을 직접 수정하고 **저장** 또는 **SQLite 동기화**를 수행합니다.
   - 턴(Wave) 번호와 실행 모드(`병렬 스폰` / `클레임 전용`)를 선택한 뒤 **턴 배치 실행**을 클릭합니다.
   - 하단 태스크 보드에서 각 태스크 카드를 클릭하면 오른쪽 **서브에이전트 인스펙터**가 열리며 실시간 서브에이전트 로그와 제어 버튼이 표시됩니다.
5. **워크트리 Diff 확인 및 병합 (`Diff 보기`)**
   - 상단 헤더의 **Diff 보기** 또는 오른쪽 도크의 Diff 아이콘을 클릭하면 태스크별 변경 파일 및 Unified Diff를 확인할 수 있습니다.
   - `merge_conflict` 발생 시 모달 하단에서 **AI 자동 해결**, **병합 승인**, **변경 거절**을 수행할 수 있습니다.
6. **라우팅 정책 설정 (`Routing` 탭)**
   - 에이전트 역할(5종) 및 카테고리(8종)별 기본 하네스·모델을 지정하고 **라우팅 저장**을 클릭하면 프로젝트의 `.asd/routing.json`에 즉시 반영됩니다.

---

## 🧪 테스트 및 검증 (Testing & Verification)

### 1. 서버 통합 및 E2E 단위 테스트 (14개 스위트)
보안/인증(G0), 프로젝트·세션·StateWatcher(G1), 디스패치·낙관적 잠금·라우팅(G2), PTY 매니저·폴백(G3), 병합 충돌 해결(G4), 멀티 시나리오 E2E(G5)를 검증합니다.
```powershell
npm test
```

### 2. Chrome CDP 실측 및 UI 회귀 검증 (`1440×900`)
실제 `dist/server/server.js`와 Headless Chrome/Edge(CDP)를 띄워 3컬럼 레이아웃 폭, 폴더 탐색기, 드라이버 바, PLAN 탭 및 태스크 카드 인스펙터 연동, Routing 탭, Diff 모달, xterm.js 터미널 마운트, 콘솔 에러 0건을 자동 검증합니다.
```powershell
node tests/chrome-ui-regression.mjs
```

### 3. Tauri `.exe` 기동 및 서버 스폰 스모크 테스트
빌드된 `src-tauri/target/debug/asd-gui.exe`를 실제로 실행하여 Node 서버 스폰, `asd-tauri-ready` 수신, HTTP 200 응답, 종료 시 자식 서버 프로세스 자동 정리까지 검증합니다.
```powershell
node src-tauri/smoke-test.mjs
```

---

## 📁 디렉토리 구조 (Project Structure)

```text
asd-gui/
├── scripts/
│   └── build-server.mjs          # esbuild 기반 Node 백엔드 번들러 (dist/server/server.js 생성)
├── src/
│   ├── shared/
│   │   └── protocol.ts           # REST API 24종 및 WebSocket 메시지 타입 계약
│   ├── server/
│   │   ├── index.ts              # HTTP 정적 서빙, REST 라우터, WebSocket 서버 엔트리
│   │   ├── auth.ts               # 토큰/쿠키 인증 및 Host/Origin 보안 검증
│   │   ├── core-api.ts           # agent-swarm-director 코어 API 래퍼
│   │   ├── jobs/                 # 비동기 작업(dispatch, debate, driver_turn 등) 레지스트리
│   │   ├── pty/                  # node-pty 멀티탭 관리 및 폴백 매니저
│   │   ├── routes/               # projects, sessions, drivers, tasks, transcripts 라우트
│   │   └── watcher/              # SQLite/PLAN.md/로그 파일 감시 및 디바운스 브로드캐스트
│   └── web/
│       ├── App.tsx               # 3컬럼 메인 콘솔 셸 및 프로젝트/세션 화면 전환
│       ├── store.tsx             # EnrichedSnapshot 기반 전역 상태 스토어 (useApp)
│       ├── api.ts                # 24개 REST 엔드포인트 fetch 클라이언트
│       ├── ws.ts                 # 자동 재연결 WebSocket 클라이언트
│       ├── events.ts             # WS 이벤트 구독 React 훅 모음
│       ├── tokens.css            # 디자인 토큰 및 다크/라이트 팔레트 변수
│       ├── styles.css            # Elysium 리퀴드 글라스 + ASD 콘솔(.asd-*) 스타일시트
│       └── components/           # UI 컴포넌트
│           ├── SessionRail.tsx       # 왼쪽 도크 및 세션 슬라이드 패널
│           ├── Thread.tsx            # 드라이버 실행 리본 및 스트리밍 결과 카드
│           ├── Composer.tsx          # 프롬프트/토론 입력 캡슐 및 트랜스크립트/재개 팝업
│           ├── PlanBoard.tsx         # PLAN.md 에디터, 턴 디스패치 바, 태스크 카드 보드
│           ├── SubagentInspector.tsx # 오른쪽 서브에이전트 상세/실시간 로그/제어 패널
│           ├── TerminalPane.tsx      # xterm.js 멀티탭 PTY 터미널
│           ├── WorktreeDiffModal.tsx # 워크트리 Unified Diff 및 충돌 해결 모달
│           ├── RoutingConfigPanel.tsx# 에이전트 역할·카테고리 라우팅 편집기
│           └── DriverBar.tsx         # 세션 드라이버 부착/전환/중단 상태 바
├── src-tauri/
│   ├── src/main.rs               # Node 서버 자식 프로세스 스폰 및 WebView2 창 관리
│   ├── tauri.conf.json           # Tauri 2 설정 및 아이콘 번들 정의
│   ├── cargo-check.bat           # MSVC 환경 로드 + cargo check
│   ├── cargo-build.bat           # MSVC 환경 로드 + cargo build
│   └── smoke-test.mjs            # Tauri exe 실기동 스모크 테스트 스크립트
└── tests/
    ├── server/                   # G0 ~ G5 백엔드 단위/통합 테스트
    └── chrome-ui-regression.mjs  # Headless Chrome CDP 기반 1440x900 UI 회귀 테스트
```

---

## 📄 라이선스 (License)

[Functional Source License, Version 1.1, Apache 2.0 Future License (FSL-1.1-ALv2)](./LICENSE) © 2026 yjsjs0987

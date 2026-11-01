// T1.1 임시 자리표시자 — 이식한 셸 조각(도크·세션 패널·입자 배경·확인 창)이 컴파일·렌더되는지만 확인한다.
// T3.1이 Elysium App.tsx 구조를 ASD 콘솔로 완성한다(프로젝트 열기/세션 생성/포그라운드 전환/메모).
import { useCallback, useState } from "react";
import { useApp } from "./store";
import SessionPanel, { Dock } from "./components/SessionRail";
import ParticleOrb from "./components/ParticleOrb";
import Segmented from "./components/Segmented";
import Markdown from "./components/Markdown";
import ConfirmDialog from "./components/ConfirmDialog";
import { GlassDefs, useGlassLight, useLiquidRefraction } from "./lib/glass";

const PANEL_WIDE = 1560;

export default function App() {
  const { foregroundSessionId } = useApp();
  useGlassLight();
  useLiquidRefraction();
  const [panel, setPanel] = useState(() => window.innerWidth >= PANEL_WIDE);
  const togglePanel = useCallback(() => setPanel((p) => !p), []);
  // 세션 화면인지 새 세션(첫 화면)인지만 구분 — 실제 콘텐츠는 T3.1/T4.1이 채운다.
  const inSession = foregroundSessionId != null;

  return (
    <div className={`app ${panel ? "panel-open" : ""}`}>
      <GlassDefs />
      <ParticleOrb mode={inSession ? "idle" : "idle"} />
      <Dock panelOpen={panel} onTogglePanel={togglePanel} />
      <SessionPanel open={panel} onPicked={() => window.innerWidth < PANEL_WIDE && setPanel(false)} />
      <main className="main">
        {/* 컴파일 확인용 표본: 이식한 Segmented/Markdown이 빌드에 닿도록 렌더한다(T3.1에서 교체). */}
        <div style={{ maxWidth: 640, margin: "48px auto", display: "grid", gap: 16 }}>
          <Segmented
            label="테마 예시"
            value="a"
            options={[
              { value: "a", label: "가" },
              { value: "b", label: "나" },
            ]}
            onChange={() => {}}
          />
          <Markdown text="**ASD GUI** — 셸 이식 확인용 자리표시자입니다." />
        </div>
      </main>
      <ConfirmDialog />
    </div>
  );
}

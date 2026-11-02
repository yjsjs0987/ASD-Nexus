// T4.1 — 드라이버 프롬프트 입력(Composer): 일반 대화(chat) · 계획 작성(plan) · 적대적 토론(debate)
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import * as api from "../api.ts";
import { useApp, type HarnessId } from "../store";
import { ChevronIcon, CopyIcon, SendIcon, StopIcon } from "./Icons";

export default function Composer() {
  const app = useApp();
  const fgId = app.foregroundSessionId;
  const baseSessionId = useMemo(() => {
    if (!fgId) return null;
    const idx = fgId.indexOf("::");
    return idx !== -1 ? fgId.slice(0, idx) : fgId;
  }, [fgId]);
  const projectRoot = app.projectRoot;
  const activeCli = app.activeCliSession;
  const fg =
    app.snapshot?.sessions.find((s) => s.session_id === fgId) ??
    app.snapshot?.sessions.find((s) => s.session_id === baseSessionId) ??
    null;
  const job = app.liveJob;
  const running = !!(
    job &&
    !job.finished &&
    (job.sessionId === fgId || job.sessionId === baseSessionId)
  );

  const [text, setText] = useState("");
  const [mode, setMode] = useState<"chat" | "plan" | "debate">("chat");
  const [sending, setSending] = useState(false);
  const [resume, setResume] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Resolve the currently selected/active driver or CLI session so "재개 명령" always matches what is shown in Thread
  const resolvedTarget = useMemo(() => {
    if (activeCli) {
      const h: HarnessId = activeCli.harnessSessionId.startsWith("ses_")
        ? "opencode"
        : activeCli.harness;
      return {
        harness: h,
        harnessSessionId: activeCli.harnessSessionId,
        model: activeCli.model ?? null,
      };
    }

    const drvList = baseSessionId
      ? (app.snapshot?.drivers?.[baseSessionId] ?? [])
      : [];
    const cliRecent = app.snapshot?.cliRecentSessions ?? [];

    if (app.selectedDriverId) {
      const selectedDrv = drvList.find(
        (d) => d.driver_id === app.selectedDriverId,
      );
      if (selectedDrv) {
        const sid = selectedDrv.harness_session_id ?? null;
        const h: HarnessId =
          sid && sid.startsWith("ses_")
            ? "opencode"
            : (selectedDrv.harness as HarnessId);
        return {
          harness: h,
          harnessSessionId: sid,
          model: selectedDrv.model ?? null,
        };
      }
      if (app.selectedDriverId.startsWith("linked::")) {
        const linkedSid = app.selectedDriverId.slice("linked::".length);
        const linkedCli = cliRecent.find(
          (c) => c.harnessSessionId === linkedSid,
        );
        if (linkedCli) {
          const h: HarnessId = linkedCli.harnessSessionId.startsWith("ses_")
            ? "opencode"
            : linkedCli.harness;
          return {
            harness: h,
            harnessSessionId: linkedCli.harnessSessionId,
            model: linkedCli.model ?? null,
          };
        }
      }
      if (app.selectedDriverId.startsWith("sess::")) {
        const sessSid = app.selectedDriverId.slice("sess::".length);
        const h: HarnessId = sessSid.startsWith("ses_")
          ? "opencode"
          : ((fg?.main_harness as HarnessId | undefined) ?? "claude-code");
        return {
          harness: h,
          harnessSessionId: sessSid,
          model: fg?.main_model ?? null,
        };
      }
    }

    const activeDrv =
      drvList.find((d) => d.detached_at == null) ?? drvList[0] ?? null;
    if (activeDrv) {
      const sid = activeDrv.harness_session_id ?? fg?.harness_session_id ?? null;
      const h: HarnessId =
        sid && sid.startsWith("ses_")
          ? "opencode"
          : (activeDrv.harness as HarnessId);
      return {
        harness: h,
        harnessSessionId: sid,
        model: activeDrv.model ?? fg?.main_model ?? null,
      };
    }

    const fallbackSid = fg?.harness_session_id ?? null;
    const fallbackHarness: HarnessId =
      fallbackSid && fallbackSid.startsWith("ses_")
        ? "opencode"
        : ((fg?.main_harness as HarnessId | undefined) ?? "claude-code");
    return {
      harness: fallbackHarness,
      harnessSessionId: fallbackSid,
      model: fg?.main_model ?? null,
    };
  }, [
    activeCli,
    app.selectedDriverId,
    app.snapshot?.cliRecentSessions,
    app.snapshot?.drivers,
    baseSessionId,
    fg?.harness_session_id,
    fg?.main_harness,
    fg?.main_model,
  ]);

  const harness = resolvedTarget.harness;
  const harnessSessionId = resolvedTarget.harnessSessionId;
  const model = resolvedTarget.model;

  useEffect(() => {
    setResume(null);
    ref.current?.focus();
  }, [fgId, activeCli?.harnessSessionId]);

  useEffect(() => {
    setResume(null);
  }, [harness, harnessSessionId, model, app.selectedDriverId]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  async function submit() {
    const t = text.trim();
    if (!t || !projectRoot || sending || running) return;
    setSending(true);
    try {
      let targetSessionId = fgId;
      if (activeCli) {
        const promoted = await app.promoteCliSessionToAsd(activeCli);
        if (!promoted) return;
        targetSessionId = promoted;
      } else if (!targetSessionId) {
        const created = await app.createSession({
          harness: "claude-code",
          memo: t.slice(0, 60),
        });
        if (!created) return;
        targetSessionId = created;
      }

      if (mode === "debate") {
        const topic = t.split("\n")[0]?.slice(0, 80) || "아키텍처 및 구현 검토";
        const r = await api.startDebate({
          projectRoot,
          sessionId: targetSessionId,
          topic,
          proposal: t,
        });
        app.recordPrompt(targetSessionId, `[적대적 토론] ${topic}`, r.jobId);
      } else {
        const r = await api.driverPrompt({
          projectRoot,
          sessionId: targetSessionId,
          prompt: t,
          mode,
          driverId: app.selectedDriverId ?? undefined,
        });
        app.recordPrompt(
          targetSessionId,
          mode === "plan" ? `[계획 작성] ${t}` : t,
          r.jobId,
          r.runId,
        );
      }
      setText("");
    } catch (e) {
      app.reportError(api.errorText(e));
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    if (!projectRoot || !fgId) return;
    try {
      await api.cancelDriver({
        projectRoot,
        sessionId: fgId,
        runId: job?.runId ?? "active",
      });
    } catch (e) {
      app.reportError(api.errorText(e));
    }
  }

  const detailsRef = useRef<HTMLDetailsElement>(null);

  async function loadResume() {
    if (!harness) return;
    try {
      const r = await api.getResumeCommand({
        harness,
        harnessSessionId: harnessSessionId ?? undefined,
        model: model ?? undefined,
      });
      setResume(r.cliString || [r.command, ...r.args].join(" "));
    } catch (e) {
      app.reportError(api.errorText(e));
    }
  }

  useEffect(() => {
    if (detailsRef.current?.open) {
      void loadResume();
    }
  }, [harness, harnessSessionId, model]);

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={ref}
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={
            running
              ? "드라이버가 실행 중입니다 — 중지 버튼으로 멈출 수 있습니다"
              : activeCli
                ? "이 일반 CLI 세션을 ASD 세션으로 승격하여 대화를 이어갑니다 (Enter 전송)"
                : mode === "plan"
                  ? "작성할 태스크 계획(PLAN.md) 요구사항을 입력하세요 (Enter 전송)"
                  : mode === "debate"
                    ? "다중 모델 적대적 토론(asd_debate) 주제 및 제안 내용을 입력하세요 (Enter 전송)"
                    : "드라이버에게 보낼 프롬프트를 적으세요 (Enter 전송 · Shift+Enter 줄바꿈)"
          }
          aria-label="드라이버 프롬프트 입력"
        />
        <div className="composer-bar">
          <div className="row" style={{ gap: 4 }} role="group" aria-label="전송 모드">
            <button
              type="button"
              className={`pill ${mode === "chat" ? "active" : ""}`}
              onClick={() => setMode("chat")}
              title="일반 드라이버 대화 및 작업 지시"
            >
              대화
            </button>
            <button
              type="button"
              className={`pill ${mode === "plan" ? "active" : ""}`}
              onClick={() => setMode("plan")}
              title="asd_plan MCP 도구로 태스크 계획(.asd/PLAN.md) 생성/수정 지시"
            >
              계획 작성
            </button>
            <button
              type="button"
              className={`pill ${mode === "debate" ? "active" : ""}`}
              onClick={() => setMode("debate")}
              title="asd_debate 다중 모델 적대적 토론 실행"
            >
              적대적 토론
            </button>
          </div>

          <details
            ref={detailsRef}
            className="asd-resume"
            onToggle={(e) =>
              (e.target as HTMLDetailsElement).open && void loadResume()
            }
          >
            <summary
              className="pill"
              title="이 세션을 CLI에서 이어서 열 때 쓰는 명령"
            >
              재개 명령 <ChevronIcon />
            </summary>
            <div className="asd-pop">
              {resume ? (
                <>
                  <code className="asd-resume-cmd">{resume}</code>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => void navigator.clipboard?.writeText(resume)}
                  >
                    <CopyIcon /> 복사
                  </button>
                </>
              ) : (
                <p className="asd-dim">명령을 불러오는 중…</p>
              )}
            </div>
          </details>

          <div className="spacer" />

          {running ? (
            <button
              type="button"
              className="send stop"
              onClick={() => void stop()}
              aria-label="중지"
              title="실행 중인 드라이버 턴을 중지합니다"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="button"
              className="send"
              onClick={() => void submit()}
              disabled={!text.trim() || sending}
              aria-label="전송"
              title="드라이버에게 프롬프트를 보냅니다 (Enter)"
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

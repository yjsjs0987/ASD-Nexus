/**
 * Background Job Registry (GUI_ARCHITECTURE.md 6.1 & 6.3).
 * Tracks long-running operations (dispatch, debate, driver_turn, subagent_action, resolve_conflict)
 * and emits job_started / job_progress / job_finished over WebSocket.
 */

import * as crypto from "node:crypto";
import type { JobKind, ServerWsMessage } from "../../shared/protocol.ts";

export interface JobRecord {
  jobId: string;
  kind: JobKind;
  projectRoot: string;
  sessionId: string;
  taskIds?: string[];
  runId?: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  controller: AbortController;
}

export class JobRegistry {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly emit: (projectRoot: string, msg: ServerWsMessage) => void;

  constructor(emit: (projectRoot: string, msg: ServerWsMessage) => void) {
    this.emit = emit;
  }

  startJob<T>(options: {
    kind: JobKind;
    projectRoot: string;
    sessionId: string;
    taskIds?: string[];
    runId?: string;
    run: (ctx: {
      jobId: string;
      signal: AbortSignal;
      emitProgress: (message: string) => void;
    }) => Promise<T>;
  }): string {
    const jobId = `job-${Date.now().toString(36)}-${crypto
      .randomBytes(3)
      .toString("hex")}`;
    const controller = new AbortController();
    const record: JobRecord = {
      jobId,
      kind: options.kind,
      projectRoot: options.projectRoot,
      sessionId: options.sessionId,
      taskIds: options.taskIds,
      runId: options.runId,
      status: "running",
      startedAt: Date.now(),
      controller,
    };
    this.jobs.set(jobId, record);

    this.emit(options.projectRoot, {
      type: "job_started",
      jobId,
      kind: options.kind,
      projectRoot: options.projectRoot,
      sessionId: options.sessionId,
      ...(options.taskIds ? { taskIds: options.taskIds } : {}),
      ...(options.runId ? { runId: options.runId } : {}),
    });

    const emitProgress = (message: string) => {
      this.emit(options.projectRoot, {
        type: "job_progress",
        jobId,
        message,
      });
    };

    void Promise.resolve()
      .then(() =>
        options.run({
          jobId,
          signal: controller.signal,
          emitProgress,
        })
      )
      .then((result) => {
        record.status = "done";
        record.finishedAt = Date.now();
        this.emit(options.projectRoot, {
          type: "job_finished",
          jobId,
          kind: options.kind,
          ok: true,
          result,
        });
      })
      .catch((err: unknown) => {
        record.status = "failed";
        record.finishedAt = Date.now();
        const errMsg = err instanceof Error ? err.message : String(err);
        this.emit(options.projectRoot, {
          type: "job_finished",
          jobId,
          kind: options.kind,
          ok: false,
          error: errMsg,
        });
      });

    return jobId;
  }

  cancelByRunId(sessionId: string, runId: string): boolean {
    for (const job of this.jobs.values()) {
      if (
        job.sessionId === sessionId &&
        job.runId === runId &&
        job.status === "running"
      ) {
        job.controller.abort();
        return true;
      }
    }
    return false;
  }

  getRunningCount(): number {
    let count = 0;
    for (const j of this.jobs.values()) {
      if (j.status === "running") count++;
    }
    return count;
  }
}

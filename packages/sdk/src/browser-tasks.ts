import { Tab, type TabObservation } from "./tab.js";
import { getRuntimeMeta, withSessionMeta } from "./session-meta.js";
import type { BrowserResumeControlResult } from "./browser.js";
import type { Transport } from "./wire/transport.js";
import * as M from "./wire/methods.js";
import type { TaskState, ResumeCompleteStatus } from "@open-browser-use/browser-control-core";

export type TaskSummary = {
  taskId: string;
  label: string;
  state: TaskState;
  schemaVersion: number;
  createdAt: number;
  segmentCount: number;
  eventCursor: number;
  lastSegment?: TaskSegmentSummary;
};

export type TaskSegmentSummary = {
  segmentId: string;
  sessionId: string;
  turnId: string;
  generation?: number;
};

export type EpisodeExport = {
  task_id: string;
  turns: unknown[];
  events: unknown[];
};

export type BrowserTaskResumeResult =
  | { status: "resumed"; plan: unknown; episode: EpisodeExport; tab: Tab; observation: TabObservation; segment: TaskSegmentSummary }
  | { status: "resumed_observation_failed"; plan: unknown; episode: EpisodeExport; tab: Tab; segment: TaskSegmentSummary; error: unknown }
  | { status: "blocked"; plan: unknown; episode: EpisodeExport; repair: unknown }
  | { status: "failed"; plan: unknown; episode: EpisodeExport; error: unknown };

export class BrowserTasks {
  constructor(
    private readonly transport: Transport,
    private readonly resumeControlResult: (opts?: { timeout?: number }) => Promise<BrowserResumeControlResult>,
  ) {}

  async list(
    opts: { state?: string | string[]; limit?: number; scope?: "runtime" | "currentSession"; timeout?: number } = {},
  ): Promise<TaskSummary[]> {
    const { timeout, ...params } = opts;
    return await this.transport.sendRequest<TaskSummary[]>(M.TASKS_LIST, withSessionMeta(params), timeout);
  }

  async export(taskId: string, opts: { timeout?: number } = {}): Promise<EpisodeExport> {
    return await this.transport.sendRequest<EpisodeExport>(M.TASKS_EXPORT, withSessionMeta({ taskId }), opts.timeout);
  }

  async resume(taskId: string, opts: { timeout?: number } = {}): Promise<BrowserTaskResumeResult> {
    // getRuntimeMeta() reads the node-repl-injected, frozen requestMeta (trusted
    // source). It MUST travel in the frame-level `runtime` envelope (4th arg of
    // sendRequest), never inside params: the host rejects `runtime`/`_runtime`
    // params and reads kernel_generation only from the envelope (Finding F2).
    const runtime = getRuntimeMeta();
    const begin = await this.transport.sendRequest<{
      resumeToken: string;
      attemptId: string; // wire-shape doc only; resume() keys off resumeToken
      plan: unknown;
      episode: EpisodeExport;
    }>(M.TASKS_RESUME, withSessionMeta({ taskId }), opts.timeout, { runtime });

    // Attach-before-observe: tasksResume (begin) -> resumeControl (attach) ->
    // tasksResumeComplete (commit) -> observe the tab. A failed attach or a
    // blocked control transition still commits a terminal tasksResumeComplete so
    // the host's resume attempt is never left dangling.
    let control: BrowserResumeControlResult;
    try {
      control = await this.resumeControlResult(opts);
    } catch (error) {
      await this.transport.sendRequest(
        M.TASKS_RESUME_COMPLETE,
        withSessionMeta({ taskId, resumeToken: begin.resumeToken, status: "attach_failed" satisfies ResumeCompleteStatus, error: normalizeError(error) }),
        opts.timeout,
        { runtime },
      );
      return { status: "failed", plan: begin.plan, episode: begin.episode, error };
    }

    if (control.status === "blocked") {
      await this.transport.sendRequest(
        M.TASKS_RESUME_COMPLETE,
        withSessionMeta({ taskId, resumeToken: begin.resumeToken, status: "blocked" satisfies ResumeCompleteStatus, repair: control.repair }),
        opts.timeout,
        { runtime },
      );
      return { status: "blocked", plan: begin.plan, episode: begin.episode, repair: control.repair };
    }

    const complete = await this.transport.sendRequest<{ segment: TaskSegmentSummary }>(
      M.TASKS_RESUME_COMPLETE,
      withSessionMeta({ taskId, resumeToken: begin.resumeToken, status: "attached" satisfies ResumeCompleteStatus }),
      opts.timeout,
      { runtime },
    );

    // Observe AFTER the attach is committed. `includeText: false` keeps this a
    // minimal continuity probe (tab_url + tab_title); a long-task resume must
    // re-observe to allocate a FRESH observation id rather than replay a
    // persisted one (Finding 10).
    const observeOpts: { includeText: false; timeout?: number } = { includeText: false };
    if (opts.timeout !== undefined) observeOpts.timeout = opts.timeout;

    // Commit a terminal observation_failed and return the soft-failure result.
    // Both the degraded-probe path (observe resolved but the continuity sections
    // errored) and the hard-throw path (observe threw for a non-section/setup
    // reason) funnel through here so the completion + return shape is identical.
    // `wireError` rides the tasksResumeComplete envelope; `error` is surfaced to
    // the caller.
    const completeObservationFailed = async (
      wireError: { code: string; message: string },
      error: unknown,
    ): Promise<BrowserTaskResumeResult> => {
      await this.transport.sendRequest(
        M.TASKS_RESUME_COMPLETE,
        withSessionMeta({ taskId, resumeToken: begin.resumeToken, status: "observation_failed" satisfies ResumeCompleteStatus, error: wireError }),
        opts.timeout,
        { runtime },
      );
      return {
        status: "resumed_observation_failed",
        plan: begin.plan,
        episode: begin.episode,
        tab: control.tab,
        segment: complete.segment,
        error,
      };
    };

    try {
      const observation = await control.tab.observe(observeOpts);
      // Tab.observe() is fault-tolerant: #observeSection swallows per-section
      // transport failures and records them in diagnostics.sectionErrors, so a
      // failed url/title probe resolves a DEGRADED observation rather than
      // throwing (observation.status can even stay "succeeded" because
      // sections.tab is "present" on metadata alone). The only precise signal of
      // a failed continuity probe is a `tab.`-prefixed sectionErrors key
      // (sectionErrors["tab.url"] / ["tab.title"] — tab.ts:391/405); a blanket
      // status check would false-positive on benign "partial" from skipped
      // optional sections. Detect that here so the attach-before-observe design
      // can report a failed probe instead of masking it as "resumed".
      const probeErrors = Object.entries(observation.diagnostics.sectionErrors).filter(([key]) =>
        key.startsWith("tab."),
      );
      if (probeErrors.length > 0) {
        const summary = Object.fromEntries(probeErrors);
        return await completeObservationFailed(
          { code: "observation_failed", message: JSON.stringify(summary) },
          { code: "observation_failed", message: JSON.stringify(summary), sectionErrors: summary },
        );
      }
      return {
        status: "resumed",
        plan: begin.plan,
        episode: begin.episode,
        tab: control.tab,
        observation,
        segment: complete.segment,
      };
    } catch (error) {
      return await completeObservationFailed(normalizeError(error), error);
    }
  }
}

function normalizeError(error: unknown): { code: string; message: string } {
  return { code: "sdk_error", message: error instanceof Error ? error.message : String(error) };
}

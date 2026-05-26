export const TASK_STATES = [
  "created",
  "running",
  "waiting_for_human",
  "waiting_for_effect",
  "paused_yielded",
  "resuming",
  "repair_required",
  "blocked",
  "completed",
  "cancelling",
  "cancelled",
  "failed",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const RESUME_COMPLETE_STATUSES = ["attached", "blocked", "attach_failed", "observation_failed"] as const;
export type ResumeCompleteStatus = (typeof RESUME_COMPLETE_STATUSES)[number];

/** Host-side projection of session/turn lifecycle truth (Finding 8). The host
 *  carries one of these instead of the rich `BrowserSessionLifecycle` /
 *  `BrowserTurnLifecycle` union, which stays authoritative in the SDK/extension.
 *  Single source for the host `ControlProjection` enum; pinned by
 *  `control_vocab_contract::control_projection_vocab_matches_fixture`. */
export const SESSION_CONTROL_PROJECTIONS = [
  "human_takeover",
  "yielded",
  "resuming",
  "repair_required",
  "blocked",
] as const;
export type SessionControlProjection = (typeof SESSION_CONTROL_PROJECTIONS)[number];

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

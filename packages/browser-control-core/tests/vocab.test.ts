import { describe, expect, it } from "vitest";
import {
  TASK_STATES,
  RESUME_COMPLETE_STATUSES,
  TAB_ORIGINS,
  TAB_STATUSES,
  COORDINATE_SPACES,
} from "../src/index.js";

describe("control vocabularies", () => {
  it("pins TaskState values in order", () => {
    expect([...TASK_STATES]).toEqual([
      "created", "running", "waiting_for_human", "waiting_for_effect",
      "paused_yielded", "resuming", "repair_required", "blocked",
      "completed", "cancelling", "cancelled", "failed",
    ]);
  });

  it("pins resume-complete statuses", () => {
    expect([...RESUME_COMPLETE_STATUSES]).toEqual(["attached", "blocked", "attach_failed", "observation_failed"]);
  });

  it("pins tab origin and status", () => {
    expect([...TAB_ORIGINS]).toEqual(["agent", "user"]);
    expect([...TAB_STATUSES]).toEqual(["active", "handoff", "deliverable"]);
  });

  it("pins coordinate spaces", () => {
    expect([...COORDINATE_SPACES]).toEqual(["visualViewport", "layoutViewport"]);
  });
});

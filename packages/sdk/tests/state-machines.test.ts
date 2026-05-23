import { describe, expect, it } from "vitest";
import {
  ACTION_RUNTIME_TRANSITIONS,
  OBSERVE_REQUEST_TRANSITIONS,
  StateTrace,
  createActionStateTrace,
  createObserveStateTrace,
} from "../src/state-machines.js";

describe("observe and action state machines", () => {
  it("keeps the observe transition graph explicit and terminal states closed", () => {
    expect(OBSERVE_REQUEST_TRANSITIONS).toEqual({
      requested: ["preflight"],
      preflight: ["blocked", "reading_backend", "failed", "cancelled"],
      reading_backend: ["composing_snapshot", "partial", "failed", "cancelled"],
      composing_snapshot: ["succeeded", "partial", "blocked", "failed", "cancelled"],
      succeeded: [],
      partial: [],
      blocked: [],
      failed: [],
      cancelled: [],
    });
  });

  it("keeps the action transition graph explicit and terminal states closed", () => {
    expect(ACTION_RUNTIME_TRANSITIONS).toEqual({
      planned: ["preflight"],
      preflight: ["blocked", "running", "failed", "cancelled"],
      running: ["waiting_for_effect", "failed", "cancelled"],
      waiting_for_effect: ["reconciling", "failed", "cancelled"],
      reconciling: ["succeeded", "failed", "cancelled"],
      succeeded: [],
      blocked: [],
      failed: [],
      cancelled: [],
    });
  });

  it("records successful observe traces in order", () => {
    const trace = createObserveStateTrace();

    trace.transition("preflight");
    trace.transition("reading_backend");
    trace.transition("composing_snapshot");
    trace.transition("succeeded");

    expect(trace.history.map((entry) => entry.state)).toEqual([
      "requested",
      "preflight",
      "reading_backend",
      "composing_snapshot",
      "succeeded",
    ]);
  });

  it("rejects invalid state jumps and any transition out of a terminal state", () => {
    const observe = createObserveStateTrace();
    expect(() => observe.transition("succeeded")).toThrow("invalid state transition requested -> succeeded");
    observe.transition("preflight");
    observe.transition("blocked");
    expect(() => observe.transition("reading_backend")).toThrow("invalid state transition blocked -> reading_backend");

    const action = createActionStateTrace();
    expect(() => action.transition("running")).toThrow("invalid state transition planned -> running");
    action.transition("preflight");
    action.transition("running");
    action.transition("waiting_for_effect");
    action.transition("reconciling");
    action.transition("succeeded");
    expect(() => action.transition("failed")).toThrow("invalid state transition succeeded -> failed");
  });

  it("preserves timestamps for deterministic diagnostics", () => {
    let now = 1000;
    const trace = new StateTrace("planned", ACTION_RUNTIME_TRANSITIONS, () => now);

    now = 1010;
    trace.transition("preflight");
    now = 1020;
    trace.transition("blocked");

    expect(trace.history).toEqual([
      { state: "planned", at: 1000 },
      { state: "preflight", at: 1010 },
      { state: "blocked", at: 1020 },
    ]);
  });
});

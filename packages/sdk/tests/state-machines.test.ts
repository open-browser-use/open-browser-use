import { describe, expect, it } from "vitest";
import {
  ACTION_RUNTIME_TRANSITIONS,
  HIGH_LEVEL_ACTION_TRANSITIONS,
  OBSERVE_REQUEST_TRANSITIONS,
  StateTrace,
  createActionStateTrace,
  createHighLevelActionStateTrace,
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

describe("high-level action state machine", () => {
  it("happy path: planned → observing → planning_steps → preflighting_steps → running_step → waiting_for_effect → reconciling → succeeded", () => {
    const trace = createHighLevelActionStateTrace();
    expect(trace.state).toBe("planned");
    trace.transition("observing");
    trace.transition("planning_steps");
    trace.transition("preflighting_steps");
    trace.transition("running_step");
    trace.transition("waiting_for_effect");
    trace.transition("reconciling");
    trace.transition("succeeded");
    expect(trace.state).toBe("succeeded");
  });

  it("observing → blocked is legal", () => {
    const trace = createHighLevelActionStateTrace();
    trace.transition("observing");
    trace.transition("blocked");
    expect(trace.state).toBe("blocked");
  });

  it("partial is reachable from reconciling", () => {
    const trace = createHighLevelActionStateTrace();
    for (const next of [
      "observing", "planning_steps", "preflighting_steps", "running_step",
      "waiting_for_effect", "reconciling", "partial",
    ] as const) {
      trace.transition(next);
    }
    expect(trace.state).toBe("partial");
  });

  it("running_step can loop back to observing for a fresh boundary", () => {
    const trace = createHighLevelActionStateTrace();
    trace.transition("observing");
    trace.transition("planning_steps");
    trace.transition("preflighting_steps");
    trace.transition("running_step");
    trace.transition("observing");
    expect(trace.state).toBe("observing");
  });

  it("rejects illegal transitions", () => {
    const trace = createHighLevelActionStateTrace();
    expect(() => trace.transition("running_step")).toThrow("invalid state transition planned -> running_step");
  });

  it("exposes a frozen transition graph with closed terminal states", () => {
    expect(HIGH_LEVEL_ACTION_TRANSITIONS.succeeded).toEqual([]);
    expect(HIGH_LEVEL_ACTION_TRANSITIONS.partial).toEqual([]);
    expect(HIGH_LEVEL_ACTION_TRANSITIONS.blocked).toEqual([]);
    expect(HIGH_LEVEL_ACTION_TRANSITIONS.failed).toEqual([]);
    expect(HIGH_LEVEL_ACTION_TRANSITIONS.cancelled).toEqual([]);
  });
});

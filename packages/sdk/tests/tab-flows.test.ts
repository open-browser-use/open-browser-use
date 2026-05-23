import { describe, expect, it } from "vitest";
import type { ActionResult, EnvAction, LocatorActionTarget } from "../src/tab-action.js";
import type { TabObservation } from "../src/tab.js";
import { TabFlows } from "../src/tab-flows.js";

function fakeObservation(seq: number): TabObservation {
  return {
    observationId: `obs-${seq}`,
    status: "succeeded",
    sections: {} as TabObservation["sections"],
  } as unknown as TabObservation;
}

function fakeActionResult(action: EnvAction, status: ActionResult["status"] = "succeeded"): ActionResult {
  return {
    actionId: action.actionId ?? "act-1",
    kind: action.kind,
    status,
    effect: "dom_changed",
    startedAt: 0,
    completedAt: 1,
  };
}

describe("TabFlows.chooseFromMenu", () => {
  it("re-observes the open menu and selects the option from the fresh observation (Finding 14)", async () => {
    const observeCalls: Array<Record<string, unknown> | undefined> = [];
    const stepCalls: EnvAction[] = [];
    let seq = 0;
    const flows = new TabFlows({
      observe: async (opts) => {
        observeCalls.push(opts);
        seq += 1;
        return fakeObservation(seq);
      },
      step: async (action) => {
        stepCalls.push(action);
        return fakeActionResult(action);
      },
    });

    const result = await flows.chooseFromMenu({
      trigger: { source: "locator", selector: "#menu" },
      option: { text: "Option B" },
    });

    // pre-trigger + post-trigger observation
    expect(observeCalls.length).toBeGreaterThanOrEqual(2);
    // both step calls must carry an observationId — the second one MUST be the post-menu observation
    expect(stepCalls.length).toBe(2);
    const optionStep = stepCalls[1];
    const target = optionStep.target as LocatorActionTarget;
    expect(target.observationId).toBe("obs-2");
    // option locator must be derived from text (came from fresh observation)
    expect(target.selector.includes("Option B")).toBe(true);
    expect(result.toJSON().status).toBe("succeeded");
  });

  it("transitions through the high-level state machine including the boundary loopback", async () => {
    let seq = 0;
    const flows = new TabFlows({
      observe: async () => { seq += 1; return fakeObservation(seq); },
      step: async (action) => fakeActionResult(action),
    });
    const result = await flows.chooseFromMenu({
      trigger: { source: "locator", selector: "#menu" },
      option: { text: "Option B" },
    });
    const states = result.toJSON().trace;
    // must include a second `observing` after the first `running_step`
    expect(states.filter((s) => s === "observing").length).toBe(2);
    expect(states).toContain("running_step");
    expect(states).toContain("reconciling");
    expect(states[states.length - 1]).toBe("succeeded");
  });
});

describe("TabFlows.submitAndObserve", () => {
  it("re-observes after submit and does not reuse pre-submit observation id", async () => {
    let seq = 0;
    const observed: string[] = [];
    const stepCalls: EnvAction[] = [];
    const flows = new TabFlows({
      observe: async () => { seq += 1; const obs = fakeObservation(seq); observed.push(obs.observationId); return obs; },
      step: async (action) => { stepCalls.push(action); return fakeActionResult(action); },
    });
    await flows.submitAndObserve({ submit: { source: "locator", selector: "button[type=submit]" } });
    expect(observed.length).toBeGreaterThanOrEqual(2);
    expect((stepCalls[0].target as LocatorActionTarget).observationId).toBe(observed[0]);
  });
});

describe("TabFlows.clickByText", () => {
  it("clicks a text-derived target from the current observation", async () => {
    let seq = 0;
    const stepCalls: EnvAction[] = [];
    const flows = new TabFlows({
      observe: async () => { seq += 1; return fakeObservation(seq); },
      step: async (action) => { stepCalls.push(action); return fakeActionResult(action); },
    });
    const result = await flows.clickByText({ text: "Sign in" });
    expect(stepCalls.length).toBe(1);
    expect(stepCalls[0].kind).toBe("locator.click");
    expect((stepCalls[0].target as LocatorActionTarget).observationId).toBe("obs-1");
    expect((stepCalls[0].target as LocatorActionTarget).selector).toContain("Sign in");
    expect(result.toJSON().status).toBe("succeeded");
  });
});

describe("TabFlows.fillForm", () => {
  it("redacts password-like field values from the result trace (Finding 15)", async () => {
    let seq = 0;
    const flows = new TabFlows({
      observe: async () => { seq += 1; return fakeObservation(seq); },
      step: async (action) => fakeActionResult(action),
    });
    const result = await flows.fillForm({
      fields: [
        { name: "email", value: "agent@example.com" },
        { name: "password", value: "hunter2" },
      ],
    });
    const json = JSON.stringify(result.toJSON());
    expect(json).not.toContain("hunter2");
    expect(json).toContain("[redacted]");
    expect(json).toContain("agent@example.com");
  });
});

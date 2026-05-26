import { describe, expect, it } from "vitest";
import type { ActionResult, EnvAction, LocatorActionTarget } from "../src/tab-action.js";
import type { TabObservation } from "../src/tab.js";
import { TabFlows } from "../src/tab-flows.js";
import { Download } from "../src/download.js";
import type { Transport } from "../src/wire/transport.js";

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

    // pre-trigger + post-trigger observation + post-reconcile observation
    expect(observeCalls.length).toBe(3);
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

  it("short-circuits without clicking an option when opening the menu fails (Finding 5)", async () => {
    let observeCount = 0;
    const stepCalls: EnvAction[] = [];
    let seq = 0;
    const flows = new TabFlows({
      observe: async () => { observeCount += 1; seq += 1; return fakeObservation(seq); },
      step: async (action) => { stepCalls.push(action); return fakeActionResult(action, "failed"); },
    });
    const result = await flows.chooseFromMenu({
      trigger: { source: "locator", selector: "#menu" },
      option: { text: "Option B" },
    });
    // only the trigger step ran; the option step was never dispatched
    expect(stepCalls.length).toBe(1);
    // only the pre-trigger observation happened — no boundary re-observe
    expect(observeCount).toBe(1);
    expect(result.toJSON().status).toBe("partial");
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

describe("TabFlows.fillForm edge cases", () => {
  it("handles zero fields without throwing and ends in succeeded", async () => {
    let seq = 0;
    const flows = new TabFlows({
      observe: async () => { seq += 1; return fakeObservation(seq); },
      step: async () => { throw new Error("step should not be called"); },
    });
    const result = await flows.fillForm({ fields: [] });
    expect(result.toJSON().status).toBe("succeeded");
  });

  it("stops filling and does not submit after a failed field (Finding 5)", async () => {
    let seq = 0;
    const stepCalls: EnvAction[] = [];
    const flows = new TabFlows({
      observe: async () => { seq += 1; return fakeObservation(seq); },
      // first field fill fails; everything after would succeed if reached
      step: async (action) => { stepCalls.push(action); return fakeActionResult(action, stepCalls.length === 1 ? "failed" : "succeeded"); },
    });
    const result = await flows.fillForm({
      fields: [{ name: "a", value: "1" }, { name: "b", value: "2" }],
      submit: { source: "locator", selector: "button[type=submit]" },
    });
    // only the first field was attempted; the second field and submit never ran
    expect(stepCalls.length).toBe(1);
    expect(stepCalls.every((s) => s.kind === "locator.fill")).toBe(true);
    expect(result.toJSON().status).toBe("partial");
  });
});

describe("TabFlows.downloadAfterClick", () => {
  const fakeTransport = {} as unknown as Transport;

  it("reuses the existing host Download handle returned by waitForDownload", async () => {
    let seq = 0;
    const stepCalls: EnvAction[] = [];
    const flows = new TabFlows({
      observe: async () => { seq += 1; return fakeObservation(seq); },
      step: async (action) => { stepCalls.push(action); return fakeActionResult(action); },
    });

    const existing = new Download(fakeTransport, "dl-1");
    const dl = await flows.downloadAfterClick(
      { trigger: { source: "locator", selector: "#dl" } },
      { waitForDownload: async () => existing },
    );

    // must reuse the existing host Download handle, not a new stale-handle model
    expect(dl.download).toBeInstanceOf(Download);
    expect(dl.download).toBe(existing);
    expect(dl.download.id).toBe("dl-1");

    // the trigger click carries the current observation id
    expect(stepCalls.length).toBe(1);
    expect(stepCalls[0].kind).toBe("locator.click");
    expect((stepCalls[0].target as LocatorActionTarget).observationId).toBe("obs-1");

    // reaches a terminal high-level state
    expect(dl.toJSON().status).toBe("succeeded");
  });

  it("transitions through the high-level state machine including the post-click boundary", async () => {
    let seq = 0;
    const flows = new TabFlows({
      observe: async () => { seq += 1; return fakeObservation(seq); },
      step: async (action) => fakeActionResult(action),
    });
    const dl = await flows.downloadAfterClick(
      { trigger: { source: "locator", selector: "#dl" } },
      { waitForDownload: async () => new Download(fakeTransport, "dl-2") },
    );
    const states = dl.toJSON().trace;
    expect(states).toContain("running_step");
    expect(states).toContain("waiting_for_effect");
    expect(states).toContain("reconciling");
    expect(states[states.length - 1]).toBe("succeeded");
  });

  it("does not wait for a download when the trigger click does not succeed (Finding 2)", async () => {
    let seq = 0;
    const flows = new TabFlows({
      observe: async () => { seq += 1; return fakeObservation(seq); },
      step: async (action) => fakeActionResult(action, "failed"),
    });
    const dl = await flows.downloadAfterClick(
      { trigger: { source: "locator", selector: "#dl" } },
      // A never-resolving waiter: the flow must still resolve (to partial)
      // WITHOUT awaiting it, proving the failed click abandons the waiter.
      { waitForDownload: () => new Promise<Download>(() => {}) },
    );
    expect(dl.toJSON().status).toBe("partial");
    expect(dl.download).toBeUndefined();
  });

  it("arms the download waiter before clicking the trigger (Finding 2)", async () => {
    let seq = 0;
    const order: string[] = [];
    const flows = new TabFlows({
      observe: async () => { seq += 1; return fakeObservation(seq); },
      step: async (action) => { order.push("click"); return fakeActionResult(action); },
    });
    const dl = await flows.downloadAfterClick(
      { trigger: { source: "locator", selector: "#dl" } },
      { waitForDownload: async () => { order.push("wait"); return new Download(fakeTransport, "dl-x"); } },
    );
    // The waiter must be armed before the click so a synchronous download is not missed.
    expect(order[0]).toBe("wait");
    expect(order).toContain("click");
    expect(dl.download).toBeInstanceOf(Download);
    expect(dl.toJSON().status).toBe("succeeded");
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

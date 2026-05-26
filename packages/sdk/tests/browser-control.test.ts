import { afterEach, describe, expect, it } from "vitest";
import { Browser } from "../src/browser.js";
import { Guards } from "../src/guards.js";
import { clearSessionMetaCacheForTests } from "../src/session-meta.js";
import type { Transport } from "../src/wire/transport.js";
import * as M from "../src/wire/methods.js";

class BrowserControlTransport {
  calls: Array<{ method: string; params: Record<string, unknown>; timeout?: number }> = [];

  async sendRequest<T>(method: string, params: Record<string, unknown>, timeout?: number): Promise<T> {
    this.calls.push({ method, params, timeout });
    if (method === M.CREATE_TAB) {
      return {
        tab_id: "tab-1",
        url: "https://example.com/form",
        title: "Example Form",
        owned: true,
        commandable: true,
        status: "active",
      } as T;
    }
    if (method === M.RESUME_CONTROL) {
      return {
        tab: {
          tab_id: "tab-1",
          url: "https://example.com/form",
          title: "Example Form",
          owned: true,
          commandable: true,
          status: "active",
        },
      } as T;
    }
    if (method === M.FINALIZE_TABS) {
      return {
        status: "ok",
        actions: [],
        closedTabIds: ["tab-1"],
        releasedTabIds: [],
        keptTabs: [],
        deliverableTabs: [],
        finalTabs: { handoff: [], deliverable: [], activeTabId: null },
        failures: [],
      } as T;
    }
    if (method === M.TAB_URL) return "https://example.com/form" as T;
    if (method === M.TAB_TITLE) return "Example Form" as T;
    if (method === M.DOM_CUA_GET_VISIBLE_DOM) {
      return {
        text: "<button node_id=101>Submit</button>",
        nodes: [{ node_id: "101", tag: "button", bounds: { x: 10, y: 20, width: 40, height: 20 } }],
      } as T;
    }
    if (method === M.DOM_CUA_CLICK) {
      return { node_id: "101", point: { x: 20, y: 30, coordinateSpace: "visualViewport" } } as T;
    }
    return null as T;
  }
}

describe("Browser control lifecycle", () => {
  afterEach(() => {
    delete (globalThis as { obuRepl?: unknown }).obuRepl;
    clearSessionMetaCacheForTests();
  });

  it("marks shared pointer state stale across human takeover and resume", async () => {
    installSessionMeta("session-a", "turn-1");
    const transport = new BrowserControlTransport();
    const browser = new Browser(
      transport as unknown as Transport,
      {
        type: "webextension",
        name: "chrome",
        capabilities: {
          supported_methods: [
            M.CREATE_TAB,
            M.CUA_CLICK,
            M.CUA_MOVE,
            M.DOM_CUA_GET_VISIBLE_DOM,
            M.DOM_CUA_CLICK,
            M.TAB_URL,
            M.TAB_TITLE,
            M.YIELD_CONTROL,
            M.RESUME_CONTROL,
          ],
        },
      },
      { type: "webextension", name: "chrome", socketPath: "/tmp/obu/chrome.sock" },
      new Guards(),
    );
    const tab = await browser.tabs.create("https://example.com/form");

    await tab.act.move(10, 20);
    const staleAfterTakeoverObservation = await tab.observe({
      mode: "actionable",
      includeText: false,
      observationTtlMs: 60_000,
    });
    let observation = await tab.observe({ includeText: false });
    expect(observation.pointer).toMatchObject({
      tabId: "tab-1",
      sessionId: "session-a",
      turnId: "turn-1",
      x: 10,
      y: 20,
      phase: "idle",
      source: "agent",
      visible: true,
    });

    await browser.yieldControl();
    const blockedTakeoverAction = await tab.act.click({
      source: "dom-cua",
      observationId: staleAfterTakeoverObservation.observationId,
      nodeId: "101",
    });
    expect(blockedTakeoverAction).toMatchObject({
      status: "blocked",
      effect: "no_visible_change",
      invalidatedObservations: [staleAfterTakeoverObservation.observationId],
      error: {
        code: "stale_observation",
        data: {
          state: "invalid",
          invalidity: {
            reason: "stale",
            detail: "human_takeover",
          },
        },
      },
    });
    observation = await tab.observe({ includeText: false });
    expect(observation.pointer).toMatchObject({
      tabId: "tab-1",
      sessionId: "session-a",
      turnId: "turn-1",
      x: 10,
      y: 20,
      phase: "stale",
      source: "unknown",
      visible: false,
      staleReason: "human_takeover",
    });

    const resumed = await browser.resumeControlResult();
    expect(resumed.status).toBe("resumed");
    expect(resumed.status === "resumed" ? resumed.tab.id : undefined).toBe("tab-1");
    const staleAfterResumeObservation = await tab.observe({
      mode: "actionable",
      includeText: false,
      observationTtlMs: 60_000,
    });
    await browser.resumeControlResult();
    const blockedResumeAction = await (resumed.status === "resumed" ? resumed.tab : tab).act.click({
      source: "dom-cua",
      observationId: staleAfterResumeObservation.observationId,
      nodeId: "101",
    });
    expect(blockedResumeAction).toMatchObject({
      status: "blocked",
      effect: "no_visible_change",
      error: {
        code: "stale_observation",
        data: {
          state: "invalid",
          invalidity: {
            reason: "stale",
            detail: "resume_control_revalidation_required",
          },
        },
      },
    });

    observation = await (resumed.status === "resumed" ? resumed.tab : tab).observe({ includeText: false });
    expect(observation.pointer).toMatchObject({
      tabId: "tab-1",
      sessionId: "session-a",
      turnId: "turn-1",
      x: 10,
      y: 20,
      phase: "stale",
      source: "unknown",
      visible: false,
      staleReason: "resume_control_revalidation_required",
    });
    const blockedAction = await (resumed.status === "resumed" ? resumed.tab : tab).act.click({
      source: "coordinate",
      x: 10,
      y: 20,
    });
    expect(blockedAction).toMatchObject({
      status: "blocked",
      effect: "no_visible_change",
      error: {
        code: "stale_pointer",
        data: {
          staleReason: "resume_control_revalidation_required",
        },
      },
    });
    expect(transport.calls.map((call) => call.method)).toEqual([
      M.CREATE_TAB,
      M.CUA_MOVE,
      M.TAB_URL,
      M.TAB_TITLE,
      M.DOM_CUA_GET_VISIBLE_DOM,
      M.TAB_URL,
      M.TAB_TITLE,
      M.YIELD_CONTROL,
      M.TAB_URL,
      M.TAB_TITLE,
      M.RESUME_CONTROL,
      M.TAB_URL,
      M.TAB_TITLE,
      M.DOM_CUA_GET_VISIBLE_DOM,
      M.RESUME_CONTROL,
      M.TAB_URL,
      M.TAB_TITLE,
    ]);
  });

  it("finalize marks SDK pointer continuity stale across session cleanup", async () => {
    installSessionMeta("session-a", "turn-finalize");
    const transport = new BrowserControlTransport();
    const browser = new Browser(
      transport as unknown as Transport,
      {
        type: "webextension",
        name: "chrome",
        capabilities: {
          supported_methods: [
            M.CREATE_TAB,
            M.CUA_CLICK,
            M.CUA_MOVE,
            M.TAB_URL,
            M.TAB_TITLE,
            M.FINALIZE_TABS,
          ],
        },
      },
      { type: "webextension", name: "chrome", socketPath: "/tmp/obu/chrome.sock" },
      new Guards(),
    );
    const tab = await browser.tabs.create("https://example.com/form");

    const moved = await tab.act.move(10, 20);
    expect(moved).toMatchObject({
      sessionId: "session-a",
      turnId: "turn-finalize",
      pointer: {
        sessionId: "session-a",
        turnId: "turn-finalize",
        phase: "idle",
      },
    });

    const finalized = await browser.finalizeTabs();
    expect(finalized.status).toBe("ok");

    const observation = await tab.observe({ includeText: false });
    expect(observation.lifecycle).toMatchObject({
      sessionId: "session-a",
      turnId: "turn-finalize",
    });
    expect(observation.pointer).toMatchObject({
      sessionId: "session-a",
      turnId: "turn-finalize",
      phase: "stale",
      source: "unknown",
      visible: false,
      staleReason: "finalize_tabs",
    });
    expect(transport.calls.map((call) => call.method)).toEqual([
      M.CREATE_TAB,
      M.CUA_MOVE,
      M.FINALIZE_TABS,
      M.TAB_URL,
      M.TAB_TITLE,
    ]);
  });
});

function installSessionMeta(sessionId: string, turnId: string): void {
  (globalThis as { obuRepl?: unknown }).obuRepl = {
    requestMeta: {
      "x-obu-turn-metadata": { session_id: sessionId, turn_id: turnId },
    },
  };
}

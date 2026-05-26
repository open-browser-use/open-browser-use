import { describe, expect, it } from "vitest";
import {
  activeSessionLifecycle,
  assertSessionAcceptsAction,
  browserControlProtocolVersion,
  finalizeAction,
  parseFinalizeKeep,
  planFinalizeTabs,
  type SessionTab,
} from "../src/index.js";

describe("browser-control-core package contract", () => {
  it("exports an explicit protocol version", () => {
    expect(browserControlProtocolVersion).toBe(1);
  });

  it("allows commands only for active sessions", () => {
    expect(() => assertSessionAcceptsAction(activeSessionLifecycle(7), "tab_goto")).not.toThrow();
    expect(() =>
      assertSessionAcceptsAction({ kind: "human_takeover", activeTabId: 7 }, "tab_goto"),
    ).toThrow(/yielded to the human/);
    expect(() =>
      assertSessionAcceptsAction({ kind: "resuming", repairPlanId: "repair-1" }, "tab_goto"),
    ).toThrow(/resuming/);
  });

  it("plans finalize actions without Chrome side effects", () => {
    const tabs = new Map<number, SessionTab>([
      [1, { tabId: 1, origin: "agent", status: "active" }],
      [2, { tabId: 2, origin: "user", status: "active" }],
    ]);
    const keep = parseFinalizeKeep({ keep: [{ tab_id: 2, status: "handoff" }] });
    expect(planFinalizeTabs(tabs, keep).steps).toEqual([
      { tabId: 1, row: { tabId: 1, origin: "agent", status: "active" }, origin: "agent", desiredStatus: "close", effect: "close_agent_tab" },
      { tabId: 2, row: { tabId: 2, origin: "user", status: "active" }, origin: "user", desiredStatus: "handoff", effect: "keep_handoff" },
    ]);
    expect(finalizeAction(2, "user", "handoff", "kept_handoff")).toMatchObject({
      tabId: 2,
      origin: "user",
      desiredStatus: "handoff",
      outcome: "kept_handoff",
    });
  });
});

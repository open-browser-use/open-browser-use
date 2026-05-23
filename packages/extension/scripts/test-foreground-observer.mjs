import assert from "node:assert/strict";

import { ForegroundObserver } from "../dist/foreground_observer.js";

const session = {
  currentTurnId: "",
  activeTabId: undefined,
  lifecycle: { kind: "active" },
  turnLifecycle: { kind: "idle" },
  tabs: new Map([[4, { tabId: 4, origin: "agent", status: "active" }]]),
  finalizedTabs: new Map(),
  attachedTabIds: new Set(),
};
const calls = {
  query: [],
  persist: 0,
  sync: 0,
  logs: [],
};

const observer = new ForegroundObserver({
  queryActiveTab: async (windowId) => {
    calls.query.push(windowId);
    return { id: 4, active: true, windowId };
  },
  findSessionForTab: (tabId) => tabId === 4 ? { sessionId: "session", session } : undefined,
  persistSessionState: async () => {
    calls.persist += 1;
  },
  syncForeground: async () => {
    calls.sync += 1;
  },
  appendDebugLog: (level, event, data) => {
    calls.logs.push({ level, event, data });
  },
});

await observer.handleWindowFocusChanged(-1);
assert.deepEqual(calls.query, []);
assert.equal(calls.sync, 1);
assert.equal(calls.persist, 0);

await observer.handleWindowFocusChanged(12);
assert.deepEqual(calls.query, [12]);
assert.equal(session.activeTabId, 4);
assert.equal(calls.persist, 1);
assert.equal(calls.sync, 2);
assert.deepEqual(calls.logs.at(-1), {
  level: "debug",
  event: "tab.logical_active.foreground",
  data: {
    sessionId: "session",
    tabId: 4,
    reason: "window_focus_changed",
  },
});

await observer.handleForegroundTabChanged(4, "tab_activated");
assert.equal(calls.persist, 1);
assert.equal(calls.sync, 3);

// Test: human_takeover lifecycle must not allow foreground tab changes to mutate activeTabId
const takeoverSession = {
  currentTurnId: "",
  activeTabId: 7,
  lifecycle: { kind: "human_takeover", activeTabId: 7 },
  turnLifecycle: { kind: "idle" },
  tabs: new Map([[4, { tabId: 4, origin: "agent", status: "active" }]]),
  finalizedTabs: new Map(),
  attachedTabIds: new Set(),
};
const takeoverCalls = {
  persist: 0,
  sync: 0,
};
const takeoverObserver = new ForegroundObserver({
  queryActiveTab: async (windowId) => ({ id: 4, active: true, windowId }),
  findSessionForTab: (tabId) => (tabId === 4 ? { sessionId: "session", session: takeoverSession } : undefined),
  persistSessionState: async () => { takeoverCalls.persist += 1; },
  syncForeground: async () => { takeoverCalls.sync += 1; },
  appendDebugLog: () => {},
});
await takeoverObserver.handleForegroundTabChanged(4, "tab_activated");
assert.equal(takeoverSession.activeTabId, 7, "human_takeover must not move agent activeTabId");
assert.equal(takeoverCalls.persist, 0, "human_takeover must not trigger persist");

console.log("All tests passed.");

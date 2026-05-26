import assert from "node:assert/strict";

import {
  planForegroundTabChanged,
  planWindowFocusChanged,
} from "../dist/lifecycle/foreground_observer_machine.js";

assert.deepEqual(planWindowFocusChanged(-1), { kind: "sync_foreground" });
assert.deepEqual(planWindowFocusChanged(Number.NaN), { kind: "sync_foreground" });
assert.deepEqual(planWindowFocusChanged(3), {
  kind: "query_active_tab",
  windowId: 3,
  reason: "window_focus_changed",
});

assert.deepEqual(planForegroundTabChanged({
  tabId: undefined,
  reason: "window_focus_changed",
}), { syncForeground: true });
assert.deepEqual(planForegroundTabChanged({
  tabId: 8,
  reason: "tab_activated",
}), { syncForeground: true });
assert.deepEqual(planForegroundTabChanged({
  tabId: 8,
  reason: "tab_activated",
  owner: { sessionId: "session" },
}), { syncForeground: true });
assert.deepEqual(planForegroundTabChanged({
  tabId: 8,
  reason: "tab_replaced",
  owner: { sessionId: "session", logicalActiveTabId: 9 },
}), {
  syncForeground: true,
  logicalActiveUpdate: {
    sessionId: "session",
    tabId: 9,
    reason: "tab_replaced",
  },
});

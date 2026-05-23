import assert from "node:assert/strict";

import {
  assertActiveSessionTab,
  assertSessionAcceptsAction,
  attachedDebuggerTabIds,
  chooseLogicalActiveTabId,
  firstDefinedGroupId,
  planActiveTabResolution,
  planCleanupSessionTabs,
  planForegroundLogicalActiveUpdate,
  sessionTabForOrigin,
  shouldPruneBrowserSession,
} from "../dist/lifecycle/browser_session_machine.js";

const emptySession = () => ({
  currentTurnId: "",
  lifecycle: { kind: "active" },
  turnLifecycle: { kind: "idle" },
  tabs: new Map(),
  finalizedTabs: new Map(),
  attachedTabIds: new Set(),
});

assert.deepEqual(sessionTabForOrigin(1, "agent"), { tabId: 1, origin: "agent", status: "active" });
assert.doesNotThrow(() => assertSessionAcceptsAction(undefined, "createTab"));
assert.throws(
  () => assertSessionAcceptsAction("human_takeover", "tab command"),
  /tab command rejected because browser control is yielded to the human/,
);

const activeRow = sessionTabForOrigin(1, "agent");
assert.equal(assertActiveSessionTab(activeRow, 1), activeRow);
assert.throws(() => assertActiveSessionTab(undefined, 2), /tab 2 is not owned/);
assert.throws(
  () => assertActiveSessionTab({ tabId: 3, origin: "agent", status: "handoff" }, 3),
  /tab 3 is handoff, not actively controlled/,
);
assert.throws(
  () => assertActiveSessionTab({ tabId: 4, origin: "user", status: "deliverable" }, 4, "tab 4 is not actively controlled"),
  /tab 4 is not actively controlled/,
);

assert.equal(chooseLogicalActiveTabId([]), undefined);
assert.equal(chooseLogicalActiveTabId([
  { tabId: 5, active: false },
  { tabId: 3, active: false },
]), 3);
assert.equal(chooseLogicalActiveTabId([
  { tabId: 5, active: false },
  { tabId: 9, active: true },
  { tabId: 3, active: true },
]), 3);

assert.deepEqual(planActiveTabResolution(1, [
  { tabId: 1, status: "active", live: false },
  { tabId: 2, status: "active", live: true, chromeActive: true },
  { tabId: 3, status: "handoff", live: false },
]), {
  nextActiveTabId: 2,
  removedTabIds: [1, 3],
  cleanup: [1, 3].map((tabId) => ({
    tabId,
    effects: [
      "forget_overlay",
      "remove_session_tab",
      "remove_finalized_tab",
      "detach_debugger",
      "remove_managed_tab",
      "remove_download_owner",
    ],
  })),
  diagnostics: [
    { kind: "active_tab_removed", tabId: 1 },
    { kind: "session_tab_removed", tabId: 3, status: "handoff" },
    { kind: "active_tab_changed", previousTabId: 1, nextTabId: 2 },
  ],
  activeTabChanged: true,
  changed: true,
});
assert.deepEqual(planActiveTabResolution(4, [
  { tabId: 4, status: "active", live: true, chromeActive: false },
  { tabId: 2, status: "active", live: true, chromeActive: true },
]), {
  nextActiveTabId: 4,
  removedTabIds: [],
  cleanup: [],
  diagnostics: [],
  activeTabChanged: false,
  changed: false,
});
assert.deepEqual(planActiveTabResolution(3, [
  { tabId: 3, status: "deliverable", live: true },
]), {
  nextActiveTabId: undefined,
  removedTabIds: [],
  cleanup: [],
  diagnostics: [
    { kind: "active_tab_changed", previousTabId: 3, nextTabId: undefined },
  ],
  activeTabChanged: true,
  changed: true,
});

const foregroundSession = emptySession();
foregroundSession.tabs.set(8, sessionTabForOrigin(8, "agent"));
assert.deepEqual(planForegroundLogicalActiveUpdate(foregroundSession, 8), { shouldUpdate: true, tabId: 8 });
foregroundSession.activeTabId = 8;
assert.deepEqual(planForegroundLogicalActiveUpdate(foregroundSession, 8), { shouldUpdate: false });
foregroundSession.tabs.set(9, { tabId: 9, origin: "agent", status: "handoff" });
assert.deepEqual(planForegroundLogicalActiveUpdate(foregroundSession, 9), { shouldUpdate: false });

const cleanupSession = emptySession();
cleanupSession.tabs.set(1, sessionTabForOrigin(1, "agent"));
cleanupSession.tabs.set(2, sessionTabForOrigin(2, "user"));
cleanupSession.tabs.set(3, { tabId: 3, origin: "agent", status: "handoff" });
assert.deepEqual(
  planCleanupSessionTabs(cleanupSession, "stop").map((step) => [step.tabId, step.effect]),
  [
    [1, "close_agent_tab"],
    [2, "release_controlled_tab"],
  ],
);
assert.deepEqual(
  planCleanupSessionTabs(cleanupSession, "unavailable").map((step) => [step.tabId, step.effect]),
  [
    [1, "release_controlled_tab"],
    [2, "release_controlled_tab"],
  ],
);

cleanupSession.attachedTabIds.add(7);
cleanupSession.attachedTabIds.add(2);
assert.deepEqual(attachedDebuggerTabIds(cleanupSession), [7, 2]);

assert.equal(firstDefinedGroupId([1, 2, 3], (tabId) => tabId === 2 ? 22 : undefined), 22);
assert.equal(firstDefinedGroupId([1, 3], () => undefined), undefined);

assert.equal(shouldPruneBrowserSession(emptySession()), true);
const nonEmptySession = emptySession();
nonEmptySession.finalizedTabs.set(10, { tabId: 10, origin: "agent", status: "deliverable" });
assert.equal(shouldPruneBrowserSession(nonEmptySession), false);

import assert from "node:assert/strict";

import {
  claimableUserTabState,
  isClaimableUserTabInfo,
  isRestrictedBrowserUrl,
  isTabOwnedByAnotherSession,
  ownedActiveTabState,
  planClaimUserTab,
  planSelectedTab,
  planTabRemoved,
  planTabReplaced,
} from "../dist/lifecycle/tab_ownership_machine.js";

const emptySession = () => ({
  currentTurnId: "",
  activeTabId: undefined,
  lifecycle: { kind: "active" },
  turnLifecycle: { kind: "idle" },
  tabs: new Map(),
  finalizedTabs: new Map(),
  attachedTabIds: new Set(),
});

assert.equal(isRestrictedBrowserUrl(undefined), false);
assert.equal(isRestrictedBrowserUrl("https://example.com/"), false);
assert.equal(isRestrictedBrowserUrl("chrome://settings"), true);
assert.equal(isRestrictedBrowserUrl("about:blank"), true);
assert.equal(isRestrictedBrowserUrl("devtools://devtools/bundled/inspector.html"), true);

assert.equal(isClaimableUserTabInfo({ id: 1, url: "https://example.com/" }), true);
assert.equal(isClaimableUserTabInfo({ url: "https://example.com/" }), false);
assert.equal(isClaimableUserTabInfo({ id: 2, url: "chrome://newtab" }), false);

const sessions = new Map();
const sessionA = emptySession();
const sessionB = emptySession();
sessionB.tabs.set(7, { tabId: 7, origin: "agent", status: "active" });
sessions.set("a", sessionA);
sessions.set("b", sessionB);
assert.equal(isTabOwnedByAnotherSession(sessions, "a", 7), true);
assert.equal(isTabOwnedByAnotherSession(sessions, "b", 7), false);
assert.equal(isTabOwnedByAnotherSession(sessions, "a", 8), false);

assert.deepEqual(ownedActiveTabState(undefined, true), {
  owned: true,
  claimRequired: false,
  commandable: true,
  logicalActive: true,
});
assert.deepEqual(ownedActiveTabState("human_takeover", false), {
  owned: true,
  claimRequired: false,
  commandable: false,
  logicalActive: false,
});
assert.deepEqual(claimableUserTabState(), {
  owned: false,
  claimRequired: true,
  commandable: false,
  logicalActive: false,
});

assert.deepEqual(planClaimUserTab({
  tabId: 1,
  claimable: true,
  ownedByAnotherSession: false,
}), { kind: "claim" });
assert.deepEqual(planClaimUserTab({
  tabId: 1,
  claimable: false,
  ownedByAnotherSession: false,
}), { kind: "reject", message: "tab 1 cannot be claimed by open-browser-use" });
assert.deepEqual(planClaimUserTab({
  tabId: 1,
  claimable: true,
  ownedByAnotherSession: true,
}), { kind: "reject", message: "tab 1 is already owned by another open-browser-use session" });

assert.deepEqual(planSelectedTab({
  row: { tabId: 1, origin: "agent", status: "active" },
  claimable: false,
  ownedByAnotherSession: false,
  controlState: undefined,
}), {
  kind: "owned_active",
  state: {
    owned: true,
    claimRequired: false,
    commandable: true,
    logicalActive: true,
  },
});
assert.deepEqual(planSelectedTab({
  row: { tabId: 1, origin: "agent", status: "handoff" },
  claimable: true,
  ownedByAnotherSession: false,
  controlState: undefined,
}), {
  kind: "claimable_user",
  state: claimableUserTabState(),
});
assert.deepEqual(planSelectedTab({
  row: undefined,
  claimable: false,
  ownedByAnotherSession: false,
  controlState: undefined,
}), { kind: "none" });
assert.deepEqual(planSelectedTab({
  row: undefined,
  claimable: true,
  ownedByAnotherSession: true,
  controlState: undefined,
}), { kind: "none" });

const removedSession = emptySession();
removedSession.activeTabId = 1;
removedSession.tabs.set(1, { tabId: 1, origin: "agent", status: "active" });
removedSession.finalizedTabs.set(1, { tabId: 1, origin: "user", status: "deliverable" });
removedSession.attachedTabIds.add(1);
assert.deepEqual(planTabRemoved(removedSession, 1), {
  removeActiveTab: true,
  removeFinalizedTab: true,
  removeAttachedDebugger: true,
  activeTabRepair: { kind: "clear" },
  changed: true,
});
assert.deepEqual(planTabRemoved(removedSession, 2), {
  removeActiveTab: false,
  removeFinalizedTab: false,
  removeAttachedDebugger: false,
  activeTabRepair: { kind: "unchanged" },
  changed: false,
});

const removedActiveWithReplacementSession = emptySession();
removedActiveWithReplacementSession.activeTabId = 1;
removedActiveWithReplacementSession.tabs.set(1, { tabId: 1, origin: "agent", status: "active" });
removedActiveWithReplacementSession.tabs.set(2, { tabId: 2, origin: "user", status: "active" });
assert.deepEqual(planTabRemoved(removedActiveWithReplacementSession, 1), {
  removeActiveTab: true,
  removeFinalizedTab: false,
  removeAttachedDebugger: false,
  activeTabRepair: { kind: "select", tabId: 2 },
  changed: true,
});

const removedFinalizedSession = emptySession();
removedFinalizedSession.activeTabId = 3;
removedFinalizedSession.tabs.set(3, { tabId: 3, origin: "agent", status: "active" });
removedFinalizedSession.finalizedTabs.set(4, { tabId: 4, origin: "agent", status: "deliverable" });
assert.deepEqual(planTabRemoved(removedFinalizedSession, 4), {
  removeActiveTab: false,
  removeFinalizedTab: true,
  removeAttachedDebugger: false,
  activeTabRepair: { kind: "unchanged" },
  changed: true,
});

const replacedSession = emptySession();
replacedSession.activeTabId = 4;
replacedSession.tabs.set(4, { tabId: 4, origin: "agent", status: "active" });
replacedSession.finalizedTabs.set(5, { tabId: 5, origin: "user", status: "deliverable" });
replacedSession.attachedTabIds.add(4);
assert.deepEqual(planTabReplaced(replacedSession, 4, 9), {
  activeRow: { tabId: 9, origin: "agent", status: "active" },
  updateActiveTab: true,
  removeAttachedDebugger: true,
  changed: true,
});
assert.deepEqual(planTabReplaced(replacedSession, 5, 10), {
  finalizedRow: { tabId: 10, origin: "user", status: "deliverable" },
  updateActiveTab: false,
  removeAttachedDebugger: false,
  changed: true,
});
assert.deepEqual(planTabReplaced(replacedSession, 6, 11), {
  updateActiveTab: false,
  removeAttachedDebugger: false,
  changed: false,
});

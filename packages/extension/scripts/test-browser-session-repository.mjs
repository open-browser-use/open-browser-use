import assert from "node:assert/strict";

import { BrowserSessionRepository } from "../dist/browser_session_repository.js";

const persisted = [];
const groupIds = new Map([[1, 10], [3, 30]]);
const repository = new BrowserSessionRepository({
  persistState: async (state) => {
    persisted.push(state);
  },
  groupIdForTab: (tabId) => groupIds.get(tabId),
});

const session = repository.sessionFor("session-a");
assert.equal(repository.sessionFor("session-a"), session);
session.tabs.set(1, { tabId: 1, origin: "agent", status: "active" });
session.finalizedTabs.set(3, { tabId: 3, origin: "user", status: "deliverable" });
session.finalizedTabs.set(4, { tabId: 4, origin: "agent", status: "handoff" });
session.attachedTabIds.add(1);
repository.syncGroupMirrors(session);
assert.equal(session.groupId, 10);
assert.equal(session.deliverableGroupId, 30);
assert.equal(repository.findSessionForTab(1)?.sessionId, "session-a");
assert.equal(repository.isOwnedByAnotherSession("session-b", 1), true);
assert.equal(repository.isOwnedByAnotherSession("session-a", 1), false);
assert.equal(repository.countDeliverableTabs(), 1);

await repository.persist();
assert.equal(persisted.length, 1);
assert.deepEqual(persisted[0].sessions[0].tabs.map((row) => [row.tabId, row.status]), [
  [1, "active"],
  [3, "deliverable"],
  [4, "handoff"],
]);

repository.removeFinalizedTabFromAllSessions(3);
assert.equal(session.finalizedTabs.has(3), false);
assert.equal(repository.countDeliverableTabs(), 0);

session.tabs.delete(1);
session.finalizedTabs.delete(4);
session.attachedTabIds.delete(1);
repository.pruneEmptySessions();
assert.equal(repository.findSessionForTab(1), undefined);

const endedOnly = repository.sessionFor("ended-only");
endedOnly.turnLifecycle = { kind: "ended", sessionId: "ended-only", turnId: "turn-ok", finalization: "ok" };
repository.pruneEmptySessions();
assert.equal(repository.get("ended-only"), undefined);

const endedWithTab = repository.sessionFor("ended-with-tab");
endedWithTab.tabs.set(9, { tabId: 9, origin: "agent", status: "active" });
endedWithTab.turnLifecycle = {
  kind: "ended",
  sessionId: "ended-with-tab",
  turnId: "turn-ok",
  finalization: "ok",
};
assert.deepEqual(
  repository.lifecycleDiagnostics().filter((row) => row.session_id === "ended-with-tab"),
  [],
);

const restored = new BrowserSessionRepository({
  persistState: async (state) => {
    persisted.push(state);
  },
  groupIdForTab: () => undefined,
});
const restoredTabs = [];
let resolveCalls = 0;
await restored.restoreFromStorageValue({
  version: 1,
  sessions: [{
    session_id: "restored",
    label: "Restored",
    activeTabId: 6,
    controlState: "human_takeover",
    tabs: [
      { tabId: 5, origin: "agent", status: "active" },
      { tabId: 6, origin: "user", status: "deliverable" },
      { tabId: 7, origin: "agent", status: "active" },
    ],
  }],
}, {
  getTab: async (tabId) => {
    if (tabId === 7) throw new Error("tab gone");
    return { id: tabId, windowId: 1, active: tabId === 5 };
  },
  restoreDurableTab: async (sessionId, _session, tab, durableTab) => {
    restoredTabs.push({ sessionId, tabId: tab.id, status: durableTab.status });
  },
  repairSessionActiveTab: async (session) => {
    resolveCalls += 1;
    session.activeTabId = 5;
    return {
      nextActiveTabId: 5,
      removedTabIds: [],
      cleanup: [],
      diagnostics: [{ kind: "active_tab_changed", previousTabId: 6, nextTabId: 5 }],
      activeTabChanged: true,
      changed: true,
    };
  },
});
const restoredSession = restored.sessionFor("restored");
assert.equal(restoredSession.label, "Restored");
assert.equal(restoredSession.controlState, "human_takeover");
assert.equal(restoredSession.activeTabId, 5);
assert.equal(restoredSession.tabs.has(5), true);
assert.equal(restoredSession.finalizedTabs.has(6), true);
assert.equal(restoredSession.tabs.has(7), false);
assert.deepEqual(restoredTabs, [
  { sessionId: "restored", tabId: 5, status: "active" },
  { sessionId: "restored", tabId: 6, status: "deliverable" },
]);
assert.equal(resolveCalls, 1);
assert.equal(persisted.at(-1).sessions[0].tabs.some((row) => row.tabId === 7), false);

// Stuck-turn reaper: a persisted actively-executing turn (open/yielded) cannot survive the
// service-worker generation that rehydrates it (its driving native-pipe connection is gone),
// so it is reconciled to idle on restore. Finalize/failed states carry their own recovery
// semantics and are preserved.
const reaped = new BrowserSessionRepository({
  persistState: async () => {},
  groupIdForTab: () => undefined,
});
await reaped.restoreFromStorageValue({
  version: 1,
  sessions: [
    {
      session_id: "stuck-open",
      tabs: [{ tabId: 21, origin: "agent", status: "active" }],
      turnLifecycle: { kind: "open", sessionId: "stuck-open", turnId: "exec-stuck" },
    },
    {
      session_id: "stuck-finalizing",
      tabs: [{ tabId: 23, origin: "agent", status: "active" }],
      turnLifecycle: { kind: "finalizing", sessionId: "stuck-finalizing", turnId: "t-fin" },
    },
    {
      session_id: "legit-failed",
      tabs: [{ tabId: 22, origin: "agent", status: "active" }],
      turnLifecycle: { kind: "failed", sessionId: "legit-failed", turnId: "t-fail", errorCode: "boom", diagnostics: [] },
    },
  ],
}, {
  getTab: async (tabId) => ({ id: tabId, windowId: 1, active: true }),
  restoreDurableTab: async () => {},
  repairSessionActiveTab: async () => ({ nextActiveTabId: undefined, removedTabIds: [], cleanup: [], diagnostics: [], activeTabChanged: false, changed: false }),
});
assert.equal(reaped.sessionFor("stuck-open").tabs.has(21), true, "stuck-open session was restored");
assert.deepEqual(reaped.sessionFor("stuck-open").turnLifecycle, { kind: "idle" }, "open turn reconciled to idle on restore");
assert.equal(reaped.sessionFor("legit-failed").turnLifecycle.kind, "failed", "failed turn preserved on restore");
// finalizing is intentionally NOT reaped here (it carries session-level recovery semantics).
assert.equal(reaped.sessionFor("stuck-finalizing").turnLifecycle.kind, "finalizing", "finalizing turn preserved on restore");

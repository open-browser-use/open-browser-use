import assert from "node:assert/strict";

import { TabLifecycleController } from "../dist/tab_lifecycle_controller.js";

{
  const session = sessionWith({
    activeTabId: 1,
    tabs: [[1, { tabId: 1, origin: "agent", status: "active" }]],
    finalized: [[1, { tabId: 1, origin: "agent", status: "deliverable" }]],
    attached: [1],
  });
  const harness = createHarness({ sessions: [["session-a", session]] });

  await harness.controller.handleTabRemoved(1);

  assert.equal(session.tabs.has(1), false);
  assert.equal(session.finalizedTabs.has(1), false);
  assert.equal(session.attachedTabIds.has(1), false);
  assert.equal(session.activeTabId, undefined);
  assert.deepEqual(harness.calls.forget, [1]);
  assert.deepEqual(harness.calls.removeManaged, [1]);
  assert.deepEqual(harness.calls.removeDownloads, [1]);
  assert.equal(harness.calls.syncAll, 1);
  assert.equal(harness.calls.persist, 1);
  assert.deepEqual(harness.calls.updateTriggers, ["tab_removed"]);
  assert.equal(harness.calls.logs.at(-1).event, "tab.removed");
}

{
  const session = sessionWith({
    activeTabId: 11,
    tabs: [
      [11, { tabId: 11, origin: "agent", status: "active" }],
      [12, { tabId: 12, origin: "user", status: "active" }],
      [13, { tabId: 13, origin: "agent", status: "handoff" }],
    ],
  });
  const harness = createHarness({ sessions: [["session-a", session]] });

  await harness.controller.handleTabRemoved(11);

  assert.equal(session.tabs.has(11), false);
  assert.equal(session.activeTabId, 12);
  assert.equal(harness.calls.persist, 1);
}

{
  const session = sessionWith({
    activeTabId: 21,
    tabs: [[21, { tabId: 21, origin: "agent", status: "active" }]],
    finalized: [[22, { tabId: 22, origin: "agent", status: "deliverable" }]],
  });
  const harness = createHarness({ sessions: [["session-a", session]] });

  await harness.controller.handleTabRemoved(22);

  assert.equal(session.finalizedTabs.has(22), false);
  assert.equal(session.activeTabId, 21);
  assert.equal(harness.calls.persist, 1);
}

{
  const session = sessionWith({
    activeTabId: 31,
    finalized: [[32, { tabId: 32, origin: "agent", status: "deliverable" }]],
  });
  const harness = createHarness({ sessions: [["session-a", session]] });

  await harness.controller.handleTabRemoved(32);

  assert.equal(session.finalizedTabs.has(32), false);
  assert.equal(session.activeTabId, undefined);
  assert.equal(harness.calls.persist, 1);
}

{
  const session = sessionWith({
    activeTabId: 2,
    tabs: [[2, { tabId: 2, origin: "user", status: "active" }]],
    finalized: [[3, { tabId: 3, origin: "agent", status: "deliverable" }]],
    attached: [2],
  });
  const harness = createHarness({ sessions: [["session-a", session]] });

  await harness.controller.handleTabReplaced(20, 2);

  assert.equal(session.tabs.has(2), false);
  assert.deepEqual(session.tabs.get(20), { tabId: 20, origin: "user", status: "active" });
  assert.equal(session.activeTabId, 20);
  assert.equal(session.attachedTabIds.has(2), false);
  assert.deepEqual(harness.calls.replaceOverlay, [[2, 20]]);
  assert.deepEqual(harness.calls.replaceManaged, [[2, 20]]);
  assert.deepEqual(harness.calls.foreground, [[20, "tab_replaced"]]);
  assert.equal(harness.calls.persist, 1);
  assert.equal(harness.calls.logs.at(-1).event, "tab.replaced");
}

{
  const session = sessionWith({
    tabs: [
      [4, { tabId: 4, origin: "agent", status: "active" }],
      [5, { tabId: 5, origin: "user", status: "active" }],
      [6, { tabId: 6, origin: "agent", status: "handoff" }],
    ],
    finalized: [[7, { tabId: 7, origin: "agent", status: "deliverable" }]],
    attached: [8],
  });
  const harness = createHarness({
    sessions: [["session-a", session]],
    overlayTabIds: [9],
    deliverableCount: 1,
  });

  const result = await harness.controller.cleanupAllSessionTabs("stop");

  assert.deepEqual(result, { closedTabs: 1, releasedTabs: 1, keptDeliverables: 1 });
  assert.deepEqual(harness.calls.hide.sort((left, right) => left - right), [4, 5, 6, 8, 9]);
  assert.deepEqual(harness.calls.close, [[4, "cleanupBrowserTabs"]]);
  assert.deepEqual(harness.calls.releaseManaged, [5]);
  assert.deepEqual(harness.calls.detach, [8]);
  assert.equal(session.tabs.has(4), false);
  assert.equal(session.tabs.has(5), false);
  assert.equal(session.tabs.has(6), true);
  assert.equal(session.finalizedTabs.has(7), true);
  assert.equal(session.attachedTabIds.has(8), false);
  assert.equal(harness.calls.syncSession, 1);
  assert.equal(harness.calls.prune, 1);
  assert.equal(harness.calls.persist, 1);
}

{
  const session = sessionWith({
    tabs: [[10, { tabId: 10, origin: "agent", status: "active" }]],
  });
  const harness = createHarness({ sessions: [["session-a", session]] });

  const result = await harness.controller.cleanupAllSessionTabs("unavailable");

  assert.deepEqual(result, { closedTabs: 0, releasedTabs: 1, keptDeliverables: 0 });
  assert.deepEqual(harness.calls.close, []);
  assert.deepEqual(harness.calls.releaseManaged, [10]);
}

{
  const session = sessionWith({
    tabs: [[14, { tabId: 14, origin: "agent", status: "active" }]],
  });
  const harness = createHarness({
    sessions: [["session-a", session]],
    closeAgentTabWithDialogPolicy: async () => {
      throw new Error("close denied by policy");
    },
  });

  const result = await harness.controller.cleanupAllSessionTabs("stop");

  assert.equal(result.closedTabs, 0);
  assert.equal(result.releasedTabs, 0);
  assert.equal(result.keptDeliverables, 0);
  assert.deepEqual(result.failures, [
    { tabId: 14, effect: "close_agent_tab", message: "close denied by policy" },
  ]);
  assert.equal(session.tabs.has(14), true);
  assert.deepEqual(session.lifecycle, {
    kind: "cleanup_failed",
    failures: [{ tabId: 14, errorMessage: "close denied by policy" }],
  });
  assert.deepEqual(harness.calls.removeManaged, []);
  assert.equal(harness.calls.persist, 1);
}

function sessionWith(options = {}) {
  return {
    currentTurnId: "",
    activeTabId: options.activeTabId,
    lifecycle: { kind: "active", ...(options.activeTabId !== undefined ? { activeTabId: options.activeTabId } : {}) },
    turnLifecycle: { kind: "idle" },
    tabs: new Map(options.tabs ?? []),
    finalizedTabs: new Map(options.finalized ?? []),
    attachedTabIds: new Set(options.attached ?? []),
  };
}

function createHarness(options = {}) {
  const sessions = options.sessions ?? [];
  const calls = {
    forget: [],
    replaceOverlay: [],
    hide: [],
    removeManaged: [],
    replaceManaged: [],
    releaseManaged: [],
    close: [],
    cleanupControlled: [],
    detach: [],
    removeDownloads: [],
    syncAll: 0,
    syncSession: 0,
    prune: 0,
    persist: 0,
    foreground: [],
    logs: [],
    updateTriggers: [],
  };
  const controller = new TabLifecycleController({
    sessions: () => sessions.map(([, session]) => session),
    sessionEntries: () => sessions,
    forgetOverlay: (tabId) => {
      calls.forget.push(tabId);
    },
    activeOverlayTabIds: () => options.overlayTabIds ?? [],
    replaceOverlayTabId: async (removedTabId, addedTabId) => {
      calls.replaceOverlay.push([removedTabId, addedTabId]);
    },
    hideCursor: async (tabId) => {
      calls.hide.push(tabId);
    },
    removeManagedTab: async (tabId) => {
      calls.removeManaged.push(tabId);
    },
    replaceManagedTab: async (removedTabId, addedTabId) => {
      calls.replaceManaged.push([removedTabId, addedTabId]);
    },
    releaseManagedTab: options.releaseManagedTab ?? (async (tabId) => {
      calls.releaseManaged.push(tabId);
    }),
    closeAgentTabWithDialogPolicy: options.closeAgentTabWithDialogPolicy ?? (async (_sessionId, _session, tabId, operation) => {
      calls.close.push([tabId, operation]);
    }),
    cleanupControlledTab: options.cleanupControlledTab ?? (async (_session, tabId) => {
      calls.cleanupControlled.push(tabId);
    }),
    detachDebugger: async (tabId) => {
      calls.detach.push(tabId);
    },
    removeDownloadOwnersForTab: (tabId) => {
      calls.removeDownloads.push(tabId);
    },
    syncSessionGroupMirrors: () => {
      calls.syncSession += 1;
    },
    syncAllSessionGroupMirrors: () => {
      calls.syncAll += 1;
    },
    countDeliverableTabs: () => options.deliverableCount ?? 0,
    pruneEmptySessions: () => {
      calls.prune += 1;
    },
    persistSessionState: async () => {
      calls.persist += 1;
    },
    handleForegroundTabChanged: async (tabId, reason) => {
      calls.foreground.push([tabId, reason]);
    },
    appendDebugLog: (level, event, data) => {
      calls.logs.push({ level, event, data });
    },
    schedulePendingExtensionUpdateCheck: (trigger) => {
      calls.updateTriggers.push(trigger);
    },
  });
  return { controller, calls };
}

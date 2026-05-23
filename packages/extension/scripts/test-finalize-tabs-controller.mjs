import assert from "node:assert/strict";

import { FinalizeTabsController } from "../dist/finalize_tabs_controller.js";

{
  const harness = createHarness({
    session: sessionWithTabs([
      [1, { tabId: 1, origin: "agent", status: "active" }],
      [2, { tabId: 2, origin: "user", status: "active" }],
    ]),
  });

  const result = await harness.controller.finalizeTabs(sessionParams(), {});

  assert.equal(result.status, "ok");
  assert.deepEqual(result.closedTabIds, [1]);
  assert.deepEqual(result.releasedTabIds, [2]);
  assert.deepEqual(result.actions.map((action) => [action.tabId, action.desiredStatus, action.outcome]), [
    [1, "close", "closed"],
    [2, "release", "released"],
  ]);
  assert.equal(harness.session.tabs.size, 0);
  assert.deepEqual(harness.session.lifecycle, { kind: "active" });
  assert.equal(harness.session.turnLifecycle.kind, "finalizing");
  assert.equal(harness.session.lastFinalize, undefined);
  assert.deepEqual(harness.calls.close, [1]);
  assert.deepEqual(harness.calls.release, [2]);
  assert.deepEqual(harness.calls.cleanup, [2]);
  assert.equal(harness.calls.persist, 1);
  assert.deepEqual(harness.calls.updateTriggers, ["tabs_finalized"]);
}

{
  const harness = createHarness({
    session: sessionWithTabs([[9, { tabId: 9, origin: "agent", status: "active" }]], {
      controlState: "human_takeover",
    }),
  });

  await assert.rejects(
    () => harness.controller.finalizeTabs(sessionParams(), {}),
    /finalizeTabs blocked during human takeover/,
  );

  assert.equal(harness.session.tabs.has(9), true);
  assert.equal(harness.calls.hide ?? 0, 0);
  assert.deepEqual(harness.calls.close, []);
  assert.deepEqual(harness.calls.release, []);
  assert.equal(harness.calls.persist, 0);
  assert.deepEqual(harness.calls.updateTriggers, []);
}

{
  const harness = createHarness({
    activeTabId: 3,
    session: sessionWithTabs([
      [3, { tabId: 3, origin: "agent", status: "active" }],
      [4, { tabId: 4, origin: "user", status: "active" }],
    ]),
  });

  const result = await harness.controller.finalizeTabs(sessionParams(), {
    keep: [
      { tabId: 3, status: "handoff" },
      { tabId: 4, status: "deliverable" },
    ],
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.actions.map((action) => [action.tabId, action.desiredStatus, action.outcome]), [
    [3, "handoff", "kept_handoff"],
    [4, "deliverable", "kept_deliverable"],
  ]);
  assert.equal(harness.session.tabs.get(3).status, "handoff");
  assert.equal(harness.session.finalizedTabs.get(4).status, "deliverable");
  assert.equal(result.keptTabs.length, 2);
  assert.deepEqual(result.deliverableTabs.map((tab) => [tab.tabId, tab.groupId]), [[4, 104]]);
  assert.deepEqual(result.finalTabs.handoff.map((tab) => tab.tabId), [3]);
  assert.deepEqual(result.finalTabs.deliverable.map((tab) => tab.tabId), [4]);
  assert.equal(result.finalTabs.activeTabId, 3);
  assert.deepEqual(harness.calls.cleanup, [3, 4]);
  assert.deepEqual(harness.calls.setStatus, [[3, "handoff"]]);
  assert.deepEqual(harness.calls.moveDeliverable, [4]);
}

{
  const harness = createHarness({
    session: sessionWithTabs([[5, { tabId: 5, origin: "agent", status: "active" }]], { attached: [5] }),
    closeAgentTabWithDialogPolicy: async () => {
      throw new Error("No tab with id: 5");
    },
  });

  const result = await harness.controller.finalizeTabs(sessionParams(), {});

  assert.equal(result.status, "ok");
  assert.deepEqual(result.actions.map((action) => [action.tabId, action.outcome]), [[5, "tab_gone"]]);
  assert.equal(harness.session.tabs.has(5), false);
  assert.equal(harness.session.attachedTabIds.has(5), false);
  assert.deepEqual(harness.calls.remove, [5]);
}

{
  const harness = createHarness({
    session: sessionWithTabs([[6, { tabId: 6, origin: "user", status: "active" }]]),
    releaseManagedTab: async () => {
      throw new Error("release denied by policy");
    },
  });

  const result = await harness.controller.finalizeTabs(sessionParams(), {});

  assert.equal(result.status, "partial");
  assert.equal(harness.session.lifecycle.kind, "finalize_partial");
  assert.equal(harness.session.lastFinalize.kind, "finalize_partial");
  assert.equal(harness.session.lastFinalize.failures[0].errorCode, "command_disallowed");
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].errorCode, "command_disallowed");
  assert.deepEqual(result.actions.map((action) => [action.tabId, action.outcome, action.errorCode]), [
    [6, "failed", "command_disallowed"],
  ]);
  assert.equal(harness.session.tabs.has(6), true);
  assert.equal(harness.calls.logs.some((log) => log.event === "tabs.finalize.partial_failure"), true);
  assert.deepEqual(harness.calls.updateTriggers, ["tabs_finalized"]);
}

{
  const harness = createHarness({
    session: sessionWithTabs([[7, { tabId: 7, origin: "user", status: "active" }]]),
    repairSessionActiveTab: async () => {
      throw new Error("active tab reconciliation failed");
    },
  });

  const result = await harness.controller.finalizeTabs(sessionParams(), {
    keep: [{ tabId: 7, status: "handoff" }],
  });

  assert.equal(result.status, "fatal");
  assert.equal(harness.session.lifecycle.kind, "finalize_failed");
  assert.equal(harness.session.turnLifecycle.kind, "failed");
  assert.equal(harness.session.lastFinalize.kind, "finalize_failed");
  assert.equal(result.errorCode, "finalize_reconciliation_failed");
  assert.equal(result.finalTabs, null);
  assert.equal(result.failures.at(-1).errorMessage, "active tab reconciliation failed");
  assert.equal(harness.calls.persist, 1);
  assert.deepEqual(harness.calls.updateTriggers, []);
}

{
  const session = sessionWithTabs([], {
    finalized: [[8, { tabId: 8, origin: "agent", status: "deliverable" }]],
  });
  const harness = createHarness({
    session,
    getTab: async (tabId) => {
      if (tabId === 8) throw new Error("Cannot find tab 8");
      return tabForId(tabId);
    },
  });

  const result = await harness.controller.finalizeTabs(sessionParams(), {});

  assert.equal(result.status, "ok");
  assert.deepEqual(result.finalTabs.deliverable, []);
  assert.equal(session.finalizedTabs.has(8), false);
  assert.deepEqual(harness.calls.remove, [8]);
  assert.equal(harness.calls.sync >= 2, true);
}

function sessionParams() {
  return { session_id: "session-a", turn_id: "turn-1" };
}

function sessionWithTabs(activeRows, options = {}) {
  return {
    currentTurnId: "",
    activeTabId: options.activeTabId,
    controlState: options.controlState,
    lifecycle: options.controlState === "human_takeover"
      ? { kind: "human_takeover", activeTabId: options.activeTabId }
      : { kind: "active", ...(options.activeTabId !== undefined ? { activeTabId: options.activeTabId } : {}) },
    turnLifecycle: { kind: "idle" },
    tabs: new Map(activeRows),
    finalizedTabs: new Map(options.finalized ?? []),
    attachedTabIds: new Set(options.attached ?? []),
  };
}

function tabForId(tabId) {
  return {
    id: tabId,
    windowId: 1,
    groupId: 0,
    url: `https://example.test/${tabId}`,
    title: `Tab ${tabId}`,
    active: false,
    pinned: false,
  };
}

function createHarness(overrides = {}) {
  const calls = {
    close: [],
    cleanup: [],
    remove: [],
    release: [],
    setStatus: [],
    moveDeliverable: [],
    persist: 0,
    sync: 0,
    logs: [],
    updateTriggers: [],
  };
  const session = overrides.session ?? sessionWithTabs([]);
  if (overrides.activeTabId !== undefined) session.activeTabId = overrides.activeTabId;

  const controller = new FinalizeTabsController({
    sessionFor: () => session,
    hideSessionTakeover: async () => {
      calls.hide = (calls.hide ?? 0) + 1;
    },
    closeAgentTabWithDialogPolicy: overrides.closeAgentTabWithDialogPolicy ?? (async (_sessionId, _session, tabId) => {
      calls.close.push(tabId);
    }),
    cleanupControlledTab: overrides.cleanupControlledTab ?? (async (_session, tabId) => {
      calls.cleanup.push(tabId);
      session.attachedTabIds.delete(tabId);
    }),
    removeManagedTab: overrides.removeManagedTab ?? (async (tabId) => {
      calls.remove.push(tabId);
    }),
    releaseManagedTab: overrides.releaseManagedTab ?? (async (tabId) => {
      calls.release.push(tabId);
    }),
    setManagedTabStatus: overrides.setManagedTabStatus ?? (async (tabId, status) => {
      calls.setStatus.push([tabId, status]);
    }),
    getTab: overrides.getTab ?? (async (tabId) => tabForId(tabId)),
    moveTabToDeliverableGroup: overrides.moveTabToDeliverableGroup ?? (async (_sessionId, sessionArg, tabId) => {
      calls.moveDeliverable.push(tabId);
      sessionArg.deliverableGroupId = tabId + 100;
      return sessionArg.deliverableGroupId;
    }),
    toTabDto: (tab, row, state = {}) => {
      if (!Number.isInteger(tab.id)) throw new Error("tab did not include an id");
      return {
        tabId: tab.id,
        windowId: tab.windowId,
        groupId: tab.groupId,
        url: tab.url,
        title: tab.title,
        active: tab.active,
        pinned: tab.pinned,
        origin: row?.origin ?? "agent",
        status: row?.status ?? "active",
        owned: row !== undefined,
        claimRequired: row === undefined,
        commandable: row?.status === "active",
        ...state,
      };
    },
    syncSessionGroupMirrors: () => {
      calls.sync += 1;
    },
    repairSessionActiveTab: overrides.repairSessionActiveTab ?? (async () => ({
      nextActiveTabId: session.activeTabId,
      removedTabIds: [],
      cleanup: [],
      diagnostics: [],
      activeTabChanged: false,
      changed: false,
    })),
    persistSessionState: async () => {
      calls.persist += 1;
    },
    appendDebugLog: (level, event, data) => {
      calls.logs.push({ level, event, data });
    },
    schedulePendingExtensionUpdateCheck: (trigger) => {
      calls.updateTriggers.push(trigger);
    },
    isTabGoneError: (error) => /No tab|Cannot find|closed|does not exist|unknown tab/i.test(String(error?.message ?? error)),
  });

  return { controller, session, calls };
}

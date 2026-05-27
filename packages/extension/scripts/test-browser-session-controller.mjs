import assert from "node:assert/strict";

import { BrowserSessionController } from "../dist/browser_session_controller.js";

{
  const harness = createHarness();

  const tab = await harness.controller.createSessionTab(sessionParams(), "https://example.test/new");

  assert.equal(tab.id, 11);
  assert.equal(harness.session.currentTurnId, "turn-1");
  assert.equal(harness.session.activeTabId, 11);
  assert.deepEqual(harness.session.tabs.get(11), { tabId: 11, origin: "agent", status: "active" });
  assert.equal(harness.session.controlState, undefined);
  assert.deepEqual(harness.calls.create, [{ url: "https://example.test/new", active: false }]);
  assert.deepEqual(harness.calls.group, [[11, "agent"]]);
  assert.deepEqual(harness.calls.overlay, [[11, undefined]]);
  assert.equal(harness.calls.persist, 1);
  assert.equal(harness.calls.logs.at(-1).event, "tab.created");
}

{
  const session = sessionWithTabs([
    [1, { tabId: 1, origin: "agent", status: "active" }],
    [2, { tabId: 2, origin: "user", status: "active" }],
  ], {
    activeTabId: 1,
    controlState: "human_takeover",
    finalized: [[3, { tabId: 3, origin: "agent", status: "deliverable" }]],
  });
  const harness = createHarness({
    session,
    tabsById: new Map([[1, tabForId(1, { active: true })]]),
  });

  const result = await harness.controller.getSessionTabs(sessionParams());

  assert.deepEqual(result.tabs.map((tab) => [tab.tabId, tab.commandable, tab.logicalActive]), [[1, false, true]]);
  assert.deepEqual(result.deliverableTabs, []);
  assert.equal(session.tabs.has(2), true);
  assert.equal(session.finalizedTabs.has(3), true);
  assert.deepEqual(result.repair.diagnostics, [
    { kind: "active_tab_removed", tabId: 2 },
    { kind: "session_tab_removed", tabId: 3, status: "deliverable" },
  ]);
  assert.deepEqual(result.repair.cleanup.map((entry) => entry.tabId), [2, 3]);
  assert.deepEqual(harness.calls.remove, []);
  assert.deepEqual(harness.calls.forget, []);
  assert.deepEqual(harness.calls.downloads, []);
  assert.equal(harness.calls.sync, 0);
  assert.equal(harness.calls.persist, 0);
}

{
  const session = sessionWithTabs([
    [1, { tabId: 1, origin: "agent", status: "active" }],
    [2, { tabId: 2, origin: "agent", status: "active" }],
  ], {
    activeTabId: 1,
    attached: [1],
  });
  const harness = createHarness({
    session,
    tabsById: new Map([[2, tabForId(2, { active: true })]]),
  });

  const result = await harness.controller.getSessionTabs(sessionParams());

  assert.deepEqual(result.tabs.map((tab) => [tab.tabId, tab.logicalActive]), [[2, true]]);
  assert.equal(session.tabs.has(1), true);
  assert.equal(session.attachedTabIds.has(1), true);
  assert.equal(session.activeTabId, 1);
  assert.deepEqual(result.repair.diagnostics, [
    { kind: "active_tab_removed", tabId: 1 },
    { kind: "active_tab_changed", previousTabId: 1, nextTabId: 2 },
  ]);
  assert.deepEqual(result.repair.cleanup.map((entry) => entry.tabId), [1]);
  assert.deepEqual(harness.calls.remove, []);
  assert.deepEqual(harness.calls.forget, []);
  assert.deepEqual(harness.calls.detach, []);
  assert.deepEqual(harness.calls.downloads, []);
  assert.equal(harness.calls.sync, 0);
  assert.equal(harness.calls.persist, 0);
}

{
  const session = sessionWithTabs([
    [1, { tabId: 1, origin: "agent", status: "active" }],
    [2, { tabId: 2, origin: "agent", status: "active" }],
  ], {
    activeTabId: 1,
    attached: [1],
  });
  const harness = createHarness({
    session,
    tabsById: new Map([[2, tabForId(2, { active: true })]]),
  });

  const plan = await harness.controller.planSessionActiveTabResolution(session);

  assert.equal(session.tabs.has(1), true);
  assert.equal(session.attachedTabIds.has(1), true);
  assert.equal(session.activeTabId, 1);
  assert.deepEqual(harness.calls.remove, []);
  assert.deepEqual(harness.calls.forget, []);
  assert.deepEqual(harness.calls.detach, []);
  assert.deepEqual(plan.removedTabIds, [1]);
  assert.deepEqual(plan.cleanup.map((entry) => entry.tabId), [1]);
  assert.deepEqual(plan.diagnostics, [
    { kind: "active_tab_removed", tabId: 1 },
    { kind: "active_tab_changed", previousTabId: 1, nextTabId: 2 },
  ]);
}

{
  const session = sessionWithTabs([
    [1, { tabId: 1, origin: "agent", status: "active" }],
    [2, { tabId: 2, origin: "agent", status: "active" }],
  ], {
    activeTabId: 1,
  });
  const harness = createHarness({
    session,
    tabsById: new Map([[2, tabForId(2, { active: true })]]),
  });

  const current = await harness.controller.getCurrentSessionTab(sessionParams());

  assert.equal(current.tabId, 2);
  assert.equal(session.tabs.has(1), true);
  assert.equal(session.activeTabId, 1);
  assert.deepEqual(harness.calls.remove, []);
  assert.equal(harness.calls.sync, 0);
  assert.equal(harness.calls.persist, 0);
}

{
  const session = sessionWithTabs([[4, { tabId: 4, origin: "agent", status: "active" }]]);
  const harness = createHarness({
    session,
    selectedTabs: [tabForId(4, { active: true })],
  });

  const selected = await harness.controller.getSelectedTab(sessionParams());

  assert.equal(selected.tabId, 4);
  assert.equal(selected.owned, true);
  assert.equal(selected.commandable, true);
  assert.equal(session.activeTabId, 4);
  assert.equal(harness.calls.persist, 1);
}

{
  const harness = createHarness({
    selectedTabs: [tabForId(5, { url: "https://claimable.test/" })],
  });

  const selected = await harness.controller.getSelectedTab(sessionParams());

  assert.equal(selected.tabId, 5);
  assert.equal(selected.owned, false);
  assert.equal(selected.claimRequired, true);
  assert.equal(selected.commandable, false);
  assert.equal(harness.calls.persist, 0);
}

{
  const session = sessionWithTabs([], {
    finalized: [[6, { tabId: 6, origin: "agent", status: "deliverable" }]],
  });
  const harness = createHarness({ session, tabsById: new Map([[6, tabForId(6)]]) });

  const tab = await harness.controller.claimUserTab(sessionParams(), 6);

  assert.equal(tab.id, 6);
  assert.equal(session.finalizedTabs.has(6), false);
  assert.deepEqual(session.tabs.get(6), { tabId: 6, origin: "user", status: "active" });
  assert.equal(session.activeTabId, 6);
  assert.equal(session.controlState, undefined);
  assert.deepEqual(harness.calls.removeFinalized, [6]);
  assert.deepEqual(harness.calls.group, [[6, "user"]]);
  assert.equal(harness.calls.syncAll, 1);
  assert.equal(harness.calls.persist, 1);
  assert.equal(harness.calls.logs.at(-1).event, "tab.claimed");
}

{
  const harness = createHarness({
    tabsById: new Map([[9, tabForId(9, { url: "chrome://settings/" })]]),
    isClaimableUserTab: () => false,
  });

  await assert.rejects(
    () => harness.controller.claimUserTab(sessionParams(), 9),
    /tab 9 cannot be claimed/,
  );
}

{
  const session = sessionWithTabs([[7, { tabId: 7, origin: "agent", status: "active", lastCursor: { x: 1, y: 2 } }]], {
    activeTabId: 7,
  });
  const harness = createHarness({ session, tabsById: new Map([[7, tabForId(7)]]) });

  await harness.controller.yieldControl(sessionParams());
  assert.equal(session.controlState, "human_takeover");
  assert.equal(harness.calls.hide, 1);
  assert.throws(
    () => harness.controller.markTurnEnded(sessionParams()),
    /turnEnded rejected because browser control is yielded/,
  );
  assert.equal(session.currentTurnId, "turn-1");

  const resumed = await harness.controller.resumeControl(sessionParams());
  assert.equal(session.controlState, undefined);
  assert.equal(resumed.tab.tabId, 7);
  assert.equal(resumed.tab.commandable, true);
  assert.deepEqual(harness.calls.overlay.at(-1), [7, { x: 1, y: 2 }]);
}

{
  const session = sessionWithTabs([
    [1, { tabId: 1, origin: "agent", status: "active" }],
    [2, { tabId: 2, origin: "agent", status: "active", lastCursor: { x: 4, y: 5 } }],
  ], {
    activeTabId: 1,
    controlState: "human_takeover",
  });
  const harness = createHarness({
    session,
    tabsById: new Map([[2, tabForId(2, { active: true })]]),
  });

  const resumed = await harness.controller.resumeControl(sessionParams());

  assert.equal(resumed.tab.tabId, 2);
  assert.equal(session.controlState, undefined);
  assert.equal(session.tabs.has(1), false);
  assert.equal(session.activeTabId, 2);
  assert.deepEqual(resumed.repair.diagnostics, [
    { kind: "active_tab_removed", tabId: 1 },
    { kind: "active_tab_changed", previousTabId: 1, nextTabId: 2 },
  ]);
  assert.deepEqual(harness.calls.remove, [1]);
  assert.deepEqual(harness.calls.overlay.at(-1), [2, { x: 4, y: 5 }]);
  assert.equal(harness.calls.sync, 1);
  assert.equal(harness.calls.persist, 1);
}

{
  const session = sessionWithTabs([[3, { tabId: 3, origin: "agent", status: "active" }]], {
    activeTabId: 3,
    controlState: "human_takeover",
    attached: [3],
  });
  const harness = createHarness({ session });

  const resumed = await harness.controller.resumeControl(sessionParams());

  assert.equal(resumed.tab, null);
  assert.deepEqual(resumed.repair, {
    status: "blocked",
    reason: "no_active_tab",
    diagnostics: [
      { kind: "active_tab_removed", tabId: 3 },
      { kind: "active_tab_changed", previousTabId: 3, nextTabId: undefined },
    ],
    cleanup: [
      {
        tabId: 3,
        effects: [
          "forget_overlay",
          "remove_session_tab",
          "remove_finalized_tab",
          "detach_debugger",
          "remove_managed_tab",
          "remove_download_owner",
        ],
      },
    ],
  });
  assert.equal(session.controlState, "human_takeover");
  assert.equal(session.tabs.has(3), false);
  assert.equal(session.activeTabId, undefined);
  assert.deepEqual(harness.calls.remove, [3]);
  assert.deepEqual(harness.calls.detach, [3]);
  assert.equal(harness.calls.sync, 1);
  assert.equal(harness.calls.persist, 1);
}

{
  const session = sessionWithTabs([[8, { tabId: 8, origin: "agent", status: "active" }]]);
  const harness = createHarness({
    session,
    tabsById: new Map([[8, tabForId(8, { active: true })]]),
  });

  const current = await harness.controller.requireCurrentSessionTabForBrowserCommand(
    sessionParams(),
    "browser visibility get",
  );
  assert.equal(current.tabId, 8);
  assert.equal(session.activeTabId, 8);
  assert.equal(harness.calls.persist, 1);

  const row = harness.controller.requireSessionTab(sessionParams(), 8);
  assert.equal(row.tabId, 8);
  assert.equal(session.activeTabId, 8);
}

{
  const session = sessionWithTabs([
    [1, { tabId: 1, origin: "agent", status: "active" }],
    [2, { tabId: 2, origin: "agent", status: "active" }],
  ], {
    activeTabId: 1,
  });
  const harness = createHarness({
    session,
    tabsById: new Map([[2, tabForId(2, { active: true })]]),
  });

  const current = await harness.controller.requireCurrentSessionTabForBrowserCommand(
    sessionParams(),
    "browser visibility get",
  );

  assert.equal(current.tabId, 2);
  assert.equal(current.row.tabId, 2);
  assert.equal(session.tabs.has(1), false);
  assert.equal(session.activeTabId, 2);
  assert.deepEqual(harness.calls.remove, [1]);
  assert.equal(harness.calls.sync, 1);
  assert.equal(harness.calls.persist, 1);
}

{
  const session = sessionWithTabs([[1, { tabId: 1, origin: "agent", status: "active" }]], {
    activeTabId: 1,
  });
  const harness = createHarness({ session });

  const current = await harness.controller.getCurrentSessionTab(sessionParams());

  assert.equal(current, null);
  assert.equal(session.tabs.has(1), true);
  assert.equal(session.activeTabId, 1);
  assert.deepEqual(harness.calls.remove, []);
  assert.equal(harness.calls.sync, 0);
  assert.equal(harness.calls.persist, 0);
}

{
  const session = sessionWithTabs([[10, { tabId: 10, origin: "agent", status: "active" }]], {
    controlState: "human_takeover",
  });
  const harness = createHarness({ session, tabsById: new Map([[10, tabForId(10)]]) });

  await assert.rejects(
    () => harness.controller.requireCurrentSessionTabForBrowserCommand(sessionParams(), "browser viewport set"),
    /rejected because browser control is yielded/,
  );
}

// Finding 19: finalize_partial and resuming must be blocked by ensureSessionAcceptsAction

{
  const params = { session_id: "s1", turn_id: "t1" };
  for (const kind of ["finalize_partial", "resuming"]) {
    const lifecycle =
      kind === "finalize_partial"
        ? { kind, turnId: "t0", failures: [] }
        : { kind, repairPlanId: "p1" };
    const errorPattern =
      kind === "finalize_partial" ? /finalized partially/ : /session is resuming/;
    const session = sessionWithTabs([], { lifecycle });
    const harness = createHarness({ session });
    await assert.rejects(
      () => harness.controller.createSessionTab(params, "about:blank"),
      errorPattern,
      `createSessionTab must reject while ${kind}`,
    );
    assert.equal(session.lifecycle.kind, kind, `${kind} must not be rewritten to active by createSessionTab`);
  }
}

{
  const params = { session_id: "s1", turn_id: "t1" };
  for (const kind of ["finalize_partial", "resuming"]) {
    const lifecycle =
      kind === "finalize_partial"
        ? { kind, turnId: "t0", failures: [] }
        : { kind, repairPlanId: "p1" };
    const errorPattern =
      kind === "finalize_partial" ? /finalized partially/ : /session is resuming/;
    const session = sessionWithTabs([], { lifecycle });
    const harness = createHarness({
      session,
      tabsById: new Map([[8, tabForId(8, { active: true })]]),
    });
    await assert.rejects(
      () => harness.controller.requireCurrentSessionTabForBrowserCommand(params, "browser viewport set"),
      errorPattern,
      `requireCurrentSessionTabForBrowserCommand must reject while ${kind}`,
    );
    assert.equal(session.lifecycle.kind, kind, `${kind} must not be rewritten to active by requireCurrentSessionTabForBrowserCommand`);
  }
}

{
  const params = { session_id: "s1", turn_id: "t1" };
  for (const kind of ["finalize_partial", "resuming"]) {
    const lifecycle =
      kind === "finalize_partial"
        ? { kind, turnId: "t0", failures: [] }
        : { kind, repairPlanId: "p1" };
    const errorPattern =
      kind === "finalize_partial" ? /finalized partially/ : /session is resuming/;
    const session = sessionWithTabs([[8, { tabId: 8, origin: "agent", status: "active" }]], { lifecycle });
    const harness = createHarness({ session });
    assert.throws(
      () => harness.controller.requireSessionTab(params, 8),
      errorPattern,
      `requireSessionTab must reject while ${kind}`,
    );
    assert.equal(session.lifecycle.kind, kind, `${kind} must not be rewritten to active by requireSessionTab`);
  }
}

function sessionParams() {
  return { session_id: "session-a", turn_id: "turn-1" };
}

function sessionWithTabs(activeRows, options = {}) {
  let lifecycle;
  if (options.lifecycle !== undefined) {
    lifecycle = options.lifecycle;
  } else if (options.controlState === "human_takeover") {
    lifecycle = { kind: "human_takeover", activeTabId: options.activeTabId };
  } else {
    lifecycle = { kind: "active", ...(options.activeTabId !== undefined ? { activeTabId: options.activeTabId } : {}) };
  }
  return {
    currentTurnId: "",
    activeTabId: options.activeTabId,
    controlState: options.controlState,
    lifecycle,
    turnLifecycle: { kind: "idle" },
    tabs: new Map(activeRows),
    finalizedTabs: new Map(options.finalized ?? []),
    attachedTabIds: new Set(options.attached ?? []),
  };
}

function tabForId(tabId, overrides = {}) {
  return {
    id: tabId,
    windowId: 1,
    groupId: 0,
    url: `https://example.test/${tabId}`,
    title: `Tab ${tabId}`,
    active: false,
    pinned: false,
    ...overrides,
  };
}

function createHarness(overrides = {}) {
  const session = overrides.session ?? sessionWithTabs([]);
  const tabsById = overrides.tabsById ?? new Map();
  const selectedTabs = overrides.selectedTabs ?? [];
  const calls = {
    create: [],
    group: [],
    remove: [],
    forget: [],
    detach: [],
    downloads: [],
    removeFinalized: [],
    overlay: [],
    persist: 0,
    sync: 0,
    syncAll: 0,
    hide: 0,
    logs: [],
  };
  const controller = new BrowserSessionController({
    sessionFor: () => session,
    createTab: async (createProperties) => {
      calls.create.push(createProperties);
      const tab = tabForId(11, { url: createProperties.url, active: createProperties.active === true });
      tabsById.set(11, tab);
      return tab;
    },
    getTab: async (tabId) => {
      const tab = tabsById.get(tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}`);
      return tab;
    },
    queryTabs: async (queryInfo) => {
      if (queryInfo.active === true) return selectedTabs;
      return [...tabsById.values()];
    },
    addTabToSessionGroup: async (_sessionId, _session, tabId, origin) => {
      calls.group.push([tabId, origin]);
    },
    renameSession: async (_sessionId, label) => {
      calls.rename = label;
    },
    removeManagedTab: async (tabId) => {
      calls.remove.push(tabId);
    },
    forgetOverlay: (tabId) => {
      calls.forget.push(tabId);
    },
    detachDebugger: async (tabId) => {
      calls.detach.push(tabId);
    },
    removeDownloadOwnersForTab: (tabId) => {
      calls.downloads.push(tabId);
    },
    removeFinalizedTabFromAllSessions: (tabId) => {
      calls.removeFinalized.push(tabId);
      session.finalizedTabs.delete(tabId);
    },
    syncSessionGroupMirrors: () => {
      calls.sync += 1;
    },
    syncAllSessionGroupMirrors: () => {
      calls.syncAll += 1;
    },
    ownedByAnotherSession: overrides.ownedByAnotherSession ?? (() => false),
    isClaimableUserTab: overrides.isClaimableUserTab ?? (() => true),
    toTabDto: (tab, row, state = {}) => ({
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
    }),
    activateOverlay: async (tabId, _sessionParams, savedCursor) => {
      calls.overlay.push([tabId, savedCursor]);
    },
    hideSessionTakeover: async () => {
      calls.hide += 1;
    },
    persistSessionState: async () => {
      calls.persist += 1;
    },
    appendDebugLog: (level, event, data) => {
      calls.logs.push({ level, event, data });
    },
    isTabGoneError: (error) => /No tab|Cannot find|closed|does not exist|unknown tab/i.test(String(error?.message ?? error)),
  });
  return { controller, session, calls };
}

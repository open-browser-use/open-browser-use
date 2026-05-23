import assert from "node:assert/strict";

import {
  assertSessionAcceptsAction,
  endedTurnLifecycle,
  finalizingTurnLifecycle,
  humanTakeoverLifecycle,
  openTurnLifecycle,
  planCleanupSessionTabs,
  sessionTabForOrigin,
  shouldPruneBrowserSession,
  yieldedTurnLifecycle,
} from "../dist/lifecycle/browser_session_machine.js";
import {
  planFinalizeTabs,
} from "../dist/lifecycle/finalize_tabs_machine.js";
import {
  createPendingExtensionUpdate,
  planApplyPendingExtensionUpdate,
  snapshotBrowserControlActivity,
} from "../dist/lifecycle/extension_update_machine.js";
import {
  planReconnect,
} from "../dist/lifecycle/native_transport_machine.js";
import {
  planSelectedTab,
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

const session = emptySession();
session.activeTabId = 10;
session.lifecycle = humanTakeoverLifecycle(10);
session.turnLifecycle = yieldedTurnLifecycle("session-a", "turn-1");
session.tabs.set(10, sessionTabForOrigin(10, "agent"));

assert.throws(
  () => assertSessionAcceptsAction("human_takeover", "coordinate.click"),
  /coordinate\.click rejected because browser control is yielded to the human/,
);
assert.deepEqual(planSelectedTab({
  row: session.tabs.get(10),
  claimable: false,
  ownedByAnotherSession: false,
  controlState: "human_takeover",
}), {
  kind: "owned_active",
  state: {
    owned: true,
    claimRequired: false,
    commandable: false,
    logicalActive: true,
  },
});
assert.equal(
  shouldPruneBrowserSession(session),
  false,
  "a yielded human-takeover session must remain recoverable for resumeControl",
);

assert.deepEqual(openTurnLifecycle("session-a", "turn-2"), {
  kind: "open",
  sessionId: "session-a",
  turnId: "turn-2",
});
assert.deepEqual(finalizingTurnLifecycle("session-a", "turn-2"), {
  kind: "finalizing",
  sessionId: "session-a",
  turnId: "turn-2",
});
assert.deepEqual(endedTurnLifecycle("session-a", "turn-2", undefined), {
  kind: "ended",
  sessionId: "session-a",
  turnId: "turn-2",
  finalization: "ok",
});
assert.deepEqual(endedTurnLifecycle("session-a", "turn-2", [{
  tabId: 11,
  desiredStatus: "close",
  outcome: "failed",
  errorCode: "dialog_requires_decision",
  errorMessage: "confirm required",
}]), {
  kind: "ended_partial",
  sessionId: "session-a",
  turnId: "turn-2",
  failures: [{
    tabId: 11,
    desiredStatus: "close",
    outcome: "failed",
    errorCode: "dialog_requires_decision",
    errorMessage: "confirm required",
  }],
});

const cleanupSession = emptySession();
const agentActiveTab = sessionTabForOrigin(1, "agent");
const userActiveTab = sessionTabForOrigin(2, "user");
cleanupSession.tabs.set(1, agentActiveTab);
cleanupSession.tabs.set(2, userActiveTab);
cleanupSession.tabs.set(3, { tabId: 3, origin: "agent", status: "handoff" });
cleanupSession.finalizedTabs.set(4, { tabId: 4, origin: "user", status: "deliverable" });
assert.deepEqual(
  planCleanupSessionTabs(cleanupSession, "stop").map((step) => [step.tabId, step.effect]),
  [
    [1, "close_agent_tab"],
    [2, "release_controlled_tab"],
  ],
  "cleanup may only mutate actively controlled tabs",
);
const activeTabsForFinalize = new Map([
  [1, agentActiveTab],
  [2, userActiveTab],
]);
assert.deepEqual(
  planFinalizeTabs(activeTabsForFinalize, new Map([[2, "deliverable"]])).steps
    .map((step) => [step.tabId, step.desiredStatus, step.effect]),
  [
    [1, "close", "close_agent_tab"],
    [2, "deliverable", "keep_deliverable"],
  ],
);
const finalizedSession = emptySession();
finalizedSession.lastFinalize = { status: "partial" };
assert.equal(
  shouldPruneBrowserSession(finalizedSession),
  false,
  "finalize diagnostics must survive until surfaced to the SDK",
);

const pendingUpdate = createPendingExtensionUpdate({ version: "0.4.0" }, 100);
const activeControl = snapshotBrowserControlActivity({
  activeTakeoverCount: 0,
  overlayPendingActivity: false,
  debuggerAttachLockCount: 0,
  nativePendingRequests: false,
  nativeState: "connected",
  nativeHelloPending: false,
  nativeReconnectPending: false,
  activeSessionTabCount: 1,
  debuggerAttachedTabCount: 1,
});
assert.deepEqual(planApplyPendingExtensionUpdate({
  pending: pendingUpdate,
  activity: activeControl,
  now: 120,
  blockAfterMs: 1000,
}), {
  kind: "wait_for_idle",
  pending: {
    state: "waiting_for_idle",
    version: "0.4.0",
    pendingSince: 100,
    reasons: ["active_session_tab", "debugger_attached"],
  },
  reasons: ["active_session_tab", "debugger_attached"],
  ageMs: 20,
});
assert.deepEqual(planApplyPendingExtensionUpdate({
  pending: pendingUpdate,
  activity: activeControl,
  now: 1_200,
  blockAfterMs: 1_000,
}), {
  kind: "blocked",
  pending: {
    state: "blocked",
    version: "0.4.0",
    pendingSince: 100,
    blockedSince: 1_200,
    reasons: ["active_session_tab", "debugger_attached"],
    nextAction: "stop_control",
  },
  reasons: ["active_session_tab", "debugger_attached"],
  ageMs: 1_100,
  nextAction: "stop_control",
});

const nativeUnready = snapshotBrowserControlActivity({
  activeTakeoverCount: 0,
  overlayPendingActivity: false,
  debuggerAttachLockCount: 0,
  nativePendingRequests: false,
  nativeState: "hello_pending",
  nativeHelloPending: true,
  nativeReconnectPending: true,
  activeSessionTabCount: 0,
  debuggerAttachedTabCount: 0,
});
assert.deepEqual(planApplyPendingExtensionUpdate({
  pending: pendingUpdate,
  activity: nativeUnready,
  now: 1_200,
  blockAfterMs: 1_000,
}), {
  kind: "blocked",
  pending: {
    state: "blocked",
    version: "0.4.0",
    pendingSince: 100,
    blockedSince: 1_200,
    reasons: ["native_hello_pending", "native_reconnect_pending"],
    nextAction: "manual_ack",
  },
  reasons: ["native_hello_pending", "native_reconnect_pending"],
  ageMs: 1_100,
  nextAction: "manual_ack",
});

assert.deepEqual(planApplyPendingExtensionUpdate({
  pending: pendingUpdate,
  activity: snapshotBrowserControlActivity({
    activeTakeoverCount: 0,
    overlayPendingActivity: false,
    debuggerAttachLockCount: 0,
    nativePendingRequests: false,
    nativeState: "connected",
    nativeHelloPending: false,
    nativeReconnectPending: false,
    activeSessionTabCount: 0,
    debuggerAttachedTabCount: 0,
  }),
  now: 130,
}), {
  kind: "reload",
  pending: {
    state: "reloading",
    version: "0.4.0",
    pendingSince: 100,
    reloadingAt: 130,
  },
  version: "0.4.0",
});

assert.deepEqual(planReconnect({
  stopping: false,
  state: "hello_pending",
  reconnectTimerActive: false,
  reconnectDelayMs: 1_000,
  reconnectMaxMs: 30_000,
  now: 200,
}), { shouldSchedule: false });
assert.deepEqual(planReconnect({
  stopping: false,
  state: "error",
  reconnectTimerActive: false,
  reconnectDelayMs: 1_000,
  reconnectMaxMs: 30_000,
  now: 200,
}), {
  shouldSchedule: true,
  delayMs: 1_000,
  nextRetryAt: 1_200,
  nextReconnectDelayMs: 2_000,
  statusPatch: {
    state: "reconnect_scheduled",
    retryDelayMs: 1_000,
    nextRetryAt: 1_200,
    updatedAt: 200,
  },
});

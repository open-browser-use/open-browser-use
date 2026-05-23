import assert from "node:assert/strict";

import {
  acknowledgePendingExtensionUpdate,
  createPendingExtensionUpdate,
  parsePendingExtensionUpdate,
  planApplyPendingExtensionUpdate,
  planPendingExtensionUpdateCheck,
  queuedPendingExtensionUpdateTrigger,
  snapshotBrowserControlActivity,
  statusWithPendingExtensionUpdate,
} from "../dist/lifecycle/extension_update_machine.js";

assert.deepEqual(parsePendingExtensionUpdate(null), undefined);
assert.deepEqual(parsePendingExtensionUpdate({ state: "ready", pendingSince: 1 }), undefined);
assert.deepEqual(parsePendingExtensionUpdate({ state: "waiting_for_idle" }), undefined);
assert.deepEqual(parsePendingExtensionUpdate({
  state: "waiting_for_idle",
  version: "",
  pendingSince: 10,
}), {
  state: "waiting_for_idle",
  pendingSince: 10,
});
assert.deepEqual(parsePendingExtensionUpdate({
  state: "waiting_for_idle",
  version: "0.2.0",
  pendingSince: 10,
  reasons: ["active_session_tab", "active_session_tab"],
}), {
  state: "waiting_for_idle",
  version: "0.2.0",
  pendingSince: 10,
  reasons: ["active_session_tab"],
});
assert.deepEqual(parsePendingExtensionUpdate({
  state: "blocked",
  version: "0.2.0",
  pendingSince: 10,
  blockedSince: 40,
  reasons: ["overlay_pending"],
  nextAction: "repair_lifecycle",
}), {
  state: "blocked",
  version: "0.2.0",
  pendingSince: 10,
  blockedSince: 40,
  reasons: ["overlay_pending"],
  nextAction: "repair_lifecycle",
});
assert.deepEqual(parsePendingExtensionUpdate({
  state: "reloading",
  version: "0.2.0",
  pendingSince: 10,
  reloadingAt: 50,
}), {
  state: "reloading",
  version: "0.2.0",
  pendingSince: 10,
  reloadingAt: 50,
});

const pending = createPendingExtensionUpdate({ version: "0.3.0" }, 20);
assert.deepEqual(pending, {
  state: "waiting_for_idle",
  version: "0.3.0",
  pendingSince: 20,
});
assert.deepEqual(createPendingExtensionUpdate({ version: "" }, 21), {
  state: "waiting_for_idle",
  pendingSince: 21,
});

assert.deepEqual(statusWithPendingExtensionUpdate({ state: "connected", updatedAt: 1 }, pending), {
  state: "connected",
  updatedAt: 1,
  pendingExtensionUpdate: pending,
});
assert.deepEqual(statusWithPendingExtensionUpdate({
  state: "connected",
  updatedAt: 1,
  pendingExtensionUpdate: pending,
}, undefined), {
  state: "connected",
  updatedAt: 1,
});

assert.deepEqual(planPendingExtensionUpdateCheck({
  pending: undefined,
  timerActive: false,
  trigger: "update_available",
}), { kind: "none" });
assert.deepEqual(planPendingExtensionUpdateCheck({
  pending,
  timerActive: true,
  trigger: "tabs_finalized",
}), {
  kind: "queue",
  trigger: "tabs_finalized",
  shouldScheduleTimer: false,
});
assert.deepEqual(planPendingExtensionUpdateCheck({
  pending,
  timerActive: false,
  trigger: "update_available",
}), {
  kind: "schedule",
  trigger: "update_available",
  shouldScheduleTimer: true,
});
assert.equal(queuedPendingExtensionUpdateTrigger(undefined, "background_bootstrap"), "background_bootstrap");
assert.equal(queuedPendingExtensionUpdateTrigger("tabs_finalized", "background_bootstrap"), "tabs_finalized");

const idle = snapshotBrowserControlActivity({
  activeTakeoverCount: 0,
  overlayPendingActivity: false,
  debuggerAttachLockCount: 0,
  nativePendingRequests: false,
  nativeState: "connected",
  nativeHelloPending: false,
  nativeReconnectPending: false,
  activeSessionTabCount: 0,
  debuggerAttachedTabCount: 0,
});
assert.deepEqual(idle, { active: false, reasons: [] });

const active = snapshotBrowserControlActivity({
  activeTakeoverCount: 1,
  overlayPendingActivity: true,
  debuggerAttachLockCount: 2,
  nativePendingRequests: true,
  nativeState: "connecting",
  nativeHelloPending: true,
  nativeReconnectPending: true,
  activeSessionTabCount: 3,
  debuggerAttachedTabCount: 4,
});
assert.deepEqual(active, {
  active: true,
  reasons: [
    "active_takeover",
    "overlay_pending",
    "debugger_attach_lock",
    "native_request_pending",
    "native_hello_pending",
    "native_reconnect_pending",
    "active_session_tab",
    "debugger_attached",
  ],
});

assert.deepEqual(planApplyPendingExtensionUpdate({ pending: undefined, activity: idle }), { kind: "none" });
assert.deepEqual(planApplyPendingExtensionUpdate({ pending, activity: active, now: 25 }), {
  kind: "wait_for_idle",
  pending: {
    state: "waiting_for_idle",
    version: "0.3.0",
    pendingSince: 20,
    reasons: active.reasons,
  },
  reasons: active.reasons,
  ageMs: 5,
});
assert.deepEqual(planApplyPendingExtensionUpdate({ pending, activity: active, now: 50, blockAfterMs: 30 }), {
  kind: "blocked",
  pending: {
    state: "blocked",
    version: "0.3.0",
    pendingSince: 20,
    blockedSince: 50,
    reasons: active.reasons,
    nextAction: "repair_lifecycle",
  },
  reasons: active.reasons,
  ageMs: 30,
  nextAction: "repair_lifecycle",
});
assert.deepEqual(planApplyPendingExtensionUpdate({ pending, activity: idle, now: 60 }), {
  kind: "reload",
  pending: {
    state: "reloading",
    version: "0.3.0",
    pendingSince: 20,
    reloadingAt: 60,
  },
  version: "0.3.0",
});
assert.deepEqual(planApplyPendingExtensionUpdate({
  pending: createPendingExtensionUpdate({}, 22),
  activity: idle,
  now: 70,
}), {
  kind: "reload",
  pending: {
    state: "reloading",
    pendingSince: 22,
    reloadingAt: 70,
  },
});
assert.deepEqual(acknowledgePendingExtensionUpdate(pending, "manual defer", 80), {
  state: "acknowledged_deferred",
  version: "0.3.0",
  pendingSince: 20,
  acknowledgedAt: 80,
  reason: "manual defer",
});
assert.deepEqual(planApplyPendingExtensionUpdate({
  pending: acknowledgePendingExtensionUpdate(pending, "manual defer", 80),
  activity: idle,
  now: 90,
}), { kind: "none" });

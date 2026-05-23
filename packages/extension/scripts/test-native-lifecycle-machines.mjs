import assert from "node:assert/strict";

import {
  baseDisconnectedStatus,
  canReconnect,
  connectingStatus,
  connectFailureStatus,
  disconnectedStatus,
  heartbeatFailureStatus,
  helloAckStatus,
  helloPendingStatus,
  helloTimeoutStatus,
  planReconnect,
  planRestorePendingReconnect,
  stoppedStatus,
  stoppingStatus,
  versionMismatchStatus,
} from "../dist/lifecycle/native_transport_machine.js";
import {
  planNativeResponse,
  planPendingRejection,
} from "../dist/lifecycle/native_request_bridge_machine.js";

assert.deepEqual(connectingStatus(10), { state: "connecting", updatedAt: 10 });
assert.deepEqual(baseDisconnectedStatus(11), { state: "disconnected", updatedAt: 11 });
assert.deepEqual(stoppedStatus("Stopped by user", 12), { state: "stopped", message: "Stopped by user", updatedAt: 12 });
assert.deepEqual(stoppingStatus("Stopping...", 12), { state: "stopping", message: "Stopping...", updatedAt: 12 });
assert.deepEqual(helloAckStatus("0.1.0", 13), { state: "connected", hostVersion: "0.1.0", updatedAt: 13 });
assert.deepEqual(helloPendingStatus(13), { state: "hello_pending", updatedAt: 13 });
assert.deepEqual(helloTimeoutStatus(14), {
  state: "error",
  message: "native host hello timed out",
  diagnosis: "native_host_hello_timeout",
  updatedAt: 14,
});
assert.deepEqual(versionMismatchStatus("host too old", 15), {
  state: "version_mismatch",
  message: "host too old",
  diagnosis: "version_mismatch",
  updatedAt: 15,
});
assert.deepEqual(connectFailureStatus("missing", "native_host_not_found", 16), {
  state: "error",
  message: "missing",
  diagnosis: "native_host_not_found",
  updatedAt: 16,
});
assert.deepEqual(disconnectedStatus({
  message: "native host exited before hello_ack",
  diagnosis: "native_host_crashed",
  wasConnecting: true,
  now: 17,
}), {
  state: "error",
  message: "native host exited before hello_ack",
  diagnosis: "native_host_crashed",
  updatedAt: 17,
});
assert.deepEqual(heartbeatFailureStatus({
  message: "native host heartbeat timed out",
  diagnosis: "native_host_heartbeat_timeout",
  now: 18,
}), {
  state: "heartbeat_failed",
  message: "native host heartbeat timed out",
  diagnosis: "native_host_heartbeat_timeout",
  updatedAt: 18,
});

assert.equal(canReconnect({ stopping: false, state: "disconnected" }), true);
assert.equal(canReconnect({ stopping: true, state: "disconnected" }), false);
assert.equal(canReconnect({ stopping: false, state: "connected" }), false);
assert.equal(canReconnect({ stopping: false, state: "version_mismatch" }), false);

assert.deepEqual(planReconnect({
  stopping: false,
  state: "error",
  reconnectTimerActive: false,
  reconnectDelayMs: 1_000,
  reconnectMaxMs: 30_000,
  now: 100,
}), {
  shouldSchedule: true,
  delayMs: 1_000,
  nextRetryAt: 1_100,
  nextReconnectDelayMs: 2_000,
  statusPatch: {
    state: "reconnect_scheduled",
    retryDelayMs: 1_000,
    nextRetryAt: 1_100,
    updatedAt: 100,
  },
});
assert.deepEqual(planReconnect({
  stopping: false,
  state: "error",
  reconnectTimerActive: true,
  reconnectDelayMs: 1_000,
  reconnectMaxMs: 30_000,
  now: 100,
}), { shouldSchedule: false });

assert.deepEqual(planRestorePendingReconnect({
  storedState: "disconnected",
  storedRetryDelayMs: 2_000,
  storedNextRetryAt: 10_000,
  reconnectInitialMs: 1_000,
  reconnectMaxMs: 30_000,
  now: 5_000,
}), {
  shouldRestore: true,
  retryDelayMs: 2_000,
  nextRetryAt: 10_000,
  nextReconnectDelayMs: 4_000,
  updatedAt: 5_000,
});
assert.deepEqual(planRestorePendingReconnect({
  storedState: "connected",
  storedNextRetryAt: 10_000,
  reconnectInitialMs: 1_000,
  reconnectMaxMs: 30_000,
  now: 5_000,
}), { shouldRestore: false });

assert.deepEqual(planNativeResponse({ result: "pong" }, true), { kind: "success", result: "pong" });
assert.deepEqual(planNativeResponse({
  error: {
    code: -1002,
    message: "boom",
    data: { code: "navigation_disallowed", url: "https://blocked.example/" },
  },
}, true), {
  kind: "error",
  error: {
    code: -1002,
    message: "boom",
    data: { code: "navigation_disallowed", url: "https://blocked.example/" },
  },
});
assert.deepEqual(planNativeResponse({ result: "late" }, false), { kind: "missing" });
assert.deepEqual(planPendingRejection(0, "stopped"), { shouldLog: false });
assert.deepEqual(planPendingRejection(2, "stopped"), {
  shouldLog: true,
  level: "warn",
  event: "native.pending.rejected",
  data: { count: 2, message: "stopped" },
});

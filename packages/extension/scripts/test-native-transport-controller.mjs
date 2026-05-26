import assert from "node:assert/strict";

import { NativeTransportController } from "../dist/native_transport_controller.js";

const isHostStatus = (value) => value && typeof value === "object" && typeof value.state === "string";

class FakePort {
  sent = [];
  disconnected = false;
  onMessage = new FakeEvent();
  onDisconnect = new FakeEvent();

  postMessage(message) {
    this.sent.push(message);
  }

  disconnect() {
    this.disconnected = true;
    this.onDisconnect.emit();
  }
}

class FakeEvent {
  listeners = [];

  addListener(listener) {
    this.listeners.push(listener);
  }

  emit(...args) {
    for (const listener of this.listeners) listener(...args);
  }
}

{
  const harness = createHarness();
  await harness.controller.bootstrap({ state: "stopped", updatedAt: 1 }, isHostStatus);
  assert.equal(harness.controller.currentStatus().state, "stopped");
  assert.equal(harness.controller.currentStatus().message, "Stopped by user");
  assert.equal(harness.connectCalls, 0);
}

{
  const harness = createHarness();
  await harness.controller.connect();
  assert.equal(harness.connectCalls, 1);
  assert.equal(harness.controller.currentStatus().state, "hello_pending");
  assert.equal(harness.ports[0].sent[0].type, "hello");
  assert.equal(harness.ports[0].sent[0].extension_instance_id, "instance");

  harness.ports[0].onMessage.emit({ type: "hello_ack", host_version: "0.1.0" });
  await tick();
  assert.equal(harness.controller.currentStatus().state, "connected");
  assert.equal(harness.controller.currentStatus().hostVersion, "0.1.0");
  assert.equal(harness.publishCount, 1);
  assert.deepEqual(harness.pendingUpdateTriggers, ["native_hello_ack"]);
  assert.equal(harness.timers.some((timer) => timer.delayMs === 10_000), true);
}

{
  const harness = createHarness({
    connectNative: () => {
      throw new Error("specified native messaging host not found");
    },
  });
  await harness.controller.connect();
  assert.equal(harness.statuses.some((status) => status.state === "error" && status.diagnosis === "native_host_not_found"), true);
  assert.equal(harness.controller.currentStatus().state, "reconnect_scheduled");
  assert.equal(harness.controller.currentStatus().diagnosis, "native_host_not_found");
  assert.equal(harness.alarms[0].name, "obu.reconnectNativeHost");
  assert.equal(harness.alarms[0].delayMs, 1_000);
}

{
  const harness = createHarness();
  await harness.controller.connect();
  harness.ports[0].onMessage.emit({ type: "hello_ack", host_version: "0.1.0" });
  await tick();
  await harness.controller.stop();
  assert.equal(harness.sendRequests[0].method, "stopBrowserControl");
  assert.deepEqual(harness.sendRequests[0].params, { reason: "popup_stop", extension_instance_id: "instance" });
  assert.equal(harness.stopActiveCount, 1);
  assert.equal(harness.controller.currentStatus().state, "stopped");
  assert.equal(harness.controller.currentStatus().message, "Stopped by user");
  assert.equal(harness.statuses.some((status) => status.state === "stopping"), true);
  assert.equal(harness.pendingUpdateTriggers.at(-1), "control_stopped");
}

{
  const harness = createHarness({
    stopActiveBrowserControl: async () => {
      return { failures: [{ tabId: 41, message: "release denied by policy" }] };
    },
  });
  await harness.controller.connect();
  harness.ports[0].onMessage.emit({ type: "hello_ack", host_version: "0.1.0" });
  await tick();
  await harness.controller.stop();

  assert.equal(harness.controller.currentStatus().state, "cleanup_failed");
  assert.match(harness.controller.currentStatus().message, /Stop cleanup failed for 1 tab/);
  assert.equal(harness.pendingUpdateTriggers.includes("control_stopped"), false);
}

function createHarness(overrides = {}) {
  const ports = [];
  const statuses = [];
  const timers = [];
  const alarms = [];
  const pendingUpdateTriggers = [];
  const sendRequests = [];
  let connectCalls = 0;
  let publishCount = 0;
  let stopActiveCount = 0;
  let now = 100;
  const harness = {
    ports,
    statuses,
    timers,
    alarms,
    pendingUpdateTriggers,
    sendRequests,
    get connectCalls() {
      return connectCalls;
    },
    get publishCount() {
      return publishCount;
    },
    get stopActiveCount() {
      return stopActiveCount;
    },
  };
  const connectNative = overrides.connectNative ?? (() => {
    connectCalls += 1;
    const port = new FakePort();
    ports.push(port);
    return port;
  });
  harness.controller = new NativeTransportController({
    hostName: "dev.obu.host",
    reconnectAlarmName: "obu.reconnectNativeHost",
    helloTimeoutMs: 5_000,
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 5_000,
    reconnectInitialMs: 1_000,
    reconnectMaxMs: 30_000,
    initialStatus: { state: "disconnected", updatedAt: now },
    now: () => now,
    scheduleTimer: (callback, delayMs) => {
      const timer = timers.length + 1;
      timers.push({ callback, delayMs, timer });
      return timer;
    },
    connectNative,
    createReconnectAlarm: (name, delayMs) => alarms.push({ name, delayMs }),
    clearReconnectAlarm: () => undefined,
    runtimeLastErrorMessage: () => undefined,
    appendDebugLog: () => undefined,
    statusLogLevel: () => "info",
    normalizeStatus: (status) => status,
    persistStatus: async (status) => {
      statuses.push(status);
    },
    diagnoseNativeHostFailure: (message, fallback) => {
      if (/not found/i.test(message)) return "native_host_not_found";
      if (/heartbeat timed out/i.test(message)) return "native_host_heartbeat_timeout";
      return fallback;
    },
    rejectPending: () => undefined,
    sendRequest: async (method, params) => {
      sendRequests.push({ method, params });
      return "ok";
    },
    stopRequestParams: async () => ({ reason: "popup_stop", extension_instance_id: "instance" }),
    handleNativeApplicationMessage: async () => undefined,
    releaseActiveTakeoverForUnavailableHost: async () => undefined,
    stopActiveBrowserControl: overrides.stopActiveBrowserControl ?? (async () => {
      stopActiveCount += 1;
    }),
    helloPayload: async () => ({
      type: "hello",
      extension_instance_id: "instance",
    }),
    publishExtensionStatus: () => {
      publishCount += 1;
    },
    schedulePendingExtensionUpdateCheck: (trigger) => {
      pendingUpdateTriggers.push(trigger);
    },
  });
  harness.advance = (ms) => {
    now += ms;
  };
  return harness;
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

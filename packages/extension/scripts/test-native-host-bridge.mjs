import assert from "node:assert/strict";

import {
  JsonRpcError,
  NativeHostBridge,
} from "../dist/native_host_bridge.js";

class FakePort {
  sent = [];

  postMessage(message) {
    this.sent.push(message);
  }
}

{
  const port = new FakePort();
  const logs = [];
  const bridge = new NativeHostBridge(() => port, (level, event, data) => {
    logs.push({ level, event, data });
  });

  const request = bridge.sendRequest("restrictedCommand", {});
  assert.deepEqual(port.sent[0], {
    jsonrpc: "2.0",
    id: 1,
    method: "restrictedCommand",
    params: {},
  });
  assert.deepEqual(bridge.diagnostics().pending.map((row) => [row.kind, row.id, row.method, row.nextAction]), [
    ["pending", 1, "restrictedCommand", "wait"],
  ]);
  assert.equal(bridge.resolveResponse({
    jsonrpc: "2.0",
    id: 1,
    error: {
      code: -1002,
      message: "navigation blocked",
      data: { code: "navigation_disallowed", url: "https://blocked.example/" },
    },
  }), true);
  assert.deepEqual(bridge.diagnostics().recent.map((row) => [row.kind, row.id, row.method, row.nextAction]), [
    ["error", 1, "restrictedCommand", "inspect_error"],
  ]);

  await assert.rejects(request, (error) => {
    assert.equal(error instanceof JsonRpcError, true);
    assert.equal(error.code, -1002);
    assert.equal(error.message, "navigation blocked");
    assert.deepEqual(error.data, { code: "navigation_disallowed", url: "https://blocked.example/" });
    return true;
  });
  assert.deepEqual(logs.at(-1), {
    level: "warn",
    event: "native.response.error",
    data: {
      id: 1,
      code: -1002,
      message: "navigation blocked",
      data: { code: "navigation_disallowed", url: "https://blocked.example/" },
    },
  });
}

{
  const port = new FakePort();
  const bridge = new NativeHostBridge(() => port, () => undefined);

  const request = bridge.sendRequest("slowCommand", {});
  bridge.rejectPending("native host disconnected");
  await assert.rejects(request, /native host disconnected/);
  assert.deepEqual(bridge.diagnostics().pending, []);
  assert.deepEqual(bridge.diagnostics().recent.map((row) => [row.kind, row.id, row.method, row.nextAction]), [
    ["rejected", 1, "slowCommand", "reconnect_or_retry"],
  ]);

  assert.equal(bridge.resolveResponse({ jsonrpc: "2.0", id: 1, result: "late" }), false);
  assert.deepEqual(bridge.diagnostics().recent.at(-1), {
    kind: "late_success",
    id: 1,
    completedAt: bridge.diagnostics().recent.at(-1).completedAt,
    nextAction: "observe_reconcile",
  });
}

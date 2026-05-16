import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const statusKey = "OBU_NATIVE_HOST_STATUS";
const debugLogKey = "OBU_DEBUG_LOG";

class EventTarget {
  listeners = [];

  addListener(listener) {
    this.listeners.push(listener);
  }

  emit(...args) {
    return this.listeners.map((listener) => listener(...args));
  }
}

class FakeElement {
  className = "";
  textContent = "";
  disabled = false;
  listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  click() {
    for (const listener of this.listeners.get("click") ?? []) listener();
  }
}

await runPopupHappyPath();
await runPopupRepairMatrix();
await runPopupResumeFromFailureStates();
await runPopupDebugLogs();
await runPopupInitialFailure("missing status response", [undefined], "Native host status unavailable");
await runPopupInitialFailure("runtime rejection", [new Error("status boom")], "status boom");

async function runPopupHappyPath() {
  const harness = installPopupHarness([
    { state: "connected", hostVersion: "0.1.0" },
    { state: "stopped", message: "Stopped by user" },
    { state: "stopped", message: "Stopped by user" },
    { state: "connecting", message: "Connecting..." },
    { state: "connected", hostVersion: "0.1.0" },
    new Error("stop boom"),
    new Error("refresh boom"),
  ]);

  await importPopup("happy");
  await waitFor(() => harness.elements.statusText.textContent === "Connected");
  assert.equal(harness.elements.dot.className, "dot connected");
  assert.equal(harness.elements.detailText.textContent, "Host 0.1.0");
  assert.equal(harness.elements.stopButton.disabled, false);
  assert.equal(harness.elements.resumeButton.disabled, true);

  harness.storageChanges.emit(
    {
      [statusKey]: {
        newValue: { state: "version_mismatch", message: "Host version is too old" },
      },
    },
    "local",
  );
  assert.equal(harness.elements.statusText.textContent, "Version mismatch");
  assert.equal(harness.elements.resumeButton.disabled, false);
  assert.match(harness.elements.detailText.textContent, /Rebuild and reinstall the native host/);

  harness.storageChanges.emit(
    {
      [statusKey]: {
        newValue: { state: "connected", hostVersion: "0.1.0" },
      },
    },
    "local",
  );
  assert.equal(harness.elements.statusText.textContent, "Connected");

  harness.storageChanges.emit(
    {
      [statusKey]: {
        newValue: { state: "connected", hostVersion: "0.1.0", deliverableTabs: 2 },
      },
    },
    "local",
  );
  assert.equal(harness.elements.statusText.textContent, "Connected");
  assert.match(harness.elements.detailText.textContent, /2 deliverable tabs available/);
  assert.match(harness.elements.detailText.textContent, /browser\.deliverables\(\).*claim\(\)/);

  harness.storageChanges.emit(
    {
      [statusKey]: {
        newValue: { state: "connecting", message: "Opening native host" },
      },
    },
    "local",
  );
  assert.equal(harness.elements.statusText.textContent, "Connecting");
  assert.equal(harness.elements.detailText.textContent, "Opening native host");

  harness.storageChanges.emit(
    {
      [statusKey]: {
        newValue: {
          state: "disconnected",
          message: "native host disconnected",
          retryDelayMs: 2000,
        },
      },
    },
    "local",
  );
  assert.equal(harness.elements.statusText.textContent, "Disconnected");
  assert.equal(harness.elements.resumeButton.disabled, false);
  assert.match(harness.elements.detailText.textContent, /native host disconnected\. Retrying native host connection in 2s/);

  harness.storageChanges.emit(
    {
      [statusKey]: {
        newValue: {
          state: "error",
          message: "Specified native messaging host not found.",
        },
      },
    },
    "local",
  );
  assert.equal(harness.elements.statusText.textContent, "Error");
  assert.equal(harness.elements.resumeButton.disabled, false);
  assert.match(harness.elements.detailText.textContent, /Install the native host manifest/);

  harness.storageChanges.emit(
    {
      [statusKey]: {
        newValue: {
          state: "error",
          message: "Access to the specified native messaging host is forbidden.",
        },
      },
    },
    "local",
  );
  assert.match(harness.elements.detailText.textContent, /extension id allowed by the native host manifest/);

  harness.storageChanges.emit(
    {
      [statusKey]: {
        newValue: {
          state: "error",
          message: "native host exited with code 1",
        },
      },
    },
    "local",
  );
  assert.match(harness.elements.detailText.textContent, /inspect native host logs/);

  harness.storageChanges.emit(
    {
      [statusKey]: {
        newValue: {
          state: "error",
          message: "Native host launch failed",
          diagnosis: "native_host_forbidden",
        },
      },
    },
    "local",
  );
  assert.match(harness.elements.detailText.textContent, /extension id allowed by the native host manifest/);

  harness.storageChanges.emit(
    {
      [statusKey]: {
        newValue: {
          state: "error",
          message: "native host hello timed out",
          diagnosis: "native_host_hello_timeout",
        },
      },
    },
    "local",
  );
  assert.match(harness.elements.detailText.textContent, /doctor browser --repair/);
  assert.match(harness.elements.detailText.textContent, /native-host handshake/);

  harness.storageChanges.emit(
    {
      [statusKey]: {
        newValue: {
          state: "disconnected",
          message: "native host disconnected",
          diagnosis: "native_host_disconnected",
        },
      },
    },
    "local",
  );
  assert.match(harness.elements.detailText.textContent, /runtime descriptor/);
  assert.match(harness.elements.detailText.textContent, /Resume to reconnect/);

  harness.storageChanges.emit(
    {
      [statusKey]: {
        newValue: {
          state: "error",
          message: "native host heartbeat timed out",
          diagnosis: "native_host_heartbeat_timeout",
        },
      },
    },
    "local",
  );
  assert.match(harness.elements.detailText.textContent, /doctor browser --repair/);
  assert.match(harness.elements.detailText.textContent, /native-host connection/);

  harness.storageChanges.emit(
    {
      [statusKey]: {
        newValue: {
          state: "error",
          message: "Native host unavailable",
          diagnosis: "native_host_unavailable",
        },
      },
    },
    "local",
  );
  assert.match(harness.elements.detailText.textContent, /Resume to retry native-host startup/);

  harness.elements.stopButton.click();
  await waitFor(() => harness.sent.some((message) => message.type === "STOP_BROWSER_CONTROL"));
  await waitFor(() => harness.elements.statusText.textContent === "Stopped");
  assert.equal(harness.elements.resumeButton.disabled, false);

  harness.elements.resumeButton.click();
  await waitFor(() => harness.sent.some((message) => message.type === "RESUME_BROWSER_CONTROL"));
  await waitFor(() => harness.elements.statusText.textContent === "Connected");

  harness.elements.stopButton.click();
  await waitFor(() => harness.elements.detailText.textContent === "refresh boom");
  assert.equal(harness.elements.statusText.textContent, "Error");
  assert.equal(harness.elements.dot.className, "dot error");
}

async function runPopupRepairMatrix() {
  const harness = installPopupHarness([
    { state: "connected", hostVersion: "0.1.0" },
  ]);
  await importPopup("repair-matrix");
  await waitFor(() => harness.elements.statusText.textContent === "Connected");

  const cases = [
    {
      status: {
        state: "error",
        message: "native host missing",
        diagnosis: "native_host_not_found",
      },
      label: "Error",
      patterns: [/Install the native host manifest/, /obu doctor browser/],
      resumeEnabled: true,
    },
    {
      status: {
        state: "error",
        message: "native host forbidden",
        diagnosis: "native_host_forbidden",
      },
      label: "Error",
      patterns: [/extension id allowed by the native host manifest/, /obu doctor browser/],
      resumeEnabled: true,
    },
    {
      status: {
        state: "error",
        message: "native host crashed",
        diagnosis: "native_host_crashed",
      },
      label: "Error",
      patterns: [/obu doctor browser/, /inspect native host logs/],
      resumeEnabled: true,
    },
    {
      status: {
        state: "error",
        message: "native host hello timed out",
        diagnosis: "native_host_hello_timeout",
      },
      label: "Error",
      patterns: [/obu doctor browser --repair/, /Resume to restart the native-host handshake/],
      resumeEnabled: true,
    },
    {
      status: {
        state: "error",
        message: "native host heartbeat timed out",
        diagnosis: "native_host_heartbeat_timeout",
      },
      label: "Error",
      patterns: [/obu doctor browser --repair/, /Resume to restart the native-host connection/],
      resumeEnabled: true,
    },
    {
      status: {
        state: "disconnected",
        message: "native host disconnected",
        diagnosis: "native_host_disconnected",
      },
      label: "Disconnected",
      patterns: [/runtime descriptor/, /Resume to reconnect/],
      resumeEnabled: true,
    },
    {
      status: {
        state: "error",
        message: "native host unavailable",
        diagnosis: "native_host_unavailable",
      },
      label: "Error",
      patterns: [/obu doctor browser --repair/, /Resume to retry native-host startup/],
      resumeEnabled: true,
    },
    {
      status: {
        state: "version_mismatch",
        message: "host too old",
        diagnosis: "version_mismatch",
      },
      label: "Version mismatch",
      patterns: [/Rebuild and reinstall the native host/, /resume browser control/],
      resumeEnabled: true,
    },
    {
      status: {
        state: "version_mismatch",
        message: "host too old",
      },
      label: "Version mismatch",
      patterns: [/Rebuild and reinstall the native host/, /resume browser control/],
      resumeEnabled: true,
    },
  ];

  for (const entry of cases) {
    harness.storageChanges.emit({ [statusKey]: { newValue: entry.status } }, "local");
    assert.equal(harness.elements.statusText.textContent, entry.label);
    assert.equal(harness.elements.resumeButton.disabled, !entry.resumeEnabled);
    for (const pattern of entry.patterns) {
      assert.match(harness.elements.detailText.textContent, pattern);
    }
  }

  harness.storageChanges.emit(
    { [statusKey]: { newValue: { state: "connecting", message: "Opening native host" } } },
    "local",
  );
  assert.equal(harness.elements.resumeButton.disabled, true);
}

async function runPopupResumeFromFailureStates() {
  const disconnected = installPopupHarness([
    { state: "disconnected", message: "retry later", retryDelayMs: 5000 },
    { state: "connecting", message: "Connecting..." },
    { state: "connected", hostVersion: "0.1.0" },
  ]);
  await importPopup("resume-disconnected");
  await waitFor(() => disconnected.elements.statusText.textContent === "Disconnected");
  assert.equal(disconnected.elements.resumeButton.disabled, false);
  disconnected.elements.resumeButton.click();
  await waitFor(() => disconnected.sent.some((message) => message.type === "RESUME_BROWSER_CONTROL"));
  await waitFor(() => disconnected.elements.statusText.textContent === "Connected");

  const failed = installPopupHarness([
    { state: "error", message: "Native host unavailable" },
    { state: "connecting", message: "Connecting..." },
    { state: "connected", hostVersion: "0.1.0" },
  ]);
  await importPopup("resume-error");
  await waitFor(() => failed.elements.statusText.textContent === "Error");
  assert.equal(failed.elements.resumeButton.disabled, false);
  failed.elements.resumeButton.click();
  await waitFor(() => failed.sent.some((message) => message.type === "RESUME_BROWSER_CONTROL"));
  await waitFor(() => failed.elements.statusText.textContent === "Connected");
}

async function runPopupInitialFailure(label, responses, expectedDetail) {
  const harness = installPopupHarness(responses);
  await importPopup(label);
  await waitFor(() => harness.elements.statusText.textContent === "Error");
  assert.equal(harness.elements.detailText.textContent, expectedDetail);
}

async function runPopupDebugLogs() {
  const harness = installPopupHarness([
    { state: "connected", hostVersion: "0.1.0" },
  ]);
  await importPopup("debug-logs");
  await waitFor(() => harness.elements.statusText.textContent === "Connected");
  await waitFor(() => harness.elements.debugText.textContent === "Disabled, 0 saved entries");
  assert.equal(harness.elements.copyDebugButton.disabled, true);
  assert.equal(harness.elements.clearDebugButton.disabled, true);

  harness.elements.debugToggleButton.click();
  await waitFor(() => harness.sent.some((message) => message.type === "SET_DEBUG_LOG_ENABLED" && message.enabled === true));
  await waitFor(() => harness.elements.debugText.textContent === "Enabled, 1/200 entries");
  assert.equal(harness.elements.debugToggleButton.textContent, "Disable");
  assert.equal(harness.elements.copyDebugButton.disabled, false);
  assert.equal(harness.elements.clearDebugButton.disabled, false);

  harness.elements.copyDebugButton.click();
  await waitFor(() => harness.clipboardWrites.length === 1);
  const copied = JSON.parse(harness.clipboardWrites[0]);
  assert.equal(copied.schemaVersion, 1);
  assert.equal(copied.extensionVersion, "0.1.0");
  assert.equal(copied.status.state, "connected");
  assert.equal(copied.debug.entries[0].event, "debug.enabled");
  assert.match(harness.elements.debugText.textContent, /Copied 1 entries/);

  harness.elements.clearDebugButton.click();
  await waitFor(() => harness.elements.debugText.textContent === "Cleared");
  assert.equal(harness.elements.copyDebugButton.disabled, true);
  assert.equal(harness.elements.clearDebugButton.disabled, true);

  harness.storageChanges.emit(
    {
      [debugLogKey]: {
        newValue: {
          enabled: true,
          maxEntries: 200,
          entries: [{ ts: "2026-05-16T00:00:00.000Z", level: "info", event: "external" }],
        },
      },
    },
    "local",
  );
  assert.equal(harness.elements.debugText.textContent, "Enabled, 1/200 entries");
}

function installPopupHarness(responses) {
  const elements = {
    dot: new FakeElement(),
    statusText: new FakeElement(),
    detailText: new FakeElement(),
    versionText: new FakeElement(),
    stopButton: new FakeElement(),
    resumeButton: new FakeElement(),
    debugText: new FakeElement(),
    debugToggleButton: new FakeElement(),
    copyDebugButton: new FakeElement(),
    clearDebugButton: new FakeElement(),
  };
  const selectors = new Map([
    ["#status-dot", elements.dot],
    ["#status-text", elements.statusText],
    ["#detail-text", elements.detailText],
    ["#version-text", elements.versionText],
    ["#stop-button", elements.stopButton],
    ["#resume-button", elements.resumeButton],
    ["#debug-text", elements.debugText],
    ["#debug-toggle-button", elements.debugToggleButton],
    ["#copy-debug-button", elements.copyDebugButton],
    ["#clear-debug-button", elements.clearDebugButton],
  ]);
  const sent = [];
  const clipboardWrites = [];
  const storageChanges = new EventTarget();
  let debugState = { enabled: false, entries: [], maxEntries: 200 };
  globalThis.document = {
    querySelector(selector) {
      return selectors.get(selector) ?? null;
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        async writeText(text) {
          clipboardWrites.push(text);
        },
      },
    },
  });
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: "0.1.0" }),
      async sendMessage(message) {
        sent.push(message);
        if (message?.type === "GET_DEBUG_LOG_STATUS") return debugState;
        if (message?.type === "SET_DEBUG_LOG_ENABLED") {
          debugState = {
            ...debugState,
            enabled: message.enabled === true,
            entries: message.enabled === true
              ? [...debugState.entries, { ts: "2026-05-16T00:00:00.000Z", level: "info", event: "debug.enabled" }]
              : debugState.entries,
          };
          return debugState;
        }
        if (message?.type === "CLEAR_DEBUG_LOGS") {
          debugState = { ...debugState, entries: [] };
          return debugState;
        }
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
    storage: {
      onChanged: storageChanges,
    },
  };
  return { elements, sent, storageChanges, clipboardWrites };
}

async function importPopup(label) {
  await import(`${pathToFileURL(path.join(packageRoot, "dist", "popup.js")).href}?test=${encodeURIComponent(label)}-${Date.now()}`);
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting for popup test predicate");
}

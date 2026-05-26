import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const statusKey = "OBU_NATIVE_HOST_STATUS";
const debugLogKey = "OBU_DEBUG_LOG";
const runtimeExtensionId = "abcdefghijklmnopabcdefghijklmnop";
const englishMessages = JSON.parse(await readFile(path.join(packageRoot, "public", "_locales", "en", "messages.json"), "utf8"));

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
  hidden = false;
  attributes = new Map();
  listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  click() {
    for (const listener of this.listeners.get("click") ?? []) listener();
  }
}

await runPopupHappyPath();
await runPopupRepairMatrix();
await runPopupAgentCopyFailure();
await runPopupStoreHandoff();
await runPopupResumeFromFailureStates();
await runPopupDebugLogs();
await runPopupInitialFailure("missing status response", [undefined], "Repair setup, then reconnect.");
await runPopupInitialFailure("runtime rejection", [new Error("status boom")], "Repair setup, then reconnect.");
await runPairingPageWakesHost();

function assertAgentHandoff(elements, channel = "unpacked-dev") {
  const handoff = elements.agentHandoff.textContent;
  assert.match(handoff, /raw\.githubusercontent\.com\/open-browser-use\/open-browser-use\/main\/prompts\/agent-install-prompt\.md/);
  assert.doesNotMatch(handoff, /blob\/v0\.1\.2\/prompts\/agent-install-prompt\.md/);
  assert.doesNotMatch(handoff, /github\.com\/open-browser-use\/open-browser-use\/blob\/main/);
  assert.match(handoff, /Browser: chrome/);
  assert.match(handoff, new RegExp(`Extension channel: ${channel}`));
  assert.match(handoff, new RegExp(`Extension id: ${runtimeExtensionId}`));
  assert.match(handoff, /source of truth/);
  assert.match(handoff, /always run the official installer first for this handoff/);
  assert.match(handoff, new RegExp(`setup --agents=<agent-id> --browser=chrome --channel=${channel} --extension-id=${runtimeExtensionId} --write-instructions --json`));
  assert.match(handoff, new RegExp(`verify --agent=<agent-id> --browser=chrome --channel=${channel} --extension-id=${runtimeExtensionId} --json`));
  assert.match(handoff, /After any browser popup reports Connected/);
  assert.match(handoff, /rerun the same verify command up to 3 times/);
  assert.match(handoff, /Only retry browser connection or ask the user after those verify attempts still do not return ready/);
  assert.match(handoff, /currently executing this prompt/);
  assert.match(handoff, /Do not run broad setup/);
  assert.match(handoff, /Stop when verify returns result: ready/);
  assert.doesNotMatch(handoff, /generic open-browser-use stdio server/);
  assert.doesNotMatch(handoff, /~\/\.codex\/AGENTS\.md/);
  assert.doesNotMatch(handoff, /~\/\.claude\/CLAUDE\.md/);
  assert.doesNotMatch(handoff, /~\/\.obu\/bin\/obu exists/);
  assert.doesNotMatch(handoff, /if it is missing/);
  assert.doesNotMatch(handoff, /rerun doctor/);
  assert.doesNotMatch(handoff, /Terminal command/i);
  assert.doesNotMatch(handoff, /curl -fsSL/);
  assert.doesNotMatch(handoff, /obu bootstrap/);
  assert.doesNotMatch(handoff, /Bootstrap:/);
  assert.doesNotMatch(handoff, /Verify:/);
}

async function runPopupHappyPath() {
  const harness = installPopupHarness([
    { state: "connected", hostVersion: "0.1.0" },
    { state: "connected", hostVersion: "0.1.0", browserControl: "human_takeover" },
    { state: "connected", hostVersion: "0.1.0", browserControl: "human_takeover" },
    { state: "connected", hostVersion: "0.1.0" },
    { state: "connected", hostVersion: "0.1.0" },
    new Error("stop boom"),
    new Error("refresh boom"),
  ]);

  await importPopup("happy");
  await waitFor(() => harness.elements.statusText.textContent === "Connected");
  assert.equal(harness.elements.dot.className, "dot connected");
  assert.equal(harness.elements.detailText.textContent, "Host 0.1.0");
  assert.equal(harness.elements.setupPanel.hidden, false);
  assert.equal(harness.elements.setupLabel.textContent, "Pair another Agent");
  assert.match(harness.elements.setupText.textContent, /Agent you want to connect/);
  assert.equal(harness.elements.agentHandoff.hidden, true);
  assert.equal(harness.elements.promptToggleButton.getAttribute("aria-expanded"), "false");
  assertAgentHandoff(harness.elements);
  assert.equal(harness.elements.stopButton.disabled, false);
  assert.equal(harness.elements.resumeButton.disabled, true);
  assert.equal(harness.elements.stopButton.textContent, "Take Control");
  assert.equal(harness.elements.stopButton.getAttribute("data-action-emphasis"), "primary");
  assert.equal(harness.elements.stopButton.getAttribute("aria-label"), "Pause agent control so you can use this browser yourself.");
  assert.equal(harness.elements.resumeButton.textContent, "Agent Has Control");
  assert.equal(harness.elements.resumeButton.getAttribute("data-action-emphasis"), "status");
  harness.elements.settingsButton.click();
  await waitFor(() => harness.sent.some((message) => message?.type === "OPEN_OPTIONS_PAGE"));

  harness.storageChanges.emit(
    {
      [statusKey]: {
        newValue: { state: "version_mismatch", message: "Host version is too old" },
      },
    },
    "local",
  );
  assert.equal(harness.elements.statusText.textContent, "Update needed");
  assert.equal(harness.elements.resumeButton.disabled, false);
  assert.equal(harness.elements.stopButton.textContent, "Update Needed");
  assert.equal(harness.elements.resumeButton.textContent, "Reconnect After Update");
  assert.equal(harness.elements.resumeButton.getAttribute("data-action-emphasis"), "primary");
  assert.match(harness.elements.detailText.textContent, /Update the local host/);
  assert.equal(harness.elements.setupPanel.hidden, false);
  assert.match(harness.elements.setupText.textContent, /Agent/);
  assert.equal(harness.elements.agentHandoff.hidden, false);
  assert.equal(harness.elements.promptToggleButton.getAttribute("aria-expanded"), "true");
  assertAgentHandoff(harness.elements);

  harness.storageChanges.emit(
    {
      [statusKey]: {
        newValue: { state: "connected", hostVersion: "0.1.0" },
      },
    },
    "local",
  );
  assert.equal(harness.elements.statusText.textContent, "Connected");
  assert.equal(harness.elements.setupPanel.hidden, false);
  assert.equal(harness.elements.setupLabel.textContent, "Pair another Agent");
  assert.match(harness.elements.setupText.textContent, /Agent you want to connect/);
  assert.equal(harness.elements.agentHandoff.hidden, true);

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
        newValue: {
          state: "connected",
          hostVersion: "0.1.0",
          pendingExtensionUpdate: {
            state: "waiting_for_idle",
            version: "0.2.0",
            pendingSince: Date.now(),
          },
        },
      },
    },
    "local",
  );
  assert.equal(harness.elements.statusText.textContent, "Connected");
  assert.match(harness.elements.detailText.textContent, /Extension update 0\.2\.0 will apply after browser control is idle/);
  assert.equal(harness.elements.setupPanel.hidden, false);

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
  assert.equal(harness.elements.statusText.textContent, "Reconnecting");
  assert.equal(harness.elements.dot.className, "dot reconnecting");
  assert.equal(harness.elements.resumeButton.disabled, false);
  assert.equal(harness.elements.stopButton.textContent, "Agent Offline");
  assert.equal(harness.elements.resumeButton.textContent, "Reconnect Agent");
  assert.match(harness.elements.detailText.textContent, /Retrying in 2s/);

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
  assert.equal(harness.elements.statusText.textContent, "Needs setup");
  assert.equal(harness.elements.resumeButton.disabled, false);
  assert.match(harness.elements.detailText.textContent, /Install the local host/);
  assert.equal(harness.elements.setupPanel.hidden, false);
  assert.match(harness.elements.setupText.textContent, /install open-browser-use/);

  harness.elements.copyAgentButton.click();
  await waitFor(() => harness.clipboardWrites.some((text) => text.includes("prompts/agent-install-prompt.md")));
  await waitFor(() => harness.elements.copyAgentButton.textContent === "Copied");
  assert.match(harness.clipboardWrites.at(-1), /always run the official installer first for this handoff/);
  assert.match(harness.clipboardWrites.at(-1), /setup --agents=<agent-id> --browser=chrome --channel=unpacked-dev/);
  assert.match(harness.clipboardWrites.at(-1), /verify --agent=<agent-id> --browser=chrome --channel=unpacked-dev/);
  assert.match(harness.clipboardWrites.at(-1), /rerun the same verify command up to 3 times/);
  assert.match(harness.clipboardWrites.at(-1), /Stop when verify returns result: ready/);
  assert.doesNotMatch(harness.clipboardWrites.at(-1), /generic open-browser-use stdio server/);
  assert.doesNotMatch(harness.clipboardWrites.at(-1), /obu bootstrap/);
  assert.doesNotMatch(harness.clipboardWrites.at(-1), /curl -fsSL/);
  assert.match(harness.elements.setupCopyText.textContent, /Agent/);

  harness.storageChanges.emit(
    {
      [statusKey]: {
        newValue: { state: "connected", hostVersion: "0.1.0" },
      },
    },
    "local",
  );
  assert.equal(harness.elements.setupPanel.hidden, false);
  assert.equal(harness.elements.setupLabel.textContent, "Pair another Agent");
  assertAgentHandoff(harness.elements);
  assert.equal(harness.elements.setupCopyText.textContent, "");

  const handoffWritesBefore = harness.clipboardWrites.length;
  harness.elements.promptToggleButton.click();
  assert.equal(harness.elements.agentHandoff.hidden, false);
  assert.equal(harness.elements.promptToggleButton.getAttribute("aria-expanded"), "true");
  harness.elements.agentHandoff.click();
  await waitFor(() => harness.clipboardWrites.length === handoffWritesBefore + 1);
  await waitFor(() => harness.elements.copyAgentButton.textContent === "Copied");
  assert.match(harness.clipboardWrites.at(-1), /prompts\/agent-install-prompt\.md/);
  assert.match(harness.elements.setupCopyText.textContent, /Agent you want to connect/);

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
  assert.match(harness.elements.detailText.textContent, /Refresh this extension's host permission/);

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
  assert.match(harness.elements.detailText.textContent, /Repair the local host/);

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
  assert.match(harness.elements.detailText.textContent, /Refresh this extension's host permission/);

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
  assert.match(harness.elements.detailText.textContent, /Repair the local host/);

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
  assert.match(harness.elements.detailText.textContent, /Check local setup/);
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
  assert.match(harness.elements.detailText.textContent, /Repair the local host/);

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
  assert.match(harness.elements.detailText.textContent, /Repair setup/);

  harness.elements.stopButton.click();
  await waitFor(() => harness.sent.some((message) => message.type === "TAKE_BROWSER_CONTROL"));
  await waitFor(() => harness.elements.statusText.textContent === "You are in control");
  assert.equal(harness.elements.resumeButton.disabled, false);
  assert.equal(harness.elements.stopButton.textContent, "You Have Control");
  assert.equal(harness.elements.resumeButton.textContent, "Return to Agent");

  harness.elements.resumeButton.click();
  await waitFor(() => harness.sent.some((message) => message.type === "RESUME_BROWSER_CONTROL"));
  await waitFor(() => harness.elements.statusText.textContent === "Connected");

  harness.elements.stopButton.click();
  await waitFor(() => harness.elements.detailText.textContent === "Repair setup, then reconnect.");
  assert.equal(harness.elements.statusText.textContent, "Needs setup");
  assert.equal(harness.elements.dot.className, "dot attention");
  assert.equal(harness.elements.stopButton.textContent, "Setup Needed");
  assert.equal(harness.elements.resumeButton.textContent, "Retry Connection");
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
      label: "Needs setup",
      patterns: [/Install the local host/],
      setupPatterns: [/install open-browser-use/],
      setupVisible: true,
      resumeEnabled: true,
    },
    {
      status: {
        state: "error",
        message: "native host forbidden",
        diagnosis: "native_host_forbidden",
      },
      label: "Needs setup",
      patterns: [/Refresh this extension's host permission/],
      setupPatterns: [/refresh the native host registration/],
      setupVisible: true,
      resumeEnabled: true,
    },
    {
      status: {
        state: "error",
        message: "native host crashed",
        diagnosis: "native_host_crashed",
      },
      label: "Needs setup",
      patterns: [/Repair the local host/],
      setupPatterns: [/repair open-browser-use setup/],
      setupVisible: true,
      resumeEnabled: true,
    },
    {
      status: {
        state: "error",
        message: "native host hello timed out",
        diagnosis: "native_host_hello_timeout",
      },
      label: "Needs setup",
      patterns: [/Repair the local host/],
      setupPatterns: [/repair open-browser-use setup/],
      setupVisible: true,
      resumeEnabled: true,
    },
    {
      status: {
        state: "error",
        message: "native host heartbeat timed out",
        diagnosis: "native_host_heartbeat_timeout",
      },
      label: "Needs setup",
      patterns: [/Repair the local host/],
      setupPatterns: [/repair open-browser-use setup/],
      setupVisible: true,
      resumeEnabled: true,
    },
    {
      status: {
        state: "disconnected",
        message: "native host disconnected",
        diagnosis: "native_host_disconnected",
      },
      label: "Reconnecting",
      patterns: [/Check local setup/, /Resume to reconnect/],
      setupVisible: false,
      resumeEnabled: true,
    },
    {
      status: {
        state: "error",
        message: "Attempting to use a disconnected port object",
        diagnosis: "native_host_disconnected",
      },
      label: "Needs setup",
      patterns: [/local host is not connected/, /reconnect/],
      setupPatterns: [/reinstall open-browser-use/, /register the host/],
      setupVisible: true,
      resumeEnabled: true,
    },
    {
      status: {
        state: "error",
        message: "Attempting to use a disconnected port object",
      },
      label: "Needs setup",
      patterns: [/local host is not connected/, /reconnect/],
      setupPatterns: [/reinstall open-browser-use/, /register the host/],
      setupVisible: true,
      resumeEnabled: true,
    },
    {
      status: {
        state: "error",
        message: "native host unavailable",
        diagnosis: "native_host_unavailable",
      },
      label: "Needs setup",
      patterns: [/Repair setup/],
      setupPatterns: [/repair open-browser-use setup/],
      setupVisible: true,
      resumeEnabled: true,
    },
    {
      status: {
        state: "version_mismatch",
        message: "host too old",
        diagnosis: "version_mismatch",
      },
      label: "Update needed",
      patterns: [/Update the local host/, /reconnect/],
      setupPatterns: [/Agent/],
      setupVisible: true,
      resumeEnabled: true,
    },
    {
      status: {
        state: "version_mismatch",
        message: "host too old",
      },
      label: "Update needed",
      patterns: [/Update the local host/, /reconnect/],
      setupPatterns: [/Agent/],
      setupVisible: true,
      resumeEnabled: true,
    },
    {
      status: {
        state: "connected",
        hostVersion: "0.1.0",
        browserControl: "human_takeover",
      },
      label: "You are in control",
      patterns: [/Finish sign-in/, /passwords/, /click Resume/],
      setupVisible: false,
      resumeEnabled: true,
    },
    {
      status: {
        state: "connected",
        hostVersion: "0.1.0",
        diagnosis: "native_host_not_found",
      },
      label: "Connected",
      patterns: [/Host 0\.1\.0/],
      setupVisible: false,
      resumeEnabled: false,
    },
    {
      status: {
        state: "connecting",
        message: "Opening native host",
      },
      label: "Connecting",
      patterns: [/Opening native host/],
      setupVisible: false,
      resumeEnabled: false,
    },
    {
      status: {
        state: "stopped",
      },
      label: "You are in control",
      patterns: [/Finish sign-in/, /passwords/, /click Resume/],
      setupVisible: false,
      resumeEnabled: true,
    },
    {
      status: {
        state: "disconnected",
        message: "native host disconnected",
      },
      label: "Reconnecting",
      patterns: [/Trying to reconnect/],
      setupVisible: false,
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
    assert.equal(harness.elements.setupPanel.hidden, false);
    assertAgentHandoff(harness.elements);
    if (entry.setupVisible) {
      assert.equal(harness.elements.setupLabel.textContent, "Setup");
      for (const pattern of entry.setupPatterns ?? []) {
        assert.match(harness.elements.setupText.textContent, pattern);
      }
    } else {
      assert.equal(harness.elements.setupLabel.textContent, "Pair another Agent");
      assert.match(harness.elements.setupText.textContent, /Agent you want to connect/);
      assert.equal(harness.elements.setupCopyText.textContent, "");
    }
  }

  harness.storageChanges.emit(
    { [statusKey]: { newValue: { state: "connecting", message: "Opening native host" } } },
    "local",
  );
  assert.equal(harness.elements.resumeButton.disabled, true);
}

async function runPopupAgentCopyFailure() {
  const harness = installPopupHarness([
    {
      state: "error",
      message: "Specified native messaging host not found.",
      diagnosis: "native_host_not_found",
    },
  ], { clipboardError: new Error("clipboard denied") });
  await importPopup("agent-copy-failure");
  await waitFor(() => harness.elements.statusText.textContent === "Needs setup");
  assert.equal(harness.elements.setupPanel.hidden, false);

  harness.elements.copyAgentButton.click();
  await waitFor(() => harness.elements.copyAgentButton.textContent === "Try again");
  await waitFor(() => /Copy unavailable/.test(harness.elements.setupCopyText.textContent));
  assert.equal(harness.clipboardWrites.length, 0);
  assert.equal(harness.elements.setupPanel.hidden, false);
}

async function runPopupStoreHandoff() {
  runBuild("store");
  try {
    const harness = installPopupHarness([
      {
        state: "error",
        message: "Specified native messaging host not found.",
        diagnosis: "native_host_not_found",
      },
    ]);
    await importPopup("store-handoff");
    await waitFor(() => harness.elements.statusText.textContent === "Needs setup");

    assert.equal(harness.elements.setupPanel.hidden, false);
    assertAgentHandoff(harness.elements, "store");
  } finally {
    runBuild("unpacked-dev");
  }
}

function runBuild(channel) {
  const result = spawnSync(process.execPath, [path.join(packageRoot, "scripts", "build.mjs"), "--channel", channel], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function runPopupResumeFromFailureStates() {
  const disconnected = installPopupHarness([
    { state: "disconnected", message: "retry later", retryDelayMs: 5000 },
    { state: "connecting", message: "Connecting..." },
    { state: "connected", hostVersion: "0.1.0" },
  ]);
  await importPopup("resume-disconnected");
  await waitFor(() => disconnected.elements.statusText.textContent === "Reconnecting");
  assert.equal(disconnected.elements.resumeButton.disabled, false);
  assert.equal(disconnected.elements.stopButton.textContent, "Agent Offline");
  assert.equal(disconnected.elements.resumeButton.textContent, "Reconnect Agent");
  disconnected.elements.resumeButton.click();
  await waitFor(() => disconnected.sent.some((message) => message.type === "RESUME_BROWSER_CONTROL"));
  await waitFor(() => disconnected.elements.statusText.textContent === "Connected");

  const failed = installPopupHarness([
    { state: "error", message: "Native host unavailable" },
    { state: "connecting", message: "Connecting..." },
    { state: "connected", hostVersion: "0.1.0" },
  ]);
  await importPopup("resume-error");
  await waitFor(() => failed.elements.statusText.textContent === "Needs setup");
  assert.equal(failed.elements.resumeButton.disabled, false);
  assert.equal(failed.elements.stopButton.textContent, "Setup Needed");
  assert.equal(failed.elements.resumeButton.textContent, "Retry Connection");
  failed.elements.resumeButton.click();
  await waitFor(() => failed.sent.some((message) => message.type === "RESUME_BROWSER_CONTROL"));
  await waitFor(() => failed.elements.statusText.textContent === "Connected");
}

async function runPopupInitialFailure(label, responses, expectedDetail) {
  const harness = installPopupHarness(responses);
  await importPopup(label);
  await waitFor(() => harness.elements.statusText.textContent === "Needs setup");
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
  await waitFor(() => harness.elements.debugText.textContent === "Enabled, 1/200 entry");
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
  assert.match(harness.elements.debugText.textContent, /Copied 1 entry/);

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
  assert.equal(harness.elements.debugText.textContent, "Enabled, 1/200 entry");
}

// Regression guard for the popup.html -> pairing.html pivot. `obu setup`
// auto-activates the browser runtime by opening pairing.html, which loads the
// SAME compiled dist/popup.js as the toolbar popup. pairing.html has fewer DOM
// elements than popup.html, so popup.js must run against that reduced element
// set WITHOUT throwing all the way to sending GET_NATIVE_HOST_STATUS -- that
// message is what wakes the native host and writes the runtime descriptor that
// activation polls for. An unguarded `element!.foo` deref on a pairing-absent
// element would silently make activation inert while every other test passes.
async function runPairingPageWakesHost() {
  // pairing.html is the source of truth for which ids the reduced page contains.
  const pairingHtml = await readFile(path.join(packageRoot, "public", "pairing.html"), "utf8");
  const pairingIds = new Set(
    Array.from(pairingHtml.matchAll(/id="([^"]+)"/g), (match) => match[1]),
  );
  // popup.ts is the source of truth for which ids popup.js looks up. Parse its
  // querySelector arguments the same way (the generic-typed `<...>` segment is
  // optional so both `querySelector("#x")` and `querySelector<T>("#x")` match).
  // Deriving both sides keeps `absent = queried - present` auto-tracking either
  // file -- if popup.ts adds an unguarded querySelector for a pairing-absent id,
  // it lands in absentSelectors and the import below would throw.
  const popupTs = await readFile(path.join(packageRoot, "src", "popup.ts"), "utf8");
  const queriedIds = new Set(
    Array.from(
      popupTs.matchAll(/querySelector(?:All)?(?:<[^>]*>)?\(\s*"#([^"]+)"\s*\)/g),
      (match) => match[1],
    ),
  );
  const absentSelectors = [...queriedIds]
    .filter((id) => !pairingIds.has(id))
    .map((id) => `#${id}`)
    .sort();
  // Drift pin over the cross-product of two independently-parsed files
  // (popup.ts queries minus pairing.html ids): pairing.html must be missing
  // exactly the toolbar-only controls, else this test proves nothing.
  assert.deepEqual(
    absentSelectors,
    [
      "#clear-debug-button",
      "#copy-debug-button",
      "#debug-text",
      "#debug-toggle-button",
      "#resume-button",
      "#settings-button",
      "#stop-button",
    ],
    "pairing.html element set drifted from popup.ts queries; update the harness/scenario",
  );

  const harness = installPopupHarness(
    [{ state: "connected", hostVersion: "0.1.0" }],
    { absentSelectors },
  );

  // Importing popup.js re-runs its module side effects, including `void start()`.
  // It must not throw on the pairing DOM.
  await importPopup("pairing-wakes-host");

  // The proof the wake path ran to completion: GET_NATIVE_HOST_STATUS was sent.
  await waitFor(() => harness.sent.some((message) => message?.type === "GET_NATIVE_HOST_STATUS"));
  assert.ok(
    harness.sent.some((message) => message?.type === "GET_NATIVE_HOST_STATUS"),
    "pairing page did not send GET_NATIVE_HOST_STATUS",
  );
}

function installPopupHarness(responses, options = {}) {
  const elements = {
    dot: new FakeElement(),
    statusText: new FakeElement(),
    detailText: new FakeElement(),
    versionText: new FakeElement(),
    stopButton: new FakeElement(),
    resumeButton: new FakeElement(),
    settingsButton: new FakeElement(),
    debugText: new FakeElement(),
    debugToggleButton: new FakeElement(),
    copyDebugButton: new FakeElement(),
    clearDebugButton: new FakeElement(),
    setupPanel: new FakeElement(),
    setupLabel: new FakeElement(),
    setupText: new FakeElement(),
    agentHandoff: new FakeElement(),
    promptToggleButton: new FakeElement(),
    copyAgentButton: new FakeElement(),
    setupCopyText: new FakeElement(),
  };
  const selectors = new Map([
    ["#status-dot", elements.dot],
    ["#status-text", elements.statusText],
    ["#detail-text", elements.detailText],
    ["#version-text", elements.versionText],
    ["#stop-button", elements.stopButton],
    ["#resume-button", elements.resumeButton],
    ["#settings-button", elements.settingsButton],
    ["#debug-text", elements.debugText],
    ["#debug-toggle-button", elements.debugToggleButton],
    ["#copy-debug-button", elements.copyDebugButton],
    ["#clear-debug-button", elements.clearDebugButton],
    ["#setup-panel", elements.setupPanel],
    ["#setup-label", elements.setupLabel],
    ["#setup-text", elements.setupText],
    ["#agent-handoff", elements.agentHandoff],
    ["#prompt-toggle-button", elements.promptToggleButton],
    ["#copy-agent-button", elements.copyAgentButton],
    ["#setup-copy-text", elements.setupCopyText],
  ]);
  // Drop selectors that a reduced host page (e.g. pairing.html) lacks so
  // document.querySelector resolves them to null, exercising popup.ts guards.
  for (const selector of options.absentSelectors ?? []) {
    selectors.delete(selector);
  }
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
          if (options.clipboardError) throw options.clipboardError;
          clipboardWrites.push(text);
        },
      },
    },
  });
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: "0.1.0" }),
      id: runtimeExtensionId,
      getURL(path) {
        return `chrome-extension://${runtimeExtensionId}/${path}`;
      },
      async openOptionsPage() {
        sent.push({ type: "OPEN_OPTIONS_PAGE" });
      },
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
    i18n: {
      getMessage(messageName, substitutions) {
        if (messageName === "@@ui_locale") return options.uiLocale ?? "en";
        if (messageName === "@@bidi_dir") return (options.uiLocale ?? "en").startsWith("ar") ? "rtl" : "ltr";
        return getEnglishMessage(messageName, substitutions);
      },
      getUILanguage() {
        return options.uiLocale ?? "en";
      },
    },
    storage: {
      onChanged: storageChanges,
    },
  };
  return { elements, sent, storageChanges, clipboardWrites };
}

function getEnglishMessage(key, substitutions) {
  const entry = englishMessages[key];
  if (!entry?.message) return "";
  const values = Array.isArray(substitutions)
    ? substitutions
    : substitutions === undefined
      ? []
      : [substitutions];
  let message = entry.message;
  for (const [name, placeholder] of Object.entries(entry.placeholders ?? {})) {
    const match = /^\$(\d+)$/.exec(placeholder.content ?? "");
    if (!match) continue;
    const value = values[Number(match[1]) - 1] ?? "";
    message = message.replace(new RegExp(`\\$${escapeRegExp(name)}\\$`, "gi"), value);
  }
  return message;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

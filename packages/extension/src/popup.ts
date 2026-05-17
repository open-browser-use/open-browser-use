const STATUS_KEY = "OBU_NATIVE_HOST_STATUS";
const DEBUG_LOG_KEY = "OBU_DEBUG_LOG";
const GITHUB_INSTALL_URL = "https://github.com/open-browser-use/open-browser-use/releases/latest/download/install.sh";
const EXTENSION_CHANNEL = "__OBU_EXTENSION_CHANNEL__";
const SETUP_COMMAND = setupCommandForChannel(EXTENSION_CHANNEL);

type ExtensionChannel = "unpacked-dev" | "store";

type HostStatus = {
  state: "disconnected" | "connecting" | "connected" | "version_mismatch" | "stopped" | "error";
  message?: string;
  diagnosis?: HostDiagnosis;
  hostVersion?: string;
  deliverableTabs?: number;
  retryDelayMs?: number;
  nextRetryAt?: number;
};

type HostDiagnosis =
  | "native_host_not_found"
  | "native_host_forbidden"
  | "native_host_crashed"
  | "native_host_disconnected"
  | "native_host_hello_timeout"
  | "native_host_heartbeat_timeout"
  | "native_host_unavailable"
  | "version_mismatch";

type NativeHostAdvice = {
  detail?: string;
  setupText?: string;
  setupCommand?: string;
  showSetup: boolean;
};

type DebugLogEntry = {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  data?: unknown;
};

type DebugLogStatus = {
  enabled: boolean;
  entries: DebugLogEntry[];
  maxEntries?: number;
};

const dot = document.querySelector<HTMLSpanElement>("#status-dot");
const statusText = document.querySelector<HTMLParagraphElement>("#status-text");
const detailText = document.querySelector<HTMLParagraphElement>("#detail-text");
const setupPanel = document.querySelector<HTMLElement>("#setup-panel");
const setupText = document.querySelector<HTMLParagraphElement>("#setup-text");
const setupCommand = document.querySelector<HTMLPreElement>("#setup-command");
const copySetupButton = document.querySelector<HTMLButtonElement>("#copy-setup-button");
const setupCopyText = document.querySelector<HTMLParagraphElement>("#setup-copy-text");
const versionText = document.querySelector<HTMLSpanElement>("#version-text");
const stopButton = document.querySelector<HTMLButtonElement>("#stop-button");
const resumeButton = document.querySelector<HTMLButtonElement>("#resume-button");
const debugText = document.querySelector<HTMLParagraphElement>("#debug-text");
const debugToggleButton = document.querySelector<HTMLButtonElement>("#debug-toggle-button");
const copyDebugButton = document.querySelector<HTMLButtonElement>("#copy-debug-button");
const clearDebugButton = document.querySelector<HTMLButtonElement>("#clear-debug-button");

let currentStatus: HostStatus | undefined;
let currentDebug: DebugLogStatus = { enabled: false, entries: [] };

versionText!.textContent = `Version ${chrome.runtime.getManifest().version}`;

void refreshStatus();
void refreshDebugStatus();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const status = changes[STATUS_KEY]?.newValue;
  if (isHostStatus(status)) render(status);
  const debug = changes[DEBUG_LOG_KEY]?.newValue;
  if (isDebugLogStatus(debug)) renderDebug(debug);
});

stopButton!.addEventListener("click", () => {
  void sendControlMessage("STOP_BROWSER_CONTROL", stopButton!);
});

resumeButton!.addEventListener("click", () => {
  void sendControlMessage("RESUME_BROWSER_CONTROL", resumeButton!);
});

copySetupButton!.addEventListener("click", () => {
  void copySetupCommand();
});

debugToggleButton!.addEventListener("click", () => {
  void setDebugEnabled(!currentDebug.enabled);
});

copyDebugButton!.addEventListener("click", () => {
  void copyDebugLogs();
});

clearDebugButton!.addEventListener("click", () => {
  void clearDebugLogs();
});

async function refreshStatus(): Promise<void> {
  try {
    const status = await chrome.runtime.sendMessage({ type: "GET_NATIVE_HOST_STATUS" });
    if (isHostStatus(status)) {
      render(status);
    } else {
      render({ state: "error", message: "Native host status unavailable" });
    }
  } catch (error) {
    render({ state: "error", message: errorMessage(error) });
  }
}

async function refreshDebugStatus(): Promise<void> {
  try {
    const debug = await chrome.runtime.sendMessage({ type: "GET_DEBUG_LOG_STATUS" });
    if (isDebugLogStatus(debug)) renderDebug(debug);
  } catch {
    renderDebug({ enabled: false, entries: [] }, "Unavailable");
  }
}

async function sendControlMessage(type: "STOP_BROWSER_CONTROL" | "RESUME_BROWSER_CONTROL", button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const status = await chrome.runtime.sendMessage({ type });
    if (isHostStatus(status)) {
      render(status);
    } else {
      render({ state: "error", message: "Native host status unavailable" });
    }
  } catch (error) {
    render({ state: "error", message: errorMessage(error) });
  } finally {
    await refreshStatus();
  }
}

async function setDebugEnabled(enabled: boolean): Promise<void> {
  debugToggleButton!.disabled = true;
  try {
    const debug = await chrome.runtime.sendMessage({ type: "SET_DEBUG_LOG_ENABLED", enabled });
    if (isDebugLogStatus(debug)) renderDebug(debug);
  } finally {
    debugToggleButton!.disabled = false;
  }
}

async function copyDebugLogs(): Promise<void> {
  copyDebugButton!.disabled = true;
  try {
    const debug = await chrome.runtime.sendMessage({ type: "GET_DEBUG_LOG_STATUS" });
    if (isDebugLogStatus(debug)) {
      renderDebug(debug);
      await writeClipboard(debugReport(debug));
      renderDebug(debug, `Copied ${debug.entries.length} entries`);
    }
  } catch (error) {
    renderDebug(currentDebug, `Copy failed: ${errorMessage(error)}`);
  } finally {
    copyDebugButton!.disabled = currentDebug.entries.length === 0;
  }
}

async function clearDebugLogs(): Promise<void> {
  clearDebugButton!.disabled = true;
  try {
    const debug = await chrome.runtime.sendMessage({ type: "CLEAR_DEBUG_LOGS" });
    if (isDebugLogStatus(debug)) renderDebug(debug, "Cleared");
  } finally {
    clearDebugButton!.disabled = currentDebug.entries.length === 0;
  }
}

async function copySetupCommand(): Promise<void> {
  copySetupButton!.disabled = true;
  try {
    const command = (setupCommand!.textContent ?? "").trim();
    if (command.length === 0) throw new Error("setup command unavailable");
    await writeClipboard(command);
    setupCopyText!.textContent = "Copied. Paste into Terminal, wait for doctor to finish, then click Resume.";
  } catch (error) {
    setupCopyText!.textContent = `Copy failed: ${errorMessage(error)}`;
  } finally {
    copySetupButton!.disabled = false;
  }
}

function render(status: HostStatus): void {
  currentStatus = status;
  const advice = nativeHostAdvice(status);
  dot!.className = `dot ${statusClass(status.state)}`;
  statusText!.textContent = statusLabel(status);
  detailText!.textContent = statusDetail(status, advice);
  renderSetup(advice);
  stopButton!.disabled = status.state !== "connected";
  resumeButton!.disabled = !canResume(status);
}

function renderSetup(advice: NativeHostAdvice): void {
  const text = advice.showSetup ? advice.setupText ?? "" : "";
  const command = advice.showSetup ? advice.setupCommand ?? "" : "";
  const changed = setupText!.textContent !== text || setupCommand!.textContent !== command;
  setupPanel!.hidden = !advice.showSetup;
  setupText!.textContent = text;
  setupCommand!.textContent = command;
  if (!advice.showSetup || changed) setupCopyText!.textContent = "";
}

function renderDebug(debug: DebugLogStatus, overrideText?: string): void {
  currentDebug = debug;
  debugToggleButton!.textContent = debug.enabled ? "Disable" : "Enable";
  copyDebugButton!.disabled = debug.entries.length === 0;
  clearDebugButton!.disabled = debug.entries.length === 0;
  if (overrideText) {
    debugText!.textContent = overrideText;
    return;
  }
  const max = typeof debug.maxEntries === "number" ? debug.maxEntries : 200;
  debugText!.textContent = debug.enabled
    ? `Enabled, ${debug.entries.length}/${max} entries`
    : `Disabled, ${debug.entries.length} saved entries`;
}

function canResume(status: HostStatus): boolean {
  return ["disconnected", "error", "stopped", "version_mismatch"].includes(status.state);
}

function statusClass(state: HostStatus["state"]): string {
  if (state === "connected") return "connected";
  if (state === "error" || state === "version_mismatch") return "error";
  return "";
}

function statusLabel(status: HostStatus): string {
  switch (status.state) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "version_mismatch":
      return "Version mismatch";
    case "stopped":
      return "You are in control";
    case "error":
      return "Error";
    case "disconnected":
      return "Disconnected";
  }
}

function detailLabel(status: HostStatus): string {
  if (status.state === "connected") {
    return status.hostVersion ? `Host ${status.hostVersion}` : "Host ready";
  }
  if (status.state === "connecting") {
    return "Connecting to the native host.";
  }
  if (status.state === "disconnected") {
    return "Retrying native host connection. Use Resume to retry now after repair.";
  }
  if (status.state === "version_mismatch") {
    return "Update the native host, then click Resume.";
  }
  if (status.state === "stopped") {
    return "Finish sign-in, passwords, or any page step, then click Resume to continue automation.";
  }
  if (status.state === "error") {
    return "Native host unavailable. Run obu doctor browser, then use Resume to retry.";
  }
  return "";
}

function statusDetail(status: HostStatus, advice: NativeHostAdvice): string {
  const retry = retryLabel(status);
  const repair = advice.detail;
  const deliverables = deliverableRecoveryLabel(status);
  const parts = [status.message, retry, repair, deliverables].filter((part): part is string => Boolean(part));
  if (parts.length > 0) return joinSentences(parts);
  return detailLabel(status);
}

function deliverableRecoveryLabel(status: HostStatus): string {
  const count = typeof status.deliverableTabs === "number" ? Math.trunc(status.deliverableTabs) : 0;
  if (count <= 0) return "";
  const noun = count === 1 ? "tab" : "tabs";
  return `${count} deliverable ${noun} available. Recover with browser.deliverables(), then claim().`;
}

function nativeHostAdvice(status: HostStatus): NativeHostAdvice {
  const diagnosis = normalizeDiagnosis(status);
  switch (diagnosis) {
    case "version_mismatch":
      return withSetup(
        "Rebuild and reinstall the native host, then click Resume.",
        "Update the local open-browser-use host from GitHub, refresh setup, then reconnect.",
      );
    case "native_host_not_found":
      return withSetup(
        "Install the native host manifest, then run obu doctor browser.",
        "Install open-browser-use from GitHub, register the native host for local Chromium browsers, then reconnect.",
      );
    case "native_host_forbidden":
      return withSetup(
        "Check the extension id allowed by the native host manifest with obu doctor browser.",
        "Reinstall the native host manifest so it allows this extension id, then reconnect.",
      );
    case "native_host_crashed":
      return withSetup(
        "Run obu doctor browser and inspect native host logs.",
        "Repair the local open-browser-use host, rerun setup, then reconnect.",
      );
    case "native_host_hello_timeout":
      return withSetup(
        "Run obu doctor browser --repair, then use Resume to restart the native-host handshake.",
        "Repair the local open-browser-use host, rerun setup, then reconnect.",
      );
    case "native_host_heartbeat_timeout":
      return withSetup(
        "Run obu doctor browser --repair, then use Resume to restart the native-host connection.",
        "Repair the local open-browser-use host, rerun setup, then reconnect.",
      );
    case "native_host_unavailable":
      if (isDisconnectedPortObject(status.message)) {
        return disconnectedPortObjectAdvice();
      }
      return withSetup(
        "Run obu doctor browser --repair, then use Resume to retry native-host startup.",
        "Repair the local open-browser-use host, rerun setup, then reconnect.",
      );
    case "native_host_disconnected":
      if (isDisconnectedPortObject(status.message)) {
        return disconnectedPortObjectAdvice();
      }
      return {
        detail: "Run obu doctor browser to check the runtime descriptor, then use Resume to reconnect.",
        showSetup: false,
      };
    case undefined:
      return { showSetup: false };
  }
}

function withSetup(detail: string, setupText: string): NativeHostAdvice {
  return {
    detail,
    setupText,
    setupCommand: SETUP_COMMAND,
    showSetup: true,
  };
}

function disconnectedPortObjectAdvice(): NativeHostAdvice {
  return withSetup(
    "The local open-browser-use install may be missing. Reinstall the native host, then click Resume.",
    "Install open-browser-use again, register the native host, then return here and click Resume.",
  );
}

function setupCommandForChannel(channel: string): string {
  const resolvedChannel: ExtensionChannel = channel === "store" ? "store" : "unpacked-dev";
  const channelSuffix = resolvedChannel === "store" ? " --channel=store" : "";
  return [
    `curl -fsSL ${GITHUB_INSTALL_URL} | sh && \\`,
    `~/.obu/bin/obu setup --yes --all --skip-agents${channelSuffix} && \\`,
    `~/.obu/bin/obu doctor browser --repair${channelSuffix}`,
  ].join("\n");
}

function retryLabel(status: HostStatus): string {
  if (status.state === "connected" || status.state === "stopped" || status.state === "version_mismatch") return "";
  const nextRetryAt = typeof status.nextRetryAt === "number" ? status.nextRetryAt : undefined;
  const retryDelayMs = typeof status.retryDelayMs === "number" ? status.retryDelayMs : undefined;
  if (nextRetryAt === undefined && retryDelayMs === undefined) return "";
  const remainingMs = Math.max(0, (nextRetryAt ?? Date.now() + (retryDelayMs ?? 0)) - Date.now());
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  return `Retrying native host connection in ${seconds}s. Run obu doctor browser if setup needs repair.`;
}

function normalizeDiagnosis(status: HostStatus): HostDiagnosis | undefined {
  if (status.state === "version_mismatch") return "version_mismatch";
  if (status.state === "connected" || status.state === "connecting" || status.state === "stopped") return undefined;
  if (status.diagnosis) return status.diagnosis;
  const message = status.message ?? "";
  if (/specified native messaging host.*not found/i.test(message)) {
    return "native_host_not_found";
  }
  if (/access to the specified native messaging host is forbidden/i.test(message)) {
    return "native_host_forbidden";
  }
  if (isDisconnectedPortObject(message)) {
    return "native_host_unavailable";
  }
  if (/native host.*(exited|crash|failed)|host process/i.test(message)) {
    return "native_host_crashed";
  }
  return undefined;
}

function isDisconnectedPortObject(message: string | undefined): boolean {
  return /disconnected port object/i.test(message ?? "");
}

function joinSentences(parts: string[]): string {
  const rows = parts
    .map((part) => part.trim())
    .filter((part, index, rows) => part.length > 0 && rows.indexOf(part) === index);
  if (rows.length === 1) return rows[0]!;
  return rows
    .map((part) => (/[.!?]$/.test(part) ? part : `${part}.`))
    .join(" ");
}

function debugReport(debug: DebugLogStatus): string {
  return JSON.stringify({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    status: currentStatus,
    debug,
  }, null, 2);
}

async function writeClipboard(text: string): Promise<void> {
  const clipboard = (globalThis.navigator as { clipboard?: { writeText(text: string): Promise<void> } } | undefined)?.clipboard;
  if (clipboard?.writeText) {
    await clipboard.writeText(text);
    return;
  }
  throw new Error("clipboard API unavailable");
}

function isHostStatus(value: unknown): value is HostStatus {
  return (
    value !== null &&
    typeof value === "object" &&
    "state" in value &&
    typeof (value as { state?: unknown }).state === "string"
  );
}

function isDebugLogStatus(value: unknown): value is DebugLogStatus {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { enabled?: unknown }).enabled === "boolean" &&
    Array.isArray((value as { entries?: unknown }).entries)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export {};

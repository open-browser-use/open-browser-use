const STATUS_KEY = "OBU_NATIVE_HOST_STATUS";
const DEBUG_LOG_KEY = "OBU_DEBUG_LOG";

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

function render(status: HostStatus): void {
  currentStatus = status;
  dot!.className = `dot ${statusClass(status.state)}`;
  statusText!.textContent = statusLabel(status);
  detailText!.textContent = statusDetail(status);
  stopButton!.disabled = status.state !== "connected";
  resumeButton!.disabled = !canResume(status);
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
      return "Stopped";
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
    return "Update the native host, then resume browser control.";
  }
  if (status.state === "stopped") {
    return "Browser control is paused.";
  }
  if (status.state === "error") {
    return "Native host unavailable. Run obu doctor browser, then use Resume to retry.";
  }
  return "";
}

function statusDetail(status: HostStatus): string {
  const retry = retryLabel(status);
  const repair = repairHint(status);
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

function retryLabel(status: HostStatus): string {
  if (status.state === "connected" || status.state === "stopped" || status.state === "version_mismatch") return "";
  const nextRetryAt = typeof status.nextRetryAt === "number" ? status.nextRetryAt : undefined;
  const retryDelayMs = typeof status.retryDelayMs === "number" ? status.retryDelayMs : undefined;
  if (nextRetryAt === undefined && retryDelayMs === undefined) return "";
  const remainingMs = Math.max(0, (nextRetryAt ?? Date.now() + (retryDelayMs ?? 0)) - Date.now());
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  return `Retrying native host connection in ${seconds}s. Run obu doctor browser if setup needs repair.`;
}

function repairHint(status: HostStatus): string {
  switch (status.diagnosis) {
    case "version_mismatch":
      return "Rebuild and reinstall the native host, then resume browser control.";
    case "native_host_not_found":
      return "Install the native host manifest, then run obu doctor browser.";
    case "native_host_forbidden":
      return "Check the extension id allowed by the native host manifest with obu doctor browser.";
    case "native_host_crashed":
      return "Run obu doctor browser and inspect native host logs.";
    case "native_host_hello_timeout":
      return "Run obu doctor browser --repair, then use Resume to restart the native-host handshake.";
    case "native_host_heartbeat_timeout":
      return "Run obu doctor browser --repair, then use Resume to restart the native-host connection.";
    case "native_host_disconnected":
      return "Run obu doctor browser to check the runtime descriptor, then use Resume to reconnect.";
    case "native_host_unavailable":
      return "Run obu doctor browser --repair, then use Resume to retry native-host startup.";
    case undefined:
      break;
  }
  const message = status.message ?? "";
  if (status.state === "version_mismatch") {
    return "Rebuild and reinstall the native host, then resume browser control.";
  }
  if (/specified native messaging host.*not found/i.test(message)) {
    return "Install the native host manifest, then run obu doctor browser.";
  }
  if (/access to the specified native messaging host is forbidden/i.test(message)) {
    return "Check the extension id allowed by the native host manifest with obu doctor browser.";
  }
  if (/native host.*(exited|crash|failed)|host process/i.test(message)) {
    return "Run obu doctor browser and inspect native host logs.";
  }
  return "";
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

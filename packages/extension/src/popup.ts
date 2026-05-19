const STATUS_KEY = "OBU_NATIVE_HOST_STATUS";
const DEBUG_LOG_KEY = "OBU_DEBUG_LOG";
const EXTENSION_CHANNEL = "__OBU_EXTENSION_CHANNEL__";
const AGENT_COPY_BUTTON_LABEL = "Copy for agent";

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
const shell = document.querySelector<HTMLElement>("#shell");
const statusPanel = document.querySelector<HTMLElement>("#status-panel");
const statusText = document.querySelector<HTMLParagraphElement>("#status-text");
const detailText = document.querySelector<HTMLParagraphElement>("#detail-text");
const setupPanel = document.querySelector<HTMLElement>("#setup-panel");
const setupLabel = document.querySelector<HTMLParagraphElement>("#setup-label");
const setupText = document.querySelector<HTMLParagraphElement>("#setup-text");
const agentHandoff = document.querySelector<HTMLElement>("#agent-handoff");
const copyAgentButton = document.querySelector<HTMLButtonElement>("#copy-agent-button");
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
let setupCopyResetTimer: ReturnType<typeof setTimeout> | undefined;

versionText!.textContent = `Version ${chrome.runtime.getManifest().version}`;
copyAgentButton!.textContent = AGENT_COPY_BUTTON_LABEL;

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

copyAgentButton!.addEventListener("click", () => {
  void copyAgentHandoff();
});

agentHandoff!.addEventListener("click", () => {
  void copyAgentHandoff();
});

agentHandoff!.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  void copyAgentHandoff();
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

async function copyAgentHandoff(): Promise<void> {
  await copySetupText({
    button: copyAgentButton!,
    text: (agentHandoff!.textContent ?? "").trim(),
    unavailable: "agent setup handoff unavailable",
    success: "Copied. Paste into your coding agent, then click Resume when setup finishes.",
  });
}

async function copySetupText(input: {
  button: HTMLButtonElement;
  text: string;
  unavailable: string;
  success: string;
}): Promise<void> {
  input.button.disabled = true;
  clearSetupCopyResetTimer();
  try {
    if (input.text.length === 0) throw new Error(input.unavailable);
    await writeClipboard(input.text);
    input.button.textContent = "Copied";
    setupCopyText!.textContent = input.success;
    setDataAttribute(setupPanel, "data-copy-state", "copied");
  } catch {
    input.button.textContent = "Try again";
    setupCopyText!.textContent = "Copy unavailable. Check clipboard permission, then try again.";
    setDataAttribute(setupPanel, "data-copy-state", "error");
  } finally {
    input.button.disabled = false;
    setupCopyResetTimer = setTimeout(() => {
      copyAgentButton!.textContent = AGENT_COPY_BUTTON_LABEL;
      setupCopyText!.textContent = "";
      removeDataAttribute(setupPanel, "data-copy-state");
      setupCopyResetTimer = undefined;
    }, 2200);
  }
}

function clearSetupCopyResetTimer(): void {
  if (setupCopyResetTimer === undefined) return;
  clearTimeout(setupCopyResetTimer);
  setupCopyResetTimer = undefined;
}

function render(status: HostStatus): void {
  currentStatus = status;
  const advice = nativeHostAdvice(status);
  setDataAttribute(shell, "data-state", status.state);
  setDataAttribute(statusPanel, "data-state", status.state);
  dot!.className = `dot ${statusClass(status.state)}`;
  statusText!.textContent = statusLabel(status);
  detailText!.textContent = statusDetail(status, advice);
  renderSetup(advice);
  stopButton!.disabled = status.state !== "connected";
  resumeButton!.disabled = !canResume(status);
}

function renderSetup(advice: NativeHostAdvice): void {
  const text = advice.showSetup
    ? advice.setupText ?? ""
    : "Connect another coding agent with this handoff. Keep this popup open until pairing finishes.";
  const handoff = agentHandoffForChannel(EXTENSION_CHANNEL, chrome.runtime.id);
  const label = advice.showSetup ? "Setup" : "Agent setup";
  const changed = setupLabel!.textContent !== label
    || setupText!.textContent !== text
    || agentHandoff!.textContent !== handoff;
  setupPanel!.hidden = false;
  setupLabel!.textContent = label;
  setupText!.textContent = text;
  agentHandoff!.textContent = handoff;
  if (changed) {
    clearSetupCopyResetTimer();
    copyAgentButton!.textContent = AGENT_COPY_BUTTON_LABEL;
    setupCopyText!.textContent = "";
    removeDataAttribute(setupPanel, "data-copy-state");
  }
}

function setDataAttribute(element: HTMLElement | null, name: string, value: string): void {
  const target = element as (HTMLElement & { setAttribute?: (name: string, value: string) => void }) | null;
  target?.setAttribute?.(name, value);
}

function removeDataAttribute(element: HTMLElement | null, name: string): void {
  const target = element as (HTMLElement & { removeAttribute?: (name: string) => void }) | null;
  target?.removeAttribute?.(name);
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
  if (state === "connecting" || state === "disconnected") return "reconnecting";
  if (state === "error" || state === "version_mismatch") return "attention";
  return "";
}

function statusLabel(status: HostStatus): string {
  switch (status.state) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "version_mismatch":
      return "Update needed";
    case "stopped":
      return "You are in control";
    case "error":
      return "Needs setup";
    case "disconnected":
      return "Reconnecting";
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
    return "Trying to reconnect. Use Resume after setup is repaired.";
  }
  if (status.state === "version_mismatch") {
    return "Update the local host, then click Resume to reconnect.";
  }
  if (status.state === "stopped") {
    return "Finish sign-in, passwords, or any page step, then click Resume to continue automation.";
  }
  if (status.state === "error") {
    return "Run setup, then click Resume to reconnect.";
  }
  return "";
}

function statusDetail(status: HostStatus, advice: NativeHostAdvice): string {
  const retry = retryLabel(status);
  const repair = advice.detail;
  const deliverables = deliverableRecoveryLabel(status);
  const parts = [visibleStatusMessage(status), retry, repair, deliverables].filter(
    (part): part is string => Boolean(part),
  );
  if (parts.length > 0) return joinSentences(parts);
  return detailLabel(status);
}

function visibleStatusMessage(status: HostStatus): string {
  if (status.state === "connecting" || status.state === "stopped") return status.message ?? "";
  return "";
}

function deliverableRecoveryLabel(status: HostStatus): string {
  const count = typeof status.deliverableTabs === "number" ? Math.trunc(status.deliverableTabs) : 0;
  if (count <= 0) return "";
  const noun = count === 1 ? "tab" : "tabs";
  const object = count === 1 ? "it" : "them";
  return `${count} deliverable ${noun} available. Use browser.deliverables(), then claim() to recover ${object}.`;
}

function nativeHostAdvice(status: HostStatus): NativeHostAdvice {
  const diagnosis = normalizeDiagnosis(status);
  switch (diagnosis) {
    case "version_mismatch":
      return withSetup(
        "Update the local host, then reconnect.",
        "Give this handoff to your coding agent. Return here and click Resume after the update finishes.",
      );
    case "native_host_not_found":
      return withSetup(
        "Install the local host, then reconnect.",
        "Ask your coding agent to install open-browser-use and register the native host for this extension.",
      );
    case "native_host_forbidden":
      return withSetup(
        "Refresh this extension's host permission, then reconnect.",
        "Ask your coding agent to refresh the native host registration for this extension ID.",
      );
    case "native_host_crashed":
      return withSetup(
        "Repair the local host, then reconnect.",
        "Ask your coding agent to repair open-browser-use setup and verify the native host.",
      );
    case "native_host_hello_timeout":
      return withSetup(
        "Repair the local host, then reconnect.",
        "Ask your coding agent to repair open-browser-use setup and verify the native host.",
      );
    case "native_host_heartbeat_timeout":
      return withSetup(
        "Repair the local host, then reconnect.",
        "Ask your coding agent to repair open-browser-use setup and verify the native host.",
      );
    case "native_host_unavailable":
      if (isDisconnectedPortObject(status.message)) {
        return disconnectedPortObjectAdvice();
      }
      return withSetup(
        "Repair setup, then reconnect.",
        "Ask your coding agent to repair open-browser-use setup and verify browser pairing.",
      );
    case "native_host_disconnected":
      if (isDisconnectedPortObject(status.message)) {
        return disconnectedPortObjectAdvice();
      }
      return {
        detail: "Check local setup, then click Resume to reconnect.",
        showSetup: false,
      };
    case undefined:
      if (status.state === "error") {
        return withSetup(
          "Repair setup, then reconnect.",
          "Ask your coding agent to repair open-browser-use setup and verify browser pairing.",
        );
      }
      return { showSetup: false };
  }
}

function withSetup(detail: string, setupText: string): NativeHostAdvice {
  return {
    detail,
    setupText,
    showSetup: true,
  };
}

function disconnectedPortObjectAdvice(): NativeHostAdvice {
  return withSetup(
    "The local host is not connected. Reinstall it, then reconnect.",
    "Ask your coding agent to reinstall open-browser-use and register the host for this extension.",
  );
}

function agentHandoffForChannel(channel: string, runtimeExtensionId: string | undefined): string {
  const resolvedChannel: ExtensionChannel = channel === "store" ? "store" : "unpacked-dev";
  const extensionId = isExtensionId(runtimeExtensionId) ? runtimeExtensionId : "<extension-id>";
  const version = chrome.runtime.getManifest().version;
  const promptUrl = `https://github.com/open-browser-use/open-browser-use/blob/v${version}/prompts/agent-install-prompt.md`;
  return [
    "Install, repair, or adapt open-browser-use for this browser extension.",
    `Prompt: ${promptUrl}`,
    `Extension channel: ${resolvedChannel}`,
    `Extension id: ${extensionId}`,
    "Use the exact extension channel and id when native-host repair or browser pairing is needed.",
    "Let the linked prompt choose the install, repair, MCP config, and agent-instruction steps for this agent and project.",
    "Configure MCP with the generic open-browser-use stdio server first; use OBU's built-in adapter commands as secondary helpers.",
    "Make open-browser-use the primary BrowserUse/browser automation tool for this agent.",
    "Configure the current agent, and any other supported agent the user requests, such as Codex, Cursor, or Claude Code.",
    "Update the project's core AGENTS.md, AGENT.md, CLAUDE.md, or equivalent agent instructions when one exists; otherwise show the instruction snippet.",
    "After setup or repair, verify browser/native-host state and return to this popup to click Resume when needed.",
  ].join("\n");
}

function retryLabel(status: HostStatus): string {
  if (status.state === "connected" || status.state === "stopped" || status.state === "version_mismatch") return "";
  const nextRetryAt = typeof status.nextRetryAt === "number" ? status.nextRetryAt : undefined;
  const retryDelayMs = typeof status.retryDelayMs === "number" ? status.retryDelayMs : undefined;
  if (nextRetryAt === undefined && retryDelayMs === undefined) return "";
  const remainingMs = Math.max(0, (nextRetryAt ?? Date.now() + (retryDelayMs ?? 0)) - Date.now());
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  return `Retrying in ${seconds}s.`;
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

function isExtensionId(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-p]{32}$/.test(value);
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

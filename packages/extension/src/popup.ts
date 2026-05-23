import { LANGUAGE_SETTING_KEY, applyDocumentLocale, applyStaticMessages, initI18n, msg, msgPlural } from "./i18n.js";

const STATUS_KEY = "OBU_NATIVE_HOST_STATUS";
const DEBUG_LOG_KEY = "OBU_DEBUG_LOG";
const EXTENSION_CHANNEL = "__OBU_EXTENSION_CHANNEL__";

type ExtensionChannel = "unpacked-dev" | "store";

type HostStatus = {
  state:
    | "disconnected"
    | "connecting"
    | "hello_pending"
    | "connected"
    | "heartbeat_failed"
    | "reconnect_scheduled"
    | "version_mismatch"
    | "stopping"
    | "stopped"
    | "cleanup_failed"
    | "error";
  message?: string;
  diagnosis?: HostDiagnosis;
  hostVersion?: string;
  deliverableTabs?: number;
  overlayRelease?: Array<{
    tabId: number;
    state: "release_pending" | "release_failed";
    failures?: number;
    sessionId: string;
    turnId: string;
  }>;
  retryDelayMs?: number;
  nextRetryAt?: number;
  pendingExtensionUpdate?: {
    version?: string;
    pendingSince: number;
    state: "waiting_for_idle";
  };
  browserControl?: "human_takeover";
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
const promptToggleButton = document.querySelector<HTMLButtonElement>("#prompt-toggle-button");
const copyAgentButton = document.querySelector<HTMLButtonElement>("#copy-agent-button");
const setupCopyText = document.querySelector<HTMLParagraphElement>("#setup-copy-text");
const versionText = document.querySelector<HTMLSpanElement>("#version-text");
const stopButton = document.querySelector<HTMLButtonElement>("#stop-button");
const resumeButton = document.querySelector<HTMLButtonElement>("#resume-button");
const settingsButton = document.querySelector<HTMLButtonElement>("#settings-button");
const debugText = document.querySelector<HTMLParagraphElement>("#debug-text");
const debugToggleButton = document.querySelector<HTMLButtonElement>("#debug-toggle-button");
const copyDebugButton = document.querySelector<HTMLButtonElement>("#copy-debug-button");
const clearDebugButton = document.querySelector<HTMLButtonElement>("#clear-debug-button");

let currentStatus: HostStatus | undefined;
let currentDebug: DebugLogStatus = { enabled: false, entries: [] };
let setupCopyResetTimer: ReturnType<typeof setTimeout> | undefined;
let setupPromptExpanded = true;

void start();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[LANGUAGE_SETTING_KEY]) {
    void refreshLanguage();
  }
  const status = changes[STATUS_KEY]?.newValue;
  if (isHostStatus(status)) render(status);
  const debug = changes[DEBUG_LOG_KEY]?.newValue;
  if (isDebugLogStatus(debug)) renderDebug(debug);
});

stopButton!.addEventListener("click", () => {
  void sendControlMessage("TAKE_BROWSER_CONTROL", stopButton!);
});

resumeButton!.addEventListener("click", () => {
  void sendControlMessage("RESUME_BROWSER_CONTROL", resumeButton!);
});

settingsButton?.addEventListener("click", () => {
  void openSettings();
});

copyAgentButton!.addEventListener("click", () => {
  void copyAgentHandoff();
});

promptToggleButton?.addEventListener("click", () => {
  setupPromptExpanded = !setupPromptExpanded;
  applyPromptExpansion();
});

agentHandoff!.addEventListener("click", () => {
  if (agentHandoff!.hidden) return;
  void copyAgentHandoff();
});

agentHandoff!.addEventListener("keydown", (event) => {
  if (agentHandoff!.hidden) return;
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

async function start(): Promise<void> {
  await initI18n();
  renderStaticShell();
  void refreshStatus();
  void refreshDebugStatus();
}

async function refreshLanguage(): Promise<void> {
  await initI18n();
  renderStaticShell();
  if (currentStatus) render(currentStatus);
  renderDebug(currentDebug);
}

function renderStaticShell(): void {
  applyDocumentLocale();
  applyStaticMessages();
  versionText!.textContent = msg("versionLabel", [chrome.runtime.getManifest().version]);
  copyAgentButton!.textContent = agentCopyButtonLabel();
}

async function openSettings(): Promise<void> {
  if (chrome.runtime.openOptionsPage) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL("options.html"), active: true });
}

async function refreshStatus(): Promise<void> {
  try {
    const status = await chrome.runtime.sendMessage({ type: "GET_NATIVE_HOST_STATUS" });
    if (isHostStatus(status)) {
      render(status);
    } else {
      render({ state: "error", message: msg("nativeHostStatusUnavailable") });
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
    renderDebug({ enabled: false, entries: [] }, msg("debugUnavailable"));
  }
}

async function sendControlMessage(type: "TAKE_BROWSER_CONTROL" | "RESUME_BROWSER_CONTROL", button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const status = await chrome.runtime.sendMessage({ type });
    if (isHostStatus(status)) {
      render(status);
    } else {
      render({ state: "error", message: msg("nativeHostStatusUnavailable") });
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
      renderDebug(debug, debugCopiedLabel(debug.entries.length));
    }
  } catch (error) {
    renderDebug(currentDebug, msg("debugCopyFailed", [errorMessage(error)]));
  } finally {
    copyDebugButton!.disabled = currentDebug.entries.length === 0;
  }
}

async function clearDebugLogs(): Promise<void> {
  clearDebugButton!.disabled = true;
  try {
    const debug = await chrome.runtime.sendMessage({ type: "CLEAR_DEBUG_LOGS" });
    if (isDebugLogStatus(debug)) renderDebug(debug, msg("debugCleared"));
  } finally {
    clearDebugButton!.disabled = currentDebug.entries.length === 0;
  }
}

async function copyAgentHandoff(): Promise<void> {
  await copySetupText({
    button: copyAgentButton!,
    text: (agentHandoff!.textContent ?? "").trim(),
    unavailable: msg("copyAgentUnavailable"),
    success: msg("copyAgentSuccess"),
  });
}

async function copySetupText(input: {
  button: HTMLButtonElement;
  text: string;
  unavailable: string;
  success: string;
}): Promise<void> {
  if (input.button.disabled) return;
  input.button.disabled = true;
  clearSetupCopyResetTimer();
  input.button.textContent = msg("copying");
  setupCopyText!.textContent = "";
  setDataAttribute(setupPanel, "data-copy-state", "copying");
  try {
    if (input.text.length === 0) throw new Error(input.unavailable);
    await writeClipboard(input.text);
    input.button.textContent = msg("copied");
    setupCopyText!.textContent = input.success;
    setDataAttribute(setupPanel, "data-copy-state", "copied");
  } catch {
    input.button.textContent = msg("tryAgain");
    setupCopyText!.textContent = msg("copyUnavailable");
    setDataAttribute(setupPanel, "data-copy-state", "error");
  } finally {
    input.button.disabled = false;
    setupCopyResetTimer = setTimeout(() => {
      copyAgentButton!.textContent = agentCopyButtonLabel();
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
  const wasConnected = currentStatus?.state === "connected";
  currentStatus = status;
  const advice = nativeHostAdvice(status);
  setDataAttribute(shell, "data-state", status.state);
  setDataAttribute(statusPanel, "data-state", status.state);
  dot!.className = `dot ${statusClass(status.state)}`;
  statusText!.textContent = statusLabel(status);
  detailText!.textContent = statusDetail(status, advice);
  renderSetup(status, advice, wasConnected);
  renderActionButtons(status);
}

type ActionButtonSemantics = {
  label: string;
  description: string;
  disabled: boolean;
  emphasis: "primary" | "secondary" | "status";
};

function renderActionButtons(status: HostStatus): void {
  applyActionButton(stopButton!, stopButtonSemantics(status));
  applyActionButton(resumeButton!, resumeButtonSemantics(status));
}

function applyActionButton(button: HTMLButtonElement, semantics: ActionButtonSemantics): void {
  button.textContent = semantics.label;
  button.disabled = semantics.disabled;
  button.setAttribute("aria-label", semantics.description);
  button.setAttribute("title", semantics.description);
  setDataAttribute(button, "data-action-emphasis", semantics.emphasis);
}

function stopButtonSemantics(status: HostStatus): ActionButtonSemantics {
  if (status.state === "connected" && status.browserControl === "human_takeover") {
    return {
      label: msg("stopButtonUserControl", undefined, "You Have Control"),
      description: msg("stopButtonUserControlDescription", undefined, "You are using the browser directly."),
      disabled: true,
      emphasis: "status",
    };
  }
  switch (status.state) {
    case "connected":
      return {
        label: msg("stopButtonTakeControl", undefined, "Take Control"),
        description: msg("stopButtonTakeControlDescription", undefined, "Pause agent control so you can use this browser yourself."),
        disabled: false,
        emphasis: "primary",
      };
    case "stopping":
      return {
        label: msg("stopButtonTakingControl", undefined, "Taking Control"),
        description: msg("stopButtonTakingControlDescription", undefined, "The agent is releasing browser control."),
        disabled: true,
        emphasis: "status",
      };
    case "stopped":
      return {
        label: msg("stopButtonUserControl", undefined, "You Have Control"),
        description: msg("stopButtonUserControlDescription", undefined, "You are using the browser directly."),
        disabled: true,
        emphasis: "status",
      };
    case "version_mismatch":
      return {
        label: msg("stopButtonUpdateNeeded", undefined, "Update Needed"),
        description: msg("stopButtonUpdateNeededDescription", undefined, "Update the local host before changing browser control."),
        disabled: true,
        emphasis: "status",
      };
    case "error":
    case "cleanup_failed":
      return {
        label: msg("stopButtonSetupNeeded", undefined, "Setup Needed"),
        description: msg("stopButtonSetupNeededDescription", undefined, "Repair setup before taking or returning browser control."),
        disabled: true,
        emphasis: "status",
      };
    case "connecting":
    case "hello_pending":
      return {
        label: msg("stopButtonAgentConnecting", undefined, "Agent Connecting"),
        description: msg("stopButtonAgentConnectingDescription", undefined, "The agent is still connecting to browser control."),
        disabled: true,
        emphasis: "status",
      };
    case "disconnected":
    case "heartbeat_failed":
    case "reconnect_scheduled":
      return {
        label: msg("stopButtonAgentOffline", undefined, "Agent Offline"),
        description: msg("stopButtonAgentOfflineDescription", undefined, "There is no active agent control to take over."),
        disabled: true,
        emphasis: "status",
      };
  }
}

function resumeButtonSemantics(status: HostStatus): ActionButtonSemantics {
  if (status.state === "connected" && status.browserControl === "human_takeover") {
    return {
      label: msg("resumeButtonReturnToAgent", undefined, "Return to Agent"),
      description: msg("resumeButtonReturnToAgentDescription", undefined, "Give browser control back to the agent."),
      disabled: false,
      emphasis: "primary",
    };
  }
  switch (status.state) {
    case "connected":
      return {
        label: msg("resumeButtonAgentControl", undefined, "Agent Has Control"),
        description: msg("resumeButtonAgentControlDescription", undefined, "The agent already controls the browser."),
        disabled: true,
        emphasis: "status",
      };
    case "stopping":
      return {
        label: msg("resumeButtonWait", undefined, "Wait"),
        description: msg("resumeButtonWaitDescription", undefined, "Wait until browser control has fully stopped."),
        disabled: true,
        emphasis: "status",
      };
    case "stopped":
      return {
        label: msg("resumeButtonReturnToAgent", undefined, "Return to Agent"),
        description: msg("resumeButtonReturnToAgentDescription", undefined, "Give browser control back to the agent."),
        disabled: false,
        emphasis: "primary",
      };
    case "version_mismatch":
      return {
        label: msg("resumeButtonReconnectAfterUpdate", undefined, "Reconnect After Update"),
        description: msg("resumeButtonReconnectAfterUpdateDescription", undefined, "Reconnect after the local host has been updated."),
        disabled: false,
        emphasis: "primary",
      };
    case "error":
    case "cleanup_failed":
      return {
        label: msg("resumeButtonRetryConnection", undefined, "Retry Connection"),
        description: msg("resumeButtonRetryConnectionDescription", undefined, "Try to reconnect after setup is repaired."),
        disabled: false,
        emphasis: "primary",
      };
    case "disconnected":
    case "heartbeat_failed":
    case "reconnect_scheduled":
      return {
        label: msg("resumeButtonReconnectAgent", undefined, "Reconnect Agent"),
        description: msg("resumeButtonReconnectAgentDescription", undefined, "Reconnect the agent to browser control."),
        disabled: false,
        emphasis: "primary",
      };
    case "connecting":
    case "hello_pending":
      return {
        label: msg("resumeButtonConnecting", undefined, "Connecting"),
        description: msg("resumeButtonConnectingDescription", undefined, "The agent is connecting now."),
        disabled: true,
        emphasis: "status",
      };
  }
}

function renderSetup(status: HostStatus, advice: NativeHostAdvice, wasConnected: boolean): void {
  const text = advice.showSetup
    ? advice.setupText ?? ""
    : msg("agentSetupDefaultText");
  const handoff = agentHandoffForChannel(EXTENSION_CHANNEL, chrome.runtime.id);
  const label = advice.showSetup
    ? msg("setupLabel")
    : msg("agentSetupLabel");
  const changed = setupLabel!.textContent !== label
    || setupText!.textContent !== text
    || agentHandoff!.textContent !== handoff;
  setupPanel!.hidden = false;
  setupLabel!.textContent = label;
  setupText!.textContent = text;
  agentHandoff!.textContent = handoff;
  if (status.state === "connected" && !wasConnected) {
    setupPromptExpanded = false;
  } else if (status.state !== "connected" && wasConnected) {
    setupPromptExpanded = true;
  } else if (changed && status.state !== "connected") {
    setupPromptExpanded = true;
  }
  applyPromptExpansion();
  if (changed) {
    clearSetupCopyResetTimer();
    copyAgentButton!.textContent = agentCopyButtonLabel();
    setupCopyText!.textContent = "";
    removeDataAttribute(setupPanel, "data-copy-state");
  }
}

function applyPromptExpansion(): void {
  agentHandoff!.hidden = !setupPromptExpanded;
  setDataAttribute(setupPanel, "data-prompt-expanded", setupPromptExpanded ? "true" : "false");
  setDataAttribute(promptToggleButton, "aria-expanded", setupPromptExpanded ? "true" : "false");
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
  debugToggleButton!.textContent = debug.enabled
    ? msg("debugDisable")
    : msg("debugEnable");
  copyDebugButton!.disabled = debug.entries.length === 0;
  clearDebugButton!.disabled = debug.entries.length === 0;
  if (overrideText) {
    debugText!.textContent = overrideText;
    return;
  }
  const max = typeof debug.maxEntries === "number" ? debug.maxEntries : 200;
  debugText!.textContent = debug.enabled
    ? debugEnabledLabel(debug.entries.length, max)
    : debugDisabledLabel(debug.entries.length);
}

function statusClass(state: HostStatus["state"]): string {
  if (state === "connected") return "connected";
  if (state === "connecting" || state === "hello_pending" || state === "disconnected" || state === "reconnect_scheduled") return "reconnecting";
  if (state === "error" || state === "cleanup_failed" || state === "version_mismatch") return "attention";
  return "";
}

function statusLabel(status: HostStatus): string {
  if (status.state === "connected" && status.browserControl === "human_takeover") {
    return msg("statusStopped");
  }
  switch (status.state) {
    case "connected":
      return msg("statusConnected");
    case "connecting":
    case "hello_pending":
      return msg("statusConnecting");
    case "reconnect_scheduled":
      return msg("statusReconnecting");
    case "heartbeat_failed":
      return msg("statusReconnecting");
    case "version_mismatch":
      return msg("statusUpdateNeeded");
    case "stopping":
      return msg("statusStopped");
    case "stopped":
      return msg("statusStopped");
    case "cleanup_failed":
      return msg("statusNeedsSetup");
    case "error":
      return msg("statusNeedsSetup");
    case "disconnected":
      return msg("statusReconnecting");
  }
}

function detailLabel(status: HostStatus): string {
  if (status.state === "connected" && status.browserControl === "human_takeover") {
    return msg("stoppedDetail");
  }
  if (status.state === "connected") {
    return status.hostVersion
      ? msg("hostVersionLabel", [status.hostVersion])
      : msg("hostReady");
  }
  if (status.state === "connecting" || status.state === "hello_pending") {
    return msg("connectingNativeHost");
  }
  if (status.state === "disconnected" || status.state === "heartbeat_failed" || status.state === "reconnect_scheduled") {
    return msg("disconnectedDetail");
  }
  if (status.state === "version_mismatch") {
    return msg("versionMismatchDetail");
  }
  if (status.state === "stopping" || status.state === "stopped") {
    return msg("stoppedDetail");
  }
  if (status.state === "error" || status.state === "cleanup_failed") {
    return msg("errorDetail");
  }
  return "";
}

function statusDetail(status: HostStatus, advice: NativeHostAdvice): string {
  const retry = retryLabel(status);
  const repair = advice.detail;
  const deliverables = deliverableRecoveryLabel(status);
  const pendingUpdate = pendingExtensionUpdateLabel(status);
  const parts = [visibleStatusMessage(status), retry, repair, deliverables, pendingUpdate].filter(
    (part): part is string => Boolean(part),
  );
  if (parts.length > 0) return joinSentences(parts);
  return detailLabel(status);
}

function visibleStatusMessage(status: HostStatus): string {
  if (status.state === "connecting" || status.state === "hello_pending" || status.state === "stopping" || status.state === "stopped" || status.state === "cleanup_failed") {
    return knownStatusMessage(status.message);
  }
  return "";
}

function deliverableRecoveryLabel(status: HostStatus): string {
  const count = typeof status.deliverableTabs === "number" ? Math.trunc(status.deliverableTabs) : 0;
  if (count <= 0) return "";
  return msgPlural(
    "deliverableRecovery",
    count,
    [String(count)],
  );
}

function pendingExtensionUpdateLabel(status: HostStatus): string {
  const update = status.pendingExtensionUpdate;
  if (!update) return "";
  return update.version
    ? msg("pendingExtensionUpdateVersion", [update.version], `Extension update ${update.version} will apply after browser control is idle.`)
    : msg("pendingExtensionUpdate", undefined, "Extension update will apply after browser control is idle.");
}

function nativeHostAdvice(status: HostStatus): NativeHostAdvice {
  const diagnosis = normalizeDiagnosis(status);
  switch (diagnosis) {
    case "version_mismatch":
      return withSetup(
        msg("adviceUpdateHost"),
        msg("setupTextUpdateHost"),
      );
    case "native_host_not_found":
      return withSetup(
        msg("adviceInstallHost"),
        msg("setupTextInstallHost"),
      );
    case "native_host_forbidden":
      return withSetup(
        msg("adviceRefreshHostPermission"),
        msg("setupTextRefreshHostPermission"),
      );
    case "native_host_crashed":
      return withSetup(
        msg("adviceRepairHost"),
        msg("setupTextRepairHost"),
      );
    case "native_host_hello_timeout":
      return withSetup(
        msg("adviceRepairHost"),
        msg("setupTextRepairHost"),
      );
    case "native_host_heartbeat_timeout":
      return withSetup(
        msg("adviceRepairHost"),
        msg("setupTextRepairHost"),
      );
    case "native_host_unavailable":
      if (isDisconnectedPortObject(status.message)) {
        return disconnectedPortObjectAdvice();
      }
      return withSetup(
        msg("adviceRepairSetup"),
        msg("setupTextRepairSetup"),
      );
    case "native_host_disconnected":
      if (isDisconnectedPortObject(status.message)) {
        return disconnectedPortObjectAdvice();
      }
      return {
        detail: msg("adviceCheckSetup"),
        showSetup: false,
      };
    case undefined:
      if (status.state === "error" || status.state === "cleanup_failed") {
        return withSetup(
          msg("adviceRepairSetup"),
          msg("setupTextRepairSetup"),
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
    msg("adviceDisconnectedPortObject"),
    msg("setupTextDisconnectedPortObject"),
  );
}

function agentHandoffForChannel(channel: string, runtimeExtensionId: string | undefined): string {
  const resolvedChannel: ExtensionChannel = channel === "store" ? "store" : "unpacked-dev";
  const extensionId = isExtensionId(runtimeExtensionId) ? runtimeExtensionId : "<extension-id>";
  const promptUrl = "https://raw.githubusercontent.com/open-browser-use/open-browser-use/main/prompts/agent-install-prompt.md";
  return [
    "Install, repair, or adapt open-browser-use for this browser extension.",
    `Prompt: ${promptUrl}`,
    "Browser: chrome",
    `Extension channel: ${resolvedChannel}`,
    `Extension id: ${extensionId}`,
    "Use the linked prompt as the source of truth, and use the exact browser, extension channel, and extension id above for setup, repair, and browser pairing.",
    `Fast path contract: always run the official installer first for this handoff; then run one-agent setup with setup --agents=<agent-id> --browser=chrome --channel=${resolvedChannel} --extension-id=${extensionId} --write-instructions --json; then run verify --agent=<agent-id> --browser=chrome --channel=${resolvedChannel} --extension-id=${extensionId} --json.`,
    "Configure the agent/client currently executing this prompt. Configure other agents only when the user explicitly names them.",
    "Do not run broad setup for unnamed agents or browsers. Stop when verify returns result: ready.",
  ].join("\n");
}

function retryLabel(status: HostStatus): string {
  if (status.state === "connected" || status.state === "stopped" || status.state === "cleanup_failed" || status.state === "version_mismatch") return "";
  const nextRetryAt = typeof status.nextRetryAt === "number" ? status.nextRetryAt : undefined;
  const retryDelayMs = typeof status.retryDelayMs === "number" ? status.retryDelayMs : undefined;
  if (nextRetryAt === undefined && retryDelayMs === undefined) return "";
  const remainingMs = Math.max(0, (nextRetryAt ?? Date.now() + (retryDelayMs ?? 0)) - Date.now());
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  return msg("retryingInSeconds", [String(seconds)]);
}

function normalizeDiagnosis(status: HostStatus): HostDiagnosis | undefined {
  if (status.state === "version_mismatch") return "version_mismatch";
  if (status.state === "connected" || status.state === "connecting" || status.state === "hello_pending" || status.state === "stopping" || status.state === "stopped") return undefined;
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
    .map((part) => (/[.!?。！？؟]$/.test(part) ? part : `${part}.`))
    .reduce((joined, part) => {
      if (joined.length === 0) return part;
      return `${joined}${sentenceSeparator(joined, part)}${part}`;
    }, "");
}

function sentenceSeparator(left: string, right: string): string {
  if (/[。！？]$/.test(left) && /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(right)) return "";
  return " ";
}

function agentCopyButtonLabel(): string {
  return msg("copyForAgent");
}

function knownStatusMessage(message: string | undefined): string {
  if (message === "Stopping...") return msg("statusStopping");
  if (message === "Stopped by user") return msg("statusStoppedByUser");
  if (message === "Version mismatch") return msg("statusVersionMismatch");
  return message ?? "";
}

function debugEnabledLabel(count: number, max: number): string {
  return msgPlural("debugEnabledEntries", count, [String(count), String(max)]);
}

function debugDisabledLabel(count: number): string {
  return msgPlural("debugDisabledEntries", count, [String(count)]);
}

function debugCopiedLabel(count: number): string {
  return msgPlural("debugCopiedEntries", count, [String(count)]);
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

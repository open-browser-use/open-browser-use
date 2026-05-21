import {
  OverlayCoordinator,
  type CdpInputBypass,
  type CursorTarget,
  type CursorVisualEvent,
  type InputBypassEventFamily,
  type PendingExtensionUpdateTrigger,
  type SessionParams,
} from "./overlay_coordinator.js";
import {
  NativeHostBridge,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./native_host_bridge.js";
import {
  createBrowserSession,
  parsePersistedBrowserSessionState,
  serializeBrowserSessions,
  type BrowserSession,
  type SessionTab,
  type TabOrigin,
} from "./session_store.js";
import { requireTabWindowId, TabGroupManager } from "./tab_group_manager.js";

const HOST_NAME = "dev.obu.host";
const STATUS_KEY = "OBU_NATIVE_HOST_STATUS";
const INSTANCE_KEY = "OBU_EXTENSION_INSTANCE_ID";
const SESSION_STATE_KEY = "OBU_BROWSER_SESSION_STATE";
const DEBUG_LOG_KEY = "OBU_DEBUG_LOG";
const PENDING_UPDATE_KEY = "OBU_PENDING_EXTENSION_UPDATE";
const DEBUG_LOG_MAX_ENTRIES = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const HELLO_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_ALARM_NAME = "obu.reconnectNativeHost";
type HostStatus = {
  state: "disconnected" | "connecting" | "connected" | "version_mismatch" | "stopped" | "error";
  message?: string;
  diagnosis?: HostDiagnosis;
  hostVersion?: string;
  deliverableTabs?: number;
  retryDelayMs?: number;
  nextRetryAt?: number;
  pendingExtensionUpdate?: PendingExtensionUpdate;
  updatedAt: number;
};

type PendingExtensionUpdate = {
  version?: string;
  pendingSince: number;
  state: "waiting_for_idle";
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

type DebugLogLevel = "debug" | "info" | "warn" | "error";

type DebugLogEntry = {
  ts: string;
  level: DebugLogLevel;
  event: string;
  data?: unknown;
};

type DebugLogSnapshot = {
  enabled: boolean;
  entries: DebugLogEntry[];
};

let status: HostStatus = { state: "disconnected", updatedAt: Date.now() };
let port: NativePort | null = null;
let stopping = false;
let debugLog: DebugLogSnapshot = { enabled: false, entries: [] };
let debugLogSave: Promise<void> = Promise.resolve();
const sessions = new Map<string, BrowserSession>();
const downloadOwnersByUrl = new Map<string, DownloadOwner[]>();
const downloadOwnersById = new Map<number, DownloadOwner>();
const debuggerAttachLocks = new Map<number, Promise<void>>();
const pendingDialogAwareCloses = new Map<number, PendingDialogAwareClose>();
let helloTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelayMs = RECONNECT_INITIAL_MS;
let pendingExtensionUpdate: PendingExtensionUpdate | undefined;
let pendingExtensionUpdateCheckTimer: ReturnType<typeof setTimeout> | undefined;
let pendingExtensionUpdateCheckTrigger: PendingExtensionUpdateTrigger | undefined;
let applyingPendingExtensionUpdate = false;

const overlayCoordinator = new OverlayCoordinator((trigger) => {
  schedulePendingExtensionUpdateCheck(trigger);
});
const nativeHostBridge = new NativeHostBridge(
  () => port,
  (level, event, data) => appendDebugLog(level, event, data),
);
const tabGroupManager = new TabGroupManager((level, event, data) => appendDebugLog(level, event, data));

void bootstrapBackground();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM_NAME) return;
  if (canReconnect()) {
    reconnectTimer = undefined;
    void connectNative();
  }
});

chrome.runtime.onUpdateAvailable?.addListener((details) => {
  void handleUpdateAvailable(details);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void handleTabRemoved(tabId);
});

chrome.tabs.onActivated?.addListener((activeInfo) => {
  void handleForegroundTabChanged(activeInfo.tabId, "tab_activated");
});

chrome.tabs.onAttached?.addListener((tabId) => {
  void handleForegroundTabChanged(tabId, "tab_attached");
});

chrome.tabs.onDetached?.addListener((tabId) => {
  void handleForegroundTabChanged(tabId, "tab_detached");
});

chrome.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
  void handleTabReplaced(addedTabId, removedTabId);
});

chrome.windows.onFocusChanged?.addListener((windowId) => {
  void handleWindowFocusChanged(windowId);
});

chrome.tabGroups.onCreated?.addListener((group) => {
  if (Number.isInteger(group.id)) void tabGroupManager.reconcileGroupId(group.id);
});

chrome.tabGroups.onUpdated?.addListener((group) => {
  if (Number.isInteger(group.id)) void tabGroupManager.reconcileGroupId(group.id);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    if (isMessage(message, "GET_NATIVE_HOST_STATUS")) {
      sendResponse(await getStatus());
      return;
    }
    if (isMessage(message, "STOP_BROWSER_CONTROL")) {
      await stopBrowserControl();
      sendResponse(await getStatus());
      return;
    }
    if (isMessage(message, "RESUME_BROWSER_CONTROL")) {
      await resumeBrowserControl();
      sendResponse(await getStatus());
      return;
    }
    if (isMessage(message, "CLEAN_UP_BROWSER_TABS")) {
      sendResponse(await cleanUpBrowserTabs());
      return;
    }
    if (isMessage(message, "GET_DEBUG_LOG_STATUS")) {
      sendResponse(debugLogStatus());
      return;
    }
    if (isMessage(message, "SET_DEBUG_LOG_ENABLED")) {
      const enabled = isRecord(message) && message.enabled === true;
      await setDebugLogEnabled(enabled);
      sendResponse(debugLogStatus());
      return;
    }
    if (isMessage(message, "CLEAR_DEBUG_LOGS")) {
      await clearDebugLogs();
      sendResponse(debugLogStatus());
      return;
    }
    if (isMessage(message, "OBU_CURSOR_ARRIVED")) {
      overlayCoordinator.handleCursorArrived(message);
      sendResponse({ ok: true });
      return;
    }
    if (isMessage(message, "OBU_CONTENT_READY")) {
      const tabId = sender.tab?.id;
      if (Number.isInteger(tabId)) await overlayCoordinator.reassert(tabId!);
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ error: "unknown message" });
  })();
  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!Number.isInteger(tabId)) return;
  const owner = findSessionForTab(tabId!);
  if (!owner || !owner.session.attachedTabIds.has(tabId!)) return;
  appendDebugLog("debug", "debugger.event", { method, tabId });
  if (method === "Page.downloadWillBegin" && isRecord(params) && typeof params.url === "string") {
    enqueueDownloadOwner(params.url, {
      sessionId: owner.sessionId,
      tabId,
      suggestedFilename: typeof params.suggestedFilename === "string" ? params.suggestedFilename : undefined,
    });
  }
  const safeDialogAction = safeDialogAutoAction(method, params);
  if (safeDialogAction) {
    sendNotification("onCDPEvent", {
      session_id: owner.sessionId,
      source: { tabId },
      method,
      params,
      handledByExtension: safeDialogAction,
    });
    void chrome.debugger
      .sendCommand({ tabId: tabId! }, "Page.handleJavaScriptDialog", { accept: safeDialogAction.accept })
      .catch((error) => {
        appendDebugLog("warn", "debugger.dialog.handle.failed", { tabId, message: errorMessage(error) });
    });
    return;
  }
  const closeDecisionAction = pendingCloseDecisionAction(tabId!, method, params);
  if (closeDecisionAction) {
    sendNotification("onCDPEvent", {
      session_id: owner.sessionId,
      source: { tabId },
      method,
      params,
      handledByExtension: closeDecisionAction.handledByExtension,
    });
    void chrome.debugger
      .sendCommand({ tabId: tabId! }, "Page.handleJavaScriptDialog", { accept: false })
      .catch((error) => {
        appendDebugLog("warn", "debugger.dialog.dismiss.failed", { tabId, message: errorMessage(error) });
      })
      .finally(() => {
        closeDecisionAction.reject();
      });
    return;
  }
  sendNotification("onCDPEvent", {
    session_id: owner.sessionId,
    source: { tabId },
    method,
    params,
  });
});

function safeDialogAutoAction(method: string, params: unknown): { defaultAction: "accept"; accept: true } | undefined {
  if (method !== "Page.javascriptDialogOpening" || !isRecord(params)) return undefined;
  const dialogType = typeof params.type === "string" ? params.type : "";
  if (dialogType !== "alert" && dialogType !== "beforeunload") return undefined;
  return { defaultAction: "accept", accept: true };
}

function pendingCloseDecisionAction(
  tabId: number,
  method: string,
  params: unknown,
): { handledByExtension: { defaultAction: "dismiss_requires_decision"; accept: false }; reject(): void } | undefined {
  if (method !== "Page.javascriptDialogOpening" || !isRecord(params)) return undefined;
  const pendingClose = pendingDialogAwareCloses.get(tabId);
  if (!pendingClose) return undefined;
  const dialogType = typeof params.type === "string" ? params.type : "";
  if (dialogType !== "confirm" && dialogType !== "prompt") return undefined;
  const messageLength = typeof params.message === "string" ? params.message.length : 0;
  return {
    handledByExtension: { defaultAction: "dismiss_requires_decision", accept: false },
    reject() {
      pendingClose.reject(new Error(
        `dialog_requires_decision: ${dialogType} dialog on tab ${tabId} blocked ${pendingClose.operation} and was dismissed`,
      ));
      appendDebugLog("warn", "debugger.dialog.requires_decision", {
        tabId,
        sessionId: pendingClose.sessionId,
        operation: pendingClose.operation,
        dialogType,
        messageLength,
      });
    },
  };
}

chrome.debugger.onDetach.addListener((source) => {
  const tabId = source.tabId;
  if (!Number.isInteger(tabId)) return;
  const owner = findSessionForTab(tabId!);
  owner?.session.attachedTabIds.delete(tabId!);
  appendDebugLog("warn", "debugger.detach", { tabId });
  if (owner) {
    sendNotification("onCDPEvent", {
      session_id: owner.sessionId,
      source: { tabId },
      method: "Inspector.detached",
      params: { reason: "debugger_detached" },
    });
  }
});

chrome.downloads.onCreated.addListener((item) => {
  const owner = takeDownloadOwner(item);
  if (!owner) return;
  appendDebugLog("debug", "download.created", { id: item.id, tabId: owner.tabId });
  downloadOwnersById.set(item.id, owner);
  sendNotification("onDownloadChange", {
    session_id: owner.sessionId,
    source: owner.tabId === undefined ? undefined : { tabId: owner.tabId },
    id: String(item.id),
    status: "started",
    filename: item.filename,
    url: item.url,
  });
});

chrome.downloads.onChanged.addListener((delta) => {
  void handleDownloadChanged(delta);
});

async function handleDownloadChanged(delta: ChromeDownloadDelta): Promise<void> {
  const owner = downloadOwnersById.get(delta.id);
  if (!owner) return;
  const item = await chrome.downloads.search({ id: delta.id }).then((rows) => rows[0]).catch(() => undefined);
  const status = downloadStatus(item?.state ?? delta.state?.current);
  if (!status) return;
  appendDebugLog(status === "failed" ? "warn" : "debug", "download.changed", { id: delta.id, status, tabId: owner.tabId });
  sendNotification("onDownloadChange", {
    session_id: owner.sessionId,
    source: owner.tabId === undefined ? undefined : { tabId: owner.tabId },
    id: String(delta.id),
    status,
    filename: item?.filename ?? delta.filename?.current,
    url: item?.url ?? delta.url?.current,
    error: item?.error ?? delta.error?.current,
  });
  if (status === "complete" || status === "failed") {
    downloadOwnersById.delete(delta.id);
  }
}

function downloadStatus(state: unknown): "complete" | "failed" | undefined {
  if (state === "complete") return "complete";
  if (state === "interrupted") return "failed";
  return undefined;
}

async function connectNative(): Promise<void> {
  if (status.state === "connecting" || status.state === "connected") return;
  clearReconnect();
  appendDebugLog("info", "native.connect.start", { host: HOST_NAME });
  await setStatus({ state: "connecting", updatedAt: Date.now() });
  let targetPort: NativePort;
  try {
    targetPort = chrome.runtime.connectNative(HOST_NAME);
    port = targetPort;
  } catch (error) {
    const message = errorMessage(error);
    appendDebugLog("error", "native.connect.failed", { message });
    await setStatus({
      state: "error",
      message,
      diagnosis: diagnoseNativeHostFailure(message, "native_host_unavailable"),
      updatedAt: Date.now(),
    });
    scheduleReconnect();
    return;
  }

  targetPort.onMessage.addListener((message) => {
    if (port !== targetPort) return;
    void handleNativeMessage(message, targetPort);
  });
  targetPort.onDisconnect.addListener(() => {
    const message = chrome.runtime.lastError?.message;
    if (port !== targetPort) return;
    const wasConnecting = status.state === "connecting";
    port = null;
    nativeHostBridge.rejectPending(message ?? "native host disconnected");
    clearHelloTimeout();
    clearHeartbeat();
    if (status.state !== "stopped" && status.state !== "version_mismatch") {
      const disconnectedMessage = message ?? (wasConnecting ? "native host exited before hello_ack" : "native host disconnected");
      appendDebugLog(wasConnecting ? "error" : "warn", "native.disconnected", {
        message: disconnectedMessage,
        wasConnecting,
      });
      void setStatus({
        state: wasConnecting ? "error" : "disconnected",
        message: disconnectedMessage,
        diagnosis: diagnoseNativeHostFailure(
          disconnectedMessage,
          wasConnecting ? "native_host_crashed" : "native_host_disconnected",
        ),
        updatedAt: Date.now(),
      });
      void releaseActiveTakeoverForUnavailableHost(wasConnecting ? "native_host_crashed" : "native_host_disconnected");
      scheduleReconnect();
    }
  });

  try {
    targetPort.postMessage({
      type: "hello",
      extension_version: chrome.runtime.getManifest().version,
      manifest_version: 3,
      min_host_version: "0.1.0",
      native_host_name: HOST_NAME,
      browser_kind: await detectBrowserKind(),
      extension_id: chrome.runtime.id ?? "unknown",
      extension_instance_id: await extensionInstanceId(),
    });
    appendDebugLog("debug", "native.hello.sent", { host: HOST_NAME });
    scheduleHelloTimeout(targetPort);
  } catch (error) {
    if (port === targetPort) port = null;
    try {
      targetPort.disconnect();
    } catch {
      // The hello write already failed; reconnect recovery should not depend on
      // whether Chrome accepts cleanup of the half-open native port.
    }
    const message = errorMessage(error);
    appendDebugLog("error", "native.hello.failed", { message });
    await setStatus({
      state: "error",
      message,
      diagnosis: diagnoseNativeHostFailure(message, "native_host_unavailable"),
      updatedAt: Date.now(),
    });
    scheduleReconnect();
  }
}

async function handleNativeMessage(message: unknown, sourcePort: NativePort): Promise<void> {
  if (isRecord(message) && message.type === "hello_ack") {
    clearHelloTimeout();
    stopping = false;
    reconnectDelayMs = RECONNECT_INITIAL_MS;
    appendDebugLog("info", "native.hello.ack", {
      hostVersion: typeof message.host_version === "string" ? message.host_version : undefined,
    });
    await setStatus({
      state: "connected",
      hostVersion: typeof message.host_version === "string" ? message.host_version : undefined,
      updatedAt: Date.now(),
    });
    scheduleHeartbeat();
    publishExtensionStatus();
    schedulePendingExtensionUpdateCheck("native_hello_ack");
    return;
  }
  if (isRecord(message) && message.type === "version_mismatch") {
    clearHelloTimeout();
    clearHeartbeat();
    appendDebugLog("error", "native.version_mismatch", {
      message: typeof message.message === "string" ? message.message : "Version mismatch",
    });
    await releaseActiveTakeoverForUnavailableHost("version_mismatch");
    await setStatus({
      state: "version_mismatch",
      message: typeof message.message === "string" ? message.message : "Version mismatch",
      diagnosis: "version_mismatch",
      updatedAt: Date.now(),
    });
    port?.disconnect();
    return;
  }
  if (isJsonRpcRequest(message)) {
    appendDebugLog("debug", "native.request", { id: message.id, method: message.method });
    await handleHostRequest(message, sourcePort);
    return;
  }
  if (isJsonRpcResponse(message)) {
    nativeHostBridge.resolveResponse(message);
  }
}

async function stopBrowserControl(): Promise<void> {
  appendDebugLog("info", "control.stop");
  stopping = true;
  clearReconnect();
  clearHelloTimeout();
  clearHeartbeat();
  await setStatus({ state: "stopped", message: "Stopping...", updatedAt: Date.now() });
  try {
    if (port) {
      await withTimeout(
        sendRequest("stopBrowserControl", {
          reason: "popup_stop",
          extension_instance_id: await extensionInstanceId(),
        }),
        1500,
      ).catch(() => undefined);
      await stopActiveBrowserControl();
      port.disconnect();
    } else {
      await stopActiveBrowserControl();
    }
  } finally {
    nativeHostBridge.rejectPending("browser control stopped");
    port = null;
    await setStatus({ state: "stopped", message: "Stopped by user", updatedAt: Date.now() });
    schedulePendingExtensionUpdateCheck("control_stopped");
  }
}

async function resumeBrowserControl(): Promise<void> {
  appendDebugLog("info", "control.resume");
  stopping = false;
  clearReconnect();
  await setStatus({ state: "disconnected", updatedAt: Date.now() });
  await connectNative();
}

function sendRequest(method: string, params?: unknown): Promise<unknown> {
  return nativeHostBridge.sendRequest(method, params);
}

function sendNotification(method: string, params?: unknown): void {
  nativeHostBridge.sendNotification(method, params);
}

async function handleHostRequest(request: JsonRpcRequest, sourcePort: NativePort): Promise<void> {
  try {
    const result = await dispatchHostRequest(request.method, request.params);
    if (port === sourcePort) {
      sourcePort.postMessage({ jsonrpc: "2.0", id: request.id, result } satisfies JsonRpcResponse);
    }
    appendDebugLog("debug", "host.request.ok", { id: request.id, method: request.method });
  } catch (error) {
    if (port === sourcePort) {
      sourcePort.postMessage({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: errorMessage(error) },
      } satisfies JsonRpcResponse);
    }
    appendDebugLog("warn", "host.request.error", { id: request.id, method: request.method, message: errorMessage(error) });
  }
}

async function dispatchHostRequest(method: string, params: unknown): Promise<unknown> {
  if (stopping || status.state === "stopped") {
    throw new Error("browser control is stopped");
  }
  switch (method) {
    case "ping":
      return "pong";
    case "createTab":
      return { tab: toTabDto(await createSessionTab(requireSessionParams(params), params)) };
    case "getTabs":
      return await getSessionTabs(requireSessionParams(params));
    case "getCurrentTab":
      return { tab: await getCurrentSessionTab(requireSessionParams(params)) };
    case "getSelectedTab":
      return { tab: await getSelectedTab(requireSessionParams(params)) };
    case "getUserTabs":
      return { tabs: await getUserTabs(requireSessionParams(params)) };
    case "claimUserTab": {
      const tab = await claimUserTab(requireSessionParams(params), params);
      return { tab: toTabDto(tab, requireSessionTab(params)) };
    }
    case "finalizeTabs":
      return await finalizeTabs(requireSessionParams(params), params);
    case "nameSession":
      await nameSession(requireSessionParams(params), params);
      return {};
    case "turnEnded":
      await markTurnEnded(requireSessionParams(params));
      return {};
    case "yieldControl":
      await yieldControl(requireSessionParams(params));
      return {};
    case "resumeControl":
      return { tab: await resumeControl(requireSessionParams(params)) };
    case "getUserHistory":
      return { items: await getUserHistory(params) };
    case "moveMouse":
      return await moveMouse(params);
    case "attach":
      await attachDebugger(params);
      return {};
    case "detach":
      await detachDebugger(params);
      return {};
    case "executeCdp":
      return await executeCdp(params);
    default:
      throw new Error(`method not found: ${method}`);
  }
}

async function createSessionTab(sessionParams: SessionParams, params: unknown): Promise<ChromeTab> {
  const url = isRecord(params) && typeof params.url === "string" ? params.url : "about:blank";
  const session = sessionFor(sessionParams.session_id);
  session.currentTurnId = sessionParams.turn_id;
  ensureSessionAcceptsAction(session, "createTab");
  const tab = await chrome.tabs.create({ url, active: true });
  const tabId = requireCreatedTabId(tab);
  session.activeTabId = tabId;
  delete session.controlState;
  session.tabs.set(tabId, { tabId, origin: "agent", status: "active" });
  await addTabToSessionGroup(sessionParams.session_id, session, tabId, "agent");
  await overlayCoordinator.activate(tabId, sessionParams);
  await persistSessionState();
  appendDebugLog("info", "tab.created", { sessionId: sessionParams.session_id, tabId });
  return tab;
}

async function getSessionTabs(sessionParams: SessionParams): Promise<SessionTabsResult> {
  const session = sessionFor(sessionParams.session_id);
  session.currentTurnId = sessionParams.turn_id;
  const rows: TabDto[] = [];
  const deliverableTabs: TabDto[] = [];
  let changed = false;
  const logicalActiveTabId = await resolveSessionActiveTabId(session);
  session.activeTabId = logicalActiveTabId;
  for (const tabId of session.tabs.keys()) {
    try {
      rows.push(toTabDto(await chrome.tabs.get(tabId), session.tabs.get(tabId), {
        owned: true,
        claimRequired: false,
        commandable: session.tabs.get(tabId)?.status === "active" && session.controlState !== "human_takeover",
        logicalActive: tabId === logicalActiveTabId,
      }));
    } catch {
      session.tabs.delete(tabId);
      await tabGroupManager.removeManagedTab(tabId);
      changed = true;
    }
  }
  for (const [tabId, row] of session.finalizedTabs) {
    try {
      deliverableTabs.push(toTabDto(await chrome.tabs.get(tabId), row));
    } catch {
      session.finalizedTabs.delete(tabId);
      await tabGroupManager.removeManagedTab(tabId);
      changed = true;
    }
  }
  if (changed) {
    syncSessionGroupMirrors(session);
    await persistSessionState();
  }
  return { tabs: rows, deliverableTabs };
}

async function getCurrentSessionTab(sessionParams: SessionParams): Promise<TabDto | null> {
  const session = sessionFor(sessionParams.session_id);
  session.currentTurnId = sessionParams.turn_id;
  const tabId = await resolveSessionActiveTabId(session);
  if (tabId === undefined) return null;
  const row = session.tabs.get(tabId);
  if (!row || row.status !== "active") return null;
  session.activeTabId = tabId;
  await persistSessionState();
  return toTabDto(await chrome.tabs.get(tabId), row, {
    owned: true,
    claimRequired: false,
    commandable: session.controlState !== "human_takeover",
    logicalActive: true,
  });
}

async function getSelectedTab(sessionParams: SessionParams): Promise<TabDto | null> {
  const session = sessionFor(sessionParams.session_id);
  session.currentTurnId = sessionParams.turn_id;
  const tab = await selectedChromeTab();
  if (!tab || !Number.isInteger(tab.id)) return null;
  const tabId = tab.id!;
  const row = session.tabs.get(tabId);
  if (row && row.status === "active") {
    session.activeTabId = tabId;
    await persistSessionState();
    return toTabDto(tab, row, {
      owned: true,
      claimRequired: false,
      commandable: session.controlState !== "human_takeover",
      logicalActive: true,
    });
  }
  if (!isClaimableUserTab(tab) || ownedByAnotherSession(sessionParams.session_id, tabId)) {
    return null;
  }
  return toTabDto(tab, { tabId, origin: "user", status: "active" }, {
    owned: false,
    claimRequired: true,
    commandable: false,
    logicalActive: false,
  });
}

async function selectedChromeTab(): Promise<ChromeTab | undefined> {
  const focused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focused[0]) return focused[0];
  const active = await chrome.tabs.query({ active: true });
  return active[0];
}

async function resolveSessionActiveTabId(session: BrowserSession): Promise<number | undefined> {
  const activeRow = session.activeTabId !== undefined ? session.tabs.get(session.activeTabId) : undefined;
  if (session.activeTabId !== undefined && activeRow?.status === "active") {
    try {
      await chrome.tabs.get(session.activeTabId);
      return session.activeTabId;
    } catch {
      session.tabs.delete(session.activeTabId);
      session.activeTabId = undefined;
    }
  } else if (session.activeTabId !== undefined) {
    session.activeTabId = undefined;
  }

  const candidates: Array<{ tabId: number; active: boolean }> = [];
  for (const [tabId, row] of session.tabs) {
    if (row.status !== "active") continue;
    try {
      const tab = await chrome.tabs.get(tabId);
      candidates.push({ tabId, active: tab.active === true });
    } catch {
      session.tabs.delete(tabId);
    }
  }
  candidates.sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    return left.tabId - right.tabId;
  });
  return candidates[0]?.tabId;
}

async function getUserTabs(sessionParams: SessionParams): Promise<TabDto[]> {
  const session = sessionFor(sessionParams.session_id);
  session.currentTurnId = sessionParams.turn_id;
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => Number.isInteger(tab.id) && isClaimableUserTab(tab))
    .filter((tab) => !ownedByAnotherSession(sessionParams.session_id, tab.id!))
    .map((tab) => toTabDto(tab, { tabId: tab.id!, origin: "user", status: "active" }, {
      owned: false,
      claimRequired: true,
      commandable: false,
      logicalActive: false,
    }));
}

async function claimUserTab(sessionParams: SessionParams, params: unknown): Promise<ChromeTab> {
  const tabId = requireTabId(params);
  const tab = await chrome.tabs.get(tabId);
  if (!isClaimableUserTab(tab)) throw new Error(`tab ${tabId} cannot be claimed by open-browser-use`);
  if (ownedByAnotherSession(sessionParams.session_id, tabId)) {
    throw new Error(`tab ${tabId} is already owned by another open-browser-use session`);
  }
  const session = sessionFor(sessionParams.session_id);
  session.currentTurnId = sessionParams.turn_id;
  removeFinalizedTabFromAllSessions(tabId);
  session.activeTabId = tabId;
  delete session.controlState;
  session.tabs.set(tabId, { tabId, origin: "user", status: "active" });
  await addTabToSessionGroup(sessionParams.session_id, session, tabId, "user");
  for (const managedSession of sessions.values()) syncSessionGroupMirrors(managedSession);
  await overlayCoordinator.activate(tabId, sessionParams, session.tabs.get(tabId)?.lastCursor);
  await persistSessionState();
  appendDebugLog("info", "tab.claimed", { sessionId: sessionParams.session_id, tabId });
  return tab;
}

async function finalizeTabs(sessionParams: SessionParams, params: unknown): Promise<FinalizeTabsResult> {
  const session = sessionFor(sessionParams.session_id);
  session.currentTurnId = sessionParams.turn_id;
  await hideSessionTakeover(session);
  const keep = parseFinalizeKeep(params);
  const closedTabIds: number[] = [];
  const releasedTabIds: number[] = [];
  const keptTabs: TabDto[] = [];
  const deliverableTabs: TabDto[] = [];

  for (const [tabId, row] of [...session.tabs]) {
    const keepStatus = keep.get(tabId);
    if (row.origin === "agent" && !keepStatus) {
      await closeAgentTabWithDialogPolicy(sessionParams.session_id, session, tabId, "finalizeTabs");
      await tabGroupManager.removeManagedTab(tabId);
      session.tabs.delete(tabId);
      session.finalizedTabs.delete(tabId);
      closedTabIds.push(tabId);
      continue;
    }
    if (row.origin === "user" && !keepStatus) {
      await cleanupControlledTab(session, tabId);
      await tabGroupManager.releaseManagedTab(tabId);
      session.tabs.delete(tabId);
      session.finalizedTabs.delete(tabId);
      releasedTabIds.push(tabId);
      continue;
    }
    try {
      if (keepStatus === "deliverable") {
        await cleanupControlledTab(session, tabId);
        const tab = await chrome.tabs.get(tabId);
        const groupId = await moveTabToDeliverableGroup(sessionParams.session_id, session, tabId, row.origin);
        const finalizedRow: SessionTab = { ...row, status: "deliverable" };
        const dto = toTabDto({ ...tab, groupId }, finalizedRow);
        session.tabs.delete(tabId);
        session.finalizedTabs.set(tabId, finalizedRow);
        keptTabs.push(dto);
        deliverableTabs.push(dto);
      } else {
        if (keepStatus === "handoff") {
          await cleanupControlledTab(session, tabId);
          const tab = await chrome.tabs.get(tabId);
          await tabGroupManager.setManagedTabStatus(tabId, "handoff");
          const handoffRow: SessionTab = { ...row, status: "handoff" };
          row.status = "handoff";
          keptTabs.push(toTabDto(tab, handoffRow));
        } else {
          keptTabs.push(toTabDto(await chrome.tabs.get(tabId), row));
        }
      }
    } catch (error) {
      if (!isTabGoneError(error)) {
        throw finalizeTabTransitionError(tabId, keepStatus, error);
      }
      session.tabs.delete(tabId);
      session.attachedTabIds.delete(tabId);
      await tabGroupManager.removeManagedTab(tabId);
      closedTabIds.push(tabId);
    }
  }
  syncSessionGroupMirrors(session);
  session.activeTabId = await resolveSessionActiveTabId(session);
  await persistSessionState();
  appendDebugLog("info", "tabs.finalized", {
    sessionId: sessionParams.session_id,
    closed: closedTabIds.length,
    released: releasedTabIds.length,
    kept: keptTabs.length,
    deliverable: deliverableTabs.length,
  });
  schedulePendingExtensionUpdateCheck("tabs_finalized");

  return { closedTabIds, releasedTabIds, keptTabs, deliverableTabs };
}

async function nameSession(sessionParams: SessionParams, params: unknown): Promise<void> {
  const session = sessionFor(sessionParams.session_id);
  session.currentTurnId = sessionParams.turn_id;
  const label = isRecord(params) && typeof params.label === "string" ? params.label : undefined;
  session.label = label;
  await tabGroupManager.renameSession(sessionParams.session_id, label);
  await persistSessionState();
}

async function markTurnEnded(sessionParams: SessionParams): Promise<void> {
  const session = sessionFor(sessionParams.session_id);
  session.currentTurnId = sessionParams.turn_id;
}

async function yieldControl(sessionParams: SessionParams): Promise<void> {
  const session = sessionFor(sessionParams.session_id);
  session.currentTurnId = sessionParams.turn_id;
  session.controlState = "human_takeover";
  await hideSessionTakeover(session);
  await persistSessionState();
  appendDebugLog("info", "control.yield", { sessionId: sessionParams.session_id });
}

async function resumeControl(sessionParams: SessionParams): Promise<TabDto | null> {
  const session = sessionFor(sessionParams.session_id);
  session.currentTurnId = sessionParams.turn_id;
  const tabId = await resolveSessionActiveTabId(session);
  if (tabId === undefined) return null;
  const row = session.tabs.get(tabId);
  if (!row || row.status !== "active") return null;
  session.activeTabId = tabId;
  delete session.controlState;
  await overlayCoordinator.activate(tabId, sessionParams, row.lastCursor);
  await persistSessionState();
  appendDebugLog("info", "control.resume_session", { sessionId: sessionParams.session_id, tabId });
  return toTabDto(await chrome.tabs.get(tabId), row, {
    owned: true,
    claimRequired: false,
    commandable: true,
    logicalActive: true,
  });
}

async function getUserHistory(params: unknown): Promise<HistoryItemDto[]> {
  const query = isRecord(params) && typeof params.query === "string" ? params.query : "";
  const maxResults = clampNumber(isRecord(params) ? params.limit : undefined, 50, 1, 500);
  const startTime = optionalNumber(isRecord(params) ? params.from : undefined);
  const endTime = optionalNumber(isRecord(params) ? params.to : undefined);
  const rows = await chrome.history.search({ text: query, maxResults, startTime, endTime });
  return rows
    .filter((row) => typeof row.url === "string" && row.url.length > 0)
    .map((row) => ({
      id: row.id,
      url: row.url!,
      title: row.title,
      lastVisitTime: row.lastVisitTime,
      visitCount: row.visitCount,
      typedCount: row.typedCount,
    }));
}

async function executeCdp(params: unknown): Promise<unknown> {
  const tabId = requireTabId(params);
  const session = requireSession(params);
  const row = requireSessionTab(params);
  await ensureDebuggerAttached(session, tabId);
  if (!isRecord(params) || typeof params.method !== "string") {
    throw new Error("executeCdp requires method");
  }
  const method = params.method;
  const timeoutMs = timeoutMsFromParams(params);
  const sessionParams = requireSessionParams(params);
  const suppressAgentOverlayForCapture = params.suppressAgentOverlayForCapture === true && method === "Page.captureScreenshot";
  appendDebugLog("debug", "cdp.execute", { method, tabId, timeoutMs });
  await overlayCoordinator.activate(tabId, sessionParams, row.lastCursor);
  const inputBypass = inputBypassFromCdp(params);
  if (inputBypass) {
    await overlayCoordinator.allowCdpInput(tabId, sessionParams, inputBypass);
  }
  const cursorEvent = cursorEventFromCdp(params);
  if (cursorEvent?.kind === "press") {
    await overlayCoordinator.sendCursorEvent(tabId, sessionParams, cursorEvent);
  }
  const sendCommand = () => withTimeout(
    chrome.debugger.sendCommand({ tabId }, method, params.commandParams),
    timeoutMs,
    `executeCdp ${method} timed out after ${timeoutMs}ms`,
  );
  const result = suppressAgentOverlayForCapture
    ? await overlayCoordinator.withCaptureSuppressed(tabId, sendCommand)
    : await sendCommand();
  if (cursorEvent && cursorEvent.kind !== "press") {
    await overlayCoordinator.sendCursorEvent(tabId, sessionParams, cursorEvent);
    if (cursorEvent.kind === "release" && cursorEvent.clickCount > 0) {
      await overlayCoordinator.sendCursorEvent(tabId, sessionParams, { ...cursorEvent, kind: "click" });
    }
  }
  if (typeof cursorEvent?.x === "number" && typeof cursorEvent.y === "number") {
    row.lastCursor = { x: cursorEvent.x, y: cursorEvent.y };
    await persistSessionState();
  }
  return result;
}

async function moveMouse(params: unknown): Promise<unknown> {
  const tabId = requireTabId(params);
  const sessionParams = requireSessionParams(params);
  const row = requireSessionTab(params);
  const x = requiredNumber(params, "x");
  const y = requiredNumber(params, "y");
  const result = await overlayCoordinator.moveMouse(tabId, sessionParams, x, y);
  if (isRecord(result) && result.visible === true) {
    row.lastCursor = { x, y, sequence: typeof result.sequence === "number" ? result.sequence : undefined };
    await persistSessionState();
  }
  appendDebugLog("debug", "cursor.move", { tabId, result });
  return result;
}

function inputBypassFromCdp(params: Record<string, unknown>): CdpInputBypass | undefined {
  if (params.method === "Input.dispatchMouseEvent") {
    const type = isRecord(params.commandParams) ? params.commandParams.type : undefined;
    const eventFamilies: InputBypassEventFamily[] = type === "mouseWheel" ? ["wheel"] : ["pointer"];
    return { durationMs: 600, reason: "cdp-mouse", eventFamilies };
  }
  if (params.method === "Input.dispatchTouchEvent") {
    return { durationMs: 600, reason: "cdp-touch", eventFamilies: ["touch"] };
  }
  if (params.method === "Input.dispatchKeyEvent") {
    return { durationMs: 600, reason: "cdp-keyboard", eventFamilies: ["keyboard", "text"] };
  }
  if (params.method === "Input.insertText") {
    return { durationMs: 600, reason: "cdp-text", eventFamilies: ["text"] };
  }
  return undefined;
}

function cursorEventFromCdp(params: Record<string, unknown>): CursorVisualEvent | undefined {
  if (params.method !== "Input.dispatchMouseEvent" || !isRecord(params.commandParams)) return undefined;
  const commandParams = params.commandParams;
  const type = commandParams.type;
  if (type !== "mousePressed" && type !== "mouseReleased") return undefined;
  const x = typeof commandParams.x === "number" ? commandParams.x : undefined;
  const y = typeof commandParams.y === "number" ? commandParams.y : undefined;
  return {
    kind: type === "mousePressed" ? "press" : "release",
    x,
    y,
    button: typeof commandParams.button === "string" ? commandParams.button : undefined,
    clickCount: typeof commandParams.clickCount === "number" ? Math.max(0, Math.trunc(commandParams.clickCount)) : 0,
  };
}

async function attachDebugger(params: unknown): Promise<void> {
  const tabId = requireTabId(params);
  const session = requireSession(params);
  requireSessionTab(params);
  await ensureDebuggerAttached(session, tabId);
  appendDebugLog("debug", "debugger.attach.requested", { tabId });
}

async function detachDebugger(params: unknown): Promise<void> {
  const tabId = requireTabId(params);
  const session = requireSession(params);
  requireSessionTab(params);
  if (!session.attachedTabIds.has(tabId)) return;
  await withDebuggerLock(tabId, async () => {
    if (!session.attachedTabIds.has(tabId)) return;
    await chrome.debugger.detach({ tabId });
    session.attachedTabIds.delete(tabId);
  });
  appendDebugLog("debug", "debugger.detach.requested", { tabId });
}

async function ensureDebuggerAttached(session: BrowserSession, tabId: number): Promise<void> {
  if (session.attachedTabIds.has(tabId)) return;
  await withDebuggerLock(tabId, async () => {
    if (session.attachedTabIds.has(tabId)) return;
    await chrome.debugger.attach({ tabId }, "1.3");
    session.attachedTabIds.add(tabId);
  });
}

async function withDebuggerLock(tabId: number, operation: () => Promise<void>): Promise<void> {
  const previous = debuggerAttachLocks.get(tabId) ?? Promise.resolve();
  const current = (async () => {
    await previous.catch(() => undefined);
    await operation();
  })();
  debuggerAttachLocks.set(tabId, current);
  try {
    await current;
  } finally {
    if (debuggerAttachLocks.get(tabId) === current) {
      debuggerAttachLocks.delete(tabId);
    }
  }
}

function requireSessionParams(params: unknown): SessionParams {
  if (!isRecord(params)) throw new Error("request params must be an object");
  const sessionId = params.session_id;
  const turnId = params.turn_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("Missing required browser session_id");
  }
  if (typeof turnId !== "string" || turnId.length === 0) {
    throw new Error("Missing required browser turn_id");
  }
  return { session_id: sessionId, turn_id: turnId };
}

function requireSession(params: unknown): BrowserSession {
  return sessionFor(requireSessionParams(params).session_id);
}

function requireSessionTab(params: unknown): SessionTab {
  const tabId = requireTabId(params);
  const sessionParams = requireSessionParams(params);
  const session = sessionFor(sessionParams.session_id);
  session.currentTurnId = sessionParams.turn_id;
  ensureSessionAcceptsAction(session, "tab command");
  const row = session.tabs.get(tabId);
  if (!row) throw new Error(`tab ${tabId} is not owned by this open-browser-use session`);
  if (row.status !== "active") throw new Error(`tab ${tabId} is ${row.status}, not actively controlled`);
  session.activeTabId = tabId;
  void persistSessionState().catch(() => undefined);
  return row;
}

function ensureSessionAcceptsAction(session: BrowserSession, operation: string): void {
  if (session.controlState === "human_takeover") {
    throw new Error(`${operation} rejected because browser control is yielded to the human; call resumeControl first`);
  }
}

function requireTabId(params: unknown): number {
  if (!isRecord(params)) throw new Error("request params must be an object");
  const direct = params.tabId;
  if (typeof direct === "number" && Number.isInteger(direct)) return direct;
  const target = isRecord(params.target) ? params.target.tabId : undefined;
  if (typeof target === "number" && Number.isInteger(target)) return target;
  throw new Error("tabId must be an integer");
}

function requiredNumber(params: unknown, key: string): number {
  if (!isRecord(params) || typeof params[key] !== "number") throw new Error(`${key} must be a number`);
  return params[key];
}

function requireCreatedTabId(tab: ChromeTab): number {
  if (!Number.isInteger(tab.id)) throw new Error("created tab did not include an id");
  return tab.id!;
}

function sessionFor(sessionId: string): BrowserSession {
  let session = sessions.get(sessionId);
  if (!session) {
    session = createBrowserSession();
    sessions.set(sessionId, session);
  }
  return session;
}

function toTabDto(tab: ChromeTab, row?: SessionTab, state: Partial<TabDto> = {}): TabDto {
  if (!Number.isInteger(tab.id)) throw new Error("tab did not include an id");
  return {
    tabId: tab.id!,
    windowId: tab.windowId,
    groupId: tab.groupId,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    pinned: tab.pinned,
    origin: row?.origin ?? "agent",
    status: row?.status ?? "active",
    owned: row !== undefined,
    claimRequired: row === undefined,
    commandable: row?.status === "active",
    ...state,
  };
}

async function addTabToSessionGroup(
  sessionId: string,
  session: BrowserSession,
  tabId: number,
  origin: TabOrigin,
): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  const windowId = requireTabWindowId(tab);
  session.groupId = await tabGroupManager.ensureSessionGroup(sessionId, windowId, tabId, origin, session.label);
}

async function moveTabToDeliverableGroup(
  sessionId: string,
  session: BrowserSession,
  tabId: number,
  origin: TabOrigin,
): Promise<number> {
  session.deliverableGroupId = await tabGroupManager.moveTabToDeliverableGroup(sessionId, tabId, origin);
  return session.deliverableGroupId;
}

async function cleanupControlledTab(session: BrowserSession, tabId: number): Promise<void> {
  await hideCursor(tabId);
  if (!session.attachedTabIds.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Ignore detach races during finalization.
  }
  session.attachedTabIds.delete(tabId);
}

async function closeAgentTabWithDialogPolicy(
  sessionId: string,
  session: BrowserSession,
  tabId: number,
  operation: string,
): Promise<void> {
  await hideCursor(tabId);
  const wasAttached = session.attachedTabIds.has(tabId);
  let attachedForClose = false;
  let closeCompleted = false;
  if (!wasAttached) {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      session.attachedTabIds.add(tabId);
      attachedForClose = true;
    } catch (error) {
      if (!await tabExists(tabId)) return;
      throw new Error(`dialog-aware close could not attach debugger for tab ${tabId}: ${errorMessage(error)}`);
    }
  }

  let closeCommand: Promise<unknown> | undefined;
  const decisionPromise = new Promise<never>((_, reject) => {
    pendingDialogAwareCloses.set(tabId, { sessionId, operation, reject });
  });
  try {
    await chrome.debugger.sendCommand({ tabId }, "Page.enable", {});
    closeCommand = chrome.debugger.sendCommand({ tabId }, "Page.close", {});
    await Promise.race([
      closeCommand.catch((error) => {
        if (isTabGoneError(error)) return undefined;
        throw error;
      }),
      decisionPromise,
    ]);
    closeCompleted = true;
  } catch (error) {
    if (isTabGoneError(error)) {
      closeCompleted = true;
      return;
    }
    throw error;
  } finally {
    pendingDialogAwareCloses.delete(tabId);
    if (closeCommand) void closeCommand.catch(() => {});
    if (closeCompleted) {
      session.attachedTabIds.delete(tabId);
    } else if (attachedForClose) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // Ignore detach races after a failed close attempt.
      }
      session.attachedTabIds.delete(tabId);
    }
  }
}

async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

function isTabGoneError(error: unknown): boolean {
  return /No tab|Cannot find|closed|does not exist|unknown tab/i.test(errorMessage(error));
}

function finalizeTabTransitionError(
  tabId: number,
  keepStatus: SessionTab["status"] | undefined,
  error: unknown,
): Error {
  const statusLabel = keepStatus ?? "active";
  return new Error(
    `finalizeTabs failed_to_finalize tab ${tabId} as ${statusLabel}; ownership is unchanged: ${errorMessage(error)}`,
  );
}

async function hideSessionTakeover(session: BrowserSession): Promise<void> {
  const tabIds = new Set<number>();
  for (const tabId of session.tabs.keys()) tabIds.add(tabId);
  for (const tabId of session.attachedTabIds) tabIds.add(tabId);
  for (const tabId of tabIds) await hideCursor(tabId);
}

function isClaimableUserTab(tab: ChromeTab): boolean {
  return Number.isInteger(tab.id) && !isRestrictedUrl(tab.url);
}

function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /^(chrome|edge|brave|arc|chromium|about|devtools|chrome-extension):/i.test(url);
}

function ownedByAnotherSession(sessionId: string, tabId: number): boolean {
  for (const [id, session] of sessions) {
    if (id !== sessionId && session.tabs.has(tabId)) return true;
  }
  return false;
}

function removeFinalizedTabFromAllSessions(tabId: number): void {
  for (const session of sessions.values()) {
    session.finalizedTabs.delete(tabId);
  }
}

function findSessionForTab(tabId: number): { sessionId: string; session: BrowserSession } | undefined {
  for (const [sessionId, session] of sessions) {
    if (session.tabs.has(tabId)) return { sessionId, session };
  }
  return undefined;
}

function enqueueDownloadOwner(url: string, owner: DownloadOwner): void {
  const queue = downloadOwnersByUrl.get(url) ?? [];
  queue.push(owner);
  downloadOwnersByUrl.set(url, queue);
}

function takeDownloadOwner(item: ChromeDownloadItem): DownloadOwner | undefined {
  const url = item.url;
  if (typeof url !== "string") return undefined;
  const queue = downloadOwnersByUrl.get(url);
  if (!queue || queue.length === 0) return undefined;
  const matchingFilenameIndex = matchingDownloadOwnerIndex(queue, item);
  const [owner] = queue.splice(matchingFilenameIndex >= 0 ? matchingFilenameIndex : 0, 1);
  if (queue.length === 0) {
    downloadOwnersByUrl.delete(url);
  } else {
    downloadOwnersByUrl.set(url, queue);
  }
  return owner;
}

function matchingDownloadOwnerIndex(queue: DownloadOwner[], item: ChromeDownloadItem): number {
  if (typeof item.filename !== "string") return -1;
  const filename = downloadBasename(item.filename);
  return queue.findIndex((owner) => {
    if (typeof owner.suggestedFilename !== "string") return false;
    return downloadBasename(owner.suggestedFilename) === filename;
  });
}

function downloadBasename(filename: string): string {
  const normalized = filename.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

async function handleTabRemoved(tabId: number): Promise<void> {
  overlayCoordinator.forget(tabId);
  let changed = false;
  for (const session of sessions.values()) {
    if (session.tabs.delete(tabId)) changed = true;
    if (session.finalizedTabs.delete(tabId)) changed = true;
    if (session.attachedTabIds.delete(tabId)) changed = true;
  }
  await tabGroupManager.removeManagedTab(tabId);
  for (const session of sessions.values()) syncSessionGroupMirrors(session);
  for (const [url, owners] of downloadOwnersByUrl) {
    const remaining = owners.filter((owner) => owner.tabId !== tabId);
    if (remaining.length === 0) {
      downloadOwnersByUrl.delete(url);
    } else if (remaining.length !== owners.length) {
      downloadOwnersByUrl.set(url, remaining);
    }
  }
  for (const [id, owner] of downloadOwnersById) {
    if (owner.tabId === tabId) downloadOwnersById.delete(id);
  }
  if (changed) await persistSessionState();
  appendDebugLog("info", "tab.removed", { tabId });
  schedulePendingExtensionUpdateCheck("tab_removed");
}

async function handleTabReplaced(addedTabId: number, removedTabId: number): Promise<void> {
  let changed = false;
  for (const session of sessions.values()) {
    const activeRow = session.tabs.get(removedTabId);
    if (activeRow) {
      session.tabs.delete(removedTabId);
      session.tabs.set(addedTabId, { ...activeRow, tabId: addedTabId });
      if (session.activeTabId === removedTabId) session.activeTabId = addedTabId;
      changed = true;
    }
    const finalizedRow = session.finalizedTabs.get(removedTabId);
    if (finalizedRow) {
      session.finalizedTabs.delete(removedTabId);
      session.finalizedTabs.set(addedTabId, { ...finalizedRow, tabId: addedTabId });
      changed = true;
    }
    if (session.attachedTabIds.delete(removedTabId)) changed = true;
  }
  await overlayCoordinator.replaceTabId(removedTabId, addedTabId);
  await tabGroupManager.replaceManagedTab(removedTabId, addedTabId);
  for (const session of sessions.values()) syncSessionGroupMirrors(session);
  if (changed) await persistSessionState();
  await handleForegroundTabChanged(addedTabId, "tab_replaced");
  appendDebugLog("info", "tab.replaced", { addedTabId, removedTabId });
}

async function handleWindowFocusChanged(windowId: number): Promise<void> {
  if (!Number.isInteger(windowId) || windowId < 0) {
    await overlayCoordinator.syncForeground();
    return;
  }
  let activeTab: ChromeTab | undefined;
  try {
    activeTab = (await chrome.tabs.query({ active: true, windowId }))[0];
  } catch {
    activeTab = undefined;
  }
  await handleForegroundTabChanged(activeTab?.id, "window_focus_changed");
}

async function handleForegroundTabChanged(tabId: number | undefined, reason: string): Promise<void> {
  if (Number.isInteger(tabId)) {
    const owner = findSessionForTab(tabId!);
    const row = owner?.session.tabs.get(tabId!);
    if (owner && row?.status === "active" && owner.session.activeTabId !== tabId) {
      owner.session.activeTabId = tabId;
      await persistSessionState();
      appendDebugLog("debug", "tab.logical_active.foreground", {
        sessionId: owner.sessionId,
        tabId,
        reason,
      });
    }
  }
  await overlayCoordinator.syncForeground();
}

function parseFinalizeKeep(params: unknown): Map<number, SessionTab["status"]> {
  const rows = isRecord(params) && Array.isArray(params.keep) ? params.keep : [];
  const keep = new Map<number, SessionTab["status"]>();
  for (const row of rows) {
    if (!isRecord(row)) throw new Error("finalizeTabs.keep entries must be objects");
    const tabId = requireTabId(row);
    const status = row.status;
    if (status !== "handoff" && status !== "deliverable") {
      throw new Error("finalizeTabs.keep status must be handoff or deliverable");
    }
    if (keep.has(tabId)) throw new Error(`finalizeTabs.keep contains duplicate tab ${tabId}`);
    keep.set(tabId, status);
  }
  return keep;
}

async function stopActiveBrowserControl(): Promise<void> {
  await cleanupAllSessionTabs("stop");
}

async function cleanUpBrowserTabs(): Promise<CleanupBrowserTabsResult> {
  const result = await cleanupAllSessionTabs("stop");
  appendDebugLog("info", "browser_tabs.cleaned", result);
  schedulePendingExtensionUpdateCheck("browser_tabs_cleaned");
  return result;
}

async function hideCursor(tabId: number): Promise<void> {
  await overlayCoordinator.hide(tabId);
}

async function releaseActiveTakeoverForUnavailableHost(reason: string): Promise<void> {
  appendDebugLog("warn", "takeover.release.unavailable_host", { reason });
  await cleanupAllSessionTabs("unavailable");
  await maybeApplyPendingExtensionUpdate("unavailable_host");
}

async function cleanupAllSessionTabs(mode: SessionCleanupMode): Promise<CleanupBrowserTabsResult> {
  const controlledTabIds = new Set<number>();
  for (const tabId of overlayCoordinator.activeTabIds()) controlledTabIds.add(tabId);
  for (const session of sessions.values()) {
    for (const tabId of session.tabs.keys()) controlledTabIds.add(tabId);
    for (const tabId of session.attachedTabIds) controlledTabIds.add(tabId);
  }
  for (const tabId of controlledTabIds) {
    await hideCursor(tabId);
  }
  const result: CleanupBrowserTabsResult = {
    closedTabs: 0,
    releasedTabs: 0,
    keptDeliverables: countDeliverableTabs(),
  };
  let changed = false;
  for (const [sessionId, session] of sessions) {
    const sessionResult = await cleanupSessionTabs(sessionId, session, mode);
    result.closedTabs += sessionResult.closedTabs;
    result.releasedTabs += sessionResult.releasedTabs;
    result.keptDeliverables += sessionResult.keptDeliverables;
    changed = sessionResult.changed || changed;
  }
  pruneEmptySessions();
  if (changed) await persistSessionState();
  return result;
}

async function cleanupSessionTabs(
  sessionId: string,
  session: BrowserSession,
  mode: SessionCleanupMode,
): Promise<CleanupBrowserTabsResult & { changed: boolean }> {
  const result = {
    closedTabs: 0,
    releasedTabs: 0,
    keptDeliverables: 0,
    changed: false,
  };
  for (const [tabId, row] of [...session.tabs]) {
    if (row.status !== "active") continue;
    if (mode === "stop" && row.origin === "agent") {
      await closeAgentTabWithDialogPolicy(sessionId, session, tabId, "cleanupBrowserTabs");
      await tabGroupManager.removeManagedTab(tabId);
      session.tabs.delete(tabId);
      session.finalizedTabs.delete(tabId);
      result.changed = true;
      result.closedTabs += 1;
      continue;
    }
    await cleanupControlledTab(session, tabId);
    await tabGroupManager.releaseManagedTab(tabId);
    session.tabs.delete(tabId);
    session.finalizedTabs.delete(tabId);
    result.releasedTabs += 1;
    result.changed = true;
  }
  for (const tabId of [...session.attachedTabIds]) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Ignore detach races during cleanup.
    }
    session.attachedTabIds.delete(tabId);
    result.changed = true;
  }
  syncSessionGroupMirrors(session);
  return result;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timeoutMsFromParams(params: unknown): number {
  const raw = isRecord(params) ? params.timeoutMs : undefined;
  return clampNumber(raw, DEFAULT_REQUEST_TIMEOUT_MS, 1, 5 * 60_000);
}

async function getStatus(): Promise<HostStatus> {
  if ((status.state === "disconnected" || status.state === "error") && reconnectTimer === undefined) {
    void connectNative();
  }
  return statusWithDeliverables(statusWithPendingUpdate(status));
}

function statusWithDeliverables(current: HostStatus): HostStatus {
  const deliverableTabs = countDeliverableTabs();
  if (deliverableTabs === 0) return current;
  return { ...current, deliverableTabs };
}

function statusWithPendingUpdate(current: HostStatus): HostStatus {
  const next = { ...current };
  if (pendingExtensionUpdate) {
    next.pendingExtensionUpdate = pendingExtensionUpdate;
  } else {
    delete next.pendingExtensionUpdate;
  }
  return next;
}

function countDeliverableTabs(): number {
  let count = 0;
  for (const session of sessions.values()) {
    for (const row of session.finalizedTabs.values()) {
      if (row.status === "deliverable") count += 1;
    }
  }
  return count;
}

function syncSessionGroupMirrors(session: BrowserSession): void {
  session.groupId = undefined;
  session.deliverableGroupId = undefined;
  for (const tabId of session.tabs.keys()) {
    const groupId = tabGroupManager.groupIdForTab(tabId);
    if (groupId !== undefined) {
      session.groupId = groupId;
      break;
    }
  }
  for (const tabId of session.finalizedTabs.keys()) {
    const groupId = tabGroupManager.groupIdForTab(tabId);
    if (groupId !== undefined) {
      session.deliverableGroupId = groupId;
      break;
    }
  }
}

function pruneEmptySessions(): void {
  for (const [sessionId, session] of sessions) {
    if (session.tabs.size === 0 && session.finalizedTabs.size === 0 && session.attachedTabIds.size === 0) {
      sessions.delete(sessionId);
    }
  }
}

async function bootstrapBackground(): Promise<void> {
  await restoreDebugLogs();
  await restorePendingExtensionUpdate();
  appendDebugLog("info", "background.bootstrap");
  await tabGroupManager.load();
  await restoreSessionState();
  await tabGroupManager.bootstrapCleanup();
  await releaseOrphanedTakeoverStateOnBootstrap();
  await bootstrapNativeConnection();
  schedulePendingExtensionUpdateCheck("background_bootstrap");
}

async function bootstrapNativeConnection(): Promise<void> {
  const stored = await chrome.storage.local.get<Record<string, unknown>>(STATUS_KEY);
  const storedStatus = stored[STATUS_KEY];
  if (isHostStatus(storedStatus)) {
    if (storedStatus.state === "stopped" || storedStatus.state === "version_mismatch") {
      stopping = storedStatus.state === "stopped";
      const restoredStatus: HostStatus = {
        state: storedStatus.state,
        message: storedStatus.message
          ?? (storedStatus.state === "stopped" ? "Stopped by user" : "Version mismatch"),
        updatedAt: Date.now(),
      };
      if (storedStatus.state === "version_mismatch") restoredStatus.diagnosis = "version_mismatch";
      await setStatus(restoredStatus);
      return;
    }
    if (await restorePendingReconnect(storedStatus)) return;
  }
  await connectNative();
}

async function restoreDebugLogs(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get<Record<string, unknown>>(DEBUG_LOG_KEY);
    debugLog = parseDebugLogSnapshot(stored[DEBUG_LOG_KEY]) ?? debugLog;
  } catch {
    debugLog = { enabled: false, entries: [] };
  }
}

async function restorePendingExtensionUpdate(): Promise<void> {
  try {
    const stored = await extensionUpdateStorage().get<Record<string, unknown>>(PENDING_UPDATE_KEY);
    pendingExtensionUpdate = parsePendingExtensionUpdate(stored[PENDING_UPDATE_KEY]);
  } catch {
    pendingExtensionUpdate = undefined;
  }
}

async function restoreSessionState(): Promise<void> {
  const stored = await chrome.storage.local.get<Record<string, unknown>>(SESSION_STATE_KEY);
  const state = parsePersistedBrowserSessionState(stored[SESSION_STATE_KEY]);
  if (!state) return;

  let changed = false;
  for (const row of state.sessions) {
    let session: BrowserSession | undefined;
    for (const tabRow of row.tabs) {
      const durableTab = tabRow;
      let tab: ChromeTab;
      try {
        tab = await chrome.tabs.get(durableTab.tabId);
      } catch {
        changed = true;
        continue;
      }
      session ??= sessionFor(row.session_id);
      session.label = typeof row.label === "string" ? row.label : undefined;
      if (row.controlState === "human_takeover") session.controlState = "human_takeover";
      if (Number.isInteger(row.activeTabId)) session.activeTabId = row.activeTabId as number;
      if (durableTab.status === "deliverable") {
        session.finalizedTabs.set(durableTab.tabId, durableTab);
      } else {
        session.tabs.set(durableTab.tabId, durableTab);
      }
      await tabGroupManager.restoreDurableTab(row.session_id, session, tab, durableTab);
    }
    if (session && session.activeTabId !== undefined && !session.tabs.has(session.activeTabId)) {
      session.activeTabId = await resolveSessionActiveTabId(session);
    }
  }
  if (changed) await persistSessionState();
}

async function releaseOrphanedTakeoverStateOnBootstrap(): Promise<void> {
  let tabs: ChromeTab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  for (const tab of tabs) {
    if (!Number.isInteger(tab.id)) continue;
    await overlayCoordinator.hide(tab.id!);
  }
}

async function persistSessionState(): Promise<void> {
  await chrome.storage.local.set({
    [SESSION_STATE_KEY]: serializeBrowserSessions(sessions),
  });
}

function parsePendingExtensionUpdate(value: unknown): PendingExtensionUpdate | undefined {
  if (!isRecord(value)) return undefined;
  if (value.state !== "waiting_for_idle") return undefined;
  const pendingSince = optionalNumber(value.pendingSince);
  if (pendingSince === undefined) return undefined;
  const version = typeof value.version === "string" && value.version.length > 0 ? value.version : undefined;
  return { pendingSince, state: "waiting_for_idle", ...(version ? { version } : {}) };
}

async function restorePendingReconnect(storedStatus: HostStatus): Promise<boolean> {
  if (storedStatus.state !== "disconnected" && storedStatus.state !== "error") return false;
  const nextRetryAt = optionalNumber(storedStatus.nextRetryAt);
  if (nextRetryAt === undefined || nextRetryAt <= Date.now()) return false;
  const retryDelayMs = optionalNumber(storedStatus.retryDelayMs) ?? RECONNECT_INITIAL_MS;
  reconnectDelayMs = Math.min(RECONNECT_MAX_MS, Math.max(RECONNECT_INITIAL_MS, retryDelayMs * 2));
  await setStatus({
    ...storedStatus,
    retryDelayMs,
    nextRetryAt,
    updatedAt: Date.now(),
  });
  scheduleReconnectAt(nextRetryAt);
  return true;
}

async function setStatus(next: HostStatus): Promise<void> {
  status = statusWithPendingUpdate(next);
  appendDebugLog(statusLogLevel(next), "status.changed", {
    state: status.state,
    diagnosis: status.diagnosis,
    message: status.message,
    retryDelayMs: status.retryDelayMs,
    pendingExtensionUpdate: status.pendingExtensionUpdate?.version ?? status.pendingExtensionUpdate?.state,
  });
  await chrome.storage.local.set({ [STATUS_KEY]: status });
  if (pendingExtensionUpdate && !applyingPendingExtensionUpdate) {
    schedulePendingExtensionUpdateCheck("status_changed");
  }
}

async function handleUpdateAvailable(details: { version?: string }): Promise<void> {
  pendingExtensionUpdate = {
    version: typeof details.version === "string" && details.version.length > 0 ? details.version : undefined,
    pendingSince: Date.now(),
    state: "waiting_for_idle",
  };
  appendDebugLog("info", "extension.update.pending", { version: pendingExtensionUpdate.version });
  await persistPendingExtensionUpdate();
  await setStatus({ ...status, updatedAt: Date.now() });
  publishExtensionStatus();
  await maybeApplyPendingExtensionUpdate("update_available");
}

function schedulePendingExtensionUpdateCheck(trigger: PendingExtensionUpdateTrigger): void {
  if (!pendingExtensionUpdate) return;
  pendingExtensionUpdateCheckTrigger = trigger;
  if (pendingExtensionUpdateCheckTimer) return;
  pendingExtensionUpdateCheckTimer = scheduleTimer(() => {
    pendingExtensionUpdateCheckTimer = undefined;
    const queuedTrigger = pendingExtensionUpdateCheckTrigger ?? trigger;
    pendingExtensionUpdateCheckTrigger = undefined;
    void maybeApplyPendingExtensionUpdate(queuedTrigger);
  }, 0);
}

async function maybeApplyPendingExtensionUpdate(trigger: PendingExtensionUpdateTrigger): Promise<void> {
  if (!pendingExtensionUpdate) return;
  applyingPendingExtensionUpdate = true;
  try {
    const active = browserControlActivitySnapshot();
    if (active.active) {
      appendDebugLog("debug", "extension.update.waiting_for_idle", { trigger, reasons: active.reasons });
      await setStatus({ ...status, updatedAt: Date.now() });
      publishExtensionStatus();
      return;
    }
    const version = pendingExtensionUpdate.version;
    appendDebugLog("info", "extension.update.reload", { trigger, version });
    pendingExtensionUpdate = undefined;
    await persistPendingExtensionUpdate();
    await setStatus({ ...status, updatedAt: Date.now() });
    publishExtensionStatus();
    chrome.runtime.reload();
  } finally {
    applyingPendingExtensionUpdate = false;
  }
}

function browserControlActivitySnapshot(): { active: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (overlayCoordinator.activeTabIds().length > 0) reasons.push("active_takeover");
  if (overlayCoordinator.hasPendingActivity()) reasons.push("overlay_pending");
  if (debuggerAttachLocks.size > 0) reasons.push("debugger_attach_lock");
  if (nativeHostBridge.hasPendingRequests()) reasons.push("native_request_pending");
  if (status.state === "connecting" || helloTimer !== undefined) reasons.push("native_hello_pending");
  if (reconnectTimer !== undefined) reasons.push("native_reconnect_pending");
  for (const session of sessions.values()) {
    if ([...session.tabs.values()].some((row) => row.status === "active")) reasons.push("active_session_tab");
    if (session.attachedTabIds.size > 0) reasons.push("debugger_attached");
  }
  return { active: reasons.length > 0, reasons: [...new Set(reasons)] };
}

async function persistPendingExtensionUpdate(): Promise<void> {
  await extensionUpdateStorage().set({ [PENDING_UPDATE_KEY]: pendingExtensionUpdate ?? null });
}

function extensionUpdateStorage(): {
  get<T extends Record<string, unknown>>(keys: string[] | string): Promise<T>;
  set(items: Record<string, unknown>): Promise<void>;
} {
  return chrome.storage.session ?? chrome.storage.local;
}

function publishExtensionStatus(): void {
  if (!port) return;
  try {
    sendNotification("onExtensionStatus", {
      pending_update: pendingExtensionUpdate ?? null,
    });
  } catch (error) {
    appendDebugLog("warn", "extension.status.publish_failed", { message: errorMessage(error) });
  }
}

async function extensionInstanceId(): Promise<string> {
  const existing = await chrome.storage.local.get<Record<string, unknown>>(INSTANCE_KEY);
  const value = existing[INSTANCE_KEY];
  if (typeof value === "string" && value.length > 0) return value;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTANCE_KEY]: id });
  return id;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message = "native host request timed out"): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function scheduleHelloTimeout(targetPort: NativePort): void {
  clearHelloTimeout();
  helloTimer = scheduleTimer(() => {
    helloTimer = undefined;
    if (port !== targetPort || status.state !== "connecting") return;
    port = null;
    try {
      targetPort.disconnect();
    } catch {
      // The port is already considered failed; cleanup is best effort.
    }
    appendDebugLog("error", "native.hello.timeout");
    void setStatus({
      state: "error",
      message: "native host hello timed out",
      diagnosis: "native_host_hello_timeout",
      updatedAt: Date.now(),
    });
    scheduleReconnect();
  }, HELLO_TIMEOUT_MS);
}

function clearHelloTimeout(): void {
  if (helloTimer !== undefined) clearTimeout(helloTimer);
  helloTimer = undefined;
}

function scheduleHeartbeat(): void {
  clearHeartbeat();
  heartbeatTimer = scheduleTimer(() => {
    heartbeatTimer = undefined;
    if (status.state !== "connected" || !port) return;
    void withTimeout(sendRequest("ping"), HEARTBEAT_TIMEOUT_MS, "native host heartbeat timed out").then(
      () => scheduleHeartbeat(),
      async (error) => {
        const message = errorMessage(error);
        appendDebugLog("warn", "native.heartbeat.failed", { message });
        const failedPort = port;
        port = null;
        failedPort?.disconnect();
        nativeHostBridge.rejectPending(message);
        await setStatus({
          state: "disconnected",
          message,
          diagnosis: message === "native host heartbeat timed out"
            ? "native_host_heartbeat_timeout"
            : diagnoseNativeHostFailure(message, "native_host_disconnected"),
          updatedAt: Date.now(),
        });
        await releaseActiveTakeoverForUnavailableHost("native_host_heartbeat_timeout");
        scheduleReconnect();
      },
    );
  }, HEARTBEAT_INTERVAL_MS);
}

function clearHeartbeat(): void {
  if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
  heartbeatTimer = undefined;
}

function scheduleReconnect(): void {
  if (!canReconnect() || reconnectTimer !== undefined) return;
  const delay = reconnectDelayMs;
  const nextRetryAt = Date.now() + delay;
  reconnectDelayMs = Math.min(RECONNECT_MAX_MS, reconnectDelayMs * 2);
  appendDebugLog("info", "native.reconnect.scheduled", { delayMs: delay });
  void setStatus({
    ...status,
    retryDelayMs: delay,
    nextRetryAt,
    updatedAt: Date.now(),
  });
  scheduleReconnectAt(nextRetryAt);
}

function canReconnect(): boolean {
  return !stopping && status.state !== "stopped" && status.state !== "connected" && status.state !== "version_mismatch";
}

function scheduleReconnectAt(nextRetryAt: number): void {
  if (!canReconnect() || reconnectTimer !== undefined) return;
  const delay = Math.max(0, nextRetryAt - Date.now());
  reconnectTimer = scheduleTimer(() => {
    reconnectTimer = undefined;
    if (canReconnect()) void connectNative();
  }, delay);
  void chrome.alarms.create(RECONNECT_ALARM_NAME, {
    delayInMinutes: Math.max(delay / 60_000, 1 / 60),
  });
}

function clearReconnect(): void {
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  void chrome.alarms.clear(RECONNECT_ALARM_NAME);
}

function debugLogStatus(): DebugLogSnapshot & { maxEntries: number } {
  return {
    enabled: debugLog.enabled,
    entries: [...debugLog.entries],
    maxEntries: DEBUG_LOG_MAX_ENTRIES,
  };
}

async function setDebugLogEnabled(enabled: boolean): Promise<void> {
  if (!enabled && debugLog.enabled) appendDebugLog("info", "debug.disabled");
  debugLog = { ...debugLog, enabled };
  if (enabled) appendDebugLog("info", "debug.enabled");
  await persistDebugLogs();
}

async function clearDebugLogs(): Promise<void> {
  debugLog = { ...debugLog, entries: [] };
  await persistDebugLogs();
}

function appendDebugLog(level: DebugLogLevel, event: string, data?: unknown): void {
  if (!debugLog.enabled) return;
  const entry: DebugLogEntry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(data === undefined ? {} : { data: sanitizeDebugData(data) }),
  };
  debugLog = {
    enabled: true,
    entries: [...debugLog.entries, entry].slice(-DEBUG_LOG_MAX_ENTRIES),
  };
  void persistDebugLogs();
}

async function persistDebugLogs(): Promise<void> {
  const snapshot = debugLogStatus();
  debugLogSave = debugLogSave
    .catch(() => undefined)
    .then(() => chrome.storage.local.set({ [DEBUG_LOG_KEY]: snapshot }).catch(() => undefined));
  await debugLogSave;
}

function parseDebugLogSnapshot(value: unknown): DebugLogSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const enabled = value.enabled === true;
  const entries = Array.isArray(value.entries)
    ? value.entries.filter(isDebugLogEntry).slice(-DEBUG_LOG_MAX_ENTRIES)
    : [];
  return { enabled, entries };
}

function isDebugLogEntry(value: unknown): value is DebugLogEntry {
  if (!isRecord(value)) return false;
  if (typeof value.ts !== "string" || typeof value.event !== "string") return false;
  return value.level === "debug" || value.level === "info" || value.level === "warn" || value.level === "error";
}

function statusLogLevel(next: HostStatus): DebugLogLevel {
  if (next.state === "error" || next.state === "version_mismatch") return "error";
  if (next.state === "disconnected") return "warn";
  return "info";
}

function sanitizeDebugData(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length > 300 ? `${value.slice(0, 300)}...` : value;
  if (value === undefined) return undefined;
  if (depth >= 3) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeDebugData(item, depth + 1));
  if (!isRecord(value)) return String(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    if (/token|password|secret|auth|cookie/i.test(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = sanitizeDebugData(item, depth + 1);
    }
  }
  return out;
}

function diagnoseNativeHostFailure(message: string, fallback: HostDiagnosis): HostDiagnosis {
  if (/specified native messaging host.*not found/i.test(message)) return "native_host_not_found";
  if (/access to the specified native messaging host is forbidden/i.test(message)) return "native_host_forbidden";
  if (/disconnected port object/i.test(message)) return "native_host_unavailable";
  if (/native host.*(exited|crash|failed)|host process/i.test(message)) return "native_host_crashed";
  if (/hello timed out/i.test(message)) return "native_host_hello_timeout";
  if (/heartbeat timed out/i.test(message)) return "native_host_heartbeat_timeout";
  if (/disconnected/i.test(message)) return "native_host_disconnected";
  return fallback;
}

function scheduleTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, delayMs);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

async function detectBrowserKind(): Promise<string> {
  const nav = globalThis.navigator as
    | {
        userAgent?: string;
        userAgentData?: { brands?: Array<{ brand?: string }> };
        brave?: { isBrave?: () => Promise<boolean> };
      }
    | undefined;
  if (await nav?.brave?.isBrave?.().catch(() => false)) return "brave";
  const brands = nav?.userAgentData?.brands?.map((brand) => brand.brand ?? "") ?? [];
  const lowerBrands = brands.map((brand) => brand.toLowerCase());
  const haystack = [...brands, nav?.userAgent ?? ""].join(" ").toLowerCase();
  if (lowerBrands.some((brand) => brand.includes("microsoft edge")) || haystack.includes("edg/")) return "edge";
  if (lowerBrands.some((brand) => brand.includes("brave")) || haystack.includes("brave")) return "brave";
  if (lowerBrands.some((brand) => brand.includes("arc")) || haystack.includes("arc/")) return "arc";
  if (lowerBrands.some((brand) => brand === "chromium") && !lowerBrands.some((brand) => brand.includes("google chrome"))) {
    return "chromium";
  }
  return "chrome";
}

function isMessage(message: unknown, type: string): boolean {
  return isRecord(message) && message.type === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isHostStatus(value: unknown): value is HostStatus {
  return isRecord(value) && typeof value.state === "string";
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return (
    isRecord(value) &&
    value.jsonrpc === "2.0" &&
    typeof value.id === "number" &&
    typeof value.method !== "string" &&
    ("result" in value || "error" in value)
  );
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    isRecord(value) &&
    value.jsonrpc === "2.0" &&
    typeof value.id === "number" &&
    typeof value.method === "string"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type PendingDialogAwareClose = {
  sessionId: string;
  operation: string;
  reject(error: Error): void;
};

type TabDto = {
  tabId: number;
  windowId?: number;
  groupId?: number;
  url?: string;
  title?: string;
  active?: boolean;
  logicalActive?: boolean;
  pinned?: boolean;
  origin: "agent" | "user";
  status: "active" | "handoff" | "deliverable";
  owned?: boolean;
  claimRequired?: boolean;
  commandable?: boolean;
};

type SessionTabsResult = {
  tabs: TabDto[];
  deliverableTabs: TabDto[];
};

type FinalizeTabsResult = {
  closedTabIds: number[];
  releasedTabIds: number[];
  keptTabs: TabDto[];
  deliverableTabs: TabDto[];
};

type HistoryItemDto = {
  id?: string;
  url: string;
  title?: string;
  lastVisitTime?: number;
  visitCount?: number;
  typedCount?: number;
};

type DownloadOwner = {
  sessionId: string;
  tabId?: number;
  suggestedFilename?: string;
};

type SessionCleanupMode = "stop" | "unavailable";

type CleanupBrowserTabsResult = {
  closedTabs: number;
  releasedTabs: number;
  keptDeliverables: number;
};

export {};

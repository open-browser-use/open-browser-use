import {
  OverlayCoordinator,
  type CursorTarget,
  type PendingExtensionUpdateTrigger,
  type SessionParams,
} from "./overlay_coordinator.js";
import {
  JsonRpcError,
  NativeHostBridge,
  errorToJsonRpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./native_host_bridge.js";
import {
  NativeTransportController,
  type HostStatus,
} from "./native_transport_controller.js";
import { ForegroundObserver } from "./foreground_observer.js";
import {
  BrowserSessionController,
  type ResumeControlResult,
  type SessionTabsResult,
  type TabDto,
} from "./browser_session_controller.js";
import { BrowserCapabilityController } from "./browser_capability_controller.js";
import { BrowserDebuggerController } from "./browser_debugger_controller.js";
import {
  BrowserDownloadController,
  type HistoryItemDto,
} from "./browser_download_controller.js";
import {
  TabLifecycleController,
  type CleanupBrowserTabsResult,
} from "./tab_lifecycle_controller.js";
import {
  FinalizeTabsController,
  type FinalizeTabsResult,
} from "./finalize_tabs_controller.js";
import {
  type BrowserSession,
  type SessionTab,
  type TabOrigin,
} from "./session_store.js";
import { BrowserSessionRepository } from "./browser_session_repository.js";
import { requireTabWindowId, TabGroupManager } from "./tab_group_manager.js";
import { type NativeHostDiagnosis } from "./lifecycle/native_transport_machine.js";
import {
  createPendingExtensionUpdate,
  parsePendingExtensionUpdate,
  planApplyPendingExtensionUpdate,
  planPendingExtensionUpdateCheck,
  queuedPendingExtensionUpdateTrigger,
  snapshotBrowserControlActivity,
  statusWithPendingExtensionUpdate,
  type BrowserControlActivitySnapshot,
  type PendingExtensionUpdate,
} from "./lifecycle/extension_update_machine.js";
import {
  isClaimableUserTabInfo,
  isRestrictedBrowserUrl,
  isTabOwnedByAnotherSession,
} from "./lifecycle/tab_ownership_machine.js";

const HOST_NAME = "dev.obu.host";
const STATUS_KEY = "OBU_NATIVE_HOST_STATUS";
const INSTANCE_KEY = "OBU_EXTENSION_INSTANCE_ID";
const SESSION_STATE_KEY = "OBU_BROWSER_SESSION_STATE";
const DEBUG_LOG_KEY = "OBU_DEBUG_LOG";
const PENDING_UPDATE_KEY = "OBU_PENDING_EXTENSION_UPDATE";
const DEBUG_LOG_MAX_ENTRIES = 200;
const HELLO_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_ALARM_NAME = "obu.reconnectNativeHost";

type HostDiagnosis = NativeHostDiagnosis;

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

let debugLog: DebugLogSnapshot = { enabled: false, entries: [] };
let debugLogSave: Promise<void> = Promise.resolve();
const pendingDialogAwareCloses = new Map<number, PendingDialogAwareClose>();
let pendingExtensionUpdate: PendingExtensionUpdate | undefined;
let pendingExtensionUpdateCheckTimer: ReturnType<typeof setTimeout> | undefined;
let pendingExtensionUpdateCheckTrigger: PendingExtensionUpdateTrigger | undefined;
let applyingPendingExtensionUpdate = false;
let popupControlTurnSequence = 0;

const overlayCoordinator = new OverlayCoordinator((trigger) => {
  schedulePendingExtensionUpdateCheck(trigger);
  publishExtensionStatus();
});
const foregroundObserver = new ForegroundObserver({
  queryActiveTab: async (windowId) => {
    try {
      return (await chrome.tabs.query({ active: true, windowId }))[0];
    } catch {
      return undefined;
    }
  },
  findSessionForTab,
  persistSessionState,
  syncForeground: () => overlayCoordinator.syncForeground(),
  appendDebugLog: (level, event, data) => appendDebugLog(level, event, data),
});
let nativeTransport: NativeTransportController;
const nativeHostBridge = new NativeHostBridge(
  () => nativeTransport.currentPort(),
  (level, event, data) => appendDebugLog(level, event, data),
);
nativeTransport = new NativeTransportController({
  hostName: HOST_NAME,
  reconnectAlarmName: RECONNECT_ALARM_NAME,
  helloTimeoutMs: HELLO_TIMEOUT_MS,
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
  reconnectInitialMs: RECONNECT_INITIAL_MS,
  reconnectMaxMs: RECONNECT_MAX_MS,
  initialStatus: { state: "disconnected", updatedAt: Date.now() },
  now: () => Date.now(),
  scheduleTimer,
  connectNative: (hostName) => chrome.runtime.connectNative(hostName),
  createReconnectAlarm: (name, delayMs) => {
    void chrome.alarms.create(name, {
      delayInMinutes: Math.max(delayMs / 60_000, 1 / 60),
    });
  },
  clearReconnectAlarm: (name) => {
    void chrome.alarms.clear(name);
  },
  runtimeLastErrorMessage: () => chrome.runtime.lastError?.message,
  appendDebugLog: (level, event, data) => appendDebugLog(level, event, data),
  statusLogLevel,
  normalizeStatus: statusWithPendingUpdate,
  persistStatus: async (next) => {
    await chrome.storage.local.set({ [STATUS_KEY]: next });
    if (pendingExtensionUpdate && !applyingPendingExtensionUpdate) {
      schedulePendingExtensionUpdateCheck("status_changed");
    }
  },
  diagnoseNativeHostFailure,
  rejectPending: (message) => nativeHostBridge.rejectPending(message),
  sendRequest: (method, params) => nativeHostBridge.sendRequest(method, params),
  stopRequestParams: async () => ({
    reason: "popup_stop",
    extension_instance_id: await extensionInstanceId(),
  }),
  handleNativeApplicationMessage,
  releaseActiveTakeoverForUnavailableHost,
  stopActiveBrowserControl,
  helloPayload: nativeHelloPayload,
  publishExtensionStatus,
  schedulePendingExtensionUpdateCheck,
});
const tabGroupManager = new TabGroupManager((level, event, data) => appendDebugLog(level, event, data));
const sessionRepository = new BrowserSessionRepository({
  persistState: async (state) => {
    await chrome.storage.local.set({ [SESSION_STATE_KEY]: state });
  },
  groupIdForTab: (tabId) => tabGroupManager.groupIdForTab(tabId),
});
const browserSessionController = new BrowserSessionController({
  sessionFor,
  createTab: (createProperties) => chrome.tabs.create(createProperties),
  getTab: (tabId) => chrome.tabs.get(tabId),
  queryTabs: (queryInfo) => chrome.tabs.query(queryInfo),
  addTabToSessionGroup,
  renameSession: (sessionId, label) => tabGroupManager.renameSession(sessionId, label),
  removeManagedTab: (tabId) => tabGroupManager.removeManagedTab(tabId),
  forgetOverlay: (tabId) => overlayCoordinator.forget(tabId),
  detachDebugger: (tabId) => chrome.debugger.detach({ tabId }),
  removeDownloadOwnersForTab: (tabId) => browserDownloadController.removeDownloadOwnersForTab(tabId),
  removeFinalizedTabFromAllSessions,
  syncSessionGroupMirrors,
  syncAllSessionGroupMirrors,
  ownedByAnotherSession,
  isClaimableUserTab,
  toTabDto,
  activateOverlay: (tabId, sessionParams, savedCursor) => overlayCoordinator.activate(tabId, sessionParams, savedCursor),
  hideSessionTakeover,
  persistSessionState,
  appendDebugLog,
  isTabGoneError,
});
const browserDebuggerController = new BrowserDebuggerController({
  sessionFor,
  requireSessionTab: (sessionParams, tabId) => browserSessionController.requireSessionTab(sessionParams, tabId),
  attachDebugger: (tabId) => attachDebuggerWithOopifAutoAttach(tabId),
  detachDebugger: (tabId) => chrome.debugger.detach({ tabId }),
  sendDebuggerCommand: (tabId, method, commandParams, sessionId) =>
    chrome.debugger.sendCommand(debuggerTarget(tabId, sessionId), method, commandParams),
  activateOverlay: (tabId, sessionParams, savedCursor) => overlayCoordinator.activate(tabId, sessionParams, savedCursor),
  allowCdpInput: (tabId, sessionParams, bypass) => overlayCoordinator.allowCdpInput(tabId, sessionParams, bypass),
  sendCursorEvent: (tabId, sessionParams, event) => overlayCoordinator.sendCursorEvent(tabId, sessionParams, event),
  withCaptureSuppressed: (tabId, operation) => overlayCoordinator.withCaptureSuppressed(tabId, operation),
  moveMouse: (tabId, sessionParams, x, y) => overlayCoordinator.moveMouse(tabId, sessionParams, x, y),
  persistSessionState,
  appendDebugLog,
});
const browserDownloadController = new BrowserDownloadController({
  historySearch: (query) => chrome.history.search(query),
  downloadSearch: (query) => chrome.downloads.search(query),
  sendNotification,
  appendDebugLog,
});
const tabLifecycleController = new TabLifecycleController({
  sessions: () => sessionRepository.values(),
  sessionEntries: () => sessionRepository.entries(),
  forgetOverlay: (tabId) => overlayCoordinator.forget(tabId),
  activeOverlayTabIds: () => overlayCoordinator.activeTabIds(),
  replaceOverlayTabId: (removedTabId, addedTabId) => overlayCoordinator.replaceTabId(removedTabId, addedTabId),
  hideCursor,
  removeManagedTab: (tabId) => tabGroupManager.removeManagedTab(tabId),
  replaceManagedTab: (removedTabId, addedTabId) => tabGroupManager.replaceManagedTab(removedTabId, addedTabId),
  releaseManagedTab: (tabId) => tabGroupManager.releaseManagedTab(tabId),
  closeAgentTabWithDialogPolicy,
  cleanupControlledTab,
  detachDebugger: (tabId) => browserDebuggerController.detachDebuggerTarget(tabId),
  removeDownloadOwnersForTab: (tabId) => browserDownloadController.removeDownloadOwnersForTab(tabId),
  syncSessionGroupMirrors,
  syncAllSessionGroupMirrors,
  countDeliverableTabs,
  pruneEmptySessions,
  persistSessionState,
  handleForegroundTabChanged: (tabId, reason) => foregroundObserver.handleForegroundTabChanged(tabId, reason),
  appendDebugLog,
  schedulePendingExtensionUpdateCheck,
});
const browserCapabilityController = new BrowserCapabilityController({
  requireCurrentSessionTabForBrowserCommand,
  ensureDebuggerAttached: (sessionId, tabId) => browserDebuggerController.ensureDebuggerAttached(sessionId, tabId),
  sendDebuggerCommand: (tabId, method, commandParams) => chrome.debugger.sendCommand({ tabId }, method, commandParams),
  updateWindow: (windowId, updateInfo) => chrome.windows.update(windowId, updateInfo),
  getWindow: (windowId) => chrome.windows.get(windowId),
  appendDebugLog,
});
const finalizeTabsController = new FinalizeTabsController({
  sessionFor,
  hideSessionTakeover,
  closeAgentTabWithDialogPolicy,
  cleanupControlledTab,
  removeManagedTab: (tabId) => tabGroupManager.removeManagedTab(tabId),
  releaseManagedTab: (tabId) => tabGroupManager.releaseManagedTab(tabId),
  setManagedTabStatus: (tabId, status) => tabGroupManager.setManagedTabStatus(tabId, status),
  getTab: (tabId) => chrome.tabs.get(tabId),
  moveTabToDeliverableGroup,
  toTabDto,
  syncSessionGroupMirrors,
  repairSessionActiveTab: (session) => browserSessionController.repairSessionActiveTab(session),
  persistSessionState,
  appendDebugLog,
  schedulePendingExtensionUpdateCheck,
  isTabGoneError,
});

void bootstrapBackground();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM_NAME) return;
  nativeTransport.onReconnectAlarm();
});

chrome.runtime.onUpdateAvailable?.addListener((details) => {
  void handleUpdateAvailable(details);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void handleTabRemoved(tabId);
});

chrome.tabs.onActivated?.addListener((activeInfo) => {
  void foregroundObserver.handleForegroundTabChanged(activeInfo.tabId, "tab_activated");
});

chrome.tabs.onAttached?.addListener((tabId) => {
  void foregroundObserver.handleForegroundTabChanged(tabId, "tab_attached");
});

chrome.tabs.onDetached?.addListener((tabId) => {
  void foregroundObserver.handleForegroundTabChanged(tabId, "tab_detached");
});

chrome.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
  void handleTabReplaced(addedTabId, removedTabId);
});

chrome.windows.onFocusChanged?.addListener((windowId) => {
  void foregroundObserver.handleWindowFocusChanged(windowId);
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
    if (isMessage(message, "TAKE_BROWSER_CONTROL")) {
      await takeBrowserControl();
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
  // The CDP child session id (Chrome 125+) for events from a flattened OOPIF
  // target; absent for top-level page events. Forwarded so the host can key its
  // OOPIF session map and route session-addressed commands back.
  const childSessionId = typeof source.sessionId === "string" ? source.sessionId : undefined;
  const eventSource = childSessionId === undefined ? { tabId } : { tabId, sessionId: childSessionId };
  appendDebugLog("debug", "debugger.event", { method, tabId, sessionId: childSessionId });
  // Re-arm auto-attach on each newly-attached OOPIF child so nested
  // out-of-process iframes attach too (mirrors the raw-CDP backend's re-arm).
  maybeRearmOopifAutoAttach(tabId!, method, params);
  browserDownloadController.handleCdpEvent(owner.sessionId, tabId!, method, params);
  const safeDialogAction = safeDialogAutoAction(method, params);
  if (safeDialogAction) {
    sendNotification("onCDPEvent", {
      session_id: owner.sessionId,
      source: eventSource,
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
      source: eventSource,
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
    source: eventSource,
    method,
    params,
  });
});

// `Target.setAutoAttach{flatten}` params, shared by the attach-time arm and the
// per-child re-arm. `flatten:true` routes child (OOPIF) sessions over the same
// `chrome.debugger` connection; `waitForDebuggerOnStart:false` lets them run.
const OOPIF_AUTO_ATTACH_PARAMS = {
  autoAttach: true,
  flatten: true,
  waitForDebuggerOnStart: false,
} as const;

/// A `chrome.debugger` target, optionally addressed to a flattened child session.
function debuggerTarget(tabId: number, sessionId?: string): { tabId: number; sessionId?: string } {
  return sessionId === undefined ? { tabId } : { tabId, sessionId };
}

/// Attach the debugger to a tab, then arm `Target.setAutoAttach{flatten}` so
/// out-of-process iframes attach as flattened child sessions on this connection.
async function attachDebuggerWithOopifAutoAttach(tabId: number): Promise<void> {
  await chrome.debugger.attach({ tabId }, "1.3");
  try {
    await chrome.debugger.sendCommand({ tabId }, "Target.setAutoAttach", OOPIF_AUTO_ATTACH_PARAMS);
  } catch (error) {
    // A page with no cross-origin frames still works; OOPIF support is simply
    // unavailable until a future re-attach. Don't fail the attach over it.
    appendDebugLog("warn", "debugger.setAutoAttach.failed", { tabId, message: errorMessage(error) });
  }
}

/// When a flattened OOPIF child attaches, re-arm auto-attach on it so nested
/// out-of-process iframes attach too. Mirrors the raw-CDP backend's re-arm.
function maybeRearmOopifAutoAttach(tabId: number, method: string, params: unknown): void {
  if (method !== "Target.attachedToTarget" || !isRecord(params)) return;
  const targetInfo = isRecord(params.targetInfo) ? params.targetInfo : undefined;
  if (targetInfo?.type !== "iframe") return;
  const childSessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
  if (childSessionId === undefined) return;
  void chrome.debugger
    .sendCommand(debuggerTarget(tabId, childSessionId), "Target.setAutoAttach", OOPIF_AUTO_ATTACH_PARAMS)
    .catch((error) => {
      appendDebugLog("debug", "debugger.setAutoAttach.rearm.failed", {
        tabId,
        sessionId: childSessionId,
        message: errorMessage(error),
      });
    });
}

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
  browserDownloadController.handleDownloadCreated(item);
});

chrome.downloads.onChanged.addListener((delta) => {
  void handleDownloadChanged(delta);
});

async function handleDownloadChanged(delta: ChromeDownloadDelta): Promise<void> {
  await browserDownloadController.handleDownloadChanged(delta);
}

async function connectNative(): Promise<void> {
  await nativeTransport.connect();
}

async function handleNativeApplicationMessage(message: unknown, sourcePort: NativePort): Promise<void> {
  if (isJsonRpcRequest(message)) {
    appendDebugLog("debug", "native.request", { id: message.id, method: message.method });
    await handleHostRequest(message, sourcePort);
    return;
  }
  if (isJsonRpcResponse(message)) {
    nativeHostBridge.resolveResponse(message);
  }
}

async function resumeBrowserControl(): Promise<void> {
  if (nativeTransport.currentStatus().state === "connected" && hasHumanTakeoverSession()) {
    await resumeAgentControl();
    return;
  }
  await nativeTransport.resume();
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
    if (nativeTransport.isCurrentPort(sourcePort)) {
      sourcePort.postMessage({ jsonrpc: "2.0", id: request.id, result } satisfies JsonRpcResponse);
    }
    appendDebugLog("debug", "host.request.ok", { id: request.id, method: request.method });
  } catch (error) {
    const rpcError = errorToJsonRpcError(error);
    if (nativeTransport.isCurrentPort(sourcePort)) {
      sourcePort.postMessage({
        jsonrpc: "2.0",
        id: request.id,
        error: rpcError,
      } satisfies JsonRpcResponse);
    }
    appendDebugLog("warn", "host.request.error", {
      id: request.id,
      method: request.method,
      code: rpcError.code,
      message: rpcError.message,
    });
  }
}

async function dispatchHostRequest(method: string, params: unknown): Promise<unknown> {
  if (nativeTransport.isStopping() || nativeTransport.currentStatus().state === "stopped") {
    throw new JsonRpcError({
      code: -1004,
      message: "browser control is stopped",
      data: {
        code: "browser_control_stopped",
        state: nativeTransport.currentStatus().state,
      },
    });
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
    case "getTabUrlForPolicy":
      return await getTabUrlForPolicy(requireSessionParams(params), params);
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
      return await resumeControl(requireSessionParams(params));
    case "getUserHistory":
      return { items: await getUserHistory(params) };
    case "browser_viewport_set":
      return await setBrowserViewport(requireSessionParams(params), params);
    case "browser_viewport_reset":
      return await resetBrowserViewport(requireSessionParams(params));
    case "browser_visibility_set":
      return await setBrowserVisibility(requireSessionParams(params), params);
    case "browser_visibility_get":
      return await getBrowserVisibility(requireSessionParams(params));
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
      throw new JsonRpcError({
        code: -32601,
        message: `method not found: ${method}`,
        data: { code: "method_not_found", method },
      });
  }
}

async function createSessionTab(sessionParams: SessionParams, params: unknown): Promise<ChromeTab> {
  const url = isRecord(params) && typeof params.url === "string" ? params.url : "about:blank";
  return await browserSessionController.createSessionTab(sessionParams, url);
}

async function getSessionTabs(sessionParams: SessionParams): Promise<SessionTabsResult> {
  return await browserSessionController.getSessionTabs(sessionParams);
}

async function getCurrentSessionTab(sessionParams: SessionParams): Promise<TabDto | null> {
  return await browserSessionController.getCurrentSessionTab(sessionParams);
}

async function getTabUrlForPolicy(sessionParams: SessionParams, params: unknown): Promise<{ url: string }> {
  const tabId = requireTabId(params);
  const session = sessionRepository.get(sessionParams.session_id);
  const row = session?.tabs.get(tabId);
  if (!session || !row || row.status !== "active") {
    throw new Error(`tab ${tabId} is not actively controlled`);
  }
  if (session.controlState === "human_takeover") {
    throw new Error("tab command blocked during human takeover");
  }
  const tab = await chrome.tabs.get(tabId);
  return { url: tab.url ?? "" };
}

async function getSelectedTab(sessionParams: SessionParams): Promise<TabDto | null> {
  return await browserSessionController.getSelectedTab(sessionParams);
}

async function getUserTabs(sessionParams: SessionParams): Promise<TabDto[]> {
  return await browserSessionController.getUserTabs(sessionParams);
}

async function claimUserTab(sessionParams: SessionParams, params: unknown): Promise<ChromeTab> {
  const tabId = requireTabId(params);
  return await browserSessionController.claimUserTab(sessionParams, tabId);
}

async function finalizeTabs(sessionParams: SessionParams, params: unknown): Promise<FinalizeTabsResult> {
  return await finalizeTabsController.finalizeTabs(sessionParams, params);
}

async function nameSession(sessionParams: SessionParams, params: unknown): Promise<void> {
  const label = isRecord(params) && typeof params.label === "string" ? params.label : undefined;
  await browserSessionController.nameSession(sessionParams, label);
}

async function markTurnEnded(sessionParams: SessionParams): Promise<void> {
  browserSessionController.markTurnEnded(sessionParams);
}

async function yieldControl(sessionParams: SessionParams): Promise<void> {
  await browserSessionController.yieldControl(sessionParams);
}

async function resumeControl(sessionParams: SessionParams): Promise<ResumeControlResult> {
  return await browserSessionController.resumeControl(sessionParams);
}

async function getUserHistory(params: unknown): Promise<HistoryItemDto[]> {
  return await browserDownloadController.getUserHistory(params);
}

async function setBrowserViewport(sessionParams: SessionParams, params: unknown): Promise<unknown> {
  return await browserCapabilityController.setViewport(sessionParams, params);
}

async function resetBrowserViewport(sessionParams: SessionParams): Promise<unknown> {
  return await browserCapabilityController.resetViewport(sessionParams);
}

async function setBrowserVisibility(sessionParams: SessionParams, params: unknown): Promise<unknown> {
  return await browserCapabilityController.setVisibility(sessionParams, params);
}

async function getBrowserVisibility(sessionParams: SessionParams): Promise<unknown> {
  return await browserCapabilityController.getVisibility(sessionParams);
}

async function requireCurrentSessionTabForBrowserCommand(
  sessionParams: SessionParams,
  operation: string,
): Promise<{ tabId: number; tab: ChromeTab; row: SessionTab }> {
  return await browserSessionController.requireCurrentSessionTabForBrowserCommand(sessionParams, operation);
}

async function executeCdp(params: unknown): Promise<unknown> {
  return await browserDebuggerController.executeCdp(params);
}

async function moveMouse(params: unknown): Promise<unknown> {
  return await browserDebuggerController.moveMouse(params);
}

async function attachDebugger(params: unknown): Promise<void> {
  await browserDebuggerController.attachDebugger(params);
}

async function detachDebugger(params: unknown): Promise<void> {
  await browserDebuggerController.detachDebugger(params);
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

function requireSessionTab(params: unknown): SessionTab {
  const tabId = requireTabId(params);
  const sessionParams = requireSessionParams(params);
  return browserSessionController.requireSessionTab(sessionParams, tabId);
}

function requireTabId(params: unknown): number {
  if (!isRecord(params)) throw new Error("request params must be an object");
  const direct = params.tabId;
  if (typeof direct === "number" && Number.isInteger(direct)) return direct;
  const target = isRecord(params.target) ? params.target.tabId : undefined;
  if (typeof target === "number" && Number.isInteger(target)) return target;
  throw new Error("tabId must be an integer");
}

function sessionFor(sessionId: string): BrowserSession {
  return sessionRepository.sessionFor(sessionId);
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
    await browserDebuggerController.detachDebuggerTarget(tabId);
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
      await browserDebuggerController.attachDebuggerTarget(tabId);
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
        await browserDebuggerController.detachDebuggerTarget(tabId);
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

async function hideSessionTakeover(session: BrowserSession): Promise<void> {
  const tabIds = new Set<number>();
  for (const tabId of session.tabs.keys()) tabIds.add(tabId);
  for (const tabId of session.attachedTabIds) tabIds.add(tabId);
  for (const tabId of tabIds) await hideCursor(tabId);
}

function isClaimableUserTab(tab: ChromeTab): boolean {
  return isClaimableUserTabInfo(tab);
}

function isRestrictedUrl(url: string | undefined): boolean {
  return isRestrictedBrowserUrl(url);
}

function ownedByAnotherSession(sessionId: string, tabId: number): boolean {
  return isTabOwnedByAnotherSession(sessionRepository.entries(), sessionId, tabId);
}

function removeFinalizedTabFromAllSessions(tabId: number): void {
  sessionRepository.removeFinalizedTabFromAllSessions(tabId);
}

function findSessionForTab(tabId: number): { sessionId: string; session: BrowserSession } | undefined {
  return sessionRepository.findSessionForTab(tabId);
}

async function handleTabRemoved(tabId: number): Promise<void> {
  await tabLifecycleController.handleTabRemoved(tabId);
}

async function handleTabReplaced(addedTabId: number, removedTabId: number): Promise<void> {
  await tabLifecycleController.handleTabReplaced(addedTabId, removedTabId);
}

async function stopActiveBrowserControl(): Promise<CleanupBrowserTabsResult> {
  return await tabLifecycleController.cleanupAllSessionTabs("stop");
}

async function takeBrowserControl(): Promise<void> {
  const sessions = sessionParamsForPopupControl("popup-take-control")
    .filter(({ session }) => {
      return session.controlState !== "human_takeover" &&
        [...session.tabs.values()].some((row) => row.status === "active");
    });
  if (sessions.length === 0) return;
  const payload = { sessions: sessions.map(({ params }) => params) };
  await sendRequest("takeBrowserControl", payload);
  for (const { params } of sessions) {
    await browserSessionController.yieldControl(params);
  }
  await publishBrowserControlStatus();
}

async function resumeAgentControl(): Promise<void> {
  const sessions = sessionParamsForPopupControl("popup-resume-control")
    .filter(({ session }) => session.controlState === "human_takeover");
  if (sessions.length === 0) return;
  const payload = { sessions: sessions.map(({ params }) => params) };
  await sendRequest("resumeBrowserControl", payload);
  for (const { params } of sessions) {
    await browserSessionController.resumeControl(params);
  }
  await publishBrowserControlStatus();
}

async function cleanUpBrowserTabs(): Promise<CleanupBrowserTabsResult> {
  const result = await tabLifecycleController.cleanupAllSessionTabs("stop");
  appendDebugLog("info", "browser_tabs.cleaned", result);
  schedulePendingExtensionUpdateCheck("browser_tabs_cleaned");
  return result;
}

async function hideCursor(tabId: number): Promise<void> {
  await overlayCoordinator.hide(tabId);
}

async function releaseActiveTakeoverForUnavailableHost(reason: string): Promise<void> {
  appendDebugLog("warn", "takeover.release.unavailable_host", { reason });
  await tabLifecycleController.cleanupAllSessionTabs("unavailable");
  await maybeApplyPendingExtensionUpdate("unavailable_host");
}

async function getStatus(): Promise<HostStatus> {
  const current = nativeTransport.currentStatus();
  if ((current.state === "disconnected" || current.state === "error" || current.state === "heartbeat_failed") && !nativeTransport.hasReconnectTimer()) {
    void connectNative();
  }
  return statusWithBrowserControl(statusWithOverlayRelease(statusWithDeliverables(statusWithPendingUpdate(nativeTransport.currentStatus()))));
}

function statusWithBrowserControl(current: HostStatus): HostStatus {
  const base = { ...current };
  delete base.browserControl;
  if (hasHumanTakeoverSession()) return { ...base, browserControl: "human_takeover" };
  return base;
}

async function publishBrowserControlStatus(): Promise<void> {
  await setStatus(statusWithBrowserControl(nativeTransport.currentStatus()));
  publishExtensionStatus();
}

function statusWithDeliverables(current: HostStatus): HostStatus {
  const deliverableTabs = countDeliverableTabs();
  if (deliverableTabs === 0) return current;
  return { ...current, deliverableTabs };
}

function statusWithPendingUpdate(current: HostStatus): HostStatus {
  return statusWithPendingExtensionUpdate(current, pendingExtensionUpdate);
}

function statusWithOverlayRelease(current: HostStatus): HostStatus {
  const overlayRelease = overlayCoordinator.releaseDiagnostics();
  if (overlayRelease.length === 0) return current;
  return { ...current, overlayRelease };
}

function countDeliverableTabs(): number {
  return sessionRepository.countDeliverableTabs();
}

function hasHumanTakeoverSession(): boolean {
  return [...sessionRepository.values()].some((session) => session.controlState === "human_takeover");
}

function sessionParamsForPopupControl(prefix: string): Array<{
  sessionId: string;
  session: BrowserSession;
  params: SessionParams;
}> {
  return [...sessionRepository.entries()].map(([sessionId, session]) => ({
    sessionId,
    session,
    params: {
      session_id: sessionId,
      turn_id: nextPopupControlTurnId(prefix, sessionId),
    },
  }));
}

function nextPopupControlTurnId(prefix: string, sessionId: string): string {
  popupControlTurnSequence = (popupControlTurnSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}:${sessionId}:${Date.now()}:${popupControlTurnSequence}`;
}

function syncSessionGroupMirrors(session: BrowserSession): void {
  sessionRepository.syncGroupMirrors(session);
}

function syncAllSessionGroupMirrors(): void {
  sessionRepository.syncAllGroupMirrors();
}

function pruneEmptySessions(): void {
  sessionRepository.pruneEmptySessions();
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
  await nativeTransport.bootstrap(stored[STATUS_KEY], isHostStatus);
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
  await sessionRepository.restoreFromStorageValue(stored[SESSION_STATE_KEY], {
    getTab: (tabId) => chrome.tabs.get(tabId),
    restoreDurableTab: (sessionId, session, tab, durableTab) =>
      tabGroupManager.restoreDurableTab(sessionId, session, tab, durableTab),
    repairSessionActiveTab: (session) => browserSessionController.repairSessionActiveTab(session),
  });
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
  await sessionRepository.persist();
}

async function setStatus(next: HostStatus): Promise<void> {
  await nativeTransport.setStatus(next);
}

async function handleUpdateAvailable(details: { version?: string }): Promise<void> {
  pendingExtensionUpdate = createPendingExtensionUpdate(details, Date.now());
  appendDebugLog("info", "extension.update.pending", { version: pendingExtensionUpdate.version });
  await persistPendingExtensionUpdate();
  await setStatus({ ...nativeTransport.currentStatus(), updatedAt: Date.now() });
  publishExtensionStatus();
  await maybeApplyPendingExtensionUpdate("update_available");
}

function schedulePendingExtensionUpdateCheck(trigger: PendingExtensionUpdateTrigger): void {
  const plan = planPendingExtensionUpdateCheck({
    pending: pendingExtensionUpdate,
    timerActive: pendingExtensionUpdateCheckTimer !== undefined,
    trigger,
  });
  if (plan.kind === "none") return;
  pendingExtensionUpdateCheckTrigger = plan.trigger;
  if (!plan.shouldScheduleTimer) return;
  pendingExtensionUpdateCheckTimer = scheduleTimer(() => {
    pendingExtensionUpdateCheckTimer = undefined;
    const queuedTrigger = queuedPendingExtensionUpdateTrigger(pendingExtensionUpdateCheckTrigger, trigger);
    pendingExtensionUpdateCheckTrigger = undefined;
    void maybeApplyPendingExtensionUpdate(queuedTrigger);
  }, 0);
}

async function maybeApplyPendingExtensionUpdate(trigger: PendingExtensionUpdateTrigger): Promise<void> {
  const applyPlan = planApplyPendingExtensionUpdate({
    pending: pendingExtensionUpdate,
    activity: browserControlActivitySnapshot(),
    now: Date.now(),
  });
  if (applyPlan.kind === "none") return;
  applyingPendingExtensionUpdate = true;
  try {
    if (applyPlan.kind === "wait_for_idle") {
      pendingExtensionUpdate = applyPlan.pending;
      appendDebugLog("debug", "extension.update.waiting_for_idle", { trigger, reasons: applyPlan.reasons, ageMs: applyPlan.ageMs });
      await persistPendingExtensionUpdate();
      await setStatus({ ...nativeTransport.currentStatus(), updatedAt: Date.now() });
      publishExtensionStatus();
      return;
    }
    if (applyPlan.kind === "blocked") {
      pendingExtensionUpdate = applyPlan.pending;
      appendDebugLog("warn", "extension.update.blocked", {
        trigger,
        reasons: applyPlan.reasons,
        ageMs: applyPlan.ageMs,
        nextAction: applyPlan.nextAction,
      });
      await persistPendingExtensionUpdate();
      await setStatus({ ...nativeTransport.currentStatus(), updatedAt: Date.now() });
      publishExtensionStatus();
      return;
    }
    const version = applyPlan.version;
    pendingExtensionUpdate = applyPlan.pending;
    appendDebugLog("info", "extension.update.reload", { trigger, version });
    await setStatus({ ...nativeTransport.currentStatus(), updatedAt: Date.now() });
    publishExtensionStatus();
    pendingExtensionUpdate = undefined;
    await persistPendingExtensionUpdate();
    chrome.runtime.reload();
  } finally {
    applyingPendingExtensionUpdate = false;
  }
}

function browserControlActivitySnapshot(): BrowserControlActivitySnapshot {
  let activeSessionTabCount = 0;
  let debuggerAttachedTabCount = 0;
  for (const session of sessionRepository.values()) {
    activeSessionTabCount += [...session.tabs.values()].filter((row) => row.status === "active").length;
    debuggerAttachedTabCount += session.attachedTabIds.size;
  }
  return snapshotBrowserControlActivity({
    activeTakeoverCount: overlayCoordinator.activeTabIds().length,
    overlayPendingActivity: overlayCoordinator.hasPendingActivity(),
    debuggerAttachLockCount: browserDebuggerController.lockCount(),
    nativePendingRequests: nativeHostBridge.hasPendingRequests(),
    nativeState: nativeTransport.currentStatus().state,
    nativeHelloPending: nativeTransport.hasHelloTimer(),
    nativeReconnectPending: nativeTransport.hasReconnectTimer(),
    activeSessionTabCount,
    debuggerAttachedTabCount,
  });
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
  if (!nativeTransport.hasConnectedPort()) return;
  try {
    sendNotification("onExtensionStatus", {
      pending_update: pendingExtensionUpdate ?? null,
      overlay_release: overlayCoordinator.releaseDiagnostics(),
      session_lifecycle: sessionRepository.lifecycleDiagnostics(),
      native_requests: nativeHostBridge.diagnostics(),
    });
  } catch (error) {
    appendDebugLog("warn", "extension.status.publish_failed", { message: errorMessage(error) });
  }
}

async function nativeHelloPayload(): Promise<unknown> {
  const extensionInstance = await extensionInstanceId();
  return {
    type: "hello",
    extension_version: chrome.runtime.getManifest().version,
    manifest_version: 3,
    min_host_version: "0.1.0",
    native_host_name: HOST_NAME,
    browser_kind: await detectBrowserKind(),
    extension_id: chrome.runtime.id ?? "unknown",
    extension_instance_id: extensionInstance,
    profile_metadata: browserProfileMetadata(extensionInstance),
  };
}

async function extensionInstanceId(): Promise<string> {
  const existing = await chrome.storage.local.get<Record<string, unknown>>(INSTANCE_KEY);
  const value = existing[INSTANCE_KEY];
  if (typeof value === "string" && value.length > 0) return value;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTANCE_KEY]: id });
  return id;
}

function browserProfileMetadata(extensionInstance: string): {
  profileIdHash: string;
  profileRuntimeBinding: "webextension";
} {
  return {
    profileIdHash: `obu-${stablePublicHash(`${chrome.runtime.id ?? "unknown"}:${extensionInstance}`)}`,
    profileRuntimeBinding: "webextension",
  };
}

function stablePublicHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
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
  if (next.state === "error" || next.state === "cleanup_failed" || next.state === "version_mismatch") return "error";
  if (next.state === "disconnected" || next.state === "heartbeat_failed") return "warn";
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

export {};

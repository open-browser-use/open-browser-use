const HOST_NAME = "dev.obu.host";
const STATUS_KEY = "OBU_NATIVE_HOST_STATUS";
const INSTANCE_KEY = "OBU_EXTENSION_INSTANCE_ID";
const SESSION_STATE_KEY = "OBU_BROWSER_SESSION_STATE";
const DEBUG_LOG_KEY = "OBU_DEBUG_LOG";
const DEBUG_LOG_MAX_ENTRIES = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const HELLO_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_ALARM_NAME = "obu.reconnectNativeHost";
const CURSOR_ARRIVAL_TIMEOUT_MS = 750;
const CONTENT_PING_TIMEOUT_MS = 1_000;
const TAKEOVER_IDLE_TIMEOUT_MS = 2_000;
const CONTENT_SCRIPT_EVENT = "__OBU_CURSOR_MESSAGE__";

type HostStatus = {
  state: "disconnected" | "connecting" | "connected" | "version_mismatch" | "stopped" | "error";
  message?: string;
  diagnosis?: HostDiagnosis;
  hostVersion?: string;
  deliverableTabs?: number;
  retryDelayMs?: number;
  nextRetryAt?: number;
  updatedAt: number;
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

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

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
let nextId = 1;
let stopping = false;
let debugLog: DebugLogSnapshot = { enabled: false, entries: [] };
let debugLogSave: Promise<void> = Promise.resolve();
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const sessions = new Map<string, BrowserSession>();
const downloadOwnersByUrl = new Map<string, DownloadOwner>();
const downloadOwnersById = new Map<number, DownloadOwner>();
const debuggerAttachLocks = new Map<number, Promise<void>>();
let helloTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelayMs = RECONNECT_INITIAL_MS;

class OverlayCoordinator {
  private nextCursorSequence = 1;
  private cursorArrivalWaiters = new Map<number, CursorArrivalWaiter>();
  private takeoverIdleTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private contentScriptPreparations = new Map<number, Promise<boolean>>();

  async activate(tabId: number, sessionParams: SessionParams): Promise<void> {
    const sent = await this.sendContentMessage(tabId, {
      type: "OBU_TAKEOVER_STATE",
      active: true,
      lockInputs: true,
      sessionId: sessionParams.session_id,
      turnId: sessionParams.turn_id,
      reason: "browser-control",
    });
    if (sent) this.scheduleIdle(tabId);
  }

  async moveMouse(tabId: number, sessionParams: SessionParams, x: number, y: number): Promise<unknown> {
    const visible = await this.isTabVisible(tabId);
    if (!visible) return { visible: false };
    await this.activate(tabId, sessionParams);

    const sequence = this.nextCursorSequence++;
    const arrival = this.waitForArrival(tabId, sequence, sessionParams);
    const sent = await this.sendContentMessage(tabId, {
      type: "OBU_CURSOR_MOVE",
      x,
      y,
      sequence,
      sessionId: sessionParams.session_id,
      turnId: sessionParams.turn_id,
    });
    if (!sent) {
      this.cancelArrival(sequence, false);
      return { visible: false };
    }
    const arrived = await arrival;
    return { visible: true, arrived, sequence };
  }

  async sendCursorEvent(tabId: number, sessionParams: SessionParams, event: CursorVisualEvent): Promise<void> {
    const sent = await this.sendContentMessage(tabId, {
      type: "OBU_CURSOR_EVENT",
      kind: event.kind,
      x: event.x,
      y: event.y,
      button: event.button,
      sessionId: sessionParams.session_id,
      turnId: sessionParams.turn_id,
    });
    if (sent) this.scheduleIdle(tabId);
  }

  async allowCdpInput(tabId: number, sessionParams: SessionParams, bypass: CdpInputBypass): Promise<void> {
    await this.sendContentMessage(tabId, {
      type: "OBU_INPUT_BYPASS",
      durationMs: bypass.durationMs,
      sessionId: sessionParams.session_id,
      turnId: sessionParams.turn_id,
      reason: bypass.reason,
    });
  }

  handleCursorArrived(message: unknown): void {
    if (!isRecord(message) || typeof message.sequence !== "number") return;
    const waiter = this.cursorArrivalWaiters.get(message.sequence);
    if (!waiter) return;
    if (message.sessionId !== waiter.sessionId) return;
    if (message.turnId !== waiter.turnId) return;
    this.cursorArrivalWaiters.delete(message.sequence);
    clearTimeout(waiter.timer);
    waiter.resolve(true);
  }

  async hide(tabId: number): Promise<void> {
    this.clearIdle(tabId);
    this.rejectWaitersForTab(tabId);
    await this.sendContentMessage(tabId, { type: "OBU_CURSOR_HIDE" }, { prepare: false });
  }

  private async sendContentMessage(tabId: number, message: unknown, options: { prepare?: boolean } = {}): Promise<boolean> {
    if (options.prepare !== false && !await this.prepareContentScript(tabId)) return false;
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        args: [CONTENT_SCRIPT_EVENT, message],
        func: (eventName: string, payload: unknown) => {
          globalThis.dispatchEvent(new CustomEvent(eventName, { detail: payload }));
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  private async prepareContentScript(tabId: number): Promise<boolean> {
    if (await this.pingContentScript(tabId)) return true;
    let pending = this.contentScriptPreparations.get(tabId);
    if (!pending) {
      pending = this.injectContentScript(tabId).finally(() => {
        this.contentScriptPreparations.delete(tabId);
      });
      this.contentScriptPreparations.set(tabId, pending);
    }
    return await pending;
  }

  private async pingContentScript(tabId: number): Promise<boolean> {
    try {
      const response = await withTimeout(
        chrome.tabs.sendMessage(tabId, { type: "OBU_CONTENT_PING" }),
        CONTENT_PING_TIMEOUT_MS,
      );
      return isRecord(response) && response.ok === true;
    } catch {
      return false;
    }
  }

  private async injectContentScript(tabId: number): Promise<boolean> {
    try {
      await chrome.scripting.executeScript({
        files: ["cursor.js"],
        injectImmediately: true,
        target: { tabId, allFrames: true },
      });
    } catch {
      return false;
    }
    return await this.pingContentScript(tabId);
  }

  private async isTabVisible(tabId: number): Promise<boolean> {
    let tab: ChromeTab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return false;
    }
    if (tab.active !== true || typeof tab.windowId !== "number") return false;
    try {
      const windowInfo = await chrome.windows.get(tab.windowId);
      return windowInfo.type === "normal" && windowInfo.state !== "minimized";
    } catch {
      return false;
    }
  }

  private waitForArrival(tabId: number, sequence: number, sessionParams: SessionParams): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = scheduleTimer(() => {
        this.cursorArrivalWaiters.delete(sequence);
        resolve(false);
      }, CURSOR_ARRIVAL_TIMEOUT_MS);
      this.cursorArrivalWaiters.set(sequence, {
        tabId,
        sessionId: sessionParams.session_id,
        turnId: sessionParams.turn_id,
        timer,
        resolve,
      });
    });
  }

  private cancelArrival(sequence: number, value: boolean): void {
    const waiter = this.cursorArrivalWaiters.get(sequence);
    if (!waiter) return;
    this.cursorArrivalWaiters.delete(sequence);
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  }

  private scheduleIdle(tabId: number): void {
    this.clearIdle(tabId);
    this.takeoverIdleTimers.set(tabId, scheduleTimer(() => {
      this.takeoverIdleTimers.delete(tabId);
      void this.hide(tabId);
    }, TAKEOVER_IDLE_TIMEOUT_MS));
  }

  private clearIdle(tabId: number): void {
    const timer = this.takeoverIdleTimers.get(tabId);
    if (timer !== undefined) clearTimeout(timer);
    this.takeoverIdleTimers.delete(tabId);
  }

  private rejectWaitersForTab(tabId: number): void {
    for (const [sequence, waiter] of this.cursorArrivalWaiters) {
      if (waiter.tabId !== tabId) continue;
      this.cursorArrivalWaiters.delete(sequence);
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
  }
}

const overlayCoordinator = new OverlayCoordinator();

void bootstrapBackground();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM_NAME) return;
  if (canReconnect()) {
    reconnectTimer = undefined;
    void connectNative();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
    downloadOwnersByUrl.set(params.url, { sessionId: owner.sessionId, tabId });
  }
  sendNotification("onCDPEvent", {
    session_id: owner.sessionId,
    source: { tabId },
    method,
    params,
  });
});

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
  const owner = typeof item.url === "string" ? downloadOwnersByUrl.get(item.url) : undefined;
  if (!owner) return;
  appendDebugLog("debug", "download.created", { id: item.id, tabId: owner.tabId });
  if (typeof item.url === "string") downloadOwnersByUrl.delete(item.url);
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
  const state = item?.state ?? delta.state?.current;
  const status = state === "complete" ? "complete" : state === "interrupted" ? "failed" : undefined;
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
    const url = item?.url ?? delta.url?.current;
    if (typeof url === "string") downloadOwnersByUrl.delete(url);
  }
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
    rejectPending(message ?? "native host disconnected");
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
    return;
  }
  if (isRecord(message) && message.type === "version_mismatch") {
    clearHelloTimeout();
    clearHeartbeat();
    appendDebugLog("error", "native.version_mismatch", {
      message: typeof message.message === "string" ? message.message : "Version mismatch",
    });
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
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) {
      appendDebugLog("warn", "native.response.error", { id: message.id, message: message.error.message });
      waiter.reject(new Error(message.error.message));
    } else {
      appendDebugLog("debug", "native.response.ok", { id: message.id });
      waiter.resolve(message.result);
    }
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
    rejectPending("browser control stopped");
    port = null;
    await setStatus({ state: "stopped", message: "Stopped by user", updatedAt: Date.now() });
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
  if (!port) return Promise.reject(new Error("native host is not connected"));
  const id = nextId++;
  const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
  const targetPort = port;
  appendDebugLog("debug", "native.outbound.request", { id, method });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      targetPort?.postMessage(request);
    } catch (error) {
      pending.delete(id);
      appendDebugLog("error", "native.outbound.failed", { id, method, message: errorMessage(error) });
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function sendNotification(method: string, params?: unknown): void {
  appendDebugLog("debug", "native.outbound.notification", { method });
  port?.postMessage({ jsonrpc: "2.0", method, params } satisfies JsonRpcNotification);
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
  const url = isRecord(params) && typeof params.url === "string" ? params.url : undefined;
  const tab = await chrome.tabs.create({ url, active: true });
  const tabId = requireCreatedTabId(tab);
  const session = sessionFor(sessionParams.session_id);
  session.currentTurnId = sessionParams.turn_id;
  session.tabs.set(tabId, { tabId, origin: "agent", status: "active" });
  await addTabToSessionGroup(session, tabId);
  appendDebugLog("info", "tab.created", { sessionId: sessionParams.session_id, tabId });
  return tab;
}

async function getSessionTabs(sessionParams: SessionParams): Promise<SessionTabsResult> {
  const session = sessionFor(sessionParams.session_id);
  session.currentTurnId = sessionParams.turn_id;
  const rows: TabDto[] = [];
  const deliverableTabs: TabDto[] = [];
  let changed = false;
  for (const tabId of session.tabs.keys()) {
    try {
      rows.push(toTabDto(await chrome.tabs.get(tabId), session.tabs.get(tabId)));
    } catch {
      session.tabs.delete(tabId);
      changed = true;
    }
  }
  for (const [tabId, row] of session.finalizedTabs) {
    try {
      deliverableTabs.push(toTabDto(await chrome.tabs.get(tabId), row));
    } catch {
      session.finalizedTabs.delete(tabId);
      changed = true;
    }
  }
  if (changed) await persistSessionState();
  return { tabs: rows, deliverableTabs };
}

async function getUserTabs(sessionParams: SessionParams): Promise<TabDto[]> {
  const session = sessionFor(sessionParams.session_id);
  session.currentTurnId = sessionParams.turn_id;
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab) => Number.isInteger(tab.id) && isClaimableUserTab(tab))
    .filter((tab) => !ownedByAnotherSession(sessionParams.session_id, tab.id!))
    .map((tab) => toTabDto(tab, { tabId: tab.id!, origin: "user", status: "active" }));
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
  session.tabs.set(tabId, { tabId, origin: "user", status: "active" });
  await addTabToSessionGroup(session, tabId);
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
    if (keepStatus) row.status = keepStatus;
    if (row.origin === "agent" && !keepStatus) {
      await cleanupControlledTab(session, tabId);
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // Already closed tabs are removed from the registry below.
      }
      session.tabs.delete(tabId);
      session.finalizedTabs.delete(tabId);
      closedTabIds.push(tabId);
      continue;
    }
    if (row.origin === "user" && !keepStatus) {
      await cleanupControlledTab(session, tabId);
      await releaseTabFromSessionGroup(tabId);
      session.tabs.delete(tabId);
      session.finalizedTabs.delete(tabId);
      releasedTabIds.push(tabId);
      continue;
    }
    try {
      if (keepStatus === "deliverable") {
        await cleanupControlledTab(session, tabId);
        await moveTabToDeliverableGroup(session, tabId);
        const dto = toTabDto(await chrome.tabs.get(tabId), row);
        session.tabs.delete(tabId);
        session.finalizedTabs.set(tabId, { ...row });
        keptTabs.push(dto);
        deliverableTabs.push(dto);
      } else {
        keptTabs.push(toTabDto(await chrome.tabs.get(tabId), row));
      }
    } catch {
      session.tabs.delete(tabId);
      session.attachedTabIds.delete(tabId);
    }
  }
  if (session.tabs.size === 0) session.groupId = undefined;
  await persistSessionState();
  appendDebugLog("info", "tabs.finalized", {
    sessionId: sessionParams.session_id,
    closed: closedTabIds.length,
    released: releasedTabIds.length,
    kept: keptTabs.length,
    deliverable: deliverableTabs.length,
  });

  return { closedTabIds, releasedTabIds, keptTabs, deliverableTabs };
}

async function nameSession(sessionParams: SessionParams, params: unknown): Promise<void> {
  const session = sessionFor(sessionParams.session_id);
  session.currentTurnId = sessionParams.turn_id;
  const label = isRecord(params) && typeof params.label === "string" ? params.label : undefined;
  session.label = label;
  if (label && session.groupId !== undefined) {
    await chrome.tabGroups.update(session.groupId, { title: label, color: "blue" });
  }
  await persistSessionState();
}

async function markTurnEnded(sessionParams: SessionParams): Promise<void> {
  const session = sessionFor(sessionParams.session_id);
  session.currentTurnId = sessionParams.turn_id;
  await hideSessionTakeover(session);
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
  requireSessionTab(params);
  await ensureDebuggerAttached(session, tabId);
  if (!isRecord(params) || typeof params.method !== "string") {
    throw new Error("executeCdp requires method");
  }
  const method = params.method;
  const timeoutMs = timeoutMsFromParams(params);
  const sessionParams = requireSessionParams(params);
  appendDebugLog("debug", "cdp.execute", { method, tabId, timeoutMs });
  await overlayCoordinator.activate(tabId, sessionParams);
  const inputBypass = inputBypassFromCdp(params);
  if (inputBypass) {
    await overlayCoordinator.allowCdpInput(tabId, sessionParams, inputBypass);
  }
  const cursorEvent = cursorEventFromCdp(params);
  if (cursorEvent?.kind === "press") {
    await overlayCoordinator.sendCursorEvent(tabId, sessionParams, cursorEvent);
  }
  const result = await withTimeout(
    chrome.debugger.sendCommand({ tabId }, method, params.commandParams),
    timeoutMs,
    `executeCdp ${method} timed out after ${timeoutMs}ms`,
  );
  if (cursorEvent && cursorEvent.kind !== "press") {
    await overlayCoordinator.sendCursorEvent(tabId, sessionParams, cursorEvent);
    if (cursorEvent.kind === "release" && cursorEvent.clickCount > 0) {
      await overlayCoordinator.sendCursorEvent(tabId, sessionParams, { ...cursorEvent, kind: "click" });
    }
  }
  return result;
}

async function moveMouse(params: unknown): Promise<unknown> {
  const tabId = requireTabId(params);
  const sessionParams = requireSessionParams(params);
  requireSessionTab(params);
  const x = requiredNumber(params, "x");
  const y = requiredNumber(params, "y");
  const result = await overlayCoordinator.moveMouse(tabId, sessionParams, x, y);
  appendDebugLog("debug", "cursor.move", { tabId, result });
  return result;
}

function inputBypassFromCdp(params: Record<string, unknown>): CdpInputBypass | undefined {
  if (params.method === "Input.dispatchMouseEvent") {
    return { durationMs: 600, reason: "cdp-mouse" };
  }
  if (params.method === "Input.dispatchTouchEvent") {
    return { durationMs: 600, reason: "cdp-touch" };
  }
  if (params.method === "Input.dispatchKeyEvent" || params.method === "Input.insertText") {
    return { durationMs: 600, reason: "cdp-keyboard" };
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
  const session = requireSession(params);
  const row = session.tabs.get(tabId);
  if (!row) throw new Error(`tab ${tabId} is not owned by this open-browser-use session`);
  return row;
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
    session = { currentTurnId: "", tabs: new Map(), finalizedTabs: new Map(), attachedTabIds: new Set() };
    sessions.set(sessionId, session);
  }
  return session;
}

function toTabDto(tab: ChromeTab, row?: SessionTab): TabDto {
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
  };
}

async function addTabToSessionGroup(session: BrowserSession, tabId: number): Promise<void> {
  const groupId = await groupTab(tabId, session.groupId);
  session.groupId = groupId;
  if (session.label) {
    await chrome.tabGroups.update(groupId, { title: session.label, color: "blue" });
  }
}

async function moveTabToDeliverableGroup(session: BrowserSession, tabId: number): Promise<void> {
  await releaseTabFromSessionGroup(tabId);
  const groupId = await groupTab(tabId, session.deliverableGroupId);
  session.deliverableGroupId = groupId;
  const title = session.label ? `${session.label} Deliverables` : "open-browser-use Deliverables";
  await chrome.tabGroups.update(groupId, { title, color: "green" });
}

async function groupTab(tabId: number, groupId: number | undefined): Promise<number> {
  const options = groupId === undefined ? { tabIds: tabId } : { tabIds: tabId, groupId };
  try {
    return await chrome.tabs.group(options);
  } catch (error) {
    if (groupId === undefined) throw error;
    return await chrome.tabs.group({ tabIds: tabId });
  }
}

async function releaseTabFromSessionGroup(tabId: number): Promise<void> {
  try {
    await chrome.tabs.ungroup(tabId);
  } catch {
    // The tab may already be ungrouped or closed.
  }
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
  const controlledTabIds = new Set<number>();
  for (const session of sessions.values()) {
    for (const tabId of session.tabs.keys()) controlledTabIds.add(tabId);
    for (const tabId of session.attachedTabIds) controlledTabIds.add(tabId);
  }
  for (const tabId of controlledTabIds) {
    await hideCursor(tabId);
  }
  for (const session of sessions.values()) {
    for (const tabId of [...session.attachedTabIds]) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // Ignore detach races; Stop is best-effort cleanup before disconnecting.
      }
    }
  }
  sessions.clear();
  await persistSessionState();
}

async function hideCursor(tabId: number): Promise<void> {
  await overlayCoordinator.hide(tabId);
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
  return statusWithDeliverables(status);
}

function statusWithDeliverables(current: HostStatus): HostStatus {
  const deliverableTabs = countDeliverableTabs();
  if (deliverableTabs === 0) return current;
  return { ...current, deliverableTabs };
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

async function bootstrapBackground(): Promise<void> {
  await restoreDebugLogs();
  appendDebugLog("info", "background.bootstrap");
  await restoreSessionState();
  await bootstrapNativeConnection();
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

async function restoreSessionState(): Promise<void> {
  const stored = await chrome.storage.local.get<Record<string, unknown>>(SESSION_STATE_KEY);
  const state = stored[SESSION_STATE_KEY];
  if (!isRecord(state) || state.version !== 1 || !Array.isArray(state.sessions)) return;

  let changed = false;
  for (const row of state.sessions) {
    if (!isRecord(row) || typeof row.session_id !== "string" || !Array.isArray(row.tabs)) {
      changed = true;
      continue;
    }
    let session: BrowserSession | undefined;
    for (const tabRow of row.tabs) {
      const durableTab = parseDurableSessionTab(tabRow);
      if (!durableTab) {
        changed = true;
        continue;
      }
      let tab: ChromeTab;
      try {
        tab = await chrome.tabs.get(durableTab.tabId);
      } catch {
        changed = true;
        continue;
      }
      session ??= sessionFor(row.session_id);
      session.label = typeof row.label === "string" ? row.label : undefined;
      if (durableTab.status === "handoff") {
        session.tabs.set(durableTab.tabId, durableTab);
        if (isUsableGroupId(tab.groupId)) session.groupId ??= tab.groupId;
      } else {
        session.finalizedTabs.set(durableTab.tabId, durableTab);
        if (isUsableGroupId(tab.groupId)) session.deliverableGroupId ??= tab.groupId;
      }
    }
  }
  if (changed) await persistSessionState();
}

async function persistSessionState(): Promise<void> {
  const sessionRows: PersistedBrowserSession[] = [];
  for (const [sessionId, session] of [...sessions].sort(([a], [b]) => a.localeCompare(b))) {
    const tabs = durableSessionTabs(session).sort((a, b) => a.tabId - b.tabId);
    if (tabs.length === 0) continue;
    sessionRows.push({
      session_id: sessionId,
      label: session.label,
      groupId: session.groupId,
      deliverableGroupId: session.deliverableGroupId,
      tabs,
    });
  }
  await chrome.storage.local.set({
    [SESSION_STATE_KEY]: {
      version: 1,
      sessions: sessionRows,
    } satisfies PersistedBrowserSessionState,
  });
}

function durableSessionTabs(session: BrowserSession): PersistedSessionTab[] {
  const rows: PersistedSessionTab[] = [];
  for (const row of session.tabs.values()) {
    if (row.status === "handoff" || row.status === "deliverable") {
      rows.push({ tabId: row.tabId, origin: row.origin, status: row.status });
    }
  }
  for (const row of session.finalizedTabs.values()) {
    if (row.status === "handoff" || row.status === "deliverable") {
      rows.push({ tabId: row.tabId, origin: row.origin, status: row.status });
    }
  }
  return rows;
}

function parseDurableSessionTab(value: unknown): SessionTab | undefined {
  if (!isRecord(value)) return undefined;
  const tabId = value.tabId;
  const origin = value.origin;
  const status = value.status;
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) return undefined;
  if (origin !== "agent" && origin !== "user") return undefined;
  if (status !== "handoff" && status !== "deliverable") return undefined;
  return { tabId, origin, status };
}

function isUsableGroupId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
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
  status = next;
  appendDebugLog(statusLogLevel(next), "status.changed", {
    state: next.state,
    diagnosis: next.diagnosis,
    message: next.message,
    retryDelayMs: next.retryDelayMs,
  });
  await chrome.storage.local.set({ [STATUS_KEY]: next });
}

async function extensionInstanceId(): Promise<string> {
  const existing = await chrome.storage.local.get<Record<string, unknown>>(INSTANCE_KEY);
  const value = existing[INSTANCE_KEY];
  if (typeof value === "string" && value.length > 0) return value;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTANCE_KEY]: id });
  return id;
}

function rejectPending(message: string): void {
  if (pending.size > 0) appendDebugLog("warn", "native.pending.rejected", { count: pending.size, message });
  for (const waiter of pending.values()) waiter.reject(new Error(message));
  pending.clear();
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
      (error) => {
        const message = errorMessage(error);
        appendDebugLog("warn", "native.heartbeat.failed", { message });
        const failedPort = port;
        port = null;
        failedPort?.disconnect();
        rejectPending(message);
        void setStatus({
          state: "disconnected",
          message,
          diagnosis: message === "native host heartbeat timed out"
            ? "native_host_heartbeat_timeout"
            : diagnoseNativeHostFailure(message, "native_host_disconnected"),
          updatedAt: Date.now(),
        });
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

type SessionParams = {
  session_id: string;
  turn_id: string;
};

type CursorArrivalWaiter = {
  tabId: number;
  sessionId: string;
  turnId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: boolean): void;
};

type CursorVisualEvent = {
  kind: "press" | "release" | "click";
  x?: number;
  y?: number;
  button?: string;
  clickCount: number;
};

type CdpInputBypass = {
  durationMs: number;
  reason: string;
};

type BrowserSession = {
  currentTurnId: string;
  tabs: Map<number, SessionTab>;
  finalizedTabs: Map<number, SessionTab>;
  attachedTabIds: Set<number>;
  groupId?: number;
  deliverableGroupId?: number;
  label?: string;
};

type SessionTab = {
  tabId: number;
  origin: "agent" | "user";
  status: "active" | "handoff" | "deliverable";
};

type TabDto = {
  tabId: number;
  windowId?: number;
  groupId?: number;
  url?: string;
  title?: string;
  active?: boolean;
  pinned?: boolean;
  origin: "agent" | "user";
  status: "active" | "handoff" | "deliverable";
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
};

type PersistedBrowserSessionState = {
  version: 1;
  sessions: PersistedBrowserSession[];
};

type PersistedBrowserSession = {
  session_id: string;
  label?: string;
  groupId?: number;
  deliverableGroupId?: number;
  tabs: PersistedSessionTab[];
};

type PersistedSessionTab = {
  tabId: number;
  origin: "agent" | "user";
  status: "handoff" | "deliverable";
};

export {};

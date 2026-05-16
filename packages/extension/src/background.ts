const HOST_NAME = "dev.obu.host";
const STATUS_KEY = "OBU_NATIVE_HOST_STATUS";
const INSTANCE_KEY = "OBU_EXTENSION_INSTANCE_ID";
const SESSION_STATE_KEY = "OBU_BROWSER_SESSION_STATE";
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

let status: HostStatus = { state: "disconnected", updatedAt: Date.now() };
let port: NativePort | null = null;
let nextId = 1;
let stopping = false;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const sessions = new Map<string, BrowserSession>();
const downloadOwnersByUrl = new Map<string, DownloadOwner>();
const downloadOwnersById = new Map<number, DownloadOwner>();
const debuggerAttachLocks = new Map<number, Promise<void>>();
let helloTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelayMs = RECONNECT_INITIAL_MS;

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
    sendResponse({ error: "unknown message" });
  })();
  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!Number.isInteger(tabId)) return;
  const owner = findSessionForTab(tabId!);
  if (!owner || !owner.session.attachedTabIds.has(tabId!)) return;
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
  await setStatus({ state: "connecting", updatedAt: Date.now() });
  let targetPort: NativePort;
  try {
    targetPort = chrome.runtime.connectNative(HOST_NAME);
    port = targetPort;
  } catch (error) {
    const message = errorMessage(error);
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
    await handleHostRequest(message, sourcePort);
    return;
  }
  if (isJsonRpcResponse(message)) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(message.error.message));
    } else {
      waiter.resolve(message.result);
    }
  }
}

async function stopBrowserControl(): Promise<void> {
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
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      targetPort?.postMessage(request);
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function sendNotification(method: string, params?: unknown): void {
  port?.postMessage({ jsonrpc: "2.0", method, params } satisfies JsonRpcNotification);
}

async function handleHostRequest(request: JsonRpcRequest, sourcePort: NativePort): Promise<void> {
  try {
    const result = await dispatchHostRequest(request.method, request.params);
    if (port === sourcePort) {
      sourcePort.postMessage({ jsonrpc: "2.0", id: request.id, result } satisfies JsonRpcResponse);
    }
  } catch (error) {
    if (port === sourcePort) {
      sourcePort.postMessage({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: errorMessage(error) },
      } satisfies JsonRpcResponse);
    }
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
      markTurnEnded(requireSessionParams(params));
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
  return tab;
}

async function finalizeTabs(sessionParams: SessionParams, params: unknown): Promise<FinalizeTabsResult> {
  const session = sessionFor(sessionParams.session_id);
  session.currentTurnId = sessionParams.turn_id;
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

function markTurnEnded(sessionParams: SessionParams): void {
  sessionFor(sessionParams.session_id).currentTurnId = sessionParams.turn_id;
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
  return await withTimeout(
    chrome.debugger.sendCommand({ tabId }, method, params.commandParams),
    timeoutMs,
    `executeCdp ${method} timed out after ${timeoutMs}ms`,
  );
}

async function moveMouse(params: unknown): Promise<unknown> {
  const tabId = requireTabId(params);
  requireSessionTab(params);
  const x = requiredNumber(params, "x");
  const y = requiredNumber(params, "y");
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) return { visible: false };
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "OBU_CURSOR_MOVE",
      x,
      y,
      sequence: isRecord(params) && typeof params.sequence === "number" ? params.sequence : undefined,
    });
    return { visible: true };
  } catch (error) {
    return { visible: false, error: errorMessage(error) };
  }
}

async function attachDebugger(params: unknown): Promise<void> {
  const tabId = requireTabId(params);
  const session = requireSession(params);
  requireSessionTab(params);
  await ensureDebuggerAttached(session, tabId);
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
  try {
    await chrome.tabs.sendMessage(tabId, { type: "OBU_CURSOR_HIDE" });
  } catch {
    // Content scripts may be absent or the tab may already be gone.
  }
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

const HOST_NAME = "dev.obu.host";
const STATUS_KEY = "OBU_NATIVE_HOST_STATUS";
const INSTANCE_KEY = "OBU_EXTENSION_INSTANCE_ID";
const SESSION_STATE_KEY = "OBU_BROWSER_SESSION_STATE";
const TAB_GROUP_STATE_KEY = "OBU_TAB_GROUP_STATE";
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
const CURSOR_ARRIVAL_TIMEOUT_MS = 750;
const CONTENT_PING_TIMEOUT_MS = 1_000;
const CONTENT_SCRIPT_HANDLER = "__OBU_CURSOR_CONTENT_SCRIPT_HANDLE_MESSAGE__";
const DEFAULT_SESSION_GROUP_TITLE = "Open Browser Use";
const DEFAULT_SESSION_GROUP_COLOR: TabGroupColor = "blue";
const DELIVERABLE_GROUP_TITLE = "Open Browser Use Deliverables";
const DELIVERABLE_GROUP_COLOR: TabGroupColor = "green";
const GROUP_EXPANDED = false;
const MAX_GROUP_TITLE_LENGTH = 80;

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
const downloadOwnersByUrl = new Map<string, DownloadOwner[]>();
const downloadOwnersById = new Map<number, DownloadOwner>();
const debuggerAttachLocks = new Map<number, Promise<void>>();
const pendingDialogAwareCloses = new Map<number, PendingDialogAwareClose>();
let helloTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelayMs = RECONNECT_INITIAL_MS;
let pendingExtensionUpdate: PendingExtensionUpdate | undefined;

class OverlayCoordinator {
  private nextCursorSequence = 1;
  private nextCaptureSuppression = 1;
  private cursorArrivalWaiters = new Map<number, CursorArrivalWaiter>();
  private activeTakeovers = new Map<number, ActiveTakeover>();
  private contentScriptPreparations = new Map<number, Promise<boolean>>();

  async activate(tabId: number, sessionParams: SessionParams): Promise<void> {
    const previous = this.activeTakeovers.get(tabId);
    const state: ActiveTakeover = {
      sessionId: sessionParams.session_id,
      turnId: sessionParams.turn_id,
      lockInputs: true,
      lastCursor: previous?.lastCursor,
    };
    this.activeTakeovers.set(tabId, state);
    await this.sendTakeoverState(tabId, state);
  }

  async reassert(tabId: number): Promise<void> {
    const state = this.activeTakeovers.get(tabId);
    if (!state) return;
    if (!await this.sendTakeoverState(tabId, state)) return;
    if (!state.lastCursor) return;
    await this.sendContentMessage(tabId, {
      type: "OBU_CURSOR_MOVE",
      x: state.lastCursor.x,
      y: state.lastCursor.y,
      sequence: state.lastCursor.sequence,
      sessionId: state.sessionId,
      turnId: state.turnId,
    });
  }

  forget(tabId: number): void {
    this.activeTakeovers.delete(tabId);
    this.rejectWaitersForTab(tabId);
  }

  activeTabIds(): number[] {
    return [...this.activeTakeovers.keys()];
  }

  hasPendingActivity(): boolean {
    return this.cursorArrivalWaiters.size > 0 || this.contentScriptPreparations.size > 0;
  }

  private async sendTakeoverState(tabId: number, state: ActiveTakeover): Promise<boolean> {
    return await this.sendContentMessage(tabId, {
      type: "OBU_TAKEOVER_STATE",
      active: true,
      lockInputs: state.lockInputs,
      sessionId: state.sessionId,
      turnId: state.turnId,
      reason: "browser-control",
    });
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
    this.rememberCursorTarget(tabId, { x, y, sequence });
    const arrived = await arrival;
    return { visible: true, arrived, sequence };
  }

  async sendCursorEvent(tabId: number, sessionParams: SessionParams, event: CursorVisualEvent): Promise<void> {
    await this.sendContentMessage(tabId, {
      type: "OBU_CURSOR_EVENT",
      kind: event.kind,
      x: event.x,
      y: event.y,
      button: event.button,
      sessionId: sessionParams.session_id,
      turnId: sessionParams.turn_id,
    });
  }

  async allowCdpInput(tabId: number, sessionParams: SessionParams, bypass: CdpInputBypass): Promise<void> {
    await this.sendContentMessage(tabId, {
      type: "OBU_INPUT_BYPASS",
      durationMs: bypass.durationMs,
      eventFamilies: bypass.eventFamilies,
      sessionId: sessionParams.session_id,
      turnId: sessionParams.turn_id,
      reason: bypass.reason,
    });
  }

  async withCaptureSuppressed<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const token = `capture-${Date.now()}-${this.nextCaptureSuppression++}`;
    const suppressed = await this.sendContentMessage(tabId, {
      type: "OBU_CAPTURE_SUPPRESSION",
      active: true,
      token,
    });
    try {
      return await operation();
    } finally {
      if (suppressed) {
        await this.sendContentMessage(tabId, {
          type: "OBU_CAPTURE_SUPPRESSION",
          active: false,
          token,
        });
      }
    }
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
    void maybeApplyPendingExtensionUpdate("cursor_arrived");
  }

  async hide(tabId: number): Promise<void> {
    this.activeTakeovers.delete(tabId);
    this.rejectWaitersForTab(tabId);
    await this.sendContentMessage(tabId, { type: "OBU_CURSOR_HIDE" }, { prepare: false });
  }

  private async sendContentMessage(tabId: number, message: unknown, options: { prepare?: boolean } = {}): Promise<boolean> {
    if (options.prepare !== false && !await this.prepareContentScript(tabId)) return false;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "ISOLATED",
        args: [CONTENT_SCRIPT_HANDLER, message],
        func: (handlerName: string, payload: unknown) => {
          const handler = (globalThis as Record<string, unknown>)[handlerName];
          if (typeof handler !== "function") return false;
          handler(payload);
          return true;
        },
      });
      return results.some((result) => result.result === true);
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
        void maybeApplyPendingExtensionUpdate("content_script_prepared");
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
        world: "ISOLATED",
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
        void maybeApplyPendingExtensionUpdate("cursor_arrival_timeout");
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
    void maybeApplyPendingExtensionUpdate("cursor_arrival_cancelled");
  }

  private rememberCursorTarget(tabId: number, target: CursorTarget): void {
    const state = this.activeTakeovers.get(tabId);
    if (!state) return;
    state.lastCursor = target;
  }

  private rejectWaitersForTab(tabId: number): void {
    for (const [sequence, waiter] of this.cursorArrivalWaiters) {
      if (waiter.tabId !== tabId) continue;
      this.cursorArrivalWaiters.delete(sequence);
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    void maybeApplyPendingExtensionUpdate("cursor_waiters_rejected");
  }
}

class TabGroupManager {
  private state: TabGroupState = emptyTabGroupState();
  private loadPromise: Promise<void> | undefined;
  private reconcilingGroupIds = new Set<number>();

  async load(): Promise<void> {
    await this.ensureLoaded();
  }

  async ensureSessionGroup(
    sessionId: string,
    windowId: number,
    tabId: number,
    origin: TabOrigin,
    label?: string,
  ): Promise<number> {
    await this.ensureLoaded();
    const windowKey = String(windowId);
    const previousGroupId = this.state.sessionGroupsBySessionIdAndWindowId[sessionId]?.[windowKey];
    const groupId = await groupTab(tabId, previousGroupId);
    this.deleteReplacedGroup(previousGroupId, groupId);
    this.removeTabFromManagedGroups(tabId, groupId);

    const now = Date.now();
    const title = sessionGroupTitle(label);
    const group = this.ensureManagedGroup(groupId, () => ({
      groupId,
      kind: "session",
      windowId,
      sessionId,
      title,
      color: DEFAULT_SESSION_GROUP_COLOR,
      tabs: {},
      createdAt: now,
      updatedAt: now,
    }));
    group.kind = "session";
    group.windowId = windowId;
    group.sessionId = sessionId;
    group.title = title;
    group.color = DEFAULT_SESSION_GROUP_COLOR;
    group.tabs[String(tabId)] = { origin, status: "active" };
    group.updatedAt = now;
    this.setSessionGroupIndex(sessionId, windowId, groupId);
    await this.reconcileGroup(group);
    await this.persist();
    return groupId;
  }

  async restoreDurableTab(
    sessionId: string,
    session: BrowserSession,
    tab: ChromeTab,
    row: SessionTab,
  ): Promise<void> {
    const windowId = requireTabWindowId(tab);
    if (row.status === "deliverable") {
      session.deliverableGroupId = await this.moveTabToDeliverableGroup(sessionId, row.tabId, row.origin);
      return;
    }
    session.groupId = await this.ensureSessionGroup(sessionId, windowId, row.tabId, row.origin, session.label);
    await this.setManagedTabStatus(row.tabId, "handoff");
  }

  async renameSession(sessionId: string, label?: string): Promise<void> {
    await this.ensureLoaded();
    let changed = false;
    const title = sessionGroupTitle(label);
    const groupIds = Object.values(this.state.sessionGroupsBySessionIdAndWindowId[sessionId] ?? {});
    for (const groupId of groupIds) {
      const group = this.groupById(groupId);
      if (!group) continue;
      group.title = title;
      group.updatedAt = Date.now();
      await this.reconcileGroup(group);
      changed = true;
    }
    if (changed) await this.persist();
  }

  async setManagedTabStatus(tabId: number, status: TabStatus): Promise<void> {
    await this.ensureLoaded();
    let changed = false;
    for (const group of this.state.groups) {
      const managed = group.tabs[String(tabId)];
      if (!managed) continue;
      managed.status = status;
      group.updatedAt = Date.now();
      changed = true;
    }
    if (changed) await this.persist();
  }

  async moveTabToDeliverableGroup(sessionId: string, tabId: number, origin: TabOrigin): Promise<number> {
    const tab = await chrome.tabs.get(tabId);
    const windowId = requireTabWindowId(tab);
    await this.ensureLoaded();
    const windowKey = String(windowId);
    const previousGroupId = this.state.deliverableGroupsByWindowId[windowKey];
    const groupId = await groupTab(tabId, previousGroupId);
    this.deleteReplacedGroup(previousGroupId, groupId);
    this.removeTabFromManagedGroups(tabId, groupId);

    const now = Date.now();
    const group = this.ensureManagedGroup(groupId, () => ({
      groupId,
      kind: "deliverable",
      windowId,
      title: DELIVERABLE_GROUP_TITLE,
      color: DELIVERABLE_GROUP_COLOR,
      tabs: {},
      createdAt: now,
      updatedAt: now,
    }));
    group.kind = "deliverable";
    group.windowId = windowId;
    delete group.sessionId;
    group.title = DELIVERABLE_GROUP_TITLE;
    group.color = DELIVERABLE_GROUP_COLOR;
    group.tabs[String(tabId)] = { origin, status: "deliverable" };
    group.updatedAt = now;
    this.state.deliverableGroupsByWindowId[windowKey] = groupId;
    await this.reconcileGroup(group);
    await this.persist();
    appendDebugLog("info", "tab_group.deliverable", { sessionId, tabId, groupId, windowId });
    return groupId;
  }

  async releaseManagedTab(tabId: number): Promise<void> {
    await this.ensureLoaded();
    await releaseTabFromSessionGroup(tabId);
    if (this.removeTabFromManagedGroups(tabId)) await this.persist();
  }

  async removeManagedTab(tabId: number): Promise<void> {
    await this.ensureLoaded();
    if (this.removeTabFromManagedGroups(tabId)) await this.persist();
  }

  async reconcileGroupId(groupId: number): Promise<void> {
    await this.ensureLoaded();
    const group = this.groupById(groupId);
    if (!group || this.reconcilingGroupIds.has(groupId)) return;
    await this.reconcileGroup(group);
  }

  async reconcileAllGroupPresentations(): Promise<void> {
    await this.ensureLoaded();
    for (const group of [...this.state.groups]) {
      await this.reconcileGroup(group);
    }
  }

  async bootstrapCleanup(): Promise<void> {
    await this.ensureLoaded();
    let changed = false;
    for (const group of [...this.state.groups]) {
      let chromeGroup: ChromeTabGroup;
      try {
        chromeGroup = await chrome.tabGroups.get(group.groupId);
      } catch {
        this.deleteGroup(group);
        changed = true;
        continue;
      }
      if (typeof chromeGroup.windowId === "number" && chromeGroup.windowId !== group.windowId) {
        group.windowId = chromeGroup.windowId;
        changed = true;
      }
      for (const tabKey of Object.keys(group.tabs)) {
        const managedTab = group.tabs[tabKey];
        const tabId = Number(tabKey);
        if (!Number.isInteger(tabId)) {
          delete group.tabs[tabKey];
          changed = true;
          continue;
        }
        let tab: ChromeTab;
        try {
          tab = await chrome.tabs.get(tabId);
        } catch {
          delete group.tabs[tabKey];
          changed = true;
          continue;
        }
        if (tab.groupId !== group.groupId) {
          delete group.tabs[tabKey];
          changed = true;
          continue;
        }
        // Active sessions are memory-only; after a service worker restart, these rows are stale.
        if (managedTab.status === "active") {
          await releaseTabFromSessionGroup(tabId);
          delete group.tabs[tabKey];
          changed = true;
        }
      }
      if (Object.keys(group.tabs).length === 0) {
        await this.ungroupRemainingTabs(group.groupId);
        this.deleteGroup(group);
        changed = true;
        continue;
      }
      await this.reconcileGroup(group);
    }
    if (changed) {
      this.rebuildIndexes();
      await this.persist();
    }
  }

  groupIdForTab(tabId: number): number | undefined {
    for (const group of this.state.groups) {
      if (group.tabs[String(tabId)]) return group.groupId;
    }
    return undefined;
  }

  private async ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.loadFromStorage();
    await this.loadPromise;
  }

  private async loadFromStorage(): Promise<void> {
    try {
      const stored = await chrome.storage.local.get<Record<string, unknown>>(TAB_GROUP_STATE_KEY);
      this.state = parseTabGroupState(stored[TAB_GROUP_STATE_KEY]) ?? emptyTabGroupState();
    } catch {
      this.state = emptyTabGroupState();
    }
  }

  private async persist(): Promise<void> {
    await chrome.storage.local.set({ [TAB_GROUP_STATE_KEY]: this.state });
  }

  private async reconcileGroup(group: ManagedTabGroup): Promise<void> {
    if (this.reconcilingGroupIds.has(group.groupId)) return;
    this.reconcilingGroupIds.add(group.groupId);
    try {
      const current = await chrome.tabGroups.get(group.groupId);
      if (
        current.title === group.title &&
        current.color === group.color &&
        current.collapsed === GROUP_EXPANDED
      ) {
        return;
      }
      await chrome.tabGroups.update(group.groupId, {
        title: group.title,
        color: group.color,
        collapsed: GROUP_EXPANDED,
      });
    } catch {
      this.deleteGroup(group);
      await this.persist();
    } finally {
      this.reconcilingGroupIds.delete(group.groupId);
    }
  }

  private async ungroupRemainingTabs(groupId: number): Promise<void> {
    let tabs: ChromeTab[];
    try {
      tabs = await chrome.tabs.query({ groupId });
    } catch {
      return;
    }
    for (const tab of tabs) {
      if (!Number.isInteger(tab.id)) continue;
      await releaseTabFromSessionGroup(tab.id!);
    }
  }

  private groupById(groupId: number): ManagedTabGroup | undefined {
    return this.state.groups.find((group) => group.groupId === groupId);
  }

  private ensureManagedGroup(groupId: number, create: () => ManagedTabGroup): ManagedTabGroup {
    const existing = this.groupById(groupId);
    if (existing) return existing;
    const group = create();
    this.state.groups.push(group);
    return group;
  }

  private deleteReplacedGroup(previousGroupId: number | undefined, groupId: number): void {
    if (previousGroupId === undefined || previousGroupId === groupId) return;
    this.deleteGroupById(previousGroupId);
  }

  private setSessionGroupIndex(sessionId: string, windowId: number, groupId: number): void {
    this.state.sessionGroupsBySessionIdAndWindowId[sessionId] ??= {};
    this.state.sessionGroupsBySessionIdAndWindowId[sessionId]![String(windowId)] = groupId;
  }

  private removeTabFromManagedGroups(tabId: number, keepGroupId?: number): boolean {
    let changed = false;
    const tabKey = String(tabId);
    for (const group of [...this.state.groups]) {
      if (group.groupId === keepGroupId) continue;
      if (!group.tabs[tabKey]) continue;
      delete group.tabs[tabKey];
      group.updatedAt = Date.now();
      changed = true;
      if (Object.keys(group.tabs).length === 0) this.deleteGroup(group);
    }
    if (changed) this.rebuildIndexes();
    return changed;
  }

  private deleteGroupById(groupId: number): void {
    const group = this.groupById(groupId);
    if (group) this.deleteGroup(group);
  }

  private deleteGroup(group: ManagedTabGroup): void {
    this.state.groups = this.state.groups.filter((candidate) => candidate.groupId !== group.groupId);
    if (group.kind === "session" && group.sessionId) {
      const windowGroups = this.state.sessionGroupsBySessionIdAndWindowId[group.sessionId];
      if (windowGroups) {
        delete windowGroups[String(group.windowId)];
        if (Object.keys(windowGroups).length === 0) {
          delete this.state.sessionGroupsBySessionIdAndWindowId[group.sessionId];
        }
      }
    } else if (group.kind === "deliverable") {
      delete this.state.deliverableGroupsByWindowId[String(group.windowId)];
    }
  }

  private rebuildIndexes(): void {
    this.state.sessionGroupsBySessionIdAndWindowId = {};
    this.state.deliverableGroupsByWindowId = {};
    for (const group of this.state.groups) {
      if (group.kind === "session" && group.sessionId) {
        this.setSessionGroupIndex(group.sessionId, group.windowId, group.groupId);
      } else if (group.kind === "deliverable") {
        this.state.deliverableGroupsByWindowId[String(group.windowId)] = group.groupId;
      }
    }
  }
}

const overlayCoordinator = new OverlayCoordinator();
const tabGroupManager = new TabGroupManager();

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
    void maybeApplyPendingExtensionUpdate("native_hello_ack");
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
    void maybeApplyPendingExtensionUpdate("control_stopped");
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
  const url = isRecord(params) && typeof params.url === "string" ? params.url : "about:blank";
  const tab = await chrome.tabs.create({ url, active: true });
  const tabId = requireCreatedTabId(tab);
  const session = sessionFor(sessionParams.session_id);
  session.currentTurnId = sessionParams.turn_id;
  session.tabs.set(tabId, { tabId, origin: "agent", status: "active" });
  await addTabToSessionGroup(sessionParams.session_id, session, tabId, "agent");
  await overlayCoordinator.activate(tabId, sessionParams);
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
  if (changed) syncSessionGroupMirrors(session);
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
  await addTabToSessionGroup(sessionParams.session_id, session, tabId, "user");
  for (const managedSession of sessions.values()) syncSessionGroupMirrors(managedSession);
  await overlayCoordinator.activate(tabId, sessionParams);
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
  await persistSessionState();
  appendDebugLog("info", "tabs.finalized", {
    sessionId: sessionParams.session_id,
    closed: closedTabIds.length,
    released: releasedTabIds.length,
    kept: keptTabs.length,
    deliverable: deliverableTabs.length,
  });
  void maybeApplyPendingExtensionUpdate("tabs_finalized");

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
  const suppressAgentOverlayForCapture = params.suppressAgentOverlayForCapture === true && method === "Page.captureScreenshot";
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
  const session = requireSession(params);
  const row = session.tabs.get(tabId);
  if (!row) throw new Error(`tab ${tabId} is not owned by this open-browser-use session`);
  if (row.status !== "active") throw new Error(`tab ${tabId} is ${row.status}, not actively controlled`);
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
  void maybeApplyPendingExtensionUpdate("tab_removed");
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
  void maybeApplyPendingExtensionUpdate("browser_tabs_cleaned");
  return result;
}

async function hideCursor(tabId: number): Promise<void> {
  await overlayCoordinator.hide(tabId);
}

async function releaseActiveTakeoverForUnavailableHost(reason: string): Promise<void> {
  appendDebugLog("warn", "takeover.release.unavailable_host", { reason });
  await cleanupAllSessionTabs("unavailable");
  void maybeApplyPendingExtensionUpdate(`unavailable_host:${reason}`);
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
  void maybeApplyPendingExtensionUpdate("background_bootstrap");
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
      } else {
        session.finalizedTabs.set(durableTab.tabId, durableTab);
      }
      await tabGroupManager.restoreDurableTab(row.session_id, session, tab, durableTab);
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

function sessionGroupTitle(label: string | undefined): string {
  const sanitized = sanitizeGroupLabel(label);
  return sanitized.length > 0 ? sanitized : DEFAULT_SESSION_GROUP_TITLE;
}

function sanitizeGroupLabel(label: string | undefined): string {
  if (typeof label !== "string") return "";
  return label.replace(/\s+/g, " ").trim().slice(0, MAX_GROUP_TITLE_LENGTH);
}

function requireTabWindowId(tab: ChromeTab): number {
  if (!Number.isInteger(tab.windowId)) throw new Error("tab did not include a windowId");
  return tab.windowId!;
}

function emptyTabGroupState(): TabGroupState {
  return {
    version: 1,
    groups: [],
    sessionGroupsBySessionIdAndWindowId: {},
    deliverableGroupsByWindowId: {},
  };
}

function parseTabGroupState(value: unknown): TabGroupState | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.groups)) return undefined;
  const state = emptyTabGroupState();
  for (const row of value.groups) {
    const group = parseManagedTabGroup(row);
    if (!group) continue;
    state.groups.push(group);
  }
  for (const group of state.groups) {
    if (group.kind === "session" && group.sessionId) {
      state.sessionGroupsBySessionIdAndWindowId[group.sessionId] ??= {};
      state.sessionGroupsBySessionIdAndWindowId[group.sessionId]![String(group.windowId)] = group.groupId;
    } else if (group.kind === "deliverable") {
      state.deliverableGroupsByWindowId[String(group.windowId)] = group.groupId;
    }
  }
  return state;
}

function parseManagedTabGroup(value: unknown): ManagedTabGroup | undefined {
  if (!isRecord(value)) return undefined;
  const groupId = value.groupId;
  const kind = value.kind;
  const windowId = value.windowId;
  const sessionId = value.sessionId;
  const title = value.title;
  const color = value.color;
  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;
  if (typeof groupId !== "number" || !Number.isInteger(groupId) || groupId < 0) return undefined;
  if (kind !== "session" && kind !== "deliverable") return undefined;
  if (typeof windowId !== "number" || !Number.isInteger(windowId)) return undefined;
  if (kind === "session" && typeof sessionId !== "string") return undefined;
  if (typeof title !== "string" || !isTabGroupColor(color)) return undefined;
  const parsedSessionId = typeof sessionId === "string" ? sessionId : undefined;
  const tabs: Record<string, ManagedTab> = {};
  if (isRecord(value.tabs)) {
    for (const [tabId, tab] of Object.entries(value.tabs)) {
      if (!/^\d+$/.test(tabId)) continue;
      const managedTab = parseManagedTab(tab);
      if (managedTab) tabs[tabId] = managedTab;
    }
  }
  return {
    groupId,
    kind,
    windowId,
    ...(kind === "session" ? { sessionId: parsedSessionId } : {}),
    title,
    color,
    tabs,
    createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

function parseManagedTab(value: unknown): ManagedTab | undefined {
  if (!isRecord(value)) return undefined;
  const origin = value.origin;
  const status = value.status;
  if (!isTabOrigin(origin) || !isTabStatus(status)) return undefined;
  return { origin, status };
}

function isTabOrigin(value: unknown): value is TabOrigin {
  return value === "agent" || value === "user";
}

function isTabStatus(value: unknown): value is TabStatus {
  return value === "active" || value === "handoff" || value === "deliverable";
}

function isTabGroupColor(value: unknown): value is TabGroupColor {
  return (
    value === "grey" ||
    value === "blue" ||
    value === "red" ||
    value === "yellow" ||
    value === "green" ||
    value === "pink" ||
    value === "purple" ||
    value === "cyan" ||
    value === "orange"
  );
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

async function maybeApplyPendingExtensionUpdate(trigger: string): Promise<void> {
  if (!pendingExtensionUpdate) return;
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
}

function browserControlActivitySnapshot(): { active: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (overlayCoordinator.activeTabIds().length > 0) reasons.push("active_takeover");
  if (overlayCoordinator.hasPendingActivity()) reasons.push("overlay_pending");
  if (debuggerAttachLocks.size > 0) reasons.push("debugger_attach_lock");
  if (pending.size > 0) reasons.push("native_request_pending");
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
      async (error) => {
        const message = errorMessage(error);
        appendDebugLog("warn", "native.heartbeat.failed", { message });
        const failedPort = port;
        port = null;
        failedPort?.disconnect();
        rejectPending(message);
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
  eventFamilies: InputBypassEventFamily[];
};

type InputBypassEventFamily = "pointer" | "wheel" | "touch" | "keyboard" | "text";

type CursorTarget = {
  x: number;
  y: number;
  sequence?: number;
};

type ActiveTakeover = {
  sessionId: string;
  turnId: string;
  lockInputs: boolean;
  lastCursor?: CursorTarget;
};

type PendingDialogAwareClose = {
  sessionId: string;
  operation: string;
  reject(error: Error): void;
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

type TabOrigin = "agent" | "user";
type TabStatus = "active" | "handoff" | "deliverable";
type TabGroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";

type SessionTab = {
  tabId: number;
  origin: TabOrigin;
  status: TabStatus;
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
  suggestedFilename?: string;
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
  origin: TabOrigin;
  status: "handoff" | "deliverable";
};

type ManagedTab = {
  origin: TabOrigin;
  status: TabStatus;
};

type ManagedTabGroup = {
  groupId: number;
  kind: "session" | "deliverable";
  windowId: number;
  sessionId?: string;
  title: string;
  color: TabGroupColor;
  tabs: Record<string, ManagedTab>;
  createdAt: number;
  updatedAt: number;
};

type TabGroupState = {
  version: 1;
  groups: ManagedTabGroup[];
  sessionGroupsBySessionIdAndWindowId: Record<string, Record<string, number>>;
  deliverableGroupsByWindowId: Record<string, number>;
};

type SessionCleanupMode = "stop" | "unavailable";

type CleanupBrowserTabsResult = {
  closedTabs: number;
  releasedTabs: number;
  keptDeliverables: number;
};

export {};

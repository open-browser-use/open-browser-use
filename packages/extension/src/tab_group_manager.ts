import type { BrowserSession, SessionTab, TabOrigin, TabStatus } from "./session_store.js";

const TAB_GROUP_STATE_KEY = "OBU_TAB_GROUP_STATE";
const DEFAULT_SESSION_GROUP_TITLE = "Open Browser Use";
const DEFAULT_SESSION_GROUP_COLOR: TabGroupColor = "blue";
const DELIVERABLE_GROUP_TITLE = "Open Browser Use Deliverables";
const DELIVERABLE_GROUP_COLOR: TabGroupColor = "green";
const GROUP_EXPANDED = false;
const MAX_GROUP_TITLE_LENGTH = 80;

type DebugLogLevel = "debug" | "info" | "warn" | "error";

export class TabGroupManager {
  private state: TabGroupState = emptyTabGroupState();
  private loadPromise: Promise<void> | undefined;
  private reconcilingGroupIds = new Set<number>();

  constructor(
    private readonly appendDebugLog: (level: DebugLogLevel, event: string, data?: unknown) => void,
  ) {}

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
    await this.setManagedTabStatus(row.tabId, row.status);
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
    this.appendDebugLog("info", "tab_group.deliverable", { sessionId, tabId, groupId, windowId });
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

  async replaceManagedTab(removedTabId: number, addedTabId: number): Promise<void> {
    await this.ensureLoaded();
    let targetGroup: ManagedTabGroup | undefined;
    let managedTab: ManagedTab | undefined;
    for (const group of this.state.groups) {
      const row = group.tabs[String(removedTabId)];
      if (!row) continue;
      delete group.tabs[String(removedTabId)];
      group.tabs[String(addedTabId)] = row;
      group.updatedAt = Date.now();
      targetGroup = group;
      managedTab = row;
      break;
    }
    if (!targetGroup || !managedTab) return;
    try {
      await groupTab(addedTabId, targetGroup.groupId);
    } catch {
      // Replacement tabs may disappear before Chrome finishes promotion; keep
      // durable session state authoritative and let cleanup reconcile later.
    }
    await this.persist();
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

export function requireTabWindowId(tab: ChromeTab): number {
  if (!Number.isInteger(tab.windowId)) throw new Error("tab did not include a windowId");
  return tab.windowId!;
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

function sessionGroupTitle(label: string | undefined): string {
  const sanitized = sanitizeGroupLabel(label);
  return sanitized.length > 0 ? sanitized : DEFAULT_SESSION_GROUP_TITLE;
}

function sanitizeGroupLabel(label: string | undefined): string {
  if (typeof label !== "string") return "";
  return label.replace(/\s+/g, " ").trim().slice(0, MAX_GROUP_TITLE_LENGTH);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type TabGroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";

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

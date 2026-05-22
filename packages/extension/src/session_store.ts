import type { CursorTarget } from "./overlay_coordinator.js";

export type BrowserSession = {
  currentTurnId: string;
  activeTabId?: number;
  controlState?: "human_takeover";
  tabs: Map<number, SessionTab>;
  finalizedTabs: Map<number, SessionTab>;
  attachedTabIds: Set<number>;
  groupId?: number;
  deliverableGroupId?: number;
  label?: string;
};

export type TabOrigin = "agent" | "user";
export type TabStatus = "active" | "handoff" | "deliverable";

export type SessionTab = {
  tabId: number;
  origin: TabOrigin;
  status: TabStatus;
  lastCursor?: CursorTarget;
};

export type PersistedBrowserSessionState = {
  version: 1;
  sessions: PersistedBrowserSession[];
};

export type PersistedBrowserSession = {
  session_id: string;
  label?: string;
  activeTabId?: number;
  controlState?: "human_takeover";
  groupId?: number;
  deliverableGroupId?: number;
  tabs: PersistedSessionTab[];
};

export type PersistedSessionTab = {
  tabId: number;
  origin: TabOrigin;
  status: TabStatus;
  lastCursor?: PersistedCursorTarget;
};

type PersistedCursorTarget = {
  x: number;
  y: number;
};

export function createBrowserSession(): BrowserSession {
  return { currentTurnId: "", tabs: new Map(), finalizedTabs: new Map(), attachedTabIds: new Set() };
}

export function serializeBrowserSessions(sessions: Map<string, BrowserSession>): PersistedBrowserSessionState {
  const rows: PersistedBrowserSession[] = [];
  for (const [sessionId, session] of [...sessions].sort(([a], [b]) => a.localeCompare(b))) {
    const tabs = durableSessionTabs(session).sort((a, b) => a.tabId - b.tabId);
    if (tabs.length === 0) continue;
    rows.push({
      session_id: sessionId,
      label: session.label,
      activeTabId: session.activeTabId,
      controlState: session.controlState,
      groupId: session.groupId,
      deliverableGroupId: session.deliverableGroupId,
      tabs,
    });
  }
  return { version: 1, sessions: rows };
}

export function parsePersistedBrowserSessionState(value: unknown): PersistedBrowserSessionState | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions)) return undefined;
  const sessions: PersistedBrowserSession[] = [];
  for (const row of value.sessions) {
    if (!isRecord(row) || typeof row.session_id !== "string" || !Array.isArray(row.tabs)) continue;
    const tabs = row.tabs.map(parseDurableSessionTab).filter((tab): tab is SessionTab => tab !== undefined);
    sessions.push({
      session_id: row.session_id,
      ...(typeof row.label === "string" ? { label: row.label } : {}),
      ...(Number.isInteger(row.activeTabId) ? { activeTabId: row.activeTabId as number } : {}),
      ...(row.controlState === "human_takeover" ? { controlState: row.controlState } : {}),
      ...(Number.isInteger(row.groupId) ? { groupId: row.groupId as number } : {}),
      ...(Number.isInteger(row.deliverableGroupId) ? { deliverableGroupId: row.deliverableGroupId as number } : {}),
      tabs,
    });
  }
  return { version: 1, sessions };
}

export function parseDurableSessionTab(value: unknown): SessionTab | undefined {
  if (!isRecord(value)) return undefined;
  const tabId = value.tabId;
  const origin = value.origin;
  const status = value.status;
  if (typeof tabId !== "number" || !Number.isInteger(tabId)) return undefined;
  if (origin !== "agent" && origin !== "user") return undefined;
  if (status !== "active" && status !== "handoff" && status !== "deliverable") return undefined;
  const lastCursor = parsePersistedCursorTarget(value.lastCursor);
  return { tabId, origin, status, ...(lastCursor ? { lastCursor } : {}) };
}

function durableSessionTabs(session: BrowserSession): PersistedSessionTab[] {
  const rows: PersistedSessionTab[] = [];
  for (const row of session.tabs.values()) {
    rows.push({ tabId: row.tabId, origin: row.origin, status: row.status, lastCursor: persistableCursor(row.lastCursor) });
  }
  for (const row of session.finalizedTabs.values()) {
    if (row.status === "handoff" || row.status === "deliverable") {
      rows.push({ tabId: row.tabId, origin: row.origin, status: row.status, lastCursor: persistableCursor(row.lastCursor) });
    }
  }
  return rows;
}

function persistableCursor(cursor: CursorTarget | undefined): PersistedCursorTarget | undefined {
  if (!cursor) return undefined;
  return { x: cursor.x, y: cursor.y };
}

function parsePersistedCursorTarget(value: unknown): CursorTarget | undefined {
  if (!isRecord(value)) return undefined;
  const x = value.x;
  const y = value.y;
  if (typeof x !== "number" || !Number.isFinite(x)) return undefined;
  if (typeof y !== "number" || !Number.isFinite(y)) return undefined;
  return { x, y };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

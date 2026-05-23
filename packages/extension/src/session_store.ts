import type { CursorTarget } from "./overlay_coordinator.js";

export type BrowserSession = {
  currentTurnId: string;
  activeTabId?: number;
  controlState?: "human_takeover";
  lifecycle: BrowserSessionLifecycle;
  turnLifecycle: BrowserTurnLifecycle;
  lastFinalize?: BrowserSessionFinalizeDiagnostic;
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

export type BrowserSessionLifecycle =
  | { kind: "active"; activeTabId?: number }
  | { kind: "human_takeover"; activeTabId?: number }
  | { kind: "resuming"; repairPlanId: string }
  | { kind: "finalizing"; turnId: string }
  | { kind: "finalize_partial"; turnId: string; failures: BrowserSessionFinalizeFailureSummary[] }
  | { kind: "finalize_failed"; turnId: string; errorCode: string; errorMessage: string }
  | { kind: "cleanup_failed"; turnId?: string; failures: BrowserSessionCleanupFailureSummary[] }
  | { kind: "stale"; reason: string };

export type BrowserTurnLifecycle =
  | { kind: "idle" }
  | { kind: "open"; sessionId: string; turnId: string }
  | { kind: "yielded"; sessionId: string; turnId: string }
  | { kind: "finalizing"; sessionId: string; turnId: string }
  | { kind: "ended"; sessionId: string; turnId: string; finalization: "ok" }
  | { kind: "ended_partial"; sessionId: string; turnId: string; failures: BrowserSessionFinalizeFailureSummary[] }
  | { kind: "failed"; sessionId: string; turnId: string; errorCode: string; diagnostics: unknown[] };

export type BrowserSessionFinalizeDiagnostic =
  | { kind: "finalize_partial"; turnId: string; failures: BrowserSessionFinalizeFailureSummary[] }
  | { kind: "finalize_failed"; turnId: string; errorCode: string; errorMessage: string; failures: BrowserSessionFinalizeFailureSummary[] };

export type BrowserSessionFinalizeFailureSummary = {
  tabId?: number;
  desiredStatus?: string;
  errorCode: string;
  errorMessage: string;
};

export type BrowserSessionCleanupFailureSummary = {
  tabId?: number;
  errorCode?: string;
  errorMessage: string;
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
  lifecycle?: BrowserSessionLifecycle;
  turnLifecycle?: BrowserTurnLifecycle;
  lastFinalize?: BrowserSessionFinalizeDiagnostic;
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
  return {
    currentTurnId: "",
    lifecycle: { kind: "active" },
    turnLifecycle: { kind: "idle" },
    tabs: new Map(),
    finalizedTabs: new Map(),
    attachedTabIds: new Set(),
  };
}

export function serializeBrowserSessions(sessions: Map<string, BrowserSession>): PersistedBrowserSessionState {
  const rows: PersistedBrowserSession[] = [];
  for (const [sessionId, session] of [...sessions].sort(([a], [b]) => a.localeCompare(b))) {
    const tabs = durableSessionTabs(session).sort((a, b) => a.tabId - b.tabId);
    if (tabs.length === 0 && !hasDurableSessionDiagnostic(session)) continue;
    rows.push({
      session_id: sessionId,
      label: session.label,
      activeTabId: session.activeTabId,
      controlState: session.controlState,
      lifecycle: session.lifecycle,
      turnLifecycle: session.turnLifecycle,
      lastFinalize: session.lastFinalize,
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
    const lifecycle = parseBrowserSessionLifecycle(row.lifecycle);
    const turnLifecycle = parseBrowserTurnLifecycle(row.turnLifecycle);
    const lastFinalize = parseBrowserSessionFinalizeDiagnostic(row.lastFinalize);
    sessions.push({
      session_id: row.session_id,
      ...(typeof row.label === "string" ? { label: row.label } : {}),
      ...(Number.isInteger(row.activeTabId) ? { activeTabId: row.activeTabId as number } : {}),
      ...(row.controlState === "human_takeover" ? { controlState: row.controlState } : {}),
      ...(lifecycle ? { lifecycle } : {}),
      ...(turnLifecycle ? { turnLifecycle } : {}),
      ...(lastFinalize ? { lastFinalize } : {}),
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

function hasDurableSessionDiagnostic(session: BrowserSession): boolean {
  return session.lifecycle.kind !== "active" || session.turnLifecycle.kind !== "idle" || session.lastFinalize !== undefined;
}

export function parseBrowserSessionLifecycle(value: unknown): BrowserSessionLifecycle | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  switch (value.kind) {
    case "active":
    case "human_takeover": {
      const activeTabId = integerField(value.activeTabId);
      return activeTabId === undefined ? { kind: value.kind } : { kind: value.kind, activeTabId };
    }
    case "resuming": {
      return typeof value.repairPlanId === "string" ? { kind: "resuming", repairPlanId: value.repairPlanId } : undefined;
    }
    case "finalizing": {
      return typeof value.turnId === "string" ? { kind: "finalizing", turnId: value.turnId } : undefined;
    }
    case "finalize_partial": {
      const failures = parseFinalizeFailures(value.failures);
      return typeof value.turnId === "string" && failures
        ? { kind: "finalize_partial", turnId: value.turnId, failures }
        : undefined;
    }
    case "finalize_failed": {
      return typeof value.turnId === "string" && typeof value.errorCode === "string" && typeof value.errorMessage === "string"
        ? { kind: "finalize_failed", turnId: value.turnId, errorCode: value.errorCode, errorMessage: value.errorMessage }
        : undefined;
    }
    case "cleanup_failed": {
      const failures = parseCleanupFailures(value.failures);
      return failures
        ? { kind: "cleanup_failed", ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}), failures }
        : undefined;
    }
    case "stale": {
      return typeof value.reason === "string" ? { kind: "stale", reason: value.reason } : undefined;
    }
    default:
      return undefined;
  }
}

export function parseBrowserTurnLifecycle(value: unknown): BrowserTurnLifecycle | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "idle") return { kind: "idle" };
  if (typeof value.sessionId !== "string" || typeof value.turnId !== "string") return undefined;
  switch (value.kind) {
    case "open":
    case "yielded":
    case "finalizing":
      return { kind: value.kind, sessionId: value.sessionId, turnId: value.turnId };
    case "ended":
      return value.finalization === "ok"
        ? { kind: "ended", sessionId: value.sessionId, turnId: value.turnId, finalization: "ok" }
        : undefined;
    case "ended_partial": {
      const failures = parseFinalizeFailures(value.failures);
      return failures ? { kind: "ended_partial", sessionId: value.sessionId, turnId: value.turnId, failures } : undefined;
    }
    case "failed":
      return typeof value.errorCode === "string" && Array.isArray(value.diagnostics)
        ? { kind: "failed", sessionId: value.sessionId, turnId: value.turnId, errorCode: value.errorCode, diagnostics: value.diagnostics }
        : undefined;
    default:
      return undefined;
  }
}

export function parseBrowserSessionFinalizeDiagnostic(value: unknown): BrowserSessionFinalizeDiagnostic | undefined {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.turnId !== "string") return undefined;
  const failures = parseFinalizeFailures(value.failures);
  if (!failures) return undefined;
  if (value.kind === "finalize_partial") return { kind: "finalize_partial", turnId: value.turnId, failures };
  if (value.kind === "finalize_failed" && typeof value.errorCode === "string" && typeof value.errorMessage === "string") {
    return {
      kind: "finalize_failed",
      turnId: value.turnId,
      errorCode: value.errorCode,
      errorMessage: value.errorMessage,
      failures,
    };
  }
  return undefined;
}

function parseFinalizeFailures(value: unknown): BrowserSessionFinalizeFailureSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const failures = value.map(parseFinalizeFailure).filter((failure): failure is BrowserSessionFinalizeFailureSummary => failure !== undefined);
  return failures.length === value.length ? failures : undefined;
}

function parseFinalizeFailure(value: unknown): BrowserSessionFinalizeFailureSummary | undefined {
  if (!isRecord(value) || typeof value.errorCode !== "string" || typeof value.errorMessage !== "string") return undefined;
  return {
    ...(integerField(value.tabId) !== undefined ? { tabId: integerField(value.tabId) } : {}),
    ...(typeof value.desiredStatus === "string" ? { desiredStatus: value.desiredStatus } : {}),
    errorCode: value.errorCode,
    errorMessage: value.errorMessage,
  };
}

function parseCleanupFailures(value: unknown): BrowserSessionCleanupFailureSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const failures = value.map(parseCleanupFailure).filter((failure): failure is BrowserSessionCleanupFailureSummary => failure !== undefined);
  return failures.length === value.length ? failures : undefined;
}

function parseCleanupFailure(value: unknown): BrowserSessionCleanupFailureSummary | undefined {
  if (!isRecord(value) || typeof value.errorMessage !== "string") return undefined;
  return {
    ...(integerField(value.tabId) !== undefined ? { tabId: integerField(value.tabId) } : {}),
    ...(typeof value.errorCode === "string" ? { errorCode: value.errorCode } : {}),
    errorMessage: value.errorMessage,
  };
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

function integerField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

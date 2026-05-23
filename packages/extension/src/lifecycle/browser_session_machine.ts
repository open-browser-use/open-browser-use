import type {
  BrowserSession,
  BrowserSessionFinalizeFailureSummary,
  BrowserSessionLifecycle,
  BrowserTurnLifecycle,
  SessionTab,
  TabOrigin,
} from "../session_store.js";

export type SessionCleanupMode = "stop" | "unavailable";

export type LogicalActiveCandidate = {
  tabId: number;
  active: boolean;
};

export type ActiveTabResolutionObservation = {
  tabId: number;
  status: SessionTab["status"];
  live: boolean;
  chromeActive?: boolean;
};

export type ActiveTabResolutionPlan = {
  nextActiveTabId?: number;
  removedTabIds: number[];
  cleanup: ActiveTabResolutionCleanupObligation[];
  diagnostics: ActiveTabResolutionDiagnostic[];
  activeTabChanged: boolean;
  changed: boolean;
};

export type ActiveTabResolutionCleanupObligation = {
  tabId: number;
  effects: Array<
    | "forget_overlay"
    | "remove_session_tab"
    | "remove_finalized_tab"
    | "detach_debugger"
    | "remove_managed_tab"
    | "remove_download_owner"
  >;
};

export type ActiveTabResolutionDiagnostic =
  | { kind: "active_tab_removed"; tabId: number }
  | { kind: "session_tab_removed"; tabId: number; status: SessionTab["status"] }
  | { kind: "active_tab_changed"; previousTabId?: number; nextTabId?: number };

export type CleanupSessionTabEffect = "close_agent_tab" | "release_controlled_tab";

export type CleanupSessionTabStep = {
  tabId: number;
  row: SessionTab;
  effect: CleanupSessionTabEffect;
};

export function activeSessionLifecycle(activeTabId: number | undefined): BrowserSessionLifecycle {
  return activeTabId === undefined ? { kind: "active" } : { kind: "active", activeTabId };
}

export function humanTakeoverLifecycle(activeTabId: number | undefined): BrowserSessionLifecycle {
  return activeTabId === undefined ? { kind: "human_takeover" } : { kind: "human_takeover", activeTabId };
}

export function openTurnLifecycle(sessionId: string, turnId: string): BrowserTurnLifecycle {
  return { kind: "open", sessionId, turnId };
}

export function finalizingTurnLifecycle(sessionId: string, turnId: string): BrowserTurnLifecycle {
  return { kind: "finalizing", sessionId, turnId };
}

export function yieldedTurnLifecycle(sessionId: string, turnId: string): BrowserTurnLifecycle {
  return { kind: "yielded", sessionId, turnId };
}

export function endedTurnLifecycle(
  sessionId: string,
  turnId: string,
  failures: BrowserSessionFinalizeFailureSummary[] | undefined,
): BrowserTurnLifecycle {
  if (failures && failures.length > 0) return { kind: "ended_partial", sessionId, turnId, failures };
  return { kind: "ended", sessionId, turnId, finalization: "ok" };
}

export function failedTurnLifecycle(
  sessionId: string,
  turnId: string,
  errorCode: string,
  diagnostics: unknown[],
): BrowserTurnLifecycle {
  return { kind: "failed", sessionId, turnId, errorCode, diagnostics };
}

export function sessionTabForOrigin(tabId: number, origin: TabOrigin): SessionTab {
  return { tabId, origin, status: "active" };
}

export function assertSessionAcceptsAction(controlState: BrowserSession["controlState"], operation: string): void {
  if (controlState === "human_takeover") {
    throw new Error(`${operation} rejected because browser control is yielded to the human; call resumeControl first`);
  }
}

export function assertActiveSessionTab(row: SessionTab | undefined, tabId: number, inactiveMessage?: string): SessionTab {
  if (!row) throw new Error(`tab ${tabId} is not owned by this open-browser-use session`);
  if (row.status !== "active") throw new Error(inactiveMessage ?? `tab ${tabId} is ${row.status}, not actively controlled`);
  return row;
}

export function chooseLogicalActiveTabId(candidates: LogicalActiveCandidate[]): number | undefined {
  const [selected] = [...candidates].sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    return left.tabId - right.tabId;
  });
  return selected?.tabId;
}

export function planActiveTabResolution(
  currentActiveTabId: number | undefined,
  observations: ActiveTabResolutionObservation[],
): ActiveTabResolutionPlan {
  const removedObservations = observations.filter((observation) => !observation.live);
  const removedTabIds = removedObservations.map((observation) => observation.tabId);
  const current = observations.find((observation) => observation.tabId === currentActiveTabId);
  const nextActiveTabId = current?.status === "active" && current.live
    ? current.tabId
    : chooseLogicalActiveTabId(
      observations
        .filter((observation) => observation.status === "active" && observation.live)
        .map((observation) => ({
          tabId: observation.tabId,
          active: observation.chromeActive === true,
        })),
    );
  const activeTabChanged = currentActiveTabId !== nextActiveTabId;
  const cleanup = removedTabIds.map((tabId) => ({
    tabId,
    effects: [
      "forget_overlay",
      "remove_session_tab",
      "remove_finalized_tab",
      "detach_debugger",
      "remove_managed_tab",
      "remove_download_owner",
    ] satisfies ActiveTabResolutionCleanupObligation["effects"],
  }));
  const diagnostics: ActiveTabResolutionDiagnostic[] = [
    ...removedObservations.map((observation) => observation.status === "active"
      ? { kind: "active_tab_removed" as const, tabId: observation.tabId }
      : { kind: "session_tab_removed" as const, tabId: observation.tabId, status: observation.status }),
    ...(activeTabChanged
      ? [{ kind: "active_tab_changed" as const, previousTabId: currentActiveTabId, nextTabId: nextActiveTabId }]
      : []),
  ];
  return {
    nextActiveTabId,
    removedTabIds,
    cleanup,
    diagnostics,
    activeTabChanged,
    changed: activeTabChanged || removedTabIds.length > 0,
  };
}

export function planForegroundLogicalActiveUpdate(
  session: BrowserSession,
  tabId: number,
): { shouldUpdate: false } | { shouldUpdate: true; tabId: number } {
  const row = session.tabs.get(tabId);
  if (row?.status !== "active" || session.activeTabId === tabId) return { shouldUpdate: false };
  return { shouldUpdate: true, tabId };
}

export function planCleanupSessionTabs(session: BrowserSession, mode: SessionCleanupMode): CleanupSessionTabStep[] {
  const steps: CleanupSessionTabStep[] = [];
  for (const [tabId, row] of [...session.tabs]) {
    if (row.status !== "active") continue;
    steps.push({
      tabId,
      row,
      effect: mode === "stop" && row.origin === "agent" ? "close_agent_tab" : "release_controlled_tab",
    });
  }
  return steps;
}

export function attachedDebuggerTabIds(session: BrowserSession): number[] {
  return [...session.attachedTabIds];
}

export function firstDefinedGroupId(tabIds: Iterable<number>, groupIdForTab: (tabId: number) => number | undefined): number | undefined {
  for (const tabId of tabIds) {
    const groupId = groupIdForTab(tabId);
    if (groupId !== undefined) return groupId;
  }
  return undefined;
}

export function shouldPruneBrowserSession(session: BrowserSession): boolean {
  return session.tabs.size === 0 &&
    session.finalizedTabs.size === 0 &&
    session.attachedTabIds.size === 0 &&
    session.lifecycle.kind === "active" &&
    session.turnLifecycle.kind === "idle" &&
    session.lastFinalize === undefined;
}

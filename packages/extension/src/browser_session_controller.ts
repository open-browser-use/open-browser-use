import type { SessionParams } from "./overlay_coordinator.js";
import type { BrowserSession, SessionTab, TabOrigin } from "./session_store.js";
import {
  activeSessionLifecycle,
  assertActiveSessionTab,
  assertControlStateAcceptsAction,
  endedTurnLifecycle,
  humanTakeoverLifecycle,
  openTurnLifecycle,
  planActiveTabResolution,
  sessionTabForOrigin,
  yieldedTurnLifecycle,
  type ActiveTabResolutionCleanupObligation,
  type ActiveTabResolutionDiagnostic,
  type ActiveTabResolutionObservation,
  type ActiveTabResolutionPlan,
} from "./lifecycle/browser_session_machine.js";
import {
  claimableUserTabState,
  ownedActiveTabState,
  planClaimUserTab,
  planSelectedTab,
} from "./lifecycle/tab_ownership_machine.js";

type DebugLogLevel = "debug" | "info" | "warn" | "error";

export type TabDto = {
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

export type SessionTabsResult = {
  tabs: TabDto[];
  deliverableTabs: TabDto[];
  repair?: SessionActiveTabRepairRequired;
};

export type SessionActiveTabRepairRequired = {
  status: "repair_required";
  nextActiveTabId?: number;
  diagnostics: ActiveTabResolutionDiagnostic[];
  cleanup: ActiveTabResolutionCleanupObligation[];
};

export type SessionActiveTabRepairBlocked = {
  status: "blocked";
  reason: "no_active_tab";
  nextActiveTabId?: number;
  diagnostics: ActiveTabResolutionDiagnostic[];
  cleanup: ActiveTabResolutionCleanupObligation[];
};

export type ResumeControlResult =
  | { tab: TabDto; repair?: SessionActiveTabRepairRequired }
  | { tab: null; repair: SessionActiveTabRepairBlocked };

type BrowserSessionControllerOptions = {
  sessionFor(sessionId: string): BrowserSession;
  createTab(createProperties: { url?: string; active?: boolean }): Promise<ChromeTab>;
  getTab(tabId: number): Promise<ChromeTab>;
  queryTabs(queryInfo: Record<string, unknown>): Promise<ChromeTab[]>;
  addTabToSessionGroup(
    sessionId: string,
    session: BrowserSession,
    tabId: number,
    origin: TabOrigin,
  ): Promise<void>;
  renameSession(sessionId: string, label?: string): Promise<void>;
  removeManagedTab(tabId: number): Promise<void>;
  forgetOverlay(tabId: number): void;
  detachDebugger(tabId: number): Promise<void>;
  removeDownloadOwnersForTab(tabId: number): void;
  removeFinalizedTabFromAllSessions(tabId: number): void;
  syncSessionGroupMirrors(session: BrowserSession): void;
  syncAllSessionGroupMirrors(): void;
  ownedByAnotherSession(sessionId: string, tabId: number): boolean;
  isClaimableUserTab(tab: ChromeTab): boolean;
  toTabDto(tab: ChromeTab, row?: SessionTab, state?: Partial<TabDto>): TabDto;
  activateOverlay(
    tabId: number,
    sessionParams: SessionParams,
    savedCursor?: SessionTab["lastCursor"],
  ): Promise<void>;
  hideSessionTakeover(session: BrowserSession): Promise<void>;
  persistSessionState(): Promise<void>;
  appendDebugLog(level: DebugLogLevel, event: string, data?: unknown): void;
  isTabGoneError(error: unknown): boolean;
};

export class BrowserSessionController {
  constructor(private readonly options: BrowserSessionControllerOptions) {}

  async createSessionTab(sessionParams: SessionParams, url: string): Promise<ChromeTab> {
    const session = this.options.sessionFor(sessionParams.session_id);
    this.openTurn(sessionParams, session);
    this.ensureSessionAcceptsAction(session, "createTab");
    const tab = await this.options.createTab({ url, active: false });
    const tabId = requireCreatedTabId(tab);
    session.activeTabId = tabId;
    delete session.controlState;
    session.lifecycle = activeSessionLifecycle(tabId);
    session.tabs.set(tabId, sessionTabForOrigin(tabId, "agent"));
    await this.options.addTabToSessionGroup(sessionParams.session_id, session, tabId, "agent");
    await this.options.activateOverlay(tabId, sessionParams);
    await this.options.persistSessionState();
    this.options.appendDebugLog("info", "tab.created", { sessionId: sessionParams.session_id, tabId });
    return tab;
  }

  async getSessionTabs(sessionParams: SessionParams): Promise<SessionTabsResult> {
    const session = this.options.sessionFor(sessionParams.session_id);
    const rows: TabDto[] = [];
    const deliverableTabs: TabDto[] = [];
    const resolution = await this.planSessionActiveTabResolution(session);
    const logicalActiveTabId = resolution.nextActiveTabId;
    for (const tabId of session.tabs.keys()) {
      try {
        rows.push(this.options.toTabDto(await this.options.getTab(tabId), session.tabs.get(tabId), {
          ...ownedActiveTabState(session.controlState, tabId === logicalActiveTabId),
          commandable: session.tabs.get(tabId)?.status === "active" && session.controlState !== "human_takeover",
          logicalActive: tabId === logicalActiveTabId,
        }));
      } catch (error) {
        if (!this.options.isTabGoneError(error)) throw error;
      }
    }
    for (const [tabId, row] of session.finalizedTabs) {
      try {
        deliverableTabs.push(this.options.toTabDto(await this.options.getTab(tabId), row));
      } catch (error) {
        if (!this.options.isTabGoneError(error)) throw error;
      }
    }
    return withRepairRequired({ tabs: rows, deliverableTabs }, resolution);
  }

  async getCurrentSessionTab(sessionParams: SessionParams): Promise<TabDto | null> {
    const session = this.options.sessionFor(sessionParams.session_id);
    const resolution = await this.planSessionActiveTabResolution(session);
    const tabId = resolution.nextActiveTabId;
    if (tabId === undefined) return null;
    const row = session.tabs.get(tabId);
    if (!row || row.status !== "active") return null;
    try {
      return this.options.toTabDto(await this.options.getTab(tabId), row, {
        ...ownedActiveTabState(session.controlState, true),
      });
    } catch (error) {
      if (this.options.isTabGoneError(error)) return null;
      throw error;
    }
  }

  async getSelectedTab(sessionParams: SessionParams): Promise<TabDto | null> {
    const session = this.options.sessionFor(sessionParams.session_id);
    const tab = await this.selectedChromeTab();
    if (!tab || !Number.isInteger(tab.id)) return null;
    const tabId = tab.id!;
    const row = session.tabs.get(tabId);
    const selected = planSelectedTab({
      row,
      claimable: this.options.isClaimableUserTab(tab),
      ownedByAnotherSession: this.options.ownedByAnotherSession(sessionParams.session_id, tabId),
      controlState: session.controlState,
    });
    if (selected.kind === "owned_active" && row) {
      this.openTurn(sessionParams, session);
      session.activeTabId = tabId;
      session.lifecycle = activeSessionLifecycle(tabId);
      await this.options.persistSessionState();
      return this.options.toTabDto(tab, row, selected.state);
    }
    if (selected.kind === "claimable_user") {
      return this.options.toTabDto(tab, sessionTabForOrigin(tabId, "user"), selected.state);
    }
    return null;
  }

  async getUserTabs(sessionParams: SessionParams): Promise<TabDto[]> {
    const session = this.options.sessionFor(sessionParams.session_id);
    const tabs = await this.options.queryTabs({});
    return tabs
      .filter((tab) => Number.isInteger(tab.id) && this.options.isClaimableUserTab(tab))
      .filter((tab) => !this.options.ownedByAnotherSession(sessionParams.session_id, tab.id!))
      .map((tab) => this.options.toTabDto(tab, sessionTabForOrigin(tab.id!, "user"), {
        ...claimableUserTabState(),
      }));
  }

  async claimUserTab(sessionParams: SessionParams, tabId: number): Promise<ChromeTab> {
    const tab = await this.options.getTab(tabId);
    const claimPlan = planClaimUserTab({
      tabId,
      claimable: this.options.isClaimableUserTab(tab),
      ownedByAnotherSession: this.options.ownedByAnotherSession(sessionParams.session_id, tabId),
    });
    if (claimPlan.kind === "reject") throw new Error(claimPlan.message);
    const session = this.options.sessionFor(sessionParams.session_id);
    this.openTurn(sessionParams, session);
    this.options.removeFinalizedTabFromAllSessions(tabId);
    session.activeTabId = tabId;
    delete session.controlState;
    session.lifecycle = activeSessionLifecycle(tabId);
    session.tabs.set(tabId, sessionTabForOrigin(tabId, "user"));
    await this.options.addTabToSessionGroup(sessionParams.session_id, session, tabId, "user");
    this.options.syncAllSessionGroupMirrors();
    await this.options.activateOverlay(tabId, sessionParams, session.tabs.get(tabId)?.lastCursor);
    await this.options.persistSessionState();
    this.options.appendDebugLog("info", "tab.claimed", { sessionId: sessionParams.session_id, tabId });
    return tab;
  }

  async nameSession(sessionParams: SessionParams, label?: string): Promise<void> {
    const session = this.options.sessionFor(sessionParams.session_id);
    this.openTurn(sessionParams, session);
    session.label = label;
    await this.options.renameSession(sessionParams.session_id, label);
    await this.options.persistSessionState();
  }

  async markTurnEnded(sessionParams: SessionParams): Promise<void> {
    const session = this.options.sessionFor(sessionParams.session_id);
    this.ensureSessionAcceptsAction(session, "turnEnded");
    session.currentTurnId = sessionParams.turn_id;
    if (session.lastFinalize?.kind === "finalize_failed" && session.lastFinalize.turnId === sessionParams.turn_id) {
      session.turnLifecycle = {
        kind: "failed",
        sessionId: sessionParams.session_id,
        turnId: sessionParams.turn_id,
        errorCode: session.lastFinalize.errorCode,
        diagnostics: session.lastFinalize.failures,
      };
      await this.options.persistSessionState();
      throw new Error("turnEnded rejected because finalizeTabs failed");
    }
    const failures = session.lastFinalize?.kind === "finalize_partial" && session.lastFinalize.turnId === sessionParams.turn_id
      ? session.lastFinalize.failures
      : undefined;
    session.turnLifecycle = endedTurnLifecycle(sessionParams.session_id, sessionParams.turn_id, failures);
    if (!failures || failures.length === 0) {
      session.lifecycle = activeSessionLifecycle(session.activeTabId);
    }
    await this.options.persistSessionState();
  }

  async yieldControl(sessionParams: SessionParams): Promise<void> {
    const session = this.options.sessionFor(sessionParams.session_id);
    this.openTurn(sessionParams, session);
    session.controlState = "human_takeover";
    session.lifecycle = humanTakeoverLifecycle(session.activeTabId);
    session.turnLifecycle = yieldedTurnLifecycle(sessionParams.session_id, sessionParams.turn_id);
    await this.options.hideSessionTakeover(session);
    await this.options.persistSessionState();
    this.options.appendDebugLog("info", "control.yield", { sessionId: sessionParams.session_id });
  }

  async resumeControl(sessionParams: SessionParams): Promise<ResumeControlResult> {
    const session = this.options.sessionFor(sessionParams.session_id);
    this.openTurn(sessionParams, session);
    session.lifecycle = { kind: "resuming", repairPlanId: `${sessionParams.session_id}:${sessionParams.turn_id}` };
    const resolution = await this.repairSessionActiveTab(session);
    const tabId = resolution.nextActiveTabId;
    if (tabId === undefined) {
      session.lifecycle = { kind: "stale", reason: "no active session tab available for resumeControl" };
      if (resolution.changed) {
        this.options.syncSessionGroupMirrors(session);
      }
      await this.options.persistSessionState();
      return { tab: null, repair: blockedRepairFromPlan(resolution) };
    }
    const row = session.tabs.get(tabId);
    if (!row || row.status !== "active") return { tab: null, repair: blockedRepairFromPlan(resolution) };
    delete session.controlState;
    session.lifecycle = activeSessionLifecycle(tabId);
    if (resolution.changed) this.options.syncSessionGroupMirrors(session);
    await this.options.activateOverlay(tabId, sessionParams, row.lastCursor);
    await this.options.persistSessionState();
    this.options.appendDebugLog("info", "control.resume_session", { sessionId: sessionParams.session_id, tabId });
    const tab = this.options.toTabDto(await this.options.getTab(tabId), row, ownedActiveTabState(session.controlState, true));
    return withRepairRequired({ tab }, resolution);
  }

  async requireCurrentSessionTabForBrowserCommand(
    sessionParams: SessionParams,
    operation: string,
  ): Promise<{ tabId: number; tab: ChromeTab; row: SessionTab }> {
    const session = this.options.sessionFor(sessionParams.session_id);
    this.openTurn(sessionParams, session);
    this.ensureSessionAcceptsAction(session, operation);
    const resolution = await this.repairSessionActiveTab(session);
    const tabId = resolution.nextActiveTabId;
    if (tabId === undefined) {
      if (resolution.changed) {
        this.options.syncSessionGroupMirrors(session);
        await this.options.persistSessionState();
      }
      throw new Error(`${operation} requires an active session tab`);
    }
    const row = session.tabs.get(tabId);
    if (!row || row.status !== "active") throw new Error(`tab ${tabId} is not actively controlled`);
    if (resolution.changed) this.options.syncSessionGroupMirrors(session);
    await this.options.persistSessionState();
    return { tabId, row, tab: await this.options.getTab(tabId) };
  }

  requireSessionTab(sessionParams: SessionParams, tabId: number): SessionTab {
    const session = this.options.sessionFor(sessionParams.session_id);
    this.openTurn(sessionParams, session);
    this.ensureSessionAcceptsAction(session, "tab command");
    const row = assertActiveSessionTab(session.tabs.get(tabId), tabId);
    session.activeTabId = tabId;
    session.lifecycle = activeSessionLifecycle(tabId);
    void this.options.persistSessionState().catch(() => undefined);
    return row;
  }

  async planSessionActiveTabResolution(session: BrowserSession): Promise<ActiveTabResolutionPlan> {
    const observations: ActiveTabResolutionObservation[] = [];
    const observedTabIds = new Set<number>();
    for (const [tabId, row] of session.tabs) {
      observedTabIds.add(tabId);
      try {
        const tab = await this.options.getTab(tabId);
        observations.push({ tabId, status: row.status, live: true, chromeActive: tab.active === true });
      } catch (error) {
        if (!this.options.isTabGoneError(error)) throw error;
        observations.push({ tabId, status: row.status, live: false });
      }
    }
    for (const [tabId, row] of session.finalizedTabs) {
      if (observedTabIds.has(tabId)) continue;
      try {
        await this.options.getTab(tabId);
        observations.push({ tabId, status: row.status, live: true });
      } catch (error) {
        if (!this.options.isTabGoneError(error)) throw error;
        observations.push({ tabId, status: row.status, live: false });
      }
    }
    return planActiveTabResolution(session.activeTabId, observations);
  }

  async repairSessionActiveTab(session: BrowserSession): Promise<ActiveTabResolutionPlan> {
    const plan = await this.planSessionActiveTabResolution(session);
    await this.applyActiveTabResolution(session, plan);
    return plan;
  }

  private async applyActiveTabResolution(session: BrowserSession, plan: ActiveTabResolutionPlan): Promise<void> {
    for (const tabId of plan.removedTabIds) {
      await this.applyGoneTabCleanup(session, tabId);
    }
    if (plan.activeTabChanged) {
      session.activeTabId = plan.nextActiveTabId;
    }
  }

  private async applyGoneTabCleanup(session: BrowserSession, tabId: number): Promise<void> {
    this.options.forgetOverlay(tabId);
    session.tabs.delete(tabId);
    session.finalizedTabs.delete(tabId);
    if (session.attachedTabIds.delete(tabId)) {
      try {
        await this.options.detachDebugger(tabId);
      } catch {
        // Ignore detach races for tab ids already proven absent from Chrome.
      }
    }
    await this.options.removeManagedTab(tabId);
    this.options.removeDownloadOwnersForTab(tabId);
    this.options.appendDebugLog("info", "tab.active_resolution.removed_stale", { tabId });
  }

  private ensureSessionAcceptsAction(session: BrowserSession, operation: string): void {
    assertControlStateAcceptsAction(session.controlState, operation);
    if (session.lifecycle.kind === "finalizing") {
      throw new Error(`${operation} rejected because turn ${session.lifecycle.turnId} is finalizing`);
    }
    if (session.lifecycle.kind === "finalize_failed") {
      throw new Error(`${operation} rejected because finalizeTabs failed: ${session.lifecycle.errorMessage}`);
    }
    if (session.lifecycle.kind === "cleanup_failed") {
      throw new Error(`${operation} rejected because browser cleanup failed`);
    }
    if (session.lifecycle.kind === "finalize_partial") {
      throw new Error(
        `${operation} rejected because turn ${session.lifecycle.turnId} finalized partially; acknowledge or repair the partial finalize before new browser actions`,
      );
    }
    if (session.lifecycle.kind === "resuming") {
      throw new Error(
        `${operation} rejected because session is resuming (repairPlan ${session.lifecycle.repairPlanId}); wait for resume to resolve to active, blocked, repair-required, or stale`,
      );
    }
    if (session.lifecycle.kind === "stale") {
      throw new Error(`${operation} rejected because session is stale: ${session.lifecycle.reason}`);
    }
  }

  private async selectedChromeTab(): Promise<ChromeTab | undefined> {
    const focused = await this.options.queryTabs({ active: true, lastFocusedWindow: true });
    if (focused[0]) return focused[0];
    const active = await this.options.queryTabs({ active: true });
    return active[0];
  }

  private openTurn(sessionParams: SessionParams, session: BrowserSession): void {
    session.currentTurnId = sessionParams.turn_id;
    if (session.turnLifecycle.kind === "open" && session.turnLifecycle.turnId === sessionParams.turn_id) return;
    session.turnLifecycle = openTurnLifecycle(sessionParams.session_id, sessionParams.turn_id);
  }
}

function requireCreatedTabId(tab: ChromeTab): number {
  if (!Number.isInteger(tab.id)) throw new Error("created tab did not include an id");
  return tab.id!;
}

function withRepairRequired<T extends object>(result: T, plan: ActiveTabResolutionPlan): T & { repair?: SessionActiveTabRepairRequired } {
  const repair = repairRequiredFromPlan(plan);
  return repair ? { ...result, repair } : result;
}

function repairRequiredFromPlan(plan: ActiveTabResolutionPlan): SessionActiveTabRepairRequired | undefined {
  if (!plan.changed) return undefined;
  return {
    status: "repair_required",
    ...plannedNextActiveTab(plan),
    diagnostics: plan.diagnostics,
    cleanup: plan.cleanup,
  };
}

function blockedRepairFromPlan(plan: ActiveTabResolutionPlan): SessionActiveTabRepairBlocked {
  return {
    status: "blocked",
    reason: "no_active_tab",
    ...plannedNextActiveTab(plan),
    diagnostics: plan.diagnostics,
    cleanup: plan.cleanup,
  };
}

function plannedNextActiveTab(plan: ActiveTabResolutionPlan): { nextActiveTabId?: number } {
  return plan.nextActiveTabId === undefined ? {} : { nextActiveTabId: plan.nextActiveTabId };
}

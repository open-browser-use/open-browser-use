import type { SessionParams } from "./overlay_coordinator.js";
import type {
  BrowserSession,
  BrowserSessionFinalizeFailureSummary,
  SessionTab,
  TabOrigin,
  TabStatus,
} from "./session_store.js";
import {
  activeSessionLifecycle,
  failedTurnLifecycle,
  finalizingTurnLifecycle,
} from "./lifecycle/browser_session_machine.js";
import {
  finalizeAction,
  finalizeFailure,
  parseFinalizeKeep,
  planFinalizeTabs,
  type FinalizeTabAction,
  type FinalizeTabFailure,
} from "./lifecycle/finalize_tabs_machine.js";

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
  origin: TabOrigin;
  status: TabStatus;
  owned?: boolean;
  claimRequired?: boolean;
  commandable?: boolean;
};

export type FinalizeTabsFinalTabs = {
  handoff: TabDto[];
  deliverable: TabDto[];
  activeTabId: number | null;
};

export type FinalizeTabsResult = {
  status: "ok" | "partial" | "fatal";
  actions: FinalizeTabAction[];
  closedTabIds: number[];
  releasedTabIds: number[];
  keptTabs: TabDto[];
  deliverableTabs: TabDto[];
  finalTabs: FinalizeTabsFinalTabs | null;
  failures: FinalizeTabFailure[];
  diagnostics: {
    reconciledFromChrome: boolean;
    reconciliationSource?: "chrome.tabs";
  };
  errorCode?: string;
  errorMessage?: string;
};

type FinalizeTabsControllerOptions = {
  sessionFor(sessionId: string): BrowserSession;
  hideSessionTakeover(session: BrowserSession): Promise<void>;
  closeAgentTabWithDialogPolicy(
    sessionId: string,
    session: BrowserSession,
    tabId: number,
    operation: string,
  ): Promise<void>;
  cleanupControlledTab(session: BrowserSession, tabId: number): Promise<void>;
  removeManagedTab(tabId: number): Promise<void>;
  releaseManagedTab(tabId: number): Promise<void>;
  setManagedTabStatus(tabId: number, status: TabStatus): Promise<void>;
  getTab(tabId: number): Promise<ChromeTab>;
  moveTabToDeliverableGroup(
    sessionId: string,
    session: BrowserSession,
    tabId: number,
    origin: TabOrigin,
  ): Promise<number>;
  toTabDto(tab: ChromeTab, row?: SessionTab, state?: Partial<TabDto>): TabDto;
  syncSessionGroupMirrors(session: BrowserSession): void;
  repairSessionActiveTab(session: BrowserSession): Promise<{
    nextActiveTabId?: number;
    changed: boolean;
  }>;
  persistSessionState(): Promise<void>;
  appendDebugLog(level: DebugLogLevel, event: string, data?: unknown): void;
  schedulePendingExtensionUpdateCheck(trigger: "tabs_finalized"): void;
  isTabGoneError(error: unknown): boolean;
};

export class FinalizeTabsController {
  constructor(private readonly options: FinalizeTabsControllerOptions) {}

  async finalizeTabs(sessionParams: SessionParams, params: unknown): Promise<FinalizeTabsResult> {
    const session = this.options.sessionFor(sessionParams.session_id);
    if (session.controlState === "human_takeover") {
      throw new Error("finalizeTabs blocked during human takeover");
    }
    session.currentTurnId = sessionParams.turn_id;
    session.lifecycle = { kind: "finalizing", turnId: sessionParams.turn_id };
    session.turnLifecycle = finalizingTurnLifecycle(sessionParams.session_id, sessionParams.turn_id);
    await this.options.hideSessionTakeover(session);
    const keep = parseFinalizeKeep(params);
    const closedTabIds: number[] = [];
    const releasedTabIds: number[] = [];
    const keptTabs: TabDto[] = [];
    const deliverableTabs: TabDto[] = [];
    const actions: FinalizeTabAction[] = [];
    const failures: FinalizeTabFailure[] = [];

    const plan = planFinalizeTabs([...session.tabs], keep);
    for (const step of plan.steps) {
      const { tabId, row, desiredStatus } = step;
      try {
        if (step.effect === "close_agent_tab") {
          await this.options.closeAgentTabWithDialogPolicy(
            sessionParams.session_id,
            session,
            tabId,
            "finalizeTabs",
          );
          await this.options.removeManagedTab(tabId);
          session.tabs.delete(tabId);
          session.finalizedTabs.delete(tabId);
          closedTabIds.push(tabId);
          actions.push(finalizeAction(tabId, row.origin, desiredStatus, "closed"));
          continue;
        }
        if (step.effect === "release_user_tab") {
          await this.options.cleanupControlledTab(session, tabId);
          await this.options.releaseManagedTab(tabId);
          session.tabs.delete(tabId);
          session.finalizedTabs.delete(tabId);
          releasedTabIds.push(tabId);
          actions.push(finalizeAction(tabId, row.origin, desiredStatus, "released"));
          continue;
        }
        if (step.effect === "keep_deliverable") {
          await this.options.cleanupControlledTab(session, tabId);
          const tab = await this.options.getTab(tabId);
          const groupId = await this.options.moveTabToDeliverableGroup(
            sessionParams.session_id,
            session,
            tabId,
            row.origin,
          );
          const finalizedRow: SessionTab = { ...row, status: "deliverable" };
          const dto = this.options.toTabDto({ ...tab, groupId }, finalizedRow);
          session.tabs.delete(tabId);
          session.finalizedTabs.set(tabId, finalizedRow);
          keptTabs.push(dto);
          deliverableTabs.push(dto);
          actions.push(finalizeAction(tabId, row.origin, desiredStatus, "kept_deliverable"));
        } else if (step.effect === "keep_handoff") {
          await this.options.cleanupControlledTab(session, tabId);
          const tab = await this.options.getTab(tabId);
          await this.options.setManagedTabStatus(tabId, "handoff");
          const handoffRow: SessionTab = { ...row, status: "handoff" };
          row.status = "handoff";
          keptTabs.push(this.options.toTabDto(tab, handoffRow));
          actions.push(finalizeAction(tabId, row.origin, desiredStatus, "kept_handoff"));
        }
      } catch (error) {
        if (this.options.isTabGoneError(error)) {
          session.tabs.delete(tabId);
          session.finalizedTabs.delete(tabId);
          session.attachedTabIds.delete(tabId);
          await this.options.removeManagedTab(tabId);
          actions.push(finalizeAction(tabId, row.origin, desiredStatus, "tab_gone"));
        } else {
          const failure = finalizeFailure(tabId, desiredStatus, "failed", error);
          failures.push(failure);
          actions.push(finalizeAction(tabId, row.origin, desiredStatus, "failed", failure.errorCode, failure.errorMessage));
          this.options.appendDebugLog("warn", "tabs.finalize.partial_failure", {
            sessionId: sessionParams.session_id,
            tabId,
            desiredStatus,
            errorCode: failure.errorCode,
            errorMessage: failure.errorMessage,
          });
        }
      }
    }

    // audit §4.10: a keep entry whose tabId is not owned by the session yields no
    // step (planFinalizeTabs only iterates owned tabs). Surface each unmatched
    // tabId as a per-tab `not_attempted` failure so the agent learns the keep
    // request was not honored, instead of silently reporting `ok`. We use a
    // failure (not an action) because an unowned tabId has no truthful origin.
    for (const tabId of plan.unknownKeepTabIds) {
      const desiredStatus = keep.get(tabId);
      const failure = finalizeFailure(
        tabId,
        desiredStatus,
        "not_attempted",
        new Error(`tab ${tabId} is not owned by the session`),
        "tab_not_owned",
      );
      failures.push(failure);
      this.options.appendDebugLog("warn", "tabs.finalize.unknown_keep_tab", {
        sessionId: sessionParams.session_id,
        tabId,
        desiredStatus,
      });
    }

    let finalTabs: FinalizeTabsFinalTabs;
    try {
      this.options.syncSessionGroupMirrors(session);
      const resolution = await this.options.repairSessionActiveTab(session);
      if (resolution.changed) this.options.syncSessionGroupMirrors(session);
      finalTabs = await this.reconcileFinalizeTabs(session);
    } catch (error) {
      const fatal = finalizeFailure(undefined, undefined, "failed", error, "finalize_reconciliation_failed");
      failures.push(fatal);
      const summarizedFailures = failures.map(summarizeFinalizeFailure);
      session.lifecycle = {
        kind: "finalize_failed",
        turnId: sessionParams.turn_id,
        errorCode: fatal.errorCode,
        errorMessage: fatal.errorMessage,
      };
      session.turnLifecycle = failedTurnLifecycle(
        sessionParams.session_id,
        sessionParams.turn_id,
        fatal.errorCode,
        summarizedFailures,
      );
      session.lastFinalize = {
        kind: "finalize_failed",
        turnId: sessionParams.turn_id,
        errorCode: fatal.errorCode,
        errorMessage: fatal.errorMessage,
        failures: summarizedFailures,
      };
      await this.options.persistSessionState();
      return {
        status: "fatal",
        actions,
        closedTabIds,
        releasedTabIds,
        keptTabs,
        deliverableTabs,
        finalTabs: null,
        failures,
        errorCode: fatal.errorCode,
        errorMessage: fatal.errorMessage,
        diagnostics: {
          reconciledFromChrome: false,
          reconciliationSource: "chrome.tabs",
        },
      };
    }

    this.options.appendDebugLog("info", "tabs.finalized", {
      sessionId: sessionParams.session_id,
      status: failures.length > 0 ? "partial" : "ok",
      closed: closedTabIds.length,
      released: releasedTabIds.length,
      kept: keptTabs.length,
      deliverable: deliverableTabs.length,
    });
    this.options.schedulePendingExtensionUpdateCheck("tabs_finalized");
    if (failures.length > 0) {
      const summarizedFailures = failures.map(summarizeFinalizeFailure);
      session.lifecycle = { kind: "finalize_partial", turnId: sessionParams.turn_id, failures: summarizedFailures };
      session.lastFinalize = { kind: "finalize_partial", turnId: sessionParams.turn_id, failures: summarizedFailures };
    } else {
      session.lifecycle = activeSessionLifecycle(session.activeTabId);
      delete session.lastFinalize;
    }
    await this.options.persistSessionState();

    return {
      status: failures.length > 0 ? "partial" : "ok",
      actions,
      closedTabIds,
      releasedTabIds,
      keptTabs,
      deliverableTabs,
      finalTabs,
      failures,
      diagnostics: {
        reconciledFromChrome: true,
        reconciliationSource: "chrome.tabs",
      },
    };
  }

  private async reconcileFinalizeTabs(session: BrowserSession): Promise<FinalizeTabsFinalTabs> {
    const handoff: TabDto[] = [];
    const deliverable: TabDto[] = [];
    let changed = false;

    for (const [tabId, row] of [...session.tabs]) {
      try {
        const tab = await this.options.getTab(tabId);
        if (row.status === "handoff") handoff.push(this.options.toTabDto(tab, row));
      } catch (error) {
        if (!this.options.isTabGoneError(error)) throw error;
        session.tabs.delete(tabId);
        session.attachedTabIds.delete(tabId);
        await this.options.removeManagedTab(tabId);
        changed = true;
      }
    }

    for (const [tabId, row] of [...session.finalizedTabs]) {
      try {
        deliverable.push(this.options.toTabDto(await this.options.getTab(tabId), row));
      } catch (error) {
        if (!this.options.isTabGoneError(error)) throw error;
        session.finalizedTabs.delete(tabId);
        await this.options.removeManagedTab(tabId);
        changed = true;
      }
    }

    if (changed) this.options.syncSessionGroupMirrors(session);
    return {
      handoff,
      deliverable,
      activeTabId: session.activeTabId ?? null,
    };
  }
}

function summarizeFinalizeFailure(failure: FinalizeTabFailure): BrowserSessionFinalizeFailureSummary {
  return {
    ...(failure.tabId !== undefined ? { tabId: failure.tabId } : {}),
    ...(failure.desiredStatus !== undefined ? { desiredStatus: failure.desiredStatus } : {}),
    errorCode: failure.errorCode,
    errorMessage: failure.errorMessage,
  };
}

import type { BrowserSession, BrowserSessionCleanupFailureSummary } from "./session_store.js";
import {
  activeSessionLifecycle,
  attachedDebuggerTabIds,
  planCleanupSessionTabs,
  type SessionCleanupMode,
} from "./lifecycle/browser_session_machine.js";
import {
  planTabRemoved,
  planTabReplaced,
} from "./lifecycle/tab_ownership_machine.js";
import type { PendingExtensionUpdateTrigger } from "./overlay_coordinator.js";

type DebugLogLevel = "debug" | "info" | "warn" | "error";

export type CleanupBrowserTabsResult = {
  closedTabs: number;
  releasedTabs: number;
  keptDeliverables: number;
  failures?: CleanupBrowserTabFailure[];
};

export type CleanupBrowserTabFailure = {
  tabId: number;
  effect: "close_agent_tab" | "release_controlled_tab";
  message: string;
};

type CleanupSessionTabsResult = CleanupBrowserTabsResult & { changed: boolean };

type TabLifecycleControllerOptions = {
  sessions(): Iterable<BrowserSession>;
  sessionEntries(): Iterable<[string, BrowserSession]>;
  forgetOverlay(tabId: number): void;
  activeOverlayTabIds(): number[];
  replaceOverlayTabId(removedTabId: number, addedTabId: number): Promise<void>;
  hideCursor(tabId: number): Promise<void>;
  removeManagedTab(tabId: number): Promise<void>;
  replaceManagedTab(removedTabId: number, addedTabId: number): Promise<void>;
  releaseManagedTab(tabId: number): Promise<void>;
  closeAgentTabWithDialogPolicy(
    sessionId: string,
    session: BrowserSession,
    tabId: number,
    operation: string,
  ): Promise<void>;
  cleanupControlledTab(session: BrowserSession, tabId: number): Promise<void>;
  detachDebugger(tabId: number): Promise<void>;
  removeDownloadOwnersForTab(tabId: number): void;
  syncSessionGroupMirrors(session: BrowserSession): void;
  syncAllSessionGroupMirrors(): void;
  countDeliverableTabs(): number;
  pruneEmptySessions(): void;
  persistSessionState(): Promise<void>;
  handleForegroundTabChanged(tabId: number, reason: "tab_replaced"): Promise<void>;
  appendDebugLog(level: DebugLogLevel, event: string, data?: unknown): void;
  schedulePendingExtensionUpdateCheck(trigger: PendingExtensionUpdateTrigger): void;
};

export class TabLifecycleController {
  constructor(private readonly options: TabLifecycleControllerOptions) {}

  async handleTabRemoved(tabId: number): Promise<void> {
    this.options.forgetOverlay(tabId);
    let changed = false;
    for (const session of this.options.sessions()) {
      const plan = planTabRemoved(session, tabId);
      if (plan.removeActiveTab) session.tabs.delete(tabId);
      if (plan.activeTabRepair.kind === "select") session.activeTabId = plan.activeTabRepair.tabId;
      if (plan.activeTabRepair.kind === "clear") delete session.activeTabId;
      if (plan.removeFinalizedTab) session.finalizedTabs.delete(tabId);
      if (plan.removeAttachedDebugger) session.attachedTabIds.delete(tabId);
      if (plan.changed) changed = true;
    }
    await this.options.removeManagedTab(tabId);
    this.options.syncAllSessionGroupMirrors();
    this.options.removeDownloadOwnersForTab(tabId);
    if (changed) await this.options.persistSessionState();
    this.options.appendDebugLog("info", "tab.removed", { tabId });
    this.options.schedulePendingExtensionUpdateCheck("tab_removed");
  }

  async handleTabReplaced(addedTabId: number, removedTabId: number): Promise<void> {
    let changed = false;
    for (const session of this.options.sessions()) {
      const plan = planTabReplaced(session, removedTabId, addedTabId);
      if (plan.activeRow) {
        session.tabs.delete(removedTabId);
        session.tabs.set(addedTabId, plan.activeRow);
      }
      if (plan.updateActiveTab) session.activeTabId = addedTabId;
      if (plan.finalizedRow) {
        session.finalizedTabs.delete(removedTabId);
        session.finalizedTabs.set(addedTabId, plan.finalizedRow);
      }
      if (plan.removeAttachedDebugger) session.attachedTabIds.delete(removedTabId);
      if (plan.changed) changed = true;
    }
    await this.options.replaceOverlayTabId(removedTabId, addedTabId);
    await this.options.replaceManagedTab(removedTabId, addedTabId);
    this.options.syncAllSessionGroupMirrors();
    if (changed) await this.options.persistSessionState();
    await this.options.handleForegroundTabChanged(addedTabId, "tab_replaced");
    this.options.appendDebugLog("info", "tab.replaced", { addedTabId, removedTabId });
  }

  async cleanupAllSessionTabs(mode: SessionCleanupMode): Promise<CleanupBrowserTabsResult> {
    const controlledTabIds = new Set<number>();
    for (const tabId of this.options.activeOverlayTabIds()) controlledTabIds.add(tabId);
    for (const session of this.options.sessions()) {
      for (const tabId of session.tabs.keys()) controlledTabIds.add(tabId);
      for (const tabId of session.attachedTabIds) controlledTabIds.add(tabId);
    }
    for (const tabId of controlledTabIds) {
      await this.options.hideCursor(tabId);
    }
    const result: CleanupBrowserTabsResult = {
      closedTabs: 0,
      releasedTabs: 0,
      keptDeliverables: this.options.countDeliverableTabs(),
    };
    let changed = false;
    for (const [sessionId, session] of this.options.sessionEntries()) {
      const sessionResult = await this.cleanupSessionTabs(sessionId, session, mode);
      result.closedTabs += sessionResult.closedTabs;
      result.releasedTabs += sessionResult.releasedTabs;
      result.keptDeliverables += sessionResult.keptDeliverables;
      if (sessionResult.failures?.length) {
        result.failures ??= [];
        result.failures.push(...sessionResult.failures);
      }
      changed = sessionResult.changed || changed;
    }
    this.options.pruneEmptySessions();
    if (changed) await this.options.persistSessionState();
    return result;
  }

  private async cleanupSessionTabs(
    sessionId: string,
    session: BrowserSession,
    mode: SessionCleanupMode,
  ): Promise<CleanupSessionTabsResult> {
    const result: CleanupSessionTabsResult = {
      closedTabs: 0,
      releasedTabs: 0,
      keptDeliverables: 0,
      changed: false,
    };
    for (const step of planCleanupSessionTabs(session, mode)) {
      const { tabId } = step;
      if (step.effect === "close_agent_tab") {
        try {
          await this.options.closeAgentTabWithDialogPolicy(sessionId, session, tabId, "cleanupBrowserTabs");
          await this.options.removeManagedTab(tabId);
          session.tabs.delete(tabId);
          session.finalizedTabs.delete(tabId);
          result.changed = true;
          result.closedTabs += 1;
        } catch (error) {
          result.failures ??= [];
          result.failures.push({ tabId, effect: step.effect, message: errorMessage(error) });
        }
        continue;
      }
      try {
        await this.options.cleanupControlledTab(session, tabId);
        await this.options.releaseManagedTab(tabId);
        session.tabs.delete(tabId);
        session.finalizedTabs.delete(tabId);
        result.releasedTabs += 1;
        result.changed = true;
      } catch (error) {
        result.failures ??= [];
        result.failures.push({ tabId, effect: step.effect, message: errorMessage(error) });
      }
    }
    for (const tabId of attachedDebuggerTabIds(session)) {
      try {
        await this.options.detachDebugger(tabId);
      } catch {
        // Ignore detach races during cleanup.
      }
      session.attachedTabIds.delete(tabId);
      result.changed = true;
    }
    if (result.failures?.length) {
      session.lifecycle = {
        kind: "cleanup_failed",
        ...(session.currentTurnId ? { turnId: session.currentTurnId } : {}),
        failures: result.failures.map(cleanupFailureSummary),
      };
      result.changed = true;
    } else if (session.lifecycle.kind === "cleanup_failed") {
      if (this.recordedFailuresResolved(session, session.lifecycle.failures)) {
        session.lifecycle = activeSessionLifecycle(session.activeTabId);
        result.changed = true;
      }
      // else: keep cleanup_failed until an explicit repair pass clears them
    }
    this.options.syncSessionGroupMirrors(session);
    return result;
  }

  private recordedFailuresResolved(
    session: BrowserSession,
    failures: BrowserSessionCleanupFailureSummary[],
  ): boolean {
    return failures.every((failure) => {
      // A failure without a tabId cannot be verified by tab id; treat as resolved
      // to avoid permanently locking the session in cleanup_failed.
      if (failure.tabId === undefined) return true;
      return !session.tabs.has(failure.tabId)
        && !session.attachedTabIds.has(failure.tabId);
    });
  }
}

function cleanupFailureSummary(failure: CleanupBrowserTabFailure): BrowserSessionCleanupFailureSummary {
  return {
    tabId: failure.tabId,
    errorMessage: failure.message,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

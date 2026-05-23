import type { BrowserSession } from "./session_store.js";
import {
  activeSessionLifecycle,
  planForegroundLogicalActiveUpdate,
} from "./lifecycle/browser_session_machine.js";
import {
  planForegroundTabChanged,
  planWindowFocusChanged,
  type ForegroundChangeReason,
} from "./lifecycle/foreground_observer_machine.js";

export type ForegroundObserverSessionOwner = {
  sessionId: string;
  session: BrowserSession;
};

export type ForegroundObserverDebugLog = (
  level: "debug" | "info" | "warn" | "error",
  event: string,
  data?: unknown,
) => void;

export class ForegroundObserver {
  constructor(
    private readonly deps: {
      queryActiveTab(windowId: number): Promise<ChromeTab | undefined>;
      findSessionForTab(tabId: number): ForegroundObserverSessionOwner | undefined;
      persistSessionState(): Promise<void>;
      syncForeground(): Promise<void>;
      appendDebugLog: ForegroundObserverDebugLog;
    },
  ) {}

  async handleWindowFocusChanged(windowId: number): Promise<void> {
    const plan = planWindowFocusChanged(windowId);
    if (plan.kind === "sync_foreground") {
      await this.deps.syncForeground();
      return;
    }
    const activeTab = await this.deps.queryActiveTab(plan.windowId);
    await this.handleForegroundTabChanged(activeTab?.id, plan.reason);
  }

  async handleForegroundTabChanged(tabId: number | undefined, reason: ForegroundChangeReason): Promise<void> {
    let owner: ForegroundObserverSessionOwner | undefined;
    let logicalActiveTabId: number | undefined;
    if (Number.isInteger(tabId)) {
      owner = this.deps.findSessionForTab(tabId!);
      if (owner) {
        const sessionPlan = planForegroundLogicalActiveUpdate(owner.session, tabId!);
        logicalActiveTabId = sessionPlan.shouldUpdate ? sessionPlan.tabId : undefined;
      }
    }
    const plan = planForegroundTabChanged({
      tabId,
      reason,
      ...(owner ? { owner: { sessionId: owner.sessionId, logicalActiveTabId } } : {}),
    });
    if (plan.logicalActiveUpdate && owner) {
      if (owner.session.lifecycle.kind === "active") {
        owner.session.activeTabId = plan.logicalActiveUpdate.tabId;
        owner.session.lifecycle = activeSessionLifecycle(plan.logicalActiveUpdate.tabId);
        await this.deps.persistSessionState();
        this.deps.appendDebugLog("debug", "tab.logical_active.foreground", plan.logicalActiveUpdate);
      }
    }
    await this.deps.syncForeground();
  }
}

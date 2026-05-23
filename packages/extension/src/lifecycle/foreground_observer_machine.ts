export type ForegroundChangeReason =
  | "tab_activated"
  | "tab_attached"
  | "tab_detached"
  | "tab_replaced"
  | "window_focus_changed";

export type WindowFocusPlan =
  | { kind: "sync_foreground" }
  | { kind: "query_active_tab"; windowId: number; reason: Extract<ForegroundChangeReason, "window_focus_changed"> };

export type ForegroundLogicalActiveUpdate = {
  sessionId: string;
  tabId: number;
  reason: ForegroundChangeReason;
};

export type ForegroundTabChangedPlan = {
  syncForeground: true;
  logicalActiveUpdate?: ForegroundLogicalActiveUpdate;
};

export function planWindowFocusChanged(windowId: number): WindowFocusPlan {
  if (!Number.isInteger(windowId) || windowId < 0) return { kind: "sync_foreground" };
  return { kind: "query_active_tab", windowId, reason: "window_focus_changed" };
}

export function planForegroundTabChanged(input: {
  tabId: number | undefined;
  reason: ForegroundChangeReason;
  owner?: { sessionId: string; logicalActiveTabId?: number };
}): ForegroundTabChangedPlan {
  if (!Number.isInteger(input.tabId) || !input.owner || input.owner.logicalActiveTabId === undefined) {
    return { syncForeground: true };
  }
  return {
    syncForeground: true,
    logicalActiveUpdate: {
      sessionId: input.owner.sessionId,
      tabId: input.owner.logicalActiveTabId,
      reason: input.reason,
    },
  };
}

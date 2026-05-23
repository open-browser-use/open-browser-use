import type { BrowserSession, SessionTab } from "../session_store.js";

export type TabPresentationState = {
  owned: boolean;
  claimRequired: boolean;
  commandable: boolean;
  logicalActive: boolean;
};

export type TabClaimPlan =
  | { kind: "claim" }
  | { kind: "reject"; message: string };

export type SelectedTabPlan =
  | { kind: "none" }
  | { kind: "owned_active"; state: TabPresentationState }
  | { kind: "claimable_user"; state: TabPresentationState };

export type TabRemovalPlan = {
  removeActiveTab: boolean;
  removeFinalizedTab: boolean;
  removeAttachedDebugger: boolean;
  activeTabRepair:
    | { kind: "unchanged" }
    | { kind: "clear" }
    | { kind: "select"; tabId: number };
  changed: boolean;
};

export type TabReplacementPlan = {
  activeRow?: SessionTab;
  finalizedRow?: SessionTab;
  updateActiveTab: boolean;
  removeAttachedDebugger: boolean;
  changed: boolean;
};

export function isRestrictedBrowserUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /^(chrome|edge|brave|arc|chromium|about|devtools|chrome-extension):/i.test(url);
}

export function isClaimableUserTabInfo(tab: { id?: number; url?: string }): boolean {
  return Number.isInteger(tab.id) && !isRestrictedBrowserUrl(tab.url);
}

export function isTabOwnedByAnotherSession(
  sessions: Iterable<[string, { tabs: ReadonlyMap<number, unknown> }]>,
  sessionId: string,
  tabId: number,
): boolean {
  for (const [id, session] of sessions) {
    if (id !== sessionId && session.tabs.has(tabId)) return true;
  }
  return false;
}

export function ownedActiveTabState(controlState: BrowserSession["controlState"], logicalActive: boolean): TabPresentationState {
  return {
    owned: true,
    claimRequired: false,
    commandable: controlState !== "human_takeover",
    logicalActive,
  };
}

export function claimableUserTabState(): TabPresentationState {
  return {
    owned: false,
    claimRequired: true,
    commandable: false,
    logicalActive: false,
  };
}

export function planClaimUserTab(input: {
  tabId: number;
  claimable: boolean;
  ownedByAnotherSession: boolean;
}): TabClaimPlan {
  if (!input.claimable) return { kind: "reject", message: `tab ${input.tabId} cannot be claimed by open-browser-use` };
  if (input.ownedByAnotherSession) {
    return { kind: "reject", message: `tab ${input.tabId} is already owned by another open-browser-use session` };
  }
  return { kind: "claim" };
}

export function planSelectedTab(input: {
  row: SessionTab | undefined;
  claimable: boolean;
  ownedByAnotherSession: boolean;
  controlState: BrowserSession["controlState"];
}): SelectedTabPlan {
  if (input.row?.status === "active") {
    return { kind: "owned_active", state: ownedActiveTabState(input.controlState, true) };
  }
  if (!input.claimable || input.ownedByAnotherSession) return { kind: "none" };
  return { kind: "claimable_user", state: claimableUserTabState() };
}

export function planTabRemoved(session: BrowserSession, tabId: number): TabRemovalPlan {
  const removeActiveTab = session.tabs.has(tabId);
  const removeFinalizedTab = session.finalizedTabs.has(tabId);
  const removeAttachedDebugger = session.attachedTabIds.has(tabId);
  const activeTabRepair = planActiveTabRepairAfterRemoval(session, tabId);
  return {
    removeActiveTab,
    removeFinalizedTab,
    removeAttachedDebugger,
    activeTabRepair,
    changed: removeActiveTab || removeFinalizedTab || removeAttachedDebugger || activeTabRepair.kind !== "unchanged",
  };
}

function planActiveTabRepairAfterRemoval(session: BrowserSession, removedTabId: number): TabRemovalPlan["activeTabRepair"] {
  if (session.activeTabId === undefined) return { kind: "unchanged" };
  const currentActiveRow = session.tabs.get(session.activeTabId);
  const currentActiveRemains =
    session.activeTabId !== removedTabId &&
    currentActiveRow !== undefined &&
    currentActiveRow.status === "active";
  if (currentActiveRemains) return { kind: "unchanged" };
  for (const [candidateTabId, row] of session.tabs) {
    if (candidateTabId !== removedTabId && row.status === "active") {
      return { kind: "select", tabId: candidateTabId };
    }
  }
  return { kind: "clear" };
}

export function planTabReplaced(session: BrowserSession, removedTabId: number, addedTabId: number): TabReplacementPlan {
  const activeRow = session.tabs.get(removedTabId);
  const finalizedRow = session.finalizedTabs.get(removedTabId);
  const removeAttachedDebugger = session.attachedTabIds.has(removedTabId);
  return {
    ...(activeRow ? { activeRow: { ...activeRow, tabId: addedTabId } } : {}),
    ...(finalizedRow ? { finalizedRow: { ...finalizedRow, tabId: addedTabId } } : {}),
    updateActiveTab: activeRow !== undefined && session.activeTabId === removedTabId,
    removeAttachedDebugger,
    changed: activeRow !== undefined || finalizedRow !== undefined || removeAttachedDebugger,
  };
}

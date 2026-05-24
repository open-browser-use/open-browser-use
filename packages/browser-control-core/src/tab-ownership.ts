import type { SessionTab } from "./session.js";

export type TabPresentationState =
  | { kind: "commandable"; tab: SessionTab }
  | { kind: "claim_required"; tab: SessionTab }
  | { kind: "owned_by_other_session"; tab: SessionTab };

export function presentSessionTab(tab: SessionTab, ownedByCurrentSession: boolean): TabPresentationState {
  if (ownedByCurrentSession && tab.status === "active") return { kind: "commandable", tab };
  if (!ownedByCurrentSession) return { kind: "owned_by_other_session", tab };
  return { kind: "claim_required", tab };
}

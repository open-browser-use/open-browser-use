export type TabOrigin = "agent" | "user";
export type TabStatus = "active" | "handoff" | "deliverable";

export type SessionTab = {
  tabId: number;
  origin: TabOrigin;
  status: TabStatus;
};

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

export function activeSessionLifecycle(activeTabId: number | undefined): BrowserSessionLifecycle {
  return activeTabId === undefined ? { kind: "active" } : { kind: "active", activeTabId };
}

export function humanTakeoverLifecycle(activeTabId: number | undefined): BrowserSessionLifecycle {
  return activeTabId === undefined ? { kind: "human_takeover" } : { kind: "human_takeover", activeTabId };
}

export function assertSessionAcceptsAction(lifecycle: BrowserSessionLifecycle, operation: string): void {
  switch (lifecycle.kind) {
    case "active":
      return;
    case "human_takeover":
      throw new Error(`${operation} rejected because browser control is yielded to the human; call resumeControl first`);
    case "resuming":
      throw new Error(`${operation} rejected because browser control is resuming`);
    case "finalizing":
    case "finalize_partial":
    case "finalize_failed":
    case "cleanup_failed":
    case "stale":
      throw new Error(`${operation} rejected because browser session is ${lifecycle.kind}`);
  }
}

// Turn-lifecycle helpers are pure, so they move to core too. Signatures match the
// extension's browser_session_machine.ts exactly so the extension can re-export them.
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

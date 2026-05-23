export type OverlayCursorTarget = {
  x: number;
  y: number;
  sequence?: number;
};

export type OverlayTakeoverState = {
  sessionId: string;
  turnId: string;
  lockInputs: boolean;
  lastCursor?: OverlayCursorTarget;
};

export type OverlayLifecycleState =
  | { kind: "active"; takeover: OverlayTakeoverState }
  | { kind: "release_pending"; takeover: OverlayTakeoverState }
  | { kind: "release_failed"; takeover: OverlayTakeoverState; failures: number };

export type OverlayActivationPlan = {
  state: OverlayTakeoverState;
  sendSavedCursor: boolean;
};

export type OverlayReplacementPlan =
  | { kind: "drop" }
  | { kind: "replace"; state: OverlayTakeoverState };

export type CursorArrival = {
  sequence: number;
  sessionId?: unknown;
  turnId?: unknown;
};

export type CursorArrivalWaiterIdentity = {
  sessionId: string;
  turnId: string;
};

export type CursorArrivalPlan =
  | { kind: "ignore" }
  | { kind: "arrived"; sequence: number };

export type ContentScriptPreparationPlan =
  | { kind: "ready" }
  | { kind: "await_pending" }
  | { kind: "inject" };

export type OverlayReleaseRequestPlan =
  | { kind: "noop" }
  | { kind: "send_hide"; next: OverlayLifecycleState };

export function planOverlayActivation(input: {
  previous?: OverlayTakeoverState;
  sessionId: string;
  turnId: string;
  savedCursor?: OverlayCursorTarget;
  rehydrateCursor: boolean;
}): OverlayActivationPlan {
  const state: OverlayTakeoverState = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    lockInputs: true,
    lastCursor: input.previous?.lastCursor ?? input.savedCursor,
  };
  return {
    state,
    sendSavedCursor: state.lastCursor !== undefined && input.rehydrateCursor,
  };
}

export function planOverlayReplacement(state: OverlayTakeoverState | undefined): OverlayReplacementPlan {
  if (!state) return { kind: "drop" };
  return { kind: "replace", state };
}

export function activeOverlayState(takeover: OverlayTakeoverState): OverlayLifecycleState {
  return { kind: "active", takeover };
}

export function releasePendingOverlayState(takeover: OverlayTakeoverState): OverlayLifecycleState {
  return { kind: "release_pending", takeover };
}

export function releaseFailedOverlayState(takeover: OverlayTakeoverState, failures: number): OverlayLifecycleState {
  return { kind: "release_failed", takeover, failures };
}

export function overlayTakeoverState(state: OverlayLifecycleState | undefined): OverlayTakeoverState | undefined {
  return state?.takeover;
}

export function planOverlayReleaseRequest(state: OverlayLifecycleState | undefined): OverlayReleaseRequestPlan {
  if (!state) return { kind: "noop" };
  const next = state.kind === "release_pending" || state.kind === "release_failed"
    ? releaseFailedOverlayState(state.takeover, state.kind === "release_failed" ? state.failures + 1 : 1)
    : releasePendingOverlayState(state.takeover);
  return { kind: "send_hide", next };
}

export function planOverlayReleaseResult(
  state: OverlayLifecycleState | undefined,
  hideAcknowledged: boolean,
): OverlayLifecycleState | undefined {
  if (!state || (state.kind !== "release_pending" && state.kind !== "release_failed")) return state;
  return hideAcknowledged ? undefined : state;
}

export function parseCursorArrival(value: unknown): CursorArrival | undefined {
  if (!isRecord(value) || typeof value.sequence !== "number") return undefined;
  return {
    sequence: value.sequence,
    sessionId: value.sessionId,
    turnId: value.turnId,
  };
}

export function planCursorArrival(
  arrival: CursorArrival | undefined,
  waiter: CursorArrivalWaiterIdentity | undefined,
): CursorArrivalPlan {
  if (!arrival || !waiter) return { kind: "ignore" };
  if (arrival.sessionId !== waiter.sessionId) return { kind: "ignore" };
  if (arrival.turnId !== waiter.turnId) return { kind: "ignore" };
  return { kind: "arrived", sequence: arrival.sequence };
}

export function planContentScriptPreparation(input: {
  pingSucceeded: boolean;
  preparationPending: boolean;
}): ContentScriptPreparationPlan {
  if (input.pingSucceeded) return { kind: "ready" };
  if (input.preparationPending) return { kind: "await_pending" };
  return { kind: "inject" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

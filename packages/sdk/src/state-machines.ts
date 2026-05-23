export type ObserveRequestState =
  | "requested"
  | "preflight"
  | "reading_backend"
  | "composing_snapshot"
  | "succeeded"
  | "partial"
  | "blocked"
  | "failed"
  | "cancelled";

export type ActionRuntimeState =
  | "planned"
  | "preflight"
  | "running"
  | "waiting_for_effect"
  | "reconciling"
  | "succeeded"
  | "blocked"
  | "failed"
  | "cancelled";

export type StateTraceEntry<S extends string> = {
  state: S;
  at: number;
};

export class StateTrace<S extends string> {
  readonly history: StateTraceEntry<S>[];
  private readonly initial: S;

  constructor(
    initial: S,
    private readonly transitions: Readonly<Record<S, readonly S[]>>,
    now: () => number = Date.now,
  ) {
    this.initial = initial;
    this.history = [{ state: initial, at: now() }];
    this.now = now;
  }

  private readonly now: () => number;

  get state(): S {
    return this.history[this.history.length - 1]?.state ?? this.initial;
  }

  transition(next: S): void {
    const allowed = this.transitions[this.state] ?? [];
    if (!allowed.includes(next)) {
      throw new Error(`invalid state transition ${this.state} -> ${next}`);
    }
    this.history.push({ state: next, at: this.now() });
  }
}

export const OBSERVE_REQUEST_TRANSITIONS: Readonly<Record<ObserveRequestState, readonly ObserveRequestState[]>> = {
  requested: ["preflight"],
  preflight: ["blocked", "reading_backend", "failed", "cancelled"],
  reading_backend: ["composing_snapshot", "partial", "failed", "cancelled"],
  composing_snapshot: ["succeeded", "partial", "blocked", "failed", "cancelled"],
  succeeded: [],
  partial: [],
  blocked: [],
  failed: [],
  cancelled: [],
};

export const ACTION_RUNTIME_TRANSITIONS: Readonly<Record<ActionRuntimeState, readonly ActionRuntimeState[]>> = {
  planned: ["preflight"],
  preflight: ["blocked", "running", "failed", "cancelled"],
  running: ["waiting_for_effect", "failed", "cancelled"],
  waiting_for_effect: ["reconciling", "failed", "cancelled"],
  reconciling: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  blocked: [],
  failed: [],
  cancelled: [],
};

export function createObserveStateTrace(): StateTrace<ObserveRequestState> {
  return new StateTrace("requested", OBSERVE_REQUEST_TRANSITIONS);
}

export function createActionStateTrace(): StateTrace<ActionRuntimeState> {
  return new StateTrace("planned", ACTION_RUNTIME_TRANSITIONS);
}

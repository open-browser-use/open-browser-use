import type { PendingExtensionUpdateTrigger } from "../overlay_coordinator.js";
import type { NativeHostState } from "./native_transport_machine.js";

export type PendingExtensionUpdate = {
  version?: string;
  pendingSince: number;
} & (
  | { state: "waiting_for_idle"; reasons?: BrowserControlActivityReason[] }
  | { state: "blocked"; reasons: BrowserControlActivityReason[]; blockedSince: number; nextAction: "repair_lifecycle" | "stop_control" | "manual_ack" }
  | { state: "reloading"; reloadingAt: number }
  | { state: "acknowledged_deferred"; acknowledgedAt: number; reason: string }
);

export type BrowserControlActivityReason =
  | "active_takeover"
  | "overlay_pending"
  | "debugger_attach_lock"
  | "native_request_pending"
  | "native_hello_pending"
  | "native_reconnect_pending"
  | "active_session_tab"
  | "debugger_attached";

export type BrowserControlActivitySnapshot = {
  active: boolean;
  reasons: BrowserControlActivityReason[];
};

export type BrowserControlActivitySignals = {
  activeTakeoverCount: number;
  overlayPendingActivity: boolean;
  debuggerAttachLockCount: number;
  nativePendingRequests: boolean;
  nativeState: NativeHostState;
  nativeHelloPending: boolean;
  nativeReconnectPending: boolean;
  activeSessionTabCount: number;
  debuggerAttachedTabCount: number;
};

export type PendingExtensionUpdateCheckPlan =
  | { kind: "none" }
  | { kind: "queue"; trigger: PendingExtensionUpdateTrigger; shouldScheduleTimer: false }
  | { kind: "schedule"; trigger: PendingExtensionUpdateTrigger; shouldScheduleTimer: true };

export type ApplyPendingExtensionUpdatePlan =
  | { kind: "none" }
  | { kind: "wait_for_idle"; pending: PendingExtensionUpdate; reasons: BrowserControlActivityReason[]; ageMs: number }
  | { kind: "blocked"; pending: PendingExtensionUpdate; reasons: BrowserControlActivityReason[]; ageMs: number; nextAction: "repair_lifecycle" | "stop_control" | "manual_ack" }
  | { kind: "reload"; pending: PendingExtensionUpdate; version?: string };

export const DEFAULT_UPDATE_BLOCK_AFTER_MS = 30_000;

export function parsePendingExtensionUpdate(value: unknown): PendingExtensionUpdate | undefined {
  if (!isRecord(value)) return undefined;
  if (value.state !== "waiting_for_idle" && value.state !== "blocked" && value.state !== "reloading" && value.state !== "acknowledged_deferred") {
    return undefined;
  }
  const pendingSince = optionalNumber(value.pendingSince);
  if (pendingSince === undefined) return undefined;
  const version = typeof value.version === "string" && value.version.length > 0 ? value.version : undefined;
  const base = { pendingSince, ...(version ? { version } : {}) };
  if (value.state === "waiting_for_idle") {
    const reasons = parseReasons(value.reasons);
    return { ...base, state: "waiting_for_idle", ...(reasons.length > 0 ? { reasons } : {}) };
  }
  if (value.state === "blocked") {
    const blockedSince = optionalNumber(value.blockedSince);
    const reasons = parseReasons(value.reasons);
    const nextAction = parseNextAction(value.nextAction);
    return blockedSince !== undefined && reasons.length > 0 && nextAction
      ? { ...base, state: "blocked", blockedSince, reasons, nextAction }
      : undefined;
  }
  if (value.state === "reloading") {
    const reloadingAt = optionalNumber(value.reloadingAt);
    return reloadingAt !== undefined ? { ...base, state: "reloading", reloadingAt } : undefined;
  }
  const acknowledgedAt = optionalNumber(value.acknowledgedAt);
  return acknowledgedAt !== undefined && typeof value.reason === "string"
    ? { ...base, state: "acknowledged_deferred", acknowledgedAt, reason: value.reason }
    : undefined;
}

export function createPendingExtensionUpdate(
  details: { version?: unknown },
  now: number,
): PendingExtensionUpdate {
  const version = typeof details.version === "string" && details.version.length > 0 ? details.version : undefined;
  return { pendingSince: now, state: "waiting_for_idle", ...(version ? { version } : {}) };
}

export function statusWithPendingExtensionUpdate<T extends { pendingExtensionUpdate?: PendingExtensionUpdate }>(
  current: T,
  pending: PendingExtensionUpdate | undefined,
): T {
  const next = { ...current };
  if (pending) {
    next.pendingExtensionUpdate = pending;
  } else {
    delete next.pendingExtensionUpdate;
  }
  return next;
}

export function planPendingExtensionUpdateCheck(input: {
  pending: PendingExtensionUpdate | undefined;
  timerActive: boolean;
  trigger: PendingExtensionUpdateTrigger;
}): PendingExtensionUpdateCheckPlan {
  if (!input.pending) return { kind: "none" };
  if (input.timerActive) {
    return { kind: "queue", trigger: input.trigger, shouldScheduleTimer: false };
  }
  return { kind: "schedule", trigger: input.trigger, shouldScheduleTimer: true };
}

export function queuedPendingExtensionUpdateTrigger(
  queued: PendingExtensionUpdateTrigger | undefined,
  fallback: PendingExtensionUpdateTrigger,
): PendingExtensionUpdateTrigger {
  return queued ?? fallback;
}

export function snapshotBrowserControlActivity(
  signals: BrowserControlActivitySignals,
): BrowserControlActivitySnapshot {
  const reasons: BrowserControlActivityReason[] = [];
  if (signals.activeTakeoverCount > 0) reasons.push("active_takeover");
  if (signals.overlayPendingActivity) reasons.push("overlay_pending");
  if (signals.debuggerAttachLockCount > 0) reasons.push("debugger_attach_lock");
  if (signals.nativePendingRequests) reasons.push("native_request_pending");
  if (signals.nativeState === "connecting" || signals.nativeState === "hello_pending" || signals.nativeHelloPending) reasons.push("native_hello_pending");
  if (signals.nativeReconnectPending) reasons.push("native_reconnect_pending");
  if (signals.activeSessionTabCount > 0) reasons.push("active_session_tab");
  if (signals.debuggerAttachedTabCount > 0) reasons.push("debugger_attached");
  const uniqueReasons = [...new Set(reasons)];
  return { active: uniqueReasons.length > 0, reasons: uniqueReasons };
}

export function planApplyPendingExtensionUpdate(input: {
  pending: PendingExtensionUpdate | undefined;
  activity: BrowserControlActivitySnapshot;
  now?: number;
  blockAfterMs?: number;
}): ApplyPendingExtensionUpdatePlan {
  if (!input.pending) return { kind: "none" };
  if (input.pending.state === "acknowledged_deferred") return { kind: "none" };
  const now = input.now ?? Date.now();
  const ageMs = Math.max(0, now - input.pending.pendingSince);
  const blockAfterMs = input.blockAfterMs ?? DEFAULT_UPDATE_BLOCK_AFTER_MS;
  if (input.activity.active) {
    const reasons = input.activity.reasons;
    const nextAction = nextActionForBlockers(reasons);
    if (input.pending.state === "blocked" || ageMs >= blockAfterMs) {
      const pending = {
        ...basePending(input.pending),
        state: "blocked" as const,
        blockedSince: input.pending.state === "blocked" ? input.pending.blockedSince : now,
        reasons,
        nextAction,
      };
      return { kind: "blocked", pending, reasons, ageMs, nextAction };
    }
    const pending = { ...basePending(input.pending), state: "waiting_for_idle" as const, reasons };
    return { kind: "wait_for_idle", pending, reasons, ageMs };
  }
  const pending = {
    ...basePending(input.pending),
    state: "reloading" as const,
    reloadingAt: now,
  };
  return { kind: "reload", pending, ...(input.pending.version ? { version: input.pending.version } : {}) };
}

export function acknowledgePendingExtensionUpdate(
  pending: PendingExtensionUpdate,
  reason: string,
  now: number,
): PendingExtensionUpdate {
  return {
    ...basePending(pending),
    state: "acknowledged_deferred",
    acknowledgedAt: now,
    reason,
  };
}

function basePending(pending: PendingExtensionUpdate): { version?: string; pendingSince: number } {
  return {
    pendingSince: pending.pendingSince,
    ...(pending.version ? { version: pending.version } : {}),
  };
}

function nextActionForBlockers(reasons: BrowserControlActivityReason[]): "repair_lifecycle" | "stop_control" | "manual_ack" {
  if (reasons.some((reason) => reason === "overlay_pending" || reason === "native_request_pending" || reason === "debugger_attach_lock")) {
    return "repair_lifecycle";
  }
  if (reasons.some((reason) => reason === "active_takeover" || reason === "active_session_tab" || reason === "debugger_attached")) {
    return "stop_control";
  }
  return "manual_ack";
}

function parseReasons(value: unknown): BrowserControlActivityReason[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isBrowserControlActivityReason))];
}

function parseNextAction(value: unknown): "repair_lifecycle" | "stop_control" | "manual_ack" | undefined {
  return value === "repair_lifecycle" || value === "stop_control" || value === "manual_ack" ? value : undefined;
}

function isBrowserControlActivityReason(value: unknown): value is BrowserControlActivityReason {
  return value === "active_takeover" ||
    value === "overlay_pending" ||
    value === "debugger_attach_lock" ||
    value === "native_request_pending" ||
    value === "native_hello_pending" ||
    value === "native_reconnect_pending" ||
    value === "active_session_tab" ||
    value === "debugger_attached";
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

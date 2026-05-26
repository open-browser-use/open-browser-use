export type NativeHostState =
  | "disconnected"
  | "connecting"
  | "hello_pending"
  | "connected"
  | "heartbeat_failed"
  | "reconnect_scheduled"
  | "version_mismatch"
  | "stopping"
  | "stopped"
  | "cleanup_failed"
  | "error";

export type NativeHostDiagnosis =
  | "native_host_not_found"
  | "native_host_forbidden"
  | "native_host_crashed"
  | "native_host_disconnected"
  | "native_host_hello_timeout"
  | "native_host_heartbeat_timeout"
  | "native_host_unavailable"
  | "version_mismatch";

export type NativeTransportStatusPatch = {
  state: NativeHostState;
  message?: string;
  diagnosis?: NativeHostDiagnosis;
  hostVersion?: string;
  retryDelayMs?: number;
  nextRetryAt?: number;
  updatedAt: number;
};

export type ReconnectPlan =
  | { shouldSchedule: false }
  | {
    shouldSchedule: true;
    delayMs: number;
    nextRetryAt: number;
    nextReconnectDelayMs: number;
    statusPatch: {
      state: "reconnect_scheduled";
      retryDelayMs: number;
      nextRetryAt: number;
      updatedAt: number;
    };
  };

export type RestorePendingReconnectPlan =
  | { shouldRestore: false }
  | {
    shouldRestore: true;
    retryDelayMs: number;
    nextRetryAt: number;
    nextReconnectDelayMs: number;
    updatedAt: number;
  };

export function canReconnect(input: { stopping: boolean; state: NativeHostState }): boolean {
  return !input.stopping &&
    input.state !== "stopping" &&
    input.state !== "stopped" &&
    input.state !== "cleanup_failed" &&
    input.state !== "connected" &&
    input.state !== "hello_pending" &&
    input.state !== "version_mismatch";
}

export function connectingStatus(now: number): NativeTransportStatusPatch {
  return { state: "connecting", updatedAt: now };
}

export function connectFailureStatus(
  message: string,
  diagnosis: NativeHostDiagnosis,
  now: number,
): NativeTransportStatusPatch {
  return { state: "error", message, diagnosis, updatedAt: now };
}

export function disconnectedStatus(input: {
  message: string;
  diagnosis: NativeHostDiagnosis;
  wasConnecting?: boolean;
  now: number;
}): NativeTransportStatusPatch {
  return {
    state: input.wasConnecting ? "error" : "disconnected",
    message: input.message,
    diagnosis: input.diagnosis,
    updatedAt: input.now,
  };
}

export function helloAckStatus(hostVersion: string | undefined, now: number): NativeTransportStatusPatch {
  return { state: "connected", hostVersion, updatedAt: now };
}

export function helloPendingStatus(now: number): NativeTransportStatusPatch {
  return { state: "hello_pending", updatedAt: now };
}

export function helloTimeoutStatus(now: number): NativeTransportStatusPatch {
  return {
    state: "error",
    message: "native host hello timed out",
    diagnosis: "native_host_hello_timeout",
    updatedAt: now,
  };
}

export function heartbeatFailureStatus(input: {
  message: string;
  diagnosis: NativeHostDiagnosis;
  now: number;
}): NativeTransportStatusPatch {
  return {
    state: "heartbeat_failed",
    message: input.message,
    diagnosis: input.diagnosis,
    updatedAt: input.now,
  };
}

export function versionMismatchStatus(message: string, now: number): NativeTransportStatusPatch {
  return {
    state: "version_mismatch",
    message,
    diagnosis: "version_mismatch",
    updatedAt: now,
  };
}

export function stoppedStatus(message: string, now: number): NativeTransportStatusPatch {
  return { state: "stopped", message, updatedAt: now };
}

export function stoppingStatus(message: string, now: number): NativeTransportStatusPatch {
  return { state: "stopping", message, updatedAt: now };
}

export function cleanupFailedStatus(message: string, now: number): NativeTransportStatusPatch {
  return { state: "cleanup_failed", message, updatedAt: now };
}

export function baseDisconnectedStatus(now: number): NativeTransportStatusPatch {
  return { state: "disconnected", updatedAt: now };
}

export function planReconnect(input: {
  stopping: boolean;
  state: NativeHostState;
  reconnectTimerActive: boolean;
  reconnectDelayMs: number;
  reconnectMaxMs: number;
  now: number;
}): ReconnectPlan {
  if (!canReconnect(input) || input.reconnectTimerActive) return { shouldSchedule: false };
  const delayMs = input.reconnectDelayMs;
  const nextRetryAt = input.now + delayMs;
  return {
    shouldSchedule: true,
    delayMs,
    nextRetryAt,
    nextReconnectDelayMs: Math.min(input.reconnectMaxMs, input.reconnectDelayMs * 2),
    statusPatch: {
      state: "reconnect_scheduled",
      retryDelayMs: delayMs,
      nextRetryAt,
      updatedAt: input.now,
    },
  };
}

export function planRestorePendingReconnect(input: {
  storedState: NativeHostState;
  storedRetryDelayMs?: number;
  storedNextRetryAt?: number;
  reconnectInitialMs: number;
  reconnectMaxMs: number;
  now: number;
}): RestorePendingReconnectPlan {
  if (input.storedState !== "disconnected" && input.storedState !== "error" && input.storedState !== "heartbeat_failed" && input.storedState !== "reconnect_scheduled") {
    return { shouldRestore: false };
  }
  if (input.storedNextRetryAt === undefined || input.storedNextRetryAt <= input.now) return { shouldRestore: false };
  const retryDelayMs = input.storedRetryDelayMs ?? input.reconnectInitialMs;
  return {
    shouldRestore: true,
    retryDelayMs,
    nextRetryAt: input.storedNextRetryAt,
    nextReconnectDelayMs: Math.min(input.reconnectMaxMs, Math.max(input.reconnectInitialMs, retryDelayMs * 2)),
    updatedAt: input.now,
  };
}

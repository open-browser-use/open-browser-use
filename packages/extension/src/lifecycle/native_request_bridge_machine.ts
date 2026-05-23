export type JsonRpcErrorObject = { code: number; message: string; data?: unknown };

export type NativeResponsePlan =
  | { kind: "missing" }
  | { kind: "error"; error: JsonRpcErrorObject }
  | { kind: "success"; result: unknown };

export type PendingRejectionLogPlan =
  | { shouldLog: false }
  | {
    shouldLog: true;
    level: "warn";
    event: "native.pending.rejected";
    data: { count: number; message: string };
  };

export function planNativeResponse(
  message: { result?: unknown; error?: JsonRpcErrorObject },
  hasPendingRequest: boolean,
): NativeResponsePlan {
  if (!hasPendingRequest) return { kind: "missing" };
  if (message.error) return { kind: "error", error: message.error };
  return { kind: "success", result: message.result };
}

export function planPendingRejection(count: number, message: string): PendingRejectionLogPlan {
  if (count <= 0) return { shouldLog: false };
  return {
    shouldLog: true,
    level: "warn",
    event: "native.pending.rejected",
    data: { count, message },
  };
}

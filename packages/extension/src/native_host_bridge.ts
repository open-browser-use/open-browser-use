import {
  planNativeResponse,
  planPendingRejection,
  type JsonRpcErrorObject,
} from "./lifecycle/native_request_bridge_machine.js";

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: JsonRpcErrorObject;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type DebugLogLevel = "debug" | "info" | "warn" | "error";

type PendingNativeRequest = {
  id: number;
  method: string;
  startedAt: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
};

export type NativeRequestLifecycleDiagnostic =
  | { kind: "pending"; id: number; method: string; startedAt: number; nextAction: "wait" }
  | { kind: "success"; id: number; method: string; completedAt: number }
  | { kind: "error"; id: number; method: string; completedAt: number; error: JsonRpcErrorObject; nextAction: "inspect_error" }
  | { kind: "rejected"; id: number; method: string; completedAt: number; message: string; nextAction: "reconnect_or_retry" }
  | { kind: "late_success"; id: number; method?: string; completedAt: number; nextAction: "observe_reconcile" }
  | { kind: "late_error"; id: number; method?: string; completedAt: number; error: JsonRpcErrorObject; nextAction: "inspect_error" };

const MAX_RECENT_NATIVE_REQUEST_DIAGNOSTICS = 50;

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: JsonRpcErrorObject) {
    super(error.message);
    this.name = "JsonRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

export function errorToJsonRpcError(error: unknown): JsonRpcErrorObject {
  if (error instanceof JsonRpcError) {
    return error.data === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, data: error.data };
  }
  return { code: -32000, message: errorMessage(error) };
}

export class NativeHostBridge {
  private nextId = 1;
  private pending = new Map<number, PendingNativeRequest>();
  private recent: NativeRequestLifecycleDiagnostic[] = [];

  constructor(
    private readonly currentPort: () => NativePort | null,
    private readonly appendDebugLog: (level: DebugLogLevel, event: string, data?: unknown) => void,
  ) {}

  hasPendingRequests(): boolean {
    return this.pending.size > 0;
  }

  diagnostics(): { pending: NativeRequestLifecycleDiagnostic[]; recent: NativeRequestLifecycleDiagnostic[] } {
    return {
      pending: [...this.pending.values()].map((request) => ({
        kind: "pending",
        id: request.id,
        method: request.method,
        startedAt: request.startedAt,
        nextAction: "wait",
      })),
      recent: [...this.recent],
    };
  }

  sendRequest(method: string, params?: unknown): Promise<unknown> {
    const port = this.currentPort();
    if (!port) return Promise.reject(new Error("native host is not connected"));
    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    this.appendDebugLog("debug", "native.outbound.request", { id, method });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { id, method, startedAt: Date.now(), resolve, reject });
      try {
        port.postMessage(request);
      } catch (error) {
        this.pending.delete(id);
        this.appendDebugLog("error", "native.outbound.failed", { id, method, message: errorMessage(error) });
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  sendNotification(method: string, params?: unknown): void {
    this.appendDebugLog("debug", "native.outbound.notification", { method });
    this.currentPort()?.postMessage({ jsonrpc: "2.0", method, params } satisfies JsonRpcNotification);
  }

  resolveResponse(message: JsonRpcResponse): boolean {
    const waiter = this.pending.get(message.id);
    const plan = planNativeResponse(message, waiter !== undefined);
    if (plan.kind === "missing") {
      if (message.error) {
        this.pushRecent({ kind: "late_error", id: message.id, completedAt: Date.now(), error: message.error, nextAction: "inspect_error" });
      } else {
        this.pushRecent({ kind: "late_success", id: message.id, completedAt: Date.now(), nextAction: "observe_reconcile" });
      }
      return false;
    }
    this.pending.delete(message.id);
    if (plan.kind === "error") {
      this.appendDebugLog("warn", "native.response.error", {
        id: message.id,
        code: plan.error.code,
        message: plan.error.message,
        data: plan.error.data,
      });
      this.pushRecent({
        kind: "error",
        id: message.id,
        method: waiter!.method,
        completedAt: Date.now(),
        error: plan.error,
        nextAction: "inspect_error",
      });
      waiter!.reject(new JsonRpcError(plan.error));
    } else {
      this.appendDebugLog("debug", "native.response.ok", { id: message.id });
      this.pushRecent({ kind: "success", id: message.id, method: waiter!.method, completedAt: Date.now() });
      waiter!.resolve(plan.result);
    }
    return true;
  }

  rejectPending(message: string): void {
    const log = planPendingRejection(this.pending.size, message);
    if (log.shouldLog) this.appendDebugLog(log.level, log.event, log.data);
    for (const waiter of this.pending.values()) {
      this.pushRecent({
        kind: "rejected",
        id: waiter.id,
        method: waiter.method,
        completedAt: Date.now(),
        message,
        nextAction: "reconnect_or_retry",
      });
      waiter.reject(new Error(message));
    }
    this.pending.clear();
  }

  private pushRecent(row: NativeRequestLifecycleDiagnostic): void {
    this.recent.push(row);
    while (this.recent.length > MAX_RECENT_NATIVE_REQUEST_DIAGNOSTICS) this.recent.shift();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

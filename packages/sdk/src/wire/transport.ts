import { ObuError, ERR_PROTOCOL, ERR_TIMEOUT, ERR_TRANSPORT_CLOSED, productErrorData } from "../errors.js";
import { FrameDecoder, FrameEncoder } from "./frames.js";
import type { NativePipeConnection } from "./pipe.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
  timeoutMs: number;
};

export type TransportRequestLifecycle =
  | {
      kind: "timed_out_pending_reconcile";
      requestId: number;
      method: string;
      timeoutMs: number;
      defensiveOvershootMs: number;
      timedOutAt: number;
      nextAction: "observe_reconcile";
    }
  | {
      kind: "timed_out_late_success";
      requestId: number;
      method: string;
      completedAt: number;
      nextAction: "observe_reconcile";
    }
  | {
      kind: "timed_out_late_error";
      requestId: number;
      method: string;
      completedAt: number;
      error: { code: number; message: string; data?: unknown };
      nextAction: "inspect_error";
    }
  | {
      kind: "timed_out_late_transport_closed";
      requestId: number;
      method: string;
      completedAt: number;
      reason: string;
      nextAction: "reconnect_or_retry";
    };

export type TransportDiagnostics = {
  request_lifecycle: TransportRequestLifecycle[];
};

type RpcResponse = {
  id?: unknown;
  result?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    data?: unknown;
  };
};

type ObuReplBackgroundTracker = {
  trackBackgroundOperation?: (operation: Promise<unknown>) => PromiseLike<unknown>;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const parsedOvershoot = Number(env?.OBU_DEFENSIVE_TIMEOUT_MS_OVERSHOOT);
const DEFENSIVE_OVERSHOOT_MS = Number.isFinite(parsedOvershoot) && parsedOvershoot >= 0
  ? parsedOvershoot
  : 5_000;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const MAX_REQUEST_LIFECYCLE_DIAGNOSTICS = 64;

export class Transport {
  #closed = false;
  #decoder = new FrameDecoder();
  #encoder = new FrameEncoder();
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #timedOutRequests = new Map<number, TransportRequestLifecycle>();
  #sessionIdOverride: string | undefined;

  constructor(private readonly connection: NativePipeConnection) {
    this.connection.on("data", (chunk) => this.#onData(chunk));
    this.connection.on("close", () => this.#onClose("transport closed"));
    this.connection.on("error", (error) => this.#onClose(String(error ?? "transport error")));
  }

  setSessionIdOverride(sessionId: string | undefined): this {
    this.#sessionIdOverride = sessionId;
    return this;
  }

  sendRequest<R = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    frameMeta?: { runtime?: { kernel_generation?: number } },
  ): Promise<R> {
    if (this.#closed) {
      return Promise.reject(new ObuError(
        ERR_TRANSPORT_CLOSED,
        "transport closed",
        productErrorData("transport_closed", { reason: "request was sent after transport closed" }),
      ));
    }

    const id = this.#nextId++;
    // The trusted runtime metadata (Finding F2) travels as a TOP-LEVEL `runtime`
    // field of the JSON-RPC frame — a sibling of `params`, never merged into it.
    // The host reads kernel_generation from this envelope and rejects
    // `runtime`/`_runtime` inside params. `runtime` is omitted entirely when no
    // frameMeta.runtime is supplied so existing requests stay byte-identical.
    const scopedParams = this.#sessionIdOverride
      ? { ...params, session_id: this.#sessionIdOverride }
      : params;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params: { ...scopedParams, client_timeout_ms: timeoutMs },
      ...(frameMeta?.runtime !== undefined ? { runtime: frameMeta.runtime } : {}),
    };

    const response = new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        this.#recordTimedOutRequest({
          kind: "timed_out_pending_reconcile",
          requestId: id,
          method,
          timeoutMs,
          defensiveOvershootMs: DEFENSIVE_OVERSHOOT_MS,
          timedOutAt: Date.now(),
          nextAction: "observe_reconcile",
        });
        reject(
          new ObuError(
            ERR_TIMEOUT,
            `defensive timeout: no response in ${timeoutMs + DEFENSIVE_OVERSHOOT_MS}ms`,
            productErrorData("timeout", {
              method: pending?.method ?? method,
              request_id: id,
              timeout_ms: timeoutMs,
              defensive_overshoot_ms: DEFENSIVE_OVERSHOOT_MS,
              lifecycle_state: "timed_out_pending_reconcile",
              next_action: "observe_reconcile",
            }),
          ),
        );
      }, timeoutMs + DEFENSIVE_OVERSHOOT_MS);
      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method,
        timeoutMs,
      });
    });

    const bytes = TEXT_ENCODER.encode(JSON.stringify(payload));
    try {
      // Pending is registered before write; an in-process transport may answer synchronously.
      this.connection.write(this.#encoder.encode(bytes));
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending) {
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      }
    }

    return trackObuReplBackgroundOperation(response);
  }

  close(): void {
    if (this.#closed) return;
    this.#onClose("client closed");
    this.connection.end();
  }

  diagnostics(): TransportDiagnostics {
    return {
      request_lifecycle: [...this.#timedOutRequests.values()],
    };
  }

  #onData(chunk: unknown): void {
    const bytes = toUint8Array(chunk);
    if (!bytes) return;
    let frames: Uint8Array[];
    try {
      frames = this.#decoder.feed(bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "frame decoder error");
      this.#onClose(`transport frame error: ${message}`, ERR_PROTOCOL);
      this.connection.end();
      return;
    }
    for (const frame of frames) {
      let message: RpcResponse;
      try {
        message = JSON.parse(TEXT_DECODER.decode(frame)) as RpcResponse;
      } catch {
        continue;
      }
      if (typeof message.id !== "number") continue;
      const pending = this.#pending.get(message.id);
      if (!pending) {
        this.#recordLateTimedOutResponse(message.id, message);
        continue;
      }
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);

      if (message.error) {
        const code = typeof message.error.code === "number" ? message.error.code : -1;
        const text = typeof message.error.message === "string" ? message.error.message : "rpc error";
        pending.reject(new ObuError(code, text, message.error.data));
        continue;
      }

      const result = message.result;
      if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        const sideEffects = Array.isArray(record.side_effects) ? record.side_effects : [];
        for (const item of sideEffects) {
          if (typeof item !== "string") continue;
          try {
            (globalThis as { display?: (value: string) => void }).display?.(item);
          } catch {
            // Display side effects must not break the transport response path.
          }
        }
        if ("value" in record) {
          pending.resolve(record.value);
          continue;
        }
      }
      pending.resolve(result);
    }
  }

  #onClose(reason: string, code = ERR_TRANSPORT_CLOSED): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [requestId, lifecycle] of this.#timedOutRequests) {
      if (lifecycle.kind !== "timed_out_pending_reconcile") continue;
      this.#recordTimedOutRequest({
        kind: "timed_out_late_transport_closed",
        requestId,
        method: lifecycle.method,
        completedAt: Date.now(),
        reason,
        nextAction: "reconnect_or_retry",
      });
    }
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ObuError(code, reason, productErrorForClosedTransport(code, reason)));
    }
    this.#pending.clear();
  }

  #recordLateTimedOutResponse(requestId: number, message: RpcResponse): void {
    const previous = this.#timedOutRequests.get(requestId);
    if (!previous) return;
    if (message.error) {
      this.#recordTimedOutRequest({
        kind: "timed_out_late_error",
        requestId,
        method: previous.method,
        completedAt: Date.now(),
        error: normalizeRpcError(message.error),
        nextAction: "inspect_error",
      });
      return;
    }
    this.#recordTimedOutRequest({
      kind: "timed_out_late_success",
      requestId,
      method: previous.method,
      completedAt: Date.now(),
      nextAction: "observe_reconcile",
    });
  }

  #recordTimedOutRequest(lifecycle: TransportRequestLifecycle): void {
    this.#timedOutRequests.set(lifecycle.requestId, lifecycle);
    while (this.#timedOutRequests.size > MAX_REQUEST_LIFECYCLE_DIAGNOSTICS) {
      const oldest = this.#timedOutRequests.keys().next().value;
      if (typeof oldest !== "number") break;
      this.#timedOutRequests.delete(oldest);
    }
  }
}

function trackObuReplBackgroundOperation<R>(operation: Promise<R>): Promise<R> {
  const tracker = (globalThis as { obuRepl?: ObuReplBackgroundTracker }).obuRepl?.trackBackgroundOperation;
  if (typeof tracker !== "function") return operation;
  try {
    const tracked = tracker(operation);
    if (tracked && typeof tracked.then === "function") return tracked as Promise<R>;
  } catch {
    // Tracking is observability/lifecycle glue. Never make an otherwise valid
    // browser RPC fail because the host runtime does not expose a tracker.
  }
  return operation;
}

function normalizeRpcError(error: NonNullable<RpcResponse["error"]>): { code: number; message: string; data?: unknown } {
  const normalized = {
    code: typeof error.code === "number" ? error.code : -1,
    message: typeof error.message === "string" ? error.message : "rpc error",
  } as { code: number; message: string; data?: unknown };
  if ("data" in error) normalized.data = error.data;
  return normalized;
}

function productErrorForClosedTransport(code: number, reason: string): Record<string, unknown> | undefined {
  if (code !== ERR_TRANSPORT_CLOSED) return undefined;
  return productErrorData("transport_closed", { reason });
}

function toUint8Array(chunk: unknown): Uint8Array | null {
  if (chunk instanceof Uint8Array) return chunk;
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  return null;
}

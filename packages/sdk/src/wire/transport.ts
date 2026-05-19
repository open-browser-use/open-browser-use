import { ObuError, ERR_PROTOCOL, ERR_TIMEOUT, ERR_TRANSPORT_CLOSED } from "../errors.js";
import { FrameDecoder, FrameEncoder } from "./frames.js";
import type { NativePipeConnection } from "./pipe.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
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

const DEFAULT_TIMEOUT_MS = 30_000;
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const parsedOvershoot = Number(env?.OBU_DEFENSIVE_TIMEOUT_MS_OVERSHOOT);
const DEFENSIVE_OVERSHOOT_MS = Number.isFinite(parsedOvershoot) && parsedOvershoot >= 0
  ? parsedOvershoot
  : 5_000;

export class Transport {
  #closed = false;
  #decoder = new FrameDecoder();
  #encoder = new FrameEncoder();
  #nextId = 1;
  #pending = new Map<number, Pending>();

  constructor(private readonly connection: NativePipeConnection) {
    this.connection.on("data", (chunk) => this.#onData(chunk));
    this.connection.on("close", () => this.#onClose("transport closed"));
    this.connection.on("error", (error) => this.#onClose(String(error ?? "transport error")));
  }

  async sendRequest<R = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<R> {
    if (this.#closed) {
      throw new ObuError(ERR_TRANSPORT_CLOSED, "transport closed");
    }

    const id = this.#nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params: { ...params, client_timeout_ms: timeoutMs },
    };

    const response = new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new ObuError(
            ERR_TIMEOUT,
            `defensive timeout: no response in ${timeoutMs + DEFENSIVE_OVERSHOOT_MS}ms`,
          ),
        );
      }, timeoutMs + DEFENSIVE_OVERSHOOT_MS);
      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });

    const bytes = new TextEncoder().encode(JSON.stringify(payload));
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

    return await response;
  }

  close(): void {
    if (this.#closed) return;
    this.#onClose("client closed");
    this.connection.end();
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
        message = JSON.parse(new TextDecoder().decode(frame)) as RpcResponse;
      } catch {
        continue;
      }
      if (typeof message.id !== "number") continue;
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
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
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ObuError(code, reason));
    }
    this.#pending.clear();
  }
}

function toUint8Array(chunk: unknown): Uint8Array | null {
  if (chunk instanceof Uint8Array) return chunk;
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  return null;
}

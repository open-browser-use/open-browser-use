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
  error?: { code: number; message: string; data?: unknown };
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type DebugLogLevel = "debug" | "info" | "warn" | "error";

type PendingNativeRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

export class NativeHostBridge {
  private nextId = 1;
  private pending = new Map<number, PendingNativeRequest>();

  constructor(
    private readonly currentPort: () => NativePort | null,
    private readonly appendDebugLog: (level: DebugLogLevel, event: string, data?: unknown) => void,
  ) {}

  hasPendingRequests(): boolean {
    return this.pending.size > 0;
  }

  sendRequest(method: string, params?: unknown): Promise<unknown> {
    const port = this.currentPort();
    if (!port) return Promise.reject(new Error("native host is not connected"));
    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    this.appendDebugLog("debug", "native.outbound.request", { id, method });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
    if (!waiter) return false;
    this.pending.delete(message.id);
    if (message.error) {
      this.appendDebugLog("warn", "native.response.error", { id: message.id, message: message.error.message });
      waiter.reject(new Error(message.error.message));
    } else {
      this.appendDebugLog("debug", "native.response.ok", { id: message.id });
      waiter.resolve(message.result);
    }
    return true;
  }

  rejectPending(message: string): void {
    if (this.pending.size > 0) {
      this.appendDebugLog("warn", "native.pending.rejected", { count: this.pending.size, message });
    }
    for (const waiter of this.pending.values()) waiter.reject(new Error(message));
    this.pending.clear();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

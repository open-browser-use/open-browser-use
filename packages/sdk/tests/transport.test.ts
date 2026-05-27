import { describe, expect, it, vi } from "vitest";
import { ObuError, ERR_DIALOG_REQUIRES_DECISION, ERR_PROTOCOL, ERR_TIMEOUT, ERR_TRANSPORT_CLOSED } from "../src/errors.js";
import { FrameDecoder, FrameEncoder, MAX_FRAME_LEN } from "../src/wire/frames.js";
import { Transport } from "../src/wire/transport.js";
import type { NativePipeConnection, NativePipeConnectionEvent } from "../src/wire/pipe.js";

class FakeConnection implements NativePipeConnection {
  readonly listeners = new Map<NativePipeConnectionEvent, Set<(arg?: unknown) => void>>();
  readonly decoder = new FrameDecoder();
  readonly encoder = new FrameEncoder();
  onWrite?: (request: Record<string, unknown>) => void;
  throwOnWrite?: unknown;
  ended = false;

  write(data: Uint8Array): void {
    if (this.throwOnWrite) throw this.throwOnWrite;
    const frames = this.decoder.feed(data);
    const request = JSON.parse(new TextDecoder().decode(frames[0])) as Record<string, unknown>;
    this.onWrite?.(request);
  }

  on(event: NativePipeConnectionEvent, listener: (arg?: unknown) => void): void {
    const bucket = this.listeners.get(event) ?? new Set<(arg?: unknown) => void>();
    bucket.add(listener);
    this.listeners.set(event, bucket);
  }

  off(event: NativePipeConnectionEvent, listener: (arg?: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  end(): void {
    this.ended = true;
  }

  emit(event: NativePipeConnectionEvent, arg?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(arg);
  }

  respond(id: unknown, result: unknown): void {
    this.emit("data", this.encoder.encode(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id, result }))));
  }

  respondError(id: unknown, error: unknown): void {
    this.emit("data", this.encoder.encode(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id, error }))));
  }
}

describe("Transport", () => {
  it("tracks browser RPC promises with the active OBU exec when available", async () => {
    const original = (globalThis as { obuRepl?: unknown }).obuRepl;
    const tracked: Promise<unknown>[] = [];
    (globalThis as { obuRepl?: unknown }).obuRepl = {
      trackBackgroundOperation(operation: Promise<unknown>) {
        tracked.push(operation);
        return operation;
      },
    };
    try {
      const connection = new FakeConnection();
      const transport = new Transport(connection);
      let requestId: unknown;
      connection.onWrite = (request) => {
        requestId = request.id;
      };

      const promise = transport.sendRequest("tab_url", {}, 1000);

      expect(tracked).toHaveLength(1);
      connection.respond(requestId, { value: "https://example.test/" });
      await expect(promise).resolves.toBe("https://example.test/");
    } finally {
      (globalThis as { obuRepl?: unknown }).obuRepl = original;
    }
  });

  it("reconnect path registers exactly one background operation", async () => {
    const original = (globalThis as { obuRepl?: unknown }).obuRepl;
    const tracked: Promise<unknown>[] = [];
    (globalThis as { obuRepl?: unknown }).obuRepl = {
      trackBackgroundOperation(operation: Promise<unknown>) {
        tracked.push(operation);
        return operation;
      },
    };
    try {
      const first = new FakeConnection();
      const second = new FakeConnection();
      const transport = new Transport(first, async () => second);
      // Host died before the next send: the live transport closes, so the next
      // NEW request takes the transparent reconnect path.
      first.emit("close");
      second.onWrite = (request) => second.respond(request.id, { value: "https://x.test/" });
      const pending = transport.sendRequest("tab_url", {}, 1000);
      await expect(pending).resolves.toBe("https://x.test/");
      // The logical request must register the background operation exactly once,
      // not twice (outer reconnect wrap + inner #send wrap).
      expect(tracked).toHaveLength(1);
    } finally {
      (globalThis as { obuRepl?: unknown }).obuRepl = original;
    }
  });

  it("registers pending before write so synchronous responses resolve", async () => {
    const connection = new FakeConnection();
    const transport = new Transport(connection);
    connection.onWrite = (request) => connection.respond(request.id, { value: "ok" });
    await expect(transport.sendRequest("getInfo", {}, 100)).resolves.toBe("ok");
  });

  it("cleans pending and rejects when write throws synchronously", async () => {
    const connection = new FakeConnection();
    const transport = new Transport(connection);
    connection.throwOnWrite = new Error("boom");
    await expect(transport.sendRequest("getInfo", {}, 100)).rejects.toThrow("boom");
  });

  it("deletes pending before resolving response and ignores duplicate late responses", async () => {
    const connection = new FakeConnection();
    const transport = new Transport(connection);
    connection.onWrite = (request) => {
      connection.respond(request.id, { value: "first" });
      connection.respond(request.id, { value: "second" });
    };
    await expect(transport.sendRequest("getInfo", {}, 100)).resolves.toBe("first");
  });

  it("times out, exposes pending reconcile, and records late success", async () => {
    vi.useFakeTimers();
    const connection = new FakeConnection();
    const transport = new Transport(connection);
    let requestId: unknown;
    connection.onWrite = (request) => {
      requestId = request.id;
    };
    const promise = transport.sendRequest("getInfo", {}, 10);
    const assertion = expect(promise).rejects.toMatchObject({ code: ERR_TIMEOUT });
    await vi.advanceTimersByTimeAsync(5011);
    await assertion;
    expect(transport.diagnostics().request_lifecycle).toMatchObject([
      {
        kind: "timed_out_pending_reconcile",
        requestId,
        method: "getInfo",
        timeoutMs: 10,
        defensiveOvershootMs: 5000,
        nextAction: "observe_reconcile",
      },
    ]);
    connection.respond(requestId, { value: "late" });
    expect(transport.diagnostics().request_lifecycle).toMatchObject([
      {
        kind: "timed_out_late_success",
        requestId,
        method: "getInfo",
        nextAction: "observe_reconcile",
      },
    ]);
    vi.useRealTimers();
  });

  it("records late timeout errors with structured data", async () => {
    vi.useFakeTimers();
    const connection = new FakeConnection();
    const transport = new Transport(connection);
    let requestId: unknown;
    connection.onWrite = (request) => {
      requestId = request.id;
    };
    const promise = transport.sendRequest("tab_goto", {}, 10);
    const assertion = expect(promise).rejects.toMatchObject({ code: ERR_TIMEOUT });
    await vi.advanceTimersByTimeAsync(5011);
    await assertion;
    connection.respondError(requestId, {
      code: -1203,
      message: "dialog_requires_decision",
      data: { code: "dialog_requires_decision", dialog_type: "confirm" },
    });
    expect(transport.diagnostics().request_lifecycle).toMatchObject([
      {
        kind: "timed_out_late_error",
        requestId,
        method: "tab_goto",
        error: {
          code: -1203,
          message: "dialog_requires_decision",
          data: { code: "dialog_requires_decision", dialog_type: "confirm" },
        },
        nextAction: "inspect_error",
      },
    ]);
    vi.useRealTimers();
  });

  it("records transport close after a timed-out request as terminal lifecycle", async () => {
    vi.useFakeTimers();
    const connection = new FakeConnection();
    const transport = new Transport(connection);
    let requestId: unknown;
    connection.onWrite = (request) => {
      requestId = request.id;
    };
    const promise = transport.sendRequest("tab_close", {}, 10);
    const assertion = expect(promise).rejects.toMatchObject({ code: ERR_TIMEOUT });
    await vi.advanceTimersByTimeAsync(5011);
    await assertion;
    connection.emit("close");
    expect(transport.diagnostics().request_lifecycle).toMatchObject([
      {
        kind: "timed_out_late_transport_closed",
        requestId,
        method: "tab_close",
        reason: "transport closed",
        nextAction: "reconnect_or_retry",
      },
    ]);
    vi.useRealTimers();
  });

  it("rejects all pending requests on close", async () => {
    const connection = new FakeConnection();
    const transport = new Transport(connection);
    const promise = transport.sendRequest("getInfo", {}, 1000);
    connection.emit("close");
    await expect(promise).rejects.toMatchObject({ code: ERR_TRANSPORT_CLOSED });
  });

  it("rejects pending requests and closes when frame decoding fails", async () => {
    const connection = new FakeConnection();
    const transport = new Transport(connection);
    const promise = transport.sendRequest("getInfo", {}, 1000);
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, MAX_FRAME_LEN + 1, true);

    connection.emit("data", header);

    await expect(promise).rejects.toMatchObject({ code: ERR_PROTOCOL });
    expect(connection.ended).toBe(true);
  });

  it("ignores notifications while preserving pending request correlation", async () => {
    const connection = new FakeConnection();
    const transport = new Transport(connection);
    connection.onWrite = (request) => {
      connection.emit("data", connection.encoder.encode(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", method: "notice" }))));
      connection.respond(request.id, { value: 42 });
    };
    await expect(transport.sendRequest("getInfo", {}, 100)).resolves.toBe(42);
  });

  it("wraps rpc errors in ObuError", async () => {
    const connection = new FakeConnection();
    const transport = new Transport(connection);
    connection.onWrite = (request) => {
      connection.emit(
        "data",
        connection.encoder.encode(
          new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -1200, message: "no backend" } })),
        ),
      );
    };
    await expect(transport.sendRequest("getInfo", {}, 100)).rejects.toBeInstanceOf(ObuError);
  });

  it("preserves structured rpc error data", async () => {
    const connection = new FakeConnection();
    const transport = new Transport(connection);
    const data = {
      code: "dialog_requires_decision",
      tab_id: "42",
      dialog_type: "confirm",
      default_action: "dismiss",
      accept: false,
    };
    connection.onWrite = (request) => {
      connection.emit(
        "data",
        connection.encoder.encode(
          new TextEncoder().encode(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: {
                code: ERR_DIALOG_REQUIRES_DECISION,
                message: "dialog_requires_decision",
                data,
              },
            }),
          ),
        ),
      );
    };
    await expect(transport.sendRequest("tab_goto", {}, 100)).rejects.toMatchObject({
      code: ERR_DIALOG_REQUIRES_DECISION,
      data,
    });
  });

  it("reconnects on the next send after the transport closed", async () => {
    const first = new FakeConnection();
    const second = new FakeConnection();
    let made = 0;
    const transport = new Transport(first, async () => {
      made++;
      return second;
    });
    first.onWrite = (request) => first.respond(request.id, { value: "one" });
    await expect(transport.sendRequest("tab_url", {}, 100)).resolves.toBe("one");

    // Host died: the live transport closes.
    first.emit("close");

    // The next NEW request transparently reconnects to a fresh connection.
    second.onWrite = (request) => second.respond(request.id, { value: "two" });
    await expect(transport.sendRequest("tab_url", {}, 100)).resolves.toBe("two");
    expect(made).toBe(1);
    expect(transport.diagnostics().reconnects).toBe(1);
  });

  it("reconnect advisory is a neutral observation, not a reissue instruction", async () => {
    const messages: string[] = [];
    (globalThis as { display?: (v: string) => void }).display = (v) => messages.push(v);
    try {
      const first = new FakeConnection();
      const second = new FakeConnection();
      const transport = new Transport(first, async () => second);
      first.onWrite = (request) => first.respond(request.id, { value: "one" });
      await expect(transport.sendRequest("tab_url", {}, 100)).resolves.toBe("one");

      // Host died: the live transport closes, then the next send transparently reconnects.
      first.emit("close");
      second.onWrite = (request) => second.respond(request.id, { value: "two" });
      await expect(transport.sendRequest("tab_url", {}, 100)).resolves.toBe("two");

      const note = messages.find((m) => m.includes("reconnected"));
      expect(note).toBeDefined();
      expect(note).not.toMatch(/reissue/i);
    } finally {
      delete (globalThis as { display?: unknown }).display;
    }
  });

  it("does not auto-retry an in-flight request when the transport closes", async () => {
    const connection = new FakeConnection();
    const transport = new Transport(connection, async () => new FakeConnection());
    const promise = transport.sendRequest("tab_goto", {}, 1000); // sent, awaiting response
    connection.emit("close");
    // Already-sent mutations must NOT be silently retried (no double-execution).
    await expect(promise).rejects.toMatchObject({ code: ERR_TRANSPORT_CLOSED });
  });

  it("rejects with transport_closed when reconnect keeps failing", async () => {
    const saved = {
      attempts: process.env.OBU_RECONNECT_MAX_ATTEMPTS,
      backoff: process.env.OBU_RECONNECT_BACKOFF_MS,
    };
    process.env.OBU_RECONNECT_MAX_ATTEMPTS = "2";
    process.env.OBU_RECONNECT_BACKOFF_MS = "0";
    try {
      const connection = new FakeConnection();
      const transport = new Transport(connection, async () => {
        throw new Error("no live socket yet");
      });
      connection.emit("close");
      await expect(transport.sendRequest("tab_url", {}, 100)).rejects.toMatchObject({
        code: ERR_TRANSPORT_CLOSED,
      });
    } finally {
      if (saved.attempts === undefined) delete process.env.OBU_RECONNECT_MAX_ATTEMPTS;
      else process.env.OBU_RECONNECT_MAX_ATTEMPTS = saved.attempts;
      if (saved.backoff === undefined) delete process.env.OBU_RECONNECT_BACKOFF_MS;
      else process.env.OBU_RECONNECT_BACKOFF_MS = saved.backoff;
    }
  });
});

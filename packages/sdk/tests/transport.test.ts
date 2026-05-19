import { describe, expect, it, vi } from "vitest";
import { ObuError, ERR_PROTOCOL, ERR_TIMEOUT, ERR_TRANSPORT_CLOSED } from "../src/errors.js";
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
}

describe("Transport", () => {
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

  it("times out, removes pending, and ignores a late response", async () => {
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
    connection.respond(requestId, { value: "late" });
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
});

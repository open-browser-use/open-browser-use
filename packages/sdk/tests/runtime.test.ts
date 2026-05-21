import { describe, expect, it } from "vitest";
import { Guards } from "../src/guards.js";
import { setupObuRuntime } from "../src/runtime.js";
import { FrameDecoder, FrameEncoder } from "../src/wire/frames.js";
import type { NativePipeBridge, NativePipeConnection, NativePipeConnectionEvent } from "../src/wire/pipe.js";

class InfoConnection implements NativePipeConnection {
  readonly decoder = new FrameDecoder();
  readonly encoder = new FrameEncoder();
  readonly listeners = new Map<NativePipeConnectionEvent, Set<(arg?: unknown) => void>>();
  getInfoCalls = 0;

  write(data: Uint8Array): void {
    const request = JSON.parse(new TextDecoder().decode(this.decoder.feed(data)[0])) as { id: number; method: string };
    if (request.method === "getInfo") this.getInfoCalls += 1;
    this.emit(
      "data",
      this.encoder.encode(
        new TextEncoder().encode(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { type: "cdp", name: "cdp", capabilities: {} } }),
        ),
      ),
    );
  }

  on(event: NativePipeConnectionEvent, listener: (arg?: unknown) => void): void {
    const bucket = this.listeners.get(event) ?? new Set<(arg?: unknown) => void>();
    bucket.add(listener);
    this.listeners.set(event, bucket);
  }

  off(event: NativePipeConnectionEvent, listener: (arg?: unknown) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  end(): void {}

  emit(event: NativePipeConnectionEvent, arg?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(arg);
  }
}

describe("setupObuRuntime", () => {
  it("installs agent without discovery, connect, or getInfo", async () => {
    let discoveryCalls = 0;
    let connectCalls = 0;
    const connections: InfoConnection[] = [];
    const globals: Record<string, unknown> = {};
    (globalThis as { obuRepl?: unknown }).obuRepl = {
      discoverBackends: () => {
        discoveryCalls += 1;
        return [{ type: "cdp", name: "cdp", socketPath: "/tmp/obu.sock" }];
      },
    };
    const pipeBridge: NativePipeBridge = {
      createConnection: async () => {
        connectCalls += 1;
        const connection = new InfoConnection();
        connections.push(connection);
        return connection;
      },
    };

    const { agent } = await setupObuRuntime({ globals, pipeBridge });
    expect(globals.agent).toBe(agent);
    expect(discoveryCalls).toBe(0);
    expect(connectCalls).toBe(0);
    expect(connections).toHaveLength(0);

    await agent.browsers.get("cdp");
    expect(discoveryCalls).toBe(1);
    expect(connectCalls).toBe(1);
    expect(connections[0]?.getInfoCalls).toBe(1);

    await agent.browsers.get("cdp");
    expect(discoveryCalls).toBe(2);
    expect(connectCalls).toBe(2);
    expect(connections[1]?.getInfoCalls).toBe(1);
  });

  it("passes configured local guards to acquired browsers", async () => {
    (globalThis as { obuRepl?: unknown }).obuRepl = {
      discoverBackends: () => [{ type: "cdp", name: "cdp", socketPath: "/tmp/obu.sock" }],
    };
    const pipeBridge: NativePipeBridge = {
      createConnection: async () => new InfoConnection(),
    };
    const defaultGuards = new Guards();
    const overrideGuards = new Guards();

    const { agent } = await setupObuRuntime({ pipeBridge, guards: defaultGuards });
    const defaultBrowser = await agent.browsers.get("cdp");
    const overrideBrowser = await agent.browsers.get("cdp", { guards: overrideGuards });

    expect(defaultBrowser.guards).toBe(defaultGuards);
    expect(overrideBrowser.guards).toBe(overrideGuards);
  });

  it("surfaces backend discovery diagnostics in no-backend errors", async () => {
    (globalThis as { obuRepl?: unknown }).obuRepl = {
      discoverBackends: () => [],
      discoverBackendDiagnostics: () => [
        {
          source: "/tmp/obu/webextension/future.json",
          reason: "unsupported schema_version 999",
        },
      ],
    };
    const pipeBridge: NativePipeBridge = {
      createConnection: async () => {
        throw new Error("should not connect without a backend");
      },
    };

    const { agent } = await setupObuRuntime({ pipeBridge });

    await expect(agent.browsers.diagnostics()).resolves.toEqual([
      {
        source: "/tmp/obu/webextension/future.json",
        reason: "unsupported schema_version 999",
      },
    ]);
    await expect(agent.browsers.get("chrome")).rejects.toThrow(/unsupported schema_version 999/);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { Browser } from "../src/browser.js";
import { Guards } from "../src/guards.js";
import type { Transport } from "../src/wire/transport.js";
import * as M from "../src/wire/methods.js";

type FrameMeta = { runtime?: { kernel_generation?: number } } | undefined;

class TaskTransport {
  calls: Array<{ method: string; params: Record<string, unknown>; frameMeta: FrameMeta }> = [];
  async sendRequest<T>(
    method: string,
    params: Record<string, unknown>,
    _timeout?: number,
    frameMeta?: FrameMeta,
  ): Promise<T> {
    this.calls.push({ method, params, frameMeta });
    if (method === M.TASKS_LIST) return [] as T;
    if (method === M.TASKS_EXPORT) return { task_id: "task-1", turns: [], events: [] } as T;
    if (method === M.TASKS_RESUME) {
      return { resumeToken: "token-1", attemptId: "attempt-1", plan: {}, episode: { task_id: "task-1", turns: [], events: [] } } as T;
    }
    if (method === M.RESUME_CONTROL) {
      return { tab: { tab_id: "tab-1", commandable: true, owned: true, status: "active", url: "https://example.test/" } } as T;
    }
    if (method === M.TASKS_RESUME_COMPLETE) {
      return { status: "attached", segment: { segmentId: "segment-1", sessionId: "session-1", turnId: "turn-1", generation: 7 } } as T;
    }
    if (method === M.TAB_URL) return "https://example.test/" as T;
    if (method === M.TAB_TITLE) return "Example" as T;
    return null as T;
  }
}

function installMeta(): void {
  (globalThis as { obuRepl?: unknown }).obuRepl = {
    requestMeta: {
      "x-obu-turn-metadata": { session_id: "session-1", turn_id: "turn-1" },
      "x-obu-runtime-metadata": { kernel_generation: 7 },
    },
  };
}

afterEach(() => {
  delete (globalThis as { obuRepl?: unknown }).obuRepl;
});

describe("browser.tasks", () => {
  it("lists and exports tasks", async () => {
    installMeta();
    const transport = new TaskTransport();
    const browser = new Browser(
      transport as unknown as Transport,
      { type: "webextension", name: "chrome" },
      { type: "webextension", name: "chrome", socketPath: "/tmp/sock" },
      new Guards(),
    );
    await expect(browser.tasks.list()).resolves.toEqual([]);
    await expect(browser.tasks.export("task-1")).resolves.toMatchObject({ task_id: "task-1" });
    expect(transport.calls.map((call) => call.method)).toEqual([M.TASKS_LIST, M.TASKS_EXPORT]);
    // list/export are always-allowed reads and do not carry a trusted runtime
    // envelope: they pass no frameMeta at all (Transport then omits top-level runtime).
    for (const call of transport.calls) {
      expect(call.frameMeta).toBeUndefined();
    }
  });

  it("completes attached resume before post-resume observe", async () => {
    installMeta();
    const transport = new TaskTransport();
    const browser = new Browser(
      transport as unknown as Transport,
      { type: "webextension", name: "chrome" },
      { type: "webextension", name: "chrome", socketPath: "/tmp/sock" },
      new Guards(),
    );
    const result = await browser.tasks.resume("task-1");
    expect(result.status).toBe("resumed");
    expect(transport.calls.map((call) => call.method)).toEqual([
      M.TASKS_RESUME,
      M.RESUME_CONTROL,
      M.TASKS_RESUME_COMPLETE,
      M.TAB_URL,
      M.TAB_TITLE,
    ]);

    // F2 trust boundary: the trusted kernel_generation (installMeta injects 7)
    // MUST ride the frame-level `runtime` envelope (4th arg of sendRequest),
    // NEVER inside params. The host reads kernel_generation only from the
    // envelope and rejects `runtime`/`_runtime` keys in params, so a leak into
    // params would be a privilege-escalation gap. Lock both halves: the envelope
    // carries the generation AND params is clean — on every task RPC that the
    // resume flow drives with frameMeta.
    const resumeRpcs = transport.calls.filter(
      (call) => call.method === M.TASKS_RESUME || call.method === M.TASKS_RESUME_COMPLETE,
    );
    expect(resumeRpcs.length).toBeGreaterThan(0);
    for (const call of resumeRpcs) {
      expect(call.frameMeta?.runtime).toEqual({ kernel_generation: 7 });
      expect(call.params).not.toHaveProperty("runtime");
      expect(call.params).not.toHaveProperty("_runtime");
      expect(call.params).not.toHaveProperty("kernel_generation");
    }
  });
});

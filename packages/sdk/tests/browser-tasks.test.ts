import { afterEach, describe, expect, it } from "vitest";
import { Browser } from "../src/browser.js";
import { Guards } from "../src/guards.js";
import type { Transport } from "../src/wire/transport.js";
import * as M from "../src/wire/methods.js";

class TaskTransport {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  async sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
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
  });
});

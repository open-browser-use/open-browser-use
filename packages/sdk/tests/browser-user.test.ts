import { describe, expect, it } from "vitest";
import { BrowserUser } from "../src/browser_user.js";
import * as M from "../src/wire/methods.js";
import type { Transport } from "../src/wire/transport.js";
import { Guards } from "../src/guards.js";
import { ERR_NOT_IMPLEMENTED } from "../src/errors.js";
import { clearSessionMetaCacheForTests } from "../src/session-meta.js";

class FakeTransport {
  calls: Array<{ method: string; params: Record<string, unknown>; timeout?: number }> = [];

  async sendRequest<T>(method: string, params: Record<string, unknown>, timeout?: number): Promise<T> {
    this.calls.push({ method, params, timeout });
    if (method === M.GET_USER_TABS) {
      return [{
        id: "11",
        url: "https://open.example/",
        title: "Open",
        origin: "user",
        status: "active",
        active: true,
        windowId: 1,
        groupId: 2,
        pinned: false,
        commandable: false,
        claimRequired: true,
      }] as T;
    }
    if (method === M.CLAIM_USER_TAB) {
      return { tab_id: "12", url: "https://claimed.example/", title: "Claimed", origin: "user", status: "active" } as T;
    }
    if (method === M.GET_USER_HISTORY) return [{ url: "https://example.com", title: "Example" }] as T;
    return null as T;
  }
}

describe("BrowserUser", () => {
  it("sends open tab, claim, and history requests with session metadata", async () => {
    const global = globalThis as { obuRepl?: { requestMeta?: unknown } };
    const original = global.obuRepl;
    global.obuRepl = {
      requestMeta: {
        "x-obu-turn-metadata": { session_id: "session", turn_id: "turn" },
      },
    };
    try {
      const transport = new FakeTransport();
      const historyChecks: Array<{ command: string; tabId?: string }> = [];
      const user = new BrowserUser(
        transport as unknown as Transport,
        new Guards({
          checkHistory: (_query, context) => {
            historyChecks.push({
              command: context.command,
              ...(context.tabId ? { tabId: context.tabId } : {}),
            });
          },
        }),
      );

      const refs = await user.discoverTabs();
      const tabs = await user.openTabs();
      const claimed = await user.claimTab(12);
      const claimedFromRef = await refs[0]!.claim();
      const history = await user.history({ query: "example", limit: 3, from: 1, to: 2 });

      expect(refs[0]!.id).toBe("11");
      expect(refs[0]!.metadata).toMatchObject({
        url: "https://open.example/",
        title: "Open",
        commandable: false,
        claimRequired: true,
        active: true,
        windowId: 1,
        groupId: 2,
        pinned: false,
      });
      expect(tabs[0]!.id).toBe("11");
      expect(tabs[0]!.metadata).toMatchObject({
        url: "https://open.example/",
        title: "Open",
        origin: "user",
        status: "active",
      });
      expect(claimed.id).toBe("12");
      expect(claimed.metadata).toMatchObject({
        url: "https://claimed.example/",
        title: "Claimed",
        origin: "user",
        status: "active",
      });
      expect(claimedFromRef.id).toBe("12");
      expect(history).toEqual([{ url: "https://example.com", title: "Example" }]);
      expect(historyChecks).toEqual([
        { command: M.GET_USER_TABS },
        { command: M.GET_USER_TABS },
        { command: M.CLAIM_USER_TAB, tabId: "12" },
        { command: M.CLAIM_USER_TAB, tabId: "11" },
        { command: M.GET_USER_HISTORY },
      ]);
      expect(transport.calls).toEqual([
        {
          method: M.GET_USER_TABS,
          params: { session_id: "session", turn_id: "turn" },
          timeout: undefined,
        },
        {
          method: M.GET_USER_TABS,
          params: { session_id: "session", turn_id: "turn" },
          timeout: undefined,
        },
        {
          method: M.CLAIM_USER_TAB,
          params: { tab_id: "12", session_id: "session", turn_id: "turn" },
          timeout: undefined,
        },
        {
          method: M.CLAIM_USER_TAB,
          params: { tab_id: "11", session_id: "session", turn_id: "turn" },
          timeout: undefined,
        },
        {
          method: M.GET_USER_HISTORY,
          params: {
            query: "example",
            limit: 3,
            from: 1,
            to: 2,
            session_id: "session",
            turn_id: "turn",
          },
          timeout: undefined,
        },
      ]);
    } finally {
      global.obuRepl = original;
    }
  });

  it("rejects profile history before transport when backend capabilities do not support it", async () => {
    const transport = new FakeTransport();
    const user = new BrowserUser(
      transport as unknown as Transport,
      new Guards(),
      (method) => method !== M.GET_USER_HISTORY,
      "cdp",
    );

    await expect(user.history({ query: "example" })).rejects.toMatchObject({
      code: ERR_NOT_IMPLEMENTED,
      message: "backend does not support browser profile history",
      data: {
        code: "unsupported_backend_capability",
        backend: "cdp",
        method: M.GET_USER_HISTORY,
        missing_capability: "method:getUserHistory",
      },
    });
    expect(transport.calls).toEqual([]);
  });

  it("claimTab accepts discovered references and id-shaped objects", async () => {
    const global = globalThis as { obuRepl?: { requestMeta?: unknown } };
    const original = global.obuRepl;
    delete global.obuRepl;
    clearSessionMetaCacheForTests();
    const transport = new FakeTransport();
    const historyChecks: Array<{ command: string; tabId?: string }> = [];
    const user = new BrowserUser(
      transport as unknown as Transport,
      new Guards({
        checkHistory: (_query, context) => {
          historyChecks.push({
            command: context.command,
            ...(context.tabId ? { tabId: context.tabId } : {}),
          });
        },
      }),
    );

    try {
      const refs = await user.discoverTabs();
      await expect(user.claimTab(refs[0]!)).resolves.toMatchObject({ id: "12" });
      await expect(user.claimTab({ id: 13 })).resolves.toMatchObject({ id: "12" });
    } finally {
      global.obuRepl = original;
      clearSessionMetaCacheForTests();
    }

    expect(historyChecks).toEqual([
      { command: M.GET_USER_TABS },
      { command: M.CLAIM_USER_TAB, tabId: "11" },
      { command: M.CLAIM_USER_TAB, tabId: "13" },
    ]);
    expect(transport.calls).toEqual([
      { method: M.GET_USER_TABS, params: {}, timeout: undefined },
      { method: M.CLAIM_USER_TAB, params: { tab_id: "11" }, timeout: undefined },
      { method: M.CLAIM_USER_TAB, params: { tab_id: "13" }, timeout: undefined },
    ]);
  });
});

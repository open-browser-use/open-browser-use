import { describe, expect, it } from "vitest";
import { Tab } from "../src/tab.js";
import { Guards } from "../src/guards.js";
import * as M from "../src/wire/methods.js";
import type { Transport } from "../src/wire/transport.js";

class FakeTransport {
  calls: Array<{ method: string; params: Record<string, unknown>; timeout?: number }> = [];

  async sendRequest<T>(method: string, params: Record<string, unknown>, timeout?: number): Promise<T> {
    this.calls.push({ method, params, timeout });
    if (method === M.TAB_CLIPBOARD_READ_TEXT) return { text: "copied" } as T;
    if (method === M.TAB_CLIPBOARD_READ) {
      return {
        items: [
          {
            entries: [
              { mime_type: "text/plain", text: "plain" },
              { mime_type: "text/html", text: "<b>plain</b>" },
              { mime_type: "image/png", base64: "iVBORw0KGgo=" },
            ],
            presentation_style: "inline",
          },
        ],
      } as T;
    }
    if (method === M.DOM_CUA_GET_VISIBLE_DOM) return { nodes: [{ node_id: "42" }] } as T;
    return null as T;
  }
}

describe("P3 tab surfaces", () => {
  it("wires text clipboard and DOM-CUA methods to host method names", async () => {
    const global = globalThis as { obuRepl?: { requestMeta?: unknown } };
    const original = global.obuRepl;
    global.obuRepl = {
      requestMeta: {
        "x-obu-turn-metadata": { session_id: "session", turn_id: "turn" },
      },
    };
    const transport = new FakeTransport();
    const tab = new Tab(transport as unknown as Transport, new Guards(), "tab-1");

    try {
      await expect(tab.clipboard.readText({ timeout: 1000 })).resolves.toBe("copied");
      await tab.clipboard.writeText("next");
      await expect(tab.clipboard.read({ timeout: 2000 })).resolves.toEqual([
        {
          entries: [
            { mimeType: "text/plain", text: "plain" },
            { mimeType: "text/html", text: "<b>plain</b>" },
            { mimeType: "image/png", base64: "iVBORw0KGgo=" },
          ],
          presentationStyle: "inline",
        },
      ]);
      await tab.clipboard.write([
        {
          entries: [
            { mimeType: "text/plain", text: "plain" },
            { mimeType: "text/html", text: "<b>plain</b>" },
            { mimeType: "image/png", base64: "iVBORw0KGgo=" },
          ],
          presentationStyle: "inline",
        },
      ]);
      await expect(tab.dom_cua.get_visible_dom()).resolves.toEqual({ nodes: [{ node_id: "42" }] });
      await tab.dom_cua.click("42", { modifiers: ["Shift"] });
      await tab.dom_cua.double_click("42", { modifiers: ["Shift"] });
      await tab.dom_cua.scroll("42", { deltaX: 1, deltaY: 2 }, { modifiers: ["Alt"] });
      await tab.dom_cua.scroll(-120, { modifiers: ["Control"] });
      await tab.dom_cua.type("42", "hello");
      await tab.dom_cua.keypress("42", ["Meta", "L"], { modifiers: ["Meta"] });
      await tab.dom_cua.download_media("42");
    } finally {
      global.obuRepl = original;
    }

    expect(transport.calls).toEqual([
      {
        method: M.TAB_CLIPBOARD_READ_TEXT,
        params: { tab_id: "tab-1", session_id: "session", turn_id: "turn" },
        timeout: 1000,
      },
      {
        method: M.TAB_CLIPBOARD_WRITE_TEXT,
        params: { tab_id: "tab-1", text: "next", session_id: "session", turn_id: "turn" },
        timeout: undefined,
      },
      {
        method: M.TAB_CLIPBOARD_READ,
        params: { tab_id: "tab-1", session_id: "session", turn_id: "turn" },
        timeout: 2000,
      },
      {
        method: M.TAB_CLIPBOARD_WRITE,
        params: {
          tab_id: "tab-1",
          items: [
            {
              entries: [
                { mime_type: "text/plain", text: "plain" },
                { mime_type: "text/html", text: "<b>plain</b>" },
                { mime_type: "image/png", base64: "iVBORw0KGgo=" },
              ],
              presentation_style: "inline",
            },
          ],
          session_id: "session",
          turn_id: "turn",
        },
        timeout: undefined,
      },
      {
        method: M.DOM_CUA_GET_VISIBLE_DOM,
        params: { tab_id: "tab-1", session_id: "session", turn_id: "turn" },
        timeout: undefined,
      },
      {
        method: M.DOM_CUA_CLICK,
        params: { tab_id: "tab-1", node_id: "42", modifiers: ["Shift"], session_id: "session", turn_id: "turn" },
        timeout: undefined,
      },
      {
        method: M.DOM_CUA_DOUBLE_CLICK,
        params: { tab_id: "tab-1", node_id: "42", modifiers: ["Shift"], session_id: "session", turn_id: "turn" },
        timeout: undefined,
      },
      {
        method: M.DOM_CUA_SCROLL,
        params: { tab_id: "tab-1", node_id: "42", deltaX: 1, deltaY: 2, modifiers: ["Alt"], session_id: "session", turn_id: "turn" },
        timeout: undefined,
      },
      {
        method: M.DOM_CUA_SCROLL,
        params: { tab_id: "tab-1", deltaX: 0, deltaY: -120, modifiers: ["Control"], session_id: "session", turn_id: "turn" },
        timeout: undefined,
      },
      {
        method: M.DOM_CUA_TYPE,
        params: { tab_id: "tab-1", node_id: "42", text: "hello", session_id: "session", turn_id: "turn" },
        timeout: undefined,
      },
      {
        method: M.DOM_CUA_KEYPRESS,
        params: { tab_id: "tab-1", node_id: "42", keys: ["Meta", "L"], modifiers: ["Meta"], session_id: "session", turn_id: "turn" },
        timeout: undefined,
      },
      {
        method: M.DOM_CUA_DOWNLOAD_MEDIA,
        params: { tab_id: "tab-1", node_id: "42", session_id: "session", turn_id: "turn" },
        timeout: undefined,
      },
    ]);
  });
});

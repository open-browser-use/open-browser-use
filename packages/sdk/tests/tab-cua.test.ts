import { describe, expect, it } from "vitest";
import { TabCua } from "../src/tab-cua.js";
import * as M from "../src/wire/methods.js";
import type { Transport } from "../src/wire/transport.js";

class FakeTransport {
  calls: Array<{ method: string; params: Record<string, unknown>; timeout?: number }> = [];

  async sendRequest(method: string, params: Record<string, unknown>, timeout?: number): Promise<unknown> {
    this.calls.push({ method, params, timeout });
    return null;
  }
}

describe("TabCua", () => {
  it("sends coordinate CUA commands with tab id and timeout", async () => {
    const transport = new FakeTransport();
    const cua = new TabCua(transport as unknown as Transport, "tab-1");

    await cua.click(10, 20, { button: "right", timeout: 1000 });
    await cua.dblclick(11, 21);
    await cua.click(12, 22, {
      timeout: 2000,
      waitForNavigation: { waitUntil: "domcontentloaded", timeout: 1500 },
    });
    await cua.click(13, 23, {
      timeout: 120,
      waitForNavigation: { waitUntil: "load", timeout: 1500 },
    });
    await cua.scroll(12, 22, { deltaX: 3, deltaY: 4 });
    await cua.scroll(13, 23, -250);
    await cua.type("hello");
    await cua.keypress(["Meta", "L"], { modifiers: ["Meta"] });
    await cua.drag({ x: 0, y: 1 }, { x: 2, y: 3 }, { steps: 4 });
    await cua.dragPath([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    await cua.move(5, 6);

    expect(transport.calls).toEqual([
      {
        method: M.CUA_CLICK,
        params: { tab_id: "tab-1", x: 10, y: 20, button: "right", modifiers: undefined },
        timeout: 1000,
      },
      {
        method: M.CUA_DBLCLICK,
        params: { tab_id: "tab-1", x: 11, y: 21, button: undefined, modifiers: undefined },
        timeout: undefined,
      },
      {
        method: M.CUA_CLICK,
        params: {
          tab_id: "tab-1",
          x: 12,
          y: 22,
          button: undefined,
          modifiers: undefined,
          wait_for_navigation: true,
          navigation_wait_until: "domcontentloaded",
          navigation_timeout_ms: 1500,
        },
        timeout: 2000,
      },
      {
        method: M.CUA_CLICK,
        params: {
          tab_id: "tab-1",
          x: 13,
          y: 23,
          button: undefined,
          modifiers: undefined,
          wait_for_navigation: true,
          navigation_wait_until: "load",
          navigation_timeout_ms: 1500,
        },
        timeout: 1500,
      },
      {
        method: M.CUA_SCROLL,
        params: { tab_id: "tab-1", x: 12, y: 22, deltaX: 3, deltaY: 4 },
        timeout: undefined,
      },
      {
        method: M.CUA_SCROLL,
        params: { tab_id: "tab-1", x: 13, y: 23, deltaX: 0, deltaY: -250 },
        timeout: undefined,
      },
      {
        method: M.CUA_TYPE,
        params: { tab_id: "tab-1", text: "hello" },
        timeout: undefined,
      },
      {
        method: M.CUA_KEYPRESS,
        params: { tab_id: "tab-1", keys: ["Meta", "L"], modifiers: ["Meta"] },
        timeout: undefined,
      },
      {
        method: M.CUA_DRAG,
        params: { tab_id: "tab-1", from: { x: 0, y: 1 }, to: { x: 2, y: 3 }, steps: 4 },
        timeout: undefined,
      },
      {
        method: M.CUA_DRAG,
        params: { tab_id: "tab-1", path: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
        timeout: undefined,
      },
      {
        method: M.CUA_MOVE,
        params: { tab_id: "tab-1", x: 5, y: 6 },
        timeout: undefined,
      },
    ]);
  });
});

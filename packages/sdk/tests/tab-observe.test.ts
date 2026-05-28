import { describe, expect, it } from "vitest";
import { Guards } from "../src/guards.js";
import { Tab } from "../src/tab.js";
import type { Transport } from "../src/wire/transport.js";
import * as M from "../src/wire/methods.js";

class FakeTransport {
  calls: Array<{ method: string; params: Record<string, unknown>; timeout?: number }> = [];

  async sendRequest<T>(method: string, params: Record<string, unknown>, timeout?: number): Promise<T> {
    this.calls.push({ method, params, timeout });
    if (method === M.TAB_URL) return "https://example.com/form" as T;
    if (method === M.TAB_TITLE) return "Example Form" as T;
    if (method === M.TAB_SNAPSHOT_TEXT) {
      return {
        result: {
          value: {
            __obu_evaluate_value: {
              url: "https://example.com/form",
              title: "Example Form",
              viewport: {
                width: 1024,
                height: 768,
                scrollX: 0,
                scrollY: 80,
                devicePixelRatio: 2,
              },
              focus: {
                tag: "input",
                id: "email",
                name: "email",
                type: "email",
                placeholder: "Email",
                ariaLabel: "",
              },
              headings: [{ level: 1, text: "Form" }],
              buttons: ["Submit"],
              links: [],
              forms: [{ label: "Email", type: "email", name: "email", placeholder: "Email" }],
            },
          },
        },
      } as T;
    }
    throw new Error(`unexpected method ${method}`);
  }
}

class ConfigurableObserveTransport extends FakeTransport {
  failText = false;
  failDomCua = false;
  failScreenshot = false;

  override async sendRequest<T>(method: string, params: Record<string, unknown>, timeout?: number): Promise<T> {
    if (method === M.TAB_SNAPSHOT_TEXT && this.failText) {
      this.calls.push({ method, params, timeout });
      throw new Error("text snapshot unavailable");
    }
    if (method === M.DOM_CUA_GET_VISIBLE_DOM) {
      this.calls.push({ method, params, timeout });
      if (this.failDomCua) throw new Error("DOM-CUA unavailable");
      return {
        text: "<button node_id=101>Submit</button>",
        nodes: [{ node_id: "101", tag: "button", bounds: { x: 10, y: 20, width: 40, height: 20 } }],
      } as T;
    }
    if (method === M.TAB_SCREENSHOT) {
      this.calls.push({ method, params, timeout });
      if (this.failScreenshot) throw new Error("screenshot unavailable");
      return { data: "aW1hZ2U=", mime_type: "image/jpeg" } as T;
    }
    return await super.sendRequest<T>(method, params, timeout);
  }
}

describe("Tab.observe", () => {
  it("returns a compact observation with lifecycle, section status, and action families", async () => {
    const transport = new FakeTransport();
    const tab = new Tab(
      transport as unknown as Transport,
      new Guards(),
      "tab-1",
      { commandable: true, owned: true, status: "active" },
      {
        supportedMethods: [
          M.PLAYWRIGHT_LOCATOR_CLICK,
          M.PLAYWRIGHT_LOCATOR_FILL,
          M.CUA_CLICK,
          M.CUA_MOVE,
        ],
        unsupportedMethods: [M.DOM_CUA_GET_VISIBLE_DOM, M.DOM_CUA_CLICK],
      },
    );

    const observation = await tab.observe({ timeout: 1000, observationTtlMs: 5000 });

    expect(observation.status).toBe("succeeded");
    expect(observation.mode).toBe("compact");
    expect(observation.tab).toMatchObject({
      id: "tab-1",
      url: "https://example.com/form",
      title: "Example Form",
      loadState: "unknown",
    });
    expect(observation.lifecycle).toMatchObject({
      state: "fresh",
      documentRevision: "https://example.com/form",
      routeRevision: "https://example.com/form",
    });
    expect(observation.lifecycle.pageStateHash).toMatch(/^psh_[0-9a-f]{8}$/);
    expect(observation.lifecycle.expiresAt).toBe(observation.createdAt + 5000);
    expect(observation.sections.text).toEqual({ status: "present" });
    expect(observation.sections.viewport).toEqual({ status: "present" });
    expect(observation.sections.focus).toEqual({ status: "present" });
    expect(observation.lifecycle.viewportRevision).toMatch(/^psh_[0-9a-f]{8}$/);
    expect(observation.lifecycle.focusRevision).toMatch(/^psh_[0-9a-f]{8}$/);
    expect(observation.sections.domCua).toEqual({ status: "omitted", reason: "not_requested" });
    expect(observation.diagnostics.stateTrace.map((entry) => entry.state)).toEqual([
      "requested",
      "preflight",
      "reading_backend",
      "composing_snapshot",
      "succeeded",
    ]);
    expect(observation.ownership).toMatchObject({
      state: "claimed_by_agent",
      commandable: true,
      owned: true,
      status: "active",
    });
    expect(observation.actionFamilies.map((family) => [family.name, family.status])).toEqual([
      ["locator", "supported"],
      ["dom-cua", "unsupported"],
      ["coordinate-cua", "supported"],
      ["raw-cdp", "unsupported"],
    ]);
    expect(transport.calls.map((call) => call.method)).toEqual([
      M.TAB_URL,
      M.TAB_TITLE,
      M.TAB_SNAPSHOT_TEXT,
    ]);
  });

  it("advises when the page is a browser error page (failed navigation)", async () => {
    class ErrorPageTransport extends FakeTransport {
      override async sendRequest<T>(method: string, params: Record<string, unknown>, timeout?: number): Promise<T> {
        if (method === M.TAB_URL) return "chrome-error://chromewebdata/" as T;
        if (method === M.TAB_TITLE) return "en.wikipedia.org" as T;
        return await super.sendRequest<T>(method, params, timeout);
      }
    }
    const transport = new ErrorPageTransport();
    const tab = new Tab(
      transport as unknown as Transport,
      new Guards(),
      "tab-err",
      { commandable: true, owned: true, status: "active" },
      { supportedMethods: [M.PLAYWRIGHT_LOCATOR_CLICK], unsupportedMethods: [M.DOM_CUA_GET_VISIBLE_DOM] },
    );

    const observation = await tab.observe({ timeout: 1000 });

    // Without this, an agent sees a sparse but "succeeded" observation and cannot tell
    // a real page from a chrome-error:// failure page (observed live for ERR_CONNECTION_RESET).
    expect(observation.diagnostics.advisories.some((advisory) => /error page/i.test(advisory))).toBe(true);
    expect(observation.tab.url).toBe("chrome-error://chromewebdata/");
  });

  it("marks unsupported DOM-CUA as blocked when actionable observation asks for it", async () => {
    const transport = new FakeTransport();
    const tab = new Tab(
      transport as unknown as Transport,
      new Guards(),
      "tab-1",
      {},
      { unsupportedMethods: [M.DOM_CUA_GET_VISIBLE_DOM] },
    );

    const observation = await tab.observe({ mode: "actionable" });

    expect(observation.status).toBe("partial");
    expect(observation.sections.domCua).toEqual({
      status: "blocked",
      reason: "capability_unsupported",
    });
    expect(transport.calls.map((call) => call.method)).not.toContain(M.DOM_CUA_GET_VISIBLE_DOM);
  });

  it("scopes DOM-CUA affordances to the observation id and records a DOM-CUA revision", async () => {
    const transport = new ConfigurableObserveTransport();
    const tab = new Tab(
      transport as unknown as Transport,
      new Guards(),
      "tab-1",
      {},
      {
        supportedMethods: [M.DOM_CUA_GET_VISIBLE_DOM, M.DOM_CUA_CLICK],
      },
    );

    const observation = await tab.observe({ mode: "actionable" });

    expect(observation.status).toBe("succeeded");
    expect(observation.sections.domCua).toEqual({ status: "present" });
    expect(observation.lifecycle.domCuaRevision).toMatch(/^psh_[0-9a-f]{8}$/);
    const domCall = transport.calls.find((call) => call.method === M.DOM_CUA_GET_VISIBLE_DOM);
    expect(domCall?.params).toMatchObject({
      tab_id: "tab-1",
      format: "compact_text",
      observation_id: observation.observationId,
    });
  });

  it("returns blocked when actionable observation has no usable page action family", async () => {
    const transport = new FakeTransport();
    const tab = new Tab(
      transport as unknown as Transport,
      new Guards(),
      "tab-1",
      {},
      {
        unsupportedMethods: [
          M.PLAYWRIGHT_LOCATOR_CLICK,
          M.PLAYWRIGHT_LOCATOR_FILL,
          M.PLAYWRIGHT_LOCATOR_PRESS,
          M.DOM_CUA_GET_VISIBLE_DOM,
          M.DOM_CUA_CLICK,
          M.DOM_CUA_TYPE,
          M.DOM_CUA_SCROLL,
          M.DOM_CUA_KEYPRESS,
          M.CUA_CLICK,
          M.CUA_MOVE,
          M.CUA_SCROLL,
          M.CUA_TYPE,
          M.CUA_KEYPRESS,
        ],
      },
    );

    const observation = await tab.observe({ mode: "actionable" });

    expect(observation.status).toBe("blocked");
    expect(observation.diagnostics.stateTrace.map((entry) => entry.state)).toEqual([
      "requested",
      "preflight",
      "reading_backend",
      "composing_snapshot",
      "blocked",
    ]);
    expect(observation.sections.domCua).toEqual({
      status: "blocked",
      reason: "capability_unsupported",
    });
    expect(observation.actionFamilies.map((family) => [family.name, family.status])).toEqual([
      ["locator", "unsupported"],
      ["dom-cua", "unsupported"],
      ["coordinate-cua", "unsupported"],
      ["raw-cdp", "unknown"],
    ]);
  });

  it("does not treat DOM-CUA read-only support as an actionable family", async () => {
    const transport = new ConfigurableObserveTransport();
    const tab = new Tab(
      transport as unknown as Transport,
      new Guards(),
      "tab-1",
      {},
      {
        supportedMethods: [M.DOM_CUA_GET_VISIBLE_DOM],
      },
    );

    const observation = await tab.observe({ mode: "actionable" });

    expect(observation.status).toBe("blocked");
    expect(observation.sections.domCua).toEqual({ status: "present" });
    expect(observation.actionFamilies.map((family) => [family.name, family.status])).toEqual([
      ["locator", "unsupported"],
      ["dom-cua", "unsupported"],
      ["coordinate-cua", "unsupported"],
      ["raw-cdp", "unsupported"],
    ]);
    expect(observation.diagnostics.stateTrace.map((entry) => entry.state)).toEqual([
      "requested",
      "preflight",
      "reading_backend",
      "composing_snapshot",
      "blocked",
    ]);
  });

  it("reports ownership state independently from read-only observation state", async () => {
    const transport = new FakeTransport();
    const tab = new Tab(
      transport as unknown as Transport,
      new Guards(),
      "tab-1",
      { commandable: false, claimRequired: true, owned: false, status: "handoff" },
    );

    const observation = await tab.observe({ includeText: false });

    expect(observation.status).toBe("succeeded");
    expect(observation.ownership).toEqual({
      state: "human_controlled",
      commandable: false,
      owned: false,
      claimRequired: true,
      status: "handoff",
    });
    expect(observation.diagnostics.stateTrace.map((entry) => entry.state)).toEqual([
      "requested",
      "preflight",
      "reading_backend",
      "composing_snapshot",
      "succeeded",
    ]);
  });

  it("returns failed when actionable observe loses both text and DOM-CUA planning inputs", async () => {
    const transport = new ConfigurableObserveTransport();
    transport.failText = true;
    transport.failDomCua = true;
    const tab = new Tab(
      transport as unknown as Transport,
      new Guards(),
      "tab-1",
      {},
      {
        supportedMethods: [M.DOM_CUA_GET_VISIBLE_DOM, M.DOM_CUA_CLICK],
      },
    );

    const observation = await tab.observe({ mode: "actionable" });

    expect(observation.status).toBe("failed");
    expect(observation.sections.text).toMatchObject({
      status: "failed",
      reason: "text snapshot unavailable",
    });
    expect(observation.sections.domCua).toMatchObject({
      status: "failed",
      reason: "DOM-CUA unavailable",
    });
    expect(observation.diagnostics.stateTrace.map((entry) => entry.state)).toEqual([
      "requested",
      "preflight",
      "reading_backend",
      "composing_snapshot",
      "failed",
    ]);
  });

  it("returns partial when visual observe keeps planning data but screenshot fails", async () => {
    const transport = new ConfigurableObserveTransport();
    transport.failScreenshot = true;
    const tab = new Tab(
      transport as unknown as Transport,
      new Guards(),
      "tab-1",
      {},
      {
        supportedMethods: [M.DOM_CUA_GET_VISIBLE_DOM, M.DOM_CUA_CLICK],
      },
    );

    const observation = await tab.observe({ mode: "visual" });

    expect(observation.status).toBe("partial");
    expect(observation.sections.text).toEqual({ status: "present" });
    expect(observation.sections.domCua).toEqual({ status: "present" });
    expect(observation.sections.screenshot).toMatchObject({
      status: "failed",
      reason: "screenshot unavailable",
    });
    expect(observation.diagnostics.stateTrace.map((entry) => entry.state)).toEqual([
      "requested",
      "preflight",
      "reading_backend",
      "composing_snapshot",
      "partial",
    ]);
  });
});

describe("Tab.observe ownership coherence", () => {
  it("reports lost, non-commandable ownership after the runtime epoch advances", async () => {
    const transport = new FakeTransport();
    const ctx = { lifecycleEpoch: { value: 0, updatedAt: 0 } };
    const tab = new Tab(
      transport as unknown as Transport,
      new Guards(),
      "tab-1",
      { commandable: true, owned: true, status: "active" },
      ctx,
    );

    const before = await tab.observe();
    expect(before.ownership.state).toBe("claimed_by_agent");
    expect(before.ownership.commandable).toBe(true);

    // A host restart bumps the runtime epoch (what markTabRuntimeContextStale does).
    ctx.lifecycleEpoch = { value: 1, staleReason: "host_restart", updatedAt: 1 };

    const after = await tab.observe();
    expect(after.ownership.state).toBe("lost");
    expect(after.ownership.commandable).toBe(false);
    expect(after.diagnostics.advisories.some((a) => /re-acquire/i.test(a))).toBe(true);
  });

  it("self-heals ownership after a successful re-attach refreshes the handle epoch", async () => {
    class AttachTransport extends FakeTransport {
      override async sendRequest<T>(method: string, params: Record<string, unknown>, timeout?: number): Promise<T> {
        if (method === M.ATTACH) {
          this.calls.push({ method, params, timeout });
          return undefined as T;
        }
        return super.sendRequest<T>(method, params, timeout);
      }
    }
    const transport = new AttachTransport();
    const ctx = { lifecycleEpoch: { value: 0, updatedAt: 0 } };
    const tab = new Tab(
      transport as unknown as Transport,
      new Guards(),
      "tab-1",
      { commandable: true, owned: true, status: "active" },
      ctx,
    );

    ctx.lifecycleEpoch = { value: 1, staleReason: "host_restart", updatedAt: 1 };
    expect((await tab.observe()).ownership.state).toBe("lost");

    // Benign reconnect: the backend still owns the tab, so attach() succeeds and the
    // handle is revalidated at the current epoch.
    await tab.attach();

    const healed = await tab.observe();
    expect(healed.ownership.state).toBe("claimed_by_agent");
    expect(healed.ownership.commandable).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { Guards } from "../src/guards.js";
import { clearSessionMetaCacheForTests } from "../src/session-meta.js";
import { Tab } from "../src/tab.js";
import type { Transport } from "../src/wire/transport.js";
import * as M from "../src/wire/methods.js";

class FakeTransport {
  calls: Array<{ method: string; params: Record<string, unknown>; timeout?: number }> = [];
  url = "https://example.com/form";
  title = "Example Form";
  viewport = {
    width: 1024,
    height: 768,
    scrollX: 0,
    scrollY: 0,
    devicePixelRatio: 2,
  };
  focus = {
    tag: "button",
    id: "submit",
    name: "",
    type: "button",
    placeholder: "",
    ariaLabel: "Submit",
  };
  domCuaText = "[1] button Submit";
  domCuaNodes: unknown[] = [
    { node_id: "1", tag: "button", bounds: { x: 40, y: 60, width: 20, height: 10 } },
  ];
  domCuaClickResult: unknown = {
    node_id: "1",
    point: { x: 42, y: 64, coordinateSpace: "visualViewport" },
  };
  failSnapshotText = false;
  failCoordinateClick = false;

  async sendRequest<T>(method: string, params: Record<string, unknown>, timeout?: number): Promise<T> {
    this.calls.push({ method, params, timeout });
    if (method === M.TAB_URL) return this.url as T;
    if (method === M.TAB_TITLE) return this.title as T;
    if (method === M.TAB_SNAPSHOT_TEXT) {
      if (this.failSnapshotText) throw new Error("snapshot text failed");
      return {
        result: {
          value: {
            __obu_evaluate_value: {
              url: this.url,
              title: this.title,
              viewport: this.viewport,
              focus: this.focus,
              headings: [],
              buttons: ["Submit"],
              links: [],
              forms: [],
            },
          },
        },
      } as T;
    }
    if (method === M.DOM_CUA_GET_VISIBLE_DOM) {
      return { text: this.domCuaText, nodes: this.domCuaNodes } as T;
    }
    if (method === M.DOM_CUA_CLICK) {
      return this.domCuaClickResult as T;
    }
    if (method === M.CUA_CLICK && this.failCoordinateClick) {
      throw new Error("coordinate click failed");
    }
    return null as T;
  }
}

function tabWithCapabilities(
  transport: FakeTransport,
  extraContext: ConstructorParameters<typeof Tab>[4] = {},
): Tab {
  return new Tab(
    transport as unknown as Transport,
    new Guards(),
    "tab-1",
    { commandable: true, owned: true },
    {
      supportedMethods: [
        M.PLAYWRIGHT_LOCATOR_CLICK,
        M.PLAYWRIGHT_LOCATOR_FILL,
        M.DOM_CUA_GET_VISIBLE_DOM,
        M.DOM_CUA_CLICK,
        M.CUA_CLICK,
        M.CUA_MOVE,
      ],
      ...extraContext,
    },
  );
}

describe("Tab environment-native action layer", () => {
  afterEach(() => {
    delete (globalThis as { obuRepl?: unknown }).obuRepl;
    clearSessionMetaCacheForTests();
    vi.useRealTimers();
  });

  it("routes tab.act.click through Locator with structured action result", async () => {
    const transport = new FakeTransport();
    const tab = tabWithCapabilities(transport);

    const result = await tab.act.click({
      source: "locator",
      selector: "button",
    });

    expect(result).toMatchObject({
      kind: "locator.click",
      status: "succeeded",
      effect: "input_dispatched",
    });
    expect(actionStates(result)).toEqual([
      "planned",
      "preflight",
      "running",
      "waiting_for_effect",
      "reconciling",
      "succeeded",
    ]);
    expect(transport.calls.map((call) => call.method)).toEqual([M.PLAYWRIGHT_LOCATOR_CLICK]);
    expect(transport.calls[0]?.params).toMatchObject({
      tab_id: "tab-1",
      selector: "button",
      command: M.PLAYWRIGHT_LOCATOR_CLICK,
    });
  });

  it("validates and consumes observation-scoped DOM-CUA actions", async () => {
    const transport = new FakeTransport();
    const tab = tabWithCapabilities(transport);
    const observation = await tab.observe({
      mode: "actionable",
      includeText: false,
      observationTtlMs: 60_000,
    });
    transport.calls = [];

    const result = await tab.step({
      actionId: "act-dom-click",
      kind: "dom_cua.click",
      target: {
        source: "dom-cua",
        observationId: observation.observationId,
        nodeId: "1",
      },
    });

    expect(result).toMatchObject({
      kind: "dom_cua.click",
      status: "succeeded",
      effect: "input_dispatched",
      invalidatedObservations: [observation.observationId],
      pointer: {
        tabId: "tab-1",
        x: 42,
        y: 64,
        phase: "idle",
        source: "agent",
      },
    });
    expect(transport.calls.map((call) => call.method)).toEqual([
      M.TAB_URL,
      M.TAB_TITLE,
      M.DOM_CUA_GET_VISIBLE_DOM,
      M.DOM_CUA_CLICK,
    ]);
    expect(transport.calls[2]?.params).toMatchObject({
      tab_id: "tab-1",
      format: "compact_text",
    });
    expect(transport.calls[2]?.params).not.toHaveProperty("observation_id");
    expect(transport.calls[3]?.params).toMatchObject({
      tab_id: "tab-1",
      node_id: "1",
      observation_id: observation.observationId,
    });

    transport.calls = [];
    const blocked = await tab.step({
      kind: "dom_cua.click",
      target: {
        source: "dom-cua",
        observationId: observation.observationId,
        nodeId: "1",
      },
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      error: {
        code: "invalid_observation",
        data: {
          state: "invalid",
          invalidity: {
            reason: "consumed",
            detail: "used by dom_cua.click",
          },
          consumedByActionId: "act-dom-click",
        },
      },
    });
    expect(actionStates(blocked)).toEqual(["planned", "preflight", "blocked"]);
    expect(transport.calls).toEqual([]);
  });

  it("blocks environment-native DOM-CUA actions without an observation id", async () => {
    const transport = new FakeTransport();
    const tab = tabWithCapabilities(transport);

    const blocked = await tab.step({
      kind: "dom_cua.click",
      target: {
        source: "dom-cua",
        nodeId: "1",
      } as never,
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      error: { code: "missing_observation" },
    });
    expect(actionStates(blocked)).toEqual(["planned", "preflight", "blocked"]);
    expect(transport.calls).toEqual([]);
  });

  it("blocks unsupported Locator and Coordinate actions in preflight", async () => {
    const transport = new FakeTransport();
    const tab = new Tab(
      transport as unknown as Transport,
      new Guards(),
      "tab-1",
      { commandable: true, owned: true },
      {
        supportedMethods: [M.CUA_MOVE],
      },
    );

    const locatorBlocked = await tab.act.click({
      source: "locator",
      selector: "button",
    });

    expect(locatorBlocked).toMatchObject({
      status: "blocked",
      effect: "no_visible_change",
      error: {
        code: "unsupported_backend_capability",
        data: {
          action: "locator.click",
          method: M.PLAYWRIGHT_LOCATOR_CLICK,
          missing_capability: `method:${M.PLAYWRIGHT_LOCATOR_CLICK}`,
        },
      },
    });
    expect(actionStates(locatorBlocked)).toEqual(["planned", "preflight", "blocked"]);

    const coordinateBlocked = await tab.act.click({
      source: "coordinate",
      x: 10,
      y: 20,
    });

    expect(coordinateBlocked).toMatchObject({
      status: "blocked",
      effect: "no_visible_change",
      error: {
        code: "unsupported_backend_capability",
        data: {
          action: "coordinate.click",
          method: M.CUA_CLICK,
          missing_capability: `method:${M.CUA_CLICK}`,
        },
      },
    });
    expect(actionStates(coordinateBlocked)).toEqual(["planned", "preflight", "blocked"]);
    expect(transport.calls).toEqual([]);
  });

  it("blocks unsupported DOM-CUA action methods even when DOM-CUA observation exists", async () => {
    const transport = new FakeTransport();
    const tab = tabWithCapabilities(transport, {
      supportedMethods: [M.DOM_CUA_GET_VISIBLE_DOM, M.DOM_CUA_CLICK],
    });
    const observation = await tab.observe({
      mode: "actionable",
      includeText: false,
      observationTtlMs: 60_000,
    });
    transport.calls = [];

    const blocked = await tab.act.type({
      source: "dom-cua",
      observationId: observation.observationId,
      nodeId: "1",
    }, "hello");

    expect(blocked).toMatchObject({
      status: "blocked",
      effect: "no_visible_change",
      error: {
        code: "unsupported_backend_capability",
        data: {
          action: "dom_cua.type",
          method: M.DOM_CUA_TYPE,
          missing_capability: `method:${M.DOM_CUA_TYPE}`,
        },
      },
    });
    expect(actionStates(blocked)).toEqual(["planned", "preflight", "blocked"]);
    expect(transport.calls).toEqual([]);
  });

  it("blocks actions while the tab is not commandable before browser side effects", async () => {
    const transport = new FakeTransport();
    const tab = new Tab(
      transport as unknown as Transport,
      new Guards(),
      "tab-1",
      { commandable: false, owned: true, status: "handoff" },
      {
        supportedMethods: [M.CUA_MOVE],
      },
    );

    const blocked = await tab.act.move(10, 20);

    expect(blocked).toMatchObject({
      status: "blocked",
      effect: "no_visible_change",
      error: { code: "tab_not_commandable" },
    });
    expect(actionStates(blocked)).toEqual(["planned", "preflight", "blocked"]);
    expect(transport.calls).toEqual([]);
  });

  it("blocks unknown observation ids before any browser side effect", async () => {
    const transport = new FakeTransport();
    const tab = tabWithCapabilities(transport);

    const blocked = await tab.step({
      kind: "dom_cua.click",
      target: {
        source: "dom-cua",
        observationId: "unknown-observation",
        nodeId: "1",
      },
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      effect: "no_visible_change",
      error: { code: "unknown_observation" },
    });
    expect(actionStates(blocked)).toEqual(["planned", "preflight", "blocked"]);
    expect(transport.calls).toEqual([]);
  });

  it("blocks observations created for a different tab before any browser side effect", async () => {
    const transport = new FakeTransport();
    const runtimeContext = {
      supportedMethods: [
        M.DOM_CUA_GET_VISIBLE_DOM,
        M.DOM_CUA_CLICK,
        M.TAB_URL,
        M.TAB_TITLE,
      ],
      observationStore: new Map(),
      lifecycleEpoch: { value: 0, updatedAt: Date.now() },
    } satisfies ConstructorParameters<typeof Tab>[4];
    const tabOne = new Tab(
      transport as unknown as Transport,
      new Guards(),
      "tab-1",
      { commandable: true, owned: true },
      runtimeContext,
    );
    const tabTwo = new Tab(
      transport as unknown as Transport,
      new Guards(),
      "tab-2",
      { commandable: true, owned: true },
      runtimeContext,
    );
    const observation = await tabOne.observe({
      mode: "actionable",
      includeText: false,
      observationTtlMs: 60_000,
    });
    transport.calls = [];

    const blocked = await tabTwo.step({
      kind: "dom_cua.click",
      target: {
        source: "dom-cua",
        observationId: observation.observationId,
        nodeId: "1",
      },
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      effect: "no_visible_change",
      error: {
        code: "wrong_observation_tab",
        data: {
          tabId: "tab-1",
        },
      },
    });
    expect(actionStates(blocked)).toEqual(["planned", "preflight", "blocked"]);
    expect(transport.calls).toEqual([]);
  });

  it("blocks expired observations and records lifecycle invalidity before side effects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const transport = new FakeTransport();
    const tab = tabWithCapabilities(transport);
    const observation = await tab.observe({
      mode: "actionable",
      includeText: false,
      observationTtlMs: 5,
    });
    transport.calls = [];
    vi.setSystemTime(1_010);

    const blocked = await tab.step({
      kind: "dom_cua.click",
      target: {
        source: "dom-cua",
        observationId: observation.observationId,
        nodeId: "1",
      },
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      effect: "no_visible_change",
      error: {
        code: "invalid_observation",
        data: {
          state: "invalid",
          invalidity: {
            reason: "expired",
            detail: "observation ttl elapsed",
          },
        },
      },
    });
    expect(actionStates(blocked)).toEqual(["planned", "preflight", "blocked"]);
    expect(transport.calls).toEqual([]);
  });

  it("blocks DOM-CUA actions that reference observations without DOM-CUA affordances", async () => {
    const transport = new FakeTransport();
    const tab = tabWithCapabilities(transport);
    const observation = await tab.observe({ observationTtlMs: 60_000 });
    transport.calls = [];

    const blocked = await tab.step({
      kind: "dom_cua.click",
      target: {
        source: "dom-cua",
        observationId: observation.observationId,
        nodeId: "1",
      },
    });

    expect(observation.sections.domCua).toEqual({ status: "omitted", reason: "not_requested" });
    expect(blocked).toMatchObject({
      status: "blocked",
      effect: "no_visible_change",
      error: { code: "invalid_observation" },
    });
    expect(blocked.error?.message).toContain("did not include DOM-CUA affordances");
    expect(transport.calls).toEqual([]);
  });

  it("fails closed when an observation no longer matches page state", async () => {
    const transport = new FakeTransport();
    const tab = tabWithCapabilities(transport);
    const observation = await tab.observe({ mode: "actionable", includeText: false, observationTtlMs: 60_000 });
    transport.calls = [];
    transport.url = "https://example.com/success";
    transport.title = "Success";

    const blocked = await tab.step({
      kind: "dom_cua.click",
      target: {
        source: "dom-cua",
        observationId: observation.observationId,
        nodeId: "1",
      },
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      error: { code: "stale_observation" },
      invalidatedObservations: [observation.observationId],
    });
    expect(actionStates(blocked)).toEqual(["planned", "preflight", "blocked"]);
    expect(transport.calls.map((call) => call.method)).toEqual([M.TAB_URL, M.TAB_TITLE]);

    transport.calls = [];
    const invalid = await tab.step({
      kind: "dom_cua.click",
      target: {
        source: "dom-cua",
        observationId: observation.observationId,
        nodeId: "1",
      },
    });

    expect(invalid).toMatchObject({
      status: "blocked",
      error: {
        code: "invalid_observation",
        data: {
          state: "invalid",
          invalidity: {
            reason: "stale",
            detail: "page state changed since observation",
          },
        },
      },
    });
    expect(actionStates(invalid)).toEqual(["planned", "preflight", "blocked"]);
    expect(transport.calls).toEqual([]);
  });

  it("fails closed when viewport or focus revisions change under the same URL and title", async () => {
    const transport = new FakeTransport();
    const tab = tabWithCapabilities(transport);
    const observation = await tab.observe({
      mode: "actionable",
      observationTtlMs: 60_000,
    });
    transport.calls = [];
    transport.viewport = { ...transport.viewport, scrollY: 300 };

    const blocked = await tab.step({
      kind: "dom_cua.click",
      target: {
        source: "dom-cua",
        observationId: observation.observationId,
        nodeId: "1",
      },
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      error: {
        code: "stale_observation",
        data: { changed: "geometry" },
      },
      invalidatedObservations: [observation.observationId],
    });
    expect(transport.calls.map((call) => call.method)).toEqual([
      M.TAB_URL,
      M.TAB_TITLE,
      M.TAB_SNAPSHOT_TEXT,
    ]);
    expect(transport.calls.map((call) => call.method)).not.toContain(M.DOM_CUA_CLICK);
  });

  it("fails closed when DOM-CUA geometry changes even if visible text is unchanged", async () => {
    const transport = new FakeTransport();
    const tab = tabWithCapabilities(transport);
    const observation = await tab.observe({
      mode: "actionable",
      includeText: false,
      observationTtlMs: 60_000,
    });
    transport.calls = [];
    transport.domCuaNodes = [
      { node_id: "1", tag: "button", bounds: { x: 200, y: 300, width: 20, height: 10 } },
    ];

    const blocked = await tab.step({
      kind: "dom_cua.click",
      target: {
        source: "dom-cua",
        observationId: observation.observationId,
        nodeId: "1",
      },
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      error: {
        code: "stale_observation",
        data: { changed: "dom" },
      },
      invalidatedObservations: [observation.observationId],
    });
    expect(transport.calls.map((call) => call.method)).toEqual([
      M.TAB_URL,
      M.TAB_TITLE,
      M.DOM_CUA_GET_VISIBLE_DOM,
    ]);
    expect(transport.calls.map((call) => call.method)).not.toContain(M.DOM_CUA_CLICK);
  });

  it("blocks coordinate replay when the visual revision changed since observation", async () => {
    const transport = new FakeTransport();
    const observationStore = new Map();
    const tab = tabWithCapabilities(transport, { observationStore });
    const observation = await tab.observe({
      mode: "actionable",
      includeText: false,
      observationTtlMs: 60_000,
    });
    // Seed visual revisions on the stored lifecycle (Task 4.3 will populate these
    // at observe time; for now we set them directly to exercise the preflight check).
    const stored = observationStore.get(observation.observationId)!;
    stored.visualRevision = "vis-1";
    stored.annotationRevision = "ann-1";
    transport.calls = [];

    const blocked = await tab.step({
      kind: "coordinate.click",
      target: {
        source: "coordinate",
        x: 10,
        y: 20,
        observationId: observation.observationId,
        annotationId: "a1",
        visualRevision: "vis-2",
        annotationRevision: "ann-1",
      },
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      error: {
        code: "stale_observation",
        data: {
          changed: "visual",
          expected: "vis-1",
          current: "vis-2",
        },
      },
      invalidatedObservations: [observation.observationId],
    });
    expect(transport.calls.map((call) => call.method)).not.toContain(M.CUA_CLICK);
  });

  it("blocks coordinate replay when the annotation revision changed since observation", async () => {
    const transport = new FakeTransport();
    const observationStore = new Map();
    const tab = tabWithCapabilities(transport, { observationStore });
    const observation = await tab.observe({
      mode: "actionable",
      includeText: false,
      observationTtlMs: 60_000,
    });
    const stored = observationStore.get(observation.observationId)!;
    stored.visualRevision = "vis-1";
    stored.annotationRevision = "ann-1";
    transport.calls = [];

    const blocked = await tab.step({
      kind: "coordinate.click",
      target: {
        source: "coordinate",
        x: 10,
        y: 20,
        observationId: observation.observationId,
        annotationId: "a1",
        visualRevision: "vis-1",
        annotationRevision: "ann-2",
      },
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      error: {
        code: "stale_observation",
        data: {
          changed: "annotation",
          expected: "ann-1",
          current: "ann-2",
        },
      },
      invalidatedObservations: [observation.observationId],
    });
    expect(transport.calls.map((call) => call.method)).not.toContain(M.CUA_CLICK);
  });

  it("blocks coordinate replay that omits visual/annotation tokens for a visual observation (Finding 3)", async () => {
    const transport = new FakeTransport();
    const observationStore = new Map();
    const tab = tabWithCapabilities(transport, { observationStore });
    const observation = await tab.observe({
      mode: "actionable",
      includeText: false,
      observationTtlMs: 60_000,
    });
    // The stored lifecycle is a VISUAL observation (carries visual revisions)...
    const stored = observationStore.get(observation.observationId)!;
    stored.visualRevision = "vis-1";
    stored.annotationRevision = "ann-1";
    transport.calls = [];

    // ...but the coordinate target deliberately omits all visual/annotation
    // tokens. It must be blocked (not silently executed), since it cannot prove
    // it is replaying against the same pixels.
    const blocked = await tab.step({
      kind: "coordinate.click",
      target: {
        source: "coordinate",
        x: 10,
        y: 20,
        observationId: observation.observationId,
      },
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      error: {
        code: "stale_observation",
        data: { changed: "visual" },
      },
      invalidatedObservations: [observation.observationId],
    });
    expect(transport.calls.map((call) => call.method)).not.toContain(M.CUA_CLICK);
  });

  it("fails closed when required text revisions cannot be checked", async () => {
    const transport = new FakeTransport();
    const tab = tabWithCapabilities(transport);
    const observation = await tab.observe({
      mode: "actionable",
      observationTtlMs: 60_000,
    });
    transport.calls = [];
    transport.failSnapshotText = true;

    const blocked = await tab.step({
      kind: "dom_cua.click",
      target: {
        source: "dom-cua",
        observationId: observation.observationId,
        nodeId: "1",
      },
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      error: {
        code: "stale_observation",
        data: { changed: "unknown", error: "snapshot text failed" },
      },
      invalidatedObservations: [observation.observationId],
    });
    expect(transport.calls.map((call) => call.method)).toEqual([
      M.TAB_URL,
      M.TAB_TITLE,
      M.TAB_SNAPSHOT_TEXT,
    ]);
    expect(transport.calls.map((call) => call.method)).not.toContain(M.DOM_CUA_CLICK);
  });

  it("fails closed when guarded page-state revalidation is denied before title reads", async () => {
    const transport = new FakeTransport();
    const guards = new Guards({
      checkCurrentOrigin: async (_tabId, _url, command) => {
        if (command === M.TAB_TITLE) throw new Error("title read denied");
      },
    });
    const tab = new Tab(
      transport as unknown as Transport,
      guards,
      "tab-1",
      { commandable: true, owned: true },
      {
        supportedMethods: [
          M.DOM_CUA_GET_VISIBLE_DOM,
          M.DOM_CUA_CLICK,
          M.TAB_URL,
          M.TAB_TITLE,
        ],
      },
    );
    const observation = await tab.observe({
      mode: "actionable",
      includeText: false,
      observationTtlMs: 60_000,
    });
    transport.calls = [];

    const blocked = await tab.act.click({
      source: "dom-cua",
      observationId: observation.observationId,
      nodeId: "1",
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      effect: "no_visible_change",
      error: {
        code: "stale_observation",
        data: { changed: "unknown", error: expect.stringContaining("title read denied") },
      },
    });
    expect(transport.calls.map((call) => call.method)).toEqual([M.TAB_URL]);
    expect(transport.calls.map((call) => call.method)).not.toContain(M.TAB_TITLE);
    expect(transport.calls.map((call) => call.method)).not.toContain(M.DOM_CUA_CLICK);
  });

  it("fails closed when guarded text revalidation is denied before snapshot reads", async () => {
    const transport = new FakeTransport();
    let denySnapshotText = false;
    const guards = new Guards({
      checkCurrentOrigin: async (_tabId, _url, command) => {
        if (denySnapshotText && command === M.TAB_SNAPSHOT_TEXT) throw new Error("snapshot read denied");
      },
    });
    const tab = new Tab(
      transport as unknown as Transport,
      guards,
      "tab-1",
      { commandable: true, owned: true },
      {
        supportedMethods: [
          M.DOM_CUA_GET_VISIBLE_DOM,
          M.DOM_CUA_CLICK,
          M.TAB_URL,
          M.TAB_TITLE,
          M.TAB_SNAPSHOT_TEXT,
        ],
      },
    );
    const observation = await tab.observe({
      mode: "actionable",
      observationTtlMs: 60_000,
    });
    expect(observation.lifecycle.viewportRevision).toBeDefined();
    expect(observation.lifecycle.focusRevision).toBeDefined();
    denySnapshotText = true;
    transport.calls = [];

    const blocked = await tab.act.click({
      source: "dom-cua",
      observationId: observation.observationId,
      nodeId: "1",
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      effect: "no_visible_change",
      error: {
        code: "stale_observation",
        data: { changed: "unknown", error: expect.stringContaining("snapshot read denied") },
      },
    });
    expect(transport.calls.map((call) => call.method)).toEqual([
      M.TAB_URL,
      M.TAB_TITLE,
      M.TAB_URL,
    ]);
    expect(transport.calls.map((call) => call.method)).not.toContain(M.TAB_SNAPSHOT_TEXT);
    expect(transport.calls.map((call) => call.method)).not.toContain(M.DOM_CUA_CLICK);
  });

  it("updates pointer state for coordinate actions", async () => {
    const transport = new FakeTransport();
    const tab = tabWithCapabilities(transport);

    const result = await tab.act.move(10, 20, { modifiers: ["Shift"] });

    expect(result).toMatchObject({
      kind: "coordinate.move",
      status: "succeeded",
      effect: "pointer_moved",
      pointer: {
        tabId: "tab-1",
        x: 10,
        y: 20,
        phase: "idle",
        source: "agent",
        modifiers: ["Shift"],
      },
    });
    expect(transport.calls.map((call) => call.method)).toEqual([M.CUA_MOVE]);
  });

  it("blocks coordinate pointer actions after stale pointer state until tied to a fresh observation", async () => {
    const transport = new FakeTransport();
    const pointerStore = new Map();
    const tab = tabWithCapabilities(transport, { pointerStore });
    await tab.act.move(10, 20);
    await tab.act.click({
      source: "locator",
      selector: "button",
    });
    expect(pointerStore.get("tab-1")).toMatchObject({
      phase: "stale",
      staleReason: "locator action executed without a reported cursor point",
    });
    transport.calls = [];

    const blocked = await tab.act.click({
      source: "coordinate",
      x: 10,
      y: 20,
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      effect: "no_visible_change",
      error: {
        code: "stale_pointer",
        data: {
          staleReason: "locator action executed without a reported cursor point",
        },
      },
    });
    expect(actionStates(blocked)).toEqual(["planned", "preflight", "blocked"]);
    expect(transport.calls).toEqual([]);

    const observation = await tab.observe({ includeText: false, observationTtlMs: 60_000 });
    transport.calls = [];
    const recovered = await tab.step({
      kind: "coordinate.click",
      target: {
        source: "coordinate",
        x: 10,
        y: 20,
        observationId: observation.observationId,
      },
    });

    expect(recovered).toMatchObject({
      status: "succeeded",
      effect: "input_dispatched",
      invalidatedObservations: [observation.observationId],
      pointer: {
        tabId: "tab-1",
        x: 10,
        y: 20,
        phase: "idle",
        source: "agent",
        visible: true,
      },
    });
    expect(actionStates(recovered)).toEqual([
      "planned",
      "preflight",
      "running",
      "waiting_for_effect",
      "reconciling",
      "succeeded",
    ]);
    expect(transport.calls.map((call) => call.method)).toEqual([
      M.TAB_URL,
      M.TAB_TITLE,
      M.CUA_CLICK,
    ]);
  });

  it("records failed action transitions without pretending reconciliation succeeded", async () => {
    const transport = new FakeTransport();
    transport.failCoordinateClick = true;
    const tab = tabWithCapabilities(transport);

    const failed = await tab.act.click({
      source: "coordinate",
      x: 10,
      y: 20,
    });

    expect(failed).toMatchObject({
      kind: "coordinate.click",
      status: "failed",
      effect: "unknown",
      error: {
        code: "action_failed",
        message: "coordinate click failed",
      },
    });
    expect(actionStates(failed)).toEqual(["planned", "preflight", "running", "failed"]);
    expect(failed.pointer).toBeUndefined();
    expect(transport.calls.map((call) => call.method)).toEqual([M.CUA_CLICK]);
  });

  it("marks a known pointer stale when a locator action does not report its action point", async () => {
    installSessionMeta("session-pointer", "turn-stale");
    const transport = new FakeTransport();
    const pointerStore = new Map();
    const tab = tabWithCapabilities(transport, { pointerStore });
    await tab.act.move(10, 20);
    transport.calls = [];

    const result = await tab.act.click({
      source: "locator",
      selector: "button",
    });

    expect(result).toMatchObject({
      status: "succeeded",
      pointer: {
        tabId: "tab-1",
        x: 10,
        y: 20,
        sessionId: "session-pointer",
        turnId: "turn-stale",
        phase: "stale",
        source: "unknown",
        visible: false,
      },
    });
    expect(pointerStore.get("tab-1")).toMatchObject({
      x: 10,
      y: 20,
      sessionId: "session-pointer",
      turnId: "turn-stale",
      phase: "stale",
    });
    expect(transport.calls.map((call) => call.method)).toEqual([M.PLAYWRIGHT_LOCATOR_CLICK]);
  });

  it("marks a known pointer stale when a DOM-CUA action returns no resolved action point", async () => {
    const transport = new FakeTransport();
    const pointerStore = new Map();
    const tab = tabWithCapabilities(transport, { pointerStore });
    await tab.act.move(10, 20);
    const observation = await tab.observe({
      mode: "actionable",
      includeText: false,
      observationTtlMs: 60_000,
    });
    transport.calls = [];
    transport.domCuaClickResult = null;

    const result = await tab.act.click({
      source: "dom-cua",
      observationId: observation.observationId,
      nodeId: "1",
    });

    expect(result).toMatchObject({
      status: "succeeded",
      pointer: {
        tabId: "tab-1",
        x: 10,
        y: 20,
        phase: "stale",
        source: "unknown",
        visible: false,
      },
    });
    expect(pointerStore.get("tab-1")).toMatchObject({
      x: 10,
      y: 20,
      phase: "stale",
    });
    expect(transport.calls.map((call) => call.method)).toEqual([
      M.TAB_URL,
      M.TAB_TITLE,
      M.DOM_CUA_GET_VISIBLE_DOM,
      M.DOM_CUA_CLICK,
    ]);
  });

  it("includes shared pointer state in the next observation", async () => {
    const transport = new FakeTransport();
    const pointerStore = new Map();
    const tab = tabWithCapabilities(transport, { pointerStore });

    await tab.act.move(10, 20, { modifiers: ["Shift"] });
    transport.calls = [];

    const observation = await tab.observe({ includeText: false });

    expect(observation.sections.pointer).toEqual({ status: "present" });
    expect(observation.pointer).toMatchObject({
      tabId: "tab-1",
      x: 10,
      y: 20,
      phase: "idle",
      source: "agent",
      modifiers: ["Shift"],
    });
    expect(pointerStore.get("tab-1")).toMatchObject({ x: 10, y: 20 });
    expect(transport.calls.map((call) => call.method)).toEqual([M.TAB_URL, M.TAB_TITLE]);
  });
});

function installSessionMeta(sessionId: string, turnId: string): void {
  (globalThis as { obuRepl?: unknown }).obuRepl = {
    requestMeta: {
      "x-obu-turn-metadata": { session_id: sessionId, turn_id: turnId },
    },
  };
}

function actionStates(result: { diagnostics?: unknown[] }): string[] {
  const trace = result.diagnostics?.find((item): item is { states: Array<{ state: string }> } => {
    return Boolean(item && typeof item === "object" && "states" in item);
  });
  return trace?.states.map((entry) => entry.state) ?? [];
}

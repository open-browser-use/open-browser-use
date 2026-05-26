import { describe, expect, it } from "vitest";
import { Guards } from "../src/guards.js";
import { markTabRuntimeContextStale, Tab } from "../src/tab.js";
import type { TabRuntimeContext } from "../src/tab.js";
import type { Transport } from "../src/wire/transport.js";
import * as M from "../src/wire/methods.js";

// Task 5.6 / Finding 10: cross-process observation-id semantics.
//
// Observation ids and pointer state are PROCESS-LOCAL and NON-DURABLE. They
// live only in the in-memory observation store of the process that created
// them; nothing persists them across a process / kernel / task-store boundary
// (the host task store deliberately does not store observation ids — Task 5.3).
//
// These tests LOCK the contract that distinguishes the two failure modes:
//   - an observation id ABSENT from the in-memory store (e.g. an id minted by a
//     previous process, replayed after a fresh process/kernel loss) resolves to
//     `unknown_observation` — the tab has simply never heard of it.
//   - an observation id PRESENT in the store but created before the current
//     browser-control lifecycle (a runtime-lifecycle change within the SAME
//     process/epoch) resolves to `stale_observation`.

class FakeTransport {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
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

  async sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === M.TAB_URL) return this.url as T;
    if (method === M.TAB_TITLE) return this.title as T;
    if (method === M.DOM_CUA_GET_VISIBLE_DOM) {
      return { text: this.domCuaText, nodes: this.domCuaNodes } as T;
    }
    return null as T;
  }
}

function makeTab(transport: FakeTransport, extraContext: Partial<TabRuntimeContext> = {}): Tab {
  return new Tab(
    transport as unknown as Transport,
    new Guards(),
    "tab-1",
    { commandable: true, owned: true },
    {
      supportedMethods: [
        M.DOM_CUA_GET_VISIBLE_DOM,
        M.DOM_CUA_CLICK,
        M.TAB_URL,
        M.TAB_TITLE,
      ],
      ...extraContext,
    },
  );
}

describe("cross-process observation-id semantics (Finding 10)", () => {
  it("resolves an id from a previous process to unknown_observation, not stale_observation", async () => {
    // Fresh process: empty observation store. An id minted by a previous
    // process is simply absent — the tab has never heard of it.
    const transport = new FakeTransport();
    const freshTab = makeTab(transport, {
      observationStore: new Map(),
      lifecycleEpoch: { value: 0, updatedAt: Date.now() },
    });

    const blocked = await freshTab.step({
      kind: "dom_cua.click",
      target: {
        source: "dom-cua",
        observationId: "obs-from-previous-process",
        nodeId: "1",
      },
    });

    expect(blocked.status).toBe("blocked");
    expect(blocked.error?.code).toBe("unknown_observation");
    // Crucially NOT conflated with the stale path.
    expect(blocked.error?.code).not.toBe("stale_observation");
    // Absent id is never "invalidated" — there was nothing to invalidate.
    expect(blocked.invalidatedObservations ?? []).toEqual([]);
  });

  it("resolves a present id from a prior epoch to stale_observation within the same runtime", async () => {
    // Same process: observe under the current epoch, then a runtime-lifecycle
    // change (markTabRuntimeContextStale) bumps the epoch. The id is STILL in
    // the store, but its lifecycle epoch no longer matches the current epoch.
    const transport = new FakeTransport();
    const observationStore = new Map();
    const context: TabRuntimeContext = {
      supportedMethods: [
        M.DOM_CUA_GET_VISIBLE_DOM,
        M.DOM_CUA_CLICK,
        M.TAB_URL,
        M.TAB_TITLE,
      ],
      observationStore,
      lifecycleEpoch: { value: 0, updatedAt: Date.now() },
    };
    const sameTab = new Tab(
      transport as unknown as Transport,
      new Guards(),
      "tab-1",
      { commandable: true, owned: true },
      context,
    );

    const observation = await sameTab.observe({
      mode: "actionable",
      includeText: false,
      observationTtlMs: 60_000,
    });
    // The id is present in the in-memory store after observe.
    expect(observationStore.has(observation.observationId)).toBe(true);

    // Drive a runtime-lifecycle change within the same process/runtime.
    markTabRuntimeContextStale(context, "browser-control lifecycle changed");

    // The id is still present in the store...
    expect(observationStore.has(observation.observationId)).toBe(true);

    const blocked = await sameTab.step({
      kind: "dom_cua.click",
      target: {
        source: "dom-cua",
        observationId: observation.observationId,
        nodeId: "1",
      },
    });

    // ...but it now resolves to stale_observation, NOT unknown_observation.
    expect(blocked.status).toBe("blocked");
    expect(blocked.error?.code).toBe("stale_observation");
    expect(blocked.error?.code).not.toBe("unknown_observation");
    expect(blocked.invalidatedObservations).toEqual([observation.observationId]);
  });
});

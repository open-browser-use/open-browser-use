import { describe, expect, it } from "vitest";
import { Guards } from "../src/guards.js";
import { Tab } from "../src/tab.js";
import type { Transport } from "../src/wire/transport.js";
import * as M from "../src/wire/methods.js";

// Minimal transport that supplies the inputs an annotated visual observation
// needs: a text snapshot (url/title/viewport/focus), a DOM-CUA visible-dom
// response carrying node bounds, and a screenshot. Mirrors
// ConfigurableObserveTransport in tab-observe.test.ts.
class VisualObserveTransport {
  calls: Array<{ method: string; params: Record<string, unknown>; timeout?: number }> = [];
  failText = false;
  failDomCua = false;
  failScreenshot = false;

  async sendRequest<T>(method: string, params: Record<string, unknown>, timeout?: number): Promise<T> {
    this.calls.push({ method, params, timeout });
    if (method === M.TAB_URL) return "https://example.com/form" as T;
    if (method === M.TAB_TITLE) return "Example Form" as T;
    if (method === M.TAB_SNAPSHOT_TEXT) {
      if (this.failText) throw new Error("text snapshot unavailable");
      return {
        result: {
          value: {
            __obu_evaluate_value: {
              url: "https://example.com/form",
              title: "Example Form",
              viewport: { width: 1024, height: 768, scrollX: 0, scrollY: 80, devicePixelRatio: 2 },
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
    if (method === M.DOM_CUA_GET_VISIBLE_DOM) {
      if (this.failDomCua) throw new Error("DOM-CUA unavailable");
      return {
        text: "<button node_id=101>Submit</button>",
        nodes: [{ node_id: "101", tag: "button", bounds: { x: 10, y: 20, width: 40, height: 20 } }],
      } as T;
    }
    if (method === M.TAB_SCREENSHOT) {
      if (this.failScreenshot) throw new Error("screenshot unavailable");
      return { data: "aW1hZ2U=", mime_type: "image/jpeg" } as T;
    }
    throw new Error(`unexpected method ${method}`);
  }
}

function visualTab(transport: VisualObserveTransport): Tab {
  return new Tab(
    transport as unknown as Transport,
    new Guards(),
    "tab-1",
    { commandable: true, owned: true, status: "active" },
    { supportedMethods: [M.DOM_CUA_GET_VISIBLE_DOM, M.DOM_CUA_CLICK, M.TAB_SCREENSHOT] },
  );
}

const OBSERVE_REQUEST_STATES = new Set([
  "requested",
  "preflight",
  "reading_backend",
  "composing_snapshot",
  "succeeded",
  "partial",
  "blocked",
  "failed",
  "cancelled",
]);

describe("visual observation", () => {
  it("includes an annotations section and stays in the TabObservation envelope", async () => {
    const transport = new VisualObserveTransport();
    const tab = visualTab(transport);

    const obs = await tab.observe({ mode: "visual" });

    // annotations is a new section-status entry alongside the existing ones.
    expect(obs.sections).toHaveProperty("annotations");
    expect(obs.sections.annotations.status).toBe("present");
    expect(obs.sections.lifecycle).toBeDefined();

    // ownership and lifecycle are top-level envelope fields (NOT under sections).
    expect(obs.ownership).toBeDefined();
    expect(obs.lifecycle).toBeDefined();
    expect(obs.status).toBe("succeeded");
    expect(obs.actionFamilies).toBeDefined();
    expect(obs.diagnostics).toBeDefined();
  });

  it("carries an AnnotatedVisualObservation payload with visual + annotation revisions", async () => {
    const transport = new VisualObserveTransport();
    const tab = visualTab(transport);

    const obs = await tab.observe({ mode: "visual" });

    expect(obs.visual).toBeDefined();
    expect(typeof obs.visual?.visualRevision).toBe("string");
    expect(typeof obs.visual?.annotationRevision).toBe("string");
    expect(obs.visual?.screenshot).toBeDefined();
    expect(obs.visual?.viewport).toMatchObject({ width: 1024, height: 768 });
    expect(obs.visual?.annotations).toEqual([
      { nodeId: "101", bounds: { x: 10, y: 20, width: 40, height: 20 }, label: "button" },
    ]);

    // The freshness loop closes: lifecycle now carries the visual/annotation revisions.
    expect(obs.lifecycle.visualRevision).toMatch(/^psh_[0-9a-f]{8}$/);
    expect(obs.lifecycle.annotationRevision).toMatch(/^psh_[0-9a-f]{8}$/);
    expect(obs.visual?.visualRevision).toBe(obs.lifecycle.visualRevision);
    expect(obs.visual?.annotationRevision).toBe(obs.lifecycle.annotationRevision);
  });

  it("is partial when annotations cannot be composed (screenshot failed)", async () => {
    const transport = new VisualObserveTransport();
    transport.failScreenshot = true;
    const tab = visualTab(transport);

    const obs = await tab.observe({ mode: "visual" });

    expect(obs.sections.annotations.status).toBe("omitted");
    expect(obs.visual).toBeUndefined();
    expect(obs.status).toBe("partial");
  });

  it("keeps the visual observe trace within the ObserveRequestState set", async () => {
    const transport = new VisualObserveTransport();
    const tab = visualTab(transport);

    const obs = await tab.observe({ mode: "visual" });

    const states = obs.diagnostics.stateTrace.map((entry) => entry.state);
    for (const state of states) {
      expect(OBSERVE_REQUEST_STATES.has(state)).toBe(true);
    }
    expect(states).toEqual([
      "requested",
      "preflight",
      "reading_backend",
      "composing_snapshot",
      "succeeded",
    ]);
  });
});

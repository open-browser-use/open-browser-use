import { describe, expect, it, vi } from "vitest";
import { TabRead, buildExtractTableExpression } from "../src/tab-read.js";

// Minimal stub DOM so we can run the REAL generated expression (not a mock) in
// the node test env and prove it walks the DOM and returns structured rows.
function cell(text: string) {
  return { textContent: text };
}
function row(cells: ReturnType<typeof cell>[]) {
  return { querySelectorAll: (sel: string) => (sel === "th,td" ? cells : []) };
}
function table(rows: ReturnType<typeof row>[]) {
  return { querySelectorAll: (sel: string) => (sel === "tr" ? rows : []) };
}
function runExpression(expr: string, document: unknown): { rows: string[][] } {
  return new Function("document", `return (${expr});`)(document) as { rows: string[][] };
}

describe("TabRead.extractTable", () => {
  it("is read-only: never dispatches step actions", async () => {
    const evaluate = vi.fn(async () => ({ rows: [["a", "b"], ["c", "d"]] }));
    const observe = vi.fn(async () => ({
      observationId: "obs-1",
      status: "succeeded",
      sections: {},
    } as any));
    const read = new TabRead({ observe, evaluate });
    const out = await read.extractTable({ selector: "table" });
    expect(out.rows).toEqual([["a", "b"], ["c", "d"]]);
    expect(out.observationId).toBe("obs-1");
    expect(observe).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("records the observation id without consuming it", async () => {
    let observed = "";
    const evaluate = async () => ({ rows: [] });
    const observe = async () => {
      observed = "obs-42";
      return { observationId: observed, status: "succeeded", sections: {} } as any;
    };
    const read = new TabRead({ observe, evaluate });
    await read.extractTable({ selector: "table" });
    expect(read.lastObservationId).toBe("obs-42");
  });

  it("calls evaluate with an expression that includes the selector", async () => {
    let receivedExpression = "";
    const evaluate = async (expression: string) => {
      receivedExpression = expression;
      return { rows: [] };
    };
    const observe = async () => ({ observationId: "o", status: "succeeded", sections: {} } as any);
    const read = new TabRead({ observe, evaluate });
    await read.extractTable({ selector: "table.results" });
    expect(receivedExpression).toContain("table.results");
  });
});

describe("buildExtractTableExpression", () => {
  it("produces structured rows from the live DOM (not a no-op comment)", () => {
    const expr = buildExtractTableExpression("table.results");
    const dom = {
      querySelector: (sel: string) =>
        sel === "table.results"
          ? table([
              row([cell("  H1 "), cell("H2")]),
              row([cell("a"), cell("b")]),
            ])
          : null,
    };
    const out = runExpression(expr, dom);
    // cells are trimmed; both header and body rows are captured
    expect(out.rows).toEqual([["H1", "H2"], ["a", "b"]]);
  });

  it("returns an empty table when the selector matches nothing", () => {
    const expr = buildExtractTableExpression("table");
    const out = runExpression(expr, { querySelector: () => null });
    expect(out.rows).toEqual([]);
  });
});

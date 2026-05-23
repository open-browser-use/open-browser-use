import { describe, expect, it, vi } from "vitest";
import { TabRead } from "../src/tab-read.js";

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

import { describe, expect, it } from "vitest";
import { createHighLevelActionResult } from "../src/high-level-action.js";

describe("HighLevelActionResult", () => {
  it("starts in planned state", () => {
    const result = createHighLevelActionResult("clickByText");
    expect(result.state).toBe("planned");
  });

  it("redacts secret-bearing trace values when recording a step", () => {
    const result = createHighLevelActionResult("fillForm");
    result.recordStep({
      description: "fill password",
      traceValues: [{ kind: "text", field: "password", value: "hunter2" }],
      primitiveTrace: undefined,
    });
    const serialized = JSON.stringify(result.toJSON());
    expect(serialized).not.toContain("hunter2");
    expect(serialized).toContain("[redacted]");
  });

  it("serializes step trace values, status, and history of states", () => {
    const result = createHighLevelActionResult("clickByText");
    result.transition("observing");
    result.transition("blocked");
    const json = result.toJSON();
    expect(json.name).toBe("clickByText");
    expect(json.status).toBe("blocked");
    expect(json.trace).toEqual(["planned", "observing", "blocked"]);
    expect(json.steps).toEqual([]);
  });

  it("delegates state transitions to the underlying state machine and rejects illegal jumps", () => {
    const result = createHighLevelActionResult("clickByText");
    expect(() => result.transition("running_step")).toThrow();
  });

  it("carries through primitiveStatus when present on the step", () => {
    const result = createHighLevelActionResult("clickByText");
    result.recordStep({
      description: "click",
      traceValues: [{ kind: "selector", value: "#submit" }],
      primitiveResult: {
        actionId: "a1",
        kind: "locator.click",
        status: "succeeded",
        effect: "dom_changed",
        startedAt: 0,
        completedAt: 1,
      } as any, // ActionResult shape lives in tab-action.ts; the cast keeps the test focused
    });
    const json = result.toJSON();
    expect(json.steps[0].primitiveStatus).toBe("succeeded");
  });
});

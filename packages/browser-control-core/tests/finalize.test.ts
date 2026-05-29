import { describe, expect, it } from "vitest";
import { parseFinalizeKeep, planFinalizeTabs } from "../src/index.js";
import type { SessionTab } from "../src/index.js";

describe("parseFinalizeKeep (audit §4.8)", () => {
  it("throws on a present-but-non-array keep instead of silently dropping it", () => {
    for (const bad of ["handoff", 5, {}, null, true, { tabId: 1, status: "handoff" }]) {
      expect(() => parseFinalizeKeep({ keep: bad })).toThrow(/keep must be an array/);
    }
  });

  it("treats an absent keep as 'keep nothing' (legitimate)", () => {
    expect(parseFinalizeKeep({}).size).toBe(0);
    expect(parseFinalizeKeep({ keep: undefined }).size).toBe(0);
    expect(parseFinalizeKeep(undefined).size).toBe(0);
  });

  it("still parses a well-formed keep array", () => {
    const keep = parseFinalizeKeep({ keep: [{ tabId: 3, status: "handoff" }] });
    expect(keep.get(3)).toBe("handoff");
  });
});

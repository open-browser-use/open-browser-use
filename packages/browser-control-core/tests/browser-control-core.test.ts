import { describe, expect, it } from "vitest";
import { browserControlProtocolVersion } from "../src/index.js";

describe("browser-control-core package contract", () => {
  it("exports an explicit protocol version", () => {
    expect(browserControlProtocolVersion).toBe(1);
  });
});

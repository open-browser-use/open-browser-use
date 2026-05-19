import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "../src/version.js";

describe("SDK version metadata", () => {
  it("keeps SDK_VERSION synced with package.json", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

    expect(SDK_VERSION).toBe(packageJson.version);
  });
});

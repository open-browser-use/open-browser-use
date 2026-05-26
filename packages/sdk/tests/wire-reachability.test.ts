import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../.."); // packages/sdk/tests -> repo root
const SDK_SRC = path.resolve(HERE, "../src");
const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "wire/methods.json"), "utf8"),
) as { methods: Array<{ constant: string; name: string; family: string }> };

// Families whose methods are agent-facing action surfaces exposed via Tab/Locator.
// Excluded families (lifecycle, session, cdp, history, browser, tasks) are host- or
// node-repl-managed. E.g. moveMouse (family "cdp") drives the overlay pointer
// internally and is intentionally not an SDK method.
const AGENT_FACING_FAMILIES = new Set(["playwright", "cua", "dom-cua", "clipboard", "tab"]);

// Methods in an agent-facing family that the SDK deliberately does NOT send,
// each with the reason. Adding here is the explicit, reviewable way to declare
// that a wire method has no SDK surface on purpose.
const NO_SDK_SENDER_EXPECTED: Record<string, string> = {
  PLAYWRIGHT_WAIT_FOR_URL: "legacy duplicate; SDK uses TAB_WAIT_FOR_URL (Tab.waitForURL)",
  PLAYWRIGHT_WAIT_FOR_LOAD_STATE: "legacy duplicate; SDK uses TAB_WAIT_FOR_LOAD_STATE (Tab.waitForLoadState)",
};

function sdkSourceText(): string {
  const texts: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        // Exclude the generated definition tables: they contain every constant
        // by definition, which would mask a missing sender.
        const isGeneratedTable =
          full.endsWith(path.join("wire", "methods.ts")) ||
          full.endsWith(path.join("wire", "method-policy.ts"));
        if (!isGeneratedTable) texts.push(fs.readFileSync(full, "utf8"));
      }
    }
  };
  walk(SDK_SRC);
  return texts.join("\n");
}

describe("wire reachability", () => {
  const source = sdkSourceText();

  it("every agent-facing wire method has an SDK sender (or a documented exception)", () => {
    const unreachable: string[] = [];
    for (const method of MANIFEST.methods) {
      if (!AGENT_FACING_FAMILIES.has(method.family)) continue;
      if (method.constant in NO_SDK_SENDER_EXPECTED) continue;
      // Reachability = a textual mention of the constant in non-generated src. This is a
      // presence check, not a proof of a sendRequest: a match inside a comment, type, or
      // capability table also passes. Accepted because every agent-facing constant in this
      // codebase appears in src only alongside a real sender; tighten to a send-site regex
      // if that ever stops holding.
      const token = new RegExp(`\\b${method.constant}\\b`);
      if (!token.test(source)) unreachable.push(`${method.constant} (${method.name})`);
    }
    expect(unreachable).toEqual([]);
  });

  it("documented exceptions still exist in the manifest", () => {
    const constants = new Set(MANIFEST.methods.map((m) => m.constant));
    for (const constant of Object.keys(NO_SDK_SENDER_EXPECTED)) {
      expect(constants.has(constant)).toBe(true);
    }
  });
});

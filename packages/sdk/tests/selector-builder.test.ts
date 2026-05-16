import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FrameLocator } from "../src/frame-locator.js";
import { Guards } from "../src/guards.js";
import { Locator } from "../src/locator.js";
import type { Transport } from "../src/wire/transport.js";

type SelectorCase = {
  id?: string;
  name?: string;
  kind?: string;
  expression: string;
  expectedSelector: string;
};

type Oracle = {
  caseCount: number;
  cases: SelectorCase[];
};

const root = resolve(import.meta.dirname, "../../..");
const golden = readOracle("packages/sdk/tests/fixtures/selector-builder.oracle.json");
const fuzz = readOracle("packages/sdk/tests/fixtures/selector-fuzz.oracle.json");
const fakeTransport = {} as Transport;
const guards = new Guards();

describe("selector builder oracle parity", () => {
  it("matches golden selectors", () => {
    for (const item of golden.cases) {
      expect(selectorForExpression(item.expression), item.name ?? item.expression).toBe(item.expectedSelector);
    }
  });

  it("matches metamorphic fuzz selectors", () => {
    expect(fuzz.cases).toHaveLength(fuzz.caseCount);
    expect(fuzz.cases.length).toBeGreaterThanOrEqual(50);
    expectKinds(fuzz.cases);
    for (const item of fuzz.cases) {
      expect(selectorForExpression(item.expression), item.id ?? item.expression).toBe(item.expectedSelector);
    }
  });
});

function readOracle(path: string): Oracle {
  return JSON.parse(readFileSync(resolve(root, path), "utf8")) as Oracle;
}

function selectorForExpression(expression: string): string {
  const page = pageHarness();
  const value = Function("page", `"use strict"; return (${expression});`)(page) as unknown;
  if (!(value instanceof Locator)) {
    throw new Error(`expression did not return Locator: ${expression}`);
  }
  return (value as unknown as { selector: string }).selector;
}

function pageHarness(): {
  locator(selector: string): Locator;
  frameLocator(selector: string): FrameLocator;
  getByRole(role: string, opts?: { name?: string | RegExp; exact?: boolean }): Locator;
  getByText(text: string | RegExp, opts?: { exact?: boolean }): Locator;
  getByLabel(text: string | RegExp, opts?: { exact?: boolean }): Locator;
  getByPlaceholder(text: string | RegExp, opts?: { exact?: boolean }): Locator;
  getByTestId(testId: string): Locator;
} {
  const rootLocator = new Locator(fakeTransport, guards, "tab-1", "");
  return {
    locator: (selector) => new Locator(fakeTransport, guards, "tab-1", selector),
    frameLocator: (selector) => new FrameLocator(fakeTransport, guards, "tab-1", selector),
    getByRole: (role, opts = {}) => rootLocator.getByRole(role, opts),
    getByText: (text, opts = {}) => rootLocator.getByText(text, opts),
    getByLabel: (text, opts = {}) => rootLocator.getByLabel(text, opts),
    getByPlaceholder: (text, opts = {}) => rootLocator.getByPlaceholder(text, opts),
    getByTestId: (testId) => rootLocator.getByTestId(testId),
  };
}

function expectKinds(cases: SelectorCase[]): void {
  const kinds = new Set(cases.map((item) => item.kind).filter((kind): kind is string => typeof kind === "string"));
  for (const required of [
    "role",
    "text",
    "label",
    "placeholder",
    "test-id",
    "filter-has",
    "filter-has-not",
    "nth",
    "frame-locator",
    "nested-frame-locator",
  ]) {
    expect(kinds.has(required), `missing selector fuzz kind: ${required}`).toBe(true);
  }
}

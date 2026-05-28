// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { snapshotTextExpression } from "../src/snapshot-text.js";

// The builder is a self-contained `(() => {...})()` source string that ships to the
// page verbatim. We exercise the EXACT shipped source here by evaluating it against a
// happy-dom document. `(0, eval)` keeps it an indirect eval (no local-scope capture).
function run(maxItems = 20, maxTextLength = 120): ReturnType<typeof builderResult> {
  // eslint-disable-next-line no-eval
  return (0, eval)(snapshotTextExpression(maxItems, maxTextLength));
}
// type helper only
declare function builderResult(): {
  url: string;
  title: string;
  buttons: string[];
  links: { text: string; href: string }[];
  forms: { label: string; type: string; name: string; placeholder: string }[];
  headings: { level: number; text: string }[];
  meta: {
    truncated: boolean;
    categories: Record<string, { shown: number; total: number; truncated: boolean }>;
    hint?: string;
  };
};

describe("snapshotTextExpression", () => {
  it("does not leak nested <style>/<script> text into button labels", () => {
    document.body.innerHTML = `<button><style>.x{color:red}.y:hover{color:#8ab4f8}</style>Search</button>`;
    const r = run();
    expect(r.buttons).toEqual(["Search"]);
  });

  it("drops hidden / aria-hidden inputs from forms (inline attributes)", () => {
    document.body.innerHTML = `
      <input type="hidden" name="csrf" value="z">
      <input type="text" name="q" aria-label="Query">
      <input type="text" name="secret" aria-hidden="true">`;
    const r = run();
    expect(r.forms.map((f) => f.name)).toEqual(["q"]);
  });

  it("drops inputs hidden via a stylesheet display:none rule", () => {
    document.body.innerHTML = `
      <style>.gone{display:none}</style>
      <input type="text" name="visible">
      <input type="text" name="styled" class="gone">`;
    const r = run();
    expect(r.forms.map((f) => f.name)).toEqual(["visible"]);
  });

  it("reports per-category totals + truncation when capped", () => {
    document.body.innerHTML = Array.from({ length: 25 }, (_, i) => `<a href="/p${i}">L${i}</a>`).join("");
    const r = run(20, 120);
    expect(r.links.length).toBe(20);
    expect(r.meta.categories.links).toEqual({ shown: 20, total: 25, truncated: true });
    expect(r.meta.truncated).toBe(true);
    expect(r.meta.hint).toContain("tab.evaluate");
    expect(r.meta.hint).toContain("domSnapshot");
  });

  it("marks truncation false and omits hint when nothing is capped/clipped", () => {
    document.body.innerHTML = `<a href="/a">A</a><h1>Title</h1>`;
    const r = run();
    expect(r.meta.truncated).toBe(false);
    expect(r.meta.hint).toBeUndefined();
    expect(r.meta.categories.links).toEqual({ shown: 1, total: 1, truncated: false });
  });

  it("flags truncation when a long string is clipped to maxTextLength", () => {
    document.body.innerHTML = `<a href="/a">${"x".repeat(300)}</a>`;
    const r = run(20, 120);
    expect(r.links[0].text.length).toBe(120);
    expect(r.meta.truncated).toBe(true);
  });
});

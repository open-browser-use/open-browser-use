// Page-text snapshot builder.
//
// This is the single in-page extractor that feeds BOTH `tab.snapshotText()` and
// `tab.observe().text`. It runs in the page (serialized to a source string and
// evaluated via the backend), so it may reference only `document`/`window`/`location`
// and its own inner declarations — never module scope.
//
// Design notes (why this is what it is):
//   * It is an AFFORDANCE SUMMARY, not page content. It deliberately carries no prose:
//     adding a "body" field would re-centralize env-decided digestion (which prose? what
//     truncation?), which is the finite-space projection the project explicitly rejects.
//     The agent reads content at full fidelity and agent-scoped via its open action space
//     (`tab.evaluate(...)`) or `tab.domSnapshot()`. `meta.hint` says so when truncated.
//   * Compaction is HONEST: every category reports {shown,total,truncated} computed BEFORE
//     slicing, and `meta.truncated` is set when any category is capped OR any value is
//     clipped to `maxTextLength`. No silent caps.
//   * It never leaks `<style>`/`<script>` text into labels, and it drops hidden /
//     non-actionable inputs.
//
// The string is a hand-written literal (no `Function.prototype.toString`) so the shipped
// source is identical in dev and bundled builds — zero bundler-transform risk.

/** Per-category compaction report so the agent owns the scope decision. */
export type SnapshotCategoryMeta = {
  /** Items included in the (capped) array. */
  shown: number;
  /** Total matching elements on the page before the cap. */
  total: number;
  /** True iff `shown < total`. */
  truncated: boolean;
};

/** Self-describing compaction metadata attached to a page-text snapshot. */
export type SnapshotTextMeta = {
  /** True iff any category was capped OR any text value was clipped to `maxTextLength`. */
  truncated: boolean;
  categories: {
    headings: SnapshotCategoryMeta;
    buttons: SnapshotCategoryMeta;
    links: SnapshotCategoryMeta;
    forms: SnapshotCategoryMeta;
  };
  /** Present iff `truncated`: tells the agent how to read the full / scoped page. */
  hint?: string;
};

export function snapshotTextExpression(maxItems: number, maxTextLength: number): string {
  return `
(() => {
  const OBU_OVERLAY_SELECTOR = "#obu-agent-overlay-root,[data-obu-overlay-root]";
  let __clipped = false;
  const text = (value) => {
    const s = String(value || "").replace(/\\s+/g, " ").trim();
    if (s.length > ${maxTextLength}) { __clipped = true; return s.slice(0, ${maxTextLength}); }
    return s;
  };
  const isObuOverlay = (el) => Boolean(el?.matches?.(OBU_OVERLAY_SELECTOR) || el?.closest?.(OBU_OVERLAY_SELECTOR));
  // Never leak <style>/<script> text content into a label. textContent concatenates the
  // text of nested <style> nodes (e.g. Google injects scoped styles inside buttons), so
  // strip them on a clone before reading.
  const cleanText = (el) => {
    if (!el) return "";
    if (el.querySelector && el.querySelector("style,script")) {
      const clone = el.cloneNode(true);
      clone.querySelectorAll("style,script").forEach((n) => n.remove());
      return text(clone.textContent);
    }
    return text(el.textContent);
  };
  const all = (selector) => Array.from(document.querySelectorAll(selector)).filter((el) => !isObuOverlay(el));
  const cap = (arr) => arr.slice(0, ${maxItems});
  const isActionableInput = (el) => {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "hidden") return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const view = el.ownerDocument && el.ownerDocument.defaultView;
    if (view && typeof view.getComputedStyle === "function") {
      const style = view.getComputedStyle(el);
      if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    }
    return true;
  };
  const labelFor = (input) => {
    if (input.labels && input.labels.length) return text(input.labels[0].textContent);
    if (input.getAttribute("aria-label")) return text(input.getAttribute("aria-label"));
    return text(input.getAttribute("name") || input.getAttribute("placeholder") || "");
  };
  const active = document.activeElement && !isObuOverlay(document.activeElement)
    ? {
        tag: text(document.activeElement.tagName.toLowerCase()),
        id: text(document.activeElement.id),
        name: text(document.activeElement.getAttribute("name")),
        type: text(document.activeElement.getAttribute("type")),
        placeholder: text(document.activeElement.getAttribute("placeholder")),
        ariaLabel: text(document.activeElement.getAttribute("aria-label")),
      }
    : null;

  const headingEls = all("h1,h2,h3");
  const buttonEls = all("button,[role=button],input[type=button],input[type=submit]");
  const linkEls = all("a[href]");
  const formEls = all("input,textarea,select").filter(isActionableInput);

  const headings = cap(headingEls).map((el) => ({ level: Number(el.tagName.slice(1)), text: cleanText(el) }));
  const buttons = cap(buttonEls).map((el) => cleanText(el) || text(el.value) || text(el.getAttribute("aria-label"))).filter(Boolean);
  const links = cap(linkEls).map((el) => ({ text: cleanText(el) || text(el.getAttribute("aria-label")), href: text(el.href) }));
  const forms = cap(formEls).map((el) => ({
    label: labelFor(el),
    type: text(el.getAttribute("type") || el.tagName.toLowerCase()),
    name: text(el.getAttribute("name")),
    placeholder: text(el.getAttribute("placeholder")),
  }));

  const cat = (shown, total) => ({ shown, total, truncated: shown < total });
  const categories = {
    headings: cat(headings.length, headingEls.length),
    buttons: cat(buttons.length, buttonEls.length),
    links: cat(links.length, linkEls.length),
    forms: cat(forms.length, formEls.length),
  };
  const truncated = __clipped || categories.headings.truncated || categories.buttons.truncated || categories.links.truncated || categories.forms.truncated;
  const meta = {
    truncated,
    categories,
    ...(truncated
      ? { hint: "snapshotText is a capped affordance summary, not page content; for a scoped read run your own tab.evaluate(...) query, or tab.domSnapshot() for the full page" }
      : {}),
  };

  return {
    url: location.href,
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio || 1,
    },
    focus: active,
    headings,
    buttons,
    links,
    forms,
    meta,
  };
})()
`;
}

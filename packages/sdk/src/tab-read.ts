import type { TabObservation, TabObserveOptions } from "./tab.js";

/** Page-side truncation sentinel returned by `evaluate()` when JSON exceeds the budget. */
export type EvaluateTruncationSummary = {
  kind: "truncated";
  type?: string;
  length?: number;
  key_count?: number;
  keys?: string[];
  bytes?: number;
  reason?: string;
};

export type TabReadDeps = {
  observe: (opts?: TabObserveOptions) => Promise<TabObservation>;
  evaluate: (
    expression: string,
  ) => Promise<{ rows: string[][] } | EvaluateTruncationSummary>;
};

export type ExtractTableInput = {
  selector: string;
};

export type ExtractTableResult = {
  observationId: string;
  rows: string[][];
};

/**
 * Build the page-side JS expression that extracts a table's cell text as
 * `{ rows: string[][] }`. The expression is fully self-contained (the selector
 * is JSON-injected, no closure variables) so it survives being stringified and
 * evaluated in the page by {@link TabRead.extractTable}.
 *
 * Semantics: each `<tr>` descendant of the matched element becomes a row, and
 * each `<th>`/`<td>` within it becomes a trimmed-text cell. A missing element
 * yields `{ rows: [] }` rather than throwing, so a stale/absent selector reads
 * as an empty table instead of an evaluation error.
 */
export function buildExtractTableExpression(selector: string): string {
  return `(() => {
  const __table = document.querySelector(${JSON.stringify(selector)});
  if (!__table) return { rows: [] };
  const __rows = [];
  for (const __tr of __table.querySelectorAll("tr")) {
    const __cells = [];
    for (const __cell of __tr.querySelectorAll("th,td")) {
      __cells.push((__cell.textContent ?? "").trim());
    }
    __rows.push(__cells);
  }
  return { rows: __rows };
})()`;
}

// Local copy (not shared with tab.ts's guard) to keep tab-read.ts importing only
// *types* from tab.ts — a value import would create a tab.ts <-> tab-read.ts cycle.
function isTruncatedEvaluateSummary(value: unknown): value is EvaluateTruncationSummary {
  return typeof value === "object" && value !== null
    && (value as { kind?: unknown }).kind === "truncated";
}

export class TabRead {
  lastObservationId?: string;

  constructor(private readonly deps: TabReadDeps) {}

  async extractTable(input: ExtractTableInput): Promise<ExtractTableResult> {
    const observation = await this.deps.observe({ mode: "actionable" });
    this.lastObservationId = observation.observationId;
    // Read-only extraction path: evaluate real DOM-walking JS against the live
    // page; never dispatch a mutating primitive action and never invalidate the
    // observation.
    const result = await this.deps.evaluate(buildExtractTableExpression(input.selector));
    if (isTruncatedEvaluateSummary(result)) {
      throw new Error(
        "tab.extractTable result exceeded the evaluate JSON budget; scope the selector to a "
          + "smaller table, or read it directly with tab.evaluate() using a larger maxJsonBytes",
      );
    }
    return { observationId: observation.observationId, rows: result.rows };
  }
}

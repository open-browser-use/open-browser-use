import type { TabObservation, TabObserveOptions } from "./tab.js";

export type TabReadDeps = {
  observe: (opts?: TabObserveOptions) => Promise<TabObservation>;
  evaluate: (expression: string) => Promise<{ rows: string[][] }>;
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

export class TabRead {
  lastObservationId?: string;

  constructor(private readonly deps: TabReadDeps) {}

  async extractTable(input: ExtractTableInput): Promise<ExtractTableResult> {
    const observation = await this.deps.observe({ mode: "actionable" });
    this.lastObservationId = observation.observationId;
    // Read-only extraction path: evaluate real DOM-walking JS against the live
    // page; never dispatch a mutating primitive action and never invalidate the
    // observation.
    const { rows } = await this.deps.evaluate(buildExtractTableExpression(input.selector));
    return { observationId: observation.observationId, rows };
  }
}

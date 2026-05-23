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

export class TabRead {
  lastObservationId?: string;

  constructor(private readonly deps: TabReadDeps) {}

  async extractTable(input: ExtractTableInput): Promise<ExtractTableResult> {
    const observation = await this.deps.observe({ mode: "actionable" });
    this.lastObservationId = observation.observationId;
    const expression = `/* extractTable(${JSON.stringify(input.selector)}) */`;
    // Read-only extraction path: evaluate against the live DOM; never dispatch a
    // mutating primitive action and never invalidate the observation.
    const { rows } = await this.deps.evaluate(expression);
    return { observationId: observation.observationId, rows };
  }
}

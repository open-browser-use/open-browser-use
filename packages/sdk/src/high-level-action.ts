import {
  createHighLevelActionStateTrace,
  HighLevelActionState,
  StateTrace,
  ActionRuntimeState,
} from "./state-machines.js";
import { redactTraceValues, RedactedTraceValue } from "./redact.js";
import type { ActionResult } from "./tab-action.js";

export type HighLevelActionName =
  | "clickByText"
  | "fillForm"
  | "chooseFromMenu"
  | "submitAndObserve"
  | "downloadAfterClick"
  | "extractTable";

export type HighLevelStep = {
  description: string;
  traceValues: RedactedTraceValue[];
  /** Present only for steps that dispatched a primitive action through tab.step(...). */
  primitiveTrace?: StateTrace<ActionRuntimeState>;
  primitiveResult?: ActionResult;
};

export type HighLevelActionStatus = "succeeded" | "partial" | "blocked" | "failed" | "cancelled";

export type HighLevelActionResultJSON = {
  name: HighLevelActionName;
  status: HighLevelActionState;
  steps: Array<{
    description: string;
    traceValues: RedactedTraceValue[];
    primitiveStatus?: ActionResult["status"];
  }>;
  trace: HighLevelActionState[];
};

export class HighLevelActionResult {
  private readonly trace = createHighLevelActionStateTrace();
  private readonly steps: HighLevelStep[] = [];

  constructor(readonly name: HighLevelActionName) {}

  transition(next: HighLevelActionState): void {
    this.trace.transition(next);
  }

  recordStep(step: HighLevelStep): void {
    this.steps.push({ ...step, traceValues: redactTraceValues(step.traceValues) });
  }

  get state(): HighLevelActionState {
    return this.trace.state;
  }

  toJSON(): HighLevelActionResultJSON {
    return {
      name: this.name,
      status: this.trace.state,
      steps: this.steps.map((s) => ({
        description: s.description,
        traceValues: s.traceValues,
        ...(s.primitiveResult ? { primitiveStatus: s.primitiveResult.status } : {}),
      })),
      trace: this.trace.history.map((h) => h.state),
    };
  }
}

export function createHighLevelActionResult(name: HighLevelActionName): HighLevelActionResult {
  return new HighLevelActionResult(name);
}

import { createHighLevelActionResult, HighLevelActionResult } from "./high-level-action.js";
import type { ActionResult, EnvAction, LocatorActionTarget } from "./tab-action.js";
import type { TabObservation, TabObserveOptions } from "./tab.js";

export type TabFlowsDeps = {
  observe: (opts?: TabObserveOptions) => Promise<TabObservation>;
  step: (action: EnvAction) => Promise<ActionResult>;
};

export type ChooseFromMenuInput = {
  trigger: LocatorActionTarget;
  option: { text: string };
};

export type SubmitAndObserveInput = {
  submit: LocatorActionTarget;
};

export type ClickByTextInput = {
  text: string;
};

export type FillFormInput = {
  fields: Array<{ name: string; value: string; selector?: string }>;
  submit?: LocatorActionTarget;
};

export class TabFlows {
  constructor(private readonly deps: TabFlowsDeps) {}

  async chooseFromMenu(input: ChooseFromMenuInput): Promise<HighLevelActionResult> {
    const result = createHighLevelActionResult("chooseFromMenu");

    // Observe before trigger
    result.transition("observing");
    const before = await this.deps.observe({ mode: "actionable" });

    // Trigger: open the menu
    result.transition("planning_steps");
    result.transition("preflighting_steps");
    result.transition("running_step");
    const triggerStep = await this.deps.step({
      kind: "locator.click",
      target: { ...input.trigger, observationId: before.observationId },
    });
    result.recordStep({
      description: "open menu",
      traceValues: [{ kind: "selector", value: input.trigger.selector }],
      primitiveResult: triggerStep,
    });

    // BOUNDARY (Finding 14): re-observe the open menu; do NOT reuse pre-menu candidates.
    result.transition("observing");
    const openMenu = await this.deps.observe({ mode: "actionable" });

    // Select the option from the FRESH observation
    result.transition("planning_steps");
    result.transition("preflighting_steps");
    result.transition("running_step");
    const optionTarget = this.locateByText(openMenu, input.option.text);
    const optionStep = await this.deps.step({
      kind: "locator.click",
      target: { ...optionTarget, observationId: openMenu.observationId },
    });
    result.recordStep({
      description: `select ${input.option.text}`,
      traceValues: [{ kind: "text", value: input.option.text }],
      primitiveResult: optionStep,
    });

    result.transition("waiting_for_effect");
    result.transition("reconciling");
    // Post-reconcile observation (observations.after)
    await this.deps.observe({ mode: "actionable" });
    result.transition(optionStep.status === "succeeded" ? "succeeded" : "partial");
    return result;
  }

  async submitAndObserve(input: SubmitAndObserveInput): Promise<HighLevelActionResult> {
    const result = createHighLevelActionResult("submitAndObserve");

    result.transition("observing");
    const before = await this.deps.observe({ mode: "actionable" });

    result.transition("planning_steps");
    result.transition("preflighting_steps");
    result.transition("running_step");
    const submitStep = await this.deps.step({
      kind: "locator.click",
      target: { ...input.submit, observationId: before.observationId },
    });
    result.recordStep({
      description: "submit",
      traceValues: [{ kind: "selector", value: input.submit.selector }],
      primitiveResult: submitStep,
    });

    // BOUNDARY: re-observe after submit. The pre-submit observation is now invalid.
    result.transition("observing");
    await this.deps.observe({ mode: "actionable" });

    // observing → planning_steps → preflighting_steps → running_step → waiting_for_effect → reconciling
    result.transition("planning_steps");
    result.transition("preflighting_steps");
    result.transition("running_step");
    result.transition("waiting_for_effect");
    result.transition("reconciling");
    result.transition(submitStep.status === "succeeded" ? "succeeded" : "partial");
    return result;
  }

  async clickByText(input: ClickByTextInput): Promise<HighLevelActionResult> {
    const result = createHighLevelActionResult("clickByText");

    result.transition("observing");
    const observation = await this.deps.observe({ mode: "actionable" });

    result.transition("planning_steps");
    result.transition("preflighting_steps");
    result.transition("running_step");
    const target: LocatorActionTarget = {
      source: "locator",
      selector: `text=${input.text}`,
      observationId: observation.observationId,
    };
    const step = await this.deps.step({ kind: "locator.click", target });
    result.recordStep({
      description: `click ${input.text}`,
      traceValues: [{ kind: "text", value: input.text }],
      primitiveResult: step,
    });

    result.transition("waiting_for_effect");
    result.transition("reconciling");
    result.transition(step.status === "succeeded" ? "succeeded" : "partial");
    return result;
  }

  async fillForm(input: FillFormInput): Promise<HighLevelActionResult> {
    const result = createHighLevelActionResult("fillForm");

    result.transition("observing");
    let observation = await this.deps.observe({ mode: "actionable" });

    result.transition("planning_steps");
    result.transition("preflighting_steps");

    if (input.fields.length === 0) {
      result.transition("running_step");
      result.transition("waiting_for_effect");
      result.transition("reconciling");
      result.transition("succeeded");
      return result;
    }

    let lastStatus: ActionResult["status"] = "succeeded";

    for (let i = 0; i < input.fields.length; i++) {
      const field = input.fields[i];
      result.transition("running_step");
      const selector = field.selector ?? `[name="${field.name}"]`;
      const step = await this.deps.step({
        kind: "locator.fill",
        target: { source: "locator", selector, observationId: observation.observationId },
        text: field.value,
      });
      result.recordStep({
        description: `fill ${field.name}`,
        traceValues: [{ kind: "text", field: field.name, value: field.value }],
        primitiveResult: step,
      });
      if (step.status !== "succeeded") lastStatus = step.status;

      const isLastField = i === input.fields.length - 1;
      if (!isLastField || input.submit) {
        // Re-observe at the boundary before the next field or submit
        result.transition("observing");
        observation = await this.deps.observe({ mode: "actionable" });
        result.transition("planning_steps");
        result.transition("preflighting_steps");
      }
    }

    if (input.submit) {
      // Submit from the latest observation
      result.transition("running_step");
      const submitStep = await this.deps.step({
        kind: "locator.click",
        target: { ...input.submit, observationId: observation.observationId },
      });
      result.recordStep({
        description: "submit",
        traceValues: [{ kind: "selector", value: input.submit.selector }],
        primitiveResult: submitStep,
      });
      if (submitStep.status !== "succeeded") lastStatus = submitStep.status;

      result.transition("observing");
      await this.deps.observe({ mode: "actionable" });
      result.transition("planning_steps");
      result.transition("preflighting_steps");
      result.transition("running_step");
      result.transition("waiting_for_effect");
      result.transition("reconciling");
    } else {
      // No submit: transition cleanly through the terminal path.
      // We are in running_step after the last field fill — move to waiting_for_effect → reconciling.
      result.transition("waiting_for_effect");
      result.transition("reconciling");
    }

    result.transition(lastStatus === "succeeded" ? "succeeded" : "partial");
    return result;
  }

  private locateByText(observation: TabObservation, text: string): LocatorActionTarget {
    return {
      source: "locator",
      selector: `text=${text}`,
      observationId: observation.observationId,
    };
  }
}

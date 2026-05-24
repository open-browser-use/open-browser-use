import { createHighLevelActionResult, HighLevelActionResult } from "./high-level-action.js";
import type { ActionResult, EnvAction, LocatorActionTarget } from "./tab-action.js";
import type { TabObservation, TabObserveOptions } from "./tab.js";
import type { Download } from "./download.js";

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

export type DownloadAfterClickInput = {
  trigger: LocatorActionTarget;
};

/**
 * Options for {@link TabFlows.downloadAfterClick}. The `waitForDownload` dep
 * surfaces the existing host {@link Download} handle (e.g. the one resolved by
 * the live transport when the browser fires a download event), so the flow does
 * NOT create a second stale-handle model.
 */
export type DownloadAfterClickOptions = {
  waitForDownload: () => Promise<Download>;
};

/**
 * Result of {@link TabFlows.downloadAfterClick}: the high-level action result
 * with the existing host {@link Download} handle attached. The handle is a
 * process-local runtime object and is intentionally NOT part of `toJSON()`.
 *
 * `download` is OPTIONAL: it is present only when the trigger click succeeded
 * and the download arrived. If the click failed/blocked the flow short-circuits
 * to `partial` without waiting for a download that will never fire, so no handle
 * is attached.
 */
export type DownloadAfterClickResult = HighLevelActionResult & { download?: Download };

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

    // Short-circuit (Finding 5): if opening the menu did not succeed, do NOT
    // cross the observation boundary to re-observe and click an option that
    // cannot exist. Gate on the prerequisite step's status before proceeding.
    if (triggerStep.status !== "succeeded") {
      result.transition(triggerStep.status === "blocked" ? "blocked" : "partial");
      return result;
    }

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
      const field = input.fields[i]!;
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

      // Short-circuit (Finding 5): a failed field fill means every subsequent
      // field and the submit would operate on an unexpected form state, so stop
      // here rather than crossing the next observe boundary or submitting.
      if (step.status !== "succeeded") {
        result.transition(step.status === "blocked" ? "blocked" : "partial");
        return result;
      }

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

  async downloadAfterClick(
    input: DownloadAfterClickInput,
    opts: DownloadAfterClickOptions,
  ): Promise<DownloadAfterClickResult> {
    const result = createHighLevelActionResult("downloadAfterClick");

    result.transition("observing");
    const before = await this.deps.observe({ mode: "actionable" });

    result.transition("planning_steps");
    result.transition("preflighting_steps");
    result.transition("running_step");

    // Arm the download waiter BEFORE the click: a download event fired
    // synchronously by the click must not be missed in the window between the
    // click resolving and us starting to wait (the arm-before-act race).
    const downloadPromise = opts.waitForDownload();
    // Register a rejection handler now so that if we abandon this waiter on a
    // failed click below, its eventual rejection does not surface as an
    // unhandled promise rejection.
    downloadPromise.catch(() => {});

    const clickStep = await this.deps.step({
      kind: "locator.click",
      target: { ...input.trigger, observationId: before.observationId },
    });
    result.recordStep({
      description: "click download trigger",
      traceValues: [{ kind: "selector", value: input.trigger.selector }],
      primitiveResult: clickStep,
    });

    if (clickStep.status !== "succeeded") {
      // The click did not succeed, so no download will follow. Abandon the
      // armed waiter (its rejection is already swallowed above) instead of
      // blocking on a download that will never arrive, and report partial with
      // no `download` handle attached.
      result.transition(clickStep.status === "blocked" ? "blocked" : "partial");
      return result;
    }

    // The click may navigate or mutate the page; await the existing host
    // Download handle (armed above) as the effect of the click.
    result.transition("waiting_for_effect");
    const download = await downloadPromise;

    // BOUNDARY: re-observe after the download effect (observations.after).
    result.transition("reconciling");
    await this.deps.observe({ mode: "actionable" });
    result.transition("succeeded");

    // Attach the existing Download handle as a process-local runtime field; it
    // is deliberately excluded from toJSON() since it is not serializable.
    return Object.assign(result, { download });
  }

  private locateByText(observation: TabObservation, text: string): LocatorActionTarget {
    return {
      source: "locator",
      selector: `text=${text}`,
      observationId: observation.observationId,
    };
  }
}

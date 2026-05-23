export type ActionStatus = "succeeded" | "failed" | "blocked" | "cancelled";

export type ActionEffect =
  | "navigation"
  | "dom_changed"
  | "pointer_moved"
  | "input_dispatched"
  | "download_started"
  | "filechooser_opened"
  | "dialog_blocked"
  | "no_visible_change"
  | "unknown";

export type AgentPointerState = {
  sessionId?: string;
  turnId?: string;
  tabId: string;
  x: number;
  y: number;
  coordinateSpace: "visualViewport" | "layoutViewport";
  viewportRevision?: string;
  phase: "idle" | "moving" | "pressed" | "dragging" | "released" | "stale";
  buttonsDown: Array<"left" | "right" | "middle">;
  modifiers: string[];
  source: "agent" | "human" | "unknown";
  visible: boolean;
  updatedAt: number;
  staleReason?: string;
};

export type LocatorActionTarget = {
  source: "locator";
  selector: string;
  observationId?: string;
};

export type DomCuaActionTarget = {
  source: "dom-cua";
  nodeId: string;
  observationId: string;
};

export type CoordinateActionTarget = {
  source: "coordinate";
  x?: number;
  y?: number;
  observationId?: string;
};

export type EnvActionTarget = LocatorActionTarget | DomCuaActionTarget | CoordinateActionTarget;

export type EnvActionPolicy = {
  mayNavigate?: boolean;
  mayDownload?: boolean;
  mayOpenFileChooser?: boolean;
  requiresHumanHandoff?: boolean;
};

export type EnvAction = {
  actionId?: string;
  kind:
    | "locator.click"
    | "locator.fill"
    | "locator.type"
    | "locator.press"
    | "dom_cua.click"
    | "dom_cua.type"
    | "dom_cua.scroll"
    | "dom_cua.keypress"
    | "coordinate.click"
    | "coordinate.move"
    | "coordinate.scroll"
    | "coordinate.type"
    | "coordinate.keypress";
  target: EnvActionTarget;
  text?: string;
  key?: string | string[];
  delta?: number | { deltaX?: number; deltaY?: number };
  timeout?: number;
  modifiers?: string[];
  button?: "left" | "right" | "middle";
  policy?: EnvActionPolicy;
};

export type ActionResult = {
  actionId: string;
  kind: EnvAction["kind"];
  status: ActionStatus;
  effect: ActionEffect;
  sessionId?: string;
  turnId?: string;
  startedAt: number;
  completedAt: number;
  pointer?: AgentPointerState;
  invalidatedObservations?: string[];
  handles?: unknown[];
  diagnostics?: unknown[];
  advisories?: string[];
  error?: {
    code: string;
    message: string;
    data?: unknown;
  };
};

export type TabActClickTarget =
  | LocatorActionTarget
  | DomCuaActionTarget
  | (CoordinateActionTarget & { x: number; y: number });

export type TabActScrollTarget =
  | DomCuaActionTarget
  | (CoordinateActionTarget & { x: number; y: number });

export type TabActMoveOptions = Omit<EnvAction, "kind" | "target"> & {
  observationId?: string;
};

export class TabAct {
  constructor(private readonly step: (action: EnvAction) => Promise<ActionResult>) {}

  async click(
    target: TabActClickTarget,
    opts: Omit<EnvAction, "kind" | "target"> = {},
  ): Promise<ActionResult> {
    return await this.step({
      ...opts,
      kind: target.source === "locator"
        ? "locator.click"
        : target.source === "dom-cua"
          ? "dom_cua.click"
          : "coordinate.click",
      target,
    });
  }

  async fill(
    target: LocatorActionTarget,
    text: string,
    opts: Omit<EnvAction, "kind" | "target" | "text"> = {},
  ): Promise<ActionResult> {
    return await this.step({ ...opts, kind: "locator.fill", target, text });
  }

  async type(
    target: DomCuaActionTarget | CoordinateActionTarget | LocatorActionTarget,
    text: string,
    opts: Omit<EnvAction, "kind" | "target" | "text"> = {},
  ): Promise<ActionResult> {
    return await this.step({
      ...opts,
      kind: target.source === "locator"
        ? "locator.type"
        : target.source === "dom-cua"
          ? "dom_cua.type"
          : "coordinate.type",
      target,
      text,
    });
  }

  async move(
    x: number,
    y: number,
    opts: TabActMoveOptions = {},
  ): Promise<ActionResult> {
    const { observationId, ...actionOpts } = opts;
    return await this.step({
      ...actionOpts,
      kind: "coordinate.move",
      target: { source: "coordinate", x, y, ...(observationId !== undefined ? { observationId } : {}) },
    });
  }

  async scroll(
    target: TabActScrollTarget,
    delta: number | { deltaX?: number; deltaY?: number },
    opts: Omit<EnvAction, "kind" | "target" | "delta"> = {},
  ): Promise<ActionResult> {
    return await this.step({
      ...opts,
      kind: target.source === "dom-cua" ? "dom_cua.scroll" : "coordinate.scroll",
      target,
      delta,
    });
  }

  async keypress(
    target: DomCuaActionTarget | CoordinateActionTarget,
    key: string | string[],
    opts: Omit<EnvAction, "kind" | "target" | "key"> = {},
  ): Promise<ActionResult> {
    return await this.step({
      ...opts,
      kind: target.source === "dom-cua" ? "dom_cua.keypress" : "coordinate.keypress",
      target,
      key,
    });
  }
}

export function actionId(prefix = "act"): string {
  return `${prefix}:${Date.now()}:${nextActionSequence()}`;
}

let ACTION_SEQUENCE = 0;

function nextActionSequence(): number {
  ACTION_SEQUENCE = (ACTION_SEQUENCE + 1) % Number.MAX_SAFE_INTEGER;
  return ACTION_SEQUENCE;
}

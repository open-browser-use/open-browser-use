import type {
  CdpInputBypass,
  CursorVisualEvent,
  InputBypassEventFamily,
} from "../overlay_coordinator.js";

export function cdpInputBypassFromParams(params: Record<string, unknown>): CdpInputBypass | undefined {
  if (params.method === "Input.dispatchMouseEvent") {
    const type = isRecord(params.commandParams) ? params.commandParams.type : undefined;
    const eventFamilies: InputBypassEventFamily[] = type === "mouseWheel" ? ["wheel"] : ["pointer"];
    return { durationMs: 600, reason: "cdp-mouse", eventFamilies };
  }
  if (params.method === "Input.dispatchTouchEvent") {
    return { durationMs: 600, reason: "cdp-touch", eventFamilies: ["touch"] };
  }
  if (params.method === "Input.dispatchKeyEvent") {
    return { durationMs: 600, reason: "cdp-keyboard", eventFamilies: ["keyboard", "text"] };
  }
  if (params.method === "Input.insertText") {
    return { durationMs: 600, reason: "cdp-text", eventFamilies: ["text"] };
  }
  return undefined;
}

export function cdpCursorEventFromParams(params: Record<string, unknown>): CursorVisualEvent | undefined {
  if (params.method !== "Input.dispatchMouseEvent" || !isRecord(params.commandParams)) return undefined;
  const commandParams = params.commandParams;
  const type = commandParams.type;
  if (type !== "mousePressed" && type !== "mouseReleased") return undefined;
  const x = typeof commandParams.x === "number" ? commandParams.x : undefined;
  const y = typeof commandParams.y === "number" ? commandParams.y : undefined;
  return {
    kind: type === "mousePressed" ? "press" : "release",
    x,
    y,
    button: typeof commandParams.button === "string" ? commandParams.button : undefined,
    clickCount: typeof commandParams.clickCount === "number" ? Math.max(0, Math.trunc(commandParams.clickCount)) : 0,
  };
}

export function shouldSuppressAgentOverlayForCdpCapture(params: Record<string, unknown>): boolean {
  return params.suppressAgentOverlayForCapture === true && params.method === "Page.captureScreenshot";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

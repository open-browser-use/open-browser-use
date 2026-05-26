import assert from "node:assert/strict";

import {
  cdpCursorEventFromParams,
  cdpInputBypassFromParams,
  shouldSuppressAgentOverlayForCdpCapture,
} from "../dist/lifecycle/cdp_input_machine.js";

assert.deepEqual(
  cdpInputBypassFromParams({ method: "Input.dispatchMouseEvent", commandParams: { type: "mouseMoved" } }),
  { durationMs: 600, reason: "cdp-mouse", eventFamilies: ["pointer"] },
);
assert.deepEqual(
  cdpInputBypassFromParams({ method: "Input.dispatchMouseEvent", commandParams: { type: "mouseWheel" } }),
  { durationMs: 600, reason: "cdp-mouse", eventFamilies: ["wheel"] },
);
assert.deepEqual(
  cdpInputBypassFromParams({ method: "Input.dispatchTouchEvent" }),
  { durationMs: 600, reason: "cdp-touch", eventFamilies: ["touch"] },
);
assert.deepEqual(
  cdpInputBypassFromParams({ method: "Input.dispatchKeyEvent" }),
  { durationMs: 600, reason: "cdp-keyboard", eventFamilies: ["keyboard", "text"] },
);
assert.deepEqual(
  cdpInputBypassFromParams({ method: "Input.insertText" }),
  { durationMs: 600, reason: "cdp-text", eventFamilies: ["text"] },
);
assert.equal(cdpInputBypassFromParams({ method: "Runtime.evaluate" }), undefined);

assert.deepEqual(
  cdpCursorEventFromParams({
    method: "Input.dispatchMouseEvent",
    commandParams: { type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 2 },
  }),
  { kind: "press", x: 10, y: 20, button: "left", clickCount: 2 },
);
assert.deepEqual(
  cdpCursorEventFromParams({
    method: "Input.dispatchMouseEvent",
    commandParams: { type: "mouseReleased", x: 10, y: 20, clickCount: -2 },
  }),
  { kind: "release", x: 10, y: 20, button: undefined, clickCount: 0 },
);
assert.equal(cdpCursorEventFromParams({ method: "Input.dispatchMouseEvent", commandParams: { type: "mouseMoved" } }), undefined);

assert.equal(
  shouldSuppressAgentOverlayForCdpCapture({
    method: "Page.captureScreenshot",
    suppressAgentOverlayForCapture: true,
  }),
  true,
);
assert.equal(
  shouldSuppressAgentOverlayForCdpCapture({
    method: "Page.captureScreenshot",
    suppressAgentOverlayForCapture: false,
  }),
  false,
);

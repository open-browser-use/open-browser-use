//! Mount the vendored Playwright InjectedScript and open-browser-use helpers in a page.

use serde_json::json;

use crate::backends::cdp::{
    CdpBackend, attach::require_session, injected_script::PLAYWRIGHT_INJECTED_JS,
};
use crate::error::{HostError, Result};
use crate::tab_state::TabId;

const INJECTED_GLOBAL: &str = "__obuPlaywrightInjected";
const RUNTIME_GLOBAL: &str = "__obuPlaywrightRuntime";

/// Ensure Playwright InjectedScript is mounted in a tab's main world.
pub async fn ensure_playwright_injected(backend: &CdpBackend, tab_id: &str) -> Result<()> {
    let id = TabId::new(tab_id);
    let session_id = require_session(backend, tab_id)?;
    if backend.registry().is_playwright_injected(&id)? {
        let probe = super::dialogs::send_command_with_dialog_policy(
            backend,
            tab_id,
            &session_id,
            "Runtime.evaluate",
            json!({
                "expression": format!(
                    "!!window.{INJECTED_GLOBAL} && !!window.{RUNTIME_GLOBAL}"
                ),
                "returnByValue": true,
            }),
        )
        .await?;
        if probe
            .get("result")
            .and_then(|result| result.get("value"))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            return Ok(());
        }
        backend.registry().clear_playwright_injected(&id)?;
    }

    let expression = mount_expression();
    let result = super::dialogs::send_command_with_dialog_policy(
        backend,
        tab_id,
        &session_id,
        "Runtime.evaluate",
        json!({
            "expression": expression,
            "returnByValue": true,
            "awaitPromise": false,
        }),
    )
    .await?;
    if let Some(details) = result.get("exceptionDetails") {
        return Err(HostError::CdpFailure(format!(
            "playwright-injected mount failed: {details}"
        )));
    }
    backend.registry().mark_playwright_injected(&id)?;
    Ok(())
}

pub(crate) fn mount_expression() -> String {
    format!(
        r#"(() => {{
  if (!window.{injected}) {{
    {bundle}
    window.{injected} = new PlaywrightInjected.InjectedScript(window, {{
      isUnderTest: false,
      sdkLanguage: "javascript",
      testIdAttributeName: "data-testid",
      stableRafCount: 1,
      browserName: "chromium",
      customEngines: [],
    }});
  }}
  if (!window.{runtime}) {{
    window.{runtime} = (() => {{
      {helpers}
      return {{
        evaluateOnSelector,
        evaluateOnSelectorAll,
        evaluateOnPage,
        resolveActionPoint,
      }};
    }})();
  }}
  return true;
}})()"#,
        injected = INJECTED_GLOBAL,
        runtime = RUNTIME_GLOBAL,
        bundle = PLAYWRIGHT_INJECTED_JS,
        helpers = runtime_helpers(),
    )
}

fn runtime_helpers() -> &'static str {
    r#"
function querySelectorStrictWithVisibleFallback(injected, parsedSelector, root) {
  const matches = injected.querySelectorAll(parsedSelector, root);
  if (!matches.length) {
    injected.checkDeprecatedSelectorUsage(parsedSelector, matches);
    return null;
  }
  if (matches.length === 1) {
    injected.checkDeprecatedSelectorUsage(parsedSelector, matches);
    return matches[0];
  }
  const visibleMatches = matches.filter((element) => {
    const state = injected.elementState(element, "visible");
    return !!state.matches;
  });
  if (visibleMatches.length === 1) return visibleMatches[0];
  throw injected.strictModeViolationError(parsedSelector, matches);
}

function injectedForWindow(rootInjected, targetWindow) {
  if (!targetWindow) throw new Error("Frame window is not available");
  if (targetWindow.__obuPlaywrightInjected) return targetWindow.__obuPlaywrightInjected;
  targetWindow.__obuPlaywrightInjected = new rootInjected.constructor(targetWindow, {
    isUnderTest: false,
    sdkLanguage: "javascript",
    testIdAttributeName: "data-testid",
    stableRafCount: 1,
    browserName: "chromium",
    customEngines: [],
  });
  return targetWindow.__obuPlaywrightInjected;
}

const unsupportedFrameAccessMessage =
  "Cross-origin or out-of-process iframes are not supported by this runtime selector path";

function sliceParsedSelector(parsedSelector, startIndex, endIndex) {
  const sliced = { ...parsedSelector, parts: parsedSelector.parts.slice(startIndex, endIndex) };
  if (parsedSelector.capture === undefined) delete sliced.capture;
  else if (parsedSelector.capture >= startIndex && parsedSelector.capture < endIndex) {
    sliced.capture = parsedSelector.capture - startIndex;
  } else {
    delete sliced.capture;
  }
  return sliced;
}

function prepareFrameChainForPointerAction(frameChain) {
  let left = 0;
  let top = 0;
  for (const frameScope of frameChain) {
    frameScope.element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    const state = frameScope.injected.elementState(frameScope.element, "visible");
    if (state.received === "error:notconnected") throw new Error("Frame is not connected");
    if (!state.matches) throw new Error("Frame is not visible");
    const rect = frameScope.element.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      throw new Error("Frame does not have an actionable bounding box");
    }
    const frameStyle = frameScope.injected.describeIFrameStyle(frameScope.element);
    if (frameStyle === "error:notconnected") throw new Error("Frame is not connected");
    if (frameStyle === "transformed") {
      throw new Error("Cannot compute a reliable click point through a transformed iframe chain");
    }
    left += rect.left + frameStyle.left;
    top += rect.top + frameStyle.top;
  }
  return { left, top };
}

function selectorScopeFor(initialInjected, parsedSelector) {
  let currentRoot = document;
  let currentInjected = initialInjected;
  const frameChain = [];
  let partStart = 0;
  while (true) {
    const enterFrameIndex = parsedSelector.parts.findIndex(
      (part, index) => index >= partStart && part.name === "internal:control" && part.body === "enter-frame"
    );
    if (enterFrameIndex === -1) {
      return {
        frameChain,
        injected: currentInjected,
        prepareFrameChainForPointerAction: () => prepareFrameChainForPointerAction(frameChain),
        root: currentRoot,
        parsed: sliceParsedSelector(parsedSelector, partStart, parsedSelector.parts.length),
      };
    }
    const frameSelector = sliceParsedSelector(parsedSelector, partStart, enterFrameIndex);
    const frameElement = querySelectorStrictWithVisibleFallback(currentInjected, frameSelector, currentRoot);
    if (!frameElement) return null;
    const tagName = String(frameElement.localName || frameElement.tagName || "").toLowerCase();
    if (tagName !== "iframe" && tagName !== "frame") {
      throw new Error("internal:control=enter-frame must target a frame element");
    }
    let frameWindow;
    let frameDocument;
    try {
      frameWindow = frameElement.contentWindow;
      frameDocument = frameElement.contentDocument || frameWindow?.document;
    } catch {
      throw new Error(unsupportedFrameAccessMessage);
    }
    if (!frameWindow || !frameDocument) throw new Error(unsupportedFrameAccessMessage);
    frameChain.push({ element: frameElement, injected: currentInjected });
    currentRoot = frameDocument;
    currentInjected = injectedForWindow(initialInjected, frameWindow);
    partStart = enterFrameIndex + 1;
  }
}

async function evaluateOnSelector(selector, functionSource, arg) {
  const initialInjected = window.__obuPlaywrightInjected;
  const parsed = initialInjected.parseSelector(selector);
  const scope = selectorScopeFor(initialInjected, parsed);
  const element = scope
    ? querySelectorStrictWithVisibleFallback(scope.injected, scope.parsed, scope.root)
    : null;
  if (!element) throw new Error("No element matched selector");
  return await (0, eval)(`(${functionSource})`)(element, scope.injected, arg, scope);
}

async function evaluateOnSelectorAll(selector, functionSource, arg) {
  const initialInjected = window.__obuPlaywrightInjected;
  const parsed = initialInjected.parseSelector(selector);
  const scope = selectorScopeFor(initialInjected, parsed);
  const elements = scope ? scope.injected.querySelectorAll(scope.parsed, scope.root) : [];
  const scopedInjected = scope ? scope.injected : initialInjected;
  return await (0, eval)(`(${functionSource})`)(elements, scopedInjected, arg);
}

async function evaluateOnPage(functionSource, arg) {
  return await (0, eval)(`(${functionSource})`)(window.__obuPlaywrightInjected, arg);
}

async function resolveActionPoint(selector, arg) {
  return await evaluateOnSelector(selector, async (element, injected, options, scope) => {
    const requiredStates = options.requiredStates || [];
    const waitForAnimationFrame = () => new Promise((resolve) => {
      const view = element.ownerDocument?.defaultView;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timerHost = typeof view?.setTimeout === "function" ? view : globalThis;
      const timer = typeof timerHost?.setTimeout === "function"
        ? timerHost.setTimeout(finish, 50)
        : undefined;
      const finishFromFrame = () => {
        if (timer !== undefined && typeof timerHost?.clearTimeout === "function") {
          timerHost.clearTimeout(timer);
        }
        finish();
      };
      if (typeof view?.requestAnimationFrame === "function") view.requestAnimationFrame(finishFromFrame);
      else finishFromFrame();
    });
    const sameRect = (a, b) => a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
    const waitForStableBoundingRect = async () => {
      let rect = element.getBoundingClientRect();
      let stableCount = 0;
      for (let i = 0; i < 10; i++) {
        await waitForAnimationFrame();
        const next = element.getBoundingClientRect();
        if (sameRect(rect, next)) {
          rect = next;
          stableCount += 1;
          if (stableCount >= 2) break;
        } else {
          rect = next;
          stableCount = 0;
        }
      }
      return rect;
    };
    for (const stateName of requiredStates) {
      const state = injected.elementState(element, stateName);
      if (state.received === "error:notconnected") throw new Error("Element is not connected");
      if (!state.matches) throw new Error("Element is not " + stateName);
    }
    element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    const rect = await waitForStableBoundingRect();
    for (const stateName of requiredStates) {
      const state = injected.elementState(element, stateName);
      if (state.received === "error:notconnected") throw new Error("Element is not connected");
      if (!state.matches) throw new Error("Element is not " + stateName);
    }
    const frameOffset = scope.prepareFrameChainForPointerAction();
    if (!rect || rect.width <= 0 || rect.height <= 0) return { resolution: "no_clickable_box" };
    const doc = element.ownerDocument;
    const view = doc.defaultView || window;
    const vw = { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight };
    const intersectArea = (r) => {
      const l = Math.max(r.left, vw.left), rt = Math.min(r.right, vw.right);
      const t = Math.max(r.top, vw.top), b = Math.min(r.bottom, vw.bottom);
      return Math.max(0, rt - l) * Math.max(0, b - t);
    };
    // Largest-visible client rect, falling back to the bounding rect.
    const rects = Array.from(element.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    const candidates = (rects.length ? rects : [rect])
      .map((r) => ({ r, area: intersectArea(r) }))
      .sort((a, b) => b.area - a.area)
      .map((c) => c.r);
    const describe = (node) => {
      if (!node || node.nodeType !== 1) return "unknown element";
      const id = node.id ? '#' + node.id : '';
      const cls = node.classList && node.classList.length ? "." + Array.from(node.classList).slice(0, 2).join(".") : "";
      return (node.tagName || "node").toLowerCase() + id + cls;
    };
    const hitAccepts = (lx, ly) => {
      const stack = typeof doc.elementsFromPoint === "function" ? doc.elementsFromPoint(lx, ly) : [doc.elementFromPoint(lx, ly)];
      for (const hit of stack) {
        if (!hit) continue;
        if (view.getComputedStyle && view.getComputedStyle(hit).pointerEvents === 'none') continue;
        if (hit === element || element.contains(hit) || hit.contains(element)) return { ok: true };
        return { ok: false, by: describe(hit) };
      }
      return { ok: false, by: "no element at point" };
    };
    if (!candidates.length || intersectArea(candidates[0]) <= 0) return { resolution: "outside_viewport" };
    const doHitTest = options.hitTest !== false;
    let occludedBy = null;
    for (const candidate of candidates) {
      const lx = candidate.left + candidate.width / 2;
      const ly = candidate.top + candidate.height / 2;
      if (!doHitTest) {
        return { x: Math.max(0, frameOffset.left + lx), y: Math.max(0, frameOffset.top + ly) };
      }
      const verdict = hitAccepts(lx, ly);
      if (verdict.ok) {
        return { x: Math.max(0, frameOffset.left + lx), y: Math.max(0, frameOffset.top + ly) };
      }
      occludedBy = verdict.by;
    }
    return { resolution: "occluded", by: occludedBy || "unknown element" };
  }, arg);
}
"#
}

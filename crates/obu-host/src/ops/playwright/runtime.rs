//! Shared helpers for invoking the page-side Playwright runtime.

use std::future::Future;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::backends::BackendRequestContext;
use crate::error::{HostError, Result};
use crate::methods;
use crate::ops::cua as cua_ops;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const RETRY_DELAY_MS: u64 = 100;

pub(crate) const MEDIA_DOWNLOAD_FUNCTION: &str = r#"(element) => {
  element.scrollIntoView({ block: "center", inline: "nearest" });
  const media = element.closest?.("img, video, source, a[href]") ?? element.querySelector?.("img, video, source, a[href]") ?? element;
  const url = media.currentSrc || media.src || media.href || "";
  if (!url) throw new Error("Matched element does not expose a downloadable media URL");
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = url.split("/").pop()?.split("?")[0] || "download";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return true;
}"#;

#[async_trait]
pub(crate) trait PlaywrightRuntimeBackend {
    async fn ensure_playwright_runtime(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
    ) -> Result<()>;

    async fn evaluate_playwright_runtime(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        expression: String,
    ) -> Result<Value>;
}

#[async_trait]
pub(crate) trait PlaywrightTextInputBackend: PlaywrightRuntimeBackend {
    async fn insert_playwright_text(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        text: &str,
    ) -> Result<()>;

    async fn press_playwright_key(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        key: &str,
    ) -> Result<()>;
}

#[async_trait]
pub(crate) trait PlaywrightCommandBackend: PlaywrightTextInputBackend + Sync {
    fn retarget_playwright_press_input(&self) -> bool;

    async fn click_playwright_selector(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
        click_count: i64,
    ) -> Result<Value>;

    async fn hover_playwright_selector(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value>;

    async fn screenshot_playwright_page(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value>;

    async fn wait_for_playwright_url(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value>;

    async fn wait_for_playwright_load_state(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value>;

    async fn wait_for_playwright_file_chooser(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value>;

    async fn set_playwright_file_chooser_files(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value>;

    async fn wait_for_playwright_download(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value>;

    async fn playwright_download_path(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value>;
}

pub(crate) fn is_direct_runtime_command(method: &str) -> bool {
    matches!(
        method,
        methods::PLAYWRIGHT_LOCATOR_IS_VISIBLE
            | methods::PLAYWRIGHT_LOCATOR_IS_ENABLED
            | methods::PLAYWRIGHT_LOCATOR_BOUNDING_BOX
            | methods::PLAYWRIGHT_LOCATOR_COUNT
            | methods::PLAYWRIGHT_LOCATOR_WAIT_FOR
            | methods::PLAYWRIGHT_LOCATOR_TEXT_CONTENT
            | methods::PLAYWRIGHT_LOCATOR_INNER_TEXT
            | methods::PLAYWRIGHT_LOCATOR_GET_ATTRIBUTE
            | methods::PLAYWRIGHT_LOCATOR_ALL_TEXT_CONTENTS
            | methods::PLAYWRIGHT_LOCATOR_SELECT_OPTION
            | methods::PLAYWRIGHT_LOCATOR_READ_ALL
            | methods::PLAYWRIGHT_LOCATOR_DOWNLOAD_MEDIA
            | methods::PLAYWRIGHT_DOM_SNAPSHOT
    )
}

pub(crate) async fn run_command<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    method: &str,
    params: Value,
) -> Result<Value>
where
    B: PlaywrightCommandBackend,
{
    if is_direct_runtime_command(method) {
        return run_direct_runtime_command(backend, ctx, method, params).await;
    }
    match method {
        methods::PLAYWRIGHT_LOCATOR_CLICK => {
            backend.click_playwright_selector(ctx, params, 1).await
        }
        methods::PLAYWRIGHT_LOCATOR_DBLCLICK => {
            backend.click_playwright_selector(ctx, params, 2).await
        }
        methods::PLAYWRIGHT_LOCATOR_HOVER => backend.hover_playwright_selector(ctx, params).await,
        methods::PLAYWRIGHT_LOCATOR_FILL => {
            fill_selector_with_text_input(backend, ctx, params).await
        }
        methods::PLAYWRIGHT_LOCATOR_PRESS => {
            press_selector_with_key_input(
                backend,
                ctx,
                params,
                backend.retarget_playwright_press_input(),
            )
            .await
        }
        methods::PLAYWRIGHT_LOCATOR_SET_CHECKED => {
            set_checked(backend, ctx, params, |params| {
                backend.click_playwright_selector(ctx, params, 1)
            })
            .await
        }
        methods::PLAYWRIGHT_SCREENSHOT => backend.screenshot_playwright_page(ctx, params).await,
        methods::PLAYWRIGHT_WAIT_FOR_TIMEOUT => wait_for_timeout(params).await,
        methods::PLAYWRIGHT_WAIT_FOR_URL => backend.wait_for_playwright_url(ctx, params).await,
        methods::PLAYWRIGHT_WAIT_FOR_LOAD_STATE => {
            backend.wait_for_playwright_load_state(ctx, params).await
        }
        methods::PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER => {
            backend.wait_for_playwright_file_chooser(ctx, params).await
        }
        methods::PLAYWRIGHT_FILE_CHOOSER_SET_FILES => {
            backend.set_playwright_file_chooser_files(ctx, params).await
        }
        methods::PLAYWRIGHT_WAIT_FOR_DOWNLOAD => {
            backend.wait_for_playwright_download(ctx, params).await
        }
        methods::PLAYWRIGHT_DOWNLOAD_PATH => backend.playwright_download_path(ctx, params).await,
        _ => Err(HostError::NotImplemented(method.into())),
    }
}

pub(crate) async fn run_direct_runtime_command<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    method: &str,
    params: Value,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    match method {
        methods::PLAYWRIGHT_LOCATOR_IS_VISIBLE => {
            read_selector_state(backend, ctx, params, "visible").await
        }
        methods::PLAYWRIGHT_LOCATOR_IS_ENABLED => {
            read_selector_state(backend, ctx, params, "enabled").await
        }
        methods::PLAYWRIGHT_LOCATOR_BOUNDING_BOX => bounding_box(backend, ctx, params).await,
        methods::PLAYWRIGHT_LOCATOR_COUNT => count(backend, ctx, params).await,
        methods::PLAYWRIGHT_LOCATOR_WAIT_FOR => wait_for_selector_state(backend, ctx, params).await,
        methods::PLAYWRIGHT_LOCATOR_TEXT_CONTENT => text_content(backend, ctx, params).await,
        methods::PLAYWRIGHT_LOCATOR_INNER_TEXT => inner_text(backend, ctx, params).await,
        methods::PLAYWRIGHT_LOCATOR_GET_ATTRIBUTE => get_attribute(backend, ctx, params).await,
        methods::PLAYWRIGHT_LOCATOR_ALL_TEXT_CONTENTS => {
            all_text_contents(backend, ctx, params).await
        }
        methods::PLAYWRIGHT_LOCATOR_SELECT_OPTION => select_option(backend, ctx, params).await,
        methods::PLAYWRIGHT_LOCATOR_READ_ALL => read_all(backend, ctx, params).await,
        methods::PLAYWRIGHT_LOCATOR_DOWNLOAD_MEDIA => download_media(backend, ctx, params).await,
        methods::PLAYWRIGHT_DOM_SNAPSHOT => dom_snapshot(backend, ctx, params).await,
        _ => Err(HostError::NotImplemented(method.into())),
    }
}

async fn wait_for_timeout(params: Value) -> Result<Value> {
    let timeout = timeout_ms(&params);
    tokio::time::sleep(Duration::from_millis(timeout)).await;
    Ok(Value::Null)
}

pub(crate) async fn resolve_action_point<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: &Value,
    require_visible: bool,
    require_enabled: bool,
) -> Result<(f64, f64)>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    let tab_id = required_str(params, "tab_id")?;
    let selector = required_str(params, "selector")?;
    let mut states = Vec::new();
    if require_visible && params.get("force").and_then(Value::as_bool) != Some(true) {
        states.push("visible");
    }
    if require_enabled && params.get("force").and_then(Value::as_bool) != Some(true) {
        states.push("enabled");
    }
    let point = eval_runtime(
        backend,
        ctx,
        tab_id,
        &format!(
            "window.__obuPlaywrightRuntime.resolveActionPoint({}, {})",
            js_string(selector),
            js_value(&json!({ "requiredStates": states }))
        ),
        timeout_ms(params),
    )
    .await?;
    let x = point
        .get("x")
        .and_then(Value::as_f64)
        .ok_or_else(|| HostError::CdpFailure("resolveActionPoint missing x".into()))?;
    let y = point
        .get("y")
        .and_then(Value::as_f64)
        .ok_or_else(|| HostError::CdpFailure("resolveActionPoint missing y".into()))?;
    Ok((x, y))
}

pub(crate) async fn click_selector<B, Click, ClickFut>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
    click_count: i64,
    mut click: Click,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
    Click: FnMut(Value, i64) -> ClickFut,
    ClickFut: Future<Output = Result<Value>>,
{
    let point = resolve_action_point(backend, ctx, &params, true, true).await?;
    let tab_id = required_str(&params, "tab_id")?;
    let button = params
        .get("button")
        .and_then(Value::as_str)
        .unwrap_or("left");
    click(
        cua_ops::click_params_with_navigation_wait(tab_id, point.0, point.1, button, &params),
        click_count,
    )
    .await
}

pub(crate) async fn hover_selector<B, Move, MoveFut>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
    mut move_mouse: Move,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
    Move: FnMut(Value) -> MoveFut,
    MoveFut: Future<Output = Result<Value>>,
{
    let point = resolve_action_point(backend, ctx, &params, true, false).await?;
    let tab_id = required_str(&params, "tab_id")?;
    move_mouse(json!({ "tab_id": tab_id, "x": point.0, "y": point.1 })).await
}

pub(crate) async fn eval_on_selector<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
    function_source: &str,
    arg: Value,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    let tab_id = required_str(&params, "tab_id")?;
    let selector = required_str(&params, "selector")?;
    eval_runtime(
        backend,
        ctx,
        tab_id,
        &format!(
            "window.__obuPlaywrightRuntime.evaluateOnSelector({}, {}, {})",
            js_string(selector),
            js_string(function_source),
            js_value(&arg)
        ),
        timeout_ms(&params),
    )
    .await
}

pub(crate) async fn eval_on_all<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
    function_source: &str,
    arg: Value,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    let tab_id = required_str(&params, "tab_id")?;
    let selector = required_str(&params, "selector")?;
    eval_runtime(
        backend,
        ctx,
        tab_id,
        &format!(
            "window.__obuPlaywrightRuntime.evaluateOnSelectorAll({}, {}, {})",
            js_string(selector),
            js_string(function_source),
            js_value(&arg)
        ),
        timeout_ms(&params),
    )
    .await
}

pub(crate) async fn read_selector_state<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
    state_name: &str,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    eval_on_all(
        backend,
        ctx,
        params,
        r#"(elements, injected, arg) => {
  const element = elements[0] || null;
  if (!element) return false;
  const state = injected.elementState(element, arg.stateName);
  return state.received === "error:notconnected" ? false : !!state.matches;
}"#,
        json!({ "stateName": state_name }),
    )
    .await
}

pub(crate) async fn count<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    eval_on_all(
        backend,
        ctx,
        params,
        "(elements) => elements.length",
        Value::Null,
    )
    .await
}

pub(crate) async fn text_content<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    eval_on_selector(
        backend,
        ctx,
        params,
        "(element) => element.textContent",
        Value::Null,
    )
    .await
}

pub(crate) async fn inner_text<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    eval_on_selector(
        backend,
        ctx,
        params,
        "(element) => ('innerText' in element ? String(element.innerText) : '')",
        Value::Null,
    )
    .await
}

pub(crate) async fn get_attribute<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    let name = required_str(&params, "name")?.to_string();
    eval_on_selector(
        backend,
        ctx,
        params,
        "(element, injected, arg) => element.getAttribute(arg.name)",
        json!({ "name": name }),
    )
    .await
}

pub(crate) async fn all_text_contents<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    eval_on_all(
        backend,
        ctx,
        params,
        "(elements) => elements.map((element) => typeof element.textContent === 'string' ? element.textContent : '')",
        Value::Null,
    )
    .await
}

pub(crate) async fn fill_selector<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    let value = required_str(&params, "value")?.to_string();
    eval_on_selector(
        backend,
        ctx,
        params,
        r#"(element, injected, arg) => {
  for (const stateName of ["visible", "enabled", "editable"]) {
    const state = injected.elementState(element, stateName);
    if (state.received === "error:notconnected") throw new Error("Element is not connected");
    if (!state.matches) throw new Error("Element is not " + stateName);
  }
  element.scrollIntoView({ block: "center", inline: "nearest" });
  const result = injected.fill(element, arg.value);
  if (result === "error:notconnected") throw new Error("Element is not connected");
  if (result !== "done" && result !== "needsinput") throw new Error(String(result));
  return result;
}"#,
        json!({ "value": value }),
    )
    .await
}

pub(crate) async fn fill_selector_with_text_input<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value>
where
    B: PlaywrightTextInputBackend + Sync,
{
    let value = required_str(&params, "value")?.to_string();
    let replace = params
        .get("replace")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let result = if replace {
        fill_selector(backend, ctx, params.clone()).await?
    } else {
        focus_selector(backend, ctx, params.clone(), false, true, true).await?;
        Value::String("needsinput".into())
    };
    if result.as_str() == Some("needsinput") {
        backend
            .insert_playwright_text(ctx, required_str(&params, "tab_id")?, &value)
            .await?;
    }
    Ok(Value::Null)
}

pub(crate) async fn focus_selector<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
    select_text: bool,
    require_editable: bool,
    retarget_input: bool,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    let states = if require_editable {
        json!(["visible", "enabled", "editable"])
    } else {
        json!(["visible", "enabled"])
    };
    eval_on_selector(
        backend,
        ctx,
        params,
        r#"(element, injected, arg) => {
  for (const stateName of arg.states) {
    const state = injected.elementState(element, stateName);
    if (state.received === "error:notconnected") throw new Error("Element is not connected");
    if (!state.matches) throw new Error("Element is not " + stateName);
  }
  const target = arg.retargetInput ? injected.retarget(element, "follow-label") : element;
  if (target == null) throw new Error("Element is not connected");
  element.scrollIntoView({ block: "center", inline: "nearest" });
  const result = arg.selectText ? injected.selectText(target) : injected.focusNode(target, false);
  if (result !== "done") throw new Error(String(result));
  return true;
}"#,
        json!({
            "states": states,
            "selectText": select_text,
            "retargetInput": retarget_input,
        }),
    )
    .await
}

pub(crate) async fn press_selector_with_key_input<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
    retarget_input: bool,
) -> Result<Value>
where
    B: PlaywrightTextInputBackend + Sync,
{
    let key = required_str(&params, "value")
        .or_else(|_| required_str(&params, "key"))?
        .to_string();
    focus_selector(backend, ctx, params.clone(), false, false, retarget_input).await?;
    backend
        .press_playwright_key(ctx, required_str(&params, "tab_id")?, &key)
        .await?;
    Ok(Value::Null)
}

pub(crate) async fn bounding_box<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    eval_on_selector(
        backend,
        ctx,
        params,
        r#"(element, injected, arg, scope) => {
  const rect = element.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const offset = scope.prepareFrameChainForPointerAction();
  return { x: offset.left + rect.left, y: offset.top + rect.top, width: rect.width, height: rect.height };
}"#,
        Value::Null,
    )
    .await
}

pub(crate) async fn select_option<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    let selections = params
        .get("selections")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    eval_on_selector(
        backend,
        ctx,
        params,
        r#"(element, injected, arg) => {
  const state = injected.elementState(element, "enabled");
  if (state.received === "error:notconnected") throw new Error("Element is not connected");
  if (!state.matches) throw new Error("Element is not enabled");
  const result = injected.selectOptions(element, arg.selections || []);
  if (typeof result === "string" && result.startsWith("error:")) throw new Error(result);
  return true;
}"#,
        json!({ "selections": selections }),
    )
    .await
    .map(|_| Value::Null)
}

pub(crate) async fn read_checked_state<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    eval_on_selector(
        backend,
        ctx,
        params,
        r#"(element, injected) => {
  const state = injected.elementState(element, "checked");
  if (state.received === "error:notconnected") throw new Error("Element is not connected");
  return { checked: !!state.matches, isRadio: !!state.isRadio };
}"#,
        Value::Null,
    )
    .await
}

pub(crate) async fn set_checked<B, Click, ClickFut>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
    mut click: Click,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
    Click: FnMut(Value) -> ClickFut,
    ClickFut: Future<Output = Result<Value>>,
{
    let checked = params
        .get("checked")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            HostError::Protocol("playwright_locator_set_checked requires checked".into())
        })?;
    let before = read_checked_state(backend, ctx, params.clone()).await?;
    if before.get("checked").and_then(Value::as_bool) == Some(checked) {
        return Ok(Value::Null);
    }
    if before.get("isRadio").and_then(Value::as_bool) == Some(true) && !checked {
        return Err(HostError::CdpFailure(
            "Cannot uncheck a radio button".into(),
        ));
    }
    click(params.clone()).await?;
    let after = read_checked_state(backend, ctx, params).await?;
    if after.get("checked").and_then(Value::as_bool) != Some(checked) {
        return Err(HostError::CdpFailure(format!(
            "Click did not change checked state to {checked}"
        )));
    }
    Ok(Value::Null)
}

pub(crate) async fn download_media<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    eval_on_selector(backend, ctx, params, MEDIA_DOWNLOAD_FUNCTION, Value::Null)
        .await
        .map(|_| Value::Null)
}

pub(crate) async fn read_all<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    let relative_selector = params
        .get("relative_selector")
        .cloned()
        .unwrap_or(Value::Null);
    eval_on_all(
        backend,
        ctx,
        params,
        r#"(elements, injected, arg) => {
  const read = (element) => ({
    attributes: Object.fromEntries(Array.from(element.attributes || [], (attr) => [attr.name, attr.value])),
    inner_text: "innerText" in element ? String(element.innerText) : "",
    text_content: element.textContent,
  });
  if (!arg.relativeSelector) return elements.map(read);
  const parsed = injected.parseSelector(arg.relativeSelector);
  return elements.map((element) => {
    const matches = injected.querySelectorAll(parsed, element);
    return matches[0] ? read(matches[0]) : null;
  });
}"#,
        json!({ "relativeSelector": relative_selector }),
    )
    .await
}

pub(crate) async fn dom_snapshot<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    let tab_id = required_str(&params, "tab_id")?;
    let value = eval_page(
        backend,
        ctx,
        tab_id,
        r##"(injected) => {
  const overlaySelector = "#obu-agent-overlay-root,[data-obu-overlay-root]";
  const overlays = Array.from(document.querySelectorAll(overlaySelector));
  const previous = overlays.map((overlay) => ({
    overlay,
    display: overlay.style.display,
    hidden: overlay.hidden,
    ariaHidden: overlay.getAttribute("aria-hidden")
  }));
  for (const overlay of overlays) {
    overlay.setAttribute("aria-hidden", "true");
    overlay.hidden = true;
    overlay.style.display = "none";
  }
  try {
  const root = document.body || document.documentElement;
  return root ? injected.incrementalAriaSnapshot(root, { mode: "ai", track: "open-browser-use-dom-snapshot" }).full : "";
  } finally {
    for (const row of previous) {
      row.overlay.style.display = row.display;
      row.overlay.hidden = row.hidden;
      if (row.ariaHidden === null) {
        row.overlay.removeAttribute("aria-hidden");
      } else {
        row.overlay.setAttribute("aria-hidden", row.ariaHidden);
      }
    }
  }
}"##,
        Value::Null,
        timeout_ms(&params),
    )
    .await?;
    Ok(json!({ "domSnapshot": value, "source": "playwright_dom_snapshot" }))
}

pub(crate) async fn wait_for_selector_state<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    let state = params
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("visible")
        .to_string();
    if !matches!(
        state.as_str(),
        "attached" | "detached" | "visible" | "hidden"
    ) {
        return Err(HostError::Protocol(format!(
            "unsupported waitFor state {state}"
        )));
    }
    eval_on_all(
        backend,
        ctx,
        params,
        r#"(elements, injected, arg) => {
  const element = elements[0] || null;
  if (arg.state === "attached") {
    if (element) return true;
    throw new Error("Element is not attached");
  }
  if (arg.state === "detached") {
    if (!element) return true;
    throw new Error("Element is still attached");
  }
  if (!element) {
    if (arg.state === "hidden") return true;
    throw new Error("Element is not attached");
  }
  const state = injected.elementState(element, arg.state);
  if (state.received === "error:notconnected") throw new Error("Element is not connected");
  if (state.matches) return true;
  throw new Error("Element is not " + arg.state);
}"#,
        json!({ "state": state }),
    )
    .await
    .map(|_| Value::Null)
}

pub(crate) async fn eval_page<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    tab_id: &str,
    function_source: &str,
    arg: Value,
    timeout_ms: u64,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    eval_runtime(
        backend,
        ctx,
        tab_id,
        &format!(
            "window.__obuPlaywrightRuntime.evaluateOnPage({}, {})",
            js_string(function_source),
            js_value(&arg)
        ),
        timeout_ms,
    )
    .await
}

pub(crate) async fn eval_runtime<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    tab_id: &str,
    invocation: &str,
    timeout_ms: u64,
) -> Result<Value>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    with_retry(timeout_ms, || async {
        backend.ensure_playwright_runtime(ctx, tab_id).await?;
        let result = backend
            .evaluate_playwright_runtime(
                ctx,
                tab_id,
                format!("(async () => await ({invocation}))()"),
            )
            .await?;
        runtime_result_value(result)
    })
    .await
}

pub(crate) fn timeout_ms(params: &Value) -> u64 {
    params
        .get("timeout_ms")
        .or_else(|| params.get("timeout"))
        .or_else(|| params.get("client_timeout_ms"))
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
}

pub(crate) fn runtime_result_value(result: Value) -> Result<Value> {
    if let Some(details) = result.get("exceptionDetails") {
        return Err(HostError::CdpFailure(exception_message(details)));
    }
    Ok(result
        .get("result")
        .and_then(|result| result.get("value"))
        .cloned()
        .unwrap_or(Value::Null))
}

fn required_str<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::Protocol(format!("missing {key}")))
}

fn exception_message(details: &Value) -> String {
    details
        .get("exception")
        .and_then(|exception| {
            exception
                .get("description")
                .or_else(|| exception.get("value"))
        })
        .and_then(Value::as_str)
        .or_else(|| details.get("text").and_then(Value::as_str))
        .unwrap_or("Playwright selector evaluation failed")
        .to_string()
}

async fn with_retry<F, Fut>(timeout_ms: u64, mut op: F) -> Result<Value>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Value>>,
{
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match op().await {
            Ok(value) => return Ok(value),
            Err(error) if is_fatal(&error) => return Err(error),
            Err(error) if Instant::now() >= deadline => {
                return Err(HostError::Timeout(format!(
                    "playwright op timed out after {timeout_ms}ms: {error}"
                )));
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(RETRY_DELAY_MS)).await,
        }
    }
}

fn is_fatal(error: &HostError) -> bool {
    match error {
        HostError::PeerAuthRefused(_)
        | HostError::NotImplemented(_)
        | HostError::NoBackendAvailable(_)
        | HostError::Protocol(_)
        | HostError::TabNotAttached(_)
        | HostError::PageClosed(_)
        | HostError::DialogRequiresDecision(_)
        | HostError::Timeout(_) => true,
        HostError::CdpFailure(message) => {
            message.contains("strict mode violation:")
                || message.contains(
                    "Cannot compute a reliable click point through a transformed iframe chain",
                )
                || message.contains("Cross-origin or out-of-process iframes are not supported")
        }
        HostError::Io(_) | HostError::Frame(_) => false,
    }
}

fn js_string(value: &str) -> String {
    serde_json::to_string(value).expect("string serializes")
}

fn js_value(value: &Value) -> String {
    serde_json::to_string(value).expect("value serializes")
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;

    use super::*;

    struct FakeRuntimeBackend {
        responses: Mutex<VecDeque<Value>>,
    }

    impl FakeRuntimeBackend {
        fn new(responses: Vec<Value>) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
            }
        }
    }

    #[async_trait]
    impl PlaywrightRuntimeBackend for FakeRuntimeBackend {
        async fn ensure_playwright_runtime(
            &self,
            _ctx: &BackendRequestContext,
            _tab_id: &str,
        ) -> Result<()> {
            Ok(())
        }

        async fn evaluate_playwright_runtime(
            &self,
            _ctx: &BackendRequestContext,
            _tab_id: &str,
            _expression: String,
        ) -> Result<Value> {
            let value = self
                .responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Value::Null);
            Ok(json!({ "result": { "value": value } }))
        }
    }

    struct FakeCommandBackend {
        responses: Mutex<VecDeque<Value>>,
        expressions: Mutex<Vec<String>>,
        clicks: Mutex<Vec<i64>>,
        pressed_keys: Mutex<Vec<String>>,
        retarget_press_input: bool,
    }

    impl FakeCommandBackend {
        fn new(responses: Vec<Value>, retarget_press_input: bool) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                expressions: Mutex::new(Vec::new()),
                clicks: Mutex::new(Vec::new()),
                pressed_keys: Mutex::new(Vec::new()),
                retarget_press_input,
            }
        }
    }

    #[async_trait]
    impl PlaywrightRuntimeBackend for FakeCommandBackend {
        async fn ensure_playwright_runtime(
            &self,
            _ctx: &BackendRequestContext,
            _tab_id: &str,
        ) -> Result<()> {
            Ok(())
        }

        async fn evaluate_playwright_runtime(
            &self,
            _ctx: &BackendRequestContext,
            _tab_id: &str,
            expression: String,
        ) -> Result<Value> {
            self.expressions.lock().unwrap().push(expression);
            let value = self
                .responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Value::Null);
            Ok(json!({ "result": { "value": value } }))
        }
    }

    #[async_trait]
    impl PlaywrightTextInputBackend for FakeCommandBackend {
        async fn insert_playwright_text(
            &self,
            _ctx: &BackendRequestContext,
            _tab_id: &str,
            _text: &str,
        ) -> Result<()> {
            Ok(())
        }

        async fn press_playwright_key(
            &self,
            _ctx: &BackendRequestContext,
            _tab_id: &str,
            key: &str,
        ) -> Result<()> {
            self.pressed_keys.lock().unwrap().push(key.to_string());
            Ok(())
        }
    }

    #[async_trait]
    impl PlaywrightCommandBackend for FakeCommandBackend {
        fn retarget_playwright_press_input(&self) -> bool {
            self.retarget_press_input
        }

        async fn click_playwright_selector(
            &self,
            _ctx: &BackendRequestContext,
            _params: Value,
            click_count: i64,
        ) -> Result<Value> {
            self.clicks.lock().unwrap().push(click_count);
            Ok(Value::Null)
        }

        async fn hover_playwright_selector(
            &self,
            _ctx: &BackendRequestContext,
            _params: Value,
        ) -> Result<Value> {
            Ok(Value::Null)
        }

        async fn screenshot_playwright_page(
            &self,
            _ctx: &BackendRequestContext,
            _params: Value,
        ) -> Result<Value> {
            Ok(json!({ "kind": "screenshot" }))
        }

        async fn wait_for_playwright_url(
            &self,
            _ctx: &BackendRequestContext,
            _params: Value,
        ) -> Result<Value> {
            Ok(json!({ "kind": "url" }))
        }

        async fn wait_for_playwright_load_state(
            &self,
            _ctx: &BackendRequestContext,
            _params: Value,
        ) -> Result<Value> {
            Ok(json!({ "kind": "load" }))
        }

        async fn wait_for_playwright_file_chooser(
            &self,
            _ctx: &BackendRequestContext,
            _params: Value,
        ) -> Result<Value> {
            Ok(json!({ "kind": "filechooser" }))
        }

        async fn set_playwright_file_chooser_files(
            &self,
            _ctx: &BackendRequestContext,
            _params: Value,
        ) -> Result<Value> {
            Ok(Value::Null)
        }

        async fn wait_for_playwright_download(
            &self,
            _ctx: &BackendRequestContext,
            _params: Value,
        ) -> Result<Value> {
            Ok(json!({ "kind": "download" }))
        }

        async fn playwright_download_path(
            &self,
            _ctx: &BackendRequestContext,
            _params: Value,
        ) -> Result<Value> {
            Ok(json!({ "kind": "path" }))
        }
    }

    fn checked_params(checked: bool) -> Value {
        json!({
            "tab_id": "tab-1",
            "selector": "input[type=checkbox]",
            "checked": checked,
            "timeout_ms": 1,
        })
    }

    #[tokio::test]
    async fn retry_loop_retries_transient_errors_until_success() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_for_retry = attempts.clone();

        let result = with_retry(200, move || {
            let attempts = attempts_for_retry.clone();
            async move {
                let attempt = attempts.fetch_add(1, Ordering::SeqCst);
                if attempt == 0 {
                    Err(HostError::CdpFailure("Element is not visible".into()))
                } else {
                    Ok(json!("ready"))
                }
            }
        })
        .await
        .unwrap();

        assert_eq!(result, json!("ready"));
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn retry_loop_does_not_retry_fatal_selector_errors() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_for_retry = attempts.clone();

        let error = with_retry(200, move || {
            let attempts = attempts_for_retry.clone();
            async move {
                attempts.fetch_add(1, Ordering::SeqCst);
                Err(HostError::CdpFailure(
                    "strict mode violation: locator resolved to two elements".into(),
                ))
            }
        })
        .await
        .unwrap_err();

        assert!(error.to_string().contains("strict mode violation"));
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn set_checked_skips_click_when_state_already_matches() {
        let backend = FakeRuntimeBackend::new(vec![json!({
            "checked": true,
            "isRadio": false,
        })]);
        let clicked = Arc::new(AtomicUsize::new(0));
        let clicked_for_closure = clicked.clone();

        set_checked(
            &backend,
            &BackendRequestContext::default(),
            checked_params(true),
            move |_| {
                let clicked = clicked_for_closure.clone();
                async move {
                    clicked.fetch_add(1, Ordering::SeqCst);
                    Ok(Value::Null)
                }
            },
        )
        .await
        .unwrap();

        assert_eq!(clicked.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn dom_snapshot_hides_obu_overlay_before_snapshotting() {
        let backend = FakeCommandBackend::new(vec![json!("snapshot")], false);

        let result = dom_snapshot(
            &backend,
            &BackendRequestContext::default(),
            json!({ "tab_id": "tab-1", "timeout_ms": 1 }),
        )
        .await
        .unwrap();

        assert_eq!(
            result,
            json!({ "domSnapshot": "snapshot", "source": "playwright_dom_snapshot" })
        );
        let expressions = backend.expressions.lock().unwrap();
        let expression = expressions.first().expect("snapshot expression captured");
        assert!(expression.contains("#obu-agent-overlay-root,[data-obu-overlay-root]"));
        assert!(expression.contains("overlay.style.display"));
        assert!(expression.contains("none"));
        assert!(expression.contains("overlay.hidden = true"));
        assert!(expression.contains("incrementalAriaSnapshot"));
        assert!(expression.contains("finally"));
    }

    #[tokio::test]
    async fn read_all_captures_text_and_attributes_for_collection() {
        let rows = json!([
            {
                "attributes": { "data-kind": "primary" },
                "inner_text": "Save",
                "text_content": " Save "
            },
            null
        ]);
        let backend = FakeCommandBackend::new(vec![rows.clone()], false);

        let result = read_all(
            &backend,
            &BackendRequestContext::default(),
            json!({
                "tab_id": "tab-1",
                "selector": ".item",
                "relative_selector": ".label",
                "timeout_ms": 1
            }),
        )
        .await
        .unwrap();

        assert_eq!(result, rows);
        let expressions = backend.expressions.lock().unwrap();
        let expression = expressions.first().expect("read_all expression captured");
        assert!(expression.contains("evaluateOnSelectorAll"));
        assert!(expression.contains(r#""relativeSelector":".label""#));
        assert!(expression.contains("Object.fromEntries"));
        assert!(expression.contains("inner_text"));
        assert!(expression.contains("text_content"));
    }

    #[tokio::test]
    async fn set_checked_rejects_radio_uncheck_before_clicking() {
        let backend = FakeRuntimeBackend::new(vec![json!({
            "checked": true,
            "isRadio": true,
        })]);
        let clicked = Arc::new(AtomicUsize::new(0));
        let clicked_for_closure = clicked.clone();

        let error = set_checked(
            &backend,
            &BackendRequestContext::default(),
            checked_params(false),
            move |_| {
                let clicked = clicked_for_closure.clone();
                async move {
                    clicked.fetch_add(1, Ordering::SeqCst);
                    Ok(Value::Null)
                }
            },
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("Cannot uncheck a radio button"));
        assert_eq!(clicked.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn set_checked_clicks_and_verifies_changed_state() {
        let backend = FakeRuntimeBackend::new(vec![
            json!({
                "checked": false,
                "isRadio": false,
            }),
            json!({
                "checked": true,
                "isRadio": false,
            }),
        ]);
        let clicked = Arc::new(AtomicUsize::new(0));
        let clicked_for_closure = clicked.clone();

        set_checked(
            &backend,
            &BackendRequestContext::default(),
            checked_params(true),
            move |_| {
                let clicked = clicked_for_closure.clone();
                async move {
                    clicked.fetch_add(1, Ordering::SeqCst);
                    Ok(Value::Null)
                }
            },
        )
        .await
        .unwrap();

        assert_eq!(clicked.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn shared_command_router_routes_backend_edge_actions() {
        let backend = FakeCommandBackend::new(vec![], false);

        run_command(
            &backend,
            &BackendRequestContext::default(),
            methods::PLAYWRIGHT_LOCATOR_DBLCLICK,
            json!({ "tab_id": "tab-1", "selector": "button" }),
        )
        .await
        .unwrap();

        assert_eq!(*backend.clicks.lock().unwrap(), vec![2]);
    }

    #[tokio::test]
    async fn shared_command_router_uses_shared_press_input_composition() {
        let backend = FakeCommandBackend::new(vec![json!(true)], true);

        run_command(
            &backend,
            &BackendRequestContext::default(),
            methods::PLAYWRIGHT_LOCATOR_PRESS,
            json!({ "tab_id": "tab-1", "selector": "label", "key": "Enter" }),
        )
        .await
        .unwrap();

        assert_eq!(*backend.pressed_keys.lock().unwrap(), vec!["Enter"]);
        assert!(
            backend
                .expressions
                .lock()
                .unwrap()
                .iter()
                .any(|expression| expression.contains(r#""retargetInput":true"#))
        );
    }
}

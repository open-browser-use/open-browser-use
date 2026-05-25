//! Shared helpers for invoking the page-side Playwright runtime.

use std::future::Future;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::backends::BackendRequestContext;
use crate::error::{HostError, Result};
use crate::methods;
use crate::ops::action_point::{
    ActionPointResolution, RESOLUTION_CROSS_ORIGIN_UNREACHABLE, RESOLUTION_NO_CLICKABLE_BOX,
    RESOLUTION_OCCLUDED, RESOLUTION_OUTSIDE_VIEWPORT, RESOLUTION_TRANSFORMED_FRAME_UNSUPPORTED,
};
use crate::ops::cua as cua_ops;
use crate::ops::dom_cua;

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

    /// The tab's top-level CDP session id (None for backends without sessions).
    async fn playwright_top_level_session(&self, _tab_id: &str) -> Option<String> {
        None
    }

    /// The OOPIF session owning the frame whose devtools frameId is `frame_id`.
    async fn playwright_oopif_session_for_frame(&self, _frame_id: &str) -> Option<String> {
        None
    }

    /// Run a CDP command on a specific session (top-level or OOPIF). Default: unsupported.
    async fn execute_playwright_cdp_on_session(
        &self,
        _session_id: &str,
        _method: &str,
        _params: Value,
    ) -> Result<Value> {
        Err(HostError::NotImplemented(
            "execute_playwright_cdp_on_session is not supported by this backend".into(),
        ))
    }
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

    async fn playwright_element_info(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value>;

    async fn playwright_element_screenshot(
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
        methods::PLAYWRIGHT_ELEMENT_INFO => backend.playwright_element_info(ctx, params).await,
        methods::PLAYWRIGHT_ELEMENT_SCREENSHOT => {
            backend.playwright_element_screenshot(ctx, params).await
        }
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

pub(crate) fn map_resolve_action_point_result(value: &Value) -> Result<(f64, f64)> {
    if let Some(resolution) = value.get("resolution").and_then(Value::as_str) {
        let outcome = match resolution {
            RESOLUTION_OCCLUDED => ActionPointResolution::Occluded {
                by: value
                    .get("by")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown element")
                    .to_string(),
            },
            RESOLUTION_OUTSIDE_VIEWPORT => ActionPointResolution::OutsideViewport,
            RESOLUTION_NO_CLICKABLE_BOX => ActionPointResolution::NoClickableBox,
            RESOLUTION_TRANSFORMED_FRAME_UNSUPPORTED => {
                ActionPointResolution::TransformedFrameUnsupported
            }
            RESOLUTION_CROSS_ORIGIN_UNREACHABLE => ActionPointResolution::CrossOriginUnreachable {
                reason: value
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("cross-origin frame is not reachable via the selector path")
                    .to_string(),
            },
            other => {
                return Err(HostError::CdpFailure(format!(
                    "resolveActionPoint returned unknown resolution: {other}"
                )));
            }
        };
        return Err(outcome.into_host_error());
    }
    let x = value
        .get("x")
        .and_then(Value::as_f64)
        .ok_or_else(|| HostError::CdpFailure("resolveActionPoint missing x".into()))?;
    let y = value
        .get("y")
        .and_then(Value::as_f64)
        .ok_or_else(|| HostError::CdpFailure("resolveActionPoint missing y".into()))?;
    Ok((x, y))
}

/// Split a Playwright selector at the FIRST cross-frame hop into
/// `(frame-locator selector, in-frame selector)`. Returns `None` when there is no
/// `enter-frame` hop. Used by the OOPIF resolver to run the frame part on the
/// top-level session and the remainder on the owning OOPIF session.
///
/// The literal marker must stay in sync with the SDK/Playwright frame-hop
/// selector serialization; if it ever diverges, a cross-origin selector falls
/// back gracefully to the typed `cross_origin_unreachable` error (the
/// `splits_selector_at_first_enter_frame` test pins the current form).
pub(crate) fn split_first_enter_frame(selector: &str) -> Option<(String, String)> {
    const MARKER: &str = " >> internal:control=enter-frame >> ";
    let index = selector.find(MARKER)?;
    let frame = selector[..index].trim().to_string();
    let inner = selector[index + MARKER.len()..].trim().to_string();
    if frame.is_empty() || inner.is_empty() {
        return None;
    }
    Some((frame, inner))
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
    let not_forced = params.get("force").and_then(Value::as_bool) != Some(true);
    let mut states = Vec::new();
    if require_visible && not_forced {
        states.push("visible");
    }
    if require_enabled && not_forced {
        states.push("enabled");
    }
    let hit_test = not_forced;
    let point = eval_runtime(
        backend,
        ctx,
        tab_id,
        &format!(
            "window.__obuPlaywrightRuntime.resolveActionPoint({}, {})",
            js_string(selector),
            js_value(&json!({ "requiredStates": states, "hitTest": hit_test }))
        ),
        timeout_ms(params),
    )
    .await?;
    // A selector that crosses into a cross-origin (OOPIF) frame can't be resolved
    // in-page: try the cross-session CDP path before surfacing the typed error.
    if point.get("resolution").and_then(Value::as_str) == Some(RESOLUTION_CROSS_ORIGIN_UNREACHABLE)
        && let Some(xy) = resolve_cross_origin_action_point(backend, tab_id, selector).await?
    {
        return Ok(xy);
    }
    map_resolve_action_point_result(&point)
}

/// Resolve a Playwright selector that crosses into a cross-origin (OOPIF) frame.
///
/// Bounded to the common case: a SINGLE cross-origin hop with CSS selectors on
/// both sides (CDP `DOM.querySelector`). Returns `Ok(None)` for anything it can't
/// resolve (no hop, non-CSS selector, no OOPIF session, element not found) so the
/// caller falls back to the typed `cross_origin_unreachable` error.
///
/// Assumptions (validated by the site-isolated e2e in tests/oopif_e2e.rs):
/// - the iframe's devtools `frameId` equals its OOPIF target id (auto-attach);
/// - an OOPIF session's `getContentQuads` returns root-frame-composed coords
///   (DOM-CUA branch 4a), so `action_point_from_content_quads` applies unchanged.
async fn resolve_cross_origin_action_point<B>(
    backend: &B,
    tab_id: &str,
    selector: &str,
) -> Result<Option<(f64, f64)>>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    let Some((frame_selector, inner_selector)) = split_first_enter_frame(selector) else {
        return Ok(None);
    };
    let Some(top_session) = backend.playwright_top_level_session(tab_id).await else {
        return Ok(None);
    };

    // Viewport (top-level) for the final intersection/centroid math.
    let metrics = backend
        .execute_playwright_cdp_on_session(&top_session, "Page.getLayoutMetrics", json!({}))
        .await?;
    let Ok(viewport) = dom_cua::viewport_rect_from_layout_metrics(&metrics) else {
        return Ok(None);
    };

    // Resolve the iframe element on the top-level session -> its content frameId.
    let Some(frame_id) = query_frame_id(backend, &top_session, &frame_selector).await? else {
        return Ok(None);
    };
    let Some(oopif_session) = backend.playwright_oopif_session_for_frame(&frame_id).await else {
        return Ok(None);
    };

    // Resolve the inner element on the OOPIF session -> its backendNodeId.
    let Some(backend_node_id) =
        query_backend_node_id(backend, &oopif_session, &inner_selector).await?
    else {
        return Ok(None);
    };

    // Geometry on the OOPIF session (branch 4a: root-composed quads).
    let quads = backend
        .execute_playwright_cdp_on_session(
            &oopif_session,
            "DOM.getContentQuads",
            json!({ "backendNodeId": backend_node_id }),
        )
        .await?;
    Ok(dom_cua::action_point_from_content_quads(&quads, viewport))
}

/// `DOM.querySelector` `frame_selector` on `session`'s document, then read the
/// matched iframe's content `frameId` via `DOM.describeNode`. CSS only.
async fn query_frame_id<B>(
    backend: &B,
    session: &str,
    frame_selector: &str,
) -> Result<Option<String>>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    let Some(node_id) = query_node_id(backend, session, frame_selector).await? else {
        return Ok(None);
    };
    let described = backend
        .execute_playwright_cdp_on_session(
            session,
            "DOM.describeNode",
            json!({ "nodeId": node_id }),
        )
        .await?;
    Ok(described
        .get("node")
        .and_then(|node| node.get("frameId"))
        .and_then(Value::as_str)
        .map(str::to_string))
}

/// `DOM.querySelector` then read the matched node's `backendNodeId`.
async fn query_backend_node_id<B>(backend: &B, session: &str, selector: &str) -> Result<Option<i64>>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    let Some(node_id) = query_node_id(backend, session, selector).await? else {
        return Ok(None);
    };
    let described = backend
        .execute_playwright_cdp_on_session(
            session,
            "DOM.describeNode",
            json!({ "nodeId": node_id }),
        )
        .await?;
    Ok(described
        .get("node")
        .and_then(|node| node.get("backendNodeId"))
        .and_then(Value::as_i64))
}

/// `DOM.getDocument` (depth 0) for the root node id, then `DOM.querySelector`.
/// Returns `Ok(None)` if the selector matches nothing OR is not valid CSS (the
/// CDP call erroring is treated as "unresolvable", not fatal).
async fn query_node_id<B>(backend: &B, session: &str, selector: &str) -> Result<Option<i64>>
where
    B: PlaywrightRuntimeBackend + Sync,
{
    let document = backend
        .execute_playwright_cdp_on_session(session, "DOM.getDocument", json!({ "depth": 0 }))
        .await?;
    let Some(root_node_id) = document
        .get("root")
        .and_then(|r| r.get("nodeId"))
        .and_then(Value::as_i64)
    else {
        return Ok(None);
    };
    match backend
        .execute_playwright_cdp_on_session(
            session,
            "DOM.querySelector",
            json!({ "nodeId": root_node_id, "selector": selector }),
        )
        .await
    {
        Ok(result) => Ok(result
            .get("nodeId")
            .and_then(Value::as_i64)
            .filter(|id| *id != 0)),
        // invalid CSS / not found -> unresolvable, fall back to typed error
        Err(_) => Ok(None),
    }
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
        | HostError::Rpc { .. }
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

        async fn playwright_element_info(
            &self,
            _ctx: &BackendRequestContext,
            _params: Value,
        ) -> Result<Value> {
            Ok(json!({ "kind": "element_info" }))
        }

        async fn playwright_element_screenshot(
            &self,
            _ctx: &BackendRequestContext,
            _params: Value,
        ) -> Result<Value> {
            Ok(json!({ "kind": "element_screenshot" }))
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

#[cfg(test)]
mod resolve_map_tests {
    use serde_json::json;

    use super::map_resolve_action_point_result;
    use crate::error::HostError;

    #[test]
    fn point_result_returns_xy() {
        assert_eq!(
            map_resolve_action_point_result(&json!({ "x": 11.0, "y": 22.0 })).unwrap(),
            (11.0, 22.0)
        );
    }

    #[test]
    fn occluded_result_maps_to_resolution_error() {
        let error = map_resolve_action_point_result(
            &json!({ "resolution": "occluded", "by": "DIV#cover" }),
        )
        .unwrap_err();
        match error {
            HostError::Rpc {
                data: Some(data), ..
            } => {
                assert_eq!(data["resolution"], "occluded");
                assert_eq!(data["by"], "DIV#cover");
            }
            other => panic!("expected occluded rpc error, got {other:?}"),
        }
    }

    #[test]
    fn no_clickable_box_maps_to_resolution_error() {
        let error = map_resolve_action_point_result(&json!({ "resolution": "no_clickable_box" }))
            .unwrap_err();
        match error {
            HostError::Rpc {
                data: Some(data), ..
            } => assert_eq!(data["resolution"], "no_clickable_box"),
            other => panic!("expected no_clickable_box rpc error, got {other:?}"),
        }
    }

    #[test]
    fn outside_viewport_maps_to_resolution_error() {
        let error = map_resolve_action_point_result(&json!({ "resolution": "outside_viewport" }))
            .unwrap_err();
        match error {
            HostError::Rpc {
                data: Some(data), ..
            } => assert_eq!(data["resolution"], "outside_viewport"),
            other => panic!("expected outside_viewport rpc error, got {other:?}"),
        }
    }

    #[test]
    fn cross_origin_unreachable_maps_to_resolution_error() {
        let error = map_resolve_action_point_result(
            &json!({ "resolution": "cross_origin_unreachable", "reason": "no session for frame" }),
        )
        .unwrap_err();
        match error {
            HostError::Rpc {
                data: Some(data), ..
            } => {
                assert_eq!(data["resolution"], "cross_origin_unreachable");
                assert_eq!(data["reason"], "no session for frame");
            }
            other => panic!("expected cross_origin_unreachable rpc error, got {other:?}"),
        }
    }

    #[test]
    fn missing_coordinates_is_cdp_failure() {
        assert!(matches!(
            map_resolve_action_point_result(&json!({})).unwrap_err(),
            HostError::CdpFailure(_)
        ));
    }

    #[test]
    fn splits_selector_at_first_enter_frame() {
        assert_eq!(
            super::split_first_enter_frame("iframe >> internal:control=enter-frame >> #inner"),
            Some(("iframe".to_string(), "#inner".to_string()))
        );
        assert_eq!(super::split_first_enter_frame("#plain-css"), None);
        // Only the FIRST hop splits; nested remainder is preserved verbatim.
        assert_eq!(
            super::split_first_enter_frame(
                "a >> internal:control=enter-frame >> b >> internal:control=enter-frame >> c"
            ),
            Some((
                "a".to_string(),
                "b >> internal:control=enter-frame >> c".to_string()
            ))
        );
    }
}

#[cfg(test)]
mod oopif_resolver_tests {
    use async_trait::async_trait;

    use super::*;

    /// Fake backend that serves canned CDP responses keyed by `(session, method)`
    /// and a fixed top-level/OOPIF session topology. Implements ONLY the trait's
    /// required methods + the three OOPIF defaults the resolver consumes.
    struct FakeOopifBackend {
        /// When `false`, `playwright_oopif_session_for_frame` returns `None`.
        has_oopif_session: bool,
    }

    impl FakeOopifBackend {
        fn new() -> Self {
            Self {
                has_oopif_session: true,
            }
        }
    }

    #[async_trait]
    impl PlaywrightRuntimeBackend for FakeOopifBackend {
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
            Ok(Value::Null)
        }

        async fn playwright_top_level_session(&self, _tab_id: &str) -> Option<String> {
            Some("TOP".to_string())
        }

        async fn playwright_oopif_session_for_frame(&self, frame_id: &str) -> Option<String> {
            if self.has_oopif_session && frame_id == "FRAME-1" {
                Some("OOPIF".to_string())
            } else {
                None
            }
        }

        async fn execute_playwright_cdp_on_session(
            &self,
            session_id: &str,
            method: &str,
            _params: Value,
        ) -> Result<Value> {
            Ok(match (session_id, method) {
                ("TOP", "Page.getLayoutMetrics") => json!({
                    "cssVisualViewport": {
                        "pageX": 0.0,
                        "pageY": 0.0,
                        "clientWidth": 100.0,
                        "clientHeight": 100.0
                    }
                }),
                ("TOP", "DOM.getDocument") => json!({ "root": { "nodeId": 1 } }),
                ("TOP", "DOM.querySelector") => json!({ "nodeId": 2 }),
                ("TOP", "DOM.describeNode") => json!({ "node": { "frameId": "FRAME-1" } }),
                ("OOPIF", "DOM.getDocument") => json!({ "root": { "nodeId": 10 } }),
                ("OOPIF", "DOM.querySelector") => json!({ "nodeId": 11 }),
                ("OOPIF", "DOM.describeNode") => json!({ "node": { "backendNodeId": 77 } }),
                ("OOPIF", "DOM.getContentQuads") => json!({
                    "quads": [[10.0, 10.0, 30.0, 10.0, 30.0, 30.0, 10.0, 30.0]]
                }),
                other => panic!("unexpected CDP call: {other:?}"),
            })
        }
    }

    #[tokio::test]
    async fn cross_origin_selector_resolves_to_inner_point() {
        let fake = FakeOopifBackend::new();
        let point = resolve_cross_origin_action_point(
            &fake,
            "t",
            "iframe >> internal:control=enter-frame >> #inner",
        )
        .await
        .unwrap();
        // 20x20 quad at (10,10)-(30,30) -> centroid (20,20); viewport origin (0,0).
        assert_eq!(point, Some((20.0, 20.0)));
    }

    #[tokio::test]
    async fn no_session_for_frame_is_unresolvable() {
        let fake = FakeOopifBackend {
            has_oopif_session: false,
        };
        let point = resolve_cross_origin_action_point(
            &fake,
            "t",
            "iframe >> internal:control=enter-frame >> #inner",
        )
        .await
        .unwrap();
        assert_eq!(point, None);
    }
}

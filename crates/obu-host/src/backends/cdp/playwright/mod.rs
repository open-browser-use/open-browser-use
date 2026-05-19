//! Page-side Playwright command handlers backed by the vendored InjectedScript.

use std::collections::HashSet;

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::backends::{
    BackendRequestContext,
    cdp::{
        CdpBackend, attach::require_session, compose::tab_goto, compose::tab_screenshot, cua,
        ensure_injected::ensure_playwright_injected,
    },
};
use crate::error::{HostError, Result};
use crate::methods;
use crate::ops::event_wait;
use crate::ops::playwright::handles as handle_ops;
use crate::ops::playwright::runtime::{
    self, PlaywrightCommandBackend, PlaywrightRuntimeBackend, PlaywrightTextInputBackend,
    timeout_ms,
};
use crate::tab_state::TabId;

/// Route a Playwright/locator method to the CDP implementation.
pub async fn run(backend: &CdpBackend, method: &str, params: Value) -> Result<Value> {
    run_with_context(backend, &BackendRequestContext::default(), method, params).await
}

/// Route a Playwright/locator method to the CDP implementation with request context.
pub async fn run_with_context(
    backend: &CdpBackend,
    ctx: &BackendRequestContext,
    method: &str,
    params: Value,
) -> Result<Value> {
    runtime::run_command(backend, ctx, method, params).await
}

#[async_trait]
impl PlaywrightRuntimeBackend for CdpBackend {
    async fn ensure_playwright_runtime(
        &self,
        _ctx: &BackendRequestContext,
        tab_id: &str,
    ) -> Result<()> {
        ensure_playwright_injected(self, tab_id).await
    }

    async fn evaluate_playwright_runtime(
        &self,
        _ctx: &BackendRequestContext,
        tab_id: &str,
        expression: String,
    ) -> Result<Value> {
        let session_id = require_session(self, tab_id)?;
        self.transport()
            .send_command(
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true,
                    "userGesture": true,
                }),
                Some(&session_id),
            )
            .await
            .map_err(HostError::from)
    }
}

#[async_trait]
impl PlaywrightTextInputBackend for CdpBackend {
    async fn insert_playwright_text(
        &self,
        _ctx: &BackendRequestContext,
        tab_id: &str,
        text: &str,
    ) -> Result<()> {
        let session_id = require_session(self, tab_id)?;
        self.transport()
            .send_command(
                "Input.insertText",
                json!({ "text": text }),
                Some(&session_id),
            )
            .await
            .map_err(HostError::from)?;
        Ok(())
    }

    async fn press_playwright_key(
        &self,
        _ctx: &BackendRequestContext,
        tab_id: &str,
        key: &str,
    ) -> Result<()> {
        let session_id = require_session(self, tab_id)?;
        for event_type in ["keyDown", "keyUp"] {
            self.transport()
                .send_command(
                    "Input.dispatchKeyEvent",
                    json!({
                        "type": event_type,
                        "key": key,
                        "text": if key.chars().count() == 1 { key } else { "" },
                    }),
                    Some(&session_id),
                )
                .await
                .map_err(HostError::from)?;
        }
        Ok(())
    }
}

#[async_trait]
impl PlaywrightCommandBackend for CdpBackend {
    fn retarget_playwright_press_input(&self) -> bool {
        false
    }

    async fn click_playwright_selector(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
        click_count: i64,
    ) -> Result<Value> {
        runtime::click_selector(self, ctx, params, click_count, |params, click_count| {
            let method = if click_count == 2 {
                methods::CUA_DBLCLICK
            } else {
                methods::CUA_CLICK
            };
            cua::run(self, method, params)
        })
        .await
    }

    async fn hover_playwright_selector(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        runtime::hover_selector(self, ctx, params, |params| {
            cua::run(self, methods::CUA_MOVE, params)
        })
        .await
    }

    async fn screenshot_playwright_page(
        &self,
        _ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        tab_screenshot::screenshot_with_params(self, params).await
    }

    async fn wait_for_playwright_url(
        &self,
        _ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        wait_for_url(self, params).await
    }

    async fn wait_for_playwright_load_state(
        &self,
        _ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        wait_for_load_state(self, params).await
    }

    async fn wait_for_playwright_file_chooser(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        wait_for_file_chooser(self, ctx, params).await
    }

    async fn set_playwright_file_chooser_files(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        file_chooser_set_files(self, ctx, params).await
    }

    async fn wait_for_playwright_download(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        wait_for_download(self, ctx, params).await
    }

    async fn playwright_download_path(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        download_path(self, ctx, params).await
    }
}

async fn wait_for_url(backend: &CdpBackend, params: Value) -> Result<Value> {
    let tab_id = required_str(&params, "tab_id")?;
    let url = required_str(&params, "url")?;
    tab_goto::wait_for_url(backend, tab_id, url, Some(timeout_ms(&params))).await
}

async fn wait_for_load_state(backend: &CdpBackend, params: Value) -> Result<Value> {
    let tab_id = required_str(&params, "tab_id")?;
    let state = params
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("load");
    tab_goto::wait_for_load_state(backend, tab_id, state, Some(timeout_ms(&params))).await
}

async fn wait_for_file_chooser(
    backend: &CdpBackend,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    let tab_id = required_str(&params, "tab_id")?;
    let session_id = require_session(backend, tab_id)?;
    backend
        .transport()
        .send_command("Page.enable", json!({}), Some(&session_id))
        .await
        .map_err(HostError::from)?;
    backend
        .transport()
        .send_command("DOM.enable", json!({}), Some(&session_id))
        .await
        .map_err(HostError::from)?;
    backend
        .transport()
        .send_command(
            "Page.setInterceptFileChooserDialog",
            json!({ "enabled": true }),
            Some(&session_id),
        )
        .await
        .map_err(HostError::from)?;
    let event_timeout_ms = timeout_ms(&params);
    let mut events = backend.transport().subscribe_events();
    let event = event_wait::wait_for_broadcast_event_matching(
        &mut events,
        event_timeout_ms,
        format!("Page.fileChooserOpened event timed out after {event_timeout_ms}ms"),
        |_| HostError::from(crate::backends::cdp::error::CdpError::Disconnected),
        |event| {
            if event.session_id.as_deref() == Some(session_id.as_str())
                && event.method == "Page.fileChooserOpened"
                && handle_ops::file_chooser_opened_has_backend_node(&event.params)
            {
                return Some(event.params);
            }
            None
        },
    )
    .await;
    let _ = backend
        .transport()
        .send_command(
            "Page.setInterceptFileChooserDialog",
            json!({ "enabled": false }),
            Some(&session_id),
        )
        .await;
    let event = event?;
    handle_ops::file_chooser_opened_result(
        backend.registry(),
        tab_id,
        handle_owner_session(ctx, backend, tab_id)?,
        &event,
    )
}

async fn file_chooser_set_files(
    backend: &CdpBackend,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    let (state, files) =
        handle_ops::take_file_chooser_for_set_files(backend.registry(), ctx, &params)?;
    let session_id = require_session(backend, &state.tab_id.0)?;
    backend
        .transport()
        .send_command(
            "DOM.setFileInputFiles",
            handle_ops::set_file_input_files_params(&state, files),
            Some(&session_id),
        )
        .await
        .map_err(HostError::from)?;
    Ok(Value::Null)
}

async fn wait_for_download(
    backend: &CdpBackend,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    let tab_id = required_str(&params, "tab_id")?;
    let event_timeout_ms = timeout_ms(&params);
    let mut events = backend.transport().subscribe_events();
    let session_id = require_session(backend, tab_id)?;
    let frame_ids = download_frame_ids(backend, &session_id).await?;
    let will_begin = event_wait::wait_for_broadcast_event_matching(
        &mut events,
        event_timeout_ms,
        format!("Browser.downloadWillBegin event timed out after {event_timeout_ms}ms"),
        |_| HostError::from(crate::backends::cdp::error::CdpError::Disconnected),
        |event| {
            if event.method == "Browser.downloadWillBegin"
                && handle_ops::download_will_begin_matches_frame_ids(&event.params, &frame_ids)
            {
                return Some(event.params);
            }
            None
        },
    )
    .await?;
    handle_ops::record_download_from_will_begin(
        backend.registry(),
        tab_id,
        handle_owner_session(ctx, backend, tab_id)?,
        &will_begin,
    )
}

async fn download_path(
    backend: &CdpBackend,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    let (download_id, mut state) = handle_ops::download_for_path(backend.registry(), ctx, &params)?;
    if state.completed_path.is_none() {
        let guid = state.guid.clone();
        let event_timeout_ms = timeout_ms(&params);
        let mut events = backend.transport().subscribe_events();
        let progress = event_wait::wait_for_broadcast_event_matching(
            &mut events,
            event_timeout_ms,
            format!("Browser.downloadProgress event timed out after {event_timeout_ms}ms"),
            |_| HostError::from(crate::backends::cdp::error::CdpError::Disconnected),
            |event| {
                if event.method == "Browser.downloadProgress"
                    && handle_ops::download_progress_completed_for_guid(&event.params, &guid)
                {
                    return Some(event.params);
                }
                None
            },
        )
        .await?;
        let path = handle_ops::download_progress_file_path(&progress);
        handle_ops::mark_download_completed(backend.registry(), &download_id, &mut state, path)?;
    }
    handle_ops::download_path_result(&download_id, state)
}

fn handle_owner_session(
    ctx: &BackendRequestContext,
    backend: &CdpBackend,
    tab_id: &str,
) -> Result<Option<String>> {
    if ctx.session_id.is_some() {
        return Ok(ctx.session_id.clone());
    }
    Ok(backend
        .registry()
        .get(&TabId::new(tab_id))?
        .and_then(|record| record.session_id))
}

async fn download_frame_ids(backend: &CdpBackend, session_id: &str) -> Result<HashSet<String>> {
    let tree = backend
        .transport()
        .send_command("Page.getFrameTree", json!({}), Some(session_id))
        .await
        .map_err(HostError::from)?;
    let mut frame_ids = HashSet::new();
    collect_frame_ids(
        tree.get("frameTree").unwrap_or(&Value::Null),
        &mut frame_ids,
    );
    if frame_ids.is_empty() {
        return Err(HostError::Protocol(
            "Page.getFrameTree returned no frame ids for download correlation".into(),
        ));
    }
    Ok(frame_ids)
}

fn collect_frame_ids(node: &Value, out: &mut HashSet<String>) {
    if let Some(frame_id) = node
        .get("frame")
        .and_then(|frame| frame.get("id"))
        .and_then(Value::as_str)
    {
        out.insert(frame_id.to_string());
    }
    if let Some(children) = node.get("childFrames").and_then(Value::as_array) {
        for child in children {
            collect_frame_ids(child, out);
        }
    }
}

fn required_str<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::Protocol(format!("missing {key}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_frame_ids_walks_nested_frame_tree() {
        let frame_tree = json!({
            "frame": { "id": "root" },
            "childFrames": [
                { "frame": { "id": "child-1" } },
                {
                    "frame": { "id": "child-2" },
                    "childFrames": [{ "frame": { "id": "grandchild" } }]
                }
            ]
        });
        let mut frame_ids = HashSet::new();

        collect_frame_ids(&frame_tree, &mut frame_ids);

        assert_eq!(
            frame_ids,
            HashSet::from([
                "root".to_string(),
                "child-1".to_string(),
                "child-2".to_string(),
                "grandchild".to_string(),
            ])
        );
    }
}

//! Shared DOM-CUA runtime over CDP DOM geometry and coordinate CUA input.

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::backends::BackendRequestContext;
use crate::error::{HostError, Result};
use crate::methods;
use crate::ops::action_point::ActionPointResolution;
use crate::ops::dom_cua::{self, Rect};

#[async_trait]
pub(crate) trait DomCuaRuntimeBackend {
    async fn execute_dom_cdp(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value>;

    async fn dispatch_coordinate_cua(
        &self,
        ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value>;

    async fn remember_visible_dom_nodes(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        observation_id: Option<&str>,
        nodes: &[Value],
    );

    async fn validate_visible_dom_node(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        observation_id: Option<&str>,
        node_id: &str,
    ) -> Result<()>;

    async fn forget_visible_dom_snapshot(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        observation_id: Option<&str>,
    );

    /// OOPIF session ids for this tab. Default: none (same-process-only backends).
    async fn oopif_sessions_for_tab(&self, _tab_id: &str) -> Vec<String> {
        Vec::new()
    }

    /// Run a DOM command on a specific (OOPIF) session id. Default: unsupported.
    /// Only reached when `oopif_sessions_for_tab` returns sessions, so the default
    /// is unreachable for backends that don't override `oopif_sessions_for_tab`.
    async fn execute_dom_cdp_on_session(
        &self,
        _ctx: &BackendRequestContext,
        _session_id: &str,
        _method: &str,
        _params: Value,
    ) -> Result<Value> {
        Err(HostError::NotImplemented(
            "execute_dom_cdp_on_session is not supported by this backend".into(),
        ))
    }
}

pub(crate) async fn run<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    method: &str,
    params: Value,
) -> Result<Value>
where
    B: DomCuaRuntimeBackend + Sync,
{
    match method {
        methods::DOM_CUA_GET_VISIBLE_DOM => visible_dom(backend, ctx, params).await,
        methods::DOM_CUA_CLICK => click(backend, ctx, params, 1).await,
        methods::DOM_CUA_DOUBLE_CLICK => click(backend, ctx, params, 2).await,
        methods::DOM_CUA_SCROLL => scroll(backend, ctx, params).await,
        methods::DOM_CUA_TYPE => type_text(backend, ctx, params).await,
        methods::DOM_CUA_KEYPRESS => keypress(backend, ctx, params).await,
        methods::DOM_CUA_DOWNLOAD_MEDIA => Err(HostError::NotImplemented(
            "dom_cua_download_media requires an extension media extraction substrate".into(),
        )),
        _ => Err(HostError::NotImplemented(format!(
            "DOM-CUA command {method}"
        ))),
    }
}

async fn visible_dom<B: DomCuaRuntimeBackend + Sync>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    let tab_id = required_str(&params, "tab_id")?;
    let observation_id = optional_str(&params, "observation_id");
    let viewport = viewport_rect(backend, ctx, tab_id).await?;
    let document = backend
        .execute_dom_cdp(
            ctx,
            tab_id,
            "DOM.getDocument",
            json!({ "depth": -1, "pierce": true }),
        )
        .await?;
    let root = document
        .get("root")
        .ok_or_else(|| HostError::Protocol("DOM.getDocument missing root".into()))?;
    let mut nodes = Vec::new();
    collect_visible_dom_nodes(backend, ctx, tab_id, None, root, viewport, &mut nodes).await?;
    // Each OOPIF session is enumerated against the SAME top-level `viewport`: an
    // OOPIF session's box-model is composed to root-frame coordinates, so its rects
    // already live in the top-level viewport space (OOPIF design premise, validated
    // by the site-isolated probe). Do not subtract a frame offset here.
    for session_id in backend.oopif_sessions_for_tab(tab_id).await {
        let Ok(document) = backend
            .execute_dom_cdp_on_session(
                ctx,
                &session_id,
                "DOM.getDocument",
                json!({ "depth": -1, "pierce": true }),
            )
            .await
        else {
            // A flaky child frame must not blank the whole snapshot; skip it, but
            // leave a breadcrumb — the feature's failure mode is "nodes absent".
            tracing::debug!(session_id = %session_id, "OOPIF DOM.getDocument failed; its nodes are absent from this snapshot");
            continue;
        };
        if let Some(root) = document.get("root") {
            collect_visible_dom_nodes(
                backend,
                ctx,
                tab_id,
                Some(&session_id),
                root,
                viewport,
                &mut nodes,
            )
            .await?;
        }
    }
    backend
        .remember_visible_dom_nodes(ctx, tab_id, observation_id, &nodes)
        .await;
    let mut response = match params.get("format").and_then(Value::as_str) {
        Some("text") => {
            let text = dom_cua::render_visible_dom_text(&nodes);
            json!({ "format": "text", "text": text, "nodes": nodes })
        }
        Some("debug_text") => {
            let text = dom_cua::render_visible_dom_debug_text(&nodes);
            json!({ "format": "debug_text", "text": text, "nodes": nodes })
        }
        Some("compact_text") => {
            let text = dom_cua::render_visible_dom_compact_text(&nodes);
            json!({ "format": "compact_text", "text": text, "nodes": nodes })
        }
        _ => json!({ "nodes": nodes }),
    };
    if let Some(observation_id) = observation_id
        && let Some(object) = response.as_object_mut()
    {
        object.insert("observation_id".into(), json!(observation_id));
    }
    Ok(response)
}

async fn click<B: DomCuaRuntimeBackend + Sync>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
    click_count: i64,
) -> Result<Value> {
    let tab_id = required_str(&params, "tab_id")?.to_string();
    let observation_id = optional_str(&params, "observation_id").map(str::to_string);
    let node_id = required_str(&params, "node_id")?.to_string();
    let (x, y) =
        node_action_point(backend, ctx, &tab_id, observation_id.as_deref(), &node_id).await?;
    let mut click_params = json!({ "tab_id": tab_id, "x": x, "y": y });
    copy_modifiers(&mut click_params, &params);
    let method = if click_count == 2 {
        methods::CUA_DBLCLICK
    } else {
        methods::CUA_CLICK
    };
    let dispatch = backend
        .dispatch_coordinate_cua(ctx, method, click_params)
        .await?;
    if observation_id.is_some() {
        backend
            .forget_visible_dom_snapshot(ctx, &tab_id, observation_id.as_deref())
            .await;
    }
    Ok(action_point_result(Some(&node_id), x, y, dispatch))
}

async fn scroll<B: DomCuaRuntimeBackend + Sync>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    let tab_id = required_str(&params, "tab_id")?;
    let observation_id = optional_str(&params, "observation_id");
    let (x, y) = if let Some(node_id) = params.get("node_id").and_then(Value::as_str) {
        node_action_point(backend, ctx, tab_id, observation_id, node_id).await?
    } else {
        visual_viewport_input_center(backend, ctx, tab_id).await?
    };
    let delta_x = params
        .get("deltaX")
        .or_else(|| params.get("delta_x"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let delta_y = params
        .get("deltaY")
        .or_else(|| params.get("delta_y"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let mut scroll_params = json!({
        "tab_id": tab_id,
        "x": x,
        "y": y,
        "deltaX": delta_x,
        "deltaY": delta_y,
    });
    copy_modifiers(&mut scroll_params, &params);
    let dispatch = backend
        .dispatch_coordinate_cua(ctx, methods::CUA_SCROLL, scroll_params)
        .await?;
    if observation_id.is_some() {
        backend
            .forget_visible_dom_snapshot(ctx, tab_id, observation_id)
            .await;
    }
    Ok(action_point_result(
        params.get("node_id").and_then(Value::as_str),
        x,
        y,
        dispatch,
    ))
}

async fn type_text<B: DomCuaRuntimeBackend + Sync>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    let tab_id = required_str(&params, "tab_id")?;
    let observation_id = optional_str(&params, "observation_id");
    let node_id = required_str(&params, "node_id")?.to_string();
    let (x, y) = node_action_point(backend, ctx, tab_id, observation_id, &node_id).await?;
    let focus_dispatch = backend
        .dispatch_coordinate_cua(
            ctx,
            methods::CUA_CLICK,
            json!({ "tab_id": tab_id, "x": x, "y": y }),
        )
        .await?;
    let input_dispatch = backend
        .dispatch_coordinate_cua(
            ctx,
            methods::CUA_TYPE,
            json!({ "tab_id": tab_id, "text": required_str(&params, "text")? }),
        )
        .await?;
    if observation_id.is_some() {
        backend
            .forget_visible_dom_snapshot(ctx, tab_id, observation_id)
            .await;
    }
    Ok(action_point_result(
        Some(&node_id),
        x,
        y,
        json!({ "focus": focus_dispatch, "input": input_dispatch }),
    ))
}

async fn keypress<B: DomCuaRuntimeBackend + Sync>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    let tab_id = required_str(&params, "tab_id")?.to_string();
    let observation_id = optional_str(&params, "observation_id").map(str::to_string);
    let node_id = required_str(&params, "node_id")?.to_string();
    let (x, y) =
        node_action_point(backend, ctx, &tab_id, observation_id.as_deref(), &node_id).await?;
    let focus_dispatch = backend
        .dispatch_coordinate_cua(
            ctx,
            methods::CUA_CLICK,
            json!({ "tab_id": tab_id, "x": x, "y": y }),
        )
        .await?;
    let key_dispatch = backend
        .dispatch_coordinate_cua(ctx, methods::CUA_KEYPRESS, params)
        .await?;
    if observation_id.is_some() {
        backend
            .forget_visible_dom_snapshot(ctx, &tab_id, observation_id.as_deref())
            .await;
    }
    Ok(action_point_result(
        Some(&node_id),
        x,
        y,
        json!({ "focus": focus_dispatch, "input": key_dispatch }),
    ))
}

async fn viewport_rect<B: DomCuaRuntimeBackend + Sync>(
    backend: &B,
    ctx: &BackendRequestContext,
    tab_id: &str,
) -> Result<Rect> {
    let metrics = backend
        .execute_dom_cdp(ctx, tab_id, "Page.getLayoutMetrics", json!({}))
        .await?;
    dom_cua::viewport_rect_from_layout_metrics(&metrics)
}

async fn visual_viewport_input_center<B: DomCuaRuntimeBackend + Sync>(
    backend: &B,
    ctx: &BackendRequestContext,
    tab_id: &str,
) -> Result<(f64, f64)> {
    let metrics = backend
        .execute_dom_cdp(ctx, tab_id, "Page.getLayoutMetrics", json!({}))
        .await?;
    dom_cua::visual_viewport_input_center(&metrics)
}

async fn collect_visible_dom_nodes<B: DomCuaRuntimeBackend + Sync>(
    backend: &B,
    ctx: &BackendRequestContext,
    tab_id: &str,
    session_id: Option<&str>,
    node: &Value,
    viewport: Rect,
    nodes: &mut Vec<Value>,
) -> Result<()> {
    let mut stack = vec![node];
    while let Some(node) = stack.pop() {
        if dom_cua::is_hidden_subtree(node) {
            continue;
        }
        if let Some(backend_node_id) = node.get("backendNodeId").and_then(Value::as_i64)
            && let Some(rect) =
                box_model_rect(backend, ctx, tab_id, session_id, backend_node_id).await?
            && rect.width > 0.0
            && rect.height > 0.0
            && rect.intersects(viewport)
            && let Some(mut entry) = dom_cua::snapshot_entry(node, backend_node_id, rect)
        {
            // Tag OOPIF nodes with their owning session so geometry routes there in
            // Task 4; top-level nodes stay untagged (session_for_node -> None).
            // NOTE: assumes backendNodeId is unique across the top-level + OOPIF
            // sessions of a tab (Chromium assigns them in the browser process); the
            // site-isolated probe (tests/oopif_e2e.rs) validates this end-to-end.
            if let (Some(sid), Some(object)) = (session_id, entry.as_object_mut()) {
                object.insert("session_id".into(), json!(sid));
            }
            nodes.push(entry);
        }
        for key in ["children", "shadowRoots", "pseudoElements"] {
            if let Some(children) = node.get(key).and_then(Value::as_array) {
                for child in children.iter().rev() {
                    stack.push(child);
                }
            }
        }
        if let Some(content_document) = node.get("contentDocument") {
            stack.push(content_document);
        }
    }
    Ok(())
}

async fn node_action_point<B: DomCuaRuntimeBackend + Sync>(
    backend: &B,
    ctx: &BackendRequestContext,
    tab_id: &str,
    observation_id: Option<&str>,
    node_id: &str,
) -> Result<(f64, f64)> {
    backend
        .validate_visible_dom_node(ctx, tab_id, observation_id, node_id)
        .await?;
    let backend_node_id = dom_cua::backend_node_id(node_id)?;
    let _ = backend
        .execute_dom_cdp(
            ctx,
            tab_id,
            "DOM.scrollIntoViewIfNeeded",
            json!({ "backendNodeId": backend_node_id }),
        )
        .await;
    let viewport = viewport_rect(backend, ctx, tab_id).await?;
    if let Some(point) =
        content_quad_action_point(backend, ctx, tab_id, backend_node_id, viewport).await?
    {
        return verify_action_point(backend, ctx, tab_id, backend_node_id, point.0, point.1)
            .await?
            .into_point();
    }
    if let Some(point) =
        box_model_action_point(backend, ctx, tab_id, backend_node_id, viewport).await?
    {
        return verify_action_point(backend, ctx, tab_id, backend_node_id, point.0, point.1)
            .await?
            .into_point();
    }
    Err(HostError::Protocol(format!(
        "node_outside_viewport_after_scroll: DOM-CUA node {node_id} has no reliable visible action point"
    )))
}

async fn verify_action_point<B: DomCuaRuntimeBackend + Sync>(
    backend: &B,
    ctx: &BackendRequestContext,
    tab_id: &str,
    target_backend_node_id: i64,
    x: f64,
    y: f64,
) -> Result<ActionPointResolution> {
    let hit = backend
        .execute_dom_cdp(
            ctx,
            tab_id,
            "DOM.getNodeForLocation",
            json!({ "x": x, "y": y, "includeUserAgentShadowDOM": true, "ignorePointerEventsNone": false }),
        )
        .await?;
    let Some(hit_id) = hit.get("backendNodeId").and_then(Value::as_i64) else {
        return Ok(ActionPointResolution::Resolved { x, y }); // nothing hit-testable; do not block
    };
    if hit_id == target_backend_node_id {
        return Ok(ActionPointResolution::Resolved { x, y });
    }
    let described = backend
        .execute_dom_cdp(
            ctx,
            tab_id,
            "DOM.describeNode",
            json!({ "backendNodeId": target_backend_node_id, "depth": -1, "pierce": true }),
        )
        .await?;
    let mut subtree = std::collections::HashSet::new();
    if let Some(node) = described.get("node") {
        collect_backend_node_ids(node, &mut subtree);
    }
    if subtree.contains(&hit_id) {
        Ok(ActionPointResolution::Resolved { x, y })
    } else {
        Ok(ActionPointResolution::Occluded {
            by: format!("backendNodeId={hit_id}"),
        })
    }
}

fn collect_backend_node_ids(node: &Value, out: &mut std::collections::HashSet<i64>) {
    if let Some(id) = node.get("backendNodeId").and_then(Value::as_i64) {
        out.insert(id);
    }
    for key in ["children", "shadowRoots", "pseudoElements"] {
        if let Some(children) = node.get(key).and_then(Value::as_array) {
            for child in children {
                collect_backend_node_ids(child, out);
            }
        }
    }
    if let Some(content) = node.get("contentDocument") {
        collect_backend_node_ids(content, out);
    }
}

async fn content_quad_action_point<B: DomCuaRuntimeBackend + Sync>(
    backend: &B,
    ctx: &BackendRequestContext,
    tab_id: &str,
    backend_node_id: i64,
    viewport: Rect,
) -> Result<Option<(f64, f64)>> {
    let result = match backend
        .execute_dom_cdp(
            ctx,
            tab_id,
            "DOM.getContentQuads",
            json!({ "backendNodeId": backend_node_id }),
        )
        .await
    {
        Ok(result) => result,
        Err(_) => return Ok(None),
    };
    Ok(dom_cua::action_point_from_content_quads(&result, viewport))
}

async fn box_model_action_point<B: DomCuaRuntimeBackend + Sync>(
    backend: &B,
    ctx: &BackendRequestContext,
    tab_id: &str,
    backend_node_id: i64,
    viewport: Rect,
) -> Result<Option<(f64, f64)>> {
    let result = match backend
        .execute_dom_cdp(
            ctx,
            tab_id,
            "DOM.getBoxModel",
            json!({ "backendNodeId": backend_node_id }),
        )
        .await
    {
        Ok(result) => result,
        Err(_) => return Ok(None),
    };
    Ok(dom_cua::action_point_from_box_model(&result, viewport))
}

async fn box_model_rect<B: DomCuaRuntimeBackend + Sync>(
    backend: &B,
    ctx: &BackendRequestContext,
    tab_id: &str,
    session: Option<&str>,
    backend_node_id: i64,
) -> Result<Option<Rect>> {
    let result = match session {
        Some(session_id) => {
            backend
                .execute_dom_cdp_on_session(
                    ctx,
                    session_id,
                    "DOM.getBoxModel",
                    json!({ "backendNodeId": backend_node_id }),
                )
                .await
        }
        None => {
            backend
                .execute_dom_cdp(
                    ctx,
                    tab_id,
                    "DOM.getBoxModel",
                    json!({ "backendNodeId": backend_node_id }),
                )
                .await
        }
    };
    let result = match result {
        Ok(result) => result,
        Err(_) => return Ok(None),
    };
    Ok(dom_cua::rect_from_box_model(&result))
}

fn copy_modifiers(target: &mut Value, source: &Value) {
    let Some(modifiers) = source.get("modifiers") else {
        return;
    };
    if let Some(object) = target.as_object_mut() {
        object.insert("modifiers".into(), modifiers.clone());
    }
}

fn action_point_result(node_id: Option<&str>, x: f64, y: f64, dispatch: Value) -> Value {
    let mut result = json!({
        "point": {
            "x": x,
            "y": y,
            "coordinateSpace": crate::coordinate_space::VISUAL_VIEWPORT,
        },
        "dispatch": dispatch,
    });
    if let Some(node_id) = node_id
        && let Some(object) = result.as_object_mut()
    {
        object.insert("node_id".into(), json!(node_id));
    }
    result
}

fn required_str<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::Protocol(format!("missing {key}")))
}

fn optional_str<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str)
}

#[cfg(test)]
mod hit_verify_tests {
    use async_trait::async_trait;
    use serde_json::{Value, json};

    use crate::backends::BackendRequestContext;
    use crate::error::Result;

    use super::*;

    #[derive(Default)]
    struct FakeDomCua {
        node_for_location: Value,
        described_target: Value,
        snapshot_ok: bool,
    }

    #[async_trait]
    impl DomCuaRuntimeBackend for FakeDomCua {
        async fn execute_dom_cdp(
            &self,
            _ctx: &BackendRequestContext,
            _tab: &str,
            method: &str,
            _p: Value,
        ) -> Result<Value> {
            match method {
                "DOM.scrollIntoViewIfNeeded" => Ok(Value::Null),
                "Page.getLayoutMetrics" => Ok(
                    json!({ "cssVisualViewport": { "pageX": 0, "pageY": 0, "clientWidth": 100, "clientHeight": 100 } }),
                ),
                "DOM.getContentQuads" => Ok(json!({ "quads": [[10, 10, 30, 10, 30, 30, 10, 30]] })),
                "DOM.getNodeForLocation" => Ok(self.node_for_location.clone()),
                "DOM.describeNode" => Ok(self.described_target.clone()),
                other => panic!("unexpected method {other}"),
            }
        }
        async fn dispatch_coordinate_cua(
            &self,
            _c: &BackendRequestContext,
            _m: &str,
            _p: Value,
        ) -> Result<Value> {
            Ok(Value::Null)
        }
        async fn remember_visible_dom_nodes(
            &self,
            _c: &BackendRequestContext,
            _t: &str,
            _o: Option<&str>,
            _n: &[Value],
        ) {
        }
        async fn validate_visible_dom_node(
            &self,
            _c: &BackendRequestContext,
            _t: &str,
            _o: Option<&str>,
            _n: &str,
        ) -> Result<()> {
            if self.snapshot_ok {
                Ok(())
            } else {
                Err(HostError::Protocol("not in snapshot".into()))
            }
        }
        async fn forget_visible_dom_snapshot(
            &self,
            _c: &BackendRequestContext,
            _t: &str,
            _o: Option<&str>,
        ) {
        }
    }

    fn ctx() -> BackendRequestContext {
        BackendRequestContext {
            session_id: Some("s".into()),
            turn_id: Some("t".into()),
            client_timeout_ms: None,
            trusted_kernel_generation: None,
        }
    }

    #[tokio::test]
    async fn occluder_outside_target_subtree_is_rejected() {
        let backend = FakeDomCua {
            node_for_location: json!({ "backendNodeId": 99 }), // hit = occluder
            described_target: json!({ "node": { "backendNodeId": 7, "children": [] } }),
            snapshot_ok: true,
        };
        let error = node_action_point(&backend, &ctx(), "42", None, "7")
            .await
            .unwrap_err();
        match error {
            HostError::Rpc {
                data: Some(data), ..
            } => assert_eq!(data["resolution"], "occluded"),
            other => panic!("expected occluded rpc error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn hit_on_target_descendant_resolves() {
        let backend = FakeDomCua {
            node_for_location: json!({ "backendNodeId": 8 }), // hit = child of target
            described_target: json!({ "node": { "backendNodeId": 7, "children": [ { "backendNodeId": 8, "children": [] } ] } }),
            snapshot_ok: true,
        };
        let point = node_action_point(&backend, &ctx(), "42", None, "7")
            .await
            .unwrap();
        assert_eq!(point, (20.0, 20.0));
    }
}

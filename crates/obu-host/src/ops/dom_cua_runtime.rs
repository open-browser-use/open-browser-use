//! Shared DOM-CUA runtime over CDP DOM geometry and coordinate CUA input.

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::backends::BackendRequestContext;
use crate::error::{HostError, Result};
use crate::methods;
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
    collect_visible_dom_nodes(backend, ctx, tab_id, root, viewport, &mut nodes).await?;
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
            && let Some(rect) = box_model_rect(backend, ctx, tab_id, backend_node_id).await?
            && rect.width > 0.0
            && rect.height > 0.0
            && rect.intersects(viewport)
            && let Some(entry) = dom_cua::snapshot_entry(node, backend_node_id, rect)
        {
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
        return Ok(point);
    }
    if let Some(point) =
        box_model_action_point(backend, ctx, tab_id, backend_node_id, viewport).await?
    {
        return Ok(point);
    }
    Err(HostError::Protocol(format!(
        "node_outside_viewport_after_scroll: DOM-CUA node {node_id} has no reliable visible action point"
    )))
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
    backend_node_id: i64,
) -> Result<Option<Rect>> {
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
            "coordinateSpace": "visualViewport",
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

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

    /// The OOPIF session owning a snapshot node, or None for a top-level node.
    async fn session_for_visible_dom_node(
        &self,
        _ctx: &BackendRequestContext,
        _tab_id: &str,
        _observation_id: Option<&str>,
        _node_id: &str,
    ) -> Option<String> {
        None
    }

    /// Root-frame content-area offset (x, y) of the OOPIF owning `session_id`,
    /// summed across the frame's `<iframe>` ancestor chain. `Ok(None)` for backends
    /// without OOPIF support. OOPIF `getContentQuads` returns FRAME-LOCAL coords
    /// (empirically — the zero-composition hypothesis is false), so this offset is
    /// added to land a top-level dispatch on the correct pixel.
    async fn oopif_root_offset(
        &self,
        _ctx: &BackendRequestContext,
        _session_id: &str,
    ) -> Result<Option<(f64, f64)>> {
        Ok(None)
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
    let mut total: usize = 0;
    total +=
        collect_visible_dom_nodes(backend, ctx, tab_id, None, root, viewport, &mut nodes).await?;
    // Each OOPIF session is enumerated against the SAME top-level `viewport`. An
    // OOPIF session's box-model is FRAME-LOCAL (branch 4c, confirmed by the
    // site-isolated probe); the reported `bounds` here are therefore frame-local
    // and the viewport intersection is approximate. The click/scroll path composes
    // the frame chain's root offset onto the action POINT in
    // `finalize_node_action_point`, which is what actually lands the dispatch.
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
            total += collect_visible_dom_nodes(
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
    // Honest accounting (mirrors SnapshotTextMeta): `total` = candidates
    // considered (interesting & non-hidden, with a backendNodeId) summed across
    // the top-level + every OOPIF session; `shown` = emitted (also had a positive
    // box-model rect intersecting the viewport); `truncated` iff some candidate
    // was dropped OR an emitted entry's label was clipped. The `hint` points at
    // the open primitives so the agent never treats the list as exhaustive.
    let shown = nodes.len();
    let text_clipped = nodes.iter().any(|node| {
        node.get("text_truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    });
    let truncated = shown < total || text_clipped;
    if let Some(object) = response.as_object_mut() {
        let mut meta = serde_json::Map::new();
        meta.insert("shown".into(), json!(shown));
        meta.insert("total".into(), json!(total));
        meta.insert("truncated".into(), json!(truncated));
        if truncated {
            meta.insert(
                "hint".into(),
                json!(
                    "Some interesting elements are off-screen/zero-area or their labels were clipped at 240 chars. Scroll the page, or read full-fidelity content with tab.evaluate(...) or tab.domSnapshot()."
                ),
            );
        }
        object.insert("meta".into(), Value::Object(meta));
    }
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
    session: Option<&str>,
    node: &Value,
    viewport: Rect,
    nodes: &mut Vec<Value>,
) -> Result<usize> {
    // Pass 1 (pure, no RTT): walk the pierced tree, collecting interesting
    // candidates in walk/pop order. `attrs`/`tag` are computed once per node and
    // carried so the predicates and `snapshot_entry_with` never recompute them.
    struct Candidate<'a> {
        node: &'a Value,
        backend_node_id: i64,
        tag: String,
        attrs: Value,
    }
    let mut candidates: Vec<Candidate<'_>> = Vec::new();
    let mut stack = vec![node];
    while let Some(node) = stack.pop() {
        let tag = dom_cua::node_tag(node);
        let attrs = dom_cua::attributes_object(node);
        if dom_cua::is_hidden_subtree_with(node, &tag, &attrs) {
            continue;
        }
        if dom_cua::is_interesting_node_with(&tag, &attrs)
            && let Some(backend_node_id) = node.get("backendNodeId").and_then(Value::as_i64)
        {
            candidates.push(Candidate {
                node,
                backend_node_id,
                tag,
                attrs,
            });
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

    // Pass 2: fetch all box models concurrently (CDP multiplexes by id; the
    // `session` is fixed for this call so all fetches route to one session).
    let rects = futures_util::future::join_all(
        candidates
            .iter()
            .map(|c| box_model_rect(backend, ctx, tab_id, session, c.backend_node_id)),
    )
    .await;

    // Pass 3: emit survivors in walk order (output byte-identical to the
    // sequential walk).
    for (candidate, rect) in candidates.iter().zip(rects) {
        if let Some(rect) = rect?
            && rect.width > 0.0
            && rect.height > 0.0
            && rect.intersects(viewport)
            && let Some(mut entry) = dom_cua::snapshot_entry_with(
                candidate.node,
                candidate.backend_node_id,
                rect,
                &candidate.tag,
                &candidate.attrs,
            )
        {
            // Tag OOPIF nodes with their owning session so geometry routes there;
            // top-level nodes stay untagged (session_for_node -> None).
            // NOTE: assumes backendNodeId is unique across the top-level + OOPIF
            // sessions of a tab (Chromium assigns them in the browser process); the
            // site-isolated probe (tests/oopif_e2e.rs) validates this end-to-end.
            if let (Some(sid), Some(object)) = (session, entry.as_object_mut()) {
                object.insert("session_id".into(), json!(sid));
            }
            nodes.push(entry);
        }
    }
    // The count of interesting & non-hidden candidates considered for this
    // session's subtree (had a backendNodeId), regardless of whether their
    // box-model rect intersected the viewport — this is the honest `total`.
    Ok(candidates.len())
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
    let session = backend
        .session_for_visible_dom_node(ctx, tab_id, observation_id, node_id)
        .await;
    let session = session.as_deref();
    let _ = dom_cdp_routed(
        backend,
        ctx,
        tab_id,
        session,
        "DOM.scrollIntoViewIfNeeded",
        json!({ "backendNodeId": backend_node_id }),
    )
    .await;
    let viewport = viewport_rect(backend, ctx, tab_id).await?;
    if let Some(point) =
        content_quad_action_point(backend, ctx, tab_id, session, backend_node_id, viewport).await?
    {
        return finalize_node_action_point(backend, ctx, tab_id, session, backend_node_id, point)
            .await;
    }
    if let Some(point) =
        box_model_action_point(backend, ctx, tab_id, session, backend_node_id, viewport).await?
    {
        return finalize_node_action_point(backend, ctx, tab_id, session, backend_node_id, point)
            .await;
    }
    Err(HostError::Protocol(format!(
        "node_outside_viewport_after_scroll: DOM-CUA node {node_id} has no reliable visible action point"
    )))
}

/// Top-level nodes get Plan A's occlusion hit-verify; OOPIF nodes (session is
/// Some) trust their owning-session quad geometry — `verify_action_point` runs
/// the hit-test on the TOP-LEVEL session, which cannot resolve an OOPIF
/// `backendNodeId`. OOPIF `getContentQuads` returns FRAME-LOCAL coords (branch
/// 4c, confirmed by the site-isolated probe), so the frame chain's root offset
/// is added before returning.
async fn finalize_node_action_point<B: DomCuaRuntimeBackend + Sync>(
    backend: &B,
    ctx: &BackendRequestContext,
    tab_id: &str,
    session: Option<&str>,
    backend_node_id: i64,
    point: (f64, f64),
) -> Result<(f64, f64)> {
    if let Some(session_id) = session {
        // OOPIF point is frame-local (getContentQuads on the OOPIF session returns
        // frame-local coords — branch 4c, confirmed by the site-isolated probe).
        // Add the frame chain's root offset so the top-level dispatch lands on the
        // right pixel. Skip the top-level occlusion verify (it can't resolve an
        // OOPIF backendNodeId).
        let composed = match backend.oopif_root_offset(ctx, session_id).await? {
            Some((ox, oy)) => (point.0 + ox, point.1 + oy),
            None => point,
        };
        return Ok(composed);
    }
    verify_action_point(backend, ctx, tab_id, backend_node_id, point.0, point.1)
        .await?
        .into_point()
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

/// Run a DOM CDP command on a node's owning session: the OOPIF session when
/// `session` is `Some`, otherwise the tab's top-level session.
async fn dom_cdp_routed<B: DomCuaRuntimeBackend + Sync>(
    backend: &B,
    ctx: &BackendRequestContext,
    tab_id: &str,
    session: Option<&str>,
    method: &str,
    params: Value,
) -> Result<Value> {
    match session {
        Some(session_id) => {
            backend
                .execute_dom_cdp_on_session(ctx, session_id, method, params)
                .await
        }
        None => backend.execute_dom_cdp(ctx, tab_id, method, params).await,
    }
}

// Branch 4c (empirical, site-isolated probe): an OOPIF session's quads/box-model
// are FRAME-LOCAL, not root-composed. This helper returns the frame-local point
// at scale 1 (the `action_point_from_*` math subtracts the top-level
// visual-viewport origin); `finalize_node_action_point` then ADDS the frame
// chain's root offset (`oopif_root_offset`) to land the top-level dispatch.
async fn content_quad_action_point<B: DomCuaRuntimeBackend + Sync>(
    backend: &B,
    ctx: &BackendRequestContext,
    tab_id: &str,
    session: Option<&str>,
    backend_node_id: i64,
    viewport: Rect,
) -> Result<Option<(f64, f64)>> {
    let result = match dom_cdp_routed(
        backend,
        ctx,
        tab_id,
        session,
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
    session: Option<&str>,
    backend_node_id: i64,
    viewport: Rect,
) -> Result<Option<(f64, f64)>> {
    let result = match dom_cdp_routed(
        backend,
        ctx,
        tab_id,
        session,
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
    let result = match dom_cdp_routed(
        backend,
        ctx,
        tab_id,
        session,
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
mod hoist_tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use async_trait::async_trait;
    use serde_json::{Value, json};

    use crate::backends::BackendRequestContext;
    use crate::error::Result;

    use super::*;

    #[derive(Default)]
    struct CountingBackend {
        box_model_calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl DomCuaRuntimeBackend for CountingBackend {
        async fn execute_dom_cdp(
            &self,
            _c: &BackendRequestContext,
            _t: &str,
            method: &str,
            _p: Value,
        ) -> Result<Value> {
            if method == "DOM.getBoxModel" {
                self.box_model_calls.fetch_add(1, Ordering::SeqCst);
                // 10x10 box at origin, inside the 100x100 viewport.
                return Ok(json!({ "model": { "content": [0, 0, 10, 0, 10, 10, 0, 10] } }));
            }
            Ok(json!({}))
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
            Ok(())
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
    async fn box_model_rtt_skipped_for_uninteresting_nodes() {
        let backend = CountingBackend::default();
        let calls = backend.box_model_calls.clone();
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };
        // Root <div> (uninteresting) wrapping one <button> (interesting) + one <span> (uninteresting).
        let root = json!({
            "nodeName": "DIV", "backendNodeId": 1,
            "children": [
                { "nodeName": "BUTTON", "backendNodeId": 2, "attributes": ["aria-label", "Go"] },
                { "nodeName": "SPAN", "backendNodeId": 3, "children": [{ "nodeName": "#text", "nodeValue": "x" }] }
            ]
        });
        let mut nodes = Vec::new();
        collect_visible_dom_nodes(&backend, &ctx(), "tab", None, &root, viewport, &mut nodes)
            .await
            .unwrap();
        // Exactly the one interesting node emitted, and exactly one box-model RTT.
        assert_eq!(nodes.len(), 1, "only the <button> is emitted");
        assert_eq!(nodes[0]["node_id"], "2");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "box-model fetched only for the interesting node"
        );
    }

    struct ConcurrentBoxModel {
        barrier: Arc<tokio::sync::Barrier>,
    }
    #[async_trait]
    impl DomCuaRuntimeBackend for ConcurrentBoxModel {
        async fn execute_dom_cdp(
            &self,
            _c: &BackendRequestContext,
            _t: &str,
            method: &str,
            p: Value,
        ) -> Result<Value> {
            if method == "DOM.getBoxModel" {
                // Each interesting node's fetch must be in-flight simultaneously:
                // a sequential implementation never reaches the 3rd before the 1st
                // returns, so this barrier (n=3) only releases under concurrency.
                self.barrier.wait().await;
                let id = p.get("backendNodeId").and_then(Value::as_i64).unwrap_or(0) as f64;
                // Distinct in-viewport boxes so all three pass and order is checkable.
                return Ok(
                    json!({ "model": { "content": [id, id, id + 5.0, id, id + 5.0, id + 5.0, id, id + 5.0] } }),
                );
            }
            Ok(json!({}))
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
            Ok(())
        }
        async fn forget_visible_dom_snapshot(
            &self,
            _c: &BackendRequestContext,
            _t: &str,
            _o: Option<&str>,
        ) {
        }
    }

    #[tokio::test]
    async fn candidates_fetched_concurrently_and_emitted_in_walk_order() {
        let backend = ConcurrentBoxModel {
            barrier: Arc::new(tokio::sync::Barrier::new(3)),
        };
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 1000.0,
            height: 1000.0,
        };
        // Three interesting buttons; walk/pop order is 2,3,4 (children pushed reversed).
        let root = json!({
            "nodeName": "DIV", "backendNodeId": 1,
            "children": [
                { "nodeName": "BUTTON", "backendNodeId": 2, "attributes": ["aria-label", "a"] },
                { "nodeName": "BUTTON", "backendNodeId": 3, "attributes": ["aria-label", "b"] },
                { "nodeName": "BUTTON", "backendNodeId": 4, "attributes": ["aria-label", "c"] }
            ]
        });
        let mut nodes = Vec::new();
        // Times out (barrier never trips) if fetches are sequential.
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            collect_visible_dom_nodes(&backend, &ctx(), "tab", None, &root, viewport, &mut nodes),
        )
        .await
        .expect("must not deadlock — fetches run concurrently")
        .unwrap();
        let ids: Vec<&str> = nodes
            .iter()
            .map(|n| n["node_id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["2", "3", "4"], "emitted in walk order");
    }

    // Returns a document with two interesting <button>s; box-model for id 2 is in
    // the 100x100 viewport, id 3 is off-screen (x=5000) so it is a considered
    // candidate dropped by the viewport filter => shown=1, total=2.
    struct MetaBackend;
    #[async_trait]
    impl DomCuaRuntimeBackend for MetaBackend {
        async fn execute_dom_cdp(
            &self,
            _c: &BackendRequestContext,
            _t: &str,
            method: &str,
            p: Value,
        ) -> Result<Value> {
            match method {
                "Page.getLayoutMetrics" => Ok(json!({
                    "cssVisualViewport": { "pageX": 0, "pageY": 0, "clientWidth": 100, "clientHeight": 100 }
                })),
                "DOM.getDocument" => Ok(json!({
                    "root": {
                        "nodeName": "DIV", "backendNodeId": 1,
                        "children": [
                            { "nodeName": "BUTTON", "backendNodeId": 2, "attributes": ["aria-label", "in"] },
                            { "nodeName": "BUTTON", "backendNodeId": 3, "attributes": ["aria-label", "off"] }
                        ]
                    }
                })),
                "DOM.getBoxModel" => {
                    let id = p.get("backendNodeId").and_then(Value::as_i64).unwrap_or(0);
                    let x = if id == 2 { 0.0 } else { 5000.0 };
                    Ok(json!({ "model": { "content": [x, 0, x + 10.0, 0, x + 10.0, 10, x, 10] } }))
                }
                _ => Ok(json!({})),
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
            Ok(())
        }
        async fn forget_visible_dom_snapshot(
            &self,
            _c: &BackendRequestContext,
            _t: &str,
            _o: Option<&str>,
        ) {
        }
    }

    #[tokio::test]
    async fn visible_dom_meta_counts_candidates_shown_and_total() {
        // One in-viewport <button> (emitted) + one off-viewport <button> (a
        // candidate that is dropped by the viewport filter) => shown=1, total=2.
        let backend = MetaBackend;
        let params = json!({ "tab_id": "tab", "observation_id": "obs" });
        let response = visible_dom(&backend, &ctx(), params).await.unwrap();
        assert_eq!(response["meta"]["shown"], json!(1));
        assert_eq!(response["meta"]["total"], json!(2));
        assert_eq!(response["meta"]["truncated"], json!(true));
        assert!(
            response["meta"]["hint"]
                .as_str()
                .unwrap()
                .contains("evaluate")
        );
        // Backward-compatible: nodes still present and addressable.
        assert_eq!(response["nodes"].as_array().unwrap().len(), 1);
    }
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

#[cfg(test)]
mod oopif_routing_tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use serde_json::{Value, json};

    use crate::backends::BackendRequestContext;
    use crate::error::Result;

    use super::*;

    #[derive(Default)]
    struct FakeDomCuaRouting {
        calls: Mutex<Vec<(String, String)>>, // (session_id or "TOP", method)
    }

    #[async_trait]
    impl DomCuaRuntimeBackend for FakeDomCuaRouting {
        async fn execute_dom_cdp(
            &self,
            _c: &BackendRequestContext,
            _t: &str,
            method: &str,
            _p: Value,
        ) -> Result<Value> {
            self.calls
                .lock()
                .unwrap()
                .push(("TOP".into(), method.into()));
            match method {
                "Page.getLayoutMetrics" => Ok(
                    json!({ "cssVisualViewport": { "pageX": 0, "pageY": 0, "clientWidth": 100, "clientHeight": 100 } }),
                ),
                "DOM.scrollIntoViewIfNeeded" => Ok(Value::Null),
                // If the OOPIF verify-skip regressed, verify_action_point would run
                // HERE on the top-level session: a non-matching hit (999) + a subtree
                // that lacks it makes verify return Occluded -> node_action_point Err.
                "DOM.getNodeForLocation" => Ok(json!({ "backendNodeId": 999 })),
                "DOM.describeNode" => Ok(json!({ "node": { "backendNodeId": 8, "children": [] } })),
                _ => Ok(json!({})),
            }
        }
        async fn execute_dom_cdp_on_session(
            &self,
            _c: &BackendRequestContext,
            session_id: &str,
            method: &str,
            _p: Value,
        ) -> Result<Value> {
            self.calls
                .lock()
                .unwrap()
                .push((session_id.into(), method.into()));
            match method {
                "DOM.getContentQuads" => Ok(json!({ "quads": [[10, 10, 30, 10, 30, 30, 10, 30]] })),
                "DOM.getNodeForLocation" => Ok(json!({ "backendNodeId": 8 })),
                "DOM.describeNode" => Ok(json!({ "node": { "backendNodeId": 8, "children": [] } })),
                _ => Ok(json!({})),
            }
        }
        async fn oopif_sessions_for_tab(&self, _t: &str) -> Vec<String> {
            vec!["OOPIF-A".into()]
        }
        async fn session_for_visible_dom_node(
            &self,
            _c: &BackendRequestContext,
            _t: &str,
            _o: Option<&str>,
            _n: &str,
        ) -> Option<String> {
            Some("OOPIF-A".into())
        }
        async fn oopif_root_offset(
            &self,
            _c: &BackendRequestContext,
            _session_id: &str,
        ) -> Result<Option<(f64, f64)>> {
            Ok(Some((30.0, 60.0)))
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
            Ok(())
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
    async fn oopif_node_geometry_routes_to_owning_session() {
        let backend = FakeDomCuaRouting::default();
        let point = node_action_point(&backend, &ctx(), "42", Some("obs"), "8")
            .await
            .unwrap();
        // Frame-local center (20,20) composed with the frame chain's root offset
        // (30,60) -> (50,80). Branch 4c: getContentQuads on the OOPIF session is
        // frame-local, so finalize adds oopif_root_offset.
        assert_eq!(point, (50.0, 80.0));
        let calls = backend.calls.lock().unwrap();
        assert!(
            calls
                .iter()
                .any(|(s, m)| s == "OOPIF-A" && m == "DOM.getContentQuads"),
            "getContentQuads must route to the OOPIF session, got {calls:?}"
        );
        // OOPIF nodes skip the top-level occlusion verify (it can't resolve an OOPIF
        // backendNodeId). If the skip regressed, the top-level getNodeForLocation
        // (999 + non-containing subtree) would occlude and the unwrap() above panics.
        assert!(
            !calls
                .iter()
                .any(|(s, m)| s == "TOP" && m == "DOM.getNodeForLocation"),
            "OOPIF nodes must skip the top-level occlusion verify, got {calls:?}"
        );
    }

    #[tokio::test]
    async fn oopif_node_point_is_composed_with_frame_offset() {
        // Frame-local center (20,20) from the OOPIF getContentQuads quad plus the
        // frame chain's root offset (30,60) yields the root-frame point (50,80).
        let backend = FakeDomCuaRouting::default();
        let point = node_action_point(&backend, &ctx(), "42", Some("obs"), "8")
            .await
            .unwrap();
        assert_eq!(point, (50.0, 80.0));
    }
}

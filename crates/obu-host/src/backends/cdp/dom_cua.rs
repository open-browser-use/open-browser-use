//! CDP adapter for the shared DOM-CUA runtime.

use serde_json::{Value, json};

use crate::backends::cdp::CdpBackend;
use crate::backends::{BackendRequestContext, BrowserBackend};
use crate::error::{HostError, Result};
use crate::ops::dom_cua;
use crate::ops::dom_cua_runtime::{self, DomCuaRuntimeBackend};
use crate::tab_state::TabId;

/// Dispatch a DOM-CUA command through CDP DOM geometry plus coordinate CUA input.
pub async fn run(
    backend: &CdpBackend,
    ctx: &BackendRequestContext,
    method: &str,
    params: Value,
) -> Result<Value> {
    dom_cua_runtime::run(backend, ctx, method, params).await
}

#[async_trait::async_trait]
impl DomCuaRuntimeBackend for CdpBackend {
    async fn execute_dom_cdp(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        self.execute_cdp_with_context(ctx, tab_id, method, params)
            .await
    }

    async fn dispatch_coordinate_cua(
        &self,
        _ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        super::cua::run(self, method, params).await
    }

    async fn remember_visible_dom_nodes(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        observation_id: Option<&str>,
        nodes: &[Value],
    ) {
        self.visible_dom_nodes
            .lock()
            .await
            .remember(ctx, tab_id, observation_id, nodes);
    }

    async fn validate_visible_dom_node(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        observation_id: Option<&str>,
        node_id: &str,
    ) -> Result<()> {
        self.visible_dom_nodes
            .lock()
            .await
            .validate_node(ctx, tab_id, observation_id, node_id)
    }

    async fn forget_visible_dom_snapshot(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        observation_id: Option<&str>,
    ) {
        self.visible_dom_nodes
            .lock()
            .await
            .forget_snapshot(ctx, tab_id, observation_id);
    }

    async fn oopif_sessions_for_tab(&self, tab_id: &str) -> Vec<String> {
        let Ok(Some(record)) = self.registry().get(&TabId::new(tab_id)) else {
            return Vec::new();
        };
        let Some(top_level) = record.cdp_session_id else {
            return Vec::new();
        };
        self.oopif_sessions()
            .lock()
            .await
            .sessions_for_tab(&top_level)
    }

    async fn execute_dom_cdp_on_session(
        &self,
        _ctx: &BackendRequestContext,
        session_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        self.transport()
            .send_command(method, params, Some(session_id))
            .await
            .map_err(HostError::from)
    }

    async fn session_for_visible_dom_node(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        observation_id: Option<&str>,
        node_id: &str,
    ) -> Option<String> {
        self.visible_dom_nodes
            .lock()
            .await
            .session_for_node(ctx, tab_id, observation_id, node_id)
    }

    async fn oopif_root_offset(
        &self,
        _ctx: &BackendRequestContext,
        session_id: &str,
    ) -> Result<Option<(f64, f64)>> {
        let mut offset = (0.0_f64, 0.0_f64);
        let mut current = session_id.to_string();
        for _ in 0..super::oopif::MAX_FRAME_DEPTH {
            let frame_and_parent = self
                .oopif_sessions()
                .lock()
                .await
                .frame_and_parent(&current);
            let Some((frame_id, Some(parent_session))) = frame_and_parent else {
                break;
            };
            let owner = self
                .transport()
                .send_command(
                    "DOM.getFrameOwner",
                    json!({ "frameId": frame_id }),
                    Some(&parent_session),
                )
                .await
                .map_err(HostError::from)?;
            let Some(backend_node_id) = owner.get("backendNodeId").and_then(Value::as_i64) else {
                break;
            };
            let box_model = self
                .transport()
                .send_command(
                    "DOM.getBoxModel",
                    json!({ "backendNodeId": backend_node_id }),
                    Some(&parent_session),
                )
                .await
                .map_err(HostError::from)?;
            if let Some(rect) = dom_cua::rect_from_box_model(&box_model) {
                offset.0 += rect.x;
                offset.1 += rect.y;
            }
            current = parent_session; // walk up; a non-OOPIF parent → frame_and_parent None → break
        }
        Ok(Some(offset))
    }
}

//! CDP browser backend skeleton.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::backends::{BackendKind, BackendRequestContext, BrowserBackend};
use crate::error::{HostError, Result};
use crate::ops::dialogs::DialogTraceStore;
use crate::service_registry::ServiceRegistry;

pub mod attach;
pub mod compose;
pub mod cua;
pub(crate) mod dialogs;
pub mod discovery;
pub mod ensure_injected;
pub mod error;
pub mod execute;
pub mod injected_script;
pub mod playwright;
pub mod targets;
pub mod transport;

/// Browser backend backed by the Chrome DevTools Protocol.
pub struct CdpBackend {
    transport: Arc<transport::CdpTransport>,
    registry: Arc<ServiceRegistry>,
    dialog_traces: DialogTraceStore,
    download_dir: tempfile::TempDir,
}

impl CdpBackend {
    /// Connect to a CDP browser endpoint.
    pub async fn connect(url: &str, registry: Arc<ServiceRegistry>) -> Result<Self> {
        injected_script::verify_pinned_hash().map_err(HostError::Protocol)?;
        let ws_url = discovery::resolve_browser_ws(url).await?;
        let transport = transport::CdpTransport::connect(&ws_url)
            .await
            .map_err(HostError::from)?;
        let download_dir = tempfile::tempdir()
            .map_err(|error| HostError::Protocol(format!("create download dir: {error}")))?;
        transport
            .send_command(
                "Browser.setDownloadBehavior",
                serde_json::json!({
                    "behavior": "allow",
                    "downloadPath": download_dir.path().to_string_lossy(),
                    "eventsEnabled": true,
                }),
                None,
            )
            .await
            .map_err(HostError::from)?;
        Ok(Self {
            transport,
            registry,
            dialog_traces: DialogTraceStore::default(),
            download_dir,
        })
    }

    /// Shared service registry.
    pub fn registry(&self) -> &Arc<ServiceRegistry> {
        &self.registry
    }

    /// CDP transport.
    pub fn transport(&self) -> &Arc<transport::CdpTransport> {
        &self.transport
    }

    /// Per-session download directory.
    pub fn download_dir(&self) -> &std::path::Path {
        self.download_dir.path()
    }

    /// Recent handled native-dialog traces.
    pub(crate) fn dialog_traces(&self) -> &DialogTraceStore {
        &self.dialog_traces
    }
}

#[async_trait]
impl BrowserBackend for CdpBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Cdp
    }

    fn id(&self) -> &str {
        "cdp"
    }

    fn diagnostics(&self) -> Value {
        json!({
            "lifecycle": registry_lifecycle_metadata(self.registry()),
            "dialogs": self.dialog_traces().diagnostics(),
        })
    }

    fn clear_lifecycle_diagnostics(&self) -> Result<Value> {
        let cleared = self.registry().clear_stale_diagnostics()?;
        Ok(json!({
            "cleared": {
                "stale_sessions": cleared.stale_sessions,
                "stale_tabs": cleared.stale_tabs,
                "stale_file_choosers": cleared.stale_file_choosers,
                "stale_downloads": cleared.stale_downloads,
            },
            "diagnostics": {
                "lifecycle": registry_lifecycle_metadata(self.registry()),
                "dialogs": self.dialog_traces().diagnostics(),
            },
        }))
    }

    async fn ping(&self) -> Result<&'static str> {
        self.transport
            .send_command(
                "Target.getBrowserContexts",
                Value::Object(Default::default()),
                None,
            )
            .await
            .map_err(HostError::from)?;
        Ok("pong")
    }

    async fn attach(&self, tab_id: &str) -> Result<()> {
        attach::attach(self, tab_id).await
    }

    async fn attach_with_context(&self, ctx: &BackendRequestContext, tab_id: &str) -> Result<()> {
        if let Some(session_id) = ctx.session_id.as_deref() {
            if let Some(record) = self.registry().get(&crate::tab_state::TabId::new(tab_id))?
                && let Some(owner) = record.session_id.as_deref()
                && owner != session_id
            {
                return Err(HostError::Protocol(format!(
                    "tab {tab_id} is already owned by another open-browser-use session"
                )));
            }
            self.registry()
                .touch_session(session_id, ctx.turn_id.as_deref())?;
            self.registry()
                .update(&crate::tab_state::TabId::new(tab_id), |record| {
                    if record.session_id.is_none() {
                        record.session_id = Some(session_id.to_string());
                        record.origin = crate::tab_state::TabOrigin::User;
                    }
                })?;
        }
        attach::attach(self, tab_id).await
    }

    async fn detach(&self, tab_id: &str) -> Result<()> {
        attach::detach(self, tab_id).await
    }

    async fn detach_with_context(&self, ctx: &BackendRequestContext, tab_id: &str) -> Result<()> {
        if let Some(session_id) = ctx.session_id.as_deref() {
            self.registry()
                .touch_session(session_id, ctx.turn_id.as_deref())?;
        }
        attach::detach(self, tab_id).await
    }

    async fn execute_cdp(&self, tab_id: &str, method: &str, params: Value) -> Result<Value> {
        execute::execute_cdp(self, tab_id, method, params).await
    }

    async fn execute_cdp_with_context(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        if let Some(session_id) = ctx.session_id.as_deref() {
            self.registry()
                .set_active_tab(session_id, tab_id, ctx.turn_id.as_deref())?;
        }
        self.execute_cdp(tab_id, method, params).await
    }

    async fn create_tab(&self, url: Option<String>) -> Result<Value> {
        targets::create_tab(self, url).await
    }

    async fn create_tab_with_context(
        &self,
        ctx: &BackendRequestContext,
        url: Option<String>,
    ) -> Result<Value> {
        let created = targets::create_tab(self, url).await?;
        if let Some(session_id) = ctx.session_id.as_deref() {
            self.registry()
                .touch_session(session_id, ctx.turn_id.as_deref())?;
            if let Some(tab_id) = created.get("tab_id").and_then(Value::as_str) {
                self.registry()
                    .update(&crate::tab_state::TabId::new(tab_id), |record| {
                        record.session_id = Some(session_id.to_string());
                    })?;
                self.registry()
                    .set_active_tab(session_id, tab_id, ctx.turn_id.as_deref())?;
            }
        }
        Ok(created)
    }

    async fn list_tabs(&self) -> Result<Value> {
        targets::list_tabs(self).await
    }

    async fn list_tabs_with_context(&self, ctx: &BackendRequestContext) -> Result<Value> {
        if let Some(session_id) = ctx.session_id.as_deref() {
            self.registry()
                .touch_session(session_id, ctx.turn_id.as_deref())?;
        }
        targets::list_tabs(self).await
    }

    async fn current_tab_with_context(&self, ctx: &BackendRequestContext) -> Result<Value> {
        targets::current_tab(self, ctx).await
    }

    async fn selected_tab_with_context(&self, ctx: &BackendRequestContext) -> Result<Value> {
        targets::selected_tab(self, ctx).await
    }

    async fn claim_user_tab_with_context(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
    ) -> Result<Value> {
        targets::claim_user_tab(self, ctx, tab_id).await
    }

    async fn finalize_tabs_with_context(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        targets::finalize_tabs(self, ctx, params).await
    }

    async fn name_session_with_context(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        if let Some(session_id) = ctx.session_id.as_deref() {
            self.registry()
                .touch_session(session_id, ctx.turn_id.as_deref())?;
            self.registry().name_session(
                session_id,
                params
                    .get("label")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            )?;
        }
        Ok(json!({}))
    }

    async fn turn_ended_with_context(
        &self,
        ctx: &BackendRequestContext,
        _params: Value,
    ) -> Result<Value> {
        if let Some(session_id) = ctx.session_id.as_deref() {
            self.registry()
                .touch_session(session_id, ctx.turn_id.as_deref())?;
        }
        Ok(json!({}))
    }

    async fn yield_control_with_context(
        &self,
        ctx: &BackendRequestContext,
        _params: Value,
    ) -> Result<Value> {
        if let Some(session_id) = ctx.session_id.as_deref() {
            self.registry()
                .touch_session(session_id, ctx.turn_id.as_deref())?;
        }
        Ok(json!({}))
    }

    async fn resume_control_with_context(
        &self,
        ctx: &BackendRequestContext,
        _params: Value,
    ) -> Result<Value> {
        targets::current_tab(self, ctx).await
    }

    async fn tab_command(&self, method: &str, params: Value) -> Result<Value> {
        compose::run_tab_command(self, method, params).await
    }

    async fn tab_command_with_context(
        &self,
        ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        if let Some(session_id) = ctx.session_id.as_deref()
            && let Some(tab_id) = params
                .get("tab_id")
                .or_else(|| params.get("tabId"))
                .and_then(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .or_else(|| value.as_i64().map(|value| value.to_string()))
                })
        {
            self.registry()
                .set_active_tab(session_id, tab_id, ctx.turn_id.as_deref())?;
        }
        self.tab_command(method, params).await
    }

    async fn cua_command(&self, method: &str, params: Value) -> Result<Value> {
        cua::run(self, method, params).await
    }

    async fn cua_command_with_context(
        &self,
        ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        self.remember_tab_param(ctx, &params)?;
        self.cua_command(method, params).await
    }

    async fn playwright_command(&self, method: &str, params: Value) -> Result<Value> {
        playwright::run(self, method, params).await
    }

    async fn playwright_command_with_context(
        &self,
        ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        self.remember_tab_param(ctx, &params)?;
        playwright::run_with_context(self, ctx, method, params).await
    }
}

impl CdpBackend {
    fn remember_tab_param(&self, ctx: &BackendRequestContext, params: &Value) -> Result<()> {
        if let Some(session_id) = ctx.session_id.as_deref()
            && let Some(tab_id) = params
                .get("tab_id")
                .or_else(|| params.get("tabId"))
                .and_then(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .or_else(|| value.as_i64().map(|value| value.to_string()))
                })
        {
            self.registry()
                .set_active_tab(session_id, tab_id, ctx.turn_id.as_deref())?;
        }
        Ok(())
    }
}

fn registry_lifecycle_metadata(registry: &ServiceRegistry) -> Value {
    let counts = match registry.lifecycle_counts() {
        Ok(counts) => counts,
        Err(error) => return json!({ "error": error.to_string() }),
    };
    let stale_session_reasons = match registry.stale_session_summaries(10) {
        Ok(rows) => rows,
        Err(error) => return json!({ "error": error.to_string() }),
    };
    let deliverable_tab_summaries = match registry.deliverable_tab_summaries(10) {
        Ok(rows) => rows,
        Err(error) => return json!({ "error": error.to_string() }),
    };
    json!({
        "sessions": counts.sessions,
        "stale_sessions": counts.stale_sessions,
        "stale_session_reasons": stale_session_reasons,
        "tabs": counts.tabs,
        "deliverable_tabs": counts.deliverable_tabs,
        "deliverable_tab_summaries": deliverable_tab_summaries,
        "stale_tabs": counts.stale_tabs,
        "file_choosers": counts.file_choosers,
        "downloads": counts.downloads,
        "stale_file_choosers": counts.stale_file_choosers,
        "stale_downloads": counts.stale_downloads,
    })
}

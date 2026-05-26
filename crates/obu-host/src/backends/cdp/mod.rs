//! CDP browser backend skeleton.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::backends::{BackendKind, BackendRequestContext, BrowserBackend};
use crate::error::{HostError, Result};
use crate::ops::dialogs::DialogTraceStore;
use crate::ops::dom_cua::VisibleDomSnapshotStore;
use crate::service_registry::ServiceRegistry;

pub mod attach;
pub mod compose;
pub mod cua;
pub(crate) mod dialogs;
pub mod discovery;
pub mod dom_cua;
pub mod ensure_injected;
pub mod error;
pub mod execute;
pub mod injected_script;
pub(crate) mod oopif;
pub mod playwright;
pub mod targets;
pub mod transport;

/// Browser backend backed by the Chrome DevTools Protocol.
pub struct CdpBackend {
    transport: Arc<transport::CdpTransport>,
    registry: Arc<ServiceRegistry>,
    dialog_traces: DialogTraceStore,
    download_dir: tempfile::TempDir,
    visible_dom_nodes: Arc<Mutex<VisibleDomSnapshotStore>>,
    oopif_sessions: Arc<Mutex<oopif::OopifSessionMap>>,
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
        let oopif_sessions = Arc::new(Mutex::new(oopif::OopifSessionMap::default()));
        {
            let oopif_sessions = oopif_sessions.clone();
            let consumer_transport = transport.clone();
            let mut events = transport.subscribe_events();
            // OOPIF session consumer. Subscribed here in `connect` — synchronously,
            // before any `attach` arms `Target.setAutoAttach` — so no `attachedToTarget`
            // is missed (a broadcast receiver buffers from its subscribe point). The
            // task holds a strong `transport` clone (needed to send the re-arm command)
            // and is intentionally process-lived: `CdpBackend` lives for the whole
            // process, so the task parks on `recv()` until the bus closes at shutdown.
            // (Breaking this self-pin + resyncing the map on `Lagged` is tracked for the
            // task that makes the map load-bearing.)
            tokio::spawn(async move {
                loop {
                    let event = match events.recv().await {
                        Ok(event) => event,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(dropped)) => {
                            tracing::warn!(
                                dropped,
                                "OOPIF event consumer lagged; session map may be stale"
                            );
                            continue;
                        }
                        Err(_) => break, // bus closed
                    };
                    let changed = oopif_sessions.lock().await.apply_event(&event);
                    if changed
                        && event.method == "Target.attachedToTarget"
                        && let Some(child) = event.params.get("sessionId").and_then(Value::as_str)
                    {
                        // Re-arm auto-attach on the child so nested OOPIFs attach too.
                        if let Err(error) = consumer_transport
                            .send_command(
                                "Target.setAutoAttach",
                                json!({ "autoAttach": true, "flatten": true, "waitForDebuggerOnStart": false }),
                                Some(child),
                            )
                            .await
                        {
                            tracing::debug!(child, ?error, "re-arm setAutoAttach failed (child may have detached)");
                        }
                    }
                }
            });
        }
        Ok(Self {
            transport,
            registry,
            dialog_traces: DialogTraceStore::default(),
            download_dir,
            visible_dom_nodes: Arc::new(Mutex::new(VisibleDomSnapshotStore::default())),
            oopif_sessions,
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

    pub(crate) fn oopif_sessions(&self) -> &Arc<Mutex<oopif::OopifSessionMap>> {
        &self.oopif_sessions
    }

    pub(crate) async fn forget_visible_dom_tab_state(&self, tab_id: &str) {
        self.visible_dom_nodes
            .lock()
            .await
            .forget_tab_for_any_session(tab_id);
        // Prune the tab's OOPIF sessions too. `close_tab` calls this before
        // removing the registry record, so the top-level session is still
        // resolvable here; clearing it bounds the map to live tabs even if a
        // `Target.detachedFromTarget` was dropped or `Lagged`.
        if let Ok(Some(record)) = self.registry().get(&crate::tab_state::TabId::new(tab_id))
            && let Some(top_level) = record.cdp_session_id.as_deref()
        {
            self.oopif_sessions().lock().await.forget_tab(top_level);
        }
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
        let session_id = require_session_turn_context(ctx, "attach")?;
        if let Some(record) = self.registry().get(&crate::tab_state::TabId::new(tab_id))?
            && let Some(owner) = record.session_id.as_deref()
            && owner != session_id
        {
            return Err(HostError::Protocol(format!(
                "tab {tab_id} is already owned by another open-browser-use session"
            )));
        }
        attach::attach(self, tab_id).await?;
        self.registry()
            .touch_session(session_id, ctx.turn_id.as_deref())?;
        self.registry()
            .update(&crate::tab_state::TabId::new(tab_id), |record| {
                if record.session_id.is_none() {
                    record.session_id = Some(session_id.to_string());
                    record.origin = crate::tab_state::TabOrigin::User;
                }
            })?;
        Ok(())
    }

    async fn detach(&self, tab_id: &str) -> Result<()> {
        attach::detach(self, tab_id).await
    }

    async fn detach_with_context(&self, ctx: &BackendRequestContext, tab_id: &str) -> Result<()> {
        let session_id = require_session_turn_context(ctx, "detach")?;
        attach::detach(self, tab_id).await?;
        self.registry()
            .touch_session(session_id, ctx.turn_id.as_deref())?;
        Ok(())
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
        let session_id = require_session_turn_context(ctx, "executeCdp")?;
        self.registry()
            .validate_active_session_tab(session_id, &crate::tab_state::TabId::new(tab_id))?;
        let result = self.execute_cdp(tab_id, method, params).await?;
        self.registry()
            .set_active_tab(session_id, tab_id, ctx.turn_id.as_deref())?;
        Ok(result)
    }

    async fn current_url_for_policy(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
    ) -> Result<String> {
        let session_id = ctx
            .session_id
            .as_deref()
            .ok_or_else(|| HostError::Protocol("current-url policy requires session_id".into()))?;
        let id = crate::tab_state::TabId::new(tab_id);
        self.registry()
            .validate_active_session_tab(session_id, &id)?;
        let record = self
            .registry()
            .get(&id)?
            .ok_or_else(|| HostError::PageClosed(format!("unknown tab {tab_id}")))?;
        let cdp_session_id = record.cdp_session_id.as_deref().ok_or_else(|| {
            HostError::TabNotAttached(format!(
                "tab {tab_id} must already be attached for current-origin policy"
            ))
        })?;
        let result = self
            .transport()
            .send_command(
                "Runtime.evaluate",
                json!({
                    "expression": "location.href",
                    "returnByValue": true,
                }),
                Some(cdp_session_id),
            )
            .await
            .map_err(HostError::from)?;
        result
            .get("result")
            .and_then(|result| result.get("value"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| {
                HostError::Protocol("current-url policy probe missing string URL".into())
            })
    }

    async fn create_tab(&self, _url: Option<String>) -> Result<Value> {
        Err(HostError::Protocol(
            "createTab requires session_id for CDP lifecycle".into(),
        ))
    }

    async fn create_tab_with_context(
        &self,
        ctx: &BackendRequestContext,
        url: Option<String>,
    ) -> Result<Value> {
        let session_id = ctx.session_id.as_deref().ok_or_else(|| {
            HostError::Protocol("createTab requires session_id for CDP lifecycle".into())
        })?;
        if ctx.turn_id.as_deref().unwrap_or_default().is_empty() {
            return Err(HostError::Protocol(
                "createTab requires turn_id for CDP lifecycle".into(),
            ));
        }
        self.registry()
            .touch_session(session_id, ctx.turn_id.as_deref())?;
        let created = targets::create_tab(self, url, session_id).await?;
        if let Some(tab_id) = created.get("tab_id").and_then(Value::as_str) {
            self.registry()
                .set_active_tab(session_id, tab_id, ctx.turn_id.as_deref())?;
        }
        Ok(created)
    }

    async fn list_tabs(&self) -> Result<Value> {
        targets::list_tabs(self).await
    }

    async fn list_tabs_with_context(&self, _ctx: &BackendRequestContext) -> Result<Value> {
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
        let session_id = require_session_turn_context(ctx, "nameSession")?;
        self.registry()
            .touch_session(session_id, ctx.turn_id.as_deref())?;
        self.registry().name_session(
            session_id,
            params
                .get("label")
                .and_then(Value::as_str)
                .map(str::to_string),
        )?;
        Ok(json!({}))
    }

    async fn turn_ended_with_context(
        &self,
        ctx: &BackendRequestContext,
        _params: Value,
    ) -> Result<Value> {
        let session_id = require_session_turn_context(ctx, "turnEnded")?;
        self.registry()
            .reject_human_takeover_if_present(session_id, "turnEnded")?;
        self.registry()
            .touch_session(session_id, ctx.turn_id.as_deref())?;
        Ok(json!({}))
    }

    async fn yield_control_with_context(
        &self,
        ctx: &BackendRequestContext,
        _params: Value,
    ) -> Result<Value> {
        let session_id = require_session_turn_context(ctx, "yieldControl")?;
        self.registry()
            .set_human_takeover(session_id, ctx.turn_id.as_deref(), true)?;
        Ok(json!({}))
    }

    async fn resume_control_with_context(
        &self,
        ctx: &BackendRequestContext,
        _params: Value,
    ) -> Result<Value> {
        let session_id = require_session_turn_context(ctx, "resumeControl")?;
        let result = targets::current_tab(self, ctx).await?;
        self.registry()
            .set_human_takeover(session_id, ctx.turn_id.as_deref(), false)?;
        Ok(result)
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
        require_session_turn_context(ctx, method)?;
        let tab_id = tab_id_param(&params);
        self.validate_active_tab_param(ctx, tab_id.as_deref())?;
        let result = self.tab_command(method, params).await?;
        self.remember_tab_id(ctx, tab_id.as_deref())?;
        Ok(result)
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
        require_session_turn_context(ctx, method)?;
        let tab_id = tab_id_param(&params);
        self.validate_active_tab_param(ctx, tab_id.as_deref())?;
        let result = if method.starts_with("dom_cua_") {
            dom_cua::run(self, ctx, method, params).await?
        } else {
            self.cua_command(method, params).await?
        };
        self.remember_tab_id(ctx, tab_id.as_deref())?;
        Ok(result)
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
        require_session_turn_context(ctx, method)?;
        let tab_id = tab_id_param(&params);
        let handle_owned_operation = matches!(
            method,
            crate::methods::PLAYWRIGHT_FILE_CHOOSER_SET_FILES
                | crate::methods::PLAYWRIGHT_DOWNLOAD_PATH
        );
        if !handle_owned_operation {
            self.validate_active_tab_param(ctx, tab_id.as_deref())?;
        }
        let result = playwright::run_with_context(self, ctx, method, params).await?;
        if !handle_owned_operation {
            self.remember_tab_id(ctx, tab_id.as_deref())?;
        }
        Ok(result)
    }
}

impl CdpBackend {
    fn validate_active_tab_param(
        &self,
        ctx: &BackendRequestContext,
        tab_id: Option<&str>,
    ) -> Result<()> {
        if let Some(tab_id) = tab_id {
            let session_id = require_session_turn_context(ctx, "tab command")?;
            self.registry()
                .validate_active_session_tab(session_id, &crate::tab_state::TabId::new(tab_id))?;
        }
        Ok(())
    }

    fn remember_tab_id(&self, ctx: &BackendRequestContext, tab_id: Option<&str>) -> Result<()> {
        if let Some(session_id) = ctx.session_id.as_deref()
            && let Some(tab_id) = tab_id
        {
            self.registry()
                .set_active_tab(session_id, tab_id, ctx.turn_id.as_deref())?;
        }
        Ok(())
    }
}

fn require_session_turn_context<'a>(
    ctx: &'a BackendRequestContext,
    method: &str,
) -> Result<&'a str> {
    let session_id = ctx.session_id.as_deref().ok_or_else(|| {
        HostError::Protocol(format!("{method} requires session_id for CDP lifecycle"))
    })?;
    if ctx.turn_id.as_deref().unwrap_or_default().is_empty() {
        return Err(HostError::Protocol(format!(
            "{method} requires turn_id for CDP lifecycle"
        )));
    }
    Ok(session_id)
}

fn tab_id_param(params: &Value) -> Option<String> {
    params
        .get("tab_id")
        .or_else(|| params.get("tabId"))
        .and_then(|value| {
            value
                .as_str()
                .map(str::to_string)
                .or_else(|| value.as_i64().map(|value| value.to_string()))
        })
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
    let recent_lifecycle_events = match registry.recent_lifecycle_events(20) {
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
        "recent_events": recent_lifecycle_events,
    })
}

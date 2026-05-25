//! WebExtension/native-messaging browser backend.

mod oopif;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use async_trait::async_trait;
use serde_json::{Map, Value, json};
use tokio::sync::{Mutex, broadcast};

use crate::backends::webext::oopif::WebextOopifSessionMap;
use crate::backends::{BackendKind, BackendRequestContext, BrowserBackend, cdp::ensure_injected};
use crate::error::{HostError, Result};
use crate::methods;
use crate::ops::clipboard as clipboard_ops;
use crate::ops::content_export::{self, ContentExportBackend};
use crate::ops::cua::{
    self as cua_ops, CoordinateCommand, KeyEventSink, MouseEvent, MouseEventSink,
    NavigationWaitOptions, NavigationWaiter,
};
use crate::ops::dialogs::DialogTraceStore;
use crate::ops::dom_cua::{self, VisibleDomSnapshotStore};
use crate::ops::dom_cua_runtime::{self, DomCuaRuntimeBackend};
use crate::ops::event_wait;
use crate::ops::playwright::handles as handle_ops;
use crate::ops::playwright::runtime::{
    self as playwright_runtime, MEDIA_DOWNLOAD_FUNCTION, PlaywrightCommandBackend,
    PlaywrightRuntimeBackend, PlaywrightTextInputBackend,
};
use crate::ops::point::{self, PointCdpBackend};
use crate::ops::tab_navigation::{self, TabNavigationBackend};
use crate::service_registry::ServiceRegistry;
use crate::tab_state::{TabId, TabOrigin, TabRecord, TabStatus};

/// Thin WebExtension backend used by P3's native-messaging vertical slice.
pub struct WebExtensionBackend {
    id: String,
    metadata: Value,
    active: Arc<AtomicBool>,
    transport: Option<Arc<dyn ExtensionTransport>>,
    event_tx: broadcast::Sender<ExtensionNotification>,
    registry: Arc<ServiceRegistry>,
    dialog_traces: DialogTraceStore,
    extension_diagnostics: Arc<StdMutex<Value>>,
    visible_dom_nodes: Arc<Mutex<VisibleDomSnapshotStore>>,
    virtual_clipboard_scripts: Arc<Mutex<HashMap<String, String>>>,
    /// OOPIF (out-of-process iframe) child sessions, populated from the
    /// `Target.attachedToTarget` events the extension forwards as `onCDPEvent`.
    /// A `std` mutex (not `tokio`) because the ingress — `handle_notification` —
    /// is synchronous; readers clone what they need out and drop the guard before
    /// any `.await`, so the lock is never held across a suspension point.
    oopif_sessions: Arc<StdMutex<WebextOopifSessionMap>>,
}

impl WebExtensionBackend {
    /// Construct a backend with the default development metadata.
    pub fn new(id: impl Into<String>, metadata: Value) -> Self {
        let (event_tx, _) = broadcast::channel(1024);
        Self {
            id: id.into(),
            metadata,
            active: Arc::new(AtomicBool::new(true)),
            transport: None,
            event_tx,
            registry: Arc::new(ServiceRegistry::default()),
            dialog_traces: DialogTraceStore::default(),
            extension_diagnostics: Arc::new(StdMutex::new(json!({}))),
            visible_dom_nodes: Arc::new(Mutex::new(VisibleDomSnapshotStore::default())),
            virtual_clipboard_scripts: Arc::new(Mutex::new(HashMap::new())),
            oopif_sessions: Arc::new(StdMutex::new(WebextOopifSessionMap::default())),
        }
    }

    /// Attach an extension RPC transport.
    pub fn with_transport(mut self, transport: Arc<dyn ExtensionTransport>) -> Self {
        self.transport = Some(transport);
        self
    }

    /// Construct the default first-slice backend.
    pub fn dev_chrome(metadata: Value) -> Self {
        Self::new("chrome", metadata)
    }

    /// Mark this backend inactive.
    pub fn stop(&self) {
        self.active.store(false, Ordering::SeqCst);
    }

    fn ensure_active(&self) -> Result<()> {
        if self.active.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(HostError::NoBackendAvailable(
                "webextension backend is inactive".into(),
            ))
        }
    }

    fn require_session_context(ctx: &BackendRequestContext, method: &str) -> Result<()> {
        if ctx.session_id.as_deref().unwrap_or_default().is_empty() {
            return Err(HostError::Protocol(format!(
                "{method} requires session_id for WebExtension backend"
            )));
        }
        if ctx.turn_id.as_deref().unwrap_or_default().is_empty() {
            return Err(HostError::Protocol(format!(
                "{method} requires turn_id for WebExtension backend"
            )));
        }
        Ok(())
    }

    fn transport(&self, method: &str) -> Result<Arc<dyn ExtensionTransport>> {
        self.transport
            .clone()
            .ok_or_else(|| HostError::NotImplemented(method.into()))
    }

    /// Subscribe to extension-originated notifications.
    pub fn subscribe_notifications(&self) -> broadcast::Receiver<ExtensionNotification> {
        self.event_tx.subscribe()
    }

    /// Publish a host-extension notification into the backend event bus.
    pub fn handle_notification(&self, method: impl Into<String>, params: Value) {
        let method = method.into();
        if method == "onExtensionStatus" {
            self.update_extension_diagnostics(params);
            return;
        }
        if !matches!(method.as_str(), "onCDPEvent" | "onDownloadChange") {
            return;
        }
        // OOPIF auto-attach bookkeeping: `Target.attachedToTarget` /
        // `Target.detachedFromTarget` are forwarded as `onCDPEvent` and carry the
        // owning `tabId` in `source`, so the session map keys by tab directly.
        // Applied before the broadcast so the map is current independent of any
        // event subscriber.
        if method == "onCDPEvent"
            && let Ok(mut map) = self.oopif_sessions.lock()
        {
            map.apply_cdp_event(&params);
        }
        let _ = self.event_tx.send(ExtensionNotification { method, params });
    }

    /// Shared per-backend service registry.
    pub fn registry(&self) -> &Arc<ServiceRegistry> {
        &self.registry
    }

    /// OOPIF child-session map, populated from forwarded `attachedToTarget` events.
    pub(crate) fn oopif_sessions(&self) -> &Arc<StdMutex<WebextOopifSessionMap>> {
        &self.oopif_sessions
    }

    /// Recent handled native-dialog traces.
    pub(crate) fn dialog_traces(&self) -> &DialogTraceStore {
        &self.dialog_traces
    }

    fn update_extension_diagnostics(&self, params: Value) {
        if !params.is_object() {
            return;
        }
        if let Ok(mut diagnostics) = self.extension_diagnostics.lock() {
            *diagnostics = params;
        }
    }

    fn extension_diagnostics(&self) -> Value {
        self.extension_diagnostics
            .lock()
            .map(|diagnostics| diagnostics.clone())
            .unwrap_or_else(|_| json!({}))
    }
}

/// Host-side client for extension JSON-RPC methods.
#[async_trait]
pub trait ExtensionTransport: Send + Sync {
    /// Send a request to the extension service worker.
    async fn request(&self, method: &str, params: Value) -> Result<Value>;

    /// Transport-owned lifecycle diagnostics.
    fn diagnostics(&self) -> Value {
        json!({})
    }
}

/// Notification emitted by the extension service worker.
#[derive(Debug, Clone, PartialEq)]
pub struct ExtensionNotification {
    /// Notification method, e.g. `onCDPEvent`.
    pub method: String,
    /// Stable DTO payload.
    pub params: Value,
}

impl Default for WebExtensionBackend {
    fn default() -> Self {
        Self::dev_chrome(json!({}))
    }
}

#[async_trait]
impl BrowserBackend for WebExtensionBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::WebExtension
    }

    fn id(&self) -> &str {
        &self.id
    }

    fn owns_request_deadline(&self, _method: &str) -> bool {
        self.transport.is_some()
    }

    fn metadata(&self) -> Value {
        self.metadata.clone()
    }

    fn diagnostics(&self) -> Value {
        json!({
            "lifecycle": registry_lifecycle_metadata(self.registry()),
            "dialogs": self.dialog_traces().diagnostics(),
            "extension": self.extension_diagnostics(),
            "transport": self.transport
                .as_ref()
                .map(|transport| transport.diagnostics())
                .unwrap_or_else(|| json!({})),
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
                "extension": self.extension_diagnostics(),
                "transport": self.transport
                    .as_ref()
                    .map(|transport| transport.diagnostics())
                    .unwrap_or_else(|| json!({})),
            },
        }))
    }

    async fn ping(&self) -> Result<&'static str> {
        self.ensure_active()?;
        if let Some(transport) = &self.transport {
            let _ = transport.request("ping", json!({})).await?;
        }
        Ok("pong")
    }

    async fn attach_with_context(&self, ctx: &BackendRequestContext, _tab_id: &str) -> Result<()> {
        self.ensure_active()?;
        Self::require_session_context(ctx, "attach")?;
        let parsed_tab_id = parse_tab_id(_tab_id)?;
        let normalized_tab_id = parsed_tab_id.to_string();
        validate_active_tab_if_recorded(self, ctx, &normalized_tab_id)?;
        self.transport("attach")?
            .request(
                "attach",
                json!({
                    "session_id": ctx.session_id.clone(),
                    "turn_id": ctx.turn_id.clone(),
                    "tabId": parsed_tab_id,
                    "timeoutMs": ctx.client_timeout_ms,
                }),
            )
            .await?;
        record_session_context(self, ctx)?;
        self.registry()
            .update(&TabId::new(&normalized_tab_id), |record| {
                record.attached = true;
            })?;
        forget_tab_state(self, ctx, _tab_id).await;
        Ok(())
    }

    async fn detach_with_context(&self, ctx: &BackendRequestContext, _tab_id: &str) -> Result<()> {
        self.ensure_active()?;
        Self::require_session_context(ctx, "detach")?;
        let parsed_tab_id = parse_tab_id(_tab_id)?;
        let normalized_tab_id = parsed_tab_id.to_string();
        validate_active_tab_if_recorded(self, ctx, &normalized_tab_id)?;
        self.transport("detach")?
            .request(
                "detach",
                json!({
                    "session_id": ctx.session_id.clone(),
                    "turn_id": ctx.turn_id.clone(),
                    "tabId": parsed_tab_id,
                    "timeoutMs": ctx.client_timeout_ms,
                }),
            )
            .await?;
        record_session_context(self, ctx)?;
        cleanup_virtual_clipboard_script(self, ctx, _tab_id).await;
        self.registry()
            .update(&TabId::new(&normalized_tab_id), |record| {
                record.attached = false;
            })?;
        self.registry()
            .clear_tab_handles(&TabId::new(&normalized_tab_id))?;
        forget_tab_state(self, ctx, _tab_id).await;
        Ok(())
    }

    async fn execute_cdp_with_context(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        execute_cdp_with_context_options(
            self,
            ctx,
            tab_id,
            method,
            params,
            ExecuteCdpOptions::default(),
        )
        .await
    }

    async fn current_url_for_policy(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
    ) -> Result<String> {
        self.ensure_active()?;
        Self::require_session_context(ctx, "currentUrlForPolicy")?;
        let parsed_tab_id = parse_tab_id(tab_id)?;
        let normalized_tab_id = parsed_tab_id.to_string();
        let session_id = ctx.session_id.as_deref().unwrap_or_default();
        self.registry()
            .validate_active_session_tab(session_id, &TabId::new(&normalized_tab_id))?;
        let response = self
            .transport("getTabUrlForPolicy")?
            .request(
                "getTabUrlForPolicy",
                json!({
                    "session_id": ctx.session_id.clone(),
                    "turn_id": ctx.turn_id.clone(),
                    "tabId": parsed_tab_id,
                    "timeoutMs": ctx.client_timeout_ms,
                }),
            )
            .await?;
        response
            .get("url")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| {
                HostError::Protocol("current-url policy probe missing string URL".into())
            })
    }

    async fn create_tab_with_context(
        &self,
        ctx: &BackendRequestContext,
        url: Option<String>,
    ) -> Result<Value> {
        self.ensure_active()?;
        Self::require_session_context(ctx, "createTab")?;
        record_session_context(self, ctx)?;
        let response = self
            .transport("createTab")?
            .request(
                "createTab",
                json!({
                    "session_id": ctx.session_id.clone(),
                    "turn_id": ctx.turn_id.clone(),
                    "url": url,
                    "timeoutMs": ctx.client_timeout_ms,
                }),
            )
            .await?;
        let normalized = normalize_tab_response(response)?;
        record_webext_tab(self, ctx, &normalized, TabOrigin::Agent, TabStatus::Active)?;
        Ok(normalized)
    }

    async fn list_tabs_with_context(&self, ctx: &BackendRequestContext) -> Result<Value> {
        self.ensure_active()?;
        Self::require_session_context(ctx, "getTabs")?;
        let response = self
            .transport("getTabs")?
            .request(
                "getTabs",
                json!({
                    "session_id": ctx.session_id.clone(),
                    "turn_id": ctx.turn_id.clone(),
                    "timeoutMs": ctx.client_timeout_ms,
                }),
            )
            .await?;
        let normalized = normalize_tabs_response(response)?;
        Ok(normalized)
    }

    async fn current_tab_with_context(&self, ctx: &BackendRequestContext) -> Result<Value> {
        self.ensure_active()?;
        Self::require_session_context(ctx, "getCurrentTab")?;
        let response = self
            .transport("getCurrentTab")?
            .request(
                "getCurrentTab",
                context_payload(ctx, Value::Object(Map::new())),
            )
            .await?;
        let Some(normalized) = normalize_optional_tab_response(response)? else {
            return Ok(Value::Null);
        };
        Ok(normalized)
    }

    async fn selected_tab_with_context(&self, ctx: &BackendRequestContext) -> Result<Value> {
        self.ensure_active()?;
        Self::require_session_context(ctx, "getSelectedTab")?;
        record_session_context(self, ctx)?;
        let response = self
            .transport("getSelectedTab")?
            .request(
                "getSelectedTab",
                context_payload(ctx, Value::Object(Map::new())),
            )
            .await?;
        let Some(normalized) = normalize_optional_tab_response(response)? else {
            return Ok(Value::Null);
        };
        if normalized
            .get("commandable")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            record_webext_tab(self, ctx, &normalized, TabOrigin::Agent, TabStatus::Active)?;
            if let Some(tab_id) = normalized.get("tab_id").and_then(Value::as_str) {
                self.registry().set_active_tab(
                    ctx.session_id.as_deref().unwrap_or_default(),
                    tab_id,
                    ctx.turn_id.as_deref(),
                )?;
            }
        }
        Ok(normalized)
    }

    async fn list_user_tabs_with_context(&self, ctx: &BackendRequestContext) -> Result<Value> {
        self.ensure_active()?;
        Self::require_session_context(ctx, "getUserTabs")?;
        record_session_context(self, ctx)?;
        let response = self
            .transport("getUserTabs")?
            .request(
                "getUserTabs",
                context_payload(ctx, Value::Object(Map::new())),
            )
            .await?;
        normalize_tabs_response(response)
    }

    async fn claim_user_tab_with_context(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
    ) -> Result<Value> {
        self.ensure_active()?;
        Self::require_session_context(ctx, "claimUserTab")?;
        let session_id = ctx.session_id.as_deref().unwrap_or_default();
        let parsed_tab_id = parse_tab_id(tab_id)?;
        let normalized_tab_id = parsed_tab_id.to_string();
        if let Some(record) = self.registry().get(&TabId::new(&normalized_tab_id))?
            && let Some(owner) = record.session_id.as_deref()
            && record.status != TabStatus::Deliverable
            && owner != session_id
        {
            return Err(HostError::Protocol(format!(
                "tab {normalized_tab_id} is already owned by another open-browser-use session"
            )));
        }
        record_session_context(self, ctx)?;
        let response = self
            .transport("claimUserTab")?
            .request(
                "claimUserTab",
                context_payload(
                    ctx,
                    json!({
                        "tabId": parsed_tab_id,
                    }),
                ),
            )
            .await?;
        let mut normalized = normalize_tab_response(response)?;
        if let Some(object) = normalized.as_object_mut() {
            object
                .entry("origin")
                .or_insert_with(|| Value::String("user".into()));
            object.insert("status".into(), Value::String("active".into()));
        }
        record_webext_tab(self, ctx, &normalized, TabOrigin::User, TabStatus::Active)?;
        self.registry().set_active_tab(
            ctx.session_id.as_deref().unwrap_or_default(),
            normalized_tab_id.as_str(),
            ctx.turn_id.as_deref(),
        )?;
        Ok(normalized)
    }

    async fn get_user_history_with_context(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        self.ensure_active()?;
        Self::require_session_context(ctx, "getUserHistory")?;
        record_session_context(self, ctx)?;
        let response = self
            .transport("getUserHistory")?
            .request("getUserHistory", context_payload(ctx, params))
            .await?;
        normalize_items_response(response)
    }

    async fn finalize_tabs_with_context(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        self.ensure_active()?;
        Self::require_session_context(ctx, "finalizeTabs")?;
        self.registry().assert_agent_owns_session(
            ctx.session_id.as_deref().unwrap_or_default(),
            "finalizeTabs",
        )?;
        record_session_context(self, ctx)?;
        let session_tabs = self
            .registry()
            .tabs_for_session(ctx.session_id.as_deref().unwrap_or_default())?;
        let keep_tab_ids = finalize_keep_tab_ids(&params)?;
        let mut preclosed_agent_tab_ids = Vec::new();
        for tab in session_tabs {
            cleanup_virtual_clipboard_script(self, ctx, &tab.id.0).await;
            if tab.origin == TabOrigin::Agent && !keep_tab_ids.contains(&tab.id.0) {
                self.execute_cdp_with_context(ctx, &tab.id.0, "Page.close", json!({}))
                    .await?;
                preclosed_agent_tab_ids.push(tab.id.0);
            }
        }
        let response = self
            .transport("finalizeTabs")?
            .request("finalizeTabs", normalize_finalize_request(ctx, params)?)
            .await?;
        let mut normalized = normalize_finalize_response(response)?;
        include_tab_ids(&mut normalized, "closed_tab_ids", &preclosed_agent_tab_ids)?;
        let terminal_tab_ids =
            collect_finalize_terminal_tab_ids(&normalized, &["closed_tab_ids", "released_tab_ids"]);
        prune_finalized_tab_rows(&mut normalized, &terminal_tab_ids)?;
        for key in ["closed_tab_ids", "released_tab_ids"] {
            let Some(tab_ids) = normalized.get(key).and_then(Value::as_array) else {
                continue;
            };
            for tab_id in tab_ids.iter().filter_map(Value::as_str) {
                forget_tab_state(self, ctx, tab_id).await;
                let _ = self.registry().remove_with_reason(
                    &TabId::new(tab_id),
                    "WebExtension finalizeTabs closed or released the tab",
                )?;
            }
        }
        for key in ["kept_tabs", "deliverable_tabs"] {
            let Some(tabs) = normalized.get(key).and_then(Value::as_array) else {
                continue;
            };
            for tab in tabs {
                if let Some(tab_id) = tab
                    .get("tab_id")
                    .or_else(|| tab.get("id"))
                    .and_then(Value::as_str)
                {
                    self.registry().clear_tab_handles(&TabId::new(tab_id))?;
                    forget_tab_state(self, ctx, tab_id).await;
                }
                record_webext_tab(self, ctx, tab, TabOrigin::Agent, TabStatus::Active)?;
            }
        }
        Ok(normalized)
    }

    async fn name_session_with_context(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        self.ensure_active()?;
        Self::require_session_context(ctx, "nameSession")?;
        record_session_context(self, ctx)?;
        self.registry().name_session(
            ctx.session_id.as_deref().unwrap_or_default(),
            params
                .get("label")
                .and_then(Value::as_str)
                .map(str::to_string),
        )?;
        self.transport("nameSession")?
            .request("nameSession", context_payload(ctx, params))
            .await?;
        Ok(Value::Null)
    }

    async fn turn_ended_with_context(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        self.ensure_active()?;
        Self::require_session_context(ctx, "turnEnded")?;
        self.registry().reject_human_takeover_if_present(
            ctx.session_id.as_deref().unwrap_or_default(),
            "turnEnded",
        )?;
        record_session_context(self, ctx)?;
        self.transport("turnEnded")?
            .request("turnEnded", context_payload(ctx, params))
            .await?;
        Ok(Value::Null)
    }

    async fn yield_control_with_context(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        self.ensure_active()?;
        Self::require_session_context(ctx, "yieldControl")?;
        self.transport("yieldControl")?
            .request("yieldControl", context_payload(ctx, params))
            .await?;
        self.registry().set_human_takeover(
            ctx.session_id.as_deref().unwrap_or_default(),
            ctx.turn_id.as_deref(),
            true,
        )?;
        Ok(Value::Null)
    }

    async fn resume_control_with_context(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        self.ensure_active()?;
        Self::require_session_context(ctx, "resumeControl")?;
        let response = self
            .transport("resumeControl")?
            .request("resumeControl", context_payload(ctx, params))
            .await?;
        let normalized_response = normalize_resume_control_response(response)?;
        let Some(normalized_tab) = resume_control_tab(&normalized_response) else {
            return Ok(normalized_response);
        };
        self.registry().set_human_takeover(
            ctx.session_id.as_deref().unwrap_or_default(),
            ctx.turn_id.as_deref(),
            false,
        )?;
        if let Some(tab_id) = normalized_tab.get("tab_id").and_then(Value::as_str) {
            record_webext_tab(
                self,
                ctx,
                normalized_tab,
                TabOrigin::Agent,
                TabStatus::Active,
            )?;
            self.registry().set_active_tab(
                ctx.session_id.as_deref().unwrap_or_default(),
                tab_id,
                ctx.turn_id.as_deref(),
            )?;
        }
        Ok(normalized_response)
    }

    async fn browser_command_with_context(
        &self,
        ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        self.ensure_active()?;
        Self::require_session_context(ctx, method)?;
        record_session_context(self, ctx)?;
        self.transport(method)?
            .request(method, context_payload(ctx, params))
            .await
    }

    async fn cua_command_with_context(
        &self,
        ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        self.ensure_active()?;
        Self::require_session_context(ctx, method)?;
        let tab_id = params_tab_id(&params);
        validate_active_tab_param_if_recorded(self, ctx, &params)?;
        let result = run_cua_command(self, ctx, method, params).await?;
        if let Some(tab_id) = tab_id {
            set_active_tab_after_success(self, ctx, &tab_id)?;
        } else {
            record_session_context(self, ctx)?;
        }
        Ok(result)
    }

    async fn playwright_command_with_context(
        &self,
        ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        self.ensure_active()?;
        Self::require_session_context(ctx, method)?;
        let tab_id = params_tab_id(&params);
        validate_active_tab_param_if_recorded(self, ctx, &params)?;
        let result = run_playwright_command(self, ctx, method, params).await?;
        if let Some(tab_id) = tab_id {
            set_active_tab_after_success(self, ctx, &tab_id)?;
        } else {
            record_session_context(self, ctx)?;
        }
        Ok(result)
    }

    async fn tab_command_with_context(
        &self,
        ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        self.ensure_active()?;
        Self::require_session_context(ctx, method)?;
        let tab_id = params_tab_id(&params);
        validate_active_tab_param_if_recorded(self, ctx, &params)?;
        let result = run_tab_command(self, ctx, method, params).await?;
        if let Some(tab_id) = tab_id {
            set_active_tab_after_success(self, ctx, &tab_id)?;
        } else {
            record_session_context(self, ctx)?;
        }
        Ok(result)
    }
}

fn record_session_context(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
) -> Result<()> {
    backend.registry().touch_session(
        ctx.session_id.as_deref().unwrap_or_default(),
        ctx.turn_id.as_deref(),
    )
}

fn set_active_tab_after_success(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
) -> Result<()> {
    let Some(record) = backend.registry().get(&TabId::new(tab_id))? else {
        return record_session_context(backend, ctx);
    };
    if record.session_id.as_deref() != ctx.session_id.as_deref()
        || record.status != TabStatus::Active
    {
        return backend.registry().validate_active_session_tab(
            ctx.session_id.as_deref().unwrap_or_default(),
            &TabId::new(tab_id),
        );
    }
    backend.registry().set_active_tab(
        ctx.session_id.as_deref().unwrap_or_default(),
        tab_id,
        ctx.turn_id.as_deref(),
    )
}

async fn execute_cdp_raw_with_context(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    parsed_tab_id: i64,
    method: &str,
    params: Value,
) -> Result<Value> {
    execute_cdp_raw_with_options(
        backend,
        ctx,
        parsed_tab_id,
        method,
        params,
        ExecuteCdpOptions::default(),
    )
    .await
}

#[derive(Clone, Copy, Default)]
struct ExecuteCdpOptions {
    suppress_agent_overlay_for_capture: bool,
}

async fn execute_cdp_with_context_options(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
    method: &str,
    params: Value,
    options: ExecuteCdpOptions,
) -> Result<Value> {
    backend.ensure_active()?;
    WebExtensionBackend::require_session_context(ctx, "executeCdp")?;
    let parsed_tab_id = parse_tab_id(tab_id)?;
    let normalized_tab_id = parsed_tab_id.to_string();
    validate_active_tab_if_recorded(backend, ctx, &normalized_tab_id)?;
    let result = if crate::backends::cdp::dialogs::method_can_open_dialog(method) {
        execute_cdp_with_dialog_policy(
            backend,
            ctx,
            &normalized_tab_id,
            parsed_tab_id,
            method,
            params,
            options,
        )
        .await
    } else {
        execute_cdp_raw_with_options(backend, ctx, parsed_tab_id, method, params, options).await
    }?;
    set_active_tab_after_success(backend, ctx, &normalized_tab_id)?;
    Ok(result)
}

async fn execute_cdp_raw_with_options(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    parsed_tab_id: i64,
    method: &str,
    params: Value,
    options: ExecuteCdpOptions,
) -> Result<Value> {
    let mut request = Map::new();
    request.insert("session_id".into(), json!(ctx.session_id.clone()));
    request.insert("turn_id".into(), json!(ctx.turn_id.clone()));
    request.insert("target".into(), json!({ "tabId": parsed_tab_id }));
    request.insert("method".into(), Value::String(method.to_string()));
    request.insert("commandParams".into(), params);
    request.insert("timeoutMs".into(), json!(ctx.client_timeout_ms));
    if options.suppress_agent_overlay_for_capture {
        request.insert("suppressAgentOverlayForCapture".into(), Value::Bool(true));
    }
    backend
        .transport("executeCdp")?
        .request("executeCdp", Value::Object(request))
        .await
}

/// Execute a CDP command addressed to a specific OOPIF child session.
///
/// WebExtension `executeCdp` is addressed by `{ tabId, sessionId }`: the
/// extension passes that `target` straight to `chrome.debugger.sendCommand`,
/// which routes to the flattened child session. The owning `tabId` is recovered
/// from the OOPIF session map (the shared runtime hands the backend only the
/// child `session_id`). Geometry-only commands never open dialogs, so this skips
/// the dialog-policy loop.
async fn execute_cdp_on_session_with_context(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    cdp_session_id: &str,
    method: &str,
    params: Value,
) -> Result<Value> {
    backend.ensure_active()?;
    WebExtensionBackend::require_session_context(ctx, "executeCdp")?;
    let tab_id = backend
        .oopif_sessions()
        .lock()
        .map_err(|_| HostError::Protocol("OOPIF session map poisoned".into()))?
        .tab_for_session(cdp_session_id)
        .ok_or_else(|| {
            HostError::Protocol(format!(
                "no attached tab owns OOPIF session {cdp_session_id}"
            ))
        })?;
    let mut request = Map::new();
    request.insert("session_id".into(), json!(ctx.session_id.clone()));
    request.insert("turn_id".into(), json!(ctx.turn_id.clone()));
    request.insert(
        "target".into(),
        json!({ "tabId": tab_id, "sessionId": cdp_session_id }),
    );
    request.insert("method".into(), Value::String(method.to_string()));
    request.insert("commandParams".into(), params);
    request.insert("timeoutMs".into(), json!(ctx.client_timeout_ms));
    backend
        .transport("executeCdp")?
        .request("executeCdp", Value::Object(request))
        .await
}

async fn execute_cdp_with_dialog_policy(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
    parsed_tab_id: i64,
    method: &str,
    params: Value,
    options: ExecuteCdpOptions,
) -> Result<Value> {
    let events = backend.subscribe_notifications();
    execute_cdp_raw_with_context(backend, ctx, parsed_tab_id, "Page.enable", json!({})).await?;
    let context = crate::ops::dialogs::DialogContext {
        tab_id: tab_id.to_string(),
        session_id: ctx.session_id.clone(),
        cdp_session_id: None,
        operation_id: None,
        operation: Some(method.to_string()),
    };
    let operation =
        execute_cdp_raw_with_options(backend, ctx, parsed_tab_id, method, params, options);
    crate::ops::dialogs::run_broadcast_dialog_policy_loop(
        &context,
        Some(backend.dialog_traces()),
        operation,
        events,
        "extension",
        |event| {
            let Some(dialog) = matching_webext_dialog_event(&event, ctx, parsed_tab_id) else {
                return None;
            };
            if let Some(action) = extension_handled_dialog_action(&event, &dialog) {
                return Some(
                    crate::ops::dialogs::DialogPolicyEvent::HandledByExternalPolicy {
                        dialog,
                        action,
                    },
                );
            }
            Some(crate::ops::dialogs::DialogPolicyEvent::Open(dialog))
        },
        |params| async {
            execute_cdp_raw_with_context(
                backend,
                ctx,
                parsed_tab_id,
                "Page.handleJavaScriptDialog",
                params,
            )
            .await
            .map(|_| ())
        },
    )
    .await
}

fn matching_webext_dialog_event(
    event: &ExtensionNotification,
    ctx: &BackendRequestContext,
    parsed_tab_id: i64,
) -> Option<crate::ops::dialogs::JavaScriptDialog> {
    if event.method != "onCDPEvent" {
        return None;
    }
    if event.params.get("session_id").and_then(Value::as_str) != ctx.session_id.as_deref() {
        return None;
    }
    if event
        .params
        .get("source")
        .and_then(|source| source.get("tabId"))
        .and_then(Value::as_i64)
        != Some(parsed_tab_id)
    {
        return None;
    }
    if event.params.get("method").and_then(Value::as_str) != Some("Page.javascriptDialogOpening") {
        return None;
    }
    crate::ops::dialogs::parse_javascript_dialog(
        &event.params.get("params").cloned().unwrap_or(Value::Null),
    )
}

fn extension_handled_dialog_action(
    event: &ExtensionNotification,
    dialog: &crate::ops::dialogs::JavaScriptDialog,
) -> Option<crate::ops::dialogs::DialogAction> {
    let handled = event.params.get("handledByExtension")?;
    let accept = handled.get("accept").and_then(Value::as_bool)?;
    let action = crate::ops::dialogs::action_for_dialog_type(&dialog.dialog_type);
    (action.accept() == accept).then_some(action)
}

fn validate_active_tab_param_if_recorded(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    params: &Value,
) -> Result<()> {
    if let Some(tab_id) = params_tab_id(params) {
        validate_active_tab_if_recorded(backend, ctx, &tab_id)?;
    }
    Ok(())
}

fn validate_active_tab_if_recorded(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
) -> Result<()> {
    let Some(record) = backend.registry().get(&TabId::new(tab_id))? else {
        return Ok(());
    };
    if record.session_id.as_deref() != ctx.session_id.as_deref() {
        return Err(HostError::Protocol(format!(
            "tab {tab_id} does not belong to session {}",
            ctx.session_id.as_deref().unwrap_or_default()
        )));
    }
    if record.status != TabStatus::Active {
        return Err(HostError::Protocol(format!(
            "tab {tab_id} is {}, not actively controlled",
            tab_status_label(&record.status)
        )));
    }
    Ok(())
}

fn params_tab_id(params: &Value) -> Option<String> {
    params
        .get("tab_id")
        .or_else(|| params.get("tabId"))
        .and_then(|value| match value {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => value.as_i64().map(|value| value.to_string()),
            _ => None,
        })
        .or_else(|| {
            params
                .get("target")
                .and_then(|target| target.get("tabId"))
                .and_then(|value| match value {
                    Value::String(value) => Some(value.clone()),
                    Value::Number(value) => value.as_i64().map(|value| value.to_string()),
                    _ => None,
                })
        })
}

fn tab_status_label(status: &TabStatus) -> &'static str {
    match status {
        TabStatus::Active => "active",
        TabStatus::Handoff => "handoff",
        TabStatus::Deliverable => "deliverable",
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

#[async_trait]
impl PlaywrightRuntimeBackend for WebExtensionBackend {
    async fn ensure_playwright_runtime(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
    ) -> Result<()> {
        let result = self
            .execute_cdp_with_context(
                ctx,
                tab_id,
                "Runtime.evaluate",
                json!({
                    "expression": "!!window.__obuPlaywrightInjected && !!window.__obuPlaywrightRuntime",
                    "returnByValue": true,
                }),
            )
            .await?;
        if result
            .get("result")
            .and_then(|result| result.get("value"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Ok(());
        }
        let result = self
            .execute_cdp_with_context(
                ctx,
                tab_id,
                "Runtime.evaluate",
                json!({
                    "expression": ensure_injected::mount_expression(),
                    "returnByValue": true,
                    "awaitPromise": false,
                }),
            )
            .await?;
        exception_to_error(&result, "playwright-injected mount")?;
        Ok(())
    }

    async fn evaluate_playwright_runtime(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        expression: String,
    ) -> Result<Value> {
        self.execute_cdp_with_context(
            ctx,
            tab_id,
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "returnByValue": true,
                "awaitPromise": true,
                "userGesture": true,
            }),
        )
        .await
    }

    async fn playwright_top_level_session(&self, tab_id: &str) -> Option<String> {
        // WebExtension has no explicit top-level CDP session id — `chrome.debugger`
        // addresses the page by `tabId` alone. Encode the tab in a sentinel so
        // `execute_playwright_cdp_on_session` can route a top-level command by
        // `{ tabId }` while OOPIF child commands route by `{ tabId, sessionId }`.
        let parsed = parse_tab_id(tab_id).ok()?;
        Some(format!("{WEBEXT_TOP_SESSION_PREFIX}{parsed}"))
    }

    async fn playwright_oopif_session_for_frame(&self, frame_id: &str) -> Option<String> {
        // CDP target ids are unique per browser process, so a frameId resolves to
        // at most one OOPIF session regardless of tab; scan all tabs' sessions.
        self.oopif_sessions()
            .lock()
            .ok()?
            .session_for_any_frame(frame_id)
    }

    async fn execute_playwright_cdp_on_session(
        &self,
        ctx: &BackendRequestContext,
        session_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        match session_id.strip_prefix(WEBEXT_TOP_SESSION_PREFIX) {
            // Top-level: route by tabId only (no child sessionId).
            Some(tab_id) => {
                execute_cdp_raw_with_context(self, ctx, parse_tab_id(tab_id)?, method, params).await
            }
            // OOPIF child session: route by { tabId, sessionId }.
            None => {
                execute_cdp_on_session_with_context(self, ctx, session_id, method, params).await
            }
        }
    }
}

/// Sentinel prefix for the WebExtension "top-level session" placeholder. The
/// page has no real CDP session id in the extension transport, so the tab id is
/// carried here and decoded by `execute_playwright_cdp_on_session`.
const WEBEXT_TOP_SESSION_PREFIX: &str = "webext-top:";

#[async_trait]
impl PlaywrightTextInputBackend for WebExtensionBackend {
    async fn insert_playwright_text(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        text: &str,
    ) -> Result<()> {
        write_text_for_virtual_paste(self, ctx, tab_id, text, false).await?;
        paste_virtual_clipboard(self, ctx, tab_id).await?;
        Ok(())
    }

    async fn press_playwright_key(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        key: &str,
    ) -> Result<()> {
        keypress(
            self,
            ctx,
            json!({
                "tab_id": tab_id,
                "key": key,
            }),
        )
        .await
        .map(|_| ())
    }
}

#[async_trait]
impl PointCdpBackend for WebExtensionBackend {
    async fn execute_point_cdp(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        self.execute_cdp_with_context(ctx, tab_id, method, params)
            .await
    }
}

#[async_trait]
impl PlaywrightCommandBackend for WebExtensionBackend {
    fn retarget_playwright_press_input(&self) -> bool {
        true
    }

    async fn click_playwright_selector(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
        click_count: i64,
    ) -> Result<Value> {
        playwright_runtime::click_selector(self, ctx, params, click_count, |params, click_count| {
            click(self, ctx, params, click_count)
        })
        .await
    }

    async fn hover_playwright_selector(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        playwright_runtime::hover_selector(self, ctx, params, |params| {
            move_mouse(self, ctx, params)
        })
        .await
    }

    async fn screenshot_playwright_page(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        capture_screenshot(self, ctx, params).await
    }

    async fn playwright_element_info(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        point::element_info(self, ctx, params).await
    }

    async fn playwright_element_screenshot(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        point::element_screenshot(self, ctx, params).await
    }

    async fn wait_for_playwright_url(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        let tab_id = required_str(&params, "tab_id")?;
        let url = required_str(&params, "url")?;
        wait_for_url(self, ctx, tab_id, url, Some(timeout_ms_u64(&params))).await
    }

    async fn wait_for_playwright_load_state(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        let tab_id = required_str(&params, "tab_id")?;
        let state = params
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("load");
        wait_for_load_state(self, ctx, tab_id, state, Some(timeout_ms_u64(&params))).await
    }

    async fn wait_for_playwright_file_chooser(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        playwright_wait_for_file_chooser(self, ctx, params).await
    }

    async fn set_playwright_file_chooser_files(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        playwright_file_chooser_set_files(self, ctx, params).await
    }

    async fn wait_for_playwright_download(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        playwright_wait_for_download(self, ctx, params).await
    }

    async fn playwright_download_path(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        playwright_download_path(self, ctx, params).await
    }
}

async fn run_playwright_command(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    method: &str,
    params: Value,
) -> Result<Value> {
    playwright_runtime::run_command(backend, ctx, method, params).await
}

async fn playwright_wait_for_file_chooser(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    WebExtensionBackend::require_session_context(ctx, "playwright_wait_for_file_chooser")?;
    let tab_id = required_str(&params, "tab_id")?;
    backend
        .execute_cdp_with_context(ctx, tab_id, "Page.enable", json!({}))
        .await?;
    backend
        .execute_cdp_with_context(ctx, tab_id, "DOM.enable", json!({}))
        .await?;
    backend
        .execute_cdp_with_context(
            ctx,
            tab_id,
            "Page.setInterceptFileChooserDialog",
            json!({ "enabled": true }),
        )
        .await?;
    let event = wait_for_cdp_event_matching(
        backend,
        ctx,
        tab_id,
        "Page.fileChooserOpened",
        timeout_ms_u64(&params),
        handle_ops::file_chooser_opened_has_backend_node,
    )
    .await;
    let _ = backend
        .execute_cdp_with_context(
            ctx,
            tab_id,
            "Page.setInterceptFileChooserDialog",
            json!({ "enabled": false }),
        )
        .await;
    let event = event?;
    handle_ops::file_chooser_opened_result(
        backend.registry(),
        tab_id,
        ctx.session_id.clone(),
        &event,
    )
}

async fn playwright_file_chooser_set_files(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    let (state, files) =
        handle_ops::take_file_chooser_for_set_files(backend.registry(), ctx, &params)?;
    backend
        .execute_cdp_with_context(
            ctx,
            &state.tab_id.0,
            "DOM.setFileInputFiles",
            handle_ops::set_file_input_files_params(&state, files),
        )
        .await?;
    Ok(Value::Null)
}

async fn playwright_wait_for_download(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    WebExtensionBackend::require_session_context(ctx, "playwright_wait_for_download")?;
    let tab_id = required_str(&params, "tab_id")?;
    let will_begin = wait_for_cdp_event_matching(
        backend,
        ctx,
        tab_id,
        "Page.downloadWillBegin",
        timeout_ms_u64(&params),
        handle_ops::download_will_begin_has_guid,
    )
    .await?;
    handle_ops::record_download_from_will_begin(
        backend.registry(),
        tab_id,
        ctx.session_id.clone(),
        &will_begin,
    )
}

async fn playwright_download_path(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    let (download_id, mut state) = handle_ops::download_for_path(backend.registry(), ctx, &params)?;
    if state.completed_path.is_none() {
        let change =
            wait_for_download_change_matching(backend, ctx, timeout_ms_u64(&params), |params| {
                handle_ops::download_change_terminal_and_matches(params, &state)
            })
            .await?;
        if !handle_ops::download_change_is_complete(&change) {
            let message = handle_ops::download_change_failure_message(&change);
            backend
                .registry()
                .mark_download_failed(&download_id, &state, message)?;
            return Err(HostError::CdpFailure(format!("{message}; event={change}")));
        }
        let path = handle_ops::download_change_filename(&change);
        handle_ops::mark_download_completed(backend.registry(), &download_id, &mut state, path)?;
    }
    handle_ops::download_path_result(&download_id, state)
}

async fn wait_for_cdp_event_matching(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
    cdp_method: &str,
    timeout_ms: u64,
    predicate: impl Fn(&Value) -> bool,
) -> Result<Value> {
    let session_id = ctx.session_id.as_deref().unwrap_or_default();
    let chrome_tab_id = parse_tab_id(tab_id)?;
    let mut rx = backend.subscribe_notifications();
    event_wait::wait_for_broadcast_event_matching(
        &mut rx,
        timeout_ms,
        format!("{cdp_method} event timed out after {timeout_ms}ms"),
        |error| HostError::Protocol(format!("extension event bus closed: {error}")),
        |event| {
            if event.method != "onCDPEvent" {
                return None;
            }
            if event.params.get("session_id").and_then(Value::as_str) != Some(session_id) {
                return None;
            }
            if event
                .params
                .get("source")
                .and_then(|source| source.get("tabId"))
                .and_then(Value::as_i64)
                != Some(chrome_tab_id)
            {
                return None;
            }
            if event.params.get("method").and_then(Value::as_str) != Some(cdp_method) {
                return None;
            }
            let params = event.params.get("params").cloned().unwrap_or(Value::Null);
            predicate(&params).then_some(params)
        },
    )
    .await
}

async fn wait_for_download_change_matching(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    timeout_ms: u64,
    predicate: impl Fn(&Value) -> bool,
) -> Result<Value> {
    let session_id = ctx.session_id.as_deref().unwrap_or_default();
    let mut rx = backend.subscribe_notifications();
    event_wait::wait_for_broadcast_event_matching(
        &mut rx,
        timeout_ms,
        format!("download event timed out after {timeout_ms}ms"),
        |error| HostError::Protocol(format!("extension event bus closed: {error}")),
        |event| {
            if event.method != "onDownloadChange" {
                return None;
            }
            if event.params.get("session_id").and_then(Value::as_str) != Some(session_id) {
                return None;
            }
            predicate(&event.params).then_some(event.params)
        },
    )
    .await
}

struct WebExtTabNavigation<'a> {
    backend: &'a WebExtensionBackend,
    ctx: &'a BackendRequestContext,
}

#[async_trait]
impl TabNavigationBackend for WebExtTabNavigation<'_> {
    async fn execute_cdp(&self, tab_id: &str, method: &str, params: Value) -> Result<Value> {
        self.backend
            .execute_cdp_with_context(self.ctx, tab_id, method, params)
            .await
    }

    async fn refresh_tab_metadata(&self, tab_id: &str) -> Result<()> {
        let current_url = tab_navigation::url(self, tab_id).await.unwrap_or_default();
        let current_title = tab_navigation::title(self, tab_id)
            .await
            .unwrap_or_default();
        self.backend
            .registry()
            .update(&TabId::new(tab_id), |record| {
                record.url = current_url;
                record.title = current_title;
            })?;
        Ok(())
    }
}

#[async_trait]
impl NavigationWaiter for WebExtTabNavigation<'_> {
    type Token = String;

    async fn arm_navigation_wait(
        &self,
        tab_id: &str,
        _wait: &NavigationWaitOptions,
    ) -> Result<Self::Token> {
        Ok(tab_navigation::url(self, tab_id).await.unwrap_or_default())
    }

    async fn wait_for_navigation(
        &self,
        tab_id: &str,
        wait: &NavigationWaitOptions,
        start_url: Self::Token,
    ) -> Result<()> {
        tab_navigation::wait_for_url_change(self, tab_id, &start_url, Some(wait.timeout_ms))
            .await?;
        tab_navigation::wait_for_load_state(self, tab_id, &wait.wait_until, Some(wait.timeout_ms))
            .await
            .map(|_| ())
    }
}

async fn run_tab_command(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    method: &str,
    params: Value,
) -> Result<Value> {
    let navigation = WebExtTabNavigation { backend, ctx };
    match method {
        methods::TAB_GOTO => {
            let tab_id = required_str(&params, "tab_id")?;
            let url = required_str(&params, "url")?;
            tab_navigation::goto(&navigation, tab_id, url).await
        }
        methods::TAB_RELOAD => {
            let tab_id = required_str(&params, "tab_id")?;
            tab_navigation::reload(&navigation, tab_id).await
        }
        methods::TAB_BACK => {
            tab_navigation::back(&navigation, required_str(&params, "tab_id")?).await
        }
        methods::TAB_FORWARD => {
            tab_navigation::forward(&navigation, required_str(&params, "tab_id")?).await
        }
        methods::TAB_CLOSE => {
            let tab_id = required_str(&params, "tab_id")?;
            backend
                .execute_cdp_with_context(ctx, tab_id, "Page.close", json!({}))
                .await?;
            forget_tab_state(backend, ctx, tab_id).await;
            let _ = backend
                .registry()
                .remove_with_reason(&TabId::new(tab_id), "WebExtension tab_close closed the tab")?;
            Ok(Value::Null)
        }
        methods::TAB_SCREENSHOT => capture_screenshot(backend, ctx, params).await,
        methods::TAB_WAIT_FOR_URL => {
            let tab_id = required_str(&params, "tab_id")?;
            let url = required_str(&params, "url")?;
            wait_for_url(backend, ctx, tab_id, url, timeout_ms(&params)).await
        }
        methods::TAB_WAIT_FOR_LOAD_STATE => {
            let tab_id = required_str(&params, "tab_id")?;
            let state = params
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("load");
            wait_for_load_state(backend, ctx, tab_id, state, timeout_ms(&params)).await
        }
        methods::TAB_CONTENT_EXPORT => {
            let tab_id = required_str(&params, "tab_id")?;
            content_export::export_content(
                backend,
                ctx,
                tab_id,
                params
                    .get("format")
                    .and_then(Value::as_str)
                    .unwrap_or("html"),
            )
            .await
        }
        methods::TAB_EVALUATE | methods::TAB_SNAPSHOT_TEXT => {
            let tab_id = required_str(&params, "tab_id")?;
            backend
                .execute_cdp_with_context(
                    ctx,
                    tab_id,
                    "Runtime.evaluate",
                    runtime_evaluate_params(&params)?,
                )
                .await
        }
        methods::TAB_URL => tab_navigation::url(&navigation, required_str(&params, "tab_id")?)
            .await
            .map(Value::String),
        methods::TAB_TITLE => tab_navigation::title(&navigation, required_str(&params, "tab_id")?)
            .await
            .map(Value::String),
        methods::TAB_CLIPBOARD_READ_TEXT => {
            let tab_id = required_str(&params, "tab_id")?;
            ensure_virtual_clipboard(backend, ctx, tab_id).await?;
            let text = eval_string(
                backend,
                ctx,
                tab_id,
                "globalThis.__obuVirtualClipboard.readText()",
            )
            .await?;
            Ok(json!({ "text": text }))
        }
        methods::TAB_CLIPBOARD_WRITE_TEXT => {
            let tab_id = required_str(&params, "tab_id")?;
            let text = params
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            ensure_virtual_clipboard(backend, ctx, tab_id).await?;
            eval_value(
                backend,
                ctx,
                tab_id,
                &format!(
                    "globalThis.__obuVirtualClipboard.writeText({})",
                    json!(text)
                ),
            )
            .await?;
            Ok(Value::Null)
        }
        methods::TAB_CLIPBOARD_READ => {
            let tab_id = required_str(&params, "tab_id")?;
            ensure_virtual_clipboard(backend, ctx, tab_id).await?;
            let items = eval_value(
                backend,
                ctx,
                tab_id,
                "globalThis.__obuVirtualClipboard.__obuReadWire()",
            )
            .await?;
            Ok(json!({ "items": items.as_array().cloned().unwrap_or_default() }))
        }
        methods::TAB_CLIPBOARD_WRITE => {
            let tab_id = required_str(&params, "tab_id")?;
            let items = clipboard_ops::validate_clipboard_items(params.get("items"))?;
            write_virtual_clipboard_items(backend, ctx, tab_id, items).await?;
            Ok(Value::Null)
        }
        _ => Err(HostError::NotImplemented(format!(
            "{method} (WebExtension)"
        ))),
    }
}

async fn run_cua_command(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    method: &str,
    params: Value,
) -> Result<Value> {
    if let Some(command) = cua_ops::coordinate_command(method) {
        return match command {
            CoordinateCommand::Click { click_count } => {
                click(backend, ctx, params, click_count).await
            }
            CoordinateCommand::Scroll => scroll(backend, ctx, params).await,
            CoordinateCommand::TypeText => type_text(backend, ctx, params).await,
            CoordinateCommand::Keypress => keypress(backend, ctx, params).await,
            CoordinateCommand::Drag => drag(backend, ctx, params).await,
            CoordinateCommand::Move => move_mouse(backend, ctx, params).await,
            CoordinateCommand::DownloadMedia => cua_download_media(backend, ctx, params).await,
        };
    }
    if method == methods::DOM_CUA_DOWNLOAD_MEDIA {
        return dom_cua_download_media(backend, ctx, params).await;
    }
    if method.starts_with("dom_cua_") {
        return dom_cua_runtime::run(backend, ctx, method, params).await;
    }
    Err(HostError::NotImplemented(format!("cua command {method}")))
}

#[async_trait::async_trait]
impl DomCuaRuntimeBackend for WebExtensionBackend {
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
        ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        if let Some(command) = cua_ops::coordinate_command(method) {
            return match command {
                CoordinateCommand::Click { click_count } => {
                    click(self, ctx, params, click_count).await
                }
                CoordinateCommand::Scroll => scroll(self, ctx, params).await,
                CoordinateCommand::TypeText => type_text(self, ctx, params).await,
                CoordinateCommand::Keypress => keypress(self, ctx, params).await,
                CoordinateCommand::Drag => drag(self, ctx, params).await,
                CoordinateCommand::Move => move_mouse(self, ctx, params).await,
                CoordinateCommand::DownloadMedia => cua_download_media(self, ctx, params).await,
            };
        }
        Err(HostError::NotImplemented(format!("cua command {method}")))
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
        let Ok(parsed_tab_id) = parse_tab_id(tab_id) else {
            return Vec::new();
        };
        self.oopif_sessions()
            .lock()
            .map(|map| map.sessions_for_tab(parsed_tab_id))
            .unwrap_or_default()
    }

    async fn execute_dom_cdp_on_session(
        &self,
        ctx: &BackendRequestContext,
        session_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        execute_cdp_on_session_with_context(self, ctx, session_id, method, params).await
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
        ctx: &BackendRequestContext,
        session_id: &str,
    ) -> Result<Option<(f64, f64)>> {
        // The owning tab is constant for an OOPIF subtree; resolve it once.
        let Some(tab_id) = self
            .oopif_sessions()
            .lock()
            .ok()
            .and_then(|map| map.tab_for_session(session_id))
        else {
            return Ok(None);
        };
        let mut offset = (0.0_f64, 0.0_f64);
        let mut current = session_id.to_string();
        for _ in 0..WebextOopifSessionMap::max_frame_depth() {
            let Some((frame_id, parent_session)) = self
                .oopif_sessions()
                .lock()
                .ok()
                .and_then(|map| map.frame_and_parent(tab_id, &current))
            else {
                break;
            };
            // The owning `<iframe>` element lives in the PARENT frame. In webext
            // the parent is either another OOPIF session (`Some`) or the top-level
            // page — which has no explicit CDP session id and is addressed by
            // `tabId` alone (`None`). Resolve the owner box on whichever that is.
            let owner = execute_oopif_parent_cdp(
                self,
                ctx,
                tab_id,
                parent_session.as_deref(),
                "DOM.getFrameOwner",
                json!({ "frameId": frame_id }),
            )
            .await?;
            let Some(backend_node_id) = owner.get("backendNodeId").and_then(Value::as_i64) else {
                break;
            };
            let box_model = execute_oopif_parent_cdp(
                self,
                ctx,
                tab_id,
                parent_session.as_deref(),
                "DOM.getBoxModel",
                json!({ "backendNodeId": backend_node_id }),
            )
            .await?;
            if let Some(rect) = dom_cua::rect_from_box_model(&box_model) {
                offset.0 += rect.x;
                offset.1 += rect.y;
            }
            // Walk up. A `None` parent is the top-level page: the chain ends there.
            let Some(parent_session) = parent_session else {
                break;
            };
            current = parent_session;
        }
        Ok(Some(offset))
    }
}

/// Run a DOM command on an OOPIF frame's PARENT, routing by the parent's nature:
/// an OOPIF parent session (`Some`, `{ tabId, sessionId }`) or the top-level page
/// (`None`, `{ tabId }` — webext has no explicit top-level CDP session id).
async fn execute_oopif_parent_cdp(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: i64,
    parent_session: Option<&str>,
    method: &str,
    params: Value,
) -> Result<Value> {
    match parent_session {
        Some(session_id) => {
            execute_cdp_on_session_with_context(backend, ctx, session_id, method, params).await
        }
        None => execute_cdp_raw_with_context(backend, ctx, tab_id, method, params).await,
    }
}

async fn write_virtual_clipboard_items(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
    items: Vec<Value>,
) -> Result<()> {
    ensure_virtual_clipboard(backend, ctx, tab_id).await?;
    eval_value(
        backend,
        ctx,
        tab_id,
        &format!(
            "globalThis.__obuVirtualClipboard.__obuWriteWire({})",
            json!(items)
        ),
    )
    .await?;
    Ok(())
}

async fn paste_virtual_clipboard(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
) -> Result<()> {
    ensure_virtual_clipboard(backend, ctx, tab_id).await?;
    eval_value(
        backend,
        ctx,
        tab_id,
        "globalThis.__obuVirtualClipboard.__obuPaste()",
    )
    .await?;
    Ok(())
}

async fn write_text_for_virtual_paste(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
    text: &str,
    include_rich_text: bool,
) -> Result<()> {
    let mut entries = vec![json!({ "mime_type": "text/plain", "text": text })];
    if include_rich_text {
        entries.push(json!({ "mime_type": "text/html", "text": clipboard_ops::text_to_clipboard_html(text) }));
    }
    write_virtual_clipboard_items(
        backend,
        ctx,
        tab_id,
        vec![json!({
            "entries": entries,
            "presentation_style": "unspecified",
        })],
    )
    .await
}

const DEFAULT_WAIT_MS: u64 = 30_000;
const VIRTUAL_CLIPBOARD_SOURCE: &str = r#"
(() => {
  if (globalThis.__obuVirtualClipboard?.__obuRichClipboard === true) {
    try {
      if (navigator.clipboard !== globalThis.__obuVirtualClipboard) {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          get() { return globalThis.__obuVirtualClipboard; }
        });
      }
      if (navigator.clipboard !== globalThis.__obuVirtualClipboard) throw new Error();
    } catch {
      throw new Error("open-browser-use virtual clipboard is not installed");
    }
    return;
  }
  const previousDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const hadOwnClipboard = Object.prototype.hasOwnProperty.call(navigator, "clipboard");
  const cloneEntry = (entry) => {
    const out = { mime_type: String(entry.mime_type) };
    if (typeof entry.text === "string") out.text = entry.text;
    if (typeof entry.base64 === "string") out.base64 = entry.base64;
    return out;
  };
  const cloneItem = (item) => ({
    entries: Array.from(item.entries ?? []).map(cloneEntry),
    presentation_style: item.presentation_style ?? "unspecified"
  });
  const state = globalThis.__obuVirtualClipboardState ??= { items: [] };
  const blobToBase64 = async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  };
  const base64ToBlob = (base64, type) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
  };
  const normalizeWireItem = (item) => {
    const entries = Array.from(item?.entries ?? []).map(cloneEntry);
    return {
      entries,
      presentation_style: item?.presentation_style ?? item?.presentationStyle ?? "unspecified"
    };
  };
  const normalizeClipboardItem = async (item) => {
    if (Array.isArray(item?.entries)) return normalizeWireItem(item);
    if (!Array.isArray(item?.types) || typeof item?.getType !== "function") {
      throw new Error("Clipboard item must include entries or types/getType");
    }
    const entries = [];
    for (const type of item.types) {
      const mime_type = String(type);
      const blob = await item.getType(type);
      if (mime_type.startsWith("text/")) entries.push({ mime_type, text: await blob.text() });
      else entries.push({ mime_type, base64: await blobToBase64(blob) });
    }
    return {
      entries,
      presentation_style: item.presentation_style ?? item.presentationStyle ?? "unspecified"
    };
  };
  const toClipboardItem = (item) => ({
    types: item.entries.map((entry) => entry.mime_type),
    presentationStyle: item.presentation_style ?? "unspecified",
    async getType(type) {
      const mime_type = String(type);
      const entry = item.entries.find((candidate) => candidate.mime_type === mime_type);
      if (!entry) throw new DOMException("Clipboard item type is unavailable", "NotFoundError");
      if (typeof entry.text === "string") return new Blob([entry.text], { type: mime_type });
      return base64ToBlob(entry.base64 ?? "", mime_type);
    }
  });
  const activeEditableTarget = (doc = document) => {
    let element = doc.activeElement || doc.body;
    for (;;) {
      if (element?.shadowRoot?.activeElement) {
        element = element.shadowRoot.activeElement;
        continue;
      }
      const tag = element?.tagName?.toLowerCase?.();
      if ((tag === "iframe" || tag === "frame") && element.contentDocument) {
        try {
          const child = activeEditableTarget(element.contentDocument);
          return child || element;
        } catch {
          return element;
        }
      }
      return element || doc.body;
    }
  };
  const fileNameForMime = (mimeType) => {
    const subtype = String(mimeType).split("/")[1]?.split(/[;+]/)[0] || "bin";
    return `clipboard.${subtype}`;
  };
  const dataTransferForItems = (items) => {
    const transfer = new DataTransfer();
    for (const item of items) {
      for (const entry of item.entries ?? []) {
        if (typeof entry.text === "string") {
          transfer.setData(entry.mime_type, entry.text);
        } else if (typeof entry.base64 === "string") {
          const blob = base64ToBlob(entry.base64, entry.mime_type);
          transfer.items.add(new File([blob], fileNameForMime(entry.mime_type), { type: entry.mime_type }));
        }
      }
    }
    return transfer;
  };
  const fallbackPaste = (target, transfer) => {
    const text = transfer.getData("text/plain");
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      target.focus();
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      target.setRangeText(text, start, end, "end");
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text }));
      return;
    }
    if (target?.isContentEditable) {
      target.focus();
      const html = transfer.getData("text/html");
      const doc = target.ownerDocument || document;
      if (html) doc.execCommand("insertHTML", false, html);
      else if (text) doc.execCommand("insertText", false, text);
    }
  };
  const clipboard = {
    __obuRichClipboard: true,
    async read() {
      return state.items.map((item) => toClipboardItem(cloneItem(item)));
    },
    async readText() {
      return state.items
        .flatMap((item) => item.entries)
        .find((entry) => entry.mime_type === "text/plain" && typeof entry.text === "string")
        ?.text ?? "";
    },
    async write(items) {
      state.items = await Promise.all(Array.from(items ?? []).map(normalizeClipboardItem));
    },
    async writeText(value) {
      state.items = [{
        entries: [{ mime_type: "text/plain", text: String(value ?? "") }],
        presentation_style: "unspecified"
      }];
    },
    async __obuReadWire() {
      return state.items.map(cloneItem);
    },
    async __obuWriteWire(items) {
      state.items = Array.from(items ?? []).map(normalizeWireItem);
    },
    async __obuPaste() {
      if (!state.items.length) throw new Error("open-browser-use virtual clipboard has no data to paste");
      const target = activeEditableTarget();
      const targetWindow = target?.ownerDocument?.defaultView;
      if (targetWindow?.navigator?.clipboard?.__obuVirtualClipboard === true && targetWindow.navigator.clipboard !== clipboard) {
        await targetWindow.navigator.clipboard.__obuWriteWire(state.items.map(cloneItem));
      }
      const transfer = dataTransferForItems(state.items);
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: transfer
      });
      if (target.dispatchEvent(event)) fallbackPaste(target, transfer);
    }
  };
  Object.defineProperty(clipboard, "__obuVirtualClipboard", { value: true });
  globalThis.__obuVirtualClipboard = clipboard;
  globalThis.__obuVirtualClipboardCleanup = () => {
    try {
      if (navigator.clipboard === clipboard) {
        if (hadOwnClipboard && previousDescriptor) Object.defineProperty(navigator, "clipboard", previousDescriptor);
        else delete navigator.clipboard;
      }
    } catch {}
    delete globalThis.__obuVirtualClipboard;
    delete globalThis.__obuVirtualClipboardCleanup;
    delete globalThis.__obuVirtualClipboardState;
  };
  try {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      get() { return clipboard; }
    });
  } catch {}
})();
"#;
async fn ensure_virtual_clipboard(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
) -> Result<()> {
    let key = dom_cua::snapshot_key(ctx, tab_id);
    if !backend
        .virtual_clipboard_scripts
        .lock()
        .await
        .contains_key(&key)
    {
        let response = backend
            .execute_cdp_with_context(
                ctx,
                tab_id,
                "Page.addScriptToEvaluateOnNewDocument",
                json!({
                    "source": VIRTUAL_CLIPBOARD_SOURCE,
                    "runImmediately": true,
                }),
            )
            .await?;
        if let Some(identifier) = response.get("identifier").and_then(Value::as_str) {
            backend
                .virtual_clipboard_scripts
                .lock()
                .await
                .insert(key, identifier.to_string());
        }
    }
    eval_value(backend, ctx, tab_id, VIRTUAL_CLIPBOARD_SOURCE).await?;
    Ok(())
}

async fn cleanup_virtual_clipboard_script(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
) {
    let key = dom_cua::snapshot_key(ctx, tab_id);
    let identifier = backend.virtual_clipboard_scripts.lock().await.remove(&key);
    let Some(identifier) = identifier else {
        return;
    };
    let _ = eval_value(
        backend,
        ctx,
        tab_id,
        "globalThis.__obuVirtualClipboardCleanup?.()",
    )
    .await;
    let _ = backend
        .execute_cdp_with_context(
            ctx,
            tab_id,
            "Page.removeScriptToEvaluateOnNewDocument",
            json!({ "identifier": identifier }),
        )
        .await;
}

async fn forget_tab_state(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
) {
    backend
        .visible_dom_nodes
        .lock()
        .await
        .forget_tab(ctx, tab_id);
    // Drop any OOPIF child sessions tracked for this tab; detach can race ahead of
    // (or supersede) the `Target.detachedFromTarget` events that would prune them.
    if let Ok(parsed_tab_id) = parse_tab_id(tab_id)
        && let Ok(mut map) = backend.oopif_sessions().lock()
    {
        map.forget_tab(parsed_tab_id);
    }
    let key = dom_cua::snapshot_key(ctx, tab_id);
    backend.virtual_clipboard_scripts.lock().await.remove(&key);
}

async fn wait_for_url(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
    expected_url: &str,
    timeout_ms: Option<u64>,
) -> Result<Value> {
    tab_navigation::wait_for_url(
        &WebExtTabNavigation { backend, ctx },
        tab_id,
        expected_url,
        timeout_ms,
    )
    .await
}

async fn wait_for_load_state(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
    state: &str,
    timeout_ms: Option<u64>,
) -> Result<Value> {
    tab_navigation::wait_for_load_state(
        &WebExtTabNavigation { backend, ctx },
        tab_id,
        state,
        timeout_ms,
    )
    .await
}

async fn eval_string(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
    expression: &str,
) -> Result<String> {
    Ok(eval_value(backend, ctx, tab_id, expression)
        .await?
        .as_str()
        .unwrap_or_default()
        .to_string())
}

async fn eval_value(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
    expression: &str,
) -> Result<Value> {
    let result = backend
        .execute_cdp_with_context(
            ctx,
            tab_id,
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "returnByValue": true,
                "awaitPromise": true,
            }),
        )
        .await?;
    exception_to_error(&result, "Runtime.evaluate")?;
    Ok(result
        .get("result")
        .and_then(|result| result.get("value"))
        .cloned()
        .unwrap_or(Value::Null))
}

fn exception_to_error(result: &Value, label: &str) -> Result<()> {
    if let Some(details) = result.get("exceptionDetails") {
        return Err(HostError::CdpFailure(format!("{label}: {details}")));
    }
    Ok(())
}

async fn capture_screenshot(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    content_export::screenshot_with_params(backend, ctx, params).await
}

#[async_trait]
impl ContentExportBackend for WebExtensionBackend {
    async fn capture_screenshot_cdp(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        cdp_params: Value,
    ) -> Result<Value> {
        execute_cdp_with_context_options(
            self,
            ctx,
            tab_id,
            "Page.captureScreenshot",
            cdp_params,
            ExecuteCdpOptions {
                suppress_agent_overlay_for_capture: true,
            },
        )
        .await
    }

    async fn print_pdf_cdp(&self, ctx: &BackendRequestContext, tab_id: &str) -> Result<Value> {
        self.execute_cdp_with_context(ctx, tab_id, "Page.printToPDF", json!({}))
            .await
    }

    async fn document_html(&self, ctx: &BackendRequestContext, tab_id: &str) -> Result<String> {
        eval_string(
            self,
            ctx,
            tab_id,
            "document.documentElement ? document.documentElement.outerHTML : ''",
        )
        .await
    }
}

async fn click(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    params: Value,
    click_count: i64,
) -> Result<Value> {
    let tab_id = cua_ops::command_tab_id(&params)?;
    let (x, y) = cua_ops::command_point(&params, cua_ops::NumericErrorStyle::MissingNumeric)?;
    let navigation = WebExtTabNavigation { backend, ctx };
    let _ = overlay_move_mouse(backend, ctx, tab_id, x, y).await;
    let sink = WebExtMouseEventSink {
        backend,
        ctx,
        tab_id,
    };
    cua_ops::dispatch_click_command_at(&sink, &navigation, tab_id, x, y, &params, click_count).await
}

async fn move_mouse(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    let tab_id = cua_ops::command_tab_id(&params)?;
    let (x, y) = cua_ops::command_point(&params, cua_ops::NumericErrorStyle::MissingNumeric)?;
    let _ = overlay_move_mouse(backend, ctx, tab_id, x, y).await;
    let sink = WebExtMouseEventSink {
        backend,
        ctx,
        tab_id,
    };
    cua_ops::dispatch_move_command_at(&sink, x, y, cua_ops::modifiers_mask(&params)).await
}

async fn scroll(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    let tab_id = required_str(&params, "tab_id")?;
    let x = required_f64(&params, "x")?;
    let y = required_f64(&params, "y")?;
    let delta_x = cua_ops::scroll_delta(&params, "deltaX", "delta_x");
    let delta_y = cua_ops::scroll_delta(&params, "deltaY", "delta_y");
    let modifiers = cua_ops::modifiers_mask(&params);
    let _ = overlay_move_mouse(backend, ctx, tab_id, x, y).await;
    match cua_ops::scroll_dispatch_plan(modifiers) {
        cua_ops::ScrollDispatchPlan::GestureThenWheel => {
            if dispatch_scroll_gesture(backend, ctx, tab_id, x, y, delta_x, delta_y)
                .await
                .is_err()
            {
                match dispatch_mouse_wheel(backend, ctx, tab_id, x, y, delta_x, delta_y, modifiers)
                    .await
                {
                    Ok(()) => {}
                    Err(_) => {
                        scroll_by_script(backend, ctx, tab_id, x, y, delta_x, delta_y).await?;
                    }
                }
            }
        }
        cua_ops::ScrollDispatchPlan::WheelOnly => {
            dispatch_mouse_wheel(backend, ctx, tab_id, x, y, delta_x, delta_y, modifiers).await?;
        }
    }
    Ok(Value::Null)
}

async fn dispatch_scroll_gesture(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
    x: f64,
    y: f64,
    delta_x: f64,
    delta_y: f64,
) -> Result<()> {
    backend
        .execute_cdp_with_context(
            ctx,
            tab_id,
            "Input.synthesizeScrollGesture",
            cua_ops::scroll_gesture_params(x, y, delta_x, delta_y),
        )
        .await
        .map(|_| ())
}

async fn dispatch_mouse_wheel(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
    x: f64,
    y: f64,
    delta_x: f64,
    delta_y: f64,
    modifiers: i64,
) -> Result<()> {
    backend
        .execute_cdp_with_context(
            ctx,
            tab_id,
            "Input.dispatchMouseEvent",
            cua_ops::mouse_wheel_params(x, y, delta_x, delta_y, modifiers),
        )
        .await
        .map(|_| ())
}

async fn scroll_by_script(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
    x: f64,
    y: f64,
    delta_x: f64,
    delta_y: f64,
) -> Result<()> {
    let x = serde_json::to_string(&x).unwrap_or_else(|_| "0".into());
    let y = serde_json::to_string(&y).unwrap_or_else(|_| "0".into());
    let delta_x = serde_json::to_string(&delta_x).unwrap_or_else(|_| "0".into());
    let delta_y = serde_json::to_string(&delta_y).unwrap_or_else(|_| "0".into());
    let expression = format!(
        r#"
(() => {{
  const x = {x};
  const y = {y};
  const deltaX = {delta_x};
  const deltaY = {delta_y};
  const canScroll = (node) => {{
    if (!(node instanceof Element)) return false;
    const style = getComputedStyle(node);
    const overflowY = style.overflowY;
    const overflowX = style.overflowX;
    const canY = deltaY !== 0
      && node.scrollHeight > node.clientHeight
      && (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay");
    const canX = deltaX !== 0
      && node.scrollWidth > node.clientWidth
      && (overflowX === "auto" || overflowX === "scroll" || overflowX === "overlay");
    return canX || canY;
  }};
  let node = document.elementFromPoint(x, y);
  while (node) {{
    if (canScroll(node)) {{
      node.scrollBy({{ left: deltaX, top: deltaY, behavior: "instant" }});
      return true;
    }}
    node = node.parentElement;
  }}
  window.scrollBy({{ left: deltaX, top: deltaY, behavior: "instant" }});
  return true;
}})()
"#
    );
    eval_value(backend, ctx, tab_id, &expression).await?;
    Ok(())
}

async fn type_text(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    let tab_id = required_str(&params, "tab_id")?;
    write_text_for_virtual_paste(
        backend,
        ctx,
        tab_id,
        required_str(&params, "text")?,
        clipboard_ops::include_rich_text(&params),
    )
    .await?;
    paste_virtual_clipboard(backend, ctx, tab_id).await?;
    Ok(Value::Null)
}

async fn keypress(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    let tab_id = cua_ops::command_tab_id(&params)?;
    match clipboard_ops::clipboard_shortcut(&params) {
        clipboard_ops::ClipboardShortcut::Paste => {
            paste_virtual_clipboard(backend, ctx, tab_id).await?;
            return Ok(Value::Null);
        }
        clipboard_ops::ClipboardShortcut::Blocked => {
            return Err(clipboard_ops::native_clipboard_shortcut_error());
        }
        clipboard_ops::ClipboardShortcut::None => {}
    }
    let sink = WebExtKeyEventSink {
        backend,
        ctx,
        tab_id,
    };
    cua_ops::dispatch_keypress_command(&sink, &params).await
}

async fn drag(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    let tab_id = cua_ops::command_tab_id(&params)?;
    let path = cua_ops::endpoint_drag_path(&params)?;
    let Some((first, _)) = path.split_first() else {
        return Ok(Value::Null);
    };
    let _ = overlay_move_mouse(backend, ctx, tab_id, first.0, first.1).await;
    let sink = WebExtMouseEventSink {
        backend,
        ctx,
        tab_id,
    };
    cua_ops::dispatch_drag_path_command(&sink, path.as_slice(), cua_ops::modifiers_mask(&params))
        .await
}

struct WebExtMouseEventSink<'a> {
    backend: &'a WebExtensionBackend,
    ctx: &'a BackendRequestContext,
    tab_id: &'a str,
}

#[async_trait::async_trait]
impl MouseEventSink for WebExtMouseEventSink<'_> {
    async fn dispatch_mouse_event(&self, event: MouseEvent<'_>) -> Result<()> {
        dispatch_mouse(self.backend, self.ctx, self.tab_id, event).await
    }
}

struct WebExtKeyEventSink<'a> {
    backend: &'a WebExtensionBackend,
    ctx: &'a BackendRequestContext,
    tab_id: &'a str,
}

#[async_trait::async_trait]
impl KeyEventSink for WebExtKeyEventSink<'_> {
    async fn dispatch_key_event(&self, event: Value) -> Result<()> {
        self.backend
            .execute_cdp_with_context(self.ctx, self.tab_id, "Input.dispatchKeyEvent", event)
            .await
            .map(|_| ())
    }
}

async fn cua_download_media(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    let tab_id = required_str(&params, "tab_id")?;
    let x = required_f64(&params, "x")?;
    let y = required_f64(&params, "y")?;
    let expression = format!(
        r#"((x, y) => {{
  const element = document.elementFromPoint(x, y);
  if (!element) throw new Error("No element found at download_media point");
  return ({MEDIA_DOWNLOAD_FUNCTION})(element);
}})({}, {})"#,
        json!(x),
        json!(y)
    );
    eval_value(backend, ctx, tab_id, &expression).await?;
    Ok(Value::Null)
}

async fn dom_cua_download_media(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    let tab_id = required_str(&params, "tab_id")?;
    let node_id = required_str(&params, "node_id")?;
    let observation_id = params.get("observation_id").and_then(Value::as_str);
    backend
        .validate_visible_dom_node(ctx, tab_id, observation_id, node_id)
        .await?;
    let backend_node_id = dom_cua::backend_node_id(node_id)?;
    let resolved = backend
        .execute_cdp_with_context(
            ctx,
            tab_id,
            "DOM.resolveNode",
            json!({ "backendNodeId": backend_node_id }),
        )
        .await?;
    let object_id = resolved
        .get("object")
        .and_then(|object| object.get("objectId"))
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::Protocol("DOM.resolveNode missing objectId".into()))?;
    let result = backend
        .execute_cdp_with_context(
            ctx,
            tab_id,
            "Runtime.callFunctionOn",
            json!({
                "objectId": object_id,
                "functionDeclaration": MEDIA_DOWNLOAD_FUNCTION,
                "returnByValue": true,
                "awaitPromise": true,
                "userGesture": true,
            }),
        )
        .await?;
    exception_to_error(&result, "Runtime.callFunctionOn")?;
    if observation_id.is_some() {
        backend
            .forget_visible_dom_snapshot(ctx, tab_id, observation_id)
            .await;
    }
    Ok(Value::Null)
}

async fn overlay_move_mouse(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
    x: f64,
    y: f64,
) -> Result<()> {
    backend
        .transport("moveMouse")?
        .request(
            "moveMouse",
            context_payload(
                ctx,
                json!({
                    "tabId": parse_tab_id(tab_id)?,
                    "x": x,
                    "y": y,
                    "waitForArrival": true,
                }),
            ),
        )
        .await?;
    Ok(())
}

async fn dispatch_mouse(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
    event: MouseEvent<'_>,
) -> Result<()> {
    backend
        .execute_cdp_with_context(
            ctx,
            tab_id,
            "Input.dispatchMouseEvent",
            event.to_cdp_params(),
        )
        .await?;
    Ok(())
}

fn runtime_evaluate_params(params: &Value) -> Result<Value> {
    let expression = required_str(params, "expression")?;
    Ok(json!({
        "expression": expression,
        "awaitPromise": params
            .get("awaitPromise")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        "returnByValue": params
            .get("returnByValue")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    }))
}

fn required_str<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::Protocol(format!("missing {key}")))
}

fn required_f64(params: &Value, key: &str) -> Result<f64> {
    params
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| HostError::Protocol(format!("missing numeric {key}")))
}

fn timeout_ms(params: &Value) -> Option<u64> {
    params
        .get("timeout_ms")
        .or_else(|| params.get("timeout"))
        .or_else(|| params.get("client_timeout_ms"))
        .and_then(Value::as_u64)
}

fn timeout_ms_u64(params: &Value) -> u64 {
    timeout_ms(params).unwrap_or(DEFAULT_WAIT_MS)
}

fn parse_tab_id(raw: &str) -> Result<i64> {
    raw.parse::<i64>()
        .map_err(|_| HostError::Protocol(format!("WebExtension tab id must be decimal: {raw}")))
}

fn normalize_tab_response(response: Value) -> Result<Value> {
    let tab = response.get("tab").cloned().unwrap_or(response);
    normalize_tab(tab)
}

fn normalize_optional_tab_response(response: Value) -> Result<Option<Value>> {
    let tab = response.get("tab").cloned().unwrap_or(response);
    if tab.is_null() {
        return Ok(None);
    }
    normalize_tab(tab).map(Some)
}

fn normalize_resume_control_response(response: Value) -> Result<Value> {
    let repair = response.get("repair").cloned();
    let Some(tab) = normalize_optional_tab_response(response)? else {
        if let Some(repair) = repair {
            return Ok(json!({
                "tab": Value::Null,
                "repair": repair,
            }));
        }
        return Ok(Value::Null);
    };
    if let Some(repair) = repair {
        return Ok(json!({
            "tab": tab,
            "repair": repair,
        }));
    }
    Ok(tab)
}

fn resume_control_tab(response: &Value) -> Option<&Value> {
    if response.is_null() {
        return None;
    }
    if let Some(tab) = response.get("tab") {
        return (!tab.is_null()).then_some(tab);
    }
    Some(response)
}

fn normalize_tabs_response(response: Value) -> Result<Value> {
    let tabs = response
        .get("tabs")
        .and_then(Value::as_array)
        .ok_or_else(|| HostError::Protocol("getTabs response missing tabs array".into()))?;
    tabs.iter().cloned().map(normalize_tab).collect()
}

fn normalize_items_response(response: Value) -> Result<Value> {
    response
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .map(Value::Array)
        .ok_or_else(|| HostError::Protocol("response missing items array".into()))
}

fn normalize_tab(tab: Value) -> Result<Value> {
    let tab_id = tab
        .get("tabId")
        .and_then(Value::as_i64)
        .ok_or_else(|| HostError::Protocol("tab response missing integer tabId".into()))?;
    let mut object = Map::new();
    object.insert("id".into(), Value::String(tab_id.to_string()));
    object.insert("tab_id".into(), Value::String(tab_id.to_string()));
    object.insert("url".into(), tab.get("url").cloned().unwrap_or(Value::Null));
    object.insert(
        "title".into(),
        tab.get("title").cloned().unwrap_or(Value::Null),
    );
    if let Some(origin) = tab.get("origin").and_then(Value::as_str) {
        object.insert("origin".into(), Value::String(origin.to_string()));
    }
    if let Some(status) = tab.get("status").and_then(Value::as_str) {
        object.insert("status".into(), Value::String(status.to_string()));
    }
    copy_bool_field(&tab, &mut object, "active", "active");
    copy_bool_field(&tab, &mut object, "pinned", "pinned");
    copy_bool_field(&tab, &mut object, "owned", "owned");
    copy_bool_field(&tab, &mut object, "claimRequired", "claimRequired");
    copy_bool_field(&tab, &mut object, "commandable", "commandable");
    copy_bool_field(&tab, &mut object, "logicalActive", "logicalActive");
    copy_number_field(&tab, &mut object, "windowId", "windowId");
    copy_number_field(&tab, &mut object, "groupId", "groupId");
    copy_number_field(&tab, &mut object, "lastAccessed", "lastAccessed");
    copy_number_field(&tab, &mut object, "lastUsedAt", "lastUsedAt");
    copy_string_field(&tab, &mut object, "tabGroupTitle", "tabGroupTitle");
    copy_string_field(&tab, &mut object, "tabGroup", "tabGroup");
    Ok(Value::Object(object))
}

fn copy_bool_field(
    source: &Value,
    target: &mut Map<String, Value>,
    source_key: &str,
    target_key: &str,
) {
    if let Some(value) = source.get(source_key).and_then(Value::as_bool) {
        target.insert(target_key.into(), Value::Bool(value));
    }
}

fn copy_number_field(
    source: &Value,
    target: &mut Map<String, Value>,
    source_key: &str,
    target_key: &str,
) {
    if let Some(value) = source.get(source_key).and_then(Value::as_i64) {
        target.insert(target_key.into(), Value::Number(value.into()));
    }
}

fn copy_string_field(
    source: &Value,
    target: &mut Map<String, Value>,
    source_key: &str,
    target_key: &str,
) {
    if let Some(value) = source.get(source_key).and_then(Value::as_str) {
        target.insert(target_key.into(), Value::String(value.to_string()));
    }
}

fn record_webext_tab(
    backend: &WebExtensionBackend,
    ctx: &BackendRequestContext,
    tab: &Value,
    default_origin: TabOrigin,
    default_status: TabStatus,
) -> Result<()> {
    let tab_id = tab
        .get("tab_id")
        .or_else(|| tab.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::Protocol("normalized tab missing tab_id".into()))?;
    let existing = backend.registry().get(&TabId::new(tab_id))?;
    let existing_owner = existing
        .as_ref()
        .and_then(|record| record.session_id.as_deref());
    if let (Some(owner), Some(session_id), Some(existing_record)) =
        (existing_owner, ctx.session_id.as_deref(), existing.as_ref())
        && owner != session_id
        && existing_record.status != TabStatus::Deliverable
    {
        return Err(HostError::Protocol(format!(
            "tab {tab_id} is already owned by session {owner}"
        )));
    }
    let session_id =
        if existing.as_ref().map(|record| record.status.clone()) == Some(TabStatus::Deliverable) {
            ctx.session_id.clone()
        } else {
            existing_owner
                .map(str::to_string)
                .or_else(|| ctx.session_id.clone())
        };
    let fallback_origin = existing
        .as_ref()
        .map(|record| record.origin.clone())
        .unwrap_or(default_origin);
    let fallback_status = existing
        .as_ref()
        .map(|record| record.status.clone())
        .unwrap_or(default_status);
    backend.registry().insert(TabRecord {
        id: TabId::new(tab_id),
        session_id,
        target_id: tab_id.to_string(),
        url: tab
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        title: tab
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        origin: tab_origin(tab, fallback_origin),
        status: tab_status(tab, fallback_status),
        attached: existing
            .as_ref()
            .map(|record| record.attached)
            .unwrap_or(false),
        cdp_session_id: existing.and_then(|record| record.cdp_session_id),
    })?;
    Ok(())
}

fn tab_origin(tab: &Value, default_origin: TabOrigin) -> TabOrigin {
    match tab.get("origin").and_then(Value::as_str) {
        Some("user") => TabOrigin::User,
        Some("agent") => TabOrigin::Agent,
        _ => default_origin,
    }
}

fn tab_status(tab: &Value, default_status: TabStatus) -> TabStatus {
    match tab.get("status").and_then(Value::as_str) {
        Some("handoff") => TabStatus::Handoff,
        Some("deliverable") => TabStatus::Deliverable,
        Some("active") => TabStatus::Active,
        _ => default_status,
    }
}

fn context_payload(ctx: &BackendRequestContext, params: Value) -> Value {
    let mut object = match params {
        Value::Object(object) => object,
        Value::Null => Map::new(),
        other => {
            let mut object = Map::new();
            object.insert("value".into(), other);
            object
        }
    };
    object.insert(
        "session_id".into(),
        Value::String(ctx.session_id.clone().unwrap_or_default()),
    );
    object.insert(
        "turn_id".into(),
        Value::String(ctx.turn_id.clone().unwrap_or_default()),
    );
    if let Some(timeout_ms) = ctx.client_timeout_ms {
        object.insert("timeoutMs".into(), Value::Number(timeout_ms.into()));
    }
    Value::Object(object)
}

fn normalize_finalize_request(ctx: &BackendRequestContext, params: Value) -> Result<Value> {
    let mut payload = match context_payload(ctx, params) {
        Value::Object(object) => object,
        _ => unreachable!("context payload is always an object"),
    };
    if let Some(keep) = payload.get_mut("keep").and_then(Value::as_array_mut) {
        for row in keep {
            let Some(object) = row.as_object_mut() else {
                return Err(HostError::Protocol(
                    "finalizeTabs keep entries must be objects".into(),
                ));
            };
            let raw_id = object
                .get("tab_id")
                .or_else(|| object.get("tabId"))
                .or_else(|| object.get("id"))
                .cloned()
                .ok_or_else(|| {
                    HostError::Protocol("finalizeTabs keep entry missing tab id".into())
                })?;
            let tab_id = match raw_id {
                Value::String(value) => parse_tab_id(&value)?,
                Value::Number(value) => value.as_i64().ok_or_else(|| {
                    HostError::Protocol("finalizeTabs tabId must be an integer".into())
                })?,
                _ => {
                    return Err(HostError::Protocol(
                        "finalizeTabs tabId must be string or integer".into(),
                    ));
                }
            };
            object.remove("tab_id");
            object.remove("id");
            object.insert("tabId".into(), Value::Number(tab_id.into()));
        }
    }
    Ok(Value::Object(payload))
}

fn finalize_keep_tab_ids(params: &Value) -> Result<HashSet<String>> {
    let mut keep = HashSet::new();
    let Some(rows) = params.get("keep").and_then(Value::as_array) else {
        return Ok(keep);
    };
    for row in rows {
        let Some(object) = row.as_object() else {
            return Err(HostError::Protocol(
                "finalizeTabs keep entries must be objects".into(),
            ));
        };
        let raw_id = object
            .get("tab_id")
            .or_else(|| object.get("tabId"))
            .or_else(|| object.get("id"))
            .cloned()
            .ok_or_else(|| HostError::Protocol("finalizeTabs keep entry missing tab id".into()))?;
        let tab_id = match raw_id {
            Value::String(value) => parse_tab_id(&value)?.to_string(),
            Value::Number(value) => value
                .as_i64()
                .ok_or_else(|| HostError::Protocol("finalizeTabs tabId must be an integer".into()))?
                .to_string(),
            _ => {
                return Err(HostError::Protocol(
                    "finalizeTabs tabId must be string or integer".into(),
                ));
            }
        };
        keep.insert(tab_id);
    }
    Ok(keep)
}

fn normalize_finalize_response(response: Value) -> Result<Value> {
    let mut object = response
        .as_object()
        .cloned()
        .ok_or_else(|| HostError::Protocol("finalizeTabs response must be an object".into()))?;
    normalize_tab_id_array(&mut object, "closedTabIds", "closed_tab_ids")?;
    normalize_tab_id_array(&mut object, "releasedTabIds", "released_tab_ids")?;
    normalize_tab_array(&mut object, "keptTabs", "kept_tabs")?;
    normalize_tab_array(&mut object, "deliverableTabs", "deliverable_tabs")?;
    Ok(Value::Object(object))
}

fn include_tab_ids(response: &mut Value, key: &str, tab_ids: &[String]) -> Result<()> {
    if tab_ids.is_empty() {
        return Ok(());
    }
    let object = response
        .as_object_mut()
        .ok_or_else(|| HostError::Protocol("finalizeTabs response must be an object".into()))?;
    let entry = object
        .entry(key.to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    let values = entry
        .as_array_mut()
        .ok_or_else(|| HostError::Protocol(format!("finalizeTabs {key} must be an array")))?;
    let mut seen = values
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<HashSet<_>>();
    for tab_id in tab_ids {
        if seen.insert(tab_id.clone()) {
            values.push(Value::String(tab_id.clone()));
        }
    }
    Ok(())
}

fn collect_finalize_terminal_tab_ids(response: &Value, keys: &[&str]) -> HashSet<String> {
    let mut tab_ids = HashSet::new();
    for key in keys {
        let Some(values) = response.get(*key).and_then(Value::as_array) else {
            continue;
        };
        tab_ids.extend(values.iter().filter_map(Value::as_str).map(str::to_string));
    }
    tab_ids
}

fn prune_finalized_tab_rows(
    response: &mut Value,
    terminal_tab_ids: &HashSet<String>,
) -> Result<()> {
    if terminal_tab_ids.is_empty() {
        return Ok(());
    }
    let object = response
        .as_object_mut()
        .ok_or_else(|| HostError::Protocol("finalizeTabs response must be an object".into()))?;
    for key in ["kept_tabs", "deliverable_tabs"] {
        let Some(tabs) = object.get_mut(key).and_then(Value::as_array_mut) else {
            continue;
        };
        tabs.retain(|tab| {
            let tab_id = tab
                .get("tab_id")
                .or_else(|| tab.get("id"))
                .and_then(Value::as_str);
            !tab_id.is_some_and(|tab_id| terminal_tab_ids.contains(tab_id))
        });
    }
    Ok(())
}

fn normalize_tab_id_array(object: &mut Map<String, Value>, source: &str, dest: &str) -> Result<()> {
    let Some(values) = object.get(source).and_then(Value::as_array) else {
        return Ok(());
    };
    let normalized = values
        .iter()
        .map(|value| match value {
            Value::Number(value) => value
                .as_i64()
                .map(|id| Value::String(id.to_string()))
                .ok_or_else(|| HostError::Protocol(format!("{source} entries must be integers"))),
            Value::String(value) => {
                parse_tab_id(value)?;
                Ok(Value::String(value.clone()))
            }
            _ => Err(HostError::Protocol(format!(
                "{source} entries must be integers or decimal strings"
            ))),
        })
        .collect::<Result<Vec<_>>>()?;
    object.insert(dest.into(), Value::Array(normalized));
    Ok(())
}

fn normalize_tab_array(object: &mut Map<String, Value>, source: &str, dest: &str) -> Result<()> {
    let Some(tabs) = object.get(source).and_then(Value::as_array) else {
        return Ok(());
    };
    let normalized = tabs
        .iter()
        .cloned()
        .map(normalize_tab)
        .collect::<Result<Vec<_>>>()?;
    object.insert(dest.into(), Value::Array(normalized));
    Ok(())
}

//! Browser backend abstraction.

use std::future::Future;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::error::{HostError, Result};
use crate::methods;

/// Typed request context extracted once by the dispatcher.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BackendRequestContext {
    /// open-browser-use session id, when supplied by the SDK.
    pub session_id: Option<String>,
    /// open-browser-use turn id, when supplied by the SDK.
    pub turn_id: Option<String>,
    /// Client-requested timeout in milliseconds.
    pub client_timeout_ms: Option<u64>,
    /// Trusted kernel generation injected by node-repl via the frame-level
    /// runtime envelope. Never populated from caller-supplied params.
    pub trusted_kernel_generation: Option<i64>,
}

tokio::task_local! {
    static CURRENT_CLIENT_TIMEOUT_MS: Option<u64>;
}

/// Run backend work with the client request timeout available to lower-level transports.
pub async fn scope_client_timeout<F>(timeout_ms: Option<u64>, future: F) -> F::Output
where
    F: Future,
{
    CURRENT_CLIENT_TIMEOUT_MS.scope(timeout_ms, future).await
}

/// Current request timeout for transports that need a per-command defensive timeout.
pub(crate) fn current_client_timeout() -> Option<Duration> {
    CURRENT_CLIENT_TIMEOUT_MS
        .try_with(|timeout_ms| timeout_ms.map(Duration::from_millis))
        .ok()
        .flatten()
}

/// Backend implementation kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendKind {
    /// Raw Chrome DevTools Protocol backend.
    Cdp,
    /// WebExtension/native-messaging backend.
    WebExtension,
}

impl BackendKind {
    /// Wire-facing backend type.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cdp => "cdp",
            Self::WebExtension => "webextension",
        }
    }
}

/// Methods that are known to be unsupported by a backend kind.
pub fn unsupported_methods(kind: BackendKind) -> &'static [&'static str] {
    match kind {
        BackendKind::Cdp => methods::CDP_UNSUPPORTED_METHODS,
        BackendKind::WebExtension => methods::WEBEXTENSION_UNSUPPORTED_METHODS,
    }
}

/// Backend support state for an inbound method, when the method is in the manifest.
pub fn method_support(kind: BackendKind, method: &str) -> Option<methods::BackendMethodSupport> {
    methods::BACKEND_METHOD_SUPPORT
        .iter()
        .find_map(|(candidate, cdp, webextension)| {
            (*candidate == method).then_some(match kind {
                BackendKind::Cdp => *cdp,
                BackendKind::WebExtension => *webextension,
            })
        })
}

/// Whether a method should pass the backend capability gate before routing.
pub fn method_supported(kind: BackendKind, method: &str) -> bool {
    !matches!(
        method_support(kind, method),
        Some(methods::BackendMethodSupport::Unsupported)
    )
}

/// Stable capability payload exposed by `getInfo`.
pub fn capabilities_for_kind(kind: BackendKind) -> Value {
    let unsupported = unsupported_methods(kind);
    let supported = methods::BACKEND_METHOD_SUPPORT
        .iter()
        .filter_map(|(method, cdp, webextension)| {
            let state = match kind {
                BackendKind::Cdp => *cdp,
                BackendKind::WebExtension => *webextension,
            };
            (state == methods::BackendMethodSupport::Implemented).then_some(*method)
        })
        .collect::<Vec<_>>();
    let mut capabilities = json!({
        "backend": kind.as_str(),
        "supported_methods": supported,
        "unsupported_methods": unsupported,
        "artifact_modes": ["inline"],
        "budgeted_outputs": {
            "tab_screenshot": true,
            "playwright_screenshot": true,
            "tab_content_export": true,
            "executeCdp": true,
            "playwright_locator_read_all": true,
            "dom_cua_get_visible_dom": !unsupported.contains(&methods::DOM_CUA_GET_VISIBLE_DOM)
        },
    });
    if kind == BackendKind::WebExtension
        && let Some(object) = capabilities.as_object_mut()
    {
        object.insert(
            "viewport".into(),
            json!({ "set": true, "reset": true, "scope": "active_session_tab" }),
        );
        object.insert(
            "visibility".into(),
            json!({ "set": true, "get": true, "scope": "active_session_window" }),
        );
    }
    capabilities
}

/// JSON-RPC methods that are serviced by a browser backend.
#[async_trait]
pub trait BrowserBackend: Send + Sync {
    /// Backend kind.
    fn kind(&self) -> BackendKind;

    /// Stable backend identifier.
    fn id(&self) -> &str;

    /// Lightweight health check.
    async fn ping(&self) -> Result<&'static str> {
        Ok("pong")
    }

    /// Backend metadata for `getInfo`.
    fn metadata(&self) -> Value {
        Value::Object(Default::default())
    }

    /// Runtime diagnostics that are not part of stable backend discovery metadata.
    fn diagnostics(&self) -> Value {
        Value::Object(Default::default())
    }

    /// Clear stale lifecycle diagnostics after an explicit repair action.
    fn clear_lifecycle_diagnostics(&self) -> Result<Value> {
        Err(HostError::NotImplemented(
            "clearLifecycleDiagnostics".into(),
        ))
    }

    /// Backend capability matrix for `getInfo`.
    fn capabilities(&self) -> Value {
        capabilities_for_kind(self.kind())
    }

    /// Return whether this backend supports a method before routing.
    fn supports_method(&self, method: &str) -> bool {
        method_supported(self.kind(), method)
    }

    /// Whether the backend currently knows a tab with id `tab_id` (audit §4.6).
    ///
    /// Used by the dispatcher to avoid minting a per-tab operation lock for a
    /// closed/unknown tab id. The default returns `true` (mint as before), so a
    /// backend that cannot cheaply answer keeps the pre-existing behaviour.
    /// No backend overrides this yet, so the minting-gate is currently DORMANT —
    /// the lock maps are bounded by the eviction-on-teardown path in
    /// `route_request_inner`, not by this gate. A backend that holds a
    /// `ServiceRegistry` (CDP / WebExtension) can override this to also reject
    /// minting for a closed/unknown tab id and close that leak source too.
    fn knows_tab(&self, _tab_id: &str) -> bool {
        true
    }

    /// Return whether this backend owns request deadline tracking for a method.
    ///
    /// Backends that send non-cancellable browser effects across another
    /// transport should keep their own correlation through timeout and late
    /// completion instead of letting the dispatcher drop the in-flight future.
    fn owns_request_deadline(&self, _method: &str) -> bool {
        false
    }

    /// Attach to a tab.
    async fn attach(&self, _tab_id: &str) -> Result<()> {
        Err(HostError::NotImplemented("attach".into()))
    }

    /// Attach to a tab with request context.
    async fn attach_with_context(&self, _ctx: &BackendRequestContext, tab_id: &str) -> Result<()> {
        self.attach(tab_id).await
    }

    /// Detach from a tab.
    async fn detach(&self, _tab_id: &str) -> Result<()> {
        Err(HostError::NotImplemented("detach".into()))
    }

    /// Detach from a tab with request context.
    async fn detach_with_context(&self, _ctx: &BackendRequestContext, tab_id: &str) -> Result<()> {
        self.detach(tab_id).await
    }

    /// Execute a raw CDP command.
    async fn execute_cdp(&self, _tab_id: &str, _method: &str, _params: Value) -> Result<Value> {
        Err(HostError::NotImplemented("execute_cdp".into()))
    }

    /// Execute a raw CDP command with request context.
    async fn execute_cdp_with_context(
        &self,
        _ctx: &BackendRequestContext,
        tab_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        self.execute_cdp(tab_id, method, params).await
    }

    /// Read a tab's current URL for host policy without mutating host lifecycle state.
    async fn current_url_for_policy(
        &self,
        _ctx: &BackendRequestContext,
        _tab_id: &str,
    ) -> Result<String> {
        Err(HostError::NotImplemented("current_url_for_policy".into()))
    }

    /// Create a tab.
    async fn create_tab(&self, _url: Option<String>) -> Result<Value> {
        Err(HostError::NotImplemented("create_tab".into()))
    }

    /// Create a tab with request context.
    async fn create_tab_with_context(
        &self,
        _ctx: &BackendRequestContext,
        url: Option<String>,
    ) -> Result<Value> {
        self.create_tab(url).await
    }

    /// List tabs.
    async fn list_tabs(&self) -> Result<Value> {
        Err(HostError::NotImplemented("list_tabs".into()))
    }

    /// List tabs with request context.
    async fn list_tabs_with_context(&self, _ctx: &BackendRequestContext) -> Result<Value> {
        self.list_tabs().await
    }

    /// Return the session-owned logical current tab, if any.
    async fn current_tab_with_context(&self, _ctx: &BackendRequestContext) -> Result<Value> {
        Ok(Value::Null)
    }

    /// Return the browser-visible selected tab, if safely representable.
    async fn selected_tab_with_context(&self, ctx: &BackendRequestContext) -> Result<Value> {
        self.current_tab_with_context(ctx).await
    }

    /// List claimable user-visible tabs.
    async fn list_user_tabs_with_context(&self, ctx: &BackendRequestContext) -> Result<Value> {
        self.list_tabs_with_context(ctx).await
    }

    /// Claim an existing user-visible tab for this session.
    async fn claim_user_tab_with_context(
        &self,
        _ctx: &BackendRequestContext,
        _tab_id: &str,
    ) -> Result<Value> {
        Err(HostError::NotImplemented("claimUserTab".into()))
    }

    /// Query browser history for this profile.
    async fn get_user_history_with_context(
        &self,
        _ctx: &BackendRequestContext,
        _params: Value,
    ) -> Result<Value> {
        Ok(Value::Array(Vec::new()))
    }

    /// Finalize a browser session's tab ownership.
    async fn finalize_tabs_with_context(
        &self,
        _ctx: &BackendRequestContext,
        _params: Value,
    ) -> Result<Value> {
        Ok(Value::Null)
    }

    /// Name the visible browser session group.
    async fn name_session_with_context(
        &self,
        _ctx: &BackendRequestContext,
        _params: Value,
    ) -> Result<Value> {
        Ok(Value::Null)
    }

    /// Mark the current turn ended.
    async fn turn_ended_with_context(
        &self,
        _ctx: &BackendRequestContext,
        _params: Value,
    ) -> Result<Value> {
        Ok(Value::Null)
    }

    /// Yield active input control to the human while preserving session state.
    async fn yield_control_with_context(
        &self,
        _ctx: &BackendRequestContext,
        _params: Value,
    ) -> Result<Value> {
        Ok(Value::Null)
    }

    /// Resume active input control for a previously yielded session.
    async fn resume_control_with_context(
        &self,
        _ctx: &BackendRequestContext,
        _params: Value,
    ) -> Result<Value> {
        Ok(Value::Null)
    }

    /// Browser-level capability method.
    async fn browser_command_with_context(
        &self,
        _ctx: &BackendRequestContext,
        method: &str,
        _params: Value,
    ) -> Result<Value> {
        Err(HostError::NotImplemented(method.into()))
    }

    /// Coordinate-level CUA command.
    async fn cua_command(&self, _method: &str, _params: Value) -> Result<Value> {
        Err(HostError::NotImplemented("cua_command".into()))
    }

    /// Coordinate-level CUA command with request context.
    async fn cua_command_with_context(
        &self,
        _ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        self.cua_command(method, params).await
    }

    /// Page-side Playwright/locator command.
    async fn playwright_command(&self, method: &str, _params: Value) -> Result<Value> {
        Err(HostError::NotImplemented(method.into()))
    }

    /// Page-side Playwright/locator command with request context.
    async fn playwright_command_with_context(
        &self,
        _ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        self.playwright_command(method, params).await
    }

    /// Generic tab command placeholder until CDP lands.
    async fn tab_command(&self, method: &str, _params: Value) -> Result<Value> {
        Err(HostError::NotImplemented(method.into()))
    }

    /// Generic tab command with request context.
    async fn tab_command_with_context(
        &self,
        _ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        self.tab_command(method, params).await
    }
}

/// Lifecycle and backend metadata operations used by the dispatcher.
#[async_trait]
pub(crate) trait LifecycleBackendOps {
    async fn ping(&self) -> Result<&'static str>;
    fn clear_lifecycle_diagnostics(&self) -> Result<Value>;
}

#[async_trait]
impl<T> LifecycleBackendOps for T
where
    T: BrowserBackend + ?Sized,
{
    async fn ping(&self) -> Result<&'static str> {
        BrowserBackend::ping(self).await
    }

    fn clear_lifecycle_diagnostics(&self) -> Result<Value> {
        BrowserBackend::clear_lifecycle_diagnostics(self)
    }
}

/// Session, tab ownership, and profile-history operations used by the dispatcher.
#[async_trait]
pub(crate) trait SessionBackendOps {
    async fn create_tab_with_context(
        &self,
        ctx: &BackendRequestContext,
        url: Option<String>,
    ) -> Result<Value>;
    async fn list_tabs_with_context(&self, ctx: &BackendRequestContext) -> Result<Value>;
    async fn current_tab_with_context(&self, ctx: &BackendRequestContext) -> Result<Value>;
    async fn selected_tab_with_context(&self, ctx: &BackendRequestContext) -> Result<Value>;
    async fn list_user_tabs_with_context(&self, ctx: &BackendRequestContext) -> Result<Value>;
    async fn claim_user_tab_with_context(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
    ) -> Result<Value>;
    async fn finalize_tabs_with_context(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value>;
    async fn name_session_with_context(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value>;
    async fn turn_ended_with_context(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value>;
    async fn yield_control_with_context(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value>;
    async fn resume_control_with_context(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value>;
    async fn get_user_history_with_context(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value>;
}

#[async_trait]
impl<T> SessionBackendOps for T
where
    T: BrowserBackend + ?Sized,
{
    async fn create_tab_with_context(
        &self,
        ctx: &BackendRequestContext,
        url: Option<String>,
    ) -> Result<Value> {
        BrowserBackend::create_tab_with_context(self, ctx, url).await
    }

    async fn list_tabs_with_context(&self, ctx: &BackendRequestContext) -> Result<Value> {
        BrowserBackend::list_tabs_with_context(self, ctx).await
    }

    async fn current_tab_with_context(&self, ctx: &BackendRequestContext) -> Result<Value> {
        BrowserBackend::current_tab_with_context(self, ctx).await
    }

    async fn selected_tab_with_context(&self, ctx: &BackendRequestContext) -> Result<Value> {
        BrowserBackend::selected_tab_with_context(self, ctx).await
    }

    async fn list_user_tabs_with_context(&self, ctx: &BackendRequestContext) -> Result<Value> {
        BrowserBackend::list_user_tabs_with_context(self, ctx).await
    }

    async fn claim_user_tab_with_context(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
    ) -> Result<Value> {
        BrowserBackend::claim_user_tab_with_context(self, ctx, tab_id).await
    }

    async fn finalize_tabs_with_context(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        BrowserBackend::finalize_tabs_with_context(self, ctx, params).await
    }

    async fn name_session_with_context(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        BrowserBackend::name_session_with_context(self, ctx, params).await
    }

    async fn turn_ended_with_context(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        BrowserBackend::turn_ended_with_context(self, ctx, params).await
    }

    async fn yield_control_with_context(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        BrowserBackend::yield_control_with_context(self, ctx, params).await
    }

    async fn resume_control_with_context(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        BrowserBackend::resume_control_with_context(self, ctx, params).await
    }

    async fn get_user_history_with_context(
        &self,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> Result<Value> {
        BrowserBackend::get_user_history_with_context(self, ctx, params).await
    }
}

/// Raw CDP attachment and command operations used by the dispatcher.
#[async_trait]
pub(crate) trait CdpBackendOps {
    async fn attach_with_context(&self, ctx: &BackendRequestContext, tab_id: &str) -> Result<()>;
    async fn detach_with_context(&self, ctx: &BackendRequestContext, tab_id: &str) -> Result<()>;
    async fn execute_cdp_with_context(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value>;
}

#[async_trait]
impl<T> CdpBackendOps for T
where
    T: BrowserBackend + ?Sized,
{
    async fn attach_with_context(&self, ctx: &BackendRequestContext, tab_id: &str) -> Result<()> {
        BrowserBackend::attach_with_context(self, ctx, tab_id).await
    }

    async fn detach_with_context(&self, ctx: &BackendRequestContext, tab_id: &str) -> Result<()> {
        BrowserBackend::detach_with_context(self, ctx, tab_id).await
    }

    async fn execute_cdp_with_context(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        BrowserBackend::execute_cdp_with_context(self, ctx, tab_id, method, params).await
    }
}

/// Browser-level control operations used by the dispatcher.
#[async_trait]
pub(crate) trait BrowserControlOps {
    async fn browser_command_with_context(
        &self,
        ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value>;
}

#[async_trait]
impl<T> BrowserControlOps for T
where
    T: BrowserBackend + ?Sized,
{
    async fn browser_command_with_context(
        &self,
        ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        BrowserBackend::browser_command_with_context(self, ctx, method, params).await
    }
}

/// Coordinate and DOM-CUA operations used by the dispatcher.
#[async_trait]
pub(crate) trait CuaBackendOps {
    async fn cua_command_with_context(
        &self,
        ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value>;
}

#[async_trait]
impl<T> CuaBackendOps for T
where
    T: BrowserBackend + ?Sized,
{
    async fn cua_command_with_context(
        &self,
        ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        BrowserBackend::cua_command_with_context(self, ctx, method, params).await
    }
}

/// Playwright-shaped page operations used by the dispatcher.
#[async_trait]
pub(crate) trait PlaywrightBackendOps {
    async fn playwright_command_with_context(
        &self,
        ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value>;
}

#[async_trait]
impl<T> PlaywrightBackendOps for T
where
    T: BrowserBackend + ?Sized,
{
    async fn playwright_command_with_context(
        &self,
        ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        BrowserBackend::playwright_command_with_context(self, ctx, method, params).await
    }
}

/// Generic tab operations used by the dispatcher.
#[async_trait]
pub(crate) trait TabBackendOps {
    async fn tab_command_with_context(
        &self,
        ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value>;
}

#[async_trait]
impl<T> TabBackendOps for T
where
    T: BrowserBackend + ?Sized,
{
    async fn tab_command_with_context(
        &self,
        ctx: &BackendRequestContext,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        BrowserBackend::tab_command_with_context(self, ctx, method, params).await
    }
}

pub mod cdp;
pub mod webext;

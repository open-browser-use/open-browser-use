//! Browser backend abstraction.

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

/// Methods that are known not to be supported by a backend kind.
pub fn unsupported_methods(kind: BackendKind) -> &'static [&'static str] {
    match kind {
        BackendKind::Cdp => &[
            methods::GET_USER_HISTORY,
            methods::CUA_DOWNLOAD_MEDIA,
            methods::DOM_CUA_GET_VISIBLE_DOM,
            methods::DOM_CUA_CLICK,
            methods::DOM_CUA_DOUBLE_CLICK,
            methods::DOM_CUA_SCROLL,
            methods::DOM_CUA_TYPE,
            methods::DOM_CUA_KEYPRESS,
            methods::DOM_CUA_DOWNLOAD_MEDIA,
            methods::TAB_CLIPBOARD_READ_TEXT,
            methods::TAB_CLIPBOARD_WRITE_TEXT,
            methods::TAB_CLIPBOARD_READ,
            methods::TAB_CLIPBOARD_WRITE,
        ],
        BackendKind::WebExtension => &[],
    }
}

/// Whether a backend kind advertises support for an inbound method.
pub fn method_supported(kind: BackendKind, method: &str) -> bool {
    !unsupported_methods(kind).contains(&method)
}

/// Stable capability payload exposed by `getInfo`.
pub fn capabilities_for_kind(kind: BackendKind) -> Value {
    let unsupported = unsupported_methods(kind);
    let supported = methods::ALL_INBOUND_METHODS
        .iter()
        .copied()
        .filter(|method| !unsupported.contains(method))
        .collect::<Vec<_>>();
    json!({
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
            "dom_cua_get_visible_dom": true
        },
    })
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

pub mod cdp;
pub mod webext;

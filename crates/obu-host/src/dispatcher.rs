//! JSON-RPC dispatcher for one authenticated SDK peer.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Mutex, Semaphore, mpsc};
use tokio_util::codec::Framed;
use tokio_util::sync::CancellationToken;
use url::Url;

use obu_wire::{
    ErrorCode, ErrorObject, FrameCodec, Request, Response, RpcMessage,
    envelope::Id,
    error::{
        ERR_CDP_FAILURE, ERR_DIALOG_REQUIRES_DECISION, ERR_OVERLOADED, ERR_PAGE_CLOSED,
        ERR_TAB_NOT_ATTACHED,
    },
    error::{ERR_IO, ERR_NO_BACKEND, ERR_NOT_IMPLEMENTED, ERR_PEER_AUTH, ERR_PROTOCOL},
};

use crate::backends::{BackendRequestContext, BrowserBackend, webext::WebExtensionBackend};
use crate::error::{HostError, Result};
use crate::methods;
use crate::peer_auth::check_capability_token;
use crate::policy::{
    HostPolicy, MethodPolicyKind, PermissivePolicy, PolicyContext, guard_mode_disabled,
};

/// Default number of concurrent JSON-RPC requests allowed for one peer.
pub const DEFAULT_MAX_IN_FLIGHT_REQUESTS: usize = 64;

/// Per-session JSON-RPC dispatcher.
#[derive(Clone)]
pub struct Dispatcher {
    inner: Arc<DispatcherInner>,
}

struct DispatcherInner {
    host_version: String,
    backend: Arc<dyn BrowserBackend>,
    policy: Arc<dyn HostPolicy>,
    session_operation_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    tab_operation_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Dispatcher {
    /// Construct a dispatcher around one browser backend.
    pub fn new(host_version: String, backend: Arc<dyn BrowserBackend>) -> Self {
        Self {
            inner: Arc::new(DispatcherInner {
                host_version,
                backend,
                policy: Arc::new(PermissivePolicy),
                session_operation_locks: Mutex::new(HashMap::new()),
                tab_operation_locks: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Construct a dispatcher around one browser backend and explicit policy.
    pub fn new_with_policy(
        host_version: String,
        backend: Arc<dyn BrowserBackend>,
        policy: Arc<dyn HostPolicy>,
    ) -> Self {
        Self {
            inner: Arc::new(DispatcherInner {
                host_version,
                backend,
                policy,
                session_operation_locks: Mutex::new(HashMap::new()),
                tab_operation_locks: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Test dispatcher using the default WebExtension backend.
    pub fn new_for_test() -> Self {
        Self::new(
            env!("CARGO_PKG_VERSION").into(),
            Arc::new(WebExtensionBackend::default()),
        )
    }

    /// Serve one authenticated peer stream.
    pub async fn serve_peer<S>(&self, stream: S, cap_token: Option<&str>) -> Result<()>
    where
        S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        self.serve_peer_with_max_in_flight(stream, cap_token, DEFAULT_MAX_IN_FLIGHT_REQUESTS)
            .await
    }

    /// Serve one peer with a custom concurrency limit.
    #[doc(hidden)]
    pub async fn serve_peer_with_max_in_flight_for_tests<S>(
        &self,
        stream: S,
        cap_token: Option<&str>,
        max_in_flight_requests: usize,
    ) -> Result<()>
    where
        S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        self.serve_peer_with_max_in_flight(stream, cap_token, max_in_flight_requests)
            .await
    }

    async fn serve_peer_with_max_in_flight<S>(
        &self,
        stream: S,
        cap_token: Option<&str>,
        max_in_flight_requests: usize,
    ) -> Result<()>
    where
        S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        let mut framed = Framed::new(stream, FrameCodec);
        let mut first_frame = None;

        let Some(first) = framed.next().await else {
            return Ok(());
        };
        let first = first?;
        match serde_json::from_slice::<Request>(&first) {
            Ok(req) if req.method == "auth" => {
                let response = self.handle_auth(req, cap_token);
                let authorized = response.error.is_none();
                framed.send(encode_response(&response)?).await?;
                if !authorized {
                    return Ok(());
                }
            }
            _ if cap_token.is_some() => {
                let response = Response::err(
                    Id::Number(0),
                    ErrorObject::new(
                        ErrorCode::Server(ERR_PEER_AUTH),
                        "first frame must be auth when capability token is enabled",
                    ),
                );
                framed.send(encode_response(&response)?).await?;
                return Ok(());
            }
            _ => first_frame = Some(first),
        }

        let (mut sink, mut stream) = framed.split();
        let (tx, mut rx) = mpsc::channel::<Bytes>(128);
        let request_slots = Arc::new(Semaphore::new(max_in_flight_requests.max(1)));
        let peer_cancel = CancellationToken::new();
        let writer = tokio::spawn(async move {
            while let Some(bytes) = rx.recv().await {
                if sink.send(bytes).await.is_err() {
                    break;
                }
            }
        });

        if let Some(bytes) = first_frame.take() {
            self.dispatch_frame(bytes, &tx, request_slots.clone(), peer_cancel.clone())
                .await;
        }

        let read_result = async {
            while let Some(frame) = stream.next().await {
                let bytes = frame?;
                self.dispatch_frame(bytes, &tx, request_slots.clone(), peer_cancel.clone())
                    .await;
            }
            Ok(())
        }
        .await;

        peer_cancel.cancel();
        drop(tx);
        let _ = writer.await;
        read_result
    }

    fn handle_auth(&self, req: Request, cap_token: Option<&str>) -> Response {
        if let Some(expected) = cap_token {
            let presented = req.params.get("capability_token").and_then(Value::as_str);
            if !check_capability_token(Some(expected), presented) {
                return Response::err(
                    req.id,
                    ErrorObject::new(
                        ErrorCode::Server(ERR_PEER_AUTH),
                        "capability token mismatch",
                    ),
                );
            }
        }
        Response::ok(req.id, Value::Null)
    }

    async fn dispatch_frame(
        &self,
        bytes: Bytes,
        tx: &mpsc::Sender<Bytes>,
        request_slots: Arc<Semaphore>,
        peer_cancel: CancellationToken,
    ) {
        let message = match serde_json::from_slice::<RpcMessage>(&bytes) {
            Ok(message) => message,
            Err(error) => {
                tracing::warn!(%error, "dropping malformed JSON-RPC frame");
                return;
            }
        };
        let RpcMessage::Request(request) = message else {
            return;
        };
        let Ok(permit) = request_slots.try_acquire_owned() else {
            let response = Response::err(
                request.id,
                ErrorObject::new(
                    ErrorCode::Server(ERR_OVERLOADED),
                    "too many in-flight requests for this peer",
                ),
            );
            if let Ok(bytes) = encode_response(&response) {
                let _ = tx.send(bytes).await;
            }
            return;
        };
        let dispatcher = self.clone();
        let tx = tx.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let id = request.id.clone();
            let method = request.method.clone();
            let timeout_ms = request_context(&request.params).client_timeout_ms;
            let route = crate::backends::scope_client_timeout(timeout_ms, async move {
                match timeout_ms {
                    Some(timeout_ms) => match tokio::time::timeout(
                        Duration::from_millis(timeout_ms),
                        dispatcher.route_request(request),
                    )
                    .await
                    {
                        Ok(response) => response,
                        Err(_) => Response::err(
                            id,
                            ErrorObject::new(
                                ErrorCode::Server(obu_wire::error::ERR_TIMEOUT),
                                format!("{method} request timed out after {timeout_ms}ms"),
                            ),
                        ),
                    },
                    None => dispatcher.route_request(request).await,
                }
            });
            let response = tokio::select! {
                _ = peer_cancel.cancelled() => return,
                response = route => response,
            };
            if let Ok(bytes) = encode_response(&response) {
                let _ = tx.send(bytes).await;
            }
        });
    }

    async fn route_request(&self, req: Request) -> Response {
        let ctx = request_context(&req.params);
        if !self.inner.backend.supports_method(&req.method) {
            let backend = self.inner.backend.kind().as_str();
            return Response::err(
                req.id,
                unsupported_backend_capability_error(backend, &req.method),
            );
        }
        let session_lock = match session_mutation_key(&req.method, &ctx) {
            Some(session_id) => Some(self.session_operation_lock(&session_id).await),
            None => None,
        };
        let _session_guard = match &session_lock {
            Some(lock) => Some(lock.lock().await),
            None => None,
        };
        if let Some(tab_id) = tab_mutation_key(&req.method, &req.params) {
            let lock = self.tab_operation_lock(&tab_id).await;
            let _guard = lock.lock().await;
            return self.route_supported_request(req, ctx).await;
        }
        self.route_supported_request(req, ctx).await
    }

    async fn route_supported_request(&self, req: Request, ctx: BackendRequestContext) -> Response {
        if let Err(error) = self.enforce_policy(&ctx, &req).await {
            return Response::err(req.id, error);
        }
        let result = match req.method.as_str() {
            methods::PING => self
                .inner
                .backend
                .ping()
                .await
                .map(|value| Value::String(value.into()))
                .map_err(host_err_to_rpc),
            methods::GET_INFO => Ok(self.get_info()),
            methods::ATTACH => match params_str(&req.params, "tab_id") {
                Some(tab_id) => self
                    .inner
                    .backend
                    .attach_with_context(&ctx, &tab_id)
                    .await
                    .map(|()| Value::Null)
                    .map_err(host_err_to_rpc),
                None => Err(invalid_params("missing tab_id")),
            },
            methods::DETACH => match params_str(&req.params, "tab_id") {
                Some(tab_id) => self
                    .inner
                    .backend
                    .detach_with_context(&ctx, &tab_id)
                    .await
                    .map(|()| Value::Null)
                    .map_err(host_err_to_rpc),
                None => Err(invalid_params("missing tab_id")),
            },
            methods::CREATE_TAB => self
                .inner
                .backend
                .create_tab_with_context(&ctx, params_str(&req.params, "url"))
                .await
                .map_err(host_err_to_rpc),
            methods::GET_TABS => self
                .inner
                .backend
                .list_tabs_with_context(&ctx)
                .await
                .map_err(host_err_to_rpc),
            methods::GET_CURRENT_TAB => self
                .inner
                .backend
                .current_tab_with_context(&ctx)
                .await
                .map_err(host_err_to_rpc),
            methods::GET_SELECTED_TAB => self
                .inner
                .backend
                .selected_tab_with_context(&ctx)
                .await
                .map_err(host_err_to_rpc),
            methods::GET_USER_TABS => self
                .inner
                .backend
                .list_user_tabs_with_context(&ctx)
                .await
                .map_err(host_err_to_rpc),
            methods::CLAIM_USER_TAB => match params_tab_id(&req.params) {
                Some(tab_id) => self
                    .inner
                    .backend
                    .claim_user_tab_with_context(&ctx, &tab_id)
                    .await
                    .map_err(host_err_to_rpc),
                None => Err(invalid_params("missing tab_id")),
            },
            methods::FINALIZE_TABS => self
                .inner
                .backend
                .finalize_tabs_with_context(&ctx, req.params)
                .await
                .map_err(host_err_to_rpc),
            methods::NAME_SESSION => self
                .inner
                .backend
                .name_session_with_context(&ctx, req.params)
                .await
                .map_err(host_err_to_rpc),
            methods::TURN_ENDED => self
                .inner
                .backend
                .turn_ended_with_context(&ctx, req.params)
                .await
                .map_err(host_err_to_rpc),
            methods::YIELD_CONTROL => self
                .inner
                .backend
                .yield_control_with_context(&ctx, req.params)
                .await
                .map_err(host_err_to_rpc),
            methods::RESUME_CONTROL => self
                .inner
                .backend
                .resume_control_with_context(&ctx, req.params)
                .await
                .map_err(host_err_to_rpc),
            methods::CLEAR_LIFECYCLE_DIAGNOSTICS => self
                .inner
                .backend
                .clear_lifecycle_diagnostics()
                .map_err(host_err_to_rpc),
            methods::GET_USER_HISTORY => self
                .inner
                .backend
                .get_user_history_with_context(&ctx, req.params)
                .await
                .map_err(host_err_to_rpc),
            methods::BROWSER_TABS_CONTENT => self.fetch_browser_tabs_content(&req.params).await,
            methods::BROWSER_VIEWPORT_SET
            | methods::BROWSER_VIEWPORT_RESET
            | methods::BROWSER_VISIBILITY_SET
            | methods::BROWSER_VISIBILITY_GET => self
                .inner
                .backend
                .browser_command_with_context(&ctx, &req.method, req.params)
                .await
                .map_err(host_err_to_rpc),
            methods::EXECUTE_CDP => {
                let tab_id = match cdp_tab_id(&req.params) {
                    Ok(tab_id) => tab_id,
                    Err(error) => return Response::err(req.id, error),
                };
                let method = params_str(&req.params, "method").unwrap_or_default();
                let params = req
                    .params
                    .get("commandParams")
                    .cloned()
                    .or_else(|| req.params.get("params").cloned())
                    .unwrap_or(Value::Null);
                self.inner
                    .backend
                    .execute_cdp_with_context(&ctx, &tab_id, &method, params)
                    .await
                    .map_err(host_err_to_rpc)
            }
            methods::MOVE_MOUSE => self
                .inner
                .backend
                .cua_command_with_context(&ctx, methods::CUA_MOVE, req.params)
                .await
                .map_err(host_err_to_rpc),
            methods::CUA_CLICK
            | methods::CUA_DBLCLICK
            | methods::CUA_SCROLL
            | methods::CUA_TYPE
            | methods::CUA_KEYPRESS
            | methods::CUA_DRAG
            | methods::CUA_MOVE
            | methods::CUA_DOWNLOAD_MEDIA
            | methods::DOM_CUA_GET_VISIBLE_DOM
            | methods::DOM_CUA_CLICK
            | methods::DOM_CUA_DOUBLE_CLICK
            | methods::DOM_CUA_SCROLL
            | methods::DOM_CUA_TYPE
            | methods::DOM_CUA_KEYPRESS
            | methods::DOM_CUA_DOWNLOAD_MEDIA => self
                .inner
                .backend
                .cua_command_with_context(&ctx, &req.method, req.params)
                .await
                .map_err(host_err_to_rpc),
            methods::PLAYWRIGHT_LOCATOR_CLICK
            | methods::PLAYWRIGHT_LOCATOR_DBLCLICK
            | methods::PLAYWRIGHT_LOCATOR_DOWNLOAD_MEDIA
            | methods::PLAYWRIGHT_LOCATOR_FILL
            | methods::PLAYWRIGHT_LOCATOR_PRESS
            | methods::PLAYWRIGHT_LOCATOR_WAIT_FOR
            | methods::PLAYWRIGHT_LOCATOR_COUNT
            | methods::PLAYWRIGHT_LOCATOR_SELECT_OPTION
            | methods::PLAYWRIGHT_LOCATOR_SET_CHECKED
            | methods::PLAYWRIGHT_LOCATOR_IS_VISIBLE
            | methods::PLAYWRIGHT_LOCATOR_IS_ENABLED
            | methods::PLAYWRIGHT_LOCATOR_ALL_TEXT_CONTENTS
            | methods::PLAYWRIGHT_LOCATOR_TEXT_CONTENT
            | methods::PLAYWRIGHT_LOCATOR_INNER_TEXT
            | methods::PLAYWRIGHT_LOCATOR_GET_ATTRIBUTE
            | methods::PLAYWRIGHT_LOCATOR_READ_ALL
            | methods::PLAYWRIGHT_LOCATOR_HOVER
            | methods::PLAYWRIGHT_LOCATOR_BOUNDING_BOX
            | methods::PLAYWRIGHT_SCREENSHOT
            | methods::PLAYWRIGHT_DOM_SNAPSHOT
            | methods::PLAYWRIGHT_WAIT_FOR_TIMEOUT
            | methods::PLAYWRIGHT_WAIT_FOR_URL
            | methods::PLAYWRIGHT_WAIT_FOR_LOAD_STATE
            | methods::PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER
            | methods::PLAYWRIGHT_FILE_CHOOSER_SET_FILES
            | methods::PLAYWRIGHT_WAIT_FOR_DOWNLOAD
            | methods::PLAYWRIGHT_DOWNLOAD_PATH => self
                .inner
                .backend
                .playwright_command_with_context(&ctx, &req.method, req.params)
                .await
                .map_err(host_err_to_rpc),
            methods::TAB_GOTO
            | methods::TAB_RELOAD
            | methods::TAB_BACK
            | methods::TAB_FORWARD
            | methods::TAB_CLOSE
            | methods::TAB_SCREENSHOT
            | methods::TAB_WAIT_FOR_URL
            | methods::TAB_WAIT_FOR_LOAD_STATE
            | methods::TAB_CONTENT_EXPORT
            | methods::TAB_URL
            | methods::TAB_TITLE
            | methods::TAB_CLIPBOARD_READ_TEXT
            | methods::TAB_CLIPBOARD_WRITE_TEXT
            | methods::TAB_CLIPBOARD_READ
            | methods::TAB_CLIPBOARD_WRITE => self
                .inner
                .backend
                .tab_command_with_context(&ctx, &req.method, req.params)
                .await
                .map_err(host_err_to_rpc),
            methods::EXECUTE_UNHANDLED_COMMAND => Err(host_err_to_rpc(HostError::NotImplemented(
                "executeUnhandledCommand".into(),
            ))),
            _ => Err(ErrorObject::new(
                ErrorCode::MethodNotFound,
                format!("method not found: {}", req.method),
            )),
        };

        match result {
            Ok(value) => Response::ok(req.id, value),
            Err(error) => Response::err(req.id, error),
        }
    }

    async fn tab_operation_lock(&self, tab_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.inner.tab_operation_locks.lock().await;
        locks
            .entry(tab_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn session_operation_lock(&self, session_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.inner.session_operation_locks.lock().await;
        locks
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn enforce_policy(
        &self,
        ctx: &BackendRequestContext,
        req: &Request,
    ) -> std::result::Result<(), ErrorObject> {
        if guard_mode_disabled() || !methods::ALL_INBOUND_METHODS.contains(&req.method.as_str()) {
            return Ok(());
        }
        let kind = crate::policy::classify_method(&req.method);
        let tab_id = params_tab_id(&req.params);
        let policy_ctx = PolicyContext {
            command: &req.method,
            kind,
            tab_id: tab_id.as_deref(),
            params: &req.params,
        };
        match kind {
            MethodPolicyKind::AlwaysAllowed | MethodPolicyKind::InternalLifecycle => Ok(()),
            MethodPolicyKind::TargetUrl => {
                if let Some(url) = params_str(&req.params, "url") {
                    self.inner.policy.check_navigation(&url, &policy_ctx)?;
                }
                Ok(())
            }
            MethodPolicyKind::CurrentOrigin => {
                self.enforce_current_origin_policy(ctx, &req.method, tab_id.as_deref(), &policy_ctx)
                    .await
            }
            MethodPolicyKind::History => self.inner.policy.check_history(&policy_ctx),
            MethodPolicyKind::Download => {
                self.enforce_current_origin_policy(
                    ctx,
                    &req.method,
                    tab_id.as_deref(),
                    &policy_ctx,
                )
                .await?;
                self.inner.policy.check_download(&policy_ctx)
            }
            MethodPolicyKind::Upload => {
                self.enforce_current_origin_policy(
                    ctx,
                    &req.method,
                    tab_id.as_deref(),
                    &policy_ctx,
                )
                .await?;
                self.inner.policy.check_upload(&policy_ctx)
            }
            MethodPolicyKind::RawCdp => {
                let tab_id = cdp_tab_id(&req.params)?;
                let method = params_str(&req.params, "method").unwrap_or_default();
                let params = req
                    .params
                    .get("commandParams")
                    .or_else(|| req.params.get("params"))
                    .unwrap_or(&Value::Null);
                self.enforce_current_origin_policy(ctx, &req.method, Some(&tab_id), &policy_ctx)
                    .await?;
                if let Some(url) = params_str(params, "url") {
                    self.inner.policy.check_navigation(&url, &policy_ctx)?;
                }
                self.inner
                    .policy
                    .check_raw_cdp(&tab_id, &method, params, &policy_ctx)
            }
        }
    }

    async fn enforce_current_origin_policy(
        &self,
        ctx: &BackendRequestContext,
        command: &str,
        tab_id: Option<&str>,
        policy_ctx: &PolicyContext<'_>,
    ) -> std::result::Result<(), ErrorObject> {
        if !self.inner.policy.needs_current_origin(command) {
            return Ok(());
        }
        let Some(tab_id) = tab_id else {
            return Err(invalid_params("missing tab_id for current-origin policy"));
        };
        let current_url = self
            .inner
            .backend
            .tab_command_with_context(ctx, methods::TAB_URL, json!({ "tab_id": tab_id }))
            .await
            .map_err(host_err_to_rpc)?;
        let url = current_url.as_str().ok_or_else(|| {
            invalid_params("current-origin policy expected tab_url string response")
        })?;
        self.inner
            .policy
            .check_current_origin(tab_id, url, policy_ctx)
    }

    fn get_info(&self) -> Value {
        let backend_metadata = self.inner.backend.metadata();
        let mut metadata = json!({
            "host_version": self.inner.host_version,
            "backend": backend_metadata,
            "diagnostics": self.inner.backend.diagnostics(),
        });
        expose_public_profile_metadata(&mut metadata);
        json!({
            "type": self.inner.backend.kind().as_str(),
            "name": self.inner.backend.id(),
            "metadata": metadata,
            "capabilities": self.inner.backend.capabilities(),
        })
    }

    async fn fetch_browser_tabs_content(
        &self,
        params: &Value,
    ) -> std::result::Result<Value, ErrorObject> {
        let urls = params_urls(params)?;
        let content_type = params
            .get("contentType")
            .or_else(|| params.get("content_type"))
            .and_then(Value::as_str)
            .unwrap_or("text");
        if !matches!(content_type, "text" | "html" | "json") {
            return Ok(json!({
                "results": urls.into_iter().map(|url| json!({
                    "url": url,
                    "status": "error",
                    "errorCode": "unsupported_content_type",
                    "errorMessage": format!("unsupported contentType: {content_type}")
                })).collect::<Vec<_>>()
            }));
        }

        let timeout = params
            .get("timeout")
            .and_then(Value::as_u64)
            .map(Duration::from_millis)
            .unwrap_or_else(|| Duration::from_secs(30));
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(timeout)
            .build()
            .map_err(|error| {
                ErrorObject::new(
                    ErrorCode::InternalError,
                    format!("failed to build content HTTP client: {error}"),
                )
            })?;
        let policy_ctx = PolicyContext {
            command: methods::BROWSER_TABS_CONTENT,
            kind: MethodPolicyKind::TargetUrl,
            tab_id: None,
            params,
        };
        let mut results = Vec::with_capacity(urls.len());
        for url in urls {
            results.push(
                fetch_one_content_url(&client, &*self.inner.policy, &policy_ctx, url, timeout)
                    .await,
            );
        }
        Ok(json!({ "results": results }))
    }
}

async fn fetch_one_content_url(
    client: &reqwest::Client,
    policy: &dyn HostPolicy,
    policy_ctx: &PolicyContext<'_>,
    original_url: String,
    timeout: Duration,
) -> Value {
    let mut current = match Url::parse(&original_url) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => url,
        Ok(_) => {
            return json!({
                "url": original_url,
                "status": "error",
                "errorCode": "unsupported_url_scheme",
                "errorMessage": "only http and https URLs are supported"
            });
        }
        Err(error) => {
            return json!({
                "url": original_url,
                "status": "error",
                "errorCode": "invalid_url",
                "errorMessage": error.to_string()
            });
        }
    };
    let mut redirects = Vec::new();
    let deadline = Instant::now() + timeout;
    if let Err(error) = policy.check_navigation(current.as_str(), policy_ctx) {
        return json!({
            "url": original_url,
            "finalUrl": current.as_str(),
            "status": "error",
            "redirects": redirects,
            "errorCode": "navigation_disallowed",
            "errorMessage": error.message
        });
    }
    for _ in 0..10 {
        let Some(remaining) = remaining_content_fetch_budget(deadline) else {
            return content_fetch_timeout_error(&original_url, &current, &redirects);
        };
        let response = match client.get(current.clone()).timeout(remaining).send().await {
            Ok(response) => response,
            Err(error) => {
                let message = if error.is_timeout() {
                    "per-URL timeout exceeded".to_string()
                } else {
                    error.to_string()
                };
                return json!({
                    "url": original_url,
                    "finalUrl": current.as_str(),
                    "status": "error",
                    "redirects": redirects,
                    "errorCode": "fetch_failed",
                    "errorMessage": message
                });
            }
        };
        let status = response.status();
        if status.is_redirection() {
            let Some(location) = response.headers().get(reqwest::header::LOCATION) else {
                return json!({
                    "url": original_url,
                    "finalUrl": current.as_str(),
                    "status": "error",
                    "redirects": redirects,
                    "httpStatus": status.as_u16(),
                    "errorCode": "redirect_missing_location",
                    "errorMessage": "redirect response did not include Location"
                });
            };
            let Ok(location) = location.to_str() else {
                return json!({
                    "url": original_url,
                    "finalUrl": current.as_str(),
                    "status": "error",
                    "redirects": redirects,
                    "httpStatus": status.as_u16(),
                    "errorCode": "invalid_redirect",
                    "errorMessage": "redirect Location is not valid UTF-8"
                });
            };
            let next = match current.join(location) {
                Ok(url) => url,
                Err(error) => {
                    return json!({
                        "url": original_url,
                        "finalUrl": current.as_str(),
                        "status": "error",
                        "redirects": redirects,
                        "httpStatus": status.as_u16(),
                        "errorCode": "invalid_redirect",
                        "errorMessage": error.to_string()
                    });
                }
            };
            if let Err(error) = policy.check_navigation(next.as_str(), policy_ctx) {
                return json!({
                    "url": original_url,
                    "finalUrl": current.as_str(),
                    "status": "error",
                    "redirects": redirects,
                    "httpStatus": status.as_u16(),
                    "errorCode": "navigation_disallowed",
                    "errorMessage": error.message
                });
            }
            redirects.push(next.as_str().to_string());
            current = next;
            continue;
        }
        let http_status = status.as_u16();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let Some(remaining) = remaining_content_fetch_budget(deadline) else {
            return content_fetch_timeout_error(&original_url, &current, &redirects);
        };
        return match tokio::time::timeout(remaining, response.text()).await {
            Ok(Ok(text)) => json!({
                "url": original_url,
                "finalUrl": current.as_str(),
                "status": "ok",
                "redirects": redirects,
                "httpStatus": http_status,
                "contentType": content_type,
                "text": text
            }),
            Ok(Err(error)) => json!({
                "url": original_url,
                "finalUrl": current.as_str(),
                "status": "error",
                "redirects": redirects,
                "httpStatus": http_status,
                "contentType": content_type,
                "errorCode": "read_failed",
                "errorMessage": error.to_string()
            }),
            Err(_) => content_fetch_timeout_error(&original_url, &current, &redirects),
        };
    }
    json!({
        "url": original_url,
        "finalUrl": current.as_str(),
        "status": "error",
        "redirects": redirects,
        "errorCode": "too_many_redirects",
        "errorMessage": "redirect limit exceeded"
    })
}

fn remaining_content_fetch_budget(deadline: Instant) -> Option<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
}

fn content_fetch_timeout_error(original_url: &str, current: &Url, redirects: &[String]) -> Value {
    json!({
        "url": original_url,
        "finalUrl": current.as_str(),
        "status": "error",
        "redirects": redirects,
        "errorCode": "fetch_failed",
        "errorMessage": "per-URL timeout exceeded"
    })
}

fn encode_response(response: &Response) -> Result<Bytes> {
    serde_json::to_vec(response)
        .map(Bytes::from)
        .map_err(|error| HostError::Protocol(error.to_string()))
}

fn params_str(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(String::from)
}

fn params_urls(value: &Value) -> std::result::Result<Vec<String>, ErrorObject> {
    let Some(urls) = value.get("urls").and_then(Value::as_array) else {
        return Err(invalid_params("missing urls array"));
    };
    if urls.is_empty() {
        return Err(invalid_params("urls array must not be empty"));
    }
    urls.iter()
        .map(|value| {
            value
                .as_str()
                .filter(|url| !url.is_empty())
                .map(str::to_string)
                .ok_or_else(|| invalid_params("urls entries must be non-empty strings"))
        })
        .collect()
}

fn expose_public_profile_metadata(metadata: &mut Value) {
    let backend = metadata.get("backend").cloned().unwrap_or(Value::Null);
    let Some(object) = metadata.as_object_mut() else {
        return;
    };
    for key in [
        "profileIdHash",
        "profileIsLastUsed",
        "profileOrdering",
        "profileRuntimeBinding",
    ] {
        if let Some(value) = backend.get(key).filter(|value| !value.is_null()) {
            object.insert(key.to_string(), value.clone());
        }
    }
    if let Some(value) = backend
        .pointer("/profile_metadata/diagnostics/profilePathRedacted")
        .cloned()
    {
        let diagnostics = object
            .entry("diagnostics".to_string())
            .or_insert_with(|| json!({}));
        if let Some(diagnostics) = diagnostics.as_object_mut() {
            diagnostics.insert("profilePathRedacted".to_string(), value);
        }
    }
}

fn params_tab_id(value: &Value) -> Option<String> {
    params_str(value, "tab_id")
        .or_else(|| params_str(value, "tabId"))
        .or_else(|| {
            value
                .get("tabId")
                .and_then(Value::as_i64)
                .map(|value| value.to_string())
        })
        .or_else(|| {
            value
                .get("target")
                .and_then(|target| params_str(target, "tabId"))
        })
        .or_else(|| {
            value
                .get("target")
                .and_then(|target| target.get("tabId"))
                .and_then(Value::as_i64)
                .map(|value| value.to_string())
        })
}

fn cdp_tab_id(value: &Value) -> std::result::Result<String, ErrorObject> {
    if let Some(target) = value.get("target") {
        if target.get("targetId").is_some() {
            return Err(invalid_params(
                "target.targetId is not allowed; use target.tabId",
            ));
        }
        if target.get("sessionId").is_some() {
            return Err(invalid_params(
                "target.sessionId is not allowed; use target.tabId",
            ));
        }
    }
    params_tab_id(value).ok_or_else(|| invalid_params("missing tab_id or target.tabId"))
}

fn tab_mutation_key(method: &str, params: &Value) -> Option<String> {
    if !is_tab_mutating_method(method) {
        return None;
    }
    params_tab_id(params)
}

fn session_mutation_key(method: &str, ctx: &BackendRequestContext) -> Option<String> {
    if !is_session_mutating_method(method) {
        return None;
    }
    ctx.session_id.clone()
}

fn is_session_mutating_method(method: &str) -> bool {
    method == methods::CREATE_TAB
        || method == methods::FINALIZE_TABS
        || is_tab_mutating_method(method)
}

fn is_tab_mutating_method(method: &str) -> bool {
    matches!(
        method,
        methods::ATTACH
            | methods::DETACH
            | methods::CLAIM_USER_TAB
            | methods::EXECUTE_CDP
            | methods::MOVE_MOUSE
            | methods::CUA_CLICK
            | methods::CUA_DBLCLICK
            | methods::CUA_SCROLL
            | methods::CUA_TYPE
            | methods::CUA_KEYPRESS
            | methods::CUA_DRAG
            | methods::CUA_MOVE
            | methods::CUA_DOWNLOAD_MEDIA
            | methods::DOM_CUA_CLICK
            | methods::DOM_CUA_DOUBLE_CLICK
            | methods::DOM_CUA_SCROLL
            | methods::DOM_CUA_TYPE
            | methods::DOM_CUA_KEYPRESS
            | methods::DOM_CUA_DOWNLOAD_MEDIA
            | methods::PLAYWRIGHT_LOCATOR_CLICK
            | methods::PLAYWRIGHT_LOCATOR_DBLCLICK
            | methods::PLAYWRIGHT_LOCATOR_DOWNLOAD_MEDIA
            | methods::PLAYWRIGHT_LOCATOR_FILL
            | methods::PLAYWRIGHT_LOCATOR_PRESS
            | methods::PLAYWRIGHT_LOCATOR_SELECT_OPTION
            | methods::PLAYWRIGHT_LOCATOR_SET_CHECKED
            | methods::PLAYWRIGHT_LOCATOR_HOVER
            | methods::PLAYWRIGHT_FILE_CHOOSER_SET_FILES
            | methods::TAB_GOTO
            | methods::TAB_RELOAD
            | methods::TAB_BACK
            | methods::TAB_FORWARD
            | methods::TAB_CLOSE
            | methods::TAB_CLIPBOARD_WRITE_TEXT
            | methods::TAB_CLIPBOARD_WRITE
    )
}

fn request_context(params: &Value) -> BackendRequestContext {
    BackendRequestContext {
        session_id: params_str(params, "session_id"),
        turn_id: params_str(params, "turn_id"),
        client_timeout_ms: params
            .get("client_timeout_ms")
            .or_else(|| params.get("timeoutMs"))
            .and_then(Value::as_u64),
    }
}

fn invalid_params(message: &str) -> ErrorObject {
    ErrorObject::new(ErrorCode::InvalidParams, message)
}

fn unsupported_backend_capability_error(backend: &str, method: &str) -> ErrorObject {
    ErrorObject::new(
        ErrorCode::Server(ERR_NOT_IMPLEMENTED),
        format!("backend {backend} does not support method {method}"),
    )
    .with_data(json!({
        "code": "unsupported_backend_capability",
        "backend": backend,
        "method": method,
        "missing_capability": format!("method:{method}"),
    }))
}

fn host_err_to_rpc(error: HostError) -> ErrorObject {
    let code = match &error {
        HostError::Io(_) | HostError::Frame(_) => ErrorCode::Server(ERR_IO),
        HostError::PeerAuthRefused(_) => ErrorCode::Server(ERR_PEER_AUTH),
        HostError::NoBackendAvailable(_) => ErrorCode::Server(ERR_NO_BACKEND),
        HostError::PageClosed(_) => ErrorCode::Server(ERR_PAGE_CLOSED),
        HostError::Timeout(_) => ErrorCode::Server(obu_wire::error::ERR_TIMEOUT),
        HostError::CdpFailure(_) => ErrorCode::Server(ERR_CDP_FAILURE),
        HostError::TabNotAttached(_) => ErrorCode::Server(ERR_TAB_NOT_ATTACHED),
        HostError::DialogRequiresDecision(_) => ErrorCode::Server(ERR_DIALOG_REQUIRES_DECISION),
        HostError::NotImplemented(_) => ErrorCode::Server(ERR_NOT_IMPLEMENTED),
        HostError::Protocol(_) => ErrorCode::Server(ERR_PROTOCOL),
    };
    let data = match &error {
        HostError::DialogRequiresDecision(dialog) => Some(dialog.data.clone()),
        _ => None,
    };
    let error = ErrorObject::new(code, error.to_string());
    match data {
        Some(data) => error.with_data(data),
        None => error,
    }
}

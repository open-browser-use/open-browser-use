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

use crate::backends::{
    BackendRequestContext, BrowserBackend, BrowserControlOps, CdpBackendOps, CuaBackendOps,
    LifecycleBackendOps, PlaywrightBackendOps, SessionBackendOps, TabBackendOps,
    webext::WebExtensionBackend,
};
use crate::error::{HostError, Result};
use crate::methods;
use crate::peer_lifecycle::{
    PEER_AUTH_REQUIRED_MESSAGE, PeerFirstFrameAction, PeerLifecycleDiagnostics, plan_peer_auth,
    plan_peer_first_frame, plan_peer_request_cancelled, plan_peer_shutdown,
    plan_peer_terminal_close,
};
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
    peer_diagnostics: PeerLifecycleDiagnostics,
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
                peer_diagnostics: PeerLifecycleDiagnostics::default(),
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
                peer_diagnostics: PeerLifecycleDiagnostics::default(),
                session_operation_locks: Mutex::new(HashMap::new()),
                tab_operation_locks: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Construct a dispatcher around one browser backend, explicit policy, and shared peer diagnostics.
    pub fn new_with_policy_and_peer_diagnostics(
        host_version: String,
        backend: Arc<dyn BrowserBackend>,
        policy: Arc<dyn HostPolicy>,
        peer_diagnostics: PeerLifecycleDiagnostics,
    ) -> Self {
        Self {
            inner: Arc::new(DispatcherInner {
                host_version,
                backend,
                policy,
                peer_diagnostics,
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
            self.inner
                .peer_diagnostics
                .record(&plan_peer_terminal_close("peer closed before first frame").event);
            return Ok(());
        };
        let first = match first {
            Ok(bytes) => bytes,
            Err(error) => {
                self.inner
                    .peer_diagnostics
                    .record(&plan_peer_terminal_close("peer closed with invalid first frame").event);
                return Err(error.into());
            }
        };
        let first_request = serde_json::from_slice::<Request>(&first).ok();
        let first_frame_plan = plan_peer_first_frame(
            cap_token.is_some(),
            first_request.as_ref().map(|req| req.method.as_str()),
        );
        self.inner.peer_diagnostics.record(&first_frame_plan.event);
        match first_frame_plan.action {
            PeerFirstFrameAction::Authenticate => {
                let req = first_request.expect("auth first-frame plan requires a parsed request");
                let response = self.handle_auth(req, cap_token);
                let authorized = response.error.is_none();
                framed.send(encode_response(&response)?).await?;
                if !authorized {
                    self.inner
                        .peer_diagnostics
                        .record(&plan_peer_terminal_close("peer rejected during capability authentication").event);
                    return Ok(());
                }
            }
            PeerFirstFrameAction::RejectMissingAuth => {
                let response = Response::err(
                    Id::Number(0),
                    ErrorObject::new(ErrorCode::Server(ERR_PEER_AUTH), PEER_AUTH_REQUIRED_MESSAGE),
                );
                framed.send(encode_response(&response)?).await?;
                self.inner
                    .peer_diagnostics
                    .record(&plan_peer_terminal_close("peer rejected before dispatch: missing auth").event);
                return Ok(());
            }
            PeerFirstFrameAction::DispatchFirstFrame => first_frame = Some(first),
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

        let shutdown_plan = plan_peer_shutdown();
        self.inner.peer_diagnostics.record(&shutdown_plan.event);
        if shutdown_plan.cancel_pending_requests {
            peer_cancel.cancel();
        }
        if shutdown_plan.close_response_channel {
            drop(tx);
        }
        if shutdown_plan.await_writer {
            let _ = writer.await;
        }
        read_result
    }

    fn handle_auth(&self, req: Request, cap_token: Option<&str>) -> Response {
        let presented = req.params.get("capability_token").and_then(Value::as_str);
        let plan = plan_peer_auth(cap_token, presented);
        self.inner.peer_diagnostics.record(&plan.event);
        if let Some(message) = plan.error_message {
            return Response::err(
                req.id,
                ErrorObject::new(ErrorCode::Server(ERR_PEER_AUTH), message),
            );
        }
        Response::ok(req.id, Value::Null)
    }

    fn trace_peer_request_cancelled(plan: &crate::peer_lifecycle::PeerRequestCancellationPlan) {
        tracing::debug!(
            event = ?plan.event.kind,
            reason = plan.event.reason.as_deref(),
            "peer lifecycle"
        );
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
        let peer_diagnostics = dispatcher.inner.peer_diagnostics.clone();
        let tx = tx.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let id = request.id.clone();
            let method = request.method.clone();
            let cancel_method = method.clone();
            let timeout_ms = request_context(&request.params).client_timeout_ms;
            let backend_owns_deadline =
                timeout_ms.is_some() && dispatcher.inner.backend.owns_request_deadline(&method);
            let route = crate::backends::scope_client_timeout(timeout_ms, async move {
                match (timeout_ms, backend_owns_deadline) {
                    (_, true) => dispatcher.route_request(request).await,
                    (Some(timeout_ms), false) => match tokio::time::timeout(
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
                    (None, false) => dispatcher.route_request(request).await,
                }
            });
            let response = tokio::select! {
                _ = peer_cancel.cancelled() => {
                    let cancel_plan = plan_peer_request_cancelled(&cancel_method);
                    Self::trace_peer_request_cancelled(&cancel_plan);
                    peer_diagnostics.record(&cancel_plan.event);
                    if cancel_plan.suppress_response {
                        return;
                    }
                    return;
                },
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
        if let Err(error) = require_mutation_context(&req.method, &ctx) {
            return Response::err(req.id, error);
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
        let id = req.id.clone();
        let result = self
            .route_method_family(&req.method, &ctx, req.params)
            .await;

        match result {
            Ok(value) => Response::ok(id, value),
            Err(error) => Response::err(id, error),
        }
    }

    async fn route_method_family(
        &self,
        method: &str,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> std::result::Result<Value, ErrorObject> {
        match method {
            methods::PING => self.route_lifecycle_request(method, ctx, params).await,
            methods::GET_INFO => self.route_lifecycle_request(method, ctx, params).await,
            methods::TURN_ENDED
            | methods::YIELD_CONTROL
            | methods::RESUME_CONTROL
            | methods::CLEAR_LIFECYCLE_DIAGNOSTICS
            | methods::EXECUTE_UNHANDLED_COMMAND => {
                self.route_lifecycle_request(method, ctx, params).await
            }
            methods::CREATE_TAB
            | methods::GET_TABS
            | methods::GET_CURRENT_TAB
            | methods::GET_SELECTED_TAB
            | methods::GET_USER_TABS
            | methods::CLAIM_USER_TAB
            | methods::FINALIZE_TABS
            | methods::NAME_SESSION
            | methods::GET_USER_HISTORY => self.route_session_request(method, ctx, params).await,
            methods::ATTACH | methods::DETACH | methods::EXECUTE_CDP => {
                self.route_cdp_request(method, ctx, params).await
            }
            methods::BROWSER_TABS_CONTENT
            | methods::BROWSER_VIEWPORT_SET
            | methods::BROWSER_VIEWPORT_RESET
            | methods::BROWSER_VISIBILITY_SET
            | methods::BROWSER_VISIBILITY_GET => {
                self.route_browser_request(method, ctx, params).await
            }
            methods::MOVE_MOUSE
            | methods::CUA_CLICK
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
            | methods::DOM_CUA_DOWNLOAD_MEDIA => self.route_cua_request(method, ctx, params).await,
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
            | methods::PLAYWRIGHT_ELEMENT_INFO
            | methods::PLAYWRIGHT_ELEMENT_SCREENSHOT
            | methods::PLAYWRIGHT_DOM_SNAPSHOT
            | methods::PLAYWRIGHT_WAIT_FOR_TIMEOUT
            | methods::PLAYWRIGHT_WAIT_FOR_URL
            | methods::PLAYWRIGHT_WAIT_FOR_LOAD_STATE
            | methods::PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER
            | methods::PLAYWRIGHT_FILE_CHOOSER_SET_FILES
            | methods::PLAYWRIGHT_WAIT_FOR_DOWNLOAD
            | methods::PLAYWRIGHT_DOWNLOAD_PATH => {
                self.route_playwright_request(method, ctx, params).await
            }
            methods::TAB_GOTO
            | methods::TAB_RELOAD
            | methods::TAB_BACK
            | methods::TAB_FORWARD
            | methods::TAB_CLOSE
            | methods::TAB_SCREENSHOT
            | methods::TAB_WAIT_FOR_URL
            | methods::TAB_WAIT_FOR_LOAD_STATE
            | methods::TAB_CONTENT_EXPORT
            | methods::TAB_EVALUATE
            | methods::TAB_SNAPSHOT_TEXT
            | methods::TAB_URL
            | methods::TAB_TITLE
            | methods::TAB_CLIPBOARD_READ_TEXT
            | methods::TAB_CLIPBOARD_WRITE_TEXT
            | methods::TAB_CLIPBOARD_READ
            | methods::TAB_CLIPBOARD_WRITE => self.route_tab_request(method, ctx, params).await,
            _ => Err(ErrorObject::new(
                ErrorCode::MethodNotFound,
                format!("method not found: {method}"),
            )),
        }
    }

    async fn route_lifecycle_request(
        &self,
        method: &str,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> std::result::Result<Value, ErrorObject> {
        match method {
            methods::PING => LifecycleBackendOps::ping(self.inner.backend.as_ref())
                .await
                .map(|value| Value::String(value.into()))
                .map_err(host_err_to_rpc),
            methods::GET_INFO => Ok(self.get_info()),
            methods::TURN_ENDED => {
                SessionBackendOps::turn_ended_with_context(self.inner.backend.as_ref(), ctx, params)
                    .await
                    .map_err(host_err_to_rpc)
            }
            methods::YIELD_CONTROL => SessionBackendOps::yield_control_with_context(
                self.inner.backend.as_ref(),
                ctx,
                params,
            )
            .await
            .map_err(host_err_to_rpc),
            methods::RESUME_CONTROL => SessionBackendOps::resume_control_with_context(
                self.inner.backend.as_ref(),
                ctx,
                params,
            )
            .await
            .map_err(host_err_to_rpc),
            methods::CLEAR_LIFECYCLE_DIAGNOSTICS => {
                LifecycleBackendOps::clear_lifecycle_diagnostics(self.inner.backend.as_ref())
                    .map_err(host_err_to_rpc)
            }
            methods::EXECUTE_UNHANDLED_COMMAND => Err(host_err_to_rpc(HostError::NotImplemented(
                "executeUnhandledCommand".into(),
            ))),
            _ => Err(ErrorObject::new(
                ErrorCode::MethodNotFound,
                format!("method not found: {method}"),
            )),
        }
    }

    async fn route_session_request(
        &self,
        method: &str,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> std::result::Result<Value, ErrorObject> {
        match method {
            methods::CREATE_TAB => SessionBackendOps::create_tab_with_context(
                self.inner.backend.as_ref(),
                ctx,
                params_str(&params, "url"),
            )
            .await
            .map_err(host_err_to_rpc),
            methods::GET_TABS => {
                SessionBackendOps::list_tabs_with_context(self.inner.backend.as_ref(), ctx)
                    .await
                    .map_err(host_err_to_rpc)
            }
            methods::GET_CURRENT_TAB => {
                SessionBackendOps::current_tab_with_context(self.inner.backend.as_ref(), ctx)
                    .await
                    .map_err(host_err_to_rpc)
            }
            methods::GET_SELECTED_TAB => {
                SessionBackendOps::selected_tab_with_context(self.inner.backend.as_ref(), ctx)
                    .await
                    .map_err(host_err_to_rpc)
            }
            methods::GET_USER_TABS => {
                SessionBackendOps::list_user_tabs_with_context(self.inner.backend.as_ref(), ctx)
                    .await
                    .map_err(host_err_to_rpc)
            }
            methods::CLAIM_USER_TAB => match params_tab_id(&params) {
                Some(tab_id) => SessionBackendOps::claim_user_tab_with_context(
                    self.inner.backend.as_ref(),
                    ctx,
                    &tab_id,
                )
                .await
                .map_err(host_err_to_rpc),
                None => Err(invalid_params("missing tab_id")),
            },
            methods::FINALIZE_TABS => SessionBackendOps::finalize_tabs_with_context(
                self.inner.backend.as_ref(),
                ctx,
                params,
            )
            .await
            .map_err(host_err_to_rpc),
            methods::NAME_SESSION => SessionBackendOps::name_session_with_context(
                self.inner.backend.as_ref(),
                ctx,
                params,
            )
            .await
            .map_err(host_err_to_rpc),
            methods::GET_USER_HISTORY => SessionBackendOps::get_user_history_with_context(
                self.inner.backend.as_ref(),
                ctx,
                params,
            )
            .await
            .map_err(host_err_to_rpc),
            _ => Err(ErrorObject::new(
                ErrorCode::MethodNotFound,
                format!("method not found: {method}"),
            )),
        }
    }

    async fn route_cdp_request(
        &self,
        method: &str,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> std::result::Result<Value, ErrorObject> {
        match method {
            methods::ATTACH => match params_str(&params, "tab_id") {
                Some(tab_id) => {
                    CdpBackendOps::attach_with_context(self.inner.backend.as_ref(), ctx, &tab_id)
                        .await
                        .map(|()| Value::Null)
                        .map_err(host_err_to_rpc)
                }
                None => Err(invalid_params("missing tab_id")),
            },
            methods::DETACH => match params_str(&params, "tab_id") {
                Some(tab_id) => {
                    CdpBackendOps::detach_with_context(self.inner.backend.as_ref(), ctx, &tab_id)
                        .await
                        .map(|()| Value::Null)
                        .map_err(host_err_to_rpc)
                }
                None => Err(invalid_params("missing tab_id")),
            },
            methods::EXECUTE_CDP => {
                let tab_id = cdp_tab_id(&params)?;
                let cdp_method = params_str(&params, "method").unwrap_or_default();
                let command_params = params
                    .get("commandParams")
                    .cloned()
                    .or_else(|| params.get("params").cloned())
                    .unwrap_or(Value::Null);
                CdpBackendOps::execute_cdp_with_context(
                    self.inner.backend.as_ref(),
                    ctx,
                    &tab_id,
                    &cdp_method,
                    command_params,
                )
                .await
                .map_err(host_err_to_rpc)
            }
            _ => Err(ErrorObject::new(
                ErrorCode::MethodNotFound,
                format!("method not found: {method}"),
            )),
        }
    }

    async fn route_browser_request(
        &self,
        method: &str,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> std::result::Result<Value, ErrorObject> {
        match method {
            methods::BROWSER_TABS_CONTENT => self.fetch_browser_tabs_content(&params).await,
            methods::BROWSER_VIEWPORT_SET
            | methods::BROWSER_VIEWPORT_RESET
            | methods::BROWSER_VISIBILITY_SET
            | methods::BROWSER_VISIBILITY_GET => BrowserControlOps::browser_command_with_context(
                self.inner.backend.as_ref(),
                ctx,
                method,
                params,
            )
            .await
            .map_err(host_err_to_rpc),
            _ => Err(ErrorObject::new(
                ErrorCode::MethodNotFound,
                format!("method not found: {method}"),
            )),
        }
    }

    async fn route_cua_request(
        &self,
        method: &str,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> std::result::Result<Value, ErrorObject> {
        match method {
            methods::MOVE_MOUSE => CuaBackendOps::cua_command_with_context(
                self.inner.backend.as_ref(),
                ctx,
                methods::CUA_MOVE,
                params,
            )
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
            | methods::DOM_CUA_DOWNLOAD_MEDIA => CuaBackendOps::cua_command_with_context(
                self.inner.backend.as_ref(),
                ctx,
                method,
                params,
            )
            .await
            .map_err(host_err_to_rpc),
            _ => Err(ErrorObject::new(
                ErrorCode::MethodNotFound,
                format!("method not found: {method}"),
            )),
        }
    }

    async fn route_playwright_request(
        &self,
        method: &str,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> std::result::Result<Value, ErrorObject> {
        match method {
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
            | methods::PLAYWRIGHT_ELEMENT_INFO
            | methods::PLAYWRIGHT_ELEMENT_SCREENSHOT
            | methods::PLAYWRIGHT_DOM_SNAPSHOT
            | methods::PLAYWRIGHT_WAIT_FOR_TIMEOUT
            | methods::PLAYWRIGHT_WAIT_FOR_URL
            | methods::PLAYWRIGHT_WAIT_FOR_LOAD_STATE
            | methods::PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER
            | methods::PLAYWRIGHT_FILE_CHOOSER_SET_FILES
            | methods::PLAYWRIGHT_WAIT_FOR_DOWNLOAD
            | methods::PLAYWRIGHT_DOWNLOAD_PATH => {
                PlaywrightBackendOps::playwright_command_with_context(
                    self.inner.backend.as_ref(),
                    ctx,
                    method,
                    params,
                )
                .await
                .map_err(host_err_to_rpc)
            }
            _ => Err(ErrorObject::new(
                ErrorCode::MethodNotFound,
                format!("method not found: {method}"),
            )),
        }
    }

    async fn route_tab_request(
        &self,
        method: &str,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> std::result::Result<Value, ErrorObject> {
        match method {
            methods::TAB_GOTO
            | methods::TAB_RELOAD
            | methods::TAB_BACK
            | methods::TAB_FORWARD
            | methods::TAB_CLOSE
            | methods::TAB_SCREENSHOT
            | methods::TAB_WAIT_FOR_URL
            | methods::TAB_WAIT_FOR_LOAD_STATE
            | methods::TAB_CONTENT_EXPORT
            | methods::TAB_EVALUATE
            | methods::TAB_SNAPSHOT_TEXT
            | methods::TAB_URL
            | methods::TAB_TITLE
            | methods::TAB_CLIPBOARD_READ_TEXT
            | methods::TAB_CLIPBOARD_WRITE_TEXT
            | methods::TAB_CLIPBOARD_READ
            | methods::TAB_CLIPBOARD_WRITE => TabBackendOps::tab_command_with_context(
                self.inner.backend.as_ref(),
                ctx,
                method,
                params,
            )
            .await
            .map_err(host_err_to_rpc),
            _ => Err(ErrorObject::new(
                ErrorCode::MethodNotFound,
                format!("method not found: {method}"),
            )),
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
        let url = self
            .inner
            .backend
            .current_url_for_policy(ctx, tab_id)
            .await
            .map_err(host_err_to_rpc)?;
        self.inner
            .policy
            .check_current_origin(tab_id, &url, policy_ctx)
    }

    fn get_info(&self) -> Value {
        let backend_metadata = self.inner.backend.metadata();
        let mut diagnostics = self.inner.backend.diagnostics();
        if let Some(object) = diagnostics.as_object_mut() {
            object.insert("peer".to_string(), self.peer_lifecycle_metadata());
        }
        let mut metadata = json!({
            "host_version": self.inner.host_version,
            "backend": backend_metadata,
            "diagnostics": diagnostics,
        });
        expose_public_profile_metadata(&mut metadata);
        json!({
            "type": self.inner.backend.kind().as_str(),
            "name": self.inner.backend.id(),
            "metadata": metadata,
            "capabilities": self.inner.backend.capabilities(),
        })
    }

    fn peer_lifecycle_metadata(&self) -> Value {
        let recent_events = self.inner.peer_diagnostics.recent_events(20);
        json!({
            "recent_event_count": recent_events.len(),
            "recent_events": recent_events,
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
    if !requires_mutation_context(method) {
        return None;
    }
    ctx.session_id.clone()
}

fn require_mutation_context(
    method: &str,
    ctx: &BackendRequestContext,
) -> std::result::Result<(), ErrorObject> {
    if !requires_mutation_context(method) {
        return Ok(());
    }
    if ctx.session_id.as_deref().unwrap_or_default().is_empty() {
        return Err(invalid_params(
            "missing session_id for mutating browser method",
        ));
    }
    if ctx.turn_id.as_deref().unwrap_or_default().is_empty() {
        return Err(invalid_params(
            "missing turn_id for mutating browser method",
        ));
    }
    Ok(())
}

fn requires_mutation_context(method: &str) -> bool {
    is_session_mutating_method(method)
        || matches!(
            method,
            methods::NAME_SESSION
                | methods::TURN_ENDED
                | methods::YIELD_CONTROL
                | methods::RESUME_CONTROL
                | methods::BROWSER_VIEWPORT_SET
                | methods::BROWSER_VIEWPORT_RESET
                | methods::BROWSER_VISIBILITY_SET
                | methods::PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER
                | methods::PLAYWRIGHT_WAIT_FOR_DOWNLOAD
        )
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
    if let HostError::Rpc {
        code,
        message,
        data,
    } = error
    {
        let error = ErrorObject::new(code, message);
        return match data {
            Some(data) => error.with_data(data),
            None => error,
        };
    }
    let code = match &error {
        HostError::Io(_) | HostError::Frame(_) => ErrorCode::Server(ERR_IO),
        HostError::PeerAuthRefused(_) => ErrorCode::Server(ERR_PEER_AUTH),
        HostError::NoBackendAvailable(_) => ErrorCode::Server(ERR_NO_BACKEND),
        HostError::PageClosed(_) => ErrorCode::Server(ERR_PAGE_CLOSED),
        HostError::Timeout(_) => ErrorCode::Server(obu_wire::error::ERR_TIMEOUT),
        HostError::CdpFailure(_) => ErrorCode::Server(ERR_CDP_FAILURE),
        HostError::TabNotAttached(_) => ErrorCode::Server(ERR_TAB_NOT_ATTACHED),
        HostError::DialogRequiresDecision(_) => ErrorCode::Server(ERR_DIALOG_REQUIRES_DECISION),
        HostError::Rpc { .. } => unreachable!("handled above"),
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

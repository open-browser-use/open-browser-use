//! JSON-RPC dispatcher for one authenticated SDK peer.

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Semaphore, mpsc};
use tokio_util::codec::Framed;
use tokio_util::sync::CancellationToken;

use obu_wire::{
    ErrorCode, ErrorObject, FrameCodec, Request, Response, RpcMessage,
    envelope::Id,
    error::{ERR_CDP_FAILURE, ERR_OVERLOADED, ERR_PAGE_CLOSED, ERR_TAB_NOT_ATTACHED},
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
}

impl Dispatcher {
    /// Construct a dispatcher around one browser backend.
    pub fn new(host_version: String, backend: Arc<dyn BrowserBackend>) -> Self {
        Self {
            inner: Arc::new(DispatcherInner {
                host_version,
                backend,
                policy: Arc::new(PermissivePolicy),
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
            let route = async move {
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
            };
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
            return Response::err(
                req.id,
                ErrorObject::new(
                    ErrorCode::Server(ERR_NOT_IMPLEMENTED),
                    format!(
                        "backend {} does not support method {}",
                        self.inner.backend.kind().as_str(),
                        req.method
                    ),
                ),
            );
        }
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
        json!({
            "type": self.inner.backend.kind().as_str(),
            "name": self.inner.backend.id(),
            "metadata": {
                "host_version": self.inner.host_version,
                "backend": self.inner.backend.metadata(),
                "diagnostics": self.inner.backend.diagnostics(),
            },
            "capabilities": self.inner.backend.capabilities(),
        })
    }
}

fn encode_response(response: &Response) -> Result<Bytes> {
    serde_json::to_vec(response)
        .map(Bytes::from)
        .map_err(|error| HostError::Protocol(error.to_string()))
}

fn params_str(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(String::from)
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

fn host_err_to_rpc(error: HostError) -> ErrorObject {
    let code = match &error {
        HostError::Io(_) | HostError::Frame(_) => ErrorCode::Server(ERR_IO),
        HostError::PeerAuthRefused(_) => ErrorCode::Server(ERR_PEER_AUTH),
        HostError::NoBackendAvailable(_) => ErrorCode::Server(ERR_NO_BACKEND),
        HostError::PageClosed(_) => ErrorCode::Server(ERR_PAGE_CLOSED),
        HostError::Timeout(_) => ErrorCode::Server(obu_wire::error::ERR_TIMEOUT),
        HostError::CdpFailure(_) => ErrorCode::Server(ERR_CDP_FAILURE),
        HostError::TabNotAttached(_) => ErrorCode::Server(ERR_TAB_NOT_ATTACHED),
        HostError::NotImplemented(_) => ErrorCode::Server(ERR_NOT_IMPLEMENTED),
        HostError::Protocol(_) => ErrorCode::Server(ERR_PROTOCOL),
    };
    ErrorObject::new(code, error.to_string())
}

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
        ERR_CDP_FAILURE, ERR_DIALOG_REQUIRES_DECISION, ERR_NAVIGATION_FAILED, ERR_OVERLOADED,
        ERR_PAGE_CLOSED, ERR_TAB_NOT_ATTACHED,
    },
    error::{
        ERR_CONFLICT, ERR_IO, ERR_NO_BACKEND, ERR_NOT_FOUND, ERR_NOT_IMPLEMENTED, ERR_PEER_AUTH,
        ERR_PROTOCOL,
    },
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
use crate::task_lifecycle::resume_status;
use crate::task_store::TaskListFilter;
use crate::task_store_actor::TaskStoreHandle;

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
    /// Durable task store actor handle, when the host provisioned one. `None`
    /// means task RPCs resolve to `task_store_unavailable` rather than panic.
    task_store: Option<TaskStoreHandle>,
    /// Keeps a test-owned temp dir alive for the lifetime of an in-test task
    /// store so the backing SQLite file is not deleted out from under the actor.
    ///
    /// Always `None` in production; only `Some` for
    /// [`Dispatcher::new_for_test_with_temp_task_store`]. Not `#[cfg(test)]`
    /// because that constructor is reachable from integration tests, which link
    /// the crate built WITHOUT `cfg(test)`.
    _task_store_tempdir: Option<Arc<tempfile::TempDir>>,
    session_operation_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    tab_operation_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Dispatcher {
    /// Construct a dispatcher around one browser backend.
    pub fn new(host_version: String, backend: Arc<dyn BrowserBackend>) -> Self {
        Self::with_optional_task_store(
            host_version,
            backend,
            Arc::new(PermissivePolicy),
            PeerLifecycleDiagnostics::default(),
            None,
            None,
        )
    }

    /// Construct a dispatcher around one browser backend and explicit policy.
    pub fn new_with_policy(
        host_version: String,
        backend: Arc<dyn BrowserBackend>,
        policy: Arc<dyn HostPolicy>,
    ) -> Self {
        Self::with_optional_task_store(
            host_version,
            backend,
            policy,
            PeerLifecycleDiagnostics::default(),
            None,
            None,
        )
    }

    /// Construct a dispatcher around one browser backend, explicit policy, and shared peer diagnostics.
    pub fn new_with_policy_and_peer_diagnostics(
        host_version: String,
        backend: Arc<dyn BrowserBackend>,
        policy: Arc<dyn HostPolicy>,
        peer_diagnostics: PeerLifecycleDiagnostics,
    ) -> Self {
        Self::with_optional_task_store(host_version, backend, policy, peer_diagnostics, None, None)
    }

    /// Construct a dispatcher with an explicit policy, peer diagnostics, and an
    /// optional durable task store actor handle.
    ///
    /// This is the constructor `main`/`native_messaging` use once they have
    /// provisioned (or failed to provision) the task store: passing `None`
    /// keeps the host running with task RPCs returning `task_store_unavailable`.
    pub fn new_with_policy_peer_diagnostics_and_task_store(
        host_version: String,
        backend: Arc<dyn BrowserBackend>,
        policy: Arc<dyn HostPolicy>,
        peer_diagnostics: PeerLifecycleDiagnostics,
        task_store: Option<TaskStoreHandle>,
    ) -> Self {
        Self::with_optional_task_store(
            host_version,
            backend,
            policy,
            peer_diagnostics,
            task_store,
            None,
        )
    }

    /// Shared constructor body that wires every `DispatcherInner` field,
    /// including the optional task store handle and (in test builds) the temp
    /// dir that backs an in-test store.
    fn with_optional_task_store(
        host_version: String,
        backend: Arc<dyn BrowserBackend>,
        policy: Arc<dyn HostPolicy>,
        peer_diagnostics: PeerLifecycleDiagnostics,
        task_store: Option<TaskStoreHandle>,
        task_store_tempdir: Option<Arc<tempfile::TempDir>>,
    ) -> Self {
        Self {
            inner: Arc::new(DispatcherInner {
                host_version,
                backend,
                policy,
                peer_diagnostics,
                task_store,
                _task_store_tempdir: task_store_tempdir,
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

    /// Test dispatcher with a real task store opened in a fresh owner-only temp
    /// dir, kept alive for the dispatcher's lifetime.
    #[doc(hidden)]
    pub fn new_for_test_with_temp_task_store() -> Self {
        Self::new_for_test_with_backend_and_temp_task_store(
            Arc::new(WebExtensionBackend::default()),
        )
    }

    /// Test dispatcher around a caller-supplied `backend` plus a real task store
    /// opened in a fresh owner-only temp dir (kept alive for the dispatcher's
    /// lifetime).
    ///
    /// Used by Task 10's finalize/turn-end evidence tests, which need a backend
    /// whose `finalizeTabs`/`turnEnded` actually SUCCEED (the bare default
    /// WebExtension backend has no transport / owned session and so errors before
    /// any evidence could be written).
    #[doc(hidden)]
    pub fn new_for_test_with_backend_and_temp_task_store(backend: Arc<dyn BrowserBackend>) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let dir = Arc::new(tempfile::tempdir().expect("tempdir"));
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))
            .expect("chmod");
        let handle = TaskStoreHandle::open(dir.path().to_path_buf()).expect("task store");
        Self::with_optional_task_store(
            env!("CARGO_PKG_VERSION").into(),
            backend,
            Arc::new(PermissivePolicy),
            PeerLifecycleDiagnostics::default(),
            Some(handle),
            Some(dir),
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
                self.inner.peer_diagnostics.record(
                    &plan_peer_terminal_close("peer closed with invalid first frame").event,
                );
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
                    self.inner.peer_diagnostics.record(
                        &plan_peer_terminal_close("peer rejected during capability authentication")
                            .event,
                    );
                    return Ok(());
                }
            }
            PeerFirstFrameAction::RejectMissingAuth => {
                let response = Response::err(
                    Id::Number(0),
                    ErrorObject::new(ErrorCode::Server(ERR_PEER_AUTH), PEER_AUTH_REQUIRED_MESSAGE),
                );
                framed.send(encode_response(&response)?).await?;
                self.inner.peer_diagnostics.record(
                    &plan_peer_terminal_close("peer rejected before dispatch: missing auth").event,
                );
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
            let timeout_ms = request_context(&request).client_timeout_ms;
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
        let method = req.method.clone();
        let ctx = request_context(&req);
        let started = Instant::now();
        // Class-A: the durable command-event summary (`params_tab_id` +
        // recursive `command_params_summary`) is a deep traversal, so compute it
        // ONLY when the command is actually recordable. The cheap predicate gates
        // the costly work; task RPCs / storeless / sessionless requests pay
        // nothing. It must be computed from `&req.params` BEFORE `route_request_inner`
        // consumes `req`.
        let pending = self.should_record_command_event(&method, &ctx).then(|| {
            (
                params_tab_id(&req.params),
                command_params_summary(&req.params),
            )
        });
        let response = self.route_request_inner(req, ctx.clone()).await;
        // Measure the latency BEFORE spawning so `durationMs` reflects only the
        // command's own work, not the (asynchronous) durable-write scheduling.
        let elapsed = started.elapsed();
        // Best-effort observability: build the durable command event synchronously
        // (cheap, no I/O), then fire-and-forget the actual SQLite write so the
        // response returns immediately and never pays the actor hop + disk write
        // on the agent's per-action latency path.
        if let Some((tab_id, params)) = pending
            && let Some((event, session_id, turn_id, generation)) =
                self.build_browser_command_event(&ctx, &method, tab_id, params, elapsed, &response)
            && let Some(store) = self.inner.task_store.clone()
        {
            // Fire-and-forget: best-effort, no back-pressure on the response path;
            // acceptable because the task-store actor's mpsc serializes the writes.
            tokio::spawn(async move {
                if let Err(error) = store
                    .record_command_event(session_id, turn_id, generation, event)
                    .await
                {
                    tracing::warn!(%error, method = %method, "failed to record browser_command event; command response still succeeded");
                }
            });
        }
        response
    }

    /// Cheap predicate: should this command produce a durable `browser_command`
    /// event? It performs ONLY constant-time checks (no param-summary traversal),
    /// so [`Self::route_request`] can gate the costly `command_params_summary`
    /// behind it. It is also the SINGLE source of truth for the skip decision,
    /// reused by [`Self::build_browser_command_event`] so the gate and the
    /// builder can never diverge.
    ///
    /// Returns `true` only when: the method is NOT a task RPC, AND a task store
    /// exists, AND both `session_id` and `turn_id` are present and non-empty.
    fn should_record_command_event(&self, method: &str, ctx: &BackendRequestContext) -> bool {
        !is_task_method(method)
            && self.inner.task_store.is_some()
            && ctx.session_id.as_deref().is_some_and(|id| !id.is_empty())
            && ctx.turn_id.as_deref().is_some_and(|id| !id.is_empty())
    }

    async fn route_request_inner(&self, req: Request, ctx: BackendRequestContext) -> Response {
        // §4.6: capture the teardown class of this method up front (before `req`
        // is consumed by routing) so a successful close/finalize can evict its
        // process-global lock-map entry afterward.
        let method_is_tab_close = req.method == methods::TAB_CLOSE;
        let method_is_finalize = req.method == methods::FINALIZE_TABS;
        // Capture the session id for finalize eviction up front too: `ctx` is
        // consumed by `route_supported_request` before the trailing eviction
        // runs, so we cannot borrow `ctx.session_id` afterward. Only cloned on a
        // finalize, so the common path pays nothing.
        let finalize_session_id = if method_is_finalize {
            ctx.session_id.clone()
        } else {
            None
        };
        if let Err(error) = reject_user_runtime_metadata(&req.method, &req.params) {
            return Response::err(req.id, error);
        }
        // Finding F1: task RPCs are served by the dispatcher's own task store, not
        // by the browser backend, so they are EXEMPT from the backend capability
        // gate. They are NOT early-returned here: they fall through to the normal
        // `require_mutation_context` + session-lock path below so a resume still
        // acquires the per-session lock like any other mutating method.
        if !is_task_method(&req.method) && !self.inner.backend.supports_method(&req.method) {
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
            // §4.6: only mint/serialize a per-tab lock for a tab the backend
            // actually knows. A mutating request naming a closed/unknown tab id
            // used to permanently mint a map entry before any validation; gating
            // on existence stops that leak. Unknown tabs fall through and let the
            // backend return its own not-attached error.
            if self.inner.backend.knows_tab(&tab_id) {
                let lock = self.tab_operation_lock(&tab_id).await;
                let _guard = lock.lock().await;
                let response = self.route_supported_request(req, ctx).await;
                // §4.6: a successful close is tab teardown — drop the lock entry.
                if method_is_tab_close && response.error.is_none() {
                    self.evict_tab_lock(&tab_id).await;
                }
                return response;
            }
            return self.route_supported_request(req, ctx).await;
        }
        let response = self.route_supported_request(req, ctx).await;
        // §4.6: a successful finalizeTabs is session teardown — drop the
        // session lock entry so a finished session does not leak forever.
        if response.error.is_none()
            && let Some(session_id) = finalize_session_id.as_deref()
        {
            self.evict_session_lock(session_id).await;
        }
        response
    }

    /// Build the durable `browser_command` event plus its routing, or `None`
    /// when this command should NOT be recorded.
    ///
    /// Returns `(event, session_id, turn_id, trusted_kernel_generation)` — all
    /// owned so the caller can move them into a `'static` spawned write. This is
    /// pure (no I/O): the actual durable write is fire-and-forget in
    /// [`Self::route_request`], keeping the actor hop + SQLite INSERT off the
    /// agent's per-action latency path.
    ///
    /// Skip (return `None`) when [`Self::should_record_command_event`] is false
    /// (task RPC, no task store, or empty session/turn ids) — the same gate
    /// `route_request` uses, so the two can never disagree. The guard runs BEFORE
    /// the event is built so skipped commands do no wasted work.
    fn build_browser_command_event(
        &self,
        ctx: &BackendRequestContext,
        method: &str,
        tab_id: Option<String>,
        params: Value,
        duration: Duration,
        response: &Response,
    ) -> Option<(Value, String, String, Option<i64>)> {
        if !self.should_record_command_event(method, ctx) {
            return None;
        }
        // The predicate already guaranteed both ids are present and non-empty;
        // this `let-else` re-extracts them as owned values (and never panics).
        let (Some(session_id), Some(turn_id)) = (
            ctx.session_id.as_deref().filter(|id| !id.is_empty()),
            ctx.turn_id.as_deref().filter(|id| !id.is_empty()),
        ) else {
            return None;
        };
        let mut event = serde_json::Map::new();
        event.insert("method".to_string(), json!(method));
        event.insert(
            "status".to_string(),
            json!(if response.error.is_some() {
                "error"
            } else {
                "ok"
            }),
        );
        event.insert("durationMs".to_string(), json!(duration_millis(duration)));
        if let Some(tab_id) = tab_id {
            event.insert("tabId".to_string(), json!(tab_id));
        }
        if let Some(client_timeout_ms) = ctx.client_timeout_ms {
            event.insert("clientTimeoutMs".to_string(), json!(client_timeout_ms));
        }
        event.insert("params".to_string(), params);
        if let Some(error) = response.error.as_ref() {
            // The error message and `data` can echo the failed URL verbatim (e.g.
            // `navigation failed: <netError> (<url>)`), and that URL routinely
            // carries credentials in its query/fragment. Summarize `data` (which
            // redacts a `url`-keyed string and truncates long blobs while keeping
            // short `netError`/`retryable` fields intact), then scrub any raw
            // URL the message inherited from that same `data.url`.
            let data = error
                .data
                .as_ref()
                .map(|d| summarize_command_value(None, d));
            let message = redact_url_in_message(&error.message, error.data.as_ref());
            event.insert(
                "error".to_string(),
                json!({
                    "code": &error.code,
                    "message": message,
                    "data": data,
                }),
            );
        }
        let nav_status = if response.error.is_some() {
            "error"
        } else {
            "ok"
        };
        if let Some(nav) = navigation_event_field(
            method,
            nav_status,
            response.error.as_ref().and_then(|err| err.data.as_ref()),
        ) {
            event.insert("navigation".to_string(), nav);
        }
        if let Some(result) = response
            .result
            .as_ref()
            .and_then(|result| command_result_summary(method, result))
        {
            event.insert("result".to_string(), result);
        }
        Some((
            Value::Object(event),
            session_id.to_string(),
            turn_id.to_string(),
            ctx.trusted_kernel_generation,
        ))
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
            methods::TASKS_LIST
            | methods::TASKS_EXPORT
            | methods::TASKS_RESUME
            | methods::TASKS_RESUME_COMPLETE => self.route_task_request(method, ctx, params).await,
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

    /// Dispatch a task RPC against the durable task store actor.
    ///
    /// All task methods funnel through the single-writer [`TaskStoreHandle`]
    /// (which serializes store mutations on its own thread). When the host did
    /// not provision a store, every task method resolves to
    /// `task_store_unavailable` rather than panicking.
    async fn route_task_request(
        &self,
        method: &str,
        ctx: &BackendRequestContext,
        params: Value,
    ) -> std::result::Result<Value, ErrorObject> {
        let store = self
            .inner
            .task_store
            .as_ref()
            .ok_or_else(task_store_unavailable)?;
        match method {
            methods::TASKS_LIST => {
                let rows = store
                    .list_tasks(parse_task_list_filter(&params, ctx))
                    .await
                    .map_err(|error| task_store_rpc_error(error.to_string()))?;
                serde_json::to_value(rows)
                    .map_err(|error| ErrorObject::new(ErrorCode::InternalError, error.to_string()))
            }
            methods::TASKS_EXPORT => {
                let task_id = require_task_id(&params)?.to_string();
                let episode = store
                    .export_episode(task_id.clone())
                    .await
                    .map_err(|error| task_store_rpc_error_for_task(error.to_string(), &task_id))?;
                serde_json::to_value(episode)
                    .map_err(|error| ErrorObject::new(ErrorCode::InternalError, error.to_string()))
            }
            methods::TASKS_RESUME => self.route_task_resume_begin(ctx, &params).await,
            methods::TASKS_RESUME_COMPLETE => self.route_task_resume_complete(ctx, &params).await,
            _ => Err(ErrorObject::new(
                ErrorCode::MethodNotFound,
                format!("method not found: {method}"),
            )),
        }
    }

    /// Begin a resume attempt (the `tasksResume` RPC).
    ///
    /// Requires a trusted kernel generation from the frame-level runtime
    /// envelope (Task 4): without it the SDK cannot prove kernel continuity, so
    /// the call is rejected with `task_runtime_metadata_missing` before any
    /// store mutation. On success the attempt's wire token, recovery
    /// [`ResumePlan`], and the task's [`EpisodeExport`] are returned together so
    /// the SDK can decide how to recover (Finding 16) in one round trip.
    async fn route_task_resume_begin(
        &self,
        ctx: &BackendRequestContext,
        params: &Value,
    ) -> std::result::Result<Value, ErrorObject> {
        let store = self
            .inner
            .task_store
            .as_ref()
            .ok_or_else(task_store_unavailable)?;
        let task_id = require_task_id(params)?.to_string();
        let session_id = require_resume_session_id(ctx, params)?;
        let turn_id = require_resume_turn_id(ctx, params)?;
        let generation = require_trusted_generation(ctx)?;
        let begin = store
            .resume_begin(
                task_id.clone(),
                session_id,
                turn_id,
                generation,
                RESUME_ATTEMPT_TTL_MS,
            )
            .await
            .map_err(|error| task_store_rpc_error_for_task(error.to_string(), &task_id))?;
        serde_json::to_value(begin)
            .map_err(|error| ErrorObject::new(ErrorCode::InternalError, error.to_string()))
    }

    /// Complete a resume attempt (the `tasksResumeComplete` RPC).
    ///
    /// Dispatches on the caller-reported `status`: `attached` materializes the
    /// execution owner + segment and returns the attached segment; the terminal
    /// `blocked`/`attach_failed`/`observation_failed` statuses record the
    /// failure reason against the attempt without creating a segment. Like
    /// begin, this requires a trusted generation (the SDK always carries it for
    /// the attached path; rejecting its absence keeps the two halves symmetric).
    async fn route_task_resume_complete(
        &self,
        ctx: &BackendRequestContext,
        params: &Value,
    ) -> std::result::Result<Value, ErrorObject> {
        let store = self
            .inner
            .task_store
            .as_ref()
            .ok_or_else(task_store_unavailable)?;
        let token = params
            .get("resumeToken")
            .and_then(Value::as_str)
            .filter(|token| !token.is_empty())
            .ok_or_else(|| {
                invalid_params("missing resumeToken for tasksResumeComplete")
                    .with_data(json!({ "code": "invalid_resume_token" }))
            })?
            .to_string();
        let status = params
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let generation = require_trusted_generation(ctx)?;
        match status.as_str() {
            resume_status::ATTACHED => {
                let outcome = store
                    .resume_complete_attached(token, generation)
                    .await
                    .map_err(|error| task_store_rpc_error(error.to_string()))?;
                Ok(json!({ "status": "attached", "segment": outcome }))
            }
            resume_status::BLOCKED
            | resume_status::ATTACH_FAILED
            | resume_status::OBSERVATION_FAILED => {
                // Capture the REAL failure detail the SDK sends so it lands in
                // durable evidence (terminal_error + the resume_attempt_blocked
                // event), not a dropped `reason: null`. The SDK
                // (packages/sdk/src/browser-tasks.ts) sends `repair` for a
                // blocked control transition and `error` for attach_failed /
                // observation_failed; we forward whichever is present.
                let mut detail = serde_json::Map::new();
                detail.insert("status".to_string(), json!(status));
                if let Some(repair) = params.get("repair") {
                    detail.insert("repair".to_string(), repair.clone());
                }
                if let Some(error) = params.get("error") {
                    detail.insert("error".to_string(), error.clone());
                }
                let payload = Value::Object(detail);
                store
                    .resume_complete_blocked(token, payload)
                    .await
                    .map_err(|error| task_store_rpc_error(error.to_string()))?;
                Ok(json!({ "status": "blocked" }))
            }
            other => Err(
                invalid_params(&format!("unknown tasksResumeComplete status: {other}"))
                    .with_data(json!({ "code": "invalid_resume_status", "status": other })),
            ),
        }
    }

    /// Best-effort: record `tabs_finalized` evidence for the current turn after a
    /// successful `finalizeTabs` (Task 10).
    ///
    /// Evidence is observability, not the user's result, so this never returns an
    /// error and never alters the finalize response:
    /// - no task store provisioned (`task_store == None`) → skip silently;
    /// - `ctx` lacks a `session_id`/`turn_id` → skip (cannot bind a segment
    ///   without turn authority);
    /// - the actor command errors → `tracing::warn!` and continue.
    ///
    /// The event records the REAL finalize disposition: [`finalize_outcome`]
    /// pulls the closed/released/kept/deliverable tab sets out of the backend's
    /// normalized finalize `result` and forwards them (camelCase) under the event's
    /// `outcome` key, so the durable episode reflects what finalize actually did.
    async fn record_finalize_evidence(&self, ctx: &BackendRequestContext, result: &Value) {
        let Some(store) = self.inner.task_store.as_ref() else {
            return;
        };
        let (Some(session_id), Some(turn_id)) = (
            ctx.session_id.as_deref().filter(|id| !id.is_empty()),
            ctx.turn_id.as_deref().filter(|id| !id.is_empty()),
        ) else {
            return;
        };
        if let Err(error) = store
            .record_finalize_evidence(
                session_id.to_string(),
                turn_id.to_string(),
                ctx.trusted_kernel_generation,
                finalize_outcome(result),
            )
            .await
        {
            tracing::warn!(%error, "failed to record tabs_finalized evidence; finalize still succeeded");
        }
    }

    /// Best-effort: record `turn_ended` evidence for the current turn after a
    /// successful `turnEnded` (Task 10). Same skip/log-and-continue contract as
    /// [`Dispatcher::record_finalize_evidence`].
    async fn record_turn_ended_evidence(&self, ctx: &BackendRequestContext) {
        let Some(store) = self.inner.task_store.as_ref() else {
            return;
        };
        let (Some(session_id), Some(turn_id)) = (
            ctx.session_id.as_deref().filter(|id| !id.is_empty()),
            ctx.turn_id.as_deref().filter(|id| !id.is_empty()),
        ) else {
            return;
        };
        if let Err(error) = store
            .record_turn_ended_evidence(
                session_id.to_string(),
                turn_id.to_string(),
                ctx.trusted_kernel_generation,
            )
            .await
        {
            tracing::warn!(%error, "failed to record turn_ended evidence; turnEnded still succeeded");
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
                let result = SessionBackendOps::turn_ended_with_context(
                    self.inner.backend.as_ref(),
                    ctx,
                    params,
                )
                .await
                .map_err(host_err_to_rpc)?;
                // Best-effort, AFTER backend success: record turn-ended evidence for
                // the current turn's segment. Never fails the user's turnEnded.
                self.record_turn_ended_evidence(ctx).await;
                Ok(result)
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
            methods::FINALIZE_TABS => {
                let result = SessionBackendOps::finalize_tabs_with_context(
                    self.inner.backend.as_ref(),
                    ctx,
                    params,
                )
                .await
                .map_err(host_err_to_rpc)?;
                // Best-effort, AFTER backend success: record finalize evidence for
                // the current turn's segment. Never fails the user's finalize.
                self.record_finalize_evidence(ctx, &result).await;
                Ok(result)
            }
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

    /// Drop the per-tab operation-lock entry for `tab_id` on tab teardown
    /// (audit §4.6).
    ///
    /// Lifecycle-tied eviction: called after a successful `tab_close` so a closed
    /// tab's lock no longer occupies the process-global map. Removing the map
    /// entry only drops the dispatcher's strong ref to the `Arc<Mutex<()>>`; any
    /// task still holding the lock keeps its own clone alive, so mutual exclusion
    /// is never broken (unlike a strong-count GC, which could evict a key a live
    /// holder still guards). A re-opened tab simply mints a fresh entry on its
    /// next mutating request.
    async fn evict_tab_lock(&self, tab_id: &str) {
        self.inner.tab_operation_locks.lock().await.remove(tab_id);
    }

    /// Drop the per-session operation-lock entry for `session_id` on session
    /// teardown (audit §4.6). Called after a successful `finalizeTabs`. Same
    /// liveness-safe semantics as [`Self::evict_tab_lock`].
    async fn evict_session_lock(&self, session_id: &str) {
        self.inner
            .session_operation_locks
            .lock()
            .await
            .remove(session_id);
    }

    /// Number of live per-tab lock entries (test-only diagnostic, audit §4.6).
    #[doc(hidden)]
    pub async fn tab_lock_count(&self) -> usize {
        self.inner.tab_operation_locks.lock().await.len()
    }

    /// Number of live per-session lock entries (test-only diagnostic, audit §4.6).
    #[doc(hidden)]
    pub async fn session_lock_count(&self) -> usize {
        self.inner.session_operation_locks.lock().await.len()
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

fn duration_millis(duration: Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

fn command_params_summary(params: &Value) -> Value {
    summarize_command_value(None, params)
}

fn command_result_summary(method: &str, result: &Value) -> Option<Value> {
    match method {
        // `tab_url` returns a URL whose query/fragment may carry credentials, so
        // it is redacted before measuring/storing; `tab_title` is plain text.
        methods::TAB_URL => Some(url_command_result_summary(result)),
        methods::TAB_TITLE => Some(string_command_result_summary(result)),
        methods::FINALIZE_TABS => Some(finalize_command_result_summary(result)),
        methods::CREATE_TAB
        | methods::GET_CURRENT_TAB
        | methods::GET_SELECTED_TAB
        | methods::CLAIM_USER_TAB
        | methods::RESUME_CONTROL => tab_command_result_summary(result),
        methods::GET_TABS | methods::GET_USER_TABS => tab_list_command_result_summary(result),
        methods::TAB_EVALUATE => Some(evaluate_command_result_summary(result)),
        methods::TAB_SNAPSHOT_TEXT
        | methods::TAB_SCREENSHOT
        | methods::TAB_CONTENT_EXPORT
        | methods::TAB_CLIPBOARD_READ
        | methods::TAB_CLIPBOARD_READ_TEXT
        | methods::PLAYWRIGHT_SCREENSHOT
        | methods::PLAYWRIGHT_ELEMENT_SCREENSHOT
        | methods::PLAYWRIGHT_DOWNLOAD_PATH
        | methods::CUA_DOWNLOAD_MEDIA
        | methods::DOM_CUA_DOWNLOAD_MEDIA
        | methods::PLAYWRIGHT_LOCATOR_DOWNLOAD_MEDIA => {
            Some(redacted_command_result_summary(result))
        }
        _ => None,
    }
}

/// Result summary for `tab_url`: identical shape to `string_command_result_summary`
/// but redacts the URL's query/fragment first so credentials in a `?token=…` or
/// `#access_token=…` are never measured or persisted.
fn url_command_result_summary(result: &Value) -> Value {
    match result.as_str() {
        Some(text) => string_command_result_summary(&Value::String(redact_url(text))),
        None => string_command_result_summary(result),
    }
}

fn string_command_result_summary(result: &Value) -> Value {
    let Some(text) = result.as_str() else {
        return json!({
            "type": command_value_type(result),
        });
    };
    let length = text.chars().count();
    if length > 512 {
        json!({
            "type": "string",
            "truncated": true,
            "length": length,
            "value": text.chars().take(512).collect::<String>(),
        })
    } else {
        json!({
            "type": "string",
            "value": text,
        })
    }
}

fn finalize_command_result_summary(result: &Value) -> Value {
    let outcome = finalize_outcome(result);
    json!({
        "type": "finalizeTabs",
        "status": result.get("status").and_then(Value::as_str).unwrap_or("ok"),
        "closedTabIds": outcome.get("closedTabIds").cloned().unwrap_or_else(|| json!([])),
        "releasedTabIds": outcome.get("releasedTabIds").cloned().unwrap_or_else(|| json!([])),
        "keptTabs": outcome.get("keptTabs").cloned().unwrap_or_else(|| json!([])),
        "deliverableTabs": outcome.get("deliverableTabs").cloned().unwrap_or_else(|| json!([])),
    })
}

fn tab_command_result_summary(result: &Value) -> Option<Value> {
    let Some(tab) = summarize_tab_like_result(result) else {
        return Some(json!({ "type": command_value_type(result) }));
    };
    Some(json!({
        "type": "tab",
        "tab": tab,
    }))
}

fn tab_list_command_result_summary(result: &Value) -> Option<Value> {
    let items = result.as_array()?;
    let tabs = items
        .iter()
        .take(20)
        .filter_map(summarize_tab_like_result)
        .collect::<Vec<_>>();
    Some(json!({
        "type": "tab_list",
        "length": items.len(),
        "truncated": items.len() > tabs.len(),
        "tabs": tabs,
    }))
}

fn summarize_tab_like_result(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let mut tab = serde_json::Map::new();
    for key in [
        "id",
        "tab_id",
        "tabId",
        "windowId",
        "window_id",
        "groupId",
        "group_id",
        "url",
        "title",
        "active",
        "logicalActive",
        "logical_active",
        "origin",
        "status",
        "owned",
        "claimRequired",
        "claim_required",
        "commandable",
    ] {
        if let Some(value) = object.get(key) {
            // The `url` key may carry credentials in its query/fragment; redact a
            // string value to scheme+host+path. Non-string values fall back to the
            // generic summarizer.
            let summarized = match (key, value) {
                ("url", Value::String(raw)) => Value::String(redact_url(raw)),
                _ => summarize_command_value(Some(key), value),
            };
            tab.insert(key.to_string(), summarized);
        }
    }
    (!tab.is_empty()).then_some(Value::Object(tab))
}

fn redacted_command_result_summary(result: &Value) -> Value {
    json!({
        "type": "redacted",
        "reason": "sensitive_or_large_result",
        "valueType": command_value_type(result),
    })
}

/// `tab_evaluate` returns the agent's OWN script output. Small primitive results
/// (bool, number, or short string) are safe and useful to surface verbatim so the
/// agent can observe what it computed; larger or structured results may include
/// page content, so they fall back to the redacted summary like other big payloads.
fn evaluate_command_result_summary(result: &Value) -> Value {
    let is_small_primitive = result.is_boolean()
        || result.is_number()
        || (result.is_string() && result.as_str().is_some_and(|s| s.chars().count() <= 64));
    if is_small_primitive {
        json!({ "type": command_value_type(result), "value": result })
    } else {
        redacted_command_result_summary(result)
    }
}

/// Strip a `user:pass@` userinfo segment from a URL's authority, scoped ONLY to
/// the authority that follows `://` so a `@` in a path/query, a `mailto:` (which
/// has no `://`), or an IPv6 host (`http://[::1]:8080/p`) is left intact.
fn strip_userinfo(url: &str) -> String {
    if let Some(scheme_end) = url.find("://") {
        let (prefix, rest) = url.split_at(scheme_end + 3); // prefix includes "://"
        let authority_end = rest.find(['/', '?']).unwrap_or(rest.len());
        let (authority, tail) = rest.split_at(authority_end);
        if let Some(at) = authority.rfind('@') {
            return format!("{prefix}{}{tail}", &authority[at + 1..]);
        }
    }
    url.to_string()
}

/// Strip credential-bearing parts from a URL for durable logging, keeping
/// scheme+host+path for debuggability. Removes the fragment and query string
/// (which routinely carry tokens, signed-URL credentials, and OAuth callback
/// codes) AND a `user:pass@` userinfo segment — all of which must not be
/// persisted to `tasks.db`.
fn redact_url(raw: &str) -> String {
    let no_fragment = raw.split('#').next().unwrap_or(raw);
    let (base, had_query) = match no_fragment.split_once('?') {
        Some((base, _query)) => (base, true),
        None => (no_fragment, false),
    };
    // Strip userinfo from the no-query base so the authority scan (which stops at
    // the first `/` or `?`) isn't confused by a query that's already gone.
    let base = strip_userinfo(base);
    if had_query {
        format!("{base}?…")
    } else {
        base
    }
}

/// Scrub a raw URL out of an error message before durable logging.
///
/// Structured errors such as `NavigationFailed` format their message as
/// `navigation failed: <netError> (<url>)`, embedding the failed URL verbatim —
/// including any `?token=` credentials. The same URL is carried structurally in
/// `error.data.url`, so we replace its exact occurrences in the message with the
/// query/fragment-stripped form. When `data.url` is absent we leave the message
/// untouched (there is no structured URL to key off, and the message is already
/// drawn from a fixed set of host-authored format strings).
fn redact_url_in_message(message: &str, error_data: Option<&Value>) -> String {
    let Some(raw_url) = error_data
        .and_then(|data| data.get("url"))
        .and_then(Value::as_str)
    else {
        return message.to_string();
    };
    let redacted = redact_url(raw_url);
    if redacted == raw_url {
        message.to_string()
    } else {
        message.replace(raw_url, &redacted)
    }
}

/// True for object keys whose string value is a URL we must redact before
/// persisting (query/fragment may carry credentials). Case-insensitive so
/// `url`, `URL`, `finalUrl`, etc. are all covered.
fn is_url_command_param(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key == "url" || key.ends_with("url")
}

fn summarize_command_value(key: Option<&str>, value: &Value) -> Value {
    if key.is_some_and(is_sensitive_command_param) {
        return redact_command_value(value);
    }
    // URL-valued keys keep scheme+host+path but drop the query/fragment, which
    // routinely carry tokens/credentials. A `?token=…` shorter than 512 chars
    // would otherwise survive the length rule below verbatim.
    if key.is_some_and(is_url_command_param)
        && let Value::String(text) = value
    {
        let redacted = redact_url(text);
        let length = redacted.chars().count();
        return if length > 512 {
            json!({ "truncated": true, "length": length })
        } else {
            Value::String(redacted)
        };
    }
    match value {
        Value::String(text) => {
            let length = text.chars().count();
            if length > 512 {
                json!({ "truncated": true, "length": length })
            } else {
                Value::String(text.clone())
            }
        }
        Value::Array(items) => {
            let summarized = items
                .iter()
                .take(20)
                .map(|item| summarize_command_value(None, item))
                .collect::<Vec<_>>();
            if items.len() > summarized.len() {
                json!({
                    "truncated": true,
                    "length": items.len(),
                    "items": summarized,
                })
            } else {
                Value::Array(summarized)
            }
        }
        Value::Object(object) => {
            let mut summarized = serde_json::Map::new();
            for (child_key, child_value) in object {
                summarized.insert(
                    child_key.clone(),
                    summarize_command_value(Some(child_key), child_value),
                );
            }
            Value::Object(summarized)
        }
        other => other.clone(),
    }
}

fn redact_command_value(value: &Value) -> Value {
    match value {
        Value::String(text) => json!({
            "redacted": true,
            "length": text.chars().count(),
        }),
        Value::Array(items) => json!({
            "redacted": true,
            "type": "array",
            "length": items.len(),
        }),
        Value::Object(object) => json!({
            "redacted": true,
            "type": "object",
            "keys": object.len(),
        }),
        Value::Null => Value::Null,
        other => json!({
            "redacted": true,
            "type": command_value_type(other),
        }),
    }
}

fn is_sensitive_command_param(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    matches!(
        key.as_str(),
        "authorization"
            | "content"
            | "cookie"
            | "expression"
            | "html"
            | "password"
            | "script"
            | "text"
            | "token"
            | "value"
    ) || key.contains("password")
        || key.contains("secret")
        || key.contains("token")
}

fn command_value_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
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
                | methods::TASKS_RESUME
                | methods::TASKS_RESUME_COMPLETE
        )
}

// NOTE (audit §4.6): the process-global operation-lock maps are evicted on
// lifecycle teardown in `route_request_inner`, keyed off `methods::TAB_CLOSE`
// and `methods::FINALIZE_TABS`. Any NEW teardown method added here (e.g. a
// bulk tab-close) MUST also wire a matching `evict_tab_lock` / `evict_session_lock`
// call in `route_request_inner`, or its lock entries will leak.
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

fn request_context(req: &Request) -> BackendRequestContext {
    BackendRequestContext {
        session_id: params_str(&req.params, "session_id"),
        turn_id: params_str(&req.params, "turn_id"),
        client_timeout_ms: req
            .params
            .get("client_timeout_ms")
            .or_else(|| req.params.get("timeoutMs"))
            .and_then(Value::as_u64),
        trusted_kernel_generation: req.runtime.as_ref().and_then(|meta| meta.kernel_generation),
    }
}

/// Reject any attempt to smuggle trusted runtime metadata through `params`.
///
/// `kernel_generation` and friends must ride in the frame-level `runtime`
/// envelope, never inside caller-supplied `params`. Task RPCs reject a
/// `runtime` or `_runtime` key in params so a raw peer cannot spoof the
/// trusted value.
fn reject_user_runtime_metadata(
    method: &str,
    params: &Value,
) -> std::result::Result<(), ErrorObject> {
    if matches!(
        method,
        methods::TASKS_RESUME
            | methods::TASKS_RESUME_COMPLETE
            | methods::TASKS_LIST
            | methods::TASKS_EXPORT
    ) {
        if let Some(field) = ["runtime", "_runtime"]
            .into_iter()
            .find(|key| params.get(*key).is_some())
        {
            return Err(
                invalid_params("untrusted runtime metadata").with_data(json!({
                    "code": "untrusted_runtime_metadata",
                    "field": field
                })),
            );
        }
    }
    Ok(())
}

fn invalid_params(message: &str) -> ErrorObject {
    ErrorObject::new(ErrorCode::InvalidParams, message)
}

/// Time-to-live for a freshly begun resume attempt (60s).
///
/// Long enough for the SDK to attach within the same turn; short enough that an
/// abandoned attempt expires rather than blocking the task's single pending
/// attempt slot indefinitely.
const RESUME_ATTEMPT_TTL_MS: i64 = 60_000;

/// Whether `method` is a task RPC served by the dispatcher's task store rather
/// than the browser backend (Finding F1: exempt from the capability gate).
fn is_task_method(method: &str) -> bool {
    matches!(
        method,
        methods::TASKS_LIST
            | methods::TASKS_EXPORT
            | methods::TASKS_RESUME
            | methods::TASKS_RESUME_COMPLETE
    )
}

/// Project the real finalize disposition out of a backend's normalized
/// `finalizeTabs` result into the `tabs_finalized` evidence `outcome` object.
///
/// The WebExtension backend's `normalize_finalize_response` returns the
/// disposition under snake_case keys (`closed_tab_ids`, `released_tab_ids`,
/// `kept_tabs`, `deliverable_tabs`); this lifts each (defaulting a missing one to
/// an empty array) and re-keys it camelCase for the durable event. The values are
/// the actual tabs finalize closed/released/kept/handed back, so the evidence is
/// real data — not a constant. A non-object `result` (e.g. the default backend's
/// `null`) yields all-empty arrays.
fn finalize_outcome(result: &Value) -> Value {
    let array_at = |snake: &str| -> Value {
        result
            .get(snake)
            .filter(|value| value.is_array())
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()))
    };
    json!({
        "closedTabIds": array_at("closed_tab_ids"),
        "releasedTabIds": array_at("released_tab_ids"),
        "keptTabs": array_at("kept_tabs"),
        "deliverableTabs": array_at("deliverable_tabs"),
    })
}

/// Build a [`TaskListFilter`] from `tasksList` params + the request context.
///
/// `state` accepts either a single string or an array of strings;
/// `scope: "currentSession"` restricts the listing to the request's session id.
fn parse_task_list_filter(params: &Value, ctx: &BackendRequestContext) -> TaskListFilter {
    let state = match params.get("state") {
        Some(Value::String(s)) => Some(vec![s.clone()]),
        Some(Value::Array(items)) => {
            let states: Vec<String> = items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
            (!states.is_empty()).then_some(states)
        }
        _ => None,
    };
    let limit = params.get("limit").and_then(Value::as_i64).unwrap_or(0);
    let scope_session_id = match params.get("scope").and_then(Value::as_str) {
        Some("currentSession") => Some(ctx.session_id.clone().unwrap_or_default()),
        _ => None,
    };
    TaskListFilter {
        state,
        limit,
        scope_session_id,
    }
}

/// Extract a non-empty `taskId` from task RPC params.
fn require_task_id(params: &Value) -> std::result::Result<&str, ErrorObject> {
    params
        .get("taskId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            invalid_params("missing taskId").with_data(json!({ "code": "invalid_params" }))
        })
}

/// Resolve the resume session id from the trusted context, falling back to
/// params only when the context lacks one.
fn require_resume_session_id(
    ctx: &BackendRequestContext,
    params: &Value,
) -> std::result::Result<String, ErrorObject> {
    ctx.session_id
        .clone()
        .filter(|id| !id.is_empty())
        .or_else(|| {
            params
                .get("session_id")
                .or_else(|| params.get("sessionId"))
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        })
        .ok_or_else(|| invalid_params("missing session_id: resume requires turn authority"))
}

/// Resolve the resume turn id from the trusted context, falling back to params
/// only when the context lacks one.
fn require_resume_turn_id(
    ctx: &BackendRequestContext,
    params: &Value,
) -> std::result::Result<String, ErrorObject> {
    ctx.turn_id
        .clone()
        .filter(|id| !id.is_empty())
        .or_else(|| {
            params
                .get("turn_id")
                .or_else(|| params.get("turnId"))
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        })
        .ok_or_else(|| invalid_params("missing turn_id: resume requires turn authority"))
}

/// Require the trusted kernel generation from the frame-level runtime envelope.
///
/// A resume cannot prove kernel continuity (Finding 16) without it, so its
/// absence is rejected with `task_runtime_metadata_missing` BEFORE any store
/// mutation. The generation must ride in the trusted runtime envelope, never in
/// caller-supplied params (already enforced by `reject_user_runtime_metadata`).
fn require_trusted_generation(
    ctx: &BackendRequestContext,
) -> std::result::Result<i64, ErrorObject> {
    ctx.trusted_kernel_generation.ok_or_else(|| {
        invalid_params("missing trusted kernel generation for task resume")
            .with_data(json!({ "code": "task_runtime_metadata_missing", "retryable": false }))
    })
}

/// Error returned when a task RPC arrives but the host did not provision a store.
fn task_store_unavailable() -> ErrorObject {
    ErrorObject::new(ErrorCode::Server(ERR_IO), "task store unavailable")
        .with_data(json!({ "code": "task_store_unavailable", "retryable": false }))
}

/// `unknown_task` error carrying the offending `task_id` in its data.
///
/// §13: resume/export of an unknown id resolves to `ERR_NOT_FOUND` with
/// `data: { code: "unknown_task", task_id }` so the SDK can report which task
/// was missing.
fn unknown_task_error(task_id: &str) -> ErrorObject {
    ErrorObject::new(
        ErrorCode::Server(ERR_NOT_FOUND),
        format!("unknown_task: {task_id}"),
    )
    .with_data(json!({ "code": "unknown_task", "task_id": task_id }))
}

/// Like [`task_store_rpc_error`], but for handlers that know the `task_id`: the
/// `unknown_task` case is enriched with the id (§13). All other cases defer to
/// [`task_store_rpc_error`].
fn task_store_rpc_error_for_task(error: String, task_id: &str) -> ErrorObject {
    if error.contains("unknown_task") || error.contains("task not found") {
        return unknown_task_error(task_id);
    }
    task_store_rpc_error(error)
}

/// Map a stringified task-store error onto a wire `ErrorObject` with a stable
/// `data.code`, so SDK callers can branch on the failure class.
fn task_store_rpc_error(error: String) -> ErrorObject {
    if error.contains("unknown_task") || error.contains("task not found") {
        return ErrorObject::new(ErrorCode::Server(ERR_NOT_FOUND), error)
            .with_data(json!({ "code": "unknown_task" }));
    }
    if error.contains("task_resume_conflict") {
        return ErrorObject::new(ErrorCode::Server(ERR_CONFLICT), error)
            .with_data(json!({ "code": "task_resume_conflict" }));
    }
    if error.contains("task_turn_conflict") {
        return ErrorObject::new(ErrorCode::Server(ERR_CONFLICT), error)
            .with_data(json!({ "code": "task_turn_conflict" }));
    }
    if error.contains("invalid_resume_token") || error.contains("resume_token_expired") {
        return invalid_params(&error).with_data(json!({ "code": "invalid_resume_token" }));
    }
    ErrorObject::new(ErrorCode::InternalError, error)
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
        HostError::NavigationFailed { .. } => ErrorCode::Server(ERR_NAVIGATION_FAILED),
        HostError::TabNotAttached(_) => ErrorCode::Server(ERR_TAB_NOT_ATTACHED),
        HostError::DialogRequiresDecision(_) => ErrorCode::Server(ERR_DIALOG_REQUIRES_DECISION),
        HostError::Rpc { .. } => unreachable!("handled above"),
        HostError::NotImplemented(_) => ErrorCode::Server(ERR_NOT_IMPLEMENTED),
        HostError::Protocol(_) => ErrorCode::Server(ERR_PROTOCOL),
    };
    let data = match &error {
        HostError::DialogRequiresDecision(dialog) => Some(dialog.data.clone()),
        HostError::NavigationFailed {
            url,
            net_error,
            retryable,
        } => Some(json!({
            "code": "navigation_failed",
            "url": url,
            "netError": net_error,
            "retryable": retryable,
        })),
        _ => None,
    };
    let error = ErrorObject::new(code, error.to_string());
    match data {
        Some(data) => error.with_data(data),
        None => error,
    }
}

/// Structured navigation tag for `task_events`, present only for navigation
/// methods. On failure it lifts `netError`/`retryable` out of the structured
/// error data so navigation outcomes are queryable without parsing the error
/// blob.
fn navigation_event_field(method: &str, status: &str, error_data: Option<&Value>) -> Option<Value> {
    if !matches!(
        method,
        methods::TAB_GOTO | methods::TAB_RELOAD | methods::TAB_BACK | methods::TAB_FORWARD
    ) {
        return None;
    }
    let mut nav = serde_json::Map::new();
    nav.insert("outcome".to_string(), json!(status));
    if let Some(data) = error_data {
        if let Some(net_error) = data.get("netError") {
            nav.insert("netError".to_string(), net_error.clone());
        }
        if let Some(retryable) = data.get("retryable") {
            nav.insert("retryable".to_string(), retryable.clone());
        }
    }
    Some(Value::Object(nav))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backends::BackendRequestContext;

    #[test]
    fn navigation_event_field_tags_nav_methods_only() {
        // Non-navigation method => no navigation tag.
        assert!(navigation_event_field("tab_click", "ok", None).is_none());
        // Successful goto => outcome ok.
        let ok = navigation_event_field(methods::TAB_GOTO, "ok", None).expect("nav field");
        assert_eq!(ok["outcome"], json!("ok"));
        // Failed goto => lifts netError/retryable out of the structured error data.
        let data = json!({"code":"navigation_failed","netError":"net::ERR_CONNECTION_RESET","retryable":true});
        let bad =
            navigation_event_field(methods::TAB_GOTO, "error", Some(&data)).expect("nav field");
        assert_eq!(bad["outcome"], json!("error"));
        assert_eq!(bad["netError"], json!("net::ERR_CONNECTION_RESET"));
        assert_eq!(bad["retryable"], json!(true));
    }

    #[test]
    fn redacted_summary_does_not_serialize_full_result() {
        // The summary must not embed a byte count derived from serializing the whole
        // (possibly multi-MB) result.
        let summary = redacted_command_result_summary(&json!({ "data": "x".repeat(4096) }));
        assert_eq!(summary["type"], "redacted");
        assert!(
            summary.get("jsonBytes").is_none(),
            "must not serialize full result to count bytes"
        );
    }

    #[test]
    fn redaction_denylist_drops_generic_structural_keys_but_keeps_secrets() {
        // Curated sensitive names still redacted:
        for k in [
            "authorization",
            "cookie",
            "password",
            "token",
            "value",
            "text",
            "html",
            "script",
            "expression",
            "content",
        ] {
            assert!(is_sensitive_command_param(k), "{k} must stay sensitive");
        }
        // Generic structural names are no longer over-redacted:
        assert!(!is_sensitive_command_param("body"));
        assert!(!is_sensitive_command_param("data"));
        // Substring fallbacks still catch obviously-secret keys:
        assert!(is_sensitive_command_param("api_token"));
        assert!(is_sensitive_command_param("client_secret"));
        assert!(is_sensitive_command_param("user_password"));
    }

    #[test]
    fn evaluate_summary_surfaces_small_primitives_and_redacts_big_results() {
        // Small primitives surfaced verbatim.
        assert_eq!(
            evaluate_command_result_summary(&json!(true)),
            json!({ "type": "boolean", "value": true })
        );
        assert_eq!(
            evaluate_command_result_summary(&json!(42)),
            json!({ "type": "number", "value": 42 })
        );
        assert_eq!(
            evaluate_command_result_summary(&json!("ok")),
            json!({ "type": "string", "value": "ok" })
        );
        // Long strings and structured values are redacted.
        let long = "x".repeat(65);
        assert_eq!(
            evaluate_command_result_summary(&json!(long))["type"],
            "redacted"
        );
        assert_eq!(
            evaluate_command_result_summary(&json!({ "a": 1 }))["type"],
            "redacted"
        );
        assert_eq!(
            evaluate_command_result_summary(&json!([1, 2, 3]))["type"],
            "redacted"
        );
    }

    #[test]
    fn redact_url_strips_query_and_fragment() {
        // Query and fragment both carry secrets; only scheme+host+path survive.
        assert_eq!(
            redact_url("https://site.test/cb?token=SUPERSECRET#frag"),
            "https://site.test/cb?…"
        );
        // No-query URL is returned unchanged.
        assert_eq!(
            redact_url("https://site.test/path/here"),
            "https://site.test/path/here"
        );
        // A fragment-only URL drops the fragment (no `?…` since there was no query).
        assert_eq!(
            redact_url("https://site.test/page#section-2"),
            "https://site.test/page"
        );
        // A fragment carrying a query-looking secret (after `#`) is still stripped:
        // the fragment is removed before the `?` split, so nothing leaks.
        let r = redact_url("https://site.test/page#access_token=SUPERSECRET");
        assert_eq!(r, "https://site.test/page");
        assert!(!r.contains("SUPERSECRET"));

        // Userinfo credentials in the authority are stripped, host is retained.
        let r = redact_url("http://user:pass@host/p?token=SECRET");
        assert!(!r.contains("user"), "userinfo user leaked: {r}");
        assert!(!r.contains("pass"), "userinfo pass leaked: {r}");
        assert!(!r.contains("SECRET"), "query secret leaked: {r}");
        assert!(r.contains("host"), "host should survive: {r}");
        assert_eq!(r, "http://host/p?…");

        // Userinfo without a query still drops the credentials and adds no `?…`.
        assert_eq!(redact_url("https://u:p@host/path"), "https://host/path");

        // Scoping edge cases the userinfo strip must NOT over-reach on:
        // - `mailto:` has no `://`, so the `@` in the address is untouched (only
        //   the query becomes `?…`).
        assert_eq!(redact_url("mailto:a@b.com?subject=x"), "mailto:a@b.com?…");
        // - IPv6 literal host is preserved verbatim.
        assert_eq!(redact_url("http://[::1]:8080/p?x"), "http://[::1]:8080/p?…");
        // - `data:` URLs have no authority; left unchanged.
        assert_eq!(redact_url("data:text/plain,hello"), "data:text/plain,hello");
        // - empty string stays empty.
        assert_eq!(redact_url(""), "");
        // - an `@` in the PATH (not the authority) is not mistaken for userinfo.
        assert_eq!(redact_url("https://host/u@v/p"), "https://host/u@v/p");
    }

    /// Pin the Display↔redaction seam: `NavigationFailed`'s message embeds the
    /// failed URL verbatim, and the dispatcher scrubs it using the URL anchored in
    /// `error.data.url`. If the Display format or the `data.url` anchor ever drift
    /// apart, the message-level redaction would silently re-leak — this goes RED.
    #[test]
    fn navigation_failed_message_redaction_is_coupled_to_data() {
        let err = HostError::NavigationFailed {
            url: "http://h/p?token=SECRET".into(),
            net_error: "net::ERR_X".into(),
            retryable: true,
        };
        // Reproduce EXACTLY what build_browser_command_event consumes: the rpc
        // error object's message + data, both derived from the same HostError.
        let rpc = host_err_to_rpc(err);
        let redacted = redact_url_in_message(&rpc.message, rpc.data.as_ref());
        assert!(
            !redacted.contains("SECRET"),
            "URL secret survived in error message: {redacted}"
        );
        // The diagnostic netError must remain in the message.
        assert!(
            redacted.contains("net::ERR_X"),
            "netError should survive in message: {redacted}"
        );
        // And the structured data still carries netError/retryable intact.
        let data = rpc.data.as_ref().expect("nav error has data");
        assert_eq!(data["netError"], json!("net::ERR_X"));
        assert_eq!(data["retryable"], json!(true));
    }

    #[test]
    fn summarize_tab_like_result_redacts_url() {
        let tab = summarize_tab_like_result(&json!({
            "url": "https://x.test/p?token=SECRET",
            "title": "T",
        }))
        .expect("tab summary");
        // Serialize the whole summary and assert the secret is gone but the host
        // (debuggability) survives.
        let serialized = serde_json::to_string(&tab).expect("serialize tab summary");
        assert!(
            serialized.contains("x.test"),
            "host should survive for debuggability: {serialized}"
        );
        assert!(
            !serialized.contains("SECRET"),
            "query secret leaked into tab summary: {serialized}"
        );
        // The redacted url keeps scheme+host+path and marks the dropped query.
        assert_eq!(tab["url"], json!("https://x.test/p?…"));
        // Non-url fields are untouched.
        assert_eq!(tab["title"], json!("T"));
    }

    #[test]
    fn url_command_result_summary_redacts_but_title_does_not() {
        // TAB_URL routes through url_command_result_summary => value redacted.
        let url_summary =
            command_result_summary(methods::TAB_URL, &json!("https://x.test/p?token=SECRET"))
                .expect("url summary");
        assert_eq!(
            url_summary,
            json!({ "type": "string", "value": "https://x.test/p?…" })
        );
        let serialized = serde_json::to_string(&url_summary).unwrap();
        assert!(
            !serialized.contains("SECRET"),
            "url secret leaked: {serialized}"
        );

        // TAB_TITLE stays on the plain string summary (titles are not URLs).
        let title_summary =
            command_result_summary(methods::TAB_TITLE, &json!("My ?token=looking title"))
                .expect("title summary");
        assert_eq!(
            title_summary,
            json!({ "type": "string", "value": "My ?token=looking title" })
        );
    }

    /// Long-task resume inherits the dispatcher's turn-authority gate:
    /// `RESUME_CONTROL` is a mutation-context method, so a resume request that
    /// arrives without a `turn_id` is rejected at the dispatcher boundary
    /// before any later browser side effects can run. This is the dispatcher
    /// half of the contract enforced at the store level by
    /// `task_store::record_resume_segment`.
    #[test]
    fn resume_control_rejected_without_turn_id() {
        // Session id present, but no turn id => no turn authority.
        let ctx = BackendRequestContext {
            session_id: Some("sess-1".into()),
            turn_id: None,
            client_timeout_ms: None,
            trusted_kernel_generation: None,
        };
        let err = require_mutation_context(methods::RESUME_CONTROL, &ctx)
            .expect_err("resume without turn_id must be rejected");
        assert_eq!(err.code, ErrorCode::InvalidParams);

        // Empty turn id is likewise no authority.
        let ctx_empty = BackendRequestContext {
            session_id: Some("sess-1".into()),
            turn_id: Some(String::new()),
            client_timeout_ms: None,
            trusted_kernel_generation: None,
        };
        assert!(
            require_mutation_context(methods::RESUME_CONTROL, &ctx_empty).is_err(),
            "empty turn_id must be rejected"
        );

        // Missing session id is also rejected.
        let ctx_no_session = BackendRequestContext {
            session_id: None,
            turn_id: Some("turn-1".into()),
            client_timeout_ms: None,
            trusted_kernel_generation: None,
        };
        assert!(
            require_mutation_context(methods::RESUME_CONTROL, &ctx_no_session).is_err(),
            "resume without session_id must be rejected"
        );
    }

    /// With both ids present, resume carries turn authority and passes the gate.
    #[test]
    fn resume_control_allowed_with_full_turn_authority() {
        let ctx = BackendRequestContext {
            session_id: Some("sess-1".into()),
            turn_id: Some("turn-1".into()),
            client_timeout_ms: None,
            trusted_kernel_generation: None,
        };
        assert!(require_mutation_context(methods::RESUME_CONTROL, &ctx).is_ok());
    }

    #[tokio::test]
    async fn tab_lock_is_evicted_and_reevicting_absent_key_is_noop() {
        let dispatcher = Dispatcher::new_for_test();
        // A normal mutating use mints a tab-lock entry.
        let _ = dispatcher.tab_operation_lock("tab-A").await;
        assert_eq!(dispatcher.tab_lock_count().await, 1);
        // Lifecycle teardown drops it.
        dispatcher.evict_tab_lock("tab-A").await;
        assert_eq!(dispatcher.tab_lock_count().await, 0);
        // Evicting an absent key is a harmless no-op.
        dispatcher.evict_tab_lock("tab-A").await;
        assert_eq!(dispatcher.tab_lock_count().await, 0);
    }

    #[tokio::test]
    async fn session_lock_is_evicted_on_finalize() {
        let dispatcher = Dispatcher::new_for_test();
        let _ = dispatcher.session_operation_lock("sess-1").await;
        assert_eq!(dispatcher.session_lock_count().await, 1);
        dispatcher.evict_session_lock("sess-1").await;
        assert_eq!(dispatcher.session_lock_count().await, 0);
    }
}

//! WebSocket transport for Chrome DevTools Protocol.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
#[cfg(test)]
use tokio::sync::Notify;
use tokio::sync::{Mutex, broadcast, oneshot, watch};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;

use super::error::CdpError;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);

type WsStream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;
type WsSink = futures_util::stream::SplitSink<WsStream, Message>;
type WsSource = futures_util::stream::SplitStream<WsStream>;

/// CDP event emitted by the browser.
#[derive(Debug, Clone)]
pub struct CdpEvent {
    /// Optional target session id.
    pub session_id: Option<String>,
    /// Event method name.
    pub method: String,
    /// Event params.
    pub params: Value,
}

const DEFAULT_RECONNECT_MAX_ATTEMPTS: u32 = 6;
const DEFAULT_RECONNECT_BACKOFF_MS: u64 = 250;
const RECONNECT_BACKOFF_CAP: Duration = Duration::from_millis(5000);

/// Bounded reconnect policy for the CDP read pump.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ReconnectConfig {
    /// Maximum consecutive failed `connect_async` attempts before going terminal.
    pub(crate) max_attempts: u32,
    /// First backoff delay; doubles each attempt up to `max_backoff`.
    pub(crate) initial_backoff: Duration,
    /// Backoff ceiling.
    pub(crate) max_backoff: Duration,
}

impl ReconnectConfig {
    fn from_env() -> Self {
        let max_attempts = std::env::var("OBU_CDP_RECONNECT_MAX_ATTEMPTS")
            .ok()
            .and_then(|raw| raw.parse::<u32>().ok())
            .filter(|value| *value >= 1)
            .unwrap_or(DEFAULT_RECONNECT_MAX_ATTEMPTS);
        let backoff_ms = std::env::var("OBU_CDP_RECONNECT_BACKOFF_MS")
            .ok()
            .and_then(|raw| raw.parse::<u64>().ok())
            .unwrap_or(DEFAULT_RECONNECT_BACKOFF_MS);
        Self {
            max_attempts,
            initial_backoff: Duration::from_millis(backoff_ms),
            max_backoff: RECONNECT_BACKOFF_CAP,
        }
    }

    #[cfg(test)]
    pub(crate) fn fast_for_tests() -> Self {
        Self {
            max_attempts: 4,
            initial_backoff: Duration::from_millis(1),
            max_backoff: Duration::from_millis(5),
        }
    }
}

/// Request/response correlated CDP transport with bounded auto-reconnect.
pub struct CdpTransport {
    next_id: AtomicU64,
    pending: StdMutex<HashMap<u64, oneshot::Sender<Result<Value, CdpError>>>>,
    /// `None` while reconnecting or after the reconnect budget is exhausted.
    write: Mutex<Option<WsSink>>,
    events: broadcast::Sender<CdpEvent>,
    /// Endpoint to reconnect to (validated once at connect time).
    ws_url: String,
    /// Bumped after every successful reconnect; backend re-establishes sessions.
    reconnect_gen: watch::Sender<u64>,
    /// Set once the reconnect budget is exhausted: the transport is dead.
    terminal: AtomicBool,
    /// Set while the read pump is between sockets; new commands must not write
    /// to the old sink once the reader has ended.
    reconnecting: AtomicBool,
    #[cfg(test)]
    after_connection_end_pause: StdMutex<Option<Arc<ConnectionEndPause>>>,
}

#[cfg(test)]
struct ConnectionEndPause {
    reached: Notify,
    proceed: Notify,
}

#[cfg(test)]
impl ConnectionEndPause {
    fn new() -> Self {
        Self {
            reached: Notify::new(),
            proceed: Notify::new(),
        }
    }
}

struct PendingRemovalGuard<'a, K, V>
where
    K: Copy + Eq + Hash,
{
    pending: &'a StdMutex<HashMap<K, V>>,
    id: K,
}

impl<K, V> Drop for PendingRemovalGuard<'_, K, V>
where
    K: Copy + Eq + Hash,
{
    fn drop(&mut self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&self.id);
        }
    }
}

impl CdpTransport {
    /// Connect to a browser CDP WebSocket endpoint with the env-configured
    /// reconnect policy.
    pub async fn connect(url: &str) -> Result<Arc<Self>, CdpError> {
        Self::connect_with_config(url, ReconnectConfig::from_env()).await
    }

    /// Connect with an explicit reconnect policy (tests use a fast policy).
    pub(crate) async fn connect_with_config(
        url: &str,
        config: ReconnectConfig,
    ) -> Result<Arc<Self>, CdpError> {
        let parsed = url::Url::parse(url).map_err(|error| {
            CdpError::Protocol(format!("invalid CDP websocket URL {url}: {error}"))
        })?;
        let ws_url = parsed.as_str().to_string();
        let (write, read) = Self::dial(&ws_url).await?;
        let (events, _) = broadcast::channel(1024);
        let (reconnect_gen, _) = watch::channel(0u64);
        let transport = Arc::new(Self {
            next_id: AtomicU64::new(1),
            pending: StdMutex::new(HashMap::new()),
            write: Mutex::new(Some(write)),
            events,
            ws_url,
            reconnect_gen,
            terminal: AtomicBool::new(false),
            reconnecting: AtomicBool::new(false),
            #[cfg(test)]
            after_connection_end_pause: StdMutex::new(None),
        });

        let pump_transport = transport.clone();
        tokio::spawn(async move {
            pump_transport.run_read_pump(read, config).await;
        });

        Ok(transport)
    }

    /// Open one WebSocket connection and split it.
    async fn dial(ws_url: &str) -> Result<(WsSink, WsSource), CdpError> {
        let (ws, _) = tokio_tungstenite::connect_async(ws_url).await?;
        Ok(ws.split())
    }

    /// Subscribe to the reconnect-generation counter (bumped after each
    /// successful reconnect). The initial value `0` never fires `changed()`.
    pub(crate) fn subscribe_reconnects(&self) -> watch::Receiver<u64> {
        self.reconnect_gen.subscribe()
    }

    /// Resolve and drop every in-flight request with a freshly built error.
    fn fail_all_pending(&self, make_error: impl Fn() -> CdpError) {
        let drained: Vec<_> = {
            let mut pending = self.pending.lock().expect("cdp pending lock");
            pending.drain().map(|(_, tx)| tx).collect()
        };
        for tx in drained {
            let _ = tx.send(Err(make_error()));
        }
    }

    #[cfg(test)]
    fn pause_after_connection_end_for_test(&self) -> Arc<ConnectionEndPause> {
        let pause = Arc::new(ConnectionEndPause::new());
        *self
            .after_connection_end_pause
            .lock()
            .expect("connection-end pause lock") = Some(pause.clone());
        pause
    }

    #[cfg(test)]
    async fn maybe_pause_after_connection_end_for_test(&self) {
        let pause = self
            .after_connection_end_pause
            .lock()
            .expect("connection-end pause lock")
            .take();
        if let Some(pause) = pause {
            pause.reached.notify_waiters();
            pause.proceed.notified().await;
        }
    }

    #[cfg(not(test))]
    async fn maybe_pause_after_connection_end_for_test(&self) {}

    /// Supervised read pump: drain the current connection until it ends, then
    /// reconnect (bounded backoff) and resume, or go terminal once exhausted.
    async fn run_read_pump(self: Arc<Self>, mut read: WsSource, config: ReconnectConfig) {
        loop {
            // Pump frames until the connection ends (Close / read Err / None).
            self.drain_connection(&mut read).await;

            // The connection ended. In-flight requests were not delivered:
            // first gate new sends away from the old sink, then resolve every
            // pending request retryably. The order matters: a send that starts
            // after the pending drain must still see `Reconnecting` instead of
            // writing to the closed sink and hanging or surfacing a hard
            // WebSocket error.
            self.reconnecting.store(true, Ordering::SeqCst);
            *self.write.lock().await = None;
            self.fail_all_pending(|| CdpError::Reconnecting);
            self.maybe_pause_after_connection_end_for_test().await;

            match self.reconnect(config).await {
                Some((new_write, new_read)) => {
                    *self.write.lock().await = Some(new_write);
                    read = new_read;
                    self.reconnecting.store(false, Ordering::SeqCst);
                    let next = self.reconnect_gen.borrow().wrapping_add(1);
                    let _ = self.reconnect_gen.send(next);
                    tracing::info!(generation = next, "CDP transport reconnected");
                    // Loop: resume draining the fresh connection.
                }
                None => {
                    self.terminal.store(true, Ordering::SeqCst);
                    self.fail_all_pending(|| CdpError::Disconnected);
                    tracing::error!(
                        "CDP transport reconnect budget exhausted; transport is permanently disconnected"
                    );
                    return;
                }
            }
        }
    }

    /// Read frames from the current connection until it ends. Returns when the
    /// stream yields `Close`, a read `Err`, or `None` — all treated the same
    /// (the supervisor decides fatal-vs-transient by whether reconnect succeeds).
    async fn drain_connection(&self, read: &mut WsSource) {
        while let Some(message) = read.next().await {
            let bytes = match message {
                Ok(Message::Text(text)) => text.to_string().into_bytes(),
                Ok(Message::Binary(bytes)) => bytes.to_vec(),
                Ok(Message::Close(_)) => return,
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => {
                    continue;
                }
                Err(error) => {
                    tracing::warn!(%error, "CDP websocket read error; will attempt reconnect");
                    return;
                }
            };
            let value: Value = match serde_json::from_slice(&bytes) {
                Ok(value) => value,
                Err(error) => {
                    tracing::warn!(%error, "CDP websocket frame was not JSON");
                    continue;
                }
            };
            if let Some(id) = value.get("id").and_then(Value::as_u64) {
                let result = if let Some(error) = value.get("error") {
                    Err(CdpError::Remote {
                        code: error.get("code").and_then(Value::as_i64).unwrap_or(-1),
                        message: error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("cdp error")
                            .to_string(),
                    })
                } else {
                    Ok(value.get("result").cloned().unwrap_or(Value::Null))
                };
                if let Some(tx) = self.pending.lock().expect("cdp pending lock").remove(&id) {
                    let _ = tx.send(result);
                }
                continue;
            }

            if let Some(method) = value.get("method").and_then(Value::as_str) {
                let _ = self.events.send(CdpEvent {
                    session_id: value
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .map(String::from),
                    method: method.to_string(),
                    params: value.get("params").cloned().unwrap_or(Value::Null),
                });
            }
        }
    }

    /// Reconnect to `ws_url` with bounded exponential backoff. `Some` on the
    /// first success, `None` once `max_attempts` consecutive dials have failed.
    async fn reconnect(&self, config: ReconnectConfig) -> Option<(WsSink, WsSource)> {
        let mut backoff = config.initial_backoff;
        for attempt in 1..=config.max_attempts {
            tokio::time::sleep(backoff).await;
            match Self::dial(&self.ws_url).await {
                Ok(split) => return Some(split),
                Err(error) => {
                    tracing::warn!(
                        attempt,
                        max = config.max_attempts,
                        %error,
                        "CDP reconnect attempt failed"
                    );
                    backoff = (backoff * 2).min(config.max_backoff);
                }
            }
        }
        None
    }

    /// Send one CDP command.
    pub async fn send_command(
        &self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
    ) -> Result<Value, CdpError> {
        if self.terminal.load(Ordering::SeqCst) {
            return Err(CdpError::Disconnected);
        }
        if self.reconnecting.load(Ordering::SeqCst) {
            return Err(CdpError::Reconnecting);
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut payload = json!({
            "id": id,
            "method": method,
            "params": params,
        });
        if let Some(session_id) = session_id {
            payload["sessionId"] = Value::String(session_id.to_string());
        }

        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("cdp pending lock")
            .insert(id, tx);
        let _pending_guard = PendingRemovalGuard {
            pending: &self.pending,
            id,
        };
        if self.reconnecting.load(Ordering::SeqCst) {
            return Err(CdpError::Reconnecting);
        }
        {
            let mut write = self.write.lock().await;
            if self.reconnecting.load(Ordering::SeqCst) {
                return Err(CdpError::Reconnecting);
            }
            let Some(sink) = write.as_mut() else {
                // No live sink: reconnecting (retryable) or terminally dead.
                return Err(if self.terminal.load(Ordering::SeqCst) {
                    CdpError::Disconnected
                } else {
                    CdpError::Reconnecting
                });
            };
            if let Err(error) = sink.send(Message::Text(payload.to_string().into())).await {
                return Err(error.into());
            }
        }

        let command_timeout = crate::backends::current_client_timeout().unwrap_or(DEFAULT_TIMEOUT);
        match timeout(command_timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(CdpError::Disconnected),
            Err(_) => Err(CdpError::Timeout(command_timeout)),
        }
    }

    /// Subscribe to CDP events.
    pub fn subscribe_events(&self) -> broadcast::Receiver<CdpEvent> {
        self.events.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::ReconnectConfig;
    use super::{CdpError, CdpTransport, PendingRemovalGuard};
    use crate::backends::cdp::test_support::{FakeCdpServer, wait_until};
    use crate::backends::scope_client_timeout;
    use futures_util::StreamExt;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message;

    #[test]
    fn pending_guard_removes_entry_on_drop() {
        let pending = Mutex::new(HashMap::from([(7_u64, "pending")]));
        {
            let _guard = PendingRemovalGuard {
                pending: &pending,
                id: 7,
            };
            assert!(pending.lock().expect("pending lock").contains_key(&7));
        }
        assert!(!pending.lock().expect("pending lock").contains_key(&7));
    }

    #[tokio::test]
    async fn command_timeout_uses_scoped_client_timeout() {
        let timeout = scope_client_timeout(Some(60_000), async {
            crate::backends::current_client_timeout()
        })
        .await;

        assert_eq!(timeout, Some(Duration::from_secs(60)));
    }

    #[tokio::test]
    async fn send_command_honors_scoped_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (request_received_tx, request_received_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let request = ws.next().await.unwrap().unwrap();
            match request {
                Message::Text(_) | Message::Binary(_) => {}
                other => panic!("unexpected websocket message: {other:?}"),
            }
            let _ = request_received_tx.send(());
            futures_util::future::pending::<()>().await;
        });

        let transport = CdpTransport::connect(&format!("ws://{addr}/devtools/browser/fake"))
            .await
            .unwrap();
        let request = tokio::spawn(async move {
            scope_client_timeout(Some(25), async {
                transport
                    .send_command("Runtime.evaluate", json!({}), None)
                    .await
            })
            .await
        });

        request_received_rx.await.unwrap();
        let error = request.await.unwrap().unwrap_err();
        let CdpError::Timeout(actual) = error else {
            panic!("expected scoped timeout, got {error:?}");
        };
        assert_eq!(actual, Duration::from_millis(25));
    }

    #[tokio::test]
    async fn inflight_command_resolves_retryable_then_transport_recovers() {
        let server = FakeCdpServer::start().await;
        let transport =
            CdpTransport::connect_with_config(server.ws_url(), ReconnectConfig::fast_for_tests())
                .await
                .unwrap();

        // Withhold the reply so the command stays in-flight, then drop the socket.
        server.set_withhold(true);
        let inflight_transport = transport.clone();
        let inflight = tokio::spawn(async move {
            inflight_transport
                .send_command("Runtime.evaluate", json!({}), None)
                .await
        });
        assert!(
            wait_until(|| !server.requests().is_empty()).await,
            "server never received the in-flight command"
        );
        server.drop_active_connection();

        // The interrupted request resolves retryably (not a 10s hang).
        let error = inflight.await.unwrap().unwrap_err();
        assert!(matches!(error, CdpError::Reconnecting), "got {error:?}");

        // The transport reconnected; a fresh command now succeeds.
        server.set_withhold(false);
        assert!(
            wait_until(|| server.connection_count() >= 2).await,
            "transport did not reconnect"
        );
        let mut recovered = None;
        for _ in 0..200 {
            match transport
                .send_command("Runtime.evaluate", json!({}), None)
                .await
            {
                Ok(value) => {
                    recovered = Some(value);
                    break;
                }
                // Tolerate the brief window where the write sink is being swapped.
                Err(CdpError::Reconnecting) => {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                Err(other) => panic!("unexpected post-reconnect error: {other:?}"),
            }
        }
        assert!(
            recovered.is_some(),
            "transport never recovered after reconnect"
        );
    }

    #[tokio::test]
    async fn command_started_after_connection_end_gets_reconnecting_not_old_sink() {
        let server = FakeCdpServer::start().await;
        let transport =
            CdpTransport::connect_with_config(server.ws_url(), ReconnectConfig::fast_for_tests())
                .await
                .unwrap();
        transport
            .send_command("Target.getTargets", json!({}), None)
            .await
            .unwrap();

        let pause = transport.pause_after_connection_end_for_test();
        server.drop_active_connection();
        pause.reached.notified().await;

        let before = server.requests().len();
        let error = scope_client_timeout(Some(25), async {
            transport
                .send_command("Runtime.evaluate", json!({}), None)
                .await
        })
        .await
        .unwrap_err();
        let after = server.requests().len();
        pause.proceed.notify_waiters();

        assert!(matches!(error, CdpError::Reconnecting), "got {error:?}");
        assert_eq!(
            after, before,
            "command started after connection end must not be written to the old sink"
        );
    }

    #[tokio::test]
    async fn reconnect_budget_exhausted_marks_transport_terminal() {
        let server = FakeCdpServer::start().await;
        let transport =
            CdpTransport::connect_with_config(server.ws_url(), ReconnectConfig::fast_for_tests())
                .await
                .unwrap();

        // Permanently stop the server (Drop aborts the accept loop + live conn),
        // so every reconnect dial fails and the budget is exhausted.
        drop(server);

        // Within the budget (4 attempts * <=5ms backoff) the transport goes
        // terminal and reports a hard Disconnected, not an endless Reconnecting.
        let became_terminal = wait_until_disconnected(&transport).await;
        assert!(
            became_terminal,
            "transport never went terminal after server death"
        );
    }

    async fn wait_until_disconnected(transport: &CdpTransport) -> bool {
        for _ in 0..400 {
            match transport
                .send_command("Runtime.evaluate", json!({}), None)
                .await
            {
                Err(CdpError::Disconnected) => return true,
                _ => tokio::time::sleep(Duration::from_millis(5)).await,
            }
        }
        false
    }

    #[tokio::test]
    async fn close_frame_triggers_reconnect_not_permanent_teardown() {
        // A clean Close from the browser must be transient: the transport
        // reconnects and keeps serving, instead of bricking every session.
        let server = FakeCdpServer::start().await;
        let transport =
            CdpTransport::connect_with_config(server.ws_url(), ReconnectConfig::fast_for_tests())
                .await
                .unwrap();
        // First command round-trips on connection #1.
        transport
            .send_command("Target.getTargets", json!({}), None)
            .await
            .unwrap();
        // Drop the live socket; the pump should reconnect on its own.
        server.drop_active_connection();
        assert!(
            wait_until(|| server.connection_count() >= 2).await,
            "transport did not reconnect after the connection dropped"
        );
        let mut recovered = false;
        for _ in 0..200 {
            match transport
                .send_command("Target.getTargets", json!({}), None)
                .await
            {
                Ok(_) => {
                    recovered = true;
                    break;
                }
                Err(CdpError::Reconnecting) => tokio::time::sleep(Duration::from_millis(5)).await,
                Err(other) => panic!("unexpected error: {other:?}"),
            }
        }
        assert!(
            recovered,
            "transport did not recover after a transient drop"
        );
    }
}

//! Test-only fake CDP browser WebSocket server for transport reconnect tests.
//!
//! Auto-responds to every command (`Target.attachToTarget` -> a fresh unique
//! `sessionId`; any other method -> `{}`), records every received request frame
//! for assertions, and can forcibly drop the live connection to simulate a
//! transient WebSocket failure. Accepts unlimited sequential connections on one
//! port, so a client that reconnects to the same `ws_url` is served again.
#![cfg(test)]

use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::AbortHandle;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

#[derive(Default)]
struct State {
    requests: Vec<Value>,
    withhold: bool,
    attach_error: bool,
    connections: usize,
    active: Option<AbortHandle>,
    next_session: u64,
}

/// A controllable in-process CDP WebSocket server.
pub(crate) struct FakeCdpServer {
    state: Arc<Mutex<State>>,
    ws_url: String,
    accept: AbortHandle,
}

impl FakeCdpServer {
    pub(crate) async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let state = Arc::new(Mutex::new(State::default()));
        let accept_state = state.clone();
        let accept = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let ws = match tokio_tungstenite::accept_async(stream).await {
                    Ok(ws) => ws,
                    Err(_) => continue,
                };
                let conn_state = accept_state.clone();
                let conn = tokio::spawn(serve_connection(ws, conn_state));
                let mut guard = accept_state.lock().unwrap();
                guard.connections += 1;
                guard.active = Some(conn.abort_handle());
            }
        });
        Self {
            state,
            ws_url: format!("ws://{addr}/devtools/browser/fake"),
            accept: accept.abort_handle(),
        }
    }

    pub(crate) fn ws_url(&self) -> &str {
        &self.ws_url
    }

    /// When true, the server records but never answers subsequent commands.
    pub(crate) fn set_withhold(&self, withhold: bool) {
        self.state.lock().unwrap().withhold = withhold;
    }

    /// When true, `Target.attachToTarget` is answered with a CDP error frame.
    pub(crate) fn set_attach_error(&self, attach_error: bool) {
        self.state.lock().unwrap().attach_error = attach_error;
    }

    /// Abort the live connection task, closing its socket (transient failure).
    pub(crate) fn drop_active_connection(&self) {
        if let Some(handle) = self.state.lock().unwrap().active.take() {
            handle.abort();
        }
    }

    pub(crate) fn requests(&self) -> Vec<Value> {
        self.state.lock().unwrap().requests.clone()
    }

    pub(crate) fn connection_count(&self) -> usize {
        self.state.lock().unwrap().connections
    }
}

impl Drop for FakeCdpServer {
    fn drop(&mut self) {
        self.accept.abort();
        if let Some(handle) = self.state.lock().unwrap().active.take() {
            handle.abort();
        }
    }
}

async fn serve_connection(mut ws: WebSocketStream<TcpStream>, state: Arc<Mutex<State>>) {
    while let Some(Ok(message)) = ws.next().await {
        let text = match message {
            Message::Text(text) => text.to_string(),
            Message::Binary(bytes) => String::from_utf8_lossy(&bytes).to_string(),
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let id = value.get("id").and_then(Value::as_u64);
        let method = value
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let (withhold, attach_error, session) = {
            let mut guard = state.lock().unwrap();
            guard.requests.push(value.clone());
            guard.next_session += 1;
            (guard.withhold, guard.attach_error, guard.next_session)
        };
        let Some(id) = id else { continue };
        if withhold {
            continue;
        }
        let reply = if method == "Target.attachToTarget" && attach_error {
            json!({ "id": id, "error": { "code": -32000, "message": "no such target" } })
        } else if method == "Target.attachToTarget" {
            json!({ "id": id, "result": { "sessionId": format!("session-{session}") } })
        } else {
            json!({ "id": id, "result": {} })
        };
        let _ = ws.send(Message::Text(reply.to_string().into())).await;
    }
}

/// Poll `predicate` every 5ms until it returns true or ~2s elapses.
/// Returns whether the predicate became true (false on timeout).
pub(crate) async fn wait_until(mut predicate: impl FnMut() -> bool) -> bool {
    for _ in 0..400 {
        if predicate() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    predicate()
}

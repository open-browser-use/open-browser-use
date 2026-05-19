//! WebSocket transport for Chrome DevTools Protocol.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, broadcast, oneshot};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;

use super::error::CdpError;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);

type WsStream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

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

/// Request/response correlated CDP transport.
pub struct CdpTransport {
    next_id: Mutex<u64>,
    pending: StdMutex<HashMap<u64, oneshot::Sender<Result<Value, CdpError>>>>,
    write: Mutex<futures_util::stream::SplitSink<WsStream, Message>>,
    events: broadcast::Sender<CdpEvent>,
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
    /// Connect to a browser CDP WebSocket endpoint.
    pub async fn connect(url: &str) -> Result<Arc<Self>, CdpError> {
        let parsed = url::Url::parse(url).map_err(|error| {
            CdpError::Protocol(format!("invalid CDP websocket URL {url}: {error}"))
        })?;
        let (ws, _) = tokio_tungstenite::connect_async(parsed.as_str()).await?;
        let (write, mut read) = ws.split();
        let (events, _) = broadcast::channel(1024);
        let transport = Arc::new(Self {
            next_id: Mutex::new(1),
            pending: StdMutex::new(HashMap::new()),
            write: Mutex::new(write),
            events: events.clone(),
        });

        let reader_transport = transport.clone();
        tokio::spawn(async move {
            while let Some(message) = read.next().await {
                let bytes = match message {
                    Ok(Message::Text(text)) => text.to_string().into_bytes(),
                    Ok(Message::Binary(bytes)) => bytes.to_vec(),
                    Ok(Message::Close(_)) => break,
                    Ok(Message::Ping(_)) | Ok(Message::Pong(_)) | Ok(Message::Frame(_)) => {
                        continue;
                    }
                    Err(error) => {
                        tracing::warn!(%error, "CDP websocket read error");
                        break;
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
                    if let Some(tx) = reader_transport
                        .pending
                        .lock()
                        .expect("cdp pending lock")
                        .remove(&id)
                    {
                        let _ = tx.send(result);
                    }
                    continue;
                }

                if let Some(method) = value.get("method").and_then(Value::as_str) {
                    let _ = events.send(CdpEvent {
                        session_id: value
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .map(String::from),
                        method: method.to_string(),
                        params: value.get("params").cloned().unwrap_or(Value::Null),
                    });
                }
            }

            for (_, tx) in reader_transport
                .pending
                .lock()
                .expect("cdp pending lock")
                .drain()
            {
                let _ = tx.send(Err(CdpError::Disconnected));
            }
        });

        Ok(transport)
    }

    /// Send one CDP command.
    pub async fn send_command(
        &self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
    ) -> Result<Value, CdpError> {
        let id = {
            let mut next = self.next_id.lock().await;
            let id = *next;
            *next += 1;
            id
        };
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
        if let Err(error) = self
            .write
            .lock()
            .await
            .send(Message::Text(payload.to_string().into()))
            .await
        {
            return Err(error.into());
        }

        match timeout(DEFAULT_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(CdpError::Disconnected),
            Err(_) => Err(CdpError::Timeout(DEFAULT_TIMEOUT)),
        }
    }

    /// Subscribe to CDP events.
    pub fn subscribe_events(&self) -> broadcast::Receiver<CdpEvent> {
        self.events.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::PendingRemovalGuard;
    use std::collections::HashMap;
    use std::sync::Mutex;

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
}

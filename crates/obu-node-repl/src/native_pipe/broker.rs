//! Native-pipe broker core.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use tokio::sync::{Mutex, Semaphore, mpsc};
use uuid::Uuid;

use super::connection::NativePipeConnection;
use super::protocol::{
    KernelIn, NativePipeClosed, NativePipeData, NativePipeOp, NativePipeRequest, NativePipeResponse,
};

/// Native-pipe broker.
pub struct NativePipeBroker {
    connections: Mutex<HashMap<String, Arc<NativePipeConnection>>>,
    outbox: mpsc::Sender<KernelIn>,
    connect_timeout: Duration,
    connect_limiter: Semaphore,
    allowed_paths: Option<Vec<PathBuf>>,
    capability_token: Option<String>,
    capability_tokens_by_path: RwLock<HashMap<PathBuf, String>>,
}

impl NativePipeBroker {
    /// Create a broker.
    pub fn new(
        outbox: mpsc::Sender<KernelIn>,
        connect_timeout: Duration,
        allowed_paths: Option<Vec<PathBuf>>,
    ) -> Self {
        Self::with_policy(outbox, connect_timeout, allowed_paths, None)
    }

    /// Create a broker with the full parent-only policy.
    pub fn with_policy(
        outbox: mpsc::Sender<KernelIn>,
        connect_timeout: Duration,
        allowed_paths: Option<Vec<PathBuf>>,
        capability_token: Option<String>,
    ) -> Self {
        Self::with_token_map(
            outbox,
            connect_timeout,
            allowed_paths,
            capability_token,
            HashMap::new(),
        )
    }

    /// Create a broker with path-specific capability tokens.
    pub fn with_token_map(
        outbox: mpsc::Sender<KernelIn>,
        connect_timeout: Duration,
        allowed_paths: Option<Vec<PathBuf>>,
        capability_token: Option<String>,
        capability_tokens_by_path: HashMap<PathBuf, String>,
    ) -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            outbox,
            connect_timeout,
            connect_limiter: Semaphore::new(8),
            allowed_paths,
            capability_token,
            capability_tokens_by_path: RwLock::new(capability_tokens_by_path),
        }
    }

    /// Replace path-specific capability tokens discovered from runtime descriptors.
    pub fn set_capability_tokens_by_path(
        &self,
        capability_tokens_by_path: HashMap<PathBuf, String>,
    ) {
        *self
            .capability_tokens_by_path
            .write()
            .expect("native pipe token map lock") = capability_tokens_by_path;
    }

    /// Dispatch one kernel request and return its response.
    pub async fn dispatch(self: &Arc<Self>, request: NativePipeRequest) -> NativePipeResponse {
        let id = request.id.clone();
        let result = match request.op {
            NativePipeOp::Connect { path } => self.clone().connect(path).await,
            NativePipeOp::Write {
                connection_id,
                data_base64,
            } => self.write(connection_id, data_base64).await,
            NativePipeOp::Close { connection_id } => self.close(connection_id).await,
        };
        match result {
            Ok(result) => NativePipeResponse {
                id,
                ok: true,
                error: None,
                result,
            },
            Err(error) => NativePipeResponse {
                id,
                ok: false,
                error: Some(error.to_string()),
                result: None,
            },
        }
    }

    /// Dispatch one kernel request and send the response to kernel stdin.
    pub async fn dispatch_request(self: Arc<Self>, request: NativePipeRequest) {
        let response = self.dispatch(request).await;
        let _ = self
            .outbox
            .send(KernelIn::NativePipeResponse(response))
            .await;
    }

    /// Close all open native-pipe connections.
    pub async fn close_all(&self) {
        let connections = {
            let mut guard = self.connections.lock().await;
            std::mem::take(&mut *guard)
        };
        for connection in connections.into_values() {
            let _ = connection.shutdown().await;
        }
    }

    async fn connect(
        self: Arc<Self>,
        raw_path: String,
    ) -> std::io::Result<Option<serde_json::Value>> {
        let _permit = self.connect_limiter.acquire().await.map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "native pipe connect limiter closed",
            )
        })?;
        let path = self.validate_path(&raw_path)?;
        let connection =
            Arc::new(NativePipeConnection::connect(&path, self.connect_timeout).await?);
        if let Some(token) = self.token_for_path(&path) {
            connection.write_all(&encode_auth_frame(&token)?).await?;
            consume_auth_response(&connection, self.connect_timeout).await?;
        }
        let connection_id = format!("conn-{}", Uuid::new_v4().simple());
        self.connections
            .lock()
            .await
            .insert(connection_id.clone(), connection.clone());

        let broker = self.clone();
        let reader_connection_id = connection_id.clone();
        tokio::spawn(async move {
            broker.read_loop(reader_connection_id, connection).await;
        });

        Ok(Some(serde_json::json!({ "connection_id": connection_id })))
    }

    async fn write(
        &self,
        connection_id: String,
        data_base64: String,
    ) -> std::io::Result<Option<serde_json::Value>> {
        let data = B64.decode(data_base64).map_err(|error| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("native pipe data decode failed: {error}"),
            )
        })?;
        let connection = self
            .connections
            .lock()
            .await
            .get(&connection_id)
            .cloned()
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    format!("unknown native pipe connection_id: {connection_id}"),
                )
            })?;
        connection.write_all(&data).await?;
        Ok(None)
    }

    async fn close(&self, connection_id: String) -> std::io::Result<Option<serde_json::Value>> {
        if let Some(connection) = self.connections.lock().await.remove(&connection_id) {
            connection.shutdown().await?;
        }
        Ok(None)
    }

    async fn read_loop(
        self: Arc<Self>,
        connection_id: String,
        connection: Arc<NativePipeConnection>,
    ) {
        loop {
            match connection.read_chunk_or_cancel().await {
                Ok(Some(data)) => {
                    let _ = self
                        .outbox
                        .send(KernelIn::NativePipeData(NativePipeData {
                            connection_id: connection_id.clone(),
                            data_base64: B64.encode(data),
                        }))
                        .await;
                }
                Ok(None) => {
                    let _ = self
                        .outbox
                        .send(KernelIn::NativePipeClosed(NativePipeClosed {
                            connection_id: connection_id.clone(),
                            error: None,
                        }))
                        .await;
                    break;
                }
                Err(error) => {
                    let _ = self
                        .outbox
                        .send(KernelIn::NativePipeClosed(NativePipeClosed {
                            connection_id: connection_id.clone(),
                            error: Some(error.to_string()),
                        }))
                        .await;
                    break;
                }
            }
        }
        self.connections.lock().await.remove(&connection_id);
    }

    fn validate_path(&self, raw: &str) -> std::io::Result<PathBuf> {
        let path = Path::new(raw);
        if !path.is_absolute() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "native pipe path must be absolute",
            ));
        }
        let canonical = std::fs::canonicalize(path).map_err(|error| {
            std::io::Error::new(
                error.kind(),
                format!("native pipe path unavailable: {error}"),
            )
        })?;
        let metadata = std::fs::metadata(&canonical).map_err(|error| {
            std::io::Error::new(error.kind(), format!("native pipe stat failed: {error}"))
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::FileTypeExt;
            if !metadata.file_type().is_socket() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "native pipe path is not a socket",
                ));
            }
        }
        if let Some(allowed) = &self.allowed_paths
            && !allowed
                .iter()
                .any(|allowed_path| allowed_path == &canonical)
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!("native pipe path not allowed: {}", canonical.display()),
            ));
        }
        Ok(canonical)
    }

    fn token_for_path(&self, canonical: &Path) -> Option<String> {
        self.capability_tokens_by_path
            .read()
            .expect("native pipe token map lock")
            .get(canonical)
            .cloned()
            .or_else(|| self.capability_token.clone())
    }
}

/// Canonicalize a socket path for allow-list policy.
pub fn canonical_socket_path(raw: &str) -> std::io::Result<PathBuf> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "native pipe allow-list path must be absolute",
        ));
    }
    std::fs::canonicalize(path)
}

fn encode_auth_frame(token: &str) -> std::io::Result<Vec<u8>> {
    let body = serde_json::to_vec(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": 0,
        "method": "auth",
        "params": {
            "capability_token": token,
        },
    }))
    .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let len = u32::try_from(body.len()).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "native pipe auth frame too large",
        )
    })?;
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&len.to_le_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

async fn consume_auth_response(
    connection: &NativePipeConnection,
    timeout: Duration,
) -> std::io::Result<()> {
    let body = connection.read_exact_framed(timeout).await?;
    let parsed: serde_json::Value = serde_json::from_slice(&body).map_err(|error| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("auth response was not JSON: {error}"),
        )
    })?;
    if let Some(error) = parsed.get("error") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("auth rejected by host: {error}"),
        ));
    }
    Ok(())
}

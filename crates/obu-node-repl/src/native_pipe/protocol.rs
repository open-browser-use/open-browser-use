//! Native-pipe broker frame protocol.
//!
//! The JavaScript kernel speaks newline-delimited JSON over stdio. These frames
//! multiplex trusted `import.meta.__obuNativePipe` socket operations onto that
//! stdio channel.

use serde::{Deserialize, Serialize};

/// Frames emitted by kernel JS to the Rust broker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum KernelOut {
    /// First frame after kernel boot; carries the per-kernel request token.
    NativePipeHandshake(NativePipeHandshake),
    /// Connect, write, or close request.
    NativePipeRequest(NativePipeRequest),
}

/// Frames delivered by the Rust broker to kernel JS.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum KernelIn {
    /// Response to a native-pipe request.
    NativePipeResponse(NativePipeResponse),
    /// Async data from an open socket connection.
    NativePipeData(NativePipeData),
    /// Async close/error event for an open socket connection.
    NativePipeClosed(NativePipeClosed),
}

/// Kernel-generated native-pipe handshake.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativePipeHandshake {
    /// Random per-kernel token required on subsequent requests.
    pub token: String,
}

/// Kernel native-pipe request envelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativePipeRequest {
    /// Kernel request id, echoed in the response.
    pub id: String,
    /// Token from the initial handshake.
    pub token: String,
    /// Requested operation.
    #[serde(flatten)]
    pub op: NativePipeOp,
}

/// Native-pipe request operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum NativePipeOp {
    /// Connect to a privileged native socket path. The broker allocates the
    /// kernel-visible `connection_id`.
    Connect {
        /// Absolute socket path requested by trusted SDK code.
        path: String,
    },
    /// Write bytes to an open connection.
    Write {
        /// Broker-allocated connection handle.
        connection_id: String,
        /// Base64-encoded byte payload.
        data_base64: String,
    },
    /// Close an open connection.
    Close {
        /// Broker-allocated connection handle.
        connection_id: String,
    },
}

/// Broker response envelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativePipeResponse {
    /// Echo of the request id.
    pub id: String,
    /// Whether the request succeeded.
    pub ok: bool,
    /// Error message when `ok` is false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Success payload. Connect returns `{ "connection_id": "..." }`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
}

/// Async data event for an open connection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativePipeData {
    /// Broker-allocated connection handle.
    pub connection_id: String,
    /// Base64-encoded byte payload.
    pub data_base64: String,
}

/// Async close event for an open connection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NativePipeClosed {
    /// Broker-allocated connection handle.
    pub connection_id: String,
    /// Optional close/error reason.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

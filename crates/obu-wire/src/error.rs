//! JSON-RPC 2.0 error codes and envelope-side `ErrorObject`.
//!
//! Error code constants (D-21 ranges):
//! - `-32xxx` JSON-RPC 2.0
//! - `-1000..-1099` server-level
//! - `-1100..-1199` guards
//! - `-1200..-1299` backend
//! - `-2000+` user-program errors

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Defensive or backend timeout.
pub const ERR_TIMEOUT: i32 = -1000;
/// Requested object was not found.
pub const ERR_NOT_FOUND: i32 = -1001;
/// Operation is disallowed at the server level.
pub const ERR_DISALLOWED: i32 = -1002;
/// Feature is not implemented.
pub const ERR_NOT_IMPLEMENTED: i32 = -1003;
/// Protocol violation.
pub const ERR_PROTOCOL: i32 = -1004;
/// No usable browser backend is available.
pub const ERR_NO_BACKEND: i32 = -1005;
/// Generic I/O failure.
pub const ERR_IO: i32 = -1099;

/// Peer/auth gate rejected the connection.
///
/// D9 and the Phase 9 failure-mode test pin wrong capability-token auth to
/// `-1100`, so the dispatcher uses this code for first-frame auth rejection.
pub const ERR_PEER_AUTH: i32 = -1100;
/// Capability-token specific guard code for later structured policy surfaces.
pub const ERR_CAPABILITY_TOKEN: i32 = -1101;
/// Command-level guard rejection.
pub const ERR_CMD_DISALLOWED: i32 = -1102;

/// Page or target has closed.
pub const ERR_PAGE_CLOSED: i32 = -1200;
/// CDP command failed.
pub const ERR_CDP_FAILURE: i32 = -1201;
/// Tab has not been attached.
pub const ERR_TAB_NOT_ATTACHED: i32 = -1202;

/// JSON-RPC 2.0 standard error codes plus an open server-error range.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    /// `-32700` parse error.
    ParseError,
    /// `-32600` invalid request.
    InvalidRequest,
    /// `-32601` method not found.
    MethodNotFound,
    /// `-32602` invalid params.
    InvalidParams,
    /// `-32603` internal error.
    InternalError,
    /// Caller-defined server error.
    Server(i32),
}

impl ErrorCode {
    /// Numeric wire value.
    pub const fn value(self) -> i32 {
        match self {
            Self::ParseError => -32700,
            Self::InvalidRequest => -32600,
            Self::MethodNotFound => -32601,
            Self::InvalidParams => -32602,
            Self::InternalError => -32603,
            Self::Server(v) => v,
        }
    }
}

impl Serialize for ErrorCode {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_i32(self.value())
    }
}

impl<'de> Deserialize<'de> for ErrorCode {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = i32::deserialize(deserializer)?;
        Ok(match value {
            -32700 => Self::ParseError,
            -32600 => Self::InvalidRequest,
            -32601 => Self::MethodNotFound,
            -32602 => Self::InvalidParams,
            -32603 => Self::InternalError,
            other => Self::Server(other),
        })
    }
}

/// JSON-RPC 2.0 error object.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorObject {
    /// Wire error code.
    pub code: ErrorCode,
    /// Human-readable message.
    pub message: String,
    /// Optional structured detail.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl ErrorObject {
    /// Construct an error object.
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    /// Attach a structured `data` payload.
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}

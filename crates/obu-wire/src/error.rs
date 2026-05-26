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

// Wire error code constants live in a generated sibling file; re-export them
// here so the existing `obu_wire::error::ERR_*` paths keep resolving.
#[path = "error_codes.generated.rs"]
mod codes;
pub use codes::*;

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

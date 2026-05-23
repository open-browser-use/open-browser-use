//! Error type for `obu-host`.

use std::io;

use serde_json::Value;
use thiserror::Error;

use obu_wire::frame::FrameError;
use obu_wire::{ErrorCode, ErrorObject};

/// Structured native-dialog decision requirement.
#[derive(Debug, Clone)]
pub struct DialogRequiresDecision {
    /// Human-readable error message.
    pub message: String,
    /// Stable JSON-RPC `error.data` payload.
    pub data: Value,
}

/// Unified host error.
#[derive(Debug, Error)]
pub enum HostError {
    /// I/O error.
    #[error("io: {0}")]
    Io(#[from] io::Error),

    /// Peer authentication rejected a client.
    #[error("peer auth failed: {0}")]
    PeerAuthRefused(String),

    /// Requested backend is not available.
    #[error("backend not available: {0}")]
    NoBackendAvailable(String),

    /// Browser page/target has closed.
    #[error("page closed: {0}")]
    PageClosed(String),

    /// CDP command failed.
    #[error("cdp failure: {0}")]
    CdpFailure(String),

    /// Operation timed out.
    #[error("timeout: {0}")]
    Timeout(String),

    /// Tab has not been attached to a CDP session.
    #[error("tab not attached: {0}")]
    TabNotAttached(String),

    /// Native browser dialog needs an explicit decision.
    #[error("{0}")]
    DialogRequiresDecision(DialogRequiresDecision),

    /// Structured JSON-RPC error returned by the WebExtension side.
    #[error("rpc error: {message}")]
    Rpc {
        /// Wire error code.
        code: ErrorCode,
        /// Human-readable message.
        message: String,
        /// Stable JSON-RPC `error.data` payload when available.
        data: Option<Value>,
    },

    /// Feature is not implemented yet.
    #[error("backend not implemented: {0}")]
    NotImplemented(String),

    /// Protocol-level error.
    #[error("protocol error: {0}")]
    Protocol(String),

    /// Wire frame error.
    #[error("frame error: {0}")]
    Frame(#[from] FrameError),
}

/// `obu-host` result type.
pub type Result<T> = std::result::Result<T, HostError>;

impl HostError {
    /// Preserve a structured JSON-RPC error as it crosses host boundaries.
    pub fn rpc(error: ErrorObject) -> Self {
        Self::Rpc {
            code: error.code,
            message: error.message,
            data: error.data,
        }
    }
}

impl std::fmt::Display for DialogRequiresDecision {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

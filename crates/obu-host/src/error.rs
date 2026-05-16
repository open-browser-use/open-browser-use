//! Error type for `obu-host`.

use std::io;

use thiserror::Error;

use obu_wire::frame::FrameError;

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

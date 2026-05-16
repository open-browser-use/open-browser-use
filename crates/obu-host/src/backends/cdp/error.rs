//! CDP transport errors.

use thiserror::Error;

/// CDP-specific error type.
#[derive(Debug, Error)]
pub enum CdpError {
    /// WebSocket error.
    #[error("websocket: {0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),
    /// JSON error.
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    /// Remote CDP error response.
    #[error("cdp error {code}: {message}")]
    Remote {
        /// CDP error code.
        code: i64,
        /// CDP error message.
        message: String,
    },
    /// Connection closed before a response arrived.
    #[error("disconnected before response")]
    Disconnected,
    /// Request timed out.
    #[error("timeout after {0:?}")]
    Timeout(std::time::Duration),
    /// Protocol issue.
    #[error("protocol: {0}")]
    Protocol(String),
}

impl From<CdpError> for crate::error::HostError {
    fn from(value: CdpError) -> Self {
        match value {
            CdpError::Remote { .. } => Self::CdpFailure(value.to_string()),
            CdpError::Disconnected => Self::NoBackendAvailable(value.to_string()),
            CdpError::Timeout(_) => Self::Timeout(value.to_string()),
            CdpError::WebSocket(_) | CdpError::Json(_) | CdpError::Protocol(_) => {
                Self::Protocol(value.to_string())
            }
        }
    }
}

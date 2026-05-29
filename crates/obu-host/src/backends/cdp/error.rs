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
    /// Connection dropped mid-request and the transport is reconnecting;
    /// the request was not delivered and is safe to retry.
    #[error("transport reconnecting; request not delivered")]
    Reconnecting,
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
            CdpError::Disconnected | CdpError::Reconnecting => {
                Self::NoBackendAvailable(value.to_string())
            }
            CdpError::Timeout(_) => Self::Timeout(value.to_string()),
            CdpError::WebSocket(_) | CdpError::Json(_) | CdpError::Protocol(_) => {
                Self::Protocol(value.to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::CdpError;
    use crate::error::HostError;

    #[test]
    fn reconnecting_maps_to_retryable_no_backend_available() {
        // A transient reconnect must surface as the same retryable class as a
        // momentary disconnect (NoBackendAvailable), never as a hard protocol
        // error — the caller is meant to retry once the transport recovers.
        let mapped = HostError::from(CdpError::Reconnecting);
        assert!(
            matches!(mapped, HostError::NoBackendAvailable(_)),
            "Reconnecting must map to NoBackendAvailable, got {mapped:?}"
        );
        // The message must distinguish it from a terminal disconnect.
        assert!(
            mapped.to_string().contains("reconnect"),
            "message should mention reconnect: {mapped}"
        );
    }
}

//! Resolve user-supplied CDP URLs to browser WebSocket endpoints.

use serde::Deserialize;

use crate::error::{HostError, Result};

#[derive(Deserialize)]
struct VersionInfo {
    #[serde(rename = "webSocketDebuggerUrl")]
    web_socket_debugger_url: String,
}

/// Resolve `ws://...` directly or `http://...` via `/json/version`.
pub async fn resolve_browser_ws(url: &str) -> Result<String> {
    if url.starts_with("ws://") || url.starts_with("wss://") {
        return Ok(url.to_string());
    }
    if url.starts_with("http://") || url.starts_with("https://") {
        let endpoint = format!("{}/json/version", url.trim_end_matches('/'));
        let info = reqwest::get(&endpoint)
            .await
            .map_err(|error| HostError::Protocol(format!("CDP /json/version: {error}")))?
            .json::<VersionInfo>()
            .await
            .map_err(|error| HostError::Protocol(format!("CDP /json/version parse: {error}")))?;
        return Ok(info.web_socket_debugger_url);
    }
    Err(HostError::Protocol(format!(
        "CDP URL must be ws://, wss://, http://, or https://; got {url}"
    )))
}

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

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    #[tokio::test]
    async fn resolves_websocket_urls_without_http_discovery() {
        assert_eq!(
            resolve_browser_ws("ws://127.0.0.1:9222/devtools/browser/id")
                .await
                .unwrap(),
            "ws://127.0.0.1:9222/devtools/browser/id"
        );
        assert_eq!(
            resolve_browser_ws("wss://example.test/devtools/browser/id")
                .await
                .unwrap(),
            "wss://example.test/devtools/browser/id"
        );
    }

    #[tokio::test]
    async fn resolves_http_urls_through_json_version() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let bytes_read = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..bytes_read]);
            assert!(
                request.starts_with("GET /json/version HTTP/1.1"),
                "{request}"
            );

            let body = r#"{"webSocketDebuggerUrl":"ws://127.0.0.1/devtools/browser/test"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        let resolved = resolve_browser_ws(&format!("http://{addr}/"))
            .await
            .unwrap();

        assert_eq!(resolved, "ws://127.0.0.1/devtools/browser/test");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_urls_with_unsupported_scheme() {
        let error = resolve_browser_ws("file:///tmp/browser")
            .await
            .expect_err("unsupported scheme should fail");

        assert!(error.to_string().contains("CDP URL must be"));
    }
}

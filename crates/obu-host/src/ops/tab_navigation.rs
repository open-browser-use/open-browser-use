//! Shared tab navigation and metadata operations.

use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::error::{HostError, Result};

const DEFAULT_WAIT_MS: u64 = 30_000;
const POLL_MS: u64 = 50;

/// Backend edge required by shared tab navigation operations.
#[async_trait]
pub(crate) trait TabNavigationBackend {
    /// Execute a CDP command against a tab.
    async fn execute_cdp(&self, tab_id: &str, method: &str, params: Value) -> Result<Value>;

    /// Refresh backend-local tab metadata after navigation.
    async fn refresh_tab_metadata(&self, _tab_id: &str) -> Result<()> {
        Ok(())
    }
}

/// Navigate a tab and wait for load.
pub(crate) async fn goto<B>(backend: &B, tab_id: &str, url: &str) -> Result<Value>
where
    B: TabNavigationBackend + Sync,
{
    let result = backend
        .execute_cdp(tab_id, "Page.navigate", json!({ "url": url }))
        .await?;
    if let Some(error_text) = result.get("errorText").and_then(Value::as_str)
        && !error_text.is_empty()
    {
        let (net_error, retryable) = classify_net_error(error_text);
        return Err(HostError::NavigationFailed {
            url: url.to_string(),
            net_error,
            retryable,
        });
    }
    wait_for_load_state(backend, tab_id, "load", Some(DEFAULT_WAIT_MS)).await?;
    backend.refresh_tab_metadata(tab_id).await?;
    Ok(Value::Null)
}

/// Reload a tab and wait for load.
pub(crate) async fn reload<B>(backend: &B, tab_id: &str) -> Result<Value>
where
    B: TabNavigationBackend + Sync,
{
    backend
        .execute_cdp(tab_id, "Page.reload", json!({}))
        .await?;
    wait_for_load_state(backend, tab_id, "load", Some(DEFAULT_WAIT_MS)).await?;
    backend.refresh_tab_metadata(tab_id).await?;
    Ok(Value::Null)
}

/// Navigate back in session history.
pub(crate) async fn back<B>(backend: &B, tab_id: &str) -> Result<Value>
where
    B: TabNavigationBackend + Sync,
{
    navigate_history_delta(backend, tab_id, -1).await
}

/// Navigate forward in session history.
pub(crate) async fn forward<B>(backend: &B, tab_id: &str) -> Result<Value>
where
    B: TabNavigationBackend + Sync,
{
    navigate_history_delta(backend, tab_id, 1).await
}

/// Wait until the exact URL is observed.
pub(crate) async fn wait_for_url<B>(
    backend: &B,
    tab_id: &str,
    expected_url: &str,
    timeout_ms: Option<u64>,
) -> Result<Value>
where
    B: TabNavigationBackend + Sync,
{
    wait_until(timeout_ms.unwrap_or(DEFAULT_WAIT_MS), || async {
        Ok(url_matches(expected_url, &url(backend, tab_id).await?))
    })
    .await?;
    Ok(Value::Null)
}

/// Wait until the current URL differs from a known starting URL.
pub(crate) async fn wait_for_url_change<B>(
    backend: &B,
    tab_id: &str,
    start_url: &str,
    timeout_ms: Option<u64>,
) -> Result<Value>
where
    B: TabNavigationBackend + Sync,
{
    let timeout_ms = timeout_ms.unwrap_or(DEFAULT_WAIT_MS);
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        if url(backend, tab_id).await? != start_url {
            return Ok(Value::Null);
        }
        if Instant::now() >= deadline {
            return Err(HostError::Timeout(format!(
                "navigation URL change timed out after {timeout_ms}ms"
            )));
        }
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
}

/// Wait for a basic document load state.
pub(crate) async fn wait_for_load_state<B>(
    backend: &B,
    tab_id: &str,
    state: &str,
    timeout_ms: Option<u64>,
) -> Result<Value>
where
    B: TabNavigationBackend + Sync,
{
    let desired = match state {
        "domcontentloaded" => "interactive",
        "load" => "complete",
        other => {
            return Err(HostError::Protocol(format!(
                "unsupported load state {other}; expected load or domcontentloaded"
            )));
        }
    };
    wait_until(timeout_ms.unwrap_or(DEFAULT_WAIT_MS), || async {
        let ready_state = eval_string(backend, tab_id, "document.readyState").await?;
        Ok(match desired {
            "interactive" => ready_state == "interactive" || ready_state == "complete",
            "complete" => ready_state == "complete",
            _ => false,
        })
    })
    .await?;
    Ok(Value::Null)
}

/// Return the current page URL.
pub(crate) async fn url<B>(backend: &B, tab_id: &str) -> Result<String>
where
    B: TabNavigationBackend + Sync,
{
    eval_string(backend, tab_id, "location.href").await
}

/// Return the current page title.
pub(crate) async fn title<B>(backend: &B, tab_id: &str) -> Result<String>
where
    B: TabNavigationBackend + Sync,
{
    eval_string(backend, tab_id, "document.title").await
}

/// Evaluate a JavaScript expression and return a string value.
pub(crate) async fn eval_string<B>(backend: &B, tab_id: &str, expression: &str) -> Result<String>
where
    B: TabNavigationBackend + Sync,
{
    Ok(eval_value(backend, tab_id, expression)
        .await?
        .as_str()
        .unwrap_or_default()
        .to_string())
}

/// Evaluate a JavaScript expression and return its JSON value.
pub(crate) async fn eval_value<B>(backend: &B, tab_id: &str, expression: &str) -> Result<Value>
where
    B: TabNavigationBackend + Sync,
{
    let result = backend
        .execute_cdp(
            tab_id,
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "returnByValue": true,
                "awaitPromise": true,
            }),
        )
        .await?;
    exception_to_error(&result, "Runtime.evaluate")?;
    Ok(result
        .get("result")
        .and_then(|result| result.get("value"))
        .cloned()
        .unwrap_or(Value::Null))
}

fn exception_to_error(result: &Value, label: &str) -> Result<()> {
    if let Some(details) = result.get("exceptionDetails") {
        return Err(HostError::CdpFailure(format!("{label}: {details}")));
    }
    Ok(())
}

async fn navigate_history_delta<B>(backend: &B, tab_id: &str, delta: i64) -> Result<Value>
where
    B: TabNavigationBackend + Sync,
{
    let history = backend
        .execute_cdp(tab_id, "Page.getNavigationHistory", json!({}))
        .await?;
    let current_index = history
        .get("currentIndex")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            HostError::Protocol("Page.getNavigationHistory missing currentIndex".into())
        })?;
    let entries = history
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| HostError::Protocol("Page.getNavigationHistory missing entries".into()))?;
    let target_index = current_index + delta;
    if target_index < 0 || target_index as usize >= entries.len() {
        return Ok(Value::Null);
    }
    let entry_id = entries[target_index as usize]
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| HostError::Protocol("navigation history entry missing id".into()))?;
    backend
        .execute_cdp(
            tab_id,
            "Page.navigateToHistoryEntry",
            json!({ "entryId": entry_id }),
        )
        .await?;
    wait_for_load_state(backend, tab_id, "load", Some(DEFAULT_WAIT_MS)).await?;
    backend.refresh_tab_metadata(tab_id).await?;
    Ok(Value::Null)
}

async fn wait_until<F, Fut>(timeout_ms: u64, mut predicate: F) -> Result<()>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<bool>>,
{
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        if predicate().await? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(HostError::Timeout(format!(
                "condition timed out after {timeout_ms}ms"
            )));
        }
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }
}

/// Match an `actual` URL against a `pattern` using Playwright-style globbing:
/// `*` matches any (possibly empty) run of characters; every other character —
/// including `?` (a URL query separator, never a wildcard) — matches literally.
/// A pattern with no `*` is therefore an exact match (back-compatible).
pub(crate) fn url_matches(pattern: &str, actual: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let a: Vec<char> = actual.chars().collect();
    let (mut pi, mut ai) = (0usize, 0usize);
    let (mut star, mut mark) = (None::<usize>, 0usize);
    while ai < a.len() {
        if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ai;
            pi += 1;
        } else if pi < p.len() && p[pi] == a[ai] {
            pi += 1;
            ai += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ai = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Classify a Chrome `Page.navigate` errorText into (normalized net error,
/// retryable). Transient connectivity failures are retryable; DNS/cert/policy
/// failures are not. Unknown strings default to non-retryable so an agent
/// reports rather than hammering.
pub(crate) fn classify_net_error(error_text: &str) -> (String, bool) {
    const RETRYABLE: &[&str] = &[
        "ERR_CONNECTION_RESET",
        "ERR_CONNECTION_CLOSED",
        "ERR_CONNECTION_ABORTED",
        "ERR_CONNECTION_REFUSED",
        "ERR_CONNECTION_TIMED_OUT",
        "ERR_TIMED_OUT",
        "ERR_NETWORK_CHANGED",
        "ERR_EMPTY_RESPONSE",
        "ERR_SOCKET_NOT_CONNECTED",
    ];
    let retryable = RETRYABLE.iter().any(|code| error_text.contains(code));
    (error_text.to_string(), retryable)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[test]
    fn url_matches_exact_when_no_wildcard() {
        assert!(url_matches("https://x.com/a", "https://x.com/a"));
        assert!(!url_matches("https://x.com/a", "https://x.com/b"));
    }

    #[test]
    fn url_matches_supports_glob_and_double_glob() {
        assert!(url_matches(
            "**/search**",
            "https://www.google.com/search?q=hi"
        ));
        assert!(url_matches(
            "*google.com/search*",
            "https://www.google.com/search?q=hi"
        ));
        assert!(!url_matches(
            "**/results**",
            "https://www.google.com/search?q=hi"
        ));
    }

    #[test]
    fn url_matches_treats_question_mark_literally() {
        // '?' is a query separator in URLs, NOT a wildcard.
        assert!(url_matches("https://x.com/p?q=1", "https://x.com/p?q=1"));
        assert!(!url_matches("https://x.com/p?q=1", "https://x.com/pXq=1"));
    }

    #[test]
    fn classify_net_error_marks_transient_failures_retryable() {
        assert_eq!(
            classify_net_error("net::ERR_CONNECTION_RESET"),
            ("net::ERR_CONNECTION_RESET".to_string(), true)
        );
        assert!(classify_net_error("net::ERR_TIMED_OUT").1);
        assert!(!classify_net_error("net::ERR_NAME_NOT_RESOLVED").1);
        assert!(!classify_net_error("net::ERR_CERT_DATE_INVALID").1);
        assert!(!classify_net_error("weird").1);
    }

    #[derive(Default)]
    struct FakeCdpExecutor {
        calls: Mutex<Vec<(String, Value)>>,
    }

    #[derive(Default)]
    struct FakeWebExtExecutor {
        calls: Mutex<Vec<(String, Value)>>,
    }

    #[async_trait]
    impl TabNavigationBackend for FakeCdpExecutor {
        async fn execute_cdp(&self, _tab_id: &str, method: &str, params: Value) -> Result<Value> {
            fake_execute(&self.calls, method, params)
        }
    }

    #[async_trait]
    impl TabNavigationBackend for FakeWebExtExecutor {
        async fn execute_cdp(&self, _tab_id: &str, method: &str, params: Value) -> Result<Value> {
            fake_execute(&self.calls, method, params)
        }
    }

    #[tokio::test]
    async fn navigation_sequence_is_identical_for_fake_cdp_and_webext_executors() {
        let cdp = FakeCdpExecutor::default();
        let webext = FakeWebExtExecutor::default();

        goto(&cdp, "7", "https://example.test/").await.unwrap();
        goto(&webext, "7", "https://example.test/").await.unwrap();

        assert_eq!(
            cdp.calls.lock().unwrap().as_slice(),
            webext.calls.lock().unwrap().as_slice()
        );
        assert_eq!(
            cdp.calls.lock().unwrap().as_slice(),
            [
                (
                    "Page.navigate".into(),
                    json!({ "url": "https://example.test/" })
                ),
                (
                    "Runtime.evaluate".into(),
                    json!({
                        "expression": "document.readyState",
                        "returnByValue": true,
                        "awaitPromise": true,
                    }),
                ),
            ]
        );
    }

    #[tokio::test]
    async fn metadata_lookup_is_identical_for_fake_cdp_and_webext_executors() {
        let cdp = FakeCdpExecutor::default();
        let webext = FakeWebExtExecutor::default();

        assert_eq!(url(&cdp, "7").await.unwrap(), "https://example.test/");
        assert_eq!(title(&cdp, "7").await.unwrap(), "Example");
        assert_eq!(url(&webext, "7").await.unwrap(), "https://example.test/");
        assert_eq!(title(&webext, "7").await.unwrap(), "Example");

        assert_eq!(
            cdp.calls.lock().unwrap().as_slice(),
            webext.calls.lock().unwrap().as_slice()
        );
    }

    #[tokio::test]
    async fn url_change_wait_sequence_is_identical_for_fake_cdp_and_webext_executors() {
        let cdp = FakeCdpExecutor::default();
        let webext = FakeWebExtExecutor::default();

        wait_for_url_change(&cdp, "7", "about:blank", Some(1))
            .await
            .unwrap();
        wait_for_url_change(&webext, "7", "about:blank", Some(1))
            .await
            .unwrap();

        assert_eq!(
            cdp.calls.lock().unwrap().as_slice(),
            webext.calls.lock().unwrap().as_slice()
        );
        assert_eq!(
            cdp.calls.lock().unwrap().as_slice(),
            [(
                "Runtime.evaluate".into(),
                json!({
                    "expression": "location.href",
                    "returnByValue": true,
                    "awaitPromise": true,
                }),
            )]
        );
    }

    #[tokio::test]
    async fn networkidle_load_state_is_rejected_instead_of_aliasing_complete() {
        let cdp = FakeCdpExecutor::default();
        let error = wait_for_load_state(&cdp, "7", "networkidle", Some(1))
            .await
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("unsupported load state networkidle")
        );
        assert!(cdp.calls.lock().unwrap().is_empty());
    }

    fn fake_execute(
        calls: &Mutex<Vec<(String, Value)>>,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        calls.lock().unwrap().push((method.into(), params.clone()));
        Ok(match method {
            "Page.navigate" | "Page.reload" | "Page.navigateToHistoryEntry" => {
                json!({ "ok": true })
            }
            "Page.getNavigationHistory" => json!({
                "currentIndex": 0,
                "entries": [{ "id": 1, "url": "https://example.test/" }]
            }),
            "Runtime.evaluate" => match params
                .get("expression")
                .and_then(Value::as_str)
                .unwrap_or_default()
            {
                "document.readyState" => runtime_value("complete"),
                "location.href" => runtime_value("https://example.test/"),
                "document.title" => runtime_value("Example"),
                _ => runtime_value(""),
            },
            _ => Value::Null,
        })
    }

    fn runtime_value(value: &str) -> Value {
        json!({ "result": { "value": value } })
    }
}

//! Tab-level CDP command composition.

use serde_json::Value;

use crate::backends::cdp::{CdpBackend, targets};
use crate::error::{HostError, Result};
use crate::methods;

pub mod tab_goto;
pub mod tab_screenshot;

/// Route tab-level JSON-RPC methods to CDP implementations.
pub async fn run_tab_command(backend: &CdpBackend, method: &str, params: Value) -> Result<Value> {
    match method {
        methods::TAB_GOTO => {
            let tab_id = required_str(&params, "tab_id")?;
            let url = required_str(&params, "url")?;
            tab_goto::goto(backend, tab_id, url).await
        }
        methods::TAB_RELOAD => tab_goto::reload(backend, required_str(&params, "tab_id")?).await,
        methods::TAB_BACK => tab_goto::back(backend, required_str(&params, "tab_id")?).await,
        methods::TAB_FORWARD => tab_goto::forward(backend, required_str(&params, "tab_id")?).await,
        methods::TAB_CLOSE => targets::close_tab(backend, required_str(&params, "tab_id")?).await,
        methods::TAB_SCREENSHOT => tab_screenshot::screenshot_with_params(backend, params).await,
        methods::TAB_WAIT_FOR_URL => {
            let tab_id = required_str(&params, "tab_id")?;
            let url = required_str(&params, "url")?;
            tab_goto::wait_for_url(backend, tab_id, url, timeout_ms(&params)).await
        }
        methods::TAB_WAIT_FOR_LOAD_STATE => {
            let tab_id = required_str(&params, "tab_id")?;
            let state = params
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("load");
            tab_goto::wait_for_load_state(backend, tab_id, state, timeout_ms(&params)).await
        }
        methods::TAB_CONTENT_EXPORT => {
            let tab_id = required_str(&params, "tab_id")?;
            let format = params
                .get("format")
                .and_then(Value::as_str)
                .unwrap_or("html");
            tab_screenshot::content_export(backend, tab_id, format).await
        }
        methods::TAB_URL => tab_goto::url(backend, required_str(&params, "tab_id")?)
            .await
            .map(Value::String),
        methods::TAB_TITLE => tab_goto::title(backend, required_str(&params, "tab_id")?)
            .await
            .map(Value::String),
        _ => Err(HostError::NotImplemented(format!("{method} (Phase 5/6)"))),
    }
}

fn required_str<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::Protocol(format!("missing {key}")))
}

fn timeout_ms(params: &Value) -> Option<u64> {
    params
        .get("timeout_ms")
        .or_else(|| params.get("timeout"))
        .or_else(|| params.get("client_timeout_ms"))
        .and_then(Value::as_u64)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn required_str_returns_named_string_param() {
        let params = json!({ "tab_id": "tab-1" });

        assert_eq!(required_str(&params, "tab_id").unwrap(), "tab-1");
    }

    #[test]
    fn required_str_rejects_missing_or_non_string_param() {
        let missing = json!({});
        let non_string = json!({ "tab_id": 42 });

        assert!(
            required_str(&missing, "tab_id")
                .unwrap_err()
                .to_string()
                .contains("missing tab_id")
        );
        assert!(
            required_str(&non_string, "tab_id")
                .unwrap_err()
                .to_string()
                .contains("missing tab_id")
        );
    }

    #[test]
    fn timeout_ms_prefers_explicit_timeout_order() {
        assert_eq!(
            timeout_ms(&json!({
                "timeout_ms": 100,
                "timeout": 200,
                "client_timeout_ms": 300
            })),
            Some(100)
        );
        assert_eq!(
            timeout_ms(&json!({
                "timeout": 200,
                "client_timeout_ms": 300
            })),
            Some(200)
        );
        assert_eq!(timeout_ms(&json!({ "client_timeout_ms": 300 })), Some(300));
        assert_eq!(timeout_ms(&json!({ "timeout_ms": "slow" })), None);
    }
}

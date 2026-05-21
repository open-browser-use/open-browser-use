//! Raw `executeCdp` pass-through.

use serde_json::Value;

use crate::backends::cdp::CdpBackend;
use crate::error::{HostError, Result};

/// Execute a CDP command against an attached tab session.
pub async fn execute_cdp(
    backend: &CdpBackend,
    tab_id: &str,
    method: &str,
    params: Value,
) -> Result<Value> {
    if method.is_empty() {
        return Err(HostError::Protocol("executeCdp missing method".into()));
    }
    let session_id = super::attach::require_session(backend, tab_id)?;
    let operation = async {
        backend
            .transport()
            .send_command(method, params, Some(&session_id))
            .await
            .map_err(HostError::from)
    };
    if super::dialogs::method_can_open_dialog(method) {
        let context = super::dialogs::context_for_tab(backend, tab_id, &session_id, method);
        super::dialogs::run_with_dialog_policy(backend, context, operation).await
    } else {
        operation.await
    }
}

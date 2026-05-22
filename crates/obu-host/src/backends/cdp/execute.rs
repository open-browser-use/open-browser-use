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
    super::dialogs::send_command_with_dialog_policy(backend, tab_id, &session_id, method, params)
        .await
}

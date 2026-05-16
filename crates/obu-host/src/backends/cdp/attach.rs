//! Per-tab CDP session attach/detach.

use serde_json::{Value, json};

use crate::backends::cdp::CdpBackend;
use crate::error::{HostError, Result};
use crate::tab_state::TabId;

/// Attach a flattened CDP session to a known tab.
pub async fn attach(backend: &CdpBackend, tab_id: &str) -> Result<()> {
    let id = TabId::new(tab_id);
    let record = backend
        .registry()
        .get(&id)?
        .ok_or_else(|| HostError::PageClosed(format!("unknown tab {tab_id}")))?;
    if record.attached && record.cdp_session_id.is_some() {
        return Ok(());
    }

    let result = backend
        .transport()
        .send_command(
            "Target.attachToTarget",
            json!({ "targetId": record.target_id, "flatten": true }),
            None,
        )
        .await
        .map_err(HostError::from)?;
    let session_id = result
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::Protocol("Target.attachToTarget missing sessionId".into()))?
        .to_string();

    backend.registry().update(&id, |record| {
        record.attached = true;
        record.cdp_session_id = Some(session_id.clone());
    })?;

    // Keep this as the only eager attach-time domain command; Page/Runtime/DOM
    // domains are enabled lazily.
    backend
        .transport()
        .send_command(
            "Emulation.setFocusEmulationEnabled",
            json!({ "enabled": true }),
            Some(&session_id),
        )
        .await
        .map_err(HostError::from)?;
    Ok(())
}

/// Detach a flattened CDP session from a tab.
pub async fn detach(backend: &CdpBackend, tab_id: &str) -> Result<()> {
    let id = TabId::new(tab_id);
    let record = backend
        .registry()
        .get(&id)?
        .ok_or_else(|| HostError::PageClosed(format!("unknown tab {tab_id}")))?;
    let Some(session_id) = record.cdp_session_id else {
        return Ok(());
    };

    backend
        .transport()
        .send_command(
            "Target.detachFromTarget",
            json!({ "sessionId": session_id }),
            None,
        )
        .await
        .map_err(HostError::from)?;

    backend.registry().update(&id, |record| {
        record.attached = false;
        record.cdp_session_id = None;
    })?;
    backend.registry().clear_tab_handles(&id)?;
    Ok(())
}

/// Return the attached CDP session id for a tab.
pub(crate) fn require_session(backend: &CdpBackend, tab_id: &str) -> Result<String> {
    let id = TabId::new(tab_id);
    let record = backend
        .registry()
        .get(&id)?
        .ok_or_else(|| HostError::PageClosed(format!("unknown tab {tab_id}")))?;
    record
        .cdp_session_id
        .ok_or_else(|| HostError::TabNotAttached(format!("tab {tab_id} not attached")))
}

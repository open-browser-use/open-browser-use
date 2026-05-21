//! CDP native-dialog policy integration.

use serde_json::{Value, json};
use tokio::sync::broadcast;

use super::{CdpBackend, transport::CdpEvent};
use crate::error::{HostError, Result};
use crate::ops::dialogs::{self, DialogContext};
use crate::tab_state::TabId;

/// Whether a CDP command should be guarded by native-dialog handling.
pub(crate) fn method_can_open_dialog(method: &str) -> bool {
    matches!(
        method,
        "Page.navigate"
            | "Page.reload"
            | "Page.navigateToHistoryEntry"
            | "Page.close"
            | "Input.dispatchMouseEvent"
            | "Input.dispatchKeyEvent"
            | "Input.insertText"
    )
}

/// Build native-dialog context from host tab registry state.
pub(crate) fn context_for_tab(
    backend: &CdpBackend,
    tab_id: &str,
    cdp_session_id: &str,
    operation: impl Into<String>,
) -> DialogContext {
    let record = backend.registry().get(&TabId::new(tab_id)).ok().flatten();
    DialogContext {
        tab_id: tab_id.to_string(),
        session_id: record.and_then(|record| record.session_id),
        cdp_session_id: Some(cdp_session_id.to_string()),
        operation_id: None,
        operation: Some(operation.into()),
    }
}

/// Run an operation while handling native dialogs for a controlled tab.
pub(crate) async fn run_with_dialog_policy<T, F>(
    backend: &CdpBackend,
    context: DialogContext,
    operation: F,
) -> Result<T>
where
    F: std::future::Future<Output = Result<T>>,
{
    let Some(cdp_session_id) = context.cdp_session_id.as_deref() else {
        return operation.await;
    };
    backend
        .transport()
        .send_command("Page.enable", json!({}), Some(cdp_session_id))
        .await
        .map_err(HostError::from)?;

    let mut events = backend.transport().subscribe_events();
    tokio::pin!(operation);
    loop {
        tokio::select! {
            result = &mut operation => return result,
            event = events.recv() => {
                let event = event.map_err(|error| {
                    HostError::Protocol(format!("CDP event bus closed: {error}"))
                })?;
                if !dialog_event_matches(&event, cdp_session_id) {
                    continue;
                }
                let Some(dialog) = dialogs::parse_javascript_dialog(&event.params) else {
                    continue;
                };
                let handle = |params: Value| async {
                    backend
                        .transport()
                        .send_command("Page.handleJavaScriptDialog", params, Some(cdp_session_id))
                        .await
                        .map(|_| ())
                        .map_err(HostError::from)
                };
                dialogs::handle_open_dialog(
                    &context,
                    &dialog,
                    Some(backend.dialog_traces()),
                    handle,
                )
                .await?;
            }
        }
    }
}

fn dialog_event_matches(event: &CdpEvent, cdp_session_id: &str) -> bool {
    event.method == "Page.javascriptDialogOpening"
        && (event.session_id.as_deref() == Some(cdp_session_id) || event.session_id.is_none())
}

/// Wait for a matching non-dialog CDP event while applying native-dialog policy.
pub(crate) async fn wait_for_event_with_dialog_policy<R, F>(
    mut events: broadcast::Receiver<CdpEvent>,
    backend: &CdpBackend,
    context: DialogContext,
    timeout_ms: u64,
    timeout_message: String,
    mut match_event: F,
) -> Result<R>
where
    F: FnMut(&CdpEvent) -> Option<R>,
{
    let Some(cdp_session_id) = context.cdp_session_id.as_deref() else {
        return Err(HostError::Protocol(
            "dialog-aware CDP event wait requires cdp_session_id".into(),
        ));
    };
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(HostError::Timeout(timeout_message));
        }
        let event = tokio::time::timeout(remaining, events.recv())
            .await
            .map_err(|_| HostError::Timeout(timeout_message.clone()))?
            .map_err(|error| HostError::Protocol(format!("CDP event bus closed: {error}")))?;
        if dialog_event_matches(&event, cdp_session_id) {
            if let Some(dialog) = dialogs::parse_javascript_dialog(&event.params) {
                let handle = |params: Value| async {
                    backend
                        .transport()
                        .send_command("Page.handleJavaScriptDialog", params, Some(cdp_session_id))
                        .await
                        .map(|_| ())
                        .map_err(HostError::from)
                };
                dialogs::handle_open_dialog(
                    &context,
                    &dialog,
                    Some(backend.dialog_traces()),
                    handle,
                )
                .await?;
            }
            continue;
        }
        if let Some(result) = match_event(&event) {
            return Ok(result);
        }
    }
}

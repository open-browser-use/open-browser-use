//! CDP native-dialog policy integration.

use serde_json::{Value, json};

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
            | "Runtime.evaluate"
            | "Input.dispatchMouseEvent"
            | "Input.dispatchKeyEvent"
            | "Input.insertText"
    )
}

/// Execute a CDP command, applying native-dialog handling for dialog-sensitive capabilities.
pub(crate) async fn send_command_with_dialog_policy(
    backend: &CdpBackend,
    tab_id: &str,
    cdp_session_id: &str,
    method: &str,
    params: Value,
) -> Result<Value> {
    let operation = async {
        backend
            .transport()
            .send_command(method, params, Some(cdp_session_id))
            .await
            .map_err(HostError::from)
    };
    if method_can_open_dialog(method) {
        let context = context_for_tab(backend, tab_id, cdp_session_id, method);
        run_with_dialog_policy(backend, context, operation).await
    } else {
        operation.await
    }
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

    let events = backend.transport().subscribe_events();
    dialogs::run_broadcast_dialog_policy_loop(
        &context,
        Some(backend.dialog_traces()),
        operation,
        events,
        "CDP",
        |event| {
            if !dialog_event_matches(&event, cdp_session_id) {
                return None;
            }
            dialogs::parse_javascript_dialog(&event.params).map(dialogs::DialogPolicyEvent::Open)
        },
        |params| async {
            backend
                .transport()
                .send_command("Page.handleJavaScriptDialog", params, Some(cdp_session_id))
                .await
                .map(|_| ())
                .map_err(HostError::from)
        },
    )
    .await
}

fn dialog_event_matches(event: &CdpEvent, cdp_session_id: &str) -> bool {
    event.method == "Page.javascriptDialogOpening"
        && (event.session_id.as_deref() == Some(cdp_session_id) || event.session_id.is_none())
}

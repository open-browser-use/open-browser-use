//! Native browser dialog policy helpers.

use std::collections::VecDeque;
use std::future::Future;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::error::{DialogRequiresDecision, HostError, Result};

const MESSAGE_PREVIEW_LIMIT: usize = 500;
const MAX_DIALOG_TRACE_ENTRIES: usize = 20;

/// Bounded in-memory history of handled native browser dialogs.
#[derive(Debug, Clone, Default)]
pub(crate) struct DialogTraceStore {
    entries: Arc<Mutex<VecDeque<Value>>>,
}

impl DialogTraceStore {
    /// Record one handled dialog.
    pub(crate) fn record(
        &self,
        context: &DialogContext,
        dialog: &JavaScriptDialog,
        action: DialogAction,
        outcome: &'static str,
    ) {
        let mut entries = self.entries.lock().expect("dialog trace lock");
        entries.push_back(dialog_trace_data(context, dialog, action, outcome));
        while entries.len() > MAX_DIALOG_TRACE_ENTRIES {
            entries.pop_front();
        }
    }

    /// Diagnostics payload for `getInfo`.
    pub(crate) fn diagnostics(&self) -> Value {
        let entries = self.entries.lock().expect("dialog trace lock");
        json!({
            "recent": entries.iter().cloned().collect::<Vec<_>>(),
        })
    }
}

/// Runtime context attached to handled native dialogs.
#[derive(Debug, Clone, Default)]
pub(crate) struct DialogContext {
    pub(crate) tab_id: String,
    pub(crate) session_id: Option<String>,
    pub(crate) cdp_session_id: Option<String>,
    pub(crate) operation_id: Option<String>,
    pub(crate) operation: Option<String>,
}

/// Parsed `Page.javascriptDialogOpening` event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct JavaScriptDialog {
    pub(crate) dialog_type: String,
    pub(crate) message: String,
}

/// Action to take for an opened native dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DialogAction {
    /// Accept and let the initiating operation continue.
    Accept,
    /// Dismiss and fail the initiating operation with structured data.
    DismissRequiresDecision,
}

/// Dialog event normalized across CDP transports.
#[derive(Clone, Debug)]
pub(crate) enum DialogPolicyEvent {
    /// A dialog opened and still needs host-side policy handling.
    Open(JavaScriptDialog),
    /// The extension already applied the same policy action before forwarding.
    HandledByExternalPolicy {
        dialog: JavaScriptDialog,
        action: DialogAction,
    },
}

impl DialogAction {
    /// CDP `Page.handleJavaScriptDialog` accept flag.
    pub(crate) const fn accept(self) -> bool {
        matches!(self, Self::Accept)
    }

    /// Whether this action should fail the initiating operation.
    pub(crate) const fn requires_decision(self) -> bool {
        matches!(self, Self::DismissRequiresDecision)
    }
}

/// Parse a CDP dialog-open event payload.
pub(crate) fn parse_javascript_dialog(params: &Value) -> Option<JavaScriptDialog> {
    let dialog_type = params.get("type").and_then(Value::as_str)?.to_string();
    let message = params
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some(JavaScriptDialog {
        dialog_type,
        message,
    })
}

/// Return the default policy action for a native dialog type.
pub(crate) fn action_for_dialog_type(dialog_type: &str) -> DialogAction {
    match dialog_type {
        "alert" | "beforeunload" => DialogAction::Accept,
        "confirm" | "prompt" => DialogAction::DismissRequiresDecision,
        _ => DialogAction::DismissRequiresDecision,
    }
}

/// Build the stable JSON-RPC error for a dismissed decision dialog.
pub(crate) fn decision_required_error(
    context: &DialogContext,
    dialog: &JavaScriptDialog,
    action: DialogAction,
) -> HostError {
    let data = dialog_error_data(context, dialog, action);
    HostError::DialogRequiresDecision(DialogRequiresDecision {
        message: format!(
            "dialog_requires_decision: {} dialog on tab {} was dismissed",
            dialog.dialog_type, context.tab_id
        ),
        data,
    })
}

/// Convert a dialog action into CDP parameters.
pub(crate) fn handle_dialog_params(action: DialogAction) -> Value {
    json!({ "accept": action.accept() })
}

/// Handle an open dialog with the default policy and optional result failure.
pub(crate) async fn handle_open_dialog<F, Fut>(
    context: &DialogContext,
    dialog: &JavaScriptDialog,
    traces: Option<&DialogTraceStore>,
    mut handle: F,
) -> Result<()>
where
    F: FnMut(Value) -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    let action = action_for_dialog_type(&dialog.dialog_type);
    if let Err(error) = handle(handle_dialog_params(action)).await {
        if let Some(traces) = traces {
            traces.record(context, dialog, action, "handler_failed");
        }
        return Err(error);
    }
    if let Some(traces) = traces {
        traces.record(
            context,
            dialog,
            action,
            if action.requires_decision() {
                "failed"
            } else {
                "continued"
            },
        );
    }
    if action.requires_decision() {
        return Err(decision_required_error(context, dialog, action));
    }
    Ok(())
}

/// Run an operation while consuming a transport-specific dialog event stream.
pub(crate) async fn run_broadcast_dialog_policy_loop<T, F, E, Match, Handle, HandleFut>(
    context: &DialogContext,
    traces: Option<&DialogTraceStore>,
    operation: F,
    mut events: broadcast::Receiver<E>,
    event_bus_name: &str,
    mut match_event: Match,
    mut handle: Handle,
) -> Result<T>
where
    F: Future<Output = Result<T>>,
    E: Clone,
    Match: FnMut(E) -> Option<DialogPolicyEvent>,
    Handle: FnMut(Value) -> HandleFut,
    HandleFut: Future<Output = Result<()>>,
{
    tokio::pin!(operation);
    loop {
        tokio::select! {
            result = &mut operation => return result,
            event = events.recv() => {
                let event = event.map_err(|error| {
                    HostError::Protocol(format!("{event_bus_name} event bus closed: {error}"))
                })?;
                let Some(event) = match_event(event) else {
                    continue;
                };
                match event {
                    DialogPolicyEvent::Open(dialog) => {
                        handle_open_dialog(context, &dialog, traces, &mut handle).await?;
                    }
                    DialogPolicyEvent::HandledByExternalPolicy { dialog, action } => {
                        if let Some(traces) = traces {
                            traces.record(
                                context,
                                &dialog,
                                action,
                                if action.requires_decision() { "failed" } else { "continued" },
                            );
                        }
                        if action.requires_decision() {
                            return Err(decision_required_error(context, &dialog, action));
                        }
                    }
                }
            }
        }
    }
}

fn dialog_error_data(
    context: &DialogContext,
    dialog: &JavaScriptDialog,
    action: DialogAction,
) -> Value {
    let (message_preview, message_truncated) = preview_message(&dialog.message);
    json!({
        "code": "dialog_requires_decision",
        "tab_id": context.tab_id,
        "session_id": context.session_id,
        "cdp_session_id": context.cdp_session_id,
        "operation_id": context.operation_id,
        "operation": context.operation,
        "dialog_type": dialog.dialog_type,
        "message": message_preview,
        "message_length": dialog.message.chars().count(),
        "message_truncated": message_truncated,
        "default_action": if action.accept() { "accept" } else { "dismiss" },
        "accept": action.accept(),
        "retry_hint": "Retry only after choosing an explicit page-specific action; automatic confirm/prompt acceptance is intentionally disabled."
    })
}

fn dialog_trace_data(
    context: &DialogContext,
    dialog: &JavaScriptDialog,
    action: DialogAction,
    outcome: &'static str,
) -> Value {
    let (message_preview, message_truncated) = preview_message(&dialog.message);
    json!({
        "code": if action.requires_decision() { "dialog_requires_decision" } else { "dialog_handled" },
        "tab_id": context.tab_id,
        "session_id": context.session_id,
        "cdp_session_id": context.cdp_session_id,
        "operation_id": context.operation_id,
        "operation": context.operation,
        "dialog_type": dialog.dialog_type,
        "message": message_preview,
        "message_length": dialog.message.chars().count(),
        "message_truncated": message_truncated,
        "default_action": if action.accept() { "accept" } else { "dismiss" },
        "accept": action.accept(),
        "outcome": outcome,
    })
}

fn preview_message(message: &str) -> (String, bool) {
    let mut preview = String::new();
    let mut truncated = false;
    for (index, ch) in message.chars().enumerate() {
        if index >= MESSAGE_PREVIEW_LIMIT {
            truncated = true;
            break;
        }
        preview.push(ch);
    }
    (preview, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_error_data_is_length_limited() {
        let context = DialogContext {
            tab_id: "tab-1".into(),
            session_id: Some("session".into()),
            cdp_session_id: Some("cdp-session".into()),
            operation_id: Some("op-1".into()),
            operation: Some("tab_goto".into()),
        };
        let dialog = JavaScriptDialog {
            dialog_type: "confirm".into(),
            message: "x".repeat(600),
        };

        let error =
            decision_required_error(&context, &dialog, DialogAction::DismissRequiresDecision);
        let HostError::DialogRequiresDecision(error) = error else {
            panic!("expected dialog error");
        };

        assert_eq!(error.data["code"], "dialog_requires_decision");
        assert_eq!(error.data["tab_id"], "tab-1");
        assert_eq!(error.data["session_id"], "session");
        assert_eq!(error.data["cdp_session_id"], "cdp-session");
        assert_eq!(error.data["operation_id"], "op-1");
        assert_eq!(error.data["operation"], "tab_goto");
        assert_eq!(error.data["dialog_type"], "confirm");
        assert_eq!(error.data["message"].as_str().unwrap().chars().count(), 500);
        assert_eq!(error.data["message_length"], 600);
        assert_eq!(error.data["message_truncated"], true);
        assert_eq!(error.data["default_action"], "dismiss");
        assert_eq!(error.data["accept"], false);
    }

    #[test]
    fn trace_store_records_bounded_history() {
        let store = DialogTraceStore::default();
        let context = DialogContext {
            tab_id: "tab-1".into(),
            session_id: Some("session".into()),
            cdp_session_id: None,
            operation_id: None,
            operation: Some("Page.navigate".into()),
        };
        for index in 0..25 {
            store.record(
                &context,
                &JavaScriptDialog {
                    dialog_type: "alert".into(),
                    message: format!("message-{index}"),
                },
                DialogAction::Accept,
                "continued",
            );
        }

        let diagnostics = store.diagnostics();
        let recent = diagnostics["recent"].as_array().unwrap();
        assert_eq!(recent.len(), 20);
        assert_eq!(recent[0]["message"], "message-5");
        assert_eq!(recent[19]["message"], "message-24");
        assert_eq!(recent[19]["code"], "dialog_handled");
        assert_eq!(recent[19]["outcome"], "continued");
    }

    #[tokio::test]
    async fn dialog_policy_loop_handles_open_events_until_operation_completes() {
        let context = DialogContext {
            tab_id: "tab-1".into(),
            operation: Some("Runtime.evaluate".into()),
            ..DialogContext::default()
        };
        let store = DialogTraceStore::default();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let mut done_tx = Some(done_tx);
        let (event_tx, events) = broadcast::channel(4);
        event_tx
            .send(DialogPolicyEvent::Open(JavaScriptDialog {
                dialog_type: "alert".into(),
                message: "done".into(),
            }))
            .unwrap();

        let result = run_broadcast_dialog_policy_loop(
            &context,
            Some(&store),
            async {
                done_rx.await.unwrap();
                Ok("ok")
            },
            events,
            "test",
            Some,
            |params| {
                let tx = done_tx.take();
                std::future::ready({
                    assert_eq!(params, json!({ "accept": true }));
                    tx.unwrap().send(()).unwrap();
                    Ok(())
                })
            },
        )
        .await
        .unwrap();

        assert_eq!(result, "ok");
        let recent = store.diagnostics()["recent"].as_array().unwrap().clone();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0]["code"], "dialog_handled");
        assert_eq!(recent[0]["outcome"], "continued");
    }

    #[tokio::test]
    async fn dialog_policy_loop_honors_external_decision_events() {
        let context = DialogContext {
            tab_id: "tab-1".into(),
            operation: Some("Runtime.evaluate".into()),
            ..DialogContext::default()
        };
        let store = DialogTraceStore::default();
        let (event_tx, events) = broadcast::channel(4);
        event_tx
            .send(DialogPolicyEvent::HandledByExternalPolicy {
                dialog: JavaScriptDialog {
                    dialog_type: "confirm".into(),
                    message: "choose".into(),
                },
                action: DialogAction::DismissRequiresDecision,
            })
            .unwrap();

        let error = run_broadcast_dialog_policy_loop(
            &context,
            Some(&store),
            async {
                std::future::pending::<()>().await;
                Ok(())
            },
            events,
            "test",
            Some,
            |_params| std::future::ready(Ok(())),
        )
        .await
        .unwrap_err();

        assert!(matches!(error, HostError::DialogRequiresDecision(_)));
        let recent = store.diagnostics()["recent"].as_array().unwrap().clone();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0]["code"], "dialog_requires_decision");
        assert_eq!(recent[0]["outcome"], "failed");
    }
}

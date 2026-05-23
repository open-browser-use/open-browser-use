//! Pure lifecycle planners for SDK peer connections.
//!
//! Pure lifecycle PLANNER. `next_state` values are diagnostic/planning labels
//! only — the host runtime does not store them in a live field and does not
//! gate transitions on them. Do not build long-task continuity guarantees on
//! `next_state` until it is persisted/consumed by runtime code. See review
//! Finding 17.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::peer_auth::check_capability_token;
use crate::socket::PeerCred;

/// Maximum recent peer lifecycle events retained for diagnostics.
pub const MAX_PEER_LIFECYCLE_EVENTS: usize = 64;

/// Error text returned when a token-protected peer does not authenticate first.
pub const PEER_AUTH_REQUIRED_MESSAGE: &str =
    "first frame must be auth when capability token is enabled";

/// Error text returned when a peer presents the wrong capability token.
pub const PEER_AUTH_MISMATCH_MESSAGE: &str = "capability token mismatch";

/// SDK peer lifecycle state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerLifecycleState {
    /// A peer stream has connected and the first frame is being classified.
    Connected,
    /// The first frame was an auth request and the peer is awaiting auth result.
    AwaitingAuth,
    /// The peer is authorized to dispatch SDK requests.
    Authenticated,
    /// OS-level peer authentication was disabled.
    OsAuthSkipped,
    /// OS-level peer credential was accepted.
    OsTrusted,
    /// The peer was rejected before request dispatch.
    Rejected {
        /// Rejection reason.
        reason: String,
    },
    /// The peer read loop is closing.
    Closing,
    /// The peer has closed and pending request work should be canceled.
    Closed,
}

/// SDK peer lifecycle event kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerLifecycleEventKind {
    /// The first frame was an auth request.
    FirstFrameAuth,
    /// The first frame should be dispatched as a normal request frame.
    FirstFrameDispatch,
    /// The first frame was not auth but auth was required.
    FirstFrameMissingAuth,
    /// Capability-token auth accepted the peer.
    AuthAccepted,
    /// Capability-token auth rejected the peer.
    AuthRejected,
    /// OS-level peer authentication was skipped by configuration.
    OsCredentialAuthSkipped,
    /// OS-level peer credential was accepted.
    OsCredentialAccepted,
    /// OS-level peer credential was rejected.
    OsCredentialRejected,
    /// A request task was canceled because the peer closed.
    RequestCancelled,
    /// The peer read loop closed and request work should be canceled.
    PeerClosed,
}

/// Planned SDK peer lifecycle event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerLifecycleEventPlan {
    /// Event kind.
    pub kind: PeerLifecycleEventKind,
    /// Event reason when available.
    pub reason: Option<String>,
}

/// One peer lifecycle event suitable for diagnostics and tests.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PeerLifecycleDiagnosticEvent {
    /// Transition kind.
    pub kind: PeerLifecycleEventKind,
    /// Transition reason when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Event timestamp as Unix milliseconds.
    pub at_unix_ms: u64,
}

/// Bounded peer lifecycle diagnostics shared by peer auth and dispatch.
#[derive(Debug, Clone, Default)]
pub struct PeerLifecycleDiagnostics {
    events: Arc<Mutex<VecDeque<PeerLifecycleDiagnosticEvent>>>,
}

impl PeerLifecycleDiagnostics {
    /// Record a planned peer lifecycle event.
    pub fn record(&self, event: &PeerLifecycleEventPlan) {
        let Ok(mut events) = self.events.lock() else {
            return;
        };
        push_peer_lifecycle_event(
            &mut events,
            peer_lifecycle_event(event.clone(), SystemTime::now()),
        );
    }

    /// Return recent peer lifecycle events, oldest to newest.
    pub fn recent_events(&self, limit: usize) -> Vec<PeerLifecycleDiagnosticEvent> {
        let Ok(events) = self.events.lock() else {
            return Vec::new();
        };
        let len = events.len();
        events
            .iter()
            .skip(len.saturating_sub(limit))
            .cloned()
            .collect()
    }
}

/// Build a peer lifecycle diagnostic event from a pure plan event.
pub fn peer_lifecycle_event(
    event: PeerLifecycleEventPlan,
    now: SystemTime,
) -> PeerLifecycleDiagnosticEvent {
    PeerLifecycleDiagnosticEvent {
        kind: event.kind,
        reason: event.reason,
        at_unix_ms: now
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
            .unwrap_or(0),
    }
}

/// Append a peer lifecycle event to a bounded recent-event queue.
pub fn push_peer_lifecycle_event(
    events: &mut VecDeque<PeerLifecycleDiagnosticEvent>,
    event: PeerLifecycleDiagnosticEvent,
) {
    events.push_back(event);
    while events.len() > MAX_PEER_LIFECYCLE_EVENTS {
        events.pop_front();
    }
}

/// Action to take for the first peer frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerFirstFrameAction {
    /// Run the auth handler for this frame.
    Authenticate,
    /// Dispatch the frame as the first normal SDK request.
    DispatchFirstFrame,
    /// Send a peer-auth error and close the peer.
    RejectMissingAuth,
}

/// Pure plan for classifying the first peer frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerFirstFramePlan {
    /// Action to execute.
    pub action: PeerFirstFrameAction,
    /// State after the action is selected.
    pub next_state: PeerLifecycleState,
    /// Lifecycle event emitted by this transition.
    pub event: PeerLifecycleEventPlan,
}

/// Pure plan for capability-token auth.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerAuthPlan {
    /// Whether the peer is accepted.
    pub accepted: bool,
    /// Error message when rejected.
    pub error_message: Option<&'static str>,
    /// State after the auth result.
    pub next_state: PeerLifecycleState,
    /// Lifecycle event emitted by this transition.
    pub event: PeerLifecycleEventPlan,
}

/// Platform-neutral peer credential kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerCredentialKind {
    /// Unix uid/gid/pid credential.
    Unix,
    /// macOS audit token credential.
    AuditToken,
    /// Windows SID credential.
    Windows,
}

/// Observation used by the OS credential-auth planner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerOsCredentialObservation {
    /// OS credential auth is disabled.
    AuthDisabled,
    /// Credential lookup failed before a credential could be classified.
    CredentialReadFailed {
        /// Failure reason.
        reason: String,
    },
    /// A credential was read from the peer socket.
    Credential {
        /// Credential kind.
        kind: PeerCredentialKind,
        /// Unix uid when the credential is Unix-shaped.
        uid: Option<u32>,
    },
}

/// Pure plan for OS credential auth.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerOsCredentialAuthPlan {
    /// Whether the peer is accepted.
    pub accepted: bool,
    /// Whether the executor should store the credential on the peer.
    pub annotate_peer: bool,
    /// Error message when rejected.
    pub error_message: Option<String>,
    /// State after the credential decision.
    pub next_state: PeerLifecycleState,
    /// Lifecycle event emitted by this transition.
    pub event: PeerLifecycleEventPlan,
}

/// Pure plan for a request task canceled by peer shutdown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerRequestCancellationPlan {
    /// Whether the executor should suppress the response.
    pub suppress_response: bool,
    /// State after cancellation.
    pub next_state: PeerLifecycleState,
    /// Lifecycle event emitted by this transition.
    pub event: PeerLifecycleEventPlan,
}

/// Pure plan for peer shutdown cleanup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerShutdownPlan {
    /// Whether in-flight request tasks should be canceled.
    pub cancel_pending_requests: bool,
    /// Whether the response channel should be closed.
    pub close_response_channel: bool,
    /// Whether the writer task should be awaited.
    pub await_writer: bool,
    /// State after shutdown cleanup.
    pub next_state: PeerLifecycleState,
    /// Lifecycle event emitted by this transition.
    pub event: PeerLifecycleEventPlan,
}

/// Plan how to handle the first frame from an SDK peer.
pub fn plan_peer_first_frame(
    capability_token_required: bool,
    request_method: Option<&str>,
) -> PeerFirstFramePlan {
    if request_method == Some("auth") {
        return PeerFirstFramePlan {
            action: PeerFirstFrameAction::Authenticate,
            next_state: PeerLifecycleState::AwaitingAuth,
            event: PeerLifecycleEventPlan {
                kind: PeerLifecycleEventKind::FirstFrameAuth,
                reason: None,
            },
        };
    }
    if capability_token_required {
        return PeerFirstFramePlan {
            action: PeerFirstFrameAction::RejectMissingAuth,
            next_state: PeerLifecycleState::Rejected {
                reason: PEER_AUTH_REQUIRED_MESSAGE.to_string(),
            },
            event: PeerLifecycleEventPlan {
                kind: PeerLifecycleEventKind::FirstFrameMissingAuth,
                reason: Some(PEER_AUTH_REQUIRED_MESSAGE.to_string()),
            },
        };
    }
    PeerFirstFramePlan {
        action: PeerFirstFrameAction::DispatchFirstFrame,
        next_state: PeerLifecycleState::Authenticated,
        event: PeerLifecycleEventPlan {
            kind: PeerLifecycleEventKind::FirstFrameDispatch,
            reason: None,
        },
    }
}

/// Plan capability-token auth without touching the peer stream.
pub fn plan_peer_auth(expected_token: Option<&str>, presented_token: Option<&str>) -> PeerAuthPlan {
    if let Some(expected) = expected_token
        && !check_capability_token(Some(expected), presented_token)
    {
        return PeerAuthPlan {
            accepted: false,
            error_message: Some(PEER_AUTH_MISMATCH_MESSAGE),
            next_state: PeerLifecycleState::Rejected {
                reason: PEER_AUTH_MISMATCH_MESSAGE.to_string(),
            },
            event: PeerLifecycleEventPlan {
                kind: PeerLifecycleEventKind::AuthRejected,
                reason: Some(PEER_AUTH_MISMATCH_MESSAGE.to_string()),
            },
        };
    }
    PeerAuthPlan {
        accepted: true,
        error_message: None,
        next_state: PeerLifecycleState::Authenticated,
        event: PeerLifecycleEventPlan {
            kind: PeerLifecycleEventKind::AuthAccepted,
            reason: None,
        },
    }
}

/// Convert a concrete socket credential into a planner observation.
pub fn peer_credential_observation(cred: &PeerCred) -> PeerOsCredentialObservation {
    match cred {
        PeerCred::Unix { uid, .. } => PeerOsCredentialObservation::Credential {
            kind: PeerCredentialKind::Unix,
            uid: Some(*uid),
        },
        PeerCred::AuditToken { .. } => PeerOsCredentialObservation::Credential {
            kind: PeerCredentialKind::AuditToken,
            uid: None,
        },
        PeerCred::Windows { .. } => PeerOsCredentialObservation::Credential {
            kind: PeerCredentialKind::Windows,
            uid: None,
        },
    }
}

/// Plan OS credential auth without touching the peer stream.
pub fn plan_peer_os_credential_auth(
    expected_uid: u32,
    observation: PeerOsCredentialObservation,
) -> PeerOsCredentialAuthPlan {
    match observation {
        PeerOsCredentialObservation::AuthDisabled => PeerOsCredentialAuthPlan {
            accepted: true,
            annotate_peer: false,
            error_message: None,
            next_state: PeerLifecycleState::OsAuthSkipped,
            event: PeerLifecycleEventPlan {
                kind: PeerLifecycleEventKind::OsCredentialAuthSkipped,
                reason: Some("peer_auth_off".to_string()),
            },
        },
        PeerOsCredentialObservation::CredentialReadFailed { reason } => {
            rejected_os_credential_plan(reason)
        }
        PeerOsCredentialObservation::Credential { kind, uid } => match (kind, uid) {
            (PeerCredentialKind::Unix, Some(uid)) if uid == expected_uid => {
                PeerOsCredentialAuthPlan {
                    accepted: true,
                    annotate_peer: true,
                    error_message: None,
                    next_state: PeerLifecycleState::OsTrusted,
                    event: PeerLifecycleEventPlan {
                        kind: PeerLifecycleEventKind::OsCredentialAccepted,
                        reason: None,
                    },
                }
            }
            (PeerCredentialKind::Unix, Some(uid)) => {
                rejected_os_credential_plan(format!("uid mismatch: got {uid}, want {expected_uid}"))
            }
            (PeerCredentialKind::Unix, None)
            | (PeerCredentialKind::AuditToken, _)
            | (PeerCredentialKind::Windows, _) => {
                rejected_os_credential_plan("unexpected non-Unix credential".to_string())
            }
        },
    }
}

fn rejected_os_credential_plan(reason: String) -> PeerOsCredentialAuthPlan {
    PeerOsCredentialAuthPlan {
        accepted: false,
        annotate_peer: false,
        error_message: Some(reason.clone()),
        next_state: PeerLifecycleState::Rejected {
            reason: reason.clone(),
        },
        event: PeerLifecycleEventPlan {
            kind: PeerLifecycleEventKind::OsCredentialRejected,
            reason: Some(reason),
        },
    }
}

/// Plan request cancellation after peer shutdown.
pub fn plan_peer_request_cancelled(method: &str) -> PeerRequestCancellationPlan {
    PeerRequestCancellationPlan {
        suppress_response: true,
        next_state: PeerLifecycleState::Closing,
        event: PeerLifecycleEventPlan {
            kind: PeerLifecycleEventKind::RequestCancelled,
            reason: Some(format!("peer closed before {method} completed")),
        },
    }
}

/// Plan peer shutdown cleanup.
pub fn plan_peer_shutdown() -> PeerShutdownPlan {
    PeerShutdownPlan {
        cancel_pending_requests: true,
        close_response_channel: true,
        await_writer: true,
        next_state: PeerLifecycleState::Closed,
        event: PeerLifecycleEventPlan {
            kind: PeerLifecycleEventKind::PeerClosed,
            reason: None,
        },
    }
}

/// Plan peer terminal close when dispatch never started.
pub fn plan_peer_terminal_close(reason: impl Into<String>) -> PeerShutdownPlan {
    PeerShutdownPlan {
        cancel_pending_requests: false,
        close_response_channel: false,
        await_writer: false,
        next_state: PeerLifecycleState::Closed,
        event: PeerLifecycleEventPlan {
            kind: PeerLifecycleEventKind::PeerClosed,
            reason: Some(reason.into()),
        },
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::time::{Duration, UNIX_EPOCH};

    use super::{
        MAX_PEER_LIFECYCLE_EVENTS, PEER_AUTH_MISMATCH_MESSAGE, PEER_AUTH_REQUIRED_MESSAGE,
        PeerCredentialKind, PeerFirstFrameAction, PeerLifecycleEventKind, PeerLifecycleEventPlan,
        PeerLifecycleState, PeerOsCredentialObservation, peer_credential_observation,
        peer_lifecycle_event, plan_peer_auth, plan_peer_first_frame, plan_peer_os_credential_auth,
        plan_peer_request_cancelled, plan_peer_shutdown, push_peer_lifecycle_event,
    };
    use crate::socket::PeerCred;

    #[test]
    fn first_frame_planner_routes_auth_before_dispatch() {
        let plan = plan_peer_first_frame(true, Some("auth"));

        assert_eq!(plan.action, PeerFirstFrameAction::Authenticate);
        assert_eq!(plan.next_state, PeerLifecycleState::AwaitingAuth);
        assert_eq!(plan.event.kind, PeerLifecycleEventKind::FirstFrameAuth);
    }

    #[test]
    fn first_frame_planner_rejects_missing_auth_when_token_required() {
        let plan = plan_peer_first_frame(true, Some("ping"));

        assert_eq!(plan.action, PeerFirstFrameAction::RejectMissingAuth);
        assert_eq!(
            plan.next_state,
            PeerLifecycleState::Rejected {
                reason: PEER_AUTH_REQUIRED_MESSAGE.to_string(),
            }
        );
        assert_eq!(
            plan.event.kind,
            PeerLifecycleEventKind::FirstFrameMissingAuth
        );
    }

    #[test]
    fn first_frame_planner_dispatches_without_token_requirement() {
        let plan = plan_peer_first_frame(false, None);

        assert_eq!(plan.action, PeerFirstFrameAction::DispatchFirstFrame);
        assert_eq!(plan.next_state, PeerLifecycleState::Authenticated);
        assert_eq!(plan.event.kind, PeerLifecycleEventKind::FirstFrameDispatch);
    }

    #[test]
    fn auth_planner_accepts_matching_or_unrequired_tokens() {
        let matching = plan_peer_auth(Some("secret"), Some("secret"));
        assert!(matching.accepted);
        assert_eq!(matching.next_state, PeerLifecycleState::Authenticated);
        assert_eq!(matching.event.kind, PeerLifecycleEventKind::AuthAccepted);

        let unrequired = plan_peer_auth(None, None);
        assert!(unrequired.accepted);
        assert_eq!(unrequired.next_state, PeerLifecycleState::Authenticated);
    }

    #[test]
    fn auth_planner_rejects_mismatched_token() {
        let plan = plan_peer_auth(Some("secret"), Some("wrong"));

        assert!(!plan.accepted);
        assert_eq!(plan.error_message, Some(PEER_AUTH_MISMATCH_MESSAGE));
        assert_eq!(
            plan.next_state,
            PeerLifecycleState::Rejected {
                reason: PEER_AUTH_MISMATCH_MESSAGE.to_string(),
            }
        );
        assert_eq!(plan.event.kind, PeerLifecycleEventKind::AuthRejected);
    }

    #[test]
    fn shutdown_planner_cancels_requests_and_closes_writer() {
        let plan = plan_peer_shutdown();

        assert!(plan.cancel_pending_requests);
        assert!(plan.close_response_channel);
        assert!(plan.await_writer);
        assert_eq!(plan.next_state, PeerLifecycleState::Closed);
        assert_eq!(plan.event.kind, PeerLifecycleEventKind::PeerClosed);
    }

    #[test]
    fn os_credential_planner_skips_when_disabled() {
        let plan = plan_peer_os_credential_auth(1000, PeerOsCredentialObservation::AuthDisabled);

        assert!(plan.accepted);
        assert!(!plan.annotate_peer);
        assert_eq!(plan.next_state, PeerLifecycleState::OsAuthSkipped);
        assert_eq!(
            plan.event.kind,
            PeerLifecycleEventKind::OsCredentialAuthSkipped
        );
    }

    #[test]
    fn os_credential_planner_accepts_matching_unix_uid() {
        let plan = plan_peer_os_credential_auth(
            1000,
            PeerOsCredentialObservation::Credential {
                kind: PeerCredentialKind::Unix,
                uid: Some(1000),
            },
        );

        assert!(plan.accepted);
        assert!(plan.annotate_peer);
        assert_eq!(plan.next_state, PeerLifecycleState::OsTrusted);
        assert_eq!(
            plan.event.kind,
            PeerLifecycleEventKind::OsCredentialAccepted
        );
    }

    #[test]
    fn os_credential_planner_rejects_mismatched_or_unsupported_credentials() {
        let mismatch = plan_peer_os_credential_auth(
            1000,
            PeerOsCredentialObservation::Credential {
                kind: PeerCredentialKind::Unix,
                uid: Some(2000),
            },
        );
        assert!(!mismatch.accepted);
        assert_eq!(
            mismatch.error_message.as_deref(),
            Some("uid mismatch: got 2000, want 1000")
        );
        assert_eq!(
            mismatch.event.kind,
            PeerLifecycleEventKind::OsCredentialRejected
        );

        let unsupported = plan_peer_os_credential_auth(
            1000,
            PeerOsCredentialObservation::Credential {
                kind: PeerCredentialKind::AuditToken,
                uid: None,
            },
        );
        assert!(!unsupported.accepted);
        assert_eq!(
            unsupported.error_message.as_deref(),
            Some("unexpected non-Unix credential")
        );
    }

    #[test]
    fn credential_observation_classifies_socket_credentials() {
        let observed = peer_credential_observation(&PeerCred::Unix {
            uid: 1000,
            gid: 100,
            pid: 42,
        });

        assert_eq!(
            observed,
            PeerOsCredentialObservation::Credential {
                kind: PeerCredentialKind::Unix,
                uid: Some(1000),
            }
        );
    }

    #[test]
    fn request_cancellation_planner_suppresses_response() {
        let plan = plan_peer_request_cancelled("attach");

        assert!(plan.suppress_response);
        assert_eq!(plan.next_state, PeerLifecycleState::Closing);
        assert_eq!(plan.event.kind, PeerLifecycleEventKind::RequestCancelled);
        assert_eq!(
            plan.event.reason.as_deref(),
            Some("peer closed before attach completed")
        );
    }

    #[test]
    fn peer_lifecycle_events_are_bounded_and_serializable() {
        let mut events = VecDeque::new();
        for index in 0..(MAX_PEER_LIFECYCLE_EVENTS + 3) {
            push_peer_lifecycle_event(
                &mut events,
                peer_lifecycle_event(
                    PeerLifecycleEventPlan {
                        kind: PeerLifecycleEventKind::RequestCancelled,
                        reason: Some(format!("request {index}")),
                    },
                    UNIX_EPOCH + Duration::from_millis(index as u64),
                ),
            );
        }

        assert_eq!(events.len(), MAX_PEER_LIFECYCLE_EVENTS);
        assert_eq!(events.front().unwrap().reason.as_deref(), Some("request 3"));
        assert_eq!(
            events.back().unwrap().at_unix_ms,
            (MAX_PEER_LIFECYCLE_EVENTS + 2) as u64
        );
        assert_eq!(
            serde_json::to_value(events.back().unwrap()).unwrap()["kind"],
            "request_cancelled"
        );
    }
}

//! Long-task lifecycle state machine.
//!
//! Models the coarse lifecycle of a durable host task that may pause, yield,
//! wait for a human or an external effect, and later resume. Resumption is not
//! always clean: when continuity cannot be proven the task moves to
//! [`TaskState::RepairRequired`], and when forward progress is impossible it
//! moves to [`TaskState::Blocked`] (Finding 7). Cancellation flows through an
//! explicit [`TaskState::Cancelling`] step before [`TaskState::Cancelled`]
//! (Finding 9).

use std::str::FromStr;

use anyhow::{bail, Result};

/// Coarse lifecycle state of a long-running host task.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum TaskState {
    /// Task has been created but has not started executing yet.
    #[default]
    Created,
    /// Task is actively executing.
    Running,
    /// Task is suspended awaiting a human decision or input.
    WaitingForHuman,
    /// Task is suspended awaiting an external effect (network, tool, timer).
    WaitingForEffect,
    /// Task voluntarily yielded its slot and is paused.
    PausedYielded,
    /// Task is being resumed; continuity is still being re-established.
    Resuming,
    /// Resumption could not prove continuity; manual or automated repair is
    /// required, after which the task re-enters via [`TaskState::Resuming`]
    /// (it may not jump directly to [`TaskState::Running`]).
    RepairRequired,
    /// Task cannot make forward progress and is blocked pending intervention;
    /// recovery routes back through [`TaskState::Resuming`] rather than
    /// directly to [`TaskState::Running`].
    Blocked,
    /// Task finished successfully. Terminal.
    Completed,
    /// Task is in the process of being cancelled.
    Cancelling,
    /// Task was cancelled. Terminal.
    Cancelled,
    /// Task failed irrecoverably. Terminal.
    Failed,
}

impl TaskState {
    /// Stable lowercase-snake string for the variant.
    ///
    /// Used as the persisted `tasks.state` TEXT value in the durable task
    /// store; round-trips with [`TaskState::from_str`].
    pub fn as_str(&self) -> &'static str {
        use TaskState::*;
        match self {
            Created => "created",
            Running => "running",
            WaitingForHuman => "waiting_for_human",
            WaitingForEffect => "waiting_for_effect",
            PausedYielded => "paused_yielded",
            Resuming => "resuming",
            RepairRequired => "repair_required",
            Blocked => "blocked",
            Completed => "completed",
            Cancelling => "cancelling",
            Cancelled => "cancelled",
            Failed => "failed",
        }
    }
}

impl FromStr for TaskState {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        use TaskState::*;
        Ok(match s {
            "created" => Created,
            "running" => Running,
            "waiting_for_human" => WaitingForHuman,
            "waiting_for_effect" => WaitingForEffect,
            "paused_yielded" => PausedYielded,
            "resuming" => Resuming,
            "repair_required" => RepairRequired,
            "blocked" => Blocked,
            "completed" => Completed,
            "cancelling" => Cancelling,
            "cancelled" => Cancelled,
            "failed" => Failed,
            other => bail!("unknown task state: {other:?}"),
        })
    }
}

/// Returns the set of states reachable in one step from `state`.
///
/// Terminal states ([`TaskState::Completed`], [`TaskState::Cancelled`],
/// [`TaskState::Failed`]) return an empty slice.
fn allowed_transitions(state: TaskState) -> &'static [TaskState] {
    use TaskState::*;
    match state {
        Created => &[Running, Cancelling, Failed],
        Running => &[
            WaitingForHuman,
            WaitingForEffect,
            PausedYielded,
            Resuming,
            Completed,
            Cancelling,
            Blocked,
            Failed,
        ],
        WaitingForEffect => &[
            Running,
            WaitingForHuman,
            PausedYielded,
            Completed,
            Cancelling,
            Blocked,
            Failed,
        ],
        WaitingForHuman => &[Running, PausedYielded, Resuming, Cancelling, Blocked, Failed],
        PausedYielded => &[Resuming, WaitingForHuman, Cancelling, Blocked, Failed],
        Resuming => &[Running, RepairRequired, Blocked, Cancelling, Failed],
        // RepairRequired and Blocked must re-enter through Resuming, where
        // continuity/authority is re-established; they may not jump straight to
        // Running (Tasks 5.2 and 5.7 project resume-safety on this).
        RepairRequired => &[Resuming, Cancelling, Failed],
        Blocked => &[Resuming, WaitingForHuman, Cancelling, Failed],
        Cancelling => &[Cancelled, Failed],
        Completed | Cancelled | Failed => &[],
    }
}

/// Host-side projection of session/turn truth used to gate task state.
///
/// Finding 8: the long-task [`TaskState`] is **not** a second source of truth —
/// it is a *projection* over what the session and turn lifecycle actually
/// assert. This struct carries the minimal evidence the host can observe about
/// the session/turn backing a task, and [`task_state_allowed`] decides which
/// task states that evidence can legally support.
///
/// The richer mapping rows from the review table (the SDK's
/// `resumeControlResult()`, session-lifecycle and turn-lifecycle strings) are
/// not available to the host in Rust; they are *projected* onto the host
/// through the [`control_state`](Self::control_state) carrier using the
/// documented string values in [`control`]. For example, the SDK's
/// `resumeControlResult().repair.status == "repair_required"` is surfaced to
/// the host as `control_state == Some("repair_required")`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionTurnEvidence {
    /// Id of the turn currently backing the task, if any. `None` means no turn
    /// presently anchors the task (part of the "missing continuity proof").
    pub current_turn_id: Option<String>,
    /// Whether the backing turn is open (accepting work) for this segment.
    pub turn_open: bool,
    /// Whether the tab is currently commandable (attached, alive, accepting
    /// browser-side effects).
    pub tab_commandable: bool,
    /// Whether the segment backing this task is the attached browser-side-effect
    /// authority. At most one segment may be attached at a time (Task 5.4
    /// enforces uniqueness at the store level); here a task whose segment is not
    /// the attached authority cannot be [`TaskState::Running`].
    pub segment_attached: bool,
    /// Projected session/turn control state. See [`control`] for the accepted
    /// values and the lifecycle truths they stand in for. `None` means no
    /// special control state is asserted.
    pub control_state: Option<String>,
}

impl SessionTurnEvidence {
    /// Evidence projecting that a human currently holds session control
    /// (`control_state == "human_takeover"`). All other fields default.
    ///
    /// While a human holds control, `cancel_task` records a terminal task
    /// state but must NOT release browser resources (Finding 9).
    pub fn human_takeover() -> Self {
        Self {
            control_state: Some(control::HUMAN_TAKEOVER.into()),
            ..Default::default()
        }
    }
}

/// Documented [`SessionTurnEvidence::control_state`] string values.
///
/// These are the host-side projection of session/turn lifecycle truth. Each
/// constant maps a richer SDK/session/turn condition onto a single string the
/// host can carry and match (Finding 8).
pub mod control {
    /// Session control was handed to a human (SDK session lifecycle
    /// `human_takeover` / an explicit human decision gate). Enables
    /// [`super::TaskState::WaitingForHuman`].
    pub const HUMAN_TAKEOVER: &str = "human_takeover";
    /// Task voluntarily yielded: persisted session lifecycle `human_takeover`
    /// **and** turn lifecycle `yielded`. Enables
    /// [`super::TaskState::PausedYielded`].
    pub const YIELDED: &str = "yielded";
    /// Resumption in progress: session lifecycle `resuming { repairPlanId }`
    /// plus a `resumeControlResult()`. Enables [`super::TaskState::Resuming`].
    pub const RESUMING: &str = "resuming";
    /// `resumeControlResult().repair.status == "repair_required"`. Enables
    /// [`super::TaskState::RepairRequired`].
    pub const REPAIR_REQUIRED: &str = "repair_required";
    /// `resumeControlResult().status == "blocked"`. Enables
    /// [`super::TaskState::Blocked`].
    pub const BLOCKED: &str = "blocked";
}

/// Returns whether `state` is supported by the session/turn `evidence`.
///
/// This is the projection guard for Finding 8: it encodes the review's mapping
/// table from task state to required session/turn evidence. It does **not**
/// decide whether a *transition* is legal (that is [`TaskLifecycle::transition`])
/// — it decides whether the observed session/turn truth can back a task being
/// *in* `state` at all.
///
/// Mapping:
/// - [`TaskState::Running`] — there is a current turn id, the turn is open for
///   this segment, the tab is commandable, and the segment is the attached
///   browser-side-effect authority. (A task may span many turns, but only the
///   segment that is the attached authority can be `Running`.)
/// - [`TaskState::WaitingForHuman`] — `control_state == "human_takeover"`.
/// - [`TaskState::PausedYielded`] — `control_state == "yielded"` (projects
///   session `human_takeover` + turn `yielded`).
/// - [`TaskState::Resuming`] — `control_state == "resuming"`.
/// - [`TaskState::RepairRequired`] — `control_state == "repair_required"`.
/// - [`TaskState::Blocked`] — `control_state == "blocked"`, **or** there is no
///   continuity proof at all (no backing turn and no attached segment), i.e.
///   nothing proves a segment/turn still anchors the task.
/// - All other states ([`TaskState::Created`], [`TaskState::WaitingForEffect`],
///   [`TaskState::Cancelling`], [`TaskState::Completed`],
///   [`TaskState::Cancelled`], [`TaskState::Failed`]) are not gated by
///   session/turn evidence in the review table — they are internal,
///   transitional, or terminal and do not assert browser authority — so they
///   return `true`.
pub fn task_state_allowed(state: TaskState, evidence: &SessionTurnEvidence) -> bool {
    use TaskState::*;
    let control = evidence.control_state.as_deref();
    match state {
        Running => {
            evidence.current_turn_id.is_some()
                && evidence.turn_open
                && evidence.tab_commandable
                && evidence.segment_attached
        }
        WaitingForHuman => control == Some(control::HUMAN_TAKEOVER),
        PausedYielded => control == Some(control::YIELDED),
        Resuming => control == Some(control::RESUMING),
        RepairRequired => control == Some(control::REPAIR_REQUIRED),
        Blocked => {
            control == Some(control::BLOCKED)
                // Missing continuity proof: nothing backs the task — no turn
                // anchors it and no segment is the attached authority.
                || (evidence.current_turn_id.is_none() && !evidence.segment_attached)
        }
        // Not gated by session/turn evidence (internal/transitional/terminal).
        Created | WaitingForEffect | Cancelling | Completed | Cancelled | Failed => true,
    }
}

/// Tracks the current [`TaskState`] of a long task and enforces legal
/// transitions.
#[derive(Debug, Clone)]
pub struct TaskLifecycle {
    state: TaskState,
}

impl Default for TaskLifecycle {
    fn default() -> Self {
        Self::new()
    }
}

impl TaskLifecycle {
    /// Create a new lifecycle in the [`TaskState::Created`] state.
    pub fn new() -> Self {
        Self {
            state: TaskState::Created,
        }
    }

    /// Current task state.
    pub fn state(&self) -> TaskState {
        self.state
    }

    /// Attempt to transition to `next`.
    ///
    /// Returns `Ok(())` and updates [`Self::state`] when `next` is reachable in
    /// one step from the current state; otherwise returns an error and leaves
    /// the state unchanged.
    pub fn transition(&mut self, next: TaskState) -> Result<()> {
        if allowed_transitions(self.state).contains(&next) {
            self.state = next;
            Ok(())
        } else {
            bail!(
                "invalid task transition: {:?} -> {:?}",
                self.state,
                next
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_lifecycle_allows_repair_required_and_blocked() {
        let mut t = TaskLifecycle::new(); // created
        t.transition(TaskState::Running).unwrap();
        t.transition(TaskState::Resuming).unwrap();
        // continuity cannot be proven -> repair_required
        t.transition(TaskState::RepairRequired).unwrap();
        assert_eq!(t.state(), TaskState::RepairRequired);

        let mut b = TaskLifecycle::new();
        b.transition(TaskState::Running).unwrap();
        b.transition(TaskState::Resuming).unwrap();
        b.transition(TaskState::Blocked).unwrap();
        assert_eq!(b.state(), TaskState::Blocked);

        // illegal transition rejected
        let mut bad = TaskLifecycle::new();
        assert!(bad.transition(TaskState::Completed).is_err());
    }

    #[test]
    fn task_state_string_round_trips_every_variant() {
        let all = [
            TaskState::Created,
            TaskState::Running,
            TaskState::WaitingForHuman,
            TaskState::WaitingForEffect,
            TaskState::PausedYielded,
            TaskState::Resuming,
            TaskState::RepairRequired,
            TaskState::Blocked,
            TaskState::Completed,
            TaskState::Cancelling,
            TaskState::Cancelled,
            TaskState::Failed,
        ];
        for state in all {
            let s = state.as_str();
            assert_eq!(
                TaskState::from_str(s).unwrap(),
                state,
                "round-trip failed for {state:?} via {s:?}"
            );
        }
        assert!(TaskState::from_str("not_a_state").is_err());
    }

    #[test]
    fn human_takeover_evidence_projects_human_control() {
        let ev = SessionTurnEvidence::human_takeover();
        assert_eq!(ev.control_state.as_deref(), Some(control::HUMAN_TAKEOVER));
        assert!(task_state_allowed(TaskState::WaitingForHuman, &ev));
    }

    #[test]
    fn new_starts_in_created() {
        let t = TaskLifecycle::new();
        assert_eq!(t.state(), TaskState::Created);
        assert_eq!(TaskLifecycle::default().state(), TaskState::Created);
    }

    // Finding 9
    #[test]
    fn cancelling_path_from_waiting_for_human() {
        let mut t = TaskLifecycle::new();
        t.transition(TaskState::Running).unwrap();
        t.transition(TaskState::WaitingForHuman).unwrap();
        t.transition(TaskState::Cancelling).unwrap();
        t.transition(TaskState::Cancelled).unwrap();
        assert_eq!(t.state(), TaskState::Cancelled);
    }

    // Finding 9
    #[test]
    fn cancelling_path_from_paused_yielded() {
        let mut t = TaskLifecycle::new();
        t.transition(TaskState::Running).unwrap();
        t.transition(TaskState::PausedYielded).unwrap();
        t.transition(TaskState::Cancelling).unwrap();
        t.transition(TaskState::Cancelled).unwrap();
        assert_eq!(t.state(), TaskState::Cancelled);
    }

    #[test]
    fn resuming_can_reach_running() {
        let mut t = TaskLifecycle::new();
        t.transition(TaskState::Running).unwrap();
        t.transition(TaskState::PausedYielded).unwrap();
        t.transition(TaskState::Resuming).unwrap();
        t.transition(TaskState::Running).unwrap();
        assert_eq!(t.state(), TaskState::Running);
    }

    #[test]
    fn blocked_and_repair_required_cannot_jump_to_running() {
        // Blocked -> Running is rejected (must route through Resuming).
        let mut blocked = TaskLifecycle::new();
        blocked.transition(TaskState::Running).unwrap();
        blocked.transition(TaskState::Blocked).unwrap();
        assert!(blocked.transition(TaskState::Running).is_err());
        assert_eq!(blocked.state(), TaskState::Blocked);

        // RepairRequired -> Running is rejected (must route through Resuming).
        let mut repair = TaskLifecycle::new();
        repair.transition(TaskState::Running).unwrap();
        repair.transition(TaskState::Resuming).unwrap();
        repair.transition(TaskState::RepairRequired).unwrap();
        assert!(repair.transition(TaskState::Running).is_err());
        assert_eq!(repair.state(), TaskState::RepairRequired);
    }

    #[test]
    fn blocked_recovers_via_resuming_then_running() {
        let mut t = TaskLifecycle::new();
        t.transition(TaskState::Running).unwrap();
        t.transition(TaskState::Blocked).unwrap();
        t.transition(TaskState::Resuming).unwrap();
        t.transition(TaskState::Running).unwrap();
        assert_eq!(t.state(), TaskState::Running);
    }

    #[test]
    fn repair_required_recovers_via_resuming_then_running() {
        let mut t = TaskLifecycle::new();
        t.transition(TaskState::Running).unwrap();
        t.transition(TaskState::Resuming).unwrap();
        t.transition(TaskState::RepairRequired).unwrap();
        t.transition(TaskState::Resuming).unwrap();
        t.transition(TaskState::Running).unwrap();
        assert_eq!(t.state(), TaskState::Running);
    }

    #[test]
    fn terminal_states_reject_all_transitions() {
        let terminals = [
            TaskState::Completed,
            TaskState::Cancelled,
            TaskState::Failed,
        ];
        let targets = [
            TaskState::Created,
            TaskState::Running,
            TaskState::WaitingForHuman,
            TaskState::WaitingForEffect,
            TaskState::PausedYielded,
            TaskState::Resuming,
            TaskState::RepairRequired,
            TaskState::Blocked,
            TaskState::Completed,
            TaskState::Cancelling,
            TaskState::Cancelled,
            TaskState::Failed,
        ];
        for &term in &terminals {
            for &target in &targets {
                let mut t = TaskLifecycle { state: term };
                assert!(
                    t.transition(target).is_err(),
                    "terminal {term:?} should reject -> {target:?}",
                );
                // State must be unchanged after a rejected transition.
                assert_eq!(t.state(), term);
            }
        }
    }

    #[test]
    fn rejected_transition_leaves_state_unchanged() {
        let mut t = TaskLifecycle::new();
        assert!(t.transition(TaskState::Completed).is_err());
        assert_eq!(t.state(), TaskState::Created);
    }

    // Finding 8: task state is a projection over session/turn evidence.
    #[test]
    fn running_requires_open_turn_and_commandable_tab() {
        let ev = SessionTurnEvidence {
            current_turn_id: Some("t1".into()),
            turn_open: true,
            tab_commandable: true,
            segment_attached: true,
            control_state: None,
        };
        assert!(task_state_allowed(TaskState::Running, &ev));
        let no_turn = SessionTurnEvidence {
            current_turn_id: None,
            turn_open: false,
            tab_commandable: true,
            segment_attached: true,
            control_state: None,
        };
        assert!(
            !task_state_allowed(TaskState::Running, &no_turn),
            "running needs an open turn"
        );

        let takeover = SessionTurnEvidence {
            control_state: Some("human_takeover".into()),
            ..no_turn.clone()
        };
        assert!(task_state_allowed(TaskState::WaitingForHuman, &takeover));
    }

    /// Evidence with a control_state set but no turn/segment backing — useful
    /// for exercising the control-state-gated rows in isolation.
    fn control_only(state: &str) -> SessionTurnEvidence {
        SessionTurnEvidence {
            control_state: Some(state.into()),
            ..Default::default()
        }
    }

    #[test]
    fn waiting_for_human_requires_human_takeover() {
        assert!(task_state_allowed(
            TaskState::WaitingForHuman,
            &control_only(control::HUMAN_TAKEOVER)
        ));
        // Wrong control state, and the empty default, are both rejected.
        assert!(!task_state_allowed(
            TaskState::WaitingForHuman,
            &control_only(control::YIELDED)
        ));
        assert!(!task_state_allowed(
            TaskState::WaitingForHuman,
            &SessionTurnEvidence::default()
        ));
    }

    #[test]
    fn paused_yielded_requires_yielded() {
        assert!(task_state_allowed(
            TaskState::PausedYielded,
            &control_only(control::YIELDED)
        ));
        assert!(!task_state_allowed(
            TaskState::PausedYielded,
            &control_only(control::HUMAN_TAKEOVER)
        ));
        assert!(!task_state_allowed(
            TaskState::PausedYielded,
            &SessionTurnEvidence::default()
        ));
    }

    #[test]
    fn resuming_requires_resuming_control_state() {
        assert!(task_state_allowed(
            TaskState::Resuming,
            &control_only(control::RESUMING)
        ));
        assert!(!task_state_allowed(
            TaskState::Resuming,
            &control_only(control::BLOCKED)
        ));
        assert!(!task_state_allowed(
            TaskState::Resuming,
            &SessionTurnEvidence::default()
        ));
    }

    #[test]
    fn repair_required_requires_repair_required_control_state() {
        assert!(task_state_allowed(
            TaskState::RepairRequired,
            &control_only(control::REPAIR_REQUIRED)
        ));
        assert!(!task_state_allowed(
            TaskState::RepairRequired,
            &control_only(control::RESUMING)
        ));
    }

    #[test]
    fn blocked_via_explicit_control_state() {
        assert!(task_state_allowed(
            TaskState::Blocked,
            &control_only(control::BLOCKED)
        ));
    }

    #[test]
    fn blocked_via_missing_continuity_proof() {
        // No backing turn AND no attached segment => nothing proves a
        // segment/turn anchors the task, so Blocked is allowed even without an
        // explicit "blocked" control_state.
        let no_proof = SessionTurnEvidence {
            current_turn_id: None,
            turn_open: false,
            tab_commandable: false,
            segment_attached: false,
            control_state: None,
        };
        assert!(task_state_allowed(TaskState::Blocked, &no_proof));

        // If a turn still anchors the task (continuity proof present), Blocked
        // is not implied by evidence alone.
        let has_turn = SessionTurnEvidence {
            current_turn_id: Some("t9".into()),
            ..no_proof.clone()
        };
        assert!(!task_state_allowed(TaskState::Blocked, &has_turn));

        // Likewise, an attached segment is continuity proof.
        let has_segment = SessionTurnEvidence {
            segment_attached: true,
            ..no_proof
        };
        assert!(!task_state_allowed(TaskState::Blocked, &has_segment));
    }

    #[test]
    fn ungated_states_always_allowed() {
        let empty = SessionTurnEvidence::default();
        for state in [
            TaskState::Created,
            TaskState::WaitingForEffect,
            TaskState::Cancelling,
            TaskState::Completed,
            TaskState::Cancelled,
            TaskState::Failed,
        ] {
            assert!(
                task_state_allowed(state, &empty),
                "{state:?} is not gated by session/turn evidence and should be allowed",
            );
        }
    }

    // Finding 8 invariant: a task may span multiple turns, but at most one
    // segment is the active browser-side-effect authority at a time. Modeled at
    // the evidence level: of two turns whose evidence is identical except that
    // only one has `segment_attached: true`, at most one can be `Running`. (Task
    // 5.4 enforces the single-segment uniqueness at the store level.)
    #[test]
    fn at_most_one_segment_is_running_authority() {
        let attached = SessionTurnEvidence {
            current_turn_id: Some("turn-a".into()),
            turn_open: true,
            tab_commandable: true,
            segment_attached: true,
            control_state: None,
        };
        let detached = SessionTurnEvidence {
            current_turn_id: Some("turn-b".into()),
            turn_open: true,
            tab_commandable: true,
            segment_attached: false,
            control_state: None,
        };

        let running_count = [&attached, &detached]
            .into_iter()
            .filter(|ev| task_state_allowed(TaskState::Running, ev))
            .count();
        assert_eq!(
            running_count, 1,
            "only the attached-authority segment may back a Running task"
        );
        assert!(task_state_allowed(TaskState::Running, &attached));
        assert!(!task_state_allowed(TaskState::Running, &detached));
    }
}

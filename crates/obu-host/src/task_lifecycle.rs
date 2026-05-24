//! Long-task lifecycle state machine.
//!
//! Models the coarse lifecycle of a durable host task that may pause, yield,
//! wait for a human or an external effect, and later resume. Resumption is not
//! always clean: when continuity cannot be proven the task moves to
//! [`TaskState::RepairRequired`], and when forward progress is impossible it
//! moves to [`TaskState::Blocked`] (Finding 7). Cancellation flows through an
//! explicit [`TaskState::Cancelling`] step before [`TaskState::Cancelled`]
//! (Finding 9).

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
}

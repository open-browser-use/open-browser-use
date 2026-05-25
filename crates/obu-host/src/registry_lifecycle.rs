//! Pure lifecycle event helpers for the host service registry.

use std::collections::{HashSet, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

/// Maximum recent lifecycle events retained for host diagnostics.
pub const MAX_REGISTRY_LIFECYCLE_EVENTS: usize = 128;

/// Host registry tab status used by pure lifecycle planners.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryTabSnapshotStatus {
    /// Controlled by the current browser session.
    Active,
    /// Parked for handoff outside active browser-control commands.
    Handoff,
    /// Preserved as a stable deliverable outside active browser control.
    Deliverable,
}

/// Minimal tab row used by pure host registry lifecycle planners.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryTabSnapshot {
    /// SDK-facing tab id.
    pub tab_id: String,
    /// Owning browser-control session, when known.
    pub session_id: Option<String>,
    /// Host-visible lifecycle status.
    pub status: RegistryTabSnapshotStatus,
}

/// Pure decision for repairing a session logical active tab.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveTabRepairPlan {
    /// Next logical active tab id, if any active owned tab remains.
    pub next_active_tab_id: Option<String>,
    /// Whether the stored active tab should be updated.
    pub changed: bool,
}

/// Pure decision for reconciling a host session against backend-observed tabs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconcileSessionTabsPlan {
    /// Non-deliverable session-owned tabs that should become stale.
    pub stale_tab_ids: Vec<String>,
    /// Next logical active tab id after stale rows are removed.
    pub next_active_tab_id: Option<String>,
    /// Whether the stored active tab should be updated.
    pub active_tab_changed: bool,
}

/// Registry-owned handle kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryHandleKind {
    /// Playwright file chooser handle.
    FileChooser,
    /// Playwright download handle.
    Download,
}

/// Closed public lifecycle state of a registry handle. The state is a
/// *projection* — the event/plan stream remains the source of truth. Live
/// handles project to `Pending`/`Active`/`Completed`; tombstones carry the
/// terminal state recorded at the transition that retired them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HandleState {
    /// Awaiting its first action (file chooser before selection).
    Pending,
    /// In progress (download before completion).
    Active,
    /// File chooser selection was consumed. Terminal.
    Consumed,
    /// Download finished successfully. Terminal.
    Completed,
    /// Handle failed. Terminal.
    Failed,
    /// Retired by tab/session reconciliation. Terminal.
    Stale,
    /// Explicitly removed. Terminal.
    Gone,
}

impl HandleState {
    /// Every state.
    pub const ALL: [HandleState; 7] = [
        Self::Pending,
        Self::Active,
        Self::Consumed,
        Self::Completed,
        Self::Failed,
        Self::Stale,
        Self::Gone,
    ];

    /// Stable snake_case string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Active => "active",
            Self::Consumed => "consumed",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Stale => "stale",
            Self::Gone => "gone",
        }
    }
}

/// Project the live state of a handle from its kind and completion.
pub fn live_handle_state(kind: RegistryHandleKind, download_completed: bool) -> HandleState {
    match kind {
        RegistryHandleKind::FileChooser => HandleState::Pending,
        RegistryHandleKind::Download if download_completed => HandleState::Completed,
        RegistryHandleKind::Download => HandleState::Active,
    }
}

/// Minimal handle row used by pure host registry lifecycle planners.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryHandleSnapshot {
    /// SDK-facing handle id.
    pub handle_id: String,
    /// Owning tab id.
    pub tab_id: String,
    /// Owning browser-control session, when known.
    pub owner_session_id: Option<String>,
    /// Owning turn id at acquisition (turn proof), when known.
    pub owner_turn_id: Option<String>,
    /// Handle kind.
    pub kind: RegistryHandleKind,
    /// Closed projected lifecycle state.
    pub state: HandleState,
}

/// Planned lifecycle event without a concrete timestamp.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryLifecycleEventPlan {
    /// Transition kind.
    pub kind: RegistryLifecycleEventKind,
    /// Primary subject id, such as a session id, tab id, or handle id.
    pub subject_id: String,
    /// Owning session id when known.
    pub session_id: Option<String>,
    /// Owning tab id when known.
    pub tab_id: Option<String>,
    /// Transition reason when the event has one.
    pub reason: Option<String>,
}

/// Planned stale handle transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryStaleHandlePlan {
    /// Handle kind.
    pub kind: RegistryHandleKind,
    /// SDK-facing handle id.
    pub handle_id: String,
    /// Owning tab id.
    pub tab_id: String,
    /// Owning browser-control session, when known.
    pub owner_session_id: Option<String>,
    /// Stale reason.
    pub reason: String,
    /// Closed terminal state recorded at the transition that retired the handle.
    pub terminal_state: HandleState,
}

/// Pure plan for clearing all handles tied to a tab.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClearTabHandlesPlan {
    /// Whether Playwright injected runtime state should be cleared.
    pub clear_playwright_injected: bool,
    /// Handles that should be removed and recorded as stale.
    pub stale_handles: Vec<RegistryStaleHandlePlan>,
    /// Aggregate lifecycle event for the tab cleanup, when anything changed.
    pub event: Option<RegistryLifecycleEventPlan>,
}

/// Pure plan for consuming a file chooser handle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsumeFileChooserPlan {
    /// Stale handle transition for the consumed handle.
    pub stale_handle: RegistryStaleHandlePlan,
    /// Terminal consumed event.
    pub event: RegistryLifecycleEventPlan,
}

/// Pure plan for marking a download handle completed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadCompletedPlan {
    /// Terminal completed event.
    pub event: RegistryLifecycleEventPlan,
}

/// Pure plan for removing a download handle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoveDownloadPlan {
    /// Terminal removed event.
    pub event: RegistryLifecycleEventPlan,
    /// Stale handle transition for the removed handle.
    pub stale_handle: RegistryStaleHandlePlan,
}

/// Pure plan for marking a download handle failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadFailedPlan {
    /// Terminal failed event.
    pub event: RegistryLifecycleEventPlan,
    /// Stale handle transition for the failed handle.
    pub stale_handle: RegistryStaleHandlePlan,
}

/// Choose the deterministic active tab for a session from host tab snapshots.
pub fn choose_registry_active_tab_id(
    session_id: &str,
    tabs: &[RegistryTabSnapshot],
) -> Option<String> {
    let mut candidates = tabs
        .iter()
        .filter(|tab| is_active_session_tab(tab, session_id))
        .map(|tab| tab.tab_id.clone())
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.into_iter().next()
}

/// Plan how to repair a session logical active tab from host tab snapshots.
pub fn plan_current_active_tab_repair(
    session_id: &str,
    current_active_tab_id: Option<&str>,
    tabs: &[RegistryTabSnapshot],
) -> ActiveTabRepairPlan {
    if let Some(current_active_tab_id) = current_active_tab_id
        && tabs.iter().any(|tab| {
            tab.tab_id == current_active_tab_id && is_active_session_tab(tab, session_id)
        })
    {
        return ActiveTabRepairPlan {
            next_active_tab_id: Some(current_active_tab_id.to_string()),
            changed: false,
        };
    }
    let next_active_tab_id = choose_registry_active_tab_id(session_id, tabs);
    ActiveTabRepairPlan {
        changed: current_active_tab_id != next_active_tab_id.as_deref(),
        next_active_tab_id,
    }
}

/// Plan session tab reconciliation against backend-observed tab ids.
pub fn plan_reconcile_session_tabs(
    session_id: &str,
    observed_tab_ids: &HashSet<String>,
    current_active_tab_id: Option<&str>,
    tabs: &[RegistryTabSnapshot],
) -> ReconcileSessionTabsPlan {
    let mut stale_tab_ids = tabs
        .iter()
        .filter(|tab| {
            tab.session_id.as_deref() == Some(session_id)
                && tab.status != RegistryTabSnapshotStatus::Deliverable
                && !observed_tab_ids.contains(&tab.tab_id)
        })
        .map(|tab| tab.tab_id.clone())
        .collect::<Vec<_>>();
    stale_tab_ids.sort();
    let stale = stale_tab_ids.iter().cloned().collect::<HashSet<_>>();
    let remaining_tabs = tabs
        .iter()
        .filter(|tab| !stale.contains(&tab.tab_id))
        .cloned()
        .collect::<Vec<_>>();
    let next_active_tab_id = choose_registry_active_tab_id(session_id, &remaining_tabs);
    ReconcileSessionTabsPlan {
        active_tab_changed: current_active_tab_id != next_active_tab_id.as_deref(),
        stale_tab_ids,
        next_active_tab_id,
    }
}

/// Plan cleanup of Playwright runtime state and handles tied to a tab.
pub fn plan_clear_tab_handles(
    tab_id: &str,
    playwright_injected: bool,
    handles: &[RegistryHandleSnapshot],
    stale_reason: &str,
) -> ClearTabHandlesPlan {
    let mut stale_handles = handles
        .iter()
        .filter(|handle| handle.tab_id == tab_id)
        .map(|handle| stale_handle_plan(handle, stale_reason, HandleState::Stale))
        .collect::<Vec<_>>();
    stale_handles.sort_by(|left, right| {
        left.handle_id
            .cmp(&right.handle_id)
            .then(handle_kind_order(left.kind).cmp(&handle_kind_order(right.kind)))
    });
    let changed = playwright_injected || !stale_handles.is_empty();
    ClearTabHandlesPlan {
        clear_playwright_injected: playwright_injected,
        stale_handles,
        event: changed.then(|| RegistryLifecycleEventPlan {
            kind: RegistryLifecycleEventKind::TabHandlesCleared,
            subject_id: tab_id.to_string(),
            session_id: None,
            tab_id: Some(tab_id.to_string()),
            reason: Some(stale_reason.to_string()),
        }),
    }
}

/// Plan terminal state for a consumed file chooser handle.
pub fn plan_file_chooser_consumed(handle: &RegistryHandleSnapshot) -> ConsumeFileChooserPlan {
    let reason = "already consumed by setFiles";
    ConsumeFileChooserPlan {
        stale_handle: stale_handle_plan(handle, reason, HandleState::Consumed),
        event: RegistryLifecycleEventPlan {
            kind: RegistryLifecycleEventKind::FileChooserConsumed,
            subject_id: handle.handle_id.clone(),
            session_id: handle.owner_session_id.clone(),
            tab_id: Some(handle.tab_id.clone()),
            reason: Some(reason.to_string()),
        },
    }
}

/// Plan terminal state for a completed download handle.
pub fn plan_download_completed(handle: &RegistryHandleSnapshot) -> DownloadCompletedPlan {
    DownloadCompletedPlan {
        event: RegistryLifecycleEventPlan {
            kind: RegistryLifecycleEventKind::DownloadCompleted,
            subject_id: handle.handle_id.clone(),
            session_id: handle.owner_session_id.clone(),
            tab_id: Some(handle.tab_id.clone()),
            reason: None,
        },
    }
}

/// Plan terminal state for an explicitly removed download handle.
pub fn plan_download_removed(handle: &RegistryHandleSnapshot) -> RemoveDownloadPlan {
    let reason = "removed explicitly";
    RemoveDownloadPlan {
        event: RegistryLifecycleEventPlan {
            kind: RegistryLifecycleEventKind::DownloadRemoved,
            subject_id: handle.handle_id.clone(),
            session_id: handle.owner_session_id.clone(),
            tab_id: Some(handle.tab_id.clone()),
            reason: Some(reason.to_string()),
        },
        stale_handle: stale_handle_plan(handle, reason, HandleState::Gone),
    }
}

/// Plan terminal state for a failed download handle.
pub fn plan_download_failed(
    handle: &RegistryHandleSnapshot,
    reason: impl Into<String>,
) -> DownloadFailedPlan {
    let reason = reason.into();
    DownloadFailedPlan {
        event: RegistryLifecycleEventPlan {
            kind: RegistryLifecycleEventKind::DownloadFailed,
            subject_id: handle.handle_id.clone(),
            session_id: handle.owner_session_id.clone(),
            tab_id: Some(handle.tab_id.clone()),
            reason: Some(reason.clone()),
        },
        stale_handle: stale_handle_plan(handle, &reason, HandleState::Failed),
    }
}

/// Plan a session touch/create lifecycle event.
pub fn plan_session_touched(session_id: &str, turn_id: Option<&str>) -> RegistryLifecycleEventPlan {
    registry_event_plan(
        RegistryLifecycleEventKind::SessionTouched,
        session_id,
        Some(session_id.to_string()),
        None,
        turn_id.map(|turn_id| format!("turn_id={turn_id}")),
    )
}

/// Plan a session label lifecycle event.
pub fn plan_session_named(session_id: &str, label: Option<String>) -> RegistryLifecycleEventPlan {
    registry_event_plan(
        RegistryLifecycleEventKind::SessionNamed,
        session_id,
        Some(session_id.to_string()),
        None,
        label.map(|label| format!("label={label}")),
    )
}

/// Plan direct logical-active-tab assignment for a session.
pub fn plan_session_active_tab_set(
    session_id: &str,
    tab_id: &str,
    turn_id: Option<&str>,
) -> RegistryLifecycleEventPlan {
    registry_event_plan(
        RegistryLifecycleEventKind::SessionActiveTabSet,
        session_id,
        Some(session_id.to_string()),
        Some(tab_id.to_string()),
        turn_id.map(|turn_id| format!("turn_id={turn_id}")),
    )
}

/// Plan logical-active-tab reconciliation for a session.
pub fn plan_session_active_tab_reconciled(
    session_id: &str,
    next_active_tab_id: Option<String>,
    reason: impl Into<String>,
) -> RegistryLifecycleEventPlan {
    registry_event_plan(
        RegistryLifecycleEventKind::SessionActiveTabReconciled,
        session_id,
        Some(session_id.to_string()),
        next_active_tab_id,
        Some(reason.into()),
    )
}

/// Plan a stale-session lifecycle event.
pub fn plan_session_stale(
    session_id: &str,
    reason: impl Into<String>,
) -> RegistryLifecycleEventPlan {
    registry_event_plan(
        RegistryLifecycleEventKind::SessionStale,
        session_id,
        Some(session_id.to_string()),
        None,
        Some(reason.into()),
    )
}

/// Plan a tab insert or restore lifecycle event.
pub fn plan_tab_inserted(
    tab_id: &str,
    session_id: Option<String>,
    restored_stale_diagnostic: bool,
) -> RegistryLifecycleEventPlan {
    registry_event_plan(
        RegistryLifecycleEventKind::TabInserted,
        tab_id,
        session_id,
        Some(tab_id.to_string()),
        restored_stale_diagnostic.then(|| "restored stale tab diagnostic".to_string()),
    )
}

/// Plan a tab update lifecycle event.
pub fn plan_tab_updated(tab_id: &str, session_id: Option<String>) -> RegistryLifecycleEventPlan {
    registry_event_plan(
        RegistryLifecycleEventKind::TabUpdated,
        tab_id,
        session_id,
        Some(tab_id.to_string()),
        None,
    )
}

/// Plan a stale tab diagnostic lifecycle event.
pub fn plan_tab_stale(
    tab_id: &str,
    session_id: Option<String>,
    reason: impl Into<String>,
) -> RegistryLifecycleEventPlan {
    registry_event_plan(
        RegistryLifecycleEventKind::TabStale,
        tab_id,
        session_id,
        Some(tab_id.to_string()),
        Some(reason.into()),
    )
}

/// Plan a Playwright runtime injection lifecycle event.
pub fn plan_playwright_injected(tab_id: &str) -> RegistryLifecycleEventPlan {
    registry_event_plan(
        RegistryLifecycleEventKind::PlaywrightInjected,
        tab_id,
        None,
        Some(tab_id.to_string()),
        None,
    )
}

/// Plan a Playwright runtime injection cleanup lifecycle event.
pub fn plan_playwright_injection_cleared(tab_id: &str) -> RegistryLifecycleEventPlan {
    registry_event_plan(
        RegistryLifecycleEventKind::PlaywrightInjectionCleared,
        tab_id,
        None,
        Some(tab_id.to_string()),
        None,
    )
}

/// Plan a file chooser handle insertion lifecycle event.
pub fn plan_file_chooser_inserted(handle: &RegistryHandleSnapshot) -> RegistryLifecycleEventPlan {
    registry_event_plan(
        RegistryLifecycleEventKind::FileChooserInserted,
        &handle.handle_id,
        handle.owner_session_id.clone(),
        Some(handle.tab_id.clone()),
        None,
    )
}

/// Plan a stale file chooser diagnostic lifecycle event.
pub fn plan_file_chooser_stale(
    handle_id: &str,
    tab_id: &str,
    owner_session_id: Option<String>,
    reason: impl Into<String>,
) -> RegistryLifecycleEventPlan {
    registry_event_plan(
        RegistryLifecycleEventKind::FileChooserStale,
        handle_id,
        owner_session_id,
        Some(tab_id.to_string()),
        Some(reason.into()),
    )
}

/// Plan a download handle insertion lifecycle event.
pub fn plan_download_inserted(handle: &RegistryHandleSnapshot) -> RegistryLifecycleEventPlan {
    registry_event_plan(
        RegistryLifecycleEventKind::DownloadInserted,
        &handle.handle_id,
        handle.owner_session_id.clone(),
        Some(handle.tab_id.clone()),
        None,
    )
}

/// Plan a stale download diagnostic lifecycle event.
pub fn plan_download_stale(
    handle_id: &str,
    tab_id: &str,
    owner_session_id: Option<String>,
    reason: impl Into<String>,
) -> RegistryLifecycleEventPlan {
    registry_event_plan(
        RegistryLifecycleEventKind::DownloadStale,
        handle_id,
        owner_session_id,
        Some(tab_id.to_string()),
        Some(reason.into()),
    )
}

/// Plan stale diagnostics acknowledgement.
pub fn plan_diagnostics_cleared() -> RegistryLifecycleEventPlan {
    registry_event_plan(
        RegistryLifecycleEventKind::DiagnosticsCleared,
        "diagnostics",
        None,
        None,
        Some("stale diagnostics acknowledged".to_string()),
    )
}

fn registry_event_plan(
    kind: RegistryLifecycleEventKind,
    subject_id: impl Into<String>,
    session_id: Option<String>,
    tab_id: Option<String>,
    reason: Option<String>,
) -> RegistryLifecycleEventPlan {
    RegistryLifecycleEventPlan {
        kind,
        subject_id: subject_id.into(),
        session_id,
        tab_id,
        reason,
    }
}

fn stale_handle_plan(
    handle: &RegistryHandleSnapshot,
    reason: &str,
    terminal_state: HandleState,
) -> RegistryStaleHandlePlan {
    RegistryStaleHandlePlan {
        kind: handle.kind,
        handle_id: handle.handle_id.clone(),
        tab_id: handle.tab_id.clone(),
        owner_session_id: handle.owner_session_id.clone(),
        reason: reason.to_string(),
        terminal_state,
    }
}

fn handle_kind_order(kind: RegistryHandleKind) -> u8 {
    match kind {
        RegistryHandleKind::FileChooser => 0,
        RegistryHandleKind::Download => 1,
    }
}

fn is_active_session_tab(tab: &RegistryTabSnapshot, session_id: &str) -> bool {
    tab.session_id.as_deref() == Some(session_id) && tab.status == RegistryTabSnapshotStatus::Active
}

/// Named lifecycle transition emitted by `ServiceRegistry` mutations.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistryLifecycleEventKind {
    /// A session was created or touched by a request.
    SessionTouched,
    /// A session label changed.
    SessionNamed,
    /// A session logical active tab was set directly.
    SessionActiveTabSet,
    /// A session logical active tab was repaired from registry state.
    SessionActiveTabReconciled,
    /// A session was marked stale.
    SessionStale,
    /// A tab record was inserted or replaced.
    TabInserted,
    /// A tab record was updated.
    TabUpdated,
    /// A tab became stale through removal or reconciliation.
    TabStale,
    /// Handles tied to a tab were cleared.
    TabHandlesCleared,
    /// Playwright runtime state was marked injected for a tab.
    PlaywrightInjected,
    /// Playwright runtime state was cleared for a tab.
    PlaywrightInjectionCleared,
    /// A file chooser handle was inserted.
    FileChooserInserted,
    /// A file chooser handle was consumed.
    FileChooserConsumed,
    /// A file chooser handle became stale.
    FileChooserStale,
    /// A download handle was inserted.
    DownloadInserted,
    /// A download handle was marked complete.
    DownloadCompleted,
    /// A download handle was removed explicitly.
    DownloadRemoved,
    /// A download handle failed or was canceled.
    DownloadFailed,
    /// A download handle became stale.
    DownloadStale,
    /// Stale diagnostics were cleared.
    DiagnosticsCleared,
}

/// One host registry lifecycle event suitable for diagnostics and tests.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RegistryLifecycleEvent {
    /// Transition kind.
    pub kind: RegistryLifecycleEventKind,
    /// Primary subject id, such as a session id, tab id, or handle id.
    pub subject_id: String,
    /// Owning session id when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Owning tab id when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    /// Transition reason when the event has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Agent-facing recovery or follow-up action for terminal/repair-relevant events.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_action: Option<String>,
    /// Event timestamp as Unix milliseconds.
    pub at_unix_ms: u64,
}

/// Build a lifecycle event from pure input values.
pub fn registry_lifecycle_event(
    kind: RegistryLifecycleEventKind,
    subject_id: impl Into<String>,
    session_id: Option<String>,
    tab_id: Option<String>,
    reason: Option<String>,
    now: SystemTime,
) -> RegistryLifecycleEvent {
    let next_action = registry_lifecycle_next_action(&kind).map(str::to_string);
    RegistryLifecycleEvent {
        kind,
        subject_id: subject_id.into(),
        session_id,
        tab_id,
        reason,
        next_action,
        at_unix_ms: unix_millis(now),
    }
}

fn registry_lifecycle_next_action(kind: &RegistryLifecycleEventKind) -> Option<&'static str> {
    match kind {
        RegistryLifecycleEventKind::SessionStale => Some("repair_or_start_new_session"),
        RegistryLifecycleEventKind::TabStale => Some("observe_tabs_or_clear_diagnostics"),
        RegistryLifecycleEventKind::TabHandlesCleared => Some("create_new_handles"),
        RegistryLifecycleEventKind::PlaywrightInjectionCleared => Some("reinjection_allowed"),
        RegistryLifecycleEventKind::FileChooserConsumed => Some("do_not_reuse_handle"),
        RegistryLifecycleEventKind::FileChooserStale => Some("create_new_file_chooser"),
        RegistryLifecycleEventKind::DownloadCompleted => Some("read_download_path_or_finalize"),
        RegistryLifecycleEventKind::DownloadRemoved => Some("do_not_reuse_handle"),
        RegistryLifecycleEventKind::DownloadFailed => Some("inspect_error_or_retry_download"),
        RegistryLifecycleEventKind::DownloadStale => Some("create_new_download"),
        RegistryLifecycleEventKind::DiagnosticsCleared => Some("retry_after_repair"),
        _ => None,
    }
}

/// Append a lifecycle event to a bounded recent-event queue.
pub fn push_registry_lifecycle_event(
    events: &mut VecDeque<RegistryLifecycleEvent>,
    event: RegistryLifecycleEvent,
) {
    events.push_back(event);
    while events.len() > MAX_REGISTRY_LIFECYCLE_EVENTS {
        events.pop_front();
    }
}

fn unix_millis(time: SystemTime) -> u64 {
    let millis = time
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    millis.min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_events_are_bounded() {
        let mut events = VecDeque::new();
        for index in 0..(MAX_REGISTRY_LIFECYCLE_EVENTS + 5) {
            push_registry_lifecycle_event(
                &mut events,
                registry_lifecycle_event(
                    RegistryLifecycleEventKind::TabInserted,
                    format!("tab-{index}"),
                    Some("session".into()),
                    Some(format!("tab-{index}")),
                    None,
                    UNIX_EPOCH,
                ),
            );
        }

        assert_eq!(events.len(), MAX_REGISTRY_LIFECYCLE_EVENTS);
        assert_eq!(events.front().unwrap().subject_id, "tab-5");
    }

    #[test]
    fn active_tab_planner_repairs_missing_or_non_commandable_current_tab() {
        let tabs = vec![
            tab(
                "handoff",
                Some("session"),
                RegistryTabSnapshotStatus::Handoff,
            ),
            tab(
                "deliverable",
                Some("session"),
                RegistryTabSnapshotStatus::Deliverable,
            ),
            tab(
                "active-b",
                Some("session"),
                RegistryTabSnapshotStatus::Active,
            ),
            tab(
                "active-a",
                Some("session"),
                RegistryTabSnapshotStatus::Active,
            ),
            tab(
                "other",
                Some("other-session"),
                RegistryTabSnapshotStatus::Active,
            ),
        ];

        assert_eq!(
            choose_registry_active_tab_id("session", &tabs),
            Some("active-a".into())
        );
        assert_eq!(
            plan_current_active_tab_repair("session", Some("active-b"), &tabs),
            ActiveTabRepairPlan {
                next_active_tab_id: Some("active-b".into()),
                changed: false,
            }
        );
        assert_eq!(
            plan_current_active_tab_repair("session", Some("handoff"), &tabs),
            ActiveTabRepairPlan {
                next_active_tab_id: Some("active-a".into()),
                changed: true,
            }
        );
        assert_eq!(
            plan_current_active_tab_repair("session", Some("missing"), &tabs),
            ActiveTabRepairPlan {
                next_active_tab_id: Some("active-a".into()),
                changed: true,
            }
        );
    }

    #[test]
    fn reconcile_planner_stales_only_missing_non_deliverable_session_tabs() {
        let tabs = vec![
            tab(
                "active-a",
                Some("session"),
                RegistryTabSnapshotStatus::Active,
            ),
            tab(
                "active-b",
                Some("session"),
                RegistryTabSnapshotStatus::Active,
            ),
            tab(
                "deliverable",
                Some("session"),
                RegistryTabSnapshotStatus::Deliverable,
            ),
            tab(
                "other",
                Some("other-session"),
                RegistryTabSnapshotStatus::Active,
            ),
        ];
        let observed = HashSet::from(["active-b".to_string()]);

        assert_eq!(
            plan_reconcile_session_tabs("session", &observed, Some("active-a"), &tabs),
            ReconcileSessionTabsPlan {
                stale_tab_ids: vec!["active-a".into()],
                next_active_tab_id: Some("active-b".into()),
                active_tab_changed: true,
            }
        );
    }

    #[test]
    fn clear_tab_handles_planner_stales_owned_handles_and_emits_aggregate_event() {
        let handles = vec![
            handle(
                "chooser-1",
                "tab-1",
                Some("session"),
                RegistryHandleKind::FileChooser,
            ),
            handle(
                "download-1",
                "tab-1",
                Some("session"),
                RegistryHandleKind::Download,
            ),
            handle(
                "download-other",
                "tab-2",
                Some("session"),
                RegistryHandleKind::Download,
            ),
        ];

        let plan = plan_clear_tab_handles("tab-1", true, &handles, "tab finalized");

        assert_eq!(plan.clear_playwright_injected, true);
        assert_eq!(
            plan.stale_handles
                .iter()
                .map(|handle| (&handle.handle_id, handle.kind))
                .collect::<Vec<_>>(),
            vec![
                (&"chooser-1".to_string(), RegistryHandleKind::FileChooser),
                (&"download-1".to_string(), RegistryHandleKind::Download),
            ]
        );
        assert_eq!(
            plan.event.unwrap().kind,
            RegistryLifecycleEventKind::TabHandlesCleared
        );
    }

    #[test]
    fn handle_terminal_planners_shape_stale_and_terminal_events() {
        let chooser = handle(
            "chooser-1",
            "tab-1",
            Some("session"),
            RegistryHandleKind::FileChooser,
        );
        let download = handle(
            "download-1",
            "tab-1",
            Some("session"),
            RegistryHandleKind::Download,
        );

        let consumed = plan_file_chooser_consumed(&chooser);
        assert_eq!(consumed.stale_handle.reason, "already consumed by setFiles");
        assert_eq!(
            consumed.event.kind,
            RegistryLifecycleEventKind::FileChooserConsumed
        );

        assert_eq!(
            plan_download_completed(&download).event.kind,
            RegistryLifecycleEventKind::DownloadCompleted
        );

        let removed = plan_download_removed(&download);
        assert_eq!(
            removed.event.kind,
            RegistryLifecycleEventKind::DownloadRemoved
        );
        assert_eq!(removed.stale_handle.reason, "removed explicitly");
    }

    #[test]
    fn mutation_event_planners_shape_common_registry_events() {
        assert_eq!(
            plan_session_touched("session", Some("turn"))
                .reason
                .as_deref(),
            Some("turn_id=turn")
        );
        assert_eq!(
            plan_session_active_tab_set("session", "tab-1", None).tab_id,
            Some("tab-1".into())
        );
        assert_eq!(
            plan_tab_inserted("tab-1", Some("session".into()), true)
                .reason
                .as_deref(),
            Some("restored stale tab diagnostic")
        );
        assert_eq!(
            plan_playwright_injection_cleared("tab-1").kind,
            RegistryLifecycleEventKind::PlaywrightInjectionCleared
        );
        assert_eq!(
            plan_file_chooser_inserted(&handle(
                "chooser-1",
                "tab-1",
                Some("session"),
                RegistryHandleKind::FileChooser,
            ))
            .kind,
            RegistryLifecycleEventKind::FileChooserInserted
        );
        assert_eq!(
            plan_download_stale("download-1", "tab-1", Some("session".into()), "gone").reason,
            Some("gone".into())
        );
        assert_eq!(
            plan_diagnostics_cleared().kind,
            RegistryLifecycleEventKind::DiagnosticsCleared
        );
    }

    #[test]
    fn handle_state_is_a_closed_seven_state_union() {
        use super::HandleState::*;
        assert_eq!(super::HandleState::ALL.len(), 7);
        assert_eq!(Pending.as_str(), "pending");
        assert_eq!(Gone.as_str(), "gone");
        assert_eq!(
            super::live_handle_state(super::RegistryHandleKind::FileChooser, false),
            Pending
        );
        assert_eq!(
            super::live_handle_state(super::RegistryHandleKind::Download, true),
            Completed
        );
    }

    fn tab(
        tab_id: &str,
        session_id: Option<&str>,
        status: RegistryTabSnapshotStatus,
    ) -> RegistryTabSnapshot {
        RegistryTabSnapshot {
            tab_id: tab_id.into(),
            session_id: session_id.map(str::to_string),
            status,
        }
    }

    fn handle(
        handle_id: &str,
        tab_id: &str,
        owner_session_id: Option<&str>,
        kind: RegistryHandleKind,
    ) -> RegistryHandleSnapshot {
        RegistryHandleSnapshot {
            handle_id: handle_id.into(),
            tab_id: tab_id.into(),
            owner_session_id: owner_session_id.map(str::to_string),
            owner_turn_id: None,
            kind,
            state: live_handle_state(kind, false),
        }
    }
}

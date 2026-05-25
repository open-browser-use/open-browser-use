//! Per-session in-memory browser state.

use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::Hash;
use std::sync::RwLock;
use std::time::SystemTime;

use crate::error::{HostError, Result};
use crate::registry_lifecycle::{
    HandleState, RegistryHandleKind, RegistryHandleSnapshot, RegistryLifecycleEvent,
    RegistryLifecycleEventKind, RegistryLifecycleEventPlan, RegistryStaleHandlePlan,
    RegistryTabSnapshot, RegistryTabSnapshotStatus, choose_registry_active_tab_id,
    live_handle_state, plan_clear_tab_handles, plan_current_active_tab_repair,
    plan_diagnostics_cleared, plan_download_completed, plan_download_failed,
    plan_download_inserted, plan_download_removed, plan_download_stale, plan_file_chooser_consumed,
    plan_file_chooser_inserted, plan_file_chooser_stale, plan_playwright_injected,
    plan_playwright_injection_cleared, plan_reconcile_session_tabs,
    plan_session_active_tab_reconciled, plan_session_active_tab_set, plan_session_named,
    plan_session_stale, plan_session_touched, plan_tab_inserted, plan_tab_stale, plan_tab_updated,
    push_registry_lifecycle_event, registry_lifecycle_event,
};
use crate::tab_state::{TabId, TabRecord, TabStatus};

const MAX_STALE_DIAGNOSTICS_PER_KIND: usize = 128;

/// Host-visible browser-control session state.
#[derive(Debug, Clone)]
pub struct BrowserSessionRecord {
    /// Owning browser-control session.
    pub session_id: String,
    /// Current or most recently observed turn id.
    pub current_turn_id: Option<String>,
    /// Session-owned logical active tab id.
    pub active_tab_id: Option<TabId>,
    /// Human-visible session label, when set.
    pub label: Option<String>,
    /// Whether the human currently owns the session.
    pub human_takeover: bool,
    /// First time this host observed the session.
    pub created_at: SystemTime,
    /// Last time this host observed or mutated the session.
    pub updated_at: SystemTime,
    /// Last time backend tab state was reconciled into host state.
    pub last_reconciled_at: Option<SystemTime>,
    /// Stale diagnosis, when the host knows the session cannot be recovered.
    pub stale_reason: Option<String>,
}

/// Tab state that used to exist in a controlled session but was invalidated by
/// explicit cleanup or backend reconciliation.
#[derive(Debug, Clone)]
pub struct StaleTabState {
    /// Why the tab became stale.
    pub reason: String,
    /// Last known tab record.
    pub record: TabRecord,
    /// Time when the tab became stale.
    pub stale_at: SystemTime,
}

/// Compact lifecycle diagnostics for user-facing setup/status probes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegistryLifecycleCounts {
    /// Known host-visible browser-control sessions.
    pub sessions: usize,
    /// Sessions marked stale because the host cannot recover their state.
    pub stale_sessions: usize,
    /// Known tab records.
    pub tabs: usize,
    /// Known deliverable tab records preserved after finalization/reconcile.
    pub deliverable_tabs: usize,
    /// Tabs removed by cleanup or reconciliation and kept for diagnostics.
    pub stale_tabs: usize,
    /// Active file chooser handles.
    pub file_choosers: usize,
    /// Active download handles.
    pub downloads: usize,
    /// Stale file chooser tombstones.
    pub stale_file_choosers: usize,
    /// Stale download tombstones.
    pub stale_downloads: usize,
}

/// Compact stale-session diagnostic suitable for `getInfo` metadata.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StaleSessionSummary {
    /// Session id.
    pub session_id: String,
    /// Why the session was marked stale.
    pub reason: String,
}

/// Compact deliverable-tab diagnostic suitable for `getInfo` metadata.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DeliverableTabSummary {
    /// SDK-facing tab id.
    pub tab_id: String,
    /// Owning browser-control session, when known.
    pub session_id: Option<String>,
    /// Last known URL.
    pub url: String,
    /// Last known title.
    pub title: String,
}

/// File chooser handle id.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct FileChooserId(pub String);

/// File chooser state.
#[derive(Debug, Clone)]
pub struct FileChooserState {
    /// Owning tab.
    pub tab_id: TabId,
    /// Owning browser-control session, when known.
    pub owner_session_id: Option<String>,
    /// Owning turn id at acquisition (turn proof). Backfilled from the owning
    /// session's `current_turn_id` during registry insert; the CDP-event
    /// constructors do not have the turn in scope.
    pub owner_turn_id: Option<String>,
    /// Creation time for stale-handle diagnostics and future pruning.
    pub created_at: SystemTime,
    /// CDP backend node id for the input element.
    pub backend_node_id: i64,
    /// Whether multiple files are accepted.
    pub is_multiple: bool,
}

/// Download handle id.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct DownloadId(pub String);

/// Download state.
#[derive(Debug, Clone)]
pub struct DownloadState {
    /// Owning tab.
    pub tab_id: TabId,
    /// Owning browser-control session, when known.
    pub owner_session_id: Option<String>,
    /// Owning turn id at acquisition (turn proof). Backfilled from the owning
    /// session's `current_turn_id` during registry insert; the CDP-event
    /// constructors do not have the turn in scope.
    pub owner_turn_id: Option<String>,
    /// Creation time for stale-handle diagnostics and future pruning.
    pub created_at: SystemTime,
    /// Download source URL.
    pub url: String,
    /// Browser-suggested filename.
    pub suggested_filename: String,
    /// CDP Browser-domain guid.
    pub guid: String,
    /// Completed local path, when available.
    pub completed_path: Option<String>,
}

/// Diagnostic state for a handle that used to exist but was intentionally
/// invalidated.
#[derive(Debug, Clone)]
pub struct StaleHandleState {
    /// Why the handle became stale.
    pub reason: String,
    /// Owning tab when the handle was active.
    pub tab_id: TabId,
    /// Owning browser-control session, when known.
    pub owner_session_id: Option<String>,
    /// Original creation time.
    pub created_at: SystemTime,
    /// Time when the handle became stale.
    pub stale_at: SystemTime,
    /// Closed terminal state at retirement.
    pub terminal_state: HandleState,
}

/// State shared by dispatcher and backend handlers for one host session.
pub struct ServiceRegistry {
    inner: RwLock<Inner>,
}

#[derive(Default)]
struct Inner {
    tab_sessions: TabSessionStore,
    handles: HandleStore,
    downloads: DownloadStore,
    diagnostics: RegistryDiagnosticsStore,
}

#[derive(Default)]
struct TabSessionStore {
    sessions: HashMap<String, BrowserSessionRecord>,
    tabs: HashMap<TabId, TabRecord>,
    playwright_injected_tab_ids: HashSet<TabId>,
}

#[derive(Default)]
struct HandleStore {
    file_choosers_by_id: HashMap<FileChooserId, FileChooserState>,
}

#[derive(Default)]
struct DownloadStore {
    downloads_by_id: HashMap<DownloadId, DownloadState>,
}

#[derive(Default)]
struct RegistryDiagnosticsStore {
    stale_tabs_by_id: HashMap<TabId, StaleTabState>,
    stale_file_choosers_by_id: HashMap<FileChooserId, StaleHandleState>,
    stale_downloads_by_id: HashMap<DownloadId, StaleHandleState>,
    lifecycle_events: VecDeque<RegistryLifecycleEvent>,
}

impl Default for ServiceRegistry {
    fn default() -> Self {
        Self {
            inner: RwLock::new(Inner::default()),
        }
    }
}

impl ServiceRegistry {
    /// Insert or replace a tab record.
    pub fn insert(&self, record: TabRecord) -> Result<()> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let tab_id = record.id.clone();
        let session_id = record.session_id.clone();
        let restored = guard
            .diagnostics
            .stale_tabs_by_id
            .remove(&record.id)
            .is_some();
        if let Some(session_id) = record.session_id.as_deref() {
            touch_session_locked(&mut guard, session_id, None);
        }
        guard.tab_sessions.tabs.insert(record.id.clone(), record);
        record_planned_lifecycle_event_locked(
            &mut guard,
            plan_tab_inserted(&tab_id.0, session_id, restored),
        );
        Ok(())
    }

    /// Remove a tab record.
    pub fn remove(&self, id: &TabId) -> Result<Option<TabRecord>> {
        self.remove_with_reason(id, "tab was removed from host registry")
    }

    /// Remove a tab record with a diagnostic stale reason.
    pub fn remove_with_reason(
        &self,
        id: &TabId,
        reason: impl Into<String>,
    ) -> Result<Option<TabRecord>> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let reason = reason.into();
        clear_tab_handles_locked(&mut guard, id, &reason);
        let record = guard.tab_sessions.tabs.remove(id);
        if let Some(record) = record.as_ref() {
            if let Some(session_id) = record.session_id.as_deref()
                && guard
                    .tab_sessions
                    .sessions
                    .get(session_id)
                    .and_then(|session| session.active_tab_id.as_ref())
                    == Some(id)
            {
                let next_active_tab_id = choose_active_tab_locked(&guard, session_id);
                let next_active_tab_id_for_event =
                    next_active_tab_id.as_ref().map(|tab_id| tab_id.0.clone());
                if let Some(session) = guard.tab_sessions.sessions.get_mut(session_id) {
                    session.active_tab_id = next_active_tab_id;
                    session.updated_at = SystemTime::now();
                }
                record_planned_lifecycle_event_locked(
                    &mut guard,
                    plan_session_active_tab_reconciled(
                        session_id,
                        next_active_tab_id_for_event,
                        "active tab was removed from host registry",
                    ),
                );
            }
            record_stale_tab_locked(&mut guard, record.clone(), reason);
        }
        Ok(record)
    }

    /// Clear handle and cache state tied to a tab while leaving the tab record.
    pub fn clear_tab_handles(&self, id: &TabId) -> Result<()> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        clear_tab_handles_locked(
            &mut guard,
            id,
            &format!("owning tab {} was detached, closed, or finalized", id.0),
        );
        Ok(())
    }

    /// Get one tab record.
    pub fn get(&self, id: &TabId) -> Result<Option<TabRecord>> {
        Ok(self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?
            .tab_sessions
            .tabs
            .get(id)
            .cloned())
    }

    /// List tab records.
    pub fn list(&self) -> Result<Vec<TabRecord>> {
        Ok(self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?
            .tab_sessions
            .tabs
            .values()
            .cloned()
            .collect())
    }

    /// Touch or create host-visible browser-control session state.
    pub fn touch_session(&self, session_id: &str, turn_id: Option<&str>) -> Result<()> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        touch_session_locked(&mut guard, session_id, turn_id);
        record_planned_lifecycle_event_locked(
            &mut guard,
            plan_session_touched(session_id, turn_id),
        );
        Ok(())
    }

    /// Set a host-visible session label.
    pub fn name_session(&self, session_id: &str, label: Option<String>) -> Result<()> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        {
            let session = touch_session_locked(&mut guard, session_id, None);
            session.label = label.clone();
            session.updated_at = SystemTime::now();
        }
        record_planned_lifecycle_event_locked(&mut guard, plan_session_named(session_id, label));
        Ok(())
    }

    /// Mark or clear the human-takeover ownership boundary for a session.
    pub fn set_human_takeover(
        &self,
        session_id: &str,
        turn_id: Option<&str>,
        active: bool,
    ) -> Result<()> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let session = touch_session_locked(&mut guard, session_id, turn_id);
        session.human_takeover = active;
        Ok(())
    }

    /// Reject lifecycle operations that require agent ownership.
    pub fn assert_agent_owns_session(&self, session_id: &str, operation: &str) -> Result<()> {
        let guard = self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let session = guard
            .tab_sessions
            .sessions
            .get(session_id)
            .ok_or_else(|| HostError::Protocol(format!("missing session {session_id}")))?;
        if session.human_takeover {
            return Err(HostError::Protocol(format!(
                "{operation} blocked during human takeover"
            )));
        }
        Ok(())
    }

    /// Reject lifecycle operations if an existing session is under human takeover.
    pub fn reject_human_takeover_if_present(&self, session_id: &str, operation: &str) -> Result<()> {
        let guard = self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let Some(session) = guard.tab_sessions.sessions.get(session_id) else {
            return Ok(());
        };
        if session.human_takeover {
            return Err(HostError::Protocol(format!(
                "{operation} blocked during human takeover"
            )));
        }
        Ok(())
    }

    /// Set the session-owned logical active tab.
    pub fn set_active_tab(
        &self,
        session_id: &str,
        tab_id: impl Into<TabId>,
        turn_id: Option<&str>,
    ) -> Result<()> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let now = SystemTime::now();
        let tab_id = tab_id.into();
        validate_active_tab_transition_locked(&guard, session_id, &tab_id)?;
        let changed = guard
            .tab_sessions
            .sessions
            .get(session_id)
            .and_then(|session| session.active_tab_id.as_ref())
            != Some(&tab_id);
        let session = guard
            .tab_sessions
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| HostError::Protocol(format!("missing session {session_id}")))?;
        if let Some(turn_id) = turn_id {
            session.current_turn_id = Some(turn_id.to_string());
        }
        session.active_tab_id = Some(tab_id.clone());
        session.updated_at = now;
        if changed {
            record_planned_lifecycle_event_locked(
                &mut guard,
                plan_session_active_tab_set(session_id, &tab_id.0, turn_id),
            );
        }
        Ok(())
    }

    /// Validate that a tab can become or remain the session-owned logical active tab.
    pub fn validate_active_session_tab(&self, session_id: &str, tab_id: &TabId) -> Result<()> {
        let guard = self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        validate_active_tab_transition_locked(&guard, session_id, tab_id)
    }

    /// Return the session-owned logical active tab when it is still valid.
    pub fn current_tab_for_session(&self, session_id: &str) -> Result<Option<TabRecord>> {
        let guard = self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let current_active_tab_id = guard
            .tab_sessions
            .sessions
            .get(session_id)
            .and_then(|session| session.active_tab_id.as_ref())
            .map(|tab_id| tab_id.0.clone());
        let snapshots = tab_snapshots_locked(&guard);
        let plan = plan_current_active_tab_repair(
            session_id,
            current_active_tab_id.as_deref(),
            &snapshots,
        );
        let Some(next_active_tab_id) = plan.next_active_tab_id else {
            return Ok(None);
        };
        Ok(guard
            .tab_sessions
            .tabs
            .get(&TabId::new(next_active_tab_id))
            .cloned())
    }

    /// Explicitly repair and return the session-owned logical active tab.
    pub fn repair_current_tab_for_session(&self, session_id: &str) -> Result<Option<TabRecord>> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let current_active_tab_id = guard
            .tab_sessions
            .sessions
            .get(session_id)
            .and_then(|session| session.active_tab_id.as_ref())
            .map(|tab_id| tab_id.0.clone());
        let snapshots = tab_snapshots_locked(&guard);
        let plan = plan_current_active_tab_repair(
            session_id,
            current_active_tab_id.as_deref(),
            &snapshots,
        );
        let mut reconciled = false;
        if let Some(session) = guard.tab_sessions.sessions.get_mut(session_id)
            && plan.changed
        {
            session.active_tab_id = plan.next_active_tab_id.clone().map(TabId::new);
            session.updated_at = SystemTime::now();
            reconciled = true;
        }
        if reconciled {
            record_planned_lifecycle_event_locked(
                &mut guard,
                plan_session_active_tab_reconciled(
                    session_id,
                    plan.next_active_tab_id.clone(),
                    "current active tab was missing or not commandable",
                ),
            );
        }
        let Some(next_active_tab_id) = plan.next_active_tab_id else {
            return Ok(None);
        };
        Ok(guard
            .tab_sessions
            .tabs
            .get(&TabId::new(next_active_tab_id))
            .cloned())
    }

    /// Mark a session as stale for diagnostics.
    pub fn mark_session_stale(&self, session_id: &str, reason: impl Into<String>) -> Result<()> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let reason = reason.into();
        {
            let session = touch_session_locked(&mut guard, session_id, None);
            session.stale_reason = Some(reason.clone());
            session.updated_at = SystemTime::now();
        }
        record_planned_lifecycle_event_locked(&mut guard, plan_session_stale(session_id, reason));
        Ok(())
    }

    /// Get one host-visible session record.
    pub fn get_session(&self, session_id: &str) -> Result<Option<BrowserSessionRecord>> {
        Ok(self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?
            .tab_sessions
            .sessions
            .get(session_id)
            .cloned())
    }

    /// List host-visible session records.
    pub fn list_sessions(&self) -> Result<Vec<BrowserSessionRecord>> {
        Ok(self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?
            .tab_sessions
            .sessions
            .values()
            .cloned()
            .collect())
    }

    /// List tab records owned by a session.
    pub fn tabs_for_session(&self, session_id: &str) -> Result<Vec<TabRecord>> {
        Ok(self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?
            .tab_sessions
            .tabs
            .values()
            .filter(|record| record.session_id.as_deref() == Some(session_id))
            .cloned()
            .collect())
    }

    /// Reconcile active controlled tabs for a session against backend-observed
    /// tab ids. Deliverable tabs are intentionally preserved because they have
    /// left the active controlled session but remain useful durable state.
    pub fn reconcile_session_tabs(
        &self,
        session_id: &str,
        observed_tab_ids: &HashSet<TabId>,
        reason: impl Into<String>,
    ) -> Result<Vec<TabRecord>> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let session = touch_session_locked(&mut guard, session_id, None);
        let now = SystemTime::now();
        let current_active_tab_id = session
            .active_tab_id
            .as_ref()
            .map(|tab_id| tab_id.0.clone());
        session.last_reconciled_at = Some(now);
        session.updated_at = now;
        let reason = reason.into();
        let observed_tab_ids = observed_tab_ids
            .iter()
            .map(|tab_id| tab_id.0.clone())
            .collect::<HashSet<_>>();
        let snapshots = tab_snapshots_locked(&guard);
        let plan = plan_reconcile_session_tabs(
            session_id,
            &observed_tab_ids,
            current_active_tab_id.as_deref(),
            &snapshots,
        );
        let stale = plan
            .stale_tab_ids
            .iter()
            .filter_map(|id| {
                let tab_id = TabId::new(id.clone());
                guard
                    .tab_sessions
                    .tabs
                    .get(&tab_id)
                    .cloned()
                    .map(|record| (tab_id, record))
            })
            .collect::<Vec<_>>();
        for (id, record) in &stale {
            clear_tab_handles_locked(&mut guard, id, &reason);
            guard.tab_sessions.tabs.remove(id);
            record_stale_tab_locked(&mut guard, record.clone(), reason.clone());
        }
        if let Some(session) = guard.tab_sessions.sessions.get_mut(session_id) {
            session.active_tab_id = plan.next_active_tab_id.clone().map(TabId::new);
            session.updated_at = SystemTime::now();
        }
        if plan.active_tab_changed {
            record_planned_lifecycle_event_locked(
                &mut guard,
                plan_session_active_tab_reconciled(
                    session_id,
                    plan.next_active_tab_id.clone(),
                    "session tab reconciliation updated active tab",
                ),
            );
        }
        Ok(stale.into_iter().map(|(_, record)| record).collect())
    }

    /// Explain why a tab record is unavailable.
    pub fn describe_missing_tab(&self, id: &TabId) -> Result<String> {
        let guard = self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        Ok(guard
            .diagnostics
            .stale_tabs_by_id
            .get(id)
            .map(|state| describe_stale_tab(&id.0, state))
            .unwrap_or_else(|| format!("missing tab {}", id.0)))
    }

    /// Return compact lifecycle counts for diagnostics.
    pub fn lifecycle_counts(&self) -> Result<RegistryLifecycleCounts> {
        let guard = self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        Ok(lifecycle_counts_locked(&guard))
    }

    /// Clear stale diagnostic tombstones after a user-facing repair acknowledges them.
    pub fn clear_stale_diagnostics(&self) -> Result<RegistryLifecycleCounts> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let before = lifecycle_counts_locked(&guard);
        let now = SystemTime::now();
        for session in guard.tab_sessions.sessions.values_mut() {
            if session.stale_reason.take().is_some() {
                session.updated_at = now;
            }
        }
        guard.diagnostics.stale_tabs_by_id.clear();
        guard.diagnostics.stale_file_choosers_by_id.clear();
        guard.diagnostics.stale_downloads_by_id.clear();
        record_planned_lifecycle_event_locked(&mut guard, plan_diagnostics_cleared());
        Ok(before)
    }

    /// Return recent registry lifecycle events for diagnostics.
    pub fn recent_lifecycle_events(&self, limit: usize) -> Result<Vec<RegistryLifecycleEvent>> {
        let guard = self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let len = guard.diagnostics.lifecycle_events.len();
        let start = len.saturating_sub(limit);
        Ok(guard
            .diagnostics
            .lifecycle_events
            .iter()
            .skip(start)
            .cloned()
            .collect())
    }

    /// Return compact stale-session summaries for diagnostics.
    pub fn stale_session_summaries(&self, limit: usize) -> Result<Vec<StaleSessionSummary>> {
        let guard = self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let mut rows = guard
            .tab_sessions
            .sessions
            .values()
            .filter_map(|session| {
                session
                    .stale_reason
                    .as_ref()
                    .map(|reason| StaleSessionSummary {
                        session_id: session.session_id.clone(),
                        reason: reason.clone(),
                    })
            })
            .collect::<Vec<_>>();
        rows.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        rows.truncate(limit);
        Ok(rows)
    }

    /// Return compact deliverable-tab summaries for diagnostics.
    pub fn deliverable_tab_summaries(&self, limit: usize) -> Result<Vec<DeliverableTabSummary>> {
        let guard = self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let mut rows = guard
            .tab_sessions
            .tabs
            .values()
            .filter(|record| record.status == TabStatus::Deliverable)
            .map(|record| DeliverableTabSummary {
                tab_id: record.id.0.clone(),
                session_id: record.session_id.clone(),
                url: record.url.clone(),
                title: record.title.clone(),
            })
            .collect::<Vec<_>>();
        rows.sort_by(|left, right| left.tab_id.cmp(&right.tab_id));
        rows.truncate(limit);
        Ok(rows)
    }

    /// Update a tab record.
    pub fn update<F: FnOnce(&mut TabRecord)>(&self, id: &TabId, f: F) -> Result<bool> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        if let Some(record) = guard.tab_sessions.tabs.get_mut(id) {
            f(record);
            let session_id = record.session_id.clone();
            let tab_id = record.id.clone();
            record_planned_lifecycle_event_locked(
                &mut guard,
                plan_tab_updated(&tab_id.0, session_id),
            );
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Mark Playwright InjectedScript as mounted in a tab.
    pub fn mark_playwright_injected(&self, id: &TabId) -> Result<()> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        guard
            .tab_sessions
            .playwright_injected_tab_ids
            .insert(id.clone());
        record_planned_lifecycle_event_locked(&mut guard, plan_playwright_injected(&id.0));
        Ok(())
    }

    /// Check whether Playwright InjectedScript is mounted in a tab.
    pub fn is_playwright_injected(&self, id: &TabId) -> Result<bool> {
        Ok(self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?
            .tab_sessions
            .playwright_injected_tab_ids
            .contains(id))
    }

    /// Clear Playwright InjectedScript mounted state for a tab.
    pub fn clear_playwright_injected(&self, id: &TabId) -> Result<()> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        if guard.tab_sessions.playwright_injected_tab_ids.remove(id) {
            record_planned_lifecycle_event_locked(
                &mut guard,
                plan_playwright_injection_cleared(&id.0),
            );
        }
        Ok(())
    }

    /// Insert a file chooser handle.
    pub fn insert_file_chooser(&self, id: FileChooserId, state: FileChooserState) -> Result<()> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let mut state = state;
        state.owner_turn_id = state
            .owner_session_id
            .as_deref()
            .and_then(|sid| guard.tab_sessions.sessions.get(sid))
            .and_then(|session| session.current_turn_id.clone());
        guard.diagnostics.stale_file_choosers_by_id.remove(&id);
        record_planned_lifecycle_event_locked(
            &mut guard,
            plan_file_chooser_inserted(&file_chooser_handle_snapshot(&id, &state)),
        );
        guard.handles.file_choosers_by_id.insert(id, state);
        Ok(())
    }

    /// Consume a file chooser handle.
    pub fn take_file_chooser(&self, id: &FileChooserId) -> Result<Option<FileChooserState>> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let state = guard.handles.file_choosers_by_id.remove(id);
        if let Some(state) = state.as_ref() {
            let plan = plan_file_chooser_consumed(&file_chooser_handle_snapshot(id, state));
            record_stale_file_chooser_locked(
                &mut guard,
                id.clone(),
                state,
                plan.stale_handle.reason,
                plan.stale_handle.terminal_state,
            );
            record_planned_lifecycle_event_locked(&mut guard, plan.event);
        }
        Ok(state)
    }

    /// Get a file chooser handle without consuming it.
    pub fn get_file_chooser(&self, id: &FileChooserId) -> Result<Option<FileChooserState>> {
        Ok(self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?
            .handles
            .file_choosers_by_id
            .get(id)
            .cloned())
    }

    /// Explain why a file chooser handle is unavailable.
    pub fn describe_missing_file_chooser(&self, id: &FileChooserId) -> Result<String> {
        let guard = self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        Ok(guard
            .diagnostics
            .stale_file_choosers_by_id
            .get(id)
            .map(|state| describe_stale_handle("file chooser", &id.0, state))
            .unwrap_or_else(|| format!("missing file chooser handle {}", id.0)))
    }

    /// Insert a download handle.
    pub fn insert_download(&self, id: DownloadId, state: DownloadState) -> Result<()> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let mut state = state;
        state.owner_turn_id = state
            .owner_session_id
            .as_deref()
            .and_then(|sid| guard.tab_sessions.sessions.get(sid))
            .and_then(|session| session.current_turn_id.clone());
        guard.diagnostics.stale_downloads_by_id.remove(&id);
        record_planned_lifecycle_event_locked(
            &mut guard,
            plan_download_inserted(&download_handle_snapshot(&id, &state)),
        );
        guard.downloads.downloads_by_id.insert(id, state);
        Ok(())
    }

    /// Get a download handle.
    pub fn get_download(&self, id: &DownloadId) -> Result<Option<DownloadState>> {
        Ok(self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?
            .downloads
            .downloads_by_id
            .get(id)
            .cloned())
    }

    /// Explain why a download handle is unavailable.
    pub fn describe_missing_download(&self, id: &DownloadId) -> Result<String> {
        let guard = self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        Ok(guard
            .diagnostics
            .stale_downloads_by_id
            .get(id)
            .map(|state| describe_stale_handle("download", &id.0, state))
            .unwrap_or_else(|| format!("missing download handle {}", id.0)))
    }

    /// Mark a download complete.
    pub fn mark_download_completed(&self, id: &DownloadId, path: Option<String>) -> Result<()> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let snapshot = if let Some(state) = guard.downloads.downloads_by_id.get_mut(id) {
            state.completed_path = path;
            Some(download_handle_snapshot(id, state))
        } else {
            None
        };
        if let Some(snapshot) = snapshot {
            record_planned_lifecycle_event_locked(
                &mut guard,
                plan_download_completed(&snapshot).event,
            );
        }
        Ok(())
    }

    /// Remove a download handle.
    pub fn remove_download(&self, id: &DownloadId) -> Result<Option<DownloadState>> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let state = guard.downloads.downloads_by_id.remove(id);
        if let Some(state) = state.as_ref() {
            let plan = plan_download_removed(&download_handle_snapshot(id, state));
            record_planned_lifecycle_event_locked(&mut guard, plan.event);
            record_stale_download_locked(
                &mut guard,
                id.clone(),
                state,
                plan.stale_handle.reason,
                plan.stale_handle.terminal_state,
            );
        }
        Ok(state)
    }

    /// Mark a download as failed and preserve its terminal diagnostic.
    pub fn mark_download_failed(
        &self,
        id: &DownloadId,
        state: &DownloadState,
        reason: impl Into<String>,
    ) -> Result<()> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        guard.downloads.downloads_by_id.remove(id);
        let plan = plan_download_failed(&download_handle_snapshot(id, state), reason);
        record_stale_download_locked(
            &mut guard,
            id.clone(),
            state,
            plan.stale_handle.reason,
            plan.stale_handle.terminal_state,
        );
        record_planned_lifecycle_event_locked(&mut guard, plan.event);
        Ok(())
    }
}

fn record_lifecycle_event_locked(
    inner: &mut Inner,
    kind: RegistryLifecycleEventKind,
    subject_id: String,
    session_id: Option<String>,
    tab_id: Option<String>,
    reason: Option<String>,
) {
    let event = registry_lifecycle_event(
        kind,
        subject_id,
        session_id,
        tab_id,
        reason,
        SystemTime::now(),
    );
    push_registry_lifecycle_event(&mut inner.diagnostics.lifecycle_events, event);
}

fn record_planned_lifecycle_event_locked(inner: &mut Inner, event: RegistryLifecycleEventPlan) {
    record_lifecycle_event_locked(
        inner,
        event.kind,
        event.subject_id,
        event.session_id,
        event.tab_id,
        event.reason,
    );
}

fn clear_tab_handles_locked(inner: &mut Inner, id: &TabId, stale_reason: &str) {
    let plan = plan_clear_tab_handles(
        &id.0,
        inner.tab_sessions.playwright_injected_tab_ids.contains(id),
        &handle_snapshots_locked(inner),
        stale_reason,
    );
    if plan.clear_playwright_injected {
        inner.tab_sessions.playwright_injected_tab_ids.remove(id);
    }
    for stale_handle in plan.stale_handles {
        remove_and_record_stale_handle_plan_locked(inner, &stale_handle);
    }
    if let Some(event) = plan.event {
        record_planned_lifecycle_event_locked(inner, event);
    }
}

fn lifecycle_counts_locked(inner: &Inner) -> RegistryLifecycleCounts {
    RegistryLifecycleCounts {
        sessions: inner.tab_sessions.sessions.len(),
        stale_sessions: inner
            .tab_sessions
            .sessions
            .values()
            .filter(|session| session.stale_reason.is_some())
            .count(),
        tabs: inner.tab_sessions.tabs.len(),
        deliverable_tabs: inner
            .tab_sessions
            .tabs
            .values()
            .filter(|record| record.status == TabStatus::Deliverable)
            .count(),
        stale_tabs: inner.diagnostics.stale_tabs_by_id.len(),
        file_choosers: inner.handles.file_choosers_by_id.len(),
        downloads: inner.downloads.downloads_by_id.len(),
        stale_file_choosers: inner.diagnostics.stale_file_choosers_by_id.len(),
        stale_downloads: inner.diagnostics.stale_downloads_by_id.len(),
    }
}

fn choose_active_tab_locked(inner: &Inner, session_id: &str) -> Option<TabId> {
    choose_registry_active_tab_id(session_id, &tab_snapshots_locked(inner)).map(TabId::new)
}

fn tab_snapshots_locked(inner: &Inner) -> Vec<RegistryTabSnapshot> {
    inner
        .tab_sessions
        .tabs
        .values()
        .map(|record| RegistryTabSnapshot {
            tab_id: record.id.0.clone(),
            session_id: record.session_id.clone(),
            status: tab_snapshot_status(&record.status),
        })
        .collect()
}

fn handle_snapshots_locked(inner: &Inner) -> Vec<RegistryHandleSnapshot> {
    inner
        .handles
        .file_choosers_by_id
        .iter()
        .map(|(id, state)| file_chooser_handle_snapshot(id, state))
        .chain(
            inner
                .downloads
                .downloads_by_id
                .iter()
                .map(|(id, state)| download_handle_snapshot(id, state)),
        )
        .chain(
            inner
                .diagnostics
                .stale_file_choosers_by_id
                .iter()
                .map(|(id, s)| {
                    stale_handle_snapshot(id.0.clone(), RegistryHandleKind::FileChooser, s)
                }),
        )
        .chain(
            inner
                .diagnostics
                .stale_downloads_by_id
                .iter()
                .map(|(id, s)| {
                    stale_handle_snapshot(id.0.clone(), RegistryHandleKind::Download, s)
                }),
        )
        .collect()
}

fn stale_handle_snapshot(
    handle_id: String,
    kind: RegistryHandleKind,
    state: &StaleHandleState,
) -> RegistryHandleSnapshot {
    RegistryHandleSnapshot {
        handle_id,
        tab_id: state.tab_id.0.clone(),
        owner_session_id: state.owner_session_id.clone(),
        owner_turn_id: None,
        kind,
        state: state.terminal_state,
    }
}

fn file_chooser_handle_snapshot(
    id: &FileChooserId,
    state: &FileChooserState,
) -> RegistryHandleSnapshot {
    RegistryHandleSnapshot {
        handle_id: id.0.clone(),
        tab_id: state.tab_id.0.clone(),
        owner_session_id: state.owner_session_id.clone(),
        owner_turn_id: state.owner_turn_id.clone(),
        kind: RegistryHandleKind::FileChooser,
        state: live_handle_state(RegistryHandleKind::FileChooser, false),
    }
}

fn download_handle_snapshot(id: &DownloadId, state: &DownloadState) -> RegistryHandleSnapshot {
    RegistryHandleSnapshot {
        handle_id: id.0.clone(),
        tab_id: state.tab_id.0.clone(),
        owner_session_id: state.owner_session_id.clone(),
        owner_turn_id: state.owner_turn_id.clone(),
        kind: RegistryHandleKind::Download,
        state: live_handle_state(RegistryHandleKind::Download, state.completed_path.is_some()),
    }
}

fn remove_and_record_stale_handle_plan_locked(inner: &mut Inner, plan: &RegistryStaleHandlePlan) {
    match plan.kind {
        RegistryHandleKind::FileChooser => {
            let id = FileChooserId(plan.handle_id.clone());
            if let Some(state) = inner.handles.file_choosers_by_id.remove(&id) {
                record_stale_file_chooser_locked(
                    inner,
                    id,
                    &state,
                    plan.reason.clone(),
                    plan.terminal_state,
                );
            }
        }
        RegistryHandleKind::Download => {
            let id = DownloadId(plan.handle_id.clone());
            if let Some(state) = inner.downloads.downloads_by_id.remove(&id) {
                record_stale_download_locked(
                    inner,
                    id,
                    &state,
                    plan.reason.clone(),
                    plan.terminal_state,
                );
            }
        }
    }
}

fn tab_snapshot_status(status: &TabStatus) -> RegistryTabSnapshotStatus {
    match status {
        TabStatus::Active => RegistryTabSnapshotStatus::Active,
        TabStatus::Handoff => RegistryTabSnapshotStatus::Handoff,
        TabStatus::Deliverable => RegistryTabSnapshotStatus::Deliverable,
    }
}

fn touch_session_locked<'a>(
    inner: &'a mut Inner,
    session_id: &str,
    turn_id: Option<&str>,
) -> &'a mut BrowserSessionRecord {
    let now = SystemTime::now();
    let session = inner
        .tab_sessions
        .sessions
        .entry(session_id.to_string())
        .or_insert_with(|| BrowserSessionRecord {
            session_id: session_id.to_string(),
            current_turn_id: None,
            active_tab_id: None,
            label: None,
            human_takeover: false,
            created_at: now,
            updated_at: now,
            last_reconciled_at: None,
            stale_reason: None,
        });
    if let Some(turn_id) = turn_id {
        session.current_turn_id = Some(turn_id.to_string());
    }
    session.updated_at = now;
    session
}

fn validate_active_tab_transition_locked(
    inner: &Inner,
    session_id: &str,
    tab_id: &TabId,
) -> Result<()> {
    if !inner.tab_sessions.sessions.contains_key(session_id) {
        return Err(HostError::Protocol(format!("missing session {session_id}")));
    }
    let Some(record) = inner.tab_sessions.tabs.get(tab_id) else {
        return Err(HostError::Protocol(format!("missing tab {}", tab_id.0)));
    };
    if record.session_id.as_deref() != Some(session_id) {
        return Err(HostError::Protocol(format!(
            "tab {} does not belong to session {session_id}",
            tab_id.0
        )));
    }
    if record.status != TabStatus::Active {
        return Err(HostError::Protocol(format!(
            "tab {} is {}, not actively controlled",
            tab_id.0,
            tab_status_label(&record.status)
        )));
    }
    Ok(())
}

fn tab_status_label(status: &TabStatus) -> &'static str {
    match status {
        TabStatus::Active => "active",
        TabStatus::Handoff => "handoff",
        TabStatus::Deliverable => "deliverable",
    }
}

fn record_stale_tab_locked(inner: &mut Inner, record: TabRecord, reason: String) {
    let tab_id = record.id.clone();
    let session_id = record.session_id.clone();
    inner.diagnostics.stale_tabs_by_id.insert(
        record.id.clone(),
        StaleTabState {
            reason: reason.clone(),
            record,
            stale_at: SystemTime::now(),
        },
    );
    prune_stale_map_locked(&mut inner.diagnostics.stale_tabs_by_id, |state| {
        state.stale_at
    });
    record_planned_lifecycle_event_locked(inner, plan_tab_stale(&tab_id.0, session_id, reason));
}

fn record_stale_file_chooser_locked(
    inner: &mut Inner,
    id: FileChooserId,
    state: &FileChooserState,
    reason: String,
    terminal_state: HandleState,
) {
    let session_id = state.owner_session_id.clone();
    let tab_id = state.tab_id.clone();
    inner.diagnostics.stale_file_choosers_by_id.insert(
        id.clone(),
        StaleHandleState {
            reason: reason.clone(),
            tab_id: state.tab_id.clone(),
            owner_session_id: state.owner_session_id.clone(),
            created_at: state.created_at,
            stale_at: SystemTime::now(),
            terminal_state,
        },
    );
    prune_stale_map_locked(&mut inner.diagnostics.stale_file_choosers_by_id, |state| {
        state.stale_at
    });
    record_planned_lifecycle_event_locked(
        inner,
        plan_file_chooser_stale(&id.0, &tab_id.0, session_id, reason),
    );
}

fn record_stale_download_locked(
    inner: &mut Inner,
    id: DownloadId,
    state: &DownloadState,
    reason: String,
    terminal_state: HandleState,
) {
    let session_id = state.owner_session_id.clone();
    let tab_id = state.tab_id.clone();
    inner.diagnostics.stale_downloads_by_id.insert(
        id.clone(),
        StaleHandleState {
            reason: reason.clone(),
            tab_id: state.tab_id.clone(),
            owner_session_id: state.owner_session_id.clone(),
            created_at: state.created_at,
            stale_at: SystemTime::now(),
            terminal_state,
        },
    );
    prune_stale_map_locked(&mut inner.diagnostics.stale_downloads_by_id, |state| {
        state.stale_at
    });
    record_planned_lifecycle_event_locked(
        inner,
        plan_download_stale(&id.0, &tab_id.0, session_id, reason),
    );
}

fn prune_stale_map_locked<K, V>(map: &mut HashMap<K, V>, stale_at: impl Fn(&V) -> SystemTime)
where
    K: Clone + Eq + Hash,
{
    while map.len() > MAX_STALE_DIAGNOSTICS_PER_KIND {
        let Some(oldest_key) = map
            .iter()
            .min_by_key(|(_, state)| stale_at(state))
            .map(|(key, _)| key.clone())
        else {
            return;
        };
        map.remove(&oldest_key);
    }
}

fn describe_stale_handle(kind: &str, id: &str, state: &StaleHandleState) -> String {
    let mut message = format!(
        "stale {kind} handle {id}: {}; owner_tab={}",
        state.reason, state.tab_id.0
    );
    if let Some(session_id) = state.owner_session_id.as_deref() {
        message.push_str(&format!("; owner_session={session_id}"));
    }
    if let Ok(age) = state.stale_at.duration_since(state.created_at) {
        message.push_str(&format!("; age_ms={}", age.as_millis()));
    }
    message
}

fn describe_stale_tab(id: &str, state: &StaleTabState) -> String {
    let mut message = format!("stale tab {id}: {}", state.reason);
    if let Some(session_id) = state.record.session_id.as_deref() {
        message.push_str(&format!("; owner_session={session_id}"));
    }
    message.push_str(&format!(
        "; origin={:?}; status={:?}",
        state.record.origin, state.record.status
    ));
    message
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tab_state::{TabOrigin, TabStatus};

    #[test]
    fn stale_tab_diagnostics_are_bounded() {
        let registry = ServiceRegistry::default();

        for index in 0..(MAX_STALE_DIAGNOSTICS_PER_KIND + 5) {
            let tab_id = TabId::new(format!("tab-{index}"));
            registry.insert(tab_record(tab_id.clone())).unwrap();
            registry
                .remove_with_reason(&tab_id, "test cleanup")
                .unwrap();
        }

        let counts = registry.lifecycle_counts().unwrap();
        assert_eq!(counts.stale_tabs, MAX_STALE_DIAGNOSTICS_PER_KIND);
    }

    #[test]
    fn stale_handle_diagnostics_are_bounded() {
        let registry = ServiceRegistry::default();
        let tab_id = TabId::new("tab-1");

        for index in 0..(MAX_STALE_DIAGNOSTICS_PER_KIND + 5) {
            let id = FileChooserId(format!("chooser-{index}"));
            registry
                .insert_file_chooser(
                    id.clone(),
                    FileChooserState {
                        tab_id: tab_id.clone(),
                        owner_session_id: None,
                        owner_turn_id: None,
                        created_at: SystemTime::now(),
                        backend_node_id: index as i64,
                        is_multiple: false,
                    },
                )
                .unwrap();
            assert!(registry.take_file_chooser(&id).unwrap().is_some());
        }

        let counts = registry.lifecycle_counts().unwrap();
        assert_eq!(counts.stale_file_choosers, MAX_STALE_DIAGNOSTICS_PER_KIND);
    }

    fn tab_record(id: TabId) -> TabRecord {
        TabRecord {
            id,
            session_id: Some("session".to_string()),
            target_id: "target".to_string(),
            url: "https://example.test/".to_string(),
            title: "Example".to_string(),
            origin: TabOrigin::Agent,
            status: TabStatus::Active,
            attached: false,
            cdp_session_id: None,
        }
    }
}

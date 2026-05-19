//! Per-session in-memory browser state.

use std::collections::{HashMap, HashSet};
use std::hash::Hash;
use std::sync::RwLock;
use std::time::SystemTime;

use crate::error::{HostError, Result};
use crate::tab_state::{TabId, TabRecord, TabStatus};

const MAX_STALE_DIAGNOSTICS_PER_KIND: usize = 128;

/// Host-visible browser-control session state.
#[derive(Debug, Clone)]
pub struct BrowserSessionRecord {
    /// Owning browser-control session.
    pub session_id: String,
    /// Current or most recently observed turn id.
    pub current_turn_id: Option<String>,
    /// Human-visible session label, when set.
    pub label: Option<String>,
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
}

/// State shared by dispatcher and backend handlers for one host session.
pub struct ServiceRegistry {
    inner: RwLock<Inner>,
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, BrowserSessionRecord>,
    tabs: HashMap<TabId, TabRecord>,
    playwright_injected_tab_ids: HashSet<TabId>,
    file_choosers_by_id: HashMap<FileChooserId, FileChooserState>,
    downloads_by_id: HashMap<DownloadId, DownloadState>,
    stale_tabs_by_id: HashMap<TabId, StaleTabState>,
    stale_file_choosers_by_id: HashMap<FileChooserId, StaleHandleState>,
    stale_downloads_by_id: HashMap<DownloadId, StaleHandleState>,
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
        if let Some(session_id) = record.session_id.as_deref() {
            touch_session_locked(&mut guard, session_id, None);
        }
        guard.stale_tabs_by_id.remove(&record.id);
        guard.tabs.insert(record.id.clone(), record);
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
        let record = guard.tabs.remove(id);
        if let Some(record) = record.as_ref() {
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
        Ok(())
    }

    /// Set a host-visible session label.
    pub fn name_session(&self, session_id: &str, label: Option<String>) -> Result<()> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let session = touch_session_locked(&mut guard, session_id, None);
        session.label = label;
        session.updated_at = SystemTime::now();
        Ok(())
    }

    /// Mark a session as stale for diagnostics.
    pub fn mark_session_stale(&self, session_id: &str, reason: impl Into<String>) -> Result<()> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let session = touch_session_locked(&mut guard, session_id, None);
        session.stale_reason = Some(reason.into());
        session.updated_at = SystemTime::now();
        Ok(())
    }

    /// Get one host-visible session record.
    pub fn get_session(&self, session_id: &str) -> Result<Option<BrowserSessionRecord>> {
        Ok(self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?
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
        session.last_reconciled_at = Some(now);
        session.updated_at = now;
        let reason = reason.into();
        let stale = guard
            .tabs
            .iter()
            .filter(|(id, record)| {
                record.session_id.as_deref() == Some(session_id)
                    && record.status != TabStatus::Deliverable
                    && !observed_tab_ids.contains(*id)
            })
            .map(|(id, record)| (id.clone(), record.clone()))
            .collect::<Vec<_>>();
        for (id, record) in &stale {
            clear_tab_handles_locked(&mut guard, id, &reason);
            guard.tabs.remove(id);
            record_stale_tab_locked(&mut guard, record.clone(), reason.clone());
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
        for session in guard.sessions.values_mut() {
            if session.stale_reason.take().is_some() {
                session.updated_at = now;
            }
        }
        guard.stale_tabs_by_id.clear();
        guard.stale_file_choosers_by_id.clear();
        guard.stale_downloads_by_id.clear();
        Ok(before)
    }

    /// Return compact stale-session summaries for diagnostics.
    pub fn stale_session_summaries(&self, limit: usize) -> Result<Vec<StaleSessionSummary>> {
        let guard = self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let mut rows = guard
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
        if let Some(record) = guard.tabs.get_mut(id) {
            f(record);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Mark Playwright InjectedScript as mounted in a tab.
    pub fn mark_playwright_injected(&self, id: &TabId) -> Result<()> {
        self.inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?
            .playwright_injected_tab_ids
            .insert(id.clone());
        Ok(())
    }

    /// Check whether Playwright InjectedScript is mounted in a tab.
    pub fn is_playwright_injected(&self, id: &TabId) -> Result<bool> {
        Ok(self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?
            .playwright_injected_tab_ids
            .contains(id))
    }

    /// Clear Playwright InjectedScript mounted state for a tab.
    pub fn clear_playwright_injected(&self, id: &TabId) -> Result<()> {
        self.inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?
            .playwright_injected_tab_ids
            .remove(id);
        Ok(())
    }

    /// Insert a file chooser handle.
    pub fn insert_file_chooser(&self, id: FileChooserId, state: FileChooserState) -> Result<()> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        guard.stale_file_choosers_by_id.remove(&id);
        guard.file_choosers_by_id.insert(id, state);
        Ok(())
    }

    /// Consume a file chooser handle.
    pub fn take_file_chooser(&self, id: &FileChooserId) -> Result<Option<FileChooserState>> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let state = guard.file_choosers_by_id.remove(id);
        if let Some(state) = state.as_ref() {
            record_stale_file_chooser_locked(
                &mut guard,
                id.clone(),
                state,
                "already consumed by setFiles".into(),
            );
        }
        Ok(state)
    }

    /// Get a file chooser handle without consuming it.
    pub fn get_file_chooser(&self, id: &FileChooserId) -> Result<Option<FileChooserState>> {
        Ok(self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?
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
        guard.stale_downloads_by_id.remove(&id);
        guard.downloads_by_id.insert(id, state);
        Ok(())
    }

    /// Get a download handle.
    pub fn get_download(&self, id: &DownloadId) -> Result<Option<DownloadState>> {
        Ok(self
            .inner
            .read()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?
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
            .stale_downloads_by_id
            .get(id)
            .map(|state| describe_stale_handle("download", &id.0, state))
            .unwrap_or_else(|| format!("missing download handle {}", id.0)))
    }

    /// Mark a download complete.
    pub fn mark_download_completed(&self, id: &DownloadId, path: Option<String>) -> Result<()> {
        if let Some(state) = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?
            .downloads_by_id
            .get_mut(id)
        {
            state.completed_path = path;
        }
        Ok(())
    }

    /// Remove a download handle.
    pub fn remove_download(&self, id: &DownloadId) -> Result<Option<DownloadState>> {
        let mut guard = self
            .inner
            .write()
            .map_err(|_| HostError::Protocol("registry poisoned".into()))?;
        let state = guard.downloads_by_id.remove(id);
        if let Some(state) = state.as_ref() {
            record_stale_download_locked(
                &mut guard,
                id.clone(),
                state,
                "removed explicitly".into(),
            );
        }
        Ok(state)
    }
}

fn clear_tab_handles_locked(inner: &mut Inner, id: &TabId, stale_reason: &str) {
    inner.playwright_injected_tab_ids.remove(id);
    let file_chooser_ids = inner
        .file_choosers_by_id
        .iter()
        .filter(|(_, state)| &state.tab_id == id)
        .map(|(handle_id, state)| (handle_id.clone(), state.clone()))
        .collect::<Vec<_>>();
    for (handle_id, state) in file_chooser_ids {
        inner.file_choosers_by_id.remove(&handle_id);
        record_stale_file_chooser_locked(inner, handle_id, &state, stale_reason.to_string());
    }

    let download_ids = inner
        .downloads_by_id
        .iter()
        .filter(|(_, state)| &state.tab_id == id)
        .map(|(handle_id, state)| (handle_id.clone(), state.clone()))
        .collect::<Vec<_>>();
    for (handle_id, state) in download_ids {
        inner.downloads_by_id.remove(&handle_id);
        record_stale_download_locked(inner, handle_id, &state, stale_reason.to_string());
    }
}

fn lifecycle_counts_locked(inner: &Inner) -> RegistryLifecycleCounts {
    RegistryLifecycleCounts {
        sessions: inner.sessions.len(),
        stale_sessions: inner
            .sessions
            .values()
            .filter(|session| session.stale_reason.is_some())
            .count(),
        tabs: inner.tabs.len(),
        deliverable_tabs: inner
            .tabs
            .values()
            .filter(|record| record.status == TabStatus::Deliverable)
            .count(),
        stale_tabs: inner.stale_tabs_by_id.len(),
        file_choosers: inner.file_choosers_by_id.len(),
        downloads: inner.downloads_by_id.len(),
        stale_file_choosers: inner.stale_file_choosers_by_id.len(),
        stale_downloads: inner.stale_downloads_by_id.len(),
    }
}

fn touch_session_locked<'a>(
    inner: &'a mut Inner,
    session_id: &str,
    turn_id: Option<&str>,
) -> &'a mut BrowserSessionRecord {
    let now = SystemTime::now();
    let session = inner
        .sessions
        .entry(session_id.to_string())
        .or_insert_with(|| BrowserSessionRecord {
            session_id: session_id.to_string(),
            current_turn_id: None,
            label: None,
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

fn record_stale_tab_locked(inner: &mut Inner, record: TabRecord, reason: String) {
    inner.stale_tabs_by_id.insert(
        record.id.clone(),
        StaleTabState {
            reason,
            record,
            stale_at: SystemTime::now(),
        },
    );
    prune_stale_map_locked(&mut inner.stale_tabs_by_id, |state| state.stale_at);
}

fn record_stale_file_chooser_locked(
    inner: &mut Inner,
    id: FileChooserId,
    state: &FileChooserState,
    reason: String,
) {
    inner.stale_file_choosers_by_id.insert(
        id,
        StaleHandleState {
            reason,
            tab_id: state.tab_id.clone(),
            owner_session_id: state.owner_session_id.clone(),
            created_at: state.created_at,
            stale_at: SystemTime::now(),
        },
    );
    prune_stale_map_locked(&mut inner.stale_file_choosers_by_id, |state| state.stale_at);
}

fn record_stale_download_locked(
    inner: &mut Inner,
    id: DownloadId,
    state: &DownloadState,
    reason: String,
) {
    inner.stale_downloads_by_id.insert(
        id,
        StaleHandleState {
            reason,
            tab_id: state.tab_id.clone(),
            owner_session_id: state.owner_session_id.clone(),
            created_at: state.created_at,
            stale_at: SystemTime::now(),
        },
    );
    prune_stale_map_locked(&mut inner.stale_downloads_by_id, |state| state.stale_at);
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

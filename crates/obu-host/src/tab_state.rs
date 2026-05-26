//! Per-tab state tracked by `obu-host`.

use serde::{Deserialize, Serialize};

/// Host-level tab identifier exposed to the SDK.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TabId(pub String);

impl TabId {
    /// Construct a tab id.
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
}

impl From<String> for TabId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for TabId {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

/// Who created or claimed a tab.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TabOrigin {
    /// Created by the agent.
    Agent,
    /// Claimed from user-visible browser state.
    User,
}

impl TabOrigin {
    /// Every origin variant. Pinned to `control-vocab.json` (`tabOrigins`).
    pub const ALL: [TabOrigin; 2] = [TabOrigin::Agent, TabOrigin::User];
}

/// Lifecycle state for a tab known to the host.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TabStatus {
    /// Controlled by the current browser session.
    Active,
    /// Parked for handoff outside active browser-control commands.
    Handoff,
    /// Preserved as a stable deliverable outside active browser control.
    Deliverable,
}

impl TabStatus {
    /// Every status variant. Pinned to `control-vocab.json` (`tabStatuses`).
    pub const ALL: [TabStatus; 3] = [
        TabStatus::Active,
        TabStatus::Handoff,
        TabStatus::Deliverable,
    ];
}

/// Mutable per-tab record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabRecord {
    /// SDK-facing id.
    pub id: TabId,
    /// Owning browser-control session, when known.
    pub session_id: Option<String>,
    /// CDP target id.
    pub target_id: String,
    /// Current URL.
    pub url: String,
    /// Current title.
    pub title: String,
    /// Tab origin.
    pub origin: TabOrigin,
    /// Host-visible lifecycle state.
    pub status: TabStatus,
    /// Whether the backend has an attached debugger session.
    pub attached: bool,
    /// CDP session id, when attached.
    pub cdp_session_id: Option<String>,
}

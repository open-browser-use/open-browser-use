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

/// Who created or claimed a tab.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TabOrigin {
    /// Created by the agent.
    Agent,
    /// Claimed from user-visible browser state.
    User,
}

/// Lifecycle state for a tab known to the host.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TabStatus {
    /// Controlled by the current browser session.
    Active,
    /// Kept under active browser control for handoff.
    Handoff,
    /// Preserved as a stable deliverable outside active browser control.
    Deliverable,
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

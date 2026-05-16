//! Configuration for peer-auth allow-lists.

use serde::{Deserialize, Serialize};

/// Allow-list for macOS SecCode peer auth.
///
/// open-browser-use defines its own allow-list instead of relying on another
/// application's bundle or team identifiers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MacAllowList {
    /// Apple Developer team identifier, if the build channel enforces one.
    pub team_id: Option<String>,
    /// Permitted bundle identifiers.
    pub bundle_ids: Vec<String>,
}

impl MacAllowList {
    /// Default open-browser-use bundle IDs. The team ID is supplied per release channel.
    pub fn obu_default() -> Self {
        Self {
            team_id: None,
            bundle_ids: vec![
                "dev.obu.host".into(),
                "dev.obu.node-repl".into(),
                "dev.obu.cli".into(),
            ],
        }
    }

    /// Return whether a resolved code identity is allowed.
    pub fn permits(&self, identifier: Option<&str>, team_id: Option<&str>) -> bool {
        let team_ok = match (&self.team_id, team_id) {
            (Some(want), Some(got)) => want == got,
            (None, _) => true,
            (Some(_), None) => false,
        };
        let bundle_ok = identifier
            .map(|id| self.bundle_ids.iter().any(|allowed| allowed == id))
            .unwrap_or(false);
        team_ok && bundle_ok
    }
}

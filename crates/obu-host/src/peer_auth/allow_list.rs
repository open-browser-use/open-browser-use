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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn obu_default_allows_expected_obu_bundle_ids_without_team_id() {
        let allow_list = MacAllowList::obu_default();

        assert_eq!(allow_list.team_id, None);
        assert!(allow_list.permits(Some("dev.obu.host"), None));
        assert!(allow_list.permits(Some("dev.obu.node-repl"), Some("ANYTEAM")));
        assert!(allow_list.permits(Some("dev.obu.cli"), None));
    }

    #[test]
    fn rejects_missing_or_unknown_bundle_id() {
        let allow_list = MacAllowList {
            team_id: None,
            bundle_ids: vec!["dev.obu.host".into()],
        };

        assert!(!allow_list.permits(None, None));
        assert!(!allow_list.permits(Some("com.example.other"), None));
    }

    #[test]
    fn team_id_is_enforced_when_configured() {
        let allow_list = MacAllowList {
            team_id: Some("TEAM123".into()),
            bundle_ids: vec!["dev.obu.host".into()],
        };

        assert!(allow_list.permits(Some("dev.obu.host"), Some("TEAM123")));
        assert!(!allow_list.permits(Some("dev.obu.host"), Some("OTHERTEAM")));
        assert!(!allow_list.permits(Some("dev.obu.host"), None));
        assert!(!allow_list.permits(Some("com.example.other"), Some("TEAM123")));
    }
}

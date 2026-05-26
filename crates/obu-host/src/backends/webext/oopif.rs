//! Cross-process (OOPIF) session tracking for the WebExtension backend.
//!
//! Mirrors `backends/cdp/oopif.rs`, but consumes the events the extension
//! forwards as `onCDPEvent` notifications rather than raw CDP frames. Each
//! forwarded event carries the owning `tabId` in its `source`, so this map keys
//! frame sessions by `tabId -> {child session id}` directly — no parent-session
//! walk is needed to find the owning tab (the CDP map only had the child CDP
//! `sessionId` and had to follow `parentSessionId` to the top-level session).
//!
//! The child CDP session id arrives in the inner `Target.attachedToTarget`
//! params (`params.sessionId`); the `source.sessionId` of that event is the
//! PARENT session (absent for the top-level tab session). The parent session is
//! retained per child so `oopif_root_offset` can walk the `<iframe>` ancestor
//! chain to compose root-frame coordinates, exactly like the CDP backend.

use std::collections::HashMap;

use serde_json::Value;

/// Max OOPIF frame-tree depth we walk before assuming a malformed parent chain.
/// Real cross-process nesting is far shallower; this only guards against a cycle.
const MAX_FRAME_DEPTH: usize = 64;

/// One attached out-of-process frame session, owned by a known browser tab.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct WebextOopifSession {
    pub session_id: String,
    pub parent_session_id: Option<String>,
    pub target_id: String,
    pub url: String,
}

/// Tab → OOPIF-session map for the WebExtension backend.
///
/// Keyed by `tabId` (the owning browser tab), then by the child CDP session id.
#[derive(Debug, Default)]
pub(crate) struct WebextOopifSessionMap {
    by_tab: HashMap<i64, HashMap<String, WebextOopifSession>>,
}

impl WebextOopifSessionMap {
    /// Apply a forwarded `onCDPEvent` payload. Returns true if the map changed.
    ///
    /// `params` is the `onCDPEvent` notification body:
    /// `{ session_id, source: { tabId, sessionId? }, method, params }`. Only the
    /// inner `Target.attachedToTarget` / `Target.detachedFromTarget` events for
    /// `iframe` targets mutate the map.
    pub(crate) fn apply_cdp_event(&mut self, params: &Value) -> bool {
        let Some(tab_id) = params
            .get("source")
            .and_then(|source| source.get("tabId"))
            .and_then(Value::as_i64)
        else {
            return false;
        };
        let parent_session_id = params
            .get("source")
            .and_then(|source| source.get("sessionId"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let method = params.get("method").and_then(Value::as_str).unwrap_or("");
        let inner = params.get("params").unwrap_or(&Value::Null);
        match method {
            "Target.attachedToTarget" => {
                let info = &inner["targetInfo"];
                // Only out-of-process *frames* go in the map. Workers/service-workers
                // are not frames; `page` targets are attached explicitly elsewhere.
                if info.get("type").and_then(Value::as_str) != Some("iframe") {
                    return false;
                }
                let Some(session_id) = inner.get("sessionId").and_then(Value::as_str) else {
                    return false;
                };
                self.by_tab.entry(tab_id).or_default().insert(
                    session_id.to_string(),
                    WebextOopifSession {
                        session_id: session_id.to_string(),
                        parent_session_id,
                        target_id: info
                            .get("targetId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        url: info
                            .get("url")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    },
                );
                true
            }
            "Target.detachedFromTarget" => {
                let Some(session_id) = inner.get("sessionId").and_then(Value::as_str) else {
                    return false;
                };
                let Some(sessions) = self.by_tab.get_mut(&tab_id) else {
                    return false;
                };
                let removed = sessions.remove(session_id).is_some();
                if sessions.is_empty() {
                    self.by_tab.remove(&tab_id);
                }
                removed
            }
            _ => false,
        }
    }

    /// All OOPIF session ids attached under a browser tab.
    pub(crate) fn sessions_for_tab(&self, tab_id: i64) -> Vec<String> {
        self.by_tab
            .get(&tab_id)
            .map(|sessions| sessions.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// The OOPIF session owning the frame whose devtools `frameId` is `frame_id`,
    /// searched across ALL tabs. CDP target ids are unique per browser process, so
    /// at most one session matches — there is no cross-tab ambiguity. Used by the
    /// Playwright path, which resolves a frame before it knows the owning tab.
    pub(crate) fn session_for_any_frame(&self, frame_id: &str) -> Option<String> {
        self.by_tab
            .values()
            .flat_map(HashMap::values)
            .find(|session| session.target_id == frame_id)
            .map(|session| session.session_id.clone())
    }

    /// The owning browser `tabId` for a child CDP session id.
    ///
    /// WebExtension `executeCdp` is addressed by `{ tabId, sessionId }`, but the
    /// shared runtime hands the backend only the child `session_id`; this reverse
    /// lookup recovers the tab so the command can be routed. (The CDP backend has
    /// a single socket and needs no tab, hence no analogue there.)
    pub(crate) fn tab_for_session(&self, session_id: &str) -> Option<i64> {
        self.by_tab
            .iter()
            .find(|(_, sessions)| sessions.contains_key(session_id))
            .map(|(tab_id, _)| *tab_id)
    }

    /// (frameId, parent_session_id) for a session under `tab_id`, for walking the
    /// OOPIF frame chain to compose root-frame coordinates.
    pub(crate) fn frame_and_parent(
        &self,
        tab_id: i64,
        session_id: &str,
    ) -> Option<(String, Option<String>)> {
        self.by_tab
            .get(&tab_id)?
            .get(session_id)
            .map(|session| (session.target_id.clone(), session.parent_session_id.clone()))
    }

    /// Drop every OOPIF session recorded for a tab (e.g. on tab close/detach).
    pub(crate) fn forget_tab(&mut self, tab_id: i64) {
        self.by_tab.remove(&tab_id);
    }

    /// Total OOPIF sessions tracked across all tabs.
    #[cfg(test)]
    pub(crate) fn session_count(&self) -> usize {
        self.by_tab.values().map(HashMap::len).sum()
    }

    /// Cycle-guarded depth bound shared by the geometry frame-chain walk.
    pub(crate) const fn max_frame_depth() -> usize {
        MAX_FRAME_DEPTH
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Build an `onCDPEvent` payload for a `Target.attachedToTarget` of `ty`.
    fn attached(tab_id: i64, parent: Option<&str>, child: &str, target: &str, ty: &str) -> Value {
        let mut source = json!({ "tabId": tab_id });
        if let Some(parent) = parent {
            source["sessionId"] = json!(parent);
        }
        json!({
            "session_id": "obu-session",
            "source": source,
            "method": "Target.attachedToTarget",
            "params": {
                "sessionId": child,
                "waitingForDebugger": false,
                "targetInfo": { "targetId": target, "type": ty, "url": "http://b.test/inner" }
            }
        })
    }

    fn detached(tab_id: i64, child: &str) -> Value {
        json!({
            "session_id": "obu-session",
            "source": { "tabId": tab_id },
            "method": "Target.detachedFromTarget",
            "params": { "sessionId": child }
        })
    }

    #[test]
    fn tracks_iframe_sessions_and_ignores_non_iframe() {
        let mut map = WebextOopifSessionMap::default();
        assert!(map.apply_cdp_event(&attached(7, None, "C1", "T1", "iframe")));
        assert!(!map.apply_cdp_event(&attached(7, None, "W1", "T2", "worker")));
        assert_eq!(map.session_count(), 1);
        assert_eq!(map.sessions_for_tab(7), vec!["C1".to_string()]);
    }

    #[test]
    fn ignores_events_without_a_tab_id() {
        let mut map = WebextOopifSessionMap::default();
        let mut event = attached(7, None, "C1", "T1", "iframe");
        event["source"] = json!({}); // no tabId
        assert!(!map.apply_cdp_event(&event));
        assert_eq!(map.session_count(), 0);
    }

    #[test]
    fn sessions_are_scoped_per_tab() {
        let mut map = WebextOopifSessionMap::default();
        map.apply_cdp_event(&attached(7, None, "C1", "T1", "iframe"));
        map.apply_cdp_event(&attached(9, None, "C2", "T2", "iframe"));
        assert_eq!(map.sessions_for_tab(7), vec!["C1".to_string()]);
        assert_eq!(map.sessions_for_tab(9), vec!["C2".to_string()]);
        assert!(map.sessions_for_tab(42).is_empty());
    }

    #[test]
    fn resolves_session_by_frame_id_across_tabs() {
        let mut map = WebextOopifSessionMap::default();
        map.apply_cdp_event(&attached(7, None, "C1", "FRAME-1", "iframe"));
        map.apply_cdp_event(&attached(9, None, "C2", "FRAME-2", "iframe"));
        // Target ids are browser-global, so the frame lookup is tab-agnostic.
        assert_eq!(map.session_for_any_frame("FRAME-1").as_deref(), Some("C1"));
        assert_eq!(map.session_for_any_frame("FRAME-2").as_deref(), Some("C2"));
        assert_eq!(map.session_for_any_frame("missing"), None);
    }

    #[test]
    fn retains_parent_session_for_frame_chain_walk() {
        let mut map = WebextOopifSessionMap::default();
        map.apply_cdp_event(&attached(7, None, "C1", "T1", "iframe")); // child of page
        map.apply_cdp_event(&attached(7, Some("C1"), "C2", "T2", "iframe")); // grandchild
        assert_eq!(
            map.frame_and_parent(7, "C2"),
            Some(("T2".to_string(), Some("C1".to_string())))
        );
        assert_eq!(
            map.frame_and_parent(7, "C1"),
            Some(("T1".to_string(), None))
        );
    }

    #[test]
    fn detach_removes_the_session_and_prunes_empty_tabs() {
        let mut map = WebextOopifSessionMap::default();
        map.apply_cdp_event(&attached(7, None, "C1", "T1", "iframe"));
        assert!(map.apply_cdp_event(&detached(7, "C1")));
        assert_eq!(map.session_count(), 0);
        assert!(map.sessions_for_tab(7).is_empty());
        // The now-empty tab bucket is pruned, so a second detach is a no-op.
        assert!(!map.apply_cdp_event(&detached(7, "C1")));
    }

    #[test]
    fn reverse_resolves_owning_tab_for_a_child_session() {
        let mut map = WebextOopifSessionMap::default();
        map.apply_cdp_event(&attached(7, None, "C1", "T1", "iframe"));
        map.apply_cdp_event(&attached(9, None, "C2", "T2", "iframe"));
        assert_eq!(map.tab_for_session("C1"), Some(7));
        assert_eq!(map.tab_for_session("C2"), Some(9));
        assert_eq!(map.tab_for_session("missing"), None);
    }

    #[test]
    fn forget_tab_drops_all_sessions_for_that_tab() {
        let mut map = WebextOopifSessionMap::default();
        map.apply_cdp_event(&attached(7, None, "C1", "T1", "iframe"));
        map.apply_cdp_event(&attached(7, Some("C1"), "C2", "T2", "iframe"));
        map.apply_cdp_event(&attached(9, None, "C3", "T3", "iframe"));
        map.forget_tab(7);
        assert!(map.sessions_for_tab(7).is_empty());
        assert_eq!(map.sessions_for_tab(9), vec!["C3".to_string()]);
    }
}

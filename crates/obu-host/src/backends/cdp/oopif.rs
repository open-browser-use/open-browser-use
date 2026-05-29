//! Cross-process (OOPIF) session tracking. Without `Target.setAutoAttach`, OOPIF
//! DOM is invisible to the single top-level session; this map records the child
//! sessions so DOM geometry can be routed to the frame that owns a node.

use std::collections::HashMap;

use crate::backends::cdp::transport::CdpEvent;

/// Max OOPIF frame-tree depth we walk before assuming a malformed parent chain.
/// Real cross-process nesting is far shallower; this only guards against a cycle.
pub(crate) const MAX_FRAME_DEPTH: usize = 64;

/// One attached out-of-process frame session.
#[derive(Debug, Clone)]
pub(crate) struct OopifSession {
    pub session_id: String,
    pub parent_session_id: Option<String>,
    pub target_id: String,
    pub url: String,
}

/// Frame→session map, keyed by the child session id.
#[derive(Debug, Default)]
pub(crate) struct OopifSessionMap {
    by_session: HashMap<String, OopifSession>,
}

impl OopifSessionMap {
    /// Apply a `Target.attachedToTarget` / `Target.detachedFromTarget` event.
    /// Returns true if the map changed.
    pub(crate) fn apply_event(&mut self, event: &CdpEvent) -> bool {
        match event.method.as_str() {
            "Target.attachedToTarget" => {
                let info = &event.params["targetInfo"];
                let ty = info.get("type").and_then(|v| v.as_str()).unwrap_or("");
                // Only out-of-process *frames* go in the map. Workers/service-workers
                // are not frames; `page` targets are attached explicitly elsewhere.
                if ty != "iframe" {
                    return false;
                }
                let Some(session_id) = event.params.get("sessionId").and_then(|v| v.as_str())
                else {
                    return false;
                };
                self.by_session.insert(
                    session_id.to_string(),
                    OopifSession {
                        session_id: session_id.to_string(),
                        parent_session_id: event.session_id.clone(),
                        target_id: info
                            .get("targetId")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        url: info
                            .get("url")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                    },
                );
                true
            }
            "Target.detachedFromTarget" => {
                let Some(session_id) = event.params.get("sessionId").and_then(|v| v.as_str())
                else {
                    return false;
                };
                self.by_session.remove(session_id).is_some()
            }
            _ => false,
        }
    }

    /// All OOPIF sessions whose ancestor chain roots at `top_level_session`.
    pub(crate) fn sessions_for_tab(&self, top_level_session: &str) -> Vec<String> {
        self.by_session
            .values()
            .filter(|s| self.roots_at(s, top_level_session))
            .map(|s| s.session_id.clone())
            .collect()
    }

    /// Drop every OOPIF session whose ancestor chain roots at `top_level_session`.
    /// Mirrors the per-tab cleanup the webext backend performs on tab close: the
    /// map is normally kept current by `Target.detachedFromTarget`, but a dropped
    /// or `Lagged` detach event would otherwise leak the tab's child sessions, so
    /// clearing on close bounds the map to live tabs. Returns the number removed.
    pub(crate) fn forget_tab(&mut self, top_level_session: &str) -> usize {
        let stale: Vec<String> = self
            .by_session
            .values()
            .filter(|session| self.roots_at(session, top_level_session))
            .map(|session| session.session_id.clone())
            .collect();
        for session_id in &stale {
            self.by_session.remove(session_id);
        }
        stale.len()
    }

    /// Drop every tracked OOPIF session. Used when the whole CDP connection is
    /// replaced (transport reconnect): all flatten session ids are connection-
    /// scoped, so the map must be reset before `Target.attachedToTarget` events
    /// rebuild it on the fresh connection.
    pub(crate) fn clear(&mut self) {
        self.by_session.clear();
    }

    /// The OOPIF session owning the frame whose devtools `frameId` is `frame_id`.
    /// For auto-attached OOPIFs the child target's `target_id` equals that frameId.
    ///
    /// The match is browser-global (not tab-scoped, unlike `sessions_for_tab`):
    /// CDP target ids are unique per browser process, so at most one session can
    /// match a given frameId — there is no cross-tab ambiguity.
    pub(crate) fn session_for_frame(&self, frame_id: &str) -> Option<String> {
        self.by_session
            .values()
            .find(|session| session.target_id == frame_id)
            .map(|session| session.session_id.clone())
    }

    /// (frameId, parent_session_id) for a session, for walking the OOPIF frame
    /// chain to compose root-frame coordinates.
    pub(crate) fn frame_and_parent(&self, session_id: &str) -> Option<(String, Option<String>)> {
        self.by_session
            .get(session_id)
            .map(|s| (s.target_id.clone(), s.parent_session_id.clone()))
    }

    fn roots_at(&self, session: &OopifSession, root: &str) -> bool {
        let mut parent = session.parent_session_id.as_deref();
        let mut hops = 0;
        while let Some(p) = parent {
            if p == root {
                return true;
            }
            parent = self
                .by_session
                .get(p)
                .and_then(|s| s.parent_session_id.as_deref());
            hops += 1;
            if hops > MAX_FRAME_DEPTH {
                return false; // cycle guard
            }
        }
        false
    }

    pub(crate) fn session_count(&self) -> usize {
        self.by_session.len()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::backends::cdp::transport::CdpEvent;

    fn attached(parent: &str, child: &str, target: &str, ty: &str) -> CdpEvent {
        CdpEvent {
            session_id: Some(parent.to_string()),
            method: "Target.attachedToTarget".to_string(),
            params: json!({
                "sessionId": child,
                "waitingForDebugger": false,
                "targetInfo": { "targetId": target, "type": ty, "url": "http://b.test/inner" }
            }),
        }
    }

    #[test]
    fn tracks_iframe_sessions_and_ignores_non_iframe() {
        let mut map = OopifSessionMap::default();
        assert!(map.apply_event(&attached("PAGE", "C1", "T1", "iframe")));
        assert!(!map.apply_event(&attached("PAGE", "W1", "T2", "worker"))); // not a frame target
        assert_eq!(map.session_count(), 1);
    }

    #[test]
    fn resolves_descendant_sessions_for_a_tab() {
        let mut map = OopifSessionMap::default();
        map.apply_event(&attached("PAGE", "C1", "T1", "iframe")); // child of page
        map.apply_event(&attached("C1", "C2", "T2", "iframe")); // grandchild
        let mut sessions = map.sessions_for_tab("PAGE");
        sessions.sort();
        assert_eq!(sessions, vec!["C1".to_string(), "C2".to_string()]);
    }

    #[test]
    fn resolves_session_by_frame_id() {
        let mut map = OopifSessionMap::default();
        map.apply_event(&attached("PAGE", "C1", "FRAME-1", "iframe"));
        assert_eq!(map.session_for_frame("FRAME-1").as_deref(), Some("C1"));
        assert_eq!(map.session_for_frame("missing"), None);
    }

    #[test]
    fn detach_removes_the_session() {
        let mut map = OopifSessionMap::default();
        map.apply_event(&attached("PAGE", "C1", "T1", "iframe"));
        let detached = CdpEvent {
            session_id: Some("PAGE".into()),
            method: "Target.detachedFromTarget".into(),
            params: json!({ "sessionId": "C1" }),
        };
        assert!(map.apply_event(&detached));
        assert_eq!(map.session_count(), 0);
    }

    #[test]
    fn forget_tab_drops_only_sessions_rooted_at_that_tab() {
        let mut map = OopifSessionMap::default();
        map.apply_event(&attached("PAGE-A", "A1", "TA1", "iframe"));
        map.apply_event(&attached("A1", "A2", "TA2", "iframe")); // grandchild under PAGE-A
        map.apply_event(&attached("PAGE-B", "B1", "TB1", "iframe")); // a different tab
        assert_eq!(map.forget_tab("PAGE-A"), 2);
        assert_eq!(map.session_count(), 1);
        // The other tab's session is untouched.
        assert_eq!(map.session_for_frame("TB1").as_deref(), Some("B1"));
    }

    #[test]
    fn clear_drops_every_session() {
        let mut map = OopifSessionMap::default();
        map.apply_event(&attached("PAGE-A", "A1", "TA1", "iframe"));
        map.apply_event(&attached("PAGE-B", "B1", "TB1", "iframe"));
        assert_eq!(map.session_count(), 2);
        map.clear();
        assert_eq!(map.session_count(), 0);
        // A subsequent attach still works after a clear.
        map.apply_event(&attached("PAGE-A", "A1", "TA1", "iframe"));
        assert_eq!(map.session_count(), 1);
    }
}

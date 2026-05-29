//! Session re-establishment after a CDP transport reconnect.
//!
//! `flatten` session ids are connection-scoped, so a reconnect invalidates every
//! `cdp_session_id`. After the transport restores the socket it bumps its
//! reconnect generation; the consumer spawned in `mod.rs` calls
//! `reestablish_sessions`, which re-attaches each known Active tab by its stored
//! `target_id` and re-arms auto-attach (the OOPIF consumer then rebuilds children).

use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::backends::cdp::error::CdpError;
use crate::backends::cdp::oopif::OopifSessionMap;
use crate::backends::cdp::transport::CdpTransport;
use crate::service_registry::ServiceRegistry;
use crate::tab_state::TabStatus;

/// Re-attach + re-arm every Active, attached tab on the fresh connection.
pub(crate) async fn reestablish_sessions(
    transport: &CdpTransport,
    registry: &ServiceRegistry,
    oopif_sessions: &Mutex<OopifSessionMap>,
) {
    // Connection-scoped child sessions died with the old socket.
    oopif_sessions.lock().await.clear();

    let tabs = match registry.list() {
        Ok(tabs) => tabs,
        Err(error) => {
            tracing::warn!(%error, "CDP reconnect: registry list failed; cannot re-establish");
            return;
        }
    };

    let mut reattached = 0usize;
    for record in tabs {
        if record.status != TabStatus::Active || !record.attached {
            continue;
        }
        match reattach_session(transport, &record.target_id).await {
            Ok(session_id) => {
                let _ = registry.update(&record.id, |record| {
                    record.attached = true;
                    record.cdp_session_id = Some(session_id.clone());
                });
                reattached += 1;
            }
            Err(error) => {
                tracing::warn!(
                    %error,
                    tab = %record.id.0,
                    "CDP reconnect: re-attach failed; marking tab unattached"
                );
                let _ = registry.update(&record.id, |record| {
                    record.attached = false;
                    record.cdp_session_id = None;
                });
            }
        }
    }
    tracing::info!(
        reattached,
        "CDP transport reconnect: re-established sessions"
    );
}

/// Re-attach one target and re-arm focus emulation + auto-attach.
/// Mirrors `attach::attach` (`attach.rs:17-56`) for the post-reconnect path.
async fn reattach_session(transport: &CdpTransport, target_id: &str) -> Result<String, CdpError> {
    let result = transport
        .send_command(
            "Target.attachToTarget",
            json!({ "targetId": target_id, "flatten": true }),
            None,
        )
        .await?;
    let session_id = result
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| CdpError::Protocol("re-attach missing sessionId".into()))?
        .to_string();
    transport
        .send_command(
            "Emulation.setFocusEmulationEnabled",
            json!({ "enabled": true }),
            Some(&session_id),
        )
        .await?;
    transport
        .send_command(
            "Target.setAutoAttach",
            json!({ "autoAttach": true, "flatten": true, "waitForDebuggerOnStart": false }),
            Some(&session_id),
        )
        .await?;
    Ok(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backends::cdp::test_support::FakeCdpServer;
    use crate::backends::cdp::transport::{CdpEvent, ReconnectConfig};
    use crate::tab_state::{TabId, TabOrigin, TabRecord};

    fn active_tab(id: &str, target: &str) -> TabRecord {
        TabRecord {
            id: TabId::new(id),
            session_id: Some("s1".into()),
            target_id: target.into(),
            url: "https://a.test/".into(),
            title: "A".into(),
            origin: TabOrigin::Agent,
            status: TabStatus::Active,
            attached: true,
            cdp_session_id: Some("dead-session".into()),
        }
    }

    #[tokio::test]
    async fn reestablish_reattaches_active_tabs_and_clears_oopif_map() {
        let server = FakeCdpServer::start().await;
        let transport =
            CdpTransport::connect_with_config(server.ws_url(), ReconnectConfig::fast_for_tests())
                .await
                .unwrap();
        let registry = ServiceRegistry::default();
        registry.insert(active_tab("tab-1", "TARGET-1")).unwrap();

        let oopif = Mutex::new(OopifSessionMap::default());
        oopif.lock().await.apply_event(&CdpEvent {
            session_id: Some("dead-session".into()),
            method: "Target.attachedToTarget".into(),
            params: json!({
                "sessionId": "child",
                "targetInfo": { "targetId": "f", "type": "iframe", "url": "" }
            }),
        });
        assert_eq!(oopif.lock().await.session_count(), 1);

        reestablish_sessions(&transport, &registry, &oopif).await;

        // OOPIF map reset.
        assert_eq!(oopif.lock().await.session_count(), 0);
        // Registry session id replaced with the fresh one from the fake server.
        let record = registry.get(&TabId::new("tab-1")).unwrap().unwrap();
        assert!(record.attached);
        assert_ne!(record.cdp_session_id.as_deref(), Some("dead-session"));
        // The server saw a re-attach for the stored target id and a re-arm.
        let requests = server.requests();
        assert!(
            requests
                .iter()
                .any(|request| request["method"] == "Target.attachToTarget"
                    && request["params"]["targetId"] == "TARGET-1"),
            "expected a re-attach for TARGET-1, got {requests:?}"
        );
        assert!(
            requests
                .iter()
                .any(|request| request["method"] == "Target.setAutoAttach"),
            "expected setAutoAttach re-arm, got {requests:?}"
        );
    }

    #[tokio::test]
    async fn reestablish_marks_tab_unattached_when_reattach_fails() {
        let server = FakeCdpServer::start().await;
        server.set_attach_error(true);
        let transport =
            CdpTransport::connect_with_config(server.ws_url(), ReconnectConfig::fast_for_tests())
                .await
                .unwrap();
        let registry = ServiceRegistry::default();
        registry.insert(active_tab("tab-1", "GONE")).unwrap();
        let oopif = Mutex::new(OopifSessionMap::default());

        reestablish_sessions(&transport, &registry, &oopif).await;

        let record = registry.get(&TabId::new("tab-1")).unwrap().unwrap();
        assert!(!record.attached, "failed re-attach must clear attached");
        assert_eq!(record.cdp_session_id, None);
    }
}

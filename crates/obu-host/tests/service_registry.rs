use std::collections::HashSet;
use std::time::SystemTime;

use obu_host::registry_lifecycle::{MAX_REGISTRY_LIFECYCLE_EVENTS, RegistryLifecycleEventKind};
use obu_host::service_registry::{
    DownloadId, DownloadState, FileChooserId, FileChooserState, ServiceRegistry,
};
use obu_host::tab_state::{TabId, TabOrigin, TabRecord, TabStatus};

#[test]
fn insert_get_list_update_remove_tab() {
    let registry = ServiceRegistry::default();
    let record = TabRecord {
        id: TabId::new("t1"),
        session_id: Some("session".into()),
        target_id: "target-1".into(),
        url: "https://example.com".into(),
        title: "Example".into(),
        origin: TabOrigin::Agent,
        status: TabStatus::Active,
        attached: false,
        cdp_session_id: None,
    };

    registry.insert(record).unwrap();
    assert_eq!(
        registry.get(&TabId::new("t1")).unwrap().unwrap().target_id,
        "target-1"
    );
    assert_eq!(registry.list().unwrap().len(), 1);
    assert!(
        registry
            .update(&TabId::new("t1"), |record| record.attached = true)
            .unwrap()
    );
    assert!(registry.get(&TabId::new("t1")).unwrap().unwrap().attached);

    registry
        .mark_playwright_injected(&TabId::new("t1"))
        .unwrap();
    assert!(registry.is_playwright_injected(&TabId::new("t1")).unwrap());
    registry
        .clear_playwright_injected(&TabId::new("t1"))
        .unwrap();
    assert!(!registry.is_playwright_injected(&TabId::new("t1")).unwrap());

    registry.remove(&TabId::new("t1")).unwrap();
    assert!(registry.list().unwrap().is_empty());
}

#[test]
fn registry_lifecycle_events_track_named_mutations() {
    let registry = ServiceRegistry::default();
    let tab_id = TabId::new("t1");

    registry.touch_session("session", Some("turn-1")).unwrap();
    registry
        .name_session("session", Some("Research".into()))
        .unwrap();
    registry.insert(tab_record(tab_id.clone())).unwrap();
    registry
        .update(&tab_id, |record| record.title = "Updated".into())
        .unwrap();
    registry.mark_playwright_injected(&tab_id).unwrap();
    registry.clear_tab_handles(&tab_id).unwrap();
    registry
        .remove_with_reason(&tab_id, "test cleanup")
        .unwrap();
    registry.clear_stale_diagnostics().unwrap();

    let kinds = registry
        .recent_lifecycle_events(20)
        .unwrap()
        .into_iter()
        .map(|event| event.kind)
        .collect::<Vec<_>>();

    assert!(kinds.contains(&RegistryLifecycleEventKind::SessionTouched));
    assert!(kinds.contains(&RegistryLifecycleEventKind::SessionNamed));
    assert!(kinds.contains(&RegistryLifecycleEventKind::TabInserted));
    assert!(kinds.contains(&RegistryLifecycleEventKind::TabUpdated));
    assert!(kinds.contains(&RegistryLifecycleEventKind::PlaywrightInjected));
    assert!(kinds.contains(&RegistryLifecycleEventKind::TabHandlesCleared));
    assert!(kinds.contains(&RegistryLifecycleEventKind::TabStale));
    assert!(kinds.contains(&RegistryLifecycleEventKind::DiagnosticsCleared));
}

#[test]
fn registry_lifecycle_events_are_bounded() {
    let registry = ServiceRegistry::default();

    for index in 0..(MAX_REGISTRY_LIFECYCLE_EVENTS + 5) {
        registry
            .insert(tab_record(TabId::new(format!("tab-{index}"))))
            .unwrap();
    }

    let events = registry
        .recent_lifecycle_events(MAX_REGISTRY_LIFECYCLE_EVENTS + 10)
        .unwrap();
    assert_eq!(events.len(), MAX_REGISTRY_LIFECYCLE_EVENTS);
    assert_eq!(events[0].kind, RegistryLifecycleEventKind::TabInserted);
    assert_eq!(events[0].subject_id, "tab-5");
}

#[test]
fn download_lifecycle_tracks_completion() {
    let registry = ServiceRegistry::default();
    let id = DownloadId("d1".into());
    registry
        .insert_download(
            id.clone(),
            DownloadState {
                tab_id: TabId::new("t1"),
                owner_session_id: Some("session".into()),
                owner_turn_id: None,
                created_at: SystemTime::now(),
                url: "https://example.com/file".into(),
                suggested_filename: "file.txt".into(),
                guid: "guid-1".into(),
                completed_path: None,
            },
        )
        .unwrap();

    registry
        .mark_download_completed(&id, Some("/tmp/file.txt".into()))
        .unwrap();
    assert_eq!(
        registry
            .get_download(&id)
            .unwrap()
            .unwrap()
            .completed_path
            .as_deref(),
        Some("/tmp/file.txt")
    );
    assert!(registry.remove_download(&id).unwrap().is_some());
    assert!(registry.get_download(&id).unwrap().is_none());
    assert!(
        registry
            .describe_missing_download(&id)
            .unwrap()
        .contains("removed explicitly")
    );
    let failed_id = DownloadId("d2".into());
    let failed_state = DownloadState {
        tab_id: TabId::new("t1"),
        owner_session_id: Some("session".into()),
        owner_turn_id: None,
        created_at: SystemTime::now(),
        url: "https://example.com/failed".into(),
        suggested_filename: "failed.txt".into(),
        guid: "guid-2".into(),
        completed_path: None,
    };
    registry
        .insert_download(failed_id.clone(), failed_state.clone())
        .unwrap();
    registry
        .mark_download_failed(&failed_id, &failed_state, "download was canceled")
        .unwrap();
    assert!(registry.get_download(&failed_id).unwrap().is_none());
    assert!(registry
        .describe_missing_download(&failed_id)
        .unwrap()
        .contains("download was canceled"));
    let events = registry.recent_lifecycle_events(10).unwrap();
    let kinds = events.iter().map(|event| event.kind.clone()).collect::<Vec<_>>();
    assert!(kinds.contains(&RegistryLifecycleEventKind::DownloadInserted));
    assert!(kinds.contains(&RegistryLifecycleEventKind::DownloadCompleted));
    assert!(kinds.contains(&RegistryLifecycleEventKind::DownloadRemoved));
    assert!(kinds.contains(&RegistryLifecycleEventKind::DownloadFailed));
    assert!(kinds.contains(&RegistryLifecycleEventKind::DownloadStale));
    assert_eq!(
        events
            .iter()
            .find(|event| event.kind == RegistryLifecycleEventKind::DownloadFailed)
            .and_then(|event| event.next_action.as_deref()),
        Some("inspect_error_or_retry_download")
    );
}

#[test]
fn removing_or_detaching_tab_cleans_associated_handles() {
    let registry = ServiceRegistry::default();
    let tab_id = TabId::new("t1");
    registry
        .insert(TabRecord {
            id: tab_id.clone(),
            session_id: Some("session".into()),
            target_id: "target-1".into(),
            url: "https://example.com".into(),
            title: "Example".into(),
            origin: TabOrigin::Agent,
            status: TabStatus::Active,
            attached: true,
            cdp_session_id: Some("cdp-session".into()),
        })
        .unwrap();
    registry.mark_playwright_injected(&tab_id).unwrap();
    registry
        .insert_file_chooser(
            FileChooserId("chooser-1".into()),
            FileChooserState {
                tab_id: tab_id.clone(),
                owner_session_id: Some("session".into()),
                owner_turn_id: None,
                created_at: SystemTime::now(),
                backend_node_id: 123,
                is_multiple: false,
            },
        )
        .unwrap();
    registry
        .insert_download(
            DownloadId("download-1".into()),
            DownloadState {
                tab_id: tab_id.clone(),
                owner_session_id: Some("session".into()),
                owner_turn_id: None,
                created_at: SystemTime::now(),
                url: "https://example.com/file".into(),
                suggested_filename: "file.txt".into(),
                guid: "guid-1".into(),
                completed_path: None,
            },
        )
        .unwrap();

    registry.clear_tab_handles(&tab_id).unwrap();
    assert!(!registry.is_playwright_injected(&tab_id).unwrap());
    assert!(
        registry
            .take_file_chooser(&FileChooserId("chooser-1".into()))
            .unwrap()
            .is_none()
    );
    let chooser_message = registry
        .describe_missing_file_chooser(&FileChooserId("chooser-1".into()))
        .unwrap();
    assert!(chooser_message.contains("stale file chooser handle chooser-1"));
    assert!(chooser_message.contains("owning tab t1 was detached, closed, or finalized"));
    assert!(chooser_message.contains("owner_session=session"));
    assert!(
        registry
            .get_download(&DownloadId("download-1".into()))
            .unwrap()
            .is_none()
    );
    let download_message = registry
        .describe_missing_download(&DownloadId("download-1".into()))
        .unwrap();
    assert!(download_message.contains("stale download handle download-1"));
    assert!(download_message.contains("owner_tab=t1"));
    assert!(registry.get(&tab_id).unwrap().is_some());

    registry
        .insert_download(
            DownloadId("download-2".into()),
            DownloadState {
                tab_id: tab_id.clone(),
                owner_session_id: Some("session".into()),
                owner_turn_id: None,
                created_at: SystemTime::now(),
                url: "https://example.com/other".into(),
                suggested_filename: "other.txt".into(),
                guid: "guid-2".into(),
                completed_path: None,
            },
        )
        .unwrap();
    registry.remove(&tab_id).unwrap();
    assert!(
        registry
            .get_download(&DownloadId("download-2".into()))
            .unwrap()
            .is_none()
    );
    assert!(registry.get(&tab_id).unwrap().is_none());
}

#[test]
fn consumed_file_chooser_reports_specific_stale_reason() {
    let registry = ServiceRegistry::default();
    // Give the owning session a current turn so the handle backfills owner_turn_id
    // and the agent-facing stale description can surface the turn proof.
    registry.touch_session("session", Some("turn-7")).unwrap();
    let id = FileChooserId("chooser-1".into());
    registry
        .insert_file_chooser(
            id.clone(),
            FileChooserState {
                tab_id: TabId::new("t1"),
                owner_session_id: Some("session".into()),
                owner_turn_id: None,
                created_at: SystemTime::now(),
                backend_node_id: 123,
                is_multiple: false,
            },
        )
        .unwrap();

    assert!(registry.take_file_chooser(&id).unwrap().is_some());
    let message = registry.describe_missing_file_chooser(&id).unwrap();
    assert!(message.contains("stale file chooser handle chooser-1"));
    assert!(message.contains("already consumed by setFiles"));
    assert!(message.contains("owner_tab=t1"));
    assert!(message.contains("owner_session=session"));
    // GAP-10 observable: the closed terminal state and owning-turn proof
    // (Task 14 write-only fields) are now surfaced to the agent.
    assert!(message.contains("terminal_state=consumed"));
    assert!(message.contains("owner_turn=turn-7"));
}

#[test]
fn session_lifecycle_tracks_turn_label_and_reconciles_missing_tabs() {
    let registry = ServiceRegistry::default();
    registry.touch_session("session", Some("turn-1")).unwrap();
    registry
        .name_session("session", Some("Research".into()))
        .unwrap();
    let session = registry.get_session("session").unwrap().unwrap();
    assert_eq!(session.session_id, "session");
    assert_eq!(session.current_turn_id.as_deref(), Some("turn-1"));
    assert_eq!(session.label.as_deref(), Some("Research"));
    assert!(session.active_tab_id.is_none());

    let active_tab = TabId::new("active");
    let deliverable_tab = TabId::new("deliverable");
    registry
        .insert(TabRecord {
            id: active_tab.clone(),
            session_id: Some("session".into()),
            target_id: "target-active".into(),
            url: "https://example.com".into(),
            title: "Example".into(),
            origin: TabOrigin::Agent,
            status: TabStatus::Active,
            attached: true,
            cdp_session_id: Some("cdp-active".into()),
        })
        .unwrap();
    registry
        .insert(TabRecord {
            id: deliverable_tab.clone(),
            session_id: Some("session".into()),
            target_id: "target-deliverable".into(),
            url: "https://deliverable.example".into(),
            title: "Deliverable".into(),
            origin: TabOrigin::Agent,
            status: TabStatus::Deliverable,
            attached: false,
            cdp_session_id: None,
        })
        .unwrap();
    registry.mark_playwright_injected(&active_tab).unwrap();
    registry
        .set_active_tab("session", active_tab.clone(), Some("turn-2"))
        .unwrap();
    assert_eq!(
        registry
            .get_session("session")
            .unwrap()
            .unwrap()
            .active_tab_id,
        Some(active_tab.clone())
    );
    assert_eq!(
        registry
            .current_tab_for_session("session")
            .unwrap()
            .unwrap()
            .id,
        active_tab
    );
    registry
        .insert_file_chooser(
            FileChooserId("chooser-active".into()),
            FileChooserState {
                tab_id: active_tab.clone(),
                owner_session_id: Some("session".into()),
                owner_turn_id: None,
                created_at: SystemTime::now(),
                backend_node_id: 123,
                is_multiple: false,
            },
        )
        .unwrap();

    let observed = HashSet::new();
    let stale = registry
        .reconcile_session_tabs(
            "session",
            &observed,
            "not returned by backend session reconcile",
        )
        .unwrap();
    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0].id, active_tab);
    assert!(registry.get(&active_tab).unwrap().is_none());
    assert!(registry.get(&deliverable_tab).unwrap().is_some());
    assert!(
        registry
            .current_tab_for_session("session")
            .unwrap()
            .is_none()
    );
    assert!(
        registry
            .describe_missing_tab(&active_tab)
            .unwrap()
            .contains("not returned by backend session reconcile")
    );
    assert!(
        registry
            .describe_missing_file_chooser(&FileChooserId("chooser-active".into()))
            .unwrap()
            .contains("not returned by backend session reconcile")
    );
    assert!(
        registry
            .get_session("session")
            .unwrap()
            .unwrap()
            .last_reconciled_at
            .is_some()
    );
    registry
        .mark_session_stale("session", "service worker restart left session unrecovered")
        .unwrap();
    assert!(
        registry
            .get_session("session")
            .unwrap()
            .unwrap()
            .stale_reason
            .as_deref()
            .unwrap()
            .contains("service worker restart")
    );
    let stale_summaries = registry.stale_session_summaries(10).unwrap();
    assert_eq!(stale_summaries.len(), 1);
    assert_eq!(stale_summaries[0].session_id, "session");
    assert!(
        stale_summaries[0]
            .reason
            .contains("service worker restart left session unrecovered")
    );
    let counts = registry.lifecycle_counts().unwrap();
    assert_eq!(counts.sessions, 1);
    assert_eq!(counts.stale_sessions, 1);
    assert_eq!(counts.tabs, 1);
    assert_eq!(counts.deliverable_tabs, 1);
    assert_eq!(counts.stale_tabs, 1);
    assert_eq!(counts.stale_file_choosers, 1);
    let cleared = registry.clear_stale_diagnostics().unwrap();
    assert_eq!(cleared.stale_sessions, 1);
    assert_eq!(cleared.stale_tabs, 1);
    assert_eq!(cleared.stale_file_choosers, 1);
    let counts_after_clear = registry.lifecycle_counts().unwrap();
    assert_eq!(counts_after_clear.sessions, 1);
    assert_eq!(counts_after_clear.stale_sessions, 0);
    assert_eq!(counts_after_clear.tabs, 1);
    assert_eq!(counts_after_clear.deliverable_tabs, 1);
    assert_eq!(counts_after_clear.stale_tabs, 0);
    assert_eq!(counts_after_clear.stale_file_choosers, 0);
    assert!(registry.stale_session_summaries(10).unwrap().is_empty());
    let deliverable_summaries = registry.deliverable_tab_summaries(10).unwrap();
    assert_eq!(deliverable_summaries.len(), 1);
    assert_eq!(deliverable_summaries[0].tab_id, "deliverable");
    assert_eq!(
        deliverable_summaries[0].session_id.as_deref(),
        Some("session")
    );
    assert_eq!(deliverable_summaries[0].url, "https://deliverable.example");
    assert_eq!(deliverable_summaries[0].title, "Deliverable");
}

#[test]
fn current_tab_for_session_falls_back_only_to_active_owned_tabs() {
    let registry = ServiceRegistry::default();
    let insert_tab = |id: &str, status: TabStatus| {
        registry
            .insert(TabRecord {
                id: TabId::new(id),
                session_id: Some("session".into()),
                target_id: format!("target-{id}"),
                url: format!("https://{id}.example"),
                title: id.into(),
                origin: TabOrigin::Agent,
                status,
                attached: false,
                cdp_session_id: None,
            })
            .unwrap();
    };
    insert_tab("handoff", TabStatus::Handoff);
    insert_tab("deliverable", TabStatus::Deliverable);
    insert_tab("active-b", TabStatus::Active);
    insert_tab("active-a", TabStatus::Active);

    registry
        .set_active_tab("session", "active-a", Some("turn-1"))
        .unwrap();
    registry
        .update(&TabId::new("active-a"), |record| {
            record.status = TabStatus::Handoff;
        })
        .unwrap();
    assert_eq!(
        registry
            .current_tab_for_session("session")
            .unwrap()
            .unwrap()
            .id,
        TabId::new("active-b")
    );
    assert_eq!(
        registry
            .get_session("session")
            .unwrap()
            .unwrap()
            .active_tab_id,
        Some(TabId::new("active-a"))
    );
    assert_eq!(
        registry
            .repair_current_tab_for_session("session")
            .unwrap()
            .unwrap()
            .id,
        TabId::new("active-b")
    );
    assert_eq!(
        registry
            .get_session("session")
            .unwrap()
            .unwrap()
            .active_tab_id,
        Some(TabId::new("active-b"))
    );

    registry
        .set_active_tab("session", "active-b", Some("turn-2"))
        .unwrap();
    registry.remove(&TabId::new("active-b")).unwrap();
    assert!(
        registry
            .current_tab_for_session("session")
            .unwrap()
            .is_none()
    );
    assert!(
        registry
            .get_session("session")
            .unwrap()
            .unwrap()
            .active_tab_id
            .is_none()
    );
    assert!(
        registry
            .repair_current_tab_for_session("session")
            .unwrap()
            .is_none()
    );
    assert!(
        registry
            .get_session("session")
            .unwrap()
            .unwrap()
            .active_tab_id
            .is_none()
    );
}

#[test]
fn active_tab_reconciliation_events_include_the_planned_next_active_tab() {
    let registry = ServiceRegistry::default();
    registry.insert(tab_record(TabId::new("active-a"))).unwrap();
    registry.insert(tab_record(TabId::new("active-b"))).unwrap();
    registry
        .set_active_tab("session", "active-a", Some("turn-1"))
        .unwrap();

    let observed = HashSet::from([TabId::new("active-b")]);
    let stale = registry
        .reconcile_session_tabs("session", &observed, "backend omitted active-a")
        .unwrap();

    assert_eq!(stale.len(), 1);
    assert_eq!(
        registry
            .get_session("session")
            .unwrap()
            .unwrap()
            .active_tab_id,
        Some(TabId::new("active-b"))
    );
    let reconciled = registry
        .recent_lifecycle_events(20)
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == RegistryLifecycleEventKind::SessionActiveTabReconciled)
        .collect::<Vec<_>>();
    assert_eq!(reconciled.len(), 1);
    assert_eq!(reconciled[0].tab_id.as_deref(), Some("active-b"));
    assert_eq!(
        reconciled[0].reason.as_deref(),
        Some("session tab reconciliation updated active tab")
    );
}

#[test]
fn direct_active_tab_removal_records_reconciliation_event() {
    let registry = ServiceRegistry::default();
    registry.insert(tab_record(TabId::new("active-a"))).unwrap();
    registry.insert(tab_record(TabId::new("active-b"))).unwrap();
    registry
        .set_active_tab("session", "active-a", Some("turn-1"))
        .unwrap();

    registry.remove(&TabId::new("active-a")).unwrap();

    assert_eq!(
        registry
            .get_session("session")
            .unwrap()
            .unwrap()
            .active_tab_id,
        Some(TabId::new("active-b"))
    );
    let reconciled = registry
        .recent_lifecycle_events(20)
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == RegistryLifecycleEventKind::SessionActiveTabReconciled)
        .collect::<Vec<_>>();
    assert_eq!(reconciled.len(), 1);
    assert_eq!(reconciled[0].tab_id.as_deref(), Some("active-b"));
    assert_eq!(
        reconciled[0].reason.as_deref(),
        Some("active tab was removed from host registry")
    );
}

#[test]
fn repeated_active_tab_assignment_does_not_emit_noop_lifecycle_events() {
    let registry = ServiceRegistry::default();
    registry.insert(tab_record(TabId::new("active"))).unwrap();

    registry
        .set_active_tab("session", "active", Some("turn-1"))
        .unwrap();
    registry
        .set_active_tab("session", "active", Some("turn-2"))
        .unwrap();

    let active_set_events = registry
        .recent_lifecycle_events(20)
        .unwrap()
        .into_iter()
        .filter(|event| event.kind == RegistryLifecycleEventKind::SessionActiveTabSet)
        .collect::<Vec<_>>();
    assert_eq!(active_set_events.len(), 1);
    assert_eq!(active_set_events[0].tab_id.as_deref(), Some("active"));
    assert_eq!(
        registry
            .get_session("session")
            .unwrap()
            .unwrap()
            .current_turn_id
            .as_deref(),
        Some("turn-2")
    );
}

#[test]
fn set_active_tab_rejects_invalid_authority_transitions() {
    let registry = ServiceRegistry::default();
    registry.touch_session("session", Some("turn")).unwrap();
    registry
        .touch_session("other-session", Some("turn"))
        .unwrap();
    registry.insert(tab_record(TabId::new("active"))).unwrap();
    registry
        .insert(TabRecord {
            id: TabId::new("other"),
            session_id: Some("other-session".into()),
            target_id: "target-other".into(),
            url: "https://other.example".into(),
            title: "Other".into(),
            origin: TabOrigin::Agent,
            status: TabStatus::Active,
            attached: false,
            cdp_session_id: None,
        })
        .unwrap();
    registry
        .insert(TabRecord {
            id: TabId::new("handoff"),
            session_id: Some("session".into()),
            target_id: "target-handoff".into(),
            url: "https://handoff.example".into(),
            title: "Handoff".into(),
            origin: TabOrigin::Agent,
            status: TabStatus::Handoff,
            attached: false,
            cdp_session_id: None,
        })
        .unwrap();
    registry
        .insert(TabRecord {
            id: TabId::new("deliverable"),
            session_id: Some("session".into()),
            target_id: "target-deliverable".into(),
            url: "https://deliverable.example".into(),
            title: "Deliverable".into(),
            origin: TabOrigin::Agent,
            status: TabStatus::Deliverable,
            attached: false,
            cdp_session_id: None,
        })
        .unwrap();

    assert!(
        registry
            .set_active_tab("missing-session", "active", Some("turn"))
            .unwrap_err()
            .to_string()
            .contains("missing session")
    );
    assert!(
        registry
            .set_active_tab("session", "missing-tab", Some("turn"))
            .unwrap_err()
            .to_string()
            .contains("missing tab")
    );
    assert!(
        registry
            .set_active_tab("session", "other", Some("turn"))
            .unwrap_err()
            .to_string()
            .contains("does not belong")
    );
    assert!(
        registry
            .set_active_tab("session", "handoff", Some("turn"))
            .unwrap_err()
            .to_string()
            .contains("not actively controlled")
    );
    assert!(
        registry
            .set_active_tab("session", "deliverable", Some("turn"))
            .unwrap_err()
            .to_string()
            .contains("not actively controlled")
    );
    assert!(
        registry
            .set_active_tab("session", "active", Some("turn"))
            .is_ok()
    );
}

#[test]
fn restored_session_tab_clears_stale_diagnostic_without_losing_deliverable() {
    let registry = ServiceRegistry::default();
    let active_tab = TabId::new("active");
    let deliverable_tab = TabId::new("deliverable");

    registry
        .insert(TabRecord {
            id: active_tab.clone(),
            session_id: Some("session".into()),
            target_id: "target-active".into(),
            url: "https://active.example".into(),
            title: "Active".into(),
            origin: TabOrigin::Agent,
            status: TabStatus::Active,
            attached: true,
            cdp_session_id: Some("cdp-active".into()),
        })
        .unwrap();
    registry
        .insert(TabRecord {
            id: deliverable_tab.clone(),
            session_id: Some("session".into()),
            target_id: "target-deliverable".into(),
            url: "https://deliverable.example".into(),
            title: "Deliverable".into(),
            origin: TabOrigin::Agent,
            status: TabStatus::Deliverable,
            attached: false,
            cdp_session_id: None,
        })
        .unwrap();

    let stale = registry
        .reconcile_session_tabs(
            "session",
            &HashSet::new(),
            "service worker restore did not report tab",
        )
        .unwrap();
    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0].id, active_tab);
    assert_eq!(registry.lifecycle_counts().unwrap().stale_tabs, 1);
    assert_eq!(registry.lifecycle_counts().unwrap().deliverable_tabs, 1);

    registry
        .insert(TabRecord {
            id: active_tab.clone(),
            session_id: Some("session".into()),
            target_id: "target-active-restored".into(),
            url: "https://active.example/restored".into(),
            title: "Active Restored".into(),
            origin: TabOrigin::Agent,
            status: TabStatus::Active,
            attached: false,
            cdp_session_id: None,
        })
        .unwrap();

    let counts = registry.lifecycle_counts().unwrap();
    assert_eq!(counts.tabs, 2);
    assert_eq!(counts.stale_tabs, 0);
    assert_eq!(counts.deliverable_tabs, 1);
    let restored = registry.get(&active_tab).unwrap().unwrap();
    assert_eq!(restored.target_id, "target-active-restored");
    assert_eq!(restored.status, TabStatus::Active);
    assert_eq!(
        registry.get(&deliverable_tab).unwrap().unwrap().status,
        TabStatus::Deliverable
    );
}

fn tab_record(id: TabId) -> TabRecord {
    TabRecord {
        id,
        session_id: Some("session".into()),
        target_id: "target".into(),
        url: "https://example.test/".into(),
        title: "Example".into(),
        origin: TabOrigin::Agent,
        status: TabStatus::Active,
        attached: false,
        cdp_session_id: None,
    }
}

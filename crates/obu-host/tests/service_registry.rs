use std::collections::HashSet;
use std::time::SystemTime;

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
fn download_lifecycle_tracks_completion() {
    let registry = ServiceRegistry::default();
    let id = DownloadId("d1".into());
    registry
        .insert_download(
            id.clone(),
            DownloadState {
                tab_id: TabId::new("t1"),
                owner_session_id: Some("session".into()),
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
    let id = FileChooserId("chooser-1".into());
    registry
        .insert_file_chooser(
            id.clone(),
            FileChooserState {
                tab_id: TabId::new("t1"),
                owner_session_id: Some("session".into()),
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
        .insert_file_chooser(
            FileChooserId("chooser-active".into()),
            FileChooserState {
                tab_id: active_tab.clone(),
                owner_session_id: Some("session".into()),
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

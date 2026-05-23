use std::sync::Arc;
use std::time::{Duration, SystemTime};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use obu_host::{
    backends::{BackendRequestContext, BrowserBackend, cdp::CdpBackend},
    error::HostError,
    methods,
    service_registry::{
        DownloadId, DownloadState, FileChooserId, FileChooserState, ServiceRegistry,
    },
    tab_state::{TabId, TabOrigin, TabRecord, TabStatus},
};

fn test_context(session_id: &str) -> BackendRequestContext {
    BackendRequestContext {
        session_id: Some(session_id.into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    }
}

#[tokio::test]
async fn targets_attach_and_execute_cdp_work_against_fake_browser() {
    let (ws_url, mut requests) = spawn_fake_cdp().await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();

    let created = backend
        .create_tab_with_context(&test_context("session"), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap();
    assert_eq!(created["target_id"], "target-1");

    let listed = backend.list_tabs().await.unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["target_id"], "target-1");

    backend.attach(tab_id).await.unwrap();
    let evaluated = backend
        .execute_cdp(
            tab_id,
            "Runtime.evaluate",
            json!({ "expression": "1+1", "returnByValue": true }),
        )
        .await
        .unwrap();
    assert_eq!(evaluated["result"]["value"], 2);

    assert_observed_methods(
        &mut requests,
        &[
            "Browser.setDownloadBehavior",
            "Target.createTarget",
            "Target.getTargets",
            "Target.attachToTarget",
            "Emulation.setFocusEmulationEnabled",
            "Page.enable",
            "Runtime.evaluate",
        ],
    )
    .await;
}

#[tokio::test]
async fn cdp_list_tabs_surfaces_preserved_host_lifecycle_semantics() {
    let (ws_url, _requests) = spawn_fake_cdp().await;
    let registry = Arc::new(ServiceRegistry::default());
    let backend = CdpBackend::connect(&ws_url, registry.clone())
        .await
        .unwrap();
    registry
        .insert(TabRecord {
            id: TabId::new("deliverable"),
            session_id: Some("session".into()),
            target_id: "target-1".into(),
            url: "https://old.example".into(),
            title: "Old".into(),
            origin: TabOrigin::Agent,
            status: TabStatus::Deliverable,
            attached: true,
            cdp_session_id: Some("old-session".into()),
        })
        .unwrap();
    let events_before = registry.recent_lifecycle_events(20).unwrap().len();

    let listed = backend.list_tabs().await.unwrap();

    assert_eq!(listed[0]["id"], "deliverable");
    assert_eq!(listed[0]["origin"], "agent");
    assert_eq!(listed[0]["status"], "deliverable");
    assert_eq!(listed[0]["url"], "about:blank");
    assert_eq!(listed[0]["attached"], false);
    let record = registry.get(&TabId::new("deliverable")).unwrap().unwrap();
    assert_eq!(record.status, TabStatus::Deliverable);
    assert_eq!(record.origin, TabOrigin::Agent);
    assert_eq!(record.url, "https://old.example");
    assert_eq!(record.attached, true);
    assert_eq!(
        registry.recent_lifecycle_events(20).unwrap().len(),
        events_before,
        "CDP getTabs observation must not record registry lifecycle events"
    );
}

#[tokio::test]
async fn cdp_list_tabs_observes_unknown_targets_without_importing_registry_rows() {
    let (ws_url, _requests) = spawn_fake_cdp().await;
    let registry = Arc::new(ServiceRegistry::default());
    let backend = CdpBackend::connect(&ws_url, registry.clone())
        .await
        .unwrap();

    let listed = backend.list_tabs().await.unwrap();

    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["id"], "target-1");
    assert!(
        registry.get(&TabId::new("target-1")).unwrap().is_none(),
        "CDP getTabs observation must not import unknown targets into the host registry"
    );
}

#[tokio::test]
async fn cdp_current_selected_and_resume_use_only_active_session_tabs() {
    let (ws_url, _requests) = spawn_fake_cdp().await;
    let registry = Arc::new(ServiceRegistry::default());
    let backend = CdpBackend::connect(&ws_url, registry.clone())
        .await
        .unwrap();
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };
    registry
        .set_human_takeover("session", Some("turn"), true)
        .unwrap();
    let error = backend
        .turn_ended_with_context(&ctx, json!({}))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("human takeover"));
    registry
        .set_human_takeover("session", Some("turn"), false)
        .unwrap();
    for (tab_id, status) in [
        ("active-b", TabStatus::Active),
        ("active-a", TabStatus::Active),
        ("handoff", TabStatus::Handoff),
        ("deliverable", TabStatus::Deliverable),
    ] {
        registry
            .insert(TabRecord {
                id: TabId::new(tab_id),
                session_id: Some("session".into()),
                target_id: format!("target-{tab_id}"),
                url: format!("https://{tab_id}.example"),
                title: tab_id.into(),
                origin: TabOrigin::Agent,
                status,
                attached: false,
                cdp_session_id: None,
            })
            .unwrap();
    }

    registry
        .set_active_tab("session", "active-b", Some("turn-1"))
        .unwrap();
    let current = backend.current_tab_with_context(&ctx).await.unwrap();
    assert_eq!(current["tab_id"], "active-b");
    assert_eq!(current["logicalActive"], true);
    assert_eq!(current["commandable"], true);

    registry
        .set_active_tab("session", "active-b", Some("turn-2"))
        .unwrap();
    registry
        .update(&TabId::new("active-b"), |record| {
            record.status = TabStatus::Handoff;
        })
        .unwrap();
    let selected = backend.selected_tab_with_context(&ctx).await.unwrap();
    assert_eq!(selected["tab_id"], "active-a");
    assert_eq!(selected["status"], "active");
    assert_eq!(selected["claimRequired"], false);

    let resumed = backend
        .resume_control_with_context(&ctx, json!({}))
        .await
        .unwrap();
    assert_eq!(resumed["tab_id"], "active-a");
    assert_eq!(resumed["commandable"], true);
}

#[tokio::test]
async fn cdp_finalize_tabs_applies_host_owned_lifecycle_semantics() {
    let (ws_url, _requests) = spawn_fake_cdp().await;
    let registry = Arc::new(ServiceRegistry::default());
    let backend = CdpBackend::connect(&ws_url, registry.clone())
        .await
        .unwrap();
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    let agent = backend
        .create_tab_with_context(&ctx, Some("about:blank".into()))
        .await
        .unwrap();
    let agent_id = agent["tab_id"].as_str().unwrap().to_string();
    for (tab_id, origin, status) in [
        ("user", TabOrigin::User, TabStatus::Active),
        ("handoff", TabOrigin::Agent, TabStatus::Active),
        ("deliverable", TabOrigin::Agent, TabStatus::Active),
    ] {
        registry
            .insert(TabRecord {
                id: TabId::new(tab_id),
                session_id: Some("session".into()),
                target_id: format!("target-{tab_id}"),
                url: format!("https://{tab_id}.example"),
                title: tab_id.into(),
                origin,
                status,
                attached: false,
                cdp_session_id: None,
            })
            .unwrap();
    }
    registry
        .insert_file_chooser(
            FileChooserId("chooser-handoff".into()),
            FileChooserState {
                tab_id: TabId::new("handoff"),
                owner_session_id: Some("session".into()),
                created_at: SystemTime::now(),
                backend_node_id: 12,
                is_multiple: false,
            },
        )
        .unwrap();
    registry
        .insert_download(
            DownloadId("download-deliverable".into()),
            DownloadState {
                tab_id: TabId::new("deliverable"),
                owner_session_id: Some("session".into()),
                created_at: SystemTime::now(),
                url: "https://deliverable.example/file".into(),
                suggested_filename: "file.txt".into(),
                guid: "guid-deliverable".into(),
                completed_path: None,
            },
        )
        .unwrap();
    registry
        .set_active_tab("session", "handoff", Some("turn-before-finalize"))
        .unwrap();

    let finalized = backend
        .finalize_tabs_with_context(
            &ctx,
            json!({
                "keep": [
                    { "tab_id": "handoff", "status": "handoff" },
                    { "tab_id": "deliverable", "status": "deliverable" }
                ]
            }),
        )
        .await
        .unwrap();
    assert!(string_array_contains(
        &finalized["closed_tab_ids"],
        &agent_id
    ));
    assert!(string_array_contains(
        &finalized["released_tab_ids"],
        "user"
    ));
    assert!(registry.get(&TabId::new(agent_id)).unwrap().is_none());
    assert!(registry.get(&TabId::new("user")).unwrap().is_none());
    assert_eq!(
        registry
            .get(&TabId::new("handoff"))
            .unwrap()
            .unwrap()
            .status,
        TabStatus::Handoff
    );
    assert_eq!(
        registry
            .get(&TabId::new("deliverable"))
            .unwrap()
            .unwrap()
            .status,
        TabStatus::Deliverable
    );
    assert_eq!(finalized["deliverable_tabs"][0]["status"], "deliverable");
    assert!(
        registry
            .describe_missing_tab(&TabId::new("user"))
            .unwrap()
            .contains("released user tab")
    );
    assert!(
        registry
            .describe_missing_file_chooser(&FileChooserId("chooser-handoff".into()))
            .unwrap()
            .contains("detached, closed, or finalized")
    );
    assert!(
        registry
            .describe_missing_download(&DownloadId("download-deliverable".into()))
            .unwrap()
            .contains("detached, closed, or finalized")
    );
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
}

#[tokio::test]
async fn cdp_claim_user_tab_rejects_tab_owned_by_another_session() {
    let (ws_url, _requests) = spawn_fake_cdp().await;
    let registry = Arc::new(ServiceRegistry::default());
    let backend = CdpBackend::connect(&ws_url, registry.clone())
        .await
        .unwrap();
    registry
        .insert(TabRecord {
            id: TabId::new("owned"),
            session_id: Some("session".into()),
            target_id: "target-owned".into(),
            url: "https://example.com".into(),
            title: "Example".into(),
            origin: TabOrigin::User,
            status: TabStatus::Active,
            attached: false,
            cdp_session_id: None,
        })
        .unwrap();
    let other_ctx = BackendRequestContext {
        session_id: Some("other-session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    let error = backend
        .claim_user_tab_with_context(&other_ctx, "owned")
        .await
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("tab owned is already owned by another open-browser-use session")
    );
    assert_eq!(
        registry
            .get(&TabId::new("owned"))
            .unwrap()
            .unwrap()
            .session_id
            .as_deref(),
        Some("session")
    );
}

#[tokio::test]
async fn cdp_claim_user_tab_allows_reclaiming_deliverable_from_previous_session() {
    let (ws_url, _requests) = spawn_fake_cdp().await;
    let registry = Arc::new(ServiceRegistry::default());
    let backend = CdpBackend::connect(&ws_url, registry.clone())
        .await
        .unwrap();
    registry
        .insert(TabRecord {
            id: TabId::new("deliverable"),
            session_id: Some("previous-session".into()),
            target_id: "target-deliverable".into(),
            url: "https://deliverable.example".into(),
            title: "Deliverable".into(),
            origin: TabOrigin::Agent,
            status: TabStatus::Deliverable,
            attached: false,
            cdp_session_id: None,
        })
        .unwrap();
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    let claimed = backend
        .claim_user_tab_with_context(&ctx, "deliverable")
        .await
        .unwrap();

    assert_eq!(claimed["tab_id"], "deliverable");
    let record = registry.get(&TabId::new("deliverable")).unwrap().unwrap();
    assert_eq!(record.session_id.as_deref(), Some("session"));
    assert_eq!(record.origin, TabOrigin::User);
    assert_eq!(record.status, TabStatus::Active);
}

#[tokio::test]
async fn cdp_rejects_non_active_tab_records_before_direct_operations() {
    let (ws_url, _requests) = spawn_fake_cdp().await;
    let registry = Arc::new(ServiceRegistry::default());
    let backend = CdpBackend::connect(&ws_url, registry.clone())
        .await
        .unwrap();
    for (tab_id, status, attached, session_id) in [
        (
            "handoff",
            TabStatus::Handoff,
            true,
            Some("cdp-session-handoff".to_string()),
        ),
        ("deliverable", TabStatus::Deliverable, false, None),
    ] {
        registry
            .insert(TabRecord {
                id: TabId::new(tab_id),
                session_id: Some("session".into()),
                target_id: format!("target-{tab_id}"),
                url: format!("https://{tab_id}.example"),
                title: tab_id.into(),
                origin: TabOrigin::Agent,
                status,
                attached,
                cdp_session_id: session_id,
            })
            .unwrap();
    }

    let handoff_error = backend
        .execute_cdp("handoff", "Runtime.evaluate", json!({}))
        .await
        .unwrap_err();
    assert!(
        handoff_error
            .to_string()
            .contains("tab handoff is handoff, not actively controlled")
    );

    let deliverable_attach_error = backend.attach("deliverable").await.unwrap_err();
    assert!(
        deliverable_attach_error
            .to_string()
            .contains("tab deliverable is deliverable, not actively controlled")
    );

    let deliverable_close_error = backend
        .tab_command(methods::TAB_CLOSE, json!({ "tab_id": "deliverable" }))
        .await
        .unwrap_err();
    assert!(
        deliverable_close_error
            .to_string()
            .contains("tab deliverable is deliverable, not actively controlled")
    );
    assert!(registry.get(&TabId::new("deliverable")).unwrap().is_some());
}

#[tokio::test]
async fn tab_commands_navigate_and_export_content_against_fake_browser() {
    let (ws_url, mut requests) = spawn_fake_cdp().await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&test_context("session"), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();

    backend
        .tab_command(
            methods::TAB_GOTO,
            json!({ "tab_id": tab_id, "url": "https://example.test/" }),
        )
        .await
        .unwrap();
    let url = backend
        .tab_command(methods::TAB_URL, json!({ "tab_id": tab_id }))
        .await
        .unwrap();
    assert_eq!(url, "https://example.test/");

    let title = backend
        .tab_command(methods::TAB_TITLE, json!({ "tab_id": tab_id }))
        .await
        .unwrap();
    assert_eq!(title, "Example");

    let html = backend
        .tab_command(
            methods::TAB_CONTENT_EXPORT,
            json!({ "tab_id": tab_id, "format": "html" }),
        )
        .await
        .unwrap();
    assert_eq!(html["mime_type"], "text/html");
    assert!(html["data_base64"].as_str().unwrap().len() > 8);

    let screenshot = backend
        .tab_command(methods::TAB_SCREENSHOT, json!({ "tab_id": tab_id }))
        .await
        .unwrap();
    assert_eq!(screenshot["mime_type"], "image/png");
    assert_eq!(screenshot["data_base64"], "iVBORw0KGgo=");

    let pdf = backend
        .tab_command(
            methods::TAB_CONTENT_EXPORT,
            json!({ "tab_id": tab_id, "format": "pdf" }),
        )
        .await
        .unwrap();
    assert_eq!(pdf["mime_type"], "application/pdf");

    backend
        .tab_command(methods::TAB_CLOSE, json!({ "tab_id": tab_id }))
        .await
        .unwrap();
    assert!(
        backend
            .registry()
            .get(&TabId::new(&tab_id))
            .unwrap()
            .is_none()
    );

    assert_observed_methods(
        &mut requests,
        &[
            "Browser.setDownloadBehavior",
            "Target.createTarget",
            "Target.attachToTarget",
            "Emulation.setFocusEmulationEnabled",
            "Page.enable",
            "Page.navigate",
            "Page.enable",
            "Runtime.evaluate",
            "Page.enable",
            "Runtime.evaluate",
            "Page.enable",
            "Runtime.evaluate",
            "Page.enable",
            "Runtime.evaluate",
            "Page.enable",
            "Runtime.evaluate",
            "Page.enable",
            "Runtime.evaluate",
            "Page.captureScreenshot",
            "Page.printToPDF",
            "Page.enable",
            "Page.close",
        ],
    )
    .await;
}

#[tokio::test]
async fn execute_cdp_requires_attach() {
    let (ws_url, _requests) = spawn_fake_cdp().await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&test_context("session"), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap();

    let err = backend
        .execute_cdp(tab_id, "Runtime.evaluate", json!({ "expression": "1+1" }))
        .await
        .unwrap_err();
    assert!(matches!(err, HostError::TabNotAttached(_)));
}

#[tokio::test]
async fn cdp_goto_accepts_beforeunload_dialog() {
    let (ws_url, mut requests) = spawn_fake_cdp_with_dialog("Page.navigate", "beforeunload").await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(
            &BackendRequestContext {
                session_id: Some("session".into()),
                turn_id: Some("turn".into()),
                client_timeout_ms: None,
            },
            Some("about:blank".into()),
        )
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();

    backend
        .tab_command(
            methods::TAB_GOTO,
            json!({ "tab_id": tab_id, "url": "https://example.test/next" }),
        )
        .await
        .unwrap();

    let diagnostics = backend.diagnostics();
    assert_eq!(
        diagnostics["dialogs"]["recent"][0]["code"],
        "dialog_handled"
    );
    assert_eq!(
        diagnostics["dialogs"]["recent"][0]["dialog_type"],
        "beforeunload"
    );
    assert_eq!(
        diagnostics["dialogs"]["recent"][0]["default_action"],
        "accept"
    );
    assert_eq!(diagnostics["dialogs"]["recent"][0]["outcome"], "continued");
    let handle = recv_until_method(&mut requests, "Page.handleJavaScriptDialog").await;
    assert_eq!(handle["params"]["accept"], true);
}

#[tokio::test]
async fn cdp_reload_uses_page_reload_dialog_policy_for_beforeunload() {
    let (ws_url, mut requests) =
        spawn_fake_cdp_with_sessionless_dialog("Page.reload", "beforeunload").await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(
            &BackendRequestContext {
                session_id: Some("session".into()),
                turn_id: Some("turn".into()),
                client_timeout_ms: None,
            },
            Some("about:blank".into()),
        )
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();

    backend
        .tab_command(methods::TAB_RELOAD, json!({ "tab_id": tab_id }))
        .await
        .unwrap();

    let diagnostics = backend.diagnostics();
    assert_eq!(
        diagnostics["dialogs"]["recent"][0]["code"],
        "dialog_handled"
    );
    assert_eq!(
        diagnostics["dialogs"]["recent"][0]["dialog_type"],
        "beforeunload"
    );
    assert_eq!(
        diagnostics["dialogs"]["recent"][0]["default_action"],
        "accept"
    );
    assert_eq!(diagnostics["dialogs"]["recent"][0]["outcome"], "continued");
    let reload = recv_until_method(&mut requests, "Page.reload").await;
    assert_eq!(reload["params"], json!({}));
    let handle = recv_until_method(&mut requests, "Page.handleJavaScriptDialog").await;
    assert_eq!(handle["params"]["accept"], true);
}

#[tokio::test]
async fn cdp_dialog_policy_reenables_page_after_tab_reattach() {
    let (ws_url, mut requests) = spawn_fake_cdp_with_dialog("Page.navigate", "beforeunload").await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };
    let created = backend
        .create_tab_with_context(&ctx, Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();

    backend.attach(&tab_id).await.unwrap();
    backend.detach(&tab_id).await.unwrap();
    backend.attach(&tab_id).await.unwrap();
    backend
        .tab_command(
            methods::TAB_GOTO,
            json!({ "tab_id": tab_id, "url": "https://example.test/after-reattach" }),
        )
        .await
        .unwrap();

    let mut methods = Vec::new();
    let mut handle_request = None;
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while let Some(request) = requests.recv().await {
            let method = request["method"].as_str().unwrap().to_string();
            if method == "Page.handleJavaScriptDialog" {
                handle_request = Some(request);
                break;
            }
            methods.push(method);
        }
    })
    .await
    .expect("timed out waiting for dialog handling after reattach");

    assert_eq!(
        methods,
        vec![
            "Browser.setDownloadBehavior",
            "Target.createTarget",
            "Target.attachToTarget",
            "Emulation.setFocusEmulationEnabled",
            "Target.detachFromTarget",
            "Target.attachToTarget",
            "Emulation.setFocusEmulationEnabled",
            "Page.enable",
            "Page.navigate",
        ]
    );
    assert_eq!(
        handle_request.expect("expected Page.handleJavaScriptDialog")["params"]["accept"],
        true
    );
}

#[tokio::test]
async fn cdp_goto_dismisses_confirm_dialog_with_structured_error() {
    let (ws_url, mut requests) = spawn_fake_cdp_with_dialog("Page.navigate", "confirm").await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };
    let created = backend
        .create_tab_with_context(&ctx, Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();

    let error = backend
        .tab_command(
            methods::TAB_GOTO,
            json!({ "tab_id": tab_id, "url": "https://example.test/next" }),
        )
        .await
        .unwrap_err();
    let HostError::DialogRequiresDecision(dialog) = error else {
        panic!("expected dialog_requires_decision error");
    };
    assert_eq!(dialog.data["code"], "dialog_requires_decision");
    assert_eq!(dialog.data["session_id"], "session");
    assert_eq!(dialog.data["dialog_type"], "confirm");
    assert_eq!(dialog.data["default_action"], "dismiss");

    let diagnostics = backend.diagnostics();
    assert_eq!(
        diagnostics["dialogs"]["recent"][0]["code"],
        "dialog_requires_decision"
    );
    assert_eq!(
        diagnostics["dialogs"]["recent"][0]["dialog_type"],
        "confirm"
    );
    assert_eq!(
        diagnostics["dialogs"]["recent"][0]["default_action"],
        "dismiss"
    );
    assert_eq!(diagnostics["dialogs"]["recent"][0]["outcome"], "failed");
    let handle = recv_until_method(&mut requests, "Page.handleJavaScriptDialog").await;
    assert_eq!(handle["params"]["accept"], false);
}

#[tokio::test]
async fn cdp_runtime_evaluate_accepts_alert_dialog() {
    assert_runtime_evaluate_dialog_accepted("alert").await;
}

#[tokio::test]
async fn cdp_runtime_evaluate_accepts_beforeunload_dialog() {
    assert_runtime_evaluate_dialog_accepted("beforeunload").await;
}

#[tokio::test]
async fn cdp_runtime_evaluate_dismisses_confirm_dialog_with_structured_error() {
    assert_runtime_evaluate_dialog_requires_decision("confirm").await;
}

#[tokio::test]
async fn cdp_runtime_evaluate_dismisses_prompt_dialog_with_structured_error() {
    assert_runtime_evaluate_dialog_requires_decision("prompt").await;
}

#[tokio::test]
async fn cdp_close_accepts_beforeunload_dialog() {
    let (ws_url, mut requests) = spawn_fake_cdp_with_dialog("Page.close", "beforeunload").await;
    let registry = Arc::new(ServiceRegistry::default());
    let backend = CdpBackend::connect(&ws_url, registry.clone())
        .await
        .unwrap();
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };
    let created = backend
        .create_tab_with_context(&ctx, Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();

    backend
        .tab_command(methods::TAB_CLOSE, json!({ "tab_id": tab_id }))
        .await
        .unwrap();

    assert!(registry.get(&TabId::new(&tab_id)).unwrap().is_none());
    let handle = recv_until_method(&mut requests, "Page.handleJavaScriptDialog").await;
    assert_eq!(handle["params"]["accept"], true);
}

#[tokio::test]
async fn cdp_finalize_accepts_beforeunload_dialog_for_omitted_agent_tab() {
    let (ws_url, mut requests) = spawn_fake_cdp_with_dialog("Page.close", "beforeunload").await;
    let registry = Arc::new(ServiceRegistry::default());
    let backend = CdpBackend::connect(&ws_url, registry.clone())
        .await
        .unwrap();
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };
    let created = backend
        .create_tab_with_context(&ctx, Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();

    let finalized = backend
        .finalize_tabs_with_context(&ctx, json!({ "keep": [] }))
        .await
        .unwrap();

    assert_eq!(finalized["closed_tab_ids"], json!([tab_id]));
    assert!(registry.get(&TabId::new(&tab_id)).unwrap().is_none());
    let diagnostics = backend.diagnostics();
    assert_eq!(
        diagnostics["dialogs"]["recent"][0]["dialog_type"],
        "beforeunload"
    );
    assert_eq!(
        diagnostics["dialogs"]["recent"][0]["default_action"],
        "accept"
    );
    assert_eq!(diagnostics["dialogs"]["recent"][0]["outcome"], "continued");
    let close = recv_until_method(&mut requests, "Page.close").await;
    assert!(close.get("sessionId").is_some());
    let handle = recv_until_method(&mut requests, "Page.handleJavaScriptDialog").await;
    assert_eq!(handle["params"]["accept"], true);
}

#[tokio::test]
async fn cua_click_dispatches_raw_cdp_mouse_events() {
    let (ws_url, mut requests) = spawn_fake_cdp().await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&test_context("session"), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();

    backend
        .cua_command(
            methods::CUA_CLICK,
            json!({ "tab_id": tab_id, "x": 10, "y": 20 }),
        )
        .await
        .unwrap();

    assert_observed_methods(
        &mut requests,
        &[
            "Browser.setDownloadBehavior",
            "Target.createTarget",
            "Target.attachToTarget",
            "Emulation.setFocusEmulationEnabled",
            "Page.enable",
            "Input.dispatchMouseEvent",
            "Input.dispatchMouseEvent",
            "Input.dispatchMouseEvent",
        ],
    )
    .await;
}

#[tokio::test]
async fn cdp_dom_cua_uses_dom_snapshot_and_coordinate_input() {
    let (ws_url, mut requests) = spawn_fake_cdp().await;
    let ctx = test_context("session");
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&ctx, Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach_with_context(&ctx, &tab_id).await.unwrap();

    let dom = backend
        .cua_command_with_context(
            &ctx,
            methods::DOM_CUA_GET_VISIBLE_DOM,
            json!({ "tab_id": tab_id, "format": "compact_text" }),
        )
        .await
        .unwrap();
    assert_eq!(dom["nodes"][0]["node_id"], "101");
    assert!(
        dom["text"]
            .as_str()
            .unwrap()
            .contains(r#"<button node_id=101 aria-label="Submit">Submit</button>"#)
    );

    backend
        .cua_command_with_context(
            &ctx,
            methods::DOM_CUA_CLICK,
            json!({ "tab_id": tab_id, "node_id": "101", "modifiers": ["Shift"] }),
        )
        .await
        .unwrap();

    let mouse = recv_until_method(&mut requests, "Input.dispatchMouseEvent").await;
    assert_eq!(mouse["params"]["x"], 20.0);
    assert_eq!(mouse["params"]["y"], 30.0);
    assert_eq!(mouse["params"]["modifiers"], 8);
}

#[tokio::test]
async fn cdp_dom_cua_scopes_node_ids_to_observation_snapshots() {
    let (ws_url, mut requests) = spawn_fake_cdp().await;
    let ctx = test_context("session");
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&ctx, Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach_with_context(&ctx, &tab_id).await.unwrap();

    let dom = backend
        .cua_command_with_context(
            &ctx,
            methods::DOM_CUA_GET_VISIBLE_DOM,
            json!({
                "tab_id": tab_id,
                "format": "compact_text",
                "observation_id": "obs-1"
            }),
        )
        .await
        .unwrap();
    assert_eq!(dom["observation_id"], "obs-1");
    assert_eq!(dom["nodes"][0]["node_id"], "101");

    let missing_observation = backend
        .cua_command_with_context(
            &ctx,
            methods::DOM_CUA_CLICK,
            json!({ "tab_id": tab_id, "node_id": "101" }),
        )
        .await
        .unwrap_err();
    assert!(
        missing_observation
            .to_string()
            .contains("current visible DOM snapshot")
    );

    let wrong_observation = backend
        .cua_command_with_context(
            &ctx,
            methods::DOM_CUA_CLICK,
            json!({ "tab_id": tab_id, "node_id": "101", "observation_id": "obs-2" }),
        )
        .await
        .unwrap_err();
    assert!(
        wrong_observation
            .to_string()
            .contains("current visible DOM snapshot")
    );

    let clicked = backend
        .cua_command_with_context(
            &ctx,
            methods::DOM_CUA_CLICK,
            json!({ "tab_id": tab_id, "node_id": "101", "observation_id": "obs-1" }),
        )
        .await
        .unwrap();
    assert_eq!(clicked["point"]["x"], 20.0);
    assert_eq!(clicked["point"]["y"], 30.0);

    let mouse = recv_until_method(&mut requests, "Input.dispatchMouseEvent").await;
    assert_eq!(mouse["params"]["x"], 20.0);
    assert_eq!(mouse["params"]["y"], 30.0);

    let consumed_observation = backend
        .cua_command_with_context(
            &ctx,
            methods::DOM_CUA_CLICK,
            json!({ "tab_id": tab_id, "node_id": "101", "observation_id": "obs-1" }),
        )
        .await
        .unwrap_err();
    assert!(
        consumed_observation
            .to_string()
            .contains("current visible DOM snapshot")
    );
}

#[tokio::test]
async fn cdp_dom_cua_actions_return_resolved_action_points() {
    let (ws_url, _requests) = spawn_fake_cdp().await;
    let ctx = test_context("session");
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&ctx, Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach_with_context(&ctx, &tab_id).await.unwrap();

    for (index, (method, mut params)) in [
        (
            methods::DOM_CUA_SCROLL,
            json!({ "tab_id": tab_id.clone(), "node_id": "101", "deltaY": 120 }),
        ),
        (
            methods::DOM_CUA_TYPE,
            json!({ "tab_id": tab_id.clone(), "node_id": "101", "text": "hello" }),
        ),
        (
            methods::DOM_CUA_KEYPRESS,
            json!({ "tab_id": tab_id.clone(), "node_id": "101", "key": "Enter" }),
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let observation_id = format!("obs-{index}");
        backend
            .cua_command_with_context(
                &ctx,
                methods::DOM_CUA_GET_VISIBLE_DOM,
                json!({ "tab_id": tab_id.clone(), "observation_id": observation_id.clone() }),
            )
            .await
            .unwrap();
        params["observation_id"] = json!(observation_id);
        let result = backend
            .cua_command_with_context(&ctx, method, params.clone())
            .await
            .unwrap();
        assert_eq!(result["node_id"], "101", "{method} must preserve node id");
        assert_eq!(result["point"]["x"], 20.0, "{method} must return x");
        assert_eq!(result["point"]["y"], 30.0, "{method} must return y");
        assert_eq!(
            result["point"]["coordinateSpace"], "visualViewport",
            "{method} must return viewport coordinate space"
        );
        let consumed = backend
            .cua_command_with_context(&ctx, method, params)
            .await
            .unwrap_err();
        assert!(
            consumed
                .to_string()
                .contains("current visible DOM snapshot"),
            "{method} must consume observation-scoped DOM-CUA snapshots"
        );
    }
}

#[tokio::test]
async fn cua_click_waits_for_navigation_when_requested() {
    let (ws_url, mut requests) = spawn_fake_cdp().await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&test_context("session"), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();

    backend
        .cua_command(
            methods::CUA_CLICK,
            json!({
                "tab_id": tab_id,
                "x": 10,
                "y": 20,
                "wait_for_navigation": true,
                "navigation_wait_until": "domcontentloaded",
                "navigation_timeout_ms": 500
            }),
        )
        .await
        .unwrap();

    assert_observed_methods(
        &mut requests,
        &[
            "Browser.setDownloadBehavior",
            "Target.createTarget",
            "Target.attachToTarget",
            "Emulation.setFocusEmulationEnabled",
            "Page.enable",
            "Input.dispatchMouseEvent",
            "Input.dispatchMouseEvent",
            "Input.dispatchMouseEvent",
            "Page.enable",
            "Runtime.evaluate",
        ],
    )
    .await;
}

#[tokio::test]
async fn cua_commands_validate_payloads_and_dispatch_expected_input_events() {
    let (ws_url, mut requests) = spawn_fake_cdp().await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&test_context("session"), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();

    assert_observed_methods(
        &mut requests,
        &[
            "Browser.setDownloadBehavior",
            "Target.createTarget",
            "Target.attachToTarget",
            "Emulation.setFocusEmulationEnabled",
        ],
    )
    .await;

    backend
        .cua_command(
            methods::CUA_KEYPRESS,
            json!({
                "tab_id": tab_id,
                "key": "x",
                "modifiers": ["Alt", "Control", "Meta", "Shift"]
            }),
        )
        .await
        .unwrap();
    let key_down = recv_until_method(&mut requests, "Input.dispatchKeyEvent").await;
    assert_eq!(key_down["method"], "Input.dispatchKeyEvent");
    assert_eq!(key_down["params"]["type"], "keyDown");
    assert_eq!(key_down["params"]["key"], "X");
    assert_eq!(key_down["params"]["text"], "");
    assert_eq!(key_down["params"]["unmodifiedText"], "");
    assert_eq!(key_down["params"]["modifiers"], 15);
    let key_up = recv_until_method(&mut requests, "Input.dispatchKeyEvent").await;
    assert_eq!(key_up["params"]["type"], "keyUp");
    assert_eq!(key_up["params"]["modifiers"], 15);

    backend
        .cua_command(
            methods::CUA_KEYPRESS,
            json!({
                "tab_id": tab_id,
                "key": "v",
                "modifiers": ["ControlOrMeta"]
            }),
        )
        .await
        .unwrap();
    let primary_mask = if cfg!(target_os = "macos") { 4 } else { 2 };
    let primary_down = recv_until_method(&mut requests, "Input.dispatchKeyEvent").await;
    assert_eq!(primary_down["params"]["modifiers"], primary_mask);
    let primary_up = recv_until_method(&mut requests, "Input.dispatchKeyEvent").await;
    assert_eq!(primary_up["params"]["modifiers"], primary_mask);

    backend
        .cua_command(
            methods::CUA_TYPE,
            json!({ "tab_id": tab_id, "text": "typed" }),
        )
        .await
        .unwrap();
    let insert = recv_until_method(&mut requests, "Input.insertText").await;
    assert_eq!(insert["method"], "Input.insertText");
    assert_eq!(insert["params"]["text"], "typed");

    backend
        .cua_command(
            methods::CUA_SCROLL,
            json!({ "tab_id": tab_id, "x": 10, "y": 20, "deltaX": 3, "deltaY": -4 }),
        )
        .await
        .unwrap();
    let scroll_move = recv_until_method(&mut requests, "Input.dispatchMouseEvent").await;
    assert_eq!(scroll_move["method"], "Input.dispatchMouseEvent");
    assert_eq!(scroll_move["params"]["type"], "mouseMoved");
    assert_eq!(scroll_move["params"]["x"], 10.0);
    assert_eq!(scroll_move["params"]["y"], 20.0);
    let gesture = requests.recv().await.unwrap();
    assert_eq!(gesture["method"], "Input.synthesizeScrollGesture");
    assert_eq!(gesture["params"]["x"], 10.0);
    assert_eq!(gesture["params"]["y"], 20.0);
    assert_eq!(gesture["params"]["xDistance"], -3.0);
    assert_eq!(gesture["params"]["yDistance"], 4.0);
    assert_eq!(gesture["params"]["gestureSourceType"], "mouse");
    assert_eq!(gesture["params"]["preventFling"], true);
    assert_eq!(gesture["params"]["speed"], 8000);

    backend
        .cua_command(
            methods::CUA_DRAG,
            json!({
                "tab_id": tab_id,
                "from": { "x": 0, "y": 1 },
                "to": { "x": 10, "y": 11 },
                "steps": 2
            }),
        )
        .await
        .unwrap();
    let drag_types = [
        "mouseMoved",
        "mousePressed",
        "mouseMoved",
        "mouseMoved",
        "mouseReleased",
    ];
    for event_type in drag_types {
        let event = recv_until_method(&mut requests, "Input.dispatchMouseEvent").await;
        assert_eq!(event["method"], "Input.dispatchMouseEvent");
        assert_eq!(event["params"]["type"], event_type);
    }

    backend
        .cua_command(
            methods::CUA_MOVE,
            json!({ "tab_id": tab_id, "x": 99, "y": 100 }),
        )
        .await
        .unwrap();
    let moved = recv_until_method(&mut requests, "Input.dispatchMouseEvent").await;
    assert_eq!(moved["params"]["type"], "mouseMoved");
    assert_eq!(moved["params"]["x"], 99.0);
    assert_eq!(moved["params"]["y"], 100.0);
}

#[tokio::test]
async fn cdp_cua_input_sequences_enable_page_once_per_command() {
    let (ws_url, mut requests) = spawn_fake_cdp().await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&test_context("session"), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();

    assert_observed_methods(
        &mut requests,
        &[
            "Browser.setDownloadBehavior",
            "Target.createTarget",
            "Target.attachToTarget",
            "Emulation.setFocusEmulationEnabled",
        ],
    )
    .await;

    backend
        .cua_command(
            methods::CUA_KEYPRESS,
            json!({ "tab_id": tab_id, "key": "x" }),
        )
        .await
        .unwrap();
    assert_observed_methods(
        &mut requests,
        &[
            "Page.enable",
            "Input.dispatchKeyEvent",
            "Input.dispatchKeyEvent",
        ],
    )
    .await;

    backend
        .cua_command(
            methods::CUA_SCROLL,
            json!({ "tab_id": tab_id, "x": 10, "y": 20, "deltaX": 3, "deltaY": -4 }),
        )
        .await
        .unwrap();
    assert_observed_methods(
        &mut requests,
        &[
            "Page.enable",
            "Input.dispatchMouseEvent",
            "Input.synthesizeScrollGesture",
        ],
    )
    .await;

    backend
        .cua_command(
            methods::CUA_DRAG,
            json!({
                "tab_id": tab_id,
                "from": { "x": 0, "y": 1 },
                "to": { "x": 10, "y": 11 },
                "steps": 2
            }),
        )
        .await
        .unwrap();
    assert_observed_methods(
        &mut requests,
        &[
            "Page.enable",
            "Input.dispatchMouseEvent",
            "Input.dispatchMouseEvent",
            "Input.dispatchMouseEvent",
            "Input.dispatchMouseEvent",
            "Input.dispatchMouseEvent",
        ],
    )
    .await;
}

#[tokio::test]
async fn cdp_drag_releases_mouse_when_move_fails() {
    let (ws_url, mut requests) = spawn_fake_cdp_with_drag_move_failure().await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&test_context("session"), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();

    let error = backend
        .cua_command(
            methods::CUA_DRAG,
            json!({
                "tab_id": tab_id,
                "path": [
                    { "x": 0, "y": 0 },
                    { "x": 10, "y": 10 },
                    { "x": 20, "y": 20 }
                ]
            }),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("synthetic drag move failure"));

    let mut mouse_events = Vec::new();
    while mouse_events.len() < 4 {
        let request = requests.recv().await.unwrap();
        if request["method"] == "Input.dispatchMouseEvent" {
            mouse_events.push(request["params"].clone());
        }
    }
    assert_eq!(
        mouse_events
            .iter()
            .map(|params| params["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["mouseMoved", "mousePressed", "mouseMoved", "mouseReleased"]
    );
    assert_eq!(mouse_events.last().unwrap()["buttons"], 0);
}

#[tokio::test]
async fn cdp_scroll_falls_back_to_mouse_wheel_when_synthesized_gesture_fails() {
    let (ws_url, mut requests) = spawn_fake_cdp_with_scroll_gesture_failure().await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&test_context("session"), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();

    backend
        .cua_command(
            methods::CUA_SCROLL,
            json!({ "tab_id": tab_id, "x": 10, "y": 20, "deltaX": 3, "deltaY": -4 }),
        )
        .await
        .unwrap();

    let mut observed = Vec::new();
    while observed.len() < 3 {
        let request = requests.recv().await.unwrap();
        if request["method"] == "Input.synthesizeScrollGesture"
            || request["method"] == "Input.dispatchMouseEvent"
        {
            observed.push(request);
        }
    }
    assert_eq!(observed[0]["method"], "Input.dispatchMouseEvent");
    assert_eq!(observed[0]["params"]["type"], "mouseMoved");
    assert_eq!(observed[1]["method"], "Input.synthesizeScrollGesture");
    assert_eq!(observed[2]["method"], "Input.dispatchMouseEvent");
    assert_eq!(observed[2]["params"]["type"], "mouseWheel");
    assert_eq!(observed[2]["params"]["deltaX"], 3.0);
    assert_eq!(observed[2]["params"]["deltaY"], -4.0);
}

#[tokio::test]
async fn cdp_modified_scroll_uses_mouse_wheel_without_synthesized_gesture() {
    let (ws_url, mut requests) = spawn_fake_cdp().await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&test_context("session"), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();

    backend
        .cua_command(
            methods::CUA_SCROLL,
            json!({
                "tab_id": tab_id,
                "x": 10,
                "y": 20,
                "deltaX": 3,
                "deltaY": -4,
                "modifiers": ["Shift"]
            }),
        )
        .await
        .unwrap();

    let mut observed = Vec::new();
    while observed.len() < 2 {
        let request = requests.recv().await.unwrap();
        if request["method"] == "Input.synthesizeScrollGesture"
            || request["method"] == "Input.dispatchMouseEvent"
        {
            observed.push(request);
        }
    }
    assert_eq!(observed[0]["method"], "Input.dispatchMouseEvent");
    assert_eq!(observed[0]["params"]["type"], "mouseMoved");
    assert_eq!(observed[0]["params"]["modifiers"], 8);
    assert_eq!(observed[1]["method"], "Input.dispatchMouseEvent");
    assert_eq!(observed[1]["params"]["type"], "mouseWheel");
    assert_eq!(observed[1]["params"]["modifiers"], 8);
    assert_eq!(observed[1]["params"]["deltaX"], 3.0);
    assert_eq!(observed[1]["params"]["deltaY"], -4.0);

    let next = tokio::time::timeout(Duration::from_millis(50), requests.recv()).await;
    assert!(
        next.is_err(),
        "modified scroll should not enqueue a synthesized gesture"
    );
}

#[tokio::test]
async fn cua_commands_reject_malformed_coordinates_drag_paths_and_tab_ids() {
    let (ws_url, _requests) = spawn_fake_cdp().await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&test_context("session"), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();

    let missing_tab = backend
        .cua_command(methods::CUA_CLICK, json!({ "x": 1, "y": 2 }))
        .await
        .unwrap_err();
    assert!(missing_tab.to_string().contains("missing tab_id"));

    let bad_x = backend
        .cua_command(
            methods::CUA_CLICK,
            json!({ "tab_id": tab_id, "x": "bad", "y": 2 }),
        )
        .await
        .unwrap_err();
    assert!(bad_x.to_string().contains("missing x"));

    let bad_drag = backend
        .cua_command(
            methods::CUA_DRAG,
            json!({ "tab_id": tab_id, "from": { "x": 0, "y": 0 } }),
        )
        .await
        .unwrap_err();
    assert!(bad_drag.to_string().contains("missing drag path/to"));
}

#[tokio::test]
async fn playwright_click_routes_through_injected_runtime_and_cua() {
    let (ws_url, mut requests) = spawn_fake_cdp().await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&test_context("session"), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();

    backend
        .playwright_command(
            methods::PLAYWRIGHT_LOCATOR_CLICK,
            json!({
                "tab_id": tab_id,
                "selector": "#button",
                "timeout_ms": 500,
            }),
        )
        .await
        .unwrap();

    assert_observed_methods(
        &mut requests,
        &[
            "Browser.setDownloadBehavior",
            "Target.createTarget",
            "Target.attachToTarget",
            "Emulation.setFocusEmulationEnabled",
            "Page.enable",
            "Runtime.evaluate",
            "Page.enable",
            "Runtime.evaluate",
            "Page.enable",
            "Input.dispatchMouseEvent",
            "Input.dispatchMouseEvent",
            "Input.dispatchMouseEvent",
        ],
    )
    .await;
}

#[tokio::test]
async fn playwright_fill_uses_shared_text_input_fallback() {
    let (ws_url, mut requests) = spawn_fake_cdp().await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&test_context("session"), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();
    assert_observed_methods(
        &mut requests,
        &[
            "Browser.setDownloadBehavior",
            "Target.createTarget",
            "Target.attachToTarget",
            "Emulation.setFocusEmulationEnabled",
        ],
    )
    .await;

    backend
        .playwright_command(
            methods::PLAYWRIGHT_LOCATOR_FILL,
            json!({
                "tab_id": tab_id,
                "selector": "#field",
                "value": "typed fallback",
            }),
        )
        .await
        .unwrap();

    let _injection_probe = requests.recv().await.unwrap();
    assert_eq!(_injection_probe["method"], "Page.enable");
    let _injection_probe = requests.recv().await.unwrap();
    assert_eq!(_injection_probe["method"], "Runtime.evaluate");
    let _fill_policy = requests.recv().await.unwrap();
    assert_eq!(_fill_policy["method"], "Page.enable");
    let fill_eval = requests.recv().await.unwrap();
    assert_eq!(fill_eval["method"], "Runtime.evaluate");
    assert!(
        fill_eval["params"]["expression"]
            .as_str()
            .unwrap()
            .contains("injected.fill")
    );
    let insert = requests.recv().await.unwrap();
    assert_eq!(insert["method"], "Input.insertText");
    assert_eq!(insert["params"]["text"], "typed fallback");
}

#[tokio::test]
async fn playwright_press_uses_shared_focus_runtime_before_keyboard_events() {
    let (ws_url, mut requests) = spawn_fake_cdp().await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&test_context("session"), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();
    assert_observed_methods(
        &mut requests,
        &[
            "Browser.setDownloadBehavior",
            "Target.createTarget",
            "Target.attachToTarget",
            "Emulation.setFocusEmulationEnabled",
        ],
    )
    .await;

    backend
        .playwright_command(
            methods::PLAYWRIGHT_LOCATOR_PRESS,
            json!({
                "tab_id": tab_id,
                "selector": "#field",
                "key": "a",
            }),
        )
        .await
        .unwrap();

    let _injection_policy = requests.recv().await.unwrap();
    assert_eq!(_injection_policy["method"], "Page.enable");
    let _injection_probe = requests.recv().await.unwrap();
    assert_eq!(_injection_probe["method"], "Runtime.evaluate");
    let _focus_policy = requests.recv().await.unwrap();
    assert_eq!(_focus_policy["method"], "Page.enable");
    let focus_eval = requests.recv().await.unwrap();
    assert_eq!(focus_eval["method"], "Runtime.evaluate");
    let expression = focus_eval["params"]["expression"].as_str().unwrap();
    assert!(expression.contains("evaluateOnSelector"));
    assert!(expression.contains("focusNode"));
    assert!(expression.contains(r#""retargetInput":false"#));
    assert!(expression.contains(r#""states":["visible","enabled"]"#));

    let key_down = requests.recv().await.unwrap();
    assert_eq!(key_down["method"], "Input.dispatchKeyEvent");
    assert_eq!(key_down["params"]["type"], "keyDown");
    assert_eq!(key_down["params"]["key"], "a");
    let key_up = requests.recv().await.unwrap();
    assert_eq!(key_up["method"], "Input.dispatchKeyEvent");
    assert_eq!(key_up["params"]["type"], "keyUp");
}

#[tokio::test]
async fn playwright_locator_click_forwards_navigation_wait_to_cua() {
    let (ws_url, mut requests) = spawn_fake_cdp().await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&test_context("session"), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();

    backend
        .playwright_command(
            methods::PLAYWRIGHT_LOCATOR_CLICK,
            json!({
                "tab_id": tab_id,
                "selector": "#button",
                "timeout_ms": 500,
                "wait_for_navigation": true,
                "navigation_wait_until": "domcontentloaded",
                "navigation_timeout_ms": 750,
            }),
        )
        .await
        .unwrap();

    assert_observed_methods(
        &mut requests,
        &[
            "Browser.setDownloadBehavior",
            "Target.createTarget",
            "Target.attachToTarget",
            "Emulation.setFocusEmulationEnabled",
            "Page.enable",
            "Runtime.evaluate",
            "Page.enable",
            "Runtime.evaluate",
            "Page.enable",
            "Input.dispatchMouseEvent",
            "Input.dispatchMouseEvent",
            "Input.dispatchMouseEvent",
            "Page.enable",
            "Runtime.evaluate",
        ],
    )
    .await;
}

#[tokio::test]
async fn playwright_wait_states_and_action_point_failures_are_encoded() {
    let (ws_url, _requests) = spawn_fake_cdp().await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&test_context("session"), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();

    for state in ["visible", "hidden", "attached", "detached"] {
        backend
            .playwright_command(
                methods::PLAYWRIGHT_LOCATOR_WAIT_FOR,
                json!({
                    "tab_id": tab_id,
                    "selector": "#button",
                    "state": state,
                    "timeout_ms": 10,
                }),
            )
            .await
            .unwrap();
    }

    let unsupported = backend
        .playwright_command(
            methods::PLAYWRIGHT_LOCATOR_WAIT_FOR,
            json!({
                "tab_id": tab_id,
                "selector": "#button",
                "state": "editable",
            }),
        )
        .await
        .unwrap_err();
    assert!(
        unsupported
            .to_string()
            .contains("unsupported waitFor state editable")
    );

    let strict = backend
        .playwright_command(
            methods::PLAYWRIGHT_LOCATOR_CLICK,
            json!({
                "tab_id": tab_id,
                "selector": "#strict",
                "timeout_ms": 10,
            }),
        )
        .await
        .unwrap_err();
    assert!(strict.to_string().contains("strict mode violation"));
}

#[tokio::test]
async fn file_chooser_wait_returns_handle_and_set_files_uses_backend_node() {
    let (ws_url, mut requests) = spawn_fake_cdp().await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&test_context("session"), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();

    let handle = backend
        .playwright_command_with_context(
            &test_context("session"),
            methods::PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER,
            json!({ "tab_id": tab_id, "timeout_ms": 500 }),
        )
        .await
        .unwrap();
    let file_chooser_id = handle["file_chooser_id"].as_str().unwrap().to_string();
    assert_eq!(handle["is_multiple"], true);

    backend
        .playwright_command_with_context(
            &test_context("session"),
            methods::PLAYWRIGHT_FILE_CHOOSER_SET_FILES,
            json!({ "file_chooser_id": file_chooser_id, "files": ["/tmp/upload.txt"] }),
        )
        .await
        .unwrap();

    assert_observed_methods(
        &mut requests,
        &[
            "Browser.setDownloadBehavior",
            "Target.createTarget",
            "Target.attachToTarget",
            "Emulation.setFocusEmulationEnabled",
            "Page.enable",
            "DOM.enable",
            "Page.setInterceptFileChooserDialog",
            "Page.setInterceptFileChooserDialog",
            "DOM.setFileInputFiles",
        ],
    )
    .await;
}

#[tokio::test]
async fn cdp_wait_for_download_ignores_unrelated_frame_event() {
    let (ws_url, _requests) = spawn_fake_cdp_with_download_events(vec![
        json!({
            "method": "Browser.downloadWillBegin",
            "params": {
                "guid": "unrelated-download",
                "frameId": "other-frame",
                "url": "https://other.example/file.txt",
                "suggestedFilename": "other.txt"
            }
        }),
        json!({
            "method": "Browser.downloadWillBegin",
            "params": {
                "guid": "download-guid",
                "frameId": "child-frame",
                "url": "https://example.test/file.txt",
                "suggestedFilename": "file.txt"
            }
        }),
    ])
    .await;
    let registry = Arc::new(ServiceRegistry::default());
    let backend = CdpBackend::connect(&ws_url, registry.clone())
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&test_context("session"), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    let download = backend
        .playwright_command_with_context(
            &ctx,
            methods::PLAYWRIGHT_WAIT_FOR_DOWNLOAD,
            json!({ "tab_id": tab_id, "timeout_ms": 1000 }),
        )
        .await
        .unwrap();

    assert_eq!(download["download_id"], "download-guid");
    assert!(
        registry
            .get_download(&DownloadId("unrelated-download".into()))
            .unwrap()
            .is_none()
    );
    let state = registry
        .get_download(&DownloadId("download-guid".into()))
        .unwrap()
        .unwrap();
    assert_eq!(state.tab_id.0, tab_id);
    assert_eq!(state.owner_session_id.as_deref(), Some("session"));
}

#[tokio::test]
async fn cdp_download_path_rejects_canceled_progress_without_timing_out() {
    let (ws_url, _requests) = spawn_fake_cdp_with_download_events(vec![
        json!({
            "method": "Browser.downloadWillBegin",
            "params": {
                "guid": "download-guid",
                "frameId": "child-frame",
                "url": "https://example.test/file.txt",
                "suggestedFilename": "file.txt"
            }
        }),
        json!({
            "method": "Browser.downloadProgress",
            "params": {
                "guid": "download-guid",
                "state": "canceled"
            }
        }),
    ])
    .await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&test_context("session"), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    let download = backend
        .playwright_command_with_context(
            &ctx,
            methods::PLAYWRIGHT_WAIT_FOR_DOWNLOAD,
            json!({ "tab_id": tab_id, "timeout_ms": 1000 }),
        )
        .await
        .unwrap();
    let error = backend
        .playwright_command_with_context(
            &ctx,
            methods::PLAYWRIGHT_DOWNLOAD_PATH,
            json!({
                "tab_id": tab_id,
                "download_id": download["download_id"],
                "timeout_ms": 1000
            }),
        )
        .await
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("download download-guid was canceled")
    );
}

#[tokio::test]
async fn cdp_file_chooser_rejects_wrong_session_without_consuming() {
    let (ws_url, mut requests) = spawn_fake_cdp().await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&test_context("session"), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();
    let owner_ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };
    let other_ctx = BackendRequestContext {
        session_id: Some("other-session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    let handle = backend
        .playwright_command_with_context(
            &owner_ctx,
            methods::PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER,
            json!({ "tab_id": tab_id, "timeout_ms": 500 }),
        )
        .await
        .unwrap();
    let file_chooser_id = handle["file_chooser_id"].as_str().unwrap().to_string();

    let wrong_session = backend
        .playwright_command_with_context(
            &other_ctx,
            methods::PLAYWRIGHT_FILE_CHOOSER_SET_FILES,
            json!({ "file_chooser_id": file_chooser_id, "files": ["/tmp/upload.txt"] }),
        )
        .await
        .unwrap_err();
    assert!(
        wrong_session
            .to_string()
            .contains("belongs to session session, not other-session")
    );
    let wrong_tab = backend
        .playwright_command_with_context(
            &owner_ctx,
            methods::PLAYWRIGHT_FILE_CHOOSER_SET_FILES,
            json!({ "tab_id": "wrong-tab", "file_chooser_id": file_chooser_id, "files": ["/tmp/upload.txt"] }),
        )
        .await
        .unwrap_err();
    assert!(
        wrong_tab
            .to_string()
            .contains(&format!("belongs to tab {tab_id}, not wrong-tab"))
    );

    backend
        .playwright_command_with_context(
            &owner_ctx,
            methods::PLAYWRIGHT_FILE_CHOOSER_SET_FILES,
            json!({ "tab_id": tab_id, "file_chooser_id": file_chooser_id, "files": ["/tmp/upload.txt"] }),
        )
        .await
        .unwrap();
    let consumed = backend
        .playwright_command_with_context(
            &owner_ctx,
            methods::PLAYWRIGHT_FILE_CHOOSER_SET_FILES,
            json!({ "file_chooser_id": file_chooser_id, "files": ["/tmp/upload.txt"] }),
        )
        .await
        .unwrap_err();
    assert!(
        consumed
            .to_string()
            .contains("already consumed by setFiles")
    );

    while let Some(request) = requests.recv().await {
        if request["method"] == "DOM.setFileInputFiles" {
            assert_eq!(request["params"]["backendNodeId"], 3);
            return;
        }
    }
    panic!("DOM.setFileInputFiles was not observed");
}

async fn spawn_fake_cdp() -> (String, mpsc::Receiver<Value>) {
    spawn_fake_cdp_inner(false, false, None, None).await
}

async fn spawn_fake_cdp_with_drag_move_failure() -> (String, mpsc::Receiver<Value>) {
    spawn_fake_cdp_inner(true, false, None, None).await
}

async fn spawn_fake_cdp_with_scroll_gesture_failure() -> (String, mpsc::Receiver<Value>) {
    spawn_fake_cdp_inner(false, true, None, None).await
}

async fn spawn_fake_cdp_with_dialog(
    method: &'static str,
    dialog_type: &'static str,
) -> (String, mpsc::Receiver<Value>) {
    spawn_fake_cdp_inner(
        false,
        false,
        Some(FakeDialog {
            method,
            dialog_type,
            include_session_id: true,
        }),
        None,
    )
    .await
}

async fn assert_runtime_evaluate_dialog_requires_decision(dialog_type: &'static str) {
    let (ws_url, mut requests) = spawn_fake_cdp_with_dialog("Runtime.evaluate", dialog_type).await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(
            &BackendRequestContext {
                session_id: Some("session".into()),
                turn_id: Some("turn".into()),
                client_timeout_ms: None,
            },
            Some("about:blank".into()),
        )
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();

    let error = backend
        .execute_cdp(
            &tab_id,
            "Runtime.evaluate",
            json!({ "expression": "1+1", "returnByValue": true }),
        )
        .await
        .unwrap_err();
    let HostError::DialogRequiresDecision(dialog) = error else {
        panic!("expected dialog_requires_decision error");
    };
    assert_eq!(dialog.data["code"], "dialog_requires_decision");
    assert_eq!(dialog.data["session_id"], "session");
    assert_eq!(dialog.data["operation"], "Runtime.evaluate");
    assert_eq!(dialog.data["dialog_type"], dialog_type);
    assert_eq!(dialog.data["default_action"], "dismiss");
    let handle = recv_until_method(&mut requests, "Page.handleJavaScriptDialog").await;
    assert_eq!(handle["params"]["accept"], false);
}

async fn assert_runtime_evaluate_dialog_accepted(dialog_type: &'static str) {
    let (ws_url, mut requests) = spawn_fake_cdp_with_dialog("Runtime.evaluate", dialog_type).await;
    let backend = CdpBackend::connect(&ws_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(
            &BackendRequestContext {
                session_id: Some("session".into()),
                turn_id: Some("turn".into()),
                client_timeout_ms: None,
            },
            Some("about:blank".into()),
        )
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();

    let evaluated = backend
        .execute_cdp(
            &tab_id,
            "Runtime.evaluate",
            json!({ "expression": "1+1", "returnByValue": true }),
        )
        .await
        .unwrap();
    assert_eq!(evaluated["result"]["value"], 2);
    let handle = recv_until_method(&mut requests, "Page.handleJavaScriptDialog").await;
    assert_eq!(handle["params"]["accept"], true);
}

async fn spawn_fake_cdp_with_sessionless_dialog(
    method: &'static str,
    dialog_type: &'static str,
) -> (String, mpsc::Receiver<Value>) {
    spawn_fake_cdp_inner(
        false,
        false,
        Some(FakeDialog {
            method,
            dialog_type,
            include_session_id: false,
        }),
        None,
    )
    .await
}

#[derive(Clone, Copy)]
struct FakeDialog {
    method: &'static str,
    dialog_type: &'static str,
    include_session_id: bool,
}

async fn spawn_fake_cdp_with_download_events(
    events: Vec<Value>,
) -> (String, mpsc::Receiver<Value>) {
    spawn_fake_cdp_inner(false, false, None, Some(events)).await
}

async fn spawn_fake_cdp_inner(
    fail_first_drag_move: bool,
    fail_scroll_gesture: bool,
    dialog: Option<FakeDialog>,
    download_events: Option<Vec<Value>>,
) -> (String, mpsc::Receiver<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, rx) = mpsc::channel(64);
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
        let mut failed_drag_move = false;
        let mut download_events = download_events;
        while let Some(message) = ws.next().await {
            let message = message.unwrap();
            let text = match message {
                Message::Text(text) => text.to_string(),
                Message::Binary(bytes) => String::from_utf8(bytes.to_vec()).unwrap(),
                Message::Close(_) => break,
                Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
            };
            let request: Value = serde_json::from_str(&text).unwrap();
            let _ = tx.send(request.clone()).await;
            let id = request["id"].as_u64().unwrap();
            let method = request["method"].as_str().unwrap();
            let params = request.get("params").unwrap_or(&Value::Null);
            let should_fail_drag_move = fail_first_drag_move
                && !failed_drag_move
                && method == "Input.dispatchMouseEvent"
                && params["type"] == "mouseMoved"
                && params["buttons"] == 1;
            let should_fail_scroll_gesture =
                fail_scroll_gesture && method == "Input.synthesizeScrollGesture";
            if let Some(dialog) = dialog
                && method == dialog.method
            {
                let mut event = json!({
                    "method": "Page.javascriptDialogOpening",
                    "params": {
                        "type": dialog.dialog_type,
                        "message": "Dialog message"
                    },
                });
                if dialog.include_session_id {
                    event["sessionId"] = request["sessionId"].clone();
                }
                ws.send(Message::Text(event.to_string().into()))
                    .await
                    .unwrap();
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            let response = if should_fail_drag_move {
                failed_drag_move = true;
                json!({
                    "id": id,
                    "error": { "code": -32000, "message": "synthetic drag move failure" }
                })
            } else if should_fail_scroll_gesture {
                json!({
                    "id": id,
                    "error": { "code": -32000, "message": "synthetic scroll gesture failure" }
                })
            } else {
                let result = fake_result(method, params);
                json!({ "id": id, "result": result })
            };
            ws.send(Message::Text(response.to_string().into()))
                .await
                .unwrap();
            if method == "Page.getFrameTree"
                && let Some(events) = download_events.take()
            {
                for (index, event) in events.into_iter().enumerate() {
                    if index > 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                    }
                    ws.send(Message::Text(event.to_string().into()))
                        .await
                        .unwrap();
                }
            }
            if method == "Page.setInterceptFileChooserDialog"
                && request["params"]["enabled"].as_bool() == Some(true)
            {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                let event = json!({
                    "method": "Page.fileChooserOpened",
                    "sessionId": request["sessionId"],
                    "params": {
                        "backendNodeId": 3,
                        "mode": "selectMultiple",
                    },
                });
                ws.send(Message::Text(event.to_string().into()))
                    .await
                    .unwrap();
            }
            if method == "Input.dispatchMouseEvent" && params["type"] == "mouseReleased" {
                let event = json!({
                    "method": "Page.frameNavigated",
                    "sessionId": request["sessionId"],
                    "params": {
                        "frame": {
                            "id": "frame-1",
                            "url": "https://example.test/next"
                        }
                    },
                });
                ws.send(Message::Text(event.to_string().into()))
                    .await
                    .unwrap();
            }
        }
    });
    (format!("ws://{addr}/devtools/browser/fake"), rx)
}

fn fake_result(method: &str, params: &Value) -> Value {
    match method {
        "Browser.setDownloadBehavior"
        | "Target.getBrowserContexts"
        | "Emulation.setFocusEmulationEnabled"
        | "Target.detachFromTarget"
        | "Page.enable"
        | "DOM.scrollIntoViewIfNeeded"
        | "Page.handleJavaScriptDialog"
        | "DOM.enable"
        | "Page.setInterceptFileChooserDialog"
        | "DOM.setFileInputFiles"
        | "Page.close"
        | "Page.reload"
        | "Page.navigateToHistoryEntry"
        | "Input.synthesizeScrollGesture"
        | "Input.dispatchMouseEvent"
        | "Input.dispatchKeyEvent"
        | "Input.insertText" => json!({}),
        "Target.createTarget" => json!({ "targetId": "target-1" }),
        "Target.getTargets" => json!({
            "targetInfos": [
                {
                    "targetId": "target-1",
                    "type": "page",
                    "url": "about:blank",
                    "title": "Example",
                    "attached": false
                },
                { "targetId": "worker-1", "type": "service_worker" }
            ]
        }),
        "Target.attachToTarget" => json!({ "sessionId": "session-1" }),
        "Runtime.evaluate" => fake_evaluate_result(
            params
                .get("expression")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
        "Page.navigate" => json!({ "frameId": "frame-1" }),
        "Page.getFrameTree" => json!({
            "frameTree": {
                "frame": { "id": "frame-1" },
                "childFrames": [
                    { "frame": { "id": "child-frame" } }
                ]
            }
        }),
        "Page.getNavigationHistory" => json!({
            "currentIndex": 0,
            "entries": [{ "id": 1, "url": "about:blank" }, { "id": 2, "url": "https://example.test/" }]
        }),
        "Page.captureScreenshot" => json!({ "data": "iVBORw0KGgo=" }),
        "Page.getLayoutMetrics" => json!({
            "cssVisualViewport": {
                "pageX": 0,
                "pageY": 0,
                "clientWidth": 800,
                "clientHeight": 600
            }
        }),
        "DOM.getDocument" => json!({
            "root": {
                "nodeName": "HTML",
                "nodeType": 1,
                "backendNodeId": 100,
                "children": [
                    {
                        "nodeName": "BUTTON",
                        "nodeType": 1,
                        "backendNodeId": 101,
                        "attributes": ["aria-label", "Submit"],
                        "children": [
                            {
                                "nodeName": "#text",
                                "nodeType": 3,
                                "nodeValue": "Submit",
                                "backendNodeId": 102
                            }
                        ]
                    }
                ]
            }
        }),
        "DOM.getBoxModel" => {
            let backend_node_id = params
                .get("backendNodeId")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            match backend_node_id {
                101 => json!({
                    "model": {
                        "content": [10, 20, 30, 20, 30, 40, 10, 40],
                        "border": [10, 20, 30, 20, 30, 40, 10, 40]
                    }
                }),
                _ => json!({
                    "model": {
                        "content": [0, 0, 0, 0, 0, 0, 0, 0],
                        "border": [0, 0, 0, 0, 0, 0, 0, 0]
                    }
                }),
            }
        }
        "DOM.getContentQuads" => json!({
            "quads": [[10, 20, 30, 20, 30, 40, 10, 40]]
        }),
        "Page.printToPDF" => json!({ "data": "JVBERi0=" }),
        "Target.closeTarget" => json!({ "success": true }),
        other => json!({ "unexpectedMethod": other }),
    }
}

fn fake_evaluate_result(expression: &str) -> Value {
    if expression.contains("window.__obuPlaywrightRuntime.resolveActionPoint(\"#strict\"") {
        return json!({
            "exceptionDetails": {
                "text": "strict mode violation: locator resolved to two elements"
            }
        });
    }
    let value = if expression.contains("window.__obuPlaywrightRuntime.resolveActionPoint(") {
        json!({ "x": 10, "y": 20 })
    } else if expression.contains("window.__obuPlaywrightRuntime.evaluateOnSelectorAll(")
        && expression.contains("elements.length")
    {
        json!(1)
    } else if expression.contains("window.__obuPlaywrightRuntime.evaluateOnSelectorAll(") {
        json!(true)
    } else if expression.contains("window.__obuPlaywrightRuntime.evaluateOnSelector(")
        && expression.contains("getBoundingClientRect")
    {
        json!({ "x": 10, "y": 20, "width": 30, "height": 40 })
    } else if expression.contains("window.__obuPlaywrightRuntime.evaluateOnSelector(")
        && expression.contains("injected.fill")
    {
        json!("needsinput")
    } else if expression.contains("window.__obuPlaywrightRuntime.evaluateOnSelector(")
        && expression.contains("textContent")
    {
        json!("hello")
    } else if expression.contains("window.__obuPlaywrightRuntime.evaluateOnSelector(") {
        json!("done")
    } else if expression.contains("window.__obuPlaywrightRuntime.evaluateOnPage(") {
        json!("snapshot")
    } else if expression.contains("__obuPlaywrightRuntime")
        || expression.contains("__obuPlaywrightInjected")
    {
        json!(true)
    } else if expression.contains("1+1") {
        json!(2)
    } else if expression.contains("document.readyState") {
        json!("complete")
    } else if expression.contains("location.href") {
        json!("https://example.test/")
    } else if expression.contains("document.title") {
        json!("Example")
    } else if expression.contains("outerHTML") {
        json!("<html><body>Example</body></html>")
    } else {
        Value::Null
    };
    json!({ "result": { "type": js_type(&value), "value": value } })
}

fn js_type(value: &Value) -> &'static str {
    match value {
        Value::String(_) => "string",
        Value::Number(_) => "number",
        Value::Bool(_) => "boolean",
        Value::Null => "undefined",
        Value::Array(_) | Value::Object(_) => "object",
    }
}

fn string_array_contains(value: &Value, expected: &str) -> bool {
    value
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .any(|value| value == expected)
        })
        .unwrap_or(false)
}

async fn assert_observed_methods(rx: &mut mpsc::Receiver<Value>, methods: &[&str]) {
    for expected in methods {
        let request = rx.recv().await.unwrap();
        assert_eq!(request["method"], *expected, "request = {request}");
    }
}

async fn recv_until_method(rx: &mut mpsc::Receiver<Value>, method: &str) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while let Some(request) = rx.recv().await {
            if request["method"] == method {
                return request;
            }
        }
        panic!("request channel closed before observing {method}");
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {method}"))
}

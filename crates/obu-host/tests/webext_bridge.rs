use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use async_trait::async_trait;
use serde_json::{Value, json};

use obu_host::{
    backends::{
        BackendRequestContext, BrowserBackend,
        webext::{ExtensionTransport, WebExtensionBackend},
    },
    error::{HostError, Result},
    service_registry::{DownloadId, DownloadState, FileChooserId, FileChooserState},
    tab_state::{TabId, TabOrigin, TabRecord, TabStatus},
};

#[tokio::test]
async fn webext_backend_normalizes_extension_tab_dtos() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone());
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: Some(1234),
    };

    let created = backend
        .create_tab_with_context(&ctx, Some("https://example.com".into()))
        .await
        .unwrap();
    assert_eq!(created["id"], "42");
    assert_eq!(created["tab_id"], "42");
    assert_eq!(created["url"], "https://example.com");

    let listed = backend.list_tabs_with_context(&ctx).await.unwrap();
    assert_eq!(listed[0]["id"], "42");
    assert_eq!(
        backend
            .registry()
            .get_session("session")
            .unwrap()
            .unwrap()
            .current_turn_id
            .as_deref(),
        Some("turn")
    );

    let calls = transport.calls.lock().unwrap();
    assert_eq!(calls[0].0, "createTab");
    assert_eq!(calls[0].1["session_id"], "session");
    assert_eq!(calls[0].1["turn_id"], "turn");
    assert_eq!(calls[0].1["timeoutMs"], 1234);
}

#[tokio::test]
async fn webext_backend_reconciles_session_tabs_missing_after_get_tabs() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport);
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };
    let stale_tab = TabId::new("99");
    backend
        .registry()
        .insert(TabRecord {
            id: stale_tab.clone(),
            session_id: Some("session".into()),
            target_id: "99".into(),
            url: "https://stale.example".into(),
            title: "Stale".into(),
            origin: TabOrigin::Agent,
            status: TabStatus::Active,
            attached: true,
            cdp_session_id: None,
        })
        .unwrap();
    backend
        .registry()
        .insert_file_chooser(
            FileChooserId("chooser-stale".into()),
            FileChooserState {
                tab_id: stale_tab.clone(),
                owner_session_id: Some("session".into()),
                created_at: SystemTime::now(),
                backend_node_id: 4,
                is_multiple: false,
            },
        )
        .unwrap();

    let listed = backend.list_tabs_with_context(&ctx).await.unwrap();
    assert_eq!(listed[0]["id"], "42");
    assert!(backend.registry().get(&stale_tab).unwrap().is_none());
    assert!(
        backend
            .registry()
            .describe_missing_tab(&stale_tab)
            .unwrap()
            .contains("not returned by WebExtension getTabs")
    );
    assert!(
        backend
            .registry()
            .describe_missing_file_chooser(&FileChooserId("chooser-stale".into()))
            .unwrap()
            .contains("not returned by WebExtension getTabs")
    );
}

#[tokio::test]
async fn webext_backend_preserves_host_tab_lifecycle_when_get_tabs_omits_state() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport);
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };
    let deliverable_tab = TabId::new("42");
    backend
        .registry()
        .insert(TabRecord {
            id: deliverable_tab.clone(),
            session_id: Some("session".into()),
            target_id: "42".into(),
            url: "https://old-deliverable.example".into(),
            title: "Old Deliverable".into(),
            origin: TabOrigin::User,
            status: TabStatus::Deliverable,
            attached: false,
            cdp_session_id: None,
        })
        .unwrap();

    backend.list_tabs_with_context(&ctx).await.unwrap();

    let record = backend.registry().get(&deliverable_tab).unwrap().unwrap();
    assert_eq!(record.origin, TabOrigin::User);
    assert_eq!(record.status, TabStatus::Deliverable);
    assert_eq!(record.url, "https://example.com");
    assert_eq!(
        backend
            .registry()
            .lifecycle_counts()
            .unwrap()
            .deliverable_tabs,
        1
    );
    let diagnostics = backend.diagnostics();
    assert_eq!(
        diagnostics["lifecycle"]["deliverable_tab_summaries"][0]["tab_id"],
        "42"
    );
    assert_eq!(
        diagnostics["lifecycle"]["deliverable_tab_summaries"][0]["session_id"],
        "session"
    );
    assert_eq!(
        diagnostics["lifecycle"]["deliverable_tab_summaries"][0]["url"],
        "https://example.com"
    );
    assert_eq!(
        diagnostics["lifecycle"]["deliverable_tab_summaries"][0]["title"],
        "Example"
    );
}

#[tokio::test]
async fn webext_backend_rehydrates_deliverables_from_get_tabs_side_channel() {
    let transport = Arc::new(GetTabsWithDeliverableTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport);
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    let listed = backend.list_tabs_with_context(&ctx).await.unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["id"], "42");

    let active_record = backend.registry().get(&TabId::new("42")).unwrap().unwrap();
    assert_eq!(active_record.status, TabStatus::Active);
    let deliverable_record = backend.registry().get(&TabId::new("8")).unwrap().unwrap();
    assert_eq!(deliverable_record.status, TabStatus::Deliverable);
    assert_eq!(deliverable_record.url, "https://deliverable.example");
    assert_eq!(
        backend
            .registry()
            .lifecycle_counts()
            .unwrap()
            .deliverable_tabs,
        1
    );
}

#[tokio::test]
async fn webext_backend_rejects_non_decimal_tab_ids() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport);
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    let error = backend
        .execute_cdp_with_context(&ctx, "target-abc", "Runtime.evaluate", json!({}))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("must be decimal"));
}

#[tokio::test]
async fn webext_backend_normalizes_user_tabs_history_and_finalize() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone());
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    let user_tabs = backend.list_user_tabs_with_context(&ctx).await.unwrap();
    assert_eq!(user_tabs[0]["id"], "7");

    let claimed = backend
        .claim_user_tab_with_context(&ctx, "7")
        .await
        .unwrap();
    assert_eq!(claimed["tab_id"], "7");
    let claimed_record = backend.registry().get(&TabId::new("7")).unwrap().unwrap();
    assert_eq!(claimed_record.origin, TabOrigin::User);
    assert_eq!(claimed_record.status, TabStatus::Active);

    let history = backend
        .get_user_history_with_context(&ctx, json!({ "query": "example", "limit": 3 }))
        .await
        .unwrap();
    assert_eq!(history[0]["url"], "https://example.com");
    backend
        .registry()
        .insert(TabRecord {
            id: TabId::new("8"),
            session_id: Some("session".into()),
            target_id: "8".into(),
            url: "https://deliverable.example".into(),
            title: "Deliverable".into(),
            origin: TabOrigin::Agent,
            status: TabStatus::Active,
            attached: false,
            cdp_session_id: None,
        })
        .unwrap();
    backend
        .registry()
        .insert_file_chooser(
            FileChooserId("chooser-handoff".into()),
            FileChooserState {
                tab_id: TabId::new("7"),
                owner_session_id: Some("session".into()),
                created_at: SystemTime::now(),
                backend_node_id: 3,
                is_multiple: false,
            },
        )
        .unwrap();
    backend
        .registry()
        .insert_download(
            DownloadId("download-deliverable".into()),
            DownloadState {
                tab_id: TabId::new("8"),
                owner_session_id: Some("session".into()),
                created_at: SystemTime::now(),
                url: "https://deliverable.example/file".into(),
                suggested_filename: "file.txt".into(),
                guid: "guid-deliverable".into(),
                completed_path: None,
            },
        )
        .unwrap();

    let finalized = backend
        .finalize_tabs_with_context(
            &ctx,
            json!({ "keep": [{ "tab_id": "7", "status": "handoff" }] }),
        )
        .await
        .unwrap();
    assert_eq!(finalized["closed_tab_ids"][0], "42");
    assert_eq!(finalized["released_tab_ids"][0], "9");
    assert_eq!(finalized["kept_tabs"][0]["id"], "7");
    assert_eq!(finalized["deliverable_tabs"][0]["id"], "8");
    assert!(backend.registry().get(&TabId::new("42")).unwrap().is_none());
    let handoff_record = backend.registry().get(&TabId::new("7")).unwrap().unwrap();
    assert_eq!(handoff_record.status, TabStatus::Handoff);
    let deliverable_record = backend.registry().get(&TabId::new("8")).unwrap().unwrap();
    assert_eq!(deliverable_record.status, TabStatus::Deliverable);
    assert!(
        backend
            .registry()
            .describe_missing_file_chooser(&FileChooserId("chooser-handoff".into()))
            .unwrap()
            .contains("detached, closed, or finalized")
    );
    assert!(
        backend
            .registry()
            .describe_missing_download(&DownloadId("download-deliverable".into()))
            .unwrap()
            .contains("detached, closed, or finalized")
    );

    let calls = transport.calls.lock().unwrap();
    let finalize = calls
        .iter()
        .find(|(method, _)| method == "finalizeTabs")
        .unwrap();
    assert_eq!(finalize.1["keep"][0]["tabId"], 7);
    assert!(finalize.1["keep"][0].get("tab_id").is_none());
}

#[tokio::test]
async fn webext_backend_rejects_claim_for_tab_owned_by_another_session() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone());
    backend
        .registry()
        .insert(TabRecord {
            id: TabId::new("7"),
            session_id: Some("session".into()),
            target_id: "7".into(),
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
        .claim_user_tab_with_context(&other_ctx, "007")
        .await
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("tab 7 is already owned by another open-browser-use session")
    );
    assert_eq!(
        backend
            .registry()
            .get(&TabId::new("7"))
            .unwrap()
            .unwrap()
            .session_id
            .as_deref(),
        Some("session")
    );
    let calls = transport.calls.lock().unwrap();
    assert!(!calls.iter().any(|(method, _)| method == "claimUserTab"));
}

#[tokio::test]
async fn webext_backend_allows_reclaiming_deliverable_from_previous_session() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone());
    backend
        .registry()
        .insert(TabRecord {
            id: TabId::new("7"),
            session_id: Some("previous-session".into()),
            target_id: "7".into(),
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
        .claim_user_tab_with_context(&ctx, "7")
        .await
        .unwrap();

    assert_eq!(claimed["tab_id"], "7");
    let record = backend.registry().get(&TabId::new("7")).unwrap().unwrap();
    assert_eq!(record.session_id.as_deref(), Some("session"));
    assert_eq!(record.origin, TabOrigin::User);
    assert_eq!(record.status, TabStatus::Active);
    let calls = transport.calls.lock().unwrap();
    assert!(calls.iter().any(|(method, _)| method == "claimUserTab"));
}

#[tokio::test]
async fn webext_backend_routes_tab_cua_and_clipboard_via_execute_cdp() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone());
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    let url = backend
        .tab_command_with_context(&ctx, "tab_url", json!({ "tab_id": "42" }))
        .await
        .unwrap();
    assert_eq!(url, "https://example.com");

    backend
        .cua_command_with_context(
            &ctx,
            "cua_click",
            json!({ "tab_id": "42", "x": 10, "y": 20 }),
        )
        .await
        .unwrap();

    let text = backend
        .tab_command_with_context(&ctx, "tab_clipboard_read_text", json!({ "tab_id": "42" }))
        .await
        .unwrap();
    assert_eq!(text["text"], "clipboard");

    let calls = transport.calls.lock().unwrap();
    assert!(calls.iter().any(|(method, params)| {
        method == "moveMouse"
            && params["tabId"] == 42
            && params["x"].as_f64() == Some(10.0)
            && params["y"].as_f64() == Some(20.0)
            && params["waitForArrival"] == true
    }));
    let execute_methods = calls
        .iter()
        .filter(|(method, _)| method == "executeCdp")
        .map(|(_, params)| params["method"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert!(execute_methods.contains(&"Runtime.evaluate".to_string()));
    assert!(execute_methods.contains(&"Input.dispatchMouseEvent".to_string()));
    assert!(execute_methods.contains(&"Page.addScriptToEvaluateOnNewDocument".to_string()));
}

#[tokio::test]
async fn webext_backend_cua_click_waits_for_navigation_when_requested() {
    let transport = Arc::new(NavigatingFakeTransport::default());
    let backend =
        Arc::new(WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone()));
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    backend
        .cua_command_with_context(
            &ctx,
            "cua_click",
            json!({
                "tab_id": "42",
                "x": 10,
                "y": 20,
                "wait_for_navigation": true,
                "navigation_wait_until": "load",
                "navigation_timeout_ms": 500
            }),
        )
        .await
        .unwrap();

    let calls = transport.calls.lock().unwrap();
    let execute_methods = calls
        .iter()
        .filter(|(method, _)| method == "executeCdp")
        .map(|(_, params)| params["method"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(execute_methods[0], "Runtime.evaluate");
    assert!(execute_methods.contains(&"Input.dispatchMouseEvent".to_string()));
    assert_eq!(execute_methods.last().unwrap(), "Runtime.evaluate");
}

#[derive(Default)]
struct NavigatingFakeTransport {
    calls: Mutex<Vec<(String, Value)>>,
    mouse_released: Mutex<bool>,
}

#[async_trait]
impl ExtensionTransport for NavigatingFakeTransport {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.calls
            .lock()
            .unwrap()
            .push((method.to_string(), params.clone()));
        if method == "executeCdp" {
            if params["method"] == "Input.dispatchMouseEvent"
                && params["commandParams"]["type"] == "mouseReleased"
            {
                *self.mouse_released.lock().unwrap() = true;
            }
            if params["method"] == "Runtime.evaluate"
                && params["commandParams"]["expression"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("location.href")
            {
                let url = if *self.mouse_released.lock().unwrap() {
                    "https://example.com/next"
                } else {
                    "https://example.com"
                };
                return Ok(json!({ "result": { "value": url } }));
            }
        }
        Ok(match method {
            "executeCdp" => fake_cdp_response(&params),
            _ => Value::Null,
        })
    }
}

#[tokio::test]
async fn webext_backend_scroll_uses_script_fallback_without_cdp_input() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone());
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    backend
        .cua_command_with_context(
            &ctx,
            "cua_scroll",
            json!({ "tab_id": "42", "x": 10, "y": 20, "deltaX": 3, "deltaY": -4 }),
        )
        .await
        .unwrap();

    let calls = transport.calls.lock().unwrap();
    let execute = calls
        .iter()
        .filter(|(method, _)| method == "executeCdp")
        .map(|(_, params)| params)
        .collect::<Vec<_>>();
    assert_eq!(execute.len(), 1);
    assert_eq!(execute[0]["method"], "Runtime.evaluate");
    let expression = execute[0]["commandParams"]["expression"].as_str().unwrap();
    assert!(expression.contains("document.elementFromPoint(x, y)"));
    assert!(expression.contains("node.scrollBy"));
    assert!(expression.contains("window.scrollBy"));
}

#[tokio::test]
async fn webext_backend_supports_rich_clipboard_wire_items() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone());
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    let read = backend
        .tab_command_with_context(&ctx, "tab_clipboard_read", json!({ "tab_id": "42" }))
        .await
        .unwrap();
    assert_eq!(read["items"][0]["entries"][0]["mime_type"], "text/plain");
    assert_eq!(read["items"][0]["entries"][1]["text"], "<b>plain</b>");
    assert_eq!(read["items"][0]["entries"][2]["base64"], "iVBORw0KGgo=");

    backend
        .tab_command_with_context(
            &ctx,
            "tab_clipboard_write",
            json!({
                "tab_id": "42",
                "items": [{
                    "entries": [
                        { "mime_type": "text/plain", "text": "plain" },
                        { "mime_type": "text/html", "text": "<b>plain</b>" },
                        { "mime_type": "image/png", "base64": "iVBORw0KGgo=" }
                    ],
                    "presentation_style": "inline"
                }]
            }),
        )
        .await
        .unwrap();

    let calls = transport.calls.lock().unwrap();
    let write_expression = calls
        .iter()
        .filter(|(method, params)| method == "executeCdp" && params["method"] == "Runtime.evaluate")
        .filter_map(|(_, params)| {
            params["commandParams"]["expression"]
                .as_str()
                .filter(|expression| {
                    expression.contains("__obuWriteWire") && expression.contains("\"mime_type\"")
                })
        })
        .next()
        .unwrap();
    assert!(write_expression.contains("\"mime_type\":\"text/html\""));
    assert!(write_expression.contains("\"base64\":\"iVBORw0KGgo=\""));
}

#[tokio::test]
async fn webext_backend_rejects_invalid_rich_clipboard_items() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport);
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    let error = backend
        .tab_command_with_context(
            &ctx,
            "tab_clipboard_write",
            json!({
                "tab_id": "42",
                "items": [{
                    "entries": [
                        { "mime_type": "text/plain", "text": "plain", "base64": "cGxhaW4=" }
                    ]
                }]
            }),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("exactly one of text or base64"));
}

#[tokio::test]
async fn webext_backend_rejects_rich_clipboard_validation_edges() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport);
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };
    let cases = [
        (
            json!({ "tab_id": "42", "items": [] }),
            "requires at least one clipboard item",
        ),
        (
            json!({ "tab_id": "42", "items": [{ "entries": [] }] }),
            "requires at least one entry",
        ),
        (
            json!({ "tab_id": "42", "items": [{ "entries": [{ "mime_type": "text/plain", "text": "plain" }], "presentation_style": "floating" }] }),
            "presentation_style is invalid",
        ),
        (
            json!({ "tab_id": "42", "items": [{ "entries": [{ "text": "plain" }] }] }),
            "requires mime_type",
        ),
        (
            json!({ "tab_id": "42", "items": [{ "entries": [{ "mime_type": "text/plain", "text": 123 }] }] }),
            "text must be a string",
        ),
        (
            json!({ "tab_id": "42", "items": [{ "entries": [{ "mime_type": "image/png", "base64": true }] }] }),
            "base64 must be a string",
        ),
    ];

    for (params, expected) in cases {
        let error = backend
            .tab_command_with_context(&ctx, "tab_clipboard_write", params)
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains(expected),
            "expected {expected:?}; got {error}"
        );
    }
}

#[tokio::test]
async fn webext_backend_requires_session_context_before_browser_side_effects() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone());

    let error = backend
        .create_tab_with_context(
            &BackendRequestContext::default(),
            Some("https://example.com".into()),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("createTab requires session_id"));
    assert!(transport.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn webext_backend_detach_cleans_virtual_clipboard_state_and_injection() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone());
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    backend
        .tab_command_with_context(
            &ctx,
            "tab_clipboard_write_text",
            json!({ "tab_id": "42", "text": "clipboard" }),
        )
        .await
        .unwrap();
    backend.detach_with_context(&ctx, "42").await.unwrap();

    let calls = transport.calls.lock().unwrap();
    let source = calls
        .iter()
        .find(|(method, params)| {
            method == "executeCdp" && params["method"] == "Page.addScriptToEvaluateOnNewDocument"
        })
        .and_then(|(_, params)| params["commandParams"]["source"].as_str())
        .unwrap();
    assert!(source.contains("navigator.clipboard !== globalThis.__obuVirtualClipboard"));
    assert!(source.contains("open-browser-use virtual clipboard is not installed"));
    assert!(
        runtime_expression(&calls, "__obuVirtualClipboardCleanup?.()", None)
            .contains("__obuVirtualClipboardCleanup?.()")
    );
    assert!(calls.iter().any(|(method, params)| {
        method == "executeCdp"
            && params["method"] == "Page.removeScriptToEvaluateOnNewDocument"
            && params["commandParams"]["identifier"] == "virtual-clipboard-script"
    }));
    assert!(calls.iter().any(|(method, _)| method == "detach"));
}

#[tokio::test]
async fn webext_backend_finalize_cleans_virtual_clipboard_state_before_backend_cleanup() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone());
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    backend
        .create_tab_with_context(&ctx, Some("https://example.com".into()))
        .await
        .unwrap();
    backend
        .tab_command_with_context(
            &ctx,
            "tab_clipboard_write_text",
            json!({ "tab_id": "42", "text": "clipboard" }),
        )
        .await
        .unwrap();
    backend
        .finalize_tabs_with_context(&ctx, json!({ "keep": [] }))
        .await
        .unwrap();

    let calls = transport.calls.lock().unwrap();
    let cleanup_index = calls
        .iter()
        .position(|(method, params)| {
            method == "executeCdp"
                && params["method"] == "Runtime.evaluate"
                && params["commandParams"]["expression"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("__obuVirtualClipboardCleanup?.()")
        })
        .expect("finalize should run virtual clipboard cleanup before extension finalization");
    let remove_index = calls
        .iter()
        .position(|(method, params)| {
            method == "executeCdp"
                && params["method"] == "Page.removeScriptToEvaluateOnNewDocument"
                && params["commandParams"]["identifier"] == "virtual-clipboard-script"
        })
        .expect("finalize should remove the virtual clipboard new-document script");
    let finalize_index = calls
        .iter()
        .position(|(method, _)| method == "finalizeTabs")
        .expect("finalizeTabs should be sent to the extension backend");
    assert!(cleanup_index < finalize_index);
    assert!(remove_index < finalize_index);
}

#[tokio::test]
async fn webext_backend_type_uses_virtual_clipboard_paste() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone());
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    backend
        .cua_command_with_context(
            &ctx,
            "cua_type",
            json!({ "tab_id": "42", "text": "hello\nworld" }),
        )
        .await
        .unwrap();

    let calls = transport.calls.lock().unwrap();
    assert!(
        !calls.iter().any(
            |(method, params)| method == "executeCdp" && params["method"] == "Input.insertText"
        )
    );
    let write_expression = runtime_expression(&calls, "__obuWriteWire", Some("\"mime_type\""));
    assert!(write_expression.contains("\"mime_type\":\"text/plain\""));
    assert!(write_expression.contains("\"mime_type\":\"text/html\""));
    assert!(write_expression.contains("hello<br>world"));
    assert!(runtime_expression(&calls, "__obuPaste()", None).contains("__obuPaste()"));
}

#[tokio::test]
async fn webext_backend_dom_type_uses_virtual_clipboard_paste_after_focus() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone());
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    backend
        .cua_command_with_context(&ctx, "dom_cua_get_visible_dom", json!({ "tab_id": "42" }))
        .await
        .unwrap();
    backend
        .cua_command_with_context(
            &ctx,
            "dom_cua_type",
            json!({ "tab_id": "42", "node_id": "101", "text": "hello" }),
        )
        .await
        .unwrap();

    let calls = transport.calls.lock().unwrap();
    assert!(
        calls.iter().any(|(method, params)| method == "executeCdp"
            && params["method"] == "Input.dispatchMouseEvent")
    );
    assert!(
        runtime_expression(&calls, "__obuWriteWire", Some("\"mime_type\""))
            .contains("\"text\":\"hello\"")
    );
    assert!(runtime_expression(&calls, "__obuPaste()", None).contains("__obuPaste()"));
}

#[tokio::test]
async fn webext_backend_keypress_routes_or_blocks_clipboard_shortcuts() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone());
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };
    let primary_modifier = if cfg!(target_os = "macos") {
        "Meta"
    } else {
        "Control"
    };
    let non_primary_modifier = if cfg!(target_os = "macos") {
        "Control"
    } else {
        "Meta"
    };

    backend
        .cua_command_with_context(
            &ctx,
            "cua_keypress",
            json!({ "tab_id": "42", "key": "v", "modifiers": ["ControlOrMeta"] }),
        )
        .await
        .unwrap();

    backend
        .cua_command_with_context(
            &ctx,
            "cua_keypress",
            json!({ "tab_id": "42", "keys": [primary_modifier, "v"], "modifiers": [primary_modifier] }),
        )
        .await
        .unwrap();

    let error = backend
        .cua_command_with_context(
            &ctx,
            "cua_keypress",
            json!({ "tab_id": "42", "key": "c", "modifiers": [primary_modifier] }),
        )
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Native clipboard shortcuts are disabled")
    );
    let error = backend
        .cua_command_with_context(
            &ctx,
            "cua_keypress",
            json!({ "tab_id": "42", "key": "v", "modifiers": [primary_modifier, "Shift"] }),
        )
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Native clipboard shortcuts are disabled")
    );

    let calls = transport.calls.lock().unwrap();
    assert!(runtime_expression(&calls, "__obuPaste()", None).contains("__obuPaste()"));
    assert!(
        !calls.iter().any(|(method, params)| method == "executeCdp"
            && params["method"] == "Input.dispatchKeyEvent")
    );
    drop(calls);

    backend
        .cua_command_with_context(
            &ctx,
            "cua_keypress",
            json!({ "tab_id": "42", "key": "v", "modifiers": [non_primary_modifier] }),
        )
        .await
        .unwrap();

    let calls = transport.calls.lock().unwrap();
    assert!(calls.iter().any(|(method, params)| {
        method == "executeCdp"
            && params["method"] == "Input.dispatchKeyEvent"
            && params["commandParams"]["key"] == "v"
    }));
}

#[tokio::test]
async fn webext_backend_dom_cua_uses_backend_node_ids() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone());
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    let dom = backend
        .cua_command_with_context(&ctx, "dom_cua_get_visible_dom", json!({ "tab_id": "42" }))
        .await
        .unwrap();
    assert_eq!(dom["nodes"][0]["node_id"], "101");
    assert_eq!(dom["nodes"][0]["tag"], "button");

    backend
        .cua_command_with_context(
            &ctx,
            "dom_cua_click",
            json!({ "tab_id": "42", "node_id": "101" }),
        )
        .await
        .unwrap();

    let calls = transport.calls.lock().unwrap();
    let mouse = calls
        .iter()
        .find(|(method, params)| {
            method == "executeCdp"
                && params["method"] == "Input.dispatchMouseEvent"
                && params["commandParams"]["type"] == "mouseMoved"
        })
        .unwrap();
    assert_eq!(mouse.1["commandParams"]["x"], 20.0);
    assert_eq!(mouse.1["commandParams"]["y"], 30.0);
}

#[tokio::test]
async fn webext_backend_dom_cua_rejects_node_outside_current_snapshot() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport);
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    backend
        .cua_command_with_context(&ctx, "dom_cua_get_visible_dom", json!({ "tab_id": "42" }))
        .await
        .unwrap();

    let error = backend
        .cua_command_with_context(
            &ctx,
            "dom_cua_click",
            json!({ "tab_id": "42", "node_id": "999" }),
        )
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("was not returned by the current visible DOM snapshot")
    );
}

#[tokio::test]
async fn webext_backend_routes_locator_click_through_playwright_runtime() {
    let transport = Arc::new(NavigatingFakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone());
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    backend
        .playwright_command_with_context(
            &ctx,
            "playwright_locator_click",
            json!({
                "tab_id": "42",
                "selector": "h1",
                "wait_for_navigation": true,
                "navigation_wait_until": "load",
                "navigation_timeout_ms": 500
            }),
        )
        .await
        .unwrap();

    let calls = transport.calls.lock().unwrap();
    assert!(calls.iter().any(|(method, params)| {
        method == "executeCdp"
            && params["method"] == "Runtime.evaluate"
            && params["commandParams"]["expression"]
                .as_str()
                .unwrap_or_default()
                .contains("resolveActionPoint")
    }));
    assert!(calls.iter().any(|(method, params)| {
        method == "executeCdp"
            && params["method"] == "Input.dispatchMouseEvent"
            && params["commandParams"]["type"] == "mousePressed"
    }));
    assert!(
        calls
            .iter()
            .filter(|(method, params)| {
                method == "executeCdp"
                    && params["method"] == "Runtime.evaluate"
                    && params["commandParams"]["expression"]
                        .as_str()
                        .unwrap_or_default()
                        .contains("location.href")
            })
            .count()
            >= 2
    );
}

#[tokio::test]
async fn webext_backend_playwright_fill_uses_shared_virtual_text_input_fallback() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone());
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    backend
        .playwright_command_with_context(
            &ctx,
            "playwright_locator_fill",
            json!({
                "tab_id": "42",
                "selector": "#field",
                "value": "typed fallback",
            }),
        )
        .await
        .unwrap();

    let calls = transport.calls.lock().unwrap();
    let fill_expression = runtime_expression(&calls, "injected.fill", None);
    assert!(fill_expression.contains("typed fallback"));
    let write_expression = runtime_expression(&calls, "__obuWriteWire", Some("\"mime_type\""));
    assert!(write_expression.contains("typed fallback"));
    assert!(runtime_expression(&calls, "__obuPaste()", None).contains("__obuPaste()"));
}

#[tokio::test]
async fn webext_backend_playwright_press_uses_shared_focus_runtime() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone());
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    backend
        .playwright_command_with_context(
            &ctx,
            "playwright_locator_press",
            json!({
                "tab_id": "42",
                "selector": "label",
                "key": "a",
            }),
        )
        .await
        .unwrap();

    let calls = transport.calls.lock().unwrap();
    let focus_expression = runtime_expression(&calls, "retargetInput", Some("focusNode"));
    assert!(focus_expression.contains(r#""retargetInput":true"#));
    assert!(focus_expression.contains(r#""states":["visible","enabled"]"#));
    assert!(calls.iter().any(|(method, params)| {
        method == "executeCdp"
            && params["method"] == "Input.dispatchKeyEvent"
            && params["commandParams"]["type"] == "keyDown"
            && params["commandParams"]["key"] == "a"
    }));
}

#[tokio::test]
async fn webext_backend_releases_drag_when_move_fails() {
    let transport = Arc::new(FailingDragMoveTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone());
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    let error = backend
        .cua_command_with_context(
            &ctx,
            "cua_drag",
            json!({
                "tab_id": "42",
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

    let calls = transport.calls.lock().unwrap();
    let mouse_events = calls
        .iter()
        .filter(|(method, params)| {
            method == "executeCdp" && params["method"] == "Input.dispatchMouseEvent"
        })
        .map(|(_, params)| params["commandParams"].clone())
        .collect::<Vec<_>>();
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
async fn webext_backend_broadcasts_extension_notifications() {
    let backend = WebExtensionBackend::dev_chrome(json!({}));
    let mut events = backend.subscribe_notifications();

    backend.handle_notification(
        "onCDPEvent",
        json!({
            "session_id": "session",
            "source": { "tabId": 42 },
            "method": "Page.loadEventFired",
            "params": { "timestamp": 1 }
        }),
    );
    backend.handle_notification("unknown", json!({ "ignored": true }));

    let event = events.recv().await.unwrap();
    assert_eq!(event.method, "onCDPEvent");
    assert_eq!(event.params["session_id"], "session");
    assert_eq!(event.params["source"]["tabId"], 42);
    assert!(events.try_recv().is_err());
}

#[tokio::test]
async fn webext_backend_waits_for_file_chooser_events_and_sets_files() {
    let transport = Arc::new(FakeTransport::default());
    let backend =
        Arc::new(WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone()));
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    let waiter_backend = backend.clone();
    let waiter_ctx = ctx.clone();
    let waiter = tokio::spawn(async move {
        waiter_backend
            .playwright_command_with_context(
                &waiter_ctx,
                "playwright_wait_for_file_chooser",
                json!({ "tab_id": "42", "timeout_ms": 1000 }),
            )
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    backend.handle_notification(
        "onCDPEvent",
        json!({
            "session_id": "other-session",
            "source": { "tabId": 42 },
            "method": "Page.fileChooserOpened",
            "params": {
                "backendNodeId": 999,
                "mode": "selectSingle"
            }
        }),
    );
    backend.handle_notification(
        "onCDPEvent",
        json!({
            "session_id": "session",
            "source": { "tabId": 7 },
            "method": "Page.fileChooserOpened",
            "params": {
                "backendNodeId": 999,
                "mode": "selectSingle"
            }
        }),
    );
    backend.handle_notification(
        "onCDPEvent",
        json!({
            "session_id": "session",
            "source": { "tabId": 42 },
            "method": "Page.fileChooserOpened",
            "params": {
                "backendNodeId": 0,
                "mode": "selectSingle"
            }
        }),
    );
    backend.handle_notification(
        "onCDPEvent",
        json!({
            "session_id": "session",
            "source": { "tabId": 42 },
            "method": "Page.fileChooserOpened",
            "params": {
                "backendNodeId": 123,
                "mode": "selectSingle"
            }
        }),
    );
    let chooser = waiter.await.unwrap().unwrap();
    let chooser_id = chooser["file_chooser_id"].as_str().unwrap();

    backend
        .playwright_command_with_context(
            &ctx,
            "playwright_file_chooser_set_files",
            json!({ "file_chooser_id": chooser_id, "files": ["/tmp/example.txt"] }),
        )
        .await
        .unwrap();

    let calls = transport.calls.lock().unwrap();
    assert!(calls.iter().any(|(method, params)| {
        method == "executeCdp"
            && params["method"] == "DOM.setFileInputFiles"
            && params["commandParams"]["backendNodeId"] == 123
    }));
}

#[tokio::test]
async fn webext_backend_rejects_handle_use_from_wrong_session_without_consuming() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone());
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

    backend
        .registry()
        .insert_file_chooser(
            FileChooserId("chooser-1".into()),
            FileChooserState {
                tab_id: TabId::new("42"),
                owner_session_id: Some("session".into()),
                created_at: SystemTime::now(),
                backend_node_id: 123,
                is_multiple: false,
            },
        )
        .unwrap();
    let wrong_chooser = backend
        .playwright_command_with_context(
            &other_ctx,
            "playwright_file_chooser_set_files",
            json!({ "file_chooser_id": "chooser-1", "files": ["/tmp/example.txt"] }),
        )
        .await
        .unwrap_err();
    assert!(
        wrong_chooser
            .to_string()
            .contains("belongs to session session, not other-session")
    );
    let wrong_chooser_tab = backend
        .playwright_command_with_context(
            &owner_ctx,
            "playwright_file_chooser_set_files",
            json!({ "tab_id": "wrong-tab", "file_chooser_id": "chooser-1", "files": ["/tmp/example.txt"] }),
        )
        .await
        .unwrap_err();
    assert!(
        wrong_chooser_tab
            .to_string()
            .contains("belongs to tab 42, not wrong-tab")
    );
    backend
        .playwright_command_with_context(
            &owner_ctx,
            "playwright_file_chooser_set_files",
            json!({ "file_chooser_id": "chooser-1", "files": ["/tmp/example.txt"] }),
        )
        .await
        .unwrap();
    let consumed_chooser = backend
        .playwright_command_with_context(
            &owner_ctx,
            "playwright_file_chooser_set_files",
            json!({ "file_chooser_id": "chooser-1", "files": ["/tmp/example.txt"] }),
        )
        .await
        .unwrap_err();
    assert!(
        consumed_chooser
            .to_string()
            .contains("already consumed by setFiles")
    );

    backend
        .registry()
        .insert_download(
            DownloadId("download-1".into()),
            DownloadState {
                tab_id: TabId::new("42"),
                owner_session_id: Some("session".into()),
                created_at: SystemTime::now(),
                url: "https://example.com/file.txt".into(),
                suggested_filename: "file.txt".into(),
                guid: "download-guid".into(),
                completed_path: Some("/tmp/file.txt".into()),
            },
        )
        .unwrap();
    let wrong_download = backend
        .playwright_command_with_context(
            &other_ctx,
            "playwright_download_path",
            json!({ "download_id": "download-1", "timeout_ms": 1000 }),
        )
        .await
        .unwrap_err();
    assert!(
        wrong_download
            .to_string()
            .contains("belongs to session session, not other-session")
    );
    let wrong_download_tab = backend
        .playwright_command_with_context(
            &owner_ctx,
            "playwright_download_path",
            json!({ "tab_id": "wrong-tab", "download_id": "download-1", "timeout_ms": 1000 }),
        )
        .await
        .unwrap_err();
    assert!(
        wrong_download_tab
            .to_string()
            .contains("belongs to tab 42, not wrong-tab")
    );
    let path = backend
        .playwright_command_with_context(
            &owner_ctx,
            "playwright_download_path",
            json!({ "download_id": "download-1", "timeout_ms": 1000 }),
        )
        .await
        .unwrap();
    assert_eq!(path["path"], "/tmp/file.txt");

    let calls = transport.calls.lock().unwrap();
    assert!(calls.iter().any(|(method, params)| {
        method == "executeCdp"
            && params["method"] == "DOM.setFileInputFiles"
            && params["commandParams"]["backendNodeId"] == 123
    }));
}

#[tokio::test]
async fn webext_backend_waits_for_download_change_path() {
    let transport = Arc::new(FakeTransport::default());
    let backend = Arc::new(WebExtensionBackend::dev_chrome(json!({})).with_transport(transport));
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    let waiter_backend = backend.clone();
    let waiter_ctx = ctx.clone();
    let waiter = tokio::spawn(async move {
        waiter_backend
            .playwright_command_with_context(
                &waiter_ctx,
                "playwright_wait_for_download",
                json!({ "tab_id": "42", "timeout_ms": 1000 }),
            )
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    backend.handle_notification(
        "onCDPEvent",
        json!({
            "session_id": "other-session",
            "source": { "tabId": 42 },
            "method": "Page.downloadWillBegin",
            "params": {
                "guid": "wrong-session",
                "url": "https://example.com/file.txt",
                "suggestedFilename": "file.txt"
            }
        }),
    );
    backend.handle_notification(
        "onCDPEvent",
        json!({
            "session_id": "session",
            "source": { "tabId": 7 },
            "method": "Page.downloadWillBegin",
            "params": {
                "guid": "wrong-tab",
                "url": "https://example.com/file.txt",
                "suggestedFilename": "file.txt"
            }
        }),
    );
    backend.handle_notification(
        "onCDPEvent",
        json!({
            "session_id": "session",
            "source": { "tabId": 42 },
            "method": "Page.downloadWillBegin",
            "params": {
                "guid": "download-guid",
                "url": "https://example.com/file.txt",
                "suggestedFilename": "file.txt"
            }
        }),
    );
    let download = waiter.await.unwrap().unwrap();
    assert_eq!(download["download_id"], "download-guid");

    let path_backend = backend.clone();
    let path_ctx = ctx.clone();
    let path_waiter = tokio::spawn(async move {
        path_backend
            .playwright_command_with_context(
                &path_ctx,
                "playwright_download_path",
                json!({ "download_id": "download-guid", "timeout_ms": 1000 }),
            )
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    backend.handle_notification(
        "onDownloadChange",
        json!({
            "session_id": "session",
            "id": "11",
            "status": "started",
            "filename": "",
            "url": "https://example.com/file.txt"
        }),
    );
    backend.handle_notification(
        "onDownloadChange",
        json!({
            "session_id": "other-session",
            "id": "11",
            "status": "complete",
            "filename": "/tmp/file.txt",
            "url": "https://example.com/file.txt"
        }),
    );
    backend.handle_notification(
        "onDownloadChange",
        json!({
            "session_id": "session",
            "id": "12",
            "status": "complete",
            "filename": "/tmp/other.txt",
            "url": "https://example.com/other.txt"
        }),
    );
    backend.handle_notification(
        "onDownloadChange",
        json!({
            "session_id": "session",
            "id": "11",
            "status": "complete",
            "filename": "/tmp/file.txt",
            "url": "https://example.com/file.txt"
        }),
    );
    let path = path_waiter.await.unwrap().unwrap();
    assert_eq!(path["path"], "/tmp/file.txt");
}

#[tokio::test]
async fn webext_backend_routes_media_download_helpers() {
    let transport = Arc::new(FakeTransport::default());
    let backend = WebExtensionBackend::dev_chrome(json!({})).with_transport(transport.clone());
    let ctx = BackendRequestContext {
        session_id: Some("session".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
    };

    backend
        .playwright_command_with_context(
            &ctx,
            "playwright_locator_download_media",
            json!({ "tab_id": "42", "selector": "img" }),
        )
        .await
        .unwrap();
    backend
        .cua_command_with_context(
            &ctx,
            "cua_download_media",
            json!({ "tab_id": "42", "x": 12, "y": 34 }),
        )
        .await
        .unwrap();
    backend
        .cua_command_with_context(&ctx, "dom_cua_get_visible_dom", json!({ "tab_id": "42" }))
        .await
        .unwrap();
    backend
        .cua_command_with_context(
            &ctx,
            "dom_cua_download_media",
            json!({ "tab_id": "42", "node_id": "101" }),
        )
        .await
        .unwrap();

    let calls = transport.calls.lock().unwrap();
    assert!(calls.iter().any(|(method, params)| {
        method == "executeCdp"
            && params["method"] == "Runtime.evaluate"
            && params["commandParams"]["expression"]
                .as_str()
                .unwrap_or_default()
                .contains("downloadable media URL")
    }));
    assert!(calls.iter().any(|(method, params)| {
        method == "executeCdp" && params["method"] == "Runtime.callFunctionOn"
    }));
}

fn runtime_expression<'a>(
    calls: &'a [(String, Value)],
    required: &str,
    also_required: Option<&str>,
) -> &'a str {
    calls
        .iter()
        .filter(|(method, params)| method == "executeCdp" && params["method"] == "Runtime.evaluate")
        .filter_map(|(_, params)| params["commandParams"]["expression"].as_str())
        .find(|expression| {
            expression.contains(required)
                && also_required
                    .map(|also_required| expression.contains(also_required))
                    .unwrap_or(true)
        })
        .unwrap()
}

#[derive(Default)]
struct FakeTransport {
    calls: Mutex<Vec<(String, Value)>>,
}

#[derive(Default)]
struct GetTabsWithDeliverableTransport {
    calls: Mutex<Vec<(String, Value)>>,
}

#[derive(Default)]
struct FailingDragMoveTransport {
    calls: Mutex<Vec<(String, Value)>>,
    failed_once: Mutex<bool>,
}

#[async_trait]
impl ExtensionTransport for FakeTransport {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.calls
            .lock()
            .unwrap()
            .push((method.to_string(), params.clone()));
        Ok(match method {
            "createTab" => json!({
                "tab": {
                    "tabId": 42,
                    "url": params.get("url").cloned().unwrap_or(Value::Null),
                    "title": "Example"
                }
            }),
            "getTabs" => json!({
                "tabs": [
                    { "tabId": 42, "url": "https://example.com", "title": "Example" }
                ]
            }),
            "getUserTabs" => json!({
                "tabs": [
                    { "tabId": 7, "url": "https://example.com", "title": "Example", "origin": "user" }
                ]
            }),
            "claimUserTab" => json!({
                "tab": { "tabId": 7, "url": "https://example.com", "title": "Example", "origin": "user" }
            }),
            "getUserHistory" => json!({
                "items": [
                    { "url": "https://example.com", "title": "Example", "visitCount": 2 }
                ]
            }),
            "finalizeTabs" => json!({
                "closedTabIds": [42],
                "releasedTabIds": [9],
                "keptTabs": [
                    { "tabId": 7, "url": "https://example.com", "title": "Example", "origin": "user", "status": "handoff" },
                    { "tabId": 8, "url": "https://deliverable.example", "title": "Deliverable", "status": "deliverable" }
                ],
                "deliverableTabs": [
                    { "tabId": 8, "url": "https://deliverable.example", "title": "Deliverable", "status": "deliverable" }
                ]
            }),
            "executeCdp" => fake_cdp_response(&params),
            _ => Value::Null,
        })
    }
}

#[async_trait]
impl ExtensionTransport for GetTabsWithDeliverableTransport {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.calls
            .lock()
            .unwrap()
            .push((method.to_string(), params));
        Ok(match method {
            "getTabs" => json!({
                "tabs": [
                    { "tabId": 42, "url": "https://example.com", "title": "Example" }
                ],
                "deliverableTabs": [
                    {
                        "tabId": 8,
                        "url": "https://deliverable.example",
                        "title": "Deliverable",
                        "status": "deliverable"
                    }
                ]
            }),
            _ => Value::Null,
        })
    }
}

#[async_trait]
impl ExtensionTransport for FailingDragMoveTransport {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.calls
            .lock()
            .unwrap()
            .push((method.to_string(), params.clone()));
        if method == "executeCdp"
            && params["method"] == "Input.dispatchMouseEvent"
            && params["commandParams"]["type"] == "mouseMoved"
            && params["commandParams"]["buttons"] == 1
        {
            let mut failed_once = self.failed_once.lock().unwrap();
            if !*failed_once {
                *failed_once = true;
                return Err(HostError::CdpFailure("synthetic drag move failure".into()));
            }
        }
        Ok(match method {
            "executeCdp" => fake_cdp_response(&params),
            _ => Value::Null,
        })
    }
}

fn fake_cdp_response(params: &Value) -> Value {
    match params
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "Runtime.evaluate" => {
            let expression = params
                .get("commandParams")
                .and_then(|params| params.get("expression"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let value = if expression.contains("location.href") {
                json!("https://example.com")
            } else if expression.contains("document.title") {
                json!("Example")
            } else if expression.contains("document.readyState") {
                json!("complete")
            } else if expression.contains("__obuReadWire") {
                json!([{
                    "entries": [
                        { "mime_type": "text/plain", "text": "plain" },
                        { "mime_type": "text/html", "text": "<b>plain</b>" },
                        { "mime_type": "image/png", "base64": "iVBORw0KGgo=" }
                    ],
                    "presentation_style": "inline"
                }])
            } else if expression.contains("readText") {
                json!("clipboard")
            } else if expression.contains("resolveActionPoint") {
                json!({ "x": 10, "y": 20 })
            } else if expression.contains("injected.fill") {
                json!("needsinput")
            } else if expression.contains("__obuPlaywrightInjected") {
                json!(false)
            } else {
                json!("")
            };
            json!({ "result": { "value": value } })
        }
        "Page.captureScreenshot" => json!({ "data": "base64png" }),
        "Page.printToPDF" => json!({ "data": "base64pdf" }),
        "Page.getLayoutMetrics" => json!({
            "visualViewport": {
                "pageX": 0,
                "pageY": 0,
                "clientWidth": 800,
                "clientHeight": 600
            }
        }),
        "DOM.getDocument" => json!({
            "root": {
                "nodeName": "HTML",
                "backendNodeId": 100,
                "children": [
                    {
                        "nodeName": "BUTTON",
                        "backendNodeId": 101,
                        "attributes": ["aria-label", "Submit"]
                    }
                ]
            }
        }),
        "DOM.getBoxModel" => {
            let backend_node_id = params
                .get("commandParams")
                .and_then(|params| params.get("backendNodeId"))
                .and_then(Value::as_i64)
                .unwrap_or_default();
            if backend_node_id == 101 {
                json!({ "model": { "content": [10, 20, 30, 20, 30, 40, 10, 40] } })
            } else {
                json!({})
            }
        }
        "DOM.resolveNode" => json!({ "object": { "objectId": "node-object" } }),
        "Runtime.callFunctionOn" => json!({ "result": { "value": true } }),
        "Page.addScriptToEvaluateOnNewDocument" => {
            json!({ "identifier": "virtual-clipboard-script" })
        }
        _ => json!({}),
    }
}

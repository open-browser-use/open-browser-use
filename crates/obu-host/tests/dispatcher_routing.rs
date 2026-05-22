#![cfg(unix)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UnixStream};
use tokio_util::codec::Framed;

use obu_host::{
    backends::{BackendKind, BackendRequestContext, BrowserBackend},
    dispatcher::Dispatcher,
    error::{DialogRequiresDecision, HostError, Result},
    methods,
    policy::{HostPolicy, PolicyContext, disallowed},
    socket::{Listener, unix::UnixSockListener},
};
use obu_wire::{
    ErrorObject, FrameCodec,
    error::{ERR_DIALOG_REQUIRES_DECISION, ERR_NOT_IMPLEMENTED},
};

#[tokio::test]
async fn getinfo_then_ping_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("dispatch.sock");
    let mut listener = UnixSockListener::bind(&path).unwrap();

    let server = tokio::spawn(async move {
        let peer = listener.accept().await.unwrap();
        let dispatcher = Dispatcher::new_for_test();
        dispatcher.serve_peer(peer.stream, None).await.unwrap();
    });

    tokio::time::sleep(Duration::from_millis(50)).await;
    let client = UnixStream::connect(&path).await.unwrap();
    let mut framed = Framed::new(client, FrameCodec);

    framed
        .send(frame(json!({
            "jsonrpc": "2.0",
            "method": methods::GET_INFO,
            "params": {},
            "id": 1,
        })))
        .await
        .unwrap();
    let info = read_json(&mut framed).await;
    assert_eq!(info["id"], 1);
    assert_eq!(info["result"]["type"], "webextension");
    assert_eq!(info["result"]["name"], "chrome");
    assert_eq!(info["result"]["capabilities"]["backend"], "webextension");
    assert!(
        info["result"]["capabilities"]["supported_methods"]
            .as_array()
            .unwrap()
            .iter()
            .any(|method| method == methods::DOM_CUA_CLICK)
    );
    assert_eq!(info["result"]["capabilities"]["viewport"]["set"], true);
    assert_eq!(info["result"]["capabilities"]["visibility"]["get"], true);
    assert_eq!(
        info["result"]["capabilities"]["budgeted_outputs"]["dom_cua_get_visible_dom"],
        true
    );

    framed
        .send(frame(json!({
            "jsonrpc": "2.0",
            "method": methods::PING,
            "params": {},
            "id": 2,
        })))
        .await
        .unwrap();
    let pong = read_json(&mut framed).await;
    assert_eq!(pong["id"], 2);
    assert_eq!(pong["result"], "pong");

    drop(framed);
    server.await.unwrap();
}

#[tokio::test]
async fn capability_token_auth_frame_is_required_when_configured() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("auth.sock");
    let mut listener = UnixSockListener::bind(&path).unwrap();

    let server = tokio::spawn(async move {
        let peer = listener.accept().await.unwrap();
        let dispatcher = Dispatcher::new_for_test();
        dispatcher
            .serve_peer(peer.stream, Some("secret"))
            .await
            .unwrap();
    });

    tokio::time::sleep(Duration::from_millis(50)).await;
    let client = UnixStream::connect(&path).await.unwrap();
    let mut framed = Framed::new(client, FrameCodec);
    framed
        .send(frame(json!({
            "jsonrpc": "2.0",
            "method": "auth",
            "params": { "capability_token": "secret" },
            "id": 0,
        })))
        .await
        .unwrap();
    let auth = read_json(&mut framed).await;
    assert_eq!(auth["id"], 0);
    assert_eq!(auth["result"], serde_json::Value::Null);

    framed
        .send(frame(json!({
            "jsonrpc": "2.0",
            "method": methods::PING,
            "params": {},
            "id": 1,
        })))
        .await
        .unwrap();
    let pong = read_json(&mut framed).await;
    assert_eq!(pong["result"], "pong");

    drop(framed);
    server.await.unwrap();
}

#[tokio::test]
async fn execute_cdp_rejects_non_tab_targets() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("target-shape.sock");
    let mut listener = UnixSockListener::bind(&path).unwrap();

    let server = tokio::spawn(async move {
        let peer = listener.accept().await.unwrap();
        let dispatcher = Dispatcher::new_for_test();
        dispatcher.serve_peer(peer.stream, None).await.unwrap();
    });

    tokio::time::sleep(Duration::from_millis(50)).await;
    let client = UnixStream::connect(&path).await.unwrap();
    let mut framed = Framed::new(client, FrameCodec);

    framed
        .send(frame(json!({
            "jsonrpc": "2.0",
            "method": methods::EXECUTE_CDP,
            "params": {
                "target": { "targetId": "target-1" },
                "method": "Runtime.evaluate",
                "commandParams": {}
            },
            "id": 1,
        })))
        .await
        .unwrap();
    let response = read_json(&mut framed).await;
    assert_eq!(response["id"], 1);
    assert_eq!(response["error"]["code"], -32602);
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("target.targetId is not allowed")
    );

    drop(framed);
    server.await.unwrap();
}

#[tokio::test]
async fn backend_error_response_does_not_poison_later_requests() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("backend-error.sock");
    let mut listener = UnixSockListener::bind(&path).unwrap();

    let server = tokio::spawn(async move {
        let peer = listener.accept().await.unwrap();
        let dispatcher = Dispatcher::new_for_test();
        dispatcher.serve_peer(peer.stream, None).await.unwrap();
    });

    tokio::time::sleep(Duration::from_millis(50)).await;
    let client = UnixStream::connect(&path).await.unwrap();
    let mut framed = Framed::new(client, FrameCodec);

    framed
        .send(frame(json!({
            "jsonrpc": "2.0",
            "method": methods::CREATE_TAB,
            "params": { "url": "https://missing-session.example/" },
            "id": 1,
        })))
        .await
        .unwrap();
    let error = read_json(&mut framed).await;
    assert_eq!(error["id"], 1);
    assert_eq!(error["error"]["code"], -1004);
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("requires session_id")
    );

    framed
        .send(frame(json!({
            "jsonrpc": "2.0",
            "method": methods::PING,
            "params": {},
            "id": 2,
        })))
        .await
        .unwrap();
    let pong = read_json(&mut framed).await;
    assert_eq!(pong["id"], 2);
    assert_eq!(pong["result"], "pong");

    drop(framed);
    server.await.unwrap();
}

#[tokio::test]
async fn host_policy_blocks_direct_navigation_before_backend_call() {
    let backend = Arc::new(RecordingBackend::default());
    let response = one_request(
        Dispatcher::new_with_policy(
            "0.1.0".into(),
            backend.clone(),
            Arc::new(BlockNavigationPolicy),
        ),
        json!({
            "jsonrpc": "2.0",
            "method": methods::CREATE_TAB,
            "params": { "url": "https://blocked.example/", "session_id": "s", "turn_id": "t" },
            "id": 1,
        }),
    )
    .await;

    assert_eq!(response["error"]["code"], -1002);
    assert!(backend.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn host_policy_blocks_direct_raw_cdp_before_backend_call() {
    let backend = Arc::new(RecordingBackend::default());
    let response = one_request(
        Dispatcher::new_with_policy("0.1.0".into(), backend.clone(), Arc::new(BlockRawCdpPolicy)),
        json!({
            "jsonrpc": "2.0",
            "method": methods::EXECUTE_CDP,
            "params": {
                "session_id": "s",
                "turn_id": "t",
                "target": { "tabId": "7" },
                "method": "Page.navigate",
                "commandParams": { "url": "https://blocked.example/" }
            },
            "id": 1,
        }),
    )
    .await;

    assert_eq!(response["error"]["code"], -1002);
    assert!(backend.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn host_policy_blocks_raw_cdp_navigation_target_before_backend_call() {
    let backend = Arc::new(RecordingBackend::default());
    let response = one_request(
        Dispatcher::new_with_policy(
            "0.1.0".into(),
            backend.clone(),
            Arc::new(BlockNavigationPolicy),
        ),
        json!({
            "jsonrpc": "2.0",
            "method": methods::EXECUTE_CDP,
            "params": {
                "session_id": "s",
                "turn_id": "t",
                "target": { "tabId": "7" },
                "method": "Page.navigate",
                "commandParams": { "url": "https://blocked.example/" }
            },
            "id": 1,
        }),
    )
    .await;

    assert_eq!(response["error"]["code"], -1002);
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("navigation blocked")
    );
    assert!(backend.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn host_policy_blocks_raw_cdp_from_denied_current_origin_before_backend_call() {
    let backend = Arc::new(RecordingBackend::default());
    let response = one_request(
        Dispatcher::new_with_policy(
            "0.1.0".into(),
            backend.clone(),
            Arc::new(BlockCurrentOriginPolicy),
        ),
        json!({
            "jsonrpc": "2.0",
            "method": methods::EXECUTE_CDP,
            "params": {
                "session_id": "s",
                "turn_id": "t",
                "target": { "tabId": "7" },
                "method": "Runtime.evaluate",
                "commandParams": { "expression": "location.href" }
            },
            "id": 1,
        }),
    )
    .await;

    assert_eq!(response["error"]["code"], -1002);
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("current origin blocked")
    );
    assert_eq!(backend.calls.lock().unwrap().as_slice(), ["tab_url"]);
}

#[tokio::test]
async fn host_policy_blocks_upload_with_tab_context_before_backend_call() {
    let backend = Arc::new(RecordingBackend::default());
    let response = one_request(
        Dispatcher::new_with_policy("0.1.0".into(), backend.clone(), Arc::new(BlockUploadPolicy)),
        json!({
            "jsonrpc": "2.0",
            "method": methods::PLAYWRIGHT_FILE_CHOOSER_SET_FILES,
            "params": {
                "session_id": "s",
                "turn_id": "t",
                "tab_id": "7",
                "file_chooser_id": "chooser-1",
                "paths": ["/tmp/a.txt"]
            },
            "id": 1,
        }),
    )
    .await;

    assert_eq!(response["error"]["code"], -1002);
    assert_eq!(response["error"]["data"]["tab_id"], "7");
    assert_eq!(response["error"]["data"]["paths"], json!(["/tmp/a.txt"]));
    assert!(backend.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn host_policy_blocks_download_with_tab_context_before_backend_call() {
    let cases = vec![
        (
            methods::PLAYWRIGHT_WAIT_FOR_DOWNLOAD,
            json!({
                "session_id": "s",
                "turn_id": "t",
                "tab_id": "7"
            }),
        ),
        (
            methods::PLAYWRIGHT_DOWNLOAD_PATH,
            json!({
                "session_id": "s",
                "turn_id": "t",
                "tab_id": "7",
                "download_id": "download-1"
            }),
        ),
        (
            methods::PLAYWRIGHT_LOCATOR_DOWNLOAD_MEDIA,
            json!({
                "session_id": "s",
                "turn_id": "t",
                "tab_id": "7",
                "selector": "#download-link"
            }),
        ),
    ];

    for (method, params) in cases {
        let backend = Arc::new(RecordingBackend::default());
        let response = one_request(
            Dispatcher::new_with_policy(
                "0.1.0".into(),
                backend.clone(),
                Arc::new(BlockDownloadPolicy),
            ),
            json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params,
                "id": 1,
            }),
        )
        .await;

        assert_eq!(response["error"]["code"], -1002);
        assert_eq!(response["error"]["data"]["command"], method);
        assert_eq!(response["error"]["data"]["tab_id"], "7");
        assert!(backend.calls.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn host_policy_blocks_user_tab_profile_surfaces_before_backend_call() {
    let cases = vec![
        (
            methods::GET_USER_TABS,
            json!({ "session_id": "s", "turn_id": "t" }),
        ),
        (
            methods::CLAIM_USER_TAB,
            json!({ "session_id": "s", "turn_id": "t", "tab_id": "7" }),
        ),
    ];
    for (method, params) in cases {
        let backend = Arc::new(RecordingBackend::default());
        let response = one_request(
            Dispatcher::new_with_policy(
                "0.1.0".into(),
                backend.clone(),
                Arc::new(BlockHistoryPolicy),
            ),
            json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params,
                "id": 1,
            }),
        )
        .await;

        assert_eq!(response["error"]["code"], -1002);
        assert_eq!(response["error"]["data"]["command"], method);
        assert!(backend.calls.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn host_policy_current_origin_uses_backend_url_not_caller_url() {
    let backend = Arc::new(RecordingBackend::default());
    let response = one_request(
        Dispatcher::new_with_policy(
            "0.1.0".into(),
            backend.clone(),
            Arc::new(BlockCurrentOriginPolicy),
        ),
        json!({
            "jsonrpc": "2.0",
            "method": methods::PLAYWRIGHT_LOCATOR_CLICK,
            "params": {
                "session_id": "s",
                "turn_id": "t",
                "tab_id": "7",
                "selector": "#ok",
                "url": "https://forged-allowed.example/"
            },
            "id": 1,
        }),
    )
    .await;

    assert_eq!(response["error"]["code"], -1002);
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("current origin blocked")
    );
    assert_eq!(backend.calls.lock().unwrap().as_slice(), ["tab_url"]);
}

#[tokio::test]
async fn host_policy_blocks_transfer_helpers_from_denied_current_origin_before_backend_call() {
    let cases = vec![
        (
            methods::PLAYWRIGHT_FILE_CHOOSER_SET_FILES,
            json!({
                "session_id": "s",
                "turn_id": "t",
                "tab_id": "7",
                "file_chooser_id": "chooser-1",
                "paths": ["/tmp/a.txt"]
            }),
        ),
        (
            methods::PLAYWRIGHT_DOWNLOAD_PATH,
            json!({
                "session_id": "s",
                "turn_id": "t",
                "tab_id": "7",
                "download_id": "download-1"
            }),
        ),
    ];

    for (method, params) in cases {
        let backend = Arc::new(RecordingBackend::default());
        let response = one_request(
            Dispatcher::new_with_policy(
                "0.1.0".into(),
                backend.clone(),
                Arc::new(BlockCurrentOriginPolicy),
            ),
            json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params,
                "id": 1,
            }),
        )
        .await;

        assert_eq!(response["error"]["code"], -1002);
        assert!(
            response["error"]["message"]
                .as_str()
                .unwrap()
                .contains("current origin blocked")
        );
        assert_eq!(backend.calls.lock().unwrap().as_slice(), ["tab_url"]);
    }
}

#[tokio::test]
async fn host_policy_blocks_tab_current_origin_helpers_before_backend_call() {
    let cases = vec![
        (
            methods::TAB_URL,
            json!({ "session_id": "s", "turn_id": "t", "tab_id": "7" }),
        ),
        (
            methods::TAB_TITLE,
            json!({ "session_id": "s", "turn_id": "t", "tab_id": "7" }),
        ),
        (
            methods::TAB_CONTENT_EXPORT,
            json!({ "session_id": "s", "turn_id": "t", "tab_id": "7", "format": "html" }),
        ),
        (
            methods::TAB_CLOSE,
            json!({ "session_id": "s", "turn_id": "t", "tab_id": "7" }),
        ),
        (
            methods::TAB_CLIPBOARD_READ_TEXT,
            json!({ "session_id": "s", "turn_id": "t", "tab_id": "7" }),
        ),
        (
            methods::TAB_CLIPBOARD_WRITE_TEXT,
            json!({ "session_id": "s", "turn_id": "t", "tab_id": "7", "text": "blocked" }),
        ),
        (
            methods::TAB_CLIPBOARD_READ,
            json!({ "session_id": "s", "turn_id": "t", "tab_id": "7" }),
        ),
        (
            methods::TAB_CLIPBOARD_WRITE,
            json!({
                "session_id": "s",
                "turn_id": "t",
                "tab_id": "7",
                "items": [{ "entries": [{ "mime_type": "text/plain", "text": "blocked" }] }]
            }),
        ),
    ];

    for (method, params) in cases {
        let backend = Arc::new(RecordingBackend::default());
        let response = one_request(
            Dispatcher::new_with_policy(
                "0.1.0".into(),
                backend.clone(),
                Arc::new(BlockCurrentOriginPolicy),
            ),
            json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params,
                "id": 1,
            }),
        )
        .await;

        assert_eq!(response["error"]["code"], -1002, "{method}");
        assert_eq!(response["error"]["data"]["command"], method, "{method}");
        assert_eq!(
            backend.calls.lock().unwrap().as_slice(),
            ["tab_url"],
            "{method}"
        );
    }
}

#[tokio::test]
async fn backend_capability_gate_rejects_unsupported_method_before_backend_call() {
    let backend = Arc::new(RecordingBackend::new(BackendKind::Cdp));
    let response = one_request(
        Dispatcher::new("0.1.0".into(), backend.clone()),
        json!({
            "jsonrpc": "2.0",
            "method": methods::TAB_CLIPBOARD_READ_TEXT,
            "params": { "session_id": "s", "turn_id": "t", "tab_id": "7" },
            "id": 1,
        }),
    )
    .await;

    assert_eq!(response["error"]["code"], ERR_NOT_IMPLEMENTED);
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("backend cdp does not support method tab_clipboard_read_text")
    );
    assert_eq!(
        response["error"]["data"]["code"],
        "unsupported_backend_capability"
    );
    assert_eq!(response["error"]["data"]["backend"], "cdp");
    assert_eq!(
        response["error"]["data"]["method"],
        methods::TAB_CLIPBOARD_READ_TEXT
    );
    assert_eq!(
        response["error"]["data"]["missing_capability"],
        "method:tab_clipboard_read_text"
    );
    assert!(backend.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cdp_capability_gate_rejects_profile_history_before_default_empty_result() {
    let backend = Arc::new(RecordingBackend::new(BackendKind::Cdp));
    let response = one_request(
        Dispatcher::new("0.1.0".into(), backend.clone()),
        json!({
            "jsonrpc": "2.0",
            "method": methods::GET_USER_HISTORY,
            "params": { "session_id": "s", "turn_id": "t", "query": "example" },
            "id": 1,
        }),
    )
    .await;

    assert_eq!(response["error"]["code"], ERR_NOT_IMPLEMENTED);
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("backend cdp does not support method getUserHistory")
    );
    assert_eq!(
        response["error"]["data"]["code"],
        "unsupported_backend_capability"
    );
    assert_eq!(response["error"]["data"]["backend"], "cdp");
    assert_eq!(
        response["error"]["data"]["method"],
        methods::GET_USER_HISTORY
    );
    assert_eq!(
        response["error"]["data"]["missing_capability"],
        "method:getUserHistory"
    );
    assert!(backend.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn dispatcher_preserves_dialog_requires_decision_error_data() {
    let response = one_request(
        Dispatcher::new("0.1.0".into(), Arc::new(DialogErrorBackend)),
        json!({
            "jsonrpc": "2.0",
            "method": methods::TAB_GOTO,
            "params": {
                "session_id": "session",
                "turn_id": "turn",
                "tab_id": "42",
                "url": "https://example.test/"
            },
            "id": 1,
        }),
    )
    .await;

    assert_eq!(response["error"]["code"], ERR_DIALOG_REQUIRES_DECISION);
    assert_eq!(
        response["error"]["data"]["code"],
        "dialog_requires_decision"
    );
    assert_eq!(response["error"]["data"]["tab_id"], "42");
    assert_eq!(response["error"]["data"]["dialog_type"], "confirm");
    assert_eq!(response["error"]["data"]["default_action"], "dismiss");
}

#[tokio::test]
async fn getinfo_exposes_backend_capability_matrix() {
    let response = one_request(
        Dispatcher::new(
            "0.1.0".into(),
            Arc::new(RecordingBackend::new(BackendKind::Cdp)),
        ),
        json!({
            "jsonrpc": "2.0",
            "method": methods::GET_INFO,
            "params": {},
            "id": 1,
        }),
    )
    .await;

    assert_eq!(response["result"]["capabilities"]["backend"], "cdp");
    assert!(
        response["result"]["capabilities"]["unsupported_methods"]
            .as_array()
            .unwrap()
            .iter()
            .any(|method| method == methods::DOM_CUA_CLICK)
    );
    assert!(
        response["result"]["capabilities"]["unsupported_methods"]
            .as_array()
            .unwrap()
            .iter()
            .any(|method| method == methods::GET_USER_HISTORY)
    );
    assert!(
        response["result"]["capabilities"]["unsupported_methods"]
            .as_array()
            .unwrap()
            .iter()
            .any(|method| method == methods::BROWSER_VIEWPORT_SET)
    );
    assert!(response["result"]["capabilities"]["viewport"].is_null());
    assert!(response["result"]["capabilities"]["visibility"].is_null());
    assert_eq!(
        response["result"]["capabilities"]["budgeted_outputs"]["dom_cua_get_visible_dom"],
        false
    );
    assert!(
        response["result"]["capabilities"]["supported_methods"]
            .as_array()
            .unwrap()
            .iter()
            .any(|method| method == methods::PLAYWRIGHT_LOCATOR_CLICK)
    );
}

#[tokio::test]
async fn clear_lifecycle_diagnostics_routes_to_backend() {
    let backend = Arc::new(RecordingBackend::default());
    let response = one_request(
        Dispatcher::new("0.1.0".into(), backend.clone()),
        json!({
            "jsonrpc": "2.0",
            "method": methods::CLEAR_LIFECYCLE_DIAGNOSTICS,
            "params": {},
            "id": 1,
        }),
    )
    .await;

    assert_eq!(response["result"]["cleared"], true);
    assert_eq!(
        backend.calls.lock().unwrap().as_slice(),
        [methods::CLEAR_LIFECYCLE_DIAGNOSTICS]
    );
}

#[tokio::test]
async fn browser_capability_methods_route_without_current_origin_policy() {
    let cases = vec![
        (
            methods::BROWSER_VIEWPORT_SET,
            json!({ "width": 640, "height": 480 }),
        ),
        (methods::BROWSER_VIEWPORT_RESET, json!({})),
        (methods::BROWSER_VISIBILITY_SET, json!({ "visible": true })),
        (methods::BROWSER_VISIBILITY_GET, json!({})),
    ];

    for (method, params) in cases {
        let backend = Arc::new(RecordingBackend::default());
        let mut params = params;
        params["session_id"] = json!("s");
        params["turn_id"] = json!("t");
        let response = one_request(
            Dispatcher::new_with_policy(
                "0.1.0".into(),
                backend.clone(),
                Arc::new(BlockCurrentOriginPolicy),
            ),
            json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params,
                "id": 1,
            }),
        )
        .await;

        assert_eq!(response["result"], json!({ "method": method }));
        assert_eq!(
            backend.calls.lock().unwrap().as_slice(),
            [method],
            "{method}"
        );
    }
}

#[tokio::test]
async fn browser_tabs_content_fetches_multiple_urls_with_mixed_results_and_no_profile_credentials()
{
    let server = ContentTestServer::spawn().await;
    let backend = Arc::new(RecordingBackend::default());
    let response = one_request(
        Dispatcher::new("0.1.0".into(), backend.clone()),
        json!({
            "jsonrpc": "2.0",
            "method": methods::BROWSER_TABS_CONTENT,
            "params": {
                "urls": [
                    server.url("/one"),
                    server.url("/redirect-ok"),
                    "ftp://example.test/not-supported",
                    server.url("/headers")
                ],
                "contentType": "text",
                "timeout": 1000
            },
            "id": 1,
        }),
    )
    .await;

    assert!(response.get("error").is_none(), "{response:#}");
    let results = response["result"]["results"].as_array().unwrap();
    assert_eq!(results.len(), 4);
    assert_eq!(results[0]["status"], "ok");
    assert_eq!(results[0]["text"], "one");
    assert_eq!(results[0]["contentType"], "text/plain");
    assert_eq!(results[1]["status"], "ok");
    assert_eq!(results[1]["text"], "one");
    assert_eq!(results[1]["redirects"], json!([server.url("/one")]));
    assert_eq!(results[2]["status"], "error");
    assert_eq!(results[2]["errorCode"], "unsupported_url_scheme");
    assert_eq!(results[3]["status"], "ok");
    assert_eq!(results[3]["text"], "cookie=<none>; authorization=<none>");
    assert!(backend.calls.lock().unwrap().is_empty());

    let hits = server.hits();
    assert!(hits.iter().any(|hit| hit.path == "/one"));
    assert!(hits.iter().any(|hit| hit.path == "/redirect-ok"));
    let headers_hit = hits.iter().find(|hit| hit.path == "/headers").unwrap();
    assert!(!headers_hit.has_header("cookie"));
    assert!(!headers_hit.has_header("authorization"));
}

#[tokio::test]
async fn browser_tabs_content_reports_unsupported_content_type_without_fetching() {
    let server = ContentTestServer::spawn().await;
    let response = one_request(
        Dispatcher::new("0.1.0".into(), Arc::new(RecordingBackend::default())),
        json!({
            "jsonrpc": "2.0",
            "method": methods::BROWSER_TABS_CONTENT,
            "params": {
                "urls": [server.url("/one")],
                "contentType": "pdf"
            },
            "id": 1,
        }),
    )
    .await;

    let results = response["result"]["results"].as_array().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["status"], "error");
    assert_eq!(results[0]["errorCode"], "unsupported_content_type");
    assert!(server.hits().is_empty());
}

#[tokio::test]
async fn browser_tabs_content_times_out_one_url_without_losing_other_results() {
    let server = ContentTestServer::spawn().await;
    let response = one_request(
        Dispatcher::new("0.1.0".into(), Arc::new(RecordingBackend::default())),
        json!({
            "jsonrpc": "2.0",
            "method": methods::BROWSER_TABS_CONTENT,
            "params": {
                "urls": [server.url("/slow"), server.url("/one")],
                "timeout": 10,
                "client_timeout_ms": 250
            },
            "id": 1,
        }),
    )
    .await;

    let results = response["result"]["results"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0]["status"], "error");
    assert_eq!(results[0]["errorCode"], "fetch_failed");
    assert_eq!(results[1]["status"], "ok");
    assert_eq!(results[1]["text"], "one");
}

#[tokio::test]
async fn browser_tabs_content_spends_one_timeout_budget_across_redirects() {
    let server = ContentTestServer::spawn().await;
    let response = one_request(
        Dispatcher::new("0.1.0".into(), Arc::new(RecordingBackend::default())),
        json!({
            "jsonrpc": "2.0",
            "method": methods::BROWSER_TABS_CONTENT,
            "params": {
                "urls": [server.url("/slow-redirect-a"), server.url("/one")],
                "timeout": 250,
                "client_timeout_ms": 700
            },
            "id": 1,
        }),
    )
    .await;

    assert!(response.get("error").is_none(), "{response:#}");
    let results = response["result"]["results"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0]["status"], "error");
    assert_eq!(results[0]["errorCode"], "fetch_failed");
    assert_eq!(results[0]["errorMessage"], "per-URL timeout exceeded");
    assert_eq!(
        results[0]["redirects"],
        json!([server.url("/slow-redirect-b")])
    );
    assert_eq!(results[1]["status"], "ok");
    assert_eq!(results[1]["text"], "one");
}

#[tokio::test]
async fn browser_tabs_content_reports_policy_denied_initial_url_per_url_before_fetch() {
    let server = ContentTestServer::spawn().await;
    let backend = Arc::new(RecordingBackend::default());
    let response = one_request(
        Dispatcher::new_with_policy(
            "0.1.0".into(),
            backend.clone(),
            Arc::new(BlockNavigationPolicy),
        ),
        json!({
            "jsonrpc": "2.0",
            "method": methods::BROWSER_TABS_CONTENT,
            "params": {
                "urls": [server.url("/one"), "https://blocked.example/content"]
            },
            "id": 1,
        }),
    )
    .await;

    assert!(response.get("error").is_none(), "{response:#}");
    let results = response["result"]["results"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0]["status"], "ok");
    assert_eq!(results[0]["text"], "one");
    assert_eq!(results[1]["status"], "error");
    assert_eq!(results[1]["url"], "https://blocked.example/content");
    assert_eq!(results[1]["errorCode"], "navigation_disallowed");
    assert!(backend.calls.lock().unwrap().is_empty());
    let hits = server.hits();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "/one");
}

#[tokio::test]
async fn browser_tabs_content_reports_policy_denied_redirect_per_url() {
    let server = ContentTestServer::spawn().await;
    let response = one_request(
        Dispatcher::new_with_policy(
            "0.1.0".into(),
            Arc::new(RecordingBackend::default()),
            Arc::new(BlockNavigationPolicy),
        ),
        json!({
            "jsonrpc": "2.0",
            "method": methods::BROWSER_TABS_CONTENT,
            "params": {
                "urls": [server.url("/redirect-blocked"), server.url("/one")]
            },
            "id": 1,
        }),
    )
    .await;

    let results = response["result"]["results"].as_array().unwrap();
    assert_eq!(results.len(), 2);
    assert_eq!(results[0]["status"], "error");
    assert_eq!(results[0]["httpStatus"], 302);
    assert_eq!(results[0]["errorCode"], "navigation_disallowed");
    assert_eq!(results[0]["redirects"], json!([]));
    assert_eq!(results[1]["status"], "ok");
    assert_eq!(results[1]["text"], "one");
}

fn frame(value: serde_json::Value) -> bytes::Bytes {
    bytes::Bytes::from(serde_json::to_vec(&value).unwrap())
}

async fn one_request(dispatcher: Dispatcher, request: serde_json::Value) -> serde_json::Value {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("policy.sock");
    let mut listener = UnixSockListener::bind(&path).unwrap();
    let server = tokio::spawn(async move {
        let peer = listener.accept().await.unwrap();
        dispatcher.serve_peer(peer.stream, None).await.unwrap();
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let client = UnixStream::connect(&path).await.unwrap();
    let mut framed = Framed::new(client, FrameCodec);
    framed.send(frame(request)).await.unwrap();
    let response = read_json(&mut framed).await;
    drop(framed);
    server.await.unwrap();
    response
}

async fn read_json(framed: &mut Framed<UnixStream, FrameCodec>) -> serde_json::Value {
    let bytes = framed.next().await.unwrap().unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[derive(Clone)]
struct ContentTestServer {
    base_url: String,
    hits: Arc<Mutex<Vec<ContentHit>>>,
}

#[derive(Clone, Debug)]
struct ContentHit {
    path: String,
    headers: Vec<String>,
}

impl ContentHit {
    fn has_header(&self, name: &str) -> bool {
        let prefix = format!("{}:", name.to_ascii_lowercase());
        self.headers
            .iter()
            .any(|header| header.to_ascii_lowercase().starts_with(&prefix))
    }
}

impl ContentTestServer {
    async fn spawn() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(Mutex::new(Vec::new()));
        let server = Self {
            base_url: format!("http://{addr}"),
            hits: hits.clone(),
        };
        tokio::spawn(async move {
            loop {
                let Ok((stream, _addr)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(handle_content_test_connection(stream, hits.clone()));
            }
        });
        server
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    fn hits(&self) -> Vec<ContentHit> {
        self.hits.lock().unwrap().clone()
    }
}

async fn handle_content_test_connection(
    mut stream: tokio::net::TcpStream,
    hits: Arc<Mutex<Vec<ContentHit>>>,
) {
    let mut request = Vec::new();
    let mut buf = [0_u8; 1024];
    loop {
        let Ok(read) = stream.read(&mut buf).await else {
            return;
        };
        if read == 0 {
            return;
        }
        request.extend_from_slice(&buf[..read]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") || request.len() > 64 * 1024 {
            break;
        }
    }
    let request = String::from_utf8_lossy(&request);
    let mut lines = request.lines();
    let path = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("/")
        .to_string();
    let headers = lines
        .take_while(|line| !line.trim().is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    hits.lock().unwrap().push(ContentHit {
        path: path.clone(),
        headers: headers.clone(),
    });

    let response = match path.as_str() {
        "/one" => http_response("200 OK", &[("Content-Type", "text/plain")], "one"),
        "/headers" => {
            let hit = ContentHit {
                path,
                headers: headers.clone(),
            };
            let cookie = if hit.has_header("cookie") {
                "present"
            } else {
                "<none>"
            };
            let authorization = if hit.has_header("authorization") {
                "present"
            } else {
                "<none>"
            };
            http_response(
                "200 OK",
                &[("Content-Type", "text/plain")],
                &format!("cookie={cookie}; authorization={authorization}"),
            )
        }
        "/redirect-ok" => redirect_response("/one"),
        "/redirect-blocked" => redirect_response("https://blocked.example/content"),
        "/slow-redirect-a" => {
            tokio::time::sleep(Duration::from_millis(160)).await;
            redirect_response("/slow-redirect-b")
        }
        "/slow-redirect-b" => {
            tokio::time::sleep(Duration::from_millis(160)).await;
            redirect_response("/one")
        }
        "/slow" => {
            tokio::time::sleep(Duration::from_millis(200)).await;
            http_response("200 OK", &[("Content-Type", "text/plain")], "slow")
        }
        _ => http_response(
            "404 Not Found",
            &[("Content-Type", "text/plain")],
            "missing",
        ),
    };
    let _ = stream.write_all(response.as_bytes()).await;
}

fn redirect_response(location: &str) -> String {
    format!(
        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
}

fn http_response(status: &str, headers: &[(&str, &str)], body: &str) -> String {
    let mut response = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\n", body.len());
    for (name, value) in headers {
        response.push_str(name);
        response.push_str(": ");
        response.push_str(value);
        response.push_str("\r\n");
    }
    response.push_str("Connection: close\r\n");
    response.push_str("\r\n");
    response.push_str(body);
    response
}

struct RecordingBackend {
    kind: BackendKind,
    calls: Mutex<Vec<String>>,
}

struct DialogErrorBackend;

#[async_trait]
impl BrowserBackend for DialogErrorBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::WebExtension
    }

    fn id(&self) -> &str {
        "dialog-error"
    }

    async fn tab_command_with_context(
        &self,
        _ctx: &BackendRequestContext,
        _method: &str,
        _params: Value,
    ) -> Result<Value> {
        Err(HostError::DialogRequiresDecision(DialogRequiresDecision {
            message: "dialog_requires_decision: confirm dialog on tab 42 was dismissed".into(),
            data: json!({
                "code": "dialog_requires_decision",
                "tab_id": "42",
                "session_id": "session",
                "dialog_type": "confirm",
                "default_action": "dismiss",
                "accept": false
            }),
        }))
    }
}

impl Default for RecordingBackend {
    fn default() -> Self {
        Self::new(BackendKind::WebExtension)
    }
}

impl RecordingBackend {
    fn new(kind: BackendKind) -> Self {
        Self {
            kind,
            calls: Mutex::default(),
        }
    }
}

#[async_trait]
impl BrowserBackend for RecordingBackend {
    fn kind(&self) -> BackendKind {
        self.kind
    }

    fn id(&self) -> &str {
        "recording"
    }

    fn clear_lifecycle_diagnostics(&self) -> Result<Value> {
        self.calls
            .lock()
            .unwrap()
            .push(methods::CLEAR_LIFECYCLE_DIAGNOSTICS.into());
        Ok(json!({ "cleared": true }))
    }

    async fn create_tab_with_context(
        &self,
        _ctx: &BackendRequestContext,
        _url: Option<String>,
    ) -> Result<Value> {
        self.calls.lock().unwrap().push(methods::CREATE_TAB.into());
        Ok(json!({ "id": "created" }))
    }

    async fn execute_cdp_with_context(
        &self,
        _ctx: &BackendRequestContext,
        _tab_id: &str,
        _method: &str,
        _params: Value,
    ) -> Result<Value> {
        self.calls.lock().unwrap().push(methods::EXECUTE_CDP.into());
        Ok(Value::Null)
    }

    async fn tab_command_with_context(
        &self,
        _ctx: &BackendRequestContext,
        method: &str,
        _params: Value,
    ) -> Result<Value> {
        self.calls.lock().unwrap().push(method.into());
        if method == methods::TAB_URL {
            return Ok(Value::String("https://blocked.example/current".into()));
        }
        Ok(Value::Null)
    }

    async fn browser_command_with_context(
        &self,
        _ctx: &BackendRequestContext,
        method: &str,
        _params: Value,
    ) -> Result<Value> {
        self.calls.lock().unwrap().push(method.into());
        Ok(json!({ "method": method }))
    }

    async fn playwright_command_with_context(
        &self,
        _ctx: &BackendRequestContext,
        method: &str,
        _params: Value,
    ) -> Result<Value> {
        self.calls.lock().unwrap().push(method.into());
        Ok(Value::Null)
    }
}

struct BlockNavigationPolicy;

impl HostPolicy for BlockNavigationPolicy {
    fn check_navigation(
        &self,
        url: &str,
        ctx: &PolicyContext<'_>,
    ) -> std::result::Result<(), ErrorObject> {
        if url.contains("blocked.example") {
            return Err(disallowed(
                "navigation blocked",
                json!({ "command": ctx.command, "url": url }),
            ));
        }
        Ok(())
    }
}

struct BlockRawCdpPolicy;

impl HostPolicy for BlockRawCdpPolicy {
    fn check_raw_cdp(
        &self,
        _tab_id: &str,
        method: &str,
        _params: &Value,
        ctx: &PolicyContext<'_>,
    ) -> std::result::Result<(), ErrorObject> {
        if method == "Page.navigate" {
            return Err(disallowed(
                "raw cdp blocked",
                json!({ "command": ctx.command, "method": method }),
            ));
        }
        Ok(())
    }
}

struct BlockUploadPolicy;

impl HostPolicy for BlockUploadPolicy {
    fn check_upload(&self, ctx: &PolicyContext<'_>) -> std::result::Result<(), ErrorObject> {
        Err(disallowed(
            "upload blocked",
            json!({
                "command": ctx.command,
                "tab_id": ctx.tab_id,
                "paths": ctx.params.get("paths").cloned().unwrap_or(Value::Null),
            }),
        ))
    }
}

struct BlockDownloadPolicy;

impl HostPolicy for BlockDownloadPolicy {
    fn check_download(&self, ctx: &PolicyContext<'_>) -> std::result::Result<(), ErrorObject> {
        Err(disallowed(
            "download blocked",
            json!({
                "command": ctx.command,
                "tab_id": ctx.tab_id,
                "download_id": ctx.params.get("download_id").cloned().unwrap_or(Value::Null),
            }),
        ))
    }
}

struct BlockHistoryPolicy;

impl HostPolicy for BlockHistoryPolicy {
    fn check_history(&self, ctx: &PolicyContext<'_>) -> std::result::Result<(), ErrorObject> {
        Err(disallowed(
            "history blocked",
            json!({ "command": ctx.command, "tab_id": ctx.tab_id }),
        ))
    }
}

struct BlockCurrentOriginPolicy;

impl HostPolicy for BlockCurrentOriginPolicy {
    fn needs_current_origin(&self, _command: &str) -> bool {
        true
    }

    fn check_current_origin(
        &self,
        _tab_id: &str,
        url: &str,
        ctx: &PolicyContext<'_>,
    ) -> std::result::Result<(), ErrorObject> {
        if url.contains("blocked.example") {
            return Err(disallowed(
                "current origin blocked",
                json!({ "command": ctx.command, "url": url }),
            ));
        }
        Ok(())
    }
}

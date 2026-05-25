use std::sync::Arc;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use obu_host::{
    backends::{BackendRequestContext, BrowserBackend, cdp::CdpBackend},
    methods,
    service_registry::ServiceRegistry,
};

// DOM-CUA + tab creation require a session-bearing context (no-ctx create_tab
// errors; no-ctx cua_command routes to coordinate-only cua::run). Proven pattern:
// tests/cdp_backend_ops.rs:20-47.
fn ctx() -> BackendRequestContext {
    BackendRequestContext {
        session_id: Some("oopif-e2e".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
        trusted_kernel_generation: None,
    }
}

/// Minimal HTTP server: `/outer` embeds a cross-site iframe; `/inner` has a
/// button that increments `window.__hits`. Returns the bound port.
async fn spawn_cross_site_fixture() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 2048];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let path = req.split_whitespace().nth(1).unwrap_or("/");
            let body = if path.starts_with("/inner") {
                format!(
                    "<!doctype html><button id='inner' style='position:absolute;left:10px;top:10px;width:80px;height:40px' \
                     onclick='window.__hits=(window.__hits||0)+1;document.title=String(window.__hits)'>inner</button>"
                )
            } else {
                format!(
                    "<!doctype html><body style='margin:0'><iframe src='http://b.test:{port}/inner' \
                     style='position:absolute;left:30px;top:60px;width:200px;height:120px;border:0'></iframe></body>"
                )
            };
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = sock.write_all(resp.as_bytes()).await;
        }
    });
    port
}

async fn open_outer(cdp_url: &str, port: u16) -> (CdpBackend, String) {
    let backend = CdpBackend::connect(cdp_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab_with_context(&ctx(), Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();
    backend
        .tab_command_with_context(&ctx(), methods::TAB_GOTO, json!({ "tab_id": tab_id, "url": format!("http://a.test:{port}/outer"), "timeout_ms": 8_000 }))
        .await
        .unwrap();
    // Give auto-attach time to register the OOPIF session.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    (backend, tab_id)
}

#[tokio::test]
#[ignore = "requires Chromium with --site-per-process --host-resolver-rules=MAP *.test 127.0.0.1 on 9223; set OBU_CDP_URL"]
async fn probe_oopif_quads_are_top_level() {
    let cdp_url =
        std::env::var("OBU_CDP_URL").unwrap_or_else(|_| "http://127.0.0.1:9223".to_string());
    let port = spawn_cross_site_fixture().await;
    let (backend, tab_id) = open_outer(&cdp_url, port).await;

    // 1. Enumerate: the inner button must now appear in the visible-DOM snapshot
    //    (proves auto-attach + cross-session enumeration works after Task 3).
    let dom = backend
        .cua_command_with_context(
            &ctx(),
            methods::DOM_CUA_GET_VISIBLE_DOM,
            json!({ "tab_id": tab_id, "observation_id": "p", "format": "compact_text" }),
        )
        .await
        .unwrap();
    let dump = serde_json::to_string(&dom).unwrap();
    assert!(
        dump.contains("inner"),
        "OOPIF button not enumerated: {dump}"
    );

    // 2. Click it via DOM-CUA node_id and confirm the inner counter incremented,
    //    probing the inner page on its OWN session via a raw enumerate of __hits.
    let node_id = dom["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["text"].as_str().unwrap_or("").contains("inner"))
        .and_then(|n| n["node_id"].as_str())
        .expect("inner node_id")
        .to_string();
    backend
        .cua_command_with_context(
            &ctx(),
            methods::DOM_CUA_CLICK,
            json!({ "tab_id": tab_id, "observation_id": "p", "node_id": node_id }),
        )
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    // 3. Read the OOPIF page's click counter (mirrored into its document.title).
    let hits = read_inner_hits(&backend, &tab_id).await;
    assert_eq!(
        hits, 1,
        "OOPIF click did not land (zero-composition model FALSIFIED — see Outcome)"
    );
}

#[tokio::test]
#[ignore = "requires Chromium with --site-per-process --host-resolver-rules=MAP *.test 127.0.0.1 on 9223; set OBU_CDP_URL"]
async fn playwright_selector_clicks_into_oopif() {
    let cdp_url =
        std::env::var("OBU_CDP_URL").unwrap_or_else(|_| "http://127.0.0.1:9223".to_string());
    let port = spawn_cross_site_fixture().await;
    let (backend, tab_id) = open_outer(&cdp_url, port).await;
    backend
        .playwright_command_with_context(
            &ctx(),
            methods::PLAYWRIGHT_LOCATOR_CLICK,
            json!({
                "tab_id": tab_id,
                "selector": "iframe >> internal:control=enter-frame >> #inner",
                "timeout_ms": 8_000
            }),
        )
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert_eq!(
        read_inner_hits(&backend, &tab_id).await,
        1,
        "Playwright cross-origin click did not land"
    );
}

/// The inner (cross-origin) page mirrors its click counter into `document.title`.
/// `Target.getTargets` exposes every target's `title`, so we read the iframe
/// target whose url contains `/inner` — no cross-origin frame eval required.
async fn read_inner_hits(backend: &CdpBackend, tab_id: &str) -> i64 {
    // Default Target.getTargets omits iframe sub-targets — pass an explicit filter.
    let targets = backend
        .execute_cdp(
            tab_id,
            "Target.getTargets",
            json!({ "filter": [{ "type": "iframe" }] }),
        )
        .await
        .unwrap();
    targets["targetInfos"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|t| t["url"].as_str().unwrap_or("").contains("/inner"))
        .and_then(|t| t["title"].as_str())
        .and_then(|title| title.trim().parse::<i64>().ok())
        .unwrap_or(0)
}

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

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
/// button whose click fires `fetch('/hit')`; `/hit` increments a server-side
/// counter. The counter is the click ground-truth — it fires only if the click
/// actually reaches the OOPIF button's `onclick`, and it is read server-side so
/// it never depends on cross-origin frame eval or OOPIF `document.title`
/// propagation (which `Target.getTargets` does not reliably reflect). Returns
/// the bound port and the shared hit counter.
async fn spawn_cross_site_fixture() -> (u16, Arc<AtomicI64>) {
    let hits = Arc::new(AtomicI64::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let hits_server = hits.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                continue;
            };
            // Handle each connection on its own task: Chrome opens speculative and
            // parallel connections (preconnect, favicon, the OOPIF subframe), so a
            // blocking read on one must not starve the others — otherwise a
            // load-blocking resource stalls and the parent frame's load event never
            // fires, hanging navigation.
            let hits_conn = hits_server.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 2048];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req.split_whitespace().nth(1).unwrap_or("/");
                let body = if path.starts_with("/hit") {
                    hits_conn.fetch_add(1, Ordering::SeqCst);
                    String::new()
                } else if path.starts_with("/inner") {
                    // The cache-busting query guarantees each click reaches the
                    // server (no cached GET swallowing the second-and-later hits).
                    "<!doctype html><button id='inner' style='position:absolute;left:10px;top:10px;width:80px;height:40px' \
                     onclick='fetch(\"/hit?\"+Math.random())'>inner</button>".to_string()
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
            });
        }
    });
    (port, hits)
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

/// The click's `fetch('/hit')` is async, so the hit may land after the dispatch
/// returns. Poll the server-side counter for up to ~3s.
async fn wait_for_hits(hits: &AtomicI64) -> i64 {
    for _ in 0..60 {
        let n = hits.load(Ordering::SeqCst);
        if n > 0 {
            return n;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    hits.load(Ordering::SeqCst)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires Chromium with --site-per-process --host-resolver-rules=MAP *.test 127.0.0.1 on 9223; set OBU_CDP_URL"]
async fn probe_oopif_quads_are_top_level() {
    let cdp_url =
        std::env::var("OBU_CDP_URL").unwrap_or_else(|_| "http://127.0.0.1:9223".to_string());
    let (port, hits) = spawn_cross_site_fixture().await;
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

    // 2. Click it via DOM-CUA node_id. The frame-local quad (branch 4c) is composed
    //    with the iframe's root offset and dispatched at the top level; confirm the
    //    inner button's onclick fired by reading the server-side hit counter.
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

    assert_eq!(
        wait_for_hits(&hits).await,
        1,
        "OOPIF DOM-CUA click did not land (branch-4c offset composition or top-level routing failed)"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires Chromium with --site-per-process --host-resolver-rules=MAP *.test 127.0.0.1 on 9223; set OBU_CDP_URL"]
async fn playwright_selector_clicks_into_oopif() {
    let cdp_url =
        std::env::var("OBU_CDP_URL").unwrap_or_else(|_| "http://127.0.0.1:9223".to_string());
    let (port, hits) = spawn_cross_site_fixture().await;
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
    assert_eq!(
        wait_for_hits(&hits).await,
        1,
        "Playwright cross-origin click did not land"
    );
}

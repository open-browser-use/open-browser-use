use std::sync::Arc;

use serde_json::json;

use obu_host::{
    backends::{BackendRequestContext, BrowserBackend, cdp::CdpBackend},
    error::HostError,
    methods,
    service_registry::ServiceRegistry,
};

const OVERLAY_PAGE: &str = "data:text/html,<style>[id=cover]{position:fixed;inset:0;background:rgba(0,0,0,.1);z-index:9}</style>\
<button id='b' style='position:fixed;left:20px;top:20px' onclick='window._=(window._||0)+1'>Click me</button><div id='cover'></div>";

// create_tab(no-ctx) errors ("createTab requires session_id"); the session-bearing
// context path is the working one (see tests/cdp_backend_ops.rs:20-47).
fn ctx() -> BackendRequestContext {
    BackendRequestContext {
        session_id: Some("e2e".into()),
        turn_id: Some("turn".into()),
        client_timeout_ms: None,
        trusted_kernel_generation: None,
    }
}

async fn open(cdp_url: &str, html: &str) -> (CdpBackend, String) {
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
        .tab_command_with_context(
            &ctx(),
            methods::TAB_GOTO,
            json!({ "tab_id": tab_id, "url": html, "timeout_ms": 5_000 }),
        )
        .await
        .unwrap();
    (backend, tab_id)
}

#[tokio::test]
#[ignore = "requires Chromium with --remote-debugging-port; set OBU_CDP_URL"]
async fn occluded_button_fails_fast_with_resolution() {
    let cdp_url =
        std::env::var("OBU_CDP_URL").unwrap_or_else(|_| "http://127.0.0.1:9223".to_string());
    let (backend, tab_id) = open(&cdp_url, OVERLAY_PAGE).await;
    let error = backend
        .playwright_command_with_context(
            &ctx(),
            methods::PLAYWRIGHT_LOCATOR_CLICK,
            json!({ "tab_id": tab_id, "selector": "#b", "timeout_ms": 5_000 }),
        )
        .await
        .unwrap_err();
    match error {
        HostError::Rpc {
            data: Some(data), ..
        } => assert_eq!(data["resolution"], "occluded"),
        other => panic!("expected occluded, got {other:?}"),
    }
}

#[tokio::test]
#[ignore = "requires Chromium with --remote-debugging-port; set OBU_CDP_URL"]
async fn force_click_bypasses_hit_test() {
    let cdp_url =
        std::env::var("OBU_CDP_URL").unwrap_or_else(|_| "http://127.0.0.1:9223".to_string());
    let (backend, tab_id) = open(&cdp_url, OVERLAY_PAGE).await;
    // force:true SKIPS the hit-test, so this call SUCCEEDS where the non-force
    // click (occluded_button_fails_fast_with_resolution) fails with `occluded`.
    // We assert only that it returns Ok: the dispatched click lands at the
    // button's coordinates, which the cover legitimately intercepts — so the
    // button's onclick does not fire, which is correct real-browser behavior for
    // a forced click through an occluder.
    backend
        .playwright_command_with_context(
            &ctx(),
            methods::PLAYWRIGHT_LOCATOR_CLICK,
            json!({ "tab_id": tab_id, "selector": "#b", "force": true, "timeout_ms": 5_000 }),
        )
        .await
        .expect("force:true should bypass the occlusion hit-test and return Ok");
}

#[tokio::test]
#[ignore = "requires Chromium with --remote-debugging-port; set OBU_CDP_URL"]
async fn screenshot_is_coordinate_valid_and_pixel_hits_element() {
    let cdp_url =
        std::env::var("OBU_CDP_URL").unwrap_or_else(|_| "http://127.0.0.1:9223".to_string());
    let page = "data:text/html,<button id='b' style='position:fixed;left:40px;top:50px;width:60px;height:30px' onclick='window._=1'>x</button>";
    let (backend, tab_id) = open(&cdp_url, page).await;
    let shot = backend
        .tab_command_with_context(
            &ctx(),
            methods::TAB_SCREENSHOT,
            json!({ "tab_id": tab_id, "fullPage": false, "timeout_ms": 5_000 }),
        )
        .await
        .unwrap();
    assert_eq!(shot["coordinateValid"], true);
    // Click the element center in screenshot/visualViewport px and confirm it fired.
    backend
        .execute_cdp(
            &tab_id,
            "Input.dispatchMouseEvent",
            json!({ "type": "mousePressed", "x": 70, "y": 65, "button": "left", "clickCount": 1 }),
        )
        .await
        .unwrap();
    backend
        .execute_cdp(
            &tab_id,
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseReleased", "x": 70, "y": 65, "button": "left", "clickCount": 1 }),
        )
        .await
        .unwrap();
    let probe = backend
        .execute_cdp(
            &tab_id,
            "Runtime.evaluate",
            json!({ "expression": "window._ === 1", "returnByValue": true }),
        )
        .await
        .unwrap();
    assert_eq!(probe["result"]["value"], true);
}

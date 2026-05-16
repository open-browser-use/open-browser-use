use std::sync::Arc;

use serde_json::json;

use obu_host::{
    backends::{BrowserBackend, cdp::CdpBackend},
    methods,
    service_registry::ServiceRegistry,
};

#[tokio::test]
#[ignore = "requires Chromium with --remote-debugging-port; set OBU_CDP_URL"]
async fn playwright_locator_click_fires_click_event() {
    let cdp_url =
        std::env::var("OBU_CDP_URL").unwrap_or_else(|_| "http://127.0.0.1:9223".to_string());
    let backend = CdpBackend::connect(&cdp_url, Arc::new(ServiceRegistry::default()))
        .await
        .unwrap();
    let created = backend
        .create_tab(Some("about:blank".into()))
        .await
        .unwrap();
    let tab_id = created["id"].as_str().unwrap().to_string();
    backend.attach(&tab_id).await.unwrap();
    backend
        .tab_command(
            methods::TAB_GOTO,
            json!({
                "tab_id": tab_id,
                "url": "data:text/html,<button id='b' onclick='window.clicked=(window.clicked||0)+1'>Click me</button>",
                "timeout_ms": 5_000,
            }),
        )
        .await
        .unwrap();

    backend
        .playwright_command(
            methods::PLAYWRIGHT_LOCATOR_CLICK,
            json!({
                "tab_id": tab_id,
                "selector": "#b",
                "timeout_ms": 5_000,
            }),
        )
        .await
        .unwrap();
    let box_ = backend
        .playwright_command(
            methods::PLAYWRIGHT_LOCATOR_BOUNDING_BOX,
            json!({
                "tab_id": tab_id,
                "selector": "#b",
                "timeout_ms": 5_000,
            }),
        )
        .await
        .unwrap();
    let shot = backend
        .playwright_command(
            methods::PLAYWRIGHT_SCREENSHOT,
            json!({
                "tab_id": tab_id,
                "cropX": box_["x"],
                "cropY": box_["y"],
                "cropWidth": box_["width"],
                "cropHeight": box_["height"],
                "timeout_ms": 5_000,
            }),
        )
        .await
        .unwrap();
    assert_eq!(shot["mime_type"], "image/png");
    assert!(
        shot["data_base64"].as_str().unwrap_or_default().len() > 1024,
        "element screenshot should be non-empty; got {shot}"
    );
    let probe = backend
        .execute_cdp(
            &tab_id,
            "Runtime.evaluate",
            json!({ "expression": "window.clicked === 1", "returnByValue": true }),
        )
        .await
        .unwrap();
    assert_eq!(probe["result"]["value"], true);
}

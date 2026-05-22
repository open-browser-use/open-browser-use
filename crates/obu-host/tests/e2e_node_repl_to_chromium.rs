#![cfg(unix)]

use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::process::{Child, Command};

#[path = "common/node_repl_mcp.rs"]
mod node_repl_harness;
use node_repl_harness::{
    NodeReplHandle, NodeReplOpts, prepare_built_sdk_module_root, spawn_node_repl, wait_for_socket,
};

#[tokio::test]
#[ignore = "requires headless Chromium on 9223, built @open-browser-use/sdk, and built obu-node-repl"]
async fn end_to_end_click_visible_screenshot() {
    let sdk = prepare_built_sdk_module_root();
    let sock_dir = tempfile::tempdir().unwrap();
    let sock_path = sock_dir.path().join("e2e.sock");
    let download_name = format!(
        "p2-download-{}.txt",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
    );
    let fixture_url = spawn_fixture_server(download_name.clone()).await;
    let upload_dir = tempfile::tempdir().unwrap();
    let upload_path = upload_dir.path().join("upload.txt");
    std::fs::write(&upload_path, "upload content").unwrap();
    let cdp_url =
        std::env::var("OBU_CDP_URL").unwrap_or_else(|_| "http://127.0.0.1:9223".to_string());
    let cap_token = "test-cap-token-please-rotate";

    let mut host: Child = Command::new(env!("CARGO_BIN_EXE_obu-host"))
        .arg("--socket")
        .arg(&sock_path)
        .arg("--cdp-url")
        .arg(&cdp_url)
        .arg("--peer-auth")
        .arg("auto")
        .env("OBU_CAPABILITY_TOKEN", cap_token)
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn obu-host");
    wait_for_socket(&sock_path, Duration::from_secs(5))
        .await
        .expect("obu-host bound the socket within 5s");

    let mcp: NodeReplHandle = spawn_node_repl(&NodeReplOpts {
        envs: vec![
            ("OBU_CAPABILITY_TOKEN".to_string(), cap_token.to_string()),
            (
                "OBU_BACKENDS".to_string(),
                format!("cdp:chromium:{}", sock_path.display()),
            ),
            (
                "OBU_NODE_REPL_MODULE_DIRS".to_string(),
                sdk.root.display().to_string(),
            ),
            ("OBU_TRUSTED_MODULE_SHA256S".to_string(), sdk.hash.clone()),
        ],
    })
    .await;

    let fixture_url_json = serde_json::to_string(&fixture_url).unwrap();
    let upload_path_json = serde_json::to_string(&upload_path.display().to_string()).unwrap();
    let download_name_json = serde_json::to_string(&download_name).unwrap();
    let agent_script = r##"
        const fixtureUrl = __FIXTURE_URL__;
        const uploadPath = __UPLOAD_PATH__;
        const downloadName = __DOWNLOAD_NAME__;
        const browser = await agent.browsers.get("cdp");
        const tab = await browser.tabs.create();
        await tab.attach();
        await tab.goto(fixtureUrl);
        await tab.waitForLoadState("load", { timeout: 10_000 });
        await tab.locator("#b").click();
        const visible = await tab.locator("#b").isVisible();
        const shot = await tab.content.export({ format: "png" });
        const probe = await tab.dev.cdp("Runtime.evaluate",
            { expression: "window._ === true", returnByValue: true });
        await tab.locator("#locator-nav").click({
            timeout: 10_000,
            waitForNavigation: { waitUntil: "load", timeout: 10_000 }
        });
        const locatorNavProbe = await tab.dev.cdp("Runtime.evaluate",
            { expression: "location.search", returnByValue: true });
        const navBox = await tab.locator("#nav").boundingBox();
        if (!navBox) throw new Error("missing CUA navigation button bounding box");
        await tab.cua.click(
            navBox.x + navBox.width / 2,
            navBox.y + navBox.height / 2,
            {
                timeout: 10_000,
                waitForNavigation: { waitUntil: "load", timeout: 10_000 }
            }
        );
        const navProbe = await tab.dev.cdp("Runtime.evaluate",
            { expression: "location.search", returnByValue: true });
        const nestedBox = await tab.locator("#nested-scroll").boundingBox();
        if (!nestedBox) throw new Error("missing nested scroll box");
        const beforeNestedScroll = await tab.dev.cdp("Runtime.evaluate",
            { expression: "document.querySelector('#nested-scroll').scrollTop", returnByValue: true });
        await tab.cua.scroll(nestedBox.x + 20, nestedBox.y + 20, 260, { timeout: 10_000 });
        await tab.waitForTimeout(100);
        const afterNestedScroll = await tab.dev.cdp("Runtime.evaluate",
            { expression: "document.querySelector('#nested-scroll').scrollTop", returnByValue: true });
        const beforeScroll = await tab.dev.cdp("Runtime.evaluate",
            { expression: "window.scrollY", returnByValue: true });
        await tab.cua.scroll(500, 500, 700, { timeout: 10_000 });
        await tab.waitForTimeout(100);
        const afterScroll = await tab.dev.cdp("Runtime.evaluate",
            { expression: "window.scrollY", returnByValue: true });

        const chooserPromise = tab.waitForEvent("filechooser", { timeout: 10_000 });
        await tab.locator("#upload").click();
        const chooser = await chooserPromise;
        await chooser.setFiles(uploadPath);
        let staleChooserMessage = "";
        try {
            await chooser.setFiles(uploadPath);
        } catch (error) {
            staleChooserMessage = String(error?.message ?? error);
        }
        const uploadProbe = await tab.dev.cdp("Runtime.evaluate", {
            expression: `({
                fileName: document.querySelector("#upload").files[0]?.name ?? "",
                fileCount: document.querySelector("#upload").files.length
            })`,
            returnByValue: true
        });

        const downloadPromise = tab.waitForEvent("download", { timeout: 10_000 });
        await tab.locator("#download-link").click();
        const download = await downloadPromise;
        const downloadPath = await download.path();

        const finalized = await browser.finalizeTabs({
            keep: [{ tabId: tab.id, status: "deliverable" }],
            timeout: 10_000
        });
        const listedAfterFinalize = await browser.tabs.list();
        const listedAfterFinalizeTab = listedAfterFinalize.find((row) => row.id === tab.id);
        const refreshed = await agent.browsers.get("cdp");
        const lifecycle = refreshed.info.metadata?.diagnostics?.lifecycle ?? {};
        const deliverableSummary = (lifecycle.deliverable_tab_summaries ?? [])
            .find((row) => row.tab_id === String(tab.id));

        JSON.stringify({
            tabId: String(tab.id),
            visible,
            clickEffect: probe.result.value,
            screenshotBytes: shot.data_base64.length,
            locatorNavigationHash: locatorNavProbe.result.value,
            cuaNavigationHash: navProbe.result.value,
            beforeNestedScroll: beforeNestedScroll.result.value,
            afterNestedScroll: afterNestedScroll.result.value,
            beforeScroll: beforeScroll.result.value,
            afterScroll: afterScroll.result.value,
            upload: uploadProbe.result.value,
            staleChooserMessage,
            downloadId: download.id,
            downloadPath,
            downloadPathIncludesName: downloadPath.includes(downloadName),
            deliverableStatus: finalized.deliverableTabs[0]?.status,
            listedAfterFinalizeStatus: listedAfterFinalizeTab?.metadata?.status,
            deliverableCount: lifecycle.deliverable_tabs ?? -1,
            deliverableSummaryTabId: deliverableSummary?.tab_id,
            deliverableSummaryUrl: deliverableSummary?.url,
        })
    "##
    .replace("__FIXTURE_URL__", &fixture_url_json)
    .replace("__UPLOAD_PATH__", &upload_path_json)
    .replace("__DOWNLOAD_NAME__", &download_name_json);
    let raw: Value = mcp
        .call_tool("js", json!({ "source": agent_script }))
        .await
        .expect("js tool call");
    let payload: Value =
        serde_json::from_str(raw["result"].as_str().expect("js result is a string"))
            .expect("decode payload");

    assert_eq!(
        payload["visible"],
        Value::Bool(true),
        "button must remain visible after click; got {raw}"
    );
    assert_eq!(
        payload["clickEffect"],
        Value::Bool(true),
        "window._ must be set by the onclick handler; got {raw}"
    );
    let bytes = payload["screenshotBytes"]
        .as_u64()
        .expect("screenshotBytes is a number");
    assert!(
        bytes > 1024,
        "screenshot must be > 1KiB base64; got {bytes}"
    );
    assert_eq!(
        payload["locatorNavigationHash"],
        json!("?locator-nav=1"),
        "locator click waitForNavigation must observe document navigation; got {raw}"
    );
    assert_eq!(
        payload["cuaNavigationHash"],
        json!("?cua-nav=1"),
        "CUA click waitForNavigation must observe document navigation; got {raw}"
    );
    assert!(
        payload["afterNestedScroll"].as_f64().unwrap_or_default()
            > payload["beforeNestedScroll"].as_f64().unwrap_or_default() + 50.0,
        "CUA scroll must move the nested scroll container; got {raw}"
    );
    assert!(
        payload["afterScroll"].as_f64().unwrap_or_default()
            > payload["beforeScroll"].as_f64().unwrap_or_default() + 50.0,
        "CUA scroll must move the page; got {raw}"
    );
    assert_eq!(payload["upload"]["fileName"], json!("upload.txt"));
    assert_eq!(payload["upload"]["fileCount"], json!(1));
    assert!(
        payload["staleChooserMessage"]
            .as_str()
            .unwrap_or_default()
            .contains("already consumed by setFiles"),
        "reusing consumed file chooser handle must include stale reason; got {raw}"
    );
    assert!(
        payload["downloadId"].as_str().unwrap_or_default().len() > 4,
        "download handle id must be present; got {raw}"
    );
    assert_eq!(
        payload["downloadPathIncludesName"],
        Value::Bool(true),
        "download path must include suggested filename; got {raw}"
    );
    assert_eq!(
        payload["deliverableStatus"],
        json!("deliverable"),
        "finalizeTabs must mark the tab deliverable; got {raw}"
    );
    assert_eq!(
        payload["listedAfterFinalizeStatus"],
        json!("deliverable"),
        "CDP listTabs must preserve host-owned deliverable status; got {raw}"
    );
    assert!(
        payload["deliverableCount"].as_i64().unwrap_or_default() >= 1,
        "lifecycle diagnostics must count deliverable tabs; got {raw}"
    );
    assert_eq!(
        payload["deliverableSummaryTabId"], payload["tabId"],
        "lifecycle diagnostics must summarize the deliverable tab; got {raw}"
    );
    assert!(
        payload["deliverableSummaryUrl"]
            .as_str()
            .is_some_and(|url| !url.is_empty()),
        "deliverable tab summary must include a URL; got {raw}"
    );

    let _ = mcp.shutdown().await;
    host.kill().await.unwrap();
}

async fn spawn_fixture_server(download_name: String) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let download_name = download_name.clone();
            tokio::spawn(async move {
                let mut buffer = [0u8; 2048];
                let _ = stream.read(&mut buffer).await;
                let request = String::from_utf8_lossy(&buffer);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");
                if path == format!("/{download_name}") {
                    let body = "download payload\n";
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-disposition: attachment; filename=\"{}\"\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        download_name,
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    return;
                }
                let body = r#"<!doctype html>
<html>
  <style>
    body { min-height: 2400px; }
    #nested-scroll { border: 1px solid #888; height: 90px; margin-top: 24px; overflow: auto; width: 260px; }
    #nested-scroll-content { height: 480px; padding-top: 220px; }
    #download-link { display: block; margin-top: 1200px; }
  </style>
  <body>
    <button id="b" onclick="window._ = true">Click me</button>
    <button id="locator-nav" onclick="location.href = '/?locator-nav=1'">Locator nav</button>
    <button id="nav" onclick="location.href = '/?cua-nav=1'">CUA nav</button>
    <div id="nested-scroll"><div id="nested-scroll-content">Nested scroll target</div></div>
    <input id="upload" type="file">
    <a id="download-link" href="/__DOWNLOAD_NAME__" download="__DOWNLOAD_NAME__">Download file</a>
  </body>
</html>"#
                    .replace("__DOWNLOAD_NAME__", &download_name);
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });
    format!("http://{addr}/")
}

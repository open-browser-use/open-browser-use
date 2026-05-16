#![cfg(unix)]

use std::process::Stdio;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::process::{Child, Command};

#[path = "common/node_repl_mcp.rs"]
mod node_repl_harness;
use node_repl_harness::{
    NodeReplOpts, prepare_built_sdk_module_root, spawn_node_repl, wait_for_socket,
};

#[tokio::test]
#[ignore = "requires headless Chromium on 9223, built @open-browser-use/sdk, and built obu-node-repl"]
async fn kill_host_mid_call_rejects_pending_with_transport_closed() {
    let sdk = prepare_built_sdk_module_root();
    let sock_dir = tempfile::tempdir().unwrap();
    let sock_path = sock_dir.path().join("kill.sock");
    let cdp_url =
        std::env::var("OBU_CDP_URL").unwrap_or_else(|_| "http://127.0.0.1:9223".to_string());
    let cap = "kill-test-token";

    let mut host: Child = Command::new(env!("CARGO_BIN_EXE_obu-host"))
        .arg("--socket")
        .arg(&sock_path)
        .arg("--cdp-url")
        .arg(&cdp_url)
        .env("OBU_CAPABILITY_TOKEN", cap)
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn obu-host");
    wait_for_socket(&sock_path, Duration::from_secs(5))
        .await
        .unwrap();

    let mcp = spawn_node_repl(&NodeReplOpts {
        envs: vec![
            ("OBU_CAPABILITY_TOKEN".to_string(), cap.to_string()),
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

    let script = r##"
        const browser = await agent.browsers.get("cdp");
        const tab = await browser.tabs.create();
        await tab.attach();
        await tab.goto("data:text/html,<div id='x' style='visibility:visible'>x</div>");
        const p = tab.locator("#x").waitFor({ state: "hidden", timeout: 60_000 })
            .then(
                () => ({ ok: true }),
                (e) => ({ ok: false, message: String(e.message ?? e), code: e.code ?? null }),
            );
        display({ text: "READY_FOR_KILL" });
        JSON.stringify(await p)
    "##;

    let call = tokio::spawn({
        let mcp = mcp.clone();
        async move { mcp.call_tool("js", json!({ "source": script })).await }
    });
    tokio::time::sleep(Duration::from_millis(400)).await;
    host.kill().await.unwrap();

    match call.await.unwrap() {
        Ok(raw) => {
            let payload: Value = serde_json::from_str(raw["result"].as_str().unwrap()).unwrap();
            assert_eq!(
                payload["ok"],
                Value::Bool(false),
                "expected failure; got {raw}"
            );
            let msg = payload["message"].as_str().unwrap();
            assert!(
                msg.contains("transport closed") || msg.contains("EOF") || msg.contains("closed"),
                "expected transport-closed error; got {msg}"
            );
        }
        Err(error) => {
            let msg = error.to_string();
            assert!(
                msg.contains("transport closed") || msg.contains("EOF") || msg.contains("closed"),
                "expected transport-closed MCP error; got {msg}"
            );
        }
    }
    let _ = mcp.shutdown().await;
}

#[tokio::test]
#[ignore = "requires built @open-browser-use/sdk and built obu-node-repl"]
async fn wrong_capability_token_yields_minus_1100() {
    let sdk = prepare_built_sdk_module_root();
    let sock_dir = tempfile::tempdir().unwrap();
    let sock_path = sock_dir.path().join("wrong.sock");
    let cdp_url =
        std::env::var("OBU_CDP_URL").unwrap_or_else(|_| "http://127.0.0.1:9223".to_string());

    let mut host: Child = Command::new(env!("CARGO_BIN_EXE_obu-host"))
        .arg("--socket")
        .arg(&sock_path)
        .arg("--cdp-url")
        .arg(&cdp_url)
        .env("OBU_CAPABILITY_TOKEN", "tokenA-correct")
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn obu-host");
    wait_for_socket(&sock_path, Duration::from_secs(5))
        .await
        .unwrap();

    let mcp = spawn_node_repl(&NodeReplOpts {
        envs: vec![
            (
                "OBU_CAPABILITY_TOKEN".to_string(),
                "tokenB-wrong".to_string(),
            ),
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

    let script = r##"
        JSON.stringify(await (async () => {
            try {
                await agent.browsers.get("cdp");
                return { ok: true };
            } catch (e) {
                return { ok: false, message: String(e.message ?? e), code: e.code ?? null };
            }
        })())
    "##;
    let raw: Value = mcp
        .call_tool("js", json!({ "source": script }))
        .await
        .expect("js call");
    let payload: Value = serde_json::from_str(raw["result"].as_str().unwrap()).unwrap();
    assert_eq!(
        payload["ok"],
        Value::Bool(false),
        "expected auth failure; got {raw}"
    );
    assert_eq!(
        payload["code"].as_i64(),
        Some(-1100),
        "expected ERR_PEER_AUTH (-1100); got {raw}"
    );
    let msg = payload["message"].as_str().unwrap();
    assert!(
        msg.contains("auth rejected") || msg.contains("capability"),
        "expected auth/capability-token message; got {msg}"
    );
    host.kill().await.unwrap();
    let _ = mcp.shutdown().await;
}

#[tokio::test]
#[ignore = "requires headless Chromium on 9223, built @open-browser-use/sdk, and built obu-node-repl"]
async fn raw_cdp_navigation_policy_denial_yields_minus_1002() {
    let sdk = prepare_built_sdk_module_root();
    let sock_dir = tempfile::tempdir().unwrap();
    let sock_path = sock_dir.path().join("policy.sock");
    let cdp_url =
        std::env::var("OBU_CDP_URL").unwrap_or_else(|_| "http://127.0.0.1:9223".to_string());
    let cap = "policy-token";

    let mut host: Child = Command::new(env!("CARGO_BIN_EXE_obu-host"))
        .arg("--socket")
        .arg(&sock_path)
        .arg("--cdp-url")
        .arg(&cdp_url)
        .env("OBU_CAPABILITY_TOKEN", cap)
        .env("OBU_HOST_POLICY_DENY_ORIGINS", "https://blocked.example")
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn obu-host");
    wait_for_socket(&sock_path, Duration::from_secs(5))
        .await
        .unwrap();

    let mcp = spawn_node_repl(&NodeReplOpts {
        envs: vec![
            ("OBU_CAPABILITY_TOKEN".to_string(), cap.to_string()),
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

    let script = r##"
        const browser = await agent.browsers.get("cdp");
        const tab = await browser.tabs.create();
        await tab.attach();
        await tab.goto("data:text/html,<title>policy</title><body>policy</body>");
        JSON.stringify(await (async () => {
            try {
                await tab.dev.cdp("Page.navigate", { url: "https://blocked.example/raw-cdp" });
                return { ok: true };
            } catch (e) {
                return { ok: false, message: String(e.message ?? e), code: e.code ?? null };
            }
        })())
    "##;
    let raw: Value = mcp
        .call_tool("js", json!({ "source": script }))
        .await
        .expect("js call");
    let payload: Value = serde_json::from_str(raw["result"].as_str().unwrap()).unwrap();
    assert_eq!(
        payload["ok"],
        Value::Bool(false),
        "expected policy denial; got {raw}"
    );
    assert_eq!(
        payload["code"].as_i64(),
        Some(-1002),
        "expected ERR_DISALLOWED (-1002); got {raw}"
    );
    let msg = payload["message"].as_str().unwrap();
    assert!(
        msg.contains("blocked by local host policy"),
        "expected host policy denial message; got {msg}"
    );

    host.kill().await.unwrap();
    let _ = mcp.shutdown().await;
}

#[tokio::test]
#[ignore = "requires headless Chromium on 9223, built @open-browser-use/sdk, and built obu-node-repl"]
async fn current_origin_policy_denial_blocks_tab_close_before_backend_call() {
    let sdk = prepare_built_sdk_module_root();
    let (redirect_url, denied_origin) = spawn_redirect_to_denied_origin_fixture().await;
    let sock_dir = tempfile::tempdir().unwrap();
    let sock_path = sock_dir.path().join("current-origin-policy.sock");
    let cdp_url =
        std::env::var("OBU_CDP_URL").unwrap_or_else(|_| "http://127.0.0.1:9223".to_string());
    let cap = "current-origin-policy-token";

    let mut host: Child = Command::new(env!("CARGO_BIN_EXE_obu-host"))
        .arg("--socket")
        .arg(&sock_path)
        .arg("--cdp-url")
        .arg(&cdp_url)
        .env("OBU_CAPABILITY_TOKEN", cap)
        .env("OBU_HOST_POLICY_DENY_ORIGINS", &denied_origin)
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn obu-host");
    wait_for_socket(&sock_path, Duration::from_secs(5))
        .await
        .unwrap();

    let mcp = spawn_node_repl(&NodeReplOpts {
        envs: vec![
            ("OBU_CAPABILITY_TOKEN".to_string(), cap.to_string()),
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

    let redirect_url_json = serde_json::to_string(&redirect_url).unwrap();
    let script = r##"
        const redirectUrl = __REDIRECT_URL__;
        const browser = await agent.browsers.get("cdp");
        const tab = await browser.tabs.create();
        await tab.attach();
        await tab.goto(redirectUrl);
        JSON.stringify(await (async () => {
            try {
                await tab.close({ timeout: 10_000 });
                return { ok: true };
            } catch (e) {
                const tabs = await browser.tabs.list();
                return {
                    ok: false,
                    message: String(e.message ?? e),
                    code: e.code ?? null,
                    stillListed: tabs.some((row) => String(row.id) === String(tab.id)),
                };
            }
        })())
    "##
    .replace("__REDIRECT_URL__", &redirect_url_json);
    let raw: Value = mcp
        .call_tool("js", json!({ "source": script }))
        .await
        .expect("js call");
    let payload: Value = serde_json::from_str(raw["result"].as_str().unwrap()).unwrap();
    assert_eq!(
        payload["ok"],
        Value::Bool(false),
        "expected current-origin policy denial; got {raw}"
    );
    assert_eq!(
        payload["code"].as_i64(),
        Some(-1002),
        "expected ERR_DISALLOWED (-1002); got {raw}"
    );
    let msg = payload["message"].as_str().unwrap();
    assert!(
        msg.contains("current origin blocked by local host policy"),
        "expected current-origin policy denial message; got {msg}"
    );
    assert_eq!(
        payload["stillListed"],
        Value::Bool(true),
        "tab.close must be blocked before the backend closes the tab; got {raw}"
    );

    host.kill().await.unwrap();
    let _ = mcp.shutdown().await;
}

#[tokio::test]
#[ignore = "requires headless Chromium on 9223, built @open-browser-use/sdk, and built obu-node-repl"]
async fn upload_policy_denial_blocks_set_files_before_backend_call() {
    let sdk = prepare_built_sdk_module_root();
    let fixture_url = spawn_upload_policy_fixture().await;
    let upload_dir = tempfile::tempdir().unwrap();
    let upload_path = upload_dir.path().join("blocked-upload.txt");
    std::fs::write(&upload_path, "blocked upload content").unwrap();
    let sock_dir = tempfile::tempdir().unwrap();
    let sock_path = sock_dir.path().join("upload-policy.sock");
    let cdp_url =
        std::env::var("OBU_CDP_URL").unwrap_or_else(|_| "http://127.0.0.1:9223".to_string());
    let cap = "upload-policy-token";

    let mut host: Child = Command::new(env!("CARGO_BIN_EXE_obu-host"))
        .arg("--socket")
        .arg(&sock_path)
        .arg("--cdp-url")
        .arg(&cdp_url)
        .env("OBU_CAPABILITY_TOKEN", cap)
        .env("OBU_HOST_POLICY_BLOCK_UPLOADS", "1")
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn obu-host");
    wait_for_socket(&sock_path, Duration::from_secs(5))
        .await
        .unwrap();

    let mcp = spawn_node_repl(&NodeReplOpts {
        envs: vec![
            ("OBU_CAPABILITY_TOKEN".to_string(), cap.to_string()),
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
    let script = r##"
        const fixtureUrl = __FIXTURE_URL__;
        const uploadPath = __UPLOAD_PATH__;
        const browser = await agent.browsers.get("cdp");
        const tab = await browser.tabs.create();
        await tab.attach();
        await tab.goto(fixtureUrl);
        const chooserPromise = tab.waitForEvent("filechooser", { timeout: 10_000 });
        await tab.locator("#upload").click();
        const chooser = await chooserPromise;
        JSON.stringify(await (async () => {
            try {
                await chooser.setFiles(uploadPath);
                return { ok: true };
            } catch (e) {
                const probe = await tab.dev.cdp("Runtime.evaluate", {
                    expression: "document.querySelector('#upload').files.length",
                    returnByValue: true,
                });
                return {
                    ok: false,
                    message: String(e.message ?? e),
                    code: e.code ?? null,
                    fileCount: probe.result.value,
                };
            }
        })())
    "##
    .replace("__FIXTURE_URL__", &fixture_url_json)
    .replace("__UPLOAD_PATH__", &upload_path_json);
    let raw: Value = mcp
        .call_tool("js", json!({ "source": script }))
        .await
        .expect("js call");
    let payload: Value = serde_json::from_str(raw["result"].as_str().unwrap()).unwrap();
    assert_eq!(
        payload["ok"],
        Value::Bool(false),
        "expected upload policy denial; got {raw}"
    );
    assert_eq!(
        payload["code"].as_i64(),
        Some(-1002),
        "expected ERR_DISALLOWED (-1002); got {raw}"
    );
    let msg = payload["message"].as_str().unwrap();
    assert!(
        msg.contains("upload blocked by local host policy"),
        "expected upload policy denial message; got {msg}"
    );
    assert_eq!(
        payload["fileCount"],
        json!(0),
        "file chooser setFiles must be blocked before DOM.setFileInputFiles; got {raw}"
    );

    host.kill().await.unwrap();
    let _ = mcp.shutdown().await;
}

#[tokio::test]
#[ignore = "requires headless Chromium on 9223, built @open-browser-use/sdk, and built obu-node-repl"]
async fn download_policy_denial_blocks_locator_download_before_backend_call() {
    let sdk = prepare_built_sdk_module_root();
    let (fixture_url, download_requests) = spawn_download_policy_fixture().await;
    let sock_dir = tempfile::tempdir().unwrap();
    let sock_path = sock_dir.path().join("download-policy.sock");
    let cdp_url =
        std::env::var("OBU_CDP_URL").unwrap_or_else(|_| "http://127.0.0.1:9223".to_string());
    let cap = "download-policy-token";

    let mut host: Child = Command::new(env!("CARGO_BIN_EXE_obu-host"))
        .arg("--socket")
        .arg(&sock_path)
        .arg("--cdp-url")
        .arg(&cdp_url)
        .env("OBU_CAPABILITY_TOKEN", cap)
        .env("OBU_HOST_POLICY_BLOCK_DOWNLOADS", "1")
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn obu-host");
    wait_for_socket(&sock_path, Duration::from_secs(5))
        .await
        .unwrap();

    let mcp = spawn_node_repl(&NodeReplOpts {
        envs: vec![
            ("OBU_CAPABILITY_TOKEN".to_string(), cap.to_string()),
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
    let script = r##"
        const fixtureUrl = __FIXTURE_URL__;
        const browser = await agent.browsers.get("cdp");
        const tab = await browser.tabs.create();
        await tab.attach();
        await tab.goto(fixtureUrl);
        JSON.stringify(await (async () => {
            try {
                await tab.locator("#download-link").download_media({ timeout: 10_000 });
                return { ok: true };
            } catch (e) {
                return {
                    ok: false,
                    message: String(e.message ?? e),
                    code: e.code ?? null,
                };
            }
        })())
    "##
    .replace("__FIXTURE_URL__", &fixture_url_json);
    let raw: Value = mcp
        .call_tool("js", json!({ "source": script }))
        .await
        .expect("js call");
    let payload: Value = serde_json::from_str(raw["result"].as_str().unwrap()).unwrap();
    assert_eq!(
        payload["ok"],
        Value::Bool(false),
        "expected download policy denial; got {raw}"
    );
    assert_eq!(
        payload["code"].as_i64(),
        Some(-1002),
        "expected ERR_DISALLOWED (-1002); got {raw}"
    );
    let msg = payload["message"].as_str().unwrap();
    assert!(
        msg.contains("download blocked by local host policy"),
        "expected download policy denial message; got {msg}"
    );
    assert_eq!(
        download_requests.load(Ordering::SeqCst),
        0,
        "locator download_media must be blocked before the page requests /download.txt; got {raw}"
    );

    host.kill().await.unwrap();
    let _ = mcp.shutdown().await;
}

#[tokio::test]
#[ignore = "requires headless Chromium on 9223, built @open-browser-use/sdk, and built obu-node-repl"]
async fn stale_download_handle_after_tab_cleanup_reports_stale_reason() {
    let sdk = prepare_built_sdk_module_root();
    let (fixture_url, _) = spawn_download_policy_fixture().await;
    let sock_dir = tempfile::tempdir().unwrap();
    let sock_path = sock_dir.path().join("stale-download.sock");
    let cdp_url =
        std::env::var("OBU_CDP_URL").unwrap_or_else(|_| "http://127.0.0.1:9223".to_string());
    let cap = "stale-download-token";

    let mut host: Child = Command::new(env!("CARGO_BIN_EXE_obu-host"))
        .arg("--socket")
        .arg(&sock_path)
        .arg("--cdp-url")
        .arg(&cdp_url)
        .env("OBU_CAPABILITY_TOKEN", cap)
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn obu-host");
    wait_for_socket(&sock_path, Duration::from_secs(5))
        .await
        .unwrap();

    let mcp = spawn_node_repl(&NodeReplOpts {
        envs: vec![
            ("OBU_CAPABILITY_TOKEN".to_string(), cap.to_string()),
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
    let script = r##"
        const fixtureUrl = __FIXTURE_URL__;
        const browser = await agent.browsers.get("cdp");
        const tab = await browser.tabs.create();
        await tab.attach();
        await tab.goto(fixtureUrl);
        const downloadPromise = tab.waitForEvent("download", { timeout: 10_000 });
        await tab.locator("#download-link").click();
        const download = await downloadPromise;
        const tabId = String(tab.id);
        const downloadId = download.id;
        await browser.finalizeTabs({ keep: [], timeout: 10_000 });
        JSON.stringify(await (async () => {
            try {
                await download.path();
                return { ok: true, tabId, downloadId };
            } catch (e) {
                return {
                    ok: false,
                    tabId,
                    downloadId,
                    message: String(e.message ?? e),
                    code: e.code ?? null,
                };
            }
        })())
    "##
    .replace("__FIXTURE_URL__", &fixture_url_json);
    let raw: Value = mcp
        .call_tool("js", json!({ "source": script }))
        .await
        .expect("js call");
    let payload: Value = serde_json::from_str(raw["result"].as_str().unwrap()).unwrap();
    assert_eq!(
        payload["ok"],
        Value::Bool(false),
        "expected stale download handle failure; got {raw}"
    );
    let msg = payload["message"].as_str().unwrap();
    let download_id = payload["downloadId"].as_str().unwrap();
    let tab_id = payload["tabId"].as_str().unwrap();
    assert!(
        msg.contains("stale download handle"),
        "expected stale download handle diagnostic; got {msg}"
    );
    assert!(
        msg.contains(download_id),
        "stale download error must include download handle id {download_id}; got {msg}"
    );
    assert!(
        msg.contains(&format!("owner_tab={tab_id}")),
        "stale download error must include owner tab {tab_id}; got {msg}"
    );
    assert!(
        msg.contains("tab was removed from host registry")
            || msg.contains("detached, closed, or finalized"),
        "stale download error must include cleanup reason; got {msg}"
    );

    host.kill().await.unwrap();
    let _ = mcp.shutdown().await;
}

#[tokio::test]
#[ignore = "requires headless Chromium on 9223, built @open-browser-use/sdk, and built obu-node-repl"]
async fn wrong_tab_file_chooser_or_download_handle_fails_without_consuming() {
    let sdk = prepare_built_sdk_module_root();
    let fixture_url = spawn_upload_policy_fixture().await;
    let upload_dir = tempfile::tempdir().unwrap();
    let upload_path = upload_dir.path().join("wrong-tab-upload.txt");
    std::fs::write(&upload_path, "wrong tab upload content").unwrap();
    let sock_dir = tempfile::tempdir().unwrap();
    let sock_path = sock_dir.path().join("wrong-tab-handle.sock");
    let cdp_url =
        std::env::var("OBU_CDP_URL").unwrap_or_else(|_| "http://127.0.0.1:9223".to_string());
    let cap = "wrong-tab-handle-token";

    let mut host: Child = Command::new(env!("CARGO_BIN_EXE_obu-host"))
        .arg("--socket")
        .arg(&sock_path)
        .arg("--cdp-url")
        .arg(&cdp_url)
        .env("OBU_CAPABILITY_TOKEN", cap)
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn obu-host");
    wait_for_socket(&sock_path, Duration::from_secs(5))
        .await
        .unwrap();

    let mcp = spawn_node_repl(&NodeReplOpts {
        envs: vec![
            ("OBU_CAPABILITY_TOKEN".to_string(), cap.to_string()),
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
    let script = r##"
        const fixtureUrl = __FIXTURE_URL__;
        const uploadPath = __UPLOAD_PATH__;
        const browser = await agent.browsers.get("cdp");
        const owner = await browser.tabs.create();
        await owner.attach();
        await owner.goto(fixtureUrl);
        const other = await browser.tabs.create();
        await other.attach();
        await other.goto("data:text/html,<title>wrong-tab</title><body>wrong tab</body>");
        const chooserPromise = owner.waitForEvent("filechooser", { timeout: 10_000 });
        await owner.locator("#upload").click();
        const chooser = await chooserPromise;
        const wrongChooser = new chooser.constructor(
            chooser.transport,
            chooser.id,
            chooser.guards,
            String(other.id),
        );
        let wrongMessage = "";
        try {
            await wrongChooser.setFiles(uploadPath);
        } catch (e) {
            wrongMessage = String(e.message ?? e);
        }
        await chooser.setFiles(uploadPath);
        const probe = await owner.dev.cdp("Runtime.evaluate", {
            expression: `({
                fileName: document.querySelector("#upload").files[0]?.name ?? "",
                fileCount: document.querySelector("#upload").files.length
            })`,
            returnByValue: true
        });
        JSON.stringify({
            ownerTabId: String(owner.id),
            otherTabId: String(other.id),
            chooserId: chooser.id,
            wrongMessage,
            upload: probe.result.value,
        })
    "##
    .replace("__FIXTURE_URL__", &fixture_url_json)
    .replace("__UPLOAD_PATH__", &upload_path_json);
    let raw: Value = mcp
        .call_tool("js", json!({ "source": script }))
        .await
        .expect("js call");
    let payload: Value = serde_json::from_str(raw["result"].as_str().unwrap()).unwrap();
    let msg = payload["wrongMessage"].as_str().unwrap();
    let chooser_id = payload["chooserId"].as_str().unwrap();
    let owner_tab_id = payload["ownerTabId"].as_str().unwrap();
    let other_tab_id = payload["otherTabId"].as_str().unwrap();
    assert!(
        msg.contains("file chooser handle"),
        "expected wrong-tab file chooser diagnostic; got {msg}"
    );
    assert!(
        msg.contains(chooser_id),
        "wrong-tab error must include chooser handle id {chooser_id}; got {msg}"
    );
    assert!(
        msg.contains(&format!("belongs to tab {owner_tab_id}")),
        "wrong-tab error must name owner tab {owner_tab_id}; got {msg}"
    );
    assert!(
        msg.contains(&format!("not {other_tab_id}")),
        "wrong-tab error must name mismatched tab {other_tab_id}; got {msg}"
    );
    assert_eq!(
        payload["upload"]["fileName"],
        json!("wrong-tab-upload.txt"),
        "owner file chooser handle must remain usable after wrong-tab rejection; got {raw}"
    );
    assert_eq!(
        payload["upload"]["fileCount"],
        json!(1),
        "wrong-tab rejection must not consume the owner file chooser handle; got {raw}"
    );

    host.kill().await.unwrap();
    let _ = mcp.shutdown().await;
}

#[tokio::test]
#[ignore = "requires headless Chromium on 9223, built @open-browser-use/sdk, and built obu-node-repl"]
async fn client_timeout_propagates_as_minus_1000() {
    let sdk = prepare_built_sdk_module_root();
    let sock_dir = tempfile::tempdir().unwrap();
    let sock_path = sock_dir.path().join("timeout.sock");
    let cdp_url =
        std::env::var("OBU_CDP_URL").unwrap_or_else(|_| "http://127.0.0.1:9223".to_string());
    let cap = "timeout-token";

    let mut host: Child = Command::new(env!("CARGO_BIN_EXE_obu-host"))
        .arg("--socket")
        .arg(&sock_path)
        .arg("--cdp-url")
        .arg(&cdp_url)
        .env("OBU_CAPABILITY_TOKEN", cap)
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn obu-host");
    wait_for_socket(&sock_path, Duration::from_secs(5))
        .await
        .unwrap();

    let mcp = spawn_node_repl(&NodeReplOpts {
        envs: vec![
            ("OBU_CAPABILITY_TOKEN".to_string(), cap.to_string()),
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

    let script = r##"
        const browser = await agent.browsers.get("cdp");
        const tab = await browser.tabs.create();
        await tab.attach();
        await tab.goto("data:text/html,<div>nothing</div>");
        JSON.stringify(await (async () => {
            try {
                await tab.locator("#never").click({ timeout: 200 });
                return { ok: true };
            } catch (e) {
                return { ok: false, message: String(e.message ?? e), code: e.code ?? null };
            }
        })())
    "##;
    let raw: Value = mcp
        .call_tool("js", json!({ "source": script }))
        .await
        .expect("js call");
    let payload: Value = serde_json::from_str(raw["result"].as_str().unwrap()).unwrap();
    assert_eq!(
        payload["ok"],
        Value::Bool(false),
        "expected timeout; got {raw}"
    );
    assert_eq!(
        payload["code"].as_i64(),
        Some(-1000),
        "expected ERR_TIMEOUT (-1000); got {raw}"
    );
    let msg = payload["message"].as_str().unwrap();
    assert!(
        msg.contains("timed out") || msg.contains("timeout"),
        "expected timeout message; got {msg}"
    );
    host.kill().await.unwrap();
    let _ = mcp.shutdown().await;
}

async fn spawn_redirect_to_denied_origin_fixture() -> (String, String) {
    let denied_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let denied_addr = denied_listener.local_addr().unwrap();
    let denied_origin = format!("http://{denied_addr}");
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = denied_listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buffer = [0u8; 1024];
                let _ = stream.read(&mut buffer).await;
                let body =
                    "<!doctype html><title>blocked-current-origin</title><body>blocked</body>";
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });

    let redirect_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let redirect_addr = redirect_listener.local_addr().unwrap();
    let redirect_target = format!("{denied_origin}/blocked");
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = redirect_listener.accept().await else {
                break;
            };
            let redirect_target = redirect_target.clone();
            tokio::spawn(async move {
                let mut buffer = [0u8; 1024];
                let _ = stream.read(&mut buffer).await;
                let response = format!(
                    "HTTP/1.1 302 Found\r\nlocation: {redirect_target}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });

    (format!("http://{redirect_addr}/redirect"), denied_origin)
}

async fn spawn_upload_policy_fixture() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buffer = [0u8; 1024];
                let _ = stream.read(&mut buffer).await;
                let body = "<!doctype html><title>upload-policy</title><input id=\"upload\" type=\"file\">";
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

async fn spawn_download_policy_fixture() -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let download_requests = Arc::new(AtomicUsize::new(0));
    let download_requests_for_server = Arc::clone(&download_requests);
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let download_requests = Arc::clone(&download_requests_for_server);
            tokio::spawn(async move {
                let mut buffer = [0u8; 1024];
                let read = stream.read(&mut buffer).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");
                let (content_type, extra_headers, body) = if path == "/download.txt" {
                    download_requests.fetch_add(1, Ordering::SeqCst);
                    (
                        "text/plain",
                        "content-disposition: attachment; filename=\"download.txt\"\r\n",
                        "blocked download content",
                    )
                } else {
                    (
                        "text/html",
                        "",
                        "<!doctype html><title>download-policy</title><a id=\"download-link\" href=\"/download.txt\">Download</a>",
                    )
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\n{extra_headers}content-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });
    (format!("http://{addr}/"), download_requests)
}

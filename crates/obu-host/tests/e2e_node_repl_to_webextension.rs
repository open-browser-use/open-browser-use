#![cfg(unix)]
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UnixListener};
use tokio::sync::Mutex;
use tokio_util::codec::Framed;

use obu_wire::frame::FrameCodec;

#[path = "common/node_repl_mcp.rs"]
mod node_repl_harness;
use node_repl_harness::{
    NodeReplHandle, NodeReplOpts, prepare_built_sdk_module_root, spawn_node_repl,
};

#[tokio::test]
async fn fake_webextension_node_repl_preserves_shopping_state_across_cells() {
    let fake = spawn_fake_webextension_runtime().await;
    let sdk = prepare_built_sdk_module_root();
    let mcp: NodeReplHandle = spawn_node_repl(&NodeReplOpts {
        envs: vec![
            (
                "OBU_RUNTIME_DIR".to_string(),
                fake.runtime_dir.path().display().to_string(),
            ),
            (
                "OBU_NODE_REPL_MODULE_DIRS".to_string(),
                sdk.root.display().to_string(),
            ),
            ("OBU_TRUSTED_MODULE_SHA256S".to_string(), sdk.hash.clone()),
        ],
    })
    .await;

    let first = eval_json(
        &mcp,
        "fake shopping search",
        r##"
        if (!globalThis.browser) {
          globalThis.browser = await agent.browsers.get("chrome");
        }
        await browser.name("Fake shopping");
        if (!globalThis.tab) {
          globalThis.tab =
            (await browser.tabs.current()) ??
            (await browser.tabs.create("https://shop.test/"));
        }
        await tab.locator("#search").fill("keyboard");
        await tab.cua.move(450, 350);
        const probe = await tab.dev.cdp("Runtime.evaluate", {
          expression: "window.__fakeShoppingState",
          returnByValue: true
        });
        await browser.turnEnded();
        JSON.stringify({
          backend: browser.info.type,
          tabId: tab.id,
          search: probe.result.value.searchInput,
          createdTabs: probe.result.value.createdTabs
        })
        "##,
    )
    .await;
    assert_eq!(first["backend"], json!("webextension"));
    assert_eq!(first["search"], json!("keyboard"));
    assert_eq!(first["createdTabs"], json!(1));

    let second = eval_json(
        &mcp,
        "fake shopping select",
        r##"
        const beforeSelectTabId = tab.id;
        await tab.locator("[data-product='keyboard']").click();
        const selectProbe = await tab.dev.cdp("Runtime.evaluate", {
          expression: "window.__fakeShoppingState",
          returnByValue: true
        });
        await browser.turnEnded();
        JSON.stringify({
          sameTab: tab.id === beforeSelectTabId,
          tabId: tab.id,
          selectedProduct: selectProbe.result.value.selectedProduct,
          searchInput: selectProbe.result.value.searchInput,
          createdTabs: selectProbe.result.value.createdTabs
        })
        "##,
    )
    .await;
    assert_eq!(second["sameTab"], json!(true));
    assert_eq!(second["tabId"], first["tabId"]);
    assert_eq!(second["searchInput"], json!("keyboard"));
    assert_eq!(second["selectedProduct"], json!("keyboard"));
    assert_eq!(second["createdTabs"], json!(1));

    let third = eval_json(
        &mcp,
        "fake shopping cart and resume",
        r##"
        await tab.locator("#add-to-cart").click();
        await browser.yieldControl();
        globalThis.tab = await browser.resumeControl();
        const cartProbe = await tab.dev.cdp("Runtime.evaluate", {
          expression: "window.__fakeShoppingState",
          returnByValue: true
        });
        await browser.turnEnded();
        JSON.stringify({
          tabId: tab.id,
          searchInput: cartProbe.result.value.searchInput,
          selectedProduct: cartProbe.result.value.selectedProduct,
          cartCount: cartProbe.result.value.cartCount,
          yielded: cartProbe.result.value.yielded,
          resumed: cartProbe.result.value.resumed,
          createdTabs: cartProbe.result.value.createdTabs,
          initialCursor: cartProbe.result.value.initialCursorBeforeFirstMove
        })
        "##,
    )
    .await;
    assert_eq!(third["tabId"], first["tabId"]);
    assert_eq!(third["searchInput"], json!("keyboard"));
    assert_eq!(third["selectedProduct"], json!("keyboard"));
    assert_eq!(third["cartCount"], json!(1));
    assert_eq!(third["yielded"], json!(true));
    assert_eq!(third["resumed"], json!(true));
    assert_eq!(third["createdTabs"], json!(1));
    assert_eq!(third["initialCursor"], json!({ "x": 450, "y": 350 }));

    let state = fake.state.lock().await;
    assert_eq!(
        state.created_tabs, 1,
        "state continuity must not create duplicate task tabs"
    );
    assert_eq!(state.turn_ended_calls, 3);
    assert_eq!(state.yield_control_calls, 1);
    assert_eq!(state.resume_control_calls, 1);
    assert_eq!(
        state
            .methods
            .iter()
            .filter(|method| method.as_str() == "createTab")
            .count(),
        1,
        "only the first cell may create the task tab"
    );

    let _ = mcp.shutdown().await;
}

#[tokio::test]
#[ignore = "requires Chromium with the unpacked extension loaded and dev native-host manifest installed"]
async fn end_to_end_webextension_create_click_and_user_surfaces() {
    let runtime_dir =
        PathBuf::from(std::env::var("OBU_RUNTIME_DIR").expect("OBU_RUNTIME_DIR must be set"));
    let descriptor = wait_for_descriptor(&runtime_dir).await;
    let descriptor_json: Value =
        serde_json::from_slice(&std::fs::read(&descriptor).unwrap()).unwrap();
    assert_eq!(descriptor_json["type"], "webextension");

    let download_name = format!(
        "e2e-download-{}.txt",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
    );
    let fixture_url = spawn_fixture_server(download_name.clone()).await;
    let upload_dir = tempfile::tempdir().unwrap();
    let upload_path = upload_dir.path().join("upload.txt");
    std::fs::write(&upload_path, "upload content").unwrap();
    let sdk = prepare_built_sdk_module_root();
    let mcp: NodeReplHandle = spawn_node_repl(&NodeReplOpts {
        envs: vec![
            (
                "OBU_RUNTIME_DIR".to_string(),
                runtime_dir.display().to_string(),
            ),
            (
                "OBU_NODE_REPL_MODULE_DIRS".to_string(),
                sdk.root.display().to_string(),
            ),
            ("OBU_TRUSTED_MODULE_SHA256S".to_string(), sdk.hash.clone()),
        ],
    })
    .await;

    let backends = eval_json(
        &mcp,
        "list backends",
        r#"JSON.stringify({ agent: typeof agent, backends: await agent.browsers.list() })"#,
    )
    .await;
    assert_eq!(backends["agent"], json!("object"));
    assert!(
        backends["backends"]
            .as_array()
            .unwrap()
            .iter()
            .any(|backend| backend["type"] == json!("webextension"))
    );

    let browser = eval_json(
        &mcp,
        "connect browser",
        r#"
        globalThis.__p3Browser = await agent.browsers.get("chrome");
        JSON.stringify({
            backend: globalThis.__p3Browser.info.type,
            name: globalThis.__p3Browser.info.name
        })
        "#,
    )
    .await;
    assert_eq!(browser["backend"], json!("webextension"));
    assert_eq!(browser["name"], json!("chrome"));

    let fixture_url_json = serde_json::to_string(&fixture_url).unwrap();
    let create_script = format!(
        r##"
        globalThis.__p3Tab = await globalThis.__p3Browser.tabs.create({fixture_url_json});
        JSON.stringify({{ tabId: globalThis.__p3Tab.id }})
        "##
    );
    let created = eval_json(&mcp, "create tab", &create_script).await;
    assert!(created["tabId"].as_str().is_some());

    let loaded = eval_json(
        &mcp,
        "wait for load",
        r#"
        await globalThis.__p3Tab.waitForLoadState("load", { timeout: 10_000 });
        JSON.stringify({ loaded: true })
        "#,
    )
    .await;
    assert_eq!(loaded["loaded"], json!(true));

    let click_effect = eval_json(
        &mcp,
        "click fixture",
        r##"
        await globalThis.__p3Tab.locator("#main").click();
        await globalThis.__p3Tab.frameLocator("iframe").locator("#inside").click();
        const probe = await globalThis.__p3Tab.dev.cdp("Runtime.evaluate", {
            expression: "({ main: window.__obuClicked === true, frame: window.__obuIframeClicked === true })",
            returnByValue: true
        });
        JSON.stringify(probe.result.value)
        "##,
    )
    .await;

    assert_eq!(click_effect["main"], json!(true));
    assert_eq!(click_effect["frame"], json!(true));

    let locator_navigation = eval_json(
        &mcp,
        "locator click wait for navigation",
        r##"
        await globalThis.__p3Tab.locator("#locator-nav").click({
            timeout: 10_000,
            waitForNavigation: { waitUntil: "load", timeout: 10_000 }
        });
        const locatorNavProbe = await globalThis.__p3Tab.dev.cdp("Runtime.evaluate", {
            expression: "location.search",
            returnByValue: true
        });
        JSON.stringify({ search: locatorNavProbe.result.value })
        "##,
    )
    .await;
    assert_eq!(locator_navigation["search"], json!("?locator-nav=1"));

    let scroll_effect = eval_json(
        &mcp,
        "CUA scroll",
        r##"
        const nestedBox = await globalThis.__p3Tab.locator("#nested-scroll").boundingBox();
        if (!nestedBox) throw new Error("missing nested scroll box");
        const beforeNestedScroll = await globalThis.__p3Tab.dev.cdp("Runtime.evaluate", {
            expression: "document.querySelector('#nested-scroll').scrollTop",
            returnByValue: true
        });
        await globalThis.__p3Tab.cua.scroll(nestedBox.x + 20, nestedBox.y + 20, 260, { timeout: 10_000 });
        await globalThis.__p3Tab.waitForTimeout(100);
        const afterNestedScroll = await globalThis.__p3Tab.dev.cdp("Runtime.evaluate", {
            expression: "document.querySelector('#nested-scroll').scrollTop",
            returnByValue: true
        });
        const beforeScroll = await globalThis.__p3Tab.dev.cdp("Runtime.evaluate", {
            expression: "window.scrollY",
            returnByValue: true
        });
        await globalThis.__p3Tab.cua.scroll(500, 500, 700, { timeout: 10_000 });
        await globalThis.__p3Tab.waitForTimeout(100);
        const afterScroll = await globalThis.__p3Tab.dev.cdp("Runtime.evaluate", {
            expression: "window.scrollY",
            returnByValue: true
        });
        JSON.stringify({
            beforeNested: beforeNestedScroll.result.value,
            afterNested: afterNestedScroll.result.value,
            before: beforeScroll.result.value,
            after: afterScroll.result.value
        })
        "##,
    )
    .await;
    assert!(
        scroll_effect["after"].as_f64().unwrap_or_default()
            > scroll_effect["before"].as_f64().unwrap_or_default() + 50.0
    );
    assert!(
        scroll_effect["afterNested"].as_f64().unwrap_or_default()
            > scroll_effect["beforeNested"].as_f64().unwrap_or_default() + 50.0
    );

    let rich_clipboard = eval_json(
        &mcp,
        "rich clipboard roundtrip",
        r##"
        await globalThis.__p3Tab.attach();

        await globalThis.__p3Tab.clipboard.write([{
            entries: [
                { mimeType: "text/plain", text: "plain" },
                { mimeType: "text/html", text: "<b>plain</b>" },
                { mimeType: "image/png", base64: "iVBORw0KGgo=" }
            ],
            presentationStyle: "inline"
        }]);
        const rich = await globalThis.__p3Tab.clipboard.read();

        JSON.stringify({
            richTypes: rich[0].entries.map((entry) => entry.mimeType),
            richHtml: rich[0].entries.find((entry) => entry.mimeType === "text/html").text,
            richImage: rich[0].entries.find((entry) => entry.mimeType === "image/png").base64
        })
        "##,
    )
    .await;
    assert_eq!(
        rich_clipboard["richTypes"],
        json!(["text/plain", "text/html", "image/png"])
    );
    assert_eq!(rich_clipboard["richHtml"], json!("<b>plain</b>"));
    assert_eq!(rich_clipboard["richImage"], json!("iVBORw0KGgo="));

    let typed_input = eval_json(
        &mcp,
        "CUA typing input",
        r##"
        await globalThis.__p3Tab.locator("#type-input").click();
        await globalThis.__p3Tab.cua.type("input text");
        const inputProbe = await globalThis.__p3Tab.dev.cdp("Runtime.evaluate", {
            expression: "document.querySelector('#type-input').value",
            returnByValue: true
        });
        JSON.stringify({ input: inputProbe.result.value })
        "##,
    )
    .await;
    assert_eq!(typed_input["input"], json!("input text"));

    let typed_textarea = eval_json(
        &mcp,
        "CUA typing textarea",
        r##"
        await globalThis.__p3Tab.locator("#type-textarea").click();
        await globalThis.__p3Tab.cua.type("textarea text");
        const textareaProbe = await globalThis.__p3Tab.dev.cdp("Runtime.evaluate", {
            expression: "document.querySelector('#type-textarea').value",
            returnByValue: true
        });
        JSON.stringify({ textarea: textareaProbe.result.value })
        "##,
    )
    .await;
    assert_eq!(typed_textarea["textarea"], json!("textarea text"));

    let typed_editable = eval_json(
        &mcp,
        "CUA typing contenteditable",
        r##"
        await globalThis.__p3Tab.locator("#type-editable").click();
        await globalThis.__p3Tab.cua.type("editable text");

        const editableProbe = await globalThis.__p3Tab.dev.cdp("Runtime.evaluate", {
            expression: "document.querySelector('#type-editable').textContent",
            returnByValue: true
        });
        JSON.stringify({ editable: editableProbe.result.value })
        "##,
    )
    .await;
    assert_eq!(typed_editable["editable"], json!("editable text"));

    let paste_results = eval_json(
        &mcp,
        "virtual clipboard paste surfaces",
        r##"
        await globalThis.__p3Tab.clipboard.write([{
            entries: [
                { mimeType: "text/plain", text: "paste text" },
                { mimeType: "text/html", text: "<i>paste text</i>" }
            ],
            presentationStyle: "inline"
        }]);
        await globalThis.__p3Tab.locator("#paste-default").click();
        await globalThis.__p3Tab.cua.keypress("v", { modifiers: ["ControlOrMeta"] });
        await globalThis.__p3Tab.locator("#paste-prevent").click();
        await globalThis.__p3Tab.cua.keypress("v", { modifiers: ["ControlOrMeta"] });
        let blockedShiftPaste = false;
        try {
            await globalThis.__p3Tab.cua.keypress("v", { modifiers: ["ControlOrMeta", "Shift"] });
        } catch (error) {
            blockedShiftPaste = String(error.message ?? error).includes("Native clipboard shortcuts are disabled");
        }

        const pasteProbe = await globalThis.__p3Tab.dev.cdp("Runtime.evaluate", {
            expression: `({
                pasteDefault: document.querySelector("#paste-default").value,
                pastePrevent: document.querySelector("#paste-prevent").value,
                pasteEvents: window.__obuPasteEvents
            })`,
            returnByValue: true
        });
        JSON.stringify({
            blockedShiftPaste,
            ...pasteProbe.result.value
        })
        "##,
    )
    .await;
    assert_eq!(paste_results["pasteDefault"], json!("paste text"));
    assert_eq!(paste_results["pastePrevent"], json!(""));
    assert_eq!(paste_results["pasteEvents"][0]["text"], json!("paste text"));
    assert_eq!(
        paste_results["pasteEvents"][0]["html"],
        json!("<i>paste text</i>")
    );
    assert_eq!(
        paste_results["pasteEvents"][1]["id"],
        json!("paste-prevent")
    );
    assert_eq!(paste_results["blockedShiftPaste"], json!(true));

    let dom_cua = eval_json(
        &mcp,
        "DOM-CUA click and type",
        r##"
        const dom = await globalThis.__p3Tab.dom_cua.get_visible_dom({ timeout: 10_000 });
        const buttonNode = dom.nodes.find((node) => node.attributes?.id === "dom-button");
        const inputNode = dom.nodes.find((node) => node.attributes?.id === "dom-input");
        await globalThis.__p3Tab.dom_cua.click(buttonNode.node_id);
        await globalThis.__p3Tab.dom_cua.type(inputNode.node_id, "dom typed");

        const domProbe = await globalThis.__p3Tab.dev.cdp("Runtime.evaluate", {
            expression: `({
                domClicked: window.__obuDomClicked === true,
                domInput: document.querySelector("#dom-input").value
            })`,
            returnByValue: true
        });
        JSON.stringify(domProbe.result.value)
        "##,
    )
    .await;
    assert_eq!(dom_cua["domClicked"], json!(true));
    assert_eq!(dom_cua["domInput"], json!("dom typed"));

    let clipboard_lifecycle = eval_json(
        &mcp,
        "clipboard lifecycle cleanup and rebound",
        r##"
        await globalThis.__p3Tab.dev.cdp("Runtime.evaluate", {
            expression: "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => 'page overwrite' } }); true",
            returnByValue: true
        });
        await globalThis.__p3Tab.clipboard.writeText("rebound");
        const rebound = await globalThis.__p3Tab.clipboard.readText();
        await globalThis.__p3Tab.detach();
        const cleanupProbe = await globalThis.__p3Tab.dev.cdp("Runtime.evaluate", {
            expression: "({ hasClipboardGlobal: typeof globalThis.__obuVirtualClipboard, hasCleanup: typeof globalThis.__obuVirtualClipboardCleanup })",
            returnByValue: true
        });
        await globalThis.__p3Tab.attach();
        await globalThis.__p3Tab.clipboard.writeText("fresh");
        const fresh = await globalThis.__p3Tab.clipboard.readText();

        JSON.stringify({
            rebound,
            cleanup: cleanupProbe.result.value,
            fresh
        })
        "##,
    )
    .await;
    assert_eq!(clipboard_lifecycle["rebound"], json!("rebound"));
    assert_eq!(
        clipboard_lifecycle["cleanup"]["hasClipboardGlobal"],
        json!("undefined")
    );
    assert_eq!(
        clipboard_lifecycle["cleanup"]["hasCleanup"],
        json!("undefined")
    );
    assert_eq!(clipboard_lifecycle["fresh"], json!("fresh"));

    let upload_path_json = serde_json::to_string(&upload_path.display().to_string()).unwrap();
    let download_name_json = serde_json::to_string(&download_name).unwrap();
    let file_handles_script = format!(
        r##"
        const uploadPath = {upload_path_json};
        const downloadName = {download_name_json};

        const chooserPromise = globalThis.__p3Tab.waitForEvent("filechooser", {{ timeout: 10_000 }});
        await globalThis.__p3Tab.locator("#upload").click();
        const chooser = await chooserPromise;
        await chooser.setFiles(uploadPath);
        let staleChooserMessage = "";
        try {{
            await chooser.setFiles(uploadPath);
        }} catch (error) {{
            staleChooserMessage = String(error?.message ?? error);
        }}

        const uploadProbe = await globalThis.__p3Tab.dev.cdp("Runtime.evaluate", {{
            expression: `({{
                fileName: document.querySelector("#upload").files[0]?.name ?? "",
                fileCount: document.querySelector("#upload").files.length
            }})`,
            returnByValue: true
        }});

        const downloadPromise = globalThis.__p3Tab.waitForEvent("download", {{ timeout: 10_000 }});
        await globalThis.__p3Tab.locator("#download-link").click();
        const download = await downloadPromise;
        const downloadPath = await download.path();

        JSON.stringify({{
            upload: uploadProbe.result.value,
            staleChooserMessage,
            downloadId: download.id,
            downloadPath,
            downloadName,
            downloadPathIncludesName: downloadPath.includes(downloadName)
        }})
        "##
    );
    let file_handles = eval_json(
        &mcp,
        "file chooser and download handles",
        &file_handles_script,
    )
    .await;
    assert_eq!(file_handles["upload"]["fileName"], json!("upload.txt"));
    assert_eq!(file_handles["upload"]["fileCount"], json!(1));
    assert!(
        file_handles["staleChooserMessage"]
            .as_str()
            .unwrap_or_default()
            .contains("already consumed by setFiles")
    );
    assert!(
        file_handles["downloadId"]
            .as_str()
            .unwrap_or_default()
            .len()
            > 4
    );
    assert_eq!(file_handles["downloadPathIncludesName"], json!(true));

    let user_surfaces = eval_json(
        &mcp,
        "user surfaces",
        r#"
        const tabs = await globalThis.__p3Browser.tabs.list();
        const openTabs = await globalThis.__p3Browser.user.openTabs();
        const history = await globalThis.__p3Browser.user.history({ query: "127.0.0.1", limit: 10 });
        JSON.stringify({
            listed: tabs.some((row) => row.id === globalThis.__p3Tab.id),
            openTabs: openTabs.length,
            history: history.length
        })
        "#,
    )
    .await;

    assert_eq!(user_surfaces["listed"], json!(true));
    assert!(user_surfaces["openTabs"].as_u64().unwrap_or_default() >= 1);
    assert!(user_surfaces["history"].as_u64().unwrap_or_default() >= 1);

    let finalized_lifecycle = eval_json(
        &mcp,
        "finalize deliverable lifecycle",
        r#"
        const tabId = globalThis.__p3Tab.id;
        const finalized = await globalThis.__p3Browser.finalizeTabs({
            keep: [{ tabId, status: "deliverable" }],
            timeout: 10_000
        });
        const listedAfterFinalize = await globalThis.__p3Browser.tabs.list();
        const refreshed = await agent.browsers.get("chrome");
        const lifecycle = refreshed.info.metadata?.diagnostics?.lifecycle ?? {};
        const deliverableSummary = (lifecycle.deliverable_tab_summaries ?? [])
            .find((row) => row.tab_id === String(tabId));
        const deliverables = await refreshed.deliverables();
        const deliverable = deliverables.find((row) => row.tabId === String(tabId));
        const claimed = await deliverable?.claim();
        const listedAfterClaim = await refreshed.tabs.list();
        JSON.stringify({
            tabId: String(tabId),
            deliverableStatus: finalized.deliverable_tabs?.[0]?.status,
            listedAfterFinalize: listedAfterFinalize.some((row) => row.id === tabId),
            deliverableCount: lifecycle.deliverable_tabs ?? -1,
            deliverableSummaryTabId: deliverableSummary?.tab_id,
            deliverableSummaryUrl: deliverableSummary?.url,
            recoverableTabId: deliverable?.tabId,
            claimedTabId: claimed?.id,
            listedAfterClaim: listedAfterClaim.some((row) => row.id === String(tabId))
        })
        "#,
    )
    .await;
    assert_eq!(
        finalized_lifecycle["deliverableStatus"],
        json!("deliverable")
    );
    assert_eq!(finalized_lifecycle["listedAfterFinalize"], json!(false));
    assert!(
        finalized_lifecycle["deliverableCount"]
            .as_i64()
            .unwrap_or_default()
            >= 1
    );
    assert_eq!(
        finalized_lifecycle["deliverableSummaryTabId"],
        finalized_lifecycle["tabId"]
    );
    assert_eq!(
        finalized_lifecycle["recoverableTabId"],
        finalized_lifecycle["tabId"]
    );
    assert_eq!(
        finalized_lifecycle["claimedTabId"],
        finalized_lifecycle["tabId"]
    );
    assert_eq!(finalized_lifecycle["listedAfterClaim"], json!(true));
    assert!(
        finalized_lifecycle["deliverableSummaryUrl"]
            .as_str()
            .is_some_and(|url| !url.is_empty())
    );

    let _ = mcp.shutdown().await;
}

#[tokio::test]
#[ignore = "requires Chromium with the unpacked extension loaded and dev native-host manifest installed"]
async fn webextension_dirty_form_beforeunload_survives_reattach_and_finish_turn() {
    let runtime_dir =
        PathBuf::from(std::env::var("OBU_RUNTIME_DIR").expect("OBU_RUNTIME_DIR must be set"));
    let descriptor = wait_for_descriptor(&runtime_dir).await;
    let descriptor_json: Value =
        serde_json::from_slice(&std::fs::read(&descriptor).unwrap()).unwrap();
    assert_eq!(descriptor_json["type"], "webextension");

    let (dirty_url, clean_url) = spawn_dirty_form_fixture().await;
    let sdk = prepare_built_sdk_module_root();
    let mcp: NodeReplHandle = spawn_node_repl(&NodeReplOpts {
        envs: vec![
            (
                "OBU_RUNTIME_DIR".to_string(),
                runtime_dir.display().to_string(),
            ),
            (
                "OBU_NODE_REPL_MODULE_DIRS".to_string(),
                sdk.root.display().to_string(),
            ),
            ("OBU_TRUSTED_MODULE_SHA256S".to_string(), sdk.hash.clone()),
        ],
    })
    .await;

    let dirty_url_json = serde_json::to_string(&dirty_url).unwrap();
    let clean_url_json = serde_json::to_string(&clean_url).unwrap();
    let script = r##"
        const dirtyUrl = __DIRTY_URL__;
        const cleanUrl = __CLEAN_URL__;
        const browser = await agent.browsers.get("chrome");

        async function makeDirty(tab) {
            await tab.goto(dirtyUrl, { timeout: 10_000 });
            await tab.waitForLoadState("load", { timeout: 10_000 });
            await tab.locator("#dirty").click({ timeout: 10_000 });
            await tab.cua.type("changed", { timeout: 10_000 });
            const probe = await tab.dev.cdp("Runtime.evaluate", {
                expression: `({
                    href: location.href,
                    dirty: window.__dirty === true,
                    value: document.querySelector("#dirty")?.value ?? ""
                })`,
                returnByValue: true
            });
            if (!probe.result.value.dirty || probe.result.value.value !== "changed") {
                throw new Error(`dirty form fixture did not become dirty: ${JSON.stringify(probe.result.value)}`);
            }
            return probe.result.value;
        }

        const tab = await browser.tabs.create();
        await tab.attach({ timeout: 10_000 });
        await makeDirty(tab);
        await tab.detach({ timeout: 10_000 });
        await tab.attach({ timeout: 10_000 });
        await tab.goto(cleanUrl, { timeout: 10_000 });
        await tab.waitForLoadState("load", { timeout: 10_000 });
        const reattachGotoUrl = await tab.url({ timeout: 10_000 });

        await makeDirty(tab);
        const finalizeTabId = String(tab.id);
        const finalized = await browser.finishTurn({
            keep: [],
            timeout: 10_000,
            turnTimeout: 10_000
        });
        const listedAfterFinishTurn = await browser.tabs.list();
        const refreshed = await agent.browsers.get("chrome");
        const recentDialogs = refreshed.info.metadata?.diagnostics?.dialogs?.recent ?? [];
        const beforeunload = recentDialogs.filter((row) => row.dialog_type === "beforeunload");
        const closedTabIds = finalized.closed_tab_ids ?? finalized.closedTabIds ?? [];

        JSON.stringify({
            reattachGotoUrl,
            finalizeTabId,
            finishTurnClosed: closedTabIds.map(String),
            finishTurnResultKeys: Object.keys(finalized),
            finalizeStillListed: listedAfterFinishTurn.some((row) => String(row.id) === finalizeTabId),
            beforeunloadCount: beforeunload.length,
            beforeunloadOperations: beforeunload.map((row) => row.operation),
            beforeunloadOutcomes: beforeunload.map((row) => row.outcome),
            beforeunloadActions: beforeunload.map((row) => row.default_action)
        })
    "##
    .replace("__DIRTY_URL__", &dirty_url_json)
    .replace("__CLEAN_URL__", &clean_url_json);
    let raw: Value = mcp
        .call_tool("js", json!({ "source": script, "timeout_ms": 60_000 }))
        .await
        .expect("dirty form reattach dialog policy js tool call");
    let payload: Value = parse_js_json_result(&raw, "dirty form reattach dialog policy");
    assert_eq!(
        payload["reattachGotoUrl"],
        json!(clean_url),
        "reattached dirty-form goto must land on the clean page"
    );
    assert_eq!(
        payload["finalizeStillListed"],
        json!(false),
        "finishTurn({{ keep: [] }}) must close the omitted dirty-form tab"
    );
    let finalize_tab_id = payload["finalizeTabId"].as_str().unwrap();
    assert!(
        payload["finishTurnClosed"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tab_id| tab_id.as_str() == Some(finalize_tab_id)),
        "finishTurn result must report the dirty-form tab as closed; got {payload}"
    );
    assert!(
        payload["beforeunloadCount"].as_u64().unwrap_or_default() >= 1,
        "expected at least the reattach navigation beforeunload diagnostic; headless Chrome may not emit close dialogs; got {payload}"
    );
    assert!(
        payload["beforeunloadOperations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|operation| operation.as_str() == Some("Page.navigate")),
        "expected the reattach navigation beforeunload diagnostic; got {payload}"
    );
    assert!(
        payload["beforeunloadActions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|action| action.as_str() == Some("accept")),
        "beforeunload dialogs must be accepted by policy; got {payload}"
    );
    assert!(
        payload["beforeunloadOutcomes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|outcome| outcome.as_str() == Some("continued")),
        "beforeunload dialogs must allow operations to continue; got {payload}"
    );

    let _ = mcp.shutdown().await;
}

async fn eval_json(mcp: &NodeReplHandle, label: &str, source: &str) -> Value {
    eprintln!("p3 webextension e2e: {label}");
    let raw: Value = mcp
        .call_tool("js", json!({ "source": source, "timeout_ms": 15_000 }))
        .await
        .unwrap_or_else(|error| panic!("{label} js tool call: {error}"));
    parse_js_json_result(&raw, label)
}

fn parse_js_json_result(raw: &Value, label: &str) -> Value {
    let result = raw
        .get("result")
        .unwrap_or_else(|| panic!("{label} missing js result; got {raw}"));
    let value = result.get("value").unwrap_or(result);
    let result = value
        .as_str()
        .unwrap_or_else(|| panic!("{label} expected string js result; got {raw}"));
    serde_json::from_str(result)
        .unwrap_or_else(|error| panic!("{label} decode payload: {error}; raw={raw}"))
}

struct FakeWebExtensionRuntime {
    runtime_dir: tempfile::TempDir,
    state: Arc<Mutex<FakeShoppingState>>,
}

#[derive(Debug)]
struct FakeShoppingState {
    next_tab_id: u64,
    tab_id: Option<u64>,
    created_tabs: u64,
    turn_ended_calls: u64,
    yield_control_calls: u64,
    resume_control_calls: u64,
    search_input: String,
    selected_product: Option<String>,
    cart_count: u64,
    yielded: bool,
    resumed: bool,
    initial_cursor_before_first_move: Option<(i64, i64)>,
    methods: Vec<String>,
}

impl Default for FakeShoppingState {
    fn default() -> Self {
        Self {
            next_tab_id: 41,
            tab_id: None,
            created_tabs: 0,
            turn_ended_calls: 0,
            yield_control_calls: 0,
            resume_control_calls: 0,
            search_input: String::new(),
            selected_product: None,
            cart_count: 0,
            yielded: false,
            resumed: false,
            initial_cursor_before_first_move: None,
            methods: Vec::new(),
        }
    }
}

async fn spawn_fake_webextension_runtime() -> FakeWebExtensionRuntime {
    let runtime_dir = tempfile::tempdir().expect("fake runtime dir");
    let descriptor_dir = runtime_dir.path().join("webextension");
    std::fs::create_dir_all(&descriptor_dir).expect("create fake descriptor dir");
    set_owner_only_dir(runtime_dir.path());
    set_owner_only_dir(&descriptor_dir);

    let socket_path = runtime_dir.path().join("fake-webextension.sock");
    let listener = UnixListener::bind(&socket_path).expect("bind fake webextension socket");
    set_owner_only_file(&socket_path);
    let token = "fake-token";
    let state = Arc::new(Mutex::new(FakeShoppingState::default()));
    let server_state = state.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let state = server_state.clone();
            tokio::spawn(handle_fake_webextension_connection(
                stream,
                state,
                token.to_string(),
            ));
        }
    });

    let descriptor_path = descriptor_dir.join("chrome.json");
    std::fs::write(
        &descriptor_path,
        serde_json::to_vec_pretty(&json!({
            "schema_version": 1,
            "type": "webextension",
            "name": "chrome",
            "socketPath": socket_path.display().to_string(),
            "sdk_auth_token": token,
            "pid": std::process::id(),
            "startedAt": "1000"
        }))
        .expect("serialize fake descriptor"),
    )
    .expect("write fake descriptor");
    set_owner_only_file(&descriptor_path);

    FakeWebExtensionRuntime { runtime_dir, state }
}

async fn handle_fake_webextension_connection(
    stream: tokio::net::UnixStream,
    state: Arc<Mutex<FakeShoppingState>>,
    token: String,
) {
    let mut framed = Framed::new(stream, FrameCodec);
    let mut authenticated = false;
    while let Some(frame) = framed.next().await {
        let Ok(bytes) = frame else {
            break;
        };
        let Ok(request) = serde_json::from_slice::<Value>(&bytes) else {
            break;
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        let response = if method == "auth" {
            let accepted = params
                .get("capability_token")
                .and_then(Value::as_str)
                .map(|actual| actual == token)
                .unwrap_or(false);
            authenticated = accepted;
            if accepted {
                rpc_ok(id, json!({ "authenticated": true }))
            } else {
                rpc_error(id, -1100, "auth rejected")
            }
        } else if !authenticated {
            rpc_error(id, -1100, "auth required")
        } else {
            fake_webextension_response(id, method, params, &state).await
        };
        if framed.send(response).await.is_err() {
            break;
        }
    }
}

async fn fake_webextension_response(
    id: Value,
    method: &str,
    params: Value,
    state: &Arc<Mutex<FakeShoppingState>>,
) -> Bytes {
    let mut state = state.lock().await;
    state.methods.push(method.to_string());
    match method {
        "getInfo" => rpc_ok(
            id,
            json!({
                "type": "webextension",
                "name": "chrome",
                "capabilities": {
                    "backend": "webextension",
                    "supported_methods": [
                        "getInfo",
                        "getCurrentTab",
                        "createTab",
                        "nameSession",
                        "turnEnded",
                        "yieldControl",
                        "resumeControl",
                        "tab_url",
                        "tab_title",
                        "executeCdp",
                        "playwright_locator_fill",
                        "playwright_locator_click",
                        "cua_move"
                    ]
                }
            }),
        ),
        "nameSession" => rpc_ok(id, json!({})),
        "getCurrentTab" => rpc_ok(
            id,
            state
                .tab_id
                .map(|tab_id| fake_tab(tab_id))
                .unwrap_or(Value::Null),
        ),
        "createTab" => {
            let tab_id = state.next_tab_id;
            state.next_tab_id += 1;
            state.tab_id = Some(tab_id);
            state.created_tabs += 1;
            rpc_ok(id, fake_tab(tab_id))
        }
        "tab_url" => rpc_ok(id, json!("https://shop.test/")),
        "tab_title" => rpc_ok(id, json!("Fake Shop")),
        "playwright_locator_fill" => {
            if params.get("selector").and_then(Value::as_str) == Some("#search") {
                state.search_input = params
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
            }
            rpc_ok(id, Value::Null)
        }
        "playwright_locator_click" => {
            match params
                .get("selector")
                .and_then(Value::as_str)
                .unwrap_or_default()
            {
                "[data-product='keyboard']" => {
                    state.selected_product = Some("keyboard".to_string())
                }
                "#add-to-cart" if state.selected_product.as_deref() == Some("keyboard") => {
                    state.cart_count += 1;
                }
                _ => {}
            }
            rpc_ok(id, Value::Null)
        }
        "cua_move" => {
            if state.initial_cursor_before_first_move.is_none() {
                let x = params.get("x").and_then(Value::as_i64).unwrap_or_default();
                let y = params.get("y").and_then(Value::as_i64).unwrap_or_default();
                state.initial_cursor_before_first_move = Some((x, y));
            }
            rpc_ok(id, Value::Null)
        }
        "executeCdp" => rpc_ok(
            id,
            json!({
                "result": {
                    "value": {
                        "searchInput": state.search_input,
                        "selectedProduct": state.selected_product,
                        "cartCount": state.cart_count,
                        "yielded": state.yielded,
                        "resumed": state.resumed,
                        "createdTabs": state.created_tabs,
                        "initialCursorBeforeFirstMove": state.initial_cursor_before_first_move.map(|(x, y)| json!({ "x": x, "y": y }))
                    }
                }
            }),
        ),
        "turnEnded" => {
            state.turn_ended_calls += 1;
            rpc_ok(id, json!({}))
        }
        "yieldControl" => {
            state.yield_control_calls += 1;
            state.yielded = true;
            rpc_ok(id, json!({}))
        }
        "resumeControl" => {
            state.resume_control_calls += 1;
            state.resumed = true;
            let tab = state.tab_id.map(fake_tab).unwrap_or(Value::Null);
            rpc_ok(id, tab)
        }
        _ => rpc_error(id, -32601, &format!("method not found: {method}")),
    }
}

fn fake_tab(tab_id: u64) -> Value {
    json!({
        "tab_id": tab_id.to_string(),
        "url": "https://shop.test/",
        "title": "Fake Shop",
        "origin": "agent",
        "status": "active",
        "commandable": true,
        "logicalActive": true
    })
}

fn rpc_ok(id: Value, result: Value) -> Bytes {
    Bytes::from(
        serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        }))
        .expect("serialize fake rpc response"),
    )
}

fn rpc_error(id: Value, code: i64, message: &str) -> Bytes {
    Bytes::from(
        serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message }
        }))
        .expect("serialize fake rpc error"),
    )
}

fn set_owner_only_dir(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .expect("set owner-only dir permissions");
    }
}

fn set_owner_only_file(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .expect("set owner-only file permissions");
    }
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
    body { min-height: 2600px; }
    #nested-scroll { border: 1px solid #888; height: 90px; margin-top: 24px; overflow: auto; width: 260px; }
    #nested-scroll-content { height: 480px; padding-top: 220px; }
    #download-link { display: block; margin-top: 1200px; }
  </style>
  <body>
    <button id="main" onclick="window.__obuClicked = true">Click me</button>
    <button id="locator-nav" onclick="location.href = '/?locator-nav=1'">Locator nav</button>
    <div id="nested-scroll"><div id="nested-scroll-content">Nested scroll target</div></div>
    <input id="type-input">
    <textarea id="type-textarea"></textarea>
    <div id="type-editable" contenteditable="true"></div>
    <input id="paste-default">
    <input id="paste-prevent">
    <button id="dom-button" onclick="window.__obuDomClicked = true">DOM button</button>
    <input id="dom-input">
    <input id="upload" type="file">
    <a id="download-link" href="/__DOWNLOAD_NAME__" download="__DOWNLOAD_NAME__">Download file</a>
    <iframe srcdoc="<button id='inside' onclick='parent.__obuIframeClicked = true'>Inside</button>"></iframe>
    <script>
      window.__obuPasteEvents = [];
      for (const id of ["paste-default", "paste-prevent"]) {
        document.getElementById(id).addEventListener("paste", (event) => {
          window.__obuPasteEvents.push({
            id,
            text: event.clipboardData.getData("text/plain"),
            html: event.clipboardData.getData("text/html"),
            files: event.clipboardData.files.length
          });
          if (id === "paste-prevent") event.preventDefault();
        });
      }
    </script>
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

async fn spawn_dirty_form_fixture() -> (String, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buffer = [0u8; 1024];
                let read = stream.read(&mut buffer).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");
                let body = if path.starts_with("/clean") {
                    "<!doctype html><title>clean</title><main id=\"clean\">clean page</main>"
                        .to_string()
                } else {
                    r#"<!doctype html>
<html>
  <head><title>dirty-form</title></head>
  <body>
    <label for="dirty">Dirty value</label>
    <input id="dirty" autofocus>
    <script>
      window.__dirty = false;
      const input = document.getElementById("dirty");
      input.addEventListener("input", () => {
        window.__dirty = true;
      });
      window.addEventListener("beforeunload", (event) => {
        if (!window.__dirty) return;
        event.preventDefault();
        event.returnValue = "";
      });
    </script>
  </body>
</html>"#
                        .to_string()
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });
    (
        format!("http://{addr}/dirty"),
        format!("http://{addr}/clean"),
    )
}

async fn wait_for_descriptor(runtime: &Path) -> PathBuf {
    let dir = runtime.join("webextension");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
                    return path;
                }
            }
        }
        assert!(
            Instant::now() < deadline,
            "webextension descriptor was not written under {}",
            dir.display()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

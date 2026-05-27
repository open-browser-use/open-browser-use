use std::fs;

use serde_json::{Value, json};
use tempfile::tempdir;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdout, Command};

#[tokio::test]
async fn mcp_stdio_client_compat_profiles_preserve_structured_content_resources_and_progress() {
    for (client_name, capabilities, progress_token) in [
        (
            "codex-cli",
            json!({ "experimental": {}, "roots": { "listChanged": false } }),
            "codex-progress",
        ),
        (
            "claude-code",
            json!({ "roots": { "listChanged": true }, "sampling": {} }),
            "claude-progress",
        ),
        (
            "cursor",
            json!({ "experimental": { "resourceLinks": {} } }),
            "cursor-progress",
        ),
    ] {
        assert_client_profile_round_trip(client_name, capabilities, progress_token).await;
    }
}

#[tokio::test]
async fn mcp_stdio_lists_tools_and_executes_js() {
    let bin = env!("CARGO_BIN_EXE_obu-node-repl");
    let runtime_dir = tempdir().unwrap();
    let challenge_dir = tempdir().unwrap();
    let challenge_path = challenge_dir.path().join("challenge.json");
    fs::write(
        &challenge_path,
        serde_json::to_vec_pretty(&json!({
            "schemaVersion": 1,
            "agentId": "codex-cli",
            "mcpServerName": "open-browser-use",
            "challenge": {
                "nonce": "test-runtime-nonce",
                "issuedAt": "2026-05-19T12:34:30.000Z"
            },
            "target": {
                "browser": "chrome",
                "channel": "store",
                "extensionId": "abcdefghijklmnopabcdefghijklmnop"
            },
            "trustedHook": {
                "id": "codex-cli-runtime-status",
                "transport": "agent_owned_ipc"
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let mut child = Command::new(bin)
        .arg("mcp")
        .arg("stdio")
        .env("OBU_RUNTIME_DIR", runtime_dir.path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(_line)) = lines.next_line().await {}
    });

    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": { "name": "obu-node-repl-test", "version": "0.0.0" }
            }
        }),
    )
    .await;
    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }),
    )
    .await;
    send(
        &mut stdin,
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }),
    )
    .await;
    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "js",
                "_meta": {
                    "progressToken": "progress-1",
                    "x-obu-turn-metadata": {
                        "session_id": "client-must-not-win",
                        "turn_id": "client-turn-1"
                    }
                },
                "arguments": {
                    "source": "display(\"hi\"); ({ value: 6 * 7, meta: globalThis.obuRepl.requestMeta[\"x-obu-turn-metadata\"] })"
                }
            }
        }),
    )
    .await;

    let mut reader = BufReader::new(stdout).lines();
    let init = read_json(&mut reader).await;
    assert_eq!(init["id"], 1);
    assert!(init["result"]["capabilities"]["tools"].is_object());
    assert!(init["result"]["capabilities"]["resources"].is_object());

    let tools = read_json(&mut reader).await;
    assert_eq!(tools["id"], 2);
    let names = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        [
            "js",
            "browser_status",
            "agent_runtime_status",
            "js_reset",
            "js_add_module_dir"
        ]
    );
    let js_tool = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "js")
        .unwrap();
    assert_eq!(js_tool["outputSchema"]["type"], "object");
    assert!(js_tool["outputSchema"]["properties"]["result"].is_object());

    let first_after_call = read_json(&mut reader).await;
    let second_after_call = read_json(&mut reader).await;
    let (progress, exec) = if first_after_call.get("method").and_then(Value::as_str)
        == Some("notifications/progress")
    {
        (first_after_call, second_after_call)
    } else {
        (second_after_call, first_after_call)
    };

    assert_eq!(progress["method"], "notifications/progress");
    assert_eq!(progress["params"]["progressToken"], "progress-1");
    assert_eq!(progress["params"]["message"], "hi");

    assert_eq!(exec["id"], 3);
    assert!(
        exec["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("JavaScript execution completed in ")
    );
    assert_eq!(exec["result"]["structuredContent"]["result"]["value"], 42);
    assert_eq!(
        exec["result"]["structuredContent"]["result"]["meta"]["turn_id"],
        "client-turn-1"
    );
    assert_ne!(
        exec["result"]["structuredContent"]["result"]["meta"]["session_id"],
        "client-must-not-win"
    );
    assert_eq!(
        exec["result"]["structuredContent"]["displays"][0]["value"],
        "hi"
    );

    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "js",
                "arguments": {
                    "source": "throw new Error('mcp boom')"
                }
            }
        }),
    )
    .await;
    let failed_exec = read_json(&mut reader).await;
    assert_eq!(failed_exec["id"], 4);
    assert_eq!(failed_exec["result"]["isError"], true);
    assert_eq!(
        failed_exec["result"]["structuredContent"]["error"],
        "mcp boom"
    );
    assert_eq!(
        failed_exec["result"]["content"][0]["text"],
        "JavaScript execution failed: mcp boom"
    );

    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "browser_status",
                "arguments": {}
            }
        }),
    )
    .await;
    let status = read_json(&mut reader).await;
    assert_eq!(status["id"], 5);
    assert!(status["result"]["structuredContent"]["sdk_bootstrap"].is_string());
    assert!(status["result"]["structuredContent"]["backends"].is_array());
    let structured = &status["result"]["structuredContent"];
    assert!(structured["advisories"].is_array());
    let verify_hint = structured["verify_hint"].as_str().unwrap();
    let doctor_hint = structured["doctor_hint"].as_str().unwrap();
    assert!(doctor_hint.contains("obu doctor browser"));
    if structured["backends"].as_array().unwrap().is_empty() {
        assert!(verify_hint.contains("obu verify --repair"));
        assert_eq!(structured["product_error"]["code"], "setup_missing");
    } else {
        assert!(verify_hint.contains("obu verify"));
        if structured["sdk_bootstrap"] == "available" {
            assert!(structured["product_error"].is_null());
        } else {
            assert_eq!(structured["product_error"]["code"], "setup_missing");
        }
    }

    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "tools/call",
            "params": {
                "name": "js",
                "arguments": {
                    "source": "display({ __obuImage: true, mime_type: 'image/png', data: 'iVBORw0KGgo=' }); 'ok'"
                }
            }
        }),
    )
    .await;
    let image_exec = read_json(&mut reader).await;
    assert_eq!(image_exec["id"], 6);
    let artifact_uri = image_exec["result"]["structuredContent"]["displays"][0]["value"]["uri"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(artifact_uri.starts_with("obu-artifact://artifact-"));
    assert_eq!(image_exec["result"]["content"][1]["type"], "resource_link");
    assert!(image_exec.to_string().contains("iVBORw0KGgo=") == false);

    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "resources/read",
            "params": {
                "uri": artifact_uri
            }
        }),
    )
    .await;
    let resource = read_json(&mut reader).await;
    assert_eq!(resource["id"], 7);
    assert_eq!(resource["result"]["contents"][0]["mimeType"], "image/png");
    assert_eq!(resource["result"]["contents"][0]["blob"], "iVBORw0KGgo=");

    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 8,
            "method": "tools/call",
            "params": {
                "name": "js",
                "arguments": {
                    "source": "console.log('x'.repeat(10000000)); 'small'"
                }
            }
        }),
    )
    .await;
    let huge = read_json(&mut reader).await;
    assert_eq!(huge["id"], 8);
    assert_eq!(
        huge["result"]["structuredContent"]["truncated"]["stdout"],
        true
    );
    assert!(
        huge["result"]["structuredContent"]["stdout"]
            .as_str()
            .unwrap()
            .len()
            < 100000
    );

    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "tools/call",
            "params": {
                "name": "agent_runtime_status",
                "arguments": {
                    "challenge_json": challenge_path.to_string_lossy()
                }
            }
        }),
    )
    .await;
    let agent_runtime = read_json(&mut reader).await;
    assert_eq!(agent_runtime["id"], 9);
    let result_file = agent_runtime["result"]["structuredContent"]["resultFile"]
        .as_str()
        .unwrap();
    let delivered: Value = serde_json::from_slice(&fs::read(result_file).unwrap()).unwrap();
    assert_eq!(delivered["agentId"], "codex-cli");
    assert_eq!(delivered["provenance"], "agent_runtime_hook");
    assert_eq!(delivered["hook"]["id"], "codex-cli-runtime-status");
    assert_eq!(delivered["challenge"]["nonce"], "test-runtime-nonce");
    assert!(delivered["status"]["sdk_bootstrap"].is_string());

    drop(stdin);
    let status = tokio::time::timeout(std::time::Duration::from_secs(3), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success());
}

#[tokio::test]
async fn mcp_stdio_drains_tracked_background_operations() {
    let bin = env!("CARGO_BIN_EXE_obu-node-repl");
    let runtime_dir = tempdir().unwrap();
    let mut child = Command::new(bin)
        .arg("mcp")
        .arg("stdio")
        .env("OBU_RUNTIME_DIR", runtime_dir.path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(_line)) = lines.next_line().await {}
    });

    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": { "name": "obu-node-repl-test", "version": "0.0.0" }
            }
        }),
    )
    .await;
    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }),
    )
    .await;

    let mut reader = BufReader::new(stdout).lines();
    let init = read_json(&mut reader).await;
    assert_eq!(init["id"], 1);

    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "js",
                "arguments": {
                    "source": "globalThis.obuRepl.trackBackgroundOperation(new Promise((resolve) => setTimeout(resolve, 25))); 'done'"
                }
            }
        }),
    )
    .await;
    let drained = read_json(&mut reader).await;
    assert_eq!(drained["id"], 2);
    assert_eq!(drained["result"]["structuredContent"]["result"], "done");

    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "js",
                "arguments": {
                    "source": "globalThis.obuRepl.trackBackgroundOperation(Promise.reject(new Error('tracked boom'))); 'done'"
                }
            }
        }),
    )
    .await;
    let failed = read_json(&mut reader).await;
    assert_eq!(failed["id"], 3);
    assert_eq!(failed["result"]["isError"], true);
    assert!(
        failed["result"]["structuredContent"]["error"]
            .as_str()
            .unwrap()
            .contains("tracked boom")
    );

    drop(stdin);
    let status = tokio::time::timeout(std::time::Duration::from_secs(3), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success());
}

#[tokio::test]
async fn mcp_stdio_drain_times_out_instead_of_hanging() {
    // OBU_EXEC_DRAIN_BUDGET_MS keeps this fast; a never-settling tracked op must
    // surface as a normal exec error after the budget, NOT hang the kernel until the
    // host-side exec timeout kills it.
    let bin = env!("CARGO_BIN_EXE_obu-node-repl");
    let runtime_dir = tempdir().unwrap();
    let mut child = Command::new(bin)
        .arg("mcp")
        .arg("stdio")
        .env("OBU_RUNTIME_DIR", runtime_dir.path())
        .env("OBU_EXEC_DRAIN_BUDGET_MS", "100")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(_line)) = lines.next_line().await {}
    });

    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": { "name": "obu-node-repl-test", "version": "0.0.0" }
            }
        }),
    )
    .await;
    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }),
    )
    .await;

    let mut reader = BufReader::new(stdout).lines();
    let init = read_json(&mut reader).await;
    assert_eq!(init["id"], 1);

    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "js",
                "arguments": {
                    "source": "globalThis.obuRepl.trackBackgroundOperation(new Promise(() => {})); 'started'"
                }
            }
        }),
    )
    .await;
    let result = read_json(&mut reader).await;
    assert_eq!(result["id"], 2);
    assert_eq!(result["result"]["isError"], true);
    let err = result["result"]["structuredContent"]["error"]
        .as_str()
        .unwrap_or_default();
    assert!(
        err.contains("background operation drain timed out"),
        "got: {err}"
    );

    drop(stdin);
    let status = tokio::time::timeout(std::time::Duration::from_secs(3), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success());
}

async fn assert_client_profile_round_trip(
    client_name: &str,
    capabilities: Value,
    progress_token: &str,
) {
    let bin = env!("CARGO_BIN_EXE_obu-node-repl");
    let runtime_dir = tempdir().unwrap();
    let mut child = Command::new(bin)
        .arg("mcp")
        .arg("stdio")
        .env("OBU_RUNTIME_DIR", runtime_dir.path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(_line)) = lines.next_line().await {}
    });

    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": capabilities,
                "clientInfo": { "name": client_name, "version": "0.0.0" }
            }
        }),
    )
    .await;
    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }),
    )
    .await;
    send(
        &mut stdin,
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }),
    )
    .await;

    let progress_message = format!("{client_name} display progress");
    let source = format!(
        "display({}); display({{ __obuImage: true, mime_type: 'image/png', data: 'iVBORw0KGgo=' }}); ({{ profile: {}, ok: true }})",
        serde_json::to_string(&progress_message).unwrap(),
        serde_json::to_string(client_name).unwrap(),
    );
    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "js",
                "_meta": { "progressToken": progress_token },
                "arguments": { "source": source }
            }
        }),
    )
    .await;

    let mut reader = BufReader::new(stdout).lines();
    let init = read_json(&mut reader).await;
    assert_eq!(init["id"], 1, "{client_name}");
    assert!(
        init["result"]["capabilities"]["resources"].is_object(),
        "{client_name}"
    );

    let tools = read_json(&mut reader).await;
    assert_eq!(tools["id"], 2, "{client_name}");
    assert!(
        tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "js"
                && tool["outputSchema"]["properties"]["artifacts"].is_object()),
        "{client_name}"
    );

    let first_after_call = read_json(&mut reader).await;
    let second_after_call = read_json(&mut reader).await;
    let (progress, exec) = if first_after_call.get("method").and_then(Value::as_str)
        == Some("notifications/progress")
    {
        (first_after_call, second_after_call)
    } else {
        (second_after_call, first_after_call)
    };

    assert_eq!(
        progress["method"], "notifications/progress",
        "{client_name}"
    );
    assert_eq!(
        progress["params"]["progressToken"], progress_token,
        "{client_name}"
    );
    assert_eq!(
        progress["params"]["message"], progress_message,
        "{client_name}"
    );

    assert_eq!(exec["id"], 3, "{client_name}");
    assert_eq!(
        exec["result"]["structuredContent"]["result"]["profile"], client_name,
        "{client_name}"
    );
    assert_eq!(
        exec["result"]["structuredContent"]["truncated"]["displays"], false,
        "{client_name}"
    );
    let artifact_uri = exec["result"]["structuredContent"]["displays"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|display| display["value"]["uri"].as_str())
        .unwrap()
        .to_string();
    assert!(
        exec["result"]["content"]
            .as_array()
            .unwrap()
            .iter()
            .any(|content| content["type"] == "resource_link"
                && content.to_string().contains(&artifact_uri)),
        "{client_name}"
    );
    assert!(!exec.to_string().contains("iVBORw0KGgo="), "{client_name}");

    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "resources/list",
            "params": {}
        }),
    )
    .await;
    let resources = read_json(&mut reader).await;
    assert_eq!(resources["id"], 4, "{client_name}");
    assert!(
        resources["result"].to_string().contains(&artifact_uri),
        "{client_name}"
    );

    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "resources/read",
            "params": { "uri": artifact_uri }
        }),
    )
    .await;
    let resource = read_json(&mut reader).await;
    assert_eq!(resource["id"], 5, "{client_name}");
    assert_eq!(
        resource["result"]["contents"][0]["mimeType"], "image/png",
        "{client_name}"
    );
    assert_eq!(
        resource["result"]["contents"][0]["blob"], "iVBORw0KGgo=",
        "{client_name}"
    );

    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "tools/call",
            "params": {
                "name": "js",
                "arguments": {
                    "source": "console.log('x'.repeat(10000000)); 'small'"
                }
            }
        }),
    )
    .await;
    let huge_stdout = read_json(&mut reader).await;
    assert_eq!(huge_stdout["id"], 6, "{client_name}");
    assert_eq!(
        huge_stdout["result"]["structuredContent"]["truncated"]["stdout"], true,
        "{client_name}"
    );
    assert!(
        huge_stdout["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Truncated: stdout."),
        "{client_name}"
    );
    assert!(
        huge_stdout["result"]["structuredContent"]["stdout"]
            .as_str()
            .unwrap()
            .len()
            < 100000,
        "{client_name}"
    );

    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {
                "name": "js",
                "arguments": {
                    "source": "({ payload: 'x'.repeat(200000) })"
                }
            }
        }),
    )
    .await;
    let huge_result = read_json(&mut reader).await;
    assert_eq!(huge_result["id"], 7, "{client_name}");
    assert_eq!(
        huge_result["result"]["structuredContent"]["truncated"]["result"], true,
        "{client_name}"
    );
    assert_eq!(
        huge_result["result"]["structuredContent"]["result"]["kind"], "truncated",
        "{client_name}"
    );
    assert!(
        huge_result["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Truncated: result."),
        "{client_name}"
    );

    drop(stdin);
    let status = tokio::time::timeout(std::time::Duration::from_secs(3), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success(), "{client_name}");
}

async fn send(stdin: &mut tokio::process::ChildStdin, value: Value) {
    stdin.write_all(value.to_string().as_bytes()).await.unwrap();
    stdin.write_all(b"\n").await.unwrap();
    stdin.flush().await.unwrap();
}

async fn read_json(reader: &mut tokio::io::Lines<BufReader<ChildStdout>>) -> Value {
    let line = tokio::time::timeout(std::time::Duration::from_secs(3), reader.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(&line).unwrap()
}

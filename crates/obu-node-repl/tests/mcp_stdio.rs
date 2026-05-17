use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdout, Command};

#[tokio::test]
async fn mcp_stdio_lists_tools_and_executes_js() {
    let bin = env!("CARGO_BIN_EXE_obu-node-repl");
    let mut child = Command::new(bin)
        .arg("mcp")
        .arg("stdio")
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
        ["js", "browser_status", "js_reset", "js_add_module_dir"]
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
    assert!(
        status["result"]["structuredContent"]["doctor_hint"]
            .as_str()
            .unwrap()
            .starts_with("obu doctor browser")
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

    drop(stdin);
    let status = tokio::time::timeout(std::time::Duration::from_secs(3), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success());
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

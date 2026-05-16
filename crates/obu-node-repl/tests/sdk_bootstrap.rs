use obu_node_repl::repl_manager::{JsRuntimeManager, ManagerOptions};
use serde_json::json;

#[tokio::test]
async fn sdk_bootstrap_mounts_agent_and_help_from_trusted_sdk() {
    let root = tempfile::tempdir().unwrap();
    let sdk_dir = root
        .path()
        .join("node_modules")
        .join("@open-browser-use")
        .join("sdk");
    let dist_dir = sdk_dir.join("dist");
    std::fs::create_dir_all(&dist_dir).unwrap();
    std::fs::write(
        sdk_dir.join("package.json"),
        r#"{ "name": "@open-browser-use/sdk", "version": "0.0.0", "type": "module", "exports": { ".": "./dist/index.mjs" } }"#,
    )
    .unwrap();
    std::fs::write(
        dist_dir.join("index.mjs"),
        r#"
export async function setupObuRuntime() {
  if (typeof import.meta.__obuNativePipe !== "object") {
    throw new Error("trusted native pipe bridge missing");
  }
  const agent = Object.freeze({
    browsers: Object.freeze({}),
    help() {
      return "fixture help";
    },
  });
  return { agent };
}
"#,
    )
    .unwrap();

    let mut options = ManagerOptions::for_tests();
    options.module_dirs.push(root.path().to_path_buf());
    options.trusted_code_paths.push(sdk_dir);

    let manager = JsRuntimeManager::new(options).await.unwrap();
    let result = manager
        .exec(
            r#"
({
  agentType: typeof agent,
  helpType: typeof help,
  helpText: help(),
  agentEnumerable: Object.keys(globalThis).includes("agent"),
  helpEnumerable: Object.keys(globalThis).includes("help")
})
"#,
            None,
        )
        .await
        .unwrap();

    assert_eq!(
        result.result,
        json!({
            "agentType": "object",
            "helpType": "function",
            "helpText": "fixture help",
            "agentEnumerable": true,
            "helpEnumerable": true
        })
    );
}

#[tokio::test]
async fn sdk_bootstrap_skips_when_sdk_is_not_installed() {
    let manager = JsRuntimeManager::new(ManagerOptions::for_tests())
        .await
        .unwrap();
    let result = manager.exec("typeof agent", None).await.unwrap();
    assert_eq!(result.result, json!("undefined"));
}

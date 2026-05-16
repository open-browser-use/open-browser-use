use obu_node_repl::repl_manager::{JsRuntimeManager, ManagerOptions};
use serde_json::json;

#[tokio::test]
async fn trusted_dir_receives_obu_native_pipe_stub() {
    let trusted = tempfile::tempdir().unwrap();
    let trusted_module = trusted.path().join("trusted.mjs");
    std::fs::write(
        &trusted_module,
        r#"
export const hasPipe = typeof import.meta.__obuNativePipe === "object";
export async function connectMessage() {
  try {
    await import.meta.__obuNativePipe.createConnection("/tmp/obu.sock");
  } catch (error) {
    return error.message;
  }
}
"#,
    )
    .unwrap();

    let untrusted = tempfile::tempdir().unwrap();
    let untrusted_module = untrusted.path().join("untrusted.mjs");
    std::fs::write(
        &untrusted_module,
        r#"export const hasPipe = typeof import.meta.__obuNativePipe === "object";"#,
    )
    .unwrap();

    let mut options = ManagerOptions::for_tests();
    options
        .trusted_code_paths
        .push(trusted.path().to_path_buf());
    let manager = JsRuntimeManager::new(options).await.unwrap();

    let trusted_url = file_url(&trusted_module);
    let untrusted_url = file_url(&untrusted_module);
    let result = manager
        .exec(
            &format!(
                r#"
const trusted = await import("{trusted_url}");
const untrusted = await import("{untrusted_url}");
({{
  trustedHasPipe: trusted.hasPipe,
  untrustedHasPipe: untrusted.hasPipe,
  connectMessage: await trusted.connectMessage()
}})
"#
            ),
            None,
        )
        .await
        .unwrap();

    assert_eq!(result.result["trustedHasPipe"], json!(true));
    assert_eq!(result.result["untrustedHasPipe"], json!(false));
    assert!(
        result.result["connectMessage"]
            .as_str()
            .unwrap()
            .contains("native pipe path unavailable")
    );
}

fn file_url(path: &std::path::Path) -> String {
    format!("file://{}", path.to_string_lossy())
}

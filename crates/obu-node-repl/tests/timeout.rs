use obu_node_repl::repl_manager::{JsRuntimeManager, ManagerOptions};
use serde_json::json;

#[tokio::test]
async fn timeout_kills_kernel_and_next_exec_recovers() {
    let manager = JsRuntimeManager::new(ManagerOptions::for_tests())
        .await
        .unwrap();

    let err = manager
        .exec(
            "await new Promise((resolve) => setTimeout(resolve, 200)); 1",
            Some(25),
        )
        .await
        .unwrap_err();
    assert!(err.to_string().contains("timed out"));

    let result = manager.exec("2 + 2", None).await.unwrap();
    assert_eq!(result.result, json!(4));
}

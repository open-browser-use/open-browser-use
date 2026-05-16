use obu_node_repl::repl_manager::{JsRuntimeManager, ManagerOptions};
use serde_json::json;

#[tokio::test]
async fn reset_clears_repl_bindings() {
    let manager = JsRuntimeManager::new(ManagerOptions::for_tests())
        .await
        .unwrap();

    manager
        .exec("const retained = 7; retained", None)
        .await
        .unwrap();
    manager.reset().await.unwrap();

    let result = manager.exec("typeof retained", None).await.unwrap();
    assert_eq!(result.result, json!("undefined"));
}

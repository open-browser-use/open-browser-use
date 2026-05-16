use obu_node_repl::repl_manager::{JsRuntimeManager, ManagerOptions};
use serde_json::json;

#[tokio::test]
async fn js_one_plus_one() {
    let manager = JsRuntimeManager::new(ManagerOptions::for_tests())
        .await
        .unwrap();
    manager.boot().await.unwrap();

    let result = manager.exec("1 + 1", None).await.unwrap();
    assert_eq!(result.result, json!(2));
    assert_eq!(result.stdout, "");
    assert!(result.displays.is_empty());
}

#[tokio::test]
async fn carries_repl_state_between_execs() {
    let manager = JsRuntimeManager::new(ManagerOptions::for_tests())
        .await
        .unwrap();
    manager.boot().await.unwrap();

    manager.exec("const base = 40; base", None).await.unwrap();
    let result = manager.exec("base + 2", None).await.unwrap();
    assert_eq!(result.result, json!(42));
}

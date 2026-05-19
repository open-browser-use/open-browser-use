use obu_node_repl::repl_manager::{JsRuntimeManager, ManagerOptions};
use serde_json::json;
use std::sync::Arc;

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
async fn concurrent_boot_calls_share_one_kernel() {
    let manager = Arc::new(
        JsRuntimeManager::new(ManagerOptions::for_tests())
            .await
            .unwrap(),
    );
    let first = manager.clone();
    let second = manager.clone();

    let (first, second) = tokio::join!(first.boot(), second.boot());

    first.unwrap();
    second.unwrap();
    let result = manager.exec("1 + 1", Some(1_000)).await.unwrap();
    assert_eq!(result.result, json!(2));
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

#[tokio::test]
async fn javascript_errors_are_reported_without_resetting_kernel_state() {
    let manager = JsRuntimeManager::new(ManagerOptions::for_tests())
        .await
        .unwrap();
    manager.boot().await.unwrap();

    manager.exec("const base = 40; base", None).await.unwrap();
    let result = manager
        .exec(r#"throw new Error("boom")"#, None)
        .await
        .unwrap();
    assert_eq!(result.error.as_deref(), Some("boom"));
    assert_eq!(result.result, json!(null));

    let result = manager.exec("base + 2", None).await.unwrap();
    assert_eq!(result.result, json!(42));
}

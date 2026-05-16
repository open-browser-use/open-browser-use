#![cfg(unix)]

use std::time::Duration;

use obu_node_repl::repl_manager::{JsRuntimeManager, ManagerOptions};

#[tokio::test]
async fn handshake_token_observed_before_first_exec() {
    let manager = JsRuntimeManager::new(ManagerOptions::for_tests())
        .await
        .unwrap();
    manager.boot().await.unwrap();

    for _ in 0..20 {
        if manager.observed_handshake_token_for_tests().await.is_some() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    panic!("native-pipe handshake token was not observed");
}

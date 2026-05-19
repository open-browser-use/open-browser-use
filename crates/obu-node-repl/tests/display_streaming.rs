use obu_node_repl::repl_manager::{JsRuntimeManager, ManagerOptions};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn display_text_json_and_image_are_captured_and_text_json_stream() {
    let manager = JsRuntimeManager::new(ManagerOptions::for_tests())
        .await
        .unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    manager
        .set_progress_sink(Some(Arc::new(move |frame| {
            let _ = tx.send(frame);
        })))
        .await;

    let result = manager
        .exec(
            r#"display("hello"); display({ k: 1 }); display({ __obuImage: true, mime_type: "image/png", data: "iVBORw0" }); 42"#,
            None,
        )
        .await
        .unwrap();

    assert_eq!(result.result, json!(42));
    assert_eq!(result.displays.len(), 3);
    assert_eq!(result.displays[0].kind, "text");
    assert_eq!(result.displays[0].value, json!("hello"));
    assert_eq!(result.displays[1].kind, "json");
    assert_eq!(result.displays[1].value, json!({ "k": 1 }));
    assert_eq!(result.displays[2].kind, "image");
    assert_eq!(
        result.displays[2].value,
        json!({ "mime_type": "image/png", "data": "iVBORw0" })
    );

    let mut streamed = Vec::new();
    while let Ok(frame) = rx.try_recv() {
        streamed.push(frame);
    }
    assert_eq!(streamed.len(), 2);
    assert_eq!(streamed[0].message, "hello");
    assert_eq!(streamed[1].message, r#"{"k":1}"#);
}

#[tokio::test]
async fn emit_image_is_acknowledged() {
    let manager = JsRuntimeManager::new(ManagerOptions::for_tests())
        .await
        .unwrap();

    let result = manager
        .exec(
            r#"await nodeRepl.emitImage("data:image/png;base64,iVBORw0KGgo="); 42"#,
            Some(1_000),
        )
        .await
        .unwrap();

    assert_eq!(result.result, json!(42));
    assert_eq!(result.displays.len(), 1);
    assert_eq!(result.displays[0].kind, "image");
    assert_eq!(
        result.displays[0].value,
        json!({ "image_url": "data:image/png;base64,iVBORw0KGgo=" })
    );
}

#[tokio::test]
async fn losing_concurrent_exec_does_not_clear_active_progress_sink() {
    let manager = Arc::new(
        JsRuntimeManager::new(ManagerOptions::for_tests())
            .await
            .unwrap(),
    );
    manager.boot().await.unwrap();

    let (first_tx, mut first_rx) = tokio::sync::mpsc::unbounded_channel();
    let first_sink = Arc::new(move |frame| {
        let _ = first_tx.send(frame);
    });
    let first_manager = manager.clone();
    let first = tokio::spawn(async move {
        first_manager
            .exec_with_turn_id_and_progress_sink(
                r#"await new Promise((resolve) => setTimeout(resolve, 50)); display("first"); 1"#,
                Some(1_000),
                None,
                Some(first_sink),
            )
            .await
    });

    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    let (second_tx, mut second_rx) = tokio::sync::mpsc::unbounded_channel();
    let second_sink = Arc::new(move |frame| {
        let _ = second_tx.send(frame);
    });
    let second = manager
        .exec_with_turn_id_and_progress_sink(
            r#"display("second"); 2"#,
            Some(1_000),
            None,
            Some(second_sink),
        )
        .await;

    assert!(second.unwrap_err().to_string().contains("kernel is busy"));
    let first = first.await.unwrap().unwrap();
    assert_eq!(first.result, json!(1));

    let first_frame = first_rx.try_recv().expect("first progress frame");
    assert_eq!(first_frame.message, "first");
    assert!(second_rx.try_recv().is_err());
}

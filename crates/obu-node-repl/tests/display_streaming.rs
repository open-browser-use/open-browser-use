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

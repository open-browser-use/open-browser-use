use obu_wire::{ErrorCode, ErrorObject, Notification, Request, Response, RpcMessage};
use serde_json::json;

#[test]
fn request_roundtrip() {
    let req = Request::new(
        1,
        "executeCdp",
        json!({"target": "t", "method": "Page.navigate"}),
    );
    let serialized = serde_json::to_string(&req).unwrap();
    let back: Request = serde_json::from_str(&serialized).unwrap();
    assert_eq!(back.method, "executeCdp");
}

#[test]
fn response_ok_roundtrip() {
    let resp = Response::ok(1, json!({"result": 42}));
    let serialized = serde_json::to_string(&resp).unwrap();
    assert!(serialized.contains("\"result\""));
    assert!(!serialized.contains("\"error\""));
}

#[test]
fn response_err_roundtrip() {
    let err = ErrorObject::new(ErrorCode::InvalidParams, "missing field");
    let resp = Response::err(1, err);
    let v: serde_json::Value =
        serde_json::from_str(&serde_json::to_string(&resp).unwrap()).unwrap();
    assert_eq!(v["error"]["code"], -32602);
    assert!(v.get("result").is_none());
}

#[test]
fn notification_has_no_id() {
    let notification = Notification::new("onCdpEvent", json!({"sessionId": "abc"}));
    let v: serde_json::Value =
        serde_json::from_str(&serde_json::to_string(&notification).unwrap()).unwrap();
    assert!(v.get("id").is_none());
    assert_eq!(v["jsonrpc"], "2.0");
}

#[test]
fn rpc_message_classifies() {
    let req = serde_json::to_string(&Request::new(7, "ping", json!({}))).unwrap();
    let msg: RpcMessage = serde_json::from_str(&req).unwrap();
    assert!(matches!(msg, RpcMessage::Request(_)));
}

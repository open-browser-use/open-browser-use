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

#[test]
fn classifies_request_regardless_of_key_order() {
    let method_first: RpcMessage =
        serde_json::from_str(r#"{"jsonrpc":"2.0","method":"ping","id":7,"params":{}}"#).unwrap();
    assert!(matches!(method_first, RpcMessage::Request(_)));
    let id_first: RpcMessage =
        serde_json::from_str(r#"{"jsonrpc":"2.0","id":7,"method":"ping","params":{}}"#).unwrap();
    assert!(matches!(id_first, RpcMessage::Request(_)));
}

#[test]
fn classifies_response_notification_and_rejects_neither() {
    let resp: RpcMessage =
        serde_json::from_str(r#"{"jsonrpc":"2.0","id":1,"result":{"x":1}}"#).unwrap();
    assert!(matches!(resp, RpcMessage::Response(_)));
    let note: RpcMessage =
        serde_json::from_str(r#"{"jsonrpc":"2.0","method":"onEvent","params":{}}"#).unwrap();
    assert!(matches!(note, RpcMessage::Notification(_)));
    assert!(serde_json::from_str::<RpcMessage>(r#"{"jsonrpc":"2.0"}"#).is_err());
}

#[test]
fn id_present_but_null_is_not_treated_as_absent() {
    // Legacy `value.get("id").is_some()` treats explicit null as PRESENT, so this
    // is a (malformed) Request, not a Notification. `Id` has no null variant, so
    // Request parsing fails -> Err. The key assertion: NOT silently a Notification.
    let parsed = serde_json::from_str::<RpcMessage>(
        r#"{"jsonrpc":"2.0","id":null,"method":"m","params":{}}"#,
    );
    assert!(parsed.is_err());
}

#[test]
fn large_result_payload_round_trips_through_classification() {
    let big: serde_json::Value = serde_json::json!({
        "nodes": (0..2000).map(|i| serde_json::json!({"id": i})).collect::<Vec<_>>()
    });
    let frame = serde_json::to_string(&Response::ok(42, big.clone())).unwrap();
    let msg: RpcMessage = serde_json::from_str(&frame).unwrap();
    match msg {
        RpcMessage::Response(r) => assert_eq!(r.result.unwrap(), big),
        _ => panic!("expected Response"),
    }
}

#[ignore = "manual perf A/B; run with --release --ignored --nocapture"]
#[test]
fn bench_rpc_message_decode_ab() {
    use std::time::Instant;
    let big: serde_json::Value = serde_json::json!({
        "nodes": (0..5000).map(|i| serde_json::json!({"id": i, "tag": "div", "x": i})).collect::<Vec<_>>()
    });
    let frame = serde_json::to_vec(&Response::ok(1, big)).unwrap();
    const ITERS: u32 = 2000;

    // Path A: the current Value-based classification (baseline, inlined).
    let t = Instant::now();
    for _ in 0..ITERS {
        let v: serde_json::Value = serde_json::from_slice(&frame).unwrap();
        let has_id = v.get("id").is_some();
        let has_method = v.get("method").is_some();
        let msg = match (has_method, has_id) {
            (false, true) => RpcMessage::Response(serde_json::from_value(v).unwrap()),
            _ => unreachable!(),
        };
        std::hint::black_box(&msg);
    }
    let value_path = t.elapsed();

    // Path B: the production RpcMessage::deserialize (Value-based; the RawValue
    // single-pass rewrite was measured here and was not worthwhile — see commit).
    let t = Instant::now();
    for _ in 0..ITERS {
        let msg: RpcMessage = serde_json::from_slice(&frame).unwrap();
        std::hint::black_box(&msg);
    }
    let rpcmessage_path = t.elapsed();

    eprintln!("Value-path:      {value_path:?} ({ITERS} iters)");
    eprintln!("RpcMessage-path: {rpcmessage_path:?} ({ITERS} iters)");
}

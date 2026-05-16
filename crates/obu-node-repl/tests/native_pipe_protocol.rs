use obu_node_repl::native_pipe::protocol::{
    KernelIn, KernelOut, NativePipeData, NativePipeHandshake, NativePipeOp, NativePipeRequest,
};

#[test]
fn handshake_roundtrips_with_kernel_wire_type() {
    let frame = KernelOut::NativePipeHandshake(NativePipeHandshake {
        token: "abc".into(),
    });
    let json = serde_json::to_string(&frame).unwrap();
    assert!(json.contains(r#""type":"native_pipe_handshake""#));

    let decoded: KernelOut = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded, frame);
}

#[test]
fn connect_request_roundtrips_without_connection_id() {
    let frame = KernelOut::NativePipeRequest(NativePipeRequest {
        id: "native-pipe-7".into(),
        token: "tok".into(),
        op: NativePipeOp::Connect {
            path: "/tmp/obu/test.sock".into(),
        },
    });
    let json = serde_json::to_string(&frame).unwrap();
    assert!(json.contains(r#""type":"native_pipe_request""#));
    assert!(json.contains(r#""op":"connect""#));
    assert!(!json.contains("connection_id"));

    let decoded: KernelOut = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded, frame);
}

#[test]
fn data_event_roundtrips_with_base64_payload() {
    let frame = KernelIn::NativePipeData(NativePipeData {
        connection_id: "conn-1".into(),
        data_base64: "aGVsbG8=".into(),
    });
    let json = serde_json::to_string(&frame).unwrap();
    assert!(json.contains(r#""type":"native_pipe_data""#));

    let decoded: KernelIn = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded, frame);
}

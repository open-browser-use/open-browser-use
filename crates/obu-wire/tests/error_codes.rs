use obu_wire::{
    ErrorCode, ErrorObject,
    error::{
        ERR_CAPABILITY_TOKEN, ERR_CDP_FAILURE, ERR_CMD_DISALLOWED, ERR_CONFLICT,
        ERR_DIALOG_REQUIRES_DECISION, ERR_DISALLOWED, ERR_IO, ERR_NO_BACKEND, ERR_NOT_FOUND,
        ERR_NOT_IMPLEMENTED, ERR_OVERLOADED, ERR_PAGE_CLOSED, ERR_PEER_AUTH, ERR_PROTOCOL,
        ERR_TAB_NOT_ATTACHED, ERR_TIMEOUT,
    },
};

#[test]
fn standard_codes_map() {
    assert_eq!(ErrorCode::ParseError.value(), -32700);
    assert_eq!(ErrorCode::InvalidRequest.value(), -32600);
    assert_eq!(ErrorCode::MethodNotFound.value(), -32601);
    assert_eq!(ErrorCode::InvalidParams.value(), -32602);
    assert_eq!(ErrorCode::InternalError.value(), -32603);
}

#[test]
fn server_error_range() {
    let custom = ErrorCode::Server(-32099);
    assert_eq!(custom.value(), -32099);
}

#[test]
fn error_object_serializes_with_data() {
    let e = ErrorObject::new(ErrorCode::InvalidParams, "bad arg")
        .with_data(serde_json::json!({"field": "source"}));
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["code"], -32602);
    assert_eq!(v["message"], "bad arg");
    assert_eq!(v["data"]["field"], "source");
}

#[test]
fn conflict_code_is_in_server_range() {
    assert_eq!(ERR_CONFLICT, -1007);
    assert!((-1099..=-1000).contains(&ERR_CONFLICT));
}

#[test]
fn ranges_are_disjoint() {
    let server = [
        ERR_TIMEOUT,
        ERR_NOT_FOUND,
        ERR_DISALLOWED,
        ERR_NOT_IMPLEMENTED,
        ERR_PROTOCOL,
        ERR_NO_BACKEND,
        ERR_OVERLOADED,
        ERR_IO,
    ];
    let guards = [ERR_PEER_AUTH, ERR_CAPABILITY_TOKEN, ERR_CMD_DISALLOWED];
    let backend = [
        ERR_PAGE_CLOSED,
        ERR_CDP_FAILURE,
        ERR_TAB_NOT_ATTACHED,
        ERR_DIALOG_REQUIRES_DECISION,
    ];
    for &code in &server {
        assert!((-1099..=-1000).contains(&code));
    }
    for &code in &guards {
        assert!((-1199..=-1100).contains(&code));
    }
    for &code in &backend {
        assert!((-1299..=-1200).contains(&code));
    }
}

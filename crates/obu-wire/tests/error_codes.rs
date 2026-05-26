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

#[test]
fn generated_codes_have_exact_values() {
    assert_eq!(ERR_TIMEOUT, -1000);
    assert_eq!(ERR_NOT_FOUND, -1001);
    assert_eq!(ERR_DISALLOWED, -1002);
    assert_eq!(ERR_NOT_IMPLEMENTED, -1003);
    assert_eq!(ERR_PROTOCOL, -1004);
    assert_eq!(ERR_NO_BACKEND, -1005);
    assert_eq!(ERR_OVERLOADED, -1006);
    assert_eq!(ERR_CONFLICT, -1007);
    assert_eq!(ERR_IO, -1099);
    assert_eq!(ERR_PEER_AUTH, -1100);
    assert_eq!(ERR_CAPABILITY_TOKEN, -1101);
    assert_eq!(ERR_CMD_DISALLOWED, -1102);
    assert_eq!(ERR_PAGE_CLOSED, -1200);
    assert_eq!(ERR_CDP_FAILURE, -1201);
    assert_eq!(ERR_TAB_NOT_ATTACHED, -1202);
    assert_eq!(ERR_DIALOG_REQUIRES_DECISION, -1203);
}

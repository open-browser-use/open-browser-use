//! JSON-RPC 2.0 envelope types for the native-pipe wire.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::ErrorObject;

/// JSON-RPC version literal.
pub const JSONRPC: &str = "2.0";

/// JSON-RPC request or response ID.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Id {
    /// Numeric ID.
    Number(i64),
    /// String ID.
    String(String),
}

impl From<i64> for Id {
    fn from(value: i64) -> Self {
        Self::Number(value)
    }
}

impl From<i32> for Id {
    fn from(value: i32) -> Self {
        Self::Number(value.into())
    }
}

impl From<&str> for Id {
    fn from(value: &str) -> Self {
        Self::String(value.to_owned())
    }
}

impl From<String> for Id {
    fn from(value: String) -> Self {
        Self::String(value)
    }
}

/// JSON-RPC 2.0 request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    /// Must be `"2.0"`.
    pub jsonrpc: String,
    /// Request ID.
    pub id: Id,
    /// Method name.
    pub method: String,
    /// Method params.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub params: Value,
}

impl Request {
    /// Construct a request.
    pub fn new(id: impl Into<Id>, method: impl Into<String>, params: Value) -> Self {
        Self {
            jsonrpc: JSONRPC.into(),
            id: id.into(),
            method: method.into(),
            params,
        }
    }
}

/// JSON-RPC 2.0 response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    /// Must be `"2.0"`.
    pub jsonrpc: String,
    /// Response ID.
    pub id: Id,
    /// Success payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// Error payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorObject>,
}

impl Response {
    /// Construct a success response.
    pub fn ok(id: impl Into<Id>, result: Value) -> Self {
        Self {
            jsonrpc: JSONRPC.into(),
            id: id.into(),
            result: Some(result),
            error: None,
        }
    }

    /// Construct an error response.
    pub fn err(id: impl Into<Id>, error: ErrorObject) -> Self {
        Self {
            jsonrpc: JSONRPC.into(),
            id: id.into(),
            result: None,
            error: Some(error),
        }
    }
}

/// JSON-RPC 2.0 notification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notification {
    /// Must be `"2.0"`.
    pub jsonrpc: String,
    /// Method name.
    pub method: String,
    /// Notification params.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub params: Value,
}

impl Notification {
    /// Construct a notification.
    pub fn new(method: impl Into<String>, params: Value) -> Self {
        Self {
            jsonrpc: JSONRPC.into(),
            method: method.into(),
            params,
        }
    }
}

/// Classified inbound JSON-RPC message.
#[derive(Debug, Clone)]
pub enum RpcMessage {
    /// Request frame.
    Request(Request),
    /// Response frame.
    Response(Response),
    /// Notification frame.
    Notification(Notification),
}

impl<'de> Deserialize<'de> for RpcMessage {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        let has_id = value.get("id").is_some();
        let has_method = value.get("method").is_some();

        match (has_method, has_id) {
            (true, true) => serde_json::from_value(value)
                .map(Self::Request)
                .map_err(serde::de::Error::custom),
            (true, false) => serde_json::from_value(value)
                .map(Self::Notification)
                .map_err(serde::de::Error::custom),
            (false, true) => serde_json::from_value(value)
                .map(Self::Response)
                .map_err(serde::de::Error::custom),
            (false, false) => Err(serde::de::Error::custom(
                "frame is neither request, response, nor notification",
            )),
        }
    }
}

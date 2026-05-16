//! `display()` dual-channel routing.
//!
//! Text and JSON displays stream as progress messages and remain in the final
//! `displays` array. Images are final-array only.

use std::sync::Arc;

use serde_json::Value;

/// Progress frame sent to an optional streaming sink.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgressFrame {
    /// Monotonic counter for the current exec.
    pub progress: u64,
    /// User-facing progress message.
    pub message: String,
}

/// Display progress sink.
pub type ProgressSink = Arc<dyn Fn(ProgressFrame) + Send + Sync + 'static>;

/// Display payload class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayKind {
    /// String display.
    Text,
    /// JSON-compatible object/array/primitive display.
    Json,
    /// Image payload. Not streamed.
    Image,
}

/// Classify a kernel display frame.
pub fn classify(payload_type: &str) -> DisplayKind {
    match payload_type {
        "image" => DisplayKind::Image,
        "json" => DisplayKind::Json,
        _ => DisplayKind::Text,
    }
}

/// Convert display payload to a progress message. Returns `None` for images.
pub fn to_stream_message(kind: DisplayKind, value: &Value) -> Option<String> {
    match kind {
        DisplayKind::Image => None,
        DisplayKind::Text => Some(match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        }),
        DisplayKind::Json => Some(value.to_string()),
    }
}

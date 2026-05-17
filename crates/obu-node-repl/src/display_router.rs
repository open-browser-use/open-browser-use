//! `display()` dual-channel routing.
//!
//! Text and JSON displays stream as progress messages and remain in the final
//! `displays` array. Images are final-array only.

use std::sync::Arc;

use serde_json::Value;

const MAX_PROGRESS_MESSAGE_BYTES: usize = 4096;

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
    let message = match kind {
        DisplayKind::Image => None,
        DisplayKind::Text => Some(match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        }),
        DisplayKind::Json => Some(value.to_string()),
    }?;
    Some(truncate_progress_message(message))
}

fn truncate_progress_message(message: String) -> String {
    if message.len() <= MAX_PROGRESS_MESSAGE_BYTES {
        return message;
    }
    let omitted = message.len() - MAX_PROGRESS_MESSAGE_BYTES;
    let mut end = MAX_PROGRESS_MESSAGE_BYTES;
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n... truncated {} bytes ...", &message[..end], omitted)
}

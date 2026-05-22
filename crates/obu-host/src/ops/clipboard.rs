//! Shared clipboard validation and shortcut helpers.

use serde_json::{Map, Value};

use crate::error::{HostError, Result};
use crate::ops::keyboard;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClipboardShortcut {
    Paste,
    Blocked,
    None,
}

pub(crate) fn text_to_clipboard_html(text: &str) -> String {
    text.chars()
        .map(|ch| match ch {
            '&' => "&amp;".into(),
            '<' => "&lt;".into(),
            '>' => "&gt;".into(),
            '"' => "&quot;".into(),
            '\n' => "<br>".into(),
            _ => ch.to_string(),
        })
        .collect::<Vec<_>>()
        .join("")
}

pub(crate) fn include_rich_text(params: &Value) -> bool {
    params
        .get("includeRichText")
        .or_else(|| params.get("include_rich_text"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

pub(crate) fn clipboard_shortcut(params: &Value) -> ClipboardShortcut {
    let mut paste = false;
    for shortcut in keyboard::shortcut_from_params(params) {
        let is_c = matches!(shortcut.primary_key.as_str(), "c" | "keyc");
        let is_v = matches!(shortcut.primary_key.as_str(), "v" | "keyv");
        let is_x = matches!(shortcut.primary_key.as_str(), "x" | "keyx");
        let is_insert = shortcut.primary_key == "insert";
        if is_v && shortcut.has_primary_modifier && shortcut.modifier_count == 1 {
            paste = true;
            continue;
        }
        if (shortcut.has_primary_modifier && (is_c || is_v || is_x))
            || (is_insert && (shortcut.has_primary_modifier || shortcut.has_shift))
        {
            return ClipboardShortcut::Blocked;
        }
    }
    if paste {
        ClipboardShortcut::Paste
    } else {
        ClipboardShortcut::None
    }
}

pub(crate) fn native_clipboard_shortcut_error() -> HostError {
    HostError::Protocol(
        "Native clipboard shortcuts are disabled; use open-browser-use virtual clipboard commands instead."
            .into(),
    )
}

pub(crate) fn validate_clipboard_items(items: Option<&Value>) -> Result<Vec<Value>> {
    let items = items
        .and_then(Value::as_array)
        .ok_or_else(|| HostError::Protocol("tab_clipboard_write requires items array".into()))?;
    if items.is_empty() {
        return Err(HostError::Protocol(
            "tab_clipboard_write requires at least one clipboard item".into(),
        ));
    }
    items
        .iter()
        .enumerate()
        .map(|(index, item)| validate_clipboard_item(index, item))
        .collect()
}

fn validate_clipboard_item(index: usize, item: &Value) -> Result<Value> {
    let item = item
        .as_object()
        .ok_or_else(|| HostError::Protocol(format!("clipboard item {index} must be an object")))?;
    let entries = item
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| HostError::Protocol(format!("clipboard item {index} requires entries")))?;
    if entries.is_empty() {
        return Err(HostError::Protocol(format!(
            "clipboard item {index} requires at least one entry"
        )));
    }
    let mut normalized = Map::new();
    normalized.insert(
        "entries".into(),
        Value::Array(
            entries
                .iter()
                .enumerate()
                .map(|(entry_index, entry)| validate_clipboard_entry(index, entry_index, entry))
                .collect::<Result<Vec<_>>>()?,
        ),
    );
    if let Some(style) = item.get("presentation_style") {
        let style = style.as_str().ok_or_else(|| {
            HostError::Protocol(format!(
                "clipboard item {index} presentation_style must be a string"
            ))
        })?;
        match style {
            "unspecified" | "inline" | "attachment" => {
                normalized.insert("presentation_style".into(), Value::String(style.into()));
            }
            _ => {
                return Err(HostError::Protocol(format!(
                    "clipboard item {index} presentation_style is invalid"
                )));
            }
        }
    }
    Ok(Value::Object(normalized))
}

fn validate_clipboard_entry(item_index: usize, entry_index: usize, entry: &Value) -> Result<Value> {
    let entry = entry.as_object().ok_or_else(|| {
        HostError::Protocol(format!(
            "clipboard item {item_index} entry {entry_index} must be an object"
        ))
    })?;
    let mime_type = entry
        .get("mime_type")
        .and_then(Value::as_str)
        .filter(|mime_type| !mime_type.is_empty())
        .ok_or_else(|| {
            HostError::Protocol(format!(
                "clipboard item {item_index} entry {entry_index} requires mime_type"
            ))
        })?;
    let text = optional_string_field(entry, "text", item_index, entry_index)?;
    let base64 = optional_string_field(entry, "base64", item_index, entry_index)?;
    if text.is_some() == base64.is_some() {
        return Err(HostError::Protocol(format!(
            "clipboard item {item_index} entry {entry_index} must set exactly one of text or base64"
        )));
    }
    let mut normalized = Map::new();
    normalized.insert("mime_type".into(), Value::String(mime_type.into()));
    if let Some(text) = text {
        normalized.insert("text".into(), Value::String(text.into()));
    }
    if let Some(base64) = base64 {
        normalized.insert("base64".into(), Value::String(base64.into()));
    }
    Ok(Value::Object(normalized))
}

fn optional_string_field<'a>(
    entry: &'a Map<String, Value>,
    field: &str,
    item_index: usize,
    entry_index: usize,
) -> Result<Option<&'a str>> {
    match entry.get(field) {
        Some(Value::String(value)) => Ok(Some(value)),
        Some(_) => Err(HostError::Protocol(format!(
            "clipboard item {item_index} entry {entry_index} {field} must be a string"
        ))),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn clipboard_shortcut_accepts_plus_chord_paste_forms() {
        assert_eq!(
            clipboard_shortcut(&json!({ "key": "ControlOrMeta+V" })),
            ClipboardShortcut::Paste
        );
        assert_eq!(
            clipboard_shortcut(&json!({ "keys": ["ControlOrMeta+V"] })),
            ClipboardShortcut::Paste
        );
        let primary = if cfg!(target_os = "macos") {
            "Meta"
        } else {
            "Control"
        };
        assert_eq!(
            clipboard_shortcut(&json!({ "keys": [primary, "v"] })),
            ClipboardShortcut::Paste
        );
    }

    #[test]
    fn clipboard_shortcut_blocks_native_clipboard_chords() {
        let primary = if cfg!(target_os = "macos") {
            "Meta"
        } else {
            "Control"
        };
        assert_eq!(
            clipboard_shortcut(&json!({ "key": format!("{primary}+C") })),
            ClipboardShortcut::Blocked
        );
        assert_eq!(
            clipboard_shortcut(&json!({ "key": "ControlOrMeta+V", "modifiers": ["Shift"] })),
            ClipboardShortcut::Blocked
        );
        assert_eq!(
            clipboard_shortcut(&json!({ "key": "Shift+Insert" })),
            ClipboardShortcut::Blocked
        );
    }

    #[test]
    fn clipboard_shortcut_ignores_non_primary_clipboard_chords() {
        let non_primary = if cfg!(target_os = "macos") {
            "Control"
        } else {
            "Meta"
        };
        assert_eq!(
            clipboard_shortcut(&json!({ "key": format!("{non_primary}+C") })),
            ClipboardShortcut::None
        );
    }
}

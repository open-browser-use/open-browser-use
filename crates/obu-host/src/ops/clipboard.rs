//! Shared clipboard validation and shortcut helpers.

use serde_json::{Map, Value};

use crate::error::{HostError, Result};

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
    let mut keys = if let Some(keys) = params.get("keys").and_then(Value::as_array) {
        keys.iter()
            .filter_map(Value::as_str)
            .map(normalize_key)
            .collect::<Vec<_>>()
    } else if let Some(key) = params.get("key").and_then(Value::as_str) {
        vec![normalize_key(key)]
    } else {
        Vec::new()
    };
    if let Some(modifiers) = params.get("modifiers").and_then(Value::as_array) {
        keys.extend(
            modifiers
                .iter()
                .filter_map(Value::as_str)
                .map(normalize_key),
        );
    }
    keys.sort();
    keys.dedup();
    let has_primary_modifier = keys.iter().any(|key| key == primary_modifier_key());
    let has_shift = keys.iter().any(|key| key == "shift");
    let has_insert = keys.iter().any(|key| key == "insert");
    let has_c = keys.iter().any(|key| key == "c" || key == "keyc");
    let has_v = keys.iter().any(|key| key == "v" || key == "keyv");
    let has_x = keys.iter().any(|key| key == "x" || key == "keyx");
    let modifier_count = keys
        .iter()
        .filter(|key| matches!(key.as_str(), "meta" | "control" | "shift" | "alt"))
        .count();

    if has_v && has_primary_modifier && modifier_count == 1 {
        return ClipboardShortcut::Paste;
    }
    if (has_primary_modifier && (has_c || has_v || has_x))
        || (has_insert && (has_primary_modifier || has_shift))
    {
        return ClipboardShortcut::Blocked;
    }
    ClipboardShortcut::None
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

fn normalize_key(key: &str) -> String {
    match key.to_ascii_lowercase().as_str() {
        "cmd" | "command" => "meta".into(),
        "ctrl" => "control".into(),
        "controlormeta" | "control_or_meta" | "control-or-meta" => primary_modifier_key().into(),
        other => other.into(),
    }
}

fn primary_modifier_key() -> &'static str {
    if cfg!(target_os = "macos") {
        "meta"
    } else {
        "control"
    }
}

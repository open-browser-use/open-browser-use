//! Shared CDP keyboard event composition.

use serde_json::{Value, json};

use crate::error::{HostError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Modifier {
    Alt,
    Control,
    Meta,
    Shift,
}

impl Modifier {
    fn mask(self) -> i64 {
        match self {
            Self::Alt => 1,
            Self::Control => 2,
            Self::Meta => 4,
            Self::Shift => 8,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedShortcut {
    pub primary_key: String,
    pub modifier_mask: i64,
    pub modifier_count: usize,
    pub has_primary_modifier: bool,
    pub has_shift: bool,
}

#[derive(Debug, Clone)]
struct KeyDescriptor {
    key: String,
    code: String,
    windows_virtual_key_code: i64,
    location: i64,
    is_keypad: bool,
    text: String,
}

#[derive(Debug, Clone)]
struct KeyStroke {
    pressed_modifiers: Vec<Modifier>,
    active_modifiers: Vec<Modifier>,
    descriptor: KeyDescriptor,
}

/// Compose a Playwright/CUA-style keypress command into CDP key events.
pub(crate) fn keypress_events(params: &Value) -> Result<Vec<Value>> {
    let explicit_modifiers = explicit_modifiers(params);
    let strokes = key_strokes(params, &explicit_modifiers)?;
    let mut events = Vec::new();
    for stroke in strokes {
        events.extend(events_for_stroke(&stroke));
    }
    Ok(events)
}

pub(crate) fn shortcut_from_params(params: &Value) -> Vec<ParsedShortcut> {
    let explicit_modifiers = explicit_modifiers(params);
    if let Some(keys) = params.get("keys").and_then(Value::as_array) {
        if let Some(shortcut) = legacy_shortcut_from_keys(keys, &explicit_modifiers) {
            return vec![shortcut];
        }
        return keys
            .iter()
            .filter_map(Value::as_str)
            .filter_map(|key| parse_shortcut_stroke(key, &explicit_modifiers))
            .collect();
    }
    params
        .get("key")
        .or_else(|| params.get("value"))
        .and_then(Value::as_str)
        .and_then(|key| parse_shortcut_stroke(key, &explicit_modifiers))
        .into_iter()
        .collect()
}

fn key_strokes(params: &Value, explicit_modifiers: &[Modifier]) -> Result<Vec<KeyStroke>> {
    if let Some(keys) = params.get("keys").and_then(Value::as_array) {
        let mut strokes = Vec::new();
        for key in keys.iter().filter_map(Value::as_str) {
            strokes.push(parse_key_stroke(key, explicit_modifiers)?);
        }
        return Ok(strokes);
    }
    let key = params
        .get("key")
        .or_else(|| params.get("value"))
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::Protocol("missing key".into()))?;
    Ok(vec![parse_key_stroke(key, explicit_modifiers)?])
}

fn legacy_shortcut_from_keys(
    keys: &[Value],
    explicit_modifiers: &[Modifier],
) -> Option<ParsedShortcut> {
    let mut modifiers = explicit_modifiers.to_vec();
    let mut primary_keys = Vec::new();
    for key in keys.iter().filter_map(Value::as_str) {
        let parts = split_key_parts(key);
        let (modifier_parts, primary_part) = parts
            .split_last()
            .map(|(last, modifiers)| (modifiers, *last))
            .unwrap_or((&[][..], key));
        if !modifier_parts.is_empty() {
            for part in modifier_parts {
                push_modifier(&mut modifiers, modifier_alias(part)?);
            }
            primary_keys.push(primary_part);
            continue;
        }
        if let Some(modifier) = modifier_alias(primary_part) {
            push_modifier(&mut modifiers, modifier);
        } else {
            primary_keys.push(primary_part);
        }
    }
    if primary_keys.len() != 1 || modifiers.is_empty() {
        return None;
    }
    shortcut_from_primary(primary_keys[0], &modifiers)
}

fn parse_shortcut_stroke(key: &str, explicit_modifiers: &[Modifier]) -> Option<ParsedShortcut> {
    let mut modifiers = explicit_modifiers.to_vec();
    let parts = split_key_parts(key);
    let primary_key = if parts.len() > 1 {
        for part in &parts[..parts.len() - 1] {
            push_modifier(&mut modifiers, modifier_alias(part)?);
        }
        parts[parts.len() - 1]
    } else {
        key
    };
    shortcut_from_primary(primary_key, &modifiers)
}

fn shortcut_from_primary(primary_key: &str, modifiers: &[Modifier]) -> Option<ParsedShortcut> {
    let normalized = normalize_key_name(primary_key);
    if modifier_alias(&normalized).is_some() {
        return None;
    }
    let modifier_mask = modifiers
        .iter()
        .fold(0, |mask, modifier| mask | modifier.mask());
    Some(ParsedShortcut {
        primary_key: normalized.to_ascii_lowercase(),
        modifier_mask,
        modifier_count: modifiers.len(),
        has_primary_modifier: modifier_mask & primary_modifier().mask() != 0,
        has_shift: modifier_mask & Modifier::Shift.mask() != 0,
    })
}

fn split_key_parts(key: &str) -> Vec<&str> {
    key.split('+').filter(|part| !part.is_empty()).collect()
}

fn parse_key_stroke(key: &str, explicit_modifiers: &[Modifier]) -> Result<KeyStroke> {
    let mut modifiers = explicit_modifiers.to_vec();
    let mut pressed_modifiers = Vec::new();
    let mut primary_key = key;
    let parts = split_key_parts(key);
    if parts.len() > 1 {
        for part in &parts[..parts.len() - 1] {
            if let Some(modifier) = modifier_alias(part) {
                push_modifier(&mut modifiers, modifier);
                push_modifier(&mut pressed_modifiers, modifier);
            }
        }
        primary_key = parts[parts.len() - 1];
    }
    let modifier_mask = modifiers
        .iter()
        .fold(0, |mask, modifier| mask | modifier.mask());
    let descriptor = descriptor_for_key(primary_key, modifier_mask)
        .ok_or_else(|| HostError::Protocol(format!("unsupported key: {primary_key}")))?;
    Ok(KeyStroke {
        pressed_modifiers,
        active_modifiers: modifiers,
        descriptor,
    })
}

fn events_for_stroke(stroke: &KeyStroke) -> Vec<Value> {
    let mut events = Vec::new();
    let modifiers = stroke
        .active_modifiers
        .iter()
        .fold(0, |mask, modifier| mask | modifier.mask());
    for modifier in &stroke.pressed_modifiers {
        events.push(event_payload(
            "rawKeyDown",
            &modifier_descriptor(*modifier),
            0,
            None,
        ));
    }
    events.push(event_payload(
        if stroke.descriptor.text.is_empty() {
            "rawKeyDown"
        } else {
            "keyDown"
        },
        &stroke.descriptor,
        modifiers,
        native_edit_commands(&stroke.descriptor, modifiers),
    ));
    events.push(event_payload("keyUp", &stroke.descriptor, modifiers, None));
    for modifier in stroke.pressed_modifiers.iter().rev() {
        events.push(event_payload(
            "keyUp",
            &modifier_descriptor(*modifier),
            0,
            None,
        ));
    }
    events
}

fn event_payload(
    event_type: &str,
    descriptor: &KeyDescriptor,
    modifiers: i64,
    commands: Option<Vec<&'static str>>,
) -> Value {
    let has_non_shift_modifier =
        modifiers & (Modifier::Alt.mask() | Modifier::Control.mask() | Modifier::Meta.mask()) != 0;
    let include_text = event_type == "keyDown" && !has_non_shift_modifier;
    let mut payload = json!({
        "type": event_type,
        "key": descriptor.key,
        "code": descriptor.code,
        "windowsVirtualKeyCode": descriptor.windows_virtual_key_code,
        "nativeVirtualKeyCode": descriptor.windows_virtual_key_code,
        "location": descriptor.location,
        "isKeypad": descriptor.is_keypad,
        "text": if include_text { descriptor.text.as_str() } else { "" },
        "unmodifiedText": if include_text { descriptor.text.as_str() } else { "" },
        "modifiers": modifiers,
    });
    if let Some(commands) = commands
        && cfg!(target_os = "macos")
        && let Some(object) = payload.as_object_mut()
    {
        object.insert("commands".into(), json!(commands));
    }
    payload
}

fn modifier_descriptor(modifier: Modifier) -> KeyDescriptor {
    match modifier {
        Modifier::Alt => named_descriptor("Alt", "AltLeft", 18, 1),
        Modifier::Control => named_descriptor("Control", "ControlLeft", 17, 1),
        Modifier::Meta => named_descriptor("Meta", "MetaLeft", 91, 1),
        Modifier::Shift => named_descriptor("Shift", "ShiftLeft", 16, 1),
    }
}

fn descriptor_for_key(key: &str, modifiers: i64) -> Option<KeyDescriptor> {
    let normalized = normalize_key_name(key);
    if let Some(modifier) = modifier_alias(&normalized) {
        return Some(modifier_descriptor(modifier));
    }
    match normalized.as_str() {
        "Escape" => Some(named_descriptor("Escape", "Escape", 27, 0)),
        "Backspace" => Some(named_descriptor("Backspace", "Backspace", 8, 0)),
        "Delete" => Some(named_descriptor("Delete", "Delete", 46, 0)),
        "Insert" => Some(named_descriptor("Insert", "Insert", 45, 0)),
        "Enter" => Some(named_descriptor("Enter", "Enter", 13, 0)),
        "Tab" => Some(named_descriptor("Tab", "Tab", 9, 0)),
        "ArrowLeft" => Some(named_descriptor("ArrowLeft", "ArrowLeft", 37, 0)),
        "ArrowUp" => Some(named_descriptor("ArrowUp", "ArrowUp", 38, 0)),
        "ArrowRight" => Some(named_descriptor("ArrowRight", "ArrowRight", 39, 0)),
        "ArrowDown" => Some(named_descriptor("ArrowDown", "ArrowDown", 40, 0)),
        "PageUp" => Some(named_descriptor("PageUp", "PageUp", 33, 0)),
        "PageDown" => Some(named_descriptor("PageDown", "PageDown", 34, 0)),
        "Home" => Some(named_descriptor("Home", "Home", 36, 0)),
        "End" => Some(named_descriptor("End", "End", 35, 0)),
        " " | "Space" => Some(printable_descriptor(" ", "Space", 32, false, 0)),
        value if value.starts_with("Numpad") => numpad_descriptor(value),
        value if value.len() == 1 => printable_char_descriptor(value.chars().next()?, modifiers),
        value if value.starts_with("Key") && value.len() == 4 => {
            printable_char_descriptor(value.chars().nth(3)?.to_ascii_lowercase(), modifiers)
        }
        value if value.starts_with("Digit") && value.len() == 6 => {
            printable_char_descriptor(value.chars().nth(5)?, modifiers)
        }
        _ => None,
    }
}

fn named_descriptor(key: &str, code: &str, vkey: i64, location: i64) -> KeyDescriptor {
    KeyDescriptor {
        key: key.into(),
        code: code.into(),
        windows_virtual_key_code: vkey,
        location,
        is_keypad: false,
        text: String::new(),
    }
}

fn printable_descriptor(
    key: &str,
    code: &str,
    vkey: i64,
    shifted: bool,
    location: i64,
) -> KeyDescriptor {
    let text = if shifted {
        shifted_text(key).unwrap_or(key).to_string()
    } else {
        key.to_string()
    };
    KeyDescriptor {
        key: text.clone(),
        code: code.into(),
        windows_virtual_key_code: vkey,
        location,
        is_keypad: location == 3,
        text,
    }
}

fn printable_char_descriptor(ch: char, modifiers: i64) -> Option<KeyDescriptor> {
    let shifted = modifiers & Modifier::Shift.mask() != 0;
    if ch.is_ascii_alphabetic() {
        let lower = ch.to_ascii_lowercase();
        let key = if shifted {
            lower.to_ascii_uppercase().to_string()
        } else {
            lower.to_string()
        };
        return Some(printable_descriptor(
            &key,
            &format!("Key{}", lower.to_ascii_uppercase()),
            lower.to_ascii_uppercase() as i64,
            false,
            0,
        ));
    }
    if ch.is_ascii_digit() {
        return Some(printable_descriptor(
            &ch.to_string(),
            &format!("Digit{ch}"),
            ch as i64,
            shifted,
            0,
        ));
    }
    let (code, vkey) = punctuation_code(ch)?;
    Some(printable_descriptor(
        &ch.to_string(),
        code,
        vkey,
        shifted,
        0,
    ))
}

fn numpad_descriptor(value: &str) -> Option<KeyDescriptor> {
    let digit = value.strip_prefix("Numpad")?.chars().next()?;
    if !digit.is_ascii_digit() {
        return None;
    }
    Some(printable_descriptor(
        &digit.to_string(),
        value,
        96 + digit.to_digit(10)? as i64,
        false,
        3,
    ))
}

fn punctuation_code(ch: char) -> Option<(&'static str, i64)> {
    Some(match ch {
        '-' | '_' => ("Minus", 189),
        '=' | '+' => ("Equal", 187),
        '[' | '{' => ("BracketLeft", 219),
        ']' | '}' => ("BracketRight", 221),
        '\\' | '|' => ("Backslash", 220),
        ';' | ':' => ("Semicolon", 186),
        '\'' | '"' => ("Quote", 222),
        ',' | '<' => ("Comma", 188),
        '.' | '>' => ("Period", 190),
        '/' | '?' => ("Slash", 191),
        '`' | '~' => ("Backquote", 192),
        _ => return None,
    })
}

fn shifted_text(key: &str) -> Option<&'static str> {
    Some(match key {
        "1" => "!",
        "2" => "@",
        "3" => "#",
        "4" => "$",
        "5" => "%",
        "6" => "^",
        "7" => "&",
        "8" => "*",
        "9" => "(",
        "0" => ")",
        "-" => "_",
        "=" => "+",
        "[" => "{",
        "]" => "}",
        "\\" => "|",
        ";" => ":",
        "'" => "\"",
        "," => "<",
        "." => ">",
        "/" => "?",
        "`" => "~",
        _ => return None,
    })
}

fn native_edit_commands(descriptor: &KeyDescriptor, modifiers: i64) -> Option<Vec<&'static str>> {
    if modifiers & Modifier::Meta.mask() == 0 {
        return None;
    }
    match descriptor.key.as_str().to_ascii_lowercase().as_str() {
        "a" => Some(vec!["selectAll"]),
        "z" if modifiers & Modifier::Shift.mask() != 0 => Some(vec!["redo"]),
        "z" => Some(vec!["undo"]),
        _ => None,
    }
}

fn explicit_modifiers(params: &Value) -> Vec<Modifier> {
    params
        .get("modifiers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(modifier_alias)
        .fold(Vec::new(), |mut modifiers, modifier| {
            push_modifier(&mut modifiers, modifier);
            modifiers
        })
}

fn push_modifier(modifiers: &mut Vec<Modifier>, modifier: Modifier) {
    if !modifiers.contains(&modifier) {
        modifiers.push(modifier);
    }
}

fn modifier_alias(key: &str) -> Option<Modifier> {
    match normalize_key_name(key).as_str() {
        "Alt" | "Option" => Some(Modifier::Alt),
        "Control" | "Ctrl" => Some(Modifier::Control),
        "ControlOrMeta" => Some(primary_modifier()),
        "Meta" | "Cmd" | "Command" => Some(Modifier::Meta),
        "Shift" => Some(Modifier::Shift),
        _ => None,
    }
}

fn normalize_key_name(key: &str) -> String {
    match key.to_ascii_lowercase().as_str() {
        "alt" => "Alt".into(),
        "option" => "Option".into(),
        "control" => "Control".into(),
        "ctrl" => "Ctrl".into(),
        "controlormeta" | "control_or_meta" | "control-or-meta" => "ControlOrMeta".into(),
        "meta" => "Meta".into(),
        "cmd" => "Cmd".into(),
        "command" => "Command".into(),
        "shift" => "Shift".into(),
        "esc" | "escape" => "Escape".into(),
        "backspace" => "Backspace".into(),
        "delete" | "del" => "Delete".into(),
        "insert" | "ins" => "Insert".into(),
        "enter" | "return" => "Enter".into(),
        "tab" => "Tab".into(),
        "space" => "Space".into(),
        "arrowleft" | "left" => "ArrowLeft".into(),
        "arrowup" | "up" => "ArrowUp".into(),
        "arrowright" | "right" => "ArrowRight".into(),
        "arrowdown" | "down" => "ArrowDown".into(),
        "pageup" => "PageUp".into(),
        "pagedown" => "PageDown".into(),
        "home" => "Home".into(),
        "end" => "End".into(),
        other if other.starts_with("numpad") && other.len() > 6 => {
            let suffix = &key[6..];
            format!("Numpad{suffix}")
        }
        other if other.starts_with("key") && other.len() == 4 => {
            format!("Key{}", key[3..].to_ascii_uppercase())
        }
        other if other.starts_with("digit") && other.len() == 6 => {
            format!("Digit{}", &key[5..])
        }
        _ => key.into(),
    }
}

fn primary_modifier() -> Modifier {
    if cfg!(target_os = "macos") {
        Modifier::Meta
    } else {
        Modifier::Control
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn control_or_meta_combo_emits_modifier_down_key_and_key_up() {
        let events = keypress_events(&json!({ "key": "ControlOrMeta+A" })).unwrap();
        let primary = if cfg!(target_os = "macos") {
            ("Meta", 4)
        } else {
            ("Control", 2)
        };
        assert_eq!(events[0]["key"], primary.0);
        assert_eq!(events[1]["key"], "a");
        assert_eq!(events[1]["code"], "KeyA");
        assert_eq!(events[1]["text"], "");
        assert_eq!(events[1]["unmodifiedText"], "");
        assert_eq!(events[1]["modifiers"], primary.1);
        assert_eq!(events[2]["type"], "keyUp");
        assert_eq!(events[3]["type"], "keyUp");
    }

    #[test]
    fn aliases_include_navigation_and_editing_keys() {
        let events = keypress_events(
            &json!({ "keys": ["esc", "pageup", "Backspace", "Delete", "ArrowLeft"] }),
        )
        .unwrap();
        let keys = events
            .iter()
            .step_by(2)
            .map(|event| event["key"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            keys,
            ["Escape", "PageUp", "Backspace", "Delete", "ArrowLeft"]
        );
        assert_eq!(events[2]["windowsVirtualKeyCode"], 33);
    }

    #[test]
    fn shifted_punctuation_and_numpad_include_metadata() {
        let shifted = keypress_events(&json!({ "key": "Shift+/" })).unwrap();
        assert_eq!(shifted[1]["key"], "?");
        assert_eq!(shifted[1]["code"], "Slash");
        assert_eq!(shifted[1]["text"], "?");

        let numpad = keypress_events(&json!({ "key": "Numpad1" })).unwrap();
        assert_eq!(numpad[0]["key"], "1");
        assert_eq!(numpad[0]["code"], "Numpad1");
        assert_eq!(numpad[0]["location"], 3);
        assert_eq!(numpad[0]["isKeypad"], true);
    }

    #[test]
    fn macos_edit_commands_are_attached_when_available() {
        let events = keypress_events(&json!({ "key": "Meta+A" })).unwrap();
        if cfg!(target_os = "macos") {
            assert_eq!(events[1]["commands"], json!(["selectAll"]));
        } else {
            assert!(events[1].get("commands").is_none());
        }
    }
}

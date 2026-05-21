//! Shared DOM-CUA snapshot and geometry helpers.

use std::collections::{BTreeMap, HashSet};

use serde_json::{Map, Value, json};

use crate::backends::BackendRequestContext;
use crate::error::{HostError, Result};

pub(crate) const OBU_OVERLAY_ROOT_ID: &str = "obu-agent-overlay-root";

#[derive(Debug, Clone, Copy)]
pub(crate) struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub(crate) fn center(self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }

    pub(crate) fn intersects(self, other: Rect) -> bool {
        self.x < other.x + other.width
            && self.x + self.width > other.x
            && self.y < other.y + other.height
            && self.y + self.height > other.y
    }
}

pub(crate) fn snapshot_key(ctx: &BackendRequestContext, tab_id: &str) -> String {
    format!("{}:{tab_id}", ctx.session_id.as_deref().unwrap_or_default())
}

pub(crate) fn backend_node_id(node_id: &str) -> Result<i64> {
    node_id.parse::<i64>().map_err(|_| {
        HostError::Protocol(format!(
            "DOM-CUA node_id must be a backendNodeId integer: {node_id}"
        ))
    })
}

pub(crate) fn viewport_rect_from_layout_metrics(metrics: &Value) -> Result<Rect> {
    let viewport = metrics
        .get("visualViewport")
        .or_else(|| metrics.get("layoutViewport"))
        .ok_or_else(|| HostError::Protocol("Page.getLayoutMetrics missing viewport".into()))?;
    Ok(Rect {
        x: viewport
            .get("pageX")
            .or_else(|| viewport.get("x"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        y: viewport
            .get("pageY")
            .or_else(|| viewport.get("y"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        width: viewport
            .get("clientWidth")
            .or_else(|| viewport.get("width"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        height: viewport
            .get("clientHeight")
            .or_else(|| viewport.get("height"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
    })
}

pub(crate) fn rect_from_box_model(result: &Value) -> Option<Rect> {
    let content = result
        .get("model")
        .and_then(|model| model.get("content"))
        .and_then(Value::as_array)?;
    if content.len() < 8 {
        return None;
    }
    let points = content.iter().filter_map(Value::as_f64).collect::<Vec<_>>();
    if points.len() < 8 {
        return None;
    }
    let xs = [points[0], points[2], points[4], points[6]];
    let ys = [points[1], points[3], points[5], points[7]];
    let min_x = xs.iter().copied().fold(f64::INFINITY, f64::min);
    let max_x = xs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let min_y = ys.iter().copied().fold(f64::INFINITY, f64::min);
    let max_y = ys.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    Some(Rect {
        x: min_x,
        y: min_y,
        width: max_x - min_x,
        height: max_y - min_y,
    })
}

pub(crate) fn attributes_object(node: &Value) -> Value {
    let Some(attributes) = node.get("attributes").and_then(Value::as_array) else {
        return Value::Object(Map::new());
    };
    let mut pairs = BTreeMap::new();
    for pair in attributes.chunks(2) {
        if let Some(key) = pair.first().and_then(Value::as_str) {
            pairs.insert(
                key.to_string(),
                pair.get(1).cloned().unwrap_or(Value::String(String::new())),
            );
        }
    }
    let mut object = Map::new();
    for (key, value) in pairs {
        object.insert(key, value);
    }
    Value::Object(object)
}

pub(crate) fn is_hidden_subtree(node: &Value) -> bool {
    if is_obu_overlay_node(node) {
        return true;
    }
    let tag = node_tag(node);
    let attrs = attributes_object(node);
    if attrs.get("hidden").is_some() {
        return true;
    }
    if attrs
        .get("aria-hidden")
        .and_then(Value::as_str)
        .is_some_and(|value| value.eq_ignore_ascii_case("true"))
    {
        return true;
    }
    if tag == "input"
        && attrs
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|value| value.eq_ignore_ascii_case("hidden"))
    {
        return true;
    }
    attrs
        .get("style")
        .and_then(Value::as_str)
        .map(normalize_ws)
        .is_some_and(|style| {
            let style = style.to_ascii_lowercase().replace(' ', "");
            style.contains("display:none") || style.contains("visibility:hidden")
        })
}

pub(crate) fn is_interesting_node(node: &Value) -> bool {
    let tag = node_tag(node);
    let attrs = attributes_object(node);
    matches!(
        tag.as_str(),
        "a" | "button"
            | "input"
            | "select"
            | "textarea"
            | "summary"
            | "option"
            | "label"
            | "img"
            | "video"
            | "audio"
    ) || attrs.get("role").is_some()
        || attrs.get("aria-label").is_some()
        || attrs.get("onclick").is_some()
        || attrs.get("tabindex").is_some()
        || attrs.get("contenteditable").is_some()
}

pub(crate) fn snapshot_entry(node: &Value, backend_node_id: i64, rect: Rect) -> Option<Value> {
    if !is_interesting_node(node) || is_hidden_subtree(node) {
        return None;
    }
    let attrs = attributes_object(node);
    let tag = node_tag(node);
    let text = aggregate_text(node, 240);
    let name = attrs
        .get("aria-label")
        .or_else(|| attrs.get("alt"))
        .or_else(|| attrs.get("title"))
        .and_then(Value::as_str)
        .map(normalize_ws)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| text.clone());
    Some(json!({
        "node_id": backend_node_id.to_string(),
        "tag": tag,
        "role": attrs.get("role").and_then(Value::as_str).unwrap_or_default(),
        "name": name,
        "text": text,
        "bounds": {
            "x": rect.x,
            "y": rect.y,
            "width": rect.width,
            "height": rect.height,
        },
        "attributes": attrs,
    }))
}

pub(crate) fn render_visible_dom_text(nodes: &[Value]) -> String {
    let mut lines = Vec::new();
    for node in nodes {
        let node_id = node.get("node_id").and_then(Value::as_str).unwrap_or("?");
        let tag = node.get("tag").and_then(Value::as_str).unwrap_or("node");
        let attrs = node
            .get("attributes")
            .and_then(Value::as_object)
            .map(|attrs| {
                let mut pairs = attrs
                    .iter()
                    .filter_map(|(key, value)| value.as_str().map(|value| (key, value)))
                    .collect::<Vec<_>>();
                pairs.sort_by(|left, right| left.0.cmp(right.0));
                pairs
                    .into_iter()
                    .map(|(key, value)| format!(r#"{key}="{}""#, escape_text(value, 80)))
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .filter(|attrs| !attrs.is_empty())
            .map(|attrs| format!(" {attrs}"))
            .unwrap_or_default();
        let name = node.get("name").and_then(Value::as_str).unwrap_or_default();
        let text = node.get("text").and_then(Value::as_str).unwrap_or_default();
        let label = if !name.is_empty() { name } else { text };
        let suffix = if label.is_empty() {
            String::new()
        } else {
            format!(" {}", escape_text(label, 180))
        };
        lines.push(format!("[{node_id}] <{tag}{attrs}>{suffix}"));
    }
    lines.join("\n")
}

pub(crate) fn aggregate_text(node: &Value, max_len: usize) -> String {
    let mut out = String::new();
    append_text(node, &mut out, max_len);
    normalize_ws(&out).chars().take(max_len).collect::<String>()
}

pub(crate) fn is_obu_overlay_node(node: &Value) -> bool {
    let Some(attributes) = node.get("attributes").and_then(Value::as_array) else {
        return false;
    };
    for pair in attributes.chunks(2) {
        let Some(key) = pair.first().and_then(Value::as_str) else {
            continue;
        };
        let value = pair.get(1).and_then(Value::as_str).unwrap_or_default();
        if key == "id" && value == OBU_OVERLAY_ROOT_ID {
            return true;
        }
        if key == "data-obu-overlay-root" {
            return true;
        }
    }
    false
}

pub(crate) fn snapshot_node_ids(nodes: &[Value]) -> HashSet<String> {
    nodes
        .iter()
        .filter_map(|node| node.get("node_id").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

fn append_text(node: &Value, out: &mut String, max_len: usize) {
    if out.len() >= max_len || is_hidden_subtree(node) {
        return;
    }
    if node
        .get("nodeName")
        .and_then(Value::as_str)
        .is_some_and(|name| name == "#text")
        && let Some(value) = node.get("nodeValue").and_then(Value::as_str)
    {
        out.push(' ');
        out.push_str(value);
    }
    for key in ["children", "shadowRoots", "contentDocument"] {
        if let Some(children) = node.get(key).and_then(Value::as_array) {
            for child in children {
                append_text(child, out, max_len);
            }
        } else if let Some(child) = node.get(key) {
            append_text(child, out, max_len);
        }
    }
}

fn node_tag(node: &Value) -> String {
    node.get("nodeName")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn normalize_ws(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn escape_text(value: &str, max_len: usize) -> String {
    normalize_ws(value)
        .chars()
        .take(max_len)
        .collect::<String>()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn rect_from_box_model_uses_content_bounds() {
        let result = json!({
            "model": {
                "content": [10, 20, 30, 18, 32, 50, 8, 51]
            }
        });
        let rect = rect_from_box_model(&result).expect("rect");
        assert_eq!(rect.x, 8.0);
        assert_eq!(rect.y, 18.0);
        assert_eq!(rect.width, 24.0);
        assert_eq!(rect.height, 33.0);
        assert_eq!(rect.center(), (20.0, 34.5));
    }

    #[test]
    fn attributes_object_pairs_cdp_attribute_list() {
        let result = attributes_object(&json!({
            "attributes": ["role", "button", "id", "submit", "disabled"]
        }));
        assert_eq!(
            result,
            json!({
                "disabled": "",
                "id": "submit",
                "role": "button"
            })
        );
    }

    #[test]
    fn hidden_and_overlay_nodes_are_skipped() {
        assert!(is_hidden_subtree(
            &json!({ "nodeName": "DIV", "attributes": ["hidden", ""] })
        ));
        assert!(is_hidden_subtree(
            &json!({ "nodeName": "DIV", "attributes": ["aria-hidden", "true"] })
        ));
        assert!(is_hidden_subtree(
            &json!({ "nodeName": "INPUT", "attributes": ["type", "hidden"] })
        ));
        assert!(is_hidden_subtree(
            &json!({ "nodeName": "DIV", "attributes": ["style", "display: none"] })
        ));
        assert!(is_hidden_subtree(
            &json!({ "nodeName": "DIV", "attributes": ["id", OBU_OVERLAY_ROOT_ID] })
        ));
        assert!(!is_hidden_subtree(
            &json!({ "nodeName": "BUTTON", "attributes": ["aria-label", "Save"] })
        ));
    }

    #[test]
    fn snapshot_entry_filters_to_interesting_nodes_and_aggregates_text() {
        let rect = Rect {
            x: 1.0,
            y: 2.0,
            width: 3.0,
            height: 4.0,
        };
        assert!(
            snapshot_entry(&json!({ "nodeName": "DIV", "backendNodeId": 1 }), 1, rect).is_none()
        );
        let button = snapshot_entry(
            &json!({
                "nodeName": "BUTTON",
                "backendNodeId": 2,
                "attributes": ["data-z", "last", "aria-label", "Save now", "role", "button"],
                "children": [
                    { "nodeName": "#text", "nodeValue": "  ignored by aria label " },
                    { "nodeName": "SPAN", "children": [{ "nodeName": "#text", "nodeValue": " nested text " }] }
                ]
            }),
            2,
            rect,
        )
        .expect("button entry");
        assert_eq!(button["node_id"], "2");
        assert_eq!(button["name"], "Save now");
        assert_eq!(button["text"], "ignored by aria label nested text");
        assert_eq!(
            button["attributes"],
            json!({ "aria-label": "Save now", "data-z": "last", "role": "button" })
        );
    }

    #[test]
    fn aggregate_text_traverses_shadow_dom_and_same_origin_iframe_content() {
        let text = aggregate_text(
            &json!({
                "nodeName": "DIV",
                "children": [{ "nodeName": "#text", "nodeValue": " light " }],
                "shadowRoots": [{
                    "nodeName": "SHADOWROOT",
                    "children": [{ "nodeName": "#text", "nodeValue": " shadow " }]
                }],
                "contentDocument": {
                    "nodeName": "HTML",
                    "children": [{ "nodeName": "#text", "nodeValue": " frame " }]
                }
            }),
            80,
        );
        assert_eq!(text, "light shadow frame");
    }

    #[test]
    fn render_visible_dom_text_is_stable_and_readable() {
        let text = render_visible_dom_text(&[json!({
            "node_id": "2",
            "tag": "button",
            "name": "Save now",
            "text": "Save now",
            "attributes": { "role": "button", "aria-label": "Save now" }
        })]);
        assert_eq!(
            text,
            r#"[2] <button aria-label="Save now" role="button"> Save now"#
        );
    }

    #[test]
    fn backend_node_id_requires_integer_strings() {
        assert_eq!(backend_node_id("42").expect("node id"), 42);
        let message = backend_node_id("node-42").unwrap_err().to_string();
        assert!(message.contains("backendNodeId integer: node-42"));
    }

    #[test]
    fn is_obu_overlay_node_detects_stable_marker() {
        assert!(is_obu_overlay_node(&json!({
            "attributes": ["id", OBU_OVERLAY_ROOT_ID]
        })));
        assert!(is_obu_overlay_node(&json!({
            "attributes": ["data-obu-overlay-root", "true"]
        })));
        assert!(!is_obu_overlay_node(&json!({
            "attributes": ["id", "app"]
        })));
    }
}

//! Shared DOM-CUA snapshot and geometry helpers.

use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::backends::BackendRequestContext;
use crate::error::{HostError, Result};

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
    let mut object = Map::new();
    for pair in attributes.chunks(2) {
        if let Some(key) = pair.first().and_then(Value::as_str) {
            object.insert(
                key.to_string(),
                pair.get(1).cloned().unwrap_or(Value::String(String::new())),
            );
        }
    }
    Value::Object(object)
}

pub(crate) fn snapshot_node_ids(nodes: &[Value]) -> HashSet<String> {
    nodes
        .iter()
        .filter_map(|node| node.get("node_id").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
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
            "attributes": ["id", "submit", "disabled"]
        }));
        assert_eq!(
            result,
            json!({
                "id": "submit",
                "disabled": ""
            })
        );
    }

    #[test]
    fn backend_node_id_requires_integer_strings() {
        assert_eq!(backend_node_id("42").expect("node id"), 42);
        let message = backend_node_id("node-42").unwrap_err().to_string();
        assert!(message.contains("backendNodeId integer: node-42"));
    }
}

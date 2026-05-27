//! Shared DOM-CUA snapshot and geometry helpers.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use crate::backends::BackendRequestContext;
use crate::error::{HostError, Result};

pub(crate) const OBU_OVERLAY_ROOT_ID: &str = "obu-agent-overlay-root";
pub(crate) const VISIBLE_DOM_SNAPSHOT_TTL: Duration = Duration::from_secs(60);
pub(crate) const VISIBLE_DOM_SNAPSHOT_MAX_ENTRIES: usize = 128;

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

    pub(crate) fn is_finite_and_positive(self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && self.width.is_finite()
            && self.height.is_finite()
            && self.width > 0.0
            && self.height > 0.0
    }
}

pub(crate) fn snapshot_key(ctx: &BackendRequestContext, tab_id: &str) -> String {
    format!("{}:{tab_id}", ctx.session_id.as_deref().unwrap_or_default())
}

#[derive(Debug, Clone)]
struct VisibleDomSnapshotRecord {
    node_ids: HashSet<String>,
    node_sessions: HashMap<String, String>,
    created_at: Instant,
    last_used_at: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct VisibleDomSnapshotKey {
    session_id: String,
    tab_id: String,
    observation_id: Option<String>,
}

impl VisibleDomSnapshotKey {
    fn new(ctx: &BackendRequestContext, tab_id: &str, observation_id: Option<&str>) -> Self {
        Self {
            session_id: ctx.session_id.as_deref().unwrap_or_default().to_string(),
            tab_id: tab_id.to_string(),
            observation_id: observation_id
                .filter(|value| !value.is_empty())
                .map(str::to_string),
        }
    }

    fn matches_tab(&self, ctx: &BackendRequestContext, tab_id: &str) -> bool {
        self.session_id == ctx.session_id.as_deref().unwrap_or_default() && self.tab_id == tab_id
    }

    fn matches_tab_id(&self, tab_id: &str) -> bool {
        self.tab_id == tab_id
    }
}

#[derive(Debug)]
pub(crate) struct VisibleDomSnapshotStore {
    entries: HashMap<VisibleDomSnapshotKey, VisibleDomSnapshotRecord>,
    ttl: Duration,
    max_entries: usize,
}

impl Default for VisibleDomSnapshotStore {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            ttl: VISIBLE_DOM_SNAPSHOT_TTL,
            max_entries: VISIBLE_DOM_SNAPSHOT_MAX_ENTRIES,
        }
    }
}

impl VisibleDomSnapshotStore {
    pub(crate) fn remember(
        &mut self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        observation_id: Option<&str>,
        nodes: &[Value],
    ) {
        let now = Instant::now();
        self.prune_expired(now);
        let node_sessions = nodes
            .iter()
            .filter_map(|node| {
                let id = node.get("node_id").and_then(Value::as_str)?;
                let session = node.get("session_id").and_then(Value::as_str)?;
                Some((id.to_string(), session.to_string()))
            })
            .collect();
        self.entries.insert(
            VisibleDomSnapshotKey::new(ctx, tab_id, observation_id),
            VisibleDomSnapshotRecord {
                node_ids: snapshot_node_ids(nodes),
                node_sessions,
                created_at: now,
                last_used_at: now,
            },
        );
        self.prune_overflow();
    }

    pub(crate) fn validate_node(
        &mut self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        observation_id: Option<&str>,
        node_id: &str,
    ) -> Result<()> {
        let now = Instant::now();
        self.prune_expired(now);
        let key = VisibleDomSnapshotKey::new(ctx, tab_id, observation_id);
        let Some(record) = self.entries.get_mut(&key) else {
            return Err(HostError::Protocol(
                "DOM-CUA node_id requires a current visible DOM snapshot".into(),
            ));
        };
        record.last_used_at = now;
        if !record.node_ids.contains(node_id) {
            return Err(HostError::Protocol(format!(
                "DOM-CUA node_id was not returned by the current visible DOM snapshot: {node_id}"
            )));
        }
        Ok(())
    }

    pub(crate) fn session_for_node(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        observation_id: Option<&str>,
        node_id: &str,
    ) -> Option<String> {
        let key = VisibleDomSnapshotKey::new(ctx, tab_id, observation_id);
        self.entries.get(&key)?.node_sessions.get(node_id).cloned()
    }

    pub(crate) fn forget_snapshot(
        &mut self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        observation_id: Option<&str>,
    ) {
        self.entries
            .remove(&VisibleDomSnapshotKey::new(ctx, tab_id, observation_id));
    }

    pub(crate) fn forget_tab(&mut self, ctx: &BackendRequestContext, tab_id: &str) {
        self.entries
            .retain(|candidate, _| !candidate.matches_tab(ctx, tab_id));
    }

    pub(crate) fn forget_tab_for_any_session(&mut self, tab_id: &str) {
        self.entries
            .retain(|candidate, _| !candidate.matches_tab_id(tab_id));
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    fn prune_expired(&mut self, now: Instant) {
        let ttl = self.ttl;
        self.entries
            .retain(|_, record| now.duration_since(record.created_at) <= ttl);
    }

    fn prune_overflow(&mut self) {
        while self.entries.len() > self.max_entries {
            let Some(oldest_key) = self
                .entries
                .iter()
                .min_by_key(|(_, record)| record.last_used_at)
                .map(|(key, _)| key.clone())
            else {
                return;
            };
            self.entries.remove(&oldest_key);
        }
    }
}

pub(crate) fn backend_node_id(node_id: &str) -> Result<i64> {
    node_id.parse::<i64>().map_err(|_| {
        HostError::Protocol(format!(
            "DOM-CUA node_id must be a backendNodeId integer: {node_id}"
        ))
    })
}

fn layout_metrics_viewport(metrics: &Value) -> Result<&Value> {
    metrics
        .get("cssVisualViewport")
        .or_else(|| metrics.get("visualViewport"))
        .or_else(|| metrics.get("layoutViewport"))
        .ok_or_else(|| HostError::Protocol("Page.getLayoutMetrics missing viewport".into()))
}

pub(crate) fn visible_page_rect_from_layout_metrics(metrics: &Value) -> Result<Rect> {
    let viewport = layout_metrics_viewport(metrics)?;
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

pub(crate) fn viewport_rect_from_layout_metrics(metrics: &Value) -> Result<Rect> {
    visible_page_rect_from_layout_metrics(metrics)
}

pub(crate) fn visual_viewport_input_center(metrics: &Value) -> Result<(f64, f64)> {
    let viewport = metrics
        .get("cssVisualViewport")
        .or_else(|| metrics.get("visualViewport"))
        .or_else(|| metrics.get("layoutViewport"))
        .ok_or_else(|| HostError::Protocol("Page.getLayoutMetrics missing viewport".into()))?;
    let width = viewport
        .get("clientWidth")
        .or_else(|| viewport.get("width"))
        .and_then(Value::as_f64)
        .ok_or_else(|| {
            HostError::Protocol("Page.getLayoutMetrics viewport missing width".into())
        })?;
    let height = viewport
        .get("clientHeight")
        .or_else(|| viewport.get("height"))
        .and_then(Value::as_f64)
        .ok_or_else(|| {
            HostError::Protocol("Page.getLayoutMetrics viewport missing height".into())
        })?;
    Ok((width / 2.0, height / 2.0))
}

pub(crate) fn rect_from_box_model(result: &Value) -> Option<Rect> {
    rect_from_box_model_quad(result, "content")
        .or_else(|| rect_from_box_model_quad(result, "border"))
}

pub(crate) fn action_point_from_content_quads(
    result: &Value,
    viewport: Rect,
) -> Option<(f64, f64)> {
    let quads = result.get("quads").and_then(Value::as_array)?;
    quads
        .iter()
        .filter_map(|quad| point_from_quad(quad, Some(viewport)))
        .max_by(|left, right| {
            left.visible_area
                .partial_cmp(&right.visible_area)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|point| page_point_to_viewport(point.center, viewport))
}

pub(crate) fn action_point_from_box_model(result: &Value, viewport: Rect) -> Option<(f64, f64)> {
    let rect = rect_from_box_model(result)?;
    if !rect.is_finite_and_positive() || !rect.intersects(viewport) {
        return None;
    }
    Some(page_point_to_viewport(rect.center(), viewport))
}

fn page_point_to_viewport(point: (f64, f64), viewport: Rect) -> (f64, f64) {
    (point.0 - viewport.x, point.1 - viewport.y)
}

fn rect_from_box_model_quad(result: &Value, key: &str) -> Option<Rect> {
    let content = result
        .get("model")
        .and_then(|model| model.get(key))
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
    let rect = Rect {
        x: min_x,
        y: min_y,
        width: max_x - min_x,
        height: max_y - min_y,
    };
    rect.is_finite_and_positive().then_some(rect)
}

#[derive(Debug, Clone, Copy)]
struct QuadPoint {
    center: (f64, f64),
    visible_area: f64,
}

fn point_from_quad(quad: &Value, viewport: Option<Rect>) -> Option<QuadPoint> {
    let points = quad
        .as_array()?
        .iter()
        .filter_map(Value::as_f64)
        .collect::<Vec<_>>();
    if points.len() < 8 || !points.iter().all(|point| point.is_finite()) {
        return None;
    }
    let xs = [points[0], points[2], points[4], points[6]];
    let ys = [points[1], points[3], points[5], points[7]];
    let center = (
        xs.iter().copied().sum::<f64>() / 4.0,
        ys.iter().copied().sum::<f64>() / 4.0,
    );
    let rect = Rect {
        x: xs.iter().copied().fold(f64::INFINITY, f64::min),
        y: ys.iter().copied().fold(f64::INFINITY, f64::min),
        width: xs.iter().copied().fold(f64::NEG_INFINITY, f64::max)
            - xs.iter().copied().fold(f64::INFINITY, f64::min),
        height: ys.iter().copied().fold(f64::NEG_INFINITY, f64::max)
            - ys.iter().copied().fold(f64::INFINITY, f64::min),
    };
    if !rect.is_finite_and_positive() {
        return None;
    }
    let visible_area = viewport.map_or(rect.width * rect.height, |viewport| {
        intersection_area(rect, viewport)
    });
    if visible_area <= 0.0 {
        return None;
    }
    Some(QuadPoint {
        center: clamp_point_to_viewport(center, viewport),
        visible_area,
    })
}

fn intersection_area(rect: Rect, viewport: Rect) -> f64 {
    let left = rect.x.max(viewport.x);
    let right = (rect.x + rect.width).min(viewport.x + viewport.width);
    let top = rect.y.max(viewport.y);
    let bottom = (rect.y + rect.height).min(viewport.y + viewport.height);
    ((right - left).max(0.0)) * ((bottom - top).max(0.0))
}

fn clamp_point_to_viewport(point: (f64, f64), viewport: Option<Rect>) -> (f64, f64) {
    let Some(viewport) = viewport else {
        return point;
    };
    (
        point.0.clamp(viewport.x, viewport.x + viewport.width),
        point.1.clamp(viewport.y, viewport.y + viewport.height),
    )
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

pub(crate) fn render_visible_dom_debug_text(nodes: &[Value]) -> String {
    render_visible_dom_text(nodes)
}

pub(crate) fn render_visible_dom_compact_text(nodes: &[Value]) -> String {
    let mut lines = Vec::new();
    for node in nodes {
        let node_id = node.get("node_id").and_then(Value::as_str).unwrap_or("?");
        let tag = node.get("tag").and_then(Value::as_str).unwrap_or("node");
        let mut attrs = vec![format!("node_id={node_id}")];
        if let Some(object) = node.get("attributes").and_then(Value::as_object) {
            for key in [
                "aria-label",
                "contenteditable",
                "href",
                "name",
                "placeholder",
                "role",
                "title",
                "type",
                "value",
            ] {
                if let Some(value) = object.get(key).and_then(Value::as_str)
                    && !value.is_empty()
                {
                    attrs.push(format!(r#"{key}="{}""#, escape_text(value, 80)));
                }
            }
            for key in [
                "checked", "disabled", "multiple", "readonly", "required", "selected",
            ] {
                if object.contains_key(key) {
                    attrs.push(key.to_string());
                }
            }
        }
        let text = node
            .get("name")
            .or_else(|| node.get("text"))
            .and_then(Value::as_str)
            .map(|value| escape_text(value, 180))
            .unwrap_or_default();
        lines.push(format!("<{tag} {}>{text}</{tag}>", attrs.join(" ")));
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

/// Elements whose text is source/non-rendered content (CSS, JS, <noscript>
/// fallbacks, inert <template> bodies) and must never leak into an accessible
/// label or snapshotText aggregate.
fn is_non_content_tag(node: &Value) -> bool {
    matches!(
        node_tag(node).as_str(),
        "style" | "script" | "noscript" | "template"
    )
}

fn append_text(node: &Value, out: &mut String, max_len: usize) {
    if out.len() >= max_len || is_hidden_subtree(node) {
        return;
    }
    // Skip non-content elements: their text is source/non-rendered content
    // (CSS, JS, <noscript> fallbacks, inert <template> bodies) that must never
    // leak into an element's accessible label — e.g. a styled <button> that
    // inlines a <style> would otherwise surface the stylesheet in snapshotText().
    if is_non_content_tag(node) {
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

    use crate::backends::BackendRequestContext;

    use super::*;

    #[test]
    fn aggregate_text_excludes_non_content_element_subtrees() {
        // A styled button (web-component pattern) that inlines a <style> and a
        // <script>, plus <noscript>/<template> fallbacks. Their text is source
        // code / non-rendered content and must never leak into the label.
        let node = json!({
            "nodeName": "BUTTON",
            "children": [
                { "nodeName": "STYLE", "children": [
                    { "nodeName": "#text", "nodeValue": ".cart-btn{color:red;background:url(x)}" }
                ]},
                { "nodeName": "#text", "nodeValue": "Add to cart" },
                { "nodeName": "SCRIPT", "children": [
                    { "nodeName": "#text", "nodeValue": "track('click')" }
                ]},
                { "nodeName": "NOSCRIPT", "children": [
                    { "nodeName": "#text", "nodeValue": "enable javascript" }
                ]},
                { "nodeName": "TEMPLATE", "children": [
                    { "nodeName": "#text", "nodeValue": "hidden template text" }
                ]}
            ]
        });
        assert_eq!(aggregate_text(&node, 240), "Add to cart");
    }

    #[test]
    fn non_content_tags_are_filtered() {
        assert!(is_non_content_tag(&json!({ "nodeName": "STYLE" })));
        assert!(is_non_content_tag(&json!({ "nodeName": "script" })));
        assert!(!is_non_content_tag(&json!({ "nodeName": "BUTTON" })));
    }

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
    fn rect_from_box_model_falls_back_to_border_bounds() {
        let result = json!({
            "model": {
                "border": [1, 2, 11, 2, 11, 22, 1, 22]
            }
        });
        let rect = rect_from_box_model(&result).expect("rect");
        assert_eq!(rect.x, 1.0);
        assert_eq!(rect.y, 2.0);
        assert_eq!(rect.width, 10.0);
        assert_eq!(rect.height, 20.0);
    }

    #[test]
    fn action_point_from_content_quads_prefers_visible_quad() {
        let point = action_point_from_content_quads(
            &json!({
                "quads": [
                    [-100, -100, -90, -100, -90, -90, -100, -90],
                    [10, 20, 30, 20, 30, 40, 10, 40]
                ]
            }),
            Rect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
        )
        .expect("point");
        assert_eq!(point, (20.0, 30.0));
    }

    #[test]
    fn action_point_helpers_return_viewport_space_points() {
        let viewport = Rect {
            x: 0.0,
            y: 1000.0,
            width: 100.0,
            height: 100.0,
        };
        let point = action_point_from_content_quads(
            &json!({
                "quads": [
                    [10, 1020, 30, 1020, 30, 1040, 10, 1040]
                ]
            }),
            viewport,
        )
        .expect("point");
        assert_eq!(point, (20.0, 30.0));

        let box_point = action_point_from_box_model(
            &json!({ "model": { "content": [10, 1020, 30, 1020, 30, 1040, 10, 1040] } }),
            viewport,
        )
        .expect("box point");
        assert_eq!(box_point, (20.0, 30.0));
    }

    #[test]
    fn layout_metrics_helpers_keep_page_rect_and_input_center_separate() {
        let metrics = json!({
            "cssVisualViewport": {
                "pageX": 50,
                "pageY": 1000,
                "clientWidth": 800,
                "clientHeight": 600
            }
        });
        let page_rect = visible_page_rect_from_layout_metrics(&metrics).expect("page rect");
        assert_eq!(page_rect.x, 50.0);
        assert_eq!(page_rect.y, 1000.0);
        assert_eq!(page_rect.width, 800.0);
        assert_eq!(page_rect.height, 600.0);
        assert_eq!(
            visual_viewport_input_center(&metrics).expect("input center"),
            (400.0, 300.0)
        );
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
    fn snapshot_store_records_node_session() {
        let ctx = BackendRequestContext {
            session_id: Some("s".into()),
            turn_id: Some("t".into()),
            client_timeout_ms: None,
            trusted_kernel_generation: None,
        };
        let mut store = VisibleDomSnapshotStore::default();
        store.remember(
            &ctx,
            "tab:1",
            Some("obs"),
            &[json!({ "node_id": "10", "session_id": "OOPIF-A" })],
        );
        assert!(
            store
                .validate_node(&ctx, "tab:1", Some("obs"), "10")
                .is_ok()
        );
        assert_eq!(
            store
                .session_for_node(&ctx, "tab:1", Some("obs"), "10")
                .as_deref(),
            Some("OOPIF-A")
        );
        assert_eq!(
            store.session_for_node(&ctx, "tab:1", Some("obs"), "999"),
            None
        );
    }

    #[test]
    fn visible_dom_snapshot_store_scopes_consumes_and_prunes_entries() {
        let ctx = BackendRequestContext {
            session_id: Some("session:with:colon".into()),
            turn_id: Some("turn".into()),
            client_timeout_ms: None,
            trusted_kernel_generation: None,
        };
        let other_ctx = BackendRequestContext {
            session_id: Some("other:session".into()),
            turn_id: Some("turn".into()),
            client_timeout_ms: None,
            trusted_kernel_generation: None,
        };
        let mut store = VisibleDomSnapshotStore::default();
        let nodes = vec![json!({ "node_id": "101" })];

        store.remember(&ctx, "tab:42", Some("obs:1"), &nodes);
        store.remember(&other_ctx, "tab:42", Some("obs:1"), &nodes);
        store.remember(&ctx, "tab:43", Some("obs:1"), &nodes);
        assert!(
            store
                .validate_node(&ctx, "tab:42", Some("obs:1"), "101")
                .is_ok()
        );
        assert!(
            store
                .validate_node(&ctx, "tab:42", Some("obs:2"), "101")
                .unwrap_err()
                .to_string()
                .contains("current visible DOM snapshot")
        );
        assert!(
            store
                .validate_node(&other_ctx, "tab:42", Some("obs:1"), "101")
                .is_ok()
        );
        assert!(
            store
                .validate_node(&ctx, "tab:43", Some("obs:1"), "101")
                .is_ok()
        );

        store.forget_snapshot(&ctx, "tab:42", Some("obs:1"));
        assert!(
            store
                .validate_node(&ctx, "tab:42", Some("obs:1"), "101")
                .unwrap_err()
                .to_string()
                .contains("current visible DOM snapshot")
        );
        assert!(
            store
                .validate_node(&other_ctx, "tab:42", Some("obs:1"), "101")
                .is_ok()
        );

        store.remember(&ctx, "tab:42", Some("obs:3"), &nodes);
        store.forget_tab(&ctx, "tab:42");
        assert!(
            store
                .validate_node(&ctx, "tab:42", Some("obs:3"), "101")
                .unwrap_err()
                .to_string()
                .contains("current visible DOM snapshot")
        );
        assert!(
            store
                .validate_node(&other_ctx, "tab:42", Some("obs:1"), "101")
                .is_ok()
        );
        assert!(
            store
                .validate_node(&ctx, "tab:43", Some("obs:1"), "101")
                .is_ok()
        );

        store.forget_tab_for_any_session("tab:42");
        assert!(
            store
                .validate_node(&other_ctx, "tab:42", Some("obs:1"), "101")
                .unwrap_err()
                .to_string()
                .contains("current visible DOM snapshot")
        );

        let mut store = VisibleDomSnapshotStore::default();
        for index in 0..(VISIBLE_DOM_SNAPSHOT_MAX_ENTRIES + 5) {
            store.remember(
                &ctx,
                "tab:42",
                Some(&format!("obs-{index}")),
                &[json!({ "node_id": format!("{index}") })],
            );
        }
        assert_eq!(store.len(), VISIBLE_DOM_SNAPSHOT_MAX_ENTRIES);
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
    fn render_visible_dom_debug_text_keeps_verbose_attribute_shape() {
        let text = render_visible_dom_debug_text(&[json!({
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
    fn render_visible_dom_compact_text_uses_element_like_rows() {
        let text = render_visible_dom_compact_text(&[json!({
            "node_id": "2",
            "tag": "button",
            "name": "Save now",
            "text": "Save now",
            "attributes": { "role": "button", "aria-label": "Save now" }
        })]);
        assert_eq!(
            text,
            r#"<button node_id=2 aria-label="Save now" role="button">Save now</button>"#
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

//! Point-level element inspection helpers.

use async_trait::async_trait;
use serde_json::{Value, json};

use crate::backends::BackendRequestContext;
use crate::error::{HostError, Result};
use crate::ops::{
    content_export::{self, ContentExportBackend},
    dom_cua::{self, Rect},
};

#[async_trait]
pub(crate) trait PointCdpBackend: ContentExportBackend + Sync {
    async fn execute_point_cdp(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value>;
}

pub(crate) async fn element_info<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value>
where
    B: PointCdpBackend,
{
    let tab_id = required_str(&params, "tab_id")?;
    let x = required_f64(&params, "x")?;
    let y = required_f64(&params, "y")?;
    let include_non_interactable = params
        .get("includeNonInteractable")
        .or_else(|| params.get("include_non_interactable"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let Some(info) =
        element_info_at_point(backend, ctx, tab_id, x, y, include_non_interactable).await?
    else {
        return Ok(Value::Null);
    };
    Ok(info)
}

pub(crate) async fn element_screenshot<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value>
where
    B: PointCdpBackend,
{
    let tab_id = required_str(&params, "tab_id")?;
    let x = required_f64(&params, "x")?;
    let y = required_f64(&params, "y")?;
    let include_non_interactable = params
        .get("includeNonInteractable")
        .or_else(|| params.get("include_non_interactable"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let info = element_info_at_point(backend, ctx, tab_id, x, y, include_non_interactable)
        .await?
        .ok_or_else(|| HostError::Protocol("no element at point".into()))?;
    let bounds = info
        .get("bounds")
        .and_then(rect_from_value)
        .ok_or_else(|| HostError::Protocol("element at point has no screenshot bounds".into()))?;
    let viewport = viewport_rect(backend, ctx, tab_id).await?;
    let clip = intersect(bounds, viewport)
        .filter(|rect| rect.is_finite_and_positive())
        .ok_or_else(|| HostError::Protocol("element bounds are outside the viewport".into()))?;
    content_export::screenshot_with_params(
        backend,
        ctx,
        json!({
            "tab_id": tab_id,
            "type": "png",
            "fullPage": false,
            "clip": {
                "x": clip.x,
                "y": clip.y,
                "width": clip.width,
                "height": clip.height,
                "scale": 1.0,
            }
        }),
    )
    .await
}

async fn element_info_at_point<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    tab_id: &str,
    x: f64,
    y: f64,
    include_non_interactable: bool,
) -> Result<Option<Value>>
where
    B: PointCdpBackend,
{
    let node_for_location = backend
        .execute_point_cdp(
            ctx,
            tab_id,
            "DOM.getNodeForLocation",
            json!({
                "x": x,
                "y": y,
                "includeUserAgentShadowDOM": true,
                "ignorePointerEventsNone": include_non_interactable,
            }),
        )
        .await?;
    let Some(backend_node_id) = node_for_location
        .get("backendNodeId")
        .and_then(Value::as_i64)
    else {
        return Ok(None);
    };
    let described = backend
        .execute_point_cdp(
            ctx,
            tab_id,
            "DOM.describeNode",
            json!({
                "backendNodeId": backend_node_id,
                "depth": 0,
                "pierce": true,
            }),
        )
        .await?;
    let node = described
        .get("node")
        .ok_or_else(|| HostError::Protocol("DOM.describeNode missing node".into()))?;
    let attributes = dom_cua::attributes_object(node);
    if !include_non_interactable && is_non_interactable(node, &attributes) {
        return Ok(None);
    }
    let bounds = element_bounds(backend, ctx, tab_id, backend_node_id).await?;
    Ok(Some(json!({
        "node_id": backend_node_id.to_string(),
        "backendNodeId": backend_node_id,
        "nodeId": node_for_location.get("nodeId").and_then(Value::as_i64),
        "nodeName": node.get("nodeName").and_then(Value::as_str).unwrap_or_default(),
        "localName": node.get("localName").and_then(Value::as_str).unwrap_or_default(),
        "nodeType": node.get("nodeType").and_then(Value::as_i64),
        "attributes": attributes,
        "bounds": bounds.map(|rect| json!({
            "x": rect.x,
            "y": rect.y,
            "width": rect.width,
            "height": rect.height,
        })),
        "point": { "x": x, "y": y },
    })))
}

async fn element_bounds<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    tab_id: &str,
    backend_node_id: i64,
) -> Result<Option<Rect>>
where
    B: PointCdpBackend,
{
    let viewport = viewport_rect(backend, ctx, tab_id).await?;
    if let Ok(quads) = backend
        .execute_point_cdp(
            ctx,
            tab_id,
            "DOM.getContentQuads",
            json!({ "backendNodeId": backend_node_id }),
        )
        .await
        && let Some(rect) = rect_from_visible_quads(&quads, viewport)
    {
        return Ok(Some(rect));
    }
    let model = backend
        .execute_point_cdp(
            ctx,
            tab_id,
            "DOM.getBoxModel",
            json!({ "backendNodeId": backend_node_id }),
        )
        .await?;
    Ok(dom_cua::rect_from_box_model(&model))
}

fn rect_from_visible_quads(result: &Value, viewport: Rect) -> Option<Rect> {
    let quads = result.get("quads").and_then(Value::as_array)?;
    quads
        .iter()
        .filter_map(rect_from_quad)
        .filter_map(|rect| {
            let visible = intersect(rect, viewport)?;
            Some((rect, visible.width * visible.height))
        })
        .max_by(|left, right| {
            left.1
                .partial_cmp(&right.1)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(rect, _)| rect)
}

#[cfg(test)]
fn rect_from_quads(result: &Value, point: (f64, f64)) -> Option<Rect> {
    let quads = result.get("quads").and_then(Value::as_array)?;
    let mut best = None;
    let mut best_distance = f64::INFINITY;
    for quad in quads {
        let values = quad
            .as_array()?
            .iter()
            .filter_map(Value::as_f64)
            .collect::<Vec<_>>();
        if values.len() < 8 || !values.iter().all(|value| value.is_finite()) {
            continue;
        }
        let xs = [values[0], values[2], values[4], values[6]];
        let ys = [values[1], values[3], values[5], values[7]];
        let center = (
            xs.iter().copied().sum::<f64>() / 4.0,
            ys.iter().copied().sum::<f64>() / 4.0,
        );
        let distance = (center.0 - point.0).abs() + (center.1 - point.1).abs();
        if distance < best_distance {
            best_distance = distance;
            let min_x = xs.iter().copied().fold(f64::INFINITY, f64::min);
            let max_x = xs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            let min_y = ys.iter().copied().fold(f64::INFINITY, f64::min);
            let max_y = ys.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            best = Some(Rect {
                x: min_x,
                y: min_y,
                width: max_x - min_x,
                height: max_y - min_y,
            });
        }
    }
    best.filter(|rect| rect.is_finite_and_positive())
}

fn rect_from_quad(quad: &Value) -> Option<Rect> {
    let values = quad
        .as_array()?
        .iter()
        .filter_map(Value::as_f64)
        .collect::<Vec<_>>();
    if values.len() < 8 || !values.iter().all(|value| value.is_finite()) {
        return None;
    }
    let xs = [values[0], values[2], values[4], values[6]];
    let ys = [values[1], values[3], values[5], values[7]];
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

async fn viewport_rect<B>(backend: &B, ctx: &BackendRequestContext, tab_id: &str) -> Result<Rect>
where
    B: PointCdpBackend,
{
    let metrics = backend
        .execute_point_cdp(ctx, tab_id, "Page.getLayoutMetrics", json!({}))
        .await?;
    dom_cua::viewport_rect_from_layout_metrics(&metrics)
}

fn is_non_interactable(node: &Value, attributes: &Value) -> bool {
    dom_cua::is_hidden_subtree(node)
        || attributes.get("disabled").is_some()
        || attributes
            .get("aria-disabled")
            .and_then(Value::as_str)
            .is_some_and(|value| value.eq_ignore_ascii_case("true"))
}

fn intersect(left: Rect, right: Rect) -> Option<Rect> {
    let x1 = left.x.max(right.x);
    let y1 = left.y.max(right.y);
    let x2 = (left.x + left.width).min(right.x + right.width);
    let y2 = (left.y + left.height).min(right.y + right.height);
    let rect = Rect {
        x: x1,
        y: y1,
        width: x2 - x1,
        height: y2 - y1,
    };
    rect.is_finite_and_positive().then_some(rect)
}

fn rect_from_value(value: &Value) -> Option<Rect> {
    Some(Rect {
        x: value.get("x").and_then(Value::as_f64)?,
        y: value.get("y").and_then(Value::as_f64)?,
        width: value.get("width").and_then(Value::as_f64)?,
        height: value.get("height").and_then(Value::as_f64)?,
    })
}

fn required_str<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::Protocol(format!("missing {key}")))
}

fn required_f64(params: &Value, key: &str) -> Result<f64> {
    params
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| HostError::Protocol(format!("missing {key}")))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use serde_json::json;

    use crate::ops::content_export::ContentExportBackend;

    use super::*;

    #[test]
    fn intersect_clips_to_viewport() {
        assert_eq!(
            intersect(
                Rect {
                    x: 90.0,
                    y: 80.0,
                    width: 30.0,
                    height: 40.0,
                },
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 100.0,
                    height: 100.0,
                },
            )
            .map(|rect| json!({ "x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height })),
            Some(json!({ "x": 90.0, "y": 80.0, "width": 10.0, "height": 20.0 }))
        );
    }

    #[test]
    fn rect_from_quads_chooses_quad_near_action_point() {
        let rect = rect_from_quads(
            &json!({
                "quads": [
                    [0, 0, 10, 0, 10, 10, 0, 10],
                    [20, 0, 40, 0, 40, 10, 20, 10]
                ]
            }),
            (30.0, 5.0),
        )
        .unwrap();
        assert_eq!(rect.x, 20.0);
        assert_eq!(rect.width, 20.0);
    }

    #[test]
    fn rect_from_visible_quads_prefers_largest_visible_area() {
        let rect = rect_from_visible_quads(
            &json!({
                "quads": [
                    [0, 900, 20, 900, 20, 920, 0, 920],
                    [10, 1020, 50, 1020, 50, 1060, 10, 1060]
                ]
            }),
            Rect {
                x: 0.0,
                y: 1000.0,
                width: 100.0,
                height: 100.0,
            },
        )
        .expect("rect");
        assert_eq!(rect.x, 10.0);
        assert_eq!(rect.y, 1020.0);
        assert_eq!(rect.width, 40.0);
        assert_eq!(rect.height, 40.0);
    }

    #[derive(Default)]
    struct FakePointBackend {
        calls: Mutex<Vec<(String, Value)>>,
        screenshots: Mutex<Vec<Value>>,
        node_for_location: Value,
        described_node: Value,
        content_quads: Option<Value>,
        content_quads_fails: bool,
        box_model: Value,
        layout_metrics: Value,
    }

    impl FakePointBackend {
        fn basic() -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                screenshots: Mutex::new(Vec::new()),
                node_for_location: json!({ "backendNodeId": 7, "nodeId": 11 }),
                described_node: json!({
                    "node": {
                        "nodeName": "BUTTON",
                        "localName": "button",
                        "nodeType": 1,
                        "attributes": ["aria-label", "Save"]
                    }
                }),
                content_quads: Some(json!({
                    "quads": [
                        [10, 1020, 50, 1020, 50, 1060, 10, 1060]
                    ]
                })),
                content_quads_fails: false,
                box_model: json!({
                    "model": {
                        "content": [100, 1100, 140, 1100, 140, 1140, 100, 1140]
                    }
                }),
                layout_metrics: json!({
                    "cssVisualViewport": {
                        "pageX": 0,
                        "pageY": 1000,
                        "clientWidth": 100,
                        "clientHeight": 100
                    }
                }),
            }
        }
    }

    #[async_trait]
    impl ContentExportBackend for FakePointBackend {
        async fn capture_screenshot_cdp(
            &self,
            _ctx: &BackendRequestContext,
            _tab_id: &str,
            cdp_params: Value,
        ) -> Result<Value> {
            self.screenshots.lock().unwrap().push(cdp_params);
            Ok(json!({ "data": "base64png" }))
        }

        async fn print_pdf_cdp(
            &self,
            _ctx: &BackendRequestContext,
            _tab_id: &str,
        ) -> Result<Value> {
            Ok(json!({ "data": "base64pdf" }))
        }

        async fn document_html(
            &self,
            _ctx: &BackendRequestContext,
            _tab_id: &str,
        ) -> Result<String> {
            Ok("<html></html>".into())
        }
    }

    #[async_trait]
    impl PointCdpBackend for FakePointBackend {
        async fn execute_point_cdp(
            &self,
            _ctx: &BackendRequestContext,
            _tab_id: &str,
            method: &str,
            params: Value,
        ) -> Result<Value> {
            self.calls
                .lock()
                .unwrap()
                .push((method.to_string(), params));
            match method {
                "DOM.getNodeForLocation" => Ok(self.node_for_location.clone()),
                "DOM.describeNode" => Ok(self.described_node.clone()),
                "DOM.getContentQuads" if self.content_quads_fails => {
                    Err(HostError::CdpFailure("content quads unavailable".into()))
                }
                "DOM.getContentQuads" => {
                    Ok(self.content_quads.clone().unwrap_or_else(|| json!({})))
                }
                "DOM.getBoxModel" => Ok(self.box_model.clone()),
                "Page.getLayoutMetrics" => Ok(self.layout_metrics.clone()),
                other => Err(HostError::Protocol(format!("unexpected method {other}"))),
            }
        }
    }

    fn ctx() -> BackendRequestContext {
        BackendRequestContext {
            session_id: Some("session".into()),
            turn_id: Some("turn".into()),
            client_timeout_ms: None,
            trusted_kernel_generation: None,
        }
    }

    #[tokio::test]
    async fn element_info_returns_null_and_screenshot_errors_when_no_element_exists() {
        let mut backend = FakePointBackend::basic();
        backend.node_for_location = json!({});

        assert_eq!(
            element_info(
                &backend,
                &ctx(),
                json!({ "tab_id": "42", "x": 10, "y": 20 })
            )
            .await
            .unwrap(),
            Value::Null
        );
        let error = element_screenshot(
            &backend,
            &ctx(),
            json!({ "tab_id": "42", "x": 10, "y": 20 }),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("no element at point"));
    }

    #[tokio::test]
    async fn element_info_filters_hidden_nodes_unless_requested() {
        let mut backend = FakePointBackend::basic();
        backend.described_node = json!({
            "node": {
                "nodeName": "BUTTON",
                "localName": "button",
                "nodeType": 1,
                "attributes": ["hidden", ""]
            }
        });

        assert_eq!(
            element_info(
                &backend,
                &ctx(),
                json!({ "tab_id": "42", "x": 10, "y": 20 })
            )
            .await
            .unwrap(),
            Value::Null
        );
        let included = element_info(
            &backend,
            &ctx(),
            json!({ "tab_id": "42", "x": 10, "y": 20, "includeNonInteractable": true }),
        )
        .await
        .unwrap();
        assert_eq!(included["node_id"], "7");
    }

    #[tokio::test]
    async fn element_bounds_prefer_visible_content_quads_over_box_model() {
        let backend = FakePointBackend::basic();
        let info = element_info(
            &backend,
            &ctx(),
            json!({ "tab_id": "42", "x": 10, "y": 20 }),
        )
        .await
        .unwrap();
        assert_eq!(info["bounds"]["x"], 10.0);
        assert_eq!(info["bounds"]["y"], 1020.0);
        assert!(
            !backend
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|(method, _)| method == "DOM.getBoxModel")
        );
    }

    #[tokio::test]
    async fn element_bounds_fall_back_to_box_model_when_quads_fail() {
        let mut backend = FakePointBackend::basic();
        backend.content_quads_fails = true;
        let info = element_info(
            &backend,
            &ctx(),
            json!({ "tab_id": "42", "x": 10, "y": 20 }),
        )
        .await
        .unwrap();
        assert_eq!(info["bounds"]["x"], 100.0);
        assert_eq!(info["bounds"]["y"], 1100.0);
        assert!(
            backend
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|(method, _)| method == "DOM.getBoxModel")
        );
    }

    #[tokio::test]
    async fn element_screenshot_clips_to_visible_page_rect() {
        let mut backend = FakePointBackend::basic();
        backend.content_quads = Some(json!({
            "quads": [
                [90, 1080, 130, 1080, 130, 1130, 90, 1130]
            ]
        }));

        let image = element_screenshot(
            &backend,
            &ctx(),
            json!({ "tab_id": "42", "x": 95, "y": 90 }),
        )
        .await
        .unwrap();
        assert_eq!(image["data_base64"], "base64png");

        let screenshots = backend.screenshots.lock().unwrap();
        let params = screenshots.last().expect("screenshot params");
        assert_eq!(params["format"], "png");
        assert_eq!(params["captureBeyondViewport"], false);
        assert_eq!(params["clip"]["x"], 90.0);
        assert_eq!(params["clip"]["y"], 1080.0);
        assert_eq!(params["clip"]["width"], 10.0);
        assert_eq!(params["clip"]["height"], 20.0);
        assert_eq!(params["clip"]["scale"], 1.0);
    }
}

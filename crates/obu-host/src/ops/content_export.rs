//! Shared helpers for screenshots and content export result shaping.

use async_trait::async_trait;
use base64::Engine;
use serde_json::{Map, Value, json};

use crate::backends::BackendRequestContext;
use crate::error::{HostError, Result};

pub(crate) enum ContentExportFormat {
    Html,
    Png,
    Pdf,
}

#[async_trait]
pub(crate) trait ContentExportBackend: Sync {
    async fn capture_screenshot_cdp(
        &self,
        ctx: &BackendRequestContext,
        tab_id: &str,
        cdp_params: Value,
    ) -> Result<Value>;

    async fn print_pdf_cdp(&self, ctx: &BackendRequestContext, tab_id: &str) -> Result<Value>;

    async fn document_html(&self, ctx: &BackendRequestContext, tab_id: &str) -> Result<String>;
}

pub(crate) async fn screenshot<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    tab_id: &str,
) -> Result<Value>
where
    B: ContentExportBackend,
{
    capture_screenshot(backend, ctx, tab_id, screenshot_cdp_params(&Value::Null)).await
}

pub(crate) async fn screenshot_with_params<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value>
where
    B: ContentExportBackend,
{
    let tab_id = required_tab_id(&params)?;
    capture_screenshot(backend, ctx, tab_id, screenshot_cdp_params(&params)).await
}

pub(crate) async fn export_content<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    tab_id: &str,
    format: &str,
) -> Result<Value>
where
    B: ContentExportBackend,
{
    match parse_content_export_format(format)? {
        ContentExportFormat::Png => screenshot(backend, ctx, tab_id).await,
        ContentExportFormat::Pdf => print_pdf(backend, ctx, tab_id).await,
        ContentExportFormat::Html => export_html(backend, ctx, tab_id).await,
    }
}

pub(crate) fn parse_content_export_format(format: &str) -> Result<ContentExportFormat> {
    match format {
        "html" | "" => Ok(ContentExportFormat::Html),
        "png" => Ok(ContentExportFormat::Png),
        "pdf" => Ok(ContentExportFormat::Pdf),
        other => Err(HostError::Protocol(format!(
            "unsupported content export format {other}; expected html, png, or pdf"
        ))),
    }
}

pub(crate) fn required_tab_id(params: &Value) -> Result<&str> {
    params
        .get("tab_id")
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::Protocol("missing tab_id".into()))
}

pub(crate) fn screenshot_cdp_params(params: &Value) -> Value {
    let mut cdp_params = Map::new();
    let format = screenshot_format(params);
    cdp_params.insert("format".into(), Value::String(format.to_string()));
    cdp_params.insert(
        "captureBeyondViewport".into(),
        Value::Bool(
            params
                .get("fullPage")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        ),
    );
    if format != "png"
        && let Some(quality) = params.get("quality").and_then(Value::as_u64)
        && quality <= 100
    {
        cdp_params.insert("quality".into(), Value::Number(quality.into()));
    }
    if let Some(clip) = screenshot_clip(params) {
        cdp_params.insert("clip".into(), clip);
    }
    Value::Object(cdp_params)
}

pub(crate) fn cdp_data<'a>(result: &'a Value, method: &str) -> Result<&'a str> {
    result
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::Protocol(format!("{method} missing data")))
}

pub(crate) fn base64_payload(data: &str, mime_type: &str) -> Value {
    json!({
        "data": data,
        "data_base64": data,
        "mime_type": mime_type,
    })
}

pub(crate) fn html_payload(html: &str) -> Value {
    let data = base64::engine::general_purpose::STANDARD.encode(html.as_bytes());
    base64_payload(&data, "text/html")
}

async fn capture_screenshot<B>(
    backend: &B,
    ctx: &BackendRequestContext,
    tab_id: &str,
    cdp_params: Value,
) -> Result<Value>
where
    B: ContentExportBackend,
{
    let mime_type = screenshot_mime_type(&cdp_params);
    let result = backend
        .capture_screenshot_cdp(ctx, tab_id, cdp_params)
        .await?;
    let data = cdp_data(&result, "Page.captureScreenshot")?;
    Ok(base64_payload(data, mime_type))
}

async fn export_html<B>(backend: &B, ctx: &BackendRequestContext, tab_id: &str) -> Result<Value>
where
    B: ContentExportBackend,
{
    let html = backend.document_html(ctx, tab_id).await?;
    Ok(html_payload(&html))
}

async fn print_pdf<B>(backend: &B, ctx: &BackendRequestContext, tab_id: &str) -> Result<Value>
where
    B: ContentExportBackend,
{
    let result = backend.print_pdf_cdp(ctx, tab_id).await?;
    let data = cdp_data(&result, "Page.printToPDF")?;
    Ok(base64_payload(data, "application/pdf"))
}

fn screenshot_clip(params: &Value) -> Option<Value> {
    let clip = params.get("clip");
    let x = number_field(clip, "x")
        .or_else(|| number_field(Some(params), "cropX"))
        .or_else(|| number_field(Some(params), "x"))?;
    let y = number_field(clip, "y")
        .or_else(|| number_field(Some(params), "cropY"))
        .or_else(|| number_field(Some(params), "y"))?;
    let width = number_field(clip, "width")
        .or_else(|| number_field(Some(params), "cropWidth"))
        .or_else(|| number_field(Some(params), "width"))?;
    let height = number_field(clip, "height")
        .or_else(|| number_field(Some(params), "cropHeight"))
        .or_else(|| number_field(Some(params), "height"))?;
    let scale = number_field(clip, "scale")
        .or_else(|| number_field(Some(params), "scale"))
        .unwrap_or(1.0);
    Some(json!({
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "scale": scale,
    }))
}

fn screenshot_format(params: &Value) -> &str {
    match params
        .get("type")
        .or_else(|| params.get("format"))
        .and_then(Value::as_str)
    {
        Some("jpeg") => "jpeg",
        Some("webp") => "webp",
        _ => "png",
    }
}

fn screenshot_mime_type(cdp_params: &Value) -> &'static str {
    match cdp_params
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or("png")
    {
        "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    }
}

fn number_field(value: Option<&Value>, key: &str) -> Option<f64> {
    value?.get(key).and_then(Value::as_f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_export_format_accepts_supported_values() {
        assert!(matches!(
            parse_content_export_format(""),
            Ok(ContentExportFormat::Html)
        ));
        assert!(matches!(
            parse_content_export_format("html"),
            Ok(ContentExportFormat::Html)
        ));
        assert!(matches!(
            parse_content_export_format("png"),
            Ok(ContentExportFormat::Png)
        ));
        assert!(matches!(
            parse_content_export_format("pdf"),
            Ok(ContentExportFormat::Pdf)
        ));
        assert!(parse_content_export_format("jpeg").is_err());
    }

    #[test]
    fn screenshot_params_include_optional_clip() {
        let full = screenshot_cdp_params(&Value::Null);
        assert_eq!(full["format"], "png");
        assert_eq!(full["captureBeyondViewport"], true);
        assert!(full.get("clip").is_none());

        let clipped = screenshot_cdp_params(&json!({
            "cropX": 1.0,
            "cropY": 2.0,
            "cropWidth": 3.0,
            "cropHeight": 4.0,
        }));
        assert_eq!(clipped["clip"]["x"], 1.0);
        assert_eq!(clipped["clip"]["y"], 2.0);
        assert_eq!(clipped["clip"]["width"], 3.0);
        assert_eq!(clipped["clip"]["height"], 4.0);
        assert_eq!(clipped["clip"]["scale"], 1.0);

        let modern = screenshot_cdp_params(&json!({
            "type": "jpeg",
            "quality": 60,
            "fullPage": false,
            "clip": { "x": 10, "y": 20, "width": 300, "height": 200, "scale": 0.5 },
        }));
        assert_eq!(modern["format"], "jpeg");
        assert_eq!(modern["quality"], 60);
        assert_eq!(modern["captureBeyondViewport"], false);
        assert_eq!(modern["clip"]["scale"], 0.5);
    }

    #[test]
    fn payload_helpers_shape_base64_responses() {
        assert_eq!(
            base64_payload("abc", "image/png"),
            json!({ "data": "abc", "data_base64": "abc", "mime_type": "image/png" })
        );
        assert_eq!(html_payload("<main></main>")["mime_type"], "text/html");
        assert!(
            html_payload("<main></main>")["data_base64"]
                .as_str()
                .unwrap()
                .len()
                > 8
        );
    }
}

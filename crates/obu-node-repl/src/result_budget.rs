//! MCP `js` result budgeting and artifact spilling.

use anyhow::{Context, Result};
use base64::Engine;
use rmcp::model::{Content, RawResource};
use serde_json::{Map, Value, json};

use crate::artifact_store::{ArtifactStore, ArtifactSummary};
use crate::repl_manager::{JsExecResult, TruncationInfo};

const MAX_STDOUT_BYTES: usize = 64 * 1024;
const MAX_STDERR_BYTES: usize = 16 * 1024;
const MAX_RESULT_JSON_BYTES: usize = 128 * 1024;
const MAX_DISPLAY_JSON_BYTES: usize = 64 * 1024;
const MAX_DISPLAY_COUNT: usize = 50;
const ARTIFACT_INLINE_THRESHOLD_BYTES: usize = 32 * 1024;

/// Budgeted MCP result ready to serialize into a tool response.
#[derive(Debug, Clone)]
pub struct PreparedJsResult {
    /// Structured content payload.
    pub structured: Value,
    /// Human-facing text summary.
    pub text_summary: String,
    /// Resource links for client render/fetch paths.
    pub content_links: Vec<Content>,
    /// User-code JavaScript error, if any.
    pub error: Option<String>,
    /// Kernel response metadata.
    pub response_meta: Option<Value>,
}

/// Apply MCP result budgets and spill large artifacts into resources.
pub fn prepare_js_result(
    result: JsExecResult,
    artifacts: &ArtifactStore,
) -> Result<PreparedJsResult> {
    let mut links = Vec::new();
    let mut truncated = TruncationInfo::default();

    let (stdout, stdout_truncated) = truncate_text(result.stdout, MAX_STDOUT_BYTES);
    let (stderr, stderr_truncated) = truncate_text(result.stderr, MAX_STDERR_BYTES);
    truncated.stdout = stdout_truncated;
    truncated.stderr = stderr_truncated;

    let mut final_result = rewrite_artifacts(result.result, artifacts, &mut links, false)?;
    if json_size(&final_result) > MAX_RESULT_JSON_BYTES {
        let bytes = json_size(&final_result);
        final_result = summarize_value(&final_result, bytes);
        truncated.result = true;
    }

    let original_display_count = result.displays.len();
    let mut displays = Vec::new();
    for mut display in result.displays.into_iter().take(MAX_DISPLAY_COUNT) {
        display.value = rewrite_artifacts(
            display.value,
            artifacts,
            &mut links,
            display.kind == "image",
        )?;
        if json_size(&display.value) > MAX_DISPLAY_JSON_BYTES {
            let bytes = json_size(&display.value);
            display.value = summarize_value(&display.value, bytes);
            truncated.displays = true;
        }
        displays.push(display);
    }
    if original_display_count > displays.len() {
        truncated.displays = true;
    }

    let artifacts_json = links
        .iter()
        .filter_map(resource_link_summary)
        .collect::<Vec<_>>();
    let text_summary = result_text_summary(result.duration_ms, &truncated, artifacts_json.len());
    let response_meta = result.response_meta.clone();
    let error = result.error.clone();
    let structured = json!({
        "stdout": stdout,
        "stderr": stderr,
        "result": final_result,
        "duration_ms": result.duration_ms,
        "truncated": truncated,
        "displays": displays,
        "artifacts": artifacts_json,
        "response_meta": response_meta,
        "error": error,
    });

    Ok(PreparedJsResult {
        structured,
        text_summary,
        content_links: links,
        error,
        response_meta,
    })
}

fn result_text_summary(
    duration_ms: u64,
    truncated: &TruncationInfo,
    artifact_count: usize,
) -> String {
    let mut parts = vec![format!(
        "JavaScript execution completed in {duration_ms}ms."
    )];
    let truncated_fields = [
        ("stdout", truncated.stdout),
        ("stderr", truncated.stderr),
        ("result", truncated.result),
        ("displays", truncated.displays),
    ]
    .into_iter()
    .filter_map(|(name, was_truncated)| was_truncated.then_some(name))
    .collect::<Vec<_>>();
    if !truncated_fields.is_empty() {
        parts.push(format!("Truncated: {}.", truncated_fields.join(", ")));
    }
    if artifact_count > 0 {
        parts.push(format!(
            "{artifact_count} artifact{} available as MCP resource{}.",
            if artifact_count == 1 { "" } else { "s" },
            if artifact_count == 1 { "" } else { "s" }
        ));
    }
    parts.join(" ")
}

fn rewrite_artifacts(
    value: Value,
    artifacts: &ArtifactStore,
    links: &mut Vec<Content>,
    force_artifact: bool,
) -> Result<Value> {
    if let Some(summary) = spill_if_artifact(&value, artifacts, force_artifact)? {
        links.push(content_link(&summary));
        return serde_json::to_value(summary).context("serialize artifact summary");
    }

    match value {
        Value::Array(items) => items
            .into_iter()
            .map(|item| rewrite_artifacts(item, artifacts, links, false))
            .collect::<Result<Vec<_>>>()
            .map(Value::Array),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, child) in map {
                out.insert(key, rewrite_artifacts(child, artifacts, links, false)?);
            }
            Ok(Value::Object(out))
        }
        other => Ok(other),
    }
}

fn spill_if_artifact(
    value: &Value,
    artifacts: &ArtifactStore,
    force_artifact: bool,
) -> Result<Option<ArtifactSummary>> {
    let Some(map) = value.as_object() else {
        return Ok(None);
    };

    if let Some(image_url) = map.get("image_url").and_then(Value::as_str)
        && let Some((mime_type, data_base64)) = parse_data_url(image_url)
    {
        let bytes = decoded_len(data_base64)?;
        if force_artifact || bytes > ARTIFACT_INLINE_THRESHOLD_BYTES {
            return artifacts
                .write_base64(&mime_type, data_base64, artifact_summary(&mime_type, bytes))
                .map(Some);
        }
    }

    let mime_type = map
        .get("mime_type")
        .or_else(|| map.get("mimeType"))
        .and_then(Value::as_str);
    let data_base64 = map
        .get("data_base64")
        .or_else(|| map.get("base64"))
        .or_else(|| map.get("data"))
        .and_then(Value::as_str);
    let Some((mime_type, data_base64)) = mime_type.zip(data_base64) else {
        return Ok(None);
    };
    if !is_resource_mime_type(mime_type) {
        return Ok(None);
    }
    let bytes = decoded_len(data_base64)?;
    if !force_artifact && bytes <= ARTIFACT_INLINE_THRESHOLD_BYTES {
        return Ok(None);
    }
    artifacts
        .write_base64(mime_type, data_base64, artifact_summary(mime_type, bytes))
        .map(Some)
}

fn content_link(summary: &ArtifactSummary) -> Content {
    Content::resource_link(
        RawResource::new(&summary.uri, resource_name(&summary.uri))
            .with_title(summary.summary.clone())
            .with_description(summary.summary.clone())
            .with_mime_type(summary.mime_type.clone())
            .with_size(summary.bytes.min(u32::MAX as usize) as u32),
    )
}

fn resource_link_summary(content: &Content) -> Option<Value> {
    let raw = content.raw.as_resource_link()?;
    Some(json!({
        "kind": "resource",
        "uri": raw.uri,
        "mime_type": raw.mime_type,
        "bytes": raw.size,
        "summary": raw.title,
    }))
}

fn resource_name(uri: &str) -> String {
    uri.strip_prefix("obu-artifact://")
        .unwrap_or(uri)
        .to_string()
}

fn is_resource_mime_type(mime_type: &str) -> bool {
    mime_type.starts_with("image/")
        || matches!(mime_type, "application/pdf" | "text/html" | "text/plain")
}

fn artifact_summary(mime_type: &str, bytes: usize) -> String {
    format!("{bytes} byte {mime_type} artifact")
}

fn parse_data_url(value: &str) -> Option<(String, &str)> {
    let rest = value.strip_prefix("data:")?;
    let (header, data) = rest.split_once(',')?;
    let mut parts = header.split(';');
    let mime_type = parts.next().filter(|part| !part.is_empty())?;
    if !parts.any(|part| part.eq_ignore_ascii_case("base64")) {
        return None;
    }
    Some((mime_type.to_string(), data))
}

fn decoded_len(data_base64: &str) -> Result<usize> {
    base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map(|bytes| bytes.len())
        .context("decode artifact base64")
}

fn truncate_text(value: String, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value, false);
    }
    let omitted = value.len() - max_bytes;
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (
        format!("{}\n... truncated {} bytes ...", &value[..end], omitted),
        true,
    )
}

fn json_size(value: &Value) -> usize {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX)
}

fn summarize_value(value: &Value, estimated_json_bytes: usize) -> Value {
    match value {
        Value::Array(items) => json!({
            "kind": "truncated",
            "type": "array",
            "length": items.len(),
            "estimated_json_bytes": estimated_json_bytes,
        }),
        Value::Object(map) => json!({
            "kind": "truncated",
            "type": "object",
            "keys": map.keys().take(25).cloned().collect::<Vec<_>>(),
            "key_count": map.len(),
            "estimated_json_bytes": estimated_json_bytes,
        }),
        Value::String(text) => json!({
            "kind": "truncated",
            "type": "string",
            "length": text.len(),
            "estimated_json_bytes": estimated_json_bytes,
        }),
        other => json!({
            "kind": "truncated",
            "type": value_type(other),
            "estimated_json_bytes": estimated_json_bytes,
        }),
    }
}

fn value_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repl_manager::{DisplayEntry, JsExecResult};

    #[test]
    fn prepare_js_result_truncates_and_spills_image_display() {
        let dir = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::new_at(dir.path(), "budget-test").unwrap();
        let raw = JsExecResult {
            stdout: "x".repeat(MAX_STDOUT_BYTES + 10),
            stderr: String::new(),
            result: json!({ "ok": true }),
            duration_ms: 7,
            truncated: TruncationInfo::default(),
            displays: vec![DisplayEntry {
                at_ms: 1,
                kind: "image".to_string(),
                value: json!({
                    "mime_type": "image/png",
                    "data": "iVBORw0KGgo="
                }),
            }],
            response_meta: None,
            error: None,
        };

        let prepared = prepare_js_result(raw, &artifacts).unwrap();
        assert_eq!(prepared.structured["truncated"]["stdout"], true);
        assert_eq!(
            prepared.structured["displays"][0]["value"]["kind"],
            "resource"
        );
        assert_eq!(prepared.content_links.len(), 1);
        let uri = prepared.structured["displays"][0]["value"]["uri"]
            .as_str()
            .unwrap();
        assert!(artifacts.read_resource(uri).is_ok());
    }

    #[test]
    fn prepare_js_result_summarizes_huge_result_and_display_values() {
        let dir = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::new_at(dir.path(), "budget-test").unwrap();
        let raw = JsExecResult {
            stdout: String::new(),
            stderr: String::new(),
            result: json!({ "payload": "x".repeat(MAX_RESULT_JSON_BYTES + 1) }),
            duration_ms: 7,
            truncated: TruncationInfo::default(),
            displays: vec![DisplayEntry {
                at_ms: 1,
                kind: "json".to_string(),
                value: json!({ "payload": "x".repeat(MAX_DISPLAY_JSON_BYTES + 1) }),
            }],
            response_meta: None,
            error: None,
        };

        let prepared = prepare_js_result(raw, &artifacts).unwrap();

        assert_eq!(prepared.structured["truncated"]["result"], true);
        assert_eq!(prepared.structured["truncated"]["displays"], true);
        assert_eq!(prepared.structured["result"]["kind"], "truncated");
        assert_eq!(
            prepared.structured["displays"][0]["value"]["kind"],
            "truncated"
        );
    }
}

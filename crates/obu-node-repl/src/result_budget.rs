//! MCP `js` result budgeting and artifact spilling.

use anyhow::{Context, Result};
use base64::Engine;
use rmcp::model::{Content, RawResource};
use serde_json::{Map, Value, json};

use crate::artifact_store::{ArtifactStore, ArtifactSummary, MAX_ARTIFACT_BYTES};
use crate::repl_manager::{JsExecResult, MAX_DISPLAY_COUNT, TruncationInfo};

const MAX_STDOUT_BYTES: usize = 64 * 1024;
const MAX_STDERR_BYTES: usize = 16 * 1024;
const MAX_RESULT_JSON_BYTES: usize = 128 * 1024;
const MAX_DISPLAY_JSON_BYTES: usize = 64 * 1024;
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

    let mut final_result = rewrite_artifacts(
        result.result,
        artifacts,
        &mut links,
        false,
        &mut truncated.result,
    )?;
    if json_size(&final_result) > MAX_RESULT_JSON_BYTES {
        let bytes = json_size(&final_result);
        final_result = summarize_value(&final_result, bytes);
        truncated.result = true;
    }

    let displays_total = result.displays_total;
    let mut displays = Vec::new();
    // Backstop only: the live accumulator is already bounded at push time
    // (ExecRegistry::push_display); take() guards against an unbounded input.
    for mut display in result.displays.into_iter().take(MAX_DISPLAY_COUNT) {
        display.value = rewrite_artifacts(
            display.value,
            artifacts,
            &mut links,
            display.kind == "image",
            &mut truncated.displays,
        )?;
        if json_size(&display.value) > MAX_DISPLAY_JSON_BYTES {
            let bytes = json_size(&display.value);
            display.value = summarize_value(&display.value, bytes);
            truncated.displays = true;
        }
        displays.push(display);
    }
    let displays_shown = displays.len();
    if displays_total > displays_shown as u64 {
        truncated.displays = true;
    }

    let artifacts_json = links
        .iter()
        .filter_map(resource_link_summary)
        .collect::<Vec<_>>();
    let text_summary = result_text_summary(
        result.duration_ms,
        &truncated,
        artifacts_json.len(),
        displays_shown,
        displays_total,
    );
    let response_meta = result.response_meta.clone();
    let error = result.error.clone();
    let error_detail = result.error_detail.clone();
    let structured = json!({
        "stdout": stdout,
        "stderr": stderr,
        "result": final_result,
        "duration_ms": result.duration_ms,
        "truncated": truncated,
        "displays": displays,
        "displays_total": displays_total,
        "displays_shown": displays_shown,
        "artifacts": artifacts_json,
        "response_meta": response_meta,
        "error": error,
        "error_detail": error_detail,
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
    displays_shown: usize,
    displays_total: u64,
) -> String {
    let mut parts = vec![format!(
        "JavaScript execution completed in {duration_ms}ms."
    )];
    let mut truncated_fields: Vec<String> = Vec::new();
    if truncated.stdout {
        truncated_fields.push("stdout".to_string());
    }
    if truncated.stderr {
        truncated_fields.push("stderr".to_string());
    }
    if truncated.result {
        truncated_fields.push("result".to_string());
    }
    if truncated.displays {
        if displays_total > displays_shown as u64 {
            truncated_fields.push(format!(
                "displays ({displays_shown} of {displays_total} shown; head)"
            ));
        } else {
            truncated_fields.push("displays".to_string());
        }
    }
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
    truncated: &mut bool,
) -> Result<Value> {
    if let Some(summary) = spill_if_artifact(&value, artifacts, force_artifact)? {
        return match summary {
            ArtifactRewrite::Resource(summary) => {
                links.push(content_link(&summary));
                serde_json::to_value(summary).context("serialize artifact summary")
            }
            ArtifactRewrite::Truncated(value) => {
                *truncated = true;
                Ok(value)
            }
        };
    }

    match value {
        Value::Array(items) => items
            .into_iter()
            .map(|item| rewrite_artifacts(item, artifacts, links, false, truncated))
            .collect::<Result<Vec<_>>>()
            .map(Value::Array),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, child) in map {
                out.insert(
                    key,
                    rewrite_artifacts(child, artifacts, links, false, truncated)?,
                );
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
) -> Result<Option<ArtifactRewrite>> {
    let Some(map) = value.as_object() else {
        return Ok(None);
    };

    if let Some(image_url) = map.get("image_url").and_then(Value::as_str)
        && let Some((mime_type, data_base64)) = parse_data_url(image_url)
    {
        let payload = decode_artifact_payload(&mime_type, data_base64)?;
        let DecodedArtifact::Bytes(bytes) = payload else {
            return Ok(Some(ArtifactRewrite::Truncated(oversized_artifact_value(
                &mime_type,
                data_base64,
            ))));
        };
        if force_artifact || bytes.len() > ARTIFACT_INLINE_THRESHOLD_BYTES {
            return artifacts
                .write_bytes(
                    &mime_type,
                    &bytes,
                    artifact_summary(&mime_type, bytes.len()),
                )
                .map(ArtifactRewrite::Resource)
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
    let payload = decode_artifact_payload(mime_type, data_base64)?;
    let DecodedArtifact::Bytes(bytes) = payload else {
        return Ok(Some(ArtifactRewrite::Truncated(oversized_artifact_value(
            mime_type,
            data_base64,
        ))));
    };
    if !force_artifact && bytes.len() <= ARTIFACT_INLINE_THRESHOLD_BYTES {
        return Ok(None);
    }
    artifacts
        .write_bytes(mime_type, &bytes, artifact_summary(mime_type, bytes.len()))
        .map(ArtifactRewrite::Resource)
        .map(Some)
}

enum ArtifactRewrite {
    Resource(ArtifactSummary),
    Truncated(Value),
}

enum DecodedArtifact {
    Bytes(Vec<u8>),
    TooLarge,
}

fn decode_artifact_payload(mime_type: &str, data_base64: &str) -> Result<DecodedArtifact> {
    let estimated = estimated_decoded_len(data_base64);
    if estimated > MAX_ARTIFACT_BYTES {
        return Ok(DecodedArtifact::TooLarge);
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .with_context(|| format!("decode {mime_type} artifact base64"))?;
    if bytes.len() > MAX_ARTIFACT_BYTES {
        return Ok(DecodedArtifact::TooLarge);
    }
    Ok(DecodedArtifact::Bytes(bytes))
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

fn estimated_decoded_len(data_base64: &str) -> usize {
    let padding = data_base64
        .as_bytes()
        .iter()
        .rev()
        .take_while(|byte| **byte == b'=')
        .take(2)
        .count();
    data_base64
        .len()
        .saturating_add(3)
        .saturating_div(4)
        .saturating_mul(3)
        .saturating_sub(padding)
}

fn oversized_artifact_value(mime_type: &str, data_base64: &str) -> Value {
    json!({
        "kind": "truncated",
        "type": "artifact",
        "mime_type": mime_type,
        "estimated_bytes": estimated_decoded_len(data_base64),
        "max_bytes": MAX_ARTIFACT_BYTES,
    })
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
            displays_total: 1,
            response_meta: None,
            error: None,
            error_detail: None,
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
            displays_total: 1,
            response_meta: None,
            error: None,
            error_detail: None,
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

    #[test]
    fn prepare_js_result_summarizes_oversize_artifact_without_decoding_it() {
        let dir = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::new_at(dir.path(), "budget-test").unwrap();
        let encoded_len = (MAX_ARTIFACT_BYTES / 3 + 2) * 4;
        let raw = JsExecResult {
            stdout: String::new(),
            stderr: String::new(),
            result: json!({
                "mime_type": "application/pdf",
                "data": "A".repeat(encoded_len),
            }),
            duration_ms: 7,
            truncated: TruncationInfo::default(),
            displays: Vec::new(),
            displays_total: 0,
            response_meta: None,
            error: None,
            error_detail: None,
        };

        let prepared = prepare_js_result(raw, &artifacts).unwrap();

        assert_eq!(prepared.structured["truncated"]["result"], true);
        assert_eq!(prepared.structured["result"]["kind"], "truncated");
        assert_eq!(prepared.structured["result"]["type"], "artifact");
        assert_eq!(prepared.content_links.len(), 0);
        assert!(artifacts.list_resources().is_empty());
    }

    #[test]
    fn prepare_js_result_surfaces_display_count_when_capped() {
        let dir = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::new_at(dir.path(), "budget-test").unwrap();
        let displays = (0..MAX_DISPLAY_COUNT)
            .map(|i| DisplayEntry {
                at_ms: i as u64,
                kind: "text".to_string(),
                value: json!(i),
            })
            .collect();
        let raw = JsExecResult {
            stdout: String::new(),
            stderr: String::new(),
            result: json!({ "ok": true }),
            duration_ms: 3,
            truncated: TruncationInfo::default(),
            displays,
            displays_total: 4321,
            response_meta: None,
            error: None,
            error_detail: None,
        };

        let prepared = prepare_js_result(raw, &artifacts).unwrap();

        assert_eq!(prepared.structured["displays_total"], 4321);
        assert_eq!(prepared.structured["displays_shown"], MAX_DISPLAY_COUNT);
        assert_eq!(prepared.structured["truncated"]["displays"], true);
        assert!(prepared.text_summary.contains("50 of 4321 shown; head"));
    }

    #[test]
    fn prepare_js_result_reports_full_display_count_when_not_capped() {
        let dir = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::new_at(dir.path(), "budget-test").unwrap();
        let raw = JsExecResult {
            stdout: String::new(),
            stderr: String::new(),
            result: json!({ "ok": true }),
            duration_ms: 3,
            truncated: TruncationInfo::default(),
            displays: vec![DisplayEntry {
                at_ms: 1,
                kind: "text".to_string(),
                value: json!("hi"),
            }],
            displays_total: 1,
            response_meta: None,
            error: None,
            error_detail: None,
        };

        let prepared = prepare_js_result(raw, &artifacts).unwrap();

        assert_eq!(prepared.structured["displays_total"], 1);
        assert_eq!(prepared.structured["displays_shown"], 1);
        assert_eq!(prepared.structured["truncated"]["displays"], false);
        assert!(!prepared.text_summary.contains("shown; head"));
    }

    #[test]
    fn prepare_js_result_count_cap_and_value_summarize_are_both_honest() {
        let dir = tempfile::tempdir().unwrap();
        let artifacts = ArtifactStore::new_at(dir.path(), "budget-test").unwrap();
        let mut displays: Vec<DisplayEntry> = (0..MAX_DISPLAY_COUNT)
            .map(|i| DisplayEntry {
                at_ms: i as u64,
                kind: "text".to_string(),
                value: json!(i),
            })
            .collect();
        // One kept frame is itself oversized -> value-summarized inline.
        displays[0].value = json!({ "payload": "x".repeat(MAX_DISPLAY_JSON_BYTES + 1) });
        let raw = JsExecResult {
            stdout: String::new(),
            stderr: String::new(),
            result: json!({ "ok": true }),
            duration_ms: 3,
            truncated: TruncationInfo::default(),
            displays,
            displays_total: 60,
            response_meta: None,
            error: None,
            error_detail: None,
        };

        let prepared = prepare_js_result(raw, &artifacts).unwrap();

        // Cardinality token wins in the summary...
        assert!(prepared.text_summary.contains("50 of 60 shown; head"));
        assert_eq!(prepared.structured["truncated"]["displays"], true);
        // ...and the oversized kept frame still carries its inline truncation marker.
        assert_eq!(
            prepared.structured["displays"][0]["value"]["kind"],
            "truncated"
        );
    }
}

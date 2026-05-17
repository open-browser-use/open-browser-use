//! MCP server surface for `obu-node-repl`.
//!
//! open-browser-use exposes `js`, `js_reset`, and `js_add_module_dir`. The third tool is
//! intentionally not named Codex's `js_add_node_module_dir`: OBU keeps the
//! behavior but drops the Node-specific spelling from the public API.

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use anyhow::{Context, Result};
use rmcp::model::{
    CallToolRequestMethod, CallToolRequestParams, CallToolResult, Content, ErrorData,
    Implementation, ListResourcesResult, ListToolsResult, Meta, PaginatedRequestParams,
    ProgressNotificationParam, ReadResourceRequestParams, ReadResourceResult, ServerCapabilities,
    ServerInfo, Tool, ToolAnnotations,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{ServerHandler, ServiceExt};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::artifact_store::ArtifactStore;
use crate::cli::Cli;
use crate::repl_manager::{JsRuntimeManager, ManagerOptions};
use crate::result_budget::prepare_js_result;

/// Long-form `js` tool description.
pub const JS_TOOL_DESCRIPTION: &str = include_str!("../resources/js_tool_description.md");

static JS_SCHEMA: LazyLock<Arc<rmcp::model::JsonObject>> = LazyLock::new(|| {
    Arc::new(schema_object(json!({
        "type": "object",
        "required": ["source"],
        "properties": {
            "source": {
                "type": "string",
                "description": "JavaScript source to execute in the persistent Node-backed kernel."
            },
            "timeout_ms": {
                "type": "integer",
                "minimum": 1,
                "description": "Optional execution timeout in milliseconds."
            }
        },
        "additionalProperties": false
    })))
});

static JS_OUTPUT_SCHEMA: LazyLock<Arc<rmcp::model::JsonObject>> = LazyLock::new(|| {
    Arc::new(schema_object(json!({
        "type": "object",
        "required": ["stdout", "stderr", "result", "duration_ms", "truncated", "displays", "artifacts", "response_meta", "error"],
        "properties": {
            "stdout": {
                "type": "string",
                "description": "Captured console and nodeRepl.write output."
            },
            "stderr": {
                "type": "string",
                "description": "Reserved stderr capture; currently empty."
            },
            "result": {
                "description": "JSON-serializable value of the last expression, or null."
            },
            "duration_ms": {
                "type": "integer",
                "minimum": 0,
                "description": "Kernel-measured execution duration."
            },
            "truncated": {
                "type": "object",
                "properties": {
                    "stdout": { "type": "boolean" },
                    "stderr": { "type": "boolean" },
                    "result": { "type": "boolean" },
                    "displays": { "type": "boolean" }
                },
                "required": ["stdout", "stderr", "result", "displays"],
                "additionalProperties": false
            },
            "displays": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["at_ms", "type", "value"],
                    "properties": {
                        "at_ms": { "type": "integer", "minimum": 0 },
                        "type": { "type": "string", "enum": ["text", "json", "image"] },
                        "value": { "description": "Display payload." }
                    },
                    "additionalProperties": false
                }
            },
            "artifacts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["kind", "uri", "mime_type", "bytes", "summary"],
                    "properties": {
                        "kind": { "type": "string", "enum": ["resource"] },
                        "uri": { "type": "string" },
                        "mime_type": { "type": ["string", "null"] },
                        "bytes": { "type": ["integer", "null"], "minimum": 0 },
                        "summary": { "type": ["string", "null"] }
                    },
                    "additionalProperties": false
                }
            },
            "response_meta": {
                "description": "Kernel-provided MCP response metadata from nodeRepl.setResponseMeta(), or null."
            },
            "error": {
                "anyOf": [
                    { "type": "null" },
                    { "type": "string" }
                ],
                "description": "User-code JavaScript error, when execution failed inside the kernel."
            }
        },
        "additionalProperties": false
    })))
});

static BROWSER_STATUS_OUTPUT_SCHEMA: LazyLock<Arc<rmcp::model::JsonObject>> = LazyLock::new(|| {
    Arc::new(schema_object(json!({
        "type": "object",
        "required": ["sdk_bootstrap", "backends", "diagnostics", "runtime_dir", "doctor_hint"],
        "properties": {
            "sdk_bootstrap": {
                "type": "string",
                "enum": ["available", "missing", "untrusted"]
            },
            "sdk_bootstrap_detail": {
                "type": "object"
            },
            "backends": {
                "type": "array"
            },
            "diagnostics": {
                "type": "array"
            },
            "runtime_dir": {
                "type": "string"
            },
            "doctor_hint": {
                "type": "string"
            }
        },
        "additionalProperties": false
    })))
});

static EMPTY_SCHEMA: LazyLock<Arc<rmcp::model::JsonObject>> = LazyLock::new(|| {
    Arc::new(schema_object(json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false
    })))
});

static OK_OUTPUT_SCHEMA: LazyLock<Arc<rmcp::model::JsonObject>> = LazyLock::new(|| {
    Arc::new(schema_object(json!({
        "type": "object",
        "required": ["ok"],
        "properties": {
            "ok": { "type": "boolean", "enum": [true] }
        },
        "additionalProperties": false
    })))
});

static ADD_MODULE_DIR_SCHEMA: LazyLock<Arc<rmcp::model::JsonObject>> = LazyLock::new(|| {
    Arc::new(schema_object(json!({
        "type": "object",
        "required": ["path"],
        "properties": {
            "path": {
                "type": "string",
                "description": "Absolute directory whose node_modules subtree should be added to bare import roots."
            }
        },
        "additionalProperties": false
    })))
});

/// `js` arguments.
#[derive(Debug, Deserialize)]
pub struct JsArgs {
    /// JavaScript source.
    pub source: String,
    /// Optional timeout in milliseconds.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// `js_reset` arguments.
#[derive(Debug, Deserialize, Default)]
pub struct JsResetArgs {}

/// `js_add_module_dir` arguments.
#[derive(Debug, Deserialize)]
pub struct JsAddModuleDirArgs {
    /// Absolute directory path.
    pub path: String,
}

/// MCP server implementation.
pub struct ObuServer {
    runtime: Arc<JsRuntimeManager>,
    artifacts: ArtifactStore,
}

impl ObuServer {
    /// Construct a server around a runtime manager.
    pub fn new(runtime: Arc<JsRuntimeManager>) -> Result<Self> {
        let artifacts = ArtifactStore::new(runtime.session_id())?;
        Ok(Self { runtime, artifacts })
    }

    fn tools() -> Vec<Tool> {
        vec![
            Tool::new("js", JS_TOOL_DESCRIPTION, JS_SCHEMA.clone())
                .with_title("JavaScript")
                .with_raw_output_schema(JS_OUTPUT_SCHEMA.clone())
                .with_annotations(
                    ToolAnnotations::new()
                        .read_only(false)
                        .destructive(true)
                        .idempotent(false)
                        .open_world(true),
                ),
            Tool::new(
                "browser_status",
                "Report browser-use readiness, SDK bootstrap status, discovered backends, and repair hints without executing JavaScript.",
                EMPTY_SCHEMA.clone(),
            )
            .with_title("Browser Status")
            .with_raw_output_schema(BROWSER_STATUS_OUTPUT_SCHEMA.clone())
            .with_annotations(
                ToolAnnotations::new()
                    .read_only(true)
                    .destructive(false)
                    .idempotent(true)
                    .open_world(false),
            ),
            Tool::new(
                "js_reset",
                "Reset the persistent Node REPL kernel and clear JavaScript state.",
                EMPTY_SCHEMA.clone(),
            )
            .with_title("Reset JavaScript Kernel")
            .with_raw_output_schema(OK_OUTPUT_SCHEMA.clone())
            .with_annotations(
                ToolAnnotations::new()
                    .read_only(false)
                    .destructive(true)
                    .idempotent(false)
                    .open_world(false),
            ),
            Tool::new(
                "js_add_module_dir",
                Cow::Borrowed("Authorize an additional absolute directory for module imports."),
                ADD_MODULE_DIR_SCHEMA.clone(),
            )
            .with_title("Add Module Directory")
            .with_raw_output_schema(OK_OUTPUT_SCHEMA.clone())
            .with_annotations(
                ToolAnnotations::new()
                    .read_only(false)
                    .destructive(false)
                    .idempotent(true)
                    .open_world(false),
            ),
        ]
    }
}

impl ServerHandler for ObuServer {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_instructions("Run JavaScript in the open-browser-use Node REPL.");
        info.server_info = Implementation::new("obu-node-repl", env!("CARGO_PKG_VERSION"));
        info
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> std::result::Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(Self::tools()))
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        Self::tools().into_iter().find(|tool| tool.name == name)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResult, ErrorData> {
        let name = request.name;
        let arguments = request.arguments;
        let meta = _context.meta.clone();
        match name.as_ref() {
            "js" => self.call_js(arguments, meta, _context).await,
            "browser_status" => self.call_browser_status(arguments).await,
            "js_reset" => self.call_js_reset(arguments).await,
            "js_add_module_dir" => self.call_js_add_module_dir(arguments).await,
            _ => Err(ErrorData::method_not_found::<CallToolRequestMethod>()),
        }
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> std::result::Result<ListResourcesResult, ErrorData> {
        Ok(ListResourcesResult::with_all_items(
            self.artifacts.list_resources(),
        ))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> std::result::Result<ReadResourceResult, ErrorData> {
        let contents = self
            .artifacts
            .read_resource(&request.uri)
            .map_err(|error| {
                ErrorData::invalid_params(format!("resource unavailable: {error}"), None)
            })?;
        Ok(ReadResourceResult::new(vec![contents]))
    }
}

impl ObuServer {
    async fn call_js(
        &self,
        arguments: Option<rmcp::model::JsonObject>,
        meta: Meta,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResult, ErrorData> {
        let args: JsArgs = decode_args(arguments)?;
        let mut pending_progress_tasks = None;
        if let Some(progress_token) = meta.get_progress_token() {
            let peer = context.peer.clone();
            let tasks = Arc::new(StdMutex::new(Vec::new()));
            let sink_tasks = tasks.clone();
            let sink: crate::display_router::ProgressSink = Arc::new(move |frame| {
                let peer = peer.clone();
                let progress_token = progress_token.clone();
                let task = tokio::spawn(async move {
                    let _ = peer
                        .notify_progress(ProgressNotificationParam {
                            progress_token,
                            progress: frame.progress as f64,
                            total: None,
                            message: Some(frame.message),
                        })
                        .await;
                });
                sink_tasks.lock().expect("progress task lock").push(task);
            });
            self.runtime.set_progress_sink(Some(sink)).await;
            pending_progress_tasks = Some(tasks);
        }

        let result = self
            .runtime
            .exec_with_turn_id(&args.source, args.timeout_ms, client_turn_id(&meta))
            .await;
        self.runtime.set_progress_sink(None).await;
        if let Some(tasks) = pending_progress_tasks {
            let tasks = {
                let mut tasks = tasks.lock().expect("progress task lock");
                std::mem::take(&mut *tasks)
            };
            for task in tasks {
                let _ = task.await;
            }
        }
        let result = result.map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let prepared = prepare_js_result(result, &self.artifacts)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        if prepared.error.is_some() {
            Ok(structured_error_result(
                prepared.structured,
                prepared.content_links,
                prepared.response_meta,
            ))
        } else {
            Ok(structured_result(
                prepared.structured,
                prepared.text_summary,
                prepared.content_links,
                prepared.response_meta,
            ))
        }
    }

    async fn call_browser_status(
        &self,
        arguments: Option<rmcp::model::JsonObject>,
    ) -> std::result::Result<CallToolResult, ErrorData> {
        let _args: JsResetArgs = decode_args(arguments)?;
        let status = self.runtime.browser_status().await.map_err(|error| {
            ErrorData::internal_error(format!("failed to compute browser status: {error}"), None)
        })?;
        Ok(structured_result(
            status,
            "Browser status computed.",
            Vec::new(),
            None,
        ))
    }

    async fn call_js_reset(
        &self,
        arguments: Option<rmcp::model::JsonObject>,
    ) -> std::result::Result<CallToolResult, ErrorData> {
        let _args: JsResetArgs = decode_args(arguments)?;
        self.runtime
            .reset()
            .await
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        Ok(structured_result(
            json!({ "ok": true }),
            "OK",
            Vec::new(),
            None,
        ))
    }

    async fn call_js_add_module_dir(
        &self,
        arguments: Option<rmcp::model::JsonObject>,
    ) -> std::result::Result<CallToolResult, ErrorData> {
        let args: JsAddModuleDirArgs = decode_args(arguments)?;
        let path = PathBuf::from(args.path);
        if !path.is_absolute() {
            return Err(ErrorData::invalid_params("path must be absolute", None));
        }
        self.runtime.add_module_dir(path);
        Ok(structured_result(
            json!({ "ok": true }),
            "OK",
            Vec::new(),
            None,
        ))
    }
}

/// Entry from `cli::run`.
pub async fn run_stdio_server_with_options(cli: Cli) -> Result<()> {
    let options = ManagerOptions::from_cli(&cli)?;
    let manager = Arc::new(JsRuntimeManager::new(options).await?);
    manager.boot().await?;

    let server = ObuServer::new(manager)?;
    let serve = server
        .serve((tokio::io::stdin(), tokio::io::stdout()))
        .await
        .context("failed to start stdio MCP server")?;
    serve
        .waiting()
        .await
        .context("stdio MCP server exited with error")?;
    Ok(())
}

fn decode_args<T: for<'de> Deserialize<'de>>(
    arguments: Option<rmcp::model::JsonObject>,
) -> std::result::Result<T, ErrorData> {
    serde_json::from_value(Value::Object(arguments.unwrap_or_default()))
        .map_err(|error| ErrorData::invalid_params(error.to_string(), None))
}

fn client_turn_id(meta: &Meta) -> Option<String> {
    meta.0
        .get("x-obu-turn-metadata")
        .or_else(|| meta.0.get("x-codex-turn-metadata"))
        .and_then(|value| value.get("turn_id").or_else(|| value.get("turnId")))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn schema_object(value: Value) -> rmcp::model::JsonObject {
    match value {
        Value::Object(map) => map,
        _ => unreachable!("schema literals are objects"),
    }
}

fn structured_result(
    value: Value,
    summary: impl Into<String>,
    mut links: Vec<Content>,
    response_meta: Option<Value>,
) -> CallToolResult {
    let mut content = vec![Content::text(summary.into())];
    content.append(&mut links);
    let mut result = CallToolResult::success(content);
    result.structured_content = Some(value);
    result.meta = response_meta.and_then(value_to_meta);
    result
}

fn structured_error_result(
    value: Value,
    mut links: Vec<Content>,
    response_meta: Option<Value>,
) -> CallToolResult {
    let message = value
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("JavaScript execution failed");
    let mut content = vec![Content::text(format!(
        "JavaScript execution failed: {message}"
    ))];
    content.append(&mut links);
    let mut result = CallToolResult::error(content);
    result.structured_content = Some(value);
    result.meta = response_meta.and_then(value_to_meta);
    result
}

fn value_to_meta(value: Value) -> Option<Meta> {
    match value {
        Value::Object(map) => Some(Meta(map)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_names_use_stable_public_names() {
        let names = ObuServer::tools()
            .into_iter()
            .map(|tool| tool.name.into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            ["js", "browser_status", "js_reset", "js_add_module_dir"]
        );
    }
}

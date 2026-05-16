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
    CallToolRequestMethod, CallToolRequestParams, CallToolResult, ErrorData, Implementation,
    ListToolsResult, Meta, PaginatedRequestParams, ProgressNotificationParam, ServerCapabilities,
    ServerInfo, Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{ServerHandler, ServiceExt};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::cli::Cli;
use crate::repl_manager::{JsRuntimeManager, ManagerOptions};

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

static EMPTY_SCHEMA: LazyLock<Arc<rmcp::model::JsonObject>> = LazyLock::new(|| {
    Arc::new(schema_object(json!({
        "type": "object",
        "properties": {},
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
}

impl ObuServer {
    /// Construct a server around a runtime manager.
    pub fn new(runtime: Arc<JsRuntimeManager>) -> Self {
        Self { runtime }
    }

    fn tools() -> Vec<Tool> {
        vec![
            Tool::new("js", JS_TOOL_DESCRIPTION, JS_SCHEMA.clone()).with_title("JavaScript"),
            Tool::new(
                "js_reset",
                "Reset the persistent Node REPL kernel and clear JavaScript state.",
                EMPTY_SCHEMA.clone(),
            )
            .with_title("Reset JavaScript Kernel"),
            Tool::new(
                "js_add_module_dir",
                Cow::Borrowed("Authorize an additional absolute directory for module imports."),
                ADD_MODULE_DIR_SCHEMA.clone(),
            )
            .with_title("Add Module Directory"),
        ]
    }
}

impl ServerHandler for ObuServer {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
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
            "js_reset" => self.call_js_reset(arguments).await,
            "js_add_module_dir" => self.call_js_add_module_dir(arguments).await,
            _ => Err(ErrorData::method_not_found::<CallToolRequestMethod>()),
        }
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
        Ok(CallToolResult::structured(json!({
            "stdout": result.stdout,
            "stderr": result.stderr,
            "result": result.result,
            "duration_ms": result.duration_ms,
            "truncated": result.truncated,
            "displays": result.displays,
        })))
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
        Ok(CallToolResult::structured(json!({ "ok": true })))
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
        Ok(CallToolResult::structured(json!({ "ok": true })))
    }
}

/// Entry from `cli::run`.
pub async fn run_stdio_server_with_options(cli: Cli) -> Result<()> {
    let options = ManagerOptions::from_cli(&cli)?;
    let manager = Arc::new(JsRuntimeManager::new(options).await?);
    manager.boot().await?;

    let server = ObuServer::new(manager);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_names_use_stable_public_names() {
        let names = ObuServer::tools()
            .into_iter()
            .map(|tool| tool.name.into_owned())
            .collect::<Vec<_>>();
        assert_eq!(names, ["js", "js_reset", "js_add_module_dir"]);
    }
}

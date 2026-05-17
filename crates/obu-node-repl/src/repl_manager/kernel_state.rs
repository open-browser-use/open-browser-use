//! Kernel lifecycle and per-exec result types.

use serde_json::Value;

/// Coarse kernel lifecycle state.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum KernelState {
    /// No child running.
    #[default]
    Idle,
    /// Child process is starting.
    Spawning,
    /// Child reported readiness.
    Ready,
    /// One exec is active.
    Executing,
    /// Kernel is restarting.
    Restarting,
}

/// One `display()` entry captured for the final tool result.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct DisplayEntry {
    /// Milliseconds since exec start.
    pub at_ms: u64,
    /// Display kind: `text`, `json`, or `image`.
    #[serde(rename = "type")]
    pub kind: String,
    /// Display payload.
    pub value: Value,
}

/// Final execution result returned by `js`.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct JsExecResult {
    /// Captured `console.log`/`nodeRepl.write` output.
    pub stdout: String,
    /// Captured stderr. P1 keeps this empty because the kernel captures console
    /// diagnostics into stdout-compatible output events.
    pub stderr: String,
    /// Last expression value, serialized for JSON transport.
    pub result: Value,
    /// Duration measured by the JavaScript kernel in milliseconds.
    pub duration_ms: u64,
    /// Optional truncation metadata.
    pub truncated: TruncationInfo,
    /// Display entries emitted during this exec.
    pub displays: Vec<DisplayEntry>,
    /// Kernel-provided MCP response metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_meta: Option<Value>,
    /// JavaScript execution error. Transport, timeout, and kernel failures are still
    /// returned as Rust errors; this field is for user-code failures reported by
    /// the kernel.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Stream truncation metadata.
#[derive(Debug, Clone, Default, serde::Serialize, PartialEq, Eq)]
pub struct TruncationInfo {
    /// True when stdout was capped.
    pub stdout: bool,
    /// True when stderr was capped.
    pub stderr: bool,
    /// True when the final result was capped or summarized.
    pub result: bool,
    /// True when displays were capped or summarized.
    pub displays: bool,
}

/// In-flight exec accumulator.
#[derive(Debug, Default)]
pub struct ExecRegistry {
    /// Current exec id.
    pub exec_id: Option<String>,
    /// Displays captured for the active exec.
    pub displays: Vec<DisplayEntry>,
    /// Monotonic progress counter for future MCP streaming.
    pub progress_counter: u64,
}

impl ExecRegistry {
    /// Start tracking an exec.
    pub fn start(&mut self, exec_id: String) {
        self.exec_id = Some(exec_id);
        self.displays.clear();
        self.progress_counter = 0;
    }

    /// Finish and return captured displays.
    pub fn finish(&mut self) -> Vec<DisplayEntry> {
        self.exec_id = None;
        self.progress_counter = 0;
        std::mem::take(&mut self.displays)
    }
}

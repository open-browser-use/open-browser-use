//! Kernel lifecycle and per-exec result types.

use serde_json::Value;

/// Maximum number of `display()`/`emit_image` frames retained per exec, both in
/// the live accumulator (push-time bound, audit §4.3) and the returned payload.
pub const MAX_DISPLAY_COUNT: usize = 50;

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
    /// Last lifecycle attempt failed; kernel must re-boot before next exec.
    Failed,
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
    /// Display entries emitted during this exec (bounded at `MAX_DISPLAY_COUNT`).
    pub displays: Vec<DisplayEntry>,
    /// Total display frames emitted this exec, including any dropped past the cap.
    pub displays_total: u64,
    /// Kernel-provided MCP response metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_meta: Option<Value>,
    /// JavaScript execution error. Transport, timeout, and kernel failures are still
    /// returned as Rust errors; this field is for user-code failures reported by
    /// the kernel.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Structured JavaScript error detail when the thrown value exposed stable
    /// fields such as `code`, `data`, or `product_error`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_detail: Option<Value>,
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
    /// Displays captured for the active exec (bounded at `MAX_DISPLAY_COUNT`).
    pub displays: Vec<DisplayEntry>,
    /// Total display frames emitted this exec, including any dropped past the cap.
    pub displays_total: u64,
    /// Monotonic progress counter for future MCP streaming.
    pub progress_counter: u64,
}

impl ExecRegistry {
    /// Start tracking an exec.
    pub fn start(&mut self, exec_id: String) {
        self.exec_id = Some(exec_id);
        self.displays.clear();
        self.displays_total = 0;
        self.progress_counter = 0;
    }

    /// Record a display frame. Bounds the retained `Vec` at `MAX_DISPLAY_COUNT`
    /// (head-keeping — frames past the cap are counted but their payload dropped,
    /// audit §4.3) and returns the new progress counter.
    pub fn push_display(&mut self, entry: DisplayEntry) -> u64 {
        self.progress_counter += 1;
        self.displays_total += 1;
        if self.displays.len() < MAX_DISPLAY_COUNT {
            self.displays.push(entry);
        }
        self.progress_counter
    }

    /// Finish: return the retained displays plus the true total emitted this exec.
    pub fn finish(&mut self) -> (Vec<DisplayEntry>, u64) {
        self.exec_id = None;
        self.progress_counter = 0;
        let total = self.displays_total;
        self.displays_total = 0;
        (std::mem::take(&mut self.displays), total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn display(i: u64) -> DisplayEntry {
        DisplayEntry {
            at_ms: i,
            kind: "text".to_string(),
            value: json!(i),
        }
    }

    #[test]
    fn push_display_bounds_retained_frames_but_counts_total() {
        let mut registry = ExecRegistry::default();
        registry.start("exec-1".to_string());
        for i in 0..(MAX_DISPLAY_COUNT as u64 + 25) {
            registry.push_display(display(i));
        }
        assert_eq!(registry.displays.len(), MAX_DISPLAY_COUNT);
        assert_eq!(registry.displays.first().unwrap().value, json!(0));
        assert_eq!(
            registry.displays.last().unwrap().value,
            json!(MAX_DISPLAY_COUNT as u64 - 1)
        );
        assert_eq!(registry.displays_total, MAX_DISPLAY_COUNT as u64 + 25);

        let (displays, total) = registry.finish();
        assert_eq!(displays.len(), MAX_DISPLAY_COUNT);
        assert_eq!(total, MAX_DISPLAY_COUNT as u64 + 25);
        assert_eq!(registry.displays_total, 0);
        assert!(registry.displays.is_empty());
    }

    #[test]
    fn push_display_keeps_all_frames_exactly_at_cap() {
        let mut registry = ExecRegistry::default();
        registry.start("exec-1".to_string());
        for i in 0..(MAX_DISPLAY_COUNT as u64) {
            registry.push_display(display(i));
        }
        assert_eq!(registry.displays.len(), MAX_DISPLAY_COUNT);
        assert_eq!(registry.displays_total, MAX_DISPLAY_COUNT as u64);
        // one more frame is counted but not retained
        registry.push_display(display(MAX_DISPLAY_COUNT as u64));
        assert_eq!(registry.displays.len(), MAX_DISPLAY_COUNT);
        assert_eq!(registry.displays_total, MAX_DISPLAY_COUNT as u64 + 1);
    }

    #[test]
    fn start_resets_display_total() {
        let mut registry = ExecRegistry::default();
        registry.start("exec-1".to_string());
        registry.push_display(display(1));
        registry.start("exec-2".to_string());
        assert_eq!(registry.displays_total, 0);
        assert!(registry.displays.is_empty());
    }
}

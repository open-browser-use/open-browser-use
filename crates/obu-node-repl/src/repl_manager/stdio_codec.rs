//! Newline-delimited JSON over the Node child's stdio.
//!
//! This is intentionally separate from `obu-wire`'s length-prefixed codec: the
//! embedded JavaScript kernel reads and writes one JSON object per line.

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};

/// JSONL reader for kernel stdout.
pub struct StdioReader {
    inner: tokio::io::Lines<BufReader<ChildStdout>>,
}

impl StdioReader {
    /// Wrap child stdout.
    pub fn new(stdout: ChildStdout) -> Self {
        Self {
            inner: BufReader::new(stdout).lines(),
        }
    }

    /// Read the next JSON frame. Empty lines and non-JSON lines are dropped.
    pub async fn next(&mut self) -> std::io::Result<Option<Value>> {
        loop {
            let Some(line) = self.inner.next_line().await? else {
                return Ok(None);
            };
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str(&line) {
                Ok(value) => return Ok(Some(value)),
                Err(error) => {
                    tracing::warn!(%error, %line, "dropping non-JSON kernel stdout line");
                }
            }
        }
    }
}

/// JSONL writer for kernel stdin.
pub struct StdioWriter {
    inner: ChildStdin,
}

impl StdioWriter {
    /// Wrap child stdin.
    pub fn new(stdin: ChildStdin) -> Self {
        Self { inner: stdin }
    }

    /// Write a JSON frame followed by `\n`.
    pub async fn send(&mut self, value: &Value) -> std::io::Result<()> {
        let mut line = serde_json::to_vec(value).expect("JSON value serialization cannot fail");
        line.push(b'\n');
        self.inner.write_all(&line).await?;
        self.inner.flush().await
    }
}

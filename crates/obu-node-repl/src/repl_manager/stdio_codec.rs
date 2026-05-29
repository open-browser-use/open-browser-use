//! Newline-delimited JSON over the Node child's stdio.
//!
//! This is intentionally separate from `obu-wire`'s length-prefixed codec: the
//! embedded JavaScript kernel reads and writes one JSON object per line.

use serde::Serialize;
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
        // `Value` serialization is infallible.
        let line = encode_line(value).expect("JSON value serialization cannot fail");
        self.send_line(&line).await
    }

    /// Write an already-encoded JSONL line (including its trailing `\n`).
    pub(crate) async fn send_line(&mut self, line: &[u8]) -> std::io::Result<()> {
        self.inner.write_all(line).await?;
        self.inner.flush().await
    }
}

/// Serialize `message` straight to a newline-terminated JSON line, skipping the
/// intermediate `serde_json::Value` that callers holding a typed message would
/// otherwise allocate.
pub(crate) fn encode_line<T: Serialize + ?Sized>(message: &T) -> serde_json::Result<Vec<u8>> {
    let mut line = serde_json::to_vec(message)?;
    line.push(b'\n');
    Ok(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Serialize)]
    struct Frame {
        // declaration order is intentionally NOT alphabetical
        method: &'static str,
        id: u32,
    }

    #[test]
    fn encode_line_serializes_directly_and_terminates_with_newline() {
        let frame = Frame { method: "x", id: 1 };
        let line = encode_line(&frame).expect("frame serializes");
        assert_eq!(*line.last().unwrap(), b'\n');
        let text = std::str::from_utf8(&line[..line.len() - 1]).unwrap();
        // direct struct->bytes preserves declaration order ...
        assert_eq!(text, r#"{"method":"x","id":1}"#);
        // ... and is logically identical to the old to_value -> to_vec path.
        let direct: serde_json::Value = serde_json::from_str(text).unwrap();
        let via_value = serde_json::to_value(&frame).unwrap();
        assert_eq!(direct, via_value);
    }
}

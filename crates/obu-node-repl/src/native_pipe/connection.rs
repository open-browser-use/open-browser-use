//! A single native-pipe UnixStream connection owned by the broker.

use std::path::Path;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{
    UnixStream,
    unix::{OwnedReadHalf, OwnedWriteHalf},
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

const READ_CHUNK_BYTES: usize = 64 * 1024;
const MAX_AUTH_RESPONSE_BYTES: usize = 1024 * 1024;

/// Split UnixStream wrapper with cancellable reads.
pub struct NativePipeConnection {
    reader: Mutex<OwnedReadHalf>,
    writer: Mutex<OwnedWriteHalf>,
    cancel: CancellationToken,
}

impl NativePipeConnection {
    /// Connect to a Unix socket with a timeout.
    pub async fn connect(path: &Path, timeout: Duration) -> std::io::Result<Self> {
        let stream = tokio::time::timeout(timeout, UnixStream::connect(path))
            .await
            .map_err(|_| {
                std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "native pipe initial connect timed out",
                )
            })??;
        let (reader, writer) = stream.into_split();
        Ok(Self {
            reader: Mutex::new(reader),
            writer: Mutex::new(writer),
            cancel: CancellationToken::new(),
        })
    }

    /// Read one chunk, returning `Ok(None)` on EOF or cancellation.
    pub async fn read_chunk_or_cancel(&self) -> std::io::Result<Option<Vec<u8>>> {
        let mut buf = vec![0u8; READ_CHUNK_BYTES];
        let mut reader = self.reader.lock().await;
        tokio::select! {
            _ = self.cancel.cancelled() => Ok(None),
            result = reader.read(&mut buf) => {
                let n = result?;
                if n == 0 {
                    return Ok(None);
                }
                buf.truncate(n);
                Ok(Some(buf))
            }
        }
    }

    /// Write bytes to the connection.
    pub async fn write_all(&self, data: &[u8]) -> std::io::Result<()> {
        let mut writer = self.writer.lock().await;
        writer.write_all(data).await
    }

    /// Read one 4-byte little-endian length-prefixed frame body.
    pub async fn read_exact_framed(&self, timeout: Duration) -> std::io::Result<Vec<u8>> {
        let mut reader = self.reader.lock().await;
        let mut len_buf = [0u8; 4];
        tokio::time::timeout(timeout, reader.read_exact(&mut len_buf))
            .await
            .map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::TimedOut, "auth response timeout")
            })??;
        let len = u32::from_le_bytes(len_buf) as usize;
        if len > MAX_AUTH_RESPONSE_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "auth response frame too large",
            ));
        }
        let mut body = vec![0u8; len];
        tokio::time::timeout(timeout, reader.read_exact(&mut body))
            .await
            .map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::TimedOut, "auth response body timeout")
            })??;
        Ok(body)
    }

    /// Cancel reads and shutdown the write half.
    pub async fn shutdown(&self) -> std::io::Result<()> {
        self.cancel.cancel();
        let mut writer = self.writer.lock().await;
        writer.shutdown().await
    }
}

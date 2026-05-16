//! Platform-abstracted local socket listener.

use std::path::PathBuf;

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncWrite};

use crate::error::Result;

#[cfg(unix)]
pub mod unix;

/// A connected peer accepted by a local listener.
pub struct Peer<S: AsyncRead + AsyncWrite + Send + Unpin + 'static> {
    /// Bidirectional stream for the connected peer.
    pub stream: S,
    /// OS credential. Phase 2 populates this during peer authentication.
    pub cred: Option<PeerCred>,
}

/// OS-level credential of a connecting peer.
#[derive(Debug, Clone)]
pub enum PeerCred {
    /// Unix peer uid/gid/pid.
    Unix {
        /// User id.
        uid: u32,
        /// Group id.
        gid: u32,
        /// Process id.
        pid: i32,
    },
    /// macOS audit token, kept opaque until SecCode validation.
    AuditToken {
        /// Raw 32-byte audit token as eight u32 words.
        token: [u32; 8],
    },
    /// Windows SID plus process id.
    Windows {
        /// String form of the user's SID.
        sid: String,
        /// Process id.
        pid: u32,
    },
}

/// Platform-neutral listener trait.
#[async_trait]
pub trait Listener: Send {
    /// Stream type yielded by this listener.
    type Stream: AsyncRead + AsyncWrite + Send + Unpin + 'static;

    /// Filesystem path or named-pipe path backing this listener.
    fn path(&self) -> &std::path::Path;

    /// Accept one peer.
    async fn accept(&mut self) -> Result<Peer<Self::Stream>>;
}

/// Resolve the default socket path for the current OS and session id.
pub fn default_socket_path(session_id: &str) -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        if let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") {
            return PathBuf::from(xdg)
                .join("obu")
                .join(format!("{session_id}.sock"));
        }
        return PathBuf::from("/tmp/obu").join(format!("{session_id}.sock"));
    }
    #[cfg(target_os = "macos")]
    {
        PathBuf::from("/tmp/obu").join(format!("{session_id}.sock"))
    }
    #[cfg(windows)]
    {
        PathBuf::from(format!(r"\\.\pipe\obu-{session_id}"))
    }
}

//! Peer authentication.

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncWrite};

use crate::error::Result;
use crate::socket::Peer;

pub mod allow_list;

#[cfg(unix)]
pub mod unix;

/// Peer-auth operating mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerAuthMode {
    /// Default mode. Phase 2 macOS signing checks refine this later.
    Auto,
    /// Strict mode. For the current Unix UID gate this is equivalent to auto.
    Strict,
    /// Disable peer auth. Intended only for local debugging.
    Off,
}

impl PeerAuthMode {
    /// Parse a CLI/env value.
    pub fn parse(raw: &str) -> Self {
        match raw {
            "strict" => Self::Strict,
            "off" => Self::Off,
            _ => Self::Auto,
        }
    }
}

/// Implemented by platform-specific peer-auth gates.
///
/// The stream type is on the trait so callers can use trait objects such as
/// `Box<dyn PeerAuthGate<tokio::net::UnixStream>>`.
#[async_trait]
pub trait PeerAuthGate<S>: Send + Sync
where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    /// Inspect and annotate the peer, or reject it.
    async fn authorize(&self, peer: &mut Peer<S>) -> Result<()>;
}

/// Constant-time capability token comparison.
pub fn check_capability_token(expected: Option<&str>, presented: Option<&str>) -> bool {
    match (expected, presented) {
        (None, _) => true,
        (Some(expected), Some(presented)) => {
            constant_time_eq(expected.as_bytes(), presented.as_bytes())
        }
        (Some(_), None) => false,
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let max = left.len().max(right.len());
    let mut diff = left.len() ^ right.len();
    for index in 0..max {
        let a = left.get(index).copied().unwrap_or(0);
        let b = right.get(index).copied().unwrap_or(0);
        diff |= usize::from(a ^ b);
    }
    diff == 0
}

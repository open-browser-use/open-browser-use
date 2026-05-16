//! Unix peer-auth gate.

use std::os::fd::AsRawFd;

use async_trait::async_trait;
use tokio::net::UnixStream;

use crate::error::{HostError, Result};
use crate::peer_auth::{PeerAuthGate, PeerAuthMode};
use crate::socket::{Peer, PeerCred};

/// Same-user Unix peer-auth gate.
pub struct UnixPeerAuthGate {
    expected_uid: u32,
    mode: PeerAuthMode,
}

impl UnixPeerAuthGate {
    /// Create a gate that accepts peers from the current effective uid.
    pub fn new(mode: PeerAuthMode) -> Self {
        if mode == PeerAuthMode::Off {
            tracing::warn!("OBU_PEER_AUTH=off: peer-auth is disabled");
        }
        Self {
            expected_uid: current_uid(),
            mode,
        }
    }
}

#[async_trait]
impl PeerAuthGate<UnixStream> for UnixPeerAuthGate {
    /// Authorize and annotate a Unix peer.
    async fn authorize(&self, peer: &mut Peer<UnixStream>) -> Result<()> {
        if self.mode == PeerAuthMode::Off {
            return Ok(());
        }

        let cred = peer_cred(peer.stream.as_raw_fd())?;
        let uid = match cred {
            PeerCred::Unix { uid, .. } => uid,
            PeerCred::AuditToken { .. } | PeerCred::Windows { .. } => {
                return Err(HostError::PeerAuthRefused(
                    "unexpected non-Unix credential".into(),
                ));
            }
        };
        if uid != self.expected_uid {
            return Err(HostError::PeerAuthRefused(format!(
                "uid mismatch: got {uid}, want {}",
                self.expected_uid
            )));
        }
        peer.cred = Some(cred);
        Ok(())
    }
}

fn current_uid() -> u32 {
    unsafe { libc::geteuid() }
}

#[cfg(target_os = "linux")]
fn peer_cred(fd: std::os::fd::RawFd) -> Result<PeerCred> {
    let mut cred = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut _ as *mut libc::c_void,
            &mut len,
        )
    };
    if rc != 0 {
        return Err(HostError::PeerAuthRefused(format!(
            "SO_PEERCRED failed: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(PeerCred::Unix {
        uid: cred.uid,
        gid: cred.gid,
        pid: cred.pid,
    })
}

#[cfg(target_os = "macos")]
fn peer_cred(fd: std::os::fd::RawFd) -> Result<PeerCred> {
    let mut uid = 0;
    let mut gid = 0;
    let rc = unsafe { libc::getpeereid(fd, &mut uid, &mut gid) };
    if rc != 0 {
        return Err(HostError::PeerAuthRefused(format!(
            "getpeereid failed: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(PeerCred::Unix { uid, gid, pid: -1 })
}

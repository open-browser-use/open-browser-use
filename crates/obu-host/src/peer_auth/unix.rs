//! Unix peer-auth gate.

use std::os::fd::AsRawFd;

use async_trait::async_trait;
use tokio::net::UnixStream;

use crate::error::{HostError, Result};
use crate::peer_auth::{PeerAuthGate, PeerAuthMode};
use crate::peer_lifecycle::{
    PeerLifecycleDiagnostics, PeerOsCredentialObservation, peer_credential_observation,
    plan_peer_os_credential_auth,
};
use crate::socket::{Peer, PeerCred};

/// Same-user Unix peer-auth gate.
pub struct UnixPeerAuthGate {
    expected_uid: u32,
    mode: PeerAuthMode,
    diagnostics: PeerLifecycleDiagnostics,
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
            diagnostics: PeerLifecycleDiagnostics::default(),
        }
    }

    /// Create a gate that records peer auth decisions into shared diagnostics.
    pub fn new_with_diagnostics(mode: PeerAuthMode, diagnostics: PeerLifecycleDiagnostics) -> Self {
        if mode == PeerAuthMode::Off {
            tracing::warn!("OBU_PEER_AUTH=off: peer-auth is disabled");
        }
        Self {
            expected_uid: current_uid(),
            mode,
            diagnostics,
        }
    }
}

#[async_trait]
impl PeerAuthGate<UnixStream> for UnixPeerAuthGate {
    /// Authorize and annotate a Unix peer.
    async fn authorize(&self, peer: &mut Peer<UnixStream>) -> Result<()> {
        if self.mode == PeerAuthMode::Off {
            let plan = plan_peer_os_credential_auth(
                self.expected_uid,
                PeerOsCredentialObservation::AuthDisabled,
            );
            trace_peer_os_credential_plan(&plan);
            self.diagnostics.record(&plan.event);
            return Ok(());
        }

        let cred = match peer_cred(peer.stream.as_raw_fd()) {
            Ok(cred) => cred,
            Err(error) => {
                let plan = plan_peer_os_credential_auth(
                    self.expected_uid,
                    PeerOsCredentialObservation::CredentialReadFailed {
                        reason: peer_auth_error_reason(&error),
                    },
                );
                trace_peer_os_credential_plan(&plan);
                self.diagnostics.record(&plan.event);
                return Err(error);
            }
        };
        let plan =
            plan_peer_os_credential_auth(self.expected_uid, peer_credential_observation(&cred));
        trace_peer_os_credential_plan(&plan);
        self.diagnostics.record(&plan.event);
        if let Some(error_message) = plan.error_message {
            return Err(HostError::PeerAuthRefused(error_message));
        }
        if plan.annotate_peer {
            peer.cred = Some(cred);
        }
        Ok(())
    }
}

fn peer_auth_error_reason(error: &HostError) -> String {
    match error {
        HostError::PeerAuthRefused(reason) => reason.clone(),
        _ => error.to_string(),
    }
}

fn trace_peer_os_credential_plan(plan: &crate::peer_lifecycle::PeerOsCredentialAuthPlan) {
    tracing::debug!(
        event = ?plan.event.kind,
        accepted = plan.accepted,
        reason = plan.event.reason.as_deref(),
        "peer lifecycle"
    );
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

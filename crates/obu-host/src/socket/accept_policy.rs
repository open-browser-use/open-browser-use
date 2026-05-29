//! Classification policy for `Listener::accept()` errors.
//!
//! A single transient `accept()` failure must not tear down the whole broker
//! (audit §4.5). `EMFILE`/`ENFILE` arise organically under heavy fd load and
//! `ECONNABORTED` is normal churn; all are self-resolving, so the accept loop
//! logs and continues instead of `?`-propagating out of `main`.

use crate::error::HostError;

/// What the accept loop should do after `accept()` returns an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcceptErrorAction {
    /// Transient (peer aborted, interrupted) — log and re-accept immediately.
    RetryImmediate,
    /// Resource exhaustion (per-process/system fd limit) — back off, then re-accept.
    RetryBackoff,
    /// The listener itself is unusable — propagate and terminate the broker.
    Fatal,
}

/// Decide how the accept loop should react to an `accept()` error.
///
/// Scope: the host listener is unix-domain today, so only UDS-relevant error
/// kinds are treated as retryable. If this is ever reused for a TCP/remote
/// transport, revisit transient network kinds (`ConnectionReset`, `TimedOut`,
/// `HostUnreachable`, `NetworkUnreachable`), which currently fall through to
/// `Fatal`.
pub fn classify_accept_error(error: &HostError) -> AcceptErrorAction {
    let io_error = match error {
        HostError::Io(io_error) => io_error,
        // accept() only ever surfaces wrapped io errors; anything else is unexpected.
        _ => return AcceptErrorAction::Fatal,
    };

    use std::io::ErrorKind;
    match io_error.kind() {
        // NB: tokio's UnixListener::accept already retries WouldBlock internally,
        // so WouldBlock never reaches us via accept().await; this arm is kept only
        // for completeness and is exercised solely by the unit test.
        ErrorKind::ConnectionAborted | ErrorKind::Interrupted | ErrorKind::WouldBlock => {
            AcceptErrorAction::RetryImmediate
        }
        // EMFILE/ENFILE map to `Uncategorized` in stable Rust, so match the raw errno.
        _ => match io_error.raw_os_error() {
            Some(code) if code == libc::EMFILE || code == libc::ENFILE => {
                AcceptErrorAction::RetryBackoff
            }
            _ => AcceptErrorAction::Fatal,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[test]
    fn transient_peer_errors_retry_immediately() {
        for kind in [
            io::ErrorKind::ConnectionAborted,
            io::ErrorKind::Interrupted,
            io::ErrorKind::WouldBlock,
        ] {
            let error = HostError::Io(io::Error::from(kind));
            assert_eq!(
                classify_accept_error(&error),
                AcceptErrorAction::RetryImmediate
            );
        }
    }

    #[test]
    fn fd_exhaustion_backs_off() {
        for code in [libc::EMFILE, libc::ENFILE] {
            let error = HostError::Io(io::Error::from_raw_os_error(code));
            assert_eq!(
                classify_accept_error(&error),
                AcceptErrorAction::RetryBackoff
            );
        }
    }

    #[test]
    fn broken_listener_and_non_io_errors_are_fatal() {
        let broken = HostError::Io(io::Error::from(io::ErrorKind::NotConnected));
        assert_eq!(classify_accept_error(&broken), AcceptErrorAction::Fatal);
        let non_io = HostError::Protocol("listener gone".into());
        assert_eq!(classify_accept_error(&non_io), AcceptErrorAction::Fatal);
        // An arbitrary non-exhaustion errno falls through to Fatal (pins the
        // raw_os_error() `_` arm, distinct from the NotConnected *kind* path).
        let unknown_errno = HostError::Io(io::Error::from_raw_os_error(libc::EACCES));
        assert_eq!(
            classify_accept_error(&unknown_errno),
            AcceptErrorAction::Fatal
        );
    }
}

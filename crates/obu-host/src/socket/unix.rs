//! Unix-domain-socket listener for Linux and macOS.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use tokio::net::{UnixListener, UnixStream};

use crate::error::Result;
use crate::socket::{Listener, Peer};

/// Unix-domain-socket listener.
pub struct UnixSockListener {
    listener: UnixListener,
    path: PathBuf,
}

impl UnixSockListener {
    /// Bind a listener at `path`.
    ///
    /// Parent directories are created as `0o700`. Existing live listeners are
    /// preserved and reported as `AddrInUse`; stale socket files are removed
    /// only after a connect probe proves they are not live.
    pub fn bind(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
            }
        }

        prepare_socket_path(path)?;

        let listener = bind_owner_only(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }

        Ok(Self {
            listener,
            path: path.to_path_buf(),
        })
    }
}

impl Drop for UnixSockListener {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[async_trait]
impl Listener for UnixSockListener {
    type Stream = UnixStream;

    fn path(&self) -> &Path {
        &self.path
    }

    async fn accept(&mut self) -> Result<Peer<Self::Stream>> {
        let (stream, _addr) = self.listener.accept().await?;
        Ok(Peer { stream, cred: None })
    }
}

fn bind_owner_only(path: &Path) -> std::io::Result<UnixListener> {
    let prev = unsafe { libc::umask(0o177) };
    let result = UnixListener::bind(path);
    unsafe {
        libc::umask(prev);
    }
    result
}

fn prepare_socket_path(path: &Path) -> Result<()> {
    use std::os::unix::fs::FileTypeExt;

    match std::os::unix::net::UnixStream::connect(path) {
        Ok(_) => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                format!(
                    "socket path already has a live listener: {}",
                    path.display()
                ),
            )
            .into());
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::ConnectionRefused => {}
        Err(err) => {
            if !path.exists() {
                return Ok(());
            }
            return Err(err.into());
        }
    }

    if !path.try_exists()? {
        return Ok(());
    }

    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.file_type().is_socket() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("socket path exists and is not a socket: {}", path.display()),
        )
        .into());
    }

    std::fs::remove_file(path)?;
    Ok(())
}

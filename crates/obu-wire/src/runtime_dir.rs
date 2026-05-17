//! Runtime directory resolution and owner-only validation.

use std::io;
use std::path::{Path, PathBuf};

/// Resolve the open-browser-use runtime directory from environment and platform defaults.
///
/// Resolution order:
/// 1. `OBU_RUNTIME_DIR`
/// 2. Linux `XDG_RUNTIME_DIR/obu`
/// 3. `/tmp/obu-<uid>` on Unix platforms
pub fn resolve_runtime_dir() -> PathBuf {
    if let Some(value) = std::env::var_os("OBU_RUNTIME_DIR") {
        return PathBuf::from(value);
    }
    platform_default_runtime_dir()
}

/// Return the platform default runtime directory without reading `OBU_RUNTIME_DIR`.
pub fn platform_default_runtime_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        if let Some(value) = std::env::var_os("XDG_RUNTIME_DIR") {
            return PathBuf::from(value).join("obu");
        }
    }
    #[cfg(unix)]
    {
        PathBuf::from("/tmp").join(format!("obu-{}", current_uid_label()))
    }
    #[cfg(not(unix))]
    {
        std::env::temp_dir().join(format!("obu-{}", current_uid_label()))
    }
}

/// Ensure `path` exists as an owner-only directory and then validate it.
pub fn ensure_owner_only_dir(path: &Path) -> io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            repair_owner_only_dir(path, &metadata)?;
            validate_owner_only_dir(path)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            std::fs::create_dir_all(path)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
            }
            validate_owner_only_dir(path)
        }
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn repair_owner_only_dir(path: &Path, metadata: &std::fs::Metadata) -> io::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    if metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "runtime directory is a symlink",
        ));
    }
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "runtime path is not a directory",
        ));
    }
    let uid = current_uid()?;
    if metadata.uid() != uid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "runtime directory is not owned by current user",
        ));
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn repair_owner_only_dir(_path: &Path, _metadata: &std::fs::Metadata) -> io::Result<()> {
    Ok(())
}

/// Validate that an existing runtime directory is not a symlink, is owned by the
/// current user, and is not readable or writable by group/other users.
pub fn validate_owner_only_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = std::fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "runtime directory is a symlink",
            ));
        }
        if !metadata.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "runtime path is not a directory",
            ));
        }
        let uid = current_uid()?;
        if metadata.uid() != uid {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "runtime directory is not owned by current user",
            ));
        }
        let mode = metadata.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "runtime directory permissions must be owner-only",
            ));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

#[cfg(unix)]
fn current_uid() -> io::Result<u32> {
    let output = std::process::Command::new("id").arg("-u").output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "id -u failed with status {}",
            output.status
        )));
    }
    let raw = std::str::from_utf8(&output.stdout)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?
        .trim();
    raw.parse::<u32>()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn current_uid_label() -> String {
    #[cfg(unix)]
    {
        current_uid()
            .map(|uid| uid.to_string())
            .unwrap_or_else(|_| "unknown".to_string())
    }
    #[cfg(not(unix))]
    {
        "unknown".to_string()
    }
}

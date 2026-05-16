//! Local development trust gate.

use std::path::{Path, PathBuf};

use super::TrustGate;

/// Trusts modules under configured local development directories.
pub struct LocalDevTrust {
    dirs: Vec<PathBuf>,
}

impl LocalDevTrust {
    /// Defaults to `~/.obu/skills` and current working directory.
    pub fn default_dirs() -> Self {
        let mut dirs = Vec::new();
        if let Some(home) = dirs::home_dir() {
            dirs.push(home.join(".obu").join("skills"));
        }
        if let Ok(cwd) = std::env::current_dir() {
            dirs.push(cwd);
        }
        Self { dirs }
    }

    /// Construct with explicit directories.
    pub fn with_dirs(dirs: Vec<PathBuf>) -> Self {
        Self { dirs }
    }
}

impl TrustGate for LocalDevTrust {
    fn is_trusted(&self, _source: &[u8], path: &Path) -> bool {
        let Ok(canonical_path) = path.canonicalize() else {
            return false;
        };
        self.dirs.iter().any(|dir| {
            dir.canonicalize()
                .map(|canonical_dir| {
                    canonical_path == canonical_dir || canonical_path.starts_with(canonical_dir)
                })
                .unwrap_or(false)
        })
    }
}

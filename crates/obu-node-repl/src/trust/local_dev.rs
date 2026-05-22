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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trusts_configured_dir_and_files_under_it() {
        let trusted = tempfile::tempdir().unwrap();
        let nested = trusted.path().join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let module = nested.join("tool.mjs");
        std::fs::write(&module, b"export {};").unwrap();

        let gate = LocalDevTrust::with_dirs(vec![trusted.path().to_path_buf()]);

        assert!(gate.is_trusted(b"", trusted.path()));
        assert!(gate.is_trusted(b"export {};", &module));
    }

    #[test]
    fn rejects_paths_outside_configured_dirs() {
        let trusted = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_module = outside.path().join("tool.mjs");
        std::fs::write(&outside_module, b"export {};").unwrap();

        let gate = LocalDevTrust::with_dirs(vec![trusted.path().to_path_buf()]);

        assert!(!gate.is_trusted(b"export {};", &outside_module));
    }

    #[test]
    fn rejects_missing_paths_and_unresolvable_trusted_dirs() {
        let temp = tempfile::tempdir().unwrap();
        let existing_module = temp.path().join("tool.mjs");
        std::fs::write(&existing_module, b"export {};").unwrap();
        let missing_module = temp.path().join("missing.mjs");
        let missing_trusted_dir = temp.path().join("missing-trusted-dir");

        let gate = LocalDevTrust::with_dirs(vec![missing_trusted_dir]);

        assert!(!gate.is_trusted(b"export {};", &existing_module));
        assert!(!gate.is_trusted(b"export {};", &missing_module));
    }
}

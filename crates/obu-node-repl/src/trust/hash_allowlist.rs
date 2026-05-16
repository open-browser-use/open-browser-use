//! Default hash and directory allowlist trust gate.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::TrustGate;

/// Hash allowlist plus trusted directory roots.
pub struct HashAllowlistTrust {
    hashes: HashSet<String>,
    dirs: Vec<PathBuf>,
    trust_all: bool,
}

impl HashAllowlistTrust {
    /// Construct an empty gate.
    pub fn empty() -> Self {
        Self {
            hashes: HashSet::new(),
            dirs: Vec::new(),
            trust_all: false,
        }
    }

    /// Build from OBU trust environment variables.
    pub fn from_env() -> Self {
        let mut trust = Self::empty();
        if std::env::var("OBU_TRUST_ALL_CODE").as_deref() == Ok("1") {
            trust.trust_all = true;
            return trust;
        }
        if let Ok(raw) = std::env::var("OBU_TRUSTED_MODULE_SHA256S") {
            trust.hashes.extend(
                raw.split(':')
                    .filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()))
                    .map(str::to_lowercase),
            );
        }
        if let Ok(raw) = std::env::var("OBU_TRUSTED_CODE_PATHS") {
            trust.dirs.extend(
                raw.split(':')
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from)
                    .filter(|path| path.is_absolute()),
            );
        }
        trust
    }

    /// Construct from hash strings.
    pub fn from_hashes<'a, I>(hashes: I) -> Self
    where
        I: IntoIterator<Item = &'a str>,
    {
        let mut trust = Self::empty();
        trust
            .hashes
            .extend(hashes.into_iter().map(str::to_lowercase));
        trust
    }

    /// Construct from hashes and directories.
    pub fn with_dirs<H, S, D>(hashes: H, dirs: D) -> Self
    where
        H: IntoIterator<Item = S>,
        S: AsRef<str>,
        D: IntoIterator<Item = PathBuf>,
    {
        let mut trust = Self::empty();
        trust
            .hashes
            .extend(hashes.into_iter().map(|hash| hash.as_ref().to_lowercase()));
        trust.dirs.extend(dirs);
        trust
    }

    /// Construct a gate that trusts every module.
    pub fn trust_all() -> Self {
        Self {
            hashes: HashSet::new(),
            dirs: Vec::new(),
            trust_all: true,
        }
    }

    /// Append a trusted directory.
    pub fn add_dir(&mut self, dir: PathBuf) {
        if dir.is_absolute() && !self.dirs.contains(&dir) {
            self.dirs.push(dir);
        }
    }

    /// Append a trusted hash.
    pub fn add_hash(&mut self, hex_digest: String) {
        let digest = hex_digest.to_lowercase();
        if digest.len() == 64 && digest.chars().all(|c| c.is_ascii_hexdigit()) {
            self.hashes.insert(digest);
        }
    }
}

impl Default for HashAllowlistTrust {
    fn default() -> Self {
        Self::from_env()
    }
}

impl TrustGate for HashAllowlistTrust {
    fn is_trusted(&self, source: &[u8], path: &Path) -> bool {
        if self.trust_all {
            return true;
        }

        let mut hasher = Sha256::new();
        hasher.update(source);
        let digest = hex::encode(hasher.finalize());
        if self.hashes.contains(&digest) {
            return true;
        }

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
    use std::path::Path;

    use sha2::{Digest, Sha256};

    use super::*;

    #[test]
    fn trusts_matching_hash() {
        let src = b"export const x = 1;";
        let mut hasher = Sha256::new();
        hasher.update(src);
        let hex = hex::encode(hasher.finalize());

        let gate = HashAllowlistTrust::from_hashes([hex.as_str()]);
        assert!(gate.is_trusted(src, Path::new("/anywhere/x.js")));
    }

    #[test]
    fn trusts_path_under_trusted_dir() {
        let dir = std::env::temp_dir().join("obu-trust-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("inner.js");
        std::fs::write(&file, b"export {};").unwrap();

        let gate = HashAllowlistTrust::with_dirs(std::iter::empty::<&str>(), [dir]);
        assert!(gate.is_trusted(b"export {};", &file));
        assert!(!gate.is_trusted(b"export {};", Path::new("/elsewhere/x.js")));
    }

    #[test]
    fn trust_all_overrides() {
        let gate = HashAllowlistTrust::trust_all();
        assert!(gate.is_trusted(b"anything", Path::new("/random/x.js")));
    }
}

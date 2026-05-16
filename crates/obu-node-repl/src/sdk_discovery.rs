//! SDK trust-root discovery.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Deserialize)]
struct VersionJson {
    #[serde(rename = "sdkVersion")]
    version: Option<String>,
    sha256: String,
    #[serde(rename = "signedAt", default)]
    _signed_at: Option<String>,
}

/// Result of SDK discovery.
#[derive(Debug, Clone)]
pub struct SdkInfo {
    /// Declared SDK version.
    pub version: Option<String>,
    /// Hex-encoded SHA-256 of the SDK entrypoint.
    pub hash: String,
    /// Directory to trust.
    pub dir: PathBuf,
}

/// Discover and verify an `@open-browser-use/sdk` installation rooted at `root`.
pub fn discover_at(root: &Path) -> Result<SdkInfo> {
    let package_json = root.join("package.json");
    std::fs::read_to_string(&package_json)
        .with_context(|| format!("read {}", package_json.display()))?;

    let dist = root.join("dist");
    let entry = dist.join("index.mjs");
    let entry_bytes = std::fs::read(&entry).with_context(|| format!("read {}", entry.display()))?;

    let version_json_path = dist.join("version.json");
    let version_json_raw = std::fs::read_to_string(&version_json_path)
        .with_context(|| format!("read {}", version_json_path.display()))?;
    let version_json: VersionJson = serde_json::from_str(&version_json_raw)
        .with_context(|| format!("parse {}", version_json_path.display()))?;

    let mut hasher = Sha256::new();
    hasher.update(&entry_bytes);
    let actual = hex::encode(hasher.finalize());

    if !ct_eq(actual.as_bytes(), version_json.sha256.as_bytes()) {
        return Err(anyhow!(
            "@open-browser-use/sdk at {} has hash {} but version.json declares {}",
            root.display(),
            actual,
            version_json.sha256
        ));
    }

    Ok(SdkInfo {
        version: version_json.version,
        hash: actual,
        dir: root.to_path_buf(),
    })
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

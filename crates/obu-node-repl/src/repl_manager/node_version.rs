//! Detect and validate the Node runtime version.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, anyhow};

/// SemVer triple for Node versions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct NodeVersion {
    /// Major version.
    pub major: u32,
    /// Minor version.
    pub minor: u32,
    /// Patch version.
    pub patch: u32,
}

impl NodeVersion {
    /// Construct a version triple.
    pub fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }

    /// Parse a `vX.Y.Z` string emitted by `node --version`.
    pub fn parse(raw: &str) -> Result<Self> {
        let trimmed = raw.trim().trim_start_matches('v');
        let mut parts = trimmed.split('.');
        let major: u32 = parts
            .next()
            .ok_or_else(|| anyhow!("missing major version"))?
            .parse()
            .context("invalid major version")?;
        let minor: u32 = parts
            .next()
            .ok_or_else(|| anyhow!("missing minor version"))?
            .parse()
            .context("invalid minor version")?;
        let patch_raw = parts
            .next()
            .ok_or_else(|| anyhow!("missing patch version"))?;
        let patch: u32 = patch_raw
            .split('-')
            .next()
            .unwrap_or("0")
            .parse()
            .context("invalid patch version")?;
        Ok(Self::new(major, minor, patch))
    }
}

impl std::fmt::Display for NodeVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "v{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// Minimum supported runtime. Node 22.22.0 is the open-browser-use floor, matching
/// Codex's verified production floor for the same Node VM features.
pub fn required_node_version() -> NodeVersion {
    NodeVersion::new(22, 22, 0)
}

/// Run `node --version` and parse stdout.
pub fn read_node_version(node_path: &Path) -> Result<NodeVersion> {
    let output = Command::new(node_path).arg("--version").output()?;
    if !output.status.success() {
        return Err(anyhow!(
            "node --version exited with {:?}",
            output.status.code()
        ));
    }
    NodeVersion::parse(&String::from_utf8_lossy(&output.stdout))
}

/// Resolve Node from `OBU_NODE_BINARY` or PATH.
pub fn resolve_node() -> Result<PathBuf> {
    if let Some(env_path) = std::env::var_os("OBU_NODE_BINARY") {
        return Ok(PathBuf::from(env_path));
    }
    which::which("node")
        .map_err(|_| anyhow!("Node runtime not found; install Node or set OBU_NODE_BINARY"))
}

/// Resolve and verify the runtime is at least `required_node_version`.
pub fn resolve_compatible_node() -> Result<(PathBuf, NodeVersion)> {
    let path = resolve_node()?;
    let version = read_node_version(&path)?;
    let required = required_node_version();
    if version < required {
        return Err(anyhow!(
            "Node {} is too old; obu-node-repl requires Node {} or newer",
            version,
            required
        ));
    }
    Ok((path, version))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_v22_22_0() {
        let v = NodeVersion::parse("v22.22.0").unwrap();
        assert_eq!(v, NodeVersion::new(22, 22, 0));
    }

    #[test]
    fn rejects_truncated() {
        assert!(NodeVersion::parse("v22").is_err());
    }

    #[test]
    fn required_matches_verified_floor() {
        assert_eq!(required_node_version(), NodeVersion::new(22, 22, 0));
    }
}

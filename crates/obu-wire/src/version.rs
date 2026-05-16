//! Host and extension version-handshake types.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Strict `MAJOR.MINOR.PATCH` version used in compatibility frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(into = "String", try_from = "String")]
pub struct MinVersion {
    /// Major version.
    pub major: u32,
    /// Minor version.
    pub minor: u32,
    /// Patch version.
    pub patch: u32,
}

/// Version parse error.
#[derive(Debug, Error)]
#[error("invalid semver: {0}")]
pub struct ParseError(String);

impl FromStr for MinVersion {
    type Err = ParseError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let mut parts = s.split('.');
        let major = parts
            .next()
            .and_then(|part| part.parse().ok())
            .ok_or_else(|| ParseError(s.into()))?;
        let minor = parts
            .next()
            .and_then(|part| part.parse().ok())
            .ok_or_else(|| ParseError(s.into()))?;
        let patch = parts
            .next()
            .and_then(|part| part.parse().ok())
            .ok_or_else(|| ParseError(s.into()))?;
        if parts.next().is_some() {
            return Err(ParseError(s.into()));
        }
        Ok(Self {
            major,
            minor,
            patch,
        })
    }
}

impl fmt::Display for MinVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

impl From<MinVersion> for String {
    fn from(value: MinVersion) -> Self {
        value.to_string()
    }
}

impl TryFrom<String> for MinVersion {
    type Error = ParseError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse()
    }
}

/// Extension-to-host hello frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename = "hello", tag = "type")]
pub struct Hello {
    /// Extension build semver.
    pub extension_version: MinVersion,
    /// Browser manifest version.
    pub manifest_version: u8,
    /// Minimum compatible host version.
    pub min_host_version: MinVersion,
}

/// Host-to-extension hello acknowledgement.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename = "hello_ack", tag = "type")]
pub struct HelloAck {
    /// Host build semver.
    pub host_version: MinVersion,
    /// Minimum compatible extension version.
    pub min_extension_version: MinVersion,
}

/// Version mismatch frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename = "version_mismatch", tag = "type")]
pub struct VersionMismatch {
    /// Human-readable recovery instructions.
    pub message: String,
}

//! Per-session MCP artifact storage.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result, anyhow};
use base64::Engine;
use obu_wire::runtime_dir::{ensure_owner_only_dir, resolve_runtime_dir};
use rmcp::model::{RawResource, Resource, ResourceContents};
use serde::Serialize;
use uuid::Uuid;

const ARTIFACT_TTL: Duration = Duration::from_secs(60 * 60);
/// Largest artifact the MCP store will persist from one result payload.
pub const MAX_ARTIFACT_BYTES: usize = 8 * 1024 * 1024;
/// Markerless sibling dirs younger than this are left alone by the startup reaper.
const REAP_GRACE_SECS: u64 = 600;

/// Compact artifact reference returned in structured tool output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArtifactSummary {
    /// Stable discriminator for agents.
    pub kind: &'static str,
    /// MCP resource URI.
    pub uri: String,
    /// MIME type.
    pub mime_type: String,
    /// Raw byte length before base64 transport encoding.
    pub bytes: usize,
    /// Human-readable description.
    pub summary: String,
}

#[derive(Debug, Clone)]
struct ArtifactRecord {
    uri: String,
    path: PathBuf,
    mime_type: String,
    bytes: usize,
    summary: String,
    created_at: SystemTime,
}

/// Owner-only artifact store scoped to one MCP server session.
#[derive(Debug, Clone)]
pub struct ArtifactStore {
    root: Arc<PathBuf>,
    records: Arc<StdMutex<HashMap<String, ArtifactRecord>>>,
}

impl ArtifactStore {
    /// Create a per-session artifact store.
    pub fn new(session_id: &str) -> Result<Self> {
        Self::new_under_runtime(&resolve_runtime_dir(), session_id)
    }

    #[cfg(test)]
    pub(crate) fn new_at(root: &Path, session_id: &str) -> Result<Self> {
        Self::new_with_root(root.join(sanitize_path_component(session_id)))
    }

    fn new_under_runtime(runtime_root: &Path, session_id: &str) -> Result<Self> {
        let artifact_root = runtime_root.join("mcp-artifacts");
        ensure_owner_only_dir(runtime_root)
            .with_context(|| format!("ensure owner-only runtime dir {}", runtime_root.display()))?;
        ensure_owner_only_dir(&artifact_root).with_context(|| {
            format!(
                "ensure owner-only artifact root {}",
                artifact_root.display()
            )
        })?;
        let sanitized = sanitize_path_component(session_id);
        let session_root = artifact_root.join(&sanitized);
        let store = Self::new_with_root(session_root.clone())?;
        // Best-effort: record our liveness marker, then reap orphaned sibling dirs/kernels.
        let _ = crate::reaper::write_owner_marker(&session_root, &crate::reaper::current_marker());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = crate::reaper::reap_runtime(&artifact_root, &sanitized, now, REAP_GRACE_SECS);
        Ok(store)
    }

    fn new_with_root(root: PathBuf) -> Result<Self> {
        ensure_owner_only_dir(&root).with_context(|| {
            format!("ensure owner-only artifact session root {}", root.display())
        })?;
        Ok(Self {
            root: Arc::new(root),
            records: Arc::new(StdMutex::new(HashMap::new())),
        })
    }

    /// Store raw bytes and return a structured resource summary.
    pub fn write_bytes(
        &self,
        mime_type: &str,
        bytes: &[u8],
        summary: impl Into<String>,
    ) -> Result<ArtifactSummary> {
        if bytes.len() > MAX_ARTIFACT_BYTES {
            return Err(anyhow!(
                "artifact is too large: {} bytes exceeds {} byte limit",
                bytes.len(),
                MAX_ARTIFACT_BYTES
            ));
        }
        self.cleanup_expired();
        let id = format!("artifact-{}", Uuid::new_v4().simple());
        let path = self
            .root
            .join(format!("{id}{}", extension_for_mime(mime_type)));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .with_context(|| format!("create artifact {}", path.display()))?;
        file.write_all(bytes)
            .with_context(|| format!("write artifact {}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
        }
        let uri = format!("obu-artifact://{id}");
        let summary = summary.into();
        let record = ArtifactRecord {
            uri: uri.clone(),
            path,
            mime_type: mime_type.to_string(),
            bytes: bytes.len(),
            summary: summary.clone(),
            created_at: SystemTime::now(),
        };
        self.records
            .lock()
            .expect("artifact store lock")
            .insert(uri.clone(), record);
        Ok(ArtifactSummary {
            kind: "resource",
            uri,
            mime_type: mime_type.to_string(),
            bytes: bytes.len(),
            summary,
        })
    }

    /// Decode and store a base64 artifact.
    pub fn write_base64(
        &self,
        mime_type: &str,
        data_base64: &str,
        summary: impl Into<String>,
    ) -> Result<ArtifactSummary> {
        let estimated = estimated_decoded_len(data_base64);
        if estimated > MAX_ARTIFACT_BYTES {
            return Err(anyhow!(
                "artifact is too large: estimated {} bytes exceeds {} byte limit",
                estimated,
                MAX_ARTIFACT_BYTES
            ));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_base64)
            .context("decode artifact base64")?;
        self.write_bytes(mime_type, &bytes, summary)
    }

    /// Return resources visible to MCP clients.
    pub fn list_resources(&self) -> Vec<Resource> {
        self.cleanup_expired();
        self.records
            .lock()
            .expect("artifact store lock")
            .values()
            .map(resource_for_record)
            .collect()
    }

    /// Read a resource by URI.
    pub fn read_resource(&self, uri: &str) -> Result<ResourceContents> {
        self.cleanup_expired();
        let record = self
            .records
            .lock()
            .expect("artifact store lock")
            .get(uri)
            .cloned()
            .ok_or_else(|| anyhow!("artifact not found: {uri}"))?;
        let bytes = std::fs::read(&record.path)
            .with_context(|| format!("read artifact {}", record.path.display()))?;
        let blob = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(ResourceContents::blob(blob, record.uri).with_mime_type(record.mime_type))
    }

    fn cleanup_expired(&self) {
        let now = SystemTime::now();
        let mut records = self.records.lock().expect("artifact store lock");
        let expired = records
            .iter()
            .filter_map(|(uri, record)| {
                let age = now.duration_since(record.created_at).unwrap_or_default();
                (age > ARTIFACT_TTL).then(|| (uri.clone(), record.path.clone()))
            })
            .collect::<Vec<_>>();
        for (uri, path) in expired {
            records.remove(&uri);
            let _ = std::fs::remove_file(path);
        }
    }
}

impl Drop for ArtifactStore {
    fn drop(&mut self) {
        if Arc::strong_count(&self.root) == 1 {
            let _ = std::fs::remove_dir_all(self.root.as_path());
        }
    }
}

fn resource_for_record(record: &ArtifactRecord) -> Resource {
    RawResource::new(&record.uri, artifact_name(&record.uri))
        .with_title(record.summary.clone())
        .with_description(record.summary.clone())
        .with_mime_type(record.mime_type.clone())
        .with_size(record.bytes.min(u32::MAX as usize) as u32)
        .no_annotation()
}

fn artifact_name(uri: &str) -> String {
    uri.strip_prefix("obu-artifact://")
        .unwrap_or(uri)
        .to_string()
}

fn extension_for_mime(mime_type: &str) -> &'static str {
    match mime_type {
        "image/jpeg" => ".jpg",
        "image/png" => ".png",
        "image/webp" => ".webp",
        "application/pdf" => ".pdf",
        "text/html" => ".html",
        _ => ".bin",
    }
}

fn sanitize_path_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' => ch,
            _ => '-',
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "session".to_string()
    } else {
        sanitized
    }
}

fn estimated_decoded_len(data_base64: &str) -> usize {
    let padding = data_base64
        .as_bytes()
        .iter()
        .rev()
        .take_while(|byte| **byte == b'=')
        .take(2)
        .count();
    data_base64
        .len()
        .saturating_add(3)
        .saturating_div(4)
        .saturating_mul(3)
        .saturating_sub(padding)
}

trait NoAnnotation {
    fn no_annotation(self) -> Resource;
}

impl NoAnnotation for RawResource {
    fn no_annotation(self) -> Resource {
        rmcp::model::AnnotateAble::no_annotation(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn artifact_store_round_trips_blob_resource() {
        let dir = tempfile::tempdir().unwrap();
        let store = ArtifactStore::new_at(dir.path(), "test/session").unwrap();
        let summary = store
            .write_bytes("image/png", b"png-bytes", "small png")
            .unwrap();

        assert_eq!(summary.kind, "resource");
        assert_eq!(summary.mime_type, "image/png");
        assert_eq!(summary.bytes, 9);
        assert!(summary.uri.starts_with("obu-artifact://artifact-"));

        let resources = store.list_resources();
        assert_eq!(resources.len(), 1);
        assert_eq!(
            serde_json::to_value(&resources[0]).unwrap()["mimeType"],
            json!("image/png")
        );

        let read = store.read_resource(&summary.uri).unwrap();
        assert_eq!(
            serde_json::to_value(read).unwrap(),
            json!({
                "uri": summary.uri,
                "mimeType": "image/png",
                "blob": "cG5nLWJ5dGVz"
            })
        );
    }

    #[test]
    fn artifact_store_rejects_oversize_bytes_before_write() {
        let dir = tempfile::tempdir().unwrap();
        let store = ArtifactStore::new_at(dir.path(), "test/session").unwrap();
        let bytes = vec![0_u8; MAX_ARTIFACT_BYTES + 1];

        let error = store
            .write_bytes("application/octet-stream", &bytes, "too large")
            .unwrap_err();
        assert!(error.to_string().contains("artifact is too large"));
        assert!(store.list_resources().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn artifact_store_secures_runtime_and_artifact_roots() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let runtime_root = dir.path().join("runtime");
        let artifact_root = runtime_root.join("mcp-artifacts");
        let session_root = artifact_root.join("test-session");

        let _store = ArtifactStore::new_under_runtime(&runtime_root, "test/session").unwrap();

        assert_eq!(
            std::fs::metadata(&runtime_root)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&artifact_root)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&session_root)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }

    #[cfg(unix)]
    #[test]
    fn artifact_store_rejects_symlinked_session_root_without_mutating_target() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let dir = tempfile::tempdir().unwrap();
        let runtime_root = dir.path().join("runtime");
        let artifact_root = runtime_root.join("mcp-artifacts");
        let session_root = artifact_root.join("known-session");
        let target = dir.path().join("outside-target");
        std::fs::create_dir_all(&artifact_root).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        symlink(&target, &session_root).unwrap();

        let error = ArtifactStore::new_under_runtime(&runtime_root, "known-session").unwrap_err();

        assert!(error.to_string().contains("artifact session root"));
        assert!(format!("{error:#}").contains("symlink"));
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert!(std::fs::read_dir(&target).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn new_under_runtime_reaps_sibling_with_dead_owner() {
        use crate::reaper::{OwnerMarker, write_owner_marker};
        let dir = tempfile::tempdir().unwrap();
        let runtime_root = dir.path().join("runtime");
        let artifact_root = runtime_root.join("mcp-artifacts");
        std::fs::create_dir_all(&artifact_root).unwrap();
        // a sibling dir owned by a dead pid
        let stale = artifact_root.join("obu-stale");
        std::fs::create_dir_all(&stale).unwrap();
        write_owner_marker(
            &stale,
            &OwnerMarker {
                pid: 999_999,
                ppid: 1,
                started_at: 0,
            },
        )
        .unwrap();

        // constructing a new store sweeps siblings and records the fresh session marker
        let _store = ArtifactStore::new_under_runtime(&runtime_root, "obu-fresh").unwrap();

        assert!(
            !stale.exists(),
            "dead-owner sibling should be reaped on startup"
        );
        assert!(
            artifact_root.join("obu-fresh").join(".owner").exists(),
            "fresh session writes its marker"
        );
    }
}

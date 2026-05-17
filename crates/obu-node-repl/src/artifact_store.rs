//! Per-session MCP artifact storage.

use std::collections::HashMap;
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
        Self::new_with_root(artifact_root.join(sanitize_path_component(session_id)))
    }

    fn new_with_root(root: PathBuf) -> Result<Self> {
        create_owner_only_dir(&root)?;
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
        self.cleanup_expired();
        let id = format!("artifact-{}", Uuid::new_v4().simple());
        let path = self
            .root
            .join(format!("{id}{}", extension_for_mime(mime_type)));
        std::fs::write(&path, bytes)
            .with_context(|| format!("write artifact {}", path.display()))?;
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

fn create_owner_only_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).with_context(|| format!("create {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("chmod 0700 {}", path.display()))?;
    }
    Ok(())
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
}

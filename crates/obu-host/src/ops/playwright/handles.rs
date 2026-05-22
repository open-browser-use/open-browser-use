//! Shared Playwright handle parsing, event waits, and ownership checks.

use std::collections::HashSet;
use std::time::SystemTime;

use serde_json::{Value, json};

use crate::backends::BackendRequestContext;
use crate::error::{HostError, Result};
use crate::service_registry::{
    DownloadId, DownloadState, FileChooserId, FileChooserState, ServiceRegistry,
};
use crate::tab_state::TabId;

pub(crate) fn file_chooser_id(params: &Value) -> Result<FileChooserId> {
    params
        .get("file_chooser_id")
        .or_else(|| params.get("id"))
        .and_then(Value::as_str)
        .map(|id| FileChooserId(id.to_string()))
        .ok_or_else(|| HostError::Protocol("missing file_chooser_id".into()))
}

pub(crate) fn download_id(params: &Value) -> Result<DownloadId> {
    params
        .get("download_id")
        .or_else(|| params.get("id"))
        .and_then(Value::as_str)
        .map(|id| DownloadId(id.to_string()))
        .ok_or_else(|| HostError::Protocol("missing download_id".into()))
}

pub(crate) fn file_paths(params: &Value) -> Result<Vec<String>> {
    let files = params
        .get("files")
        .or_else(|| params.get("paths"))
        .and_then(Value::as_array)
        .ok_or_else(|| HostError::Protocol("fileChooser.setFiles requires files".into()))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| HostError::Protocol("file path must be a string".into()))
        })
        .collect::<Result<Vec<_>>>()?;
    if files.is_empty() {
        return Err(HostError::Protocol(
            "fileChooser.setFiles requires at least one file".into(),
        ));
    }
    Ok(files)
}

pub(crate) fn ensure_handle_session(
    kind: &str,
    id: &str,
    owner_session_id: &Option<String>,
    ctx: &BackendRequestContext,
) -> Result<()> {
    let Some(owner) = owner_session_id.as_deref() else {
        return Ok(());
    };
    let current = ctx.session_id.as_deref().unwrap_or_default();
    if current != owner {
        return Err(HostError::CdpFailure(format!(
            "{kind} handle {id} belongs to session {owner}, not {current}"
        )));
    }
    Ok(())
}

pub(crate) fn ensure_handle_tab(
    kind: &str,
    id: &str,
    owner_tab_id: &TabId,
    params: &Value,
) -> Result<()> {
    let Some(current) = params.get("tab_id").and_then(Value::as_str) else {
        return Ok(());
    };
    if current != owner_tab_id.0 {
        return Err(HostError::CdpFailure(format!(
            "{kind} handle {id} belongs to tab {}, not {current}",
            owner_tab_id.0
        )));
    }
    Ok(())
}

pub(crate) fn take_file_chooser_for_set_files(
    registry: &ServiceRegistry,
    ctx: &BackendRequestContext,
    params: &Value,
) -> Result<(FileChooserState, Vec<String>)> {
    let chooser_id = file_chooser_id(params)?;
    let files = file_paths(params)?;
    let state = registry
        .get_file_chooser(&chooser_id)?
        .ok_or_else(|| missing_file_chooser_handle(registry, &chooser_id.0))?;
    ensure_handle_session("file chooser", &chooser_id.0, &state.owner_session_id, ctx)?;
    ensure_handle_tab("file chooser", &chooser_id.0, &state.tab_id, params)?;
    if !state.is_multiple && files.len() > 1 {
        return Err(HostError::CdpFailure(
            "File chooser does not accept multiple files".into(),
        ));
    }
    let state = registry
        .take_file_chooser(&chooser_id)?
        .ok_or_else(|| missing_file_chooser_handle(registry, &chooser_id.0))?;
    Ok((state, files))
}

pub(crate) fn file_chooser_opened_result(
    registry: &ServiceRegistry,
    tab_id: &str,
    owner_session_id: Option<String>,
    params: &Value,
) -> Result<Value> {
    let backend_node_id = params
        .get("backendNodeId")
        .and_then(Value::as_i64)
        .ok_or_else(|| HostError::CdpFailure("file chooser missing backendNodeId".into()))?;
    let is_multiple = params.get("mode").and_then(Value::as_str) == Some("selectMultiple");
    let id = FileChooserId(format!("file-chooser-{}", uuid::Uuid::new_v4()));
    registry.insert_file_chooser(
        id.clone(),
        FileChooserState {
            tab_id: TabId::new(tab_id),
            owner_session_id,
            created_at: SystemTime::now(),
            backend_node_id,
            is_multiple,
        },
    )?;
    Ok(json!({
        "id": id.0,
        "file_chooser_id": id.0,
        "is_multiple": is_multiple,
    }))
}

pub(crate) fn file_chooser_opened_has_backend_node(params: &Value) -> bool {
    params
        .get("backendNodeId")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        > 0
}

pub(crate) fn set_file_input_files_params(state: &FileChooserState, files: Vec<String>) -> Value {
    json!({
        "backendNodeId": state.backend_node_id,
        "files": files,
    })
}

pub(crate) fn download_will_begin_has_guid(params: &Value) -> bool {
    params.get("guid").and_then(Value::as_str).is_some()
}

pub(crate) fn download_will_begin_matches_frame_ids(
    params: &Value,
    frame_ids: &HashSet<String>,
) -> bool {
    download_will_begin_has_guid(params)
        && params
            .get("frameId")
            .and_then(Value::as_str)
            .is_some_and(|frame_id| frame_ids.contains(frame_id))
}

pub(crate) fn download_from_will_begin(
    tab_id: &str,
    owner_session_id: Option<String>,
    params: &Value,
) -> Result<(DownloadId, DownloadState)> {
    let guid = params
        .get("guid")
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::CdpFailure("downloadWillBegin missing guid".into()))?
        .to_string();
    let id = DownloadId(guid.clone());
    let state = DownloadState {
        tab_id: TabId::new(tab_id),
        owner_session_id,
        created_at: SystemTime::now(),
        url: params
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        suggested_filename: params
            .get("suggestedFilename")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        guid,
        completed_path: None,
    };
    Ok((id, state))
}

pub(crate) fn record_download_from_will_begin(
    registry: &ServiceRegistry,
    tab_id: &str,
    owner_session_id: Option<String>,
    params: &Value,
) -> Result<Value> {
    let (id, state) = download_from_will_begin(tab_id, owner_session_id, params)?;
    registry.insert_download(id.clone(), state)?;
    Ok(json!({
        "id": id.0,
        "download_id": id.0,
    }))
}

pub(crate) fn download_for_path(
    registry: &ServiceRegistry,
    ctx: &BackendRequestContext,
    params: &Value,
) -> Result<(DownloadId, DownloadState)> {
    let download_id = download_id(params)?;
    let state = registry
        .get_download(&download_id)?
        .ok_or_else(|| missing_download_handle(registry, &download_id.0))?;
    ensure_handle_session("download", &download_id.0, &state.owner_session_id, ctx)?;
    ensure_handle_tab("download", &download_id.0, &state.tab_id, params)?;
    Ok((download_id, state))
}

pub(crate) fn mark_download_completed(
    registry: &ServiceRegistry,
    id: &DownloadId,
    state: &mut DownloadState,
    completed_path: Option<String>,
) -> Result<()> {
    registry.mark_download_completed(id, completed_path.clone())?;
    state.completed_path = completed_path;
    Ok(())
}

pub(crate) fn download_path_result(id: &DownloadId, state: DownloadState) -> Result<Value> {
    let Some(path) = state.completed_path else {
        return Err(HostError::CdpFailure(format!(
            "download {} has not completed",
            id.0
        )));
    };
    Ok(json!({ "path": path }))
}

pub(crate) fn missing_file_chooser_handle(registry: &ServiceRegistry, id: &str) -> HostError {
    match registry.describe_missing_file_chooser(&FileChooserId(id.to_string())) {
        Ok(message) => HostError::CdpFailure(message),
        Err(error) => error,
    }
}

pub(crate) fn download_progress_terminal_for_guid(params: &Value, guid: &str) -> bool {
    params.get("guid").and_then(Value::as_str) == Some(guid)
        && matches!(
            params.get("state").and_then(Value::as_str),
            Some("completed" | "canceled")
        )
}

pub(crate) fn download_progress_is_canceled(params: &Value) -> bool {
    params.get("state").and_then(Value::as_str) == Some("canceled")
}

pub(crate) fn download_progress_file_path(params: &Value) -> Option<String> {
    params
        .get("filePath")
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub(crate) fn download_change_terminal_and_matches(params: &Value, state: &DownloadState) -> bool {
    let status = params
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    matches!(status, "complete" | "failed") && download_change_matches(params, state)
}

pub(crate) fn download_change_is_complete(params: &Value) -> bool {
    params.get("status").and_then(Value::as_str) == Some("complete")
}

pub(crate) fn download_change_failure_message(params: &Value) -> &str {
    params
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("download failed")
}

pub(crate) fn download_change_filename(params: &Value) -> Option<String> {
    params
        .get("filename")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn download_change_matches(params: &Value, state: &DownloadState) -> bool {
    if let Some(source_tab_id) = params
        .get("source")
        .and_then(|source| source.get("tabId"))
        .and_then(Value::as_i64)
        && state.tab_id.0 != source_tab_id.to_string()
    {
        return false;
    }
    if let Some(url) = params.get("url").and_then(Value::as_str)
        && !state.url.is_empty()
        && url == state.url
    {
        return true;
    }
    if let Some(filename) = params.get("filename").and_then(Value::as_str)
        && !state.suggested_filename.is_empty()
        && filename.ends_with(&state.suggested_filename)
    {
        return true;
    }
    false
}

pub(crate) fn missing_download_handle(registry: &ServiceRegistry, id: &str) -> HostError {
    match registry.describe_missing_download(&DownloadId(id.to_string())) {
        Ok(message) => HostError::CdpFailure(message),
        Err(error) => error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_input_payload_uses_recorded_backend_node_and_files() {
        let state = FileChooserState {
            tab_id: TabId::new("tab-1"),
            owner_session_id: Some("session".into()),
            created_at: SystemTime::now(),
            backend_node_id: 42,
            is_multiple: true,
        };

        assert_eq!(
            set_file_input_files_params(&state, vec!["/tmp/a.txt".into(), "/tmp/b.txt".into()]),
            json!({
                "backendNodeId": 42,
                "files": ["/tmp/a.txt", "/tmp/b.txt"],
            })
        );
    }

    #[test]
    fn event_predicates_match_file_chooser_and_download_start_shapes() {
        assert!(file_chooser_opened_has_backend_node(
            &json!({ "backendNodeId": 42 })
        ));
        assert!(!file_chooser_opened_has_backend_node(
            &json!({ "backendNodeId": 0 })
        ));
        assert!(!file_chooser_opened_has_backend_node(
            &json!({ "backendNodeId": "42" })
        ));
        assert!(download_will_begin_has_guid(
            &json!({ "guid": "download-guid" })
        ));
        assert!(!download_will_begin_has_guid(&json!({ "guid": 42 })));
        let frame_ids = HashSet::from(["frame-1".to_string()]);
        assert!(download_will_begin_matches_frame_ids(
            &json!({ "guid": "download-guid", "frameId": "frame-1" }),
            &frame_ids,
        ));
        assert!(!download_will_begin_matches_frame_ids(
            &json!({ "guid": "download-guid", "frameId": "frame-2" }),
            &frame_ids,
        ));
        assert!(download_progress_terminal_for_guid(
            &json!({ "guid": "download-guid", "state": "completed" }),
            "download-guid",
        ));
        assert!(download_progress_terminal_for_guid(
            &json!({ "guid": "download-guid", "state": "canceled" }),
            "download-guid",
        ));
        assert!(!download_progress_terminal_for_guid(
            &json!({ "guid": "download-guid", "state": "inProgress" }),
            "download-guid",
        ));
        assert_eq!(
            download_progress_file_path(&json!({ "filePath": "/tmp/file.txt" })).as_deref(),
            Some("/tmp/file.txt"),
        );
    }

    #[test]
    fn record_download_started_registers_handle_and_result_shape() {
        let registry = ServiceRegistry::default();
        let result = record_download_from_will_begin(
            &registry,
            "tab-1",
            Some("session".into()),
            &json!({
                "guid": "download-guid",
                "url": "https://example.test/file.txt",
                "suggestedFilename": "file.txt",
            }),
        )
        .unwrap();

        assert_eq!(
            result,
            json!({ "id": "download-guid", "download_id": "download-guid" })
        );
        let state = registry
            .get_download(&DownloadId("download-guid".into()))
            .unwrap()
            .unwrap();
        assert_eq!(state.tab_id, TabId::new("tab-1"));
        assert_eq!(state.owner_session_id.as_deref(), Some("session"));
        assert_eq!(state.url, "https://example.test/file.txt");
        assert_eq!(state.suggested_filename, "file.txt");
    }

    #[test]
    fn download_change_helpers_match_terminal_downloads() {
        let state = DownloadState {
            tab_id: TabId::new("1"),
            owner_session_id: Some("session".into()),
            created_at: SystemTime::now(),
            url: "https://example.test/file.txt".into(),
            suggested_filename: "file.txt".into(),
            guid: "download-guid".into(),
            completed_path: None,
        };

        let completed = json!({
            "status": "complete",
            "source": { "tabId": 1 },
            "url": "https://example.test/file.txt",
            "filename": "/tmp/file.txt",
        });
        assert!(download_change_terminal_and_matches(&completed, &state));
        assert!(download_change_is_complete(&completed));
        assert_eq!(
            download_change_filename(&completed).as_deref(),
            Some("/tmp/file.txt"),
        );

        let failed = json!({
            "status": "failed",
            "filename": "/tmp/file.txt",
            "error": "network failed",
        });
        assert!(download_change_terminal_and_matches(&failed, &state));
        assert!(!download_change_is_complete(&failed));
        assert_eq!(download_change_failure_message(&failed), "network failed");

        assert!(!download_change_terminal_and_matches(
            &json!({
                "status": "complete",
                "source": { "tabId": 2 },
                "url": "https://example.test/file.txt",
            }),
            &state,
        ));
        assert!(!download_change_terminal_and_matches(
            &json!({
                "status": "complete",
                "source": { "tabId": 1 },
                "url": "https://other.test/file.txt",
            }),
            &state,
        ));
    }
}

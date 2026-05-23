//! Pure lifecycle planners for WebExtension runtime descriptors.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

/// Runtime descriptor lifecycle state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeDescriptorState {
    /// No runtime descriptor is currently registered.
    Absent,
    /// A descriptor file is published for SDK discovery.
    Fresh {
        /// Runtime descriptor file path.
        descriptor_path: PathBuf,
    },
    /// A descriptor file was dropped or intentionally invalidated.
    Dropped {
        /// Runtime descriptor file path when one existed.
        descriptor_path: Option<PathBuf>,
        /// Drop reason.
        reason: String,
    },
}

/// Runtime descriptor lifecycle event kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeDescriptorLifecycleEventKind {
    /// A descriptor has been prepared for publication.
    Fresh,
    /// A descriptor should be removed.
    Dropped,
    /// A drop was requested when no descriptor was registered.
    DropSkipped,
}

/// Planned runtime descriptor lifecycle event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeDescriptorLifecycleEventPlan {
    /// Event kind.
    pub kind: RuntimeDescriptorLifecycleEventKind,
    /// Runtime descriptor path when available.
    pub descriptor_path: Option<PathBuf>,
    /// Event reason when available.
    pub reason: Option<String>,
}

/// Pure plan for publishing a runtime descriptor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeDescriptorWritePlan {
    /// Temporary file written before the atomic rename.
    pub tmp_path: PathBuf,
    /// Final descriptor path.
    pub descriptor_path: PathBuf,
    /// Descriptor JSON payload.
    pub descriptor: Value,
    /// State after the write effects complete.
    pub next_state: RuntimeDescriptorState,
    /// Lifecycle event emitted by this transition.
    pub event: RuntimeDescriptorLifecycleEventPlan,
}

/// Pure plan for dropping a runtime descriptor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeDescriptorDropPlan {
    /// Descriptor file to remove, if one is registered.
    pub remove_path: Option<PathBuf>,
    /// State after the drop effects complete.
    pub next_state: RuntimeDescriptorState,
    /// Lifecycle event emitted by this transition.
    pub event: RuntimeDescriptorLifecycleEventPlan,
}

/// Plan descriptor publication without touching the filesystem.
pub fn plan_runtime_descriptor_write(
    descriptor_dir: &Path,
    descriptor_id: &str,
    socket_path: &Path,
    sdk_auth_token: &str,
    metadata: Value,
    pid: u32,
    started_at: String,
) -> RuntimeDescriptorWritePlan {
    let descriptor_path = descriptor_dir.join(format!("{descriptor_id}.json"));
    let tmp_path = descriptor_dir.join(format!("{descriptor_id}.json.tmp"));
    let descriptor = json!({
        "schema_version": 1,
        "type": "webextension",
        "name": metadata
            .get("browser_kind")
            .and_then(Value::as_str)
            .unwrap_or("chrome"),
        "socketPath": socket_path.to_string_lossy(),
        "sdk_auth_token": sdk_auth_token,
        "pid": pid,
        "startedAt": started_at,
        "metadata": metadata,
    });
    RuntimeDescriptorWritePlan {
        tmp_path,
        descriptor_path: descriptor_path.clone(),
        descriptor,
        next_state: RuntimeDescriptorState::Fresh {
            descriptor_path: descriptor_path.clone(),
        },
        event: RuntimeDescriptorLifecycleEventPlan {
            kind: RuntimeDescriptorLifecycleEventKind::Fresh,
            descriptor_path: Some(descriptor_path),
            reason: None,
        },
    }
}

/// Plan descriptor removal without touching the filesystem.
pub fn plan_runtime_descriptor_drop(
    descriptor_path: Option<&Path>,
    reason: &str,
) -> RuntimeDescriptorDropPlan {
    let descriptor_path = descriptor_path.map(Path::to_path_buf);
    let kind = if descriptor_path.is_some() {
        RuntimeDescriptorLifecycleEventKind::Dropped
    } else {
        RuntimeDescriptorLifecycleEventKind::DropSkipped
    };
    RuntimeDescriptorDropPlan {
        remove_path: descriptor_path.clone(),
        next_state: descriptor_path
            .clone()
            .map(|descriptor_path| RuntimeDescriptorState::Dropped {
                descriptor_path: Some(descriptor_path),
                reason: reason.to_string(),
            })
            .unwrap_or(RuntimeDescriptorState::Absent),
        event: RuntimeDescriptorLifecycleEventPlan {
            kind,
            descriptor_path,
            reason: Some(reason.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{
        RuntimeDescriptorLifecycleEventKind, RuntimeDescriptorState, plan_runtime_descriptor_drop,
        plan_runtime_descriptor_write,
    };
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn write_planner_shapes_descriptor_and_fresh_state() {
        let plan = plan_runtime_descriptor_write(
            Path::new("/tmp/obu-runtime/webextension"),
            "descriptor-id",
            Path::new("/tmp/obu-runtime/webextension/sdk.sock"),
            "sdk-token",
            json!({ "browser_kind": "chrome", "extension_id": "test-extension" }),
            42,
            "123456".to_string(),
        );

        assert_eq!(
            plan.descriptor_path,
            Path::new("/tmp/obu-runtime/webextension/descriptor-id.json")
        );
        assert_eq!(
            plan.tmp_path,
            Path::new("/tmp/obu-runtime/webextension/descriptor-id.json.tmp")
        );
        assert_eq!(plan.descriptor["schema_version"], json!(1));
        assert_eq!(plan.descriptor["type"], "webextension");
        assert_eq!(plan.descriptor["name"], "chrome");
        assert_eq!(
            plan.descriptor["socketPath"],
            "/tmp/obu-runtime/webextension/sdk.sock"
        );
        assert_eq!(plan.descriptor["sdk_auth_token"], "sdk-token");
        assert_eq!(plan.descriptor["pid"], json!(42));
        assert_eq!(plan.descriptor["startedAt"], "123456");
        assert_eq!(
            plan.descriptor["metadata"]["extension_id"],
            "test-extension"
        );
        assert_eq!(
            plan.next_state,
            RuntimeDescriptorState::Fresh {
                descriptor_path: Path::new("/tmp/obu-runtime/webextension/descriptor-id.json")
                    .to_path_buf(),
            }
        );
        assert_eq!(plan.event.kind, RuntimeDescriptorLifecycleEventKind::Fresh);
    }

    #[test]
    fn drop_planner_removes_registered_descriptor() {
        let plan = plan_runtime_descriptor_drop(
            Some(Path::new(
                "/tmp/obu-runtime/webextension/descriptor-id.json",
            )),
            "stop_browser_control",
        );

        assert_eq!(
            plan.remove_path.as_deref(),
            Some(Path::new(
                "/tmp/obu-runtime/webextension/descriptor-id.json"
            ))
        );
        assert_eq!(
            plan.event.kind,
            RuntimeDescriptorLifecycleEventKind::Dropped
        );
        assert_eq!(plan.event.reason.as_deref(), Some("stop_browser_control"));
        assert_eq!(
            plan.next_state,
            RuntimeDescriptorState::Dropped {
                descriptor_path: Some(
                    Path::new("/tmp/obu-runtime/webextension/descriptor-id.json").to_path_buf()
                ),
                reason: "stop_browser_control".to_string(),
            }
        );
    }

    #[test]
    fn drop_planner_skips_absent_descriptor() {
        let plan = plan_runtime_descriptor_drop(None, "native_loop_finished");

        assert_eq!(plan.remove_path, None);
        assert_eq!(
            plan.event.kind,
            RuntimeDescriptorLifecycleEventKind::DropSkipped
        );
        assert_eq!(plan.next_state, RuntimeDescriptorState::Absent);
    }
}

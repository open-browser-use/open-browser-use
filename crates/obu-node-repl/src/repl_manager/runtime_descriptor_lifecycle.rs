//! Pure lifecycle planners for runtime descriptor discovery.

use serde::Serialize;
use serde_json::Value;

/// Runtime descriptor state observed by descriptor discovery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeDescriptorReadState {
    /// Descriptor points to a usable runtime backend.
    Fresh,
    /// Descriptor shape, file permissions, or socket metadata are not valid.
    Invalid,
    /// Descriptor was once valid but no longer responds as a live backend.
    Stale,
}

impl RuntimeDescriptorReadState {
    /// Every read-state variant. Pinned to `descriptor-vocab.json` (`readerStates`).
    pub const ALL: [RuntimeDescriptorReadState; 3] = [Self::Fresh, Self::Invalid, Self::Stale];
}

/// Runtime descriptor setup state observed before reading descriptor content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeDescriptorSetupState {
    /// Runtime root or descriptor directory is missing.
    Missing,
    /// Runtime root or descriptor directory cannot be read.
    Unreadable,
    /// Runtime root or descriptor directory shape/permissions are invalid.
    Invalid,
    /// Descriptor directory exists but has no active descriptor.
    NoDescriptor,
}

/// Stable reason code for descriptor discovery diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeDescriptorReadReasonCode {
    /// Descriptor file failed safety validation.
    DescriptorFileInvalid,
    /// Descriptor JSON could not be parsed.
    DescriptorJsonInvalid,
    /// Descriptor schema version is unsupported.
    UnsupportedSchemaVersion,
    /// Descriptor type is unsupported.
    UnsupportedDescriptorType,
    /// Descriptor is missing `socketPath`.
    SocketPathMissing,
    /// Descriptor is missing `sdk_auth_token`.
    SdkAuthTokenMissing,
    /// Descriptor socket failed safety or shape validation.
    DescriptorSocketInvalid,
    /// Descriptor process is no longer alive.
    DescriptorProcessNotAlive,
    /// Descriptor socket probe failed.
    DescriptorProbeFailed,
}

impl RuntimeDescriptorReadReasonCode {
    /// Stable snake_case code used in JSON diagnostics.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DescriptorFileInvalid => "descriptor_file_invalid",
            Self::DescriptorJsonInvalid => "descriptor_json_invalid",
            Self::UnsupportedSchemaVersion => "unsupported_schema_version",
            Self::UnsupportedDescriptorType => "unsupported_descriptor_type",
            Self::SocketPathMissing => "socket_path_missing",
            Self::SdkAuthTokenMissing => "sdk_auth_token_missing",
            Self::DescriptorSocketInvalid => "descriptor_socket_invalid",
            Self::DescriptorProcessNotAlive => "descriptor_process_not_alive",
            Self::DescriptorProbeFailed => "descriptor_probe_failed",
        }
    }

    /// Every reader reason code. Pinned to `descriptor-vocab.json`.
    pub const ALL: [RuntimeDescriptorReadReasonCode; 9] = [
        Self::DescriptorFileInvalid,
        Self::DescriptorJsonInvalid,
        Self::UnsupportedSchemaVersion,
        Self::UnsupportedDescriptorType,
        Self::SocketPathMissing,
        Self::SdkAuthTokenMissing,
        Self::DescriptorSocketInvalid,
        Self::DescriptorProcessNotAlive,
        Self::DescriptorProbeFailed,
    ];
}

/// Stable reason code for descriptor setup diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeDescriptorSetupReasonCode {
    /// Runtime root is missing.
    RuntimeRootMissing,
    /// Runtime root cannot be read.
    RuntimeRootUnreadable,
    /// Runtime root shape or permissions are invalid.
    RuntimeRootInvalid,
    /// Runtime descriptor directory is missing.
    DescriptorDirMissing,
    /// Runtime descriptor directory cannot be read.
    DescriptorDirUnreadable,
    /// Runtime descriptor directory shape or permissions are invalid.
    DescriptorDirInvalid,
    /// Runtime descriptor directory has no descriptor files.
    DescriptorMissing,
}

impl RuntimeDescriptorSetupReasonCode {
    /// Stable snake_case code used in JSON diagnostics.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RuntimeRootMissing => "runtime_root_missing",
            Self::RuntimeRootUnreadable => "runtime_root_unreadable",
            Self::RuntimeRootInvalid => "runtime_root_invalid",
            Self::DescriptorDirMissing => "descriptor_dir_missing",
            Self::DescriptorDirUnreadable => "descriptor_dir_unreadable",
            Self::DescriptorDirInvalid => "descriptor_dir_invalid",
            Self::DescriptorMissing => "descriptor_missing",
        }
    }
}

/// Pure issue input for ignored runtime descriptor planning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeDescriptorReadIssue {
    /// Descriptor file failed safety validation.
    DescriptorFileInvalid {
        /// Validation reason.
        reason: String,
    },
    /// Descriptor JSON could not be parsed.
    DescriptorJsonInvalid {
        /// Parser error.
        reason: String,
    },
    /// Descriptor schema version is unsupported.
    UnsupportedSchemaVersion {
        /// Rendered schema version value.
        value: String,
    },
    /// Descriptor type is unsupported.
    UnsupportedDescriptorType {
        /// Rendered descriptor type value.
        value: String,
    },
    /// Descriptor is missing `socketPath`.
    SocketPathMissing,
    /// Descriptor is missing `sdk_auth_token`.
    SdkAuthTokenMissing,
    /// Descriptor socket failed safety or shape validation.
    DescriptorSocketInvalid {
        /// Validation reason.
        reason: String,
    },
    /// Descriptor process is no longer alive.
    DescriptorProcessNotAlive,
    /// Descriptor socket probe failed.
    DescriptorProbeFailed,
}

/// Pure issue input for runtime descriptor setup planning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeDescriptorSetupIssue {
    /// Runtime root is missing.
    RuntimeRootMissing,
    /// Runtime root failed safety validation.
    RuntimeRootInvalid {
        /// Validation reason.
        reason: String,
    },
    /// Runtime root cannot be read.
    RuntimeRootUnreadable {
        /// Read error.
        reason: String,
    },
    /// Runtime descriptor directory is missing.
    DescriptorDirMissing,
    /// Runtime descriptor directory cannot be read.
    DescriptorDirUnreadable {
        /// Read error.
        reason: String,
    },
    /// Runtime descriptor directory failed safety validation.
    DescriptorDirInvalid {
        /// Validation reason.
        reason: String,
    },
    /// Runtime descriptor directory has no descriptor files.
    DescriptorMissing,
}

/// Pure plan for an ignored runtime descriptor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeDescriptorIgnoredPlan {
    /// Descriptor read state.
    pub lifecycle_state: RuntimeDescriptorReadState,
    /// Stable reason code.
    pub reason_code: RuntimeDescriptorReadReasonCode,
    /// Existing human-readable reason string.
    pub reason: String,
}

/// Pure plan for a runtime descriptor setup diagnostic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeDescriptorSetupPlan {
    /// Descriptor setup state.
    pub setup_lifecycle_state: RuntimeDescriptorSetupState,
    /// Stable setup reason code.
    pub setup_reason_code: RuntimeDescriptorSetupReasonCode,
    /// Existing human-readable reason string.
    pub reason: String,
}

/// Pure plan for a usable runtime descriptor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeDescriptorUsablePlan {
    /// Descriptor read state.
    pub lifecycle_state: RuntimeDescriptorReadState,
}

/// Plan an ignored runtime descriptor diagnostic.
pub fn plan_runtime_descriptor_ignored(
    issue: RuntimeDescriptorReadIssue,
) -> RuntimeDescriptorIgnoredPlan {
    match issue {
        RuntimeDescriptorReadIssue::DescriptorFileInvalid { reason } => {
            RuntimeDescriptorIgnoredPlan {
                lifecycle_state: RuntimeDescriptorReadState::Invalid,
                reason_code: RuntimeDescriptorReadReasonCode::DescriptorFileInvalid,
                reason,
            }
        }
        RuntimeDescriptorReadIssue::DescriptorJsonInvalid { reason } => {
            RuntimeDescriptorIgnoredPlan {
                lifecycle_state: RuntimeDescriptorReadState::Invalid,
                reason_code: RuntimeDescriptorReadReasonCode::DescriptorJsonInvalid,
                reason,
            }
        }
        RuntimeDescriptorReadIssue::UnsupportedSchemaVersion { value } => {
            RuntimeDescriptorIgnoredPlan {
                lifecycle_state: RuntimeDescriptorReadState::Invalid,
                reason_code: RuntimeDescriptorReadReasonCode::UnsupportedSchemaVersion,
                reason: format!("unsupported schema_version {value}"),
            }
        }
        RuntimeDescriptorReadIssue::UnsupportedDescriptorType { value } => {
            RuntimeDescriptorIgnoredPlan {
                lifecycle_state: RuntimeDescriptorReadState::Invalid,
                reason_code: RuntimeDescriptorReadReasonCode::UnsupportedDescriptorType,
                reason: format!("unsupported descriptor type {value}"),
            }
        }
        RuntimeDescriptorReadIssue::SocketPathMissing => RuntimeDescriptorIgnoredPlan {
            lifecycle_state: RuntimeDescriptorReadState::Invalid,
            reason_code: RuntimeDescriptorReadReasonCode::SocketPathMissing,
            reason: "socketPath missing".to_string(),
        },
        RuntimeDescriptorReadIssue::SdkAuthTokenMissing => RuntimeDescriptorIgnoredPlan {
            lifecycle_state: RuntimeDescriptorReadState::Invalid,
            reason_code: RuntimeDescriptorReadReasonCode::SdkAuthTokenMissing,
            reason: "sdk_auth_token missing".to_string(),
        },
        RuntimeDescriptorReadIssue::DescriptorSocketInvalid { reason } => {
            RuntimeDescriptorIgnoredPlan {
                lifecycle_state: RuntimeDescriptorReadState::Invalid,
                reason_code: RuntimeDescriptorReadReasonCode::DescriptorSocketInvalid,
                reason,
            }
        }
        RuntimeDescriptorReadIssue::DescriptorProcessNotAlive => RuntimeDescriptorIgnoredPlan {
            lifecycle_state: RuntimeDescriptorReadState::Stale,
            reason_code: RuntimeDescriptorReadReasonCode::DescriptorProcessNotAlive,
            reason: "descriptor process is not alive".to_string(),
        },
        RuntimeDescriptorReadIssue::DescriptorProbeFailed => RuntimeDescriptorIgnoredPlan {
            lifecycle_state: RuntimeDescriptorReadState::Stale,
            reason_code: RuntimeDescriptorReadReasonCode::DescriptorProbeFailed,
            reason: "descriptor probe failed".to_string(),
        },
    }
}

/// Plan a runtime descriptor setup diagnostic.
pub fn plan_runtime_descriptor_setup(
    issue: RuntimeDescriptorSetupIssue,
) -> RuntimeDescriptorSetupPlan {
    match issue {
        RuntimeDescriptorSetupIssue::RuntimeRootMissing => RuntimeDescriptorSetupPlan {
            setup_lifecycle_state: RuntimeDescriptorSetupState::Missing,
            setup_reason_code: RuntimeDescriptorSetupReasonCode::RuntimeRootMissing,
            reason: "runtime root missing".to_string(),
        },
        RuntimeDescriptorSetupIssue::RuntimeRootInvalid { reason } => RuntimeDescriptorSetupPlan {
            setup_lifecycle_state: RuntimeDescriptorSetupState::Invalid,
            setup_reason_code: RuntimeDescriptorSetupReasonCode::RuntimeRootInvalid,
            reason,
        },
        RuntimeDescriptorSetupIssue::RuntimeRootUnreadable { reason } => {
            RuntimeDescriptorSetupPlan {
                setup_lifecycle_state: RuntimeDescriptorSetupState::Unreadable,
                setup_reason_code: RuntimeDescriptorSetupReasonCode::RuntimeRootUnreadable,
                reason,
            }
        }
        RuntimeDescriptorSetupIssue::DescriptorDirMissing => RuntimeDescriptorSetupPlan {
            setup_lifecycle_state: RuntimeDescriptorSetupState::Missing,
            setup_reason_code: RuntimeDescriptorSetupReasonCode::DescriptorDirMissing,
            reason: "runtime descriptor directory missing".to_string(),
        },
        RuntimeDescriptorSetupIssue::DescriptorDirUnreadable { reason } => {
            RuntimeDescriptorSetupPlan {
                setup_lifecycle_state: RuntimeDescriptorSetupState::Unreadable,
                setup_reason_code: RuntimeDescriptorSetupReasonCode::DescriptorDirUnreadable,
                reason,
            }
        }
        RuntimeDescriptorSetupIssue::DescriptorDirInvalid { reason } => {
            RuntimeDescriptorSetupPlan {
                setup_lifecycle_state: RuntimeDescriptorSetupState::Invalid,
                setup_reason_code: RuntimeDescriptorSetupReasonCode::DescriptorDirInvalid,
                reason,
            }
        }
        RuntimeDescriptorSetupIssue::DescriptorMissing => RuntimeDescriptorSetupPlan {
            setup_lifecycle_state: RuntimeDescriptorSetupState::NoDescriptor,
            setup_reason_code: RuntimeDescriptorSetupReasonCode::DescriptorMissing,
            reason: "no active WebExtension descriptor found".to_string(),
        },
    }
}

/// Plan a usable runtime descriptor.
pub fn plan_runtime_descriptor_usable() -> RuntimeDescriptorUsablePlan {
    RuntimeDescriptorUsablePlan {
        lifecycle_state: RuntimeDescriptorReadState::Fresh,
    }
}

/// Render a descriptor value for compatibility with existing diagnostic text.
pub fn rendered_descriptor_value(value: Option<&Value>) -> String {
    value
        .map(Value::to_string)
        .unwrap_or_else(|| "missing".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        RuntimeDescriptorReadIssue, RuntimeDescriptorReadReasonCode, RuntimeDescriptorReadState,
        RuntimeDescriptorSetupIssue, RuntimeDescriptorSetupReasonCode, RuntimeDescriptorSetupState,
        plan_runtime_descriptor_ignored, plan_runtime_descriptor_setup,
        plan_runtime_descriptor_usable, rendered_descriptor_value,
    };
    use serde_json::json;

    #[test]
    fn ignored_planner_preserves_existing_reason_text_for_invalid_shape() {
        let json =
            plan_runtime_descriptor_ignored(RuntimeDescriptorReadIssue::DescriptorJsonInvalid {
                reason: "descriptor_json_invalid: expected value".to_string(),
            });
        assert_eq!(json.lifecycle_state, RuntimeDescriptorReadState::Invalid);
        assert_eq!(
            json.reason_code,
            RuntimeDescriptorReadReasonCode::DescriptorJsonInvalid
        );
        assert_eq!(json.reason, "descriptor_json_invalid: expected value");

        let schema =
            plan_runtime_descriptor_ignored(RuntimeDescriptorReadIssue::UnsupportedSchemaVersion {
                value: "999".to_string(),
            });
        assert_eq!(schema.lifecycle_state, RuntimeDescriptorReadState::Invalid);
        assert_eq!(
            schema.reason_code,
            RuntimeDescriptorReadReasonCode::UnsupportedSchemaVersion
        );
        assert_eq!(schema.reason, "unsupported schema_version 999");

        let missing_socket =
            plan_runtime_descriptor_ignored(RuntimeDescriptorReadIssue::SocketPathMissing);
        assert_eq!(missing_socket.reason, "socketPath missing");
        assert_eq!(
            missing_socket.reason_code,
            RuntimeDescriptorReadReasonCode::SocketPathMissing
        );
    }

    #[test]
    fn ignored_planner_marks_dead_process_and_failed_probe_stale() {
        let dead =
            plan_runtime_descriptor_ignored(RuntimeDescriptorReadIssue::DescriptorProcessNotAlive);
        assert_eq!(dead.lifecycle_state, RuntimeDescriptorReadState::Stale);
        assert_eq!(
            dead.reason_code,
            RuntimeDescriptorReadReasonCode::DescriptorProcessNotAlive
        );

        let probe =
            plan_runtime_descriptor_ignored(RuntimeDescriptorReadIssue::DescriptorProbeFailed);
        assert_eq!(probe.lifecycle_state, RuntimeDescriptorReadState::Stale);
        assert_eq!(
            probe.reason_code,
            RuntimeDescriptorReadReasonCode::DescriptorProbeFailed
        );
    }

    #[test]
    fn setup_planner_classifies_descriptor_setup_boundary_states() {
        let missing =
            plan_runtime_descriptor_setup(RuntimeDescriptorSetupIssue::DescriptorDirMissing);
        assert_eq!(
            missing.setup_lifecycle_state,
            RuntimeDescriptorSetupState::Missing
        );
        assert_eq!(
            missing.setup_reason_code,
            RuntimeDescriptorSetupReasonCode::DescriptorDirMissing
        );

        let unreadable =
            plan_runtime_descriptor_setup(RuntimeDescriptorSetupIssue::DescriptorDirUnreadable {
                reason: "permission denied".to_string(),
            });
        assert_eq!(
            unreadable.setup_lifecycle_state,
            RuntimeDescriptorSetupState::Unreadable
        );
        assert_eq!(
            unreadable.setup_reason_code,
            RuntimeDescriptorSetupReasonCode::DescriptorDirUnreadable
        );
        assert_eq!(unreadable.reason, "permission denied");

        let invalid =
            plan_runtime_descriptor_setup(RuntimeDescriptorSetupIssue::DescriptorDirInvalid {
                reason: "not owner-only".to_string(),
            });
        assert_eq!(
            invalid.setup_lifecycle_state,
            RuntimeDescriptorSetupState::Invalid
        );
        assert_eq!(
            invalid.setup_reason_code,
            RuntimeDescriptorSetupReasonCode::DescriptorDirInvalid
        );

        let none = plan_runtime_descriptor_setup(RuntimeDescriptorSetupIssue::DescriptorMissing);
        assert_eq!(
            none.setup_lifecycle_state,
            RuntimeDescriptorSetupState::NoDescriptor
        );
        assert_eq!(
            none.setup_reason_code,
            RuntimeDescriptorSetupReasonCode::DescriptorMissing
        );
    }

    #[test]
    fn usable_planner_marks_descriptor_fresh() {
        let plan = plan_runtime_descriptor_usable();
        assert_eq!(plan.lifecycle_state, RuntimeDescriptorReadState::Fresh);
    }

    #[test]
    fn rendered_descriptor_value_matches_legacy_diagnostics() {
        assert_eq!(rendered_descriptor_value(Some(&json!(999))), "999");
        assert_eq!(rendered_descriptor_value(None), "missing");
    }
}

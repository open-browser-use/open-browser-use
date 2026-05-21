//! Local host-side browser command policy.

use std::collections::BTreeSet;

use serde_json::{Value, json};
use url::Url;

use obu_wire::{ErrorCode, ErrorObject, error::ERR_DISALLOWED};

use crate::methods;

/// Comma/semicolon-delimited list of URL origins blocked by the local host policy.
///
/// Example: `OBU_HOST_POLICY_DENY_ORIGINS=https://example.com;https://admin.example`
pub const ENV_DENY_ORIGINS: &str = "OBU_HOST_POLICY_DENY_ORIGINS";
/// Comma/semicolon-delimited list of raw CDP method names blocked by the local host policy.
///
/// Use `*` to block all raw CDP.
pub const ENV_DENY_CDP_METHODS: &str = "OBU_HOST_POLICY_DENY_CDP_METHODS";
/// Boolean flag that blocks browser history reads when true.
pub const ENV_BLOCK_HISTORY: &str = "OBU_HOST_POLICY_BLOCK_HISTORY";
/// Boolean flag that blocks browser download commands when true.
pub const ENV_BLOCK_DOWNLOADS: &str = "OBU_HOST_POLICY_BLOCK_DOWNLOADS";
/// Boolean flag that blocks browser upload commands when true.
pub const ENV_BLOCK_UPLOADS: &str = "OBU_HOST_POLICY_BLOCK_UPLOADS";

/// Policy classification for an inbound browser method.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MethodPolicyKind {
    /// Health, metadata, and other non-sensitive methods.
    AlwaysAllowed,
    /// Method targets a URL supplied by the caller.
    TargetUrl,
    /// Method acts on the currently loaded tab origin.
    CurrentOrigin,
    /// Browser history access.
    History,
    /// Download or download-handle access.
    Download,
    /// File upload or file-chooser access.
    Upload,
    /// Raw Chrome DevTools Protocol.
    RawCdp,
    /// Internal lifecycle/control method.
    InternalLifecycle,
}

/// Explicit policy matrix for every supported inbound browser method.
///
/// New wire methods must be added here and to the SDK `METHOD_CLASSIFICATION`
/// map so method-name and policy-sync tests can catch missing policy review.
pub const METHOD_POLICY_CLASSIFICATIONS: &[(&str, MethodPolicyKind)] = &[
    (methods::PING, MethodPolicyKind::AlwaysAllowed),
    (methods::GET_INFO, MethodPolicyKind::AlwaysAllowed),
    (methods::GET_TABS, MethodPolicyKind::AlwaysAllowed),
    (methods::GET_CURRENT_TAB, MethodPolicyKind::AlwaysAllowed),
    (methods::NAME_SESSION, MethodPolicyKind::AlwaysAllowed),
    (
        methods::PLAYWRIGHT_WAIT_FOR_TIMEOUT,
        MethodPolicyKind::AlwaysAllowed,
    ),
    (methods::TURN_ENDED, MethodPolicyKind::InternalLifecycle),
    (
        methods::CLEAR_LIFECYCLE_DIAGNOSTICS,
        MethodPolicyKind::InternalLifecycle,
    ),
    (methods::FINALIZE_TABS, MethodPolicyKind::InternalLifecycle),
    (methods::YIELD_CONTROL, MethodPolicyKind::InternalLifecycle),
    (methods::RESUME_CONTROL, MethodPolicyKind::InternalLifecycle),
    (methods::ATTACH, MethodPolicyKind::InternalLifecycle),
    (methods::DETACH, MethodPolicyKind::InternalLifecycle),
    (
        methods::EXECUTE_UNHANDLED_COMMAND,
        MethodPolicyKind::InternalLifecycle,
    ),
    (methods::CREATE_TAB, MethodPolicyKind::TargetUrl),
    (methods::TAB_GOTO, MethodPolicyKind::TargetUrl),
    (methods::TAB_WAIT_FOR_URL, MethodPolicyKind::TargetUrl),
    (
        methods::PLAYWRIGHT_WAIT_FOR_URL,
        MethodPolicyKind::TargetUrl,
    ),
    (methods::GET_USER_HISTORY, MethodPolicyKind::History),
    (methods::GET_USER_TABS, MethodPolicyKind::History),
    (methods::GET_SELECTED_TAB, MethodPolicyKind::History),
    (methods::CLAIM_USER_TAB, MethodPolicyKind::History),
    (
        methods::PLAYWRIGHT_LOCATOR_DOWNLOAD_MEDIA,
        MethodPolicyKind::Download,
    ),
    (methods::CUA_DOWNLOAD_MEDIA, MethodPolicyKind::Download),
    (methods::DOM_CUA_DOWNLOAD_MEDIA, MethodPolicyKind::Download),
    (
        methods::PLAYWRIGHT_WAIT_FOR_DOWNLOAD,
        MethodPolicyKind::Download,
    ),
    (
        methods::PLAYWRIGHT_DOWNLOAD_PATH,
        MethodPolicyKind::Download,
    ),
    (
        methods::PLAYWRIGHT_FILE_CHOOSER_SET_FILES,
        MethodPolicyKind::Upload,
    ),
    (methods::EXECUTE_CDP, MethodPolicyKind::RawCdp),
    (methods::MOVE_MOUSE, MethodPolicyKind::CurrentOrigin),
    (methods::CUA_CLICK, MethodPolicyKind::CurrentOrigin),
    (methods::CUA_DBLCLICK, MethodPolicyKind::CurrentOrigin),
    (methods::CUA_SCROLL, MethodPolicyKind::CurrentOrigin),
    (methods::CUA_TYPE, MethodPolicyKind::CurrentOrigin),
    (methods::CUA_KEYPRESS, MethodPolicyKind::CurrentOrigin),
    (methods::CUA_DRAG, MethodPolicyKind::CurrentOrigin),
    (methods::CUA_MOVE, MethodPolicyKind::CurrentOrigin),
    (
        methods::DOM_CUA_GET_VISIBLE_DOM,
        MethodPolicyKind::CurrentOrigin,
    ),
    (methods::DOM_CUA_CLICK, MethodPolicyKind::CurrentOrigin),
    (
        methods::DOM_CUA_DOUBLE_CLICK,
        MethodPolicyKind::CurrentOrigin,
    ),
    (methods::DOM_CUA_SCROLL, MethodPolicyKind::CurrentOrigin),
    (methods::DOM_CUA_TYPE, MethodPolicyKind::CurrentOrigin),
    (methods::DOM_CUA_KEYPRESS, MethodPolicyKind::CurrentOrigin),
    (
        methods::PLAYWRIGHT_LOCATOR_CLICK,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::PLAYWRIGHT_LOCATOR_DBLCLICK,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::PLAYWRIGHT_LOCATOR_FILL,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::PLAYWRIGHT_LOCATOR_PRESS,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::PLAYWRIGHT_LOCATOR_WAIT_FOR,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::PLAYWRIGHT_LOCATOR_COUNT,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::PLAYWRIGHT_LOCATOR_SELECT_OPTION,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::PLAYWRIGHT_LOCATOR_SET_CHECKED,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::PLAYWRIGHT_LOCATOR_IS_VISIBLE,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::PLAYWRIGHT_LOCATOR_IS_ENABLED,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::PLAYWRIGHT_LOCATOR_ALL_TEXT_CONTENTS,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::PLAYWRIGHT_LOCATOR_TEXT_CONTENT,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::PLAYWRIGHT_LOCATOR_INNER_TEXT,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::PLAYWRIGHT_LOCATOR_GET_ATTRIBUTE,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::PLAYWRIGHT_LOCATOR_READ_ALL,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::PLAYWRIGHT_LOCATOR_HOVER,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::PLAYWRIGHT_LOCATOR_BOUNDING_BOX,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::PLAYWRIGHT_SCREENSHOT,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::PLAYWRIGHT_DOM_SNAPSHOT,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::PLAYWRIGHT_WAIT_FOR_LOAD_STATE,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::PLAYWRIGHT_WAIT_FOR_FILE_CHOOSER,
        MethodPolicyKind::CurrentOrigin,
    ),
    (methods::TAB_RELOAD, MethodPolicyKind::CurrentOrigin),
    (methods::TAB_BACK, MethodPolicyKind::CurrentOrigin),
    (methods::TAB_FORWARD, MethodPolicyKind::CurrentOrigin),
    (methods::TAB_CLOSE, MethodPolicyKind::CurrentOrigin),
    (methods::TAB_SCREENSHOT, MethodPolicyKind::CurrentOrigin),
    (
        methods::TAB_WAIT_FOR_LOAD_STATE,
        MethodPolicyKind::CurrentOrigin,
    ),
    (methods::TAB_CONTENT_EXPORT, MethodPolicyKind::CurrentOrigin),
    (methods::TAB_URL, MethodPolicyKind::CurrentOrigin),
    (methods::TAB_TITLE, MethodPolicyKind::CurrentOrigin),
    (
        methods::TAB_CLIPBOARD_READ_TEXT,
        MethodPolicyKind::CurrentOrigin,
    ),
    (
        methods::TAB_CLIPBOARD_WRITE_TEXT,
        MethodPolicyKind::CurrentOrigin,
    ),
    (methods::TAB_CLIPBOARD_READ, MethodPolicyKind::CurrentOrigin),
    (
        methods::TAB_CLIPBOARD_WRITE,
        MethodPolicyKind::CurrentOrigin,
    ),
];

/// Context passed to host policy checks.
#[derive(Debug, Clone)]
pub struct PolicyContext<'a> {
    /// Wire method being routed.
    pub command: &'a str,
    /// Method classification.
    pub kind: MethodPolicyKind,
    /// Optional tab id extracted from request params.
    pub tab_id: Option<&'a str>,
    /// Full request params.
    pub params: &'a Value,
}

/// Host-side policy hooks. Default implementations are permissive.
pub trait HostPolicy: Send + Sync {
    /// Whether this policy needs the dispatcher to resolve current tab URLs.
    fn needs_current_origin(&self, _command: &str) -> bool {
        false
    }

    /// Check a caller-supplied navigation URL.
    fn check_navigation(&self, _url: &str, _ctx: &PolicyContext<'_>) -> Result<(), ErrorObject> {
        Ok(())
    }

    /// Check the actual current URL observed from the backend.
    fn check_current_origin(
        &self,
        _tab_id: &str,
        _url: &str,
        _ctx: &PolicyContext<'_>,
    ) -> Result<(), ErrorObject> {
        Ok(())
    }

    /// Check browser history access.
    fn check_history(&self, _ctx: &PolicyContext<'_>) -> Result<(), ErrorObject> {
        Ok(())
    }

    /// Check a download command.
    fn check_download(&self, _ctx: &PolicyContext<'_>) -> Result<(), ErrorObject> {
        Ok(())
    }

    /// Check an upload command.
    fn check_upload(&self, _ctx: &PolicyContext<'_>) -> Result<(), ErrorObject> {
        Ok(())
    }

    /// Check a raw CDP command.
    fn check_raw_cdp(
        &self,
        _tab_id: &str,
        _method: &str,
        _params: &Value,
        _ctx: &PolicyContext<'_>,
    ) -> Result<(), ErrorObject> {
        Ok(())
    }
}

/// Default local policy: allow all commands.
#[derive(Debug, Default)]
pub struct PermissivePolicy;

impl HostPolicy for PermissivePolicy {}

/// Local host policy configuration.
///
/// The default is intentionally permissive. Deployments can opt into local
/// blocking without adding a remote policy oracle.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostPolicyConfig {
    /// Block navigation and current-origin commands on these normalized origins.
    pub deny_origins: BTreeSet<String>,
    /// Block raw CDP method names. `*` blocks all raw CDP.
    pub deny_cdp_methods: BTreeSet<String>,
    /// Block profile history reads.
    pub block_history: bool,
    /// Block download commands.
    pub block_downloads: bool,
    /// Block upload commands.
    pub block_uploads: bool,
}

impl HostPolicyConfig {
    /// Read local host policy configuration from the process environment.
    pub fn from_env() -> Self {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    fn from_lookup(mut lookup: impl FnMut(&str) -> Option<String>) -> Self {
        Self {
            deny_origins: split_list(lookup(ENV_DENY_ORIGINS).as_deref())
                .into_iter()
                .map(|value| normalize_origin(&value).unwrap_or_else(|| normalize_raw(&value)))
                .filter(|value| !value.is_empty())
                .collect(),
            deny_cdp_methods: split_list(lookup(ENV_DENY_CDP_METHODS).as_deref())
                .into_iter()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .collect(),
            block_history: env_flag(lookup(ENV_BLOCK_HISTORY).as_deref()),
            block_downloads: env_flag(lookup(ENV_BLOCK_DOWNLOADS).as_deref()),
            block_uploads: env_flag(lookup(ENV_BLOCK_UPLOADS).as_deref()),
        }
    }

    /// Whether this policy leaves every command category permissive.
    pub fn is_permissive(&self) -> bool {
        self.deny_origins.is_empty()
            && self.deny_cdp_methods.is_empty()
            && !self.block_history
            && !self.block_downloads
            && !self.block_uploads
    }
}

/// Host policy backed by local process configuration.
#[derive(Debug, Clone, Default)]
pub struct ConfiguredHostPolicy {
    config: HostPolicyConfig,
}

impl ConfiguredHostPolicy {
    /// Build a configured policy from explicit config.
    pub fn new(config: HostPolicyConfig) -> Self {
        Self { config }
    }

    /// Build a configured policy from environment variables.
    pub fn from_env() -> Self {
        Self::new(HostPolicyConfig::from_env())
    }

    fn denied_origin(&self, url: &str) -> Option<String> {
        let origin = normalize_origin(url)?;
        self.config.deny_origins.contains(&origin).then_some(origin)
    }
}

impl HostPolicy for ConfiguredHostPolicy {
    fn needs_current_origin(&self, _command: &str) -> bool {
        !self.config.deny_origins.is_empty()
    }

    fn check_navigation(&self, url: &str, ctx: &PolicyContext<'_>) -> Result<(), ErrorObject> {
        if let Some(origin) = self.denied_origin(url) {
            return Err(disallowed(
                "navigation blocked by local host policy",
                json!({ "command": ctx.command, "url": url, "origin": origin }),
            ));
        }
        Ok(())
    }

    fn check_current_origin(
        &self,
        _tab_id: &str,
        url: &str,
        ctx: &PolicyContext<'_>,
    ) -> Result<(), ErrorObject> {
        if let Some(origin) = self.denied_origin(url) {
            return Err(disallowed(
                "current origin blocked by local host policy",
                json!({ "command": ctx.command, "url": url, "origin": origin }),
            ));
        }
        Ok(())
    }

    fn check_history(&self, ctx: &PolicyContext<'_>) -> Result<(), ErrorObject> {
        if self.config.block_history {
            return Err(disallowed(
                "history access blocked by local host policy",
                json!({ "command": ctx.command }),
            ));
        }
        Ok(())
    }

    fn check_download(&self, ctx: &PolicyContext<'_>) -> Result<(), ErrorObject> {
        if self.config.block_downloads {
            return Err(disallowed(
                "download blocked by local host policy",
                json!({ "command": ctx.command }),
            ));
        }
        Ok(())
    }

    fn check_upload(&self, ctx: &PolicyContext<'_>) -> Result<(), ErrorObject> {
        if self.config.block_uploads {
            return Err(disallowed(
                "upload blocked by local host policy",
                json!({ "command": ctx.command }),
            ));
        }
        Ok(())
    }

    fn check_raw_cdp(
        &self,
        _tab_id: &str,
        method: &str,
        _params: &Value,
        ctx: &PolicyContext<'_>,
    ) -> Result<(), ErrorObject> {
        if self.config.deny_cdp_methods.contains("*")
            || self.config.deny_cdp_methods.contains(method)
        {
            return Err(disallowed(
                "raw CDP method blocked by local host policy",
                json!({ "command": ctx.command, "method": method }),
            ));
        }
        Ok(())
    }
}

/// Classify an inbound method for policy routing.
pub fn classify_method(method: &str) -> MethodPolicyKind {
    METHOD_POLICY_CLASSIFICATIONS
        .iter()
        .find_map(|(candidate, kind)| (*candidate == method).then_some(*kind))
        .unwrap_or(MethodPolicyKind::CurrentOrigin)
}

/// Whether host policy checks are explicitly disabled for local testing.
pub fn guard_mode_disabled() -> bool {
    std::env::var("OBU_GUARD_MODE").is_ok_and(|value| value == "disabled")
}

/// Build a standard disallowed error object.
pub fn disallowed(message: impl Into<String>, data: Value) -> ErrorObject {
    ErrorObject::new(ErrorCode::Server(ERR_DISALLOWED), message).with_data(data)
}

fn split_list(value: Option<&str>) -> Vec<String> {
    value
        .unwrap_or_default()
        .split([',', ';'])
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

fn env_flag(value: Option<&str>) -> bool {
    matches!(
        value.map(|value| value.trim().to_ascii_lowercase()),
        Some(value) if matches!(value.as_str(), "1" | "true" | "yes" | "on")
    )
}

fn normalize_origin(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    let host = url.host_str()?;
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Some(format!(
        "{}://{}{}",
        url.scheme(),
        host.to_ascii_lowercase(),
        port
    ))
}

fn normalize_raw(value: &str) -> String {
    value.trim().trim_end_matches('/').to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::BTreeSet;

    use obu_wire::{ErrorCode, error::ERR_DISALLOWED};

    #[test]
    fn method_policy_matrix_explicitly_covers_every_inbound_method() {
        let matrix_methods = METHOD_POLICY_CLASSIFICATIONS
            .iter()
            .map(|(method, _)| *method)
            .collect::<BTreeSet<_>>();
        assert_eq!(
            matrix_methods.len(),
            METHOD_POLICY_CLASSIFICATIONS.len(),
            "policy matrix contains duplicate method entries"
        );

        let inbound_methods = methods::ALL_INBOUND_METHODS
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        assert_eq!(
            matrix_methods, inbound_methods,
            "every inbound method must have an explicit policy classification",
        );
    }

    #[test]
    fn env_config_parses_local_policy_inputs() {
        let config = HostPolicyConfig::from_lookup(|name| match name {
            ENV_DENY_ORIGINS => {
                Some("https://Blocked.example/path; http://localhost:8080/x".into())
            }
            ENV_DENY_CDP_METHODS => Some("Page.navigate, Runtime.evaluate".into()),
            ENV_BLOCK_HISTORY => Some("true".into()),
            ENV_BLOCK_DOWNLOADS => Some("1".into()),
            ENV_BLOCK_UPLOADS => Some("yes".into()),
            _ => None,
        });

        assert!(config.deny_origins.contains("https://blocked.example"));
        assert!(config.deny_origins.contains("http://localhost:8080"));
        assert!(config.deny_cdp_methods.contains("Page.navigate"));
        assert!(config.deny_cdp_methods.contains("Runtime.evaluate"));
        assert!(config.block_history);
        assert!(config.block_downloads);
        assert!(config.block_uploads);
        assert!(!config.is_permissive());
    }

    #[test]
    fn configured_policy_blocks_opt_in_categories_locally() {
        let policy = ConfiguredHostPolicy::new(HostPolicyConfig {
            deny_origins: ["https://blocked.example"]
                .into_iter()
                .map(String::from)
                .collect(),
            deny_cdp_methods: ["Page.navigate"].into_iter().map(String::from).collect(),
            block_history: true,
            block_downloads: true,
            block_uploads: true,
        });
        let params = json!({});
        let ctx = PolicyContext {
            command: methods::TAB_GOTO,
            kind: MethodPolicyKind::TargetUrl,
            tab_id: Some("7"),
            params: &params,
        };

        assert!(policy.needs_current_origin(methods::PLAYWRIGHT_LOCATOR_CLICK));
        assert_disallowed(policy.check_navigation("https://blocked.example/path", &ctx));
        assert_disallowed(policy.check_current_origin(
            "7",
            "https://blocked.example/current",
            &ctx,
        ));
        assert!(
            policy
                .check_navigation("https://allowed.example/", &ctx)
                .is_ok()
        );
        assert_disallowed(policy.check_history(&ctx));
        assert_disallowed(policy.check_download(&ctx));
        assert_disallowed(policy.check_upload(&ctx));
        assert_disallowed(policy.check_raw_cdp("7", "Page.navigate", &Value::Null, &ctx));
        assert!(
            policy
                .check_raw_cdp("7", "Runtime.evaluate", &Value::Null, &ctx)
                .is_ok()
        );
    }

    fn assert_disallowed(result: Result<(), ErrorObject>) {
        let error = result.expect_err("policy check should be disallowed");
        assert_eq!(error.code, ErrorCode::Server(ERR_DISALLOWED));
    }
}

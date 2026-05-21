//! Navigation and page metadata handlers for the CDP backend.

use async_trait::async_trait;
use serde_json::Value;

use crate::backends::cdp::{CdpBackend, attach::require_session};
use crate::error::{HostError, Result};
use crate::ops::tab_navigation::{self, TabNavigationBackend};
use crate::tab_state::TabId;

struct CdpTabNavigation<'a> {
    backend: &'a CdpBackend,
}

#[async_trait]
impl TabNavigationBackend for CdpTabNavigation<'_> {
    async fn execute_cdp(&self, tab_id: &str, method: &str, params: Value) -> Result<Value> {
        let session_id = require_session(self.backend, tab_id)?;
        let operation = async {
            self.backend
                .transport()
                .send_command(method, params, Some(&session_id))
                .await
                .map_err(HostError::from)
        };
        if crate::backends::cdp::dialogs::method_can_open_dialog(method) {
            let context = crate::backends::cdp::dialogs::context_for_tab(
                self.backend,
                tab_id,
                &session_id,
                method,
            );
            crate::backends::cdp::dialogs::run_with_dialog_policy(self.backend, context, operation)
                .await
        } else {
            operation.await
        }
    }

    async fn refresh_tab_metadata(&self, tab_id: &str) -> Result<()> {
        let id = TabId::new(tab_id);
        let current_url = tab_navigation::url(self, tab_id).await.unwrap_or_default();
        let current_title = tab_navigation::title(self, tab_id)
            .await
            .unwrap_or_default();
        self.backend.registry().update(&id, |record| {
            record.url = current_url;
            record.title = current_title;
        })?;
        Ok(())
    }
}

/// Navigate a tab and wait for the load state.
pub async fn goto(backend: &CdpBackend, tab_id: &str, url: &str) -> Result<Value> {
    tab_navigation::goto(&CdpTabNavigation { backend }, tab_id, url).await
}

/// Reload a tab and wait for the load state.
pub async fn reload(backend: &CdpBackend, tab_id: &str) -> Result<Value> {
    tab_navigation::reload(&CdpTabNavigation { backend }, tab_id).await
}

/// Navigate back in session history if possible.
pub async fn back(backend: &CdpBackend, tab_id: &str) -> Result<Value> {
    tab_navigation::back(&CdpTabNavigation { backend }, tab_id).await
}

/// Navigate forward in session history if possible.
pub async fn forward(backend: &CdpBackend, tab_id: &str) -> Result<Value> {
    tab_navigation::forward(&CdpTabNavigation { backend }, tab_id).await
}

/// Wait until the exact URL is observed.
pub async fn wait_for_url(
    backend: &CdpBackend,
    tab_id: &str,
    expected_url: &str,
    timeout_ms: Option<u64>,
) -> Result<Value> {
    tab_navigation::wait_for_url(
        &CdpTabNavigation { backend },
        tab_id,
        expected_url,
        timeout_ms,
    )
    .await
}

/// Wait for a basic document load state.
pub async fn wait_for_load_state(
    backend: &CdpBackend,
    tab_id: &str,
    state: &str,
    timeout_ms: Option<u64>,
) -> Result<Value> {
    tab_navigation::wait_for_load_state(&CdpTabNavigation { backend }, tab_id, state, timeout_ms)
        .await
}

/// Return the current page URL.
pub async fn url(backend: &CdpBackend, tab_id: &str) -> Result<String> {
    tab_navigation::url(&CdpTabNavigation { backend }, tab_id).await
}

/// Return the current page title.
pub async fn title(backend: &CdpBackend, tab_id: &str) -> Result<String> {
    tab_navigation::title(&CdpTabNavigation { backend }, tab_id).await
}

pub(crate) async fn eval_value(
    backend: &CdpBackend,
    tab_id: &str,
    expression: &str,
) -> Result<Value> {
    tab_navigation::eval_value(&CdpTabNavigation { backend }, tab_id, expression).await
}

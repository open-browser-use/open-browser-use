//! Screenshot and content export handlers.

use async_trait::async_trait;
use serde_json::{Map, Value};

use crate::backends::{
    BackendRequestContext,
    cdp::{CdpBackend, attach::require_session},
};
use crate::error::{HostError, Result};
use crate::ops::content_export::{self as content_export_ops, ContentExportBackend};

/// Capture a PNG screenshot for the full viewport.
pub async fn screenshot(backend: &CdpBackend, tab_id: &str) -> Result<Value> {
    content_export_ops::screenshot(backend, &BackendRequestContext::default(), tab_id).await
}

/// Capture a PNG screenshot, optionally with crop params from the request.
pub async fn screenshot_with_params(backend: &CdpBackend, params: Value) -> Result<Value> {
    content_export_ops::screenshot_with_params(backend, &BackendRequestContext::default(), params)
        .await
}

/// Export page content as HTML, PNG, or PDF.
pub async fn content_export(backend: &CdpBackend, tab_id: &str, format: &str) -> Result<Value> {
    content_export_ops::export_content(backend, &BackendRequestContext::default(), tab_id, format)
        .await
}

#[async_trait]
impl ContentExportBackend for CdpBackend {
    async fn capture_screenshot_cdp(
        &self,
        _ctx: &BackendRequestContext,
        tab_id: &str,
        cdp_params: Value,
    ) -> Result<Value> {
        let session_id = require_session(self, tab_id)?;
        self.transport()
            .send_command("Page.captureScreenshot", cdp_params, Some(&session_id))
            .await
            .map_err(HostError::from)
    }

    async fn print_pdf_cdp(&self, _ctx: &BackendRequestContext, tab_id: &str) -> Result<Value> {
        let session_id = require_session(self, tab_id)?;
        self.transport()
            .send_command(
                "Page.printToPDF",
                Value::Object(Map::new()),
                Some(&session_id),
            )
            .await
            .map_err(HostError::from)
    }

    async fn document_html(&self, _ctx: &BackendRequestContext, tab_id: &str) -> Result<String> {
        Ok(super::tab_goto::eval_value(
            self,
            tab_id,
            "document.documentElement ? document.documentElement.outerHTML : ''",
        )
        .await?
        .as_str()
        .unwrap_or_default()
        .to_string())
    }
}

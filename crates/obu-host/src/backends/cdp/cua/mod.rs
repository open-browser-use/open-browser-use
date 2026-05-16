//! Coordinate-based CUA commands backed by raw CDP input events.

use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::backends::cdp::{
    CdpBackend, attach::require_session, compose::tab_goto, transport::CdpEvent,
};
use crate::error::{HostError, Result};
use crate::ops::cua as cua_ops;
use crate::ops::cua::{
    CoordinateCommand, KeyEventSink, MouseEvent, MouseEventSink, NavigationWaitOptions,
    NavigationWaiter,
};
use crate::ops::event_wait;

/// Dispatch a CUA command.
pub async fn run(backend: &CdpBackend, method: &str, params: Value) -> Result<Value> {
    match cua_ops::coordinate_command(method) {
        Some(CoordinateCommand::Click { click_count }) => click(backend, params, click_count).await,
        Some(CoordinateCommand::Scroll) => scroll(backend, params).await,
        Some(CoordinateCommand::TypeText) => type_text(backend, params).await,
        Some(CoordinateCommand::Keypress) => keypress(backend, params).await,
        Some(CoordinateCommand::Drag) => drag(backend, params).await,
        Some(CoordinateCommand::Move) => move_mouse(backend, params).await,
        Some(CoordinateCommand::DownloadMedia) => Err(HostError::NotImplemented(
            "cua_download_media is deferred to the WebExtension backend".into(),
        )),
        None => Err(HostError::NotImplemented(format!("cua command {method}"))),
    }
}

async fn click(backend: &CdpBackend, params: Value, click_count: i64) -> Result<Value> {
    let tab_id = cua_ops::command_tab_id(&params)?;
    let session_id = require_session(backend, tab_id)?;
    let sink = CdpMouseEventSink {
        backend,
        session_id: &session_id,
    };
    let navigation = CdpNavigationWaiter {
        backend,
        session_id: &session_id,
    };
    cua_ops::dispatch_click_command(
        &sink,
        &navigation,
        &params,
        click_count,
        cua_ops::NumericErrorStyle::Missing,
    )
    .await
}

async fn wait_for_navigation_event(
    mut events: broadcast::Receiver<CdpEvent>,
    session_id: &str,
    timeout_ms: u64,
) -> Result<()> {
    event_wait::wait_for_broadcast_event_matching(
        &mut events,
        timeout_ms,
        format!("navigation event timed out after {timeout_ms}ms"),
        |error| HostError::Protocol(format!("CDP event bus closed: {error}")),
        |event| {
            if event.session_id.as_deref() == Some(session_id)
                && is_navigation_event(&event.method, &event.params)
            {
                return Some(());
            }
            None
        },
    )
    .await
}

fn is_navigation_event(method: &str, params: &Value) -> bool {
    match method {
        "Page.navigatedWithinDocument" | "Page.loadEventFired" => true,
        "Page.frameNavigated" => params
            .get("frame")
            .and_then(|frame| frame.get("parentId"))
            .is_none(),
        _ => false,
    }
}

async fn move_mouse(backend: &CdpBackend, params: Value) -> Result<Value> {
    let session_id = require_session(backend, cua_ops::command_tab_id(&params)?)?;
    let sink = CdpMouseEventSink {
        backend,
        session_id: &session_id,
    };
    cua_ops::dispatch_move_command(&sink, &params, cua_ops::NumericErrorStyle::Missing).await
}

async fn scroll(backend: &CdpBackend, params: Value) -> Result<Value> {
    let session_id = require_session(backend, required_str(&params, "tab_id")?)?;
    let x = required_f64(&params, "x")?;
    let y = required_f64(&params, "y")?;
    let delta_x = cua_ops::scroll_delta(&params, "deltaX", "delta_x");
    let delta_y = cua_ops::scroll_delta(&params, "deltaY", "delta_y");
    dispatch_mouse(backend, &session_id, cua_ops::mouse_move_event(x, y)).await?;
    if dispatch_scroll_gesture(backend, &session_id, x, y, delta_x, delta_y)
        .await
        .is_err()
    {
        dispatch_mouse_wheel(backend, &session_id, x, y, delta_x, delta_y).await?;
    }
    Ok(Value::Null)
}

async fn dispatch_scroll_gesture(
    backend: &CdpBackend,
    session_id: &str,
    x: f64,
    y: f64,
    delta_x: f64,
    delta_y: f64,
) -> Result<()> {
    backend
        .transport()
        .send_command(
            "Input.synthesizeScrollGesture",
            cua_ops::scroll_gesture_params(x, y, delta_x, delta_y),
            Some(session_id),
        )
        .await
        .map(|_| ())
        .map_err(HostError::from)
}

async fn dispatch_mouse_wheel(
    backend: &CdpBackend,
    session_id: &str,
    x: f64,
    y: f64,
    delta_x: f64,
    delta_y: f64,
) -> Result<()> {
    backend
        .transport()
        .send_command(
            "Input.dispatchMouseEvent",
            cua_ops::mouse_wheel_params(x, y, delta_x, delta_y),
            Some(session_id),
        )
        .await
        .map(|_| ())
        .map_err(HostError::from)
}

async fn type_text(backend: &CdpBackend, params: Value) -> Result<Value> {
    let session_id = require_session(backend, required_str(&params, "tab_id")?)?;
    let text = required_str(&params, "text")?;
    backend
        .transport()
        .send_command(
            "Input.insertText",
            json!({ "text": text }),
            Some(&session_id),
        )
        .await
        .map_err(HostError::from)?;
    Ok(Value::Null)
}

async fn keypress(backend: &CdpBackend, params: Value) -> Result<Value> {
    let session_id = require_session(backend, cua_ops::command_tab_id(&params)?)?;
    let sink = CdpKeyEventSink {
        backend,
        session_id: &session_id,
    };
    cua_ops::dispatch_keypress_command(&sink, &params).await
}

async fn drag(backend: &CdpBackend, params: Value) -> Result<Value> {
    let session_id = require_session(backend, cua_ops::command_tab_id(&params)?)?;
    let path = cua_ops::interpolated_drag_path(&params, 20)?;
    let sink = CdpMouseEventSink {
        backend,
        session_id: &session_id,
    };
    cua_ops::dispatch_drag_path_command(&sink, path.as_slice()).await
}

struct CdpMouseEventSink<'a> {
    backend: &'a CdpBackend,
    session_id: &'a str,
}

#[async_trait::async_trait]
impl MouseEventSink for CdpMouseEventSink<'_> {
    async fn dispatch_mouse_event(&self, event: MouseEvent<'_>) -> Result<()> {
        dispatch_mouse(self.backend, self.session_id, event).await
    }
}

struct CdpNavigationWaiter<'a> {
    backend: &'a CdpBackend,
    session_id: &'a str,
}

#[async_trait::async_trait]
impl NavigationWaiter for CdpNavigationWaiter<'_> {
    type Token = broadcast::Receiver<CdpEvent>;

    async fn arm_navigation_wait(
        &self,
        _tab_id: &str,
        _wait: &NavigationWaitOptions,
    ) -> Result<Self::Token> {
        let rx = self.backend.transport().subscribe_events();
        self.backend
            .transport()
            .send_command("Page.enable", json!({}), Some(self.session_id))
            .await
            .map_err(HostError::from)?;
        Ok(rx)
    }

    async fn wait_for_navigation(
        &self,
        tab_id: &str,
        wait: &NavigationWaitOptions,
        events: Self::Token,
    ) -> Result<()> {
        wait_for_navigation_event(events, self.session_id, wait.timeout_ms).await?;
        tab_goto::wait_for_load_state(
            self.backend,
            tab_id,
            &wait.wait_until,
            Some(wait.timeout_ms),
        )
        .await
        .map(|_| ())
    }
}

struct CdpKeyEventSink<'a> {
    backend: &'a CdpBackend,
    session_id: &'a str,
}

#[async_trait::async_trait]
impl KeyEventSink for CdpKeyEventSink<'_> {
    async fn dispatch_key_event(&self, event: Value) -> Result<()> {
        self.backend
            .transport()
            .send_command("Input.dispatchKeyEvent", event, Some(self.session_id))
            .await
            .map(|_| ())
            .map_err(HostError::from)
    }
}

async fn dispatch_mouse(
    backend: &CdpBackend,
    session_id: &str,
    event: MouseEvent<'_>,
) -> Result<()> {
    backend
        .transport()
        .send_command(
            "Input.dispatchMouseEvent",
            event.to_cdp_params(),
            Some(session_id),
        )
        .await
        .map_err(HostError::from)?;
    Ok(())
}

fn required_str<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::Protocol(format!("missing {key}")))
}

fn required_f64(params: &Value, key: &str) -> Result<f64> {
    params
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| HostError::Protocol(format!("missing {key}")))
}

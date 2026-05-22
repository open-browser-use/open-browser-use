//! Shared coordinate-level CUA input helpers.

use serde_json::{Map, Value, json};

use crate::methods;

const DEFAULT_NAVIGATION_WAIT_MS: u64 = 30_000;

/// Backend-agnostic coordinate CUA command kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CoordinateCommand {
    Click { click_count: i64 },
    Scroll,
    TypeText,
    Keypress,
    Drag,
    Move,
    DownloadMedia,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ScrollDispatchPlan {
    GestureThenWheel,
    WheelOnly,
}

/// Classify method names that belong to the coordinate CUA surface.
pub(crate) fn coordinate_command(method: &str) -> Option<CoordinateCommand> {
    match method {
        methods::CUA_CLICK => Some(CoordinateCommand::Click { click_count: 1 }),
        methods::CUA_DBLCLICK => Some(CoordinateCommand::Click { click_count: 2 }),
        methods::CUA_SCROLL => Some(CoordinateCommand::Scroll),
        methods::CUA_TYPE => Some(CoordinateCommand::TypeText),
        methods::CUA_KEYPRESS => Some(CoordinateCommand::Keypress),
        methods::CUA_DRAG => Some(CoordinateCommand::Drag),
        methods::CUA_MOVE => Some(CoordinateCommand::Move),
        methods::CUA_DOWNLOAD_MEDIA => Some(CoordinateCommand::DownloadMedia),
        _ => None,
    }
}

/// Parsed explicit navigation wait options for coordinate input.
#[derive(Debug, Clone)]
pub(crate) struct NavigationWaitOptions {
    /// Desired load state.
    pub wait_until: String,
    /// Timeout in milliseconds.
    pub timeout_ms: u64,
}

/// CDP mouse event payload.
#[derive(Debug, Clone, Copy)]
pub(crate) struct MouseEvent<'a> {
    /// CDP event type.
    pub event_type: &'a str,
    /// X coordinate in CSS pixels.
    pub x: f64,
    /// Y coordinate in CSS pixels.
    pub y: f64,
    /// CDP button name.
    pub button: &'a str,
    /// CDP buttons bitmask.
    pub buttons: i64,
    /// Click count.
    pub click_count: i64,
    /// CDP keyboard modifier bitmask active for this mouse event.
    pub modifiers: i64,
}

impl MouseEvent<'_> {
    /// Convert to raw CDP params.
    pub fn to_cdp_params(self) -> Value {
        json!({
            "type": self.event_type,
            "x": self.x,
            "y": self.y,
            "button": self.button,
            "buttons": self.buttons,
            "clickCount": self.click_count,
            "modifiers": self.modifiers,
        })
    }
}

/// Backend edge for dispatching already-composed mouse events.
#[async_trait::async_trait]
pub(crate) trait MouseEventSink {
    /// Send one mouse event through the concrete backend transport.
    async fn dispatch_mouse_event(&self, event: MouseEvent<'_>) -> crate::error::Result<()>;
}

/// Backend edge for dispatching already-composed key events.
#[async_trait::async_trait]
pub(crate) trait KeyEventSink {
    /// Send one key event through the concrete backend transport.
    async fn dispatch_key_event(&self, event: Value) -> crate::error::Result<()>;
}

/// Backend edge for arming and completing an explicit click navigation wait.
#[async_trait::async_trait]
pub(crate) trait NavigationWaiter {
    /// Backend-specific token captured before the click is dispatched.
    type Token: Send;

    /// Arm navigation observation before input is sent.
    async fn arm_navigation_wait(
        &self,
        tab_id: &str,
        wait: &NavigationWaitOptions,
    ) -> crate::error::Result<Self::Token>;

    /// Complete the navigation wait after input is sent.
    async fn wait_for_navigation(
        &self,
        tab_id: &str,
        wait: &NavigationWaitOptions,
        token: Self::Token,
    ) -> crate::error::Result<()>;
}

/// Build a pointer move event with no pressed buttons and explicit modifiers.
pub(crate) fn mouse_move_event_with_modifiers(
    x: f64,
    y: f64,
    modifiers: i64,
) -> MouseEvent<'static> {
    MouseEvent {
        event_type: "mouseMoved",
        x,
        y,
        button: "none",
        buttons: 0,
        click_count: 0,
        modifiers,
    }
}

/// Build a mouse press event for a named button and explicit modifiers.
pub(crate) fn mouse_press_event_with_modifiers<'a>(
    x: f64,
    y: f64,
    button: &'a str,
    click_count: i64,
    modifiers: i64,
) -> MouseEvent<'a> {
    MouseEvent {
        event_type: "mousePressed",
        x,
        y,
        button,
        buttons: button_mask(button),
        click_count,
        modifiers,
    }
}

/// Build a mouse release event for a named button and explicit modifiers.
pub(crate) fn mouse_release_event_with_modifiers<'a>(
    x: f64,
    y: f64,
    button: &'a str,
    click_count: i64,
    modifiers: i64,
) -> MouseEvent<'a> {
    MouseEvent {
        event_type: "mouseReleased",
        x,
        y,
        button,
        buttons: 0,
        click_count,
        modifiers,
    }
}

/// Build the CDP mouse event sequence for a single or double click.
#[cfg(test)]
pub(crate) fn click_events<'a>(
    x: f64,
    y: f64,
    button: &'a str,
    click_count: i64,
) -> Vec<MouseEvent<'a>> {
    click_events_with_modifiers(x, y, button, click_count, 0)
}

/// Build the CDP mouse event sequence for a click with explicit modifiers.
pub(crate) fn click_events_with_modifiers<'a>(
    x: f64,
    y: f64,
    button: &'a str,
    click_count: i64,
    modifiers: i64,
) -> Vec<MouseEvent<'a>> {
    let mut events = Vec::with_capacity(1 + (click_count.max(0) as usize * 2));
    events.push(mouse_move_event_with_modifiers(x, y, modifiers));
    for count in 1..=click_count {
        events.push(mouse_press_event_with_modifiers(
            x, y, button, count, modifiers,
        ));
        events.push(mouse_release_event_with_modifiers(
            x, y, button, count, modifiers,
        ));
    }
    events
}

/// Dispatch a single or double click through the concrete backend sink.
pub(crate) async fn dispatch_click<S>(
    sink: &S,
    x: f64,
    y: f64,
    button: &str,
    click_count: i64,
    modifiers: i64,
) -> crate::error::Result<()>
where
    S: MouseEventSink + Sync,
{
    for event in click_events_with_modifiers(x, y, button, click_count, modifiers) {
        sink.dispatch_mouse_event(event).await?;
    }
    Ok(())
}

/// Dispatch a click and run the backend-specific explicit navigation wait around it.
pub(crate) async fn dispatch_click_with_navigation_wait<S, N>(
    sink: &S,
    navigation: &N,
    tab_id: &str,
    x: f64,
    y: f64,
    button: &str,
    click_count: i64,
    params: &Value,
) -> crate::error::Result<()>
where
    S: MouseEventSink + Sync,
    N: NavigationWaiter + Sync,
{
    let navigation_wait = navigation_wait_options(params);
    let modifiers = modifiers_mask(params);
    let token = if let Some(wait) = navigation_wait.as_ref() {
        Some(navigation.arm_navigation_wait(tab_id, wait).await?)
    } else {
        None
    };
    dispatch_click(sink, x, y, button, click_count, modifiers).await?;
    if let (Some(wait), Some(token)) = (navigation_wait.as_ref(), token) {
        navigation.wait_for_navigation(tab_id, wait, token).await?;
    }
    Ok(())
}

/// Parse and dispatch a coordinate click command through backend edge sinks.
pub(crate) async fn dispatch_click_command<S, N>(
    sink: &S,
    navigation: &N,
    params: &Value,
    click_count: i64,
    numeric_error_style: NumericErrorStyle,
) -> crate::error::Result<Value>
where
    S: MouseEventSink + Sync,
    N: NavigationWaiter + Sync,
{
    let tab_id = command_tab_id(params)?;
    let (x, y) = command_point(params, numeric_error_style)?;
    dispatch_click_command_at(sink, navigation, tab_id, x, y, params, click_count).await
}

/// Dispatch a coordinate click command after the backend has inspected the point.
pub(crate) async fn dispatch_click_command_at<S, N>(
    sink: &S,
    navigation: &N,
    tab_id: &str,
    x: f64,
    y: f64,
    params: &Value,
    click_count: i64,
) -> crate::error::Result<Value>
where
    S: MouseEventSink + Sync,
    N: NavigationWaiter + Sync,
{
    let button = command_button(params);
    dispatch_click_with_navigation_wait(
        sink,
        navigation,
        tab_id,
        x,
        y,
        button,
        click_count,
        params,
    )
    .await?;
    Ok(Value::Null)
}

/// Dispatch a single mouse move through the concrete backend sink.
#[cfg(test)]
pub(crate) async fn dispatch_move<S>(sink: &S, x: f64, y: f64) -> crate::error::Result<()>
where
    S: MouseEventSink + Sync,
{
    dispatch_move_with_modifiers(sink, x, y, 0).await
}

/// Dispatch a single mouse move with explicit modifiers.
pub(crate) async fn dispatch_move_with_modifiers<S>(
    sink: &S,
    x: f64,
    y: f64,
    modifiers: i64,
) -> crate::error::Result<()>
where
    S: MouseEventSink + Sync,
{
    sink.dispatch_mouse_event(mouse_move_event_with_modifiers(x, y, modifiers))
        .await
}

/// Parse and dispatch a coordinate move command.
pub(crate) async fn dispatch_move_command<S>(
    sink: &S,
    params: &Value,
    numeric_error_style: NumericErrorStyle,
) -> crate::error::Result<Value>
where
    S: MouseEventSink + Sync,
{
    let (x, y) = command_point(params, numeric_error_style)?;
    dispatch_move_command_at(sink, x, y, modifiers_mask(params)).await
}

/// Dispatch a coordinate move command after the backend has inspected the point.
pub(crate) async fn dispatch_move_command_at<S>(
    sink: &S,
    x: f64,
    y: f64,
    modifiers: i64,
) -> crate::error::Result<Value>
where
    S: MouseEventSink + Sync,
{
    dispatch_move_with_modifiers(sink, x, y, modifiers).await?;
    Ok(Value::Null)
}

/// Build the initial mouse move and press events for coordinate drag.
#[cfg(test)]
pub(crate) fn drag_start_events(x: f64, y: f64) -> [MouseEvent<'static>; 2] {
    drag_start_events_with_modifiers(x, y, 0)
}

/// Build the initial mouse move and press events for coordinate drag with explicit modifiers.
pub(crate) fn drag_start_events_with_modifiers(
    x: f64,
    y: f64,
    modifiers: i64,
) -> [MouseEvent<'static>; 2] {
    [
        mouse_move_event_with_modifiers(x, y, modifiers),
        mouse_press_event_with_modifiers(x, y, "left", 1, modifiers),
    ]
}

/// Build a pressed-button drag move event.
#[cfg(test)]
pub(crate) fn drag_move_event(x: f64, y: f64) -> MouseEvent<'static> {
    drag_move_event_with_modifiers(x, y, 0)
}

/// Build a pressed-button drag move event with explicit modifiers.
pub(crate) fn drag_move_event_with_modifiers(
    x: f64,
    y: f64,
    modifiers: i64,
) -> MouseEvent<'static> {
    MouseEvent {
        event_type: "mouseMoved",
        x,
        y,
        button: "left",
        buttons: 1,
        click_count: 1,
        modifiers,
    }
}

/// Build a left-button drag release event.
#[cfg(test)]
pub(crate) fn drag_release_event(x: f64, y: f64) -> MouseEvent<'static> {
    drag_release_event_with_modifiers(x, y, 0)
}

/// Build a left-button drag release event with explicit modifiers.
pub(crate) fn drag_release_event_with_modifiers(
    x: f64,
    y: f64,
    modifiers: i64,
) -> MouseEvent<'static> {
    mouse_release_event_with_modifiers(x, y, "left", 1, modifiers)
}

/// Dispatch a drag path and release the mouse at the last successful point if a move fails.
#[cfg(test)]
pub(crate) async fn dispatch_drag_path<S>(sink: &S, path: &[(f64, f64)]) -> crate::error::Result<()>
where
    S: MouseEventSink + Sync,
{
    dispatch_drag_path_with_modifiers(sink, path, 0).await
}

/// Dispatch a drag path with explicit modifiers and release at the last successful point on failure.
pub(crate) async fn dispatch_drag_path_with_modifiers<S>(
    sink: &S,
    path: &[(f64, f64)],
    modifiers: i64,
) -> crate::error::Result<()>
where
    S: MouseEventSink + Sync,
{
    let Some((first, rest)) = path.split_first() else {
        return Ok(());
    };
    for event in drag_start_events_with_modifiers(first.0, first.1, modifiers) {
        sink.dispatch_mouse_event(event).await?;
    }
    let mut last = *first;
    for (x, y) in rest {
        let result = sink
            .dispatch_mouse_event(drag_move_event_with_modifiers(*x, *y, modifiers))
            .await;
        if let Err(error) = result {
            let _ = sink
                .dispatch_mouse_event(drag_release_event_with_modifiers(last.0, last.1, modifiers))
                .await;
            return Err(error);
        }
        last = (*x, *y);
    }
    sink.dispatch_mouse_event(drag_release_event_with_modifiers(last.0, last.1, modifiers))
        .await
}

/// Dispatch a parsed drag path and return the wire command result shape.
pub(crate) async fn dispatch_drag_path_command<S>(
    sink: &S,
    path: &[(f64, f64)],
    modifiers: i64,
) -> crate::error::Result<Value>
where
    S: MouseEventSink + Sync,
{
    dispatch_drag_path_with_modifiers(sink, path, modifiers).await?;
    Ok(Value::Null)
}

/// Parse explicit navigation wait options.
pub(crate) fn navigation_wait_options(params: &Value) -> Option<NavigationWaitOptions> {
    if params.get("wait_for_navigation").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    Some(NavigationWaitOptions {
        wait_until: params
            .get("navigation_wait_until")
            .and_then(Value::as_str)
            .unwrap_or("load")
            .to_string(),
        timeout_ms: params
            .get("navigation_timeout_ms")
            .or_else(|| params.get("timeout_ms"))
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_NAVIGATION_WAIT_MS),
    })
}

/// CDP button bitmask for a button name.
pub(crate) fn button_mask(button: &str) -> i64 {
    match button {
        "left" => 1,
        "right" => 2,
        "middle" => 4,
        _ => 1,
    }
}

/// CDP modifier bitmask from CUA keyboard params.
pub(crate) fn modifiers_mask(params: &Value) -> i64 {
    let keys = params
        .get("modifiers")
        .or_else(|| params.get("keys"))
        .and_then(Value::as_array);
    let Some(keys) = keys else {
        return 0;
    };
    keys.iter().filter_map(Value::as_str).fold(0, |mask, key| {
        mask | match key.to_ascii_lowercase().as_str() {
            "alt" | "option" => 1,
            "control" | "ctrl" => 2,
            "controlormeta" | "control_or_meta" | "control-or-meta" => primary_modifier_mask(),
            "meta" | "cmd" | "command" => 4,
            "shift" => 8,
            _ => 0,
        }
    })
}

/// Parse a drag path, preserving only explicit path points or from/to endpoints.
pub(crate) fn endpoint_drag_path(params: &Value) -> crate::error::Result<Vec<(f64, f64)>> {
    if let Some(path) = explicit_drag_path(params, NumericErrorStyle::MissingNumeric)? {
        return Ok(path);
    }
    let from = params
        .get("from")
        .ok_or_else(|| crate::error::HostError::Protocol("drag requires from/to or path".into()))?;
    let to = params
        .get("to")
        .ok_or_else(|| crate::error::HostError::Protocol("drag requires from/to or path".into()))?;
    Ok(vec![
        (
            required_f64(from, "x", NumericErrorStyle::MissingNumeric)?,
            required_f64(from, "y", NumericErrorStyle::MissingNumeric)?,
        ),
        (
            required_f64(to, "x", NumericErrorStyle::MissingNumeric)?,
            required_f64(to, "y", NumericErrorStyle::MissingNumeric)?,
        ),
    ])
}

/// Parse a drag path, interpolating from/to endpoints when no explicit path is given.
pub(crate) fn interpolated_drag_path(
    params: &Value,
    default_steps: u64,
) -> crate::error::Result<Vec<(f64, f64)>> {
    if let Some(path) = explicit_drag_path(params, NumericErrorStyle::Missing)? {
        return Ok(path);
    }
    let from = params
        .get("from")
        .ok_or_else(|| crate::error::HostError::Protocol("missing drag path/from".into()))?;
    let to = params
        .get("to")
        .ok_or_else(|| crate::error::HostError::Protocol("missing drag path/to".into()))?;
    let from_x = required_f64(from, "x", NumericErrorStyle::Missing)?;
    let from_y = required_f64(from, "y", NumericErrorStyle::Missing)?;
    let to_x = required_f64(to, "x", NumericErrorStyle::Missing)?;
    let to_y = required_f64(to, "y", NumericErrorStyle::Missing)?;
    let steps = params
        .get("steps")
        .and_then(Value::as_u64)
        .unwrap_or(default_steps)
        .max(1);
    Ok((0..=steps)
        .map(|index| {
            let t = index as f64 / steps as f64;
            (from_x + (to_x - from_x) * t, from_y + (to_y - from_y) * t)
        })
        .collect())
}

/// Read a scroll delta from camelCase or snake_case params.
pub(crate) fn scroll_delta(params: &Value, camel_key: &str, snake_key: &str) -> f64 {
    params
        .get(camel_key)
        .or_else(|| params.get(snake_key))
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

pub(crate) fn scroll_dispatch_plan(modifiers: i64) -> ScrollDispatchPlan {
    if modifiers == 0 {
        ScrollDispatchPlan::GestureThenWheel
    } else {
        ScrollDispatchPlan::WheelOnly
    }
}

/// CDP params for synthesized scroll gesture.
pub(crate) fn scroll_gesture_params(x: f64, y: f64, delta_x: f64, delta_y: f64) -> Value {
    json!({
        "x": x,
        "y": y,
        "xDistance": if delta_x == 0.0 { 0.0 } else { -delta_x },
        "yDistance": if delta_y == 0.0 { 0.0 } else { -delta_y },
        "gestureSourceType": "mouse",
        "preventFling": true,
        "speed": 8000,
    })
}

/// CDP params for mouse wheel fallback.
pub(crate) fn mouse_wheel_params(
    x: f64,
    y: f64,
    delta_x: f64,
    delta_y: f64,
    modifiers: i64,
) -> Value {
    json!({
        "type": "mouseWheel",
        "x": x,
        "y": y,
        "deltaX": delta_x,
        "deltaY": delta_y,
        "modifiers": modifiers,
    })
}

/// Build CDP keyDown/keyUp params for CUA keypress commands.
pub(crate) fn keypress_events(params: &Value) -> crate::error::Result<Vec<Value>> {
    crate::ops::keyboard::keypress_events(params)
}

/// Build and dispatch CDP key events for a CUA keypress command.
pub(crate) async fn dispatch_keypress<S>(sink: &S, params: &Value) -> crate::error::Result<()>
where
    S: KeyEventSink + Sync,
{
    for event in keypress_events(params)? {
        sink.dispatch_key_event(event).await?;
    }
    Ok(())
}

/// Parse and dispatch a keypress command.
pub(crate) async fn dispatch_keypress_command<S>(
    sink: &S,
    params: &Value,
) -> crate::error::Result<Value>
where
    S: KeyEventSink + Sync,
{
    dispatch_keypress(sink, params).await?;
    Ok(Value::Null)
}

/// Build CUA click params while preserving explicit navigation wait options.
pub(crate) fn click_params_with_navigation_wait(
    tab_id: &str,
    x: f64,
    y: f64,
    button: &str,
    source: &Value,
) -> Value {
    let mut params = Map::new();
    params.insert("tab_id".into(), Value::String(tab_id.to_string()));
    params.insert("x".into(), json!(x));
    params.insert("y".into(), json!(y));
    params.insert("button".into(), Value::String(button.to_string()));

    if source.get("wait_for_navigation").and_then(Value::as_bool) == Some(true) {
        params.insert("wait_for_navigation".into(), Value::Bool(true));
        if let Some(wait_until) = source.get("navigation_wait_until") {
            params.insert("navigation_wait_until".into(), wait_until.clone());
        }
        if let Some(timeout) = source
            .get("navigation_timeout_ms")
            .or_else(|| source.get("timeout_ms"))
        {
            params.insert("navigation_timeout_ms".into(), timeout.clone());
        }
    }
    if let Some(modifiers) = source.get("modifiers").or_else(|| source.get("keys")) {
        params.insert("modifiers".into(), modifiers.clone());
    }

    Value::Object(params)
}

/// Read the target tab id from a coordinate CUA command.
pub(crate) fn command_tab_id<'a>(params: &'a Value) -> crate::error::Result<&'a str> {
    required_str(params, "tab_id")
}

/// Read the target point from a coordinate CUA command.
pub(crate) fn command_point(
    params: &Value,
    numeric_error_style: NumericErrorStyle,
) -> crate::error::Result<(f64, f64)> {
    Ok((
        required_f64(params, "x", numeric_error_style)?,
        required_f64(params, "y", numeric_error_style)?,
    ))
}

/// Read the mouse button from a coordinate CUA command.
pub(crate) fn command_button(params: &Value) -> &str {
    params
        .get("button")
        .and_then(Value::as_str)
        .unwrap_or("left")
}

fn primary_modifier_mask() -> i64 {
    if cfg!(target_os = "macos") { 4 } else { 2 }
}

#[cfg(test)]
fn primary_modifier_dispatch_key() -> &'static str {
    if cfg!(target_os = "macos") {
        "Meta"
    } else {
        "Control"
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum NumericErrorStyle {
    Missing,
    MissingNumeric,
}

fn explicit_drag_path(
    params: &Value,
    style: NumericErrorStyle,
) -> crate::error::Result<Option<Vec<(f64, f64)>>> {
    let Some(path) = params.get("path").and_then(Value::as_array) else {
        return Ok(None);
    };
    path.iter()
        .map(|point| {
            Ok((
                required_f64(point, "x", style)?,
                required_f64(point, "y", style)?,
            ))
        })
        .collect::<crate::error::Result<Vec<_>>>()
        .map(Some)
}

fn required_f64(params: &Value, key: &str, style: NumericErrorStyle) -> crate::error::Result<f64> {
    params
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| match style {
            NumericErrorStyle::Missing => {
                crate::error::HostError::Protocol(format!("missing {key}"))
            }
            NumericErrorStyle::MissingNumeric => {
                crate::error::HostError::Protocol(format!("missing numeric {key}"))
            }
        })
}

fn required_str<'a>(params: &'a Value, key: &str) -> crate::error::Result<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| crate::error::HostError::Protocol(format!("missing {key}")))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::*;

    #[test]
    fn coordinate_command_classifies_cua_method_names() {
        assert_eq!(
            coordinate_command(methods::CUA_CLICK),
            Some(CoordinateCommand::Click { click_count: 1 })
        );
        assert_eq!(
            coordinate_command(methods::CUA_DBLCLICK),
            Some(CoordinateCommand::Click { click_count: 2 })
        );
        assert_eq!(
            coordinate_command(methods::CUA_DOWNLOAD_MEDIA),
            Some(CoordinateCommand::DownloadMedia)
        );
        assert_eq!(coordinate_command(methods::DOM_CUA_CLICK), None);
    }

    #[test]
    fn modifiers_mask_accepts_shared_aliases() {
        let mask = modifiers_mask(&json!({
            "modifiers": ["option", "ctrl", "cmd", "shift", "control_or_meta", "ignored"]
        }));
        assert_eq!(mask & 1, 1);
        assert_eq!(mask & 2, 2);
        assert_eq!(mask & 4, 4);
        assert_eq!(mask & 8, 8);
    }

    #[test]
    fn modifiers_mask_can_fallback_to_keys() {
        assert_eq!(modifiers_mask(&json!({ "keys": ["alt", "shift"] })), 9);
    }

    #[test]
    fn keypress_events_normalize_aliases_and_emit_down_up() {
        let events = keypress_events(&json!({
            "key": "Shift+/"
        }))
        .unwrap();
        assert_eq!(events[0]["key"], "Shift");
        assert_eq!(events[1]["key"], "?");
        assert_eq!(events[1]["code"], "Slash");
        assert_eq!(events[1]["text"], "?");
        assert_eq!(events[1]["modifiers"], 8);
    }

    #[test]
    fn click_events_include_move_press_release_counts() {
        let events = click_events(10.0, 20.0, "right", 2);
        let payloads = events
            .into_iter()
            .map(MouseEvent::to_cdp_params)
            .collect::<Vec<_>>();
        assert_eq!(
            payloads,
            vec![
                json!({
                    "type": "mouseMoved",
                    "x": 10.0,
                    "y": 20.0,
                    "button": "none",
                    "buttons": 0,
                    "clickCount": 0,
                    "modifiers": 0,
                }),
                json!({
                    "type": "mousePressed",
                    "x": 10.0,
                    "y": 20.0,
                    "button": "right",
                    "buttons": 2,
                    "clickCount": 1,
                    "modifiers": 0,
                }),
                json!({
                    "type": "mouseReleased",
                    "x": 10.0,
                    "y": 20.0,
                    "button": "right",
                    "buttons": 0,
                    "clickCount": 1,
                    "modifiers": 0,
                }),
                json!({
                    "type": "mousePressed",
                    "x": 10.0,
                    "y": 20.0,
                    "button": "right",
                    "buttons": 2,
                    "clickCount": 2,
                    "modifiers": 0,
                }),
                json!({
                    "type": "mouseReleased",
                    "x": 10.0,
                    "y": 20.0,
                    "button": "right",
                    "buttons": 0,
                    "clickCount": 2,
                    "modifiers": 0,
                }),
            ]
        );
    }

    #[tokio::test]
    async fn dispatch_click_sends_shared_input_sequence() {
        let sink = RecordingSink::new();
        dispatch_click(&sink, 10.0, 20.0, "middle", 1, 8)
            .await
            .unwrap();
        assert_eq!(
            sink.payloads(),
            vec![
                json!({
                    "type": "mouseMoved",
                    "x": 10.0,
                    "y": 20.0,
                    "button": "none",
                    "buttons": 0,
                    "clickCount": 0,
                    "modifiers": 8,
                }),
                json!({
                    "type": "mousePressed",
                    "x": 10.0,
                    "y": 20.0,
                    "button": "middle",
                    "buttons": 4,
                    "clickCount": 1,
                    "modifiers": 8,
                }),
                json!({
                    "type": "mouseReleased",
                    "x": 10.0,
                    "y": 20.0,
                    "button": "middle",
                    "buttons": 0,
                    "clickCount": 1,
                    "modifiers": 8,
                }),
            ]
        );
    }

    #[tokio::test]
    async fn dispatch_click_with_navigation_wait_wraps_input_sequence() {
        let order = Arc::new(Mutex::new(Vec::new()));
        let sink = OrderedSink::new(order.clone());
        let navigation = RecordingNavigation::new(order.clone());

        dispatch_click_with_navigation_wait(
            &sink,
            &navigation,
            "tab-1",
            10.0,
            20.0,
            "left",
            1,
            &json!({
                "wait_for_navigation": true,
                "navigation_wait_until": "domcontentloaded",
                "navigation_timeout_ms": 500
            }),
        )
        .await
        .unwrap();

        assert_eq!(
            order.lock().unwrap().as_slice(),
            [
                "arm:tab-1:domcontentloaded:500",
                "mouseMoved",
                "mousePressed",
                "mouseReleased",
                "wait:tab-1:token:domcontentloaded:500",
            ]
        );
    }

    #[tokio::test]
    async fn dispatch_click_with_navigation_wait_skips_navigation_when_disabled() {
        let order = Arc::new(Mutex::new(Vec::new()));
        let sink = OrderedSink::new(order.clone());
        let navigation = RecordingNavigation::new(order.clone());

        dispatch_click_with_navigation_wait(
            &sink,
            &navigation,
            "tab-1",
            10.0,
            20.0,
            "left",
            1,
            &json!({}),
        )
        .await
        .unwrap();

        assert_eq!(
            order.lock().unwrap().as_slice(),
            ["mouseMoved", "mousePressed", "mouseReleased"]
        );
    }

    #[tokio::test]
    async fn dispatch_move_sends_shared_move_event() {
        let sink = RecordingSink::new();
        dispatch_move(&sink, 10.0, 20.0).await.unwrap();
        assert_eq!(
            sink.payloads(),
            vec![json!({
                "type": "mouseMoved",
                "x": 10.0,
                "y": 20.0,
                    "button": "none",
                    "buttons": 0,
                    "clickCount": 0,
                    "modifiers": 0,
            })]
        );
    }

    #[tokio::test]
    async fn command_wrappers_parse_params_and_preserve_navigation_wait() {
        let order = Arc::new(Mutex::new(Vec::new()));
        let sink = OrderedSink::new(order.clone());
        let navigation = RecordingNavigation::new(order.clone());

        dispatch_click_command(
            &sink,
            &navigation,
            &json!({
                "tab_id": "tab-1",
                "x": 10.0,
                "y": 20.0,
                "button": "left",
                "wait_for_navigation": true,
                "navigation_wait_until": "load",
                "navigation_timeout_ms": 250
            }),
            1,
            NumericErrorStyle::Missing,
        )
        .await
        .unwrap();

        assert_eq!(
            order.lock().unwrap().as_slice(),
            [
                "arm:tab-1:load:250",
                "mouseMoved",
                "mousePressed",
                "mouseReleased",
                "wait:tab-1:token:load:250",
            ]
        );
    }

    #[tokio::test]
    async fn command_wrappers_return_wire_null_after_dispatch() {
        let sink = RecordingSink::new();

        assert_eq!(
            dispatch_move_command(
                &sink,
                &json!({ "x": 10.0, "y": 20.0 }),
                NumericErrorStyle::Missing
            )
            .await
            .unwrap(),
            Value::Null
        );
        assert_eq!(
            dispatch_keypress_command(&sink, &json!({ "key": "a" }))
                .await
                .unwrap(),
            Value::Null
        );
        assert_eq!(
            dispatch_drag_path_command(&sink, &[(1.0, 2.0), (3.0, 4.0)], 0)
                .await
                .unwrap(),
            Value::Null
        );
    }

    #[tokio::test]
    async fn command_wrappers_preserve_mouse_modifiers_in_payloads() {
        let sink = RecordingSink::new();
        let navigation = RecordingNavigation::new(Arc::new(Mutex::new(Vec::new())));

        dispatch_click_command(
            &sink,
            &navigation,
            &json!({
                "tab_id": "tab-1",
                "x": 10.0,
                "y": 20.0,
                "modifiers": ["Shift"]
            }),
            1,
            NumericErrorStyle::Missing,
        )
        .await
        .unwrap();
        assert!(
            sink.payloads()
                .iter()
                .all(|payload| payload["modifiers"] == 8)
        );
    }

    #[test]
    fn click_params_with_navigation_wait_preserves_locator_modifiers() {
        let params = click_params_with_navigation_wait(
            "tab-1",
            10.0,
            20.0,
            "left",
            &json!({
                "modifiers": ["Shift"],
                "wait_for_navigation": true,
                "navigation_timeout_ms": 250
            }),
        );
        assert_eq!(params["modifiers"], json!(["Shift"]));
        assert_eq!(params["wait_for_navigation"], true);
    }

    #[tokio::test]
    async fn dispatch_keypress_sends_shared_key_sequence() {
        let sink = RecordingSink::new();
        dispatch_keypress(
            &sink,
            &json!({
                "key": "ControlOrMeta+X"
            }),
        )
        .await
        .unwrap();
        let payloads = sink.payloads();
        assert_eq!(payloads[0]["key"], primary_modifier_dispatch_key());
        assert_eq!(payloads[1]["key"], "x");
        assert_eq!(payloads[1]["code"], "KeyX");
        assert_eq!(payloads[2]["type"], "keyUp");
        assert_eq!(payloads[3]["key"], primary_modifier_dispatch_key());
    }

    #[test]
    fn drag_event_builders_match_shared_input_sequence() {
        let start = drag_start_events(1.0, 2.0);
        assert_eq!(start[0].to_cdp_params()["type"], "mouseMoved");
        assert_eq!(start[0].to_cdp_params()["button"], "none");
        assert_eq!(start[1].to_cdp_params()["type"], "mousePressed");
        assert_eq!(start[1].to_cdp_params()["buttons"], 1);

        let moved = drag_move_event(3.0, 4.0).to_cdp_params();
        assert_eq!(moved["type"], "mouseMoved");
        assert_eq!(moved["button"], "left");
        assert_eq!(moved["buttons"], 1);

        let released = drag_release_event(5.0, 6.0).to_cdp_params();
        assert_eq!(released["type"], "mouseReleased");
        assert_eq!(released["button"], "left");
        assert_eq!(released["buttons"], 0);
    }

    #[tokio::test]
    async fn dispatch_drag_path_releases_at_last_successful_point_on_move_failure() {
        let sink = RecordingSink::fail_on_call(4);
        let error = dispatch_drag_path(&sink, &[(1.0, 2.0), (3.0, 4.0), (5.0, 6.0)])
            .await
            .unwrap_err();
        assert!(error.to_string().contains("synthetic move failure"));

        let payloads = sink.payloads();
        assert_eq!(
            payloads,
            vec![
                json!({
                    "type": "mouseMoved",
                    "x": 1.0,
                    "y": 2.0,
                    "button": "none",
                    "buttons": 0,
                    "clickCount": 0,
                    "modifiers": 0,
                }),
                json!({
                    "type": "mousePressed",
                    "x": 1.0,
                    "y": 2.0,
                    "button": "left",
                    "buttons": 1,
                    "clickCount": 1,
                    "modifiers": 0,
                }),
                json!({
                    "type": "mouseMoved",
                    "x": 3.0,
                    "y": 4.0,
                    "button": "left",
                    "buttons": 1,
                    "clickCount": 1,
                    "modifiers": 0,
                }),
                json!({
                    "type": "mouseReleased",
                    "x": 3.0,
                    "y": 4.0,
                    "button": "left",
                    "buttons": 0,
                    "clickCount": 1,
                    "modifiers": 0,
                }),
            ]
        );
    }

    #[test]
    fn endpoint_drag_path_preserves_from_to_endpoints() {
        let path = endpoint_drag_path(&json!({
            "from": { "x": 0, "y": 1 },
            "to": { "x": 10, "y": 11 },
            "steps": 99
        }))
        .expect("path");
        assert_eq!(path, vec![(0.0, 1.0), (10.0, 11.0)]);
    }

    #[test]
    fn interpolated_drag_path_honors_steps() {
        let path = interpolated_drag_path(
            &json!({
                "from": { "x": 0, "y": 0 },
                "to": { "x": 10, "y": 20 },
                "steps": 2
            }),
            20,
        )
        .expect("path");
        assert_eq!(path, vec![(0.0, 0.0), (5.0, 10.0), (10.0, 20.0)]);
    }

    #[test]
    fn drag_path_errors_preserve_backend_wording() {
        let cdp_message = interpolated_drag_path(&json!({ "from": { "x": 0, "y": 0 } }), 20)
            .unwrap_err()
            .to_string();
        assert!(cdp_message.contains("missing drag path/to"));

        let webext_message = endpoint_drag_path(&json!({ "path": [{ "x": "bad", "y": 1 }] }))
            .unwrap_err()
            .to_string();
        assert!(webext_message.contains("missing numeric x"));
    }

    struct RecordingSink {
        payloads: Mutex<Vec<Value>>,
        calls: Mutex<usize>,
        fail_on_call: Option<usize>,
    }

    impl RecordingSink {
        fn new() -> Self {
            Self {
                payloads: Mutex::new(Vec::new()),
                calls: Mutex::new(0),
                fail_on_call: None,
            }
        }

        fn fail_on_call(fail_on_call: usize) -> Self {
            Self {
                payloads: Mutex::new(Vec::new()),
                calls: Mutex::new(0),
                fail_on_call: Some(fail_on_call),
            }
        }

        fn payloads(&self) -> Vec<Value> {
            self.payloads.lock().unwrap().clone()
        }
    }

    #[async_trait::async_trait]
    impl MouseEventSink for RecordingSink {
        async fn dispatch_mouse_event(&self, event: MouseEvent<'_>) -> crate::error::Result<()> {
            let mut calls = self.calls.lock().unwrap();
            *calls += 1;
            let call = *calls;
            drop(calls);

            let mut payloads = self.payloads.lock().unwrap();
            if self.fail_on_call == Some(call) {
                return Err(crate::error::HostError::CdpFailure(
                    "synthetic move failure".into(),
                ));
            }
            payloads.push(event.to_cdp_params());
            Ok(())
        }
    }

    #[async_trait::async_trait]
    impl KeyEventSink for RecordingSink {
        async fn dispatch_key_event(&self, event: Value) -> crate::error::Result<()> {
            self.payloads.lock().unwrap().push(event);
            Ok(())
        }
    }

    struct OrderedSink {
        order: Arc<Mutex<Vec<String>>>,
    }

    impl OrderedSink {
        fn new(order: Arc<Mutex<Vec<String>>>) -> Self {
            Self { order }
        }
    }

    #[async_trait::async_trait]
    impl MouseEventSink for OrderedSink {
        async fn dispatch_mouse_event(&self, event: MouseEvent<'_>) -> crate::error::Result<()> {
            self.order
                .lock()
                .unwrap()
                .push(event.event_type.to_string());
            Ok(())
        }
    }

    struct RecordingNavigation {
        order: Arc<Mutex<Vec<String>>>,
    }

    impl RecordingNavigation {
        fn new(order: Arc<Mutex<Vec<String>>>) -> Self {
            Self { order }
        }
    }

    #[async_trait::async_trait]
    impl NavigationWaiter for RecordingNavigation {
        type Token = String;

        async fn arm_navigation_wait(
            &self,
            tab_id: &str,
            wait: &NavigationWaitOptions,
        ) -> crate::error::Result<Self::Token> {
            self.order.lock().unwrap().push(format!(
                "arm:{tab_id}:{}:{}",
                wait.wait_until, wait.timeout_ms
            ));
            Ok("token".into())
        }

        async fn wait_for_navigation(
            &self,
            tab_id: &str,
            wait: &NavigationWaitOptions,
            token: Self::Token,
        ) -> crate::error::Result<()> {
            self.order.lock().unwrap().push(format!(
                "wait:{tab_id}:{token}:{}:{}",
                wait.wait_until, wait.timeout_ms
            ));
            Ok(())
        }
    }
}

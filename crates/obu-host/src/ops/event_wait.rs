//! Shared event wait loops.

use std::time::Duration;

use tokio::sync::broadcast;
use tokio::time::Instant;

use crate::error::{HostError, Result};

pub(crate) async fn wait_for_broadcast_event_matching<T, R, F, G>(
    rx: &mut broadcast::Receiver<T>,
    timeout_ms: u64,
    timeout_message: impl Into<String>,
    mut closed_error: G,
    mut match_event: F,
) -> Result<R>
where
    T: Clone,
    F: FnMut(T) -> Option<R>,
    G: FnMut(broadcast::error::RecvError) -> HostError,
{
    let timeout_message = timeout_message.into();
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(HostError::Timeout(timeout_message));
        }
        let event = tokio::time::timeout(remaining, rx.recv())
            .await
            .map_err(|_| HostError::Timeout(timeout_message.clone()))?
            .map_err(&mut closed_error)?;
        if let Some(result) = match_event(event) {
            return Ok(result);
        }
    }
}

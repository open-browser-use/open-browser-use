//! Typed target→coordinate resolution outcome shared by all action modalities.
//!
//! Only `Resolved` dispatches. Every other variant fails the action fast and is
//! surfaced to the agent as `HostError::Rpc` carrying `error.data.resolution`
//! (the dispatcher's `host_err_to_rpc` passes `Rpc.data` straight through).

use obu_wire::ErrorCode;
use obu_wire::error::ERR_PROTOCOL;
use serde_json::json;

use crate::error::HostError;

pub(crate) const RESOLUTION_OCCLUDED: &str = "occluded";
pub(crate) const RESOLUTION_OUTSIDE_VIEWPORT: &str = "outside_viewport";
pub(crate) const RESOLUTION_NO_CLICKABLE_BOX: &str = "no_clickable_box";
pub(crate) const RESOLUTION_TRANSFORMED_FRAME_UNSUPPORTED: &str = "transformed_frame_unsupported";
pub(crate) const RESOLUTION_CROSS_ORIGIN_UNREACHABLE: &str = "cross_origin_unreachable";
pub(crate) const RESOLUTION_NOT_VISIBLE: &str = "not_visible";
pub(crate) const RESOLUTION_DETACHED: &str = "detached";

/// Outcome of resolving a target to a dispatch point. Closed set by design.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ActionPointResolution {
    /// Hit-verified `VISUAL_VIEWPORT` CSS-px point.
    Resolved { x: f64, y: f64 },
    /// Another node intercepts the point; `by` describes the occluder.
    Occluded { by: String },
    /// The clickable box is fully outside the viewport.
    OutsideViewport,
    /// The target has no finite, positive box to click.
    NoClickableBox,
    /// The target sits inside a CSS-transformed iframe chain (unsupported).
    TransformedFrameUnsupported,
    /// A cross-origin/OOPIF target could not be reached on this path.
    CrossOriginUnreachable { reason: String },
    /// The target was found but stayed non-actionable through the grace window;
    /// `state` names which actionability check failed (visible/stable/enabled/editable).
    NotVisible { state: String },
    /// The target detached from the DOM before the action could dispatch.
    Detached,
}

impl ActionPointResolution {
    /// Resolved → the point; anything else → the fail-fast error.
    pub(crate) fn into_point(self) -> Result<(f64, f64), HostError> {
        match self {
            Self::Resolved { x, y } => Ok((x, y)),
            other => Err(other.into_host_error()),
        }
    }

    /// Map a non-resolved outcome to a structured JSON-RPC error.
    ///
    /// Invariant: callers pass a non-`Resolved` variant. `Resolved` is routed to
    /// a point via [`into_point`](Self::into_point) and never reaches here; the
    /// arm below records that invariant (a violation is a crate-internal bug).
    pub(crate) fn into_host_error(self) -> HostError {
        let (message, data) = match self {
            // Unreachable for intended callers (see the invariant above): `Resolved`
            // is consumed by `into_point`, so only error variants land here.
            Self::Resolved { .. } => unreachable!("Resolved is not an error"),
            Self::Occluded { by } => (
                format!("action point is occluded by {by}"),
                json!({ "resolution": RESOLUTION_OCCLUDED, "by": by }),
            ),
            Self::OutsideViewport => (
                "action point is outside the viewport".to_string(),
                json!({ "resolution": RESOLUTION_OUTSIDE_VIEWPORT }),
            ),
            Self::NoClickableBox => (
                "target has no clickable box".to_string(),
                json!({ "resolution": RESOLUTION_NO_CLICKABLE_BOX }),
            ),
            Self::TransformedFrameUnsupported => (
                "target is inside a transformed iframe chain".to_string(),
                json!({ "resolution": RESOLUTION_TRANSFORMED_FRAME_UNSUPPORTED }),
            ),
            Self::CrossOriginUnreachable { reason } => (
                format!("cross-origin target is unreachable: {reason}"),
                json!({ "resolution": RESOLUTION_CROSS_ORIGIN_UNREACHABLE, "reason": reason }),
            ),
            Self::NotVisible { state } => (
                format!("target is not actionable: not {state}"),
                json!({ "resolution": RESOLUTION_NOT_VISIBLE, "state": state }),
            ),
            Self::Detached => (
                "target detached from the DOM".to_string(),
                json!({ "resolution": RESOLUTION_DETACHED }),
            ),
        };
        HostError::Rpc {
            code: ErrorCode::Server(ERR_PROTOCOL),
            message,
            data: Some(data),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::HostError;

    fn rpc_data(error: HostError) -> serde_json::Value {
        match error {
            HostError::Rpc { data, .. } => data.expect("rpc error carries data"),
            other => panic!("expected HostError::Rpc, got {other:?}"),
        }
    }

    #[test]
    fn resolved_returns_point() {
        assert_eq!(
            ActionPointResolution::Resolved { x: 12.0, y: 34.0 }
                .into_point()
                .unwrap(),
            (12.0, 34.0)
        );
    }

    #[test]
    fn occluded_carries_resolution_and_occluder() {
        let error = ActionPointResolution::Occluded {
            by: "DIV#cover".into(),
        }
        .into_host_error();
        assert!(error.to_string().contains("occluded"));
        let data = rpc_data(error);
        assert_eq!(data["resolution"], RESOLUTION_OCCLUDED);
        assert_eq!(data["by"], "DIV#cover");
    }

    #[test]
    fn each_variant_maps_to_its_resolution_string() {
        assert_eq!(
            rpc_data(ActionPointResolution::OutsideViewport.into_host_error())["resolution"],
            RESOLUTION_OUTSIDE_VIEWPORT
        );
        assert_eq!(
            rpc_data(ActionPointResolution::NoClickableBox.into_host_error())["resolution"],
            RESOLUTION_NO_CLICKABLE_BOX
        );
        assert_eq!(
            rpc_data(ActionPointResolution::TransformedFrameUnsupported.into_host_error())["resolution"],
            RESOLUTION_TRANSFORMED_FRAME_UNSUPPORTED
        );
        let cross = rpc_data(
            ActionPointResolution::CrossOriginUnreachable {
                reason: "no session".into(),
            }
            .into_host_error(),
        );
        assert_eq!(cross["resolution"], RESOLUTION_CROSS_ORIGIN_UNREACHABLE);
        assert_eq!(cross["reason"], "no session");
    }

    #[test]
    fn into_point_errors_for_non_resolved() {
        assert!(ActionPointResolution::NoClickableBox.into_point().is_err());
    }

    #[test]
    fn not_visible_carries_resolution_and_state() {
        let error = ActionPointResolution::NotVisible {
            state: "visible".into(),
        }
        .into_host_error();
        let data = rpc_data(error);
        assert_eq!(data["resolution"], RESOLUTION_NOT_VISIBLE);
        assert_eq!(data["state"], "visible");
    }

    #[test]
    fn detached_carries_resolution() {
        let data = rpc_data(ActionPointResolution::Detached.into_host_error());
        assert_eq!(data["resolution"], RESOLUTION_DETACHED);
    }
}

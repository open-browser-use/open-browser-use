//! Coordinate-space vocabulary the host reports to the SDK in
//! `point.coordinateSpace`. Single-sourced via `control-vocab.json`
//! (`coordinateSpaces`).
//!
//! NOTE: the `"visualViewport"` / `"layoutViewport"` keys read from CDP layout
//! metrics in `ops/dom_cua.rs` are Chrome's own protocol field names and are NOT
//! part of this contract.

/// Visual-viewport coordinate space (the default the host emits).
pub const VISUAL_VIEWPORT: &str = "visualViewport";
/// Layout-viewport coordinate space.
pub const LAYOUT_VIEWPORT: &str = "layoutViewport";
/// Every coordinate-space value the host may emit.
pub const ALL: [&str; 2] = [VISUAL_VIEWPORT, LAYOUT_VIEWPORT];

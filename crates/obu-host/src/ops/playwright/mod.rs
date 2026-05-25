//! Shared Playwright runtime operations.

// `prune_aria_snapshot` is wired into `dom_snapshot` by a follow-up task; until
// then the module is intentionally standalone, so silence `dead_code` here.
#[allow(dead_code)]
pub(crate) mod aria_prune;
pub(crate) mod handles;
pub(crate) mod runtime;

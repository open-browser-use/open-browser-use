//! Trust gate that never grants privileged capabilities.

use std::path::Path;

use super::TrustGate;

/// Never trusts anything.
pub struct NullTrust;

impl TrustGate for NullTrust {
    fn is_trusted(&self, _source: &[u8], _path: &Path) -> bool {
        false
    }
}

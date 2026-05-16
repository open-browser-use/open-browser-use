//! Pluggable trust gates.

use std::path::Path;
use std::sync::Arc;

pub mod hash_allowlist;
pub mod local_dev;
pub mod null;

pub use hash_allowlist::HashAllowlistTrust;
pub use local_dev::LocalDevTrust;
pub use null::NullTrust;

/// Trust gate for deciding whether a module receives privileged capabilities.
pub trait TrustGate: Send + Sync + 'static {
    /// Return true when the source/path pair is trusted.
    fn is_trusted(&self, source: &[u8], path: &Path) -> bool;
}

/// Composite OR gate.
pub struct CompositeOrTrust(pub Vec<Arc<dyn TrustGate>>);

impl TrustGate for CompositeOrTrust {
    fn is_trusted(&self, source: &[u8], path: &Path) -> bool {
        self.0.iter().any(|gate| gate.is_trusted(source, path))
    }
}

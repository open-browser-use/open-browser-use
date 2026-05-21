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

#[cfg(test)]
mod tests {
    use super::*;

    struct FixedTrust(bool);

    impl TrustGate for FixedTrust {
        fn is_trusted(&self, _source: &[u8], _path: &Path) -> bool {
            self.0
        }
    }

    #[test]
    fn composite_trusts_when_any_gate_trusts() {
        let gate = CompositeOrTrust(vec![
            Arc::new(FixedTrust(false)),
            Arc::new(FixedTrust(true)),
            Arc::new(FixedTrust(false)),
        ]);

        assert!(gate.is_trusted(b"source", Path::new("/tmp/module.mjs")));
    }

    #[test]
    fn composite_rejects_when_no_gate_trusts() {
        let gate = CompositeOrTrust(vec![
            Arc::new(FixedTrust(false)),
            Arc::new(FixedTrust(false)),
        ]);

        assert!(!gate.is_trusted(b"source", Path::new("/tmp/module.mjs")));
    }

    #[test]
    fn composite_rejects_empty_gate_list() {
        let gate = CompositeOrTrust(Vec::new());

        assert!(!gate.is_trusted(b"source", Path::new("/tmp/module.mjs")));
    }
}

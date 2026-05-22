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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_trusts_any_source_or_path() {
        let gate = NullTrust;

        assert!(!gate.is_trusted(b"export {};", Path::new("/tmp/module.mjs")));
        assert!(!gate.is_trusted(b"", Path::new("relative.mjs")));
    }
}

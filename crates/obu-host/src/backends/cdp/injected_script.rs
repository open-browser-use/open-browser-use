//! Vendored Playwright InjectedScript bundle.

/// Compiled Playwright InjectedScript IIFE.
pub const PLAYWRIGHT_INJECTED_JS: &str = include_str!("../../../vendored/playwright-injected.js");

/// Verify the embedded bundle matches the pinned SHA-256.
pub fn verify_pinned_hash() -> Result<(), String> {
    use sha2::{Digest, Sha256};

    let expected = include_str!("../../../vendored/PINNED_HASH").trim();
    let mut hasher = Sha256::new();
    hasher.update(PLAYWRIGHT_INJECTED_JS.as_bytes());
    let got = format!("{:x}", hasher.finalize());
    if got == expected {
        Ok(())
    } else {
        Err(format!(
            "playwright-injected.js hash mismatch: got {got}, expected {expected}"
        ))
    }
}

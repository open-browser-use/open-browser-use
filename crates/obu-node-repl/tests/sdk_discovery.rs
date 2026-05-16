use std::path::PathBuf;

use obu_node_repl::sdk_discovery::discover_at;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

#[test]
fn discovers_good_sdk() {
    let info = discover_at(&fixture("sdk-good")).expect("good sdk should resolve");
    assert_eq!(info.version.as_deref(), Some("0.1.0"));
    assert_eq!(info.hash.len(), 64);
}

#[test]
fn rejects_hash_mismatch() {
    let err = discover_at(&fixture("sdk-bad")).unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("hash"),
        "expected hash mismatch error, got: {msg}"
    );
}

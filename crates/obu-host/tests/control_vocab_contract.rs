//! Pins every Rust enum/const vocabulary to the single source emitted in
//! `packages/browser-control-core/fixtures/control-vocab.json`. A drift between
//! the hand-authored Rust side and the core TS source fails here.

use std::collections::BTreeSet;

use obu_host::task_lifecycle::TaskState;
use serde_json::Value;

fn fixture() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/browser-control-core/fixtures/control-vocab.json");
    let source =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&source).expect("parse control-vocab.json")
}

fn fixture_set(value: &Value, key: &str) -> BTreeSet<String> {
    value[key]
        .as_array()
        .unwrap_or_else(|| panic!("fixture missing array `{key}`"))
        .iter()
        .map(|entry| entry.as_str().expect("vocab entry is a string").to_string())
        .collect()
}

#[test]
fn task_state_vocab_matches_fixture() {
    let got: BTreeSet<String> = TaskState::ALL
        .iter()
        .map(|s| s.as_str().to_string())
        .collect();
    assert_eq!(got, fixture_set(&fixture(), "taskStates"));
}

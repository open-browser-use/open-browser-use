//! Pins node-repl's descriptor reader enums to the single source emitted in
//! `packages/cli/fixtures/descriptor-vocab.json`. A drift between the Rust
//! reader vocab and the CLI canonical source fails here.

use std::collections::BTreeSet;

use obu_node_repl::repl_manager::runtime_descriptor_lifecycle::{
    RuntimeDescriptorReadReasonCode, RuntimeDescriptorReadState,
};
use serde_json::Value;

fn fixture() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/cli/fixtures/descriptor-vocab.json");
    let source =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&source).expect("parse descriptor-vocab.json")
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
fn read_state_vocab_matches_fixture() {
    let got: BTreeSet<String> = RuntimeDescriptorReadState::ALL
        .iter()
        .map(|s| serde_json::to_value(s).unwrap().as_str().unwrap().to_string())
        .collect();
    assert_eq!(got, fixture_set(&fixture(), "readerStates"));
}

#[test]
fn reader_reason_code_vocab_matches_fixture() {
    let got: BTreeSet<String> = RuntimeDescriptorReadReasonCode::ALL
        .iter()
        .map(|c| c.as_str().to_string())
        .collect();
    assert_eq!(got, fixture_set(&fixture(), "readerReasonCodes"));
}

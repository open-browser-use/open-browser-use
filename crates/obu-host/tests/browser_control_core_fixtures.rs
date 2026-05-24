use serde_json::Value;

#[test]
fn browser_control_core_json_fixtures_are_parseable() {
    let fixture_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/browser-control-core/fixtures/browser-control-core.json");
    let source = std::fs::read_to_string(fixture_path).expect("read browser-control fixture json");
    let fixture: Value = serde_json::from_str(&source).expect("parse browser-control fixture json");
    assert_eq!(fixture["protocolVersion"], 1);
    let cases = fixture["cases"].as_array().expect("fixture cases");
    assert!(cases.iter().any(|case| case["name"] == "activeCommandAccepted"));
    assert!(cases.iter().any(|case| case["name"] == "finalizeTwoTabs"));
}

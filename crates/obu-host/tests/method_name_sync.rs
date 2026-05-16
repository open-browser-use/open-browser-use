use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use obu_host::{
    methods::ALL_INBOUND_METHODS,
    policy::{MethodPolicyKind, classify_method},
};

#[test]
fn rust_and_ts_method_names_match() {
    let ts_path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/sdk/src/wire/methods.ts");
    let src = std::fs::read_to_string(&ts_path).expect("SDK methods.ts is missing");

    let ts = parse_ts_method_constants(&src)
        .values()
        .cloned()
        .collect::<BTreeSet<_>>();

    let rust = ALL_INBOUND_METHODS
        .iter()
        .map(|method| method.to_string())
        .collect::<BTreeSet<_>>();
    let missing_in_ts = rust.difference(&ts).collect::<Vec<_>>();
    let extra_in_ts = ts.difference(&rust).collect::<Vec<_>>();

    assert!(
        missing_in_ts.is_empty() && extra_in_ts.is_empty(),
        "method-name desync:\n  missing in TS: {missing_in_ts:?}\n  extra in TS: {extra_in_ts:?}",
    );
}

#[test]
fn rust_and_ts_policy_classifications_match() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let methods_src =
        std::fs::read_to_string(manifest_dir.join("../../packages/sdk/src/wire/methods.ts"))
            .expect("SDK methods.ts is missing");
    let guards_src = std::fs::read_to_string(manifest_dir.join("../../packages/sdk/src/guards.ts"))
        .expect("SDK guards.ts is missing");
    let constants = parse_ts_method_constants(&methods_src);
    let ts_classifications = parse_ts_classifications(&guards_src, &constants);

    let rust_methods = ALL_INBOUND_METHODS.iter().copied().collect::<BTreeSet<_>>();
    let ts_methods = ts_classifications
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    assert_eq!(
        ts_methods, rust_methods,
        "TS policy classification must cover the same inbound methods as Rust",
    );

    for method in ALL_INBOUND_METHODS {
        let expected = ts_classifications
            .get(*method)
            .unwrap_or_else(|| panic!("missing TS classification for {method}"));
        let actual = rust_policy_kind(classify_method(method));
        assert_eq!(
            actual, expected,
            "policy classification desync for method {method}",
        );
    }
}

fn parse_ts_method_constants(src: &str) -> BTreeMap<String, String> {
    let mut constants = BTreeMap::new();
    for line in src.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("export const ") else {
            continue;
        };
        let Some(eq) = rest.find('=') else {
            continue;
        };
        let name = rest[..eq].trim();
        let Some(value) = quoted_value(&rest[eq + 1..]) else {
            continue;
        };
        constants.insert(name.to_string(), value);
    }
    constants
}

fn parse_ts_classifications(
    src: &str,
    constants: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut classifications = BTreeMap::new();
    for line in src.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("[M.") else {
            continue;
        };
        let Some(end) = rest.find(']') else {
            continue;
        };
        let name = &rest[..end];
        let Some(method) = constants.get(name) else {
            panic!("guards.ts references unknown method constant M.{name}");
        };
        let Some(classification) = quoted_value(&rest[end + 1..]) else {
            continue;
        };
        classifications.insert(method.clone(), classification);
    }
    classifications
}

fn quoted_value(src: &str) -> Option<String> {
    let start = src.find('"')?;
    let rest = &src[start + 1..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn rust_policy_kind(kind: MethodPolicyKind) -> &'static str {
    match kind {
        MethodPolicyKind::AlwaysAllowed => "always-allowed",
        MethodPolicyKind::TargetUrl => "target-url",
        MethodPolicyKind::CurrentOrigin => "current-origin",
        MethodPolicyKind::History => "history",
        MethodPolicyKind::Download => "download",
        MethodPolicyKind::Upload => "upload",
        MethodPolicyKind::RawCdp => "raw-cdp",
        MethodPolicyKind::InternalLifecycle => "internal-lifecycle",
    }
}

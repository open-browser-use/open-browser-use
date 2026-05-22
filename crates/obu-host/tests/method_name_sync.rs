use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use obu_host::{
    backends::{BackendKind, capabilities_for_kind, unsupported_methods},
    methods::{self, ALL_INBOUND_METHODS, BackendMethodSupport},
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
    let guards_src =
        std::fs::read_to_string(manifest_dir.join("../../packages/sdk/src/wire/method-policy.ts"))
            .expect("SDK wire method-policy.ts is missing");
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

#[test]
fn backend_capabilities_follow_generated_support_matrix() {
    let matrix_methods = methods::BACKEND_METHOD_SUPPORT
        .iter()
        .map(|(method, _, _)| *method)
        .collect::<BTreeSet<_>>();
    let inbound_methods = ALL_INBOUND_METHODS.iter().copied().collect::<BTreeSet<_>>();
    assert_eq!(
        matrix_methods, inbound_methods,
        "backend support matrix must cover every inbound method",
    );

    for kind in [BackendKind::Cdp, BackendKind::WebExtension] {
        let support = support_by_method(kind);
        let implemented = support
            .iter()
            .filter_map(|(method, state)| {
                (*state == BackendMethodSupport::Implemented).then_some(method.to_string())
            })
            .collect::<BTreeSet<_>>();
        let unsupported = support
            .iter()
            .filter_map(|(method, state)| {
                (*state == BackendMethodSupport::Unsupported).then_some(method.to_string())
            })
            .collect::<BTreeSet<_>>();
        let intentionally_not_implemented = support
            .iter()
            .filter_map(|(method, state)| {
                (*state == BackendMethodSupport::IntentionallyNotImplemented)
                    .then_some(method.to_string())
            })
            .collect::<BTreeSet<_>>();
        let generated_unsupported = unsupported_methods(kind)
            .iter()
            .map(|method| method.to_string())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            generated_unsupported, unsupported,
            "unsupported method list for {kind:?} must be generated from unsupported support states",
        );

        let capabilities = capabilities_for_kind(kind);
        let advertised_supported = string_array_set(&capabilities["supported_methods"]);
        let advertised_unsupported = string_array_set(&capabilities["unsupported_methods"]);
        assert_eq!(
            advertised_supported, implemented,
            "capability supported_methods for {kind:?} must match implemented support states",
        );
        assert_eq!(
            advertised_unsupported, generated_unsupported,
            "capability unsupported_methods for {kind:?} must match generated unsupported list",
        );
        assert!(
            intentionally_not_implemented.is_disjoint(&advertised_supported),
            "intentionally-not-implemented methods must not be advertised as supported for {kind:?}",
        );
        assert!(
            intentionally_not_implemented.is_disjoint(&advertised_unsupported),
            "intentionally-not-implemented methods must not be advertised as unsupported for {kind:?}",
        );
    }
}

#[test]
fn backend_capability_docs_list_agent_visible_differences() {
    let doc_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/current-product-architecture.md");
    let doc =
        std::fs::read_to_string(&doc_path).expect("current-product-architecture.md is missing");
    for expected in [
        "Backend differences that agents and SDK code should treat as capabilities",
        "| Surface | CDP backend | WebExtension backend | Capability signal |",
        "| Raw CDP access |",
        "| DOM-CUA visible DOM and media download helpers |",
        "| Clipboard helpers |",
        "unsupported_backend_capability",
        "missing_capability",
    ] {
        assert!(
            doc.contains(expected),
            "backend capability docs missing expected text: {expected}"
        );
    }
}

fn support_by_method(kind: BackendKind) -> BTreeMap<&'static str, BackendMethodSupport> {
    methods::BACKEND_METHOD_SUPPORT
        .iter()
        .map(|(method, cdp, webextension)| {
            let state = match kind {
                BackendKind::Cdp => *cdp,
                BackendKind::WebExtension => *webextension,
            };
            (*method, state)
        })
        .collect()
}

fn string_array_set(value: &serde_json::Value) -> BTreeSet<String> {
    value
        .as_array()
        .expect("expected string array")
        .iter()
        .map(|value| value.as_str().expect("expected string item").to_string())
        .collect()
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

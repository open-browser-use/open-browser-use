use obu_wire::{Hello, HelloAck, MinVersion, VersionMismatch};

#[test]
fn min_version_parses_and_compares() {
    let a: MinVersion = "0.3.0".parse().unwrap();
    let b: MinVersion = "0.4.1".parse().unwrap();
    assert!(b > a);
}

#[test]
fn hello_serializes_per_spec() {
    let hello = Hello {
        extension_version: "0.3.0".parse().unwrap(),
        manifest_version: 3,
        min_host_version: "0.3.0".parse().unwrap(),
    };
    let v: serde_json::Value =
        serde_json::from_str(&serde_json::to_string(&hello).unwrap()).unwrap();
    assert_eq!(v["type"], "hello");
    assert_eq!(v["extension_version"], "0.3.0");
    assert_eq!(v["manifest_version"], 3);
    assert_eq!(v["min_host_version"], "0.3.0");
}

#[test]
fn hello_ack_and_mismatch_serialize() {
    let ack = HelloAck {
        host_version: "0.3.0".parse().unwrap(),
        min_extension_version: "0.3.0".parse().unwrap(),
    };
    let serialized = serde_json::to_string(&ack).unwrap();
    assert!(serialized.contains("\"hello_ack\""));

    let mismatch = VersionMismatch {
        message: "open-browser-use CLI v0.3.0+ required (you have v0.1.0). Run: npm i -g @open-browser-use/cli@latest"
            .into(),
    };
    let serialized = serde_json::to_string(&mismatch).unwrap();
    assert!(serialized.contains("\"version_mismatch\""));
    assert!(serialized.contains("npm i -g @open-browser-use/cli@latest"));
}

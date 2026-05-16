use obu_node_repl::repl_manager::{JsRuntimeManager, ManagerOptions};
use serde_json::json;

#[tokio::test]
async fn add_module_dir_extends_bare_import_roots() {
    let root = tempfile::tempdir().unwrap();
    let package_dir = root.path().join("node_modules").join("obu-test-pkg");
    std::fs::create_dir_all(&package_dir).unwrap();
    std::fs::write(
        package_dir.join("package.json"),
        r#"{ "name": "obu-test-pkg", "version": "1.0.0", "type": "module", "main": "./index.js" }"#,
    )
    .unwrap();
    std::fs::write(package_dir.join("index.js"), "export const value = 99;\n").unwrap();

    let manager = JsRuntimeManager::new(ManagerOptions::for_tests())
        .await
        .unwrap();
    manager.add_module_dir(root.path().to_path_buf());

    let result = manager
        .exec(
            r#"const pkg = await import("obu-test-pkg"); pkg.value"#,
            None,
        )
        .await
        .unwrap();
    assert_eq!(result.result, json!(99));
}

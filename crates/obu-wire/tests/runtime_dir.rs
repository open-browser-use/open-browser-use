use obu_wire::runtime_dir::{
    ensure_owner_only_dir, platform_default_runtime_dir, validate_owner_only_dir,
};

#[test]
fn platform_default_runtime_dir_uses_uid_scoped_tmp_fallback() {
    let path = platform_default_runtime_dir();
    let rendered = path.display().to_string();
    assert!(
        rendered.contains("obu-") || rendered.ends_with("/obu"),
        "default runtime dir should be uid-scoped: {rendered}"
    );
}

#[cfg(unix)]
#[test]
fn ensure_owner_only_dir_creates_and_validates_directory() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("runtime");
    ensure_owner_only_dir(&path).unwrap();
    let metadata = std::fs::symlink_metadata(&path).unwrap();
    assert!(metadata.is_dir());
    assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
    validate_owner_only_dir(&path).unwrap();
}

#[cfg(unix)]
#[test]
fn ensure_owner_only_dir_repairs_owner_readable_directory() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("runtime");
    std::fs::create_dir(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();

    ensure_owner_only_dir(&path).unwrap();

    let metadata = std::fs::symlink_metadata(&path).unwrap();
    assert!(metadata.is_dir());
    assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
    validate_owner_only_dir(&path).unwrap();
}

#[cfg(unix)]
#[test]
fn validate_owner_only_dir_rejects_symlinks_and_group_readable_dirs() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("target");
    std::fs::create_dir(&target).unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o700)).unwrap();

    let link = temp.path().join("link");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let error = validate_owner_only_dir(&link).unwrap_err();
    assert!(error.to_string().contains("symlink"));

    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
    let error = validate_owner_only_dir(&target).unwrap_err();
    assert!(error.to_string().contains("owner-only"));
}

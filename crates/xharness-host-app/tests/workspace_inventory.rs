use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use xharness_fs::{inventory::InventoryLimits, FsService};
use xharness_host_app::workspace_inventory::{
    capture_workspace_inventory, WorkspaceInventoryError,
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xh-personal-inventory-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn service(&self) -> FsService {
        FsService::new(&self.0).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            eprintln!("personal inventory fixture cleanup failed: {error}");
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod unix {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    use xharness_cloud::workspace_sync::{
        WorkspaceManifest, WorkspaceSyncPlan, WorkspaceSyncScope,
    };
    use xharness_cloud::{Counter, Id};

    #[test]
    fn fixed_policy_prunes_secrets_before_open_and_builds_validated_manifest() {
        let root = Fixture::new();
        fs::create_dir_all(root.0.join("中文/empty")).unwrap();
        fs::write(root.0.join("中文/keep.bin"), b"payload\0\xff").unwrap();
        fs::set_permissions(
            root.0.join("中文/keep.bin"),
            fs::Permissions::from_mode(0o750),
        )
        .unwrap();
        for name in [
            ".env",
            ".ENV.local",
            "id_rsa",
            "private.pem",
            "credentials.json",
            ".netrc",
            "auth.json",
        ] {
            // Dangling symlinks are intentionally used: accidental native open
            // would fail, whereas explicit policy exclusion must succeed.
            symlink("/missing-private-target", root.0.join(name)).unwrap();
        }
        for name in [".git", "target", "node_modules"] {
            symlink("/missing-private-tree", root.0.join(name)).unwrap();
        }
        let service = root.service();
        let captured = capture_workspace_inventory(&service, InventoryLimits::default()).unwrap();
        assert_eq!(captured.excluded_entries(), 10);
        assert_eq!(captured.manifest().files().len(), 1);
        let file = &captured.manifest().files()["中文/keep.bin"];
        assert_eq!(
            file.sha256.as_str(),
            format!("{:x}", Sha256::digest(b"payload\0\xff"))
        );
        assert!(file.executable);
        let wire = captured.manifest().to_json().unwrap();
        assert_eq!(
            WorkspaceManifest::from_json(&wire).unwrap(),
            *captured.manifest()
        );
        assert!(!format!("{captured:?}").contains("keep.bin"));
        captured.revalidate(&service).unwrap();
        assert_eq!(
            captured.policy_ref().unwrap(),
            xharness_host_app::workspace_inventory::policy_ref().unwrap()
        );
    }
    #[test]
    fn unsupported_portable_names_fail_instead_of_being_omitted() {
        for name in [
            "CON",
            "name.",
            "bad:name",
            "bad\\name",
            "bad\nname",
            "com¹.txt",
        ] {
            let root = Fixture::new();
            fs::write(root.0.join(name), b"fixture").unwrap();
            assert!(
                matches!(
                    capture_workspace_inventory(&root.service(), Default::default()),
                    Err(WorkspaceInventoryError::Native(
                        xharness_fs::inventory::InventoryError::Policy(_)
                    ))
                ),
                "{name}"
            );
        }
    }
    #[test]
    fn empty_directory_aliases_are_validated_not_lost_from_file_manifest() {
        let root = Fixture::new();
        fs::create_dir(root.0.join("Alpha")).unwrap();
        match fs::create_dir(root.0.join("alpha")) {
            Ok(()) => assert!(matches!(
                capture_workspace_inventory(&root.service(), Default::default()),
                Err(WorkspaceInventoryError::Policy(_))
            )),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                assert_eq!(
                    fs::metadata(root.0.join("Alpha")).unwrap().ino(),
                    fs::metadata(root.0.join("alpha")).unwrap().ino()
                );
                assert!(
                    capture_workspace_inventory(&root.service(), Default::default())
                        .unwrap()
                        .manifest()
                        .files()
                        .is_empty()
                );
            }
            Err(error) => panic!("cannot construct native alias fixture: {error}"),
        }
    }
    #[test]
    fn unicode_aliases_are_rejected_when_both_native_spellings_exist() {
        for (left, right) in [("Straße", "STRASSE"), ("é", "e\u{301}")] {
            let root = Fixture::new();
            fs::write(root.0.join(left), b"left").unwrap();
            fs::write(root.0.join(right), b"right").unwrap();
            let same_inode = fs::metadata(root.0.join(left)).unwrap().ino()
                == fs::metadata(root.0.join(right)).unwrap().ino();
            let result = capture_workspace_inventory(&root.service(), Default::default());
            if same_inode {
                assert_eq!(result.unwrap().manifest().files().len(), 1);
            } else {
                assert!(matches!(result, Err(WorkspaceInventoryError::Policy(_))));
            }
        }
    }
    #[test]
    fn native_provenance_cannot_be_reused_for_another_service_or_stale_state() {
        let root = Fixture::new();
        fs::write(root.0.join("file"), b"before").unwrap();
        let service = root.service();
        let captured = capture_workspace_inventory(&service, Default::default()).unwrap();
        assert!(captured.revalidate(&root.service()).is_err());
        fs::write(root.0.join("file"), b"after").unwrap();
        assert!(captured.revalidate(&service).is_err());
    }
    #[test]
    fn real_native_inventories_feed_three_way_plan_without_applying_it() {
        let local = Fixture::new();
        let cloud = Fixture::new();
        fs::write(local.0.join("local.txt"), b"local").unwrap();
        fs::write(cloud.0.join("cloud.txt"), b"cloud").unwrap();
        let left_service = local.service();
        let right_service = cloud.service();
        let left = capture_workspace_inventory(&left_service, Default::default()).unwrap();
        let right = capture_workspace_inventory(&right_service, Default::default()).unwrap();
        let scope = WorkspaceSyncScope::new(
            Id::new("pair").unwrap(),
            Counter(1),
            Id::new("local").unwrap(),
            Id::new("cloud").unwrap(),
            left.policy_ref().unwrap(),
        )
        .unwrap();
        let base = WorkspaceManifest::new([]).unwrap();
        let plan =
            WorkspaceSyncPlan::build(scope, &base, left.manifest(), right.manifest()).unwrap();
        assert_eq!(plan.changes().unwrap().len(), 2);
        assert!(plan.conflicts().is_empty());
        assert!(!local.0.join("cloud.txt").exists());
        assert!(!cloud.0.join("local.txt").exists());
        left.revalidate(&left_service).unwrap();
        right.revalidate(&right_service).unwrap();
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
#[test]
fn native_inventory_is_explicitly_unavailable() {
    let root = Fixture::new();
    assert!(matches!(
        capture_workspace_inventory(&root.service(), InventoryLimits::default()),
        Err(WorkspaceInventoryError::Native(
            xharness_fs::inventory::InventoryError::Unsupported
        ))
    ));
}

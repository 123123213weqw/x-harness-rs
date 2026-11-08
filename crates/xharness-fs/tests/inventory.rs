use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use xharness_fs::{
    inventory::{InventoryDecision, InventoryError, InventoryLimits, InventoryPolicy, PolicyError},
    FsService,
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xh-inventory-{}-{}-{}",
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
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            eprintln!("inventory fixture cleanup failed: {error}");
        }
    }
}
struct All;
impl InventoryPolicy for All {
    fn identity(&self) -> [u8; 32] {
        [1; 32]
    }
    fn classify(&self, _: &str) -> Result<InventoryDecision, PolicyError> {
        Ok(InventoryDecision::Include)
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod unix {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};

    #[test]
    fn complete_unicode_binary_tree_full_hash_modes_and_private_debug() {
        let root = Fixture::new();
        fs::create_dir_all(root.path().join("中文/empty")).unwrap();
        let path = root.path().join("中文/private.bin");
        let bytes = b"private_payload\0\xff";
        fs::write(&path, bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o750)).unwrap();
        fs::write(root.path().join("zero"), []).unwrap();
        let before = fs::metadata(&path).unwrap();
        let service = FsService::new(root.path()).unwrap();
        let inventory = service
            .capture_inventory(&All, InventoryLimits::default())
            .unwrap();
        assert_eq!(inventory.files().len(), 2);
        let captured = inventory
            .files()
            .iter()
            .find(|file| file.path() == "中文/private.bin")
            .unwrap();
        assert_eq!(
            captured.sha256_hex(),
            format!("{:x}", Sha256::digest(bytes))
        );
        assert_eq!(captured.bytes(), bytes.len() as u64);
        assert!(captured.executable());
        assert!(inventory.directories().any(|path| path == "中文/empty"));
        for debug in [format!("{inventory:?}"), format!("{captured:?}")] {
            for secret in [
                "private_payload",
                "private.bin",
                "中文",
                &captured.sha256_hex(),
            ] {
                assert!(!debug.contains(secret));
            }
        }
        service.revalidate_inventory(&inventory, &All).unwrap();
        let after = fs::metadata(&path).unwrap();
        assert_eq!(
            (before.mode(), before.len(), before.mtime(), before.ctime()),
            (after.mode(), after.len(), after.mtime(), after.ctime())
        );
    }
    #[test]
    fn empty_root_and_zero_byte_budget_are_valid() {
        let root = Fixture::new();
        let service = FsService::new(root.path()).unwrap();
        let limits = InventoryLimits {
            entries: 0,
            files: 0,
            file_bytes: 0,
            total_bytes: 0,
            ..Default::default()
        };
        assert!(service
            .capture_inventory(&All, limits)
            .unwrap()
            .files()
            .is_empty());
        fs::write(root.path().join("empty"), []).unwrap();
        let limits = InventoryLimits {
            entries: 1,
            files: 1,
            ..limits
        };
        assert_eq!(
            service.capture_inventory(&All, limits).unwrap().files()[0].bytes(),
            0
        );
    }
    #[test]
    fn every_resource_limit_fails_whole_scan() {
        let root = Fixture::new();
        fs::create_dir(root.path().join("dir")).unwrap();
        fs::write(root.path().join("dir/file"), b"two").unwrap();
        let service = FsService::new(root.path()).unwrap();
        for limits in [
            InventoryLimits {
                entries: 1,
                ..Default::default()
            },
            InventoryLimits {
                files: 0,
                ..Default::default()
            },
            InventoryLimits {
                directories: 1,
                ..Default::default()
            },
            InventoryLimits {
                metadata_bytes: 256,
                ..Default::default()
            },
            InventoryLimits {
                file_bytes: 2,
                ..Default::default()
            },
            InventoryLimits {
                total_bytes: 2,
                ..Default::default()
            },
            InventoryLimits {
                depth: 1,
                ..Default::default()
            },
        ] {
            assert!(
                matches!(
                    service.capture_inventory(&All, limits),
                    Err(InventoryError::Limit)
                ),
                "{limits:?}"
            );
        }
        for limits in [
            InventoryLimits {
                entries: 100_001,
                ..Default::default()
            },
            InventoryLimits {
                file_bytes: 512 * 1024 * 1024 + 1,
                ..Default::default()
            },
            InventoryLimits {
                directories: 0,
                ..Default::default()
            },
            InventoryLimits {
                depth: 129,
                ..Default::default()
            },
        ] {
            assert!(matches!(
                service.capture_inventory(&All, limits),
                Err(InventoryError::InvalidLimits)
            ));
        }
    }
    #[test]
    fn large_file_interior_is_fully_rehashed_and_revalidation_detects_edit() {
        let root = Fixture::new();
        let path = root.path().join("large");
        let mut bytes = vec![b'a'; 8 * 1024 * 1024];
        fs::write(&path, &bytes).unwrap();
        let service = FsService::new(root.path()).unwrap();
        let inventory = service.capture_inventory(&All, Default::default()).unwrap();
        assert_eq!(
            inventory.files()[0].sha256_hex(),
            format!("{:x}", Sha256::digest(&bytes))
        );
        bytes[512 * 1024] = b'b';
        fs::write(&path, &bytes).unwrap();
        assert!(service.revalidate_inventory(&inventory, &All).is_err());
    }
    #[test]
    fn additions_deletions_inode_and_mode_changes_invalidate() {
        for operation in 0..4 {
            let root = Fixture::new();
            let path = root.path().join("file");
            fs::write(&path, b"same").unwrap();
            let service = FsService::new(root.path()).unwrap();
            let inventory = service.capture_inventory(&All, Default::default()).unwrap();
            match operation {
                0 => fs::write(root.path().join("added"), b"new").unwrap(),
                1 => fs::remove_file(&path).unwrap(),
                2 => {
                    fs::rename(&path, root.path().join("retained")).unwrap();
                    fs::write(&path, b"same").unwrap();
                }
                _ => fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap(),
            }
            assert!(service.revalidate_inventory(&inventory, &All).is_err());
        }
    }
    #[test]
    fn links_and_special_nodes_are_not_silently_omitted() {
        use nix::{sys::stat::Mode, unistd::mkfifo};
        for kind in 0..4 {
            let root = Fixture::new();
            let outside = Fixture::new();
            fs::write(outside.path().join("file"), b"private").unwrap();
            match kind {
                0 => symlink(outside.path().join("file"), root.path().join("link")).unwrap(),
                1 => symlink(outside.path(), root.path().join("link")).unwrap(),
                2 => {
                    fs::write(root.path().join("file"), b"same").unwrap();
                    fs::hard_link(root.path().join("file"), root.path().join("other")).unwrap();
                }
                _ => mkfifo(&root.path().join("fifo"), Mode::S_IRUSR | Mode::S_IWUSR).unwrap(),
            }
            let service = FsService::new(root.path()).unwrap();
            assert!(matches!(
                service.capture_inventory(&All, Default::default()),
                Err(InventoryError::UnsupportedNode)
            ));
        }
    }
    #[test]
    fn exclusions_are_decided_before_opening_or_traversing_nodes() {
        struct Exclude;
        impl InventoryPolicy for Exclude {
            fn identity(&self) -> [u8; 32] {
                [2; 32]
            }
            fn classify(&self, path: &str) -> Result<InventoryDecision, PolicyError> {
                assert!(
                    !path.contains('/'),
                    "excluded directory must not be traversed"
                );
                Ok(InventoryDecision::Exclude)
            }
        }
        let root = Fixture::new();
        fs::create_dir(root.path().join("private")).unwrap();
        fs::write(root.path().join("private/content"), b"secret").unwrap();
        symlink("/missing-private-location", root.path().join("secret-link")).unwrap();
        nix::unistd::mkfifo(
            &root.path().join("secret-fifo"),
            nix::sys::stat::Mode::S_IRUSR,
        )
        .unwrap();
        let service = FsService::new(root.path()).unwrap();
        let inventory = service
            .capture_inventory(&Exclude, Default::default())
            .unwrap();
        assert!(inventory.files().is_empty());
        assert_eq!(inventory.excluded_entries(), 3);
        assert!(matches!(
            service.revalidate_inventory(&inventory, &All),
            Err(InventoryError::ForeignInventory)
        ));
    }
    #[test]
    fn foreign_service_and_rebound_root_fail_closed() {
        let outer = Fixture::new();
        let root = outer.path().join("root");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("file"), b"same").unwrap();
        let service = FsService::new(&root).unwrap();
        let inventory = service.capture_inventory(&All, Default::default()).unwrap();
        let other = FsService::new(&root).unwrap();
        assert!(matches!(
            other.revalidate_inventory(&inventory, &All),
            Err(InventoryError::ForeignInventory)
        ));
        fs::rename(&root, outer.path().join("old")).unwrap();
        fs::create_dir(&root).unwrap();
        assert!(matches!(
            service.capture_inventory(&All, Default::default()),
            Err(InventoryError::Changed)
        ));
    }
    #[tokio::test]
    async fn inventory_never_grants_model_observed_write_permission() {
        let root = Fixture::new();
        fs::write(root.path().join("file"), b"original").unwrap();
        let service = FsService::new(root.path()).unwrap();
        let inventory = service.capture_inventory(&All, Default::default()).unwrap();
        let target = service.resolve("file").unwrap();
        assert!(service
            .observations()
            .get("model", target.key())
            .unwrap()
            .is_none());
        assert!(matches!(
            service.write("model", &target, b"blind".to_vec()).await,
            Err(xharness_fs::FsError::BlindOverwrite { .. })
        ));
        service.revalidate_inventory(&inventory, &All).unwrap();
    }
    #[test]
    fn directory_fault_probe_never_accepts_injected_io_errors() {
        // The preload shim is used only by an isolated remote acceptance process.
        // A normal CI invocation still exercises the positive path, not a skip.
        let fixture = Fixture::new();
        let root = fixture.path().join("xh-inventory-fault");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("file"), b"fixture").unwrap();
        let service = FsService::new(&root).unwrap();
        #[cfg(target_os = "linux")]
        let before_fds = if std::env::var_os("XHARNESS_INVENTORY_ISOLATED_PROBE").is_some() {
            Some(
                fs::read_dir("/proc/self/fd")
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap()
                    .len(),
            )
        } else {
            None
        };
        let result = service.capture_inventory(&All, Default::default());
        #[cfg(target_os = "linux")]
        if let Some(before_fds) = before_fds {
            assert_eq!(
                before_fds,
                fs::read_dir("/proc/self/fd")
                    .unwrap()
                    .collect::<Result<Vec<_>, _>>()
                    .unwrap()
                    .len(),
                "directory error leaked an fd"
            );
        }
        if let Some(mode) = std::env::var_os("XHARNESS_DIR_FAULT") {
            assert!(
                std::env::var_os("XHARNESS_INVENTORY_ISOLATED_PROBE").is_some(),
                "fault acceptance must run in the isolated single-test subprocess"
            );
            let error = match result {
                Err(InventoryError::Directory(error)) => error,
                other => panic!("fault was accepted or misclassified: {other:?}"),
            };
            let expected = match mode.to_str().unwrap() {
                "open" => 12,
                "permission" => 13,
                "unknown" => 300,
                _ => 5,
            };
            let mut current: &(dyn std::error::Error + 'static) = error.as_ref();
            let mut found = false;
            loop {
                if let Some(error) = current.downcast_ref::<std::io::Error>() {
                    found |= error.raw_os_error() == Some(expected);
                }
                match current.source() {
                    Some(source) => current = source,
                    None => break,
                }
            }
            assert!(found, "original typed OS error was lost");
            if mode == "read-close" {
                assert!(error.to_string().contains("cleanup"));
            }
        } else {
            assert!(result.is_ok(), "{result:?}");
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn non_utf8_actual_name_is_rejected_without_lossy_conversion() {
        use std::os::unix::ffi::OsStringExt;
        let root = Fixture::new();
        fs::write(
            root.path()
                .join(std::ffi::OsString::from_vec(vec![b'x', 255])),
            b"data",
        )
        .unwrap();
        assert!(matches!(
            FsService::new(root.path())
                .unwrap()
                .capture_inventory(&All, Default::default()),
            Err(InventoryError::InvalidPath)
        ));
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn mount_crossing_is_rejected() {
        struct ProcOnly;
        impl InventoryPolicy for ProcOnly {
            fn identity(&self) -> [u8; 32] {
                [3; 32]
            }
            fn classify(&self, path: &str) -> Result<InventoryDecision, PolicyError> {
                Ok(if path == "proc" {
                    InventoryDecision::Include
                } else {
                    InventoryDecision::Exclude
                })
            }
        }
        assert_ne!(
            fs::metadata("/").unwrap().dev(),
            fs::metadata("/proc").unwrap().dev()
        );
        assert!(matches!(
            FsService::new("/")
                .unwrap()
                .capture_inventory(&ProcOnly, Default::default()),
            Err(InventoryError::CrossDevice)
        ));
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
#[test]
fn unsupported_platform_never_reports_a_complete_inventory() {
    let root = Fixture::new();
    let service = FsService::new(root.path()).unwrap();
    assert!(matches!(
        service.capture_inventory(&All, InventoryLimits::default()),
        Err(InventoryError::Unsupported)
    ));
}

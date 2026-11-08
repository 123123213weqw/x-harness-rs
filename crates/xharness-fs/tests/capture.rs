use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use xharness_fs::{capture::CaptureError, FsService};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct TestDir(PathBuf);
impl TestDir {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "xh-native-capture-{}-{nonce}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            eprintln!("native capture fixture cleanup failed: {error}");
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod unix {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    use xharness_fs::{capture::MAX_CAPTURE_FILE_BYTES, FsError};

    #[test]
    fn unicode_binary_capture_preserves_bytes_mode_and_full_hash() {
        let root = TestDir::new();
        let path = root.path().join("中文.bin");
        let contents = b"abc\0\xff\nprivate_payload";
        fs::write(&path, contents).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o750)).unwrap();
        let before = fs::metadata(&path).unwrap();
        let service = FsService::new(root.path()).unwrap();
        let target = service.resolve("中文.bin").unwrap();
        let captured = service.capture_file(&target, 1024).unwrap();
        assert_eq!(captured.contents(), contents);
        assert_eq!(
            captured.sha256_hex(),
            format!("{:x}", Sha256::digest(contents))
        );
        assert!(captured.executable());
        service.revalidate_capture(&target, &captured).unwrap();
        let debug = format!("{captured:?}");
        assert!(!debug.contains("private_payload"));
        assert!(!debug.contains("中文"));
        let after = fs::metadata(path).unwrap();
        assert_eq!(
            (before.mode(), before.len(), before.mtime(), before.ctime()),
            (after.mode(), after.len(), after.mtime(), after.ctime())
        );
    }

    #[tokio::test]
    async fn capture_never_grants_a_models_observed_write_permission() {
        let root = TestDir::new();
        fs::write(root.path().join("file"), b"original").unwrap();
        let service = FsService::new(root.path()).unwrap();
        let target = service.resolve("file").unwrap();
        let captured = service.capture_file(&target, 1024).unwrap();
        service.revalidate_capture(&target, &captured).unwrap();
        assert_eq!(
            service.observations().get("model", target.key()).unwrap(),
            None
        );
        assert!(matches!(
            service.write("model", &target, b"blind".to_vec()).await,
            Err(FsError::BlindOverwrite { .. })
        ));
        assert_eq!(fs::read(root.path().join("file")).unwrap(), b"original");
    }

    #[test]
    fn large_file_hash_covers_interior_bytes_outside_tool_sample_windows() {
        let root = TestDir::new();
        let path = root.path().join("large");
        let mut bytes = vec![b'a'; 8 * 1024 * 1024];
        fs::write(&path, &bytes).unwrap();
        let service = FsService::new(root.path()).unwrap();
        let target = service.resolve("large").unwrap();
        let before = service.capture_file(&target, bytes.len()).unwrap();
        bytes[512 * 1024] = b'b';
        fs::write(&path, &bytes).unwrap();
        assert!(service.revalidate_capture(&target, &before).is_err());
        assert_eq!(before.contents()[512 * 1024], b'a');
        let after = service.capture_file(&target, bytes.len()).unwrap();
        assert_ne!(before.sha256_hex(), after.sha256_hex());
        assert_eq!(after.sha256_hex(), format!("{:x}", Sha256::digest(&bytes)));
    }

    #[test]
    fn byte_bounds_fail_without_truncating_and_zero_accepts_only_empty_files() {
        let root = TestDir::new();
        fs::write(root.path().join("empty"), []).unwrap();
        fs::write(root.path().join("full"), b"abc").unwrap();
        let service = FsService::new(root.path()).unwrap();
        let empty = service.resolve("empty").unwrap();
        let full = service.resolve("full").unwrap();
        let capture = service.capture_file(&empty, 0).unwrap();
        assert!(capture.contents().is_empty());
        assert_eq!(
            capture.sha256_hex(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        for bound in [0, 2, MAX_CAPTURE_FILE_BYTES + 1, usize::MAX] {
            assert!(matches!(
                service.capture_file(&full, bound),
                Err(CaptureError::ByteLimit)
            ));
        }
        assert_eq!(service.capture_file(&full, 3).unwrap().contents(), b"abc");
    }

    #[test]
    fn captures_are_bound_to_the_service_target_and_original_inode() {
        let root = TestDir::new();
        fs::write(root.path().join("a"), b"same").unwrap();
        fs::write(root.path().join("b"), b"same").unwrap();
        let first = FsService::new(root.path()).unwrap();
        let second = FsService::new(root.path()).unwrap();
        let a = first.resolve("a").unwrap();
        let b = first.resolve("b").unwrap();
        let other = second.resolve("a").unwrap();
        let captured = first.capture_file(&a, 4).unwrap();
        assert!(matches!(
            first.capture_file(&other, 4),
            Err(CaptureError::ForeignTarget)
        ));
        assert!(matches!(
            first.revalidate_capture(&b, &captured),
            Err(CaptureError::ForeignTarget)
        ));
        assert!(matches!(
            second.revalidate_capture(&other, &captured),
            Err(CaptureError::ForeignTarget)
        ));
        fs::rename(root.path().join("a"), root.path().join("old")).unwrap();
        fs::write(root.path().join("a"), b"same").unwrap();
        assert!(matches!(
            first.revalidate_capture(&a, &captured),
            Err(CaptureError::Changed)
        ));
    }

    #[test]
    fn mode_change_or_deletion_invalidates_a_capture() {
        let root = TestDir::new();
        let path = root.path().join("file");
        fs::write(&path, b"same").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let service = FsService::new(root.path()).unwrap();
        let target = service.resolve("file").unwrap();
        let captured = service.capture_file(&target, 4).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(service.revalidate_capture(&target, &captured).is_err());
        fs::remove_file(path).unwrap();
        assert!(matches!(
            service.capture_file(&target, 4),
            Err(CaptureError::Missing)
        ));
    }

    #[test]
    fn growth_invalidates_a_capture_instead_of_changing_its_transfer_budget() {
        let root = TestDir::new();
        let path = root.path().join("file");
        fs::write(&path, b"a").unwrap();
        let service = FsService::new(root.path()).unwrap();
        let target = service.resolve("file").unwrap();
        let captured = service.capture_file(&target, 1).unwrap();
        fs::write(path, b"longer").unwrap();
        assert!(matches!(
            service.revalidate_capture(&target, &captured),
            Err(CaptureError::Changed)
        ));
    }

    #[test]
    fn hardlinks_are_rejected_even_if_the_alias_is_inside_the_workspace() {
        let root = TestDir::new();
        let path = root.path().join("file");
        fs::write(&path, b"same").unwrap();
        let service = FsService::new(root.path()).unwrap();
        let target = service.resolve("file").unwrap();
        let captured = service.capture_file(&target, 4).unwrap();
        fs::hard_link(path, root.path().join("alias")).unwrap();
        assert!(matches!(
            service.capture_file(&target, 4),
            Err(CaptureError::UnsupportedNode)
        ));
        assert!(service.revalidate_capture(&target, &captured).is_err());
    }

    #[test]
    fn parent_symlinks_are_rejected_even_when_the_destination_is_inside() {
        for inside in [true, false] {
            let root = TestDir::new();
            let outside = TestDir::new();
            fs::create_dir(root.path().join("dir")).unwrap();
            fs::write(root.path().join("dir/file"), b"original").unwrap();
            fs::write(outside.path().join("file"), b"outside").unwrap();
            let service = FsService::new(root.path()).unwrap();
            let target = service.resolve("dir/file").unwrap();
            fs::rename(root.path().join("dir"), root.path().join("parked")).unwrap();
            let destination = if inside {
                root.path().join("parked")
            } else {
                outside.path().to_owned()
            };
            symlink(destination, root.path().join("dir")).unwrap();
            assert!(matches!(
                service.capture_file(&target, 1024),
                Err(CaptureError::UnsupportedNode)
            ));
            assert_eq!(fs::read(outside.path().join("file")).unwrap(), b"outside");
        }
    }

    #[test]
    fn substituted_leaf_symlink_directory_and_fifo_never_produce_contents() {
        let root = TestDir::new();
        let path = root.path().join("file");
        fs::write(&path, b"original").unwrap();
        fs::write(root.path().join("other"), b"other").unwrap();
        let service = FsService::new(root.path()).unwrap();
        let target = service.resolve("file").unwrap();
        fs::remove_file(&path).unwrap();
        symlink(root.path().join("other"), &path).unwrap();
        assert!(matches!(
            service.capture_file(&target, 1024),
            Err(CaptureError::UnsupportedNode)
        ));
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(matches!(
            service.capture_file(&target, 1024),
            Err(CaptureError::UnsupportedNode)
        ));
        fs::remove_dir(&path).unwrap();
        nix::unistd::mkfifo(&path, nix::sys::stat::Mode::S_IRUSR).unwrap();
        let before = std::time::Instant::now();
        assert!(matches!(
            service.capture_file(&target, 1024),
            Err(CaptureError::UnsupportedNode)
        ));
        assert!(before.elapsed() < std::time::Duration::from_secs(2));
    }

    #[test]
    fn replaced_root_does_not_rebind_an_existing_service() {
        let parent = TestDir::new();
        let path = parent.path().join("workspace");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("file"), b"old").unwrap();
        let service = FsService::new(&path).unwrap();
        let target = service.resolve("file").unwrap();
        fs::rename(&path, parent.path().join("parked")).unwrap();
        fs::create_dir(&path).unwrap();
        fs::write(path.join("file"), b"new").unwrap();
        assert!(matches!(
            service.capture_file(&target, 1024),
            Err(CaptureError::Changed)
        ));
    }

    // Darwin's native filesystem rejects this fixture at creation (verified
    // separately). Exercise an actual non-UTF-8 file only where it can exist.
    #[cfg(target_os = "linux")]
    #[test]
    fn non_utf8_paths_fail_instead_of_using_lossy_spelling() {
        use std::os::unix::ffi::OsStrExt;
        let root = TestDir::new();
        let name = std::ffi::OsStr::from_bytes(b"bad-\xff");
        fs::write(root.path().join(name), b"bytes").unwrap();
        let service = FsService::new(root.path()).unwrap();
        let target = service.resolve(Path::new(name)).unwrap();
        assert!(matches!(
            service.capture_file(&target, 1024),
            Err(CaptureError::InvalidPath)
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn cross_mount_targets_are_rejected_without_reading_them() {
        assert_ne!(
            fs::metadata("/").unwrap().dev(),
            fs::metadata("/proc").unwrap().dev()
        );
        let service = FsService::new("/").unwrap();
        let target = service.resolve("proc/version").unwrap();
        assert!(matches!(
            service.capture_file(&target, 4096),
            Err(CaptureError::CrossDevice)
        ));
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
#[test]
fn unsupported_platform_never_claims_native_capture_is_certified() {
    let root = TestDir::new();
    fs::write(root.path().join("file"), b"original").unwrap();
    let service = FsService::new(root.path()).unwrap();
    let target = service.resolve("file").unwrap();
    assert!(matches!(
        service.capture_file(&target, 1024),
        Err(CaptureError::Unsupported)
    ));
}

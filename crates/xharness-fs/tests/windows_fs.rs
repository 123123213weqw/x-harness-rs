#![cfg(windows)]

use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use xharness_fs::{FsError, FsService, ReadLimits, ReadOutcome};

static NEXT_TEMP_DIR: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let sequence = NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "xharness-fs-win-{label}-{}-{nonce}-{sequence}",
            std::process::id()
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
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn windows_read_create_replace_and_cas_match_the_shared_contract() {
    let workspace = TestDir::new("cas");
    let service = FsService::new(workspace.path()).unwrap();
    let target = service.resolve("file.txt").unwrap();

    assert!(matches!(
        service
            .read("owner", &target, ReadLimits::default())
            .await
            .unwrap(),
        ReadOutcome::Absent
    ));
    let created = service.write("owner", &target, "第一版").await.unwrap();
    assert!(created.created);
    assert_eq!(
        fs::read_to_string(workspace.path().join("file.txt")).unwrap(),
        "第一版"
    );

    service
        .read("owner", &target, ReadLimits::default())
        .await
        .unwrap();
    let replaced = service.write("owner", &target, "第二版").await.unwrap();
    assert!(!replaced.created);
    assert_eq!(
        fs::read_to_string(workspace.path().join("file.txt")).unwrap(),
        "第二版"
    );

    fs::write(workspace.path().join("file.txt"), "external").unwrap();
    let error = service.write("owner", &target, "stale").await.unwrap_err();
    assert!(matches!(error, FsError::StaleObservation { .. }));
}

#[test]
fn windows_resolution_rejects_absolute_and_parent_paths() {
    let workspace = TestDir::new("paths");
    let service = FsService::new(workspace.path()).unwrap();
    assert!(matches!(
        service.resolve("..\\outside.txt"),
        Err(FsError::InvalidPath { .. })
    ));
    assert!(matches!(
        service.resolve("C:\\Windows\\win.ini"),
        Err(FsError::InvalidPath { .. })
    ));
}

#[tokio::test]
async fn windows_parent_junction_cannot_escape_the_workspace() {
    use std::os::windows::fs::symlink_dir;

    let workspace = TestDir::new("junction-workspace");
    let outside = TestDir::new("junction-outside");
    let link = workspace.path().join("escape");
    if symlink_dir(outside.path(), &link).is_err() {
        // Some locked-down Windows environments disable unprivileged symlink
        // creation. The ordinary path/CAS tests still run there; native CI
        // enables Developer Mode and exercises this branch.
        return;
    }
    let service = FsService::new(workspace.path()).unwrap();
    let error = service.resolve("escape\\owned.txt").unwrap_err();
    assert!(matches!(error, FsError::WorkspaceEscape { .. }));
    assert!(!outside.path().join("owned.txt").exists());
}

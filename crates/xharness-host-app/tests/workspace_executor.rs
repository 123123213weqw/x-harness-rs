#![cfg(any(target_os = "linux", target_os = "macos"))]
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use xharness_cloud::Id;
use xharness_fs::{workspace_apply::ApplyError, FsService};
use xharness_host_app::workspace_executor::{Checkpoint, ExecutorError, WorkspacePair};

static NEXT: AtomicU64 = AtomicU64::new(0);
// These tests deliberately start real child processes. CLOEXEC takes effect at
// exec, not at fork: an unrelated parallel spawn can transiently inherit a live
// flock descriptor. Isolate fixture lifetimes instead of treating that bounded
// OS inheritance window as a leaked lock or retrying a content operation.
static PROCESS_ISOLATION: std::sync::Mutex<()> = std::sync::Mutex::new(());
struct Fixture {
    root: PathBuf,
    local: FsService,
    cloud: FsService,
    _isolation: std::sync::MutexGuard<'static, ()>,
}
impl Fixture {
    fn new() -> Self {
        let isolation = PROCESS_ISOLATION.lock().unwrap();
        let root = std::env::temp_dir().join(format!(
            "xh-executor-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("local")).unwrap();
        fs::create_dir_all(root.join("cloud")).unwrap();
        Self {
            local: FsService::new(root.join("local")).unwrap(),
            cloud: FsService::new(root.join("cloud")).unwrap(),
            root,
            _isolation: isolation,
        }
    }
    fn pair(&self) -> WorkspacePair<'_> {
        WorkspacePair::new(
            &self.local,
            &self.cloud,
            Id::new("pair").unwrap(),
            Id::new("local").unwrap(),
            Id::new("cloud").unwrap(),
        )
        .unwrap()
    }
    fn l(&self) -> &Path {
        self.local.workspace_root()
    }
    fn c(&self) -> &Path {
        self.cloud.workspace_root()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(e) = fs::remove_dir_all(&self.root) {
            eprintln!("executor fixture cleanup failed: {e}");
        }
    }
}

#[test]
fn two_way_full_hash_binary_unicode_nested_paths_and_retained_preimages() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    fs::create_dir_all(f.l().join("中文/sub")).unwrap();
    fs::write(f.l().join("中文/sub/local.bin"), b"local\0\xff").unwrap();
    fs::write(f.c().join("cloud.txt"), "cloud").unwrap();
    fs::set_permissions(f.c().join("cloud.txt"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(f.l().join(".env"), "secret").unwrap();
    let first = f.pair().synchronize().unwrap();
    assert_eq!(
        (first.generation, first.applied_files, first.recovered),
        (1, 2, false)
    );
    assert_eq!(
        fs::read(f.c().join("中文/sub/local.bin")).unwrap(),
        b"local\0\xff"
    );
    assert_eq!(fs::read(f.l().join("cloud.txt")).unwrap(), b"cloud");
    assert_ne!(
        fs::metadata(f.l().join("cloud.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o111,
        0
    );
    assert!(!f.c().join(".env").exists());
    fs::write(f.l().join("cloud.txt"), "replacement").unwrap();
    let second = f.pair().synchronize().unwrap();
    assert_eq!((second.generation, second.applied_files), (2, 1));
    assert_eq!(fs::read(f.c().join("cloud.txt")).unwrap(), b"replacement");
    let old: Vec<_> = fs::read_dir(f.c())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "old"))
        .collect();
    assert_eq!(old.len(), 1);
    assert_eq!(fs::read(&old[0]).unwrap(), b"cloud");
    assert!(f.local.workspace_use().is_ok());
    assert!(f.cloud.workspace_use().is_ok());
}

#[test]
fn every_durable_boundary_restarts_without_duplicate_effects_or_premature_base() {
    for cut in [
        Checkpoint::Intent,
        Checkpoint::Stage,
        Checkpoint::Publish,
        Checkpoint::Prepared,
        Checkpoint::Decision,
        Checkpoint::CloudBase,
        Checkpoint::BothBases,
        Checkpoint::CloudReleased,
    ] {
        let f = Fixture::new();
        fs::write(f.l().join("local"), "L").unwrap();
        fs::write(f.c().join("cloud"), "C").unwrap();
        assert!(matches!(
            f.pair().synchronize_observed(|p| p != cut),
            Err(ExecutorError::Interrupted)
        ));
        assert!(matches!(f.local.workspace_use(), Err(ApplyError::Busy)));
        if !matches!(cut, Checkpoint::CloudReleased) {
            assert!(matches!(f.cloud.workspace_use(), Err(ApplyError::Busy)));
        }
        if !matches!(
            cut,
            Checkpoint::CloudBase | Checkpoint::BothBases | Checkpoint::CloudReleased
        ) {
            assert!(!f.c().join(".xh-sync-base").exists());
        }
        // New services model process restart: witnesses are not service-ID bound.
        let local = FsService::new(f.l()).unwrap();
        let cloud = FsService::new(f.c()).unwrap();
        let pair = WorkspacePair::new(
            &local,
            &cloud,
            Id::new("pair").unwrap(),
            Id::new("local").unwrap(),
            Id::new("cloud").unwrap(),
        )
        .unwrap();
        let report = pair.synchronize().unwrap();
        assert_eq!(
            (report.generation, report.applied_files, report.recovered),
            (1, 2, true),
            "{cut:?}"
        );
        assert_eq!(fs::read(f.l().join("local")).unwrap(), b"L");
        assert_eq!(fs::read(f.c().join("local")).unwrap(), b"L");
        assert_eq!(fs::read(f.l().join("cloud")).unwrap(), b"C");
        assert_eq!(fs::read(f.c().join("cloud")).unwrap(), b"C");
        assert_eq!(
            fs::read(f.l().join(".xh-sync-base")).unwrap(),
            fs::read(f.c().join(".xh-sync-base")).unwrap()
        );
        assert!(local.workspace_use().is_ok());
        assert!(cloud.workspace_use().is_ok());
    }
}

#[test]
fn conflicts_and_any_deletion_reject_entire_round_before_intent() {
    let f = Fixture::new();
    fs::write(f.l().join("file"), "base").unwrap();
    f.pair().synchronize().unwrap();
    fs::remove_file(f.l().join("file")).unwrap();
    fs::write(f.c().join("new"), "not-yet").unwrap();
    let before = fs::read(f.l().join(".xh-sync-base")).unwrap();
    assert!(matches!(
        f.pair().synchronize(),
        Err(ExecutorError::DeletionDisabled)
    ));
    assert!(!f.l().join("new").exists());
    assert_eq!(before, fs::read(f.l().join(".xh-sync-base")).unwrap());
    assert!(f.local.workspace_use().is_ok());
    fs::write(f.l().join("file"), "left").unwrap();
    fs::write(f.c().join("file"), "right").unwrap();
    assert!(matches!(
        f.pair().synchronize(),
        Err(ExecutorError::Domain(_))
    ));
    assert!(!f.l().join("new").exists());
}

#[test]
fn stale_destination_keeps_external_edit_and_holds_recovery_fence() {
    let f = Fixture::new();
    fs::write(f.l().join("file"), "base").unwrap();
    f.pair().synchronize().unwrap();
    fs::write(f.l().join("file"), "new").unwrap();
    assert!(matches!(
        f.pair().synchronize_observed(|p| p != Checkpoint::Stage),
        Err(ExecutorError::Interrupted)
    ));
    fs::write(f.c().join("file"), "external").unwrap();
    assert!(f.pair().synchronize().is_err());
    assert_eq!(fs::read(f.c().join("file")).unwrap(), b"external");
    assert!(matches!(f.cloud.workspace_use(), Err(ApplyError::Busy)));
}

#[test]
fn changed_source_or_extra_file_cannot_commit_common_base() {
    let f = Fixture::new();
    fs::write(f.l().join("file"), "source").unwrap();
    assert!(matches!(
        f.pair().synchronize_observed(|p| p != Checkpoint::Publish),
        Err(ExecutorError::Interrupted)
    ));
    fs::write(f.c().join("foreign"), "edit").unwrap();
    assert!(f.pair().synchronize().is_err());
    assert!(!f.l().join(".xh-sync-base").exists());
    assert!(!f.c().join(".xh-sync-base").exists());
}

#[test]
fn independent_services_admit_one_writer_and_pending_journal_survives_drop() {
    let f = Fixture::new();
    let other = FsService::new(f.l()).unwrap();
    let use_guard = other.workspace_use().unwrap();
    assert!(matches!(f.local.sync_lease(), Err(ApplyError::Busy)));
    drop(use_guard);
    let lease = f.local.sync_lease().unwrap();
    assert!(matches!(other.workspace_use(), Err(ApplyError::Busy)));
    assert!(matches!(other.sync_lease(), Err(ApplyError::Busy)));
    lease
        .write_record("active", b"pending:owner-recovery\n")
        .unwrap();
    drop(lease);
    assert!(matches!(other.workspace_use(), Err(ApplyError::Busy)));
    let recovery = other.sync_lease().unwrap();
    recovery.write_record("active", b"idle\n").unwrap();
    drop(recovery);
    assert!(f.local.workspace_use().is_ok());
}

#[test]
fn wrong_pair_or_swapped_native_roots_cannot_resume() {
    let f = Fixture::new();
    fs::write(f.l().join("file"), "content").unwrap();
    assert!(matches!(
        f.pair().synchronize_observed(|p| p != Checkpoint::Intent),
        Err(ExecutorError::Interrupted)
    ));
    let other = WorkspacePair::new(
        &f.local,
        &f.cloud,
        Id::new("other-pair").unwrap(),
        Id::new("local").unwrap(),
        Id::new("cloud").unwrap(),
    )
    .unwrap();
    assert!(matches!(
        other.synchronize(),
        Err(ExecutorError::InvalidState)
    ));
    let swapped = WorkspacePair::new(
        &f.cloud,
        &f.local,
        Id::new("pair").unwrap(),
        Id::new("local").unwrap(),
        Id::new("cloud").unwrap(),
    )
    .unwrap();
    assert!(swapped.synchronize().is_err());
    assert!(!f.c().join("file").exists());
    assert!(f.pair().synchronize().unwrap().recovered);
}

#[test]
fn symlink_rejected_and_excluded_transaction_artifacts_never_sync() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    fs::write(f.l().join(".xh-sync-private.old"), "preimage").unwrap();
    fs::write(f.l().join("safe"), "data").unwrap();
    symlink(f.root.join("outside"), f.c().join("escape")).unwrap();
    assert!(f.pair().synchronize().is_err());
    assert!(!f.c().join("safe").exists());
    fs::remove_file(f.c().join("escape")).unwrap();
    f.pair().synchronize().unwrap();
    assert!(!f.c().join(".xh-sync-private.old").exists());
}

#[tokio::test]
async fn model_writes_cannot_alter_native_records_or_mutate_during_pending_sync() {
    let f = Fixture::new();
    let target = f.local.resolve(".xh-sync-active").unwrap();
    assert!(f
        .local
        .write("model", &target, b"forged".to_vec())
        .await
        .is_err());
    fs::write(f.l().join("source"), "data").unwrap();
    assert!(f
        .pair()
        .synchronize_observed(|p| p != Checkpoint::Intent)
        .is_err());
    let target = f.local.resolve("other").unwrap();
    assert!(f
        .local
        .write("model", &target, b"write".to_vec())
        .await
        .is_err());
    assert!(!f.l().join("other").exists());
}

#[test]
fn native_crash_child() {
    let Some(root) = std::env::var_os("XHARNESS_EXECUTOR_CRASH_FIXTURE") else {
        let f = Fixture::new();
        assert_eq!(f.pair().synchronize().unwrap().generation, 1);
        return;
    };
    let root = PathBuf::from(root);
    let local = FsService::new(root.join("local")).unwrap();
    let cloud = FsService::new(root.join("cloud")).unwrap();
    let pair = WorkspacePair::new(
        &local,
        &cloud,
        Id::new("pair").unwrap(),
        Id::new("local").unwrap(),
        Id::new("cloud").unwrap(),
    )
    .unwrap();
    let cut = std::env::var("XHARNESS_EXECUTOR_CRASH_AT").unwrap();
    let result = pair.synchronize_observed(|point| {
        if format!("{point:?}") == cut {
            std::process::exit(86);
        }
        true
    });
    panic!("expected explicit process exit, got {result:?}");
}

#[test]
fn real_process_exit_at_all_eight_boundaries_recovers_from_disk() {
    for cut in [
        Checkpoint::Intent,
        Checkpoint::Stage,
        Checkpoint::Publish,
        Checkpoint::Prepared,
        Checkpoint::Decision,
        Checkpoint::CloudBase,
        Checkpoint::BothBases,
        Checkpoint::CloudReleased,
    ] {
        let f = Fixture::new();
        fs::write(f.l().join("local"), "L").unwrap();
        fs::write(f.c().join("cloud"), "C").unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "native_crash_child",
                "--test-threads=1",
                "--nocapture",
            ])
            .env("XHARNESS_EXECUTOR_CRASH_FIXTURE", &f.root)
            .env("XHARNESS_EXECUTOR_CRASH_AT", format!("{cut:?}"))
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(86),
            "{cut:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(matches!(f.local.workspace_use(), Err(ApplyError::Busy)));
        let report = f.pair().synchronize().unwrap();
        assert!(report.recovered, "{cut:?}");
        assert_eq!(report.generation, 1, "{cut:?}");
        assert_eq!(
            fs::read(f.l().join(".xh-sync-base")).unwrap(),
            fs::read(f.c().join(".xh-sync-base")).unwrap()
        );
        assert_eq!(fs::read(f.c().join("local")).unwrap(), b"L");
        assert_eq!(fs::read(f.l().join("cloud")).unwrap(), b"C");
    }
}

#[test]
fn nested_or_identical_native_roots_are_rejected_before_any_journal() {
    let f = Fixture::new();
    fs::create_dir(f.l().join("nested")).unwrap();
    let nested = FsService::new(f.l().join("nested")).unwrap();
    for (l, c) in [
        (&f.local, &nested),
        (&nested, &f.local),
        (&f.local, &f.local),
    ] {
        assert!(matches!(
            WorkspacePair::new(
                l,
                c,
                Id::new("pair").unwrap(),
                Id::new("local").unwrap(),
                Id::new("cloud").unwrap()
            ),
            Err(ExecutorError::InvalidState)
        ));
    }
    assert!(!f.l().join(".xh-sync-active").exists());
}

#[test]
fn durable_decision_recovery_finalizes_metadata_without_replaying_content() {
    let f = Fixture::new();
    fs::write(f.l().join("file"), "base").unwrap();
    f.pair().synchronize().unwrap();
    fs::write(f.l().join("file"), "decision-point").unwrap();
    assert!(matches!(
        f.pair().synchronize_observed(|p| p != Checkpoint::Decision),
        Err(ExecutorError::Interrupted)
    ));
    // An uncooperative edit after the verified decision must survive recovery.
    fs::write(f.c().join("file"), "later-external-edit").unwrap();
    assert_eq!(f.pair().synchronize().unwrap().generation, 2);
    assert_eq!(
        fs::read(f.c().join("file")).unwrap(),
        b"later-external-edit"
    );
    assert_eq!(fs::read(f.l().join("file")).unwrap(), b"decision-point");
    // The committed point-in-time base now makes the next edit directional.
    assert_eq!(f.pair().synchronize().unwrap().generation, 3);
    assert_eq!(
        fs::read(f.l().join("file")).unwrap(),
        b"later-external-edit"
    );
}

#[test]
fn malformed_journal_never_becomes_empty_state_and_batch_limit_has_no_effects() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    fs::write(f.l().join(".xh-sync-active"), b"{broken").unwrap();
    fs::set_permissions(
        f.l().join(".xh-sync-active"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(matches!(
        f.pair().synchronize(),
        Err(ExecutorError::Encoding(_))
    ));
    assert!(!f.c().join(".xh-sync-active").exists());
    fs::write(f.l().join(".xh-sync-active"), b"idle\n").unwrap();
    for i in 0..129 {
        fs::write(f.l().join(format!("file-{i}")), b"data").unwrap();
    }
    assert!(matches!(
        f.pair().synchronize(),
        Err(ExecutorError::BatchLimit)
    ));
    assert!(!f.c().join("file-0").exists());
    assert!(!f.l().join(".xh-sync-base").exists());
    assert!(f.local.workspace_use().is_ok());
}

#[test]
fn destination_empty_directory_alias_is_rejected_before_any_effect() {
    let f = Fixture::new();
    fs::create_dir(f.l().join("folder")).unwrap();
    fs::write(f.l().join("folder/file"), "data").unwrap();
    fs::create_dir(f.c().join("FOLDER")).unwrap();
    assert!(f.pair().synchronize().is_err());
    assert!(!f.c().join("folder/file").exists());
    assert!(!f.c().join("FOLDER/file").exists());
    assert!(!f.l().join(".xh-sync-active").exists());
}

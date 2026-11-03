#![cfg(any(target_os = "linux", target_os = "macos"))]
use std::os::unix::fs::PermissionsExt;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use xharness_cloud::Id;
use xharness_fs::ObservationStore;
use xharness_fs::{workspace_apply::ApplyError, FsService};
use xharness_host_app::workspace_executor::{
    Checkpoint, ExecutorError, RegistrationCheckpoint, WorkspacePair,
};

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
        let f = Self::unpaired();
        f.pair().register_new_pair().unwrap();
        f
    }
    fn unpaired() -> Self {
        // Independent fixture state is never shared through this scheduling lock.
        // Keep later tests diagnostic even when an earlier assertion poisoned it.
        let isolation = PROCESS_ISOLATION
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
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
        for side in ["local", "cloud"] {
            let control = root.join(format!("control-{side}"));
            fs::create_dir(&control).unwrap();
            fs::set_permissions(&control, fs::Permissions::from_mode(0o700)).unwrap();
            let nonce = if side == "local" {
                "a".repeat(64)
            } else {
                "b".repeat(64)
            };
            FsService::new(root.join(side))
                .unwrap()
                .provision_sync_control(&FsService::new(&control).unwrap(), &nonce)
                .unwrap();
        }
        Self {
            local: open_controlled(&root, "local"),
            cloud: open_controlled(&root, "cloud"),
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
    fn lc(&self) -> PathBuf {
        self.root.join("control-local")
    }
    fn cc(&self) -> PathBuf {
        self.root.join("control-cloud")
    }
    fn generation(&self, cloud: bool) -> u64 {
        let path = if cloud { self.cc() } else { self.lc() };
        serde_json::from_slice::<serde_json::Value>(&fs::read(path.join(".xh-sync-base")).unwrap())
            .unwrap()["generation"]
            .as_u64()
            .unwrap()
    }
    fn l(&self) -> &Path {
        self.local.workspace_root()
    }
    fn c(&self) -> &Path {
        self.cloud.workspace_root()
    }
}
fn open_controlled(root: &Path, side: &str) -> FsService {
    let nonce = if side == "local" {
        "a".repeat(64)
    } else {
        "b".repeat(64)
    };
    FsService::with_sync_control(
        root.join(side),
        ObservationStore::default(),
        root.join(format!("control-{side}")),
        &nonce,
    )
    .unwrap()
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
        Checkpoint::Archived,
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
            Checkpoint::CloudBase
                | Checkpoint::BothBases
                | Checkpoint::Archived
                | Checkpoint::CloudReleased
        ) {
            assert_eq!(f.generation(true), 0);
        }
        // New services model process restart: witnesses are not service-ID bound.
        let local = open_controlled(&f.root, "local");
        let cloud = open_controlled(&f.root, "cloud");
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
            fs::read(f.lc().join(".xh-sync-base")).unwrap(),
            fs::read(f.cc().join(".xh-sync-base")).unwrap()
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
    let before = fs::read(f.lc().join(".xh-sync-base")).unwrap();
    assert!(matches!(
        f.pair().synchronize(),
        Err(ExecutorError::DeletionDisabled)
    ));
    assert!(!f.l().join("new").exists());
    assert_eq!(before, fs::read(f.lc().join(".xh-sync-base")).unwrap());
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
    assert_eq!(f.generation(false), 0);
    assert_eq!(f.generation(true), 0);
}

#[test]
fn independent_services_admit_one_writer_and_pending_journal_survives_drop() {
    let f = Fixture::new();
    let other = open_controlled(&f.root, "local");
    let use_guard = other.workspace_use().unwrap();
    assert!(matches!(f.local.sync_lease(), Err(ApplyError::Busy)));
    drop(use_guard);
    let lease = f.local.sync_lease().unwrap();
    assert!(matches!(other.workspace_use(), Err(ApplyError::Busy)));
    assert!(matches!(other.sync_lease(), Err(ApplyError::Busy)));
    let private = f.local.sync_control().unwrap().0.sync_lease().unwrap();
    private
        .write_record("active", b"pending:owner-recovery\n")
        .unwrap();
    drop(private);
    drop(lease);
    assert!(matches!(other.workspace_use(), Err(ApplyError::Busy)));
    let recovery = other.sync_lease().unwrap();
    let private = other.sync_control().unwrap().0.sync_lease().unwrap();
    private.write_record("active", b"idle\n").unwrap();
    drop(private);
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
        Err(ExecutorError::Unregistered)
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
    let local = open_controlled(&root, "local");
    let cloud = open_controlled(&root, "cloud");
    let pair = WorkspacePair::new(
        &local,
        &cloud,
        Id::new("pair").unwrap(),
        Id::new("local").unwrap(),
        Id::new("cloud").unwrap(),
    )
    .unwrap();
    if let Ok(cut) = std::env::var("XHARNESS_REGISTRATION_CRASH_AT") {
        let result = pair.register_new_pair_observed(|point| {
            if format!("{point:?}") == cut {
                std::process::exit(86);
            }
            true
        });
        panic!("expected registration process exit, got {result:?}");
    }
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
fn real_process_exit_at_all_nine_boundaries_recovers_from_disk() {
    for cut in [
        Checkpoint::Intent,
        Checkpoint::Stage,
        Checkpoint::Publish,
        Checkpoint::Prepared,
        Checkpoint::Decision,
        Checkpoint::CloudBase,
        Checkpoint::BothBases,
        Checkpoint::Archived,
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
            fs::read(f.lc().join(".xh-sync-base")).unwrap(),
            fs::read(f.cc().join(".xh-sync-base")).unwrap()
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
    assert_eq!(fs::read(f.lc().join(".xh-sync-active")).unwrap(), b"idle\n");
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
    let f = Fixture::new();
    fs::write(f.lc().join(".xh-sync-active"), b"{broken").unwrap();
    fs::set_permissions(
        f.lc().join(".xh-sync-active"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(matches!(
        f.pair().synchronize(),
        Err(ExecutorError::Encoding(_))
    ));
    assert_eq!(fs::read(f.cc().join(".xh-sync-active")).unwrap(), b"idle\n");
    fs::write(f.lc().join(".xh-sync-active"), b"idle\n").unwrap();
    for i in 0..129 {
        fs::write(f.l().join(format!("file-{i}")), b"data").unwrap();
    }
    assert!(matches!(
        f.pair().synchronize(),
        Err(ExecutorError::BatchLimit)
    ));
    assert!(!f.c().join("file-0").exists());
    assert_eq!(f.generation(false), 0);
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
    assert_eq!(fs::read(f.lc().join(".xh-sync-active")).unwrap(), b"idle\n");
}

#[test]
fn missing_private_bases_are_not_interpreted_as_a_new_pair() {
    let f = Fixture::new();
    fs::write(f.l().join("file"), "data").unwrap();
    f.pair().synchronize().unwrap();
    fs::remove_file(f.lc().join(".xh-sync-base")).unwrap();
    fs::remove_file(f.cc().join(".xh-sync-base")).unwrap();
    assert!(matches!(
        f.pair().synchronize(),
        Err(ExecutorError::InvalidState)
    ));
    assert!(matches!(
        f.pair().register_new_pair(),
        Err(ExecutorError::InvalidState)
    ));
    assert!(!f.lc().join(".xh-sync-base").exists());
    assert_eq!(fs::read(f.c().join("file")).unwrap(), b"data");
}

#[test]
fn explicit_registration_and_private_root_are_required_for_first_use() {
    let f = Fixture::unpaired();
    assert!(matches!(f.local.workspace_use(), Err(ApplyError::Busy)));
    assert!(matches!(
        f.pair().synchronize(),
        Err(ExecutorError::Unregistered)
    ));
    f.pair().register_new_pair().unwrap();
    f.pair().register_new_pair().unwrap();
    assert!(f.local.workspace_use().is_ok());
    let wrong =
        FsService::with_sync_control(f.l(), ObservationStore::default(), f.lc(), &"c".repeat(64));
    assert!(matches!(wrong, Err(ApplyError::Unregistered)));
    let raw = FsService::new(f.l()).unwrap();
    assert!(matches!(raw.workspace_use(), Err(ApplyError::Busy)));
    assert!(matches!(
        WorkspacePair::new(
            &raw,
            &f.cloud,
            Id::new("pair").unwrap(),
            Id::new("local").unwrap(),
            Id::new("cloud").unwrap()
        ),
        Err(ExecutorError::Unregistered)
    ));
    fs::set_permissions(f.lc(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(f.local.workspace_use().is_err());
    assert!(f.pair().synchronize().is_err());
}

#[test]
fn removing_or_forging_worktree_hints_cannot_unlock_private_recovery() {
    let f = Fixture::new();
    fs::write(f.l().join("file"), "data").unwrap();
    assert!(f
        .pair()
        .synchronize_observed(|p| p != Checkpoint::Intent)
        .is_err());
    fs::remove_file(f.l().join(".xh-sync-active")).unwrap();
    fs::write(f.c().join(".xh-sync-active"), b"idle\n").unwrap();
    assert!(matches!(f.local.workspace_use(), Err(ApplyError::Busy)));
    assert!(matches!(f.cloud.workspace_use(), Err(ApplyError::Busy)));
    let report = f.pair().synchronize().unwrap();
    assert!(report.recovered);
    assert_eq!(fs::read(f.c().join("file")).unwrap(), b"data");
    assert!(f.local.workspace_use().is_ok());
}

#[test]
fn private_checkpoint_archives_are_identical_immutable_and_inspectable() {
    let f = Fixture::new();
    fs::write(f.l().join("file"), "first").unwrap();
    let one = f.pair().synchronize().unwrap();
    fs::write(f.c().join("file"), "second").unwrap();
    let two = f.pair().synchronize().unwrap();
    for generation in [1, 2] {
        let key = format!("checkpoint-{generation:020}");
        let path = format!(".xh-sync-{key}");
        let bytes = fs::read(f.lc().join(&path)).unwrap();
        assert_eq!(bytes, fs::read(f.cc().join(&path)).unwrap());
        assert!(!f.l().join(&path).exists());
        assert!(!f.c().join(&path).exists());
        let lease = f.local.sync_control().unwrap().0.sync_lease().unwrap();
        assert!(matches!(
            lease.put_record_once(&key, b"different"),
            Err(ApplyError::Changed)
        ));
        assert!(matches!(
            lease.write_record(&key, b"different"),
            Err(ApplyError::Invalid)
        ));
        lease.put_record_once(&key, &bytes).unwrap();
    }
    let first = f.pair().committed_checkpoint(1).unwrap();
    let second = f.pair().committed_checkpoint(2).unwrap();
    assert_eq!(first.common_base_sha256, one.common_base_sha256);
    assert_eq!(second.common_base_sha256, two.common_base_sha256);
    assert_eq!(second.previous_base_sha256, first.common_base_sha256);
    assert_eq!(first.changed_files, 1);
    assert_ne!(first.round_id, second.round_id);
    assert!(f.pair().committed_checkpoint(0).is_err());
    assert!(f.pair().committed_checkpoint(3).is_err());
}

#[test]
fn registration_cannot_be_rebound_or_recreated_after_metadata_loss() {
    let f = Fixture::new();
    let saved = fs::read(f.lc().join(".xh-sync-registration")).unwrap();
    fs::remove_file(f.lc().join(".xh-sync-registration")).unwrap();
    assert!(matches!(
        FsService::with_sync_control(f.l(), ObservationStore::default(), f.lc(), &"a".repeat(64)),
        Err(ApplyError::Unregistered)
    ));
    assert!(f.local.workspace_use().is_err());
    assert!(FsService::new(f.l())
        .unwrap()
        .provision_sync_control(f.local.sync_control().unwrap().0, &"a".repeat(64))
        .is_err());
    fs::write(f.lc().join(".xh-sync-registration"), saved).unwrap();
    fs::set_permissions(
        f.lc().join(".xh-sync-registration"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(open_controlled(&f.root, "local").workspace_use().is_ok());
    let moved = f.root.join("moved-control");
    fs::rename(f.lc(), &moved).unwrap();
    fs::create_dir(f.lc()).unwrap();
    fs::set_permissions(f.lc(), fs::Permissions::from_mode(0o700)).unwrap();
    for e in fs::read_dir(moved).unwrap() {
        let e = e.unwrap();
        fs::copy(e.path(), f.lc().join(e.file_name())).unwrap();
    }
    assert!(f.local.workspace_use().is_err());
    assert!(FsService::with_sync_control(
        f.l(),
        ObservationStore::default(),
        f.lc(),
        &"a".repeat(64)
    )
    .is_err());
}

#[test]
fn current_base_requires_identical_committed_archive_before_next_round() {
    let f = Fixture::new();
    fs::write(f.l().join("file"), b"one").unwrap();
    f.pair().synchronize().unwrap();
    fs::write(f.l().join("file"), b"two").unwrap();
    fs::remove_file(f.cc().join(".xh-sync-checkpoint-00000000000000000001")).unwrap();
    assert!(f.pair().synchronize().is_err());
    assert_eq!(f.generation(false), 1);
    assert_eq!(fs::read(f.c().join("file")).unwrap(), b"one");
}

#[test]
fn controlled_platform_keeps_private_admission_and_refuses_full_access() {
    use xharness_platform::{NativePlatform, PlatformConfig, PlatformError};
    let f = Fixture::new();
    let config = PlatformConfig::new(f.l()).workspace_control(f.lc(), "a".repeat(64));
    assert!(matches!(
        NativePlatform::new(config.clone().full_access()),
        Err(PlatformError::UnconfinedWorkspaceControl)
    ));
    let platform = NativePlatform::new(config.clone()).unwrap();
    // A second confined session may open shared admission normally.
    let other = NativePlatform::new(config).unwrap();
    assert!(f.pair().synchronize().is_err());
    let files = platform.filesystem().clone();
    drop(platform);
    drop(other);
    assert!(f.pair().synchronize().is_err());
    drop(files);
    assert_eq!(f.pair().synchronize().unwrap().generation, 1);
}

#[test]
fn new_pair_registration_recovers_after_real_process_exit_at_six_boundaries() {
    for cut in [
        RegistrationCheckpoint::Intent,
        RegistrationCheckpoint::LocalBase,
        RegistrationCheckpoint::BothBases,
        RegistrationCheckpoint::LocalPair,
        RegistrationCheckpoint::BothPairs,
        RegistrationCheckpoint::CloudReleased,
    ] {
        let f = Fixture::unpaired();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "native_crash_child",
                "--test-threads=1",
                "--nocapture",
            ])
            .env("XHARNESS_EXECUTOR_CRASH_FIXTURE", &f.root)
            .env("XHARNESS_REGISTRATION_CRASH_AT", format!("{cut:?}"))
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(86),
            "{cut:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        f.pair().register_new_pair().unwrap();
        assert_eq!(f.generation(false), 0);
        assert_eq!(f.generation(true), 0);
        assert!(f.local.workspace_use().is_ok());
        assert_eq!(f.pair().synchronize().unwrap().generation, 1);
    }
}

#[test]
fn checkpoint_retention_limit_blocks_before_a_new_intent_without_gc() {
    let f = Fixture::new();
    for generation in 1..=128 {
        assert_eq!(f.pair().synchronize().unwrap().generation, generation);
    }
    let before = fs::read(f.lc().join(".xh-sync-base")).unwrap();
    assert!(matches!(
        f.pair().synchronize(),
        Err(ExecutorError::CheckpointLimit)
    ));
    assert_eq!(before, fs::read(f.lc().join(".xh-sync-base")).unwrap());
    assert!(f.pair().committed_checkpoint(1).is_ok());
    assert!(f.pair().committed_checkpoint(128).is_ok());
    assert!(f.local.workspace_use().is_ok());
}

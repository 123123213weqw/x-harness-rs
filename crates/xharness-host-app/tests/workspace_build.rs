#![cfg(target_os = "linux")]
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
use xharness_cloud::{Counter, Id};
use xharness_fs::{FsService, ObservationStore};
use xharness_host_app::{
    workspace_build::{BuildError, BuildStep, NativeBuildCommand, RemoteBuildRunner},
    workspace_executor::{PinnedWorkspaceSnapshot, WorkspacePair},
};
use xharness_process::SpawnSpec;
static PROCESS_ISOLATION: std::sync::Mutex<()> = std::sync::Mutex::new(());
struct Fixture {
    _isolation: std::sync::MutexGuard<'static, ()>,
    root: PathBuf,
    local: FsService,
    cloud: FsService,
}
impl Fixture {
    fn new() -> Self {
        // Independent fixtures: isolate fork-to-CLOEXEC admission inheritance.
        let isolation = PROCESS_ISOLATION
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let root = std::env::temp_dir().join(format!(
            "xh-build-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        for name in [
            "local",
            "cloud",
            "control-local",
            "control-cloud",
            "snapshot",
            "cache",
            "journal",
        ] {
            fs::create_dir(root.join(name)).unwrap();
            fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let open = |side: &str, nonce: &str| {
            let source = FsService::new(root.join(side)).unwrap();
            let control = FsService::new(root.join(format!("control-{side}"))).unwrap();
            source.provision_sync_control(&control, nonce).unwrap();
            FsService::with_sync_control(
                root.join(side),
                ObservationStore::default(),
                control.workspace_root(),
                nonce,
            )
            .unwrap()
        };
        let f = Self {
            _isolation: isolation,
            local: open("local", &"a".repeat(64)),
            cloud: open("cloud", &"b".repeat(64)),
            root,
        };
        f.pair().register_new_pair().unwrap();
        fs::write(
            f.root.join("local/main.rs"),
            b"fn main() { println!(\"remote-built\"); }\n",
        )
        .unwrap();
        fs::write(f.root.join("local/.env"), b"not a source input").unwrap();
        f.pair().synchronize().unwrap();
        f
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
    fn snapshot(&self) -> Arc<PinnedWorkspaceSnapshot> {
        Arc::new(
            self.pair()
                .seal_cloud_snapshot(&FsService::new(self.root.join("snapshot")).unwrap())
                .unwrap(),
        )
    }
    fn runner(&self) -> RemoteBuildRunner {
        RemoteBuildRunner::provision(
            FsService::new(self.root.join("journal")).unwrap(),
            FsService::new(self.root.join("cache")).unwrap(),
            Id::new("cloud").unwrap(),
            Counter(1),
        )
        .unwrap()
    }
    fn command(&self, script: &str) -> NativeBuildCommand {
        NativeBuildCommand {
            spec: SpawnSpec::new("/bin/sh", self.root.join("snapshot"))
                .env("PATH", "/usr/bin:/bin")
                .args(["-c", script])
                .timeout(Duration::from_secs(15)),
            read_only_roots: vec![],
            artifacts: vec![],
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
#[tokio::test]
async fn real_native_build_uses_pinned_source_and_keeps_cache_out_of_both_mirrors() {
    let f = Fixture::new();
    let snapshot = f.snapshot();
    let runner = f.runner();
    let job = Id::new("build").unwrap();
    fs::write(
        f.root.join("local/main.rs"),
        b"new local edit while version one builds",
    )
    .unwrap();
    let receipt = runner
        .run(
            job.clone(),
            snapshot.clone(),
            f.command("cat main.rs && test ! -e .env && printf cache-only > \"$OUT\"")
                .with_test_env("OUT", f.root.join("cache/cache-file")),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(receipt.success, "{}", receipt.stderr);
    assert!(receipt.stdout.contains("remote-built"));
    assert_eq!(receipt.checkpoint.generation(), Counter(1));
    assert_eq!(
        fs::read(f.root.join("cache/cache-file")).unwrap(),
        b"cache-only"
    );
    assert!(!f.root.join("local/cache-file").exists());
    assert!(!f.root.join("cloud/cache-file").exists());
    assert_eq!(
        runner.inspect(&job).unwrap().unwrap().checkpoint,
        receipt.checkpoint
    );
    assert!(runner
        .inspect(&Id::new("missing").unwrap())
        .unwrap()
        .is_none());
    let replay = runner
        .run(
            job.clone(),
            snapshot,
            f.command("cat main.rs && test ! -e .env && printf cache-only > \"$OUT\"")
                .with_test_env("OUT", f.root.join("cache/cache-file")),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(replay.success);
    assert!(runner.artifact(&job, "cache-file").is_err());
    println!("NATIVE_REMOTE_BUILD_VERSION_AND_CACHE_PASSED");
}
trait CommandEnv {
    fn with_test_env(self, key: &str, value: PathBuf) -> Self;
}
impl CommandEnv for NativeBuildCommand {
    fn with_test_env(mut self, key: &str, value: PathBuf) -> Self {
        self.spec = self.spec.env(key, value);
        self
    }
}
#[tokio::test]
async fn readonly_snapshot_rejects_compiler_writes_and_results_remain_versioned() {
    let f = Fixture::new();
    let snapshot = f.snapshot();
    let runner = f.runner();
    let receipt = runner
        .run(
            Id::new("bad-write").unwrap(),
            snapshot.clone(),
            f.command("printf forbidden > main.rs"),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(!receipt.success);
    snapshot.validate().unwrap();
    assert!(fs::read_to_string(f.root.join("snapshot/main.rs"))
        .unwrap()
        .contains("remote-built"));
}
#[tokio::test]
async fn cancel_and_timeout_are_observed_and_never_replayed() {
    let f = Fixture::new();
    let snapshot = f.snapshot();
    let runner = f.runner();
    let job = Id::new("timeout").unwrap();
    let mut command = f.command("sleep 30");
    command.spec.timeout = Some(Duration::from_millis(50));
    let receipt = runner
        .run(
            job.clone(),
            snapshot.clone(),
            command,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(!receipt.success);
    assert_eq!(receipt.termination, "timedout");
    let mut command = f.command("sleep 30");
    command.spec.timeout = Some(Duration::from_millis(50));
    assert_eq!(
        runner
            .run(job.clone(), snapshot, command, &CancellationToken::new())
            .await
            .unwrap()
            .termination,
        "timedout"
    );
    assert_eq!(
        runner.finalize_completed(&job).unwrap().termination,
        "timedout"
    );
}
#[tokio::test]
async fn unknown_intent_blocks_reexecution_and_epoch_or_missing_registration_fail_closed() {
    use sha2::{Digest, Sha256};
    let f = Fixture::new();
    let snapshot = f.snapshot();
    let runner = f.runner();
    let job = Id::new("unknown").unwrap();
    assert!(matches!(
        runner
            .run_observed(
                job.clone(),
                snapshot.clone(),
                f.command("exit 0"),
                &CancellationToken::new(),
                |point| point != BuildStep::Intent
            )
            .await,
        Err(BuildError::Interrupted)
    ));
    assert!(matches!(
        runner.inspect(&job),
        Err(BuildError::OutcomeUnknown)
    ));
    assert!(runner
        .run(
            Id::new("different-job").unwrap(),
            snapshot,
            f.command("exit 0"),
            &CancellationToken::new()
        )
        .await
        .is_err());
    assert!(!f
        .root
        .join(format!(
            "journal/.xh-sync-job-{:x}-result",
            Sha256::digest(job.as_str().as_bytes())
        ))
        .exists());
    assert!(RemoteBuildRunner::open(
        FsService::new(f.root.join("journal")).unwrap(),
        FsService::new(f.root.join("cache")).unwrap(),
        Id::new("cloud").unwrap(),
        Counter(2)
    )
    .is_err());
    fs::remove_file(f.root.join("journal/.xh-sync-profile")).unwrap();
    assert!(runner.inspect(&job).is_err());
}
#[test]
fn source_changes_or_nonempty_snapshot_cannot_become_a_build_checkpoint() {
    let f = Fixture::new();
    fs::write(f.root.join("cloud/main.rs"), b"uncommitted cloud edit").unwrap();
    assert!(f
        .pair()
        .seal_cloud_snapshot(&FsService::new(f.root.join("snapshot")).unwrap())
        .is_err());
}

#[tokio::test]
async fn actual_remote_rustc_build_and_explicit_versioned_artifact_read() {
    use sha2::{Digest, Sha256};
    // This test compiles Rust; execution is explicitly remote-only, never a
    // local test fallback. The whole integration binary is Linux-only too.
    assert!(
        std::env::var("XHARNESS_REMOTE_RUST").as_deref() == Ok("1")
            || std::env::var("GITHUB_ACTIONS").as_deref() == Ok("true"),
        "run this compiler acceptance on WZU_Server or Linux CI only"
    );
    let output = std::process::Command::new("rustup")
        .args(["which", "rustc"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let rustc = fs::canonicalize(String::from_utf8(output.stdout).unwrap().trim()).unwrap();
    let toolchain = rustc.parent().unwrap().parent().unwrap().to_path_buf();
    let f = Fixture::new();
    let snapshot = f.snapshot();
    let runner = f.runner();
    let job = Id::new("actual-rust-build").unwrap();
    let relative = format!(
        "artifacts/{:x}/program",
        Sha256::digest(job.as_str().as_bytes())
    );
    let mut command = f
        .command(
            "mkdir -p \"${OUT%/*}\" && \"$RUSTC\" --edition=2021 main.rs -o \"$OUT\" && \"$OUT\"",
        )
        .with_test_env("OUT", f.root.join("cache").join(&relative))
        .with_test_env("RUSTC", rustc);
    command.read_only_roots = vec![toolchain];
    command.artifacts = vec![relative.clone()];
    let start = std::time::Instant::now();
    let receipt = runner
        .run(job.clone(), snapshot, command, &CancellationToken::new())
        .await
        .unwrap();
    assert!(receipt.success, "{}", receipt.stderr);
    assert_eq!(receipt.stdout.trim(), "remote-built");
    assert_eq!(receipt.artifacts.len(), 1);
    let bytes = runner.artifact(&job, &relative).unwrap();
    assert_eq!(&bytes[..4], b"\x7fELF");
    if let Some(directory) = std::env::var_os("XHARNESS_BUILD_ARTIFACT_EVIDENCE") {
        // Explicit owner-selected evidence output under remote CARGO_TARGET_DIR;
        // no production directory or model-selected artifact path is accepted.
        let target = PathBuf::from(std::env::var_os("CARGO_TARGET_DIR").unwrap());
        let directory = PathBuf::from(directory);
        assert!(directory.starts_with(target));
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("program"), &bytes).unwrap();
        fs::write(directory.join("receipt.json"),serde_json::to_vec_pretty(&serde_json::json!({"profile":"local_code_remote_exec_v1","checkpoint":receipt.checkpoint,"sha256":format!("{:x}",Sha256::digest(&bytes)),"bytes":bytes.len(),"elapsed_ms":start.elapsed().as_millis(),"remote_compiler":true,"local_fallback":false})).unwrap()).unwrap();
    }
    fs::write(f.root.join("cache").join(&relative), b"changed artifact").unwrap();
    assert!(runner.artifact(&job, &relative).is_err());
    assert!(!f.root.join("local/target").exists());
    assert!(!f.root.join("cloud/target").exists());
}

#[tokio::test]
async fn lost_reply_recovers_completed_metadata_without_a_second_process() {
    let f = Fixture::new();
    let snapshot = f.snapshot();
    let runner = f.runner();
    let job = Id::new("lost-reply").unwrap();
    let command = || {
        f.command("printf hit >> \"$LOG\"")
            .with_test_env("LOG", f.root.join("cache/count"))
    };
    assert!(matches!(
        runner
            .run_observed(
                job.clone(),
                snapshot.clone(),
                command(),
                &CancellationToken::new(),
                |point| point != BuildStep::ResultStored
            )
            .await,
        Err(BuildError::Interrupted)
    ));
    assert!(runner.inspect(&job).unwrap().unwrap().success);
    assert!(runner.finalize_completed(&job).unwrap().success);
    assert!(
        runner
            .run(job, snapshot, command(), &CancellationToken::new())
            .await
            .unwrap()
            .success
    );
    assert_eq!(fs::read(f.root.join("cache/count")).unwrap(), b"hit");
}

#[tokio::test]
async fn dropped_build_future_retains_admission_until_native_supervisor_drains() {
    let f = Fixture::new();
    let snapshot = f.snapshot();
    let weak = Arc::downgrade(&snapshot);
    let runner = Arc::new(f.runner());
    let command = f
        .command("printf ready > \"$MARK\"; sleep 30")
        .with_test_env("MARK", f.root.join("cache/started"));
    let task = tokio::spawn(async move {
        runner
            .run(
                Id::new("dropped").unwrap(),
                snapshot,
                command,
                &CancellationToken::new(),
            )
            .await
    });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !f.root.join("cache/started").exists() {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(FsService::new(f.root.join("snapshot"))
        .unwrap()
        .sync_lease()
        .is_err());
    assert!(FsService::new(f.root.join("cache"))
        .unwrap()
        .sync_lease()
        .is_err());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    while weak.upgrade().is_some() {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(FsService::new(f.root.join("snapshot"))
        .unwrap()
        .sync_lease()
        .is_ok());
    assert!(FsService::new(f.root.join("cache"))
        .unwrap()
        .sync_lease()
        .is_ok());
}

#[tokio::test]
async fn native_build_crash_child() {
    let Some(root) = std::env::var_os("XHARNESS_BUILD_CRASH_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let open = |side: &str, nonce: &str| {
        FsService::with_sync_control(
            root.join(side),
            ObservationStore::default(),
            root.join(format!("control-{side}")),
            nonce,
        )
        .unwrap()
    };
    let local = open("local", &"a".repeat(64));
    let cloud = open("cloud", &"b".repeat(64));
    let pair = WorkspacePair::new(
        &local,
        &cloud,
        Id::new("pair").unwrap(),
        Id::new("local").unwrap(),
        Id::new("cloud").unwrap(),
    )
    .unwrap();
    let snapshot = Arc::new(
        pair.seal_cloud_snapshot(&FsService::new(root.join("snapshot")).unwrap())
            .unwrap(),
    );
    let runner = RemoteBuildRunner::provision(
        FsService::new(root.join("journal")).unwrap(),
        FsService::new(root.join("cache")).unwrap(),
        Id::new("cloud").unwrap(),
        Counter(1),
    )
    .unwrap();
    let command = NativeBuildCommand {
        spec: SpawnSpec::new("/bin/sh", root.join("snapshot"))
            .args(["-c", "printf hit >> \"$LOG\""])
            .env("LOG", root.join("cache/count"))
            .timeout(Duration::from_secs(10)),
        read_only_roots: vec![],
        artifacts: vec![],
    };
    let cut = std::env::var("XHARNESS_BUILD_CRASH_STEP").unwrap();
    runner
        .run_observed(
            Id::new("crash").unwrap(),
            snapshot,
            command,
            &CancellationToken::new(),
            |point| {
                if format!("{point:?}") == cut {
                    std::process::exit(86);
                }
                true
            },
        )
        .await
        .unwrap();
    panic!("crash cut was not reached");
}

#[test]
fn actual_process_exit_keeps_unknown_intent_and_recovers_lost_completed_reply() {
    for step in ["Intent", "ResultStored"] {
        let f = Fixture::new();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "native_build_crash_child",
                "--test-threads=1",
                "--nocapture",
            ])
            .env("XHARNESS_BUILD_CRASH_ROOT", &f.root)
            .env("XHARNESS_BUILD_CRASH_STEP", step)
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(86),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let runner = RemoteBuildRunner::open(
            FsService::new(f.root.join("journal")).unwrap(),
            FsService::new(f.root.join("cache")).unwrap(),
            Id::new("cloud").unwrap(),
            Counter(1),
        )
        .unwrap();
        let job = Id::new("crash").unwrap();
        if step == "Intent" {
            assert!(matches!(
                runner.inspect(&job),
                Err(BuildError::OutcomeUnknown)
            ));
            assert!(!f.root.join("cache/count").exists());
        } else {
            assert!(runner.finalize_completed(&job).unwrap().success);
            assert_eq!(fs::read(f.root.join("cache/count")).unwrap(), b"hit");
        }
    }
}

#[test]
fn journal_directory_count_is_repeatable_and_nonempty_snapshot_is_rejected() {
    let f = Fixture::new();
    let root = FsService::new(f.root.join("snapshot")).unwrap();
    let lease = root.sync_lease().unwrap();
    fs::write(f.root.join("snapshot/one"), b"one").unwrap();
    assert_eq!(lease.entry_count(10).unwrap(), 1);
    assert_eq!(lease.entry_count(10).unwrap(), 1);
    drop(lease);
    assert!(f.pair().seal_cloud_snapshot(&root).is_err());
}

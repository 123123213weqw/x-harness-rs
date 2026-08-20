use std::{
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use async_trait::async_trait;
use xharness_process::{ProcessRuntime, SpawnSpec};
use xharness_sandbox::{
    BwrapProbe, BwrapSandbox, NetworkAccess, SandboxError, SandboxMode, SandboxPolicy,
};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

struct TestTree {
    root: PathBuf,
}

impl TestTree {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "xharness-sandbox-{label}-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        Self {
            root: fs::canonicalize(root).unwrap(),
        }
    }

    fn directory(&self, name: &str) -> PathBuf {
        let path = self.root.join(name);
        fs::create_dir_all(&path).unwrap();
        fs::canonicalize(path).unwrap()
    }
}

impl Drop for TestTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[derive(Clone)]
struct FakeProbe {
    calls: Arc<AtomicUsize>,
    result: Result<PathBuf, String>,
}

impl FakeProbe {
    fn available(path: impl Into<PathBuf>) -> Self {
        Self {
            calls: Arc::new(AtomicUsize::new(0)),
            result: Ok(path.into()),
        }
    }

    fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            calls: Arc::new(AtomicUsize::new(0)),
            result: Err(reason.into()),
        }
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl BwrapProbe for FakeProbe {
    async fn probe(&self, _program: OsString) -> Result<PathBuf, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.result.clone()
    }
}

fn sandbox_with_probe(policy: SandboxPolicy, probe: &FakeProbe) -> BwrapSandbox {
    BwrapSandbox::new(policy).with_probe_backend(Arc::new(probe.clone()))
}

fn mount_exists(args: &[OsString], operation: &str, path: &Path) -> bool {
    args.windows(3).any(|window| {
        window[0] == OsStr::new(operation)
            && window[1] == path.as_os_str()
            && window[2] == path.as_os_str()
    })
}

fn option_value_exists(args: &[OsString], option: &str, value: &Path) -> bool {
    args.windows(2)
        .any(|window| window[0] == OsStr::new(option) && window[1] == value.as_os_str())
}

#[tokio::test]
async fn read_only_builds_direct_argv_and_preserves_process_controls() {
    let tree = TestTree::new("readonly");
    let workspace = tree.directory("workspace");
    let cwd = tree.directory("workspace/sub dir");
    let probe = FakeProbe::available("/fake/bwrap");
    let sandbox = sandbox_with_probe(
        SandboxPolicy::new(&workspace, SandboxMode::ReadOnly),
        &probe,
    );
    let original = SpawnSpec::new("/usr/bin/printf", &cwd)
        .args(["%s", "hello world; $(touch /tmp/not-shell)"])
        .env("LANG", "C")
        .timeout(Duration::from_secs(7))
        .termination_grace(Duration::from_millis(123))
        .output_limits(1234, 5678);

    let wrapped = sandbox.prepare(original.clone()).await.unwrap();
    assert_eq!(wrapped.program, OsStr::new("/fake/bwrap"));
    assert_eq!(wrapped.cwd, cwd);
    assert_eq!(wrapped.env, original.env);
    assert_eq!(wrapped.timeout, original.timeout);
    assert_eq!(wrapped.termination_grace, original.termination_grace);
    assert_eq!(wrapped.stdout_limit, 1234);
    assert_eq!(wrapped.stderr_limit, 5678);
    assert!(mount_exists(&wrapped.args, "--ro-bind", Path::new("/")));
    assert!(wrapped.args.contains(&OsString::from("--die-with-parent")));
    assert!(wrapped.args.contains(&OsString::from("--unshare-pid")));
    assert!(mount_exists(&wrapped.args, "--ro-bind", &workspace));
    assert!(option_value_exists(
        &wrapped.args,
        "--proc",
        Path::new("/proc")
    ));
    assert!(option_value_exists(
        &wrapped.args,
        "--dev",
        Path::new("/dev")
    ));
    assert!(option_value_exists(
        &wrapped.args,
        "--tmpfs",
        Path::new("/tmp")
    ));
    assert!(!wrapped.args.contains(&OsString::from("--share-net")));
    assert!(option_value_exists(&wrapped.args, "--chdir", &cwd));

    let separator = wrapped
        .args
        .iter()
        .rposition(|argument| argument == OsStr::new("--"))
        .unwrap();
    assert_eq!(
        &wrapped.args[separator + 1..],
        [
            OsString::from("/usr/bin/printf"),
            OsString::from("%s"),
            OsString::from("hello world; $(touch /tmp/not-shell)")
        ]
    );
}

#[tokio::test]
async fn workspace_write_adds_only_explicit_write_mount_and_network_capability() {
    let tree = TestTree::new("write");
    let workspace = tree.directory("workspace");
    let probe = FakeProbe::available("/fake/bwrap");
    let sandbox = sandbox_with_probe(
        SandboxPolicy::new(&workspace, SandboxMode::WorkspaceWrite)
            .with_network(NetworkAccess::Allow),
        &probe,
    );
    let wrapped = sandbox
        .prepare(SpawnSpec::new("/bin/true", &workspace))
        .await
        .unwrap();

    assert!(mount_exists(&wrapped.args, "--bind", &workspace));
    assert!(!mount_exists(&wrapped.args, "--ro-bind", &workspace));
    assert!(wrapped.args.contains(&OsString::from("--share-net")));
    assert!(option_value_exists(
        &wrapped.args,
        "--tmpfs",
        Path::new("/tmp")
    ));
}

#[tokio::test]
async fn danger_full_access_is_byte_for_byte_passthrough_and_never_probes() {
    let probe = FakeProbe::unavailable("must not run");
    let sandbox = sandbox_with_probe(
        SandboxPolicy::new("/definitely/missing", SandboxMode::DangerFullAccess),
        &probe,
    );
    let original = SpawnSpec::new("program with spaces", "/missing/cwd")
        .args(["a", "b c"])
        .env("TOKEN", "preserved");
    assert_eq!(sandbox.prepare(original.clone()).await.unwrap(), original);
    assert_eq!(probe.calls(), 0);
}

#[tokio::test]
async fn unavailable_probe_is_cached_and_restricted_modes_never_fall_back() {
    let tree = TestTree::new("unavailable");
    let workspace = tree.directory("workspace");
    let probe = FakeProbe::unavailable("user namespaces disabled");
    let sandbox = sandbox_with_probe(
        SandboxPolicy::new(&workspace, SandboxMode::ReadOnly),
        &probe,
    );
    for _ in 0..2 {
        let error = sandbox
            .prepare(SpawnSpec::new("/bin/true", &workspace))
            .await
            .unwrap_err();
        assert_eq!(
            error,
            SandboxError::Unavailable {
                reason: "user namespaces disabled".to_owned()
            }
        );
    }
    assert_eq!(probe.calls(), 1);
}

#[tokio::test]
async fn successful_probe_is_cached_across_clones_and_prepare() {
    let tree = TestTree::new("cache");
    let workspace = tree.directory("workspace");
    let probe = FakeProbe::available("/canonical/fake-bwrap");
    let sandbox = sandbox_with_probe(
        SandboxPolicy::new(&workspace, SandboxMode::ReadOnly),
        &probe,
    );
    let cloned = sandbox.clone();
    assert_eq!(
        sandbox.probe().await.unwrap(),
        Path::new("/canonical/fake-bwrap")
    );
    assert_eq!(
        cloned.probe().await.unwrap(),
        Path::new("/canonical/fake-bwrap")
    );
    cloned
        .prepare(SpawnSpec::new("/bin/true", &workspace))
        .await
        .unwrap();
    assert_eq!(probe.calls(), 1);
}

#[tokio::test]
async fn cwd_must_be_under_workspace_or_an_explicit_read_only_root() {
    let tree = TestTree::new("cwd");
    let workspace = tree.directory("workspace");
    let external = tree.directory("external");
    let nested = tree.directory("external/nested");
    let probe = FakeProbe::available("/fake/bwrap");
    let denied = sandbox_with_probe(
        SandboxPolicy::new(&workspace, SandboxMode::WorkspaceWrite),
        &probe,
    );
    let error = denied
        .prepare(SpawnSpec::new("/bin/true", &nested))
        .await
        .unwrap_err();
    assert!(matches!(error, SandboxError::WorkingDirectoryDenied { .. }));

    let allowed = sandbox_with_probe(
        SandboxPolicy::new(&workspace, SandboxMode::WorkspaceWrite).allow_cwd_root(&external),
        &probe,
    );
    let wrapped = allowed
        .prepare(SpawnSpec::new("/bin/true", &nested))
        .await
        .unwrap();
    assert!(mount_exists(&wrapped.args, "--ro-bind", &external));
    assert!(option_value_exists(&wrapped.args, "--chdir", &nested));
}

#[cfg(unix)]
#[tokio::test]
async fn canonical_cwd_check_rejects_a_symlink_escape_before_probe() {
    use std::os::unix::fs::symlink;

    let tree = TestTree::new("symlink");
    let workspace = tree.directory("workspace");
    let external = tree.directory("external");
    let escaped = workspace.join("escaped");
    symlink(&external, &escaped).unwrap();
    let probe = FakeProbe::available("/fake/bwrap");
    let sandbox = sandbox_with_probe(
        SandboxPolicy::new(&workspace, SandboxMode::ReadOnly),
        &probe,
    );

    let error = sandbox
        .prepare(SpawnSpec::new("/bin/true", &escaped))
        .await
        .unwrap_err();
    assert!(matches!(error, SandboxError::WorkingDirectoryDenied { .. }));
    assert_eq!(probe.calls(), 0);
}

/// Runs only when the server's real Bubblewrap probe succeeds. The fake-probe
/// tests above remain authoritative on hosts without unprivileged userns.
#[tokio::test]
async fn real_bwrap_confines_host_writes_when_available() {
    let tree = TestTree::new("integration");
    let workspace = tree.directory("workspace");
    let outside = tree.directory("outside");
    let sandbox = BwrapSandbox::new(SandboxPolicy::new(&workspace, SandboxMode::WorkspaceWrite));
    if let Err(error) = sandbox.probe().await {
        eprintln!("skipping real Bubblewrap integration: {error}");
        return;
    }

    let inside_file = workspace.join("inside-created");
    let inside = sandbox
        .prepare(SpawnSpec::new("/usr/bin/touch", &workspace).arg(&inside_file))
        .await
        .unwrap();
    let output = ProcessRuntime::new()
        .spawn(inside)
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert!(output.status.success, "stderr={}", output.stderr.text);
    assert!(inside_file.exists());

    let outside_file = outside.join("outside-created");
    let outside_attempt = sandbox
        .prepare(SpawnSpec::new("/usr/bin/touch", &workspace).arg(&outside_file))
        .await
        .unwrap();
    let output = ProcessRuntime::new()
        .spawn(outside_attempt)
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert!(!output.status.success);
    assert!(!outside_file.exists());
}

/// A descendant deliberately creates a new session/process group. Once the
/// sandbox root exits, the PID namespace must still tear it down before its
/// delayed write can occur.
#[tokio::test]
async fn real_bwrap_pid_namespace_cleans_up_setsid_escape_when_available() {
    if !Path::new("/usr/bin/setsid").is_file() {
        eprintln!("skipping setsid cleanup integration: /usr/bin/setsid is missing");
        return;
    }
    let tree = TestTree::new("pid-cleanup");
    let workspace = tree.directory("workspace");
    let worker = workspace.join("delayed-worker.sh");
    let marker = workspace.join("escaped-marker");
    fs::write(&worker, "#!/bin/sh\n/bin/sleep 1\n/usr/bin/touch \"$1\"\n").unwrap();
    let sandbox = BwrapSandbox::new(SandboxPolicy::new(&workspace, SandboxMode::WorkspaceWrite));
    if let Err(error) = sandbox.probe().await {
        eprintln!("skipping setsid cleanup integration: {error}");
        return;
    }

    let script = "/usr/bin/setsid /bin/sh \"$1\" \"$2\" >/dev/null 2>&1 & exit 0";
    let original = SpawnSpec::new("/bin/sh", &workspace)
        .args([
            OsString::from("-c"),
            OsString::from(script),
            OsString::from("xharness-root"),
            worker.as_os_str().to_owned(),
            marker.as_os_str().to_owned(),
        ])
        .timeout(Duration::from_secs(3));
    let wrapped = sandbox.prepare(original).await.unwrap();
    let output = ProcessRuntime::new()
        .spawn(wrapped)
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert!(output.status.success, "stderr={}", output.stderr.text);

    tokio::time::sleep(Duration::from_millis(1_300)).await;
    assert!(
        !marker.exists(),
        "setsid descendant survived the sandbox root and wrote its marker"
    );
}

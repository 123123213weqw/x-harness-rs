use std::{
    fs,
    io::{Read as _, Write as _},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

#[cfg(windows)]
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
};

use xharness_fs::{ReadLimits, ReadOutcome};
use xharness_platform::{NativePlatform, PlatformAccess, PlatformConfig, PlatformKind};
use xharness_process::{SpawnSpec, TerminationReason};
use xharness_sandbox::NetworkAccess;

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

#[cfg(windows)]
fn pwsh_path() -> PathBuf {
    std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .map(|root| root.join("PowerShell").join("7").join("pwsh.exe"))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("pwsh.exe"))
}

#[cfg(unix)]
fn echo_spec(cwd: &std::path::Path, value: &str) -> SpawnSpec {
    SpawnSpec::new("/bin/echo", cwd).arg(value)
}

#[cfg(windows)]
fn echo_spec(cwd: &std::path::Path, value: &str) -> SpawnSpec {
    let mut spec = SpawnSpec::new(pwsh_path(), cwd).args([
        OsString::from("-NoLogo"),
        OsString::from("-NoProfile"),
        OsString::from("-NonInteractive"),
        OsString::from("-Command"),
        OsString::from("Write-Output $args[0]"),
        OsString::from(value),
    ]);
    spec.env = std::env::vars_os().collect::<BTreeMap<_, _>>();
    spec
}

#[cfg(unix)]
fn sleeping_spec(cwd: &std::path::Path) -> SpawnSpec {
    SpawnSpec::new("/bin/sh", cwd).args(["-c", "/bin/sleep 30 & wait"])
}

#[cfg(windows)]
fn sleeping_spec(cwd: &std::path::Path) -> SpawnSpec {
    let mut spec = SpawnSpec::new(pwsh_path(), cwd).args([
        OsStr::new("-NoLogo"),
        OsStr::new("-NoProfile"),
        OsStr::new("-NonInteractive"),
        OsStr::new("-Command"),
        OsStr::new("Start-Sleep -Seconds 30"),
    ]);
    spec.env = std::env::vars_os().collect::<BTreeMap<_, _>>();
    spec
}

struct TempWorkspace(PathBuf);

impl TempWorkspace {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xharness-platform-{}-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test"),
            NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed),
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
}

#[test]
fn full_access_network_probe_child() {
    let Ok(address) = std::env::var("XHARNESS_TEST_NETWORK_ADDRESS") else {
        return;
    };
    let mut stream = TcpStream::connect(address).expect("full-access child can connect");
    stream
        .write_all(b"xharness-network-ok")
        .expect("full-access child can write");
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn native_platform_composes_filesystem_process_and_policy() {
    let workspace = TempWorkspace::new();
    let config = PlatformConfig::new(&workspace.0)
        .full_access()
        .network(NetworkAccess::Deny);
    assert_eq!(config.network_value(), NetworkAccess::Allow);
    let platform = NativePlatform::new(config).unwrap();

    #[cfg(target_os = "linux")]
    assert_eq!(platform.kind(), PlatformKind::Linux);
    #[cfg(target_os = "macos")]
    assert_eq!(platform.kind(), PlatformKind::MacOS);
    #[cfg(windows)]
    assert_eq!(platform.kind(), PlatformKind::Windows);
    assert_eq!(platform.workspace_root(), workspace.0);
    #[cfg(unix)]
    assert_eq!(platform.filesystem().workspace_root(), PathBuf::from("/"));
    #[cfg(windows)]
    assert_eq!(
        platform.filesystem().workspace_root(),
        workspace.0.components().take(2).collect::<PathBuf>()
    );
    assert_eq!(platform.access(), PlatformAccess::FullAccess);
    assert!(platform.sandbox().is_none());

    let relative = platform.resolve_file("probe.txt").unwrap();
    let absolute = platform
        .resolve_file(workspace.0.join("probe.txt"))
        .unwrap();
    assert_eq!(relative.key(), absolute.key());

    let original = echo_spec(&workspace.0, "hello");
    assert_eq!(
        platform.prepare_spawn(original.clone()).await.unwrap(),
        original
    );

    let handle = platform.spawn(echo_spec(&workspace.0, "managed"));
    let output = handle.await.unwrap().wait().await.unwrap();
    assert_eq!(output.stdout.text.trim(), "managed");
}

#[tokio::test]
async fn full_access_reads_and_writes_an_absolute_path_outside_the_workspace() {
    let workspace = TempWorkspace::new();
    let outside = TempWorkspace::new();
    let platform = NativePlatform::new(PlatformConfig::new(&workspace.0).full_access()).unwrap();
    let outside_file = outside.0.join("outside.txt");
    let target = platform.resolve_file(&outside_file).unwrap();

    assert_eq!(
        platform
            .filesystem()
            .read("full-access", &target, ReadLimits::default())
            .await
            .unwrap(),
        ReadOutcome::Absent
    );
    let written = platform
        .filesystem()
        .write("full-access", &target, b"outside workspace\n".to_vec())
        .await
        .unwrap();
    assert!(written.created);
    assert_eq!(
        fs::read_to_string(&outside_file).unwrap(),
        "outside workspace\n"
    );
    let reread = platform
        .filesystem()
        .read("full-access", &target, ReadLimits::default())
        .await
        .unwrap();
    let ReadOutcome::File(reread) = reread else {
        panic!("the full-access write must be readable");
    };
    assert_eq!(reread.text, "outside workspace\n");
}

#[tokio::test]
async fn full_access_allows_network_without_bypassing_managed_process_execution() {
    let workspace = TempWorkspace::new();
    let platform = NativePlatform::new(PlatformConfig::new(&workspace.0).full_access()).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener
        .set_nonblocking(false)
        .expect("test listener can be blocking");
    let address = listener.local_addr().unwrap();
    let receiver = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("network probe connects");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).unwrap();
        bytes
    });

    let current_test = std::env::current_exe().unwrap();
    let mut child_spec = SpawnSpec::new(current_test, &workspace.0)
        .args(["--exact", "full_access_network_probe_child", "--nocapture"])
        .timeout(Duration::from_secs(10));
    // SpawnSpec deliberately replaces the environment. Preserve the native
    // runtime environment here because Windows networking initialization
    // depends on system entries such as SystemRoot.
    child_spec.env = std::env::vars_os().collect();
    child_spec = child_spec.env("XHARNESS_TEST_NETWORK_ADDRESS", address.to_string());
    let output = platform
        .spawn(child_spec)
        .await
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert!(output.status.success, "{}", output.stderr.text);
    assert_eq!(receiver.join().unwrap(), b"xharness-network-ok");
}

#[tokio::test]
async fn full_access_keeps_timeout_and_cancel_process_group_cleanup() {
    let workspace = TempWorkspace::new();
    let platform = NativePlatform::new(PlatformConfig::new(&workspace.0).full_access()).unwrap();

    let timed_out = platform
        .spawn(
            sleeping_spec(&workspace.0)
                .timeout(Duration::from_millis(100))
                .termination_grace(Duration::from_millis(50)),
        )
        .await
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(timed_out.termination, TerminationReason::TimedOut);

    let running = platform
        .spawn(sleeping_spec(&workspace.0).termination_grace(Duration::from_millis(50)))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let cancelled = running.cancel_and_wait().await.unwrap();
    assert_eq!(cancelled.termination, TerminationReason::Cancelled);
}

#[tokio::test]
async fn full_access_readiness_is_explicit_and_does_not_construct_a_sandbox() {
    let workspace = TempWorkspace::new();
    let platform = NativePlatform::new(PlatformConfig::new(&workspace.0).full_access()).unwrap();
    let first = platform.capability_report().await;
    let second = platform.capability_report().await;
    assert_eq!(first, second);
    assert!(first.filesystem_read.is_available());
    assert!(first.filesystem_mutation.is_available());
    assert!(first.restricted_process.is_available());
    assert!(first.terminal_open.is_available());
    assert!(first.process_network.is_available());
    assert_eq!(first.sandbox_backend, "none-full-access");
    assert!(platform.sandbox().is_none());
}

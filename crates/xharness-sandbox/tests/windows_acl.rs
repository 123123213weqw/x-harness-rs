#![cfg(windows)]

use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use xharness_process::{ProcessOutput, ProcessRuntime, SpawnSpec};
use xharness_sandbox::{SandboxMode, SandboxPolicy, WindowsAclSandbox};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

struct TestTree(PathBuf);

impl TestTree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xharness-windows-acl-test-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }

    fn directory(&self, name: &str) -> PathBuf {
        let path = self.0.join(name);
        fs::create_dir(&path).unwrap();
        fs::canonicalize(path).unwrap()
    }
}

impl Drop for TestTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn pwsh_path() -> PathBuf {
    std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .map(|root| root.join("PowerShell").join("7").join("pwsh.exe"))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("pwsh.exe"))
}

fn powershell(cwd: &Path, script: &str, arguments: &[&Path]) -> SpawnSpec {
    let argument_references = (0..arguments.len())
        .map(|index| format!("$env:XHARNESS_TEST_ARGUMENT_{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut spec = SpawnSpec::new(pwsh_path(), cwd).args([
        OsString::from("-NoLogo"),
        OsString::from("-NoProfile"),
        OsString::from("-NonInteractive"),
        OsString::from("-Command"),
        OsString::from(format!(
            "$ErrorActionPreference='Stop'; $testArgs=@({argument_references}); {script}"
        )),
    ]);
    spec.env = std::env::vars_os().collect::<BTreeMap<_, _>>();
    for (index, path) in arguments.iter().enumerate() {
        spec.env.insert(
            OsString::from(format!("XHARNESS_TEST_ARGUMENT_{index}")),
            path.as_os_str().to_owned(),
        );
    }
    spec.timeout = Some(Duration::from_secs(20));
    spec
}

async fn run(workspace: &Path, mode: SandboxMode, spec: SpawnSpec) -> ProcessOutput {
    let sandbox = WindowsAclSandbox::new(SandboxPolicy::new(workspace, mode)).with_runner(
        PathBuf::from(env!("CARGO_BIN_EXE_xharness-windows-sandbox-runner")),
    );
    let wrapped = sandbox.prepare(spec).await.unwrap();
    ProcessRuntime::new()
        .spawn(wrapped)
        .unwrap()
        .wait()
        .await
        .unwrap()
}

#[tokio::test]
async fn workspace_write_allows_workspace_and_private_temp_but_denies_outside() {
    let tree = TestTree::new();
    let workspace = tree.directory("workspace");
    let outside = tree.directory("outside");
    let inside_file = workspace.join("inside.txt");
    let outside_file = outside.join("outside.txt");

    let inside = run(
        &workspace,
        SandboxMode::WorkspaceWrite,
        powershell(
            &workspace,
            "Set-Content -LiteralPath $testArgs[0] -Value 'inside'; $tempFile=Join-Path $env:TEMP 'private.txt'; Set-Content -LiteralPath $tempFile -Value 'temp'; Write-Output (Get-Content -LiteralPath $tempFile)",
            &[&inside_file],
        ),
    )
    .await;
    assert!(inside.status.success, "stderr={}", inside.stderr.text);
    assert_eq!(fs::read_to_string(&inside_file).unwrap().trim(), "inside");
    assert!(inside.stdout.text.contains("temp"));

    let denied = run(
        &workspace,
        SandboxMode::WorkspaceWrite,
        powershell(
            &workspace,
            "Set-Content -LiteralPath $testArgs[0] -Value 'outside'",
            &[&outside_file],
        ),
    )
    .await;
    assert!(!denied.status.success, "stdout={}", denied.stdout.text);
    assert!(!outside_file.exists());
}

#[tokio::test]
async fn read_only_keeps_standing_workspace_grant_inert() {
    let tree = TestTree::new();
    let workspace = tree.directory("workspace");
    let writable = workspace.join("first.txt");
    let denied = workspace.join("denied.txt");

    let first = run(
        &workspace,
        SandboxMode::WorkspaceWrite,
        powershell(
            &workspace,
            "Set-Content -LiteralPath $testArgs[0] -Value 'first'",
            &[&writable],
        ),
    )
    .await;
    assert!(first.status.success, "stderr={}", first.stderr.text);

    let second = run(
        &workspace,
        SandboxMode::ReadOnly,
        powershell(
            &workspace,
            "Set-Content -LiteralPath $testArgs[0] -Value 'denied'",
            &[&denied],
        ),
    )
    .await;
    assert!(!second.status.success, "stdout={}", second.stdout.text);
    assert!(!denied.exists());
}

#![cfg(target_os = "macos")]

use std::{
    fs,
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use xharness_process::{ProcessRuntime, SpawnSpec};
use xharness_sandbox::{NetworkAccess, SandboxMode, SandboxPolicy, SeatbeltSandbox};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

struct TestTree {
    root: PathBuf,
}

impl TestTree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "xharness-seatbelt-{}-{}",
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

async fn execute(spec: SpawnSpec) -> xharness_process::ProcessOutput {
    ProcessRuntime::new()
        .spawn(spec)
        .unwrap()
        .wait()
        .await
        .unwrap()
}

#[tokio::test]
async fn real_seatbelt_allows_workspace_write_and_denies_outside_write() {
    assert!(Path::new("/usr/bin/sandbox-exec").is_file());
    let tree = TestTree::new();
    let workspace = tree.directory("workspace");
    let outside = tree.directory("outside");
    let sandbox = SeatbeltSandbox::new(SandboxPolicy::new(&workspace, SandboxMode::WorkspaceWrite));

    let inside = workspace.join("inside-created");
    let output = execute(
        sandbox
            .prepare(SpawnSpec::new("/usr/bin/touch", &workspace).arg(&inside))
            .await
            .unwrap(),
    )
    .await;
    assert!(output.status.success, "stderr={}", output.stderr.text);
    assert!(inside.is_file());

    let escaped = outside.join("outside-created");
    let output = execute(
        sandbox
            .prepare(SpawnSpec::new("/usr/bin/touch", &workspace).arg(&escaped))
            .await
            .unwrap(),
    )
    .await;
    assert!(
        !output.status.success,
        "outside write unexpectedly succeeded"
    );
    assert!(!escaped.exists());
}

#[tokio::test]
async fn real_seatbelt_denies_network_when_policy_denies_it() {
    assert!(Path::new("/usr/bin/sandbox-exec").is_file());
    let tree = TestTree::new();
    let workspace = tree.directory("workspace-network");
    let sandbox = SeatbeltSandbox::new(
        SandboxPolicy::new(&workspace, SandboxMode::WorkspaceWrite)
            .with_network(NetworkAccess::Deny),
    );
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let address = listener.local_addr().unwrap();
    assert!(TcpStream::connect(address).is_ok());
    let host = address.ip().to_string();
    let port = address.port().to_string();

    // The local listener proves that an unsandboxed connection is available;
    // the same connection from Seatbelt must still be denied.
    let output = execute(
        sandbox
            .prepare(SpawnSpec::new("/usr/bin/nc", &workspace).args([
                "-z",
                "-w",
                "1",
                host.as_str(),
                port.as_str(),
            ]))
            .await
            .unwrap(),
    )
    .await;
    assert!(
        !output.status.success,
        "network access unexpectedly succeeded"
    );
}

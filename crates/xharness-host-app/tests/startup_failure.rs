use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::SystemTime,
};
use xharness_diagnostics::{StartupFailureCode, StartupFailureReceipt};

struct Workspace(PathBuf);

impl Workspace {
    fn new() -> Self {
        // macOS can report the same clock tick to parallel test threads.
        // A per-process serial prevents one Workspace's Drop from deleting
        // another test's still-running child process state directory.
        static NEXT_WORKSPACE: AtomicU64 = AtomicU64::new(0);
        let serial = NEXT_WORKSPACE.fetch_add(1, Ordering::Relaxed);
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "xharness-startup-failure-{}-{nonce}-{serial}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("workspace")).unwrap();
        fs::create_dir(root.join("state")).unwrap();
        Self(root)
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn invalid_provider_file_writes_a_closed_failure_receipt_before_host_exit() {
    let root = Workspace::new();
    let provider_file = root.0.join("providers.json");
    let receipt_file = root.0.join("startup-failure.json");
    let ready_file = root.0.join("ready.address");
    fs::write(
        &provider_file,
        r#"{"apiKey":"secret-bait","providers":"invalid"}"#,
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_xharness-host"))
        .args([
            "--bind",
            "127.0.0.1:0",
            "--workspace",
            root.0.join("workspace").to_str().unwrap(),
            "--state-dir",
            root.0.join("state").to_str().unwrap(),
            "--providers-file",
            provider_file.to_str().unwrap(),
            "--ready-file",
            ready_file.to_str().unwrap(),
        ])
        .env("XHARNESS_STARTUP_FAILURE_FILE", &receipt_file)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!ready_file.exists());
    let receipt = StartupFailureReceipt::read(&receipt_file).unwrap_or_else(|error| {
        panic!(
            "provider startup failed without a receipt: {error}; status={}; stdout={}; stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    });
    assert_eq!(receipt.code, StartupFailureCode::ProviderConfiguration);
    let written = fs::read_to_string(&receipt_file).unwrap();
    assert!(!written.contains("secret-bait"));
    assert!(!written.contains(provider_file.to_str().unwrap()));
}

#[test]
fn argument_failure_before_diagnostics_initialization_still_writes_receipt() {
    let root = Workspace::new();
    let receipt_file = root.0.join("startup-failure.json");
    let output = Command::new(env!("CARGO_BIN_EXE_xharness-host"))
        .args(["--not-a-real-option", "value"])
        .env("XHARNESS_STARTUP_FAILURE_FILE", &receipt_file)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert_eq!(
        StartupFailureReceipt::read(&receipt_file).unwrap().code,
        StartupFailureCode::Arguments
    );
}

#[test]
fn corrupt_control_log_reports_session_restore_without_copying_its_contents() {
    let root = Workspace::new();
    let control = root.0.join("state/control");
    fs::create_dir_all(&control).unwrap();
    fs::write(
        control.join("host-control.jsonl"),
        "not a control header; apiKey=secret-bait\n",
    )
    .unwrap();
    let receipt_file = root.0.join("startup-failure.json");
    let output = Command::new(env!("CARGO_BIN_EXE_xharness-host"))
        .args([
            "--bind",
            "127.0.0.1:0",
            "--workspace",
            root.0.join("workspace").to_str().unwrap(),
            "--state-dir",
            root.0.join("state").to_str().unwrap(),
        ])
        .env("XHARNESS_STARTUP_FAILURE_FILE", &receipt_file)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let receipt = StartupFailureReceipt::read(&receipt_file).unwrap_or_else(|error| {
        panic!(
            "corrupt control log failed without a receipt: {error}; status={}; stdout={}; stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    });
    assert_eq!(
        receipt.code,
        StartupFailureCode::SessionRestore,
        "unexpected startup category; status={}; stdout={}; stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!fs::read_to_string(receipt_file)
        .unwrap()
        .contains("secret-bait"));
}

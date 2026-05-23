use std::{fs, path::PathBuf, process::Command, time::SystemTime};
use xharness_diagnostics::{StartupFailureCode, StartupFailureReceipt};

struct Workspace(PathBuf);

impl Workspace {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "xharness-startup-failure-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(root.join("workspace")).unwrap();
        fs::create_dir_all(root.join("state")).unwrap();
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
    assert_eq!(
        StartupFailureReceipt::read(&receipt_file).unwrap().code,
        StartupFailureCode::ProviderConfiguration
    );
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
    assert_eq!(
        StartupFailureReceipt::read(&receipt_file).unwrap().code,
        StartupFailureCode::SessionRestore
    );
    assert!(!fs::read_to_string(receipt_file)
        .unwrap()
        .contains("secret-bait"));
}

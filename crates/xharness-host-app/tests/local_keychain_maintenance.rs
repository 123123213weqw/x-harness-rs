//! Invalid maintenance requests must never enter ordinary Host startup.
use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn maintenance_rejects_secret_arguments_before_any_runtime_or_state_writes() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "xh-keychain-maintenance-{}-{stamp}",
        std::process::id()
    ));
    fs::create_dir(&root).unwrap();
    let receipt = root.join("must-not-exist.json");
    let result = Command::new(env!("CARGO_BIN_EXE_xharness-host"))
        .env_clear()
        .env("XHARNESS_STARTUP_FAILURE_FILE", &receipt)
        .args(["--authorize-local-keychain", "--state-dir"])
        .arg(&root)
        .args(["--credential-value", "synthetic-secret-must-not-appear"])
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
    assert!(!String::from_utf8_lossy(&result.stderr).contains("synthetic-secret-must-not-appear"));
    assert!(!receipt.exists());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    fs::remove_dir(root).unwrap();
}

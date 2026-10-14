#![cfg(windows)]

use std::{path::PathBuf, time::Duration};
use xharness_process::{
    powershell, shell::ShellSearch, ProcessRuntime, SpawnSpec, TerminationReason,
};

fn selected() -> xharness_process::shell::Shell {
    // CI must stage this exact bundle before these native tests. A developer
    // without a bundle gets an actionable failure, never a silently skipped test.
    let root = std::env::var_os(powershell::ROOT_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../apps/desktop/src-tauri/resources/powershell")
        });
    let mut search = ShellSearch::from_environment();
    search.configured = None;
    search.paths.clear();
    search.bundled_root = Some(root);
    search
        .resolve(|p| p.is_file())
        .expect("stage the pinned PowerShell bundle before native tests")
}

#[tokio::test]
async fn managed_bundle_reports_pinned_version_and_both_streams() {
    let shell = selected();
    let script = "[Console]::Out.Write($PSVersionTable.PSVersion.ToString() + '|中文'); [Console]::Error.Write('stderr'); exit 7";
    let output = ProcessRuntime::new()
        .spawn(
            SpawnSpec::new(&shell.program, std::env::temp_dir())
                .args(shell.command_args(script))
                .env("SystemRoot", std::env::var_os("SystemRoot").unwrap())
                .env("PATH", "")
                .timeout(Duration::from_secs(30)),
        )
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(output.status.code, Some(7));
    assert_eq!(output.termination, TerminationReason::Exited);
    assert_eq!(
        output.stdout.text,
        format!("{}|中文", powershell::version())
    );
    assert_eq!(output.stderr.text, "stderr");
}

#[tokio::test]
async fn managed_bundle_timeout_reaches_quiescence() {
    let shell = selected();
    let output = ProcessRuntime::new()
        .spawn(
            SpawnSpec::new(&shell.program, std::env::temp_dir())
                .args(shell.command_args("Start-Sleep -Seconds 60"))
                .env("SystemRoot", std::env::var_os("SystemRoot").unwrap())
                .timeout(Duration::from_secs(2)),
        )
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(output.termination, TerminationReason::TimedOut);
}

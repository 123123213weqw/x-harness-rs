#![cfg(windows)]

use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use xharness_process::{
    is_secret_env_name, scrub_secret_env, ProcessRuntime, SpawnSpec, TerminationReason,
};

static NEXT_TEMP_DIR: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let sequence = NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "xharness-process-win-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn pwsh(cwd: &Path, command: &str) -> SpawnSpec {
    let mut env = std::env::vars_os().collect::<BTreeMap<_, _>>();
    scrub_secret_env(&mut env);
    let mut spec = SpawnSpec::new("pwsh.exe", cwd).args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        command,
    ]);
    spec.env = env;
    spec
}

#[tokio::test]
async fn foreground_process_preserves_utf8_cwd_and_nonzero_status() {
    let dir = TestDir::new();
    let output = ProcessRuntime::new()
        .spawn(pwsh(
            dir.path(),
            "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::Error.Write('错误'); [Console]::Out.Write((Get-Location).Path + '|你好'); exit 17",
        ))
        .unwrap()
        .wait()
        .await
        .unwrap();

    assert_eq!(output.termination, TerminationReason::Exited);
    assert_eq!(output.status.code, Some(17));
    assert!(!output.status.success);
    assert_eq!(output.status.signal, None);
    assert!(!output.status.core_dumped);
    assert!(output.stdout.text.ends_with("|你好"));
    assert_eq!(output.stderr.text, "错误");
}

#[tokio::test]
async fn timeout_terminates_the_job_and_returns_a_timed_out_result() {
    let dir = TestDir::new();
    let output = ProcessRuntime::new()
        .spawn(pwsh(dir.path(), "Start-Sleep -Seconds 30").timeout(Duration::from_millis(100)))
        .unwrap()
        .wait()
        .await
        .unwrap();

    assert_eq!(output.termination, TerminationReason::TimedOut);
    assert!(!output.status.success);
}

#[tokio::test]
async fn root_exit_kills_a_descendant_before_result_publication() {
    let dir = TestDir::new();
    let pid_path = dir.path().join("child.pid");
    let escaped_path = pid_path.display().to_string().replace('\'', "''");
    let command = format!(
        "$childScript=\"[IO.File]::WriteAllText('{escaped_path}', [string]`$PID); Start-Sleep -Seconds 30\"; \
         $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childScript)); \
         Start-Process pwsh.exe -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$encoded) | Out-Null; \
         $deadline=[DateTime]::UtcNow.AddSeconds(5); \
         do {{ Start-Sleep -Milliseconds 10; $ready=(Test-Path -LiteralPath '{escaped_path}') -and ((Get-Item -LiteralPath '{escaped_path}').Length -gt 0) }} until ($ready -or [DateTime]::UtcNow -ge $deadline); \
         if (-not $ready) {{ throw 'child did not publish its PID' }}"
    );
    let output = ProcessRuntime::new()
        .spawn(pwsh(dir.path(), &command))
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert!(output.status.success);

    let pid_text = fs::read_to_string(pid_path).unwrap();
    let pid = pid_text
        .trim()
        .parse::<u32>()
        .expect("child PID file should contain a process id");
    let probe = ProcessRuntime::new()
        .spawn(pwsh(
            dir.path(),
            &format!("if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 1 }}"),
        ))
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert!(
        probe.status.success,
        "descendant {pid} survived Job cleanup"
    );
}

#[test]
fn secret_environment_scrubber_is_case_insensitive_on_windows() {
    let mut env = BTreeMap::from([
        (OsString::from("Path"), OsString::from("safe")),
        (
            OsString::from("DEEPSEEK_API_KEY"),
            OsString::from("must-not-survive"),
        ),
        (OsString::from("Password"), OsString::from("hidden")),
    ]);
    let removed = scrub_secret_env(&mut env);
    assert_eq!(env.len(), 1);
    assert!(env.contains_key(&OsString::from("Path")));
    assert_eq!(removed.len(), 2);
    assert!(is_secret_env_name(
        OsString::from("deepseek_api_key").as_os_str()
    ));
}

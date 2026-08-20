#![cfg(target_os = "linux")]

use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use nix::{errno::Errno, sys::signal::kill, unistd::Pid};
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
            "xharness-process-{}-{nonce}-{sequence}",
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

#[tokio::test]
async fn argv_is_not_interpreted_by_a_shell_and_cwd_is_explicit() {
    let dir = TestDir::new();
    let marker = dir.path().join("must-not-exist");
    let payload = format!("$(touch {})", marker.display());
    let output = ProcessRuntime::new()
        .spawn(
            SpawnSpec::new("/usr/bin/printf", dir.path())
                .args([OsString::from("%s"), OsString::from(&payload)]),
        )
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert!(output.status.success);
    assert_eq!(output.status.code, Some(0));
    assert_eq!(output.termination, TerminationReason::Exited);
    assert_eq!(output.stdout.text, payload);
    assert!(!marker.exists());

    let pwd = ProcessRuntime::new()
        .spawn(SpawnSpec::new("/bin/pwd", dir.path()))
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(pwd.stdout.text.trim_end(), dir.path().to_str().unwrap());

    let environment = ProcessRuntime::new()
        .spawn(SpawnSpec::new("/usr/bin/env", dir.path()).env("XHARNESS_VISIBLE", "explicit-value"))
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(
        environment.stdout.text, "XHARNESS_VISIBLE=explicit-value\n",
        "the child environment must replace, not inherit, the parent environment"
    );
}

#[tokio::test]
async fn nonzero_exit_is_a_normal_result_with_both_streams() {
    let dir = TestDir::new();
    let output = ProcessRuntime::new()
        .spawn(SpawnSpec::new("/bin/sh", dir.path()).args([
            OsString::from("-c"),
            OsString::from("printf stdout; printf stderr >&2; exit 7"),
        ]))
        .unwrap()
        .wait()
        .await
        .unwrap();

    assert!(!output.status.success);
    assert_eq!(output.status.code, Some(7));
    assert_eq!(output.status.signal, None);
    assert_eq!(output.termination, TerminationReason::Exited);
    assert_eq!(output.stdout.text, "stdout");
    assert_eq!(output.stderr.text, "stderr");
}

#[tokio::test]
async fn timeout_escalates_and_returns_a_timed_out_result() {
    let dir = TestDir::new();
    let started = Instant::now();
    let output = ProcessRuntime::new()
        .spawn(
            SpawnSpec::new("/bin/sh", dir.path())
                .args([
                    OsString::from("-c"),
                    OsString::from("trap '' TERM; exec /bin/sleep 30"),
                ])
                .timeout(Duration::from_millis(40))
                .termination_grace(Duration::from_millis(40)),
        )
        .unwrap()
        .wait()
        .await
        .unwrap();

    assert_eq!(output.termination, TerminationReason::TimedOut);
    assert!(!output.status.success);
    assert_eq!(output.status.signal, Some(9));
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn cancel_kills_the_session_leader_and_descendant_tree() {
    let dir = TestDir::new();
    let child_pid_file = dir.path().join("child.pid");
    let handle = ProcessRuntime::new()
        .spawn(
            SpawnSpec::new("/bin/sh", dir.path())
                .args([
                    OsString::from("-c"),
                    OsString::from(
                        "trap '' TERM; /bin/sleep 30 & child=$!; printf '%s' \"$child\" > \"$1\"; wait \"$child\"",
                    ),
                    OsString::from("xharness-test"),
                    child_pid_file.clone().into_os_string(),
                ])
                .termination_grace(Duration::from_millis(40)),
        )
        .unwrap();
    let leader_pid = handle.pid();
    let child_pid = wait_for_pid_file(&child_pid_file).await;

    let (process_group, session) = proc_group_and_session(leader_pid);
    assert_eq!(process_group, leader_pid);
    assert_eq!(session, leader_pid);
    assert!(handle.cancel());
    let output = handle.wait().await.unwrap();
    assert_eq!(output.termination, TerminationReason::Cancelled);
    assert_eq!(output.status.signal, Some(9));

    wait_until_dead(leader_pid).await;
    wait_until_dead(child_pid).await;
}

#[tokio::test]
async fn capture_is_bounded_and_never_splits_valid_unicode() {
    let dir = TestDir::new();
    let output = ProcessRuntime::new()
        .spawn(
            SpawnSpec::new("/usr/bin/printf", dir.path())
                .args([OsString::from("%s"), OsString::from("ééé")])
                .output_limits(5, 3),
        )
        .unwrap()
        .wait()
        .await
        .unwrap();

    assert_eq!(output.stdout.bytes_read, 6);
    assert_eq!(output.stdout.text, "éé");
    assert!(output.stdout.truncated);
    assert!(!output.stdout.text.contains('\u{fffd}'));
    assert!(output.stdout.text.len() <= 5);

    // Bytes are: invalid 0xff, followed by UTF-8 `é` (0xc3 0xa9). The cap
    // keeps 0xff 0xc3: preserve one lossy replacement for the actual invalid
    // byte, but drop the independently truncated scalar lead at the boundary.
    let mixed = ProcessRuntime::new()
        .spawn(
            SpawnSpec::new("/usr/bin/printf", dir.path())
                .args([OsString::from("%b"), OsString::from(r"\0377\0303\0251")])
                .output_limits(2, 2),
        )
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(mixed.stdout.bytes_read, 3);
    assert_eq!(mixed.stdout.text, "\u{fffd}");
    assert!(mixed.stdout.truncated);
}

#[test]
fn secret_environment_scrubber_is_case_insensitive_and_not_overbroad() {
    let mut env = BTreeMap::from([
        (OsString::from("PATH"), OsString::from("/usr/bin")),
        (OsString::from("HOME"), OsString::from("/tmp/home")),
        (OsString::from("MONKEY"), OsString::from("banana")),
        (OsString::from("OPENAI_API_KEY"), OsString::from("secret")),
        (OsString::from("github_token"), OsString::from("secret")),
        (
            OsString::from("AWS_SECRET_ACCESS_KEY"),
            OsString::from("secret"),
        ),
        (OsString::from("SSH_AUTH_SOCK"), OsString::from("/tmp/sock")),
    ]);
    let removed = scrub_secret_env(&mut env);

    assert_eq!(
        env.get(OsStr::new("PATH")),
        Some(&OsString::from("/usr/bin"))
    );
    assert_eq!(
        env.get(OsStr::new("MONKEY")),
        Some(&OsString::from("banana"))
    );
    assert!(!env.contains_key(OsStr::new("OPENAI_API_KEY")));
    assert!(!env.contains_key(OsStr::new("github_token")));
    assert!(!env.contains_key(OsStr::new("AWS_SECRET_ACCESS_KEY")));
    assert!(!env.contains_key(OsStr::new("SSH_AUTH_SOCK")));
    assert_eq!(removed.len(), 4);
    assert!(is_secret_env_name(OsStr::new("My-Password")));
    assert!(!is_secret_env_name(OsStr::new("KEYBOARD_LAYOUT")));
}

async fn wait_for_pid_file(path: &Path) -> u32 {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        if let Ok(text) = fs::read_to_string(path) {
            if let Ok(pid) = text.trim().parse() {
                return pid;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "child pid file was not created"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn proc_group_and_session(pid: u32) -> (u32, u32) {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    let after_name = stat.rsplit_once(") ").unwrap().1;
    let fields: Vec<_> = after_name.split_whitespace().collect();
    let process_group = fields[2].parse().unwrap();
    let session = fields[3].parse().unwrap();
    (process_group, session)
}

async fn wait_until_dead(pid: u32) {
    let pid = Pid::from_raw(i32::try_from(pid).unwrap());
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        if matches!(kill(pid, None), Err(Errno::ESRCH)) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "pid {pid} is still alive"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

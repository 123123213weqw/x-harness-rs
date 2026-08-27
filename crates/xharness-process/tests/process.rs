#![cfg(any(target_os = "linux", target_os = "macos"))]

use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc as std_mpsc, Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use nix::{
    errno::Errno,
    sys::signal::{kill, Signal},
    unistd::Pid,
};
use xharness_debug::{DebugRecorder, MemoryDebugSink};
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
    assert_eq!(
        fs::canonicalize(pwd.stdout.text.trim_end()).unwrap(),
        fs::canonicalize(dir.path()).unwrap(),
        "macOS may report /private/var for the /var symlink"
    );

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
    #[cfg(not(target_os = "macos"))]
    assert_eq!(session, leader_pid);
    #[cfg(target_os = "macos")]
    assert_ne!(session, leader_pid);
    assert!(handle.cancel());
    let output = handle.wait().await.unwrap();
    assert_eq!(output.termination, TerminationReason::Cancelled);
    assert_eq!(output.status.signal, Some(9));

    wait_until_dead(leader_pid).await;
    wait_until_dead(child_pid).await;
}

#[test]
fn dropping_tokio_runtime_kills_the_managed_process_group() {
    let dir = TestDir::new();
    let child_pid_file = dir.path().join("runtime-drop-child.pid");
    let (pids_tx, pids_rx) = std_mpsc::sync_channel(1);
    let (drop_tx, drop_rx) = std_mpsc::sync_channel::<()>(1);
    let thread_file = child_pid_file.clone();
    let worker = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let handle = runtime.block_on(async {
            let handle = ProcessRuntime::new()
                .spawn(
                    SpawnSpec::new("/bin/sh", thread_file.parent().unwrap())
                        .args([
                            OsString::from("-c"),
                            OsString::from(
                                "trap '' TERM; /bin/sleep 30 & child=$!; printf '%s' \"$child\" > \"$1\"; wait \"$child\"",
                            ),
                            OsString::from("xharness-runtime-drop"),
                            thread_file.clone().into_os_string(),
                        ])
                        .termination_grace(Duration::from_secs(30)),
                )
                .unwrap();
            let child = wait_for_pid_file(&thread_file).await;
            pids_tx.send((handle.pid(), child)).unwrap();
            handle
        });
        drop_rx.recv().unwrap();
        // Drop the caller-owned handle immediately before destroying Tokio.
        // The supervisor's synchronous group guard is what makes task abort
        // kill both the leader and descendant without an async cleanup poll.
        drop(handle);
        drop(runtime);
    });

    let (leader, child) = pids_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(process_exists(leader));
    assert!(process_exists(child));
    drop_tx.send(()).unwrap();
    worker.join().unwrap();

    wait_until_dead_sync(leader);
    wait_until_dead_sync(child);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn escaped_session_holding_output_is_a_bounded_cleanup_failure() {
    let dir = TestDir::new();
    let escaped_pid_file = dir.path().join("escaped.pid");
    let handle = ProcessRuntime::new()
        .spawn(
            SpawnSpec::new("/bin/sh", dir.path())
                .args([
                    OsString::from("-c"),
                    OsString::from(
                        "setsid /bin/sh -c 'printf \"%s\" \"$$\" > \"$1\"; exec /bin/sleep 30' escaped \"$1\" & while [ ! -s \"$1\" ]; do /bin/sleep 0.01; done; exit 0",
                    ),
                    OsString::from("xharness-escaped-session"),
                    escaped_pid_file.clone().into_os_string(),
                ])
                .capture_drain_grace(Duration::from_millis(50)),
        )
        .unwrap();
    let escaped = wait_for_pid_file(&escaped_pid_file).await;
    let started = Instant::now();
    let error = handle.wait().await.unwrap_err();
    assert!(matches!(
        error,
        xharness_process::ProcessError::CaptureDrainTimedOut { .. }
    ));
    assert!(started.elapsed() < Duration::from_secs(2));

    // Full access deliberately cannot hard-contain a child that creates a new
    // session. The important contract is that it is reported as cleanup
    // failure instead of hanging or publishing a successful tool result.
    let escaped = Pid::from_raw(i32::try_from(escaped).unwrap());
    let _ = kill(escaped, Signal::SIGKILL);
    wait_until_dead(u32::try_from(escaped.as_raw()).unwrap()).await;
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
    #[cfg(target_os = "linux")]
    {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
        let after_name = stat.rsplit_once(") ").unwrap().1;
        let fields: Vec<_> = after_name.split_whitespace().collect();
        let process_group = fields[2].parse().unwrap();
        let session = fields[3].parse().unwrap();
        return (process_group, session);
    }

    #[cfg(target_os = "macos")]
    {
        let pid = i32::try_from(pid).unwrap();
        // SAFETY: both calls only inspect the process identified by `pid`.
        // The test has just spawned it and checks both return values below.
        let process_group = unsafe { nix::libc::getpgid(pid) };
        let session = unsafe { nix::libc::getsid(pid) };
        assert!(process_group >= 0, "getpgid failed for pid {pid}");
        assert!(session >= 0, "getsid failed for pid {pid}");
        return (
            u32::try_from(process_group).unwrap(),
            u32::try_from(session).unwrap(),
        );
    }

    #[allow(unreachable_code)]
    (0, 0)
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

fn process_exists(pid: u32) -> bool {
    let pid = Pid::from_raw(i32::try_from(pid).unwrap());
    !matches!(kill(pid, None), Err(Errno::ESRCH))
}

fn wait_until_dead_sync(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while process_exists(pid) {
        assert!(Instant::now() < deadline, "pid {pid} is still alive");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[tokio::test]
async fn full_debug_preserves_spawn_raw_chunks_and_completion() {
    let sink = Arc::new(MemoryDebugSink::default());
    let output = ProcessRuntime::with_debug(DebugRecorder::new(sink.clone()))
        .spawn(
            SpawnSpec::new("/bin/sh", "/tmp")
                .args(["-c", "printf out; printf err >&2"])
                .debug_parent("tool-execution-7"),
        )
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert!(output.status.success);
    let events = sink.events().await;
    assert!(events.iter().any(|event| {
        event.event == "started" && event.payload["spec"]["parent"] == "tool-execution-7"
    }));
    assert!(events
        .iter()
        .any(|event| { event.event == "output.chunk" && event.payload["content"] == "out" }));
    assert!(events
        .iter()
        .any(|event| { event.event == "output.chunk" && event.payload["content"] == "err" }));
    assert!(events.iter().any(|event| event.event == "completed"));
}

//! Unix process runtime used by local XHarness tools.
//!
//! Commands are always spawned as an executable plus an argument vector;
//! there is no implicit shell. Every child starts a dedicated process group
//! (and, on Linux, a new session),
//! receives an explicitly supplied working directory and environment, and has
//! bounded stdout/stderr capture. Cancellation and timeouts signal the whole
//! process group with `SIGTERM`, then `SIGKILL` after the configured grace.
//! Process groups are deliberately only an execution-lifecycle primitive: a
//! descendant can call `setsid(2)` and escape them. Hard containment belongs to
//! the platform sandbox below the shared runtime (Seatbelt on macOS and
//! Bubblewrap/Landlock/cgroups on Linux). Callers must await
//! [`ProcessHandle::wait`] before shutting down Tokio so cancellation can reach
//! quiescence and final output can be drained.

use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    future::pending,
    io,
    os::unix::process::ExitStatusExt,
    path::PathBuf,
    process::{ExitStatus, Stdio},
    time::Duration,
};

#[cfg(target_os = "macos")]
use nix::unistd::setpgid;
#[cfg(not(target_os = "macos"))]
use nix::unistd::setsid;
use nix::{
    errno::Errno,
    sys::signal::{killpg, Signal},
    unistd::Pid,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    sync::{oneshot, watch},
    time,
};

pub const DEFAULT_CAPTURE_LIMIT: usize = 256 * 1024;
pub const DEFAULT_TERMINATION_GRACE: Duration = Duration::from_secs(2);

/// One explicit process invocation.
///
/// `program` and `args` are passed directly to `exec`; neither is parsed as a
/// command line. `env` replaces the inherited environment rather than
/// extending it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnSpec {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    pub env: BTreeMap<OsString, OsString>,
    pub timeout: Option<Duration>,
    pub termination_grace: Duration,
    pub stdout_limit: usize,
    pub stderr_limit: usize,
}

impl SpawnSpec {
    pub fn new(program: impl Into<OsString>, cwd: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: cwd.into(),
            env: BTreeMap::new(),
            timeout: None,
            termination_grace: DEFAULT_TERMINATION_GRACE,
            stdout_limit: DEFAULT_CAPTURE_LIMIT,
            stderr_limit: DEFAULT_CAPTURE_LIMIT,
        }
    }

    pub fn arg(mut self, argument: impl Into<OsString>) -> Self {
        self.args.push(argument.into());
        self
    }

    pub fn args<I, S>(mut self, arguments: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.args.extend(arguments.into_iter().map(Into::into));
        self
    }

    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub fn termination_grace(mut self, grace: Duration) -> Self {
        self.termination_grace = grace;
        self
    }

    pub fn output_limits(mut self, stdout_limit: usize, stderr_limit: usize) -> Self {
        self.stdout_limit = stdout_limit;
        self.stderr_limit = stderr_limit;
        self
    }

    /// Remove environment entries whose names look like credentials.
    pub fn scrub_secrets(mut self) -> Self {
        scrub_secret_env(&mut self.env);
        self
    }
}

/// Why the root process stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminationReason {
    Exited,
    Cancelled,
    TimedOut,
}

/// Portable Unix exit information. A non-zero code is still a normal result.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProcessStatus {
    pub success: bool,
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub core_dumped: bool,
}

impl From<ExitStatus> for ProcessStatus {
    fn from(status: ExitStatus) -> Self {
        Self {
            success: status.success(),
            code: status.code(),
            signal: status.signal(),
            core_dumped: status.core_dumped(),
        }
    }
}

/// One bounded stream capture.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturedOutput {
    /// Valid UTF-8. Invalid source bytes are replaced lossily; a UTF-8 scalar
    /// cut by the byte cap is omitted rather than replaced by a partial glyph.
    pub text: String,
    /// True when the byte cap or an incomplete terminal UTF-8 scalar removed
    /// source bytes.
    pub truncated: bool,
    /// Total bytes drained from the pipe, including discarded bytes.
    pub bytes_read: u64,
}

/// Completed process result, including cancellation and timeout exits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessOutput {
    pub pid: u32,
    pub status: ProcessStatus,
    pub termination: TerminationReason,
    pub stdout: CapturedOutput,
    pub stderr: CapturedOutput,
}

#[derive(Debug, thiserror::Error)]
pub enum ProcessError {
    #[error("process program must not be empty")]
    EmptyProgram,
    #[error("a Tokio runtime is required to spawn a process")]
    NoTokioRuntime,
    #[error("spawned process did not expose a pid")]
    MissingPid,
    #[error("process pid {0} does not fit the Unix pid type")]
    PidOutOfRange(u32),
    #[error("failed to spawn {program:?}: {source}")]
    Spawn {
        program: String,
        #[source]
        source: io::Error,
    },
    #[error("process I/O failed while {operation}: {source}")]
    Io {
        operation: &'static str,
        #[source]
        source: io::Error,
    },
    #[error("process supervisor stopped before publishing a result")]
    SupervisorStopped,
    #[error("{stream} capture worker stopped: {message}")]
    CaptureWorker {
        stream: &'static str,
        message: String,
    },
}

/// Stateless Unix process launcher.
#[derive(Clone, Copy, Debug, Default)]
pub struct ProcessRuntime;

impl ProcessRuntime {
    pub const fn new() -> Self {
        Self
    }

    /// Spawn an executable directly, creating a new session/process group.
    pub fn spawn(&self, spec: SpawnSpec) -> Result<ProcessHandle, ProcessError> {
        if spec.program.is_empty() {
            return Err(ProcessError::EmptyProgram);
        }
        let runtime =
            tokio::runtime::Handle::try_current().map_err(|_| ProcessError::NoTokioRuntime)?;

        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .env_clear()
            .envs(&spec.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        // SAFETY: the closure captures no state and performs exactly one
        // async-signal-safe syscall in the post-fork/pre-exec child. Linux
        // gets a fresh session as well as a process group. On macOS, keeping
        // the child in the parent's session while assigning a fresh process
        // group is intentional: hosted/sandboxed macOS runners may reject a
        // cross-session `killpg(2)` with EPERM even for same-uid children.
        // A dedicated process group still gives the lifecycle runtime the
        // required tree-wide TERM/KILL semantics; hard containment remains a
        // responsibility of the platform sandbox.
        unsafe {
            command.pre_exec(|| {
                #[cfg(target_os = "macos")]
                let result = setpgid(Pid::from_raw(0), Pid::from_raw(0));
                #[cfg(not(target_os = "macos"))]
                let result = setsid().map(|_| ());
                result.map_err(|error| io::Error::from_raw_os_error(error as i32))
            });
        }

        let program = spec.program.to_string_lossy().into_owned();
        let mut child = command
            .spawn()
            .map_err(|source| ProcessError::Spawn { program, source })?;
        let pid = match child.id() {
            Some(pid) => pid,
            None => {
                let _ = child.start_kill();
                return Err(ProcessError::MissingPid);
            }
        };
        let process_group = match i32::try_from(pid) {
            Ok(pid) => Pid::from_raw(pid),
            Err(_) => {
                let _ = child.start_kill();
                return Err(ProcessError::PidOutOfRange(pid));
            }
        };

        let stdout = child
            .stdout
            .take()
            .expect("stdout is available because it was configured as piped");
        let stderr = child
            .stderr
            .take()
            .expect("stderr is available because it was configured as piped");
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (result_tx, result_rx) = oneshot::channel();
        runtime.spawn(async move {
            let result =
                supervise(child, process_group, pid, stdout, stderr, spec, cancel_rx).await;
            let _ = result_tx.send(result);
        });

        Ok(ProcessHandle {
            pid,
            cancel_tx,
            result_rx: Some(result_rx),
        })
    }
}

/// An owned running process. Dropping it requests cooperative cancellation;
/// the detached supervisor remains alive until the whole process group is
/// reaped or killed.
#[must_use = "dropping a process handle cancels the process; call wait() to collect its result"]
pub struct ProcessHandle {
    pid: u32,
    cancel_tx: watch::Sender<bool>,
    result_rx: Option<oneshot::Receiver<Result<ProcessOutput, ProcessError>>>,
}

/// Cloneable cancellation capability separated from result ownership. This
/// lets structured tool runtimes request termination while continuing to
/// await the single owned [`ProcessHandle`] to quiescence.
#[derive(Clone)]
pub struct ProcessCancellation {
    cancel_tx: watch::Sender<bool>,
}

impl ProcessCancellation {
    /// Returns false when the supervisor has already stopped.
    pub fn cancel(&self) -> bool {
        self.cancel_tx.send(true).is_ok()
    }
}

impl ProcessHandle {
    pub const fn pid(&self) -> u32 {
        self.pid
    }

    /// Request termination. Returns false if the supervisor already stopped.
    pub fn cancel(&self) -> bool {
        self.cancel_tx.send(true).is_ok()
    }

    pub fn cancellation(&self) -> ProcessCancellation {
        ProcessCancellation {
            cancel_tx: self.cancel_tx.clone(),
        }
    }

    pub async fn cancel_and_wait(self) -> Result<ProcessOutput, ProcessError> {
        self.cancel();
        self.wait().await
    }

    pub async fn wait(mut self) -> Result<ProcessOutput, ProcessError> {
        let receiver = self
            .result_rx
            .take()
            .expect("a ProcessHandle owns exactly one result receiver");
        receiver
            .await
            .map_err(|_| ProcessError::SupervisorStopped)?
    }
}

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        let _ = self.cancel_tx.send(true);
    }
}

enum StopTrigger {
    Exited(io::Result<ExitStatus>),
    Cancelled,
    TimedOut,
}

#[allow(clippy::too_many_arguments)]
async fn supervise(
    mut child: Child,
    process_group: Pid,
    pid: u32,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
    spec: SpawnSpec,
    mut cancel_rx: watch::Receiver<bool>,
) -> Result<ProcessOutput, ProcessError> {
    let stdout_task = tokio::spawn(capture(stdout, spec.stdout_limit));
    let stderr_task = tokio::spawn(capture(stderr, spec.stderr_limit));
    let timeout_duration = spec.timeout;
    let termination_grace = spec.termination_grace;
    let timeout = async move {
        match timeout_duration {
            Some(duration) => time::sleep(duration).await,
            None => pending::<()>().await,
        }
    };
    tokio::pin!(timeout);

    let trigger = tokio::select! {
        status = child.wait() => StopTrigger::Exited(status),
        _ = cancellation_requested(&mut cancel_rx) => StopTrigger::Cancelled,
        _ = &mut timeout => StopTrigger::TimedOut,
    };

    let (status, termination) = match trigger {
        StopTrigger::Exited(status) => {
            let status = status.map_err(|source| io_error("waiting for process", source))?;
            // A tool is a contained process tree. Do not leave descendants
            // alive after its root exits and holding capture pipes open.
            signal_group(process_group, Signal::SIGKILL)?;
            (status, TerminationReason::Exited)
        }
        StopTrigger::Cancelled => (
            terminate_group(&mut child, process_group, termination_grace).await?,
            TerminationReason::Cancelled,
        ),
        StopTrigger::TimedOut => (
            terminate_group(&mut child, process_group, termination_grace).await?,
            TerminationReason::TimedOut,
        ),
    };

    let (stdout_result, stderr_result) = tokio::join!(stdout_task, stderr_task);
    let stdout = capture_result("stdout", stdout_result)?;
    let stderr = capture_result("stderr", stderr_result)?;
    Ok(ProcessOutput {
        pid,
        status: status.into(),
        termination,
        stdout,
        stderr,
    })
}

async fn cancellation_requested(receiver: &mut watch::Receiver<bool>) {
    if *receiver.borrow() {
        return;
    }
    while receiver.changed().await.is_ok() {
        if *receiver.borrow() {
            return;
        }
    }
    // Dropping every sender is also cancellation.
}

async fn terminate_group(
    child: &mut Child,
    process_group: Pid,
    grace: Duration,
) -> Result<ExitStatus, ProcessError> {
    if let Err(error) = signal_group(process_group, Signal::SIGTERM) {
        let _ = child.start_kill();
        let _ = child.wait().await;
        return Err(error);
    }

    match time::timeout(grace, child.wait()).await {
        Ok(status) => {
            let status = status.map_err(|source| io_error("waiting after SIGTERM", source))?;
            // The root may exit while a descendant ignores TERM. KILL the
            // remaining group before awaiting capture EOF.
            signal_group(process_group, Signal::SIGKILL)?;
            Ok(status)
        }
        Err(_) => {
            signal_group(process_group, Signal::SIGKILL)?;
            child
                .wait()
                .await
                .map_err(|source| io_error("waiting after SIGKILL", source))
        }
    }
}

fn signal_group(process_group: Pid, signal: Signal) -> Result<(), ProcessError> {
    match killpg(process_group, signal) {
        Ok(()) | Err(Errno::ESRCH) => Ok(()),
        Err(error) => Err(io_error(
            "signalling process group",
            io::Error::from_raw_os_error(error as i32),
        )),
    }
}

async fn capture<R>(mut reader: R, limit: usize) -> io::Result<CapturedOutput>
where
    R: AsyncRead + Unpin,
{
    let mut kept = Vec::with_capacity(limit.min(8192));
    let mut bytes_read = 0u64;
    let mut buffer = [0u8; 8192];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        bytes_read = bytes_read.saturating_add(count as u64);
        let remaining = limit.saturating_sub(kept.len());
        kept.extend_from_slice(&buffer[..count.min(remaining)]);
    }

    let capped = bytes_read > kept.len() as u64;
    let (text, incomplete_scalar) = utf8_safe_lossy(kept);
    Ok(CapturedOutput {
        text,
        truncated: capped || incomplete_scalar,
        bytes_read,
    })
}

fn utf8_safe_lossy(mut bytes: Vec<u8>) -> (String, bool) {
    let incomplete_tail = incomplete_utf8_tail_start(&bytes);
    if let Some(start) = incomplete_tail {
        bytes.truncate(start);
    }
    (
        String::from_utf8_lossy(&bytes).into_owned(),
        incomplete_tail.is_some(),
    )
}

/// Locate a terminal byte sequence that is still a possible prefix of a valid
/// UTF-8 scalar. Invalid bytes earlier in the buffer do not prevent detection
/// of an independently truncated scalar at the cap boundary.
fn incomplete_utf8_tail_start(bytes: &[u8]) -> Option<usize> {
    let mut continuation_start = bytes.len();
    while continuation_start > 0 && is_utf8_continuation(bytes[continuation_start - 1]) {
        continuation_start -= 1;
    }

    if continuation_start == bytes.len() {
        let lead_index = bytes.len().checked_sub(1)?;
        return utf8_width(bytes[lead_index])
            .filter(|width| *width > 1)
            .map(|_| lead_index);
    }

    let lead_index = continuation_start.checked_sub(1)?;
    let width = utf8_width(bytes[lead_index])?;
    let available = bytes.len() - lead_index;
    if available >= width || !is_possible_utf8_prefix(&bytes[lead_index..]) {
        return None;
    }
    Some(lead_index)
}

const fn is_utf8_continuation(byte: u8) -> bool {
    byte & 0b1100_0000 == 0b1000_0000
}

const fn utf8_width(lead: u8) -> Option<usize> {
    match lead {
        0x00..=0x7f => Some(1),
        0xc2..=0xdf => Some(2),
        0xe0..=0xef => Some(3),
        0xf0..=0xf4 => Some(4),
        _ => None,
    }
}

fn is_possible_utf8_prefix(bytes: &[u8]) -> bool {
    if bytes.len() < 2 {
        return true;
    }
    let second = bytes[1];
    match bytes[0] {
        0xe0 => (0xa0..=0xbf).contains(&second),
        0xed => (0x80..=0x9f).contains(&second),
        0xf0 => (0x90..=0xbf).contains(&second),
        0xf4 => (0x80..=0x8f).contains(&second),
        _ => is_utf8_continuation(second),
    }
}

fn capture_result(
    stream: &'static str,
    result: Result<io::Result<CapturedOutput>, tokio::task::JoinError>,
) -> Result<CapturedOutput, ProcessError> {
    match result {
        Ok(Ok(capture)) => Ok(capture),
        Ok(Err(source)) => Err(io_error("reading process output", source)),
        Err(error) => Err(ProcessError::CaptureWorker {
            stream,
            message: error.to_string(),
        }),
    }
}

fn io_error(operation: &'static str, source: io::Error) -> ProcessError {
    ProcessError::Io { operation, source }
}

/// Remove likely credential-bearing variables and return the removed names.
///
/// Matching is ASCII case-insensitive. It recognizes common exact variables,
/// credential words separated by punctuation, and API/private key suffixes,
/// while avoiding unrelated names such as `MONKEY`.
pub fn scrub_secret_env(env: &mut BTreeMap<OsString, OsString>) -> Vec<OsString> {
    let mut removed = Vec::new();
    env.retain(|name, _| {
        let secret = is_secret_env_name(name);
        if secret {
            removed.push(name.clone());
        }
        !secret
    });
    removed
}

pub fn is_secret_env_name(name: &OsStr) -> bool {
    let normalized = name.to_string_lossy().to_ascii_uppercase();
    if matches!(
        normalized.as_str(),
        "AUTHORIZATION"
            | "COOKIE"
            | "GIT_ASKPASS"
            | "SSH_ASKPASS"
            | "SSH_AUTH_SOCK"
            | "API_KEY"
            | "PRIVATE_KEY"
    ) || normalized.ends_with("_API_KEY")
        || normalized.ends_with("_PRIVATE_KEY")
    {
        return true;
    }

    normalized
        .split(|character: char| !character.is_ascii_alphanumeric())
        .any(|part| {
            matches!(
                part,
                "TOKEN" | "SECRET" | "PASSWORD" | "PASSWD" | "CREDENTIAL" | "CREDENTIALS"
            )
        })
}

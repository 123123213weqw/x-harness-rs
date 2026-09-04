//! Owner-scoped persistent terminal sessions.
//!
//! Unix sessions use a real controlling terminal and Windows sessions use the
//! native ConPTY backend. Output is retained in a bounded byte/line scrollback
//! with monotonic cursors; callers never infer process exit from a quiet period.

use std::{
    collections::{HashMap, VecDeque},
    io,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

#[cfg(windows)]
use std::io::{Read, Write};
#[cfg(unix)]
use std::{
    fs::File,
    os::{fd::OwnedFd, unix::process::ExitStatusExt},
    process::Stdio,
};

#[cfg(unix)]
use nix::{
    errno::Errno,
    libc,
    pty::openpty,
    sys::signal::{killpg, Signal},
    unistd::{dup, setsid, tcgetpgrp, Pid},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
#[cfg(unix)]
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
};
use tokio::{sync::Mutex, time};
use xharness_debug::{DebugEvent, DebugRecorder, DebugScope};
use xharness_process::SpawnSpec;
#[cfg(windows)]
use xharness_win32::{spawn_conpty, ConPtyChild};

const DEFAULT_MAX_SESSIONS_PER_OWNER: usize = 16;
const DEFAULT_SCROLLBACK_BYTES: usize = 1024 * 1024;
const DEFAULT_SCROLLBACK_LINES: usize = 10_000;
const DEFAULT_CLOSE_GRACE: Duration = Duration::from_secs(2);
const MAX_NAME_BYTES: usize = 64;

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);
type SessionKey = (String, String);
type SessionMap = HashMap<SessionKey, Arc<TerminalSession>>;

#[derive(Clone, Debug)]
pub struct TerminalConfig {
    pub max_sessions_per_owner: usize,
    pub scrollback_bytes: usize,
    pub scrollback_lines: usize,
    pub close_grace: Duration,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            max_sessions_per_owner: DEFAULT_MAX_SESSIONS_PER_OWNER,
            scrollback_bytes: DEFAULT_SCROLLBACK_BYTES,
            scrollback_lines: DEFAULT_SCROLLBACK_LINES,
            close_grace: DEFAULT_CLOSE_GRACE,
        }
    }
}

impl TerminalConfig {
    pub fn validate(&self) -> Result<(), TerminalError> {
        if self.max_sessions_per_owner == 0
            || self.scrollback_bytes == 0
            || self.scrollback_lines == 0
            || self.close_grace.is_zero()
        {
            return Err(TerminalError::InvalidConfig);
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct TerminalOpenSpec {
    pub owner: String,
    pub name: String,
    pub process: SpawnSpec,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalSignal {
    Interrupt,
    Terminate,
    Kill,
    Suspend,
    Hangup,
}

impl TerminalSignal {
    #[cfg(unix)]
    const fn as_nix(self) -> Signal {
        match self {
            Self::Interrupt => Signal::SIGINT,
            Self::Terminate => Signal::SIGTERM,
            Self::Kill => Signal::SIGKILL,
            Self::Suspend => Signal::SIGTSTP,
            Self::Hangup => Signal::SIGHUP,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalDescriptor {
    pub id: String,
    pub name: String,
    pub pid: u32,
    pub running: bool,
    pub cursor: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalRead {
    pub id: String,
    pub name: String,
    pub content: String,
    pub cursor: u64,
    pub truncated_before_cursor: bool,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<i32>,
}

#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    #[error("terminal configuration limits must be non-zero")]
    InvalidConfig,
    #[error("terminal owner must not be empty or contain NUL")]
    InvalidOwner,
    #[error("terminal name must use 1-64 ASCII letters, digits, '_', '-' or '.'")]
    InvalidName,
    #[error("terminal {name:?} already exists for this owner")]
    DuplicateName { name: String },
    #[error("terminal session limit reached for this owner")]
    SessionLimit,
    #[error("terminal {name:?} was not found for this owner")]
    NotFound { name: String },
    #[error("terminal {name:?} has already exited")]
    Exited { name: String },
    #[error("terminal cursor {cursor} is ahead of current output {current}")]
    CursorAhead { cursor: u64, current: u64 },
    #[error("terminal process program must not be empty")]
    EmptyProgram,
    #[error("terminal registry is shutting down")]
    RegistryClosed,
    #[error("terminal operation {operation} failed: {source}")]
    Io {
        operation: &'static str,
        #[source]
        source: io::Error,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TerminalShutdownReport {
    pub sessions: usize,
    pub closed: usize,
    pub errors: Vec<String>,
}

impl TerminalShutdownReport {
    pub const fn is_graceful(&self) -> bool {
        self.errors.is_empty() && self.sessions == self.closed
    }
}

#[derive(Clone)]
pub struct TerminalRegistry {
    config: TerminalConfig,
    sessions: Arc<Mutex<SessionMap>>,
    debug: DebugRecorder,
    closed: Arc<AtomicBool>,
}

impl TerminalRegistry {
    pub fn new(config: TerminalConfig) -> Result<Self, TerminalError> {
        config.validate()?;
        Ok(Self {
            config,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            debug: DebugRecorder::disabled(),
            closed: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn with_debug(mut self, debug: DebugRecorder) -> Self {
        self.debug = debug;
        self
    }

    pub fn with_defaults() -> Self {
        Self::new(TerminalConfig::default()).expect("default terminal config is valid")
    }

    pub async fn open(&self, spec: TerminalOpenSpec) -> Result<TerminalDescriptor, TerminalError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(TerminalError::RegistryClosed);
        }
        self.trace(
            &spec.owner,
            "open.request",
            json!({
                "name": &spec.name,
                "program": spec.process.program.to_string_lossy(),
                "args": spec.process.args.iter().map(|arg| arg.to_string_lossy()).collect::<Vec<_>>(),
                "cwd": spec.process.cwd.to_string_lossy(),
            }),
        )
        .await;
        validate_owner(&spec.owner)?;
        validate_name(&spec.name)?;
        if spec.process.program.is_empty() {
            return Err(TerminalError::EmptyProgram);
        }

        let key = (spec.owner.clone(), spec.name.clone());
        let mut sessions = self.sessions.lock().await;
        if self.closed.load(Ordering::Acquire) {
            return Err(TerminalError::RegistryClosed);
        }
        if sessions.contains_key(&key) {
            return Err(TerminalError::DuplicateName { name: spec.name });
        }
        if sessions
            .keys()
            .filter(|(owner, _)| owner == &spec.owner)
            .count()
            >= self.config.max_sessions_per_owner
        {
            return Err(TerminalError::SessionLimit);
        }

        let session = Arc::new(spawn_session(spec, &self.config, self.debug.clone())?);
        let descriptor = session.descriptor().await?;
        self.trace(&key.0, "open.completed", json!({"terminal": &descriptor}))
            .await;
        sessions.insert(key, session);
        Ok(descriptor)
    }

    pub async fn send(&self, owner: &str, name: &str, input: &[u8]) -> Result<u64, TerminalError> {
        self.trace(
            owner,
            "send.request",
            json!({"name": name, "bytes": input.len(), "content": String::from_utf8_lossy(input)}),
        )
        .await;
        let session = self.session(owner, name).await?;
        session.refresh_status().await?;
        if !session.state.lock().await.running {
            return Err(TerminalError::Exited {
                name: name.to_owned(),
            });
        }
        session.write_input(input).await?;
        let cursor = session.state.lock().await.total_bytes;
        self.trace(
            owner,
            "send.completed",
            json!({"name": name, "cursor": cursor}),
        )
        .await;
        Ok(cursor)
    }

    pub async fn read(
        &self,
        owner: &str,
        name: &str,
        cursor: Option<u64>,
    ) -> Result<TerminalRead, TerminalError> {
        let session = self.session(owner, name).await?;
        session.refresh_status().await?;
        let state = session.state.lock().await;
        let requested = cursor.unwrap_or(state.base_offset);
        if requested > state.total_bytes {
            return Err(TerminalError::CursorAhead {
                cursor: requested,
                current: state.total_bytes,
            });
        }
        let truncated_before_cursor = requested < state.base_offset;
        let effective = requested.max(state.base_offset);
        let skip = usize::try_from(effective - state.base_offset).unwrap_or(usize::MAX);
        let content: Vec<u8> = state.buffer.iter().skip(skip).copied().collect();
        let result = TerminalRead {
            id: session.id.clone(),
            name: session.name.clone(),
            content: String::from_utf8_lossy(&content).into_owned(),
            cursor: state.total_bytes,
            truncated_before_cursor,
            running: state.running,
            exit_code: state.exit_code,
            exit_signal: state.exit_signal,
        };
        self.trace(owner, "read.completed", json!({"read": &result}))
            .await;
        Ok(result)
    }

    pub async fn signal(
        &self,
        owner: &str,
        name: &str,
        signal: TerminalSignal,
    ) -> Result<(), TerminalError> {
        let session = self.session(owner, name).await?;
        let result = session.signal(signal).await;
        self.trace(
            owner,
            "signal",
            json!({"name": name, "signal": signal, "ok": result.is_ok()}),
        )
        .await;
        result
    }

    pub async fn close(&self, owner: &str, name: &str) -> Result<TerminalRead, TerminalError> {
        let key = checked_key(owner, name)?;
        let session =
            self.sessions
                .lock()
                .await
                .remove(&key)
                .ok_or_else(|| TerminalError::NotFound {
                    name: name.to_owned(),
                })?;
        session.close(self.config.close_grace).await?;
        session.refresh_status().await?;
        let result = self.read_detached(&session, None).await;
        self.trace(
            owner,
            "close.completed",
            json!({"name": name, "result": result.as_ref().ok(), "error": result.as_ref().err().map(ToString::to_string)}),
        )
        .await;
        result
    }

    pub async fn list(&self, owner: &str) -> Result<Vec<TerminalDescriptor>, TerminalError> {
        validate_owner(owner)?;
        let sessions: Vec<Arc<TerminalSession>> = self
            .sessions
            .lock()
            .await
            .iter()
            .filter(|((candidate, _), _)| candidate == owner)
            .map(|(_, session)| Arc::clone(session))
            .collect();
        let mut descriptors = Vec::with_capacity(sessions.len());
        for session in sessions {
            session.refresh_status().await?;
            descriptors.push(session.descriptor().await?);
        }
        descriptors.sort_by(|left, right| left.name.cmp(&right.name));
        self.trace(owner, "list.completed", json!({"terminals": &descriptors}))
            .await;
        Ok(descriptors)
    }

    /// Close every persistent PTY and prevent later admission. Each session
    /// executes the same TERM -> grace -> KILL -> wait path as explicit close;
    /// failures are accumulated instead of silently detached from Host exit.
    pub async fn shutdown(&self) -> TerminalShutdownReport {
        self.closed.store(true, Ordering::Release);
        let keys = self
            .sessions
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut report = TerminalShutdownReport {
            sessions: keys.len(),
            ..TerminalShutdownReport::default()
        };
        for (owner, name) in keys {
            match self.close(&owner, &name).await {
                Ok(_) => report.closed += 1,
                Err(error) => report.errors.push(format!("{owner}/{name}: {error}")),
            }
        }
        report
    }

    async fn session(
        &self,
        owner: &str,
        name: &str,
    ) -> Result<Arc<TerminalSession>, TerminalError> {
        let key = checked_key(owner, name)?;
        self.sessions
            .lock()
            .await
            .get(&key)
            .cloned()
            .ok_or_else(|| TerminalError::NotFound {
                name: name.to_owned(),
            })
    }

    async fn read_detached(
        &self,
        session: &TerminalSession,
        cursor: Option<u64>,
    ) -> Result<TerminalRead, TerminalError> {
        let state = session.state.lock().await;
        let requested = cursor.unwrap_or(state.base_offset);
        let effective = requested.max(state.base_offset).min(state.total_bytes);
        let skip = usize::try_from(effective - state.base_offset).unwrap_or(usize::MAX);
        let content: Vec<u8> = state.buffer.iter().skip(skip).copied().collect();
        Ok(TerminalRead {
            id: session.id.clone(),
            name: session.name.clone(),
            content: String::from_utf8_lossy(&content).into_owned(),
            cursor: state.total_bytes,
            truncated_before_cursor: requested < state.base_offset,
            running: state.running,
            exit_code: state.exit_code,
            exit_signal: state.exit_signal,
        })
    }

    async fn trace(&self, owner: &str, event: &str, payload: serde_json::Value) {
        self.debug
            .record_lossy(
                DebugEvent::new("terminal", event, payload)
                    .with_scope(DebugScope::default().with_session(owner.to_owned())),
            )
            .await;
    }
}

struct TerminalSession {
    id: String,
    name: String,
    pid: u32,
    #[cfg(unix)]
    control_fd: Arc<OwnedFd>,
    #[cfg(unix)]
    writer: Mutex<tokio::fs::File>,
    #[cfg(unix)]
    child: Mutex<Child>,
    #[cfg(windows)]
    writer: Mutex<Box<dyn Write + Send>>,
    #[cfg(windows)]
    child: Mutex<ConPtyChild>,
    state: Arc<Mutex<Scrollback>>,
}

impl TerminalSession {
    async fn refresh_status(&self) -> Result<(), TerminalError> {
        #[cfg(unix)]
        let status = self
            .child
            .lock()
            .await
            .try_wait()
            .map_err(|source| terminal_io("inspect PTY child", source))?;
        #[cfg(windows)]
        let status = self
            .child
            .lock()
            .await
            .try_wait()
            .map_err(|source| terminal_io("inspect ConPTY child", io::Error::other(source)))?;
        if let Some(status) = status {
            let mut state = self.state.lock().await;
            state.running = false;
            state.exit_code = exit_code(&status);
            state.exit_signal = exit_signal(&status);
        }
        Ok(())
    }

    async fn descriptor(&self) -> Result<TerminalDescriptor, TerminalError> {
        self.refresh_status().await?;
        let state = self.state.lock().await;
        Ok(TerminalDescriptor {
            id: self.id.clone(),
            name: self.name.clone(),
            pid: self.pid,
            running: state.running,
            cursor: state.total_bytes,
        })
    }

    #[cfg(unix)]
    async fn write_input(&self, input: &[u8]) -> Result<(), TerminalError> {
        let mut writer = self.writer.lock().await;
        writer
            .write_all(input)
            .await
            .map_err(|source| terminal_io("write PTY input", source))?;
        writer
            .flush()
            .await
            .map_err(|source| terminal_io("flush PTY input", source))
    }

    #[cfg(windows)]
    async fn write_input(&self, input: &[u8]) -> Result<(), TerminalError> {
        let mut writer = self.writer.lock().await;
        writer
            .write_all(input)
            .map_err(|source| terminal_io("write ConPTY input", source))?;
        writer
            .flush()
            .map_err(|source| terminal_io("flush ConPTY input", source))
    }

    #[cfg(unix)]
    async fn signal(&self, signal: TerminalSignal) -> Result<(), TerminalError> {
        let group = tcgetpgrp(self.control_fd.as_ref()).or_else(|error| {
            if error == Errno::ENOTTY {
                i32::try_from(self.pid)
                    .map(Pid::from_raw)
                    .map_err(|_| Errno::EINVAL)
            } else {
                Err(error)
            }
        });
        let group = group.map_err(|error| {
            terminal_io(
                "resolve PTY foreground process group",
                io::Error::from_raw_os_error(error as i32),
            )
        })?;
        match killpg(group, signal.as_nix()) {
            Ok(()) | Err(Errno::ESRCH) => Ok(()),
            Err(error) => Err(terminal_io(
                "signal PTY foreground process group",
                io::Error::from_raw_os_error(error as i32),
            )),
        }
    }

    #[cfg(windows)]
    async fn signal(&self, signal: TerminalSignal) -> Result<(), TerminalError> {
        match signal {
            // ConPTY converts the terminal control character into the console
            // control event understood by interactive PowerShell and console
            // programs. It is preferable to force-killing the process tree.
            TerminalSignal::Interrupt => self.write_input(&[0x03]).await,
            TerminalSignal::Terminate | TerminalSignal::Kill | TerminalSignal::Hangup => self
                .child
                .lock()
                .await
                .terminate(if signal == TerminalSignal::Kill {
                    137
                } else {
                    143
                })
                .map_err(|source| {
                    terminal_io("terminate ConPTY process tree", io::Error::other(source))
                }),
            TerminalSignal::Suspend => Err(terminal_io(
                "suspend ConPTY process",
                io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Windows ConPTY does not support job-control suspension",
                ),
            )),
        }
    }

    #[cfg(unix)]
    async fn close(&self, grace: Duration) -> Result<(), TerminalError> {
        let _ = self.signal(TerminalSignal::Terminate).await;
        let mut child = self.child.lock().await;
        if time::timeout(grace, child.wait()).await.is_err() {
            let _ = self.signal(TerminalSignal::Kill).await;
            // The foreground command may have its own process group. Kill the
            // session leader as a final fallback so `close` cannot wait forever.
            let _ = child.start_kill();
            child
                .wait()
                .await
                .map_err(|source| terminal_io("wait after PTY kill", source))?;
        }
        Ok(())
    }

    #[cfg(windows)]
    async fn close(&self, grace: Duration) -> Result<(), TerminalError> {
        // Give an interactive shell a chance to handle Ctrl-C and unwind. If
        // it remains alive, close the entire Job boundary deterministically.
        let _ = self.signal(TerminalSignal::Interrupt).await;
        let deadline = time::Instant::now() + grace;
        loop {
            self.refresh_status().await?;
            if !self.state.lock().await.running {
                return Ok(());
            }
            if time::Instant::now() >= deadline {
                break;
            }
            time::sleep(Duration::from_millis(20)).await;
        }
        self.signal(TerminalSignal::Kill).await?;
        let settle_deadline = time::Instant::now() + Duration::from_secs(2);
        loop {
            self.refresh_status().await?;
            if !self.state.lock().await.running {
                return Ok(());
            }
            if time::Instant::now() >= settle_deadline {
                return Err(terminal_io(
                    "wait after ConPTY kill",
                    io::Error::new(io::ErrorKind::TimedOut, "ConPTY child did not settle"),
                ));
            }
            time::sleep(Duration::from_millis(20)).await;
        }
    }
}

struct Scrollback {
    buffer: VecDeque<u8>,
    base_offset: u64,
    total_bytes: u64,
    newline_count: usize,
    max_bytes: usize,
    max_lines: usize,
    running: bool,
    exit_code: Option<i32>,
    exit_signal: Option<i32>,
}

impl Scrollback {
    fn new(max_bytes: usize, max_lines: usize) -> Self {
        Self {
            buffer: VecDeque::with_capacity(max_bytes.min(64 * 1024)),
            base_offset: 0,
            total_bytes: 0,
            newline_count: 0,
            max_bytes,
            max_lines,
            running: true,
            exit_code: None,
            exit_signal: None,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.buffer.push_back(*byte);
            self.total_bytes = self.total_bytes.saturating_add(1);
            if *byte == b'\n' {
                self.newline_count = self.newline_count.saturating_add(1);
            }
            while self.buffer.len() > self.max_bytes || self.newline_count > self.max_lines {
                if let Some(removed) = self.buffer.pop_front() {
                    self.base_offset = self.base_offset.saturating_add(1);
                    if removed == b'\n' {
                        self.newline_count = self.newline_count.saturating_sub(1);
                    }
                }
            }
        }
    }
}

#[cfg(unix)]
fn spawn_session(
    spec: TerminalOpenSpec,
    config: &TerminalConfig,
    debug: DebugRecorder,
) -> Result<TerminalSession, TerminalError> {
    let pty = openpty(None, None)
        .map_err(|error| terminal_io("allocate PTY", io::Error::from_raw_os_error(error as i32)))?;
    let reader_fd = dup(&pty.master).map_err(|error| {
        terminal_io(
            "duplicate PTY reader",
            io::Error::from_raw_os_error(error as i32),
        )
    })?;
    let writer_fd = dup(&pty.master).map_err(|error| {
        terminal_io(
            "duplicate PTY writer",
            io::Error::from_raw_os_error(error as i32),
        )
    })?;
    let stdin_fd = dup(&pty.slave).map_err(|error| {
        terminal_io(
            "duplicate PTY stdin",
            io::Error::from_raw_os_error(error as i32),
        )
    })?;
    let stdout_fd = dup(&pty.slave).map_err(|error| {
        terminal_io(
            "duplicate PTY stdout",
            io::Error::from_raw_os_error(error as i32),
        )
    })?;

    let mut command = Command::new(&spec.process.program);
    command
        .args(&spec.process.args)
        .current_dir(&spec.process.cwd)
        .env_clear()
        .envs(&spec.process.env)
        .stdin(Stdio::from(File::from(stdin_fd)))
        .stdout(Stdio::from(File::from(stdout_fd)))
        .stderr(Stdio::from(File::from(pty.slave)))
        .kill_on_drop(true);
    // SAFETY: the closure performs only async-signal-safe syscalls and does
    // not allocate. Stdio has already been installed on descriptors 0/1/2.
    unsafe {
        command.pre_exec(|| {
            setsid().map_err(|error| io::Error::from_raw_os_error(error as i32))?;
            if libc::ioctl(libc::STDIN_FILENO, tiocsctty_request(), 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command
        .spawn()
        .map_err(|source| terminal_io("spawn PTY child", source))?;
    let pid = child.id().ok_or_else(|| {
        terminal_io(
            "read PTY child pid",
            io::Error::new(io::ErrorKind::NotFound, "child has no pid"),
        )
    })?;
    let state = Arc::new(Mutex::new(Scrollback::new(
        config.scrollback_bytes,
        config.scrollback_lines,
    )));
    let id = format!(
        "pty-{:016x}",
        NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed)
    );
    let trace_id = id.clone();
    let trace_name = spec.name.clone();
    let trace_owner = spec.owner.clone();
    let reader_state = Arc::clone(&state);
    tokio::spawn(async move {
        let mut reader = tokio::fs::File::from_std(File::from(reader_fd));
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(count) => {
                    debug
                        .record_lossy(
                            DebugEvent::new(
                                "terminal",
                                "output.chunk",
                                json!({
                                    "terminalId": &trace_id,
                                    "name": &trace_name,
                                    "bytes": count,
                                    "content": String::from_utf8_lossy(&buffer[..count]),
                                }),
                            )
                            .with_scope(DebugScope::default().with_session(trace_owner.clone())),
                        )
                        .await;
                    reader_state.lock().await.push(&buffer[..count]);
                }
                Err(_) => break,
            }
        }
    });

    Ok(TerminalSession {
        id,
        name: spec.name,
        pid,
        control_fd: Arc::new(pty.master),
        writer: Mutex::new(tokio::fs::File::from_std(File::from(writer_fd))),
        child: Mutex::new(child),
        state,
    })
}

#[cfg(windows)]
fn spawn_session(
    spec: TerminalOpenSpec,
    config: &TerminalConfig,
    debug: DebugRecorder,
) -> Result<TerminalSession, TerminalError> {
    let conpty = spawn_conpty(
        &spec.process.program,
        &spec.process.args,
        &spec.process.cwd,
        &spec.process.env,
        30,
        120,
    )
    .map_err(|source| terminal_io("spawn native ConPTY child", io::Error::other(source)))?;
    let pid = conpty.child.pid();
    let mut reader = conpty.reader;
    let state = Arc::new(Mutex::new(Scrollback::new(
        config.scrollback_bytes,
        config.scrollback_lines,
    )));
    let id = format!(
        "conpty-{:016x}",
        NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed)
    );
    let trace_id = id.clone();
    let trace_name = spec.name.clone();
    let trace_owner = spec.owner.clone();
    let reader_state = Arc::clone(&state);
    let (output_tx, mut output_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
    tokio::spawn(async move {
        while let Some(chunk) = output_rx.recv().await {
            debug
                .record_lossy(
                    DebugEvent::new(
                        "terminal",
                        "output.chunk",
                        json!({
                            "terminalId": &trace_id,
                            "name": &trace_name,
                            "bytes": chunk.len(),
                            "content": String::from_utf8_lossy(&chunk),
                        }),
                    )
                    .with_scope(DebugScope::default().with_session(trace_owner.clone())),
                )
                .await;
            reader_state.lock().await.push(&chunk);
        }
    });
    std::thread::Builder::new()
        .name(format!("xharness-{id}-reader"))
        .spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        if output_tx.blocking_send(buffer[..count].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        })
        .map_err(|source| terminal_io("spawn ConPTY output reader", source))?;

    Ok(TerminalSession {
        id,
        name: spec.name,
        pid,
        writer: Mutex::new(Box::new(conpty.writer)),
        child: Mutex::new(conpty.child),
        state,
    })
}

#[cfg(unix)]
fn exit_code(status: &std::process::ExitStatus) -> Option<i32> {
    status.code()
}

#[cfg(windows)]
fn exit_code(status: &u32) -> Option<i32> {
    i32::try_from(*status).ok()
}

#[cfg(unix)]
fn exit_signal(status: &std::process::ExitStatus) -> Option<i32> {
    status.signal()
}

#[cfg(windows)]
fn exit_signal(_status: &u32) -> Option<i32> {
    None
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
const fn tiocsctty_request() -> libc::c_ulong {
    libc::TIOCSCTTY
}

#[cfg(all(target_os = "linux", target_env = "musl"))]
const fn tiocsctty_request() -> libc::c_int {
    libc::TIOCSCTTY
}

#[cfg(target_os = "macos")]
const fn tiocsctty_request() -> libc::c_ulong {
    libc::TIOCSCTTY as libc::c_ulong
}

fn checked_key(owner: &str, name: &str) -> Result<(String, String), TerminalError> {
    validate_owner(owner)?;
    validate_name(name)?;
    Ok((owner.to_owned(), name.to_owned()))
}

fn validate_owner(owner: &str) -> Result<(), TerminalError> {
    if owner.is_empty() || owner.as_bytes().contains(&0) {
        Err(TerminalError::InvalidOwner)
    } else {
        Ok(())
    }
}

fn validate_name(name: &str) -> Result<(), TerminalError> {
    if name.is_empty()
        || name.len() > MAX_NAME_BYTES
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        Err(TerminalError::InvalidName)
    } else {
        Ok(())
    }
}

fn terminal_io(operation: &'static str, source: io::Error) -> TerminalError {
    TerminalError::Io { operation, source }
}

impl Default for TerminalRegistry {
    fn default() -> Self {
        Self::with_defaults()
    }
}

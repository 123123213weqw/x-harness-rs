//! Owner-scoped persistent PTY sessions for macOS and Linux.
//!
//! Sessions use a real controlling terminal. Output is retained in a bounded
//! byte/line scrollback with monotonic cursors; callers never infer process
//! exit from a quiet period. Signals target the terminal's foreground process
//! group when available.

use std::{
    collections::{HashMap, VecDeque},
    fs::File,
    io,
    os::fd::OwnedFd,
    os::unix::process::ExitStatusExt,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use nix::{
    errno::Errno,
    libc,
    pty::openpty,
    sys::signal::{killpg, Signal},
    unistd::{dup, setsid, tcgetpgrp, Pid},
};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    sync::Mutex,
    time,
};
use xharness_process::SpawnSpec;

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
    #[error("terminal operation {operation} failed: {source}")]
    Io {
        operation: &'static str,
        #[source]
        source: io::Error,
    },
}

#[derive(Clone)]
pub struct TerminalRegistry {
    config: TerminalConfig,
    sessions: Arc<Mutex<SessionMap>>,
}

impl TerminalRegistry {
    pub fn new(config: TerminalConfig) -> Result<Self, TerminalError> {
        config.validate()?;
        Ok(Self {
            config,
            sessions: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn with_defaults() -> Self {
        Self::new(TerminalConfig::default()).expect("default terminal config is valid")
    }

    pub async fn open(&self, spec: TerminalOpenSpec) -> Result<TerminalDescriptor, TerminalError> {
        validate_owner(&spec.owner)?;
        validate_name(&spec.name)?;
        if spec.process.program.is_empty() {
            return Err(TerminalError::EmptyProgram);
        }

        let key = (spec.owner.clone(), spec.name.clone());
        let mut sessions = self.sessions.lock().await;
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

        let session = Arc::new(spawn_session(spec, &self.config)?);
        let descriptor = session.descriptor().await?;
        sessions.insert(key, session);
        Ok(descriptor)
    }

    pub async fn send(&self, owner: &str, name: &str, input: &[u8]) -> Result<u64, TerminalError> {
        let session = self.session(owner, name).await?;
        session.refresh_status().await?;
        if !session.state.lock().await.running {
            return Err(TerminalError::Exited {
                name: name.to_owned(),
            });
        }
        let mut writer = session.writer.lock().await;
        writer
            .write_all(input)
            .await
            .map_err(|source| terminal_io("write PTY input", source))?;
        writer
            .flush()
            .await
            .map_err(|source| terminal_io("flush PTY input", source))?;
        let cursor = session.state.lock().await.total_bytes;
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
        Ok(TerminalRead {
            id: session.id.clone(),
            name: session.name.clone(),
            content: String::from_utf8_lossy(&content).into_owned(),
            cursor: state.total_bytes,
            truncated_before_cursor,
            running: state.running,
            exit_code: state.exit_code,
            exit_signal: state.exit_signal,
        })
    }

    pub async fn signal(
        &self,
        owner: &str,
        name: &str,
        signal: TerminalSignal,
    ) -> Result<(), TerminalError> {
        let session = self.session(owner, name).await?;
        session.signal(signal)
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
        let _ = session.signal(TerminalSignal::Terminate);
        let mut child = session.child.lock().await;
        if time::timeout(self.config.close_grace, child.wait())
            .await
            .is_err()
        {
            let _ = session.signal(TerminalSignal::Kill);
            // The foreground command may have its own process group. Kill the
            // session leader as a final fallback so `close` cannot wait forever
            // after only terminating that foreground group.
            let _ = child.start_kill();
            child
                .wait()
                .await
                .map_err(|source| terminal_io("wait after PTY kill", source))?;
        }
        drop(child);
        session.refresh_status().await?;
        self.read_detached(&session, None).await
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
        Ok(descriptors)
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
}

struct TerminalSession {
    id: String,
    name: String,
    pid: u32,
    control_fd: Arc<OwnedFd>,
    writer: Mutex<tokio::fs::File>,
    child: Mutex<Child>,
    state: Arc<Mutex<Scrollback>>,
}

impl TerminalSession {
    async fn refresh_status(&self) -> Result<(), TerminalError> {
        let status = self
            .child
            .lock()
            .await
            .try_wait()
            .map_err(|source| terminal_io("inspect PTY child", source))?;
        if let Some(status) = status {
            let mut state = self.state.lock().await;
            state.running = false;
            state.exit_code = status.code();
            state.exit_signal = status.signal();
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

    fn signal(&self, signal: TerminalSignal) -> Result<(), TerminalError> {
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

fn spawn_session(
    spec: TerminalOpenSpec,
    config: &TerminalConfig,
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
    let reader_state = Arc::clone(&state);
    tokio::spawn(async move {
        let mut reader = tokio::fs::File::from_std(File::from(reader_fd));
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) => break,
                Ok(count) => reader_state.lock().await.push(&buffer[..count]),
                Err(_) => break,
            }
        }
    });

    Ok(TerminalSession {
        id: format!(
            "pty-{:016x}",
            NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed)
        ),
        name: spec.name,
        pid,
        control_fd: Arc::new(pty.master),
        writer: Mutex::new(tokio::fs::File::from_std(File::from(writer_fd))),
        child: Mutex::new(child),
        state,
    })
}

#[cfg(target_os = "linux")]
const fn tiocsctty_request() -> libc::c_ulong {
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

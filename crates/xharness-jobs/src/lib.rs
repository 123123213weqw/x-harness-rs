//! Producer-neutral background jobs for XHarness.
//!
//! The registry owns admission, ids, session isolation, lifecycle state,
//! bounded unread output and shutdown. A producer owns the actual resource and
//! receives a [`JobLease`] after registration. Model-facing tools are kept in
//! `xharness-coding-tools`; this crate intentionally knows nothing about Bash,
//! PTYs, subagents or providers.

use std::{
    collections::{BTreeMap, VecDeque},
    fmt,
    sync::{Arc, Mutex, Weak},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tokio::sync::{broadcast, watch};

pub const DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER: usize = 10;
pub const DEFAULT_OUTPUT_LIMIT_BYTES: usize = 256 * 1024;
pub const DEFAULT_MAX_RETAINED_JOBS_PER_OWNER: usize = 100;

/// Producer cancellation must be synchronous, idempotent and eventually make
/// the producer settle its lease. A throw-equivalent error leaves registry
/// state unchanged so callers can retry or report the producer fault.
pub type JobCancel = Arc<dyn Fn(Option<&str>) -> Result<(), String> + Send + Sync + 'static>;

#[derive(Clone, Debug)]
pub struct JobRegistryConfig {
    pub max_concurrent_jobs_per_owner: usize,
    pub default_output_limit_bytes: usize,
    pub max_retained_jobs_per_owner: usize,
    pub event_capacity: usize,
}

impl Default for JobRegistryConfig {
    fn default() -> Self {
        Self {
            max_concurrent_jobs_per_owner: DEFAULT_MAX_CONCURRENT_JOBS_PER_OWNER,
            default_output_limit_bytes: DEFAULT_OUTPUT_LIMIT_BYTES,
            max_retained_jobs_per_owner: DEFAULT_MAX_RETAINED_JOBS_PER_OWNER,
            event_capacity: 256,
        }
    }
}

#[derive(Clone, Copy, Debug, thiserror::Error, PartialEq, Eq)]
pub enum JobConfigError {
    #[error("max_concurrent_jobs_per_owner must be greater than zero")]
    InvalidConcurrentLimit,
    #[error("default_output_limit_bytes must be greater than zero")]
    InvalidOutputLimit,
    #[error("max_retained_jobs_per_owner must be greater than zero")]
    InvalidRetentionLimit,
    #[error("event_capacity must be greater than zero")]
    InvalidEventCapacity,
}

impl JobRegistryConfig {
    pub fn validate(&self) -> Result<(), JobConfigError> {
        if self.max_concurrent_jobs_per_owner == 0 {
            return Err(JobConfigError::InvalidConcurrentLimit);
        }
        if self.default_output_limit_bytes == 0 {
            return Err(JobConfigError::InvalidOutputLimit);
        }
        if self.max_retained_jobs_per_owner == 0 {
            return Err(JobConfigError::InvalidRetentionLimit);
        }
        if self.event_capacity == 0 {
            return Err(JobConfigError::InvalidEventCapacity);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct JobId(String);

impl JobId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for JobId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Running,
    Stopping,
    Completed,
    Killed,
    Failed,
}

impl JobStatus {
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Killed | Self::Failed)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobOutcome {
    pub status: TerminalJobStatus,
    pub detail: Option<String>,
}

impl JobOutcome {
    pub fn completed(detail: impl Into<String>) -> Self {
        Self {
            status: TerminalJobStatus::Completed,
            detail: Some(detail.into()),
        }
    }

    pub fn killed(detail: impl Into<String>) -> Self {
        Self {
            status: TerminalJobStatus::Killed,
            detail: Some(detail.into()),
        }
    }

    pub fn failed(detail: impl Into<String>) -> Self {
        Self {
            status: TerminalJobStatus::Failed,
            detail: Some(detail.into()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalJobStatus {
    Completed,
    Killed,
    Failed,
}

impl From<TerminalJobStatus> for JobStatus {
    fn from(value: TerminalJobStatus) -> Self {
        match value {
            TerminalJobStatus::Completed => Self::Completed,
            TerminalJobStatus::Killed => Self::Killed,
            TerminalJobStatus::Failed => Self::Failed,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct JobSnapshot {
    pub id: JobId,
    pub kind: String,
    pub label: String,
    pub owner: String,
    pub status: JobStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub output_limit_bytes: usize,
    pub started_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at_ms: Option<u64>,
    pub reported: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct JobRead {
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub snapshot: JobSnapshot,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KillResult {
    Requested,
    AlreadyFinished,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobEventKind {
    Started,
    Stopping,
    Finished,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct JobEvent {
    pub kind: JobEventKind,
    pub job: JobSnapshot,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct JobShutdownReport {
    pub jobs: usize,
    pub cancellation_failures: usize,
    pub timed_out: usize,
}

impl JobShutdownReport {
    pub const fn is_graceful(&self) -> bool {
        self.cancellation_failures == 0 && self.timed_out == 0
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum JobError {
    #[error("job owner must not be empty")]
    EmptyOwner,
    #[error("job kind must not be empty")]
    EmptyKind,
    #[error("job label must not be empty")]
    EmptyLabel,
    #[error("job output limit must be greater than zero")]
    InvalidOutputLimit,
    #[error("background job registry is shutting down")]
    ShuttingDown,
    #[error(
        "background job limit reached for this owner (limit: {limit}); use job_kill to stop an unneeded job, wait for it to finish, then retry"
    )]
    Capacity { limit: usize },
    #[error("job reservation is no longer valid")]
    ReservationExpired,
    #[error("unknown job {id}")]
    NotFound { id: String },
    #[error("job {id} cancellation failed: {message}")]
    CancelFailed { id: String, message: String },
    #[error("job wait timeout must be greater than zero")]
    InvalidWaitTimeout,
}

#[derive(Clone)]
pub struct JobRegistry {
    inner: Arc<RegistryInner>,
}

struct RegistryInner {
    config: JobRegistryConfig,
    state: Mutex<RegistryState>,
    events: broadcast::Sender<JobEvent>,
}

struct RegistryState {
    accepting: bool,
    next_reservation: u64,
    reservations: BTreeMap<u64, String>,
    counters: BTreeMap<String, u64>,
    jobs: BTreeMap<JobId, Arc<JobEntry>>,
    order: VecDeque<JobId>,
}

struct JobEntry {
    id: JobId,
    kind: String,
    label: String,
    owner: String,
    pid: Option<u32>,
    output_limit_bytes: usize,
    started_at_ms: u64,
    cancel: JobCancel,
    state: Mutex<EntryState>,
    changed: watch::Sender<u64>,
    events: broadcast::Sender<JobEvent>,
}

struct EntryState {
    status: JobStatus,
    detail: Option<String>,
    finished_at_ms: Option<u64>,
    reported: bool,
    revision: u64,
    stdout: OutputBuffer,
    stderr: OutputBuffer,
}

struct OutputBuffer {
    bytes: Vec<u8>,
    dropped: u64,
    limit: usize,
}

impl OutputBuffer {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(limit.min(8192)),
            dropped: 0,
            limit,
        }
    }

    fn append(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() > self.limit {
            let overflow = self.bytes.len() - self.limit;
            self.bytes.drain(..overflow);
            self.dropped = self.dropped.saturating_add(overflow as u64);
        }
    }

    fn take(&mut self) -> (String, bool) {
        let complete_len = incomplete_utf8_tail_start(&self.bytes).unwrap_or(self.bytes.len());
        let complete = self.bytes.drain(..complete_len).collect::<Vec<_>>();
        let text = String::from_utf8_lossy(&complete).into_owned();
        let truncated = self.dropped > 0;
        self.dropped = 0;
        (text, truncated)
    }
}

impl JobRegistry {
    /// Construct from trusted static configuration.
    ///
    /// Dynamic/user-authored configuration should call [`Self::try_new`] so
    /// invalid zero limits become a typed error instead of a startup panic.
    pub fn new(config: JobRegistryConfig) -> Self {
        Self::try_new(config).expect("invalid JobRegistryConfig")
    }

    pub fn try_new(config: JobRegistryConfig) -> Result<Self, JobConfigError> {
        config.validate()?;
        let (events, _) = broadcast::channel(config.event_capacity);
        Ok(Self {
            inner: Arc::new(RegistryInner {
                config,
                state: Mutex::new(RegistryState {
                    accepting: true,
                    next_reservation: 1,
                    reservations: BTreeMap::new(),
                    counters: BTreeMap::new(),
                    jobs: BTreeMap::new(),
                    order: VecDeque::new(),
                }),
                events,
            }),
        })
    }

    pub fn with_defaults() -> Self {
        Self::new(JobRegistryConfig::default())
    }

    /// Reserve one owner capacity slot before a producer allocates resources.
    /// Dropping the returned value rolls the reservation back without consuming
    /// a public job id.
    pub fn reserve(
        &self,
        owner: impl Into<String>,
        kind: impl Into<String>,
        label: impl Into<String>,
        output_limit_bytes: Option<usize>,
    ) -> Result<JobReservation, JobError> {
        let owner = owner.into();
        let kind = kind.into();
        let label = label.into();
        if owner.trim().is_empty() {
            return Err(JobError::EmptyOwner);
        }
        if kind.trim().is_empty() {
            return Err(JobError::EmptyKind);
        }
        if label.trim().is_empty() {
            return Err(JobError::EmptyLabel);
        }
        let output_limit_bytes =
            output_limit_bytes.unwrap_or(self.inner.config.default_output_limit_bytes);
        if output_limit_bytes == 0 {
            return Err(JobError::InvalidOutputLimit);
        }

        let token = {
            let mut state = self.inner.state.lock().expect("job registry lock poisoned");
            if !state.accepting {
                return Err(JobError::ShuttingDown);
            }
            let active = state
                .jobs
                .values()
                .filter(|job| {
                    job.owner == owner
                        && !job
                            .state
                            .lock()
                            .expect("job entry lock poisoned")
                            .status
                            .is_terminal()
                })
                .count();
            let reserved = state
                .reservations
                .values()
                .filter(|reserved_owner| **reserved_owner == owner)
                .count();
            if active.saturating_add(reserved) >= self.inner.config.max_concurrent_jobs_per_owner {
                return Err(JobError::Capacity {
                    limit: self.inner.config.max_concurrent_jobs_per_owner,
                });
            }
            let token = state.next_reservation;
            state.next_reservation = state.next_reservation.saturating_add(1);
            state.reservations.insert(token, owner.clone());
            token
        };

        Ok(JobReservation {
            registry: Arc::downgrade(&self.inner),
            token,
            owner,
            kind,
            label,
            output_limit_bytes,
            active: true,
        })
    }

    pub fn list(&self, owner: &str) -> Vec<JobSnapshot> {
        let state = self.inner.state.lock().expect("job registry lock poisoned");
        state
            .order
            .iter()
            .filter_map(|id| state.jobs.get(id))
            .filter(|job| job.owner == owner)
            .map(|job| job.snapshot())
            .collect()
    }

    pub fn get(&self, owner: &str, id: &str) -> Result<JobSnapshot, JobError> {
        Ok(self.expect_owned(owner, id)?.snapshot())
    }

    /// Consume output published since the previous model-facing read.
    pub fn read(&self, owner: &str, id: &str) -> Result<JobRead, JobError> {
        let job = self.expect_owned(owner, id)?;
        let mut state = job.state.lock().expect("job entry lock poisoned");
        let (stdout, stdout_truncated) = state.stdout.take();
        let (stderr, stderr_truncated) = state.stderr.take();
        if state.status.is_terminal() {
            state.reported = true;
        }
        let snapshot = job.snapshot_with(&state);
        Ok(JobRead {
            stdout,
            stderr,
            stdout_truncated,
            stderr_truncated,
            snapshot,
        })
    }

    /// Wait only for terminal settlement. A timeout is a successful live
    /// snapshot and never cancels the job.
    pub async fn wait(
        &self,
        owner: &str,
        id: &str,
        timeout: Duration,
    ) -> Result<JobSnapshot, JobError> {
        if timeout.is_zero() {
            return Err(JobError::InvalidWaitTimeout);
        }
        let job = self.expect_owned(owner, id)?;
        let mut changed = job.changed.subscribe();
        let settled = async {
            loop {
                if job.snapshot().status.is_terminal() {
                    return;
                }
                if changed.changed().await.is_err() {
                    return;
                }
            }
        };
        let _ = tokio::time::timeout(timeout, settled).await;
        let mut state = job.state.lock().expect("job entry lock poisoned");
        if state.status.is_terminal() {
            state.reported = true;
        }
        Ok(job.snapshot_with(&state))
    }

    /// Request cancellation. The producer hook runs before the state change;
    /// a hook error therefore leaves `running`/`reported` untouched.
    pub fn kill(
        &self,
        owner: &str,
        id: &str,
        reason: Option<&str>,
    ) -> Result<KillResult, JobError> {
        let job = self.expect_owned(owner, id)?;
        {
            let mut state = job.state.lock().expect("job entry lock poisoned");
            if state.status.is_terminal() {
                state.reported = true;
                return Ok(KillResult::AlreadyFinished);
            }
        }
        (job.cancel)(reason).map_err(|message| JobError::CancelFailed {
            id: id.to_owned(),
            message,
        })?;
        let snapshot = {
            let mut state = job.state.lock().expect("job entry lock poisoned");
            if state.status.is_terminal() {
                state.reported = true;
                return Ok(KillResult::AlreadyFinished);
            }
            state.status = JobStatus::Stopping;
            state.reported = true;
            job.bump_locked(&mut state);
            job.snapshot_with(&state)
        };
        let _ = self.inner.events.send(JobEvent {
            kind: JobEventKind::Stopping,
            job: snapshot,
        });
        Ok(KillResult::Requested)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<JobEvent> {
        self.inner.events.subscribe()
    }

    pub async fn shutdown(&self, grace: Duration) -> JobShutdownReport {
        let jobs = {
            let mut state = self.inner.state.lock().expect("job registry lock poisoned");
            state.accepting = false;
            state.reservations.clear();
            state.jobs.values().cloned().collect::<Vec<_>>()
        };
        let mut report = JobShutdownReport {
            jobs: jobs.len(),
            ..JobShutdownReport::default()
        };
        for job in &jobs {
            if job.snapshot().status.is_terminal() {
                continue;
            }
            match (job.cancel)(Some("job registry shutdown")) {
                Ok(()) => job.mark_stopping_and_reported(),
                Err(message) => {
                    report.cancellation_failures += 1;
                    job.settle(JobOutcome::failed(format!(
                        "shutdown cancellation failed; producer may be orphaned: {message}"
                    )));
                }
            }
        }

        let deadline = tokio::time::Instant::now() + grace;
        for job in &jobs {
            if job.snapshot().status.is_terminal() {
                continue;
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() || wait_entry(job, remaining).await.is_err() {
                report.timed_out += 1;
                job.settle(JobOutcome::failed(
                    "shutdown timed out; producer may still be running",
                ));
            }
        }
        report
    }

    fn expect_owned(&self, owner: &str, id: &str) -> Result<Arc<JobEntry>, JobError> {
        let key = JobId(id.to_owned());
        let state = self.inner.state.lock().expect("job registry lock poisoned");
        let Some(job) = state.jobs.get(&key) else {
            return Err(JobError::NotFound { id: id.to_owned() });
        };
        // Predictable ids must not disclose whether another session owns one.
        if job.owner != owner {
            return Err(JobError::NotFound { id: id.to_owned() });
        }
        Ok(Arc::clone(job))
    }
}

impl Default for JobRegistry {
    fn default() -> Self {
        Self::with_defaults()
    }
}

pub struct JobReservation {
    registry: Weak<RegistryInner>,
    token: u64,
    owner: String,
    kind: String,
    label: String,
    output_limit_bytes: usize,
    active: bool,
}

impl JobReservation {
    /// Atomically publish a started producer. If this returns an error, the
    /// caller still owns and must cancel the producer resource.
    pub fn commit(
        mut self,
        pid: Option<u32>,
        cancel: JobCancel,
    ) -> Result<(JobId, JobLease), JobError> {
        let Some(registry) = self.registry.upgrade() else {
            return Err(JobError::ReservationExpired);
        };
        let (id, entry) = {
            let mut state = registry.state.lock().expect("job registry lock poisoned");
            if !state.accepting {
                return Err(JobError::ShuttingDown);
            }
            if state.reservations.remove(&self.token).as_deref() != Some(self.owner.as_str()) {
                return Err(JobError::ReservationExpired);
            }
            self.active = false;
            prune_history(
                &mut state,
                &self.owner,
                registry.config.max_retained_jobs_per_owner,
            );
            let count = state.counters.entry(self.kind.clone()).or_default();
            *count = count.saturating_add(1);
            let id = JobId(format!("{}-{}", self.kind, *count));
            let (changed, _) = watch::channel(0);
            let entry = Arc::new(JobEntry {
                id: id.clone(),
                kind: self.kind.clone(),
                label: self.label.clone(),
                owner: self.owner.clone(),
                pid,
                output_limit_bytes: self.output_limit_bytes,
                started_at_ms: now_ms(),
                cancel,
                state: Mutex::new(EntryState {
                    status: JobStatus::Running,
                    detail: None,
                    finished_at_ms: None,
                    reported: false,
                    revision: 0,
                    stdout: OutputBuffer::new(self.output_limit_bytes),
                    stderr: OutputBuffer::new(self.output_limit_bytes),
                }),
                changed,
                events: registry.events.clone(),
            });
            state.jobs.insert(id.clone(), Arc::clone(&entry));
            state.order.push_back(id.clone());
            (id, entry)
        };
        let snapshot = entry.snapshot();
        let _ = registry.events.send(JobEvent {
            kind: JobEventKind::Started,
            job: snapshot,
        });
        Ok((
            id,
            JobLease {
                entry: Some(entry),
                settled: false,
            },
        ))
    }
}

impl Drop for JobReservation {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        if let Some(registry) = self.registry.upgrade() {
            registry
                .state
                .lock()
                .expect("job registry lock poisoned")
                .reservations
                .remove(&self.token);
        }
    }
}

/// Producer-facing half of one registered job. Dropping it without settlement
/// force-fails the record so `job_output(wait=true)` and shutdown cannot hang.
pub struct JobLease {
    entry: Option<Arc<JobEntry>>,
    settled: bool,
}

impl JobLease {
    pub fn id(&self) -> &JobId {
        &self.entry.as_ref().expect("job lease entry missing").id
    }

    pub fn publish_stdout(&self, chunk: impl AsRef<[u8]>) {
        self.entry
            .as_ref()
            .expect("job lease entry missing")
            .append(true, chunk.as_ref());
    }

    pub fn publish_stderr(&self, chunk: impl AsRef<[u8]>) {
        self.entry
            .as_ref()
            .expect("job lease entry missing")
            .append(false, chunk.as_ref());
    }

    pub fn finish(mut self, outcome: JobOutcome) {
        if let Some(entry) = &self.entry {
            entry.settle(outcome);
        }
        self.settled = true;
    }
}

impl Drop for JobLease {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        if let Some(entry) = &self.entry {
            entry.settle(JobOutcome::failed(
                "job producer stopped before publishing a terminal outcome",
            ));
        }
    }
}

impl JobEntry {
    fn append(&self, stdout: bool, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        let mut state = self.state.lock().expect("job entry lock poisoned");
        if stdout {
            state.stdout.append(chunk);
        } else {
            state.stderr.append(chunk);
        }
        self.bump_locked(&mut state);
    }

    fn settle(&self, outcome: JobOutcome) -> bool {
        let snapshot = {
            let mut state = self.state.lock().expect("job entry lock poisoned");
            if state.status.is_terminal() {
                return false;
            }
            state.status = outcome.status.into();
            state.detail = outcome.detail;
            state.finished_at_ms = Some(now_ms());
            self.bump_locked(&mut state);
            self.snapshot_with(&state)
        };
        let _ = self.events.send(JobEvent {
            kind: JobEventKind::Finished,
            job: snapshot,
        });
        true
    }

    fn mark_stopping_and_reported(&self) {
        let snapshot = {
            let mut state = self.state.lock().expect("job entry lock poisoned");
            if state.status.is_terminal() {
                return;
            }
            state.status = JobStatus::Stopping;
            state.reported = true;
            self.bump_locked(&mut state);
            self.snapshot_with(&state)
        };
        let _ = self.events.send(JobEvent {
            kind: JobEventKind::Stopping,
            job: snapshot,
        });
    }

    fn bump_locked(&self, state: &mut EntryState) {
        state.revision = state.revision.saturating_add(1);
        self.changed.send_replace(state.revision);
    }

    fn snapshot(&self) -> JobSnapshot {
        let state = self.state.lock().expect("job entry lock poisoned");
        self.snapshot_with(&state)
    }

    fn snapshot_with(&self, state: &EntryState) -> JobSnapshot {
        JobSnapshot {
            id: self.id.clone(),
            kind: self.kind.clone(),
            label: self.label.clone(),
            owner: self.owner.clone(),
            status: state.status,
            detail: state.detail.clone(),
            pid: self.pid,
            output_limit_bytes: self.output_limit_bytes,
            started_at_ms: self.started_at_ms,
            finished_at_ms: state.finished_at_ms,
            reported: state.reported,
        }
    }
}

async fn wait_entry(job: &Arc<JobEntry>, timeout: Duration) -> Result<(), ()> {
    let mut changed = job.changed.subscribe();
    tokio::time::timeout(timeout, async {
        loop {
            if job.snapshot().status.is_terminal() {
                return;
            }
            if changed.changed().await.is_err() {
                return;
            }
        }
    })
    .await
    .map_err(|_| ())
}

fn prune_history(state: &mut RegistryState, owner: &str, max_retained: usize) {
    while state.jobs.values().filter(|job| job.owner == owner).count() >= max_retained {
        let removable = state.order.iter().find_map(|id| {
            let job = state.jobs.get(id)?;
            (job.owner == owner && job.snapshot().status.is_terminal()).then(|| id.clone())
        });
        let Some(id) = removable else {
            break;
        };
        state.jobs.remove(&id);
        state.order.retain(|candidate| candidate != &id);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn incomplete_utf8_tail_start(bytes: &[u8]) -> Option<usize> {
    let mut continuation_start = bytes.len();
    while continuation_start > 0 && bytes[continuation_start - 1] & 0b1100_0000 == 0b1000_0000 {
        continuation_start -= 1;
    }
    if continuation_start == bytes.len() {
        let lead = bytes.len().checked_sub(1)?;
        return utf8_width(bytes[lead])
            .filter(|width| *width > 1)
            .map(|_| lead);
    }
    let lead = continuation_start.checked_sub(1)?;
    let width = utf8_width(bytes[lead])?;
    (bytes.len() - lead < width).then_some(lead)
}

const fn utf8_width(byte: u8) -> Option<usize> {
    match byte {
        0x00..=0x7f => Some(1),
        0xc2..=0xdf => Some(2),
        0xe0..=0xef => Some(3),
        0xf0..=0xf4 => Some(4),
        _ => None,
    }
}

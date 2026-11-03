//! Opt-in Linux native build port. Owner-supplied capabilities only; no browser
//! command/root/SSH endpoint, task migration or network-write RPC is exposed.
#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::let_underscore_must_use,
    unused_must_use
)]
#![cfg_attr(
    not(test),
    forbid(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::let_underscore_must_use,
        unused_must_use
    )
)]
use crate::workspace_executor::{ExecutorError, PinnedWorkspaceSnapshot};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use xharness_cloud::{
    workspace_profile::{BuildCheckpoint, ExecutionLocation, WorkspaceProfile},
    workspace_sync::{classify_capture_path, CapturePathClass},
    CloudError, Counter, Id,
};
use xharness_fs::{
    workspace_apply::{ApplyError, SyncLease},
    FsService,
};
use xharness_platform::{NativePlatform, PlatformConfig, PlatformError};
use xharness_process::{ProcessError, ProcessOutput, SpawnSpec};

#[derive(Debug)]
pub enum BuildError {
    Invalid,
    Interrupted,
    Unsupported,
    OutcomeUnknown,
    Busy,
    Limit,
    Native(ApplyError),
    Snapshot(ExecutorError),
    Domain(CloudError),
    Encoding(serde_json::Error),
    Platform(PlatformError),
    Process(ProcessError),
}
impl std::fmt::Display for BuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("native remote workspace build failed")
    }
}
impl std::error::Error for BuildError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Native(e) => Some(e),
            Self::Snapshot(e) => Some(e),
            Self::Domain(e) => Some(e),
            Self::Encoding(e) => Some(e),
            Self::Platform(e) => Some(e),
            Self::Process(e) => Some(e),
            _ => None,
        }
    }
}
macro_rules! conversion {
    ($source:ty,$variant:ident) => {
        impl From<$source> for BuildError {
            fn from(e: $source) -> Self {
                Self::$variant(e)
            }
        }
    };
}
conversion!(ApplyError, Native);
conversion!(ExecutorError, Snapshot);
conversion!(CloudError, Domain);
conversion!(serde_json::Error, Encoding);
conversion!(PlatformError, Platform);
conversion!(ProcessError, Process);

/// No Debug/Serialize. Program/argv/env/toolchain roots are native owner config,
/// not parameters reconstructed from untrusted profile or job metadata.
pub struct NativeBuildCommand {
    pub spec: SpawnSpec,
    pub read_only_roots: Vec<PathBuf>,
    pub artifacts: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Registration {
    version: u8,
    root: String,
    cache: String,
    environment: Id,
    epoch: Counter,
    profile: WorkspaceProfile,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    registration: Registration,
    job: Id,
    checkpoint: BuildCheckpoint,
    command: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildArtifact {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    exact: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildReceipt {
    pub job: Id,
    pub environment: Id,
    pub epoch: Counter,
    pub checkpoint: BuildCheckpoint,
    pub success: bool,
    pub exit_code: Option<i32>,
    pub termination: String,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub artifacts: Vec<BuildArtifact>,
    command: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuildStep {
    Intent,
    ResultStored,
}
/// A failure after intent is durable is unknown unless inspect finds a complete
/// receipt. Retrying run never starts a second process, even after client loss.
pub struct RemoteBuildRunner {
    store: FsService,
    cache: FsService,
    registration: Registration,
}
fn key(job: &Id, suffix: &str) -> String {
    format!("job-{:x}-{suffix}", Sha256::digest(job.as_str().as_bytes()))
}
impl RemoteBuildRunner {
    pub fn provision(
        store: FsService,
        cache: FsService,
        environment: Id,
        epoch: Counter,
    ) -> Result<Self, BuildError> {
        let runner = Self::configured(store, cache, environment, epoch)?;
        let lease = runner.store.sync_lease()?;
        if lease.entry_count(1)? != 0 {
            return Err(BuildError::Invalid);
        }
        lease.write_record("build-active", b"idle\n")?;
        lease.put_record_once("profile", &serde_json::to_vec(&runner.registration)?)?;
        Ok(runner)
    }
    fn configured(
        store: FsService,
        cache: FsService,
        environment: Id,
        epoch: Counter,
    ) -> Result<Self, BuildError> {
        if !cfg!(target_os = "linux") {
            return Err(BuildError::Unsupported);
        }
        if epoch.0 == 0 || overlaps(store.workspace_root(), cache.workspace_root()) {
            return Err(BuildError::Invalid);
        }
        let lease = store.sync_lease()?;
        lease.validate_private_root()?;
        let cache_lease = cache.sync_lease()?;
        cache_lease.validate_private_root()?;
        let registration = Registration {
            version: 1,
            root: lease.root_identity()?,
            cache: cache_lease.root_identity()?,
            environment,
            epoch,
            profile: WorkspaceProfile::LocalCodeRemoteExecV1,
        };
        Ok(Self {
            store,
            cache,
            registration,
        })
    }
    pub fn open(
        store: FsService,
        cache: FsService,
        environment: Id,
        epoch: Counter,
    ) -> Result<Self, BuildError> {
        let runner = Self::configured(store, cache, environment, epoch)?;
        runner.verify(&runner.store.sync_lease()?)?;
        Ok(runner)
    }
    fn verify(&self, lease: &SyncLease) -> Result<(), BuildError> {
        lease.validate_private_root()?;
        if lease.root_identity()? != self.registration.root
            || lease.read_record("profile")?.as_deref()
                != Some(serde_json::to_vec(&self.registration)?.as_slice())
        {
            return Err(BuildError::Invalid);
        }
        // Avoid exclusive cache admission here: a quarantined supervisor may
        // still own it while inspect reads the durable unknown intent.
        Ok(())
    }
    pub fn inspect(&self, job: &Id) -> Result<Option<BuildReceipt>, BuildError> {
        let lease = self.store.sync_lease()?;
        self.verify(&lease)?;
        self.read_receipt(&lease, job)
    }
    fn read_receipt(
        &self,
        lease: &SyncLease,
        job: &Id,
    ) -> Result<Option<BuildReceipt>, BuildError> {
        let Some(intent) = lease.read_record(&key(job, "intent"))? else {
            return Ok(None);
        };
        let intent: Intent = serde_json::from_slice(&intent)?;
        if intent.registration != self.registration || &intent.job != job {
            return Err(BuildError::Invalid);
        }
        let Some(result) = lease.read_record(&key(job, "result"))? else {
            return Err(BuildError::OutcomeUnknown);
        };
        let result: BuildReceipt = serde_json::from_slice(&result)?;
        if &result.job != job
            || result.environment != self.registration.environment
            || result.epoch != self.registration.epoch
            || result.checkpoint != intent.checkpoint
            || result.command != intent.command
        {
            return Err(BuildError::Invalid);
        }
        Ok(Some(result))
    }
    pub async fn run(
        &self,
        job: Id,
        snapshot: Arc<PinnedWorkspaceSnapshot>,
        command: NativeBuildCommand,
        cancellation: &CancellationToken,
    ) -> Result<BuildReceipt, BuildError> {
        self.run_observed(job, snapshot, command, cancellation, |_| true)
            .await
    }
    pub async fn run_observed(
        &self,
        job: Id,
        snapshot: Arc<PinnedWorkspaceSnapshot>,
        mut command: NativeBuildCommand,
        cancellation: &CancellationToken,
        mut observer: impl FnMut(BuildStep) -> bool,
    ) -> Result<BuildReceipt, BuildError> {
        self.registration
            .profile
            .require_execution(ExecutionLocation::Remote, true)?;
        let lease = self.store.sync_lease()?;
        self.verify(&lease)?;
        if snapshot.environment != self.registration.environment
            || overlaps(
                snapshot.lease.service().workspace_root(),
                self.cache.workspace_root(),
            )
            || overlaps(
                snapshot.lease.service().workspace_root(),
                self.store.workspace_root(),
            )
        {
            return Err(BuildError::Invalid);
        }
        for root in &snapshot.protected_roots {
            if overlaps(root, self.cache.workspace_root())
                || overlaps(root, self.store.workspace_root())
            {
                return Err(BuildError::Invalid);
            }
        }
        if cancellation.is_cancelled() {
            return Err(BuildError::Busy);
        }
        snapshot.validate()?;
        if command.spec.cwd != snapshot.lease.service().workspace_root()
            || command.artifacts.len() > 16
            || command
                .spec
                .timeout
                .is_none_or(|t| t.is_zero() || t > Duration::from_secs(600))
        {
            return Err(BuildError::Invalid);
        }
        let expected_prefix = format!("artifacts/{:x}/", Sha256::digest(job.as_str().as_bytes()));
        for path in &command.artifacts {
            if !path.starts_with(&expected_prefix)
                || classify_capture_path(path)? != CapturePathClass::Include
            {
                return Err(BuildError::Invalid);
            }
        }
        let mut config = PlatformConfig::new(self.cache.workspace_root())
            .read_only_root(snapshot.lease.service().workspace_root());
        let mut roots = Vec::new();
        for root in &command.read_only_roots {
            let root = std::fs::canonicalize(root).map_err(|e| {
                BuildError::Platform(PlatformError::Filesystem(xharness_fs::FsError::Io {
                    operation: "canonicalize native build read root",
                    path: "native build root".into(),
                    source: e,
                }))
            })?;
            if overlaps(&root, self.store.workspace_root())
                || overlaps(&root, self.cache.workspace_root())
                || overlaps(&root, snapshot.lease.service().workspace_root())
                || snapshot.protected_roots.iter().any(|r| overlaps(r, &root))
            {
                return Err(BuildError::Invalid);
            }
            roots.push(root.to_str().ok_or(BuildError::Invalid)?.to_owned());
            config = config.read_only_root(root);
        }
        command.spec.stdout_limit = command.spec.stdout_limit.min(64 * 1024);
        command.spec.stderr_limit = command.spec.stderr_limit.min(64 * 1024);
        let args: Vec<_> = command
            .spec
            .args
            .iter()
            .map(|a| a.to_str().ok_or(BuildError::Invalid))
            .collect::<Result<_, _>>()?;
        let env: Vec<_> = command
            .spec
            .env
            .iter()
            .map(|(k, v)| {
                Ok((
                    k.to_str().ok_or(BuildError::Invalid)?,
                    v.to_str().ok_or(BuildError::Invalid)?,
                ))
            })
            .collect::<Result<_, BuildError>>()?;
        let identity = serde_json::to_vec(&(
            command.spec.program.to_str().ok_or(BuildError::Invalid)?,
            args,
            env,
            roots,
            &command.artifacts,
            command.spec.timeout,
            command.spec.stdout_limit,
            command.spec.stderr_limit,
            command.spec.termination_grace,
            command.spec.capture_drain_grace,
        ))?;
        let intent = Intent {
            registration: self.registration.clone(),
            job: job.clone(),
            checkpoint: snapshot.checkpoint.clone(),
            command: format!("{:x}", Sha256::digest(identity)),
        };
        if let Some(old) = lease.read_record(&key(&job, "intent"))? {
            if old != serde_json::to_vec(&intent)? {
                return Err(BuildError::Invalid);
            }
            let result = self
                .read_receipt(&lease, &job)?
                .ok_or(BuildError::OutcomeUnknown)?;
            self.finish_metadata(&lease, &job)?;
            return Ok(result);
        }
        if lease.read_record("build-active")?.as_deref() != Some(b"idle\n") {
            return Err(BuildError::OutcomeUnknown);
        }
        if lease.entry_count(160)? + 2 > 130 {
            return Err(BuildError::Limit);
        }
        {
            let cache = self.cache.sync_lease()?;
            cache.validate_private_root()?;
            if cache.root_identity()? != self.registration.cache {
                return Err(BuildError::Invalid);
            }
        }
        let platform = NativePlatform::new(config)?.retain_execution_guard(snapshot.clone());
        lease.put_record_once(&key(&job, "intent"), &serde_json::to_vec(&intent)?)?;
        lease.write_record("build-active", key(&job, "intent").as_bytes())?;
        if !observer(BuildStep::Intent) {
            return Err(BuildError::Interrupted);
        }
        let handle = platform.spawn(command.spec).await?;
        let control = handle.cancellation();
        let waiting = handle.wait();
        tokio::pin!(waiting);
        let output: ProcessOutput = tokio::select! { result=&mut waiting=>result?, _=cancellation.cancelled()=>{control.cancel(); waiting.await?} };
        snapshot.validate()?;
        drop(platform);
        let cache = self.cache.sync_lease()?;
        cache.validate_private_root()?;
        if cache.root_identity()? != self.registration.cache {
            return Err(BuildError::Invalid);
        }
        let mut artifacts = Vec::new();
        for path in command.artifacts {
            if let Some(w) = cache.probe(&path)? {
                if w.bytes > 16 * 1024 * 1024 {
                    return Err(BuildError::Limit);
                }
                artifacts.push(BuildArtifact {
                    path,
                    sha256: w.sha256,
                    bytes: w.bytes,
                    exact: w.exact,
                });
            // Failed/timed-out builds may not produce a selected artifact.
            // Their receipt stays unsuccessful; no absent file is acknowledged.
            } else if output.status.success {
                return Err(BuildError::Invalid);
            }
        }
        let receipt = BuildReceipt {
            job: job.clone(),
            environment: self.registration.environment.clone(),
            epoch: self.registration.epoch,
            checkpoint: intent.checkpoint,
            command: intent.command,
            success: output.status.success
                && output.termination == xharness_process::TerminationReason::Exited,
            exit_code: output.status.code,
            termination: format!("{:?}", output.termination).to_ascii_lowercase(),
            stdout: output.stdout.text,
            stderr: output.stderr.text,
            stdout_truncated: output.stdout.truncated,
            stderr_truncated: output.stderr.truncated,
            artifacts,
        };
        lease.put_record_once(&key(&job, "result"), &serde_json::to_vec(&receipt)?)?;
        if !observer(BuildStep::ResultStored) {
            return Err(BuildError::Interrupted);
        }
        lease.write_record("build-active", b"idle\n")?;
        Ok(receipt)
    }
    pub fn finalize_completed(&self, job: &Id) -> Result<BuildReceipt, BuildError> {
        let lease = self.store.sync_lease()?;
        self.verify(&lease)?;
        let result = self
            .read_receipt(&lease, job)?
            .ok_or(BuildError::OutcomeUnknown)?;
        self.finish_metadata(&lease, job)?;
        Ok(result)
    }
    fn finish_metadata(&self, lease: &SyncLease, job: &Id) -> Result<(), BuildError> {
        let active = lease.read_record("build-active")?;
        if active.as_deref() == Some(key(job, "intent").as_bytes()) {
            lease.write_record("build-active", b"idle\n")?;
        } else if active.as_deref() != Some(b"idle\n") {
            return Err(BuildError::OutcomeUnknown);
        }
        Ok(())
    }
    /// Explicitly selected recorded artifact only, never automatic cache sync.
    pub fn artifact(&self, job: &Id, path: &str) -> Result<Vec<u8>, BuildError> {
        let receipt = self.inspect(job)?.ok_or(BuildError::Invalid)?;
        let file = receipt
            .artifacts
            .iter()
            .find(|a| a.path == path)
            .ok_or(BuildError::Invalid)?;
        let cache = self.cache.sync_lease()?;
        cache.validate_private_root()?;
        if cache.root_identity()? != self.registration.cache {
            return Err(BuildError::Invalid);
        }
        let bytes = cache.export_bytes(path, &file.exact, 16 * 1024 * 1024)?;
        if bytes.len() as u64 != file.bytes
            || format!("{:x}", Sha256::digest(&bytes)) != file.sha256
        {
            return Err(BuildError::Invalid);
        }
        Ok(bytes)
    }
}
fn overlaps(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

//! Compile-time native platform composition for XHarness.
//!
//! The agent loop and model providers remain platform-independent. This crate
//! is the single lower-layer entry point for workspace filesystem access,
//! direct process execution, and OS confinement. Linux and macOS select their
//! implementation with `cfg`, not a runtime backend registry.

use std::path::{Path, PathBuf};

use xharness_fs::{FsError, FsService, ObservationStore};
use xharness_process::{ProcessError, ProcessHandle, ProcessRuntime, SpawnSpec};
use xharness_sandbox::{NativeSandbox, NetworkAccess, SandboxError, SandboxMode, SandboxPolicy};

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
compile_error!("xharness-platform currently supports only Linux and macOS");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlatformKind {
    MacOS,
    Linux,
}

impl PlatformKind {
    #[cfg(target_os = "linux")]
    pub const CURRENT: Self = Self::Linux;
    #[cfg(target_os = "macos")]
    pub const CURRENT: Self = Self::MacOS;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlatformConfig {
    workspace_root: PathBuf,
    sandbox_mode: SandboxMode,
    network: NetworkAccess,
    allowed_cwd_roots: Vec<PathBuf>,
}

impl PlatformConfig {
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        Self {
            workspace_root: workspace_root.into(),
            sandbox_mode: SandboxMode::WorkspaceWrite,
            network: NetworkAccess::Deny,
            allowed_cwd_roots: Vec::new(),
        }
    }

    pub fn sandbox_mode(mut self, mode: SandboxMode) -> Self {
        self.sandbox_mode = mode;
        self
    }

    pub fn network(mut self, network: NetworkAccess) -> Self {
        self.network = network;
        self
    }

    pub fn allow_cwd_root(mut self, root: impl Into<PathBuf>) -> Self {
        self.allowed_cwd_roots.push(root.into());
        self
    }

    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    pub const fn sandbox_mode_value(&self) -> SandboxMode {
        self.sandbox_mode
    }

    pub const fn network_value(&self) -> NetworkAccess {
        self.network
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PlatformError {
    #[error(transparent)]
    Filesystem(#[from] FsError),
    #[error(transparent)]
    Sandbox(#[from] SandboxError),
    #[error(transparent)]
    Process(#[from] ProcessError),
}

/// Native capabilities bound to one workspace.
#[derive(Clone)]
pub struct NativePlatform {
    filesystem: FsService,
    process: ProcessRuntime,
    sandbox: NativeSandbox,
}

impl NativePlatform {
    pub fn new(config: PlatformConfig) -> Result<Self, PlatformError> {
        Self::with_observations(config, ObservationStore::default())
    }

    pub fn with_observations(
        config: PlatformConfig,
        observations: ObservationStore,
    ) -> Result<Self, PlatformError> {
        let filesystem = FsService::with_observations(&config.workspace_root, observations)?;
        let mut policy = SandboxPolicy::new(filesystem.workspace_root(), config.sandbox_mode)
            .with_network(config.network);
        for root in config.allowed_cwd_roots {
            policy = policy.allow_cwd_root(root);
        }
        Ok(Self {
            filesystem,
            process: ProcessRuntime::new(),
            sandbox: NativeSandbox::new(policy),
        })
    }

    pub const fn kind(&self) -> PlatformKind {
        PlatformKind::CURRENT
    }

    pub fn filesystem(&self) -> &FsService {
        &self.filesystem
    }

    pub const fn process(&self) -> &ProcessRuntime {
        &self.process
    }

    pub const fn sandbox(&self) -> &NativeSandbox {
        &self.sandbox
    }

    /// Apply the native sandbox without spawning. This keeps policy decisions
    /// inspectable and lets higher layers journal the final argv first.
    pub async fn prepare_spawn(&self, spec: SpawnSpec) -> Result<SpawnSpec, PlatformError> {
        Ok(self.sandbox.prepare(spec).await?)
    }

    /// Prepare and launch one process. Callers retain the handle and must await
    /// it before considering a tool call quiescent.
    pub async fn spawn(&self, spec: SpawnSpec) -> Result<ProcessHandle, PlatformError> {
        let spec = self.prepare_spawn(spec).await?;
        Ok(self.process.spawn(spec)?)
    }
}

impl std::fmt::Debug for NativePlatform {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativePlatform")
            .field("kind", &self.kind())
            .field("workspace_root", &self.filesystem.workspace_root())
            .field("sandbox", &self.sandbox)
            .finish_non_exhaustive()
    }
}

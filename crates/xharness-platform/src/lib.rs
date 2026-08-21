//! Compile-time native platform composition for XHarness.
//!
//! The agent loop and model providers remain platform-independent. This crate
//! is the single lower-layer entry point for workspace filesystem access,
//! direct process execution, and OS confinement. Linux and macOS select their
//! implementation with `cfg`, not a runtime backend registry.

use std::path::{Path, PathBuf};

use xharness_fs::{FsError, FsService, FsTarget, ObservationStore};
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
    workspace_root: PathBuf,
    sandbox_mode: SandboxMode,
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
        let workspace_root =
            std::fs::canonicalize(&config.workspace_root).map_err(|source| FsError::Io {
                operation: "canonicalize workspace root",
                path: config.workspace_root.to_string_lossy().into_owned(),
                source,
            })?;
        let filesystem_root = if config.sandbox_mode == SandboxMode::DangerFullAccess {
            Path::new("/")
        } else {
            workspace_root.as_path()
        };
        let filesystem = FsService::with_observations(filesystem_root, observations)?;
        let mut policy =
            SandboxPolicy::new(&workspace_root, config.sandbox_mode).with_network(config.network);
        for root in config.allowed_cwd_roots {
            policy = policy.allow_cwd_root(root);
        }
        Ok(Self {
            workspace_root,
            sandbox_mode: config.sandbox_mode,
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

    /// Canonical session workspace used as the default cwd even when the
    /// structured filesystem is rooted at `/` for Full access.
    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    /// Resolve a model-supplied file path under the active permission mode.
    /// Workspace write keeps the hardened workspace-relative capability.
    /// Full access roots that same race-safe implementation at `/`, while
    /// preserving workspace-relative inputs for ordinary coding tasks.
    pub fn resolve_file(&self, input: impl AsRef<Path>) -> Result<FsTarget, FsError> {
        let input = input.as_ref();
        if self.sandbox_mode != SandboxMode::DangerFullAccess {
            return self.filesystem.resolve(input);
        }
        let absolute = if input.is_absolute() {
            input.to_owned()
        } else {
            self.workspace_root.join(input)
        };
        let relative = absolute
            .strip_prefix("/")
            .map_err(|_| FsError::InvalidPath {
                display: input.to_string_lossy().into_owned(),
                reason: "full-access path is not rooted",
            })?;
        self.filesystem.resolve(relative)
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
            .field("workspace_root", &self.workspace_root)
            .field("sandbox", &self.sandbox)
            .finish_non_exhaustive()
    }
}

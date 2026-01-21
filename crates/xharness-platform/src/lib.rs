//! Compile-time native platform composition for XHarness.
//!
//! The agent loop and model providers remain platform-independent. This crate
//! is the single lower-layer entry point for workspace filesystem access,
//! direct process execution, and OS confinement. Linux and macOS select their
//! implementation with `cfg`, not a runtime backend registry.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use tokio::sync::OnceCell;

use xharness_debug::{DebugEvent, DebugRecorder};
use xharness_fs::{FsError, FsService, FsTarget, ObservationStore};
use xharness_process::{ProcessError, ProcessHandle, ProcessRuntime, SpawnSpec};
use xharness_sandbox::{NativeSandbox, NetworkAccess, SandboxError, SandboxMode, SandboxPolicy};

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
compile_error!("xharness-platform currently supports only Linux, macOS and Windows");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlatformKind {
    MacOS,
    Linux,
    Windows,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CapabilityState {
    Available,
    Unavailable { reason: String },
}

impl CapabilityState {
    pub const fn is_available(&self) -> bool {
        matches!(self, Self::Available)
    }
}

/// Cached product-facing readiness of one workspace/permission composition.
/// It reports facts only; it never widens policy or falls back to full access.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityReport {
    pub filesystem_read: CapabilityState,
    pub filesystem_mutation: CapabilityState,
    pub restricted_process: CapabilityState,
    pub terminal_open: CapabilityState,
    pub process_network: CapabilityState,
    pub sandbox_backend: String,
}

/// Process authority selected by the product permission preset.
///
/// Full access is intentionally outside [`SandboxMode`]: it does not create,
/// probe or call a native sandbox adapter. Processes are still launched by
/// [`ProcessRuntime`] so cancellation, timeout and process-group cleanup remain
/// active. A descendant that deliberately creates a new Unix session is not
/// hard-contained in this mode.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PlatformAccess {
    #[default]
    WorkspaceWrite,
    ReadOnly,
    FullAccess,
}

impl PlatformAccess {
    const fn sandbox_mode(self) -> Option<SandboxMode> {
        match self {
            Self::WorkspaceWrite => Some(SandboxMode::WorkspaceWrite),
            Self::ReadOnly => Some(SandboxMode::ReadOnly),
            Self::FullAccess => None,
        }
    }

    pub const fn is_sandboxed(self) -> bool {
        self.sandbox_mode().is_some()
    }
}

impl PlatformKind {
    #[cfg(target_os = "linux")]
    pub const CURRENT: Self = Self::Linux;
    #[cfg(target_os = "macos")]
    pub const CURRENT: Self = Self::MacOS;
    #[cfg(windows)]
    pub const CURRENT: Self = Self::Windows;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlatformConfig {
    workspace_root: PathBuf,
    access: PlatformAccess,
    network: NetworkAccess,
    allowed_cwd_roots: Vec<PathBuf>,
}

impl PlatformConfig {
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        Self {
            workspace_root: workspace_root.into(),
            access: PlatformAccess::WorkspaceWrite,
            network: NetworkAccess::Deny,
            allowed_cwd_roots: Vec::new(),
        }
    }

    pub fn sandbox_mode(mut self, mode: SandboxMode) -> Self {
        self.access = match mode {
            SandboxMode::ReadOnly => PlatformAccess::ReadOnly,
            SandboxMode::WorkspaceWrite => PlatformAccess::WorkspaceWrite,
        };
        self
    }

    /// Disable native permission sandboxing while retaining managed process
    /// execution through [`ProcessRuntime`].
    pub fn full_access(mut self) -> Self {
        self.access = PlatformAccess::FullAccess;
        self.network = NetworkAccess::Allow;
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

    pub const fn access_value(&self) -> PlatformAccess {
        self.access
    }

    pub const fn network_value(&self) -> NetworkAccess {
        match self.access {
            PlatformAccess::FullAccess => NetworkAccess::Allow,
            PlatformAccess::WorkspaceWrite | PlatformAccess::ReadOnly => self.network,
        }
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
    filesystem_root: PathBuf,
    access: PlatformAccess,
    filesystem: FsService,
    process: ProcessRuntime,
    sandbox: Option<NativeSandbox>,
    readiness: Arc<OnceCell<CapabilityReport>>,
    debug: DebugRecorder,
}

impl NativePlatform {
    pub fn new(config: PlatformConfig) -> Result<Self, PlatformError> {
        Self::with_observations(config, ObservationStore::default())
    }

    pub fn with_debug(config: PlatformConfig, debug: DebugRecorder) -> Result<Self, PlatformError> {
        Self::with_observations_and_debug(config, ObservationStore::default(), debug)
    }

    pub fn with_observations(
        config: PlatformConfig,
        observations: ObservationStore,
    ) -> Result<Self, PlatformError> {
        Self::with_observations_and_debug(config, observations, DebugRecorder::disabled())
    }

    pub fn with_observations_and_debug(
        config: PlatformConfig,
        observations: ObservationStore,
        debug: DebugRecorder,
    ) -> Result<Self, PlatformError> {
        let workspace_root =
            std::fs::canonicalize(&config.workspace_root).map_err(|source| FsError::Io {
                operation: "canonicalize workspace root",
                path: config.workspace_root.to_string_lossy().into_owned(),
                source,
            })?;
        let filesystem_root = if config.access == PlatformAccess::FullAccess {
            native_filesystem_root(&workspace_root)
        } else {
            workspace_root.clone()
        };
        let filesystem = FsService::with_observations(&filesystem_root, observations)?;
        let sandbox = if let Some(mode) = config.access.sandbox_mode() {
            let mut policy = SandboxPolicy::new(&workspace_root, mode).with_network(config.network);
            for root in config.allowed_cwd_roots {
                policy = policy.allow_cwd_root(root);
            }
            Some(NativeSandbox::new(policy).with_debug(debug.clone()))
        } else {
            None
        };
        Ok(Self {
            workspace_root,
            filesystem_root,
            access: config.access,
            filesystem,
            process: ProcessRuntime::with_debug(debug.clone()),
            sandbox,
            readiness: Arc::new(OnceCell::new()),
            debug,
        })
    }

    pub const fn kind(&self) -> PlatformKind {
        PlatformKind::CURRENT
    }

    pub fn filesystem(&self) -> &FsService {
        &self.filesystem
    }

    /// Canonical session workspace used as the default cwd even when the
    /// structured filesystem uses the native volume root for Full access.
    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    /// Resolve a model-supplied file path under the active permission mode.
    /// Workspace write keeps the hardened workspace-relative capability.
    /// Full access roots that same race-safe implementation at the native
    /// filesystem root, while preserving workspace-relative inputs for
    /// ordinary coding tasks.
    pub fn resolve_file(&self, input: impl AsRef<Path>) -> Result<FsTarget, FsError> {
        let input = input.as_ref();
        if self.access != PlatformAccess::FullAccess {
            return self.filesystem.resolve(input);
        }
        let absolute = if input.is_absolute() {
            input.to_owned()
        } else {
            self.workspace_root.join(input)
        };
        let relative = strip_native_root(&absolute, &self.filesystem_root).ok_or_else(|| {
            FsError::InvalidPath {
                display: input.to_string_lossy().into_owned(),
                reason: "full-access path is outside the workspace volume",
            }
        })?;
        self.filesystem.resolve(relative)
    }

    pub const fn process(&self) -> &ProcessRuntime {
        &self.process
    }

    pub const fn access(&self) -> PlatformAccess {
        self.access
    }

    /// The native adapter exists only for restricted execution. Full access
    /// returns `None` because it is not a sandbox configuration.
    pub const fn sandbox(&self) -> Option<&NativeSandbox> {
        self.sandbox.as_ref()
    }

    /// Probe native process confinement once and return a stable readiness
    /// report consumed by Host tool projection.
    pub async fn capability_report(&self) -> CapabilityReport {
        let report = self
            .readiness
            .get_or_init(|| async { self.probe_capabilities().await })
            .await
            .clone();
        self.debug
            .record_lossy(DebugEvent::new(
                "platform",
                "capability.report",
                serde_json::json!({
                    "workspace": self.workspace_root.to_string_lossy(),
                    "access": format!("{:?}", self.access),
                    "report": format!("{:?}", report),
                }),
            ))
            .await;
        report
    }

    async fn probe_capabilities(&self) -> CapabilityReport {
        let filesystem_read = CapabilityState::Available;
        let filesystem_mutation = if self.access == PlatformAccess::ReadOnly {
            CapabilityState::Unavailable {
                reason: "session policy is read-only".to_owned(),
            }
        } else {
            CapabilityState::Available
        };
        if self.access == PlatformAccess::FullAccess {
            return CapabilityReport {
                filesystem_read,
                filesystem_mutation,
                restricted_process: CapabilityState::Available,
                terminal_open: CapabilityState::Available,
                process_network: CapabilityState::Available,
                sandbox_backend: "none-full-access".to_owned(),
            };
        }

        let process = match self.probe_native_sandbox().await {
            Ok(()) => CapabilityState::Available,
            Err(reason) => CapabilityState::Unavailable { reason },
        };
        let process_network = if process.is_available()
            && self
                .sandbox
                .as_ref()
                .is_some_and(|sandbox| sandbox.policy().network() == NetworkAccess::Allow)
        {
            CapabilityState::Available
        } else if !process.is_available() {
            process.clone()
        } else {
            CapabilityState::Unavailable {
                reason: "sandbox network policy is deny".to_owned(),
            }
        };
        CapabilityReport {
            filesystem_read,
            filesystem_mutation,
            restricted_process: process.clone(),
            terminal_open: process,
            process_network,
            sandbox_backend: native_sandbox_name().to_owned(),
        }
    }

    #[cfg(target_os = "linux")]
    async fn probe_native_sandbox(&self) -> Result<(), String> {
        self.sandbox
            .as_ref()
            .expect("restricted platform has a sandbox")
            .probe()
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    #[cfg(target_os = "macos")]
    async fn probe_native_sandbox(&self) -> Result<(), String> {
        let spec = SpawnSpec::new("/usr/bin/true", &self.workspace_root);
        self.sandbox
            .as_ref()
            .expect("restricted platform has a sandbox")
            .prepare(spec)
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    #[cfg(windows)]
    async fn probe_native_sandbox(&self) -> Result<(), String> {
        let spec = SpawnSpec::new("cmd.exe", &self.workspace_root).args(["/D", "/C", "exit 0"]);
        let prepared = self
            .sandbox
            .as_ref()
            .expect("restricted platform has a sandbox")
            .prepare(spec)
            .await
            .map_err(|error| error.to_string())?;
        let output = self
            .process
            .spawn(prepared)
            .map_err(|error| error.to_string())?
            .wait()
            .await
            .map_err(|error| error.to_string())?;
        if output.status.success {
            Ok(())
        } else {
            Err(format!(
                "Windows ACL sandbox probe failed: {}",
                output.stderr.text.trim()
            ))
        }
    }

    /// Apply the native sandbox without spawning. This keeps policy decisions
    /// inspectable and lets higher layers journal the final argv first.
    pub async fn prepare_spawn(&self, spec: SpawnSpec) -> Result<SpawnSpec, PlatformError> {
        match &self.sandbox {
            Some(sandbox) => Ok(sandbox.prepare(spec).await?),
            None => Ok(spec),
        }
    }

    /// Prepare and launch one process. Callers retain the handle and must await
    /// it before considering a tool call quiescent.
    pub async fn spawn(&self, spec: SpawnSpec) -> Result<ProcessHandle, PlatformError> {
        let spec = self.prepare_spawn(spec).await?;
        Ok(self.process.spawn(spec)?)
    }
}

#[cfg(target_os = "linux")]
const fn native_sandbox_name() -> &'static str {
    "bubblewrap"
}

#[cfg(target_os = "macos")]
const fn native_sandbox_name() -> &'static str {
    "seatbelt"
}

#[cfg(windows)]
const fn native_sandbox_name() -> &'static str {
    "windows-acl-partial"
}

#[cfg(unix)]
fn native_filesystem_root(_workspace: &Path) -> PathBuf {
    PathBuf::from("/")
}

#[cfg(windows)]
fn native_filesystem_root(workspace: &Path) -> PathBuf {
    let mut root = PathBuf::new();
    for component in workspace.components() {
        root.push(component.as_os_str());
        if matches!(component, std::path::Component::RootDir) {
            break;
        }
    }
    root
}

#[cfg(not(windows))]
fn strip_native_root<'a>(path: &'a Path, root: &Path) -> Option<&'a Path> {
    path.strip_prefix(root).ok()
}

#[cfg(windows)]
fn strip_native_root(path: &Path, root: &Path) -> Option<PathBuf> {
    let path_components = path.components().collect::<Vec<_>>();
    let root_components = root.components().collect::<Vec<_>>();
    if root_components.len() > path_components.len()
        || !root_components
            .iter()
            .zip(&path_components)
            .all(|(left, right)| {
                left.as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
            })
    {
        return None;
    }
    Some(path_components[root_components.len()..].iter().collect())
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

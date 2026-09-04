#[cfg(target_os = "linux")]
use std::{env, ffi::OsStr, time::Duration};
use std::{
    ffi::OsString,
    fmt, fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::sync::OnceCell;
use xharness_debug::{DebugEvent, DebugRecorder};
use xharness_process::SpawnSpec;
#[cfg(target_os = "linux")]
use xharness_process::{ProcessRuntime, TerminationReason};

use crate::{NetworkAccess, SandboxMode, SandboxPolicy};

#[cfg(target_os = "linux")]
const DEFAULT_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(target_os = "linux")]
const PROBE_CAPTURE_LIMIT: usize = 16 * 1024;

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum SandboxError {
    #[error("native sandbox is unavailable: {reason}")]
    Unavailable { reason: String },
    #[error("cannot canonicalize workspace root {path:?}: {message}")]
    WorkspacePath { path: PathBuf, message: String },
    #[error("workspace root is not a directory: {path:?}")]
    WorkspaceNotDirectory { path: PathBuf },
    #[error("workspace root {path:?} would replace a sandbox infrastructure mount")]
    UnsafeWorkspaceRoot { path: PathBuf },
    #[error("cannot canonicalize working directory {path:?}: {message}")]
    WorkingDirectoryPath { path: PathBuf, message: String },
    #[error("working directory is not a directory: {path:?}")]
    WorkingDirectoryNotDirectory { path: PathBuf },
    #[error("cannot canonicalize allowed cwd root {path:?}: {message}")]
    AllowedCwdPath { path: PathBuf, message: String },
    #[error("allowed cwd root is not a directory: {path:?}")]
    AllowedCwdNotDirectory { path: PathBuf },
    #[error("allowed cwd root {path:?} would replace a sandbox infrastructure mount")]
    UnsafeAllowedCwdRoot { path: PathBuf },
    #[error(
        "working directory {cwd:?} is outside workspace {workspace:?} and every explicit cwd root"
    )]
    WorkingDirectoryDenied { cwd: PathBuf, workspace: PathBuf },
    #[error("sandboxed process program must not be empty")]
    EmptyProgram,
    #[error("sandbox profile path is not valid UTF-8: {path:?}")]
    ProfilePathEncoding { path: PathBuf },
}

/// Injectable probe seam. The production implementation resolves `program`,
/// executes a minimal isolated command, and returns the canonical executable
/// path only on success.
#[async_trait]
pub trait BwrapProbe: Send + Sync + 'static {
    async fn probe(&self, program: OsString) -> Result<PathBuf, String>;
}

/// Cached Bubblewrap availability result.
#[derive(Clone, Debug, PartialEq, Eq)]
enum ProbeState {
    Available(PathBuf),
    Unavailable(String),
}

/// Fail-closed Bubblewrap adapter.
#[derive(Clone)]
pub struct BwrapSandbox {
    policy: SandboxPolicy,
    bwrap_program: OsString,
    probe_backend: Arc<dyn BwrapProbe>,
    probe_cache: Arc<OnceCell<ProbeState>>,
    debug: DebugRecorder,
}

impl BwrapSandbox {
    pub fn new(policy: SandboxPolicy) -> Self {
        Self {
            policy,
            bwrap_program: OsString::from("bwrap"),
            probe_backend: Arc::new(ProcessBwrapProbe::default()),
            probe_cache: Arc::new(OnceCell::new()),
            debug: DebugRecorder::disabled(),
        }
    }

    pub fn with_debug(mut self, debug: DebugRecorder) -> Self {
        self.debug = debug;
        self
    }

    /// Override the executable request. A relative bare name is resolved
    /// through `PATH` by the production probe; a path is canonicalized.
    pub fn with_bwrap_program(mut self, program: impl Into<OsString>) -> Self {
        self.bwrap_program = program.into();
        self.probe_cache = Arc::new(OnceCell::new());
        self
    }

    /// Replace probing for deterministic hosts/tests. Changing the seam resets
    /// the cached result.
    pub fn with_probe_backend(mut self, backend: Arc<dyn BwrapProbe>) -> Self {
        self.probe_backend = backend;
        self.probe_cache = Arc::new(OnceCell::new());
        self
    }

    pub const fn policy(&self) -> &SandboxPolicy {
        &self.policy
    }

    /// Actually execute a minimal mount/user namespace isolation once. Both a
    /// successful canonical path and a failure are cached across clones.
    pub async fn probe(&self) -> Result<PathBuf, SandboxError> {
        let state = self
            .probe_cache
            .get_or_init(|| async {
                match self.probe_backend.probe(self.bwrap_program.clone()).await {
                    Ok(path) => ProbeState::Available(path),
                    Err(reason) => ProbeState::Unavailable(reason),
                }
            })
            .await;
        let result = match state {
            ProbeState::Available(path) => Ok(path.clone()),
            ProbeState::Unavailable(reason) => Err(SandboxError::Unavailable {
                reason: reason.clone(),
            }),
        };
        self.debug
            .record_lossy(DebugEvent::new(
                "sandbox",
                "probe.completed",
                json!({
                    "backend": "bubblewrap",
                    "available": result.is_ok(),
                    "path": result.as_ref().ok().map(|path| path.to_string_lossy()),
                    "error": result.as_ref().err().map(ToString::to_string),
                }),
            ))
            .await;
        result
    }

    /// Convert one direct-exec spec into a direct `bwrap` invocation. The
    /// Restricted modes never return the original spec when Bubblewrap is
    /// unavailable. Full access is deliberately not a sandbox mode and must
    /// bypass this adapter in the platform layer.
    pub async fn prepare(&self, spec: SpawnSpec) -> Result<SpawnSpec, SandboxError> {
        let request = spawn_spec_payload(&spec);
        self.debug
            .record_lossy(DebugEvent::new(
                "sandbox",
                "prepare.request",
                json!({
                    "backend": "bubblewrap",
                    "mode": format!("{:?}", self.policy.mode()),
                    "network": format!("{:?}", self.policy.network()),
                    "spec": request,
                }),
            ))
            .await;
        let result = self.prepare_inner(spec).await;
        self.debug
            .record_lossy(DebugEvent::new(
                "sandbox",
                "prepare.completed",
                json!({
                    "backend": "bubblewrap",
                    "spec": result.as_ref().ok().map(spawn_spec_payload),
                    "error": result.as_ref().err().map(ToString::to_string),
                }),
            ))
            .await;
        result
    }

    async fn prepare_inner(&self, mut spec: SpawnSpec) -> Result<SpawnSpec, SandboxError> {
        if spec.program.is_empty() {
            return Err(SandboxError::EmptyProgram);
        }

        let paths = ValidatedPaths::new(&self.policy, &spec.cwd)?;
        let bwrap = self.probe().await?;
        let original_program = std::mem::take(&mut spec.program);
        let original_args = std::mem::take(&mut spec.args);

        let mut args = base_arguments(self.policy.network());
        // Mount these after the ephemeral /tmp so workspaces or explicit cwd
        // roots located below /tmp remain visible.
        for root in &paths.allowed_cwd_roots {
            if !root.starts_with(&paths.workspace) {
                push_mount(&mut args, "--ro-bind", root, root);
            }
        }
        // Mount the workspace last so an explicitly allowed parent cwd root
        // cannot cover and accidentally downgrade the writable workspace.
        match self.policy.mode() {
            SandboxMode::ReadOnly => {
                push_mount(&mut args, "--ro-bind", &paths.workspace, &paths.workspace)
            }
            SandboxMode::WorkspaceWrite => {
                push_mount(&mut args, "--bind", &paths.workspace, &paths.workspace)
            }
        }
        args.push(OsString::from("--chdir"));
        args.push(paths.cwd.as_os_str().to_owned());
        args.push(OsString::from("--"));
        args.push(original_program);
        args.extend(original_args);

        spec.program = bwrap.into_os_string();
        spec.args = args;
        spec.cwd = paths.cwd;
        Ok(spec)
    }
}

pub(crate) fn spawn_spec_payload(spec: &SpawnSpec) -> Value {
    json!({
        "program": spec.program.to_string_lossy(),
        "args": spec.args.iter().map(|arg| arg.to_string_lossy()).collect::<Vec<_>>(),
        "cwd": spec.cwd.to_string_lossy(),
        "timeoutMs": spec.timeout.map(|duration| duration.as_millis()),
        "parent": &spec.debug_parent,
    })
}

impl fmt::Debug for BwrapSandbox {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BwrapSandbox")
            .field("policy", &self.policy)
            .field("bwrap_program", &self.bwrap_program)
            .field("probe_cached", &self.probe_cache.initialized())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ValidatedPaths {
    pub(crate) workspace: PathBuf,
    pub(crate) cwd: PathBuf,
    pub(crate) allowed_cwd_roots: Vec<PathBuf>,
}

impl ValidatedPaths {
    pub(crate) fn new(policy: &SandboxPolicy, cwd: &Path) -> Result<Self, SandboxError> {
        let workspace = canonical_directory(policy.workspace_root(), |message| {
            SandboxError::WorkspacePath {
                path: policy.workspace_root().to_owned(),
                message,
            }
        })?
        .ok_or_else(|| SandboxError::WorkspaceNotDirectory {
            path: policy.workspace_root().to_owned(),
        })?;
        if is_infrastructure_mount(&workspace) {
            return Err(SandboxError::UnsafeWorkspaceRoot { path: workspace });
        }
        let cwd = canonical_directory(cwd, |message| SandboxError::WorkingDirectoryPath {
            path: cwd.to_owned(),
            message,
        })?
        .ok_or_else(|| SandboxError::WorkingDirectoryNotDirectory {
            path: cwd.to_owned(),
        })?;

        let mut allowed_cwd_roots = Vec::with_capacity(policy.allowed_cwd_roots().len());
        for raw in policy.allowed_cwd_roots() {
            let canonical = canonical_directory(raw, |message| SandboxError::AllowedCwdPath {
                path: raw.clone(),
                message,
            })?
            .ok_or_else(|| SandboxError::AllowedCwdNotDirectory { path: raw.clone() })?;
            if is_infrastructure_mount(&canonical) {
                return Err(SandboxError::UnsafeAllowedCwdRoot { path: canonical });
            }
            if !allowed_cwd_roots.contains(&canonical) {
                allowed_cwd_roots.push(canonical);
            }
        }

        if !path_is_within(&cwd, &workspace)
            && !allowed_cwd_roots
                .iter()
                .any(|root| path_is_within(&cwd, root))
        {
            return Err(SandboxError::WorkingDirectoryDenied { cwd, workspace });
        }
        Ok(Self {
            workspace,
            cwd,
            allowed_cwd_roots,
        })
    }
}

#[cfg(not(windows))]
fn path_is_within(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

#[cfg(windows)]
fn path_is_within(path: &Path, root: &Path) -> bool {
    let path = path
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_lowercase())
        .collect::<Vec<_>>();
    let root = root
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_lowercase())
        .collect::<Vec<_>>();
    path.starts_with(&root)
}

fn is_infrastructure_mount(path: &Path) -> bool {
    matches!(path.to_str(), Some("/" | "/tmp" | "/proc" | "/dev"))
}

fn canonical_directory<F>(path: &Path, error: F) -> Result<Option<PathBuf>, SandboxError>
where
    F: FnOnce(String) -> SandboxError,
{
    let canonical = fs::canonicalize(path).map_err(|source| error(source.to_string()))?;
    if canonical.is_dir() {
        Ok(Some(canonical))
    } else {
        Ok(None)
    }
}

fn base_arguments(network: NetworkAccess) -> Vec<OsString> {
    let mut args = vec![
        OsString::from("--die-with-parent"),
        OsString::from("--unshare-all"),
        // Keep this explicit even though --unshare-all includes it: the PID
        // namespace plus die-with-parent is the process-tree boundary for
        // descendants that call setsid and escape the host process group.
        OsString::from("--unshare-pid"),
    ];
    if network == NetworkAccess::Allow {
        args.push(OsString::from("--share-net"));
    }
    args.extend([
        OsString::from("--ro-bind"),
        OsString::from("/"),
        OsString::from("/"),
        OsString::from("--proc"),
        OsString::from("/proc"),
        OsString::from("--dev"),
        OsString::from("/dev"),
        OsString::from("--tmpfs"),
        OsString::from("/tmp"),
    ]);
    args
}

fn push_mount(args: &mut Vec<OsString>, operation: &str, source: &Path, destination: &Path) {
    args.push(OsString::from(operation));
    args.push(source.as_os_str().to_owned());
    args.push(destination.as_os_str().to_owned());
}

#[derive(Clone, Debug)]
#[cfg_attr(not(target_os = "linux"), derive(Default))]
struct ProcessBwrapProbe {
    #[cfg(target_os = "linux")]
    timeout: Duration,
}

#[cfg(target_os = "linux")]
impl Default for ProcessBwrapProbe {
    fn default() -> Self {
        Self {
            #[cfg(target_os = "linux")]
            timeout: DEFAULT_PROBE_TIMEOUT,
        }
    }
}

#[async_trait]
impl BwrapProbe for ProcessBwrapProbe {
    async fn probe(&self, program: OsString) -> Result<PathBuf, String> {
        #[cfg(not(target_os = "linux"))]
        {
            let _ = program;
            return Err("Bubblewrap confinement is supported only on Linux".to_owned());
        }

        #[cfg(target_os = "linux")]
        {
            let bwrap = resolve_executable(&program)?;
            let true_program =
                first_executable(&[Path::new("/bin/true"), Path::new("/usr/bin/true")])
                    .ok_or_else(|| {
                        "cannot locate /bin/true or /usr/bin/true for probe".to_owned()
                    })?;
            let mut args = base_arguments(NetworkAccess::Deny);
            args.extend([
                OsString::from("--chdir"),
                OsString::from("/"),
                OsString::from("--"),
                true_program.as_os_str().to_owned(),
            ]);
            let spec = SpawnSpec::new(bwrap.clone(), PathBuf::from("/"))
                .args(args)
                .timeout(self.timeout)
                .output_limits(PROBE_CAPTURE_LIMIT, PROBE_CAPTURE_LIMIT);
            let output = ProcessRuntime::new()
                .spawn(spec)
                .map_err(|error| format!("failed to start Bubblewrap probe: {error}"))?
                .wait()
                .await
                .map_err(|error| format!("Bubblewrap probe process failed: {error}"))?;
            if output.termination != TerminationReason::Exited {
                return Err(format!(
                    "Bubblewrap probe did not exit normally: {:?}",
                    output.termination
                ));
            }
            if !output.status.success {
                let detail = if output.stderr.text.trim().is_empty() {
                    format!(
                        "exit code {:?}, signal {:?}",
                        output.status.code, output.status.signal
                    )
                } else {
                    output.stderr.text.trim().to_owned()
                };
                return Err(format!("minimal isolation probe failed: {detail}"));
            }
            Ok(bwrap)
        }
    }
}

#[cfg(target_os = "linux")]
fn resolve_executable(program: &OsStr) -> Result<PathBuf, String> {
    let requested = Path::new(program);
    if requested.components().count() > 1 {
        return canonical_executable(requested);
    }
    let path = env::var_os("PATH").unwrap_or_else(|| OsString::from("/usr/bin:/bin"));
    for directory in env::split_paths(&path) {
        let candidate = directory.join(requested);
        if candidate.is_file() {
            return canonical_executable(&candidate);
        }
    }
    Err(format!("cannot find {program:?} in PATH"))
}

#[cfg(target_os = "linux")]
fn canonical_executable(path: &Path) -> Result<PathBuf, String> {
    let path =
        fs::canonicalize(path).map_err(|error| format!("cannot canonicalize {path:?}: {error}"))?;
    if !path.is_file() {
        return Err(format!("Bubblewrap executable is not a file: {path:?}"));
    }
    Ok(path)
}

#[cfg(target_os = "linux")]
fn first_executable(candidates: &[&Path]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| fs::canonicalize(candidate).ok())
}

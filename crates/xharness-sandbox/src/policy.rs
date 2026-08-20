use std::path::{Path, PathBuf};

/// Filesystem authority granted to one process execution.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SandboxMode {
    /// Host filesystem is visible but read-only; only ephemeral `/tmp` is
    /// writable.
    #[default]
    ReadOnly,
    /// `workspace_root` is writable; the rest of the host remains read-only.
    WorkspaceWrite,
    /// Explicitly bypass confinement and preserve the original spawn spec.
    DangerFullAccess,
}

/// Network namespace policy reserved as an explicit capability rather than an
/// implicit consequence of another sandbox mode.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum NetworkAccess {
    /// Keep the isolated network namespace created by `--unshare-all`.
    #[default]
    Deny,
    /// Re-share the host network namespace with `--share-net`.
    Allow,
}

/// Declarative sandbox input. Paths are canonicalized again immediately
/// before preparation so symlink escapes and stale paths fail closed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxPolicy {
    workspace_root: PathBuf,
    mode: SandboxMode,
    network: NetworkAccess,
    allowed_cwd_roots: Vec<PathBuf>,
}

impl SandboxPolicy {
    pub fn new(workspace_root: impl Into<PathBuf>, mode: SandboxMode) -> Self {
        Self {
            workspace_root: workspace_root.into(),
            mode,
            network: NetworkAccess::Deny,
            allowed_cwd_roots: Vec::new(),
        }
    }

    pub fn with_network(mut self, network: NetworkAccess) -> Self {
        self.network = network;
        self
    }

    /// Add an explicit read-only root under which a working directory may
    /// live. This does not grant write access in `WorkspaceWrite` mode.
    pub fn allow_cwd_root(mut self, root: impl Into<PathBuf>) -> Self {
        self.allowed_cwd_roots.push(root.into());
        self
    }

    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    pub const fn mode(&self) -> SandboxMode {
        self.mode
    }

    pub const fn network(&self) -> NetworkAccess {
        self.network
    }

    pub fn allowed_cwd_roots(&self) -> &[PathBuf] {
        &self.allowed_cwd_roots
    }
}

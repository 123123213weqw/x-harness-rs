use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
};

use async_trait::async_trait;

/// Exclusive ownership token for one live agent activation.
pub trait AgentLease: Send + Sync + 'static {
    fn agent_id(&self) -> &str;
}

#[derive(Debug, thiserror::Error)]
pub enum LeaseError {
    #[error("agent {agent_id:?} already has a live owner")]
    AlreadyOwned { agent_id: String },
    #[error("invalid agent id {agent_id:?}")]
    InvalidAgentId { agent_id: String },
    #[error("agent lease backend error: {message}")]
    Backend { message: String },
}

/// Backend that establishes a single live writer before an Agent is published.
#[async_trait]
pub trait LeaseManager: Send + Sync + 'static {
    async fn acquire(&self, agent_id: &str) -> Result<Box<dyn AgentLease>, LeaseError>;
}

/// Process-local lease provider used by embedding tests and ephemeral hosts.
#[derive(Clone, Default)]
pub struct MemoryLeaseManager {
    owned: Arc<StdMutex<HashSet<String>>>,
}

struct MemoryLease {
    agent_id: String,
    owned: Arc<StdMutex<HashSet<String>>>,
}

impl AgentLease for MemoryLease {
    fn agent_id(&self) -> &str {
        &self.agent_id
    }
}

impl Drop for MemoryLease {
    fn drop(&mut self) {
        if let Ok(mut owned) = self.owned.lock() {
            owned.remove(&self.agent_id);
        }
    }
}

#[async_trait]
impl LeaseManager for MemoryLeaseManager {
    async fn acquire(&self, agent_id: &str) -> Result<Box<dyn AgentLease>, LeaseError> {
        validate_agent_id(agent_id)?;
        let mut owned = self.owned.lock().map_err(|_| LeaseError::Backend {
            message: "memory lease table is poisoned".to_owned(),
        })?;
        if !owned.insert(agent_id.to_owned()) {
            return Err(LeaseError::AlreadyOwned {
                agent_id: agent_id.to_owned(),
            });
        }
        Ok(Box::new(MemoryLease {
            agent_id: agent_id.to_owned(),
            owned: Arc::clone(&self.owned),
        }))
    }
}

/// Cross-process local-filesystem lease provider for macOS and Linux hosts.
/// Advisory locks are automatically released when the owning process exits.
#[derive(Clone, Debug)]
pub struct FileLeaseManager {
    root: Arc<PathBuf>,
}

impl FileLeaseManager {
    pub fn new(root: impl AsRef<Path>) -> Result<Self, LeaseError> {
        fs::create_dir_all(root.as_ref()).map_err(|error| LeaseError::Backend {
            message: format!("could not create lease directory: {error}"),
        })?;
        let root = fs::canonicalize(root.as_ref()).map_err(|error| LeaseError::Backend {
            message: format!("could not canonicalize lease directory: {error}"),
        })?;
        Ok(Self {
            root: Arc::new(root),
        })
    }

    pub fn root(&self) -> &Path {
        self.root.as_path()
    }
}

struct FileLease {
    agent_id: String,
    file: File,
}

impl AgentLease for FileLease {
    fn agent_id(&self) -> &str {
        &self.agent_id
    }
}

impl Drop for FileLease {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.file);
    }
}

#[async_trait]
impl LeaseManager for FileLeaseManager {
    async fn acquire(&self, agent_id: &str) -> Result<Box<dyn AgentLease>, LeaseError> {
        validate_agent_id(agent_id)?;
        let owned_id = agent_id.to_owned();
        let path = self.root.join(format!("{agent_id}.agent.lock"));
        tokio::task::spawn_blocking(move || {
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(&path)
                .map_err(|error| LeaseError::Backend {
                    message: format!("could not open {}: {error}", path.display()),
                })?;
            match fs2::FileExt::try_lock_exclusive(&file) {
                Ok(()) => Ok(Box::new(FileLease {
                    agent_id: owned_id,
                    file,
                }) as Box<dyn AgentLease>),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    Err(LeaseError::AlreadyOwned { agent_id: owned_id })
                }
                Err(error) => Err(LeaseError::Backend {
                    message: format!("could not lock {}: {error}", path.display()),
                }),
            }
        })
        .await
        .map_err(|error| LeaseError::Backend {
            message: format!("lease worker failed: {error}"),
        })?
    }
}

fn validate_agent_id(agent_id: &str) -> Result<(), LeaseError> {
    let valid = !agent_id.is_empty()
        && agent_id.len() <= 200
        && !agent_id.starts_with('.')
        && agent_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
    if valid {
        Ok(())
    } else {
        Err(LeaseError::InvalidAgentId {
            agent_id: agent_id.to_owned(),
        })
    }
}

use std::{collections::HashMap, sync::Arc};

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use xharness_session::{EventData, SessionHeader, Store};

use crate::{
    AgentLease, AgentLifecycle, AgentPhase, AgentStatus, DurableInbox, InboxError, LeaseError,
    LeaseManager, LifecycleError,
};

/// Published, single-writer runtime relation for one durable session.
pub struct AgentActivation {
    id: String,
    inbox: DurableInbox,
    lifecycle: Mutex<AgentLifecycle>,
    cancellation: CancellationToken,
    _lease: Box<dyn AgentLease>,
}

impl AgentActivation {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn inbox(&self) -> &DurableInbox {
        &self.inbox
    }

    pub async fn phase(&self) -> AgentPhase {
        self.lifecycle.lock().await.phase()
    }

    pub async fn status(&self) -> AgentStatus {
        self.lifecycle.lock().await.status()
    }

    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    pub async fn reserve_driver(&self) -> Result<(), LifecycleError> {
        self.lifecycle.lock().await.reserve_driver()
    }

    pub async fn open_turn(&self) -> Result<u32, LifecycleError> {
        self.lifecycle.lock().await.open_turn()
    }

    pub async fn open_step(&self) -> Result<(u32, u32), LifecycleError> {
        self.lifecycle.lock().await.open_step()
    }

    pub async fn finish_driver(&self) -> Result<(), LifecycleError> {
        self.lifecycle.lock().await.finish_driver()
    }
}

impl Drop for AgentActivation {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error(transparent)]
    Lease(#[from] LeaseError),
    #[error(transparent)]
    Inbox(#[from] InboxError),
    #[error("agent registry is unavailable")]
    Unavailable,
}

/// Registry of live activations. Repeated opens return the exact same Agent;
/// independent processes are excluded by the configured lease provider.
pub struct AgentRegistry {
    store: Arc<dyn Store>,
    leases: Arc<dyn LeaseManager>,
    activations: Mutex<HashMap<String, std::sync::Weak<AgentActivation>>>,
}

impl AgentRegistry {
    pub fn new(store: Arc<dyn Store>, leases: Arc<dyn LeaseManager>) -> Self {
        Self {
            store,
            leases,
            activations: Mutex::new(HashMap::new()),
        }
    }

    /// Create or resume exactly one activation for `header.id`.
    pub async fn activate(
        &self,
        header: SessionHeader,
    ) -> Result<Arc<AgentActivation>, RegistryError> {
        let id = header.id.clone();
        let mut activations = self.activations.lock().await;
        if let Some(existing) = activations.get(&id).and_then(std::sync::Weak::upgrade) {
            return Ok(existing);
        }
        activations.retain(|_, activation| activation.strong_count() > 0);

        let lease = self.leases.acquire(&id).await?;
        let inbox = DurableInbox::open(Arc::clone(&self.store), header).await?;
        let session = self
            .store
            .load(&id)
            .await
            .map_err(InboxError::from)?
            .ok_or_else(|| InboxError::SessionDisappeared {
                session_id: id.clone(),
            })?;
        let last_turn = session
            .events()
            .iter()
            .rev()
            .find_map(|event| match event.data() {
                EventData::TurnStart { turn } => Some(*turn),
                _ => None,
            })
            .unwrap_or_default();
        let activation = Arc::new(AgentActivation {
            id: id.clone(),
            inbox,
            lifecycle: Mutex::new(AgentLifecycle::new(last_turn)),
            cancellation: CancellationToken::new(),
            _lease: lease,
        });
        activations.insert(id, Arc::downgrade(&activation));
        Ok(activation)
    }

    pub async fn get(&self, agent_id: &str) -> Option<Arc<AgentActivation>> {
        self.activations
            .lock()
            .await
            .get(agent_id)
            .and_then(std::sync::Weak::upgrade)
    }
}

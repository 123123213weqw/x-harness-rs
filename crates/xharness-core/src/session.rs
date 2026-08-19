use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use tokio::sync::RwLock;

use crate::{AgentMessage, SessionSnapshot};

#[async_trait]
pub trait SessionStore: Send + Sync + 'static {
    async fn load(&self, session_id: &str) -> Result<Option<SessionSnapshot>, String>;
    async fn save(&self, session_id: &str, snapshot: SessionSnapshot) -> Result<(), String>;
}

#[derive(Clone, Default)]
pub struct MemorySessionStore {
    snapshots: Arc<RwLock<HashMap<String, SessionSnapshot>>>,
}

#[async_trait]
impl SessionStore for MemorySessionStore {
    async fn load(&self, session_id: &str) -> Result<Option<SessionSnapshot>, String> {
        Ok(self.snapshots.read().await.get(session_id).cloned())
    }

    async fn save(&self, session_id: &str, snapshot: SessionSnapshot) -> Result<(), String> {
        self.snapshots
            .write()
            .await
            .insert(session_id.to_owned(), snapshot);
        Ok(())
    }
}

#[async_trait]
pub trait ContextPolicy: Send + Sync + 'static {
    async fn prepare(&self, messages: &[AgentMessage]) -> Result<Vec<AgentMessage>, String>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct IdentityContextPolicy;

#[async_trait]
impl ContextPolicy for IdentityContextPolicy {
    async fn prepare(&self, messages: &[AgentMessage]) -> Result<Vec<AgentMessage>, String> {
        Ok(messages.to_vec())
    }
}

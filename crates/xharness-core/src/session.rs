use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use tokio::sync::RwLock;

use crate::SessionSnapshot;

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

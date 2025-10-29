use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use tokio::sync::RwLock;

use crate::{
    AppendReceipt, Revision, Session, SessionError, SessionEvent, SessionHeader, SessionInspection,
};

/// Storage failures with stable ownership and CAS diagnostics.
#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum StoreError {
    #[error("invalid session id {session_id:?}")]
    InvalidSessionId { session_id: String },
    #[error("session {session_id:?} already exists")]
    AlreadyExists { session_id: String },
    #[error("session {session_id:?} was not found")]
    NotFound { session_id: String },
    #[error("session {session_id:?} revision conflict: expected {expected:?}, actual {actual:?}")]
    RevisionConflict {
        session_id: String,
        expected: Revision,
        actual: Revision,
    },
    #[error("session storage backend error: {message}")]
    Backend { message: String },
    #[error(transparent)]
    InvalidSession(#[from] SessionError),
}

/// Durable append-only storage seam.
#[async_trait]
pub trait Store: Send + Sync + 'static {
    /// Enumerate every durable session known to this store.
    ///
    /// Implementations must return headers in ascending session-id order and
    /// validate each discovered record before publishing it. This is the
    /// startup discovery seam used by Hosts to rebuild projections after a
    /// process restart; silently skipping a corrupt session would make
    /// durable work disappear from the product surface.
    async fn list_headers(&self) -> Result<Vec<SessionHeader>, StoreError>;

    /// Atomically register an empty session. Existing ids are never replaced.
    async fn create(&self, header: SessionHeader) -> Result<Session, StoreError>;

    /// Load one complete logical snapshot.
    async fn load(&self, session_id: &str) -> Result<Option<Session>, StoreError>;

    /// Atomically append a batch iff `expected_revision` is still current.
    async fn append(
        &self,
        session_id: &str,
        expected_revision: Revision,
        events: Vec<SessionEvent>,
    ) -> Result<AppendReceipt, StoreError>;

    /// Durability barrier for everything accepted before this call.
    async fn flush(&self, session_id: &str) -> Result<Revision, StoreError>;

    /// Read an unpublished logical cut suitable for diagnostics and recovery.
    async fn inspect(&self, session_id: &str) -> Result<Option<SessionInspection>, StoreError>;
}

/// In-process Store implementation. The per-store write lock makes revision
/// comparison and append one atomic operation; returned snapshots are detached
/// clones and cannot mutate the authoritative log.
#[derive(Clone, Default)]
pub struct MemorySessionStore {
    sessions: Arc<RwLock<HashMap<String, Session>>>,
}

#[async_trait]
impl Store for MemorySessionStore {
    async fn list_headers(&self) -> Result<Vec<SessionHeader>, StoreError> {
        let mut headers = self
            .sessions
            .read()
            .await
            .values()
            .map(|session| session.header().clone())
            .collect::<Vec<_>>();
        headers.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(headers)
    }

    async fn create(&self, header: SessionHeader) -> Result<Session, StoreError> {
        let session = Session::new(header)?;
        let mut sessions = self.sessions.write().await;
        if sessions.contains_key(&session.header().id) {
            return Err(StoreError::AlreadyExists {
                session_id: session.header().id.clone(),
            });
        }
        sessions.insert(session.header().id.clone(), session.clone());
        Ok(session)
    }

    async fn load(&self, session_id: &str) -> Result<Option<Session>, StoreError> {
        Ok(self.sessions.read().await.get(session_id).cloned())
    }

    async fn append(
        &self,
        session_id: &str,
        expected_revision: Revision,
        events: Vec<SessionEvent>,
    ) -> Result<AppendReceipt, StoreError> {
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| StoreError::NotFound {
                session_id: session_id.to_owned(),
            })?;
        if session.revision() != expected_revision {
            return Err(StoreError::RevisionConflict {
                session_id: session_id.to_owned(),
                expected: expected_revision,
                actual: session.revision(),
            });
        }
        session
            .append_batch(expected_revision, events)
            .map_err(StoreError::from)
    }

    async fn flush(&self, session_id: &str) -> Result<Revision, StoreError> {
        self.sessions
            .read()
            .await
            .get(session_id)
            .map(Session::revision)
            .ok_or_else(|| StoreError::NotFound {
                session_id: session_id.to_owned(),
            })
    }

    async fn inspect(&self, session_id: &str) -> Result<Option<SessionInspection>, StoreError> {
        Ok(self
            .sessions
            .read()
            .await
            .get(session_id)
            .map(Session::inspect))
    }
}

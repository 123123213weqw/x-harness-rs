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
    /// Persist the exact tool-returned envelope before publishing a reduced result.
    /// Implementations must not return a reference until publication succeeds.
    async fn archive_tool_result(
        &self,
        _session_id: &str,
        _text: &str,
    ) -> Result<crate::ToolArchiveRef, StoreError> {
        Err(StoreError::Backend {
            message: "tool result archival is not supported by this store".into(),
        })
    }

    /// Only read within this session's namespace; never accept a filesystem path.
    async fn tool_result_archive(
        &self,
        _session_id: &str,
        _key: &str,
    ) -> Result<Option<String>, StoreError> {
        Err(StoreError::Backend {
            message: "tool result archival is not supported by this store".into(),
        })
    }

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

    /// Store request audit data outside the hot journal when supported.
    /// This never changes the messages delivered to the provider.
    async fn archive_request(
        &self,
        header: crate::RequestHeader,
    ) -> Result<crate::RequestHeader, StoreError> {
        Ok(header)
    }

    /// Explicit, on-demand audit lookup, not part of ordinary history replay.
    async fn request_header(
        &self,
        session_id: &str,
        seq: u64,
    ) -> Result<Option<crate::RequestHeader>, StoreError> {
        Ok(self.load(session_id).await?.and_then(|s| {
            s.events().iter().find_map(|e| {
                if e.seq == seq {
                    if let crate::EventData::RequestHeader { header } = e.data() {
                        return Some(header.clone());
                    }
                }
                None
            })
        }))
    }

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
    tool_archives: Arc<RwLock<HashMap<(String, String), String>>>,
}

#[async_trait]
impl Store for MemorySessionStore {
    async fn archive_tool_result(
        &self,
        session_id: &str,
        text: &str,
    ) -> Result<crate::ToolArchiveRef, StoreError> {
        if !self.sessions.read().await.contains_key(session_id) {
            return Err(StoreError::NotFound {
                session_id: session_id.into(),
            });
        }
        let reference = crate::ToolArchiveRef::for_text(text)?;
        self.tool_archives
            .write()
            .await
            .insert((session_id.into(), reference.sha256.clone()), text.into());
        Ok(reference)
    }

    async fn tool_result_archive(
        &self,
        session_id: &str,
        key: &str,
    ) -> Result<Option<String>, StoreError> {
        crate::ToolArchiveRef::validate_key(key)?;
        Ok(self
            .tool_archives
            .read()
            .await
            .get(&(session_id.into(), key.into()))
            .cloned())
    }

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

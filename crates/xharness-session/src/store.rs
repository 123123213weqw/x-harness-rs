use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use tokio::sync::{mpsc, RwLock};

use crate::{
    AppendReceipt, LoggedEvent, Revision, Session, SessionError, SessionEvent, SessionHeader,
    SessionInspection,
};

/// Read-only presentation cut, never an executable/recovery Session. Context
/// contains only out-of-window dependencies (inbox provenance, compaction
/// origin and tool calls). Sequence numbers are the original journal cursors.
#[derive(Clone, Debug)]
pub struct SessionHistoryWindow {
    pub next_seq: u64,
    pub has_more: bool,
    pub events: Vec<LoggedEvent>,
    pub context: Vec<LoggedEvent>,
    pub initial_request_header_seq: Option<u64>,
    pub completed_steps: Vec<(u32, u32)>,
}

/// Disposable application-owned recovery projection, not a partial `Session`.
/// Execution and model history MUST still use `Store::load`. The schema belongs
/// to the projection owner; a mismatched schema is a cache miss.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionRecoveryCheckpoint {
    pub schema: String,
    pub header: SessionHeader,
    pub next_seq: u64,
    pub revision: Revision,
    pub state: serde_json::Value,
}

/// Source-bound checkpoint plus a bounded, contiguous suffix. The suffix has
/// physical/CAS integrity checks, NOT full Session semantic validation. Its
/// owner must reject unsupported transitions and fall back to `load`.
#[derive(Clone, Debug)]
pub struct SessionRecoveryTail {
    pub checkpoint: SessionRecoveryCheckpoint,
    pub events: Vec<LoggedEvent>,
    pub next_seq: u64,
    pub revision: Revision,
}

/// Rebuildable, bounded catalogue projection. The journal remains authoritative.
/// A disk store returns this only when its recorded file identity still matches
/// the journal; a missing or stale entry is an unknown state, never "idle".
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCatalogEntry {
    pub header: SessionHeader,
    pub updated_at_ms: u64,
    pub title: Option<String>,
    pub agent_preset: Option<String>,
    pub parent_session_id: Option<String>,
    pub origin: Option<String>,
    pub model_provider: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub context_window_tokens: Option<u64>,
    pub permission_preset: String,
    pub plan_active: bool,
    pub blank: bool,
    pub next_seq: u64,
    /// Includes any pending input, approval, question, interrupted work, or
    /// runtime background work. False is safe only with a matching fingerprint.
    pub needs_recovery: bool,
    /// Versioned public metric views only (no text, prompts, or per-step fold
    /// state). Old catalogues omit this and are repaired after Host readiness.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric_snapshot: Option<serde_json::Value>,
}

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

/// One directory entry that a tolerant startup scan found but could not
/// publish as a [`SessionHeader`].
///
/// The session id is reported whenever the entry's name could denote a session
/// at all, so an operator can locate the offending file. `reason` is the
/// store's own diagnostic text and is shown verbatim.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreadableSession {
    pub session_id: String,
    pub reason: String,
}

/// A single startup discovery result. Streaming these lets the Host become
/// usable before an arbitrarily large legacy directory has been inspected.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StartupCandidate {
    Header(SessionHeader),
    Unreadable(UnreadableSession),
}

/// Durable append-only storage seam.
#[async_trait]
pub trait Store: Send + Sync + 'static {
    /// Optional read-only acceleration. None (including corruption, a torn
    /// tail or exceeded acceleration budget) requires authoritative full replay.
    async fn recovery_tail(
        &self,
        _session_id: &str,
        _schema: &str,
    ) -> Result<Option<SessionRecoveryTail>, StoreError> {
        Ok(None)
    }

    /// Publish only against an exact source already validated by this Store.
    /// Failures must not invalidate or mutate the authoritative journal.
    async fn publish_recovery_checkpoint(
        &self,
        _checkpoint: SessionRecoveryCheckpoint,
    ) -> Result<(), StoreError> {
        Ok(())
    }

    /// Optional bounded historical read at an already projected cursor. None
    /// means unsupported, stale, damaged, too wide or a preferred warm-cache
    /// path: callers MUST use their
    /// existing authoritative history path, not fabricate an empty page.
    async fn history_window(
        &self,
        _session_id: &str,
        _expected_next_seq: u64,
        _before_seq: Option<u64>,
        _max_messages: usize,
    ) -> Result<Option<SessionHistoryWindow>, StoreError> {
        Ok(None)
    }

    /// Optional fast catalogue lookup. None means missing/stale/unusable and
    /// must never be interpreted as proof that no work needs recovery.
    async fn catalog_entry(
        &self,
        _session_id: &str,
    ) -> Result<Option<SessionCatalogEntry>, StoreError> {
        Ok(None)
    }

    /// Best-effort rebuildable index publication after a verified full replay.
    async fn publish_catalog_entry(&self, _entry: SessionCatalogEntry) -> Result<(), StoreError> {
        Ok(())
    }

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
    /// strict discovery seam used by callers that require fully validated
    /// journals; silently skipping a corrupt session would make durable work
    /// disappear from the product surface.
    ///
    /// Failing closed is required for anything that may still hold durable
    /// work. Implementations may skip only entries that provably carry none
    /// and that the store can never address anyway, such as a zero-byte
    /// crash residue left between `create` and the header write, or a
    /// directory entry whose name cannot denote a session id. One writer
    /// artifact must never make every healthy session undiscoverable.
    async fn list_headers(&self) -> Result<Vec<SessionHeader>, StoreError>;

    /// Tolerant variant of [`Store::list_headers`] for Host startup.
    ///
    /// Publishes every session that can be read and *reports* the ones that
    /// cannot, instead of failing the whole enumeration. A Host uses this to
    /// keep healthy sessions visible while recording the rest as a non-fatal
    /// startup issue, which is what turns "unreadable entry" from "product does
    /// not start" into "product starts and says what it skipped".
    ///
    /// Implementations must never drop an unreadable entry silently: anything
    /// not returned in the header list has to appear in the unreadable list.
    /// The default implementation keeps the strict [`Store::list_headers`]
    /// contract, so stores that cannot distinguish the two cases fail closed.
    async fn scan_sessions(
        &self,
    ) -> Result<(Vec<SessionHeader>, Vec<UnreadableSession>), StoreError> {
        Ok((self.list_headers().await?, Vec::new()))
    }

    /// Startup candidate enumeration. A disk store may validate only the
    /// immutable header here, avoiding a second full replay of every journal.
    /// The Host MUST call `load` for each candidate before publishing it and
    /// report a failed load as an unreadable session. Stores without a cheap
    /// header read retain the fully validated `scan_sessions` behavior.
    async fn scan_startup_candidates(
        &self,
    ) -> Result<(Vec<SessionHeader>, Vec<UnreadableSession>), StoreError> {
        self.scan_sessions().await
    }

    /// Incremental startup discovery. Disk stores should override this so a
    /// slow or damaged journal cannot hide already discovered conversations.
    /// The default retains compatibility with other Store implementations.
    async fn stream_startup_candidates(
        &self,
        sender: mpsc::Sender<StartupCandidate>,
    ) -> Result<(), StoreError> {
        let (headers, unreadable) = self.scan_startup_candidates().await?;
        for header in headers {
            if sender.send(StartupCandidate::Header(header)).await.is_err() {
                return Ok(());
            }
        }
        for entry in unreadable {
            if sender
                .send(StartupCandidate::Unreadable(entry))
                .await
                .is_err()
            {
                return Ok(());
            }
        }
        Ok(())
    }

    /// Atomically register an empty session. Existing ids are never replaced.
    async fn create(&self, header: SessionHeader) -> Result<Session, StoreError>;

    /// Load one complete logical snapshot.
    async fn load(&self, session_id: &str) -> Result<Option<Session>, StoreError>;

    /// Idempotently remove the journal and per-session sidecars. The Host must
    /// durably tombstone the id and stop all writers before calling this.
    async fn delete_session_data(&self, session_id: &str) -> Result<(), StoreError> {
        Err(StoreError::Backend {
            message: format!("session deletion is unsupported for {session_id:?}"),
        })
    }

    /// Whether the caller must materialize a full request envelope for audit.
    /// Stores retaining the original header keep the compatible default.
    fn captures_full_request_audit(&self) -> bool {
        true
    }

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

    async fn delete_session_data(&self, session_id: &str) -> Result<(), StoreError> {
        self.sessions.write().await.remove(session_id);
        self.tool_archives
            .write()
            .await
            .retain(|(id, _), _| id != session_id);
        Ok(())
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

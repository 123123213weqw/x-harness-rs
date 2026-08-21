use std::collections::HashSet;
use std::sync::Arc;

use tokio::sync::Mutex;
use xharness_session::{
    AppendReceipt, EventData, InboxMessage, InboxSpliceOutcome, InboxTarget, Revision, Session,
    SessionEvent, SessionHeader, Store, StoreError,
};

const MAX_CAS_RETRIES: usize = 16;

/// Read-only projection reconstructed exclusively from inbox splice events.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct InboxProjection {
    next_turn: Vec<InboxMessage>,
    next_step: Vec<InboxMessage>,
}

impl InboxProjection {
    /// Replay a validated session snapshot into its two pending-input lists.
    pub fn from_session(session: &Session) -> Result<Self, InboxError> {
        let mut projection = Self::default();
        for logged in session.events() {
            if let EventData::AgentInboxSpliced {
                target,
                start,
                removed_count,
                inserted,
                ..
            } = logged.data()
            {
                projection.apply(*target, *start, *removed_count, inserted.clone())?;
            }
        }
        Ok(projection)
    }

    pub fn next_turn(&self) -> &[InboxMessage] {
        &self.next_turn
    }

    pub fn next_step(&self) -> &[InboxMessage] {
        &self.next_step
    }

    pub fn has_pending(&self) -> bool {
        !self.next_turn.is_empty() || !self.next_step.is_empty()
    }

    fn list(&self, target: InboxTarget) -> &[InboxMessage] {
        match target {
            InboxTarget::NextTurn => &self.next_turn,
            InboxTarget::NextStep => &self.next_step,
        }
    }

    fn apply(
        &mut self,
        target: InboxTarget,
        start: usize,
        removed_count: usize,
        inserted: Vec<InboxMessage>,
    ) -> Result<Vec<InboxMessage>, InboxError> {
        let list = match target {
            InboxTarget::NextTurn => &mut self.next_turn,
            InboxTarget::NextStep => &mut self.next_step,
        };
        let end = start
            .checked_add(removed_count)
            .ok_or(InboxError::ProjectionCorrupt)?;
        if start > list.len() || end > list.len() {
            return Err(InboxError::ProjectionCorrupt);
        }
        Ok(list.splice(start..end, inserted).collect())
    }

    fn locate(&self, message_id: &str) -> Option<(InboxTarget, usize)> {
        for target in [InboxTarget::NextTurn, InboxTarget::NextStep] {
            if let Some(index) = self
                .list(target)
                .iter()
                .position(|message| message.id == message_id)
            {
                return Some((target, index));
            }
        }
        None
    }
}

/// A claim proposal bound to one exact session revision.
///
/// The deletion events must be committed atomically with the turn/step facts
/// that consume `messages`; otherwise a crash could remove input without
/// recording where it went.
#[derive(Clone, Debug)]
pub struct PreparedClaim {
    pub expected_revision: Revision,
    pub messages: Vec<InboxMessage>,
    deletion_events: Vec<SessionEvent>,
}

impl PreparedClaim {
    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    /// Split the claim for a Loop request whose journal start commits the
    /// deletion events beside `turn/start` and the returned messages.
    pub fn into_loop_parts(self) -> (Revision, Vec<InboxMessage>, Vec<SessionEvent>) {
        (self.expected_revision, self.messages, self.deletion_events)
    }
}

/// Result of atomically transferring pending messages into a durable turn.
#[derive(Clone, Debug)]
pub struct ClaimReceipt {
    pub messages: Vec<InboxMessage>,
    pub append: AppendReceipt,
}

#[derive(Debug, thiserror::Error)]
pub enum InboxError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("session {session_id:?} disappeared")]
    SessionDisappeared { session_id: String },
    #[error("inbox message id must not be empty")]
    EmptyMessageId,
    #[error("inbox message {message_id:?} is already pending")]
    DuplicateMessage { message_id: String },
    #[error("inbox projection is inconsistent with the validated session log")]
    ProjectionCorrupt,
    #[error("inbox mutation could not converge after {attempts} revision conflicts")]
    Contended { attempts: usize },
}

/// Durable, replayable inbox for one session.
///
/// Mutations are serialized per handle and use Store CAS for independent
/// handles/processes. Every accepted public mutation is flushed before return.
#[derive(Clone)]
pub struct DurableInbox {
    session_id: String,
    store: Arc<dyn Store>,
    local_gate: Arc<Mutex<()>>,
}

impl DurableInbox {
    /// Open an existing session or atomically create it from `header`.
    pub async fn open(store: Arc<dyn Store>, header: SessionHeader) -> Result<Self, InboxError> {
        let session_id = header.id.clone();
        match store.load(&session_id).await? {
            Some(_) => {}
            None => match store.create(header).await {
                Ok(_) | Err(StoreError::AlreadyExists { .. }) => {}
                Err(error) => return Err(error.into()),
            },
        }
        Ok(Self {
            session_id,
            store,
            local_gate: Arc::new(Mutex::new(())),
        })
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn store(&self) -> Arc<dyn Store> {
        Arc::clone(&self.store)
    }

    pub async fn snapshot(&self) -> Result<InboxProjection, InboxError> {
        let session = self.load().await?;
        InboxProjection::from_session(&session)
    }

    /// Append a new identified message to one pending list.
    pub async fn append(
        &self,
        target: InboxTarget,
        message: InboxMessage,
    ) -> Result<AppendReceipt, InboxError> {
        self.insert_at(target, InsertPosition::Back, message).await
    }

    /// Prepend a new identified message to one pending list.
    pub async fn prepend(
        &self,
        target: InboxTarget,
        message: InboxMessage,
    ) -> Result<AppendReceipt, InboxError> {
        self.insert_at(target, InsertPosition::Front, message).await
    }

    /// Replace a still-pending message in place.
    pub async fn replace(
        &self,
        message_id: &str,
        replacement: InboxMessage,
    ) -> Result<Option<AppendReceipt>, InboxError> {
        self.mutate(|projection| {
            let Some((target, index)) = projection.locate(message_id) else {
                return Ok(None);
            };
            validate_insert(projection, &replacement, Some(message_id))?;
            Ok(Some(splice(
                target,
                index,
                1,
                vec![replacement.clone()],
                Some(InboxSpliceOutcome::Cancelled),
            )))
        })
        .await
    }

    /// Cancel a still-pending message.
    pub async fn remove(&self, message_id: &str) -> Result<Option<AppendReceipt>, InboxError> {
        self.mutate(|projection| {
            Ok(projection.locate(message_id).map(|(target, index)| {
                splice(
                    target,
                    index,
                    1,
                    Vec::new(),
                    Some(InboxSpliceOutcome::Cancelled),
                )
            }))
        })
        .await
    }

    /// Cancel all next-step work before ordinary queued turns, matching the
    /// upstream agent's observable mutation order.
    pub async fn clear(&self) -> Result<Vec<AppendReceipt>, InboxError> {
        let mut receipts = Vec::new();
        for target in [InboxTarget::NextStep, InboxTarget::NextTurn] {
            if let Some(receipt) = self
                .mutate(|projection| {
                    let count = projection.list(target).len();
                    Ok((count > 0).then(|| {
                        splice(
                            target,
                            0,
                            count,
                            Vec::new(),
                            Some(InboxSpliceOutcome::Cancelled),
                        )
                    }))
                })
                .await?
            {
                receipts.push(receipt);
            }
        }
        Ok(receipts)
    }

    /// Remove pending identities that already have a durable `user/message`.
    /// This closes the crash window where a live steering message reached its
    /// model step but the later inbox deletion did not execute.
    pub async fn reconcile_consumed(&self) -> Result<Option<AppendReceipt>, InboxError> {
        let _guard = self.local_gate.lock().await;
        for _ in 0..MAX_CAS_RETRIES {
            let session = self.load().await?;
            let consumed = session
                .events()
                .iter()
                .filter_map(|event| match event.data() {
                    EventData::UserMessage { message } => message.id.as_deref(),
                    _ => None,
                })
                .collect::<HashSet<_>>();
            let projection = InboxProjection::from_session(&session)?;
            let mut events = Vec::new();
            for target in [InboxTarget::NextStep, InboxTarget::NextTurn] {
                // Delete from the back so each recorded splice remains valid
                // after all earlier events in this same batch are applied.
                for index in (0..projection.list(target).len()).rev() {
                    if consumed.contains(projection.list(target)[index].id.as_str()) {
                        events.push(splice(target, index, 1, Vec::new(), None));
                    }
                }
            }
            if events.is_empty() {
                return Ok(None);
            }
            match self
                .store
                .append(&self.session_id, session.revision(), events)
                .await
            {
                Ok(receipt) => {
                    self.store.flush(&self.session_id).await?;
                    return Ok(Some(receipt));
                }
                Err(StoreError::RevisionConflict { .. }) => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(InboxError::Contended {
            attempts: MAX_CAS_RETRIES,
        })
    }

    /// Prepare the complete batch for a model step without mutating storage.
    /// Next-step messages are ordered before at most one next-turn message.
    pub async fn prepare_claim(&self, target: InboxTarget) -> Result<PreparedClaim, InboxError> {
        let _guard = self.local_gate.lock().await;
        let session = self.load().await?;
        let projection = InboxProjection::from_session(&session)?;
        let mut messages = projection.next_step.clone();
        let mut deletion_events = Vec::new();
        if !projection.next_step.is_empty() {
            deletion_events.push(splice(
                InboxTarget::NextStep,
                0,
                projection.next_step.len(),
                Vec::new(),
                None,
            ));
        }
        if target == InboxTarget::NextTurn {
            if let Some(message) = projection.next_turn.first() {
                messages.push(message.clone());
                deletion_events.push(splice(InboxTarget::NextTurn, 0, 1, Vec::new(), None));
            }
        }
        Ok(PreparedClaim {
            expected_revision: session.revision(),
            messages,
            deletion_events,
        })
    }

    /// Atomically commit a prepared claim with its consuming lifecycle facts.
    /// The claim deletions are placed between caller-supplied prefix/suffix.
    pub async fn commit_claim(
        &self,
        claim: PreparedClaim,
        mut prefix: Vec<SessionEvent>,
        suffix: Vec<SessionEvent>,
    ) -> Result<ClaimReceipt, InboxError> {
        let _guard = self.local_gate.lock().await;
        prefix.extend(claim.deletion_events);
        prefix.extend(suffix);
        let append = self
            .store
            .append(&self.session_id, claim.expected_revision, prefix)
            .await?;
        self.store.flush(&self.session_id).await?;
        Ok(ClaimReceipt {
            messages: claim.messages,
            append,
        })
    }

    async fn insert_at(
        &self,
        target: InboxTarget,
        position: InsertPosition,
        message: InboxMessage,
    ) -> Result<AppendReceipt, InboxError> {
        self.mutate(|projection| {
            validate_insert(projection, &message, None)?;
            let start = match position {
                InsertPosition::Front => 0,
                InsertPosition::Back => projection.list(target).len(),
            };
            Ok(Some(splice(target, start, 0, vec![message.clone()], None)))
        })
        .await?
        .ok_or(InboxError::ProjectionCorrupt)
    }

    async fn mutate<F>(&self, mut build: F) -> Result<Option<AppendReceipt>, InboxError>
    where
        F: FnMut(&InboxProjection) -> Result<Option<SessionEvent>, InboxError>,
    {
        let _guard = self.local_gate.lock().await;
        for _ in 0..MAX_CAS_RETRIES {
            let session = self.load().await?;
            let projection = InboxProjection::from_session(&session)?;
            let Some(event) = build(&projection)? else {
                return Ok(None);
            };
            match self
                .store
                .append(&self.session_id, session.revision(), vec![event])
                .await
            {
                Ok(receipt) => {
                    self.store.flush(&self.session_id).await?;
                    return Ok(Some(receipt));
                }
                Err(StoreError::RevisionConflict { .. }) => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(InboxError::Contended {
            attempts: MAX_CAS_RETRIES,
        })
    }

    async fn load(&self) -> Result<Session, InboxError> {
        self.store
            .load(&self.session_id)
            .await?
            .ok_or_else(|| InboxError::SessionDisappeared {
                session_id: self.session_id.clone(),
            })
    }
}

#[derive(Clone, Copy)]
enum InsertPosition {
    Front,
    Back,
}

fn validate_insert(
    projection: &InboxProjection,
    message: &InboxMessage,
    replacing: Option<&str>,
) -> Result<(), InboxError> {
    if message.id.is_empty() {
        return Err(InboxError::EmptyMessageId);
    }
    if projection.locate(&message.id).is_some() && replacing != Some(message.id.as_str()) {
        return Err(InboxError::DuplicateMessage {
            message_id: message.id.clone(),
        });
    }
    Ok(())
}

fn splice(
    target: InboxTarget,
    start: usize,
    removed_count: usize,
    inserted: Vec<InboxMessage>,
    outcome: Option<InboxSpliceOutcome>,
) -> SessionEvent {
    EventData::AgentInboxSpliced {
        target,
        start,
        removed_count,
        inserted,
        outcome,
    }
    .into()
}

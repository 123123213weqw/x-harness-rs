//! Durable original control receipts under the existing Schedule owner gate.
use super::automation::settings;
use super::*;
use serde::{Deserialize, Serialize};
use xharness_session::SessionMutationReceipt;
pub const CONTROL_RECEIPT_METHOD: &str = "remote.automation.control.v1";
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum SavedAutomationControl {
    Pause { id: String },
    Resume { id: String },
    Delete { id: String },
}
impl SavedAutomationControl {
    pub fn id(&self) -> &str {
        match self {
            Self::Pause { id } | Self::Resume { id } | Self::Delete { id } => id,
        }
    }
    fn state(&self) -> SavedAutomationState {
        match self {
            Self::Pause { .. } => SavedAutomationState::Paused,
            Self::Resume { .. } => SavedAutomationState::Enabled,
            Self::Delete { .. } => SavedAutomationState::Deleted,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SavedAutomationState {
    Paused,
    Enabled,
    Deleted,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedAutomationApplied {
    pub id: String,
    pub state: SavedAutomationState,
}
#[derive(Clone, Debug)]
pub struct SavedAutomationInvocation {
    pub invocation: String,
    pub fingerprint: String,
    pub control: SavedAutomationControl,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SavedAutomationError {
    #[error("saved automation control invalid")]
    Invalid,
    #[error("saved automation control conflict")]
    Conflict,
    #[error("saved automation is not active")]
    NotActive,
    #[error("saved automation control capacity")]
    Capacity,
    #[error("saved automation control unavailable")]
    Unavailable,
}
impl SavedAutomationInvocation {
    fn valid(&self) -> bool {
        self.invocation
            .strip_prefix("remote-automation-")
            .is_some_and(|k| {
                k.len() == 64
                    && k.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            && self.fingerprint.len() == 64
            && self
                .fingerprint
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && !self.control.id().is_empty()
            && self.control.id().len() <= 512
            && !self.control.id().chars().any(char::is_control)
    }
}
fn original(
    session: &Session,
    r: &SavedAutomationInvocation,
) -> Result<Option<SavedAutomationApplied>, SavedAutomationError> {
    let receipts: Vec<_> = session
        .events()
        .iter()
        .filter_map(|e| match e.data() {
            EventData::SessionMutationCommitted { receipt } if receipt.rpc_id == r.invocation => {
                Some(receipt)
            }
            _ => None,
        })
        .collect();
    if receipts.is_empty() {
        return Ok(None);
    }
    if receipts.len() != 1 {
        return Err(SavedAutomationError::Conflict);
    }
    let receipt = receipts[0];
    if receipt.method != CONTROL_RECEIPT_METHOD
        || receipt.fingerprint != r.fingerprint
        || receipt.response_event_seq_field.is_some()
    {
        return Err(SavedAutomationError::Conflict);
    }
    let applied: SavedAutomationApplied = serde_json::from_value(receipt.response.clone())
        .map_err(|_| SavedAutomationError::Conflict)?;
    if applied.id != r.control.id() || applied.state != r.control.state() {
        return Err(SavedAutomationError::Conflict);
    }
    Ok(Some(applied))
}
async fn certify(owner: &ScheduleOwner, session: &Session) -> Result<(), SavedAutomationError> {
    let flushed = owner
        .store
        .flush(&owner.session_id)
        .await
        .map_err(|_| SavedAutomationError::Unavailable)?;
    if flushed < session.revision() {
        return Err(SavedAutomationError::Unavailable);
    }
    Ok(())
}
impl ScheduleManager {
    /// Read only the original native fact; never execute, notify, or adopt current state.
    pub async fn saved_control_receipt(
        &self,
        session_id: &str,
        r: &SavedAutomationInvocation,
    ) -> Result<Option<SavedAutomationApplied>, SavedAutomationError> {
        let _life = self.control_lifetime.read().await;
        if self.closed.load(Ordering::Acquire) {
            return Err(SavedAutomationError::Unavailable);
        }
        if !r.valid() {
            return Err(SavedAutomationError::Invalid);
        }
        let owner = self
            .owner(session_id)
            .await
            .map_err(|_| SavedAutomationError::Unavailable)?;
        let _guard = owner.transaction.lock().await;
        let session = load_session(&owner.store, session_id)
            .await
            .map_err(|_| SavedAutomationError::Unavailable)?;
        let result = original(&session, r)?;
        certify(&owner, &session).await?;
        Ok(result)
    }
    /// Own the admitted writer independently of its waiter; no new timer or model loop.
    pub async fn saved_control_once(
        self: &Arc<Self>,
        session_id: &str,
        r: SavedAutomationInvocation,
    ) -> Result<SavedAutomationApplied, SavedAutomationError> {
        if !r.valid() {
            return Err(SavedAutomationError::Invalid);
        }
        let life = self.control_lifetime.clone().read_owned().await;
        if self.closed.load(Ordering::Acquire) {
            return Err(SavedAutomationError::Unavailable);
        }
        let slot = self
            .saved_control_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| SavedAutomationError::Capacity)?;
        let manager = self.clone();
        let session_id = session_id.to_owned();
        tokio::spawn(async move {
            let _life = life;
            let _slot = slot;
            manager.saved_control_inner(&session_id, r).await
        })
        .await
        .map_err(|_| SavedAutomationError::Unavailable)?
    }
    async fn saved_control_inner(
        &self,
        session_id: &str,
        r: SavedAutomationInvocation,
    ) -> Result<SavedAutomationApplied, SavedAutomationError> {
        if !r.valid() {
            return Err(SavedAutomationError::Invalid);
        }
        let owner = self
            .owner(session_id)
            .await
            .map_err(|_| SavedAutomationError::Unavailable)?;
        let _guard = owner.transaction.lock().await;
        for _ in 0..MAX_CAS_RETRIES {
            let pending = { owner.pending_dispatches.lock().await.clone() };
            if let Some(changes) = pending {
                owner
                    .append_dispatches(changes)
                    .await
                    .map_err(|_| SavedAutomationError::Unavailable)?;
                *owner.pending_dispatches.lock().await = None;
            }
            let session = load_session(&owner.store, session_id)
                .await
                .map_err(|_| SavedAutomationError::Unavailable)?;
            certify(&owner, &session).await?;
            if let Some(applied) = original(&session, &r)? {
                return Ok(applied);
            }
            let folded =
                fold_schedule_events(&session).map_err(|_| SavedAutomationError::Unavailable)?;
            let Some(mut record) = folded
                .active
                .iter()
                .find(|x| x.id == r.control.id())
                .cloned()
            else {
                return Err(SavedAutomationError::NotActive);
            };
            // Same reservation reconciliation as normal Schedule controls: an accepted
            // run is recorded, never cancelled; pause keeps an unadmitted reservation.
            if let Some((run, accepted_at)) = folded
                .pending_runs
                .iter()
                .find(|(run, _)| run.schedule_id == r.control.id())
            {
                let target = owner
                    .store
                    .load(&run.session_id)
                    .await
                    .map_err(|_| SavedAutomationError::Unavailable)?;
                if target
                    .as_ref()
                    .is_some_and(|s| message_seen(s, &run.run_id))
                {
                    owner
                        .append_dispatches(vec![ScheduleChange::Run {
                            version: 1,
                            run: run.clone(),
                            accepted_at: accepted_at.clone(),
                        }])
                        .await
                        .map_err(|_| SavedAutomationError::Unavailable)?;
                    continue;
                }
            }
            let change = match &r.control {
                SavedAutomationControl::Delete { id } => ScheduleChange::Delete {
                    version: 1,
                    id: id.clone(),
                },
                operation => {
                    let had_config = record.automation.is_some();
                    let mut config = settings(&record);
                    if config.target == AutomationTarget::NewChat && self.targets.get().is_none() {
                        return Err(SavedAutomationError::Unavailable);
                    }
                    config.paused = matches!(operation, SavedAutomationControl::Pause { .. });
                    let paused = config.paused;
                    record.automation = Some(config);
                    if had_config {
                        ScheduleChange::SetPaused {
                            version: 1,
                            id: record.id.clone(),
                            paused,
                        }
                    } else {
                        ScheduleChange::Update {
                            version: 1,
                            schedule: record,
                        }
                    }
                }
            };
            let applied = SavedAutomationApplied {
                id: r.control.id().into(),
                state: r.control.state(),
            };
            let receipt = SessionMutationReceipt {
                rpc_id: r.invocation.clone(),
                method: CONTROL_RECEIPT_METHOD.into(),
                fingerprint: r.fingerprint.clone(),
                response: serde_json::to_value(&applied)
                    .map_err(|_| SavedAutomationError::Invalid)?,
                response_event_seq_field: None,
            };
            match owner
                .store
                .append(
                    session_id,
                    session.revision(),
                    vec![
                        EventData::ScheduleChange { change }.into(),
                        EventData::SessionMutationCommitted { receipt }.into(),
                    ],
                )
                .await
            {
                Ok(append) => {
                    let session = load_session(&owner.store, session_id)
                        .await
                        .map_err(|_| SavedAutomationError::Unavailable)?;
                    if session.revision() < append.revision
                        || original(&session, &r)?.as_ref() != Some(&applied)
                    {
                        return Err(SavedAutomationError::Unavailable);
                    }
                    certify(&owner, &session).await?;
                    owner.notify.notify_one();
                    return Ok(applied);
                }
                Err(StoreError::RevisionConflict { .. }) => continue,
                Err(_) => return Err(SavedAutomationError::Unavailable),
            }
        }
        Err(SavedAutomationError::Unavailable)
    }
    /// Shared native read conversion. List and view keep their existing domain
    /// behavior; the Host will expose only bounded, path-free DTOs.
    pub async fn saved_read(
        &self,
        session_id: &str,
        command: AutomationCommand,
        after: Option<String>,
    ) -> Result<Value, SavedAutomationError> {
        let _life = self.control_lifetime.read().await;
        if self.closed.load(Ordering::Acquire) {
            return Err(SavedAutomationError::Unavailable);
        }
        if !matches!(
            command,
            AutomationCommand::List {} | AutomationCommand::View { .. }
        ) || after
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > 512 || s.chars().any(char::is_control))
        {
            return Err(SavedAutomationError::Invalid);
        }
        let owner = self
            .owner(session_id)
            .await
            .map_err(|_| SavedAutomationError::Unavailable)?;
        let _guard = owner.transaction.lock().await;
        let session = load_session(&owner.store, session_id)
            .await
            .map_err(|_| SavedAutomationError::Unavailable)?;
        certify(&owner, &session).await?;
        let folded =
            fold_schedule_events(&session).map_err(|_| SavedAutomationError::Unavailable)?;
        if let AutomationCommand::View { id } = command {
            if after.is_some()
                || id.is_empty()
                || id.len() > 512
                || id.chars().any(char::is_control)
            {
                return Err(SavedAutomationError::Invalid);
            }
            let value =
                automation::saved_view(&owner, &session, &folded, &id, self.clock.now_ms()).await;
            if value.get("code").is_some() {
                return Err(SavedAutomationError::NotActive);
            }
            return Ok(value);
        }
        let mut records = folded.active;
        records.sort_by(|a, b| a.id.cmp(&b.id));
        if records
            .iter()
            .any(|r| r.id.is_empty() || r.id.len() > 512 || r.id.chars().any(char::is_control))
            || records.windows(2).any(|w| w[0].id == w[1].id)
        {
            return Err(SavedAutomationError::Unavailable);
        }
        let mut page = records
            .into_iter()
            .filter(|r| after.as_ref().is_none_or(|a| r.id > *a))
            .take(26)
            .collect::<Vec<_>>();
        let next = if page.len() > 25 {
            page.pop();
            page.last().map(|r| r.id.clone())
        } else {
            None
        };
        let entries = page
            .into_iter()
            .map(|mut r| {
                let preview = r.prompt.chars().count() > 160;
                r.prompt = r.prompt.chars().take(160).collect();
                let mut view = automation::automation_view(&r, self.clock.now_ms());
                view["promptIsPreview"] = json!(preview);
                view
            })
            .collect::<Vec<_>>();
        Ok(json!({"entries":entries,"next":next}))
    }
}

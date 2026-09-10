//! Thin durable Goal adapter. Reuses Session CAS, DurableInbox and the existing driver.
use crate::{InboxError, InboxProjection};
use std::sync::Arc;
use xharness_goal::*;
use xharness_session::{
    EventData, GoalChange, GoalSnapshotChange, GoalSnapshotOperation, InboxMessage, InboxTarget,
    Revision, Session, SessionEvent, Store, StoreError, TurnEndReason,
};

#[derive(Debug, thiserror::Error)]
pub enum GoalError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Inbox(#[from] InboxError),
    #[error(transparent)]
    Contract(#[from] GoalContractError),
    #[error("goal controller: {0}")]
    Invalid(String),
}

/// Explicit host-side report payload; the controller binds all identity fields.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GoalReportBody {
    pub status: GoalReportStatus,
    pub summary: String,
    #[serde(default)]
    pub remaining: Vec<String>,
    #[serde(default)]
    pub evidence: Vec<GoalEvidence>,
    #[serde(default)]
    pub blocked_reason: Option<GoalBlockReason>,
}

#[derive(Clone)]
pub struct GoalController {
    store: Arc<dyn Store>,
    session_id: String,
}
impl GoalController {
    pub fn new(store: Arc<dyn Store>, session_id: impl Into<String>) -> Self {
        Self {
            store,
            session_id: session_id.into(),
        }
    }
    async fn load(&self) -> Result<Session, GoalError> {
        self.store
            .load(&self.session_id)
            .await?
            .ok_or_else(|| GoalError::Invalid("session missing".into()))
    }
    async fn append(&self, revision: Revision, events: Vec<SessionEvent>) -> Result<(), GoalError> {
        self.store
            .append(&self.session_id, revision, events)
            .await?;
        self.store.flush(&self.session_id).await?;
        Ok(())
    }
    /// Explicit opt-in only. v1 active snapshots never enable themselves.
    pub async fn enable(
        &self,
        expected: Revision,
        criteria: Vec<String>,
        verification: VerificationMode,
        empty_report_limit: u32,
    ) -> Result<(), GoalError> {
        let session = self.load().await?;
        if session.revision() != expected {
            return Err(GoalError::Invalid("stale enable revision".into()));
        }
        let g = goal_snapshot(&session)
            .ok_or_else(|| GoalError::Invalid("create/resume the goal first".into()))?;
        let old = execution_state(&session);
        if g.goal.phase != GoalPhase::Active
            || open_turn(&session).is_some()
            || old
                .as_ref()
                .is_some_and(|s| s.running.is_some() || s.pending.is_some())
        {
            return Err(GoalError::Invalid("goal is not idle and active".into()));
        }
        let state = GoalExecutionState {
            definition: GoalDefinition {
                snapshot: g.goal.clone(),
                definition_revision: g.goal.revision,
                acceptance_criteria: criteria,
                execution_enabled: true,
                verification,
            },
            activation_epoch: old
                .as_ref()
                .map_or(1, |s| s.activation_epoch.saturating_add(1)),
            rounds_started: g.rounds_started,
            pending: None,
            running: None,
            latest_turn: None,
            admitted: old.map_or_else(Default::default, |s| s.admitted),
            empty_report_rounds: 0,
            empty_report_limit,
            review: None,
            pause_reason: None,
        };
        state.definition.validate()?;
        self.append(
            expected,
            vec![execution(GoalExecutionOperation::Enable, state)],
        )
        .await
    }
    /// User stop pauses future Goal work, including when no model turn is active.
    pub async fn pause(&self) -> Result<(), GoalError> {
        for _ in 0..16 {
            let session = self.load().await?;
            let Some(mut g) = goal_snapshot(&session) else {
                return Ok(());
            };
            if g.goal.phase != GoalPhase::Active {
                return Ok(());
            }
            g.version = 1;
            g.operation = GoalSnapshotOperation::Pause;
            g.goal.phase = GoalPhase::Paused;
            g.goal.revision = g
                .goal
                .revision
                .checked_add(1)
                .ok_or_else(|| GoalError::Invalid("revision overflow".into()))?;
            match self
                .append(
                    session.revision(),
                    vec![EventData::GoalChange {
                        change: GoalChange::Snapshot(g),
                    }
                    .into()],
                )
                .await
            {
                Err(GoalError::Store(StoreError::RevisionConflict { .. })) => continue,
                other => return other,
            }
        }
        Err(GoalError::Invalid("pause stayed contended".into()))
    }
    pub async fn state(&self) -> Result<Option<GoalExecutionState>, GoalError> {
        Ok(execution_state(&self.load().await?))
    }

    /// Re-evaluate durable facts. Conflicts are returned; caller reloads, never reuses a stale proposal.
    pub async fn reconcile(&self) -> Result<GoalDecision, GoalError> {
        for _ in 0..3 {
            let d = self.reconcile_once().await?;
            if d == (GoalDecision::Wait {
                reason: WaitReason::Recovery,
            }) && self.state().await?.is_some_and(|s| s.running.is_none())
            {
                continue;
            }
            return Ok(d);
        }
        Ok(GoalDecision::Wait {
            reason: WaitReason::Recovery,
        })
    }
    async fn reconcile_once(&self) -> Result<GoalDecision, GoalError> {
        let session = self.load().await?;
        let state = execution_state(&session);
        let inbox = InboxProjection::from_session(&session)?;
        let valid_id = state
            .as_ref()
            .and_then(|s| s.pending.as_ref())
            .map(|p| p.message_id.as_str());
        let mut orphan_removals = Vec::new();
        for (i, m) in inbox.next_turn().iter().enumerate().rev() {
            if is_goal_message(m) && Some(m.id.as_str()) != valid_id {
                orphan_removals.push(
                    EventData::AgentInboxSpliced {
                        target: InboxTarget::NextTurn,
                        start: i,
                        removed_count: 1,
                        inserted: vec![],
                        outcome: Some(xharness_session::InboxSpliceOutcome::Cancelled),
                    }
                    .into(),
                );
            }
        }
        if !orphan_removals.is_empty() {
            self.append(session.revision(), orphan_removals).await?;
            return Ok(GoalDecision::Wait {
                reason: WaitReason::ContinuationPending,
            });
        }
        let Some(mut s) = state else {
            return Ok(GoalDecision::Idle {
                reason: IdleReason::Disabled,
            });
        };
        // Legacy pause/edit/clear cannot leave executable queued Goal work.
        if let Some(p) = s.pending.clone() {
            if !s.definition.execution_enabled
                || s.definition.snapshot.phase != GoalPhase::Active
                || p.key.definition_revision != s.definition.definition_revision
                || p.key.activation_epoch != s.activation_epoch
            {
                let mut events = remove_intent(&session, &p)?;
                s.pending = None;
                events.push(execution(GoalExecutionOperation::Discard, s));
                self.append(session.revision(), events).await?;
                return Ok(GoalDecision::Wait {
                    reason: WaitReason::ContinuationPending,
                });
            }
        }
        if s.pending
            .as_ref()
            .is_some_and(|p| !inbox.next_turn().iter().any(|m| m.id == p.message_id))
        {
            s.pending = None;
            s.pause_reason = Some(PauseReason::Cancelled);
            s.definition.snapshot.phase = GoalPhase::Paused;
            self.commit_phase(&session, s, GoalSnapshotOperation::Pause)
                .await?;
            return Ok(GoalDecision::Idle {
                reason: IdleReason::Paused,
            });
        }
        if let Some(running) = &s.running {
            if closed_outcome(&session, running.turn).is_some() {
                self.settle(None).await?;
            }
            return Ok(GoalDecision::Wait {
                reason: WaitReason::Recovery,
            });
        }
        let inbox = InboxProjection::from_session(&session)?;
        let pending_id = s.pending.as_ref().map(|p| p.message_id.as_str());
        let runtime = if open_turn(&session).is_some() {
            RuntimeState::NeedsRecovery
        } else {
            RuntimeState::Idle
        };
        let observation = GoalObservation {
            goal: Some(s.definition.clone()),
            session_revision: session.revision(),
            activation_epoch: s.activation_epoch,
            runtime,
            pending_user_input: !inbox.next_step().is_empty()
                || inbox
                    .next_turn()
                    .iter()
                    .any(|m| Some(m.id.as_str()) != pending_id),
            // No dependency-producing Goal API is registered in this stage. A future
            // dependency adapter must populate this before enabling those tools.
            unresolved_dependencies: false,
            rounds_started: s.rounds_started,
            latest_turn: s.latest_turn.clone(),
            completion_review: s.review.clone(),
            pending_intent: s.pending.as_ref().map(|p| p.key.clone()),
            admitted_intents: s.admitted.clone(),
            empty_report_rounds: s.empty_report_rounds,
            empty_report_limit: s.empty_report_limit,
        };
        let d = decide(&observation)?;
        match &d {
            GoalDecision::Continue { key, .. } => {
                let message_id = format!(
                    "goal:{}",
                    serde_json::to_string(key).map_err(|e| GoalError::Invalid(e.to_string()))?
                );
                let p = GoalIntent {
                    key: key.clone(),
                    message_id: message_id.clone(),
                };
                let mut message = InboxMessage::user(message_id, goal_prompt(&s));
                message.source = Some(
                    serde_json::json!({"kind":"goal","goalId":s.definition.snapshot.id,"activation":s.activation_epoch}),
                );
                s.pending = Some(p);
                s.admitted.insert(key.clone());
                self.append(
                    session.revision(),
                    vec![
                        EventData::AgentInboxSpliced {
                            target: InboxTarget::NextTurn,
                            start: inbox.next_turn().len(),
                            removed_count: 0,
                            inserted: vec![message],
                            outcome: None,
                        }
                        .into(),
                        execution(GoalExecutionOperation::Enqueue, s),
                    ],
                )
                .await?;
            }
            GoalDecision::Pause { reason, .. } => {
                s.pause_reason = Some(*reason);
                s.definition.snapshot.phase = GoalPhase::Paused;
                self.commit_phase(&session, s, GoalSnapshotOperation::Pause)
                    .await?;
            }
            GoalDecision::Block { reason, .. } => {
                s.definition.snapshot.phase = GoalPhase::Blocked;
                s.definition.snapshot.blocked_reason = Some(reason.clone());
                self.commit_phase(&session, s, GoalSnapshotOperation::Block)
                    .await?;
            }
            GoalDecision::Complete { .. } => {
                s.definition.snapshot.phase = GoalPhase::Complete;
                self.commit_phase(&session, s, GoalSnapshotOperation::Complete)
                    .await?;
            }
            _ => {}
        }
        Ok(d)
    }
    async fn commit_phase(
        &self,
        session: &Session,
        mut s: GoalExecutionState,
        operation: GoalSnapshotOperation,
    ) -> Result<(), GoalError> {
        s.definition.snapshot.revision = s
            .definition
            .snapshot
            .revision
            .checked_add(1)
            .ok_or_else(|| GoalError::Invalid("revision overflow".into()))?;
        let change = snapshot_change(session, &s, operation)?;
        self.append(
            session.revision(),
            vec![
                EventData::GoalChange {
                    change: GoalChange::Snapshot(change),
                }
                .into(),
                execution(GoalExecutionOperation::Decision, s),
            ],
        )
        .await
    }
    /// Append claim accounting to the same prelude as inbox deletion + turn/start.
    pub fn claim_events(
        session: &Session,
        claimed: &[InboxMessage],
        turn: u32,
    ) -> Result<Vec<SessionEvent>, GoalError> {
        let Some(mut s) = execution_state(session) else {
            return Ok(vec![]);
        };
        let Some(p) = s.pending.clone() else {
            return Ok(vec![]);
        };
        if !claimed.iter().any(|m| m.id == p.message_id) {
            return Ok(vec![]);
        }
        if !s.definition.execution_enabled
            || s.definition.snapshot.phase != GoalPhase::Active
            || s.running.is_some()
            || s.rounds_started >= s.definition.snapshot.max_goal_rounds
            || claimed.len() != 1
            || open_turn(session).is_some()
        {
            return Err(GoalError::Invalid("stale or ineligible goal claim".into()));
        }
        let inbox = InboxProjection::from_session(session)?;
        if !inbox.next_step().is_empty() || inbox.next_turn().iter().any(|m| m.id != p.message_id) {
            return Err(GoalError::Invalid("user input takes priority".into()));
        }
        s.pending = None;
        s.running = Some(GoalRoundClaim { intent: p, turn });
        s.rounds_started += 1;
        s.definition.snapshot.revision = s
            .definition
            .snapshot
            .revision
            .checked_add(1)
            .ok_or_else(|| GoalError::Invalid("revision overflow".into()))?;
        let change = snapshot_change(session, &s, GoalSnapshotOperation::Edit)?;
        Ok(vec![
            EventData::GoalChange {
                change: GoalChange::Snapshot(change),
            }
            .into(),
            execution(GoalExecutionOperation::Claim, s),
        ])
    }
    /// Called after a durable TurnEnd. Missing reports are never fabricated.
    pub async fn settle(&self, body: Option<GoalReportBody>) -> Result<(), GoalError> {
        for _ in 0..16 {
            match self.settle_once(body.clone()).await {
                Err(GoalError::Store(StoreError::RevisionConflict { .. })) => continue,
                other => return other,
            }
        }
        Err(GoalError::Invalid("settlement stayed contended".into()))
    }
    async fn settle_once(&self, body: Option<GoalReportBody>) -> Result<(), GoalError> {
        let session = self.load().await?;
        let Some(mut s) = execution_state(&session) else {
            return Ok(());
        };
        let Some(running) = s.running.clone() else {
            return Ok(());
        };
        let outcome = closed_outcome(&session, running.turn)
            .ok_or_else(|| GoalError::Invalid("turn is not durably settled".into()))?;
        let key = &running.intent.key;
        let report = body.map(|b| GoalReport {
            goal_id: key.goal_id.clone(),
            definition_revision: key.definition_revision,
            turn: running.turn,
            report_id: format!("{}:report", running.intent.message_id),
            status: b.status,
            summary: b.summary,
            remaining: b.remaining,
            evidence: b.evidence,
            blocked_reason: b.blocked_reason,
        });
        if let Some(r) = &report {
            r.validate()?;
        }
        let tools = session.events().iter().any(
            |e| matches!(e.data(), EventData::ToolResult { turn, .. } if *turn == running.turn),
        );
        s.empty_report_rounds = if report.is_some() || tools {
            0
        } else {
            s.empty_report_rounds.saturating_add(1)
        };
        s.latest_turn = Some(GoalTurnResult {
            goal_id: key.goal_id.clone(),
            definition_revision: key.definition_revision,
            activation_epoch: key.activation_epoch,
            turn: running.turn,
            outcome,
            report,
        });
        s.running = None;
        s.review = None;
        self.append(
            session.revision(),
            vec![execution(GoalExecutionOperation::Settle, s)],
        )
        .await
    }
    pub async fn review(
        &self,
        expected: Revision,
        review: CompletionReview,
    ) -> Result<(), GoalError> {
        let session = self.load().await?;
        let mut state = execution_state(&session)
            .ok_or_else(|| GoalError::Invalid("goal not enabled".into()))?;
        if state.review.as_ref() == Some(&review) {
            return Ok(());
        }
        state.review = Some(review);
        self.append(
            expected,
            vec![execution(GoalExecutionOperation::Review, state)],
        )
        .await
    }
}
fn execution(operation: GoalExecutionOperation, state: GoalExecutionState) -> SessionEvent {
    EventData::GoalExecution {
        change: Box::new(GoalExecutionChange {
            version: 2,
            operation,
            state,
        }),
    }
    .into()
}
fn remove_intent(session: &Session, p: &GoalIntent) -> Result<Vec<SessionEvent>, GoalError> {
    let inbox = InboxProjection::from_session(session)?;
    Ok(inbox
        .next_turn()
        .iter()
        .position(|m| m.id == p.message_id)
        .map(|start| {
            EventData::AgentInboxSpliced {
                target: InboxTarget::NextTurn,
                start,
                removed_count: 1,
                inserted: vec![],
                outcome: Some(xharness_session::InboxSpliceOutcome::Cancelled),
            }
            .into()
        })
        .into_iter()
        .collect())
}
fn snapshot_change(
    session: &Session,
    s: &GoalExecutionState,
    operation: GoalSnapshotOperation,
) -> Result<GoalSnapshotChange, GoalError> {
    let mut g = goal_snapshot(session).ok_or_else(|| GoalError::Invalid("goal missing".into()))?;
    g.version = 2;
    g.goal = s.definition.snapshot.clone();
    g.rounds_started = s.rounds_started;
    g.operation = operation;
    g.updated_at = g.updated_at.max(
        std::time::SystemTime::UNIX_EPOCH
            .elapsed()
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX),
    );
    Ok(g)
}
pub fn goal_snapshot(session: &Session) -> Option<GoalSnapshotChange> {
    session
        .events()
        .iter()
        .rev()
        .find_map(|e| match e.data() {
            EventData::GoalChange { change } => Some(match change {
                GoalChange::Snapshot(s) => Some(s.clone()),
                GoalChange::Clear(_) => None,
            }),
            _ => None,
        })
        .flatten()
}
fn open_turn(session: &Session) -> Option<u32> {
    session
        .events()
        .iter()
        .rev()
        .find_map(|e| match e.data() {
            EventData::TurnStart { turn } => Some(Some(*turn)),
            EventData::TurnEnd { .. } => Some(None),
            _ => None,
        })
        .flatten()
}
fn closed_outcome(session: &Session, t: u32) -> Option<GoalTurnOutcome> {
    session.events().iter().rev().find_map(|e| match e.data() {
        EventData::TurnEnd { turn, reason } if *turn == t => Some(match reason {
            TurnEndReason::Completed => GoalTurnOutcome::Completed,
            TurnEndReason::Cancelled => GoalTurnOutcome::Cancelled,
            TurnEndReason::Failed { .. } => GoalTurnOutcome::Failed,
            TurnEndReason::LimitReached => GoalTurnOutcome::StepLimit,
            TurnEndReason::MaxTokens => GoalTurnOutcome::OutputLimit,
            TurnEndReason::Interrupted => GoalTurnOutcome::OutcomeUnknown,
        }),
        _ => None,
    })
}
fn goal_prompt(s: &GoalExecutionState) -> String {
    format!("[Goal continuation]\nObjective: {}\nAcceptance criteria: {}\nLatest progress: {}\nContinue substantive work towards this goal. A normal turn ending is not goal completion. Do not repeat already completed side effects. Report missing requirements or blockers honestly.\n[/Goal continuation]", s.definition.snapshot.objective, s.definition.acceptance_criteria.join("; "), s.latest_turn.as_ref().and_then(|t| t.report.as_ref()).map_or("No report yet".into(), |r| format!("{}; remaining: {}", r.summary, r.remaining.join("; "))))
}

pub(crate) fn is_goal_message(m: &InboxMessage) -> bool {
    m.source
        .as_ref()
        .and_then(|v| v.get("kind"))
        .and_then(|v| v.as_str())
        == Some("goal")
}

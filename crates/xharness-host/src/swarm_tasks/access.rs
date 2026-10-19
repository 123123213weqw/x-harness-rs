//! Read-only team ownership and worker observations shared by transport adapters.
use crate::{swarm_processor::SwarmProcessor, BasicHost};
use serde::Serialize;
use xharness_api::RpcError;
use xharness_control::SwarmSnapshot;
use xharness_session::{EventData, Session, TurnEndReason};
fn bad_request(message: impl Into<String>) -> RpcError {
    RpcError::bad_request(message, serde_json::json!([]))
}
pub(crate) async fn owned(
    host: &BasicHost,
    id: &str,
    owner: &str,
) -> Result<SwarmSnapshot, RpcError> {
    SwarmProcessor::owned(&host.state.read().await.swarms, id, owner)
        .cloned()
        .map_err(bad_request)
}
pub(crate) async fn journal(host: &BasicHost, id: &str) -> Result<Option<Session>, RpcError> {
    host.agent_runtime
        .authoritative_session(id)
        .await
        .map_err(|e| RpcError::internal(e.to_string()))
}
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum WorkerActivity {
    Unavailable,
    Running,
    AwaitingApproval,
    AwaitingAnswer,
    NeedsReconciliation,
    DispatchPaused,
    Queued,
    Idle,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerObservation {
    session_id: String,
    activity: WorkerActivity,
    session_revision: Option<u64>,
    last_turn_end: Option<TurnEndReason>,
    unresolved_tool_calls: Vec<String>,
    pending_messages: usize,
}
impl WorkerObservation {
    pub(super) fn idle(&self) -> bool {
        matches!(self.activity, WorkerActivity::Idle)
    }
}
pub(crate) async fn observe(host: &BasicHost, id: &str) -> Result<WorkerObservation, RpcError> {
    let (unavailable, running, paused) = {
        let state = host.state.read().await;
        (
            state.deleted_sessions.contains(id) || !state.sessions.contains_key(id),
            state.sessions.get(id).is_some_and(|s| s.running),
            state.sessions.get(id).is_some_and(|s| s.dispatch_paused),
        )
    };
    let session = if unavailable {
        None
    } else {
        journal(host, id).await?
    };
    let mut observation = WorkerObservation {
        session_id: id.into(),
        activity: WorkerActivity::Unavailable,
        session_revision: None,
        last_turn_end: None,
        unresolved_tool_calls: Vec::new(),
        pending_messages: 0,
    };
    let Some(session) = session else {
        return Ok(observation);
    };
    observation.session_revision = Some(session.revision().get());
    let inbox = xharness_agent::InboxProjection::from_session(&session)
        .map_err(|e| RpcError::internal(e.to_string()))?;
    observation.pending_messages = inbox.next_turn().len() + inbox.next_step().len();
    let mut open_turn = false;
    for event in session.events() {
        match event.data() {
            EventData::TurnStart { .. } => open_turn = true,
            EventData::TurnEnd { reason, .. } => {
                open_turn = false;
                observation.last_turn_end = Some(reason.clone());
            }
            _ => {}
        }
    }
    observation.unresolved_tool_calls = xharness_session::incomplete_tool_calls(session.events())
        .into_iter()
        .map(|p| p.call.id)
        .collect();
    observation.activity = if running {
        WorkerActivity::Running
    } else if !session.pending_tool_approvals().is_empty() {
        WorkerActivity::AwaitingApproval
    } else if !session.pending_user_questions().is_empty() {
        WorkerActivity::AwaitingAnswer
    } else if open_turn || !observation.unresolved_tool_calls.is_empty() {
        WorkerActivity::NeedsReconciliation
    } else if paused || session.dispatch_paused() {
        WorkerActivity::DispatchPaused
    } else if observation.pending_messages > 0 {
        WorkerActivity::Queued
    } else {
        WorkerActivity::Idle
    };
    Ok(observation)
}

pub(crate) async fn require_idle_worker(host: &BasicHost, id: &str) -> Result<(), RpcError> {
    if !matches!(observe(host, id).await?.activity, WorkerActivity::Idle) {
        return Err(bad_request(
            "task worker must be idle, unpaused and reconciled",
        ));
    }
    Ok(())
}

/// Stopped coordinators and unresolved user/tool boundaries park background admission.
pub(super) async fn owner_dispatch_allowed(
    host: &BasicHost,
    owner: &str,
) -> Result<bool, RpcError> {
    {
        let state = host.state.read().await;
        if state.deleted_sessions.contains(owner)
            || state
                .sessions
                .get(owner)
                .is_none_or(|session| session.dispatch_paused)
        {
            return Ok(false);
        }
    }
    let Some(session) = journal(host, owner).await? else {
        return Ok(false);
    };
    if session.dispatch_paused()
        || crate::delegation::restored_delegation(&session).is_some()
        || !session.pending_tool_approvals().is_empty()
        || !session.pending_user_questions().is_empty()
        || !xharness_session::incomplete_tool_calls(session.events()).is_empty()
    {
        return Ok(false);
    }
    // An open turn is normal while the coordinator is actually running, but is
    // an incomplete recovery boundary when the owner is idle after a crash.
    let mut open = false;
    for event in session.events() {
        match event.data() {
            EventData::TurnStart { .. } => open = true,
            EventData::TurnEnd { .. } => open = false,
            _ => {}
        }
    }
    Ok(!open
        || host
            .state
            .read()
            .await
            .sessions
            .get(owner)
            .is_some_and(|s| s.running))
}

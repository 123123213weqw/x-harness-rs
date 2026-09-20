//! Goal RPC compatibility adapter.

use serde_json::{json, Value};
use xharness_api::{RpcError, RpcErrorCode, RpcId, RpcMethod};
use xharness_session::{
    EventData as SessionEventData, GoalChange as SessionGoalChange, GoalChangeKind,
    GoalClearChange, GoalClearOperation, GoalRef as DurableGoalRef, GoalSnapshotChange,
    GoalSnapshotOperation, SessionEvent,
};

use crate::{
    control::SessionMutationResponse,
    goal_processor::{GoalDecisionError, GoalProcessor, GoalReference, GoalTransition},
    state::{now_ms, GoalState},
    BasicHost,
};

use super::{
    bad_request, optional_string, optional_u64, required_string, rpc_error, session_not_found,
};

pub(super) async fn call(
    host: &BasicHost,
    rpc_id: RpcId,
    method: RpcMethod,
    payload: &Value,
) -> Result<Value, RpcError> {
    match method {
        RpcMethod::GoalCreate => create(host, rpc_id, payload).await,
        RpcMethod::GoalEdit => edit(host, rpc_id, payload).await,
        RpcMethod::GoalPause => transition(host, rpc_id, payload, "paused").await,
        RpcMethod::GoalResume => transition(host, rpc_id, payload, "active").await,
        RpcMethod::GoalComplete => transition(host, rpc_id, payload, "complete").await,
        RpcMethod::GoalClear => clear(host, rpc_id, payload).await,
        _ => unreachable!("goal adapter received non-goal method {method}"),
    }
}

pub(super) async fn remote(
    host: &BasicHost,
    rpc_id: RpcId,
    endpoint: &str,
    payload: &Value,
) -> Result<Value, RpcError> {
    let args = payload
        .get("args")
        .ok_or_else(|| bad_request(format!("{endpoint} requires args")))?;
    let session_id = required_string(args, "agentId")?;
    let request = args.get("request").cloned().unwrap_or_else(|| json!({}));
    let mut flat = json!({"sessionId": session_id});
    if let Some(objective) = optional_string(&request, "objective")? {
        flat["objective"] = json!(objective);
    }
    if let Some(rounds) = optional_u64(&request, "maxGoalRounds")? {
        flat["maxGoalRounds"] = json!(rounds);
    }
    if endpoint == "goals/create" {
        // The shipped client never sends `executionEnabled`, but the flat
        // method understands it, so pass it through instead of silently
        // arming a goal the caller asked to create disarmed.
        if let Some(enabled) = request.get("executionEnabled") {
            let enabled = enabled
                .as_bool()
                .ok_or_else(|| bad_request("request.executionEnabled must be a boolean"))?;
            flat["executionEnabled"] = json!(enabled);
        }
        // Creation arms the goal and already answers with exactly the ref
        // the upstream create schema expects.
        return create(host, rpc_id, &flat).await;
    }
    let reference = args
        .get("ref")
        .cloned()
        .ok_or_else(|| bad_request(format!("{endpoint} requires ref")))?;
    goal_ref(&json!({"ref": reference}))?;
    flat["ref"] = reference;
    match endpoint {
        "goals/edit" => edit_reply(host, rpc_id, &flat, true).await,
        "goals/pause" => transition_reply(host, rpc_id, &flat, "paused", true).await,
        "goals/resume" => transition_reply(host, rpc_id, &flat, "active", true).await,
        "goals/complete" => transition_reply(host, rpc_id, &flat, "complete", true).await,
        "goals/clear" => clear_reply(host, rpc_id, &flat, true).await,
        _ => unreachable!("goal_remote is only mounted for goals/*"),
    }
}

pub(super) async fn create(
    host: &BasicHost,
    rpc_id: RpcId,
    payload: &Value,
) -> Result<Value, RpcError> {
    let session_id = required_string(payload, "sessionId")?;
    let objective = required_string(payload, "objective")?;
    let max_goal_rounds = optional_u64(payload, "maxGoalRounds")?.unwrap_or(256);
    let _session_guard = host.lock_admission(&session_id).await;
    if let Some(response) = host
        .replay_session_mutation_receipt(&session_id, &rpc_id, RpcMethod::GoalCreate, payload)
        .await?
    {
        return Ok(response);
    }
    let (session_exists, existing) = {
        let state = host.state.read().await;
        (
            state.sessions.contains_key(&session_id),
            state.goals.get(&session_id).cloned(),
        )
    };
    let now = now_ms();
    let mut mutation = GoalProcessor::create(
        session_exists,
        existing.as_ref(),
        String::new(),
        objective,
        max_goal_rounds,
        now,
    )
    .map_err(|error| decision_error(error, &session_id, false))?;
    mutation.goal.id = host.mint_id("goal");
    let goal = mutation.goal;
    let mut events = vec![goal_snapshot_event(&goal, mutation.operation)];
    if payload.get("executionEnabled").and_then(Value::as_bool) != Some(false) {
        events.extend(host.goal_enable_events(&session_id, &goal).await?);
    }
    let response = json!({"ref": {"id": goal.id.clone(), "revision": goal.revision}});
    host.commit_session_mutation(
        &session_id,
        &rpc_id,
        RpcMethod::GoalCreate,
        payload,
        events,
        SessionMutationResponse::fixed(response.clone()),
    )
    .await?;
    if !host.agent_runtime.has_authoritative_sessions() {
        let mut state = host.state.write().await;
        state
            .sessions
            .get_mut(&session_id)
            .ok_or_else(|| session_not_found(&session_id))?
            .goal = Some(goal.clone());
        state.goals.insert(session_id.clone(), goal.clone());
    }
    if host.agent_runtime.has_authoritative_sessions() {
        host.sync_authoritative_session(&session_id).await?;
    } else {
        host.push_projection(&session_id, "goal", goal.projection())
            .await;
    }
    host.activate_goal(&session_id).await?;
    Ok(response)
}

pub(super) async fn edit(
    host: &BasicHost,
    rpc_id: RpcId,
    payload: &Value,
) -> Result<Value, RpcError> {
    edit_reply(host, rpc_id, payload, false).await
}

async fn edit_reply(
    host: &BasicHost,
    rpc_id: RpcId,
    payload: &Value,
    remote: bool,
) -> Result<Value, RpcError> {
    let session_id = required_string(payload, "sessionId")?;
    // A valid flat request always has a top-level sessionId; wrapping only
    // remote receipts gives the two protocols disjoint fingerprints while
    // preserving all historical flat receipts unchanged.
    let receipt_payload = if remote {
        json!({"goalRemoteRequest": payload})
    } else {
        payload.clone()
    };
    let objective = optional_string(payload, "objective")?;
    let max_goal_rounds = optional_u64(payload, "maxGoalRounds")?;
    if objective.is_none() && max_goal_rounds.is_none() {
        return Err(bad_request("goal.edit requires objective or maxGoalRounds"));
    }
    let expected = goal_ref(payload)?;
    let _session_guard = host.lock_admission(&session_id).await;
    if let Some(response) = host
        .replay_session_mutation_receipt(
            &session_id,
            &rpc_id,
            RpcMethod::GoalEdit,
            &receipt_payload,
        )
        .await?
    {
        return Ok(response);
    }
    host.sync_authoritative_session(&session_id).await?;
    let current = host.state.read().await.goals.get(&session_id).cloned();
    let mutation = GoalProcessor::edit(
        current.as_ref(),
        &expected,
        objective,
        max_goal_rounds,
        now_ms(),
    )
    .map_err(|error| decision_error(error, &session_id, true))?;
    let goal = mutation.goal;
    let mut events = vec![goal_snapshot_event(&goal, mutation.operation)];
    events.extend(
        host.invalidate_goal_pending(&session_id, Some(&goal))
            .await?,
    );
    let response = if remote {
        goal_remote_snapshot(&goal, &events)
    } else {
        json!({"ref": {"id": goal.id.clone(), "revision": goal.revision}})
    };
    host.commit_session_mutation(
        &session_id,
        &rpc_id,
        RpcMethod::GoalEdit,
        &receipt_payload,
        events,
        SessionMutationResponse::fixed(response.clone()),
    )
    .await?;
    if !host.agent_runtime.has_authoritative_sessions() {
        let mut state = host.state.write().await;
        state
            .sessions
            .get_mut(&session_id)
            .ok_or_else(|| session_not_found(&session_id))?
            .goal = Some(goal.clone());
        state.goals.insert(session_id.clone(), goal.clone());
    }
    if host.agent_runtime.has_authoritative_sessions() {
        host.sync_authoritative_session(&session_id).await?;
    } else {
        host.push_projection(&session_id, "goal", goal.projection())
            .await;
    }
    Ok(response)
}

pub(super) async fn transition(
    host: &BasicHost,
    rpc_id: RpcId,
    payload: &Value,
    transition: &str,
) -> Result<Value, RpcError> {
    transition_reply(host, rpc_id, payload, transition, false).await
}

async fn transition_reply(
    host: &BasicHost,
    rpc_id: RpcId,
    payload: &Value,
    transition: &str,
    remote: bool,
) -> Result<Value, RpcError> {
    let session_id = required_string(payload, "sessionId")?;
    // A valid flat request always has a top-level sessionId; wrapping only
    // remote receipts gives the two protocols disjoint fingerprints while
    // preserving all historical flat receipts unchanged.
    let receipt_payload = if remote {
        json!({"goalRemoteRequest": payload})
    } else {
        payload.clone()
    };
    let expected = goal_ref(payload)?;
    let _session_guard = host.lock_admission(&session_id).await;
    let (method, transition_kind) = match transition {
        "paused" => (RpcMethod::GoalPause, GoalTransition::Pause),
        "active" => (RpcMethod::GoalResume, GoalTransition::Resume),
        "complete" => (RpcMethod::GoalComplete, GoalTransition::Complete),
        _ => return Err(RpcError::internal("unknown goal transition")),
    };
    if let Some(response) = host
        .replay_session_mutation_receipt(&session_id, &rpc_id, method, &receipt_payload)
        .await?
    {
        return Ok(response);
    }
    host.sync_authoritative_session(&session_id).await?;
    let current = host.state.read().await.goals.get(&session_id).cloned();
    let mutation =
        GoalProcessor::transition(current.as_ref(), &expected, transition_kind, now_ms())
            .map_err(|error| decision_error(error, &session_id, false))?;
    let goal = mutation.goal;
    let mut events = vec![goal_snapshot_event(&goal, mutation.operation)];
    if transition == "active" {
        events.extend(host.goal_enable_events(&session_id, &goal).await?);
    }
    if transition != "active" {
        events.extend(
            host.invalidate_goal_pending(&session_id, Some(&goal))
                .await?,
        );
    }
    let response = if remote {
        goal_remote_snapshot(&goal, &events)
    } else {
        json!({"ref": {"id": goal.id.clone(), "revision": goal.revision}})
    };
    host.commit_session_mutation(
        &session_id,
        &rpc_id,
        method,
        &receipt_payload,
        events,
        SessionMutationResponse::fixed(response.clone()),
    )
    .await?;
    if !host.agent_runtime.has_authoritative_sessions() {
        let mut state = host.state.write().await;
        state
            .sessions
            .get_mut(&session_id)
            .ok_or_else(|| session_not_found(&session_id))?
            .goal = Some(goal.clone());
        state.goals.insert(session_id.clone(), goal.clone());
    }
    if host.agent_runtime.has_authoritative_sessions() {
        host.sync_authoritative_session(&session_id).await?;
    } else {
        host.push_projection(&session_id, "goal", goal.projection())
            .await;
    }
    if transition == "active" {
        host.activate_goal(&session_id).await?;
    }
    Ok(response)
}

pub(super) async fn clear(
    host: &BasicHost,
    rpc_id: RpcId,
    payload: &Value,
) -> Result<Value, RpcError> {
    clear_reply(host, rpc_id, payload, false).await
}

async fn clear_reply(
    host: &BasicHost,
    rpc_id: RpcId,
    payload: &Value,
    remote: bool,
) -> Result<Value, RpcError> {
    let session_id = required_string(payload, "sessionId")?;
    // A valid flat request always has a top-level sessionId; wrapping only
    // remote receipts gives the two protocols disjoint fingerprints while
    // preserving all historical flat receipts unchanged.
    let receipt_payload = if remote {
        json!({"goalRemoteRequest": payload})
    } else {
        payload.clone()
    };
    let expected = goal_ref(payload)?;
    let _session_guard = host.lock_admission(&session_id).await;
    if let Some(response) = host
        .replay_session_mutation_receipt(
            &session_id,
            &rpc_id,
            RpcMethod::GoalClear,
            &receipt_payload,
        )
        .await?
    {
        return Ok(response);
    }
    host.sync_authoritative_session(&session_id).await?;
    let goal = host.state.read().await.goals.get(&session_id).cloned();
    let cleared = GoalProcessor::clear(goal.as_ref(), &expected)
        .map_err(|error| decision_error(error, &session_id, false))?;
    let goal = goal.expect("clear decision requires a goal");
    let cleared = DurableGoalRef {
        id: cleared.id,
        revision: cleared.revision,
    };
    let response = if remote {
        json!({"id": &cleared.id, "revision": cleared.revision})
    } else {
        json!({"cleared": true})
    };
    let mut events = vec![SessionEventData::GoalChange {
        change: SessionGoalChange::Clear(GoalClearChange {
            kind: GoalChangeKind::GoalChange,
            version: 1,
            operation: GoalClearOperation::Clear,
            cleared,
            cleared_at: now_ms().max(goal.updated_at),
        }),
    }
    .into()];
    events.extend(host.invalidate_goal_pending(&session_id, None).await?);
    host.commit_session_mutation(
        &session_id,
        &rpc_id,
        RpcMethod::GoalClear,
        &receipt_payload,
        events,
        SessionMutationResponse::fixed(response.clone()),
    )
    .await?;
    if !host.agent_runtime.has_authoritative_sessions() {
        let mut state = host.state.write().await;
        state
            .sessions
            .get_mut(&session_id)
            .ok_or_else(|| session_not_found(&session_id))?
            .goal = None;
        state.goals.remove(&session_id);
    }
    host.push_projection(&session_id, "goal", Value::Null).await;
    Ok(response)
}

fn goal_snapshot_event(goal: &GoalState, operation: GoalSnapshotOperation) -> SessionEvent {
    SessionEventData::GoalChange {
        change: SessionGoalChange::Snapshot(GoalSnapshotChange {
            kind: GoalChangeKind::GoalChange,
            version: 1,
            operation,
            goal: goal.snapshot(),
            rounds_started: goal.rounds_started,
            created_at: goal.created_at,
            updated_at: goal.updated_at,
        }),
    }
    .into()
}

fn goal_ref(payload: &Value) -> Result<GoalReference, RpcError> {
    let reference = payload
        .get("ref")
        .and_then(Value::as_object)
        .ok_or_else(|| bad_request("ref must be an object"))?;
    let id = reference
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| bad_request("ref.id must be a string"))?;
    let revision = reference
        .get("revision")
        .and_then(Value::as_u64)
        .filter(|revision| *revision > 0)
        .ok_or_else(|| bad_request("ref.revision must be positive"))?;
    Ok(GoalReference { id, revision })
}

fn decision_error(error: GoalDecisionError, session_id: &str, active_wording: bool) -> RpcError {
    match error {
        GoalDecisionError::SessionMissing => session_not_found(session_id),
        GoalDecisionError::ExistingNonComplete => {
            bad_request("session already has a non-complete goal")
        }
        GoalDecisionError::GoalMissing if active_wording => rpc_error(
            RpcErrorCode::BadRequest,
            "session has no active goal",
            json!({"issues": []}),
        ),
        GoalDecisionError::GoalMissing => bad_request("session has no goal"),
        GoalDecisionError::StaleReference => {
            bad_request("goal reference is stale or does not match")
        }
        GoalDecisionError::EmptyObjective => bad_request("objective must not be empty"),
        GoalDecisionError::InvalidRoundBudget => bad_request("maxGoalRounds must be positive"),
        GoalDecisionError::EmptyEdit => {
            bad_request("goal.edit requires objective or maxGoalRounds")
        }
        GoalDecisionError::InvalidTransition { transition, phase } => bad_request(format!(
            "cannot {} goal from phase {phase:?}",
            transition.wire_name()
        )),
    }
}

fn goal_remote_snapshot(goal: &GoalState, events: &[SessionEvent]) -> Value {
    let armed = events
        .iter()
        .rev()
        .find_map(|event| match event.data() {
            SessionEventData::GoalExecution { change } => {
                Some(change.state.definition.execution_enabled)
            }
            SessionEventData::GoalChange {
                change: SessionGoalChange::Snapshot(change),
            } if change.version == 1 => Some(false),
            _ => None,
        })
        .unwrap_or(false);
    let mut value = json!({
        "ref": {"id": &goal.id, "revision": goal.revision},
        "id": &goal.id,
        "revision": goal.revision,
        "objective": &goal.objective,
        "phase": goal.phase,
        "maxGoalRounds": goal.max_goal_rounds,
        "roundsStarted": goal.rounds_started,
        "createdAt": goal.created_at,
        "updatedAt": goal.updated_at,
        "activation": if armed { "armed" } else { "disarmed" },
    });
    if let Some(reason) = &goal.blocked_reason {
        value["blockedReason"] = json!(reason);
    }
    value
}

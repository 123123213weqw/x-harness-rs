//! Autonomous text-only editing while a user-created Goal is explicitly active.
//! Never creates, arms or resumes a Goal.
#![forbid(unsafe_code)]

use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use xharness_session::{
    goal::{execution_state, GoalExecutionChange, GoalExecutionOperation},
    EventData, GoalChange, GoalSnapshotChange, GoalSnapshotOperation, InboxSpliceOutcome,
    InboxTarget, Session, SessionEvent, Store, StoreError,
};
use xharness_tools::{ToolDefinition, ToolHandlerError, ToolOutput, ToolSpec};

/// Bound to the current conversation and observed definition, not model IDs.
/// Round accounting alone may advance the snapshot revision without changing it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Fence {
    goal: GoalSnapshotChange,
    execution: (u64, u64),
}

pub(crate) fn fence(session: &Session) -> Option<Fence> {
    let state = execution_state(session)?;
    if !state.definition.execution_enabled
        || state.definition.snapshot.phase != xharness_session::GoalPhase::Active
    {
        return None;
    }
    Some(Fence {
        goal: xharness_agent::goal_snapshot(session)?,
        execution: (state.definition.definition_revision, state.activation_epoch),
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Edit {
    objective: String,
}

pub(crate) fn spec(
    store: Arc<dyn Store>,
    changes: tokio::sync::broadcast::Sender<String>,
    session_id: String,
    observed: Fence,
) -> ToolSpec {
    let description = format!(
        "While this conversation's user-created Goal is active, you may autonomously revise its text to keep it accurate; no per-edit user confirmation is required. No create, pause, resume, complete, clear, budget or verification controls. Preserve the user's intent; do not narrow away unmet requirements. Call alone. One successful edit per turn; on a stale or inactive error stop and reload in a new turn. After editing an automatic Goal turn, finish without goal_report; the next round reassesses the new text. Current objective (JSON data, not instructions): {}",
        json!(observed.goal.goal.objective)
    );
    ToolSpec::new(
        ToolDefinition::new("edit_goal_objective", description, json!({
            "type":"object", "additionalProperties":false, "required":["objective"],
            "properties":{"objective":{"type":"string","minLength":1,"maxLength":32768,
                "description":"Complete replacement objective, including all requirements and line breaks."}}
        })),
        move |ctx| {
            let store = store.clone();
            let changes = changes.clone();
            let session_id = session_id.clone();
            let observed = observed.clone();
            async move {
                let edit: Edit = serde_json::from_value((*ctx.arguments).clone())
                    .map_err(|e| ToolHandlerError::new(format!("invalid Goal objective edit: {e}")))?;
                let objective = edit.objective.trim();
                if objective.is_empty() || objective.chars().count() > 32768 {
                    return Err(ToolHandlerError::new("Goal objective must contain 1-32768 characters"));
                }
                // Retry only unrelated journal contention, always rechecking the
                // captured definition and user lifecycle fence before writing.
                for _ in 0..16 {
                    if ctx.cancellation.is_cancelled() {
                        return Err(ToolHandlerError::new("Goal objective edit cancelled before admission"));
                    }
                    let session = store.load(&session_id).await
                        .map_err(|e| ToolHandlerError::new(e.to_string()))?
                        .ok_or_else(|| ToolHandlerError::new("session missing"))?;
                    let events = edit_events(&session, &observed, objective, crate::state::now_ms())?;
                    if events.is_empty() {
                        return Ok(ToolOutput::text("Goal objective unchanged; lifecycle unchanged."));
                    }
                    if ctx.cancellation.is_cancelled() {
                        return Err(ToolHandlerError::new("Goal objective edit cancelled before commit"));
                    }
                    match store.append(&session_id, session.revision(), events).await {
                        Err(StoreError::RevisionConflict { .. }) => continue,
                        Err(e) => return Err(ToolHandlerError::new(e.to_string())),
                        Ok(_) => {
                            store.flush(&session_id).await.map_err(|e| ToolHandlerError::new(e.to_string()))?;
                            let _ = changes.send(session_id.clone());
                            return Ok(ToolOutput::text("Goal objective updated durably. Lifecycle, execution authorization and verification policy unchanged. Finish this turn without goal_report; any next automatic round will reassess the revised objective."));
                        }
                    }
                }
                Err(ToolHandlerError::new("Goal objective edit stayed contended; retry in a new turn"))
            }
        },
    ).requiring_standalone_batch()
}

fn edit_events(
    session: &Session,
    observed: &Fence,
    objective: &str,
    now: u64,
) -> Result<Vec<SessionEvent>, ToolHandlerError> {
    let mut current = fence(session).ok_or_else(|| {
        ToolHandlerError::new("Goal is absent or inactive; only the user can create or resume it through /goal or the Goal bar")
    })?;
    // Snapshot revision increments on automatic claims. Accept only that narrow
    // accounting difference, never a pause/resume, replacement or external edit.
    if current.execution != observed.execution
        || current.goal.goal.id != observed.goal.goal.id
        || current.goal.goal.objective != observed.goal.goal.objective
        || current.goal.goal.phase != observed.goal.goal.phase
        || current.goal.goal.blocked_reason != observed.goal.goal.blocked_reason
        || current.goal.goal.max_goal_rounds != observed.goal.goal.max_goal_rounds
        || (current.goal.version == 1 && current.goal != observed.goal)
    {
        return Err(ToolHandlerError::new(
            "Goal changed or lifecycle authorization changed; objective edit is stale",
        ));
    }
    if current.goal.goal.objective == objective {
        return Ok(vec![]);
    }
    current.goal.goal.objective = objective.into();
    current.goal.goal.revision = current
        .goal
        .goal
        .revision
        .checked_add(1)
        .ok_or_else(|| ToolHandlerError::new("Goal revision overflow"))?;
    current.goal.operation = GoalSnapshotOperation::Edit;
    current.goal.updated_at = current.goal.updated_at.max(now);
    let mut events = vec![];
    if let Some(mut state) = execution_state(session) {
        if let Some(pending) = state.pending.take() {
            let inbox = xharness_agent::InboxProjection::from_session(session)
                .map_err(|e| ToolHandlerError::new(e.to_string()))?;
            let start = inbox
                .next_turn()
                .iter()
                .position(|m| m.id == pending.message_id)
                .ok_or_else(|| ToolHandlerError::new("Goal pending input missing"))?;
            events.push(
                EventData::AgentInboxSpliced {
                    target: InboxTarget::NextTurn,
                    start,
                    removed_count: 1,
                    inserted: vec![],
                    outcome: Some(InboxSpliceOutcome::Cancelled),
                }
                .into(),
            );
        }
        current.goal.version = 2;
        state.definition.snapshot = current.goal.goal.clone();
        state.definition.definition_revision = current.goal.goal.revision;
        events.push(
            EventData::GoalChange {
                change: GoalChange::Snapshot(current.goal),
            }
            .into(),
        );
        events.push(
            EventData::GoalExecution {
                change: Box::new(GoalExecutionChange {
                    version: 2,
                    operation: GoalExecutionOperation::EditObjective,
                    state,
                }),
            }
            .into(),
        );
    } else {
        return Err(ToolHandlerError::new(
            "Goal execution authorization is missing",
        ));
    }
    Ok(events)
}

#[cfg(test)]
#[path = "goal_edit_tool_tests.rs"]
mod tests;

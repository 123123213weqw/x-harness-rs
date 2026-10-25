//! Report-only capability for an explicitly admitted automatic Goal turn.
//! User controls own lifecycle; the separate existing-objective tool cannot report.
#![forbid(unsafe_code)]
use crate::SessionToolFactory;
use serde_json::json;
use std::sync::Arc;
use xharness_core::AgentMessage;
use xharness_session::{goal::GoalDefinition, EventData, GoalPhase, Session, Store};
use xharness_tools::{ToolDefinition, ToolHandlerError, ToolSpec};

/// Match durable work identity, never the wording of a user message. Recovery
/// may rebuild an executor with no new input for the same still-open Goal turn.
pub(crate) fn fence(session: &Session, input: &[AgentMessage]) -> Option<(GoalDefinition, u64)> {
    let state = xharness_session::goal::execution_state(session)?;
    if !state.definition.execution_enabled || state.definition.snapshot.phase != GoalPhase::Active {
        return None;
    }
    let admitted = state.pending.as_ref().is_some_and(|pending| {
        input.len() == 1
            && input[0].role == xharness_core::Role::User
            && input[0].id.as_deref() == Some(pending.message_id.as_str())
            && pending.key.definition_revision == state.definition.definition_revision
    });
    let recovering = input.is_empty()
        && state.running.as_ref().is_some_and(|running| {
            running.intent.key.definition_revision == state.definition.definition_revision
                && session
                    .events()
                    .iter()
                    .rev()
                    .find_map(|event| match event.data() {
                        EventData::TurnStart { turn } => Some(Some(*turn)),
                        EventData::TurnEnd { .. } => Some(None),
                        _ => None,
                    })
                    .flatten()
                    == Some(running.turn)
        });
    (admitted || recovering).then_some((state.definition, state.activation_epoch))
}

pub(crate) fn spec(
    store: Arc<dyn Store>,
    tools: Arc<dyn SessionToolFactory>,
    session_id: String,
    fence: (GoalDefinition, u64),
) -> ToolSpec {
    ToolSpec::new(ToolDefinition::new("goal_report",
        "Report progress for this automatic Goal turn, then finish it. No Goal or plan management. Complete needs evidence, no remaining work and settled dependencies; blocked needs blocked_reason. Job/agent references must be exact existing IDs owned by this conversation; put annotations in summary. Correct rejected reports before retrying. Call alone.",
        json!({"type":"object","additionalProperties":false,"required":["status","summary"],"properties":{
            "status":{"type":"string","enum":["progress","blocked","complete"]},
            "summary":{"type":"string","minLength":1,"maxLength":8192},
            "remaining":{"type":"array","maxItems":32,"items":{"type":"string","maxLength":2048}},
            "evidence":{"type":"array","maxItems":32,"items":{"type":"object","additionalProperties":false,"required":["kind","reference"],"properties":{"kind":{"type":"string","enum":["artifact","job","agent"]},"reference":{"type":"string","minLength":1,"maxLength":2048,"description":"Exact resource ID for job/agent; no whitespace or annotations. Artifact references may be paths or URLs."}}}},
            "blocked_reason":{"type":"object","additionalProperties":false,"required":["code","message"],"properties":{"code":{"type":"string"},"message":{"type":"string"}}}
        }})), move |ctx| {
            let store = store.clone(); let tools = tools.clone();
            let session_id = session_id.clone(); let (definition, epoch) = fence.clone();
            async move {
                if ctx.cancellation.is_cancelled() {
                    return Err(ToolHandlerError::new("Goal report cancelled before admission"));
                }
                let body = serde_json::from_value((*ctx.arguments).clone())
                    .map_err(|e| ToolHandlerError::new(format!("invalid Goal report: {e}")))?;
                crate::goals::validate_report(&store, &tools, &session_id, definition, epoch, body).await
            }
        }).requiring_standalone_batch()
}

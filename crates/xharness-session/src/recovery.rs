use std::collections::HashSet;

use crate::{EventData, LoggedEvent, Session, SessionEvent, ToolCall, ToolOutcome, ToolResultData};

pub const OUTCOME_UNKNOWN_CONTENT: &str = "Tool outcome is unknown because the call was durably recorded but no authoritative result survived. Do not assume the operation did not run; verify external state before retrying non-idempotent work.";

/// Description of a tool call lacking a durable result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IncompleteToolCall {
    pub turn: u32,
    pub step: u32,
    pub call: ToolCall,
}

/// Find model-requested calls for which no authoritative result exists.
///
/// This is a pure inspection: it neither mutates the supplied log nor claims
/// whether a side effect happened.
pub fn incomplete_tool_calls(events: &[LoggedEvent]) -> Vec<IncompleteToolCall> {
    let settled: HashSet<&str> = events
        .iter()
        .filter_map(|event| match event.data() {
            EventData::ToolResult { result, .. } => Some(result.call_id.as_str()),
            _ => None,
        })
        .collect();

    events
        .iter()
        .filter_map(|event| match event.data() {
            EventData::ToolCall { turn, step, call } if !settled.contains(call.id.as_str()) => {
                Some(IncompleteToolCall {
                    turn: *turn,
                    step: *step,
                    call: call.clone(),
                })
            }
            _ => None,
        })
        .collect()
}

/// Build append candidates that balance every incomplete tool call with an
/// explicit `outcome_unknown` result. Callers choose the durability boundary
/// and append them through the normal CAS path.
pub fn outcome_unknown_recovery(events: &[LoggedEvent]) -> Vec<SessionEvent> {
    incomplete_tool_calls(events)
        .into_iter()
        .map(|pending| {
            EventData::ToolResult {
                turn: pending.turn,
                step: pending.step,
                result: ToolResultData {
                    call_id: pending.call.id,
                    outcome: ToolOutcome::OutcomeUnknown,
                    content: OUTCOME_UNKNOWN_CONTENT.to_owned(),
                    metadata: None,
                },
            }
            .into()
        })
        .collect()
}

impl Session {
    /// Pure recovery candidates for the current immutable log snapshot.
    pub fn outcome_unknown_recovery(&self) -> Vec<SessionEvent> {
        outcome_unknown_recovery(self.events())
    }
}

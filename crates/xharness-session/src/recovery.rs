use std::collections::{HashMap, HashSet};

use crate::{EventData, LoggedEvent, Session, SessionEvent, ToolCall, ToolOutcome, ToolResultData};

pub const OUTCOME_UNKNOWN_CONTENT: &str = "Tool outcome is unknown because the call was durably recorded but no authoritative result survived. Do not assume the operation did not run; verify external state before retrying non-idempotent work.";

/// Description of a tool call lacking a durable result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IncompleteToolCall {
    pub turn: u32,
    pub step: u32,
    pub call: ToolCall,
}

/// One approval request that was durably asked but did not receive a durable
/// decision before the writer stopped.
///
/// A tool referenced by this record is known not to have crossed the approval
/// boundary in the original process. Recovery may therefore ask the user
/// again with the same approval identity; it must never silently execute the
/// call or collapse it into `outcome_unknown`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingToolApproval {
    pub id: String,
    pub tool_name: String,
    pub call_id: String,
    pub reason: Option<String>,
    pub turn: u32,
    pub step: u32,
    pub call: ToolCall,
}

/// Project undecided approval requests from an immutable Session cut.
///
/// The Session validator already guarantees unique approval ids and valid
/// call references. This projection additionally requires a concrete call id
/// because only tool-bound approvals can be resumed by the Loop runtime.
pub fn pending_tool_approvals(events: &[LoggedEvent]) -> Vec<PendingToolApproval> {
    let decided = events
        .iter()
        .filter_map(|event| match event.data() {
            EventData::ApprovalDecided { id, .. } => Some(id.as_str()),
            _ => None,
        })
        .collect::<HashSet<_>>();
    let calls = events
        .iter()
        .filter_map(|event| match event.data() {
            EventData::ToolCall { turn, step, call } => {
                Some((call.id.as_str(), (*turn, *step, call)))
            }
            _ => None,
        })
        .collect::<HashMap<_, _>>();
    let settled = events
        .iter()
        .filter_map(|event| match event.data() {
            EventData::ToolResult { result, .. } => Some(result.call_id.as_str()),
            _ => None,
        })
        .collect::<HashSet<_>>();

    events
        .iter()
        .filter_map(|event| match event.data() {
            EventData::ApprovalAsked {
                id,
                tool_name,
                call_id: Some(call_id),
                reason,
            } if !decided.contains(id.as_str()) && !settled.contains(call_id.as_str()) => {
                let (turn, step, call) = calls.get(call_id.as_str())?;
                Some(PendingToolApproval {
                    id: id.clone(),
                    tool_name: tool_name.clone(),
                    call_id: call_id.clone(),
                    reason: reason.clone(),
                    turn: *turn,
                    step: *step,
                    call: (*call).clone(),
                })
            }
            _ => None,
        })
        .collect()
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
    let awaiting_approval = pending_tool_approvals(events)
        .into_iter()
        .map(|approval| approval.call_id)
        .collect::<HashSet<_>>();
    incomplete_tool_calls(events)
        .into_iter()
        .filter(|pending| !awaiting_approval.contains(&pending.call.id))
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

    /// Undecided, tool-bound approvals that can be resumed interactively.
    pub fn pending_tool_approvals(&self) -> Vec<PendingToolApproval> {
        pending_tool_approvals(self.events())
    }
}

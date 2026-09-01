use std::collections::{HashMap, HashSet};

use crate::{EventData, LoggedEvent, Session, SessionEvent, ToolCall, ToolOutcome, ToolResultData};
use xharness_interaction::{
    QuestionAnswer, QuestionInteraction, QuestionInvocation, QuestionTerminalState,
};

pub const COMPACTION_INTERRUPTED_ERROR: &str =
    "compaction was interrupted before an authoritative replacement was committed";

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

/// Durable state of one question-bearing tool call whose ordinary tool result
/// has not yet committed. Re-executing this call is safe: its provider folds
/// the stable interaction identity and either waits for the existing request
/// or returns its already-durable resolution.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoverableUserQuestion {
    pub turn: u32,
    pub step: u32,
    pub call: ToolCall,
    pub invocation: QuestionInvocation,
    pub draft: Vec<QuestionAnswer>,
    pub terminal: QuestionTerminalState,
}

/// Pending subset projected to Web reconnect baselines.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingUserQuestion {
    pub turn: u32,
    pub step: u32,
    pub call: ToolCall,
    pub invocation: QuestionInvocation,
    pub draft: Vec<QuestionAnswer>,
}

/// Fold all durable question events whose associated Tool call still lacks a
/// result. The Session validator guarantees that every transition is valid.
pub fn recoverable_user_questions(events: &[LoggedEvent]) -> Vec<RecoverableUserQuestion> {
    let calls = events
        .iter()
        .filter_map(|event| match event.data() {
            EventData::ToolCall { turn, step, call } => {
                Some((call.id.clone(), (*turn, *step, call.clone())))
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
    let mut order = Vec::<String>::new();
    let mut interactions = HashMap::<String, QuestionInteraction>::new();
    for event in events {
        match event.data() {
            EventData::QuestionRequested { invocation } => {
                order.push(invocation.interaction_id.clone());
                interactions.insert(
                    invocation.interaction_id.clone(),
                    QuestionInteraction::new(invocation.clone())
                        .expect("validated Session contains a valid question request"),
                );
            }
            EventData::QuestionDraftUpdated {
                interaction_id,
                answers,
            } => {
                interactions
                    .get_mut(interaction_id)
                    .expect("validated Session draft references its request")
                    .update_draft(answers.clone())
                    .expect("validated Session contains a valid question draft");
            }
            EventData::QuestionResolved {
                interaction_id,
                resolution,
            } => {
                let answers = resolution
                    .answers
                    .iter()
                    .map(|answer| QuestionAnswer {
                        question_id: answer.question_id.clone(),
                        selected_option_id: answer.selected_option_id.clone(),
                        custom_text: answer.custom_text.clone(),
                    })
                    .collect();
                interactions
                    .get_mut(interaction_id)
                    .expect("validated Session resolution references its request")
                    .resolve(resolution.action, answers)
                    .expect("validated Session contains a valid question resolution");
            }
            EventData::QuestionCancelled {
                interaction_id,
                reason,
            } => {
                interactions
                    .get_mut(interaction_id)
                    .expect("validated Session cancellation references its request")
                    .cancel(reason.clone())
                    .expect("validated Session contains a valid question cancellation");
            }
            _ => {}
        }
    }
    order
        .into_iter()
        .filter_map(|interaction_id| {
            let interaction = interactions.remove(&interaction_id)?;
            let invocation = interaction.invocation().clone();
            if settled.contains(invocation.execution_id.as_str()) {
                return None;
            }
            let (turn, step, call) = calls.get(&invocation.execution_id)?.clone();
            Some(RecoverableUserQuestion {
                turn,
                step,
                call,
                draft: interaction.draft(),
                terminal: interaction.terminal_state(),
                invocation,
            })
        })
        .collect()
}

pub fn pending_user_questions(events: &[LoggedEvent]) -> Vec<PendingUserQuestion> {
    recoverable_user_questions(events)
        .into_iter()
        .filter_map(|question| {
            matches!(question.terminal, QuestionTerminalState::Pending).then_some(
                PendingUserQuestion {
                    turn: question.turn,
                    step: question.step,
                    call: question.call,
                    invocation: question.invocation,
                    draft: question.draft,
                },
            )
        })
        .collect()
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
    let recoverable_questions = recoverable_user_questions(events)
        .into_iter()
        .map(|question| question.call.id)
        .collect::<HashSet<_>>();
    incomplete_tool_calls(events)
        .into_iter()
        .filter(|pending| {
            !awaiting_approval.contains(&pending.call.id)
                && !recoverable_questions.contains(&pending.call.id)
        })
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

/// Close every started compaction that has no durable end marker. The normal
/// coordinator appends summary + replacement + successful end atomically, so
/// an unmatched start is always a failed, surface-neutral attempt.
pub fn interrupted_compaction_recovery(events: &[LoggedEvent]) -> Vec<SessionEvent> {
    let ended = events
        .iter()
        .filter_map(|event| match event.data() {
            EventData::CompactionEnd { compaction_id, .. } => Some(compaction_id.as_str()),
            _ => None,
        })
        .collect::<HashSet<_>>();
    events
        .iter()
        .filter_map(|event| match event.data() {
            EventData::CompactionStart {
                compaction_id,
                source_command_id,
                turn,
            } if !ended.contains(compaction_id.as_str()) => Some(
                EventData::CompactionEnd {
                    compaction_id: compaction_id.clone(),
                    source_command_id: source_command_id.clone(),
                    turn: *turn,
                    error: Some(COMPACTION_INTERRUPTED_ERROR.to_owned()),
                }
                .into(),
            ),
            _ => None,
        })
        .collect()
}

impl Session {
    /// Pure recovery candidates for the current immutable log snapshot.
    pub fn outcome_unknown_recovery(&self) -> Vec<SessionEvent> {
        outcome_unknown_recovery(self.events())
    }

    /// Close interrupted, surface-neutral compaction attempts before normal
    /// turn/step lifecycle recovery proceeds.
    pub fn interrupted_compaction_recovery(&self) -> Vec<SessionEvent> {
        interrupted_compaction_recovery(self.events())
    }

    /// Undecided, tool-bound approvals that can be resumed interactively.
    pub fn pending_tool_approvals(&self) -> Vec<PendingToolApproval> {
        pending_tool_approvals(self.events())
    }

    /// Question calls that can be safely reattached or replayed after restart.
    pub fn recoverable_user_questions(&self) -> Vec<RecoverableUserQuestion> {
        recoverable_user_questions(self.events())
    }

    /// Unsettled user questions for Web reconnect baselines.
    pub fn pending_user_questions(&self) -> Vec<PendingUserQuestion> {
        pending_user_questions(self.events())
    }
}

//! Read-only facts from real child execution, shared by inspect and the outbox.
//! No probing, provider selection, retry scheduling or new persisted state.
use serde_json::{json, Value};
use xharness_session::{AssistantChunk, EventData, LoggedEvent, Session, TurnEndReason};

fn observed_turn(
    child: &str,
    session: &Session,
    index: usize,
    turn: u32,
    reason: &TurnEndReason,
) -> Value {
    let closing = &session.events()[index];
    let prefix = &session.events()[..index];
    let start = prefix
        .iter()
        .rposition(|e| matches!(e.data(), EventData::TurnStart { turn: t } if *t == turn));
    // Missing legacy turn boundaries must not attribute another turn's request.
    let events = start.map_or(&prefix[0..0], |start| &prefix[start..]);
    let request = events.iter().rev().find_map(|e| match e.data() {
        EventData::RequestHeader { header } => Some(json!({
            "provider":header.provider,"model":header.model,
            "reasoning_effort":header.reasoning_effort,
        })),
        _ => None,
    });
    let output_observed = events.iter().any(|e| match e.data() {
        EventData::ModelReception {
            turn: t, reception, ..
        } if *t == turn => reception.first_delta_ms.is_some(),
        EventData::AssistantChunk { turn: t, chunk, .. } if *t == turn => match chunk {
            AssistantChunk::TextDelta(s) | AssistantChunk::ReasoningDelta(s) => !s.is_empty(),
            AssistantChunk::ToolCallDelta { .. } => true,
            _ => false,
        },
        EventData::AssistantMessage {
            turn: t, message, ..
        } if *t == turn => !message.content.is_empty() || !message.tool_calls.is_empty(),
        _ => false,
    });
    let tool_calls_observed = events
        .iter()
        .any(|e| matches!(e.data(), EventData::ToolCall { turn: t, .. } if *t == turn));
    let work = events.iter().find_map(|e| match e.data() {
        EventData::UserMessage { message, .. } => message.id.as_deref(),
        _ => None,
    });
    let mut notice = turn_notice(child, session, turn, reason);
    notice["work_id"] = json!(work);
    notice["settlement_seq"] = json!(closing.seq);
    notice["timestamp_ms"] = json!(closing.timestamp_ms);
    notice["execution"] = json!({"phase":"turn","request_recorded":request.is_some(),
        "request":request,"output_observed":output_observed,
        "tool_calls_observed":tool_calls_observed});
    notice
}

fn observed_failure(child: &str, event: &LoggedEvent, work: &str, error: &str) -> Value {
    let mut notice = failure_notice(child, work, error);
    notice["settlement_seq"] = json!(event.seq);
    notice["timestamp_ms"] = json!(event.timestamp_ms);
    notice["execution"] = json!({"phase":"without_turn_end"});
    notice
}

/// Preserve the existing outbox payload/fingerprint across upgrades, including
/// the crash window after parent admission but before the child delivery marker.
/// Additional local facts are available through inspect, not a rewritten receipt.
pub(super) fn turn_notice(
    child: &str,
    session: &Session,
    turn: u32,
    reason: &TurnEndReason,
) -> Value {
    let answer = session
        .events()
        .iter()
        .rev()
        .find_map(|e| match e.data() {
            EventData::AssistantMessage {
                turn: t, message, ..
            } if *t == turn => Some(message.content.as_str()),
            _ => None,
        })
        .unwrap_or("");
    json!({"agent_id":child,"turn":turn,"outcome":reason,
        "answer":super::bounded(answer,8192),"truncated":answer.len()>8192})
}

pub(super) fn failure_notice(child: &str, work: &str, error: &str) -> Value {
    json!({"agent_id":child,"outcome":{"kind":"failed","error":error},"work_id":work})
}

pub(super) fn latest_notice(child: &str, session: &Session) -> Option<Value> {
    let ownership_start = session
        .events()
        .iter()
        .rposition(|event| matches!(event.data(), EventData::AgentDelegated { .. }))
        .unwrap_or(0);
    session
        .events()
        .iter()
        .enumerate()
        .rev()
        .filter(|(index, _)| *index >= ownership_start)
        .find_map(|(index, event)| match event.data() {
            EventData::TurnEnd { turn, reason } => {
                Some(observed_turn(child, session, index, *turn, reason))
            }
            EventData::AgentDelegationFailure { message_id, error } => {
                Some(observed_failure(child, event, message_id, error))
            }
            _ => None,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use xharness_session::{Message, RequestHeader, SessionHeader, ToolCall};

    fn append(session: &mut Session, events: Vec<EventData>) {
        session
            .append_batch(
                session.revision(),
                events.into_iter().map(Into::into).collect(),
            )
            .unwrap();
    }
    fn open(turn: u32, work: &str) -> Vec<EventData> {
        vec![
            EventData::TurnStart { turn },
            EventData::UserMessage {
                message: Message::user("review").with_id(work),
                surface_replace: None,
            },
            EventData::StepStart { turn, step: 1 },
        ]
    }

    #[test]
    fn legacy_error_text_does_not_invent_retryability_or_reuse_old_request_facts() {
        let mut session = Session::new(SessionHeader::new("child")).unwrap();
        assert!(latest_notice("child", &session).is_none());
        let mut events = open(1, "first");
        let mut header = RequestHeader::new("old-provider", "old-model");
        header.input = vec![Message::user("sensitive input must not be exposed")];
        events.extend([
            EventData::RequestHeader { header },
            EventData::AssistantMessage {
                turn: 1,
                step: 1,
                message: Message::assistant("done"),
                usage: None,
            },
            EventData::StepEnd { turn: 1, step: 1 },
            EventData::TurnEnd {
                turn: 1,
                reason: TurnEndReason::Completed,
            },
        ]);
        append(&mut session, events);
        let prior = latest_notice("child", &session).unwrap();
        let mut events = open(2, "second");
        events.push(EventData::StepEnd { turn: 2, step: 1 });
        events.push(EventData::TurnEnd {
            turn: 2,
            reason: TurnEndReason::Failed {
                error: "HTTP 401? retryable? unknown legacy error".into(),
                provider_failure: None,
            },
        });
        append(&mut session, events);
        let latest = latest_notice("child", &session).unwrap();
        assert_eq!(latest["work_id"], "second");
        assert_eq!(latest["execution"]["request_recorded"], false);
        assert_eq!(latest["execution"]["output_observed"], false);
        assert!(latest["execution"]["request"].is_null());
        assert!(latest["outcome"].get("provider_failure").is_none());
        assert!(!prior.to_string().contains("sensitive input"));
    }

    #[test]
    fn committed_tool_calls_and_partial_output_are_reported_without_replaying_work() {
        let mut session = Session::new(SessionHeader::new("child")).unwrap();
        let mut events = open(1, "work");
        let call = ToolCall {
            id: "tool".into(),
            name: "shell".into(),
            arguments_json: "{}".into(),
            ..Default::default()
        };
        let mut message = Message::assistant("");
        message.tool_calls.push(call.clone());
        events.extend([
            EventData::AssistantChunk {
                turn: 1,
                step: 1,
                chunk: AssistantChunk::ReasoningDelta("partial".into()),
            },
            EventData::AssistantMessage {
                turn: 1,
                step: 1,
                message,
                usage: None,
            },
            EventData::ToolCall {
                turn: 1,
                step: 1,
                call,
            },
            EventData::ToolResult {
                turn: 1,
                step: 1,
                result: xharness_session::ToolResultData {
                    call_id: "tool".into(),
                    outcome: xharness_session::ToolOutcome::OutcomeUnknown,
                    content: "outcome unknown; check before retry".into(),
                    metadata: None,
                },
            },
            EventData::StepEnd { turn: 1, step: 1 },
            EventData::TurnEnd {
                turn: 1,
                reason: TurnEndReason::Interrupted,
            },
        ]);
        append(&mut session, events);
        let before = session.events().to_vec();
        let notice = latest_notice("child", &session).unwrap();
        assert_eq!(notice["outcome"]["kind"], "interrupted");
        assert_eq!(notice["execution"]["output_observed"], true);
        assert_eq!(notice["execution"]["tool_calls_observed"], true);
        assert_eq!(session.events(), before);
    }

    #[test]
    fn failure_without_turn_end_is_explicit_and_does_not_claim_no_side_effects() {
        let mut session = Session::new(SessionHeader::new("child")).unwrap();
        append(
            &mut session,
            vec![EventData::AgentDelegationFailure {
                message_id: "work".into(),
                error: "preparation failed".into(),
            }],
        );
        let notice = latest_notice("child", &session).unwrap();
        assert_eq!(notice["outcome"]["kind"], "failed");
        assert_eq!(notice["execution"]["phase"], "without_turn_end");
        assert!(notice["execution"].get("output_observed").is_none());
        assert!(notice["execution"].get("tool_calls_observed").is_none());
    }
}

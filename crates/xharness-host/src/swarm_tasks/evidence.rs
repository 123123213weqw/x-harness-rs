//! Bounded evidence for the exact consuming assignment, not a worker's latest turn.
use super::access::journal;
use crate::BasicHost;
use serde::Serialize;
use sha2::{Digest, Sha256};
use xharness_api::RpcError;
use xharness_control::{SwarmTask, SwarmTaskState};
use xharness_session::EventData;

#[derive(Serialize)]
pub(crate) struct Attempt {
    pub(crate) execution_ref: String,
    pub(crate) message_id: String,
    pub(crate) turn: Option<u32>,
    settlement_seq: u64,
    outcome: serde_json::Value,
    answer: String,
    truncated: bool,
    unresolved: bool,
}
fn bounded(text: &str, limit: usize) -> String {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].into()
}
pub(crate) async fn attempt(
    host: &BasicHost,
    task: &SwarmTask,
) -> Result<Option<Attempt>, RpcError> {
    let SwarmTaskState::Assigned {
        worker_session_id,
        message_id,
        ..
    } = &task.state
    else {
        return Ok(None);
    };
    let Some(cut) = journal(host, worker_session_id).await? else {
        return Ok(None);
    };
    let mut turn = None;
    let mut consumed = false;
    let mut observed = None;
    let mut answer = String::new();
    let mut truncated = false;
    for event in cut.events() {
        match event.data() {
            EventData::TurnStart { turn: t } => {
                turn = Some(*t);
                consumed = false;
                answer.clear();
                truncated = false;
            }
            EventData::UserMessage { message, .. }
                if message.id.as_deref() == Some(message_id.as_str()) && turn.is_some() =>
            {
                consumed = true
            }
            EventData::AssistantMessage {
                turn: t, message, ..
            } if consumed && turn == Some(*t) => {
                truncated = message.content.len() > 4096;
                answer = bounded(&message.content, 4096);
            }
            EventData::TurnEnd { turn: t, reason } if consumed && turn == Some(*t) => {
                observed = Some((
                    turn,
                    event.seq,
                    serde_json::to_value(reason).map_err(|e| RpcError::internal(e.to_string()))?,
                    answer.clone(),
                    truncated,
                ));
                break;
            }
            EventData::AgentDelegationFailure {
                message_id: id,
                error,
            } if id == message_id => {
                observed = Some((
                    None,
                    event.seq,
                    serde_json::json!({"kind":"failed","error":bounded(error,2048)}),
                    String::new(),
                    false,
                ));
                break;
            }
            _ => {}
        }
    }
    let Some((turn, seq, outcome, answer, truncated)) = observed else {
        return Ok(None);
    };
    let mut open = false;
    for event in cut.events() {
        match event.data() {
            EventData::TurnStart { .. } => open = true,
            EventData::TurnEnd { .. } => open = false,
            _ => {}
        }
    }
    let identity = serde_json::to_vec(&(worker_session_id, message_id, turn, seq))
        .map_err(|e| RpcError::internal(e.to_string()))?;
    Ok(Some(Attempt {
        execution_ref: format!("swarm-execution-{:x}", Sha256::digest(identity)),
        message_id: message_id.clone(),
        turn,
        settlement_seq: seq,
        outcome,
        truncated,
        answer,
        unresolved: open || !xharness_session::incomplete_tool_calls(cut.events()).is_empty(),
    }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn swarm_evidence_truncation_preserves_utf8_boundaries() {
        let source = "é".repeat(3000);
        let result = super::bounded(&source, 4095);
        assert_eq!(result.len(), 4094);
        assert!(source.starts_with(&result));
    }
}

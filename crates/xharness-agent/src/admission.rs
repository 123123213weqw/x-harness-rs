//! Shared internal-input failure boundary; independent of receipt producer.
use xharness_session::{EventData, InboxMessage, Session, TurnEndReason};

pub fn is_user_inbox_message(message: &InboxMessage) -> bool {
    let Some(metadata) = message.source.as_ref() else {
        return true;
    }; // legacy user input
    let source = metadata.get("source").unwrap_or(metadata);
    match source.get("kind").and_then(serde_json::Value::as_str) {
        Some("user") | None => true,
        Some(_) => false,
    }
}

pub fn is_completion_receipt(message: &InboxMessage) -> bool {
    let Some(metadata) = message.source.as_ref() else {
        return false;
    };
    let source = metadata.get("source").unwrap_or(metadata);
    matches!(
        source.get("kind").and_then(serde_json::Value::as_str),
        Some("job-settlement" | "agent-settlement")
    )
}

pub fn internal_inputs_blocked(session: &Session) -> bool {
    session
        .events()
        .iter()
        .rev()
        .find_map(|e| match e.data() {
            EventData::TurnEnd { reason, .. } => Some(!matches!(reason, TurnEndReason::Completed)),
            EventData::TurnStart { .. } => Some(false),
            _ => None,
        })
        .unwrap_or(false)
}

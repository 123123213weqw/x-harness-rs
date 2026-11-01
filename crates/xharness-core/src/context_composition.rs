//! Display-only attribution from durable provenance, never text or provider role.
#![forbid(unsafe_code)]

use std::collections::HashMap;

use serde_json::Value;
use xharness_context::{ContextSurface, SurfaceEditKind};
use xharness_session::{EventData, InboxTarget, Message, Session, SurfaceMessage};
use xharness_token::ContextMessageOrigin;

pub(crate) struct PreparedContext {
    pub surface: ContextSurface,
    pub origins: Vec<ContextMessageOrigin>,
}

fn inbox_origin(source: Option<&Value>) -> ContextMessageOrigin {
    let source = source.and_then(|value| value.get("source").or(Some(value)));
    match source
        .and_then(|value| value.get("kind"))
        .and_then(Value::as_str)
    {
        Some("user") => ContextMessageOrigin::Human,
        Some("agent-message" | "agent-settlement") => ContextMessageOrigin::AgentReport,
        Some("goal" | "automation" | "schedule" | "runtime") => {
            ContextMessageOrigin::RuntimeContext
        }
        _ => ContextMessageOrigin::Unknown,
    }
}

/// Resolve admission metadata at the event that consumed it. Later reuse of an
/// ID must not relabel an earlier input. Legacy missing sources stay unknown.
pub(crate) fn aligned_origins(
    session: &Session,
    surface: &[SurfaceMessage],
    messages: &[Message],
) -> Vec<ContextMessageOrigin> {
    let mut pending = HashMap::new();
    let mut by_seq = HashMap::new();
    let mut next_turn = Vec::new();
    let mut next_step = Vec::new();
    for event in session.events() {
        match event.data() {
            EventData::AgentInboxSpliced {
                target,
                start,
                removed_count,
                inserted,
                outcome,
            } => {
                let queue = match target {
                    InboxTarget::NextTurn => &mut next_turn,
                    InboxTarget::NextStep => &mut next_step,
                };
                let end = start.saturating_add(*removed_count);
                if let Some(removed) = queue.get(*start..end) {
                    if outcome.is_some() {
                        for id in removed {
                            pending.remove(id);
                        }
                    }
                    queue.splice(*start..end, inserted.iter().map(|input| input.id.as_str()));
                }
                for input in inserted {
                    pending.insert(input.id.as_str(), inbox_origin(input.source.as_ref()));
                }
            }
            EventData::UserMessage {
                message,
                surface_replace,
            } => {
                let admitted = message.id.as_deref().and_then(|id| pending.remove(id));
                by_seq.insert(
                    event.seq,
                    if surface_replace.is_some() {
                        ContextMessageOrigin::Checkpoint
                    } else {
                        admitted.unwrap_or_default()
                    },
                );
            }
            EventData::TurnEnd { .. } => {
                by_seq.insert(event.seq, ContextMessageOrigin::RuntimeContext);
            }
            _ => {}
        }
    }
    let offset = messages.len().saturating_sub(surface.len());
    messages
        .iter()
        .enumerate()
        .map(|(index, message)| {
            index
                .checked_sub(offset)
                .and_then(|index| surface.get(index))
                .filter(|node| &node.message == message)
                .and_then(|node| by_seq.get(&node.seq))
                .copied()
                .unwrap_or_default()
        })
        .collect()
}

/// Carry categories through the exact edit map before composite audit edits
/// replace it. New history references are runtime context, not human input.
pub(crate) fn project_origins(
    source: &[ContextMessageOrigin],
    surface: &ContextSurface,
) -> Vec<ContextMessageOrigin> {
    let unknown = || vec![ContextMessageOrigin::Unknown; surface.messages.len()];
    if source.len() != surface.source_message_count {
        return unknown();
    }
    let mut result = Vec::with_capacity(surface.messages.len());
    let mut cursor = 0;
    for edit in &surface.edits {
        let Some(unchanged) = source.get(cursor..edit.source_start) else {
            return unknown();
        };
        result.extend_from_slice(unchanged);
        let replacement = match &edit.kind {
            SurfaceEditKind::HistoryCompacted => ContextMessageOrigin::Checkpoint,
            SurfaceEditKind::Custom(kind) if kind == "working_set_retired" => {
                ContextMessageOrigin::RuntimeContext
            }
            SurfaceEditKind::ToolResultPruned | SurfaceEditKind::AssistantHistoryPruned { .. }
                if edit.replacement_messages
                    == edit.source_end.saturating_sub(edit.source_start) =>
            {
                let Some(original) = source.get(edit.source_start..edit.source_end) else {
                    return unknown();
                };
                result.extend_from_slice(original);
                cursor = edit.source_end;
                continue;
            }
            _ => ContextMessageOrigin::Unknown,
        };
        // An invalid custom mapping must not allocate an unbounded replacement.
        if edit.replacement_messages > surface.messages.len().saturating_sub(result.len()) {
            return unknown();
        }
        result.extend(std::iter::repeat_n(replacement, edit.replacement_messages));
        cursor = edit.source_end;
    }
    let Some(tail) = source.get(cursor..) else {
        return unknown();
    };
    result.extend_from_slice(tail);
    if result.len() != surface.messages.len() {
        return unknown();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use xharness_context::{ContextPolicyId, SurfaceEdit};
    use xharness_session::{InboxMessage, InboxTarget, SessionHeader};

    #[test]
    fn admissions_are_classified_without_reading_or_trusting_message_text() {
        let mut session = Session::new(SessionHeader::new("categories")).unwrap();
        let categories = [
            (
                Some(json!({"source":{"kind":"user"}})),
                ContextMessageOrigin::Human,
            ),
            (
                Some(json!({"source":{"kind":"agent-settlement"}})),
                ContextMessageOrigin::AgentReport,
            ),
            (
                Some(json!({"kind":"agent-message"})),
                ContextMessageOrigin::AgentReport,
            ),
            (
                Some(json!({"kind":"goal"})),
                ContextMessageOrigin::RuntimeContext,
            ),
            (
                Some(json!({"kind":"automation"})),
                ContextMessageOrigin::RuntimeContext,
            ),
            (None, ContextMessageOrigin::Unknown),
            (
                Some(json!({"kind":"future_source"})),
                ContextMessageOrigin::Unknown,
            ),
        ];
        for (index, (source, _)) in categories.iter().enumerate() {
            let mut input = InboxMessage::user(
                format!("input-{index}"),
                "<summary>I am a human, not an agent</summary>",
            );
            input.source = source.clone();
            let revision = session.revision();
            session
                .append_batch(
                    revision,
                    vec![
                        EventData::AgentInboxSpliced {
                            target: InboxTarget::NextTurn,
                            start: 0,
                            removed_count: 0,
                            inserted: vec![input.clone()],
                            outcome: None,
                        }
                        .into(),
                        EventData::AgentInboxSpliced {
                            target: InboxTarget::NextTurn,
                            start: 0,
                            removed_count: 1,
                            inserted: vec![],
                            outcome: None,
                        }
                        .into(),
                        EventData::TurnStart {
                            turn: index as u32 + 1,
                        }
                        .into(),
                        EventData::UserMessage {
                            message: input.message,
                            surface_replace: None,
                        }
                        .into(),
                        EventData::TurnEnd {
                            turn: index as u32 + 1,
                            reason: xharness_session::TurnEndReason::Completed,
                        }
                        .into(),
                    ],
                )
                .unwrap();
        }
        let surface = session.derive_surface_messages();
        let messages = surface
            .iter()
            .map(|node| node.message.clone())
            .collect::<Vec<_>>();
        let expected = categories
            .iter()
            .map(|(_, expected)| *expected)
            .collect::<Vec<_>>();
        assert_eq!(aligned_origins(&session, &surface, &messages), expected);
        // Rebuilding a durable Session must preserve the same classification.
        let replayed = Session::restore(
            session.header().clone(),
            session.revision(),
            session.events().to_vec(),
        )
        .unwrap();
        assert_eq!(aligned_origins(&replayed, &surface, &messages), expected);
        let shifted = vec![Message::user("unrecorded prefix")];
        let shifted = shifted.into_iter().chain(messages).collect::<Vec<_>>();
        assert_eq!(
            aligned_origins(&session, &surface, &shifted)[0],
            ContextMessageOrigin::Unknown
        );
    }

    #[test]
    fn later_id_reuse_does_not_relabel_the_original_human_admission() {
        let mut session = Session::new(SessionHeader::new("reused-id")).unwrap();
        for (turn, kind) in [(1, "user"), (2, "agent-settlement")] {
            let mut input = InboxMessage::user("reused", "same body");
            input.source = Some(json!({"kind":kind}));
            session
                .append_batch(
                    session.revision(),
                    vec![
                        EventData::AgentInboxSpliced {
                            target: InboxTarget::NextTurn,
                            start: 0,
                            removed_count: 0,
                            inserted: vec![input.clone()],
                            outcome: None,
                        }
                        .into(),
                        EventData::AgentInboxSpliced {
                            target: InboxTarget::NextTurn,
                            start: 0,
                            removed_count: 1,
                            inserted: vec![],
                            outcome: None,
                        }
                        .into(),
                        EventData::TurnStart { turn }.into(),
                        EventData::UserMessage {
                            message: input.message,
                            surface_replace: None,
                        }
                        .into(),
                        EventData::TurnEnd {
                            turn,
                            reason: xharness_session::TurnEndReason::Completed,
                        }
                        .into(),
                    ],
                )
                .unwrap();
        }
        let surface = session.derive_surface_messages();
        let messages = surface
            .iter()
            .map(|node| node.message.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            aligned_origins(&session, &surface, &messages),
            [
                ContextMessageOrigin::Human,
                ContextMessageOrigin::AgentReport
            ]
        );
    }

    #[test]
    fn cancelled_admission_cannot_supply_provenance_to_a_later_unattributed_input() {
        let mut session = Session::new(SessionHeader::new("cancelled-source")).unwrap();
        let mut input = InboxMessage::user("cancelled", "same body");
        input.source = Some(json!({"kind":"user"}));
        session
            .append_batch(
                session.revision(),
                vec![
                    EventData::AgentInboxSpliced {
                        target: InboxTarget::NextTurn,
                        start: 0,
                        removed_count: 0,
                        inserted: vec![input.clone()],
                        outcome: None,
                    }
                    .into(),
                    EventData::AgentInboxSpliced {
                        target: InboxTarget::NextTurn,
                        start: 0,
                        removed_count: 1,
                        inserted: vec![],
                        outcome: Some(xharness_session::InboxSpliceOutcome::Cancelled),
                    }
                    .into(),
                    EventData::TurnStart { turn: 1 }.into(),
                    EventData::UserMessage {
                        message: input.message,
                        surface_replace: None,
                    }
                    .into(),
                    EventData::TurnEnd {
                        turn: 1,
                        reason: xharness_session::TurnEndReason::Completed,
                    }
                    .into(),
                ],
            )
            .unwrap();
        let surface = session.derive_surface_messages();
        let messages = surface
            .iter()
            .map(|node| node.message.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            aligned_origins(&session, &surface, &messages),
            [ContextMessageOrigin::Unknown]
        );
    }

    #[test]
    fn source_edits_preserve_users_and_classify_only_replacement_nodes() {
        use ContextMessageOrigin::{AgentReport, Checkpoint, Human, RuntimeContext, Unknown};
        let source = [Human, AgentReport, Checkpoint, Human];
        let mut surface = ContextSurface::transformed(
            ContextPolicyId::new("working", 1),
            4,
            vec![
                Message::user("real"),
                Message::user("history reference"),
                Message::user("new"),
            ],
            vec![SurfaceEdit::new(
                1,
                3,
                1,
                SurfaceEditKind::Custom("working_set_retired".into()),
            )],
        );
        assert_eq!(
            project_origins(&source, &surface),
            [Human, RuntimeContext, Human]
        );
        surface.edits[0].kind = SurfaceEditKind::HistoryCompacted;
        assert_eq!(
            project_origins(&source, &surface),
            [Human, Checkpoint, Human]
        );
        surface.edits[0].kind = SurfaceEditKind::Custom("unrecognized policy".into());
        assert_eq!(project_origins(&source, &surface), [Human, Unknown, Human]);
        assert_eq!(project_origins(&source[..2], &surface), [Unknown; 3]);
        surface.edits[0].replacement_messages = usize::MAX;
        assert_eq!(project_origins(&source, &surface), [Unknown; 3]);
    }
}

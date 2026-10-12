//! Journal provenance for disposable working sets. No semantic task classifier.
use std::collections::{HashMap, HashSet};
use xharness_context::{WorkingSetSource, WorkingSetSourceKind};
use xharness_session::{EventData, Message, Session, SurfaceMessage, ToolOutcome};

pub(crate) fn sources(
    session: &Session,
    surface: &[SurfaceMessage],
) -> Vec<Option<WorkingSetSource>> {
    let outcomes = session
        .events()
        .iter()
        .filter_map(|event| match event.data() {
            EventData::ToolResult { result, .. } => Some((result.call_id.as_str(), result.outcome)),
            _ => None,
        })
        .collect::<HashMap<_, _>>();
    surface
        .iter()
        .map(|node| {
            let event = session.events().get(node.seq as usize)?;
            let (kind, unknown) = match event.data() {
                EventData::UserMessage {
                    surface_replace: Some(_),
                    ..
                } => (WorkingSetSourceKind::Checkpoint, false),
                EventData::UserMessage {
                    surface_replace: None,
                    ..
                } => (WorkingSetSourceKind::RawUser, false),
                EventData::AssistantMessage { message, .. } => (
                    WorkingSetSourceKind::RawAssistant,
                    message.tool_calls.iter().any(|call| {
                        outcomes
                            .get(call.id.as_str())
                            .is_none_or(|outcome| *outcome == ToolOutcome::OutcomeUnknown)
                    }),
                ),
                EventData::ToolResult { result, .. } => (
                    WorkingSetSourceKind::ToolResult,
                    result.outcome == ToolOutcome::OutcomeUnknown,
                ),
                EventData::TurnEnd { .. } => (WorkingSetSourceKind::RuntimeControl, false),
                _ => return None,
            };
            Some(WorkingSetSource {
                seq: node.seq,
                kind,
                outcome_unknown: unknown,
            })
        })
        .collect()
}

/// Conservative source anchors remain exact. No user text is automatically
/// turned into a permanent global permission, and no old checkpoint is a new
/// user instruction. Whole unknown/open tool units are protected by boundaries.
pub(crate) fn protected(
    surface: &[SurfaceMessage],
    sources: &[Option<WorkingSetSource>],
) -> HashSet<u64> {
    surface
        .iter()
        .zip(sources)
        .filter_map(|(node, source)| {
            let pinned = source.is_none_or(|source| {
                source.outcome_unknown
                    || matches!(
                        source.kind,
                        WorkingSetSourceKind::RawUser
                            | WorkingSetSourceKind::CurrentCheckpoint
                            | WorkingSetSourceKind::Checkpoint
                            | WorkingSetSourceKind::RuntimeControl
                    )
            });
            (pinned
                || !node.message.provider_items.is_empty()
                || node.message.interrupted
                || node.message.role == xharness_session::MessageRole::System)
                .then_some(node.seq)
        })
        .collect()
}

pub(crate) fn aligned(
    messages: &[Message],
    surface: &[SurfaceMessage],
    sources: &[Option<WorkingSetSource>],
) -> Vec<Option<WorkingSetSource>> {
    let offset = messages.len().saturating_sub(surface.len());
    messages
        .iter()
        .enumerate()
        .map(|(i, message)| {
            let index = i.checked_sub(offset)?;
            let node = surface.get(index)?;
            if &node.message != message {
                return None;
            }
            sources.get(index).copied().flatten()
        })
        .collect()
}

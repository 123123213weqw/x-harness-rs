//! Incremental preparation for the rebuildable live tail, never the journal.
#![forbid(unsafe_code)]

use super::*;

pub struct TailReplacement {
    pub seq: u64,
    pub event: Value,
    pub bytes: usize,
    pub resident_bytes: usize,
}

pub enum ProjectedTailUpdate {
    Replace(ProjectedEventTail),
    Append {
        tail: ProjectedEventTail,
        replacements: Vec<TailReplacement>,
    },
}

/// Reuse prior JSON only for events whose presentation dependencies are local.
/// Unknown and cross-event lifecycle changes retain the canonical full fold.
/// Preparation borrows the immutable snapshot; it never clones the old cache.
pub fn prepare_session_tail_update(
    session: &Session,
    route: &dyn ProjectionRoute,
    base_seq: u64,
    previous: Option<u64>,
    reusable_route: bool,
    max_events: usize,
    max_bytes: usize,
) -> ProjectedTailUpdate {
    let Some(previous) = previous.filter(|_| reusable_route) else {
        return ProjectedTailUpdate::Replace(project_session_event_tail_from(
            session, route, base_seq, max_events, max_bytes,
        ));
    };
    let start = usize::try_from(previous).unwrap_or(usize::MAX);
    let Some(delta) = session.events().get(start..) else {
        return ProjectedTailUpdate::Replace(project_session_event_tail_from(
            session, route, base_seq, max_events, max_bytes,
        ));
    };
    let safe = delta.iter().all(|event| match event.data() {
        EventData::AssistantChunk { .. }
        | EventData::StepStart { .. }
        | EventData::StepEnd { .. }
        | EventData::ToolCall { .. }
        | EventData::ToolResult { .. }
        | EventData::TurnEnd { .. }
        | EventData::ModelReception { .. } => true,
        EventData::AssistantMessage { message, .. } => message.role == MessageRole::Assistant,
        _ => false,
    });
    if !safe {
        return ProjectedTailUpdate::Replace(project_session_event_tail_from(
            session, route, base_seq, max_events, max_bytes,
        ));
    }
    let tail = project_session_event_tail_from(session, route, previous, max_events, max_bytes);
    // An oversized delta has already advanced the canonical tail past every
    // old entry. Preserve that exact contiguous suffix rather than invent gaps.
    if tail.base_seq != previous {
        return ProjectedTailUpdate::Replace(tail);
    }
    let completed = delta
        .iter()
        .filter_map(|event| match event.data() {
            EventData::AssistantMessage { turn, step, .. } => Some((*turn, *step)),
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    let mut replacements = Vec::new();
    if !completed.is_empty() {
        let floor = usize::try_from(base_seq).unwrap_or(start).min(start);
        let sources = ProjectionSources::default();
        for source in &session.events()[floor..start] {
            if is_folded_assistant_chunk(source, &completed) {
                let event = restored_web_event(source, route, &sources, None, Some(&completed));
                let bytes = serde_json::to_vec(&event)
                    .map(|value| value.len())
                    .unwrap_or(max_bytes.saturating_add(1));
                let resident_bytes = estimated_event_resident_bytes(&event).max(bytes);
                replacements.push(TailReplacement {
                    seq: source.seq,
                    event,
                    bytes,
                    resident_bytes,
                });
            }
        }
    }
    ProjectedTailUpdate::Append { tail, replacements }
}

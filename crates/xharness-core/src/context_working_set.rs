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

/// Body-free durable selection. Only a fresh pressure decision may move these
/// ranges; append-only continuation reuses the same early history reference.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct StableSelection {
    version: u32,
    source_messages: usize,
    source_sha256: String,
    retired_ranges: Vec<(usize, usize)>,
}

impl StableSelection {
    pub(crate) fn restore(value: &serde_json::Value) -> Option<Self> {
        // Reject oversized/malformed optional metadata before deserialization.
        let ranges = value.get("retiredRanges")?.as_array()?;
        if ranges.is_empty() || ranges.len() > 4096 {
            return None;
        }
        let selection: Self = serde_json::from_value(value.clone()).ok()?;
        if selection.version != 1
            || selection.source_sha256.len() != 64
            || !selection
                .source_sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
        {
            return None;
        }
        let mut end = 0;
        for &(start, next) in &selection.retired_ranges {
            if start < end || start >= next || next > selection.source_messages {
                return None;
            }
            end = next;
        }
        (end == selection.source_messages).then_some(selection)
    }

    pub(crate) fn matches(
        &self,
        messages: &[Message],
        sources: &[Option<WorkingSetSource>],
    ) -> Result<bool, xharness_context::ContextError> {
        if messages.len() < self.source_messages || sources.len() != messages.len() {
            return Ok(false);
        }
        Ok(self.source_sha256
            == prefix_hash(
                &messages[..self.source_messages],
                &sources[..self.source_messages],
            )?)
    }

    pub(crate) fn capture(
        messages: &[Message],
        sources: &[Option<WorkingSetSource>],
        surface: &xharness_context::ContextSurface,
    ) -> Result<Option<Self>, xharness_context::ContextError> {
        if surface.edits.is_empty() {
            return Ok(None);
        }
        let retired_ranges = surface
            .edits
            .iter()
            .map(|edit| (edit.source_start, edit.source_end))
            .collect::<Vec<_>>();
        let source_messages = retired_ranges.last().map_or(0, |(_, end)| *end);
        if source_messages > messages.len() || sources.len() != messages.len() {
            return Err(xharness_context::ContextError::invalid_surface(
                "working-set capture does not match source",
            ));
        }
        Ok(Some(Self {
            version: 1,
            source_messages,
            source_sha256: prefix_hash(&messages[..source_messages], &sources[..source_messages])?,
            retired_ranges,
        }))
    }

    /// Large selections can still be reused in memory. Optional durable
    /// metadata has a fixed bound; a cold runner can safely recount full input.
    pub(crate) fn metadata(
        &self,
    ) -> Result<Option<serde_json::Value>, xharness_context::ContextError> {
        if self.retired_ranges.len() > 4096 {
            return Ok(None);
        }
        serde_json::to_value(self)
            .map(Some)
            .map_err(|error| xharness_context::ContextError::invalid_surface(error.to_string()))
    }

    pub(crate) fn ranges(&self) -> &[(usize, usize)] {
        &self.retired_ranges
    }
}

fn prefix_hash(
    messages: &[Message],
    sources: &[Option<WorkingSetSource>],
) -> Result<String, xharness_context::ContextError> {
    use sha2::{Digest, Sha256};
    struct HashWriter(Sha256);
    impl std::io::Write for HashWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = HashWriter(Sha256::new());
    serde_json::to_writer(&mut writer, &(messages, sources))
        .map_err(|error| xharness_context::ContextError::invalid_surface(error.to_string()))?;
    Ok(format!("{:x}", writer.0.finalize()))
}

#[cfg(test)]
mod stable_tests {
    use super::*;
    use xharness_session::{MessageRole, ToolCall};

    #[test]
    fn body_free_selection_roundtrip_accepts_append_but_rejects_changed_prefix_or_provenance() {
        let mut assistant = Message::assistant("inspect");
        assistant.tool_calls.push(ToolCall {
            id: "read-1".into(),
            name: "read".into(),
            arguments_json: "{}".into(),
            ..ToolCall::default()
        });
        let messages = vec![
            Message::user("Do not publish"),
            assistant,
            Message::tool("read-1", "PRIVATE_RESULT".repeat(2000)),
        ];
        let sources = vec![
            Some(WorkingSetSource {
                seq: 1,
                kind: WorkingSetSourceKind::RawUser,
                outcome_unknown: false,
            }),
            Some(WorkingSetSource {
                seq: 2,
                kind: WorkingSetSourceKind::RawAssistant,
                outcome_unknown: false,
            }),
            Some(WorkingSetSource {
                seq: 3,
                kind: WorkingSetSourceKind::ToolResult,
                outcome_unknown: false,
            }),
        ];
        let surface = xharness_context::project_working_set(
            messages.clone(),
            &sources,
            &xharness_context::WorkingSetConfig {
                pressure: true,
                available_input_tokens: 100,
                recent_tokens: 0,
                hot_input_budget: None,
                retain_checkpoints: 2,
            },
        )
        .unwrap();
        let selection = StableSelection::capture(&messages, &sources, &surface)
            .unwrap()
            .unwrap();
        let encoded = selection.metadata().unwrap().unwrap();
        let mut oversized = selection.clone();
        oversized.retired_ranges = vec![(1, 3); 4097];
        assert!(
            oversized.metadata().unwrap().is_none(),
            "metadata size must never reject a valid live request"
        );
        assert!(!encoded.to_string().contains("PRIVATE_RESULT"));
        assert!(!encoded.to_string().contains("Do not publish"));
        let restored = StableSelection::restore(&encoded).unwrap();
        let mut appended = messages.clone();
        appended.push(Message::user("continue"));
        let mut appended_sources = sources.clone();
        appended_sources.push(Some(WorkingSetSource {
            seq: 4,
            kind: WorkingSetSourceKind::RawUser,
            outcome_unknown: false,
        }));
        assert!(restored.matches(&appended, &appended_sources).unwrap());
        let mut changed = messages.clone();
        changed[0].content = "different instructions".into();
        assert!(!restored.matches(&changed, &sources).unwrap());
        let mut changed_sources = sources.clone();
        changed_sources[2].as_mut().unwrap().outcome_unknown = true;
        assert!(!restored.matches(&messages, &changed_sources).unwrap());
        changed[0].role = MessageRole::System;
        assert!(!restored.matches(&changed, &sources).unwrap());
        for invalid in [
            serde_json::json!({}),
            serde_json::json!({"version":2}),
            serde_json::json!({"version":1,"sourceMessages":3,"sourceSha256":"f".repeat(64),"retiredRanges":[[0,4]]}),
        ] {
            assert!(StableSelection::restore(&invalid).is_none());
        }
    }
}

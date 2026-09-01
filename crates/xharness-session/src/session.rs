use std::{collections::HashMap, sync::Arc, time::SystemTime};

use serde::{Deserialize, Serialize};

use crate::{
    EventData, InboxMessage, InboxTarget, LoggedEvent, Message, MessageRole, Revision, Sequence,
    SessionEvent,
};
use xharness_interaction::{
    QuestionAnswer, QuestionInteraction, QuestionStateError, QuestionTerminalState,
    ASK_USER_QUESTION_TOOL,
};

/// On-disk format identity and immutable metadata outside the conversation
/// event stream.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionHeader {
    pub version: u32,
    pub id: String,
    pub created_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

impl SessionHeader {
    pub const FORMAT_VERSION: u32 = 1;

    pub fn new(id: impl Into<String>) -> Self {
        Self {
            version: Self::FORMAT_VERSION,
            id: id.into(),
            created_at_ms: unix_timestamp_ms(),
            cwd: None,
        }
    }
}

/// Immutable-history session snapshot.
#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    header: SessionHeader,
    revision: Revision,
    /// Immutable cuts share their already-validated prefix. `Arc::make_mut`
    /// preserves detached snapshot semantics when a caller still owns an old
    /// cut, while the ordinary single-writer path appends without cloning the
    /// whole log.
    events: Arc<Vec<LoggedEvent>>,
}

/// Result of one successful compare-and-swap append.
#[derive(Clone, Debug, PartialEq)]
pub struct AppendReceipt {
    pub previous_revision: Revision,
    pub revision: Revision,
    pub first_seq: Sequence,
    pub last_seq: Option<Sequence>,
    pub events: Vec<LoggedEvent>,
}

/// An owned, read-only logical inspection cut.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionInspection {
    pub header: SessionHeader,
    pub revision: Revision,
    pub next_seq: Sequence,
    pub events: Vec<LoggedEvent>,
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum SessionError {
    #[error("session id must not be empty")]
    EmptySessionId,
    #[error("unsupported session format version {actual}; expected {expected}")]
    UnsupportedVersion { expected: u32, actual: u32 },
    #[error("session sequence mismatch: expected {expected}, got {actual}")]
    SequenceMismatch {
        expected: Sequence,
        actual: Sequence,
    },
    #[error("session revision conflict: expected {expected:?}, actual {actual:?}")]
    RevisionConflict {
        expected: Revision,
        actual: Revision,
    },
    #[error("session revision overflow")]
    RevisionOverflow,
    #[error("invalid logged revision at seq {seq}: expected {expected:?}, got {actual:?}")]
    LoggedRevisionMismatch {
        seq: Sequence,
        expected: Revision,
        actual: Revision,
    },
    #[error("event at seq {seq} has invalid {role} message role")]
    InvalidMessageRole { seq: Sequence, role: &'static str },
    #[error("tool call id must not be empty at seq {seq}")]
    EmptyToolCallId { seq: Sequence },
    #[error("provider-native tool call id must not be empty at seq {seq}")]
    EmptyProviderToolCallId { seq: Sequence },
    #[error("tool name must not be empty at seq {seq}")]
    EmptyToolName { seq: Sequence },
    #[error("duplicate tool call id {call_id:?} at seq {seq}")]
    DuplicateToolCall { seq: Sequence, call_id: String },
    #[error("tool result at seq {seq} references unknown call id {call_id:?}")]
    UnknownToolCall { seq: Sequence, call_id: String },
    #[error("duplicate tool result for call id {call_id:?} at seq {seq}")]
    DuplicateToolResult { seq: Sequence, call_id: String },
    #[error("invalid session lifecycle at seq {seq}: {message}")]
    InvalidLifecycle { seq: Sequence, message: String },
    #[error(
        "tool-call audit at seq {seq} does not mirror assistant call {position} in turn {turn} step {step}"
    )]
    ToolCallMirrorMismatch {
        seq: Sequence,
        turn: u32,
        step: u32,
        position: usize,
    },
    #[error("inbox message id must not be empty at seq {seq}")]
    EmptyInboxMessageId { seq: Sequence },
    #[error("inbox message {message_id:?} at seq {seq} must have the user role")]
    InvalidInboxMessageRole { seq: Sequence, message_id: String },
    #[error("inbox message {message_id:?} at seq {seq} must carry the same message id")]
    InboxMessageIdMismatch { seq: Sequence, message_id: String },
    #[error("duplicate pending inbox message id {message_id:?} at seq {seq}")]
    DuplicateInboxMessage { seq: Sequence, message_id: String },
    #[error("invalid inbox splice at seq {seq}: {message}")]
    InvalidInboxSplice { seq: Sequence, message: String },
}

impl Session {
    pub fn new(header: SessionHeader) -> Result<Self, SessionError> {
        validate_header(&header)?;
        Ok(Self {
            header,
            revision: Revision::ZERO,
            events: Arc::new(Vec::new()),
        })
    }

    /// Restore a complete storage snapshot while rechecking every append
    /// invariant. No partially valid prefix is returned.
    pub fn restore(
        header: SessionHeader,
        revision: Revision,
        events: Vec<LoggedEvent>,
    ) -> Result<Self, SessionError> {
        validate_header(&header)?;
        validate_log(revision, &events)?;
        Ok(Self {
            header,
            revision,
            events: Arc::new(events),
        })
    }

    pub const fn header(&self) -> &SessionHeader {
        &self.header
    }

    pub const fn revision(&self) -> Revision {
        self.revision
    }

    pub fn events(&self) -> &[LoggedEvent] {
        self.events.as_slice()
    }

    pub fn next_seq(&self) -> Sequence {
        self.events.len() as Sequence
    }

    /// Append one event under a single-writer revision check.
    pub fn append(
        &mut self,
        expected_revision: Revision,
        event: impl Into<SessionEvent>,
    ) -> Result<LoggedEvent, SessionError> {
        let receipt = self.append_batch(expected_revision, vec![event.into()])?;
        Ok(receipt
            .events
            .into_iter()
            .next()
            .expect("a one-event append returns one event"))
    }

    /// Atomically append a batch. Every event receives a contiguous sequence
    /// number and the batch's one new revision. An empty batch is a checked
    /// no-op and does not advance the revision.
    pub fn append_batch(
        &mut self,
        expected_revision: Revision,
        events: Vec<SessionEvent>,
    ) -> Result<AppendReceipt, SessionError> {
        self.append_batch_at(expected_revision, events, unix_timestamp_ms())
    }

    /// Deterministic-clock form used by persistence providers and tests.
    pub fn append_batch_at(
        &mut self,
        expected_revision: Revision,
        events: Vec<SessionEvent>,
        timestamp_ms: u64,
    ) -> Result<AppendReceipt, SessionError> {
        if expected_revision != self.revision {
            return Err(SessionError::RevisionConflict {
                expected: expected_revision,
                actual: self.revision,
            });
        }

        let first_seq = self.next_seq();
        if events.is_empty() {
            return Ok(AppendReceipt {
                previous_revision: self.revision,
                revision: self.revision,
                first_seq,
                last_seq: None,
                events: Vec::new(),
            });
        }

        let revision = Revision(
            self.revision
                .0
                .checked_add(1)
                .ok_or(SessionError::RevisionOverflow)?,
        );
        let mut staged = Vec::with_capacity(events.len());
        for (offset, event) in events.into_iter().enumerate() {
            staged.push(LoggedEvent {
                seq: first_seq + offset as Sequence,
                revision,
                timestamp_ms,
                event,
            });
        }

        let previous_revision = self.revision;
        // Extend the uniquely owned hot log before validation so the common
        // path does not allocate and clone its entire immutable prefix. If an
        // older Session cut is still alive, `make_mut` performs the required
        // copy-on-write detachment. A rejected batch is rolled back in place.
        let events = Arc::make_mut(&mut self.events);
        let previous_len = events.len();
        events.extend(staged.iter().cloned());
        if let Err(error) = validate_log(revision, events) {
            events.truncate(previous_len);
            return Err(error);
        }
        self.revision = revision;
        Ok(AppendReceipt {
            previous_revision,
            revision,
            first_seq,
            last_seq: staged.last().map(|event| event.seq),
            events: staged,
        })
    }

    /// Pure provider-history projection over the immutable event snapshot.
    pub fn derive_messages(&self) -> Vec<Message> {
        derive_messages(self.events())
    }

    /// Current model-facing surface with the durable source coordinate of
    /// every message. Compaction planners use these coordinates to journal an
    /// immutable head replacement without deleting source history.
    pub fn derive_surface_messages(&self) -> Vec<SurfaceMessage> {
        derive_surface_messages(self.events())
    }

    pub fn inspect(&self) -> SessionInspection {
        SessionInspection {
            header: self.header.clone(),
            revision: self.revision,
            next_seq: self.next_seq(),
            events: self.events.as_ref().clone(),
        }
    }
}

/// Pure provider-history projection. Raw chunks, lifecycle boundaries, request
/// headers, and tool-call audit facts never become a second message.
pub fn derive_messages(events: &[LoggedEvent]) -> Vec<Message> {
    derive_surface_messages(events)
        .into_iter()
        .map(|node| node.message)
        .collect()
}

/// One visible provider-history node and the event that introduced it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceMessage {
    pub seq: Sequence,
    pub message: Message,
}

/// Pure current-surface projection. Replacement checkpoints shadow immutable
/// source nodes but never rewrite or delete the underlying event log.
pub fn derive_surface_messages(events: &[LoggedEvent]) -> Vec<SurfaceMessage> {
    let mut provider_call_ids = HashMap::<String, String>::new();
    let mut messages = Vec::new();
    let mut call_order = Vec::<String>::new();
    let mut tool_results = HashMap::<String, (Sequence, String)>::new();

    fn flush_tool_results(
        messages: &mut Vec<SurfaceMessage>,
        call_order: &mut Vec<String>,
        tool_results: &mut HashMap<String, (Sequence, String)>,
        provider_call_ids: &HashMap<String, String>,
    ) {
        for call_id in call_order.drain(..) {
            let Some((seq, content)) = tool_results.remove(&call_id) else {
                continue;
            };
            messages.push(SurfaceMessage {
                seq,
                message: Message::tool(
                    provider_call_ids.get(&call_id).cloned().unwrap_or(call_id),
                    content,
                ),
            });
        }
        // A valid log associates results with the current assistant batch.
        // Preserve a deterministic fallback for legacy snapshots whose audit
        // events predate that lifecycle invariant.
        let mut leftovers = tool_results.drain().collect::<Vec<_>>();
        leftovers.sort_by(|left, right| left.0.cmp(&right.0));
        for (call_id, (seq, content)) in leftovers {
            messages.push(SurfaceMessage {
                seq,
                message: Message::tool(
                    provider_call_ids.get(&call_id).cloned().unwrap_or(call_id),
                    content,
                ),
            });
        }
    }

    fn replace_surface(
        messages: &mut Vec<SurfaceMessage>,
        seq: Sequence,
        message: Message,
        replace: &crate::SurfaceReplace,
    ) {
        let positions = replace
            .shadowed_seqs
            .iter()
            .filter_map(|shadowed| messages.iter().position(|node| node.seq == *shadowed))
            .collect::<Vec<_>>();
        let contiguous = positions.len() == replace.shadowed_seqs.len()
            && positions
                .windows(2)
                .all(|pair| pair[1] == pair[0].saturating_add(1));
        if contiguous && !positions.is_empty() {
            let start = positions[0];
            let end = positions[positions.len() - 1];
            messages.splice(start..=end, [SurfaceMessage { seq, message }]);
        } else {
            // `Session` validation rejects this shape. Keep the pure helper
            // lossless for callers that project an unchecked legacy slice.
            messages.push(SurfaceMessage { seq, message });
        }
    }

    for logged in events {
        match logged.data() {
            EventData::UserMessage {
                message,
                surface_replace,
            } => {
                flush_tool_results(
                    &mut messages,
                    &mut call_order,
                    &mut tool_results,
                    &provider_call_ids,
                );
                match surface_replace {
                    Some(replace) => {
                        replace_surface(&mut messages, logged.seq, message.clone(), replace)
                    }
                    None => messages.push(SurfaceMessage {
                        seq: logged.seq,
                        message: message.clone(),
                    }),
                }
            }
            EventData::AssistantMessage { message, .. } => {
                flush_tool_results(
                    &mut messages,
                    &mut call_order,
                    &mut tool_results,
                    &provider_call_ids,
                );
                for call in &message.tool_calls {
                    provider_call_ids.insert(call.id.clone(), call.provider_id().to_owned());
                }
                call_order.extend(message.tool_calls.iter().map(|call| call.id.clone()));
                messages.push(SurfaceMessage {
                    seq: logged.seq,
                    message: message.clone(),
                });
            }
            EventData::ToolCall { call, .. } => {
                provider_call_ids.insert(call.id.clone(), call.provider_id().to_owned());
            }
            EventData::ToolResult { result, .. } => {
                tool_results.insert(result.call_id.clone(), (logged.seq, result.content.clone()));
            }
            EventData::StepEnd { .. } | EventData::TurnEnd { .. } => flush_tool_results(
                &mut messages,
                &mut call_order,
                &mut tool_results,
                &provider_call_ids,
            ),
            _ => {}
        }
    }
    flush_tool_results(
        &mut messages,
        &mut call_order,
        &mut tool_results,
        &provider_call_ids,
    );
    messages
}

fn validate_header(header: &SessionHeader) -> Result<(), SessionError> {
    if header.id.is_empty() {
        return Err(SessionError::EmptySessionId);
    }
    if header.version != SessionHeader::FORMAT_VERSION {
        return Err(SessionError::UnsupportedVersion {
            expected: SessionHeader::FORMAT_VERSION,
            actual: header.version,
        });
    }
    Ok(())
}

fn validate_log(revision: Revision, events: &[LoggedEvent]) -> Result<(), SessionError> {
    if events.is_empty() {
        if revision != Revision::ZERO {
            return Err(SessionError::LoggedRevisionMismatch {
                seq: 0,
                expected: Revision::ZERO,
                actual: revision,
            });
        }
        return Ok(());
    }

    #[derive(Default)]
    struct StepState {
        turn: u32,
        step: u32,
        request_header_seen: bool,
        request_provider: Option<String>,
        assistant_calls: Option<Vec<crate::ToolCall>>,
        mirrored_calls: usize,
    }

    #[derive(Default)]
    struct CompactionState {
        source_command_id: Option<String>,
        turn: Option<u32>,
        summary: Option<(crate::SequenceRange, Vec<Sequence>)>,
        replacement: bool,
        ended: bool,
    }

    fn lifecycle_error(seq: Sequence, message: impl Into<String>) -> SessionError {
        SessionError::InvalidLifecycle {
            seq,
            message: message.into(),
        }
    }

    fn question_transition_error(seq: Sequence, error: QuestionStateError) -> SessionError {
        lifecycle_error(seq, format!("invalid user-question transition: {error}"))
    }

    fn ensure_calls_mirrored(seq: Sequence, state: &StepState) -> Result<(), SessionError> {
        if let Some(calls) = &state.assistant_calls {
            if state.mirrored_calls != calls.len() {
                return Err(lifecycle_error(
                    seq,
                    format!(
                        "assistant declared {} tool calls but only {} audit events followed",
                        calls.len(),
                        state.mirrored_calls
                    ),
                ));
            }
        }
        Ok(())
    }

    let mut current_logged_revision = Revision::ZERO;
    let mut calls: HashMap<String, (bool, u32, u32)> = HashMap::new();
    let mut approvals = HashMap::<String, bool>::new();
    let mut questions = HashMap::<String, QuestionInteraction>::new();
    let mut question_by_call = HashMap::<String, String>::new();
    let mut call_names = HashMap::<String, String>::new();
    let mut commands = HashMap::<String, bool>::new();
    let mut retry_chains = HashMap::<(u32, u32, String, String), (String, u32)>::new();
    let mut retry_owners = HashMap::<String, (u32, u32, String, String)>::new();
    let mut scheduled_retries = HashMap::<(String, u32), (u32, u32)>::new();
    let mut started_retries = std::collections::HashSet::<(String, u32)>::new();
    let mut mutation_receipts = std::collections::HashSet::<String>::new();
    let mut mutation_revisions = std::collections::HashSet::<u64>::new();
    let mut compactions = HashMap::<String, CompactionState>::new();
    let mut open_turn = None::<u32>;
    let mut last_turn = 0u32;
    let mut open_step = None::<StepState>;
    let mut last_step = 0u32;
    let mut next_turn_inbox = Vec::<InboxMessage>::new();
    let mut next_step_inbox = Vec::<InboxMessage>::new();
    let mut current_goal = None::<(crate::GoalSnapshot, u64, u64, u64)>;
    let mut seen_goal_ids = std::collections::HashSet::<String>::new();
    for (position, logged) in events.iter().enumerate() {
        let expected_seq = position as Sequence;
        if logged.seq != expected_seq {
            return Err(SessionError::SequenceMismatch {
                expected: expected_seq,
                actual: logged.seq,
            });
        }
        if logged.revision == Revision::ZERO {
            return Err(SessionError::LoggedRevisionMismatch {
                seq: logged.seq,
                expected: Revision(1),
                actual: logged.revision,
            });
        }
        if logged.revision != current_logged_revision {
            let next = current_logged_revision
                .0
                .checked_add(1)
                .ok_or(SessionError::RevisionOverflow)?;
            if logged.revision != Revision(next) {
                return Err(SessionError::LoggedRevisionMismatch {
                    seq: logged.seq,
                    expected: Revision(next),
                    actual: logged.revision,
                });
            }
            current_logged_revision = logged.revision;
        }

        if !matches!(logged.data(), EventData::ToolCall { .. }) {
            if let Some(state) = open_step.as_ref() {
                ensure_calls_mirrored(logged.seq, state)?;
            }
        }

        match logged.data() {
            EventData::AgentPresetSelected { agent_preset } => {
                if agent_preset.trim().is_empty() {
                    return Err(lifecycle_error(
                        logged.seq,
                        "agent-preset/selected value must be non-empty",
                    ));
                }
            }
            EventData::SessionModelSelected {
                provider,
                model,
                reasoning_effort,
            } => {
                if provider.trim().is_empty()
                    || model.trim().is_empty()
                    || reasoning_effort
                        .as_ref()
                        .is_some_and(|value| value.trim().is_empty())
                {
                    return Err(lifecycle_error(
                        logged.seq,
                        "session/model-selected provider, model and optional reasoning effort must be non-empty",
                    ));
                }
            }
            EventData::AgentInboxSpliced {
                target,
                start,
                removed_count,
                inserted,
                outcome,
            } => {
                let (target_inbox, other_inbox) = match target {
                    InboxTarget::NextTurn => (&mut next_turn_inbox, &next_step_inbox),
                    InboxTarget::NextStep => (&mut next_step_inbox, &next_turn_inbox),
                };
                let end = start.checked_add(*removed_count).ok_or_else(|| {
                    SessionError::InvalidInboxSplice {
                        seq: logged.seq,
                        message: "splice range overflow".to_owned(),
                    }
                })?;
                if *start > target_inbox.len() || end > target_inbox.len() {
                    return Err(SessionError::InvalidInboxSplice {
                        seq: logged.seq,
                        message: format!(
                            "range {start}..{end} exceeds {} pending items",
                            target_inbox.len()
                        ),
                    });
                }
                if outcome.is_some() && *removed_count == 0 {
                    return Err(SessionError::InvalidInboxSplice {
                        seq: logged.seq,
                        message: "discard outcome requires at least one removed message".to_owned(),
                    });
                }
                for message in inserted {
                    if message.id.is_empty() {
                        return Err(SessionError::EmptyInboxMessageId { seq: logged.seq });
                    }
                    if message.message.role != MessageRole::User {
                        return Err(SessionError::InvalidInboxMessageRole {
                            seq: logged.seq,
                            message_id: message.id.clone(),
                        });
                    }
                    if message.message.id.as_deref() != Some(message.id.as_str()) {
                        return Err(SessionError::InboxMessageIdMismatch {
                            seq: logged.seq,
                            message_id: message.id.clone(),
                        });
                    }
                }
                let mut candidate = target_inbox.clone();
                candidate.splice(*start..end, inserted.iter().cloned());
                let mut ids = std::collections::HashSet::new();
                for message in candidate.iter().chain(other_inbox) {
                    if !ids.insert(message.id.as_str()) {
                        return Err(SessionError::DuplicateInboxMessage {
                            seq: logged.seq,
                            message_id: message.id.clone(),
                        });
                    }
                }
                *target_inbox = candidate;
            }
            EventData::TurnStart { turn } => {
                if open_turn.is_some() || open_step.is_some() {
                    return Err(lifecycle_error(logged.seq, "cannot nest a turn"));
                }
                let expected = last_turn
                    .checked_add(1)
                    .ok_or(SessionError::RevisionOverflow)?;
                if *turn != expected {
                    return Err(lifecycle_error(
                        logged.seq,
                        format!("expected turn {expected}, got {turn}"),
                    ));
                }
                open_turn = Some(*turn);
                last_turn = *turn;
                last_step = 0;
            }
            EventData::TurnEnd { turn, .. } => {
                if open_step.is_some() {
                    return Err(lifecycle_error(
                        logged.seq,
                        "cannot end a turn while a step is open",
                    ));
                }
                if open_turn != Some(*turn) {
                    return Err(lifecycle_error(
                        logged.seq,
                        format!("turn/end {turn} does not match the open turn {open_turn:?}"),
                    ));
                }
                open_turn = None;
            }
            EventData::StepStart { turn, step } => {
                if open_turn != Some(*turn) {
                    return Err(lifecycle_error(
                        logged.seq,
                        format!("step/start turn {turn} does not match open turn {open_turn:?}"),
                    ));
                }
                if open_step.is_some() {
                    return Err(lifecycle_error(logged.seq, "cannot nest a step"));
                }
                let expected = last_step
                    .checked_add(1)
                    .ok_or(SessionError::RevisionOverflow)?;
                if *step != expected {
                    return Err(lifecycle_error(
                        logged.seq,
                        format!("expected step {expected}, got {step}"),
                    ));
                }
                last_step = *step;
                open_step = Some(StepState {
                    turn: *turn,
                    step: *step,
                    ..StepState::default()
                });
            }
            EventData::StepEnd { turn, step } => {
                let Some(state) = open_step.as_ref() else {
                    return Err(lifecycle_error(logged.seq, "step/end without an open step"));
                };
                if state.turn != *turn || state.step != *step {
                    return Err(lifecycle_error(
                        logged.seq,
                        format!(
                            "step/end {turn}/{step} does not match open step {}/{}",
                            state.turn, state.step
                        ),
                    ));
                }
                if questions.values().any(|interaction| {
                    matches!(interaction.terminal_state(), QuestionTerminalState::Pending)
                        && calls
                            .get(&interaction.invocation().execution_id)
                            .is_some_and(|(settled, call_turn, call_step)| {
                                !*settled && *call_turn == *turn && *call_step == *step
                            })
                }) {
                    return Err(lifecycle_error(
                        logged.seq,
                        "step/end cannot close a pending user question",
                    ));
                }
                open_step = None;
            }
            EventData::RequestHeader { header } => {
                let Some(state) = open_step.as_mut() else {
                    return Err(lifecycle_error(
                        logged.seq,
                        "request/header requires an open step",
                    ));
                };
                if state.request_header_seen {
                    return Err(lifecycle_error(
                        logged.seq,
                        "a step may contain only one request/header",
                    ));
                }
                if state.assistant_calls.is_some() {
                    return Err(lifecycle_error(
                        logged.seq,
                        "request/header cannot follow assistant/message",
                    ));
                }
                if header.provider.trim().is_empty() {
                    return Err(lifecycle_error(
                        logged.seq,
                        "request/header provider must be non-empty",
                    ));
                }
                state.request_header_seen = true;
                state.request_provider = Some(header.provider.clone());
            }
            EventData::RequestContext {
                provider, model, ..
            } => {
                if open_step.is_none() {
                    return Err(lifecycle_error(
                        logged.seq,
                        "request/context requires an open step",
                    ));
                }
                if provider.trim().is_empty() || model.trim().is_empty() {
                    return Err(lifecycle_error(
                        logged.seq,
                        "request/context provider and model must be non-empty",
                    ));
                }
            }
            EventData::ApprovalAsked {
                id,
                tool_name,
                call_id,
                ..
            } => {
                if open_turn.is_none() {
                    return Err(lifecycle_error(
                        logged.seq,
                        "approval/asked requires an open turn",
                    ));
                }
                if id.trim().is_empty() {
                    return Err(lifecycle_error(
                        logged.seq,
                        "approval/asked id must be non-empty",
                    ));
                }
                if tool_name.trim().is_empty() {
                    return Err(lifecycle_error(
                        logged.seq,
                        "approval/asked toolName must be non-empty",
                    ));
                }
                if approvals.insert(id.clone(), false).is_some() {
                    return Err(lifecycle_error(
                        logged.seq,
                        format!("approval/asked repeats id {id:?}"),
                    ));
                }
                if let Some(call_id) = call_id {
                    let Some((settled, _, _)) = calls.get(call_id) else {
                        return Err(lifecycle_error(
                            logged.seq,
                            format!("approval/asked references unknown call id {call_id:?}"),
                        ));
                    };
                    if *settled {
                        return Err(lifecycle_error(
                            logged.seq,
                            format!("approval/asked references settled call id {call_id:?}"),
                        ));
                    }
                }
            }
            EventData::ApprovalDecided { id, .. } => {
                if open_turn.is_none() {
                    return Err(lifecycle_error(
                        logged.seq,
                        "approval/decided requires an open turn",
                    ));
                }
                match approvals.get_mut(id) {
                    None => {
                        return Err(lifecycle_error(
                            logged.seq,
                            format!("approval/decided has no matching ask for id {id:?}"),
                        ));
                    }
                    Some(true) => {
                        return Err(lifecycle_error(
                            logged.seq,
                            format!("approval/decided repeats id {id:?}"),
                        ));
                    }
                    Some(decided) => *decided = true,
                }
            }
            EventData::QuestionRequested { invocation } => {
                let Some((settled, call_turn, call_step)) = calls.get(&invocation.execution_id)
                else {
                    return Err(lifecycle_error(
                        logged.seq,
                        format!(
                            "question/requested references unknown call id {:?}",
                            invocation.execution_id
                        ),
                    ));
                };
                let open = open_step.as_ref().map(|state| (state.turn, state.step));
                if *settled
                    || open != Some((*call_turn, *call_step))
                    || call_names.get(&invocation.execution_id).map(String::as_str)
                        != Some(ASK_USER_QUESTION_TOOL)
                    || invocation.interaction_id.trim().is_empty()
                    || question_by_call.contains_key(&invocation.execution_id)
                    || questions.contains_key(&invocation.interaction_id)
                {
                    return Err(lifecycle_error(
                        logged.seq,
                        "question/requested must uniquely reference one open ask_user_question call",
                    ));
                }
                let interaction =
                    QuestionInteraction::new(invocation.clone()).map_err(|error| {
                        lifecycle_error(logged.seq, format!("invalid question/requested: {error}"))
                    })?;
                question_by_call.insert(
                    invocation.execution_id.clone(),
                    invocation.interaction_id.clone(),
                );
                questions.insert(invocation.interaction_id.clone(), interaction);
            }
            EventData::QuestionDraftUpdated {
                interaction_id,
                answers,
            } => {
                let interaction = questions.get_mut(interaction_id).ok_or_else(|| {
                    lifecycle_error(
                        logged.seq,
                        format!(
                            "question/draft-updated references unknown interaction {interaction_id:?}"
                        ),
                    )
                })?;
                interaction
                    .update_draft(answers.clone())
                    .map_err(|error| question_transition_error(logged.seq, error))?;
            }
            EventData::QuestionResolved {
                interaction_id,
                resolution,
            } => {
                let interaction = questions.get_mut(interaction_id).ok_or_else(|| {
                    lifecycle_error(
                        logged.seq,
                        format!(
                            "question/resolved references unknown interaction {interaction_id:?}"
                        ),
                    )
                })?;
                let answers = resolution
                    .answers
                    .iter()
                    .map(|answer| QuestionAnswer {
                        question_id: answer.question_id.clone(),
                        selected_option_id: answer.selected_option_id.clone(),
                        custom_text: answer.custom_text.clone(),
                    })
                    .collect();
                let canonical = interaction
                    .resolve(resolution.action, answers)
                    .map_err(|error| question_transition_error(logged.seq, error))?;
                if canonical != *resolution {
                    return Err(lifecycle_error(
                        logged.seq,
                        "question/resolved does not match its requested questions and answers",
                    ));
                }
            }
            EventData::QuestionCancelled {
                interaction_id,
                reason,
            } => {
                if reason.trim().is_empty() {
                    return Err(lifecycle_error(
                        logged.seq,
                        "question/cancelled reason must be non-empty",
                    ));
                }
                let interaction = questions.get_mut(interaction_id).ok_or_else(|| {
                    lifecycle_error(
                        logged.seq,
                        format!(
                            "question/cancelled references unknown interaction {interaction_id:?}"
                        ),
                    )
                })?;
                interaction
                    .cancel(reason.clone())
                    .map_err(|error| question_transition_error(logged.seq, error))?;
            }
            EventData::PermissionPreset { preset } => {
                if preset.trim().is_empty() {
                    return Err(lifecycle_error(
                        logged.seq,
                        "permission/preset name must be non-empty",
                    ));
                }
            }
            EventData::SandboxMode { .. }
            | EventData::ApprovalPolicy { .. }
            | EventData::PlanMode { .. } => {}
            EventData::CommandRun {
                command_id, name, ..
            } => {
                if command_id.trim().is_empty() || name.trim().is_empty() {
                    return Err(lifecycle_error(
                        logged.seq,
                        "command/run commandId and name must be non-empty",
                    ));
                }
                if commands.insert(command_id.clone(), false).is_some() {
                    return Err(lifecycle_error(
                        logged.seq,
                        format!("command/run repeats commandId {command_id:?}"),
                    ));
                }
            }
            EventData::CommandDone {
                command_id,
                kind,
                source_event_seq,
                ..
            } => {
                match commands.get_mut(command_id) {
                    None => {
                        return Err(lifecycle_error(
                            logged.seq,
                            format!("command/done has no matching run for {command_id:?}"),
                        ));
                    }
                    Some(true) => {
                        return Err(lifecycle_error(
                            logged.seq,
                            format!("command/done repeats commandId {command_id:?}"),
                        ));
                    }
                    Some(done) => *done = true,
                }
                if let Some(source_seq) = source_event_seq {
                    let target = usize::try_from(*source_seq)
                        .ok()
                        .and_then(|index| events.get(index));
                    if *kind != crate::CommandResultKind::Success
                        || *source_seq >= logged.seq
                        || target.is_none_or(|target| {
                            target.seq != *source_seq
                                || matches!(
                                    target.data(),
                                    EventData::CommandRun { .. } | EventData::CommandDone { .. }
                                )
                        })
                    {
                        return Err(lifecycle_error(
                            logged.seq,
                            "command/done carries an invalid sourceEventSeq",
                        ));
                    }
                }
            }
            EventData::SessionTitle {
                title,
                message_seqs,
                source,
            } => {
                if title.trim().is_empty() {
                    return Err(lifecycle_error(
                        logged.seq,
                        "session/title title must be non-empty",
                    ));
                }
                let user_owned = matches!(source, crate::SessionTitleSource::User);
                if message_seqs.is_empty() != user_owned {
                    return Err(lifecycle_error(
                        logged.seq,
                        "session/title messageSeqs must be empty exactly for a user source",
                    ));
                }
                if let crate::SessionTitleSource::Provider { provider, model } = source {
                    if provider.trim().is_empty()
                        || model.as_ref().is_some_and(|model| {
                            model.provider.trim().is_empty() || model.model.trim().is_empty()
                        })
                    {
                        return Err(lifecycle_error(
                            logged.seq,
                            "session/title provider provenance must be non-empty",
                        ));
                    }
                }
            }
            EventData::GoalChange { change } => match change {
                crate::GoalChange::Snapshot(change) => {
                    let goal = &change.goal;
                    if change.version != 1
                        || goal.id.trim().is_empty()
                        || goal.objective.trim().is_empty()
                        || goal.revision == 0
                        || goal.max_goal_rounds == 0
                        || change.rounds_started > goal.max_goal_rounds
                        || change.updated_at < change.created_at
                    {
                        return Err(lifecycle_error(
                            logged.seq,
                            "goal/change snapshot has invalid identity, limits or timestamps",
                        ));
                    }
                    let blocked = matches!(goal.phase, crate::GoalPhase::Blocked);
                    if blocked != goal.blocked_reason.is_some()
                        || goal.blocked_reason.as_ref().is_some_and(|reason| {
                            reason.code.trim().is_empty() || reason.message.trim().is_empty()
                        })
                    {
                        return Err(lifecycle_error(
                            logged.seq,
                            "goal/change blockedReason must exist exactly for blocked phase",
                        ));
                    }
                    match change.operation {
                        crate::GoalSnapshotOperation::Create => {
                            if goal.revision != 1
                                || goal.phase != crate::GoalPhase::Active
                                || change.rounds_started != 0
                                || current_goal.as_ref().is_some_and(|(current, ..)| {
                                    current.phase != crate::GoalPhase::Complete
                                })
                                || !seen_goal_ids.insert(goal.id.clone())
                            {
                                return Err(lifecycle_error(
                                    logged.seq,
                                    "goal create requires a fresh active revision-one goal",
                                ));
                            }
                        }
                        operation => {
                            let Some((current, rounds, created_at, updated_at)) =
                                current_goal.as_ref()
                            else {
                                return Err(lifecycle_error(
                                    logged.seq,
                                    "non-create goal mutation requires a current goal",
                                ));
                            };
                            if goal.id != current.id
                                || goal.revision != current.revision.saturating_add(1)
                                || change.created_at != *created_at
                                || change.updated_at < *updated_at
                                || change.rounds_started != *rounds
                            {
                                return Err(lifecycle_error(
                                    logged.seq,
                                    "goal mutation must advance one revision without rewinding metadata",
                                ));
                            }
                            let same_definition = goal.objective == current.objective
                                && goal.max_goal_rounds == current.max_goal_rounds;
                            let valid = match operation {
                                crate::GoalSnapshotOperation::Edit => {
                                    goal.phase == current.phase
                                        && goal.blocked_reason == current.blocked_reason
                                }
                                crate::GoalSnapshotOperation::Pause => {
                                    same_definition
                                        && current.phase == crate::GoalPhase::Active
                                        && goal.phase == crate::GoalPhase::Paused
                                }
                                crate::GoalSnapshotOperation::Resume => {
                                    same_definition
                                        && matches!(
                                            current.phase,
                                            crate::GoalPhase::Active
                                                | crate::GoalPhase::Paused
                                                | crate::GoalPhase::Blocked
                                        )
                                        && goal.phase == crate::GoalPhase::Active
                                        && change.rounds_started < goal.max_goal_rounds
                                }
                                crate::GoalSnapshotOperation::Complete => {
                                    same_definition
                                        && current.phase != crate::GoalPhase::Complete
                                        && goal.phase == crate::GoalPhase::Complete
                                }
                                crate::GoalSnapshotOperation::Block => {
                                    same_definition
                                        && current.phase == crate::GoalPhase::Active
                                        && goal.phase == crate::GoalPhase::Blocked
                                }
                                crate::GoalSnapshotOperation::Create => false,
                            };
                            if !valid {
                                return Err(lifecycle_error(
                                    logged.seq,
                                    "goal/change has an invalid phase or definition transition",
                                ));
                            }
                        }
                    }
                    current_goal = Some((
                        goal.clone(),
                        change.rounds_started,
                        change.created_at,
                        change.updated_at,
                    ));
                }
                crate::GoalChange::Clear(change) => {
                    let Some((current, _, _, updated_at)) = current_goal.as_ref() else {
                        return Err(lifecycle_error(
                            logged.seq,
                            "goal clear requires a current goal",
                        ));
                    };
                    if change.version != 1
                        || change.cleared.id != current.id
                        || change.cleared.revision != current.revision.saturating_add(1)
                        || change.cleared_at < *updated_at
                    {
                        return Err(lifecycle_error(
                            logged.seq,
                            "goal clear tombstone has invalid identity, revision or timestamp",
                        ));
                    }
                    current_goal = None;
                }
            },
            EventData::SessionMutationCommitted { receipt } => {
                let paired_with_state = position > 0
                    && events[position - 1].revision == logged.revision
                    && !matches!(
                        events[position - 1].data(),
                        EventData::SessionMutationCommitted { .. }
                    );
                let ends_revision = events
                    .get(position.saturating_add(1))
                    .is_none_or(|next| next.revision != logged.revision);
                let fingerprint_is_valid = receipt.fingerprint.len() == 64
                    && receipt
                        .fingerprint
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
                let response_seq_field_is_valid = receipt
                    .response_event_seq_field
                    .as_ref()
                    .is_none_or(|field| {
                        !field.trim().is_empty()
                            && !field.contains('\0')
                            && receipt
                                .response
                                .as_object()
                                .is_some_and(|response| !response.contains_key(field))
                    });
                if receipt.rpc_id.trim().is_empty()
                    || receipt.method.trim().is_empty()
                    || !fingerprint_is_valid
                    || !response_seq_field_is_valid
                    || !paired_with_state
                    || !ends_revision
                    || contains_populated_secret(&receipt.response)
                    || !mutation_receipts.insert(receipt.rpc_id.clone())
                    || !mutation_revisions.insert(logged.revision.0)
                {
                    return Err(lifecycle_error(
                        logged.seq,
                        "xharness/mutation-committed must be unique, secret-free, valid and end a state-mutation revision",
                    ));
                }
            }
            EventData::LlmRetry {
                retry_id,
                turn,
                step,
                provider,
                mode,
                policy_key,
                retry,
                max_retries,
                failure,
                ..
            } => {
                let Some(state) = open_step.as_ref() else {
                    return Err(lifecycle_error(
                        logged.seq,
                        "llm/retry requires an open step",
                    ));
                };
                if state.turn != *turn || state.step != *step {
                    return Err(lifecycle_error(
                        logged.seq,
                        "llm/retry coordinates do not match the open step",
                    ));
                }
                if retry_id.trim().is_empty()
                    || provider.trim().is_empty()
                    || policy_key.trim().is_empty()
                {
                    return Err(lifecycle_error(
                        logged.seq,
                        "llm/retry identity, provider and policyKey must be non-empty",
                    ));
                }
                if state.request_provider.as_deref() != Some(provider.as_str()) {
                    return Err(lifecycle_error(
                        logged.seq,
                        "llm/retry provider does not match request/header",
                    ));
                }
                if *retry == 0 {
                    return Err(lifecycle_error(
                        logged.seq,
                        "llm/retry retry must be positive",
                    ));
                }
                match mode {
                    crate::LlmRetryMode::Normal => {
                        if max_retries.is_none_or(|maximum| maximum == 0 || *retry > maximum) {
                            return Err(lifecycle_error(
                                logged.seq,
                                "normal llm/retry requires a positive maxRetries not below retry",
                            ));
                        }
                    }
                    crate::LlmRetryMode::Always => {
                        if max_retries.is_some() {
                            return Err(lifecycle_error(
                                logged.seq,
                                "always llm/retry must omit maxRetries",
                            ));
                        }
                    }
                }
                if failure.message.trim().is_empty() || failure.code.trim().is_empty() {
                    return Err(lifecycle_error(
                        logged.seq,
                        "llm/retry failure message and code must be non-empty",
                    ));
                }
                if failure
                    .status
                    .is_some_and(|status| !(100..=599).contains(&status))
                {
                    return Err(lifecycle_error(
                        logged.seq,
                        "llm/retry failure status must be within 100..=599",
                    ));
                }
                if failure.provider_retry_after_ms == Some(0) {
                    return Err(lifecycle_error(
                        logged.seq,
                        "llm/retry providerRetryAfterMs must be positive",
                    ));
                }
                if failure.request_id.as_ref().is_some_and(|id| id.is_empty()) {
                    return Err(lifecycle_error(
                        logged.seq,
                        "llm/retry requestId must be non-empty when present",
                    ));
                }

                let owner = (*turn, *step, provider.clone(), policy_key.clone());
                if let Some(existing) = retry_owners.get(retry_id) {
                    if existing != &owner {
                        return Err(lifecycle_error(
                            logged.seq,
                            format!("llm/retry id {retry_id:?} is owned by another chain"),
                        ));
                    }
                } else {
                    retry_owners.insert(retry_id.clone(), owner.clone());
                }
                let chain = retry_chains.entry(owner).or_insert((retry_id.clone(), 0));
                if chain.0 != *retry_id || retry != &(chain.1.saturating_add(1)) {
                    return Err(lifecycle_error(
                        logged.seq,
                        "llm/retry must preserve retryId and increment retry by one",
                    ));
                }
                chain.1 = *retry;
                if scheduled_retries
                    .insert((retry_id.clone(), *retry), (*turn, *step))
                    .is_some()
                {
                    return Err(lifecycle_error(
                        logged.seq,
                        "llm/retry repeats one scheduled attempt",
                    ));
                }
            }
            EventData::LlmRetryStarted {
                retry_id,
                turn,
                step,
                retry,
            } => {
                if open_step.as_ref().map(|state| (state.turn, state.step)) != Some((*turn, *step))
                {
                    return Err(lifecycle_error(
                        logged.seq,
                        "llm/retry-started coordinates do not match the open step",
                    ));
                }
                if scheduled_retries.get(&(retry_id.clone(), *retry)) != Some(&(*turn, *step)) {
                    return Err(lifecycle_error(
                        logged.seq,
                        "llm/retry-started has no matching scheduled retry",
                    ));
                }
                if !started_retries.insert((retry_id.clone(), *retry)) {
                    return Err(lifecycle_error(
                        logged.seq,
                        "llm/retry-started repeats one scheduled attempt",
                    ));
                }
            }
            EventData::CompactionStart {
                compaction_id,
                source_command_id,
                turn,
            } => {
                if compaction_id.trim().is_empty()
                    || source_command_id
                        .as_ref()
                        .is_some_and(|value| value.trim().is_empty())
                    || turn.is_some_and(|turn| open_turn != Some(turn))
                    || compactions.contains_key(compaction_id)
                {
                    return Err(lifecycle_error(
                        logged.seq,
                        "compaction/start has invalid identity, turn or duplicate id",
                    ));
                }
                compactions.insert(
                    compaction_id.clone(),
                    CompactionState {
                        source_command_id: source_command_id.clone(),
                        turn: *turn,
                        ..CompactionState::default()
                    },
                );
            }
            EventData::CompactionSummary {
                compaction_id,
                source_command_id,
                summary,
                shadowed_range,
                shadowed_seqs,
                shadowed_token_count,
                provider,
                model,
                max_tokens,
                ..
            } => {
                let Some(state) = compactions.get_mut(compaction_id) else {
                    return Err(lifecycle_error(
                        logged.seq,
                        "compaction/summary has no matching start",
                    ));
                };
                let range_is_valid = !shadowed_seqs.is_empty()
                    && shadowed_seqs.first() == Some(&shadowed_range.start)
                    && shadowed_seqs.last() == Some(&shadowed_range.end)
                    && shadowed_seqs
                        .iter()
                        .collect::<std::collections::HashSet<_>>()
                        .len()
                        == shadowed_seqs.len();
                let surface = derive_surface_messages(&events[..position]);
                let positions = shadowed_seqs
                    .iter()
                    .filter_map(|seq| surface.iter().position(|node| node.seq == *seq))
                    .collect::<Vec<_>>();
                let surface_is_contiguous = positions.len() == shadowed_seqs.len()
                    && positions
                        .windows(2)
                        .all(|pair| pair[1] == pair[0].saturating_add(1));
                if state.ended
                    || state.summary.is_some()
                    || state.source_command_id != *source_command_id
                    || summary.trim().is_empty()
                    || provider.trim().is_empty()
                    || model.trim().is_empty()
                    || *shadowed_token_count == 0
                    || max_tokens == &Some(0)
                    || !range_is_valid
                    || !surface_is_contiguous
                {
                    return Err(lifecycle_error(
                        logged.seq,
                        "compaction/summary is invalid or does not name a contiguous current-surface range",
                    ));
                }
                state.summary = Some((*shadowed_range, shadowed_seqs.clone()));
            }
            EventData::CompactionEnd {
                compaction_id,
                source_command_id,
                turn,
                error,
            } => {
                let Some(state) = compactions.get_mut(compaction_id) else {
                    return Err(lifecycle_error(
                        logged.seq,
                        "compaction/end has no matching start",
                    ));
                };
                let success_shape = state.summary.is_some() && state.replacement;
                let failure_shape = state.summary.is_none() && !state.replacement;
                if state.ended
                    || state.source_command_id != *source_command_id
                    || state.turn != *turn
                    || error.as_ref().is_some_and(|value| value.trim().is_empty())
                    || (error.is_none() && !success_shape)
                    || (error.is_some() && !failure_shape)
                {
                    return Err(lifecycle_error(
                        logged.seq,
                        "compaction/end does not close one valid success or failure transaction",
                    ));
                }
                state.ended = true;
            }
            EventData::CompactionPrune {
                shadowed_range,
                shadowed_seqs,
                shadowed_token_count,
            } => {
                if shadowed_seqs.is_empty()
                    || shadowed_seqs.first() != Some(&shadowed_range.start)
                    || shadowed_seqs.last() != Some(&shadowed_range.end)
                    || shadowed_seqs
                        .iter()
                        .collect::<std::collections::HashSet<_>>()
                        .len()
                        != shadowed_seqs.len()
                    || *shadowed_token_count == 0
                {
                    return Err(lifecycle_error(
                        logged.seq,
                        "compaction/prune has invalid range or accounting",
                    ));
                }
            }
            EventData::UserMessage {
                message,
                surface_replace,
            } => {
                if message.role != MessageRole::User {
                    return Err(SessionError::InvalidMessageRole {
                        seq: logged.seq,
                        role: "user",
                    });
                }
                if open_turn.is_none() || (open_step.is_some() && surface_replace.is_none()) {
                    return Err(lifecycle_error(
                        logged.seq,
                        "user/message requires an open turn at a step boundary",
                    ));
                }
                if let Some(replace) = surface_replace {
                    let Some(state) = compactions.get_mut(&replace.compaction_id) else {
                        return Err(lifecycle_error(
                            logged.seq,
                            "surface replacement has no matching compaction/start",
                        ));
                    };
                    let immediately_follows_summary = position > 0
                        && events[position - 1].revision == logged.revision
                        && matches!(
                            events[position - 1].data(),
                            EventData::CompactionSummary { compaction_id, .. }
                                if compaction_id == &replace.compaction_id
                        );
                    if state.ended
                        || state.replacement
                        || state.summary.as_ref().is_none_or(|(range, seqs)| {
                            *range != replace.shadowed_range || seqs != &replace.shadowed_seqs
                        })
                        || !immediately_follows_summary
                    {
                        return Err(lifecycle_error(
                            logged.seq,
                            "surface replacement must immediately and exactly mirror its compaction summary",
                        ));
                    }
                    state.replacement = true;
                }
            }
            EventData::AssistantChunk { turn, step, .. } => {
                let Some(state) = open_step.as_ref() else {
                    return Err(lifecycle_error(
                        logged.seq,
                        "assistant/chunk requires an open step",
                    ));
                };
                if state.turn != *turn || state.step != *step {
                    return Err(lifecycle_error(
                        logged.seq,
                        "assistant/chunk coordinates do not match the open step",
                    ));
                }
                if state.assistant_calls.is_some() {
                    return Err(lifecycle_error(
                        logged.seq,
                        "assistant/chunk cannot follow assistant/message",
                    ));
                }
            }
            EventData::AssistantMessage {
                turn,
                step,
                message,
                ..
            } => {
                if message.role != MessageRole::Assistant {
                    return Err(SessionError::InvalidMessageRole {
                        seq: logged.seq,
                        role: "assistant",
                    });
                }
                let Some(state) = open_step.as_mut() else {
                    return Err(lifecycle_error(
                        logged.seq,
                        "assistant/message requires an open step",
                    ));
                };
                if state.turn != *turn || state.step != *step {
                    return Err(lifecycle_error(
                        logged.seq,
                        "assistant/message coordinates do not match the open step",
                    ));
                }
                if state.assistant_calls.is_some() {
                    return Err(lifecycle_error(
                        logged.seq,
                        "a step may contain only one assistant/message",
                    ));
                }
                let mut embedded_ids = std::collections::HashSet::new();
                for call in &message.tool_calls {
                    if call.id.is_empty() {
                        return Err(SessionError::EmptyToolCallId { seq: logged.seq });
                    }
                    if call.provider_call_id.as_deref() == Some("") {
                        return Err(SessionError::EmptyProviderToolCallId { seq: logged.seq });
                    }
                    if call.name.is_empty() {
                        return Err(SessionError::EmptyToolName { seq: logged.seq });
                    }
                    if calls.contains_key(&call.id) || !embedded_ids.insert(call.id.as_str()) {
                        return Err(SessionError::DuplicateToolCall {
                            seq: logged.seq,
                            call_id: call.id.clone(),
                        });
                    }
                }
                state.assistant_calls = Some(message.tool_calls.clone());
            }
            EventData::ToolCall { turn, step, call } => {
                if call.id.is_empty() {
                    return Err(SessionError::EmptyToolCallId { seq: logged.seq });
                }
                if call.provider_call_id.as_deref() == Some("") {
                    return Err(SessionError::EmptyProviderToolCallId { seq: logged.seq });
                }
                if call.name.is_empty() {
                    return Err(SessionError::EmptyToolName { seq: logged.seq });
                }
                let Some(state) = open_step.as_mut() else {
                    return Err(lifecycle_error(
                        logged.seq,
                        "tool/call requires an open step",
                    ));
                };
                if state.turn != *turn || state.step != *step {
                    return Err(lifecycle_error(
                        logged.seq,
                        "tool/call coordinates do not match the open step",
                    ));
                }
                let expected = state
                    .assistant_calls
                    .as_ref()
                    .and_then(|expected| expected.get(state.mirrored_calls));
                if expected != Some(call) {
                    return Err(SessionError::ToolCallMirrorMismatch {
                        seq: logged.seq,
                        turn: *turn,
                        step: *step,
                        position: state.mirrored_calls,
                    });
                }
                state.mirrored_calls += 1;
                if calls
                    .insert(call.id.clone(), (false, *turn, *step))
                    .is_some()
                {
                    return Err(SessionError::DuplicateToolCall {
                        seq: logged.seq,
                        call_id: call.id.clone(),
                    });
                }
                call_names.insert(call.id.clone(), call.name.clone());
            }
            EventData::ToolResult { turn, step, result } => match calls.get_mut(&result.call_id) {
                None => {
                    return Err(SessionError::UnknownToolCall {
                        seq: logged.seq,
                        call_id: result.call_id.clone(),
                    });
                }
                Some((true, _, _)) => {
                    return Err(SessionError::DuplicateToolResult {
                        seq: logged.seq,
                        call_id: result.call_id.clone(),
                    });
                }
                Some((settled, call_turn, call_step)) => {
                    if *call_turn != *turn || *call_step != *step {
                        return Err(lifecycle_error(
                            logged.seq,
                            "tool/result coordinates do not match its tool/call",
                        ));
                    }
                    if result.outcome != crate::ToolOutcome::OutcomeUnknown {
                        let Some(state) = open_step.as_ref() else {
                            return Err(lifecycle_error(
                                logged.seq,
                                "authoritative tool/result requires its step to remain open",
                            ));
                        };
                        if state.turn != *turn || state.step != *step {
                            return Err(lifecycle_error(
                                logged.seq,
                                "tool/result does not belong to the open step",
                            ));
                        }
                    }
                    if call_names.get(&result.call_id).map(String::as_str)
                        == Some(ASK_USER_QUESTION_TOOL)
                    {
                        let interaction_id =
                            question_by_call.get(&result.call_id).ok_or_else(|| {
                                lifecycle_error(
                                logged.seq,
                                "ask_user_question tool/result has no durable question/requested",
                            )
                            })?;
                        let terminal = questions
                            .get(interaction_id)
                            .expect("question call map references an interaction")
                            .terminal_state();
                        if matches!(terminal, QuestionTerminalState::Pending) {
                            return Err(lifecycle_error(
                                logged.seq,
                                "ask_user_question tool/result cannot precede question settlement",
                            ));
                        }
                    }
                    *settled = true;
                }
            },
            EventData::SessionEndSeed => {
                if open_turn.is_some() || open_step.is_some() {
                    return Err(lifecycle_error(
                        logged.seq,
                        "session/end-seed requires all turns and steps to be closed",
                    ));
                }
            }
        }
    }

    if let Some(state) = open_step.as_ref() {
        ensure_calls_mirrored(events.last().expect("non-empty").seq, state)?;
    }

    if current_logged_revision != revision {
        return Err(SessionError::LoggedRevisionMismatch {
            seq: events.last().expect("non-empty").seq,
            expected: revision,
            actual: current_logged_revision,
        });
    }
    Ok(())
}

fn contains_populated_secret(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(object) => object.iter().any(|(key, value)| {
            let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
            let sensitive = normalized.contains("password")
                || normalized.contains("authorization")
                || normalized.contains("apikey")
                || normalized.ends_with("token")
                || normalized.ends_with("secret");
            let populated = !matches!(value, serde_json::Value::Null)
                && !matches!(value, serde_json::Value::String(text) if text.is_empty())
                && !matches!(value, serde_json::Value::Array(items) if items.is_empty())
                && !matches!(value, serde_json::Value::Object(items) if items.is_empty());
            (sensitive && populated) || contains_populated_secret(value)
        }),
        serde_json::Value::Array(values) => values.iter().any(contains_populated_secret),
        _ => false,
    }
}

pub(crate) fn unix_timestamp_ms() -> u64 {
    let millis = SystemTime::UNIX_EPOCH
        .elapsed()
        .unwrap_or_default()
        .as_millis();
    u64::try_from(millis).unwrap_or(u64::MAX)
}

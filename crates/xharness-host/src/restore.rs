use std::{
    collections::{BTreeMap, VecDeque},
    path::Path,
    sync::Arc,
};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use xharness_agent::InboxProjection;
use xharness_session::{
    AssistantChunk, EventData, LoggedEvent, Message, MessageRole, Session, Store, StoreError,
    ToolOutcome, TurnEndReason,
};

use crate::{
    runtime::{AgentSessionRequest, ModelRoute},
    state::{
        DriverCommand, GoalState, ModelSelection, QueuedPrompt, SessionRecord, WorkspaceRecord,
    },
    BasicHost, PermissionPreset,
};

/// Non-fatal startup condition. The durable Session remains visible even when
/// its pending Agent cannot currently be resumed (for example because its
/// historical model route is no longer configured).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRestoreIssue {
    pub session_id: String,
    pub message: String,
}

/// Deterministic summary of one Host startup replay.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRestoreReport {
    pub discovered_sessions: usize,
    pub restored_sessions: usize,
    pub resumed_pending_turns: usize,
    pub resumed_pending_approvals: usize,
    pub waiting_next_step_inputs: usize,
    pub issues: Vec<HostRestoreIssue>,
}

/// One bounded suffix of the deterministic Web projection. Sequence numbers
/// stay identical to the append-only Session log, so eviction never changes a
/// browser cursor.
pub(crate) struct ProjectedEventTail {
    pub(crate) base_seq: u64,
    pub(crate) next_seq: u64,
    pub(crate) bytes: usize,
    pub(crate) events: Vec<Value>,
}

/// Cursor page returned from the authoritative append-only Session rather
/// than from the Host's bounded live tail.
pub(crate) struct ProjectedHistoryPage {
    pub(crate) events: Vec<Value>,
    pub(crate) has_more: bool,
    pub(crate) as_of_seq: Option<u64>,
}

#[derive(Debug, thiserror::Error)]
pub enum HostRestoreError {
    #[error(transparent)]
    Control(#[from] xharness_control::ControlError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("session {session_id:?} disappeared during Host restoration")]
    SessionDisappeared { session_id: String },
    #[error("session {session_id:?} has an invalid durable inbox: {message}")]
    InvalidInbox { session_id: String, message: String },
    #[error("session {session_id:?} prompt could not be restored: {message}")]
    Prompt { session_id: String, message: String },
    #[error(
        "session {session_id:?} resume attached {runtime_count} turns but projection contains {projected_count}"
    )]
    ResumeMismatch {
        session_id: String,
        runtime_count: usize,
        projected_count: usize,
    },
}

impl BasicHost {
    /// Rebuild the Web-facing Host projection from the append-only Session
    /// store and reattach every pending next-turn input before starting any
    /// Agent worker. This method is idempotent for a freshly constructed Host;
    /// callers must invoke it before exposing the HTTP listener.
    pub async fn restore_from_store(
        self: &Arc<Self>,
        store: Arc<dyn Store>,
    ) -> Result<HostRestoreReport, HostRestoreError> {
        self.restore_control_state().await?;
        let headers = store.list_headers().await?;
        let mut report = HostRestoreReport {
            discovered_sessions: headers.len(),
            ..HostRestoreReport::default()
        };
        let mut resumable = Vec::new();

        for header in headers {
            let session_id = header.id.clone();
            let session = store.load(&session_id).await?.ok_or_else(|| {
                HostRestoreError::SessionDisappeared {
                    session_id: session_id.clone(),
                }
            })?;
            let inbox = InboxProjection::from_session(&session).map_err(|error| {
                HostRestoreError::InvalidInbox {
                    session_id: session_id.clone(),
                    message: error.to_string(),
                }
            })?;
            let cwd = header
                .cwd
                .clone()
                .unwrap_or_else(|| self.config.cwd.to_string_lossy().into_owned());
            let route = restored_route(&session, &self.config);
            let queue = inbox
                .next_turn()
                .iter()
                .map(restored_prompt)
                .collect::<VecDeque<_>>();
            let admissions = restored_admissions(&session);
            let projected_queue_len = queue.len();
            let pending_approval_count = session.pending_tool_approvals().len();
            let tail = project_session_event_tail(
                &session,
                &route,
                self.config.session_event_cache_capacity,
                self.config.session_event_cache_bytes,
            );
            let messages = session.derive_messages();
            let updated_at = session
                .events()
                .last()
                .map_or(header.created_at_ms, |event| event.timestamp_ms);
            let next_turn = session
                .events()
                .iter()
                .filter_map(|event| match event.data() {
                    EventData::TurnStart { turn } => Some(*turn),
                    _ => None,
                })
                .max()
                .unwrap_or_default();
            let blank = messages.is_empty() && !inbox.has_pending();
            let permission = restored_permission(&session);
            let plan_active = restored_plan_mode(&session);
            let goal = restored_goal(&session);
            let record = SessionRecord {
                session_id: session_id.clone(),
                created_at: header.created_at_ms,
                updated_at,
                running: false,
                blank,
                parent_session_id: None,
                origin: Some("restored".to_owned()),
                cwd: cwd.clone(),
                agent_preset: restored_agent_preset(&session),
                title: restored_title(&session),
                model: ModelSelection {
                    provider: route.provider.clone(),
                    model: route.model.clone(),
                    reasoning_effort: route.reasoning_effort.clone(),
                },
                permission_preset: permission,
                plan_active,
                goal: goal.clone(),
                events: tail.events,
                event_base_seq: tail.base_seq,
                event_cache_bytes: tail.bytes,
                messages,
                queue,
                admissions,
                mutation_receipts: restored_session_mutation_receipts(&session),
                authoritative_seq: Some(tail.next_seq),
                control: None,
                next_turn,
            };

            {
                let mut state = self.state.write().await;
                attach_workspace(&mut state, &session_id, &cwd, header.created_at_ms);
                state.sessions.insert(session_id.clone(), record);
                if let Some(goal) = goal {
                    state.goals.insert(session_id.clone(), goal);
                }
            }
            report.restored_sessions += 1;
            report.waiting_next_step_inputs += inbox.next_step().len();
            if projected_queue_len > 0 || pending_approval_count > 0 {
                let prompt = self
                    .state
                    .read()
                    .await
                    .prompt_assembly(&session_id)
                    .map_err(|message| HostRestoreError::Prompt {
                        session_id: session_id.clone(),
                        message,
                    })?;
                resumable.push((
                    session_id,
                    cwd,
                    route,
                    permission,
                    prompt,
                    projected_queue_len,
                    pending_approval_count,
                ));
            }
        }

        // The runtime subscribes and prepares every recovered input before it
        // wakes the durable Agent. Only after that succeeds do we publish the
        // Host-owned driver/control projection.
        for (session_id, cwd, route, permission, prompt, projected_count, projected_approvals) in
            resumable
        {
            match self
                .agent_runtime
                .resume_session(AgentSessionRequest {
                    session_id: session_id.clone(),
                    cwd,
                    route,
                    permission,
                    prompt: Some(prompt),
                })
                .await
            {
                Ok(runtime_report) => {
                    if runtime_report.pending_turns != projected_count {
                        return Err(HostRestoreError::ResumeMismatch {
                            session_id,
                            runtime_count: runtime_report.pending_turns,
                            projected_count,
                        });
                    }
                    report.resumed_pending_turns += runtime_report.pending_turns;
                    if runtime_report.recovered_approval_work_id.is_some() {
                        report.resumed_pending_approvals += projected_approvals;
                    } else if projected_approvals > 0 {
                        report.issues.push(HostRestoreIssue {
                            session_id: session_id.clone(),
                            message: "runtime did not attach the durable pending approval"
                                .to_owned(),
                        });
                        continue;
                    }
                    let (control_tx, control_rx) = mpsc::channel::<DriverCommand>(64);
                    {
                        let mut state = self.state.write().await;
                        let record = state
                            .sessions
                            .get_mut(&session_id)
                            .expect("restored session remains registered");
                        record.running = true;
                        record.control = Some(control_tx);
                    }
                    let host = self.as_ref().clone();
                    if let Some(work_id) = runtime_report.recovered_approval_work_id {
                        let recovered = self
                            .agent_runtime
                            .take_resumed_turn(&session_id, &work_id)
                            .await
                            .map_err(|error| HostRestoreError::InvalidInbox {
                                session_id: session_id.clone(),
                                message: error.to_string(),
                            })?
                            .ok_or_else(|| HostRestoreError::InvalidInbox {
                                session_id: session_id.clone(),
                                message: format!(
                                    "runtime lost recovered approval work {work_id:?}"
                                ),
                            })?;
                        tokio::spawn(async move {
                            host.drive_recovered_turn(session_id, recovered, control_rx)
                                .await
                        });
                    } else {
                        tokio::spawn(
                            async move { host.drive_session(session_id, control_rx).await },
                        );
                    }
                }
                Err(error) => report.issues.push(HostRestoreIssue {
                    session_id,
                    message: error.to_string(),
                }),
            }
        }

        // Session discovery may attach newly restored ids to a Workspace.
        // Reapply durable custom ordering/tombstones after those ids exist.
        self.reload_control_projection().await?;

        Ok(report)
    }
}

fn restored_route(session: &Session, config: &crate::HostConfig) -> ModelRoute {
    session
        .events()
        .iter()
        .rev()
        .find_map(|event| match event.data() {
            EventData::SessionModelSelected {
                provider,
                model,
                reasoning_effort,
            } => Some(ModelRoute {
                provider: provider.clone(),
                model: model.clone(),
                reasoning_effort: reasoning_effort.clone(),
            }),
            EventData::RequestHeader { header } => Some(ModelRoute {
                provider: header.provider.clone(),
                model: header.model.clone(),
                reasoning_effort: header.reasoning_effort.clone(),
            }),
            _ => None,
        })
        .unwrap_or_else(|| ModelRoute {
            provider: config.provider_id.clone(),
            model: config.model_id.clone(),
            reasoning_effort: None,
        })
}

pub(crate) fn restored_permission(session: &Session) -> PermissionPreset {
    for event in session.events().iter().rev() {
        match event.data() {
            EventData::PermissionPreset { preset } => {
                if let Some(preset) = PermissionPreset::parse(preset) {
                    return preset;
                }
            }
            EventData::SandboxMode {
                mode: xharness_session::SessionSandboxMode::DangerFullAccess,
                ..
            } => return PermissionPreset::DangerFullAccess,
            EventData::SandboxMode { .. } => return PermissionPreset::WorkspaceWrite,
            _ => {}
        }
    }
    PermissionPreset::default()
}

pub(crate) fn restored_agent_preset(session: &Session) -> Option<String> {
    session
        .events()
        .iter()
        .rev()
        .find_map(|event| {
            let EventData::AgentPresetSelected { agent_preset } = event.data() else {
                return None;
            };
            Some(agent_preset.clone())
        })
        .or_else(|| Some("coding".to_owned()))
}

pub(crate) fn restored_title(session: &Session) -> Option<String> {
    session.events().iter().rev().find_map(|event| {
        let EventData::SessionTitle { title, .. } = event.data() else {
            return None;
        };
        Some(title.clone())
    })
}

pub(crate) fn restored_plan_mode(session: &Session) -> bool {
    session
        .events()
        .iter()
        .rev()
        .find_map(|event| match event.data() {
            EventData::PlanMode { active } => Some(*active),
            _ => None,
        })
        .unwrap_or(false)
}

pub(crate) fn restored_goal(session: &Session) -> Option<GoalState> {
    let mut current = None;
    for event in session.events() {
        let EventData::GoalChange { change } = event.data() else {
            continue;
        };
        current = match change {
            xharness_session::GoalChange::Snapshot(change) => Some(GoalState {
                id: change.goal.id.clone(),
                revision: change.goal.revision,
                objective: change.goal.objective.clone(),
                phase: change.goal.phase,
                blocked_reason: change.goal.blocked_reason.clone(),
                max_goal_rounds: change.goal.max_goal_rounds,
                rounds_started: change.rounds_started,
                created_at: change.created_at,
                updated_at: change.updated_at,
            }),
            xharness_session::GoalChange::Clear(_) => None,
        };
    }
    current
}

fn restored_prompt(input: &xharness_session::InboxMessage) -> QueuedPrompt {
    let (content, source, fingerprint) = input
        .source
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|metadata| {
            Some((
                metadata.get("content")?.as_array()?.clone(),
                metadata.get("source").cloned()?,
                metadata
                    .get("rpcFingerprint")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            ))
        })
        .unwrap_or_else(|| {
            (
                vec![json!({"type": "text", "text": input.message.content})],
                json!({"kind": "user", "restored": true}),
                None,
            )
        });
    QueuedPrompt {
        id: input.id.clone(),
        text: input.message.content.clone(),
        content,
        source,
        fingerprint,
    }
}

fn restored_admissions(session: &Session) -> BTreeMap<String, QueuedPrompt> {
    let session_id = &session.header().id;
    let mut admissions = BTreeMap::new();
    for event in session.events() {
        let EventData::AgentInboxSpliced { inserted, .. } = event.data() else {
            continue;
        };
        for input in inserted {
            let metadata = input.source.as_ref().and_then(Value::as_object);
            let belongs_to_session = metadata
                .and_then(|value| value.get("rpcSessionId"))
                .and_then(Value::as_str)
                == Some(session_id.as_str());
            if !belongs_to_session {
                continue;
            }
            let prompt = restored_prompt(input);
            if prompt.fingerprint.is_some() {
                admissions.insert(prompt.id.clone(), prompt);
            }
        }
    }
    admissions
}

pub(crate) fn restored_session_mutation_receipts(
    session: &Session,
) -> BTreeMap<String, crate::state::ProjectedSessionMutationReceipt> {
    session
        .events()
        .iter()
        .enumerate()
        .filter_map(|(index, event)| {
            let EventData::SessionMutationCommitted { receipt } = event.data() else {
                return None;
            };
            let state_event_seq = session.events().get(index.checked_sub(1)?)?.seq;
            Some((
                receipt.rpc_id.clone(),
                crate::state::ProjectedSessionMutationReceipt {
                    receipt: receipt.clone(),
                    state_event_seq,
                },
            ))
        })
        .collect()
}

#[derive(Clone)]
struct PromptView {
    content: Vec<Value>,
    source: Value,
}

pub(crate) fn project_session_event_range(
    session: &Session,
    route: &ModelRoute,
    start: usize,
    end: usize,
) -> Vec<Value> {
    let prompts = prompt_views(session);
    project_session_event_range_with_prompts(session, route, &prompts, start, end)
}

pub(crate) fn project_session_event_tail(
    session: &Session,
    route: &ModelRoute,
    max_events: usize,
    max_bytes: usize,
) -> ProjectedEventTail {
    let end = session.events().len();
    let prompts = prompt_views(session);
    let max_events = max_events.max(1);
    let max_bytes = max_bytes.max(1);
    let mut reversed = Vec::new();
    let mut bytes = 0usize;

    for event in session.events().iter().rev().take(max_events) {
        let projected = restored_web_event(event, route, &prompts);
        let event_bytes = serde_json::to_vec(&projected)
            .map(|encoded| encoded.len())
            .unwrap_or(max_bytes.saturating_add(1));
        if event_bytes > max_bytes.saturating_sub(bytes) {
            break;
        }
        bytes = bytes.saturating_add(event_bytes);
        reversed.push(projected);
    }
    reversed.reverse();
    let start = end.saturating_sub(reversed.len());
    ProjectedEventTail {
        base_seq: u64::try_from(start).unwrap_or(u64::MAX),
        next_seq: session.next_seq(),
        bytes,
        events: reversed,
    }
}

pub(crate) fn project_session_history(
    session: &Session,
    route: &ModelRoute,
    before_seq: Option<u64>,
    max_messages: usize,
) -> ProjectedHistoryPage {
    let end = before_seq
        .and_then(|seq| usize::try_from(seq).ok())
        .map_or(session.events().len(), |seq| {
            seq.min(session.events().len())
        });
    let mut start = end;
    let mut messages = 0usize;
    while start > 0 && messages < max_messages.max(1) {
        start -= 1;
        if matches!(
            session.events()[start].data(),
            EventData::UserMessage { .. }
                | EventData::AssistantMessage { .. }
                | EventData::ToolResult { .. }
        ) {
            messages += 1;
        }
    }
    ProjectedHistoryPage {
        events: project_session_event_range(session, route, start, end),
        has_more: start > 0,
        as_of_seq: session.next_seq().checked_sub(1),
    }
}

fn project_session_event_range_with_prompts(
    session: &Session,
    route: &ModelRoute,
    prompts: &BTreeMap<String, PromptView>,
    start: usize,
    end: usize,
) -> Vec<Value> {
    let end = end.min(session.events().len());
    let start = start.min(end);
    session.events()[start..end]
        .iter()
        .map(|event| restored_web_event(event, route, prompts))
        .collect()
}

fn prompt_views(session: &Session) -> BTreeMap<String, PromptView> {
    let mut prompts = BTreeMap::new();
    for event in session.events() {
        let EventData::AgentInboxSpliced { inserted, .. } = event.data() else {
            continue;
        };
        for input in inserted {
            let prompt = restored_prompt(input);
            prompts.insert(
                input.id.clone(),
                PromptView {
                    content: prompt.content,
                    source: prompt.source,
                },
            );
        }
    }
    prompts
}

fn restored_web_event(
    event: &LoggedEvent,
    route: &ModelRoute,
    prompts: &BTreeMap<String, PromptView>,
) -> Value {
    let (event_type, data, surface_op) = match event.data() {
        EventData::AgentPresetSelected { .. }
        | EventData::AgentInboxSpliced { .. }
        | EventData::SessionModelSelected { .. }
        | EventData::RequestHeader { .. }
        | EventData::ApprovalAsked { .. }
        | EventData::ApprovalDecided { .. }
        | EventData::PermissionPreset { .. }
        | EventData::SandboxMode { .. }
        | EventData::ApprovalPolicy { .. }
        | EventData::CommandRun { .. }
        | EventData::CommandDone { .. }
        | EventData::SessionTitle { .. }
        | EventData::GoalChange { .. }
        | EventData::PlanMode { .. }
        | EventData::LlmRetry { .. }
        | EventData::LlmRetryStarted { .. } => tagged_event_data(event.data()),
        EventData::SessionMutationCommitted { .. } => {
            return json!({
                "type": "xharness/internal",
                "seq": event.seq,
                "time": event.timestamp_ms,
                "data": {"kind": "session-mutation-receipt"},
                "hidden": true,
            });
        }
        EventData::TurnStart { turn } => (
            "turn/start".to_owned(),
            json!({
                "turn": web_turn(*turn),
                "trigger": {"kind": "message", "source": {"kind": "user"}},
            }),
            None,
        ),
        EventData::TurnEnd { turn, reason } => (
            "turn/end".to_owned(),
            json!({"turn": web_turn(*turn), "reason": web_turn_end(reason)}),
            None,
        ),
        EventData::StepStart { turn, step } => (
            "step/start".to_owned(),
            json!({"turn": web_turn(*turn), "step": step}),
            None,
        ),
        EventData::StepEnd { turn, step } => (
            "step/end".to_owned(),
            json!({"turn": web_turn(*turn), "step": step}),
            None,
        ),
        EventData::UserMessage { message } => (
            "user/message".to_owned(),
            web_message(message, route, event.seq, prompts),
            Some("append"),
        ),
        EventData::AssistantChunk { turn, step, chunk } => (
            "assistant/chunk".to_owned(),
            json!({
                "turn": web_turn(*turn),
                "step": step,
                "chunk": web_assistant_chunk(chunk),
            }),
            None,
        ),
        EventData::AssistantMessage {
            turn,
            step,
            message,
            usage,
        } => (
            "assistant/message".to_owned(),
            json!({
                "turn": web_turn(*turn),
                "step": step,
                "message": web_message(message, route, event.seq, prompts),
                "usage": usage,
            }),
            Some("append"),
        ),
        EventData::ToolCall { turn, step, call } => (
            "tool/call".to_owned(),
            json!({
                "turn": web_turn(*turn),
                "step": step,
                "callId": call.id,
                "name": call.name,
                "arguments": call.arguments_json,
            }),
            None,
        ),
        EventData::ToolResult { turn, step, result } => (
            "tool/result".to_owned(),
            json!({
                "turn": web_turn(*turn),
                "step": step,
                "message": {
                    "id": format!("restored-tool-{}", event.seq),
                    "role": "user",
                    "content": [{
                        "type": "tool-result",
                        "toolCallId": result.call_id,
                        "content": [{"type": "text", "text": result.content}],
                        "isError": result.outcome != ToolOutcome::Success,
                    }],
                    "source": {"kind": "tool", "callId": result.call_id},
                },
            }),
            Some("append"),
        ),
        EventData::SessionEndSeed => tagged_event_data(event.data()),
    };
    let mut web = json!({
        "type": event_type,
        "seq": event.seq,
        "time": event.timestamp_ms,
        "data": data,
    });
    if let Some(surface_op) = surface_op {
        web.as_object_mut()
            .expect("restored event is an object")
            .insert("surfaceOp".to_owned(), json!(surface_op));
    }
    web
}

fn tagged_event_data(event: &EventData) -> (String, Value, Option<&'static str>) {
    let mut value = serde_json::to_value(event).expect("EventData is serializable");
    let object = value
        .as_object_mut()
        .expect("tagged EventData serializes as an object");
    let event_type = object
        .remove("type")
        .and_then(|value| value.as_str().map(str::to_owned))
        .expect("tagged EventData contains a type");
    let data = object.remove("data").unwrap_or(Value::Null);
    (event_type, data, None)
}

fn web_turn(turn: u32) -> u32 {
    // Durable loop turns are one-based while the upstream Web surface starts
    // at zero. Keeping this conversion here makes replay and live continuation
    // use the same browser coordinates.
    turn.saturating_sub(1)
}

fn web_turn_end(reason: &TurnEndReason) -> Value {
    match reason {
        TurnEndReason::Completed => json!({"kind": "completed"}),
        TurnEndReason::Cancelled => json!({"kind": "cancelled"}),
        TurnEndReason::LimitReached => json!({"kind": "max-steps"}),
        TurnEndReason::Failed { error } => json!({
            "kind": "error",
            "error": {"code": "LOOP_FAILED", "message": error},
        }),
        TurnEndReason::Interrupted => json!({
            "kind": "error",
            "error": {
                "code": "INTERRUPTED",
                "message": "the previous Host stopped before this turn closed",
            },
        }),
    }
}

fn web_assistant_chunk(chunk: &AssistantChunk) -> Value {
    match chunk {
        AssistantChunk::TextDelta(text) => {
            json!({"type": "text-delta", "index": 0, "text": text})
        }
        AssistantChunk::ReasoningDelta(text) => {
            json!({"type": "reasoning-delta", "index": 0, "text": text})
        }
        AssistantChunk::ToolCallDelta {
            index,
            id,
            name,
            arguments_delta,
        } => json!({
            "type": "tool-call-delta",
            "index": index,
            "id": id,
            "name": name,
            "argumentsDelta": arguments_delta,
        }),
        AssistantChunk::Usage(usage) => json!({"type": "usage", "usage": usage}),
        AssistantChunk::Finish { reason } => json!({"type": "finish", "reason": reason}),
        AssistantChunk::Provider(item) => json!({"type": "provider", "item": item}),
    }
}

fn web_message(
    message: &Message,
    route: &ModelRoute,
    seq: u64,
    prompts: &BTreeMap<String, PromptView>,
) -> Value {
    let id = message
        .id
        .clone()
        .unwrap_or_else(|| format!("restored-{}-{seq}", message.role.as_str()));
    if message.role == MessageRole::User {
        if let Some(prompt) = prompts.get(&id) {
            return json!({
                "id": id,
                "role": "user",
                "content": prompt.content,
                "source": prompt.source,
            });
        }
    }
    let source = match message.role {
        MessageRole::Assistant => {
            json!({"kind": "model", "provider": route.provider, "model": route.model})
        }
        MessageRole::Tool => json!({"kind": "tool", "callId": message.tool_call_id}),
        MessageRole::System => json!({"kind": "system"}),
        MessageRole::User => json!({"kind": "user", "restored": true}),
    };
    json!({
        "id": id,
        "role": message.role.as_str(),
        "content": [{"type": "text", "text": message.content}],
        "source": source,
    })
}

fn attach_workspace(
    state: &mut crate::state::HostState,
    session_id: &str,
    cwd: &str,
    created_at_ms: u64,
) {
    let workspace_id = state
        .workspaces
        .iter()
        .find_map(|(id, workspace)| (workspace.path == cwd).then(|| id.clone()))
        .unwrap_or_else(|| {
            let ordinal = state.workspaces.len();
            let mut id = format!("workspace-recovered-{ordinal}");
            while state.workspaces.contains_key(&id) {
                id.push('x');
            }
            let title = Path::new(cwd)
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| !name.is_empty())
                .unwrap_or(cwd)
                .to_owned();
            let timestamp = created_at_ms.to_string();
            state.workspaces.insert(
                id.clone(),
                WorkspaceRecord {
                    workspace_id: id.clone(),
                    path: cwd.to_owned(),
                    title,
                    session_ids: Vec::new(),
                    created_at: timestamp.clone(),
                    updated_at: timestamp,
                },
            );
            state.workspace_order.push(id.clone());
            id
        });
    let workspace = state
        .workspaces
        .get_mut(&workspace_id)
        .expect("selected workspace exists");
    if !workspace
        .session_ids
        .iter()
        .any(|existing| existing == session_id)
    {
        workspace.session_ids.push(session_id.to_owned());
    }
    workspace.updated_at = created_at_ms.to_string();
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
        time::Duration,
    };

    use async_trait::async_trait;
    use futures::{stream, StreamExt};
    use tokio::sync::Notify;
    use tokio_util::sync::CancellationToken;
    use xharness_agent::{DurableInbox, InboxMessage, InboxTarget, MemoryLeaseManager};
    use xharness_api::{
        ApiBackend, ClientResponse, ClientResponseKind, RpcId, RpcMethod, RpcResult,
    };
    use xharness_control::{ControlRevision, ControlStore, JsonlControlStore};
    use xharness_core::{
        FinishReason, IdentityContextPolicy, ModelProvider, ProviderError, ProviderEvent,
        ProviderRequest, ProviderStream, ToolResult, ToolSpec,
    };
    use xharness_session::{
        ApprovalOutcome, EventData, LlmFailure, LlmRetryMode, MemorySessionStore, Message,
        RequestHeader, Revision, Session, SessionEvent, SessionHeader, Store, ToolCall,
        ToolOutcome, ToolResultData, TurnEndReason,
    };

    use super::*;
    use crate::{
        state::now_ms, DurableLoopAgentRuntime, HostConfig, NoTools, PermissionPreset,
        SessionToolFactory,
    };

    struct GatedProvider {
        calls: AtomicUsize,
        release: Arc<Notify>,
        answers: Mutex<VecDeque<String>>,
    }

    #[async_trait]
    impl ModelProvider for GatedProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        fn model_name(&self) -> Option<&str> {
            Some("test-model")
        }

        async fn stream(
            &self,
            _request: ProviderRequest,
            _cancellation: CancellationToken,
        ) -> Result<ProviderStream, ProviderError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.release.notified().await;
            let answer = self.answers.lock().unwrap().pop_front().unwrap();
            Ok(Box::pin(stream::iter([
                Ok(ProviderEvent::TextDelta(answer)),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::Stop),
                    usage: None,
                    provider_items: Vec::new(),
                }),
            ])))
        }
    }

    struct ApprovalRecoveryProvider {
        requests: Arc<Mutex<Vec<ProviderRequest>>>,
    }

    #[async_trait]
    impl ModelProvider for ApprovalRecoveryProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        fn model_name(&self) -> Option<&str> {
            Some("test-model")
        }

        async fn stream(
            &self,
            request: ProviderRequest,
            _cancellation: CancellationToken,
        ) -> Result<ProviderStream, ProviderError> {
            self.requests.lock().unwrap().push(request);
            Ok(Box::pin(stream::iter([
                Ok(ProviderEvent::TextDelta("recovered".to_owned())),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::Stop),
                    usage: None,
                    provider_items: Vec::new(),
                }),
            ])))
        }
    }

    struct ApprovalRecoveryTools {
        executions: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl SessionToolFactory for ApprovalRecoveryTools {
        async fn tools(
            &self,
            _session_id: &str,
            _cwd: &str,
            _permission: PermissionPreset,
        ) -> Result<Vec<ToolSpec>, String> {
            let executions = Arc::clone(&self.executions);
            Ok(vec![ToolSpec::new(
                "guarded",
                "approval recovery fixture",
                serde_json::json!({"type":"object"}),
                move |_, _| {
                    executions.fetch_add(1, Ordering::SeqCst);
                    async { ToolResult::success("recovered tool result") }
                },
            )
            .requires_approval()])
        }
    }

    fn config(cwd: &Path) -> HostConfig {
        let mut config = HostConfig::new(cwd);
        config.provider_id = "test".to_owned();
        config.provider_display_name = "Test".to_owned();
        config.model_id = "test-model".to_owned();
        config
    }

    fn closed_text_turn(turn: u32, user: &str, assistant: &str) -> Vec<SessionEvent> {
        vec![
            EventData::TurnStart { turn }.into(),
            EventData::UserMessage {
                message: Message::user(user).with_id(format!("user-{turn}")),
            }
            .into(),
            EventData::StepStart { turn, step: 1 }.into(),
            EventData::RequestHeader {
                header: RequestHeader::new("test", "test-model"),
            }
            .into(),
            EventData::AssistantMessage {
                turn,
                step: 1,
                message: Message::assistant(assistant).with_id(format!("assistant-{turn}")),
                usage: None,
            }
            .into(),
            EventData::StepEnd { turn, step: 1 }.into(),
            EventData::TurnEnd {
                turn,
                reason: TurnEndReason::Completed,
            }
            .into(),
        ]
    }

    #[test]
    fn authoritative_history_pages_are_independent_of_the_bounded_live_tail() {
        let mut session = Session::new(SessionHeader::new("paged")).unwrap();
        let events = (1..=6)
            .flat_map(|turn| {
                closed_text_turn(turn, &format!("question-{turn}"), &format!("answer-{turn}"))
            })
            .collect::<Vec<_>>();
        session.append_batch_at(Revision::ZERO, events, 1).unwrap();
        let route = ModelRoute::new("test", "test-model");

        let tail = project_session_event_tail(&session, &route, 5, usize::MAX);
        assert_eq!(tail.events.len(), 5);
        assert_eq!(tail.base_seq, session.next_seq() - 5);
        assert_eq!(tail.next_seq, session.next_seq());
        assert_eq!(tail.events[0]["seq"], tail.base_seq);
        let byte_evicted = project_session_event_tail(&session, &route, usize::MAX, 1);
        assert!(byte_evicted.events.is_empty());
        assert_eq!(byte_evicted.base_seq, session.next_seq());
        assert_eq!(byte_evicted.bytes, 0);

        let newest = project_session_history(&session, &route, None, 2);
        assert!(newest.has_more);
        assert_eq!(newest.as_of_seq, session.next_seq().checked_sub(1));
        assert!(newest
            .events
            .iter()
            .any(|event| event["data"].to_string().contains("question-6")));
        assert!(newest
            .events
            .iter()
            .any(|event| event["data"].to_string().contains("answer-6")));
        let cursor = newest.events[0]["seq"].as_u64().unwrap();
        let previous = project_session_history(&session, &route, Some(cursor), 2);
        assert!(previous
            .events
            .iter()
            .all(|event| event["seq"].as_u64().unwrap() < cursor));
        assert!(previous
            .events
            .iter()
            .any(|event| event["data"].to_string().contains("question-5")));
    }

    #[tokio::test]
    async fn durable_history_remains_complete_after_tail_eviction_and_restart() {
        let cwd = std::env::temp_dir();
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let mut header = SessionHeader::new("bounded-history");
        header.cwd = Some(cwd.to_string_lossy().into_owned());
        store.create(header).await.unwrap();
        let events = (1..=6)
            .flat_map(|turn| {
                closed_text_turn(turn, &format!("question-{turn}"), &format!("answer-{turn}"))
            })
            .collect::<Vec<_>>();
        store
            .append("bounded-history", Revision::ZERO, events)
            .await
            .unwrap();

        for _restart in 0..2 {
            let runtime = Arc::new(DurableLoopAgentRuntime::new(
                "test",
                "test-model",
                None,
                Arc::new(NoTools),
                Arc::new(IdentityContextPolicy),
                Arc::clone(&store),
                Arc::new(MemoryLeaseManager::default()),
                64,
            ));
            let mut host_config = config(&cwd);
            host_config.session_event_cache_capacity = 5;
            host_config.session_event_cache_bytes = usize::MAX;
            let host = BasicHost::with_agent_runtime(host_config, runtime);
            host.restore_from_store(Arc::clone(&store)).await.unwrap();
            {
                let state = host.state.read().await;
                let record = &state.sessions["bounded-history"];
                assert_eq!(record.events.len(), 5);
                assert_eq!(record.event_base_seq, record.next_event_seq() - 5);
                assert_eq!(record.last_event_seq(), Some(41));
            }
            let history = host
                .call(
                    RpcId::new(format!("history-{_restart}")),
                    RpcMethod::SessionHistory,
                    json!({"sessionId": "bounded-history", "maxMessages": 500}),
                    CancellationToken::new(),
                )
                .await;
            let RpcResult::Success { value: Some(value) } = history else {
                panic!("history failed: {history:?}");
            };
            assert_eq!(value["events"].as_array().unwrap().len(), 42);
            assert_eq!(value["projections"]["asOfSeq"], 41);
            assert_eq!(value["hasMore"], false);
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn workspace_settings_and_mutation_receipts_survive_a_host_restart() {
        let root = std::env::temp_dir().join(format!(
            "xharness-host-control-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let cwd = root.join("boot");
        let custom = root.join("custom");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&custom).unwrap();
        let session_store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let control_store: Arc<dyn ControlStore> =
            Arc::new(JsonlControlStore::new(root.join("control")).unwrap());

        let runtime = Arc::new(DurableLoopAgentRuntime::new(
            "test",
            "test-model",
            None,
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            Arc::clone(&session_store),
            Arc::new(MemoryLeaseManager::default()),
            64,
        ));
        let live = BasicHost::with_agent_runtime_and_control_store(
            config(&cwd),
            runtime,
            Arc::clone(&control_store),
        );
        live.restore_from_store(Arc::clone(&session_store))
            .await
            .unwrap();

        let create_payload = json!({"path": custom.to_string_lossy()});
        let left = {
            let host = Arc::clone(&live);
            let payload = create_payload.clone();
            tokio::spawn(async move {
                host.call(
                    RpcId::new("workspace-create-once"),
                    RpcMethod::WorkspaceCreate,
                    payload,
                    CancellationToken::new(),
                )
                .await
            })
        };
        let right = {
            let host = Arc::clone(&live);
            let payload = create_payload.clone();
            tokio::spawn(async move {
                host.call(
                    RpcId::new("workspace-create-once"),
                    RpcMethod::WorkspaceCreate,
                    payload,
                    CancellationToken::new(),
                )
                .await
            })
        };
        let [created, duplicate] = [left.await.unwrap(), right.await.unwrap()];
        assert_eq!(created, duplicate);
        let RpcResult::Success {
            value: Some(created),
        } = created
        else {
            panic!("workspace create failed: {created:?}");
        };
        let workspace_id = created["workspace"]["workspaceId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            control_store.load().await.unwrap().revision(),
            ControlRevision(1)
        );

        let renamed = live
            .call(
                RpcId::new("workspace-rename-once"),
                RpcMethod::WorkspaceRename,
                json!({"workspaceId": workspace_id, "title": "Durable custom"}),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(renamed, RpcResult::Success { .. }));
        let settings_payload = json!({
            "ns": "ui-onboarding",
            "section": {"welcomeNoticeVersion": "v2"},
            "expectedRevision": 0,
        });
        let settings = live
            .call(
                RpcId::new("settings-once"),
                RpcMethod::SettingsReplace,
                settings_payload.clone(),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(settings, RpcResult::Success { .. }));
        assert_eq!(
            control_store.load().await.unwrap().revision(),
            ControlRevision(3)
        );

        drop(live);
        std::fs::remove_dir_all(&custom).unwrap();
        let restarted_runtime = Arc::new(DurableLoopAgentRuntime::new(
            "test",
            "test-model",
            None,
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            Arc::clone(&session_store),
            Arc::new(MemoryLeaseManager::default()),
            64,
        ));
        let restarted = BasicHost::with_agent_runtime_and_control_store(
            config(&cwd),
            restarted_runtime,
            Arc::clone(&control_store),
        );
        restarted
            .restore_from_store(Arc::clone(&session_store))
            .await
            .unwrap();
        let workspaces = restarted
            .call(
                RpcId::new("workspace-list-after-restart"),
                RpcMethod::WorkspaceList,
                json!({}),
                CancellationToken::new(),
            )
            .await;
        let RpcResult::Success {
            value: Some(workspaces),
        } = workspaces
        else {
            panic!("workspace list failed: {workspaces:?}");
        };
        assert!(workspaces["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|workspace| {
                workspace["workspaceId"] == workspace_id && workspace["title"] == "Durable custom"
            }));
        let described = restarted
            .call(
                RpcId::new("settings-after-restart"),
                RpcMethod::SettingsDescribe,
                json!({}),
                CancellationToken::new(),
            )
            .await;
        let RpcResult::Success {
            value: Some(described),
        } = described
        else {
            panic!("settings describe failed: {described:?}");
        };
        assert!(described["namespaces"]
            .as_array()
            .unwrap()
            .iter()
            .any(|namespace| {
                namespace["ns"] == "ui-onboarding"
                    && namespace["value"]["welcomeNoticeVersion"] == "v2"
                    && namespace["revision"] == 1
            }));

        // Receipt lookup precedes path validation: the original success can
        // be recovered even though the directory disappeared after commit.
        let replay = restarted
            .call(
                RpcId::new("workspace-create-once"),
                RpcMethod::WorkspaceCreate,
                create_payload,
                CancellationToken::new(),
            )
            .await;
        assert_eq!(replay, duplicate);
        assert_eq!(
            control_store.load().await.unwrap().revision(),
            ControlRevision(3)
        );
        let conflict = restarted
            .call(
                RpcId::new("settings-once"),
                RpcMethod::SettingsReplace,
                json!({
                    "ns": "ui-onboarding",
                    "section": {"welcomeNoticeVersion": "different"},
                    "expectedRevision": 0,
                }),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(conflict, RpcResult::Failure { .. }));
        assert_eq!(
            control_store.load().await.unwrap().revision(),
            ControlRevision(3)
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn restore_rebuilds_history_events_messages_and_workspace_projection() {
        let cwd = std::env::temp_dir();
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let mut header = SessionHeader::new("history-session");
        header.created_at_ms = 123;
        header.cwd = Some(cwd.to_string_lossy().into_owned());
        store.create(header).await.unwrap();
        let mut request_header = RequestHeader::new("test", "test-model");
        request_header.reasoning_effort = Some("high".to_owned());
        store
            .append(
                "history-session",
                Revision::ZERO,
                vec![
                    SessionEvent::from(EventData::TurnStart { turn: 1 }),
                    EventData::UserMessage {
                        message: Message::user("hello").with_id("prompt-history"),
                    }
                    .into(),
                    EventData::StepStart { turn: 1, step: 1 }.into(),
                    EventData::RequestHeader {
                        header: request_header,
                    }
                    .into(),
                    EventData::AssistantMessage {
                        turn: 1,
                        step: 1,
                        message: Message::assistant("world").with_id("answer-history"),
                        usage: None,
                    }
                    .into(),
                    EventData::StepEnd { turn: 1, step: 1 }.into(),
                    EventData::TurnEnd {
                        turn: 1,
                        reason: TurnEndReason::Completed,
                    }
                    .into(),
                ],
            )
            .await
            .unwrap();

        let host = BasicHost::without_provider(config(&cwd));
        let report = host.restore_from_store(Arc::clone(&store)).await.unwrap();
        assert_eq!(report.discovered_sessions, 1);
        assert_eq!(report.restored_sessions, 1);
        assert!(report.issues.is_empty());

        let state = host.state.read().await;
        let session = state.sessions.get("history-session").unwrap();
        assert_eq!(session.messages.len(), 2);
        assert_eq!(session.messages[0].content, "hello");
        assert_eq!(session.messages[1].content, "world");
        assert_eq!(session.model.provider, "test");
        assert_eq!(session.model.model, "test-model");
        assert_eq!(session.model.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(session.next_turn, 1);
        assert!(!session.blank);
        assert_eq!(session.events.len(), 7);
        assert_eq!(session.events[0]["type"], "turn/start");
        assert_eq!(session.events[0]["data"]["turn"], 0);
        assert!(state
            .workspaces
            .values()
            .any(|workspace| workspace.session_ids == ["history-session"]));
    }

    #[tokio::test]
    async fn approval_and_retry_events_project_with_frozen_wire_names() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        store
            .create(SessionHeader::new("control-projection"))
            .await
            .unwrap();
        let call = ToolCall {
            id: "execution-1".to_owned(),
            provider_call_id: Some("provider-call-1".to_owned()),
            index: 0,
            name: "bash".to_owned(),
            arguments_json: r#"{"command":"pwd"}"#.to_owned(),
        };
        let mut assistant = Message::assistant("");
        assistant.tool_calls.push(call.clone());
        store
            .append(
                "control-projection",
                Revision::ZERO,
                vec![
                    EventData::TurnStart { turn: 1 }.into(),
                    EventData::UserMessage {
                        message: Message::user("inspect"),
                    }
                    .into(),
                    EventData::StepStart { turn: 1, step: 1 }.into(),
                    EventData::RequestHeader {
                        header: RequestHeader::new("test", "test-model"),
                    }
                    .into(),
                    EventData::LlmRetry {
                        retry_id: "retry-1".to_owned(),
                        turn: 1,
                        step: 1,
                        provider: "test".to_owned(),
                        mode: LlmRetryMode::Normal,
                        policy_key: "normal:2".to_owned(),
                        retry: 1,
                        max_retries: Some(2),
                        delay_ms: 0,
                        failure: LlmFailure::transport("temporary"),
                    }
                    .into(),
                    EventData::LlmRetryStarted {
                        retry_id: "retry-1".to_owned(),
                        turn: 1,
                        step: 1,
                        retry: 1,
                    }
                    .into(),
                    EventData::AssistantMessage {
                        turn: 1,
                        step: 1,
                        message: assistant,
                        usage: None,
                    }
                    .into(),
                    EventData::ToolCall {
                        turn: 1,
                        step: 1,
                        call,
                    }
                    .into(),
                    EventData::ApprovalAsked {
                        id: "approval-1".to_owned(),
                        tool_name: "bash".to_owned(),
                        call_id: Some("execution-1".to_owned()),
                        reason: Some("requires permission".to_owned()),
                    }
                    .into(),
                    EventData::ApprovalDecided {
                        id: "approval-1".to_owned(),
                        outcome: ApprovalOutcome::Rejected,
                    }
                    .into(),
                    EventData::ToolResult {
                        turn: 1,
                        step: 1,
                        result: ToolResultData::error("execution-1", "rejected"),
                    }
                    .into(),
                    EventData::StepEnd { turn: 1, step: 1 }.into(),
                    EventData::TurnEnd {
                        turn: 1,
                        reason: TurnEndReason::Completed,
                    }
                    .into(),
                ],
            )
            .await
            .unwrap();
        let session = store.load("control-projection").await.unwrap().unwrap();
        let route = ModelRoute {
            provider: "test".to_owned(),
            model: "test-model".to_owned(),
            reasoning_effort: None,
        };
        let projected = project_session_event_range(&session, &route, 0, session.events().len());
        let controls = projected
            .iter()
            .filter(|event| {
                matches!(
                    event["type"].as_str(),
                    Some("approval/asked" | "approval/decided" | "llm/retry" | "llm/retry-started")
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            controls
                .iter()
                .map(|event| event["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "llm/retry",
                "llm/retry-started",
                "approval/asked",
                "approval/decided",
            ]
        );
        assert_eq!(controls[0]["data"]["retryId"], "retry-1");
        assert_eq!(controls[2]["data"]["toolName"], "bash");
        assert_eq!(controls[2]["data"]["callId"], "execution-1");
        assert_eq!(controls[3]["data"]["outcome"], "rejected");
        assert!(controls
            .iter()
            .all(|event| event.get("surfaceOp").is_none()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn restore_reattaches_pending_approval_and_executes_only_after_web_response() {
        let cwd = std::env::temp_dir();
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let mut header = SessionHeader::new("approval-restart");
        header.cwd = Some(cwd.to_string_lossy().into_owned());
        store.create(header).await.unwrap();
        let call = ToolCall {
            id: "execution-restart".to_owned(),
            provider_call_id: Some("provider-restart".to_owned()),
            index: 0,
            name: "guarded".to_owned(),
            arguments_json: "{}".to_owned(),
        };
        let mut assistant = Message::assistant("");
        assistant.tool_calls.push(call.clone());
        store
            .append(
                "approval-restart",
                Revision::ZERO,
                vec![
                    EventData::TurnStart { turn: 1 }.into(),
                    EventData::UserMessage {
                        message: Message::user("run guarded tool").with_id("original-prompt"),
                    }
                    .into(),
                    EventData::StepStart { turn: 1, step: 1 }.into(),
                    EventData::RequestHeader {
                        header: RequestHeader::new("test", "test-model"),
                    }
                    .into(),
                    EventData::AssistantMessage {
                        turn: 1,
                        step: 1,
                        message: assistant,
                        usage: None,
                    }
                    .into(),
                    EventData::ToolCall {
                        turn: 1,
                        step: 1,
                        call: call.clone(),
                    }
                    .into(),
                    EventData::ApprovalAsked {
                        id: "approval-restart-stable".to_owned(),
                        tool_name: "guarded".to_owned(),
                        call_id: Some(call.id.clone()),
                        reason: Some("requires explicit approval".to_owned()),
                    }
                    .into(),
                ],
            )
            .await
            .unwrap();
        store.flush("approval-restart").await.unwrap();

        let requests = Arc::new(Mutex::new(Vec::new()));
        let executions = Arc::new(AtomicUsize::new(0));
        let provider: Arc<dyn ModelProvider> = Arc::new(ApprovalRecoveryProvider {
            requests: Arc::clone(&requests),
        });
        let runtime = Arc::new(DurableLoopAgentRuntime::new(
            "test",
            "test-model",
            Some(provider),
            Arc::new(ApprovalRecoveryTools {
                executions: Arc::clone(&executions),
            }),
            Arc::new(IdentityContextPolicy),
            Arc::clone(&store),
            Arc::new(MemoryLeaseManager::default()),
            64,
        ));
        let host = BasicHost::with_agent_runtime(config(&cwd), runtime);
        let mut mux = host.mux_events();
        let report = host.restore_from_store(Arc::clone(&store)).await.unwrap();
        assert_eq!(report.resumed_pending_approvals, 1);
        assert_eq!(report.resumed_pending_turns, 0);
        assert!(report.issues.is_empty());

        let approval = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let frame = mux.next().await.expect("mux remained open");
                if frame.payload["type"] == "approval/requested" {
                    break frame;
                }
            }
        })
        .await
        .expect("recovered approval was not projected");
        assert_eq!(approval.payload["approvalId"], "approval-restart-stable");
        assert_eq!(approval.payload["callId"], "execution-restart");
        assert_eq!(executions.load(Ordering::SeqCst), 0);
        assert!(requests.lock().unwrap().is_empty());

        let receipt = host
            .respond(ClientResponse {
                kind: ClientResponseKind::ClientResponse,
                rpc_id: approval.rpc_id,
                result: RpcResult::success(serde_json::json!({
                    "sessionId": "approval-restart",
                    "approvalId": "approval-restart-stable",
                    "outcome": "allowed-once",
                })),
            })
            .await;
        assert_eq!(receipt, xharness_api::RpcReceipt::Accepted);

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let session = store.load("approval-restart").await.unwrap().unwrap();
                if session.events().iter().any(|event| {
                    matches!(
                        event.data(),
                        EventData::TurnEnd {
                            turn: 1,
                            reason: TurnEndReason::Completed
                        }
                    )
                }) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("recovered turn did not finish");
        assert_eq!(executions.load(Ordering::SeqCst), 1);
        {
            let requests = requests.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].step, 2);
            assert_eq!(
                requests[0].messages.last().unwrap().tool_call_id.as_deref(),
                Some("provider-restart")
            );
        }

        let session = store.load("approval-restart").await.unwrap().unwrap();
        assert_eq!(session.pending_tool_approvals().len(), 0);
        assert_eq!(
            session
                .events()
                .iter()
                .filter(|event| matches!(event.data(), EventData::ApprovalAsked { .. }))
                .count(),
            1
        );
        assert!(session.events().iter().any(|event| matches!(
            event.data(),
            EventData::ToolResult { result, .. }
                if result.call_id == "execution-restart"
                    && result.outcome == ToolOutcome::Success
        )));
    }

    #[tokio::test]
    async fn permission_command_and_receipt_survive_a_host_restart() {
        let cwd = std::env::temp_dir();
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let runtime = Arc::new(DurableLoopAgentRuntime::new(
            "test",
            "test-model",
            None,
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            Arc::clone(&store),
            Arc::new(MemoryLeaseManager::default()),
            64,
        ));
        let live = BasicHost::with_agent_runtime(config(&cwd), runtime);
        let created = live
            .call(
                RpcId::new("policy-create"),
                RpcMethod::SessionCreate,
                json!({"sessionId": "policy-session", "cwd": cwd}),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(created, RpcResult::Success { .. }));
        let switched = live
            .call_dynamic(
                RpcId::new("policy-command"),
                "commands/execute",
                json!({
                    "args": {
                        "agentId": "policy-session",
                        "line": "/permission danger-full-access",
                        "images": [],
                    }
                }),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(matches!(switched, RpcResult::Success { .. }));
        let renamed = live
            .call(
                RpcId::new("policy-rename"),
                RpcMethod::SessionRename,
                json!({"sessionId": "policy-session", "title": "  Durable   policy  "}),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(renamed, RpcResult::Success { .. }));
        let selected = live
            .call(
                RpcId::new("policy-preset"),
                RpcMethod::AgentPresetSelect,
                json!({"sessionId": "policy-session", "agentPreset": "coding"}),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(selected, RpcResult::Success { .. }));
        let selected_model = live
            .call(
                RpcId::new("policy-model"),
                RpcMethod::SessionSelectModel,
                json!({
                    "sessionId": "policy-session",
                    "provider": "test",
                    "model": "selected-model",
                    "reasoningEffort": "high",
                }),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(selected_model, RpcResult::Success { .. }));
        let plan = live
            .call_dynamic(
                RpcId::new("policy-plan"),
                "commands/execute",
                json!({
                    "args": {
                        "agentId": "policy-session",
                        "line": "/plan",
                        "images": [],
                    }
                }),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(matches!(plan, RpcResult::Success { .. }));

        let durable = store.load("policy-session").await.unwrap().unwrap();
        assert_eq!(
            restored_permission(&durable),
            PermissionPreset::DangerFullAccess
        );
        assert_eq!(
            durable
                .events()
                .iter()
                .map(|event| match event.data() {
                    EventData::AgentPresetSelected { .. } => "agent-preset/selected",
                    EventData::SessionModelSelected { .. } => "session/model-selected",
                    EventData::CommandRun { .. } => "command/run",
                    EventData::PermissionPreset { .. } => "permission/preset",
                    EventData::SandboxMode { .. } => "sandbox/mode",
                    EventData::ApprovalPolicy { .. } => "approval/policy",
                    EventData::CommandDone { .. } => "command/done",
                    EventData::SessionTitle { .. } => "session/title",
                    EventData::SessionMutationCommitted { .. } => {
                        "xharness/mutation-committed"
                    }
                    EventData::PlanMode { .. } => "plan/mode",
                    _ => "other",
                })
                .collect::<Vec<_>>(),
            [
                "agent-preset/selected",
                "permission/preset",
                "sandbox/mode",
                "approval/policy",
                "command/run",
                "permission/preset",
                "sandbox/mode",
                "approval/policy",
                "command/done",
                "session/title",
                "xharness/mutation-committed",
                "agent-preset/selected",
                "xharness/mutation-committed",
                "session/model-selected",
                "xharness/mutation-committed",
                "command/run",
                "plan/mode",
                "command/done",
            ]
        );

        let restarted_runtime = Arc::new(DurableLoopAgentRuntime::new(
            "test",
            "test-model",
            None,
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            Arc::clone(&store),
            Arc::new(MemoryLeaseManager::default()),
            64,
        ));
        let restarted = BasicHost::with_agent_runtime(config(&cwd), restarted_runtime);
        let report = restarted
            .restore_from_store(Arc::clone(&store))
            .await
            .unwrap();
        assert_eq!(report.restored_sessions, 1);
        let replayed_rename = restarted
            .call(
                RpcId::new("policy-rename"),
                RpcMethod::SessionRename,
                json!({"sessionId": "policy-session", "title": "  Durable   policy  "}),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(replayed_rename, renamed);
        let replayed_preset = restarted
            .call(
                RpcId::new("policy-preset"),
                RpcMethod::AgentPresetSelect,
                json!({"sessionId": "policy-session", "agentPreset": "coding"}),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(replayed_preset, selected);
        let replayed_model = restarted
            .call(
                RpcId::new("policy-model"),
                RpcMethod::SessionSelectModel,
                json!({
                    "sessionId": "policy-session",
                    "provider": "test",
                    "model": "selected-model",
                    "reasoningEffort": "high",
                }),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(replayed_model, selected_model);
        let conflicting_model = restarted
            .call(
                RpcId::new("policy-model"),
                RpcMethod::SessionSelectModel,
                json!({
                    "sessionId": "policy-session",
                    "provider": "test",
                    "model": "another-model",
                    "reasoningEffort": "high",
                }),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(conflicting_model, RpcResult::Failure { .. }));
        let receipt_count = store
            .load("policy-session")
            .await
            .unwrap()
            .unwrap()
            .events()
            .iter()
            .filter(|event| matches!(event.data(), EventData::SessionMutationCommitted { .. }))
            .count();
        assert_eq!(receipt_count, 3);
        let restarted_events = {
            let state = restarted.state.read().await;
            let record = state.sessions.get("policy-session").unwrap();
            assert_eq!(record.permission_preset, PermissionPreset::DangerFullAccess);
            assert_eq!(record.title.as_deref(), Some("Durable policy"));
            assert_eq!(record.agent_preset.as_deref(), Some("coding"));
            assert_eq!(record.model.provider, "test");
            assert_eq!(record.model.model, "selected-model");
            assert_eq!(record.model.reasoning_effort.as_deref(), Some("high"));
            assert!(record.plan_active);
            assert_eq!(
                record.projection_values()["plan"],
                json!({"active": true, "pending": false})
            );
            record.events.clone()
        };
        let live_events = live.state.read().await.sessions["policy-session"]
            .events
            .clone();
        assert_eq!(restarted_events, live_events);
    }

    #[tokio::test]
    async fn goal_snapshot_revisions_and_projection_survive_a_host_restart() {
        let cwd = std::env::temp_dir();
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let runtime = Arc::new(DurableLoopAgentRuntime::new(
            "test",
            "test-model",
            None,
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            Arc::clone(&store),
            Arc::new(MemoryLeaseManager::default()),
            64,
        ));
        let live = BasicHost::with_agent_runtime(config(&cwd), runtime);
        assert!(live
            .call(
                RpcId::new("goal-session-create"),
                RpcMethod::SessionCreate,
                json!({"sessionId": "goal-session", "cwd": cwd}),
                CancellationToken::new(),
            )
            .await
            .is_ok());
        let created = live
            .call(
                RpcId::new("goal-create"),
                RpcMethod::GoalCreate,
                json!({
                    "sessionId": "goal-session",
                    "objective": "Ship the durable agent",
                    "maxGoalRounds": 8,
                }),
                CancellationToken::new(),
            )
            .await;
        let RpcResult::Success {
            value: Some(created),
        } = created
        else {
            panic!("goal create failed: {created:?}");
        };
        let edited = live
            .call(
                RpcId::new("goal-edit"),
                RpcMethod::GoalEdit,
                json!({
                    "sessionId": "goal-session",
                    "ref": created["ref"],
                    "objective": "Ship the durable Rust agent",
                }),
                CancellationToken::new(),
            )
            .await;
        let RpcResult::Success {
            value: Some(edited),
        } = edited
        else {
            panic!("goal edit failed: {edited:?}");
        };
        let pause_payload = json!({"sessionId": "goal-session", "ref": edited["ref"]});
        let paused = live
            .call(
                RpcId::new("goal-pause"),
                RpcMethod::GoalPause,
                pause_payload.clone(),
                CancellationToken::new(),
            )
            .await;
        assert!(paused.is_ok());

        let durable = store.load("goal-session").await.unwrap().unwrap();
        let goal = restored_goal(&durable).expect("current durable goal");
        assert_eq!(goal.revision, 3);
        assert_eq!(goal.phase, xharness_session::GoalPhase::Paused);
        assert_eq!(goal.objective, "Ship the durable Rust agent");
        assert_eq!(
            durable
                .events()
                .iter()
                .filter(|event| matches!(event.data(), EventData::GoalChange { .. }))
                .count(),
            3
        );
        assert_eq!(
            durable
                .events()
                .iter()
                .filter(|event| {
                    matches!(event.data(), EventData::SessionMutationCommitted { .. })
                })
                .count(),
            3
        );
        let history = live
            .call(
                RpcId::new("goal-history"),
                RpcMethod::SessionHistory,
                json!({"sessionId": "goal-session", "maxMessages": 500}),
                CancellationToken::new(),
            )
            .await;
        let RpcResult::Success {
            value: Some(history),
        } = history
        else {
            panic!("goal history failed: {history:?}");
        };
        let encoded_history = serde_json::to_string(&history).unwrap();
        assert!(encoded_history.contains("session-mutation-receipt"));
        assert!(!encoded_history.contains("goal-pause"));
        assert!(!encoded_history.contains("\"fingerprint\""));
        assert!(!encoded_history.contains("\"response\""));

        let restarted_runtime = Arc::new(DurableLoopAgentRuntime::new(
            "test",
            "test-model",
            None,
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            Arc::clone(&store),
            Arc::new(MemoryLeaseManager::default()),
            64,
        ));
        let restarted = BasicHost::with_agent_runtime(config(&cwd), restarted_runtime);
        restarted
            .restore_from_store(Arc::clone(&store))
            .await
            .unwrap();
        {
            let state = restarted.state.read().await;
            let restored = state.goals.get("goal-session").expect("restored goal");
            assert_eq!(restored.revision, 3);
            assert_eq!(restored.phase, xharness_session::GoalPhase::Paused);
            assert_eq!(
                restored.projection()["goal"]["objective"],
                "Ship the durable Rust agent"
            );
        }

        let replayed = restarted
            .call(
                RpcId::new("goal-pause"),
                RpcMethod::GoalPause,
                pause_payload,
                CancellationToken::new(),
            )
            .await;
        assert_eq!(replayed, paused);
        let conflict = restarted
            .call(
                RpcId::new("goal-pause"),
                RpcMethod::GoalPause,
                json!({
                    "sessionId": "goal-session",
                    "ref": {"id": edited["ref"]["id"], "revision": 999},
                }),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(conflict, RpcResult::Failure { .. }));
        let after_replay = store.load("goal-session").await.unwrap().unwrap();
        assert_eq!(
            after_replay
                .events()
                .iter()
                .filter(|event| matches!(event.data(), EventData::GoalChange { .. }))
                .count(),
            3
        );
    }

    #[tokio::test]
    async fn restore_reattaches_and_runs_pending_input_exactly_once() {
        let cwd = std::env::temp_dir();
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let mut header = SessionHeader::new("pending-session");
        header.cwd = Some(cwd.to_string_lossy().into_owned());
        let inbox = DurableInbox::open(Arc::clone(&store), header)
            .await
            .unwrap();
        inbox
            .append(
                InboxTarget::NextTurn,
                InboxMessage::user("pending-input", "resume this"),
            )
            .await
            .unwrap();

        let release = Arc::new(Notify::new());
        let provider = Arc::new(GatedProvider {
            calls: AtomicUsize::new(0),
            release: Arc::clone(&release),
            answers: Mutex::new(VecDeque::from(["done".to_owned()])),
        });
        let provider_dyn: Arc<dyn ModelProvider> = provider.clone();
        let config = config(&cwd);
        let runtime = Arc::new(DurableLoopAgentRuntime::new(
            "test",
            "test-model",
            Some(provider_dyn),
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            Arc::clone(&store),
            Arc::new(MemoryLeaseManager::default()),
            64,
        ));
        let host = BasicHost::with_agent_runtime(config, runtime);
        let report = host.restore_from_store(Arc::clone(&store)).await.unwrap();
        assert_eq!(report.resumed_pending_turns, 1);
        assert!(report.issues.is_empty());

        release.notify_one();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let completed = store
                    .load("pending-session")
                    .await
                    .unwrap()
                    .unwrap()
                    .events()
                    .iter()
                    .any(|event| matches!(event.data(), EventData::TurnEnd { .. }));
                if completed {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("restored turn must complete");

        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        let session = store.load("pending-session").await.unwrap().unwrap();
        assert_eq!(
            session
                .events()
                .iter()
                .filter_map(|event| match event.data() {
                    EventData::AgentInboxSpliced { inserted, .. } => Some(
                        inserted
                            .iter()
                            .filter(|message| message.id == "pending-input")
                            .count(),
                    ),
                    _ => None,
                })
                .sum::<usize>(),
            1,
            "startup resume must not append the durable input again"
        );
        assert_eq!(
            session
                .derive_messages()
                .iter()
                .filter(|message| message.id.as_deref() == Some("pending-input"))
                .count(),
            1
        );
        assert_eq!(session.derive_messages().last().unwrap().content, "done");
    }

    #[tokio::test]
    async fn restore_rebuilds_prompt_receipts_before_runtime_resume() {
        let cwd = std::env::temp_dir();
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let mut header = SessionHeader::new("receipt-session");
        header.cwd = Some(cwd.to_string_lossy().into_owned());
        let inbox = DurableInbox::open(Arc::clone(&store), header)
            .await
            .unwrap();
        let content = vec![json!({"type": "text", "text": "admitted before crash"})];
        let fingerprint = crate::rpc::prompt_fingerprint("queue", &content, None);
        let mut input = InboxMessage::user("receipt-rpc", "admitted before crash");
        input.source = Some(json!({
            "content": content,
            "source": {"kind": "user", "rpcId": "receipt-rpc"},
            "rpcFingerprint": fingerprint,
            "rpcSessionId": "receipt-session",
        }));
        inbox.append(InboxTarget::NextTurn, input).await.unwrap();

        // No provider is configured. Restoration reports that pending work is
        // not runnable, but admission receipts must still become queryable.
        let runtime = Arc::new(DurableLoopAgentRuntime::new(
            "test",
            "test-model",
            None,
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            Arc::clone(&store),
            Arc::new(MemoryLeaseManager::default()),
            64,
        ));
        let host = BasicHost::with_agent_runtime(config(&cwd), runtime);
        let report = host.restore_from_store(Arc::clone(&store)).await.unwrap();
        assert_eq!(report.restored_sessions, 1);
        assert_eq!(report.issues.len(), 1);

        let replay = host
            .call(
                RpcId::new("receipt-rpc"),
                RpcMethod::SessionPrompt,
                json!({
                    "sessionId": "receipt-session",
                    "mode": "queue",
                    "content": [{"type": "text", "text": "admitted before crash"}],
                }),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(replay, RpcResult::Success { .. }));

        let conflict = host
            .call(
                RpcId::new("receipt-rpc"),
                RpcMethod::SessionPrompt,
                json!({
                    "sessionId": "receipt-session",
                    "mode": "queue",
                    "content": [{"type": "text", "text": "different payload"}],
                }),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(
            conflict,
            RpcResult::Failure {
                error: xharness_api::RpcError {
                    code: xharness_api::RpcErrorCode::SessionConflict,
                    ..
                }
            }
        ));

        let restored = store.load("receipt-session").await.unwrap().unwrap();
        assert_eq!(
            restored
                .events()
                .iter()
                .filter_map(|event| match event.data() {
                    EventData::AgentInboxSpliced { inserted, .. } => Some(
                        inserted
                            .iter()
                            .filter(|message| message.id == "receipt-rpc")
                            .count(),
                    ),
                    _ => None,
                })
                .sum::<usize>(),
            1,
            "a response-loss retry must not append a second durable input"
        );
    }

    #[tokio::test]
    async fn live_and_restarted_history_use_the_same_authoritative_projection() {
        let cwd = std::env::temp_dir();
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let release = Arc::new(Notify::new());
        let provider = Arc::new(GatedProvider {
            calls: AtomicUsize::new(0),
            release: Arc::clone(&release),
            answers: Mutex::new(VecDeque::from(["stable answer".to_owned()])),
        });
        let provider_dyn: Arc<dyn ModelProvider> = provider.clone();
        let runtime = Arc::new(DurableLoopAgentRuntime::new(
            "test",
            "test-model",
            Some(provider_dyn),
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            Arc::clone(&store),
            Arc::new(MemoryLeaseManager::default()),
            64,
        ));
        let live = BasicHost::with_agent_runtime(config(&cwd), runtime);
        let created = live
            .call(
                RpcId::new("projection-create"),
                RpcMethod::SessionCreate,
                json!({"sessionId": "projection-session", "cwd": cwd}),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(created, RpcResult::Success { .. }));
        let admitted = live
            .call(
                RpcId::new("projection-prompt"),
                RpcMethod::SessionPrompt,
                json!({
                    "sessionId": "projection-session",
                    "mode": "queue",
                    "clientTimeZone": "Asia/Shanghai",
                    "content": [{"type": "text", "text": "stable question"}],
                }),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(admitted, RpcResult::Success { .. }));
        release.notify_one();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let completed = store
                    .load("projection-session")
                    .await
                    .unwrap()
                    .unwrap()
                    .events()
                    .iter()
                    .any(|event| matches!(event.data(), EventData::TurnEnd { .. }));
                if completed {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("live turn completes");
        let live_history = live
            .call(
                RpcId::new("projection-live-history"),
                RpcMethod::SessionHistory,
                json!({"sessionId": "projection-session", "maxMessages": 500}),
                CancellationToken::new(),
            )
            .await;
        let RpcResult::Success {
            value: Some(live_history),
        } = live_history
        else {
            panic!("live history failed: {live_history:?}");
        };

        let restarted_runtime = Arc::new(DurableLoopAgentRuntime::new(
            "test",
            "test-model",
            None,
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            Arc::clone(&store),
            Arc::new(MemoryLeaseManager::default()),
            64,
        ));
        let restarted = BasicHost::with_agent_runtime(config(&cwd), restarted_runtime);
        let report = restarted
            .restore_from_store(Arc::clone(&store))
            .await
            .unwrap();
        assert!(report.issues.is_empty());
        let restarted_history = restarted
            .call(
                RpcId::new("projection-restarted-history"),
                RpcMethod::SessionHistory,
                json!({"sessionId": "projection-session", "maxMessages": 500}),
                CancellationToken::new(),
            )
            .await;
        let RpcResult::Success {
            value: Some(restarted_history),
        } = restarted_history
        else {
            panic!("restarted history failed: {restarted_history:?}");
        };
        assert_eq!(live_history["events"], restarted_history["events"]);
        assert_eq!(
            live_history["projections"],
            restarted_history["projections"]
        );
        let user = live_history["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["event"]["type"] == "user/message")
            .unwrap();
        assert_eq!(
            user["event"]["data"]["content"][0]["text"],
            "stable question"
        );
        assert_eq!(
            user["event"]["data"]["source"]["clientTimeZone"],
            "Asia/Shanghai"
        );
    }
}

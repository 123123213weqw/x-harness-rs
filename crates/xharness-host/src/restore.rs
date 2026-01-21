use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::Path,
    sync::Arc,
};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use xharness_agent::InboxProjection;
use xharness_session::{
    AssistantChunk, EventData, LoggedEvent, Message, MessageRole, RequestHeader, Session, Store,
    StoreError, ToolOutcome, TurnEndReason,
};

const HISTORY_CHUNK_COALESCE_BYTES: usize = 64 * 1_024;

use crate::{
    metrics::{web_token_usage, MetricsProjectionState},
    runtime::{AgentSessionRequest, ModelRoute},
    state::{
        DriverCommand, GoalState, ModelSelection, QueuePlacement, QueuedPrompt, SessionRecord,
        WorkspaceRecord,
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
    pub resumed_user_questions: usize,
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
        self.start_background_turn_listener();
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
            let projected_queue = restored_queue(&inbox);
            let admissions = restored_admissions(&session);
            let projected_queue_len = queue.len();
            let pending_approval_count = session.pending_tool_approvals().len();
            let recoverable_question_count = session.recoverable_user_questions().len();
            let runtime_background_work = match self.agent_runtime.needs_session_resume(&session) {
                Ok(required) => required,
                Err(error) => {
                    report.issues.push(HostRestoreIssue {
                        session_id: session_id.clone(),
                        message: error.to_string(),
                    });
                    false
                }
            };
            let metric_events =
                project_session_event_range(&session, &route, 0, session.events().len());
            let metrics = MetricsProjectionState::rebuild(metric_events.iter());
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
                // `origin` is a frozen Web-wire discriminant. The upstream
                // client accepts only `"subagent"`; ordinary sessions remain
                // ordinary after a Host restart, so restoration must not leak
                // an internal lifecycle marker into `session.list`.
                origin: None,
                cwd: cwd.clone(),
                agent_preset: restored_agent_preset(&session),
                title: restored_title(&session),
                model: ModelSelection {
                    provider: route.provider.clone(),
                    model: route.model.clone(),
                    reasoning_effort: route.reasoning_effort.clone(),
                    context_window_tokens: route.context_window_tokens,
                },
                permission_preset: permission,
                plan_active,
                goal: goal.clone(),
                events: tail.events,
                event_base_seq: tail.base_seq,
                event_cache_bytes: tail.bytes,
                metrics,
                messages,
                queue,
                projected_queue,
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
            if projected_queue_len > 0
                || pending_approval_count > 0
                || recoverable_question_count > 0
                || runtime_background_work
            {
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
                    recoverable_question_count,
                ));
            }
        }

        // The runtime subscribes and prepares every recovered input before it
        // wakes the durable Agent. Only after that succeeds do we publish the
        // Host-owned driver/control projection.
        for (
            session_id,
            cwd,
            route,
            permission,
            prompt,
            projected_count,
            projected_approvals,
            projected_questions,
        ) in resumable
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
                    if runtime_report.recovered_question_work_id.is_some() {
                        report.resumed_user_questions += projected_questions;
                    } else if projected_questions > 0 {
                        report.issues.push(HostRestoreIssue {
                            session_id: session_id.clone(),
                            message: "runtime did not attach the durable user question".to_owned(),
                        });
                        continue;
                    }
                    if runtime_report.pending_turns == 0
                        && runtime_report.recovered_approval_work_id.is_none()
                        && runtime_report.recovered_question_work_id.is_none()
                    {
                        // Timer-only activation is driven by the runtime's
                        // background-turn notice. Starting an empty Host queue
                        // driver here would race and clear its running state.
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
                    if let Some(work_id) = runtime_report
                        .recovered_approval_work_id
                        .or(runtime_report.recovered_question_work_id)
                    {
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
                                    "runtime lost recovered interaction work {work_id:?}"
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
    // `session/model-selected` is the durable user preference.  Request
    // headers are execution observations and older providers may omit the
    // optional reasoning effort from them.  Looking for both event kinds in a
    // single reverse scan lets a later request header erase an explicit
    // effort after restart (for example `low` becomes the model default).
    // Prefer the newest explicit selection for the lifetime of the session;
    // only legacy sessions without one fall back to their last request route.
    if let Some(route) = session
        .events()
        .iter()
        .rev()
        .find_map(|event| match event.data() {
            EventData::SessionModelSelected {
                provider,
                model,
                reasoning_effort,
                context_window_tokens,
            } => Some(ModelRoute {
                provider: provider.clone(),
                model: model.clone(),
                reasoning_effort: reasoning_effort.clone(),
                context_window_tokens: *context_window_tokens,
            }),
            _ => None,
        })
    {
        return route;
    }

    session
        .events()
        .iter()
        .rev()
        .find_map(|event| match event.data() {
            EventData::RequestHeader { header } => Some(ModelRoute {
                provider: header.provider.clone(),
                model: header.model.clone(),
                reasoning_effort: header.reasoning_effort.clone(),
                context_window_tokens: None,
            }),
            _ => None,
        })
        .unwrap_or_else(|| ModelRoute {
            provider: config.provider_id.clone(),
            model: config.model_id.clone(),
            reasoning_effort: None,
            context_window_tokens: config
                .token_guard
                .as_ref()
                .map(|guard| guard.budget().context_window_tokens),
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

pub(crate) fn restored_prompt(input: &xharness_session::InboxMessage) -> QueuedPrompt {
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
        placement: QueuePlacement::Queued,
    }
}

pub(crate) fn restored_queue(inbox: &InboxProjection) -> Vec<QueuedPrompt> {
    let mut items = inbox
        .next_turn()
        .iter()
        .map(restored_prompt)
        .collect::<Vec<_>>();
    items.extend(inbox.next_step().iter().map(|input| {
        let mut prompt = restored_prompt(input);
        prompt.placement = if prompt.source.get("kind").and_then(Value::as_str) == Some("user") {
            QueuePlacement::Steering
        } else {
            QueuePlacement::Context
        };
        prompt
    }));
    items
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

/// Derive the optional upstream Tool presentation owned by one durable event.
///
/// The browser deliberately keeps event facts and their presentation apart:
/// the `session/event` envelope carries `event` plus an optional `view`.  A
/// plain `tool/call` therefore remains valid, but specialized shell rows
/// cannot expand unless the Host supplies the matching card contract.
/// Keeping this derivation beside the durable projector makes live delivery,
/// paged history and restart replay use exactly the same data.
pub(crate) fn project_session_event_view(session: &Session, event: &LoggedEvent) -> Option<Value> {
    match event.data() {
        EventData::ToolCall { call, .. } => terminal_call_view(&call.name, &call.arguments_json),
        EventData::ToolResult { result, .. } => {
            let is_shell = session.events().iter().rev().any(|candidate| {
                candidate.seq < event.seq
                    && matches!(
                        candidate.data(),
                        EventData::ToolCall { call, .. }
                            if call.id == result.call_id && is_shell_tool(&call.name)
                    )
            });
            if !is_shell {
                return None;
            }
            // Older journals may predate structured Tool metadata. Their
            // model-facing result is still JSON, so retain restart
            // compatibility without changing the durable schema.
            let parsed = result
                .metadata
                .is_none()
                .then(|| serde_json::from_str::<Value>(&result.content).ok())
                .flatten();
            let metadata = result.metadata.as_ref().or(parsed.as_ref())?;
            terminal_result_view(metadata)
        }
        _ => None,
    }
}

/// Recover the same optional presentation from an already projected Web
/// event. This keeps the legacy in-memory adapter and bounded tail cache
/// compatible with the authoritative durable path. It intentionally accepts
/// only the distinctive native-shell foreground-result shape, so arbitrary JSON tool
/// output cannot accidentally become executable-looking terminal chrome.
pub(crate) fn project_web_event_view(event: &Value, history: &[Value]) -> Option<Value> {
    match event.get("type").and_then(Value::as_str)? {
        "tool/call" => {
            let data = event.get("data")?;
            terminal_call_view(
                data.get("name")?.as_str()?,
                data.get("arguments")?.as_str()?,
            )
        }
        "tool/result" => {
            let call_id = event.pointer("/data/message/source/callId")?.as_str()?;
            let seq = event.get("seq").and_then(Value::as_u64);
            let is_shell = history.iter().rev().any(|candidate| {
                candidate.get("type").and_then(Value::as_str) == Some("tool/call")
                    && candidate.pointer("/data/callId").and_then(Value::as_str) == Some(call_id)
                    && candidate
                        .pointer("/data/name")
                        .and_then(Value::as_str)
                        .is_some_and(is_shell_tool)
                    && seq
                        .is_none_or(|seq| candidate.get("seq").and_then(Value::as_u64) < Some(seq))
            });
            if !is_shell {
                return None;
            }
            let result_text = event
                .pointer("/data/message/content/0/content/0/text")?
                .as_str()?;
            let metadata = serde_json::from_str::<Value>(result_text).ok()?;
            terminal_result_view(&metadata)
        }
        _ => None,
    }
}

fn terminal_call_view(name: &str, arguments_json: &str) -> Option<Value> {
    if !is_shell_tool(name) {
        return None;
    }
    let arguments = serde_json::from_str::<Value>(arguments_json).ok()?;
    let arguments = arguments.as_object()?;
    let command = arguments.get("command")?.as_str()?;
    let mut view = serde_json::Map::from_iter([
        ("card".to_owned(), json!("terminal")),
        ("title".to_owned(), json!(command)),
    ]);
    if let Some(cwd) = arguments.get("cwd").and_then(Value::as_str) {
        view.insert("cwd".to_owned(), json!(cwd));
    }
    if let Some(description) = arguments.get("description").and_then(Value::as_str) {
        view.insert("description".to_owned(), json!(description));
    }
    Some(json!({"for": "call", "view": Value::Object(view)}))
}

fn is_shell_tool(name: &str) -> bool {
    matches!(name, "bash" | "pwsh")
}

fn terminal_result_view(metadata: &Value) -> Option<Value> {
    let metadata = metadata.as_object()?;
    if metadata.get("kind").and_then(Value::as_str) != Some("foreground") {
        return None;
    }
    let stdout = metadata.get("stdout").and_then(Value::as_str)?;
    let stderr = metadata
        .get("stderr")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut output = String::with_capacity(stdout.len().saturating_add(stderr.len() + 1));
    output.push_str(stdout);
    if !stderr.is_empty() {
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(stderr);
    }
    if metadata
        .get("stdout_truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        append_terminal_notice(&mut output, "[stdout truncated]");
    }
    if metadata
        .get("stderr_truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        append_terminal_notice(&mut output, "[stderr truncated]");
    }

    let mut view = serde_json::Map::from_iter([
        ("card".to_owned(), json!("terminal")),
        ("output".to_owned(), Value::String(output)),
    ]);
    if let Some(exit_code) = metadata.get("exit_code").and_then(Value::as_i64) {
        view.insert("exitCode".to_owned(), json!(exit_code));
    }
    if let Some(signal) = metadata.get("signal").and_then(Value::as_i64) {
        view.insert("signal".to_owned(), json!(signal));
    }
    Some(json!({"for": "result", "view": Value::Object(view)}))
}

fn append_terminal_notice(output: &mut String, notice: &str) {
    if !output.is_empty() && !output.ends_with('\n') {
        output.push('\n');
    }
    output.push_str(notice);
    output.push('\n');
}

pub(crate) fn project_session_event_tail(
    session: &Session,
    route: &ModelRoute,
    max_events: usize,
    max_bytes: usize,
) -> ProjectedEventTail {
    let end = session.events().len();
    let prompts = prompt_views(session);
    let initial_request_header_seq = initial_request_header_seq(session);
    let completed_steps = completed_assistant_steps(session);
    let max_events = max_events.max(1);
    let max_bytes = max_bytes.max(1);
    let mut reversed = Vec::new();
    let mut bytes = 0usize;

    for event in session.events().iter().rev().take(max_events) {
        let projected = restored_web_event(
            event,
            route,
            &prompts,
            initial_request_header_seq,
            Some(&completed_steps),
        );
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
        events: project_session_history_range(session, route, start, end),
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
    let initial_request_header_seq = initial_request_header_seq(session);
    session.events()[start..end]
        .iter()
        .map(|event| restored_web_event(event, route, prompts, initial_request_header_seq, None))
        .collect()
}

fn project_session_history_range(
    session: &Session,
    route: &ModelRoute,
    start: usize,
    end: usize,
) -> Vec<Value> {
    let end = end.min(session.events().len());
    let start = start.min(end);
    let prompts = prompt_views(session);
    let initial_request_header_seq = initial_request_header_seq(session);
    let completed_steps = completed_assistant_steps(session);
    let mut projected = Vec::new();
    for event in &session.events()[start..end] {
        if is_folded_assistant_chunk(event, &completed_steps) {
            continue;
        }
        let next = restored_web_event(event, route, &prompts, initial_request_header_seq, None);
        if projected
            .last_mut()
            .is_some_and(|prior| merge_projected_history_chunk(prior, &next))
        {
            continue;
        }
        projected.push(next);
    }
    projected
}

/// History does not need one browser event per provider token. Preserve the
/// complete partial text and its order while bounding each synthetic payload;
/// live authoritative projection still uses exact durable sequence events.
fn merge_projected_history_chunk(prior: &mut Value, next: &Value) -> bool {
    if prior.get("type") != Some(&Value::String("assistant/chunk".to_owned()))
        || next.get("type") != Some(&Value::String("assistant/chunk".to_owned()))
    {
        return false;
    }

    let Some(prior_data) = prior.get_mut("data").and_then(Value::as_object_mut) else {
        return false;
    };
    let Some(next_data) = next.get("data").and_then(Value::as_object) else {
        return false;
    };
    if prior_data.get("turn") != next_data.get("turn")
        || prior_data.get("step") != next_data.get("step")
    {
        return false;
    }

    let Some(prior_chunk) = prior_data.get_mut("chunk").and_then(Value::as_object_mut) else {
        return false;
    };
    let Some(next_chunk) = next_data.get("chunk").and_then(Value::as_object) else {
        return false;
    };
    let kind = prior_chunk.get("type").and_then(Value::as_str);
    if !matches!(kind, Some("text-delta" | "reasoning-delta"))
        || kind != next_chunk.get("type").and_then(Value::as_str)
    {
        return false;
    }
    let Some(prior_text) = prior_chunk.get("text").and_then(Value::as_str) else {
        return false;
    };
    let Some(next_text) = next_chunk.get("text").and_then(Value::as_str) else {
        return false;
    };
    if prior_text.len().saturating_add(next_text.len()) > HISTORY_CHUNK_COALESCE_BYTES {
        return false;
    }
    let mut merged = String::with_capacity(prior_text.len().saturating_add(next_text.len()));
    merged.push_str(prior_text);
    merged.push_str(next_text);
    prior_chunk.insert("text".to_owned(), Value::String(merged));
    true
}

fn completed_assistant_steps(session: &Session) -> BTreeSet<(u32, u32)> {
    session
        .events()
        .iter()
        .filter_map(|event| match event.data() {
            EventData::AssistantMessage { turn, step, .. } => Some((*turn, *step)),
            _ => None,
        })
        .collect()
}

fn is_folded_assistant_chunk(event: &LoggedEvent, completed_steps: &BTreeSet<(u32, u32)>) -> bool {
    matches!(
        event.data(),
        EventData::AssistantChunk { turn, step, .. }
            if completed_steps.contains(&(*turn, *step))
    )
}

fn initial_request_header_seq(session: &Session) -> Option<u64> {
    session.events().iter().find_map(|event| {
        matches!(event.data(), EventData::RequestHeader { .. }).then_some(event.seq)
    })
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
    initial_request_header_seq: Option<u64>,
    fold_completed_chunks: Option<&BTreeSet<(u32, u32)>>,
) -> Value {
    if fold_completed_chunks.is_some_and(|completed| is_folded_assistant_chunk(event, completed)) {
        return json!({
            "type": "xharness/internal",
            "seq": event.seq,
            "time": event.timestamp_ms,
            "data": {"kind": "folded-assistant-chunk"},
            "hidden": true,
        });
    }
    let (event_type, data, surface_op) = match event.data() {
        EventData::AgentPresetSelected { .. }
        | EventData::SessionModelSelected { .. }
        | EventData::ApprovalAsked { .. }
        | EventData::ApprovalDecided { .. }
        | EventData::PermissionPreset { .. }
        | EventData::SandboxMode { .. }
        | EventData::ApprovalPolicy { .. }
        | EventData::CommandRun { .. }
        | EventData::CommandDone { .. }
        | EventData::SessionTitle { .. }
        | EventData::GoalChange { .. }
        | EventData::ScheduleChange { .. }
        | EventData::PlanMode { .. }
        | EventData::LlmRetry { .. }
        | EventData::LlmRetryStarted { .. }
        | EventData::CompactionStart { .. }
        | EventData::CompactionSummary { .. }
        | EventData::CompactionEnd { .. }
        | EventData::CompactionPrune { .. }
        | EventData::RequestContext { .. } => tagged_event_data(event.data()),
        EventData::RequestHeader { header } => {
            web_request_header(header, initial_request_header_seq == Some(event.seq))
        }
        EventData::AgentInboxSpliced {
            target,
            start,
            removed_count,
            inserted,
            outcome,
        } => {
            let mut data = json!({
                "target": target,
                "start": start,
                "removedCount": removed_count,
                // The Web fold spreads this field unconditionally; an empty
                // removal splice must therefore carry `[]` rather than rely on
                // the durable enum's skip-empty serialization.
                "inserted": inserted,
            });
            if let Some(outcome) = outcome {
                data.as_object_mut()
                    .expect("inbox splice data is an object")
                    .insert("outcome".to_owned(), json!(outcome));
            }
            ("agent/inbox/spliced".to_owned(), data, None)
        }
        EventData::SessionMutationCommitted { .. } => {
            return json!({
                "type": "xharness/internal",
                "seq": event.seq,
                "time": event.timestamp_ms,
                "data": {"kind": "session-mutation-receipt"},
                "hidden": true,
            });
        }
        EventData::QuestionRequested { .. }
        | EventData::QuestionDraftUpdated { .. }
        | EventData::QuestionResolved { .. }
        | EventData::QuestionCancelled { .. } => {
            return json!({
                "type": "xharness/internal",
                "seq": event.seq,
                "time": event.timestamp_ms,
                "data": {"kind": "user-question-lifecycle"},
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
        EventData::UserMessage {
            message,
            surface_replace,
        } => (
            "user/message".to_owned(),
            web_message(message, route, event.seq, prompts),
            Some(surface_replace.as_ref().map_or_else(
                || json!("append"),
                |replace| {
                    json!({
                        "op": "replace",
                        "start": replace.shadowed_range.start,
                        "end": replace.shadowed_range.end,
                    })
                },
            )),
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
        } => {
            let mut data = json!({
                "turn": web_turn(*turn),
                "step": step,
                "message": web_message(message, route, event.seq, prompts),
            });
            if let Some(usage) = usage.as_ref().and_then(web_token_usage) {
                data.as_object_mut()
                    .expect("assistant message data is an object")
                    .insert("usage".to_owned(), usage);
            }
            ("assistant/message".to_owned(), data, Some(json!("append")))
        }
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
            Some(json!("append")),
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
            .insert("surfaceOp".to_owned(), surface_op);
    }
    if let EventData::UserMessage {
        surface_replace: Some(replace),
        ..
    } = event.data()
    {
        web.as_object_mut()
            .expect("restored event is an object")
            .insert("sourceEventSeqs".to_owned(), json!(replace.shadowed_seqs));
    }
    web
}

fn tagged_event_data(event: &EventData) -> (String, Value, Option<Value>) {
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

/// Project the durable provider-neutral request snapshot into the upstream Web
/// request-header shape while retaining XHarness' exact message input and
/// policy/budget audit fields as additive extensions. The ordinary Trajectory
/// client consumes `config/system/tools`; the Context Inspector consumes
/// `input/options`. Keeping both in one immutable event guarantees that the
/// two views describe the same provider call.
fn web_request_header(header: &RequestHeader, initial: bool) -> (String, Value, Option<Value>) {
    let mut config = json!({
        "provider": header.provider,
        "model": header.model,
    });
    if let Some(reasoning_effort) = &header.reasoning_effort {
        config
            .as_object_mut()
            .expect("request config is an object")
            .insert(
                "reasoningEffort".to_owned(),
                Value::String(reasoning_effort.clone()),
            );
    }

    let mut web_header = json!({
        "config": config,
        "tools": header.tools,
        "input": header.input,
        "options": header.options,
        "xharnessVersion": 1,
    });
    if let Some(system) = &header.system {
        web_header
            .as_object_mut()
            .expect("request header is an object")
            .insert("system".to_owned(), Value::String(system.clone()));
    }

    (
        "request/header".to_owned(),
        json!({
            "header": web_header,
            "reason": if initial { "initial" } else { "change" },
        }),
        None,
    )
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
        TurnEndReason::MaxTokens => json!({"kind": "max-tokens"}),
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
        AssistantChunk::Usage(usage) => web_token_usage(usage).map_or_else(
            || json!({"type": "provider", "item": {"kind": "invalid-usage"}}),
            |usage| json!({"type": "usage", "usage": usage}),
        ),
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
    use xharness_control::{ControlRevision, ControlStore, JsonlControlStore, MemoryControlStore};
    use xharness_core::{
        FinishReason, IdentityContextPolicy, ModelProvider, ProviderError, ProviderEvent,
        ProviderRequest, ProviderStream, TokenUsage,
    };
    use xharness_interaction::{
        AnswerDestination, AskUserQuestionRequest, AskUserQuestionTool, QuestionInvocation,
        QuestionOption, QuestionSpec, ASK_USER_QUESTION_TOOL,
    };
    use xharness_session::{
        ApprovalOutcome, AssistantChunk, EventData, LlmFailure, LlmRetryMode, MemorySessionStore,
        Message, RequestHeader, Revision, SequenceRange, Session, SessionEvent, SessionHeader,
        Store, SurfaceReplace, ToolCall, ToolOutcome, ToolResultData, TurnEndReason,
    };
    use xharness_tools::{ToolDefinition, ToolExecutor, ToolOutput, ToolRegistry, ToolSpec};

    use super::*;
    use crate::{
        state::now_ms, DurableLoopAgentRuntime, HostConfig, ModelDescriptor, ModelReasoning,
        ModelReasoningEffort, ModelRegistry, NoTools, PermissionPreset, RegisteredModel,
        SessionToolFactory,
    };

    struct GatedProvider {
        calls: AtomicUsize,
        release: Arc<Notify>,
        answers: Mutex<VecDeque<String>>,
    }

    struct LiveDeltaProvider {
        delta_announced: Arc<Notify>,
        finish_release: Arc<Notify>,
    }

    #[async_trait]
    impl ModelProvider for LiveDeltaProvider {
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
            let delta_announced = Arc::clone(&self.delta_announced);
            let finish_release = Arc::clone(&self.finish_release);
            Ok(Box::pin(
                stream::once(async move {
                    delta_announced.notify_one();
                    Ok(ProviderEvent::TextDelta("live-0".to_owned()))
                })
                .chain(stream::iter((1..64).map(|index| {
                    Ok(ProviderEvent::TextDelta(format!("live-{index}")))
                })))
                .chain(stream::once(async move {
                    finish_release.notified().await;
                    Ok(ProviderEvent::Completed {
                        finish_reason: Some(FinishReason::Stop),
                        usage: None,
                        provider_items: Vec::new(),
                    })
                })),
            ))
        }
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
                    usage: Some(TokenUsage {
                        input_tokens: 10,
                        output_tokens: 5,
                        cache_read_tokens: 90,
                        cache_write_tokens: 2,
                        reasoning_tokens: 3,
                    }),
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

    struct QuestionRecoveryTools {
        hub: Arc<crate::DurableQuestionHub>,
    }

    #[async_trait]
    impl SessionToolFactory for QuestionRecoveryTools {
        async fn executor(
            &self,
            session_id: &str,
            cwd: &str,
            _permission: PermissionPreset,
        ) -> Result<ToolExecutor, String> {
            let registry = Arc::new(ToolRegistry::new());
            AskUserQuestionTool::new(Arc::new(crate::DurableQuestionProvider::new(
                Arc::clone(&self.hub),
                session_id,
                cwd,
            )))
            .register(&registry)
            .await
            .map_err(|error| error.to_string())?;
            Ok(ToolExecutor::new(registry))
        }
    }

    #[async_trait]
    impl SessionToolFactory for ApprovalRecoveryTools {
        async fn executor(
            &self,
            _session_id: &str,
            _cwd: &str,
            _permission: PermissionPreset,
        ) -> Result<ToolExecutor, String> {
            let executions = Arc::clone(&self.executions);
            let registry = Arc::new(ToolRegistry::new());
            registry
                .register(
                    ToolSpec::new(
                        ToolDefinition::new(
                            "guarded",
                            "approval recovery fixture",
                            serde_json::json!({"type":"object"}),
                        ),
                        move |_context| {
                            let executions = Arc::clone(&executions);
                            async move {
                                executions.fetch_add(1, Ordering::SeqCst);
                                Ok(ToolOutput::text("recovered tool result"))
                            }
                        },
                    )
                    .requiring_approval(true),
                )
                .await
                .map_err(|error| error.to_string())?;
            Ok(ToolExecutor::new(registry))
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
                surface_replace: None,
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

    fn closed_tool_session(
        tool_name: &str,
        arguments_json: String,
        result: ToolResultData,
    ) -> Session {
        let mut session = Session::new(SessionHeader::new("tool-view-session")).unwrap();
        let call = ToolCall {
            id: result.call_id.clone(),
            provider_call_id: Some(format!("provider-{}", result.call_id)),
            index: 0,
            name: tool_name.to_owned(),
            arguments_json,
        };
        let mut assistant = Message::assistant("");
        assistant.tool_calls.push(call.clone());
        session
            .append_batch_at(
                Revision::ZERO,
                vec![
                    EventData::TurnStart { turn: 1 }.into(),
                    EventData::UserMessage {
                        message: Message::user("run the tool"),
                        surface_replace: None,
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
                        call,
                    }
                    .into(),
                    EventData::ToolResult {
                        turn: 1,
                        step: 1,
                        result,
                    }
                    .into(),
                    EventData::StepEnd { turn: 1, step: 1 }.into(),
                    EventData::TurnEnd {
                        turn: 1,
                        reason: TurnEndReason::Completed,
                    }
                    .into(),
                ],
                1,
            )
            .unwrap();
        session
    }

    #[test]
    fn explicit_model_selection_survives_a_later_request_header() {
        let mut session = Session::new(SessionHeader::new("selected-route")).unwrap();
        let mut events = vec![EventData::SessionModelSelected {
            provider: "test".to_owned(),
            model: "selected-model".to_owned(),
            reasoning_effort: Some("low".to_owned()),
            context_window_tokens: Some(32_768),
        }
        .into()];
        // `closed_text_turn` appends a lifecycle-valid later request header
        // without a reasoning effort, matching the provider log that exposed
        // this restoration bug.
        events.extend(closed_text_turn(1, "hello", "world"));
        session.append_batch_at(Revision::ZERO, events, 1).unwrap();

        let route = restored_route(&session, &config(Path::new("/tmp")));
        assert_eq!(route.provider, "test");
        assert_eq!(route.model, "selected-model");
        assert_eq!(route.reasoning_effort.as_deref(), Some("low"));
        assert_eq!(route.context_window_tokens, Some(32_768));
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

    #[test]
    fn completed_stream_chunks_are_folded_for_tail_and_omitted_from_history() {
        let mut session = Session::new(SessionHeader::new("folded-stream-history")).unwrap();
        session
            .append_batch_at(
                Revision::ZERO,
                vec![
                    EventData::TurnStart { turn: 1 }.into(),
                    EventData::UserMessage {
                        message: Message::user("question").with_id("fold-user"),
                        surface_replace: None,
                    }
                    .into(),
                    EventData::StepStart { turn: 1, step: 1 }.into(),
                    EventData::AssistantChunk {
                        turn: 1,
                        step: 1,
                        chunk: AssistantChunk::ReasoningDelta("old thought".to_owned()),
                    }
                    .into(),
                    EventData::AssistantChunk {
                        turn: 1,
                        step: 1,
                        chunk: AssistantChunk::TextDelta("old answer".to_owned()),
                    }
                    .into(),
                    EventData::AssistantMessage {
                        turn: 1,
                        step: 1,
                        message: Message::assistant("old answer").with_id("fold-answer"),
                        usage: None,
                    }
                    .into(),
                    EventData::StepEnd { turn: 1, step: 1 }.into(),
                    EventData::StepStart { turn: 1, step: 2 }.into(),
                    EventData::AssistantChunk {
                        turn: 1,
                        step: 2,
                        chunk: AssistantChunk::ReasoningDelta("still running".to_owned()),
                    }
                    .into(),
                    EventData::AssistantChunk {
                        turn: 1,
                        step: 2,
                        chunk: AssistantChunk::ReasoningDelta(" and merged".to_owned()),
                    }
                    .into(),
                ],
                1,
            )
            .unwrap();
        let route = ModelRoute::new("test", "test-model");

        let tail = project_session_event_tail(&session, &route, usize::MAX, usize::MAX);
        assert_eq!(tail.events.len(), session.events().len());
        assert_eq!(tail.base_seq, 0);
        assert_eq!(tail.next_seq, session.next_seq());
        assert_eq!(tail.events[3]["type"], "xharness/internal");
        assert_eq!(tail.events[4]["type"], "xharness/internal");
        assert_eq!(tail.events[8]["type"], "assistant/chunk");
        assert_eq!(tail.events[9]["type"], "assistant/chunk");

        let history = project_session_history(&session, &route, None, 100);
        let history_events = &history.events;
        assert_eq!(
            history_events
                .iter()
                .filter(|event| event["type"] == "assistant/chunk")
                .count(),
            1,
            "only the incomplete step keeps replayable stream fragments"
        );
        let open_chunk = history_events
            .iter()
            .find(|event| event["type"] == "assistant/chunk")
            .unwrap();
        assert_eq!(
            open_chunk["data"]["chunk"]["text"],
            "still running and merged"
        );
        assert!(history_events
            .iter()
            .any(|event| event["type"] == "assistant/message"));
        assert!(history_events
            .iter()
            .all(|event| event["data"]["chunk"]["text"] != "old answer"));
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
        request_header.system = Some("system prompt".to_owned());
        request_header.tools = vec![json!({"name": "read", "description": "Read a file"})];
        request_header.input = vec![Message::user("hello")];
        request_header.options.insert(
            "tokenBudget".to_owned(),
            json!({"contextWindowTokens": 53_248}),
        );
        store
            .append(
                "history-session",
                Revision::ZERO,
                vec![
                    SessionEvent::from(EventData::TurnStart { turn: 1 }),
                    EventData::UserMessage {
                        message: Message::user("hello").with_id("prompt-history"),
                        surface_replace: None,
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
        let projected_header = session
            .events
            .iter()
            .find(|event| event["type"] == "request/header")
            .expect("request/header is projected for the Web client");
        assert_eq!(
            projected_header["data"]["header"]["config"],
            json!({
                "provider": "test",
                "model": "test-model",
                "reasoningEffort": "high",
            })
        );
        assert_eq!(projected_header["data"]["reason"], "initial");
        assert_eq!(
            projected_header["data"]["header"]["input"][0]["content"],
            "hello"
        );
        assert_eq!(
            projected_header["data"]["header"]["options"]["tokenBudget"]["contextWindowTokens"],
            53_248
        );
        assert!(
            session.summary().get("origin").is_none(),
            "ordinary restored sessions must remain compatible with the Web session.list origin enum"
        );
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
                        surface_replace: None,
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
            context_window_tokens: None,
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

    #[tokio::test]
    async fn compaction_projects_a_replace_surface_operation_with_source_evidence() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        store
            .create(SessionHeader::new("compaction-projection"))
            .await
            .unwrap();
        store
            .append(
                "compaction-projection",
                Revision::ZERO,
                vec![
                    EventData::TurnStart { turn: 1 }.into(),
                    EventData::UserMessage {
                        message: Message::user("large history"),
                        surface_replace: None,
                    }
                    .into(),
                    EventData::StepStart { turn: 1, step: 1 }.into(),
                    EventData::CompactionStart {
                        compaction_id: "compact-1".to_owned(),
                        source_command_id: None,
                        turn: Some(1),
                    }
                    .into(),
                ],
            )
            .await
            .unwrap();
        let shadowed_range = SequenceRange { start: 1, end: 1 };
        store
            .append(
                "compaction-projection",
                Revision(1),
                vec![
                    EventData::CompactionSummary {
                        compaction_id: "compact-1".to_owned(),
                        source_command_id: None,
                        summary: "summary".to_owned(),
                        shadowed_range,
                        shadowed_seqs: vec![1],
                        shadowed_token_count: 128,
                        provider: "test".to_owned(),
                        model: "test-model".to_owned(),
                        max_tokens: Some(64),
                        usage: None,
                    }
                    .into(),
                    EventData::UserMessage {
                        message: Message::user("checkpoint"),
                        surface_replace: Some(SurfaceReplace {
                            compaction_id: "compact-1".to_owned(),
                            shadowed_range,
                            shadowed_seqs: vec![1],
                        }),
                    }
                    .into(),
                    EventData::CompactionEnd {
                        compaction_id: "compact-1".to_owned(),
                        source_command_id: None,
                        turn: Some(1),
                        error: None,
                    }
                    .into(),
                ],
            )
            .await
            .unwrap();

        let session = store.load("compaction-projection").await.unwrap().unwrap();
        let route = ModelRoute {
            provider: "test".to_owned(),
            model: "test-model".to_owned(),
            reasoning_effort: None,
            context_window_tokens: None,
        };
        let projected = project_session_event_range(&session, &route, 0, session.events().len());
        let replacement = projected
            .iter()
            .find(|event| event["data"]["content"][0]["text"] == "checkpoint")
            .expect("checkpoint event is projected");
        assert_eq!(
            replacement["surfaceOp"],
            json!({"op": "replace", "start": 1, "end": 1})
        );
        assert_eq!(replacement["sourceEventSeqs"], json!([1]));
        assert!(projected
            .iter()
            .any(|event| event["type"] == "compaction/start"));
        assert!(projected
            .iter()
            .any(|event| event["type"] == "compaction/summary"));
        assert!(projected
            .iter()
            .any(|event| event["type"] == "compaction/end"));
    }

    #[tokio::test]
    async fn inbox_splice_projection_always_uses_the_web_camel_case_shape() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        store
            .create(SessionHeader::new("inbox-splice-projection"))
            .await
            .unwrap();
        store
            .append(
                "inbox-splice-projection",
                Revision::ZERO,
                vec![
                    EventData::AgentInboxSpliced {
                        target: InboxTarget::NextTurn,
                        start: 0,
                        removed_count: 0,
                        inserted: vec![InboxMessage::user("input-1", "hello")],
                        outcome: None,
                    }
                    .into(),
                    EventData::AgentInboxSpliced {
                        target: InboxTarget::NextTurn,
                        start: 0,
                        removed_count: 1,
                        inserted: Vec::new(),
                        outcome: None,
                    }
                    .into(),
                ],
            )
            .await
            .unwrap();

        let session = store
            .load("inbox-splice-projection")
            .await
            .unwrap()
            .unwrap();
        let route = ModelRoute {
            provider: "test".to_owned(),
            model: "test-model".to_owned(),
            reasoning_effort: None,
            context_window_tokens: None,
        };
        let projected = project_session_event_range(&session, &route, 0, session.events().len());
        assert_eq!(projected.len(), 2);
        assert_eq!(projected[0]["data"]["removedCount"], 0);
        assert_eq!(
            projected[0]["data"]["inserted"].as_array().unwrap().len(),
            1
        );
        assert_eq!(projected[1]["data"]["removedCount"], 1);
        assert_eq!(projected[1]["data"]["inserted"], json!([]));
        assert!(projected
            .iter()
            .all(|event| event["data"].get("removed_count").is_none()));
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
                        surface_replace: None,
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn restore_reattaches_pending_question_and_reuses_the_web_composer_protocol() {
        let cwd = std::env::temp_dir();
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let mut header = SessionHeader::new("question-restart");
        header.cwd = Some(cwd.to_string_lossy().into_owned());
        store.create(header).await.unwrap();
        let request = AskUserQuestionRequest {
            questions: vec![QuestionSpec {
                id: "target".to_owned(),
                header: "目标".to_owned(),
                question: "部署到哪里？".to_owned(),
                options: vec![QuestionOption {
                    id: "tokyo".to_owned(),
                    label: "东京 (Recommended)".to_owned(),
                    description: Some("公开服务".to_owned()),
                    recommended: true,
                }],
                allow_custom: true,
                destination: AnswerDestination::Context,
            }],
        };
        let call = ToolCall {
            id: "question-execution-restart".to_owned(),
            provider_call_id: Some("provider-question-restart".to_owned()),
            index: 0,
            name: ASK_USER_QUESTION_TOOL.to_owned(),
            arguments_json: serde_json::to_string(&request).unwrap(),
        };
        let mut assistant = Message::assistant("");
        assistant.tool_calls.push(call.clone());
        store
            .append(
                "question-restart",
                Revision::ZERO,
                vec![
                    EventData::TurnStart { turn: 1 }.into(),
                    EventData::UserMessage {
                        message: Message::user("ask me").with_id("original-question-prompt"),
                        surface_replace: None,
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
                    EventData::QuestionRequested {
                        invocation: QuestionInvocation::new(call.id.clone(), request),
                    }
                    .into(),
                ],
            )
            .await
            .unwrap();
        store.flush("question-restart").await.unwrap();

        let questions = crate::DurableQuestionHub::new(
            Arc::clone(&store),
            Arc::new(crate::NoopAgentMarkdownSink),
        );
        let requests = Arc::new(Mutex::new(Vec::new()));
        let provider: Arc<dyn ModelProvider> = Arc::new(ApprovalRecoveryProvider {
            requests: Arc::clone(&requests),
        });
        let runtime = Arc::new(DurableLoopAgentRuntime::new(
            "test",
            "test-model",
            Some(provider),
            Arc::new(QuestionRecoveryTools {
                hub: Arc::clone(&questions),
            }),
            Arc::new(IdentityContextPolicy),
            Arc::clone(&store),
            Arc::new(MemoryLeaseManager::default()),
            64,
        ));
        let host = BasicHost::with_agent_runtime_control_and_questions(
            config(&cwd),
            runtime,
            Arc::new(MemoryControlStore::default()),
            questions,
        );
        let mut mux = host.mux_events();
        let report = host.restore_from_store(Arc::clone(&store)).await.unwrap();
        assert_eq!(report.resumed_user_questions, 1);
        assert!(report.issues.is_empty());

        let question = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let frame = mux.next().await.expect("mux remained open");
                if frame.payload["type"] == "question/requested" {
                    break frame;
                }
            }
        })
        .await
        .expect("recovered question was not projected");
        assert_eq!(
            question.rpc_id.as_str(),
            "question:question-execution-restart"
        );
        assert_eq!(question.payload["sessionId"], "question-restart");
        assert_eq!(question.payload["questions"][0]["question"], "部署到哪里？");

        let receipt = host
            .respond(ClientResponse {
                kind: ClientResponseKind::ClientResponse,
                rpc_id: question.rpc_id,
                result: RpcResult::success(json!({
                    "sessionId": "question-restart",
                    "answer": {"answers": [{
                        "id": "target",
                        "selected": ["东京 (Recommended)"],
                    }]},
                })),
            })
            .await;
        assert_eq!(receipt, xharness_api::RpcReceipt::Accepted);

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let session = store.load("question-restart").await.unwrap().unwrap();
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
        .expect("recovered question turn did not finish");
        let session = store.load("question-restart").await.unwrap().unwrap();
        assert!(session.recoverable_user_questions().is_empty());
        assert!(session.events().iter().any(|event| matches!(
            event.data(),
            EventData::ToolResult { result, .. }
                if result.call_id == "question-execution-restart"
                    && result.outcome == ToolOutcome::Success
        )));
        assert_eq!(requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn permission_command_and_receipt_survive_a_host_restart() {
        let cwd = std::env::temp_dir();
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let make_runtime = |store: Arc<dyn Store>| {
            let mut models = ModelRegistry::new();
            models
                .register(RegisteredModel::new(
                    ModelDescriptor::new("test", "Test", "selected-model", "Selected model")
                        .with_reasoning(
                            ModelReasoning::new(vec![ModelReasoningEffort::new("high", "High")])
                                .with_default("high"),
                        ),
                    Arc::new(ApprovalRecoveryProvider {
                        requests: Arc::new(Mutex::new(Vec::new())),
                    }),
                ))
                .unwrap();
            Arc::new(
                DurableLoopAgentRuntime::from_registry(
                    ModelRoute::new("test", "selected-model"),
                    models,
                    Arc::new(NoTools),
                    Arc::new(IdentityContextPolicy),
                    store,
                    Arc::new(MemoryLeaseManager::default()),
                    64,
                )
                .unwrap(),
            )
        };
        let runtime = make_runtime(Arc::clone(&store));
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

        let restarted_runtime = make_runtime(Arc::clone(&store));
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
    async fn mux_queue_baseline_is_folded_from_both_durable_inbox_lists() {
        let cwd = std::env::temp_dir();
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let mut header = SessionHeader::new("queue-baseline");
        header.cwd = Some(cwd.to_string_lossy().into_owned());
        let inbox = DurableInbox::open(Arc::clone(&store), header)
            .await
            .unwrap();
        inbox
            .append(
                InboxTarget::NextStep,
                InboxMessage {
                    id: "steering-1".to_owned(),
                    message: Message::user("steer now").with_id("steering-1"),
                    source: Some(json!({
                        "content": [{"type": "text", "text": "steer now"}],
                        "source": {"kind": "user"},
                    })),
                },
            )
            .await
            .unwrap();
        inbox
            .append(
                InboxTarget::NextStep,
                InboxMessage {
                    id: "context-1".to_owned(),
                    message: Message::user("tool context").with_id("context-1"),
                    source: Some(json!({
                        "content": [{"type": "text", "text": "tool context"}],
                        "source": {"kind": "tool", "callId": "call-1"},
                    })),
                },
            )
            .await
            .unwrap();

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
        host.restore_from_store(Arc::clone(&store)).await.unwrap();

        let mut mux = host.mux_events();
        let baseline = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let frame = mux.next().await.expect("mux remained open");
                if frame.payload["type"] == "session/queue" {
                    break frame.payload;
                }
            }
        })
        .await
        .expect("queue baseline was not replayed");
        assert_eq!(baseline["sessionId"], "queue-baseline");
        assert_eq!(baseline["items"][0]["id"], "steering-1");
        assert_eq!(baseline["items"][0]["placement"], "steering");
        assert_eq!(baseline["items"][1]["id"], "context-1");
        assert_eq!(baseline["items"][1]["placement"], "context");

        inbox.remove("steering-1").await.unwrap().unwrap();
        host.sync_authoritative_session("queue-baseline")
            .await
            .unwrap();
        let after_remove = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let frame = mux.next().await.expect("mux remained open");
                if frame.payload["type"] == "session/queue" {
                    break frame.payload;
                }
            }
        })
        .await
        .expect("queue removal was not projected");
        assert_eq!(after_remove["items"].as_array().unwrap().len(), 1);
        assert_eq!(after_remove["items"][0]["id"], "context-1");

        inbox
            .append(
                InboxTarget::NextTurn,
                InboxMessage {
                    id: "queued-1".to_owned(),
                    message: Message::user("later").with_id("queued-1"),
                    source: Some(json!({
                        "content": [{"type": "text", "text": "later"}],
                        "source": {"kind": "user"},
                    })),
                },
            )
            .await
            .unwrap();
        host.sync_authoritative_session("queue-baseline")
            .await
            .unwrap();
        let after_append = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let frame = mux.next().await.expect("mux remained open");
                if frame.payload["type"] == "session/queue" {
                    break frame.payload;
                }
            }
        })
        .await
        .expect("queue append was not projected");
        assert_eq!(after_append["items"][0]["id"], "queued-1");
        assert_eq!(after_append["items"][0]["placement"], "queued");
        assert_eq!(after_append["items"][1]["id"], "context-1");
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
        let mut mux = live.mux_events();
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
        let seen_metric_frames = Arc::new(Mutex::new(Vec::new()));
        let seen_in_stream = Arc::clone(&seen_metric_frames);
        let live_metrics = tokio::time::timeout(Duration::from_secs(2), async {
            let mut token_usage = None;
            let mut session_stats = None;
            loop {
                let frame = mux.next().await.expect("mux remained open");
                if frame.payload["type"] != "session/projection"
                    || frame.payload["sessionId"] != "projection-session"
                {
                    continue;
                }
                seen_in_stream.lock().unwrap().push(frame.payload.clone());
                match frame.payload["key"].as_str() {
                    Some("tokenUsage") => token_usage = Some(frame.payload["value"].clone()),
                    Some("sessionStats") if frame.payload["value"]["steps"].as_u64() == Some(1) => {
                        session_stats = Some(frame.payload["value"].clone())
                    }
                    _ => {}
                }
                if let (Some(token_usage), Some(session_stats)) = (&token_usage, &session_stats) {
                    break (token_usage.clone(), session_stats.clone());
                }
            }
        })
        .await;
        let (live_token_usage, live_session_stats) = live_metrics.unwrap_or_else(|_| {
            panic!(
                "live metric projection frames were not published: {:?}",
                seen_metric_frames.lock().unwrap()
            )
        });
        assert_eq!(
            live_token_usage,
            json!({
                "uncachedInputTokens": 10,
                "outputTokens": 5,
                "cacheReadTokens": 90,
                "cacheWriteTokens": 2,
            })
        );
        assert_eq!(live_session_stats["turns"], 1);
        assert_eq!(live_session_stats["steps"], 1);
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
        assert_eq!(
            live_history["projections"]["values"]["tokenUsage"],
            json!({
                "uncachedInputTokens": 10,
                "outputTokens": 5,
                "cacheReadTokens": 90,
                "cacheWriteTokens": 2,
            })
        );
        assert_eq!(
            live_history["projections"]["values"]["sessionStats"]["turns"],
            1
        );
        assert_eq!(
            live_history["projections"]["values"]["sessionStats"]["steps"],
            1
        );
        assert_eq!(
            live_history["projections"]["values"]["sessionStats"]["ttftSteps"],
            1
        );
        let assistant = live_history["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["event"]["type"] == "assistant/message")
            .unwrap();
        assert_eq!(
            assistant["event"]["data"]["usage"],
            json!({
                "inputTokens": 10,
                "outputTokens": 5,
                "cacheReadTokens": 90,
                "cacheWriteTokens": 2,
                "reasoningTokens": 3,
            })
        );
        assert!(assistant["event"]["data"]["usage"]
            .get("input_tokens")
            .is_none());
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

    #[tokio::test]
    async fn authoritative_input_is_published_before_provider_ttft() {
        let cwd = std::env::temp_dir();
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let release = Arc::new(Notify::new());
        let provider = Arc::new(GatedProvider {
            calls: AtomicUsize::new(0),
            release: Arc::clone(&release),
            answers: Mutex::new(VecDeque::from(["late answer".to_owned()])),
        });
        let runtime = Arc::new(DurableLoopAgentRuntime::new(
            "test",
            "test-model",
            Some(provider.clone()),
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            Arc::clone(&store),
            Arc::new(MemoryLeaseManager::default()),
            64,
        ));
        let host = BasicHost::with_agent_runtime(config(&cwd), runtime);
        let mut mux = host.mux_events();
        let created = host
            .call(
                RpcId::new("input-before-ttft-create"),
                RpcMethod::SessionCreate,
                json!({"sessionId": "input-before-ttft", "cwd": cwd}),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(created, RpcResult::Success { .. }));
        let admitted = host
            .call(
                RpcId::new("input-before-ttft-prompt"),
                RpcMethod::SessionPrompt,
                json!({
                    "sessionId": "input-before-ttft",
                    "mode": "queue",
                    "content": [{"type": "text", "text": "publish before TTFT"}],
                }),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(admitted, RpcResult::Success { .. }));

        tokio::time::timeout(Duration::from_secs(2), async {
            while provider.calls.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("provider request started and remained blocked before TTFT");

        let (saw_dequeue, saw_user) = tokio::time::timeout(Duration::from_secs(2), async {
            let mut saw_dequeue = false;
            let mut saw_user = false;
            loop {
                let frame = mux.next().await.expect("mux remained open");
                if frame.payload["type"] != "session/event"
                    || frame.payload["sessionId"] != "input-before-ttft"
                {
                    continue;
                }
                match frame.payload["event"]["type"].as_str() {
                    Some("agent/inbox/spliced")
                        if frame.payload["event"]["data"]["removedCount"] == 1
                            && frame.payload["event"]["data"]["inserted"] == json!([]) =>
                    {
                        saw_dequeue = true;
                    }
                    Some("user/message")
                        if frame.payload["event"]["data"]["content"][0]["text"]
                            == "publish before TTFT" =>
                    {
                        saw_user = true;
                    }
                    Some("assistant/chunk") => {
                        panic!("assistant output cannot exist while the provider is TTFT-blocked")
                    }
                    _ => {}
                }
                if saw_dequeue && saw_user {
                    break (saw_dequeue, saw_user);
                }
            }
        })
        .await
        .expect("claimed input was held behind provider TTFT");
        assert!(saw_dequeue && saw_user);

        let before_ttft = store.load("input-before-ttft").await.unwrap().unwrap();
        assert!(before_ttft.events().iter().any(|event| {
            matches!(
                event.data(),
                EventData::UserMessage { message, .. }
                    if message.content == "publish before TTFT"
            )
        }));
        assert!(before_ttft
            .events()
            .iter()
            .all(|event| !matches!(event.data(), EventData::AssistantChunk { .. })));

        release.notify_one();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let session = store.load("input-before-ttft").await.unwrap().unwrap();
                if session
                    .events()
                    .iter()
                    .any(|event| matches!(event.data(), EventData::TurnEnd { .. }))
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("durable turn completed after releasing the provider");
    }

    #[tokio::test]
    async fn authoritative_stream_checkpoint_is_published_before_model_completion() {
        let cwd = std::env::temp_dir();
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let delta_announced = Arc::new(Notify::new());
        let finish_release = Arc::new(Notify::new());
        let provider: Arc<dyn ModelProvider> = Arc::new(LiveDeltaProvider {
            delta_announced: Arc::clone(&delta_announced),
            finish_release: Arc::clone(&finish_release),
        });
        let runtime = Arc::new(DurableLoopAgentRuntime::new(
            "test",
            "test-model",
            Some(provider),
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            Arc::clone(&store),
            Arc::new(MemoryLeaseManager::default()),
            64,
        ));
        let host = BasicHost::with_agent_runtime(config(&cwd), runtime);
        let mut mux = host.mux_events();
        let created = host
            .call(
                RpcId::new("live-stream-create"),
                RpcMethod::SessionCreate,
                json!({"sessionId": "live-stream-session", "cwd": cwd}),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(created, RpcResult::Success { .. }));
        let admitted = host
            .call(
                RpcId::new("live-stream-prompt"),
                RpcMethod::SessionPrompt,
                json!({
                    "sessionId": "live-stream-session",
                    "mode": "queue",
                    "content": [{"type": "text", "text": "stream now"}],
                }),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(admitted, RpcResult::Success { .. }));

        tokio::time::timeout(Duration::from_secs(2), delta_announced.notified())
            .await
            .expect("provider produced its first delta");
        let live = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let frame = mux.next().await.expect("mux remained open");
                if frame.payload["type"] == "session/event"
                    && frame.payload["sessionId"] == "live-stream-session"
                    && frame.payload["event"]["type"] == "assistant/chunk"
                    && frame.payload["event"]["data"]["chunk"]["type"] == "text-delta"
                {
                    break frame.payload;
                }
            }
        })
        .await
        .expect("live delta was held behind the durable completion batch");
        let expected_first_batch = (0..64)
            .map(|index| format!("live-{index}"))
            .collect::<String>();
        assert_eq!(live["event"]["data"]["chunk"]["text"], expected_first_batch);
        let live_seq = live["event"]["seq"].as_u64().unwrap();
        let before_finish = store.load("live-stream-session").await.unwrap().unwrap();
        assert_eq!(
            before_finish
                .events()
                .iter()
                .filter(|event| matches!(event.data(), EventData::AssistantChunk { .. }))
                .count(),
            1
        );
        assert!(before_finish
            .events()
            .iter()
            .all(|event| !matches!(event.data(), EventData::AssistantMessage { .. })));

        finish_release.notify_one();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let session = store.load("live-stream-session").await.unwrap().unwrap();
                if session
                    .events()
                    .iter()
                    .any(|event| matches!(event.data(), EventData::TurnEnd { .. }))
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("durable turn completed");
        let durable = store.load("live-stream-session").await.unwrap().unwrap();
        let durable_seq = durable
            .events()
            .iter()
            .find_map(|event| match event.data() {
                EventData::AssistantChunk {
                    chunk: AssistantChunk::TextDelta(text),
                    ..
                } if text == &expected_first_batch => Some(event.seq),
                _ => None,
            })
            .expect("durable delta exists after the semantic boundary");
        assert_eq!(live_seq, durable_seq);
    }

    #[test]
    fn max_tokens_is_projected_as_the_upstream_first_class_turn_reason() {
        assert_eq!(
            web_turn_end(&TurnEndReason::MaxTokens),
            json!({"kind": "max-tokens"})
        );
    }

    #[test]
    fn bash_call_and_foreground_result_project_expandable_terminal_views() {
        let session = closed_tool_session(
            "bash",
            json!({
                "command": "printf ok",
                "cwd": "subdir",
                "description": "run the smoke test"
            })
            .to_string(),
            ToolResultData {
                call_id: "bash-1".to_owned(),
                outcome: ToolOutcome::Success,
                content: "model-facing result".to_owned(),
                metadata: Some(json!({
                    "kind": "foreground",
                    "stdout": "out",
                    "stderr": "err",
                    "exit_code": 7,
                    "signal": null,
                    "stdout_truncated": true,
                    "stderr_truncated": false
                })),
            },
        );
        let call = session
            .events()
            .iter()
            .find(|event| matches!(event.data(), EventData::ToolCall { .. }))
            .unwrap();
        assert_eq!(
            project_session_event_view(&session, call),
            Some(json!({
                "for": "call",
                "view": {
                    "card": "terminal",
                    "title": "printf ok",
                    "cwd": "subdir",
                    "description": "run the smoke test"
                }
            }))
        );

        let result = session
            .events()
            .iter()
            .find(|event| matches!(event.data(), EventData::ToolResult { .. }))
            .unwrap();
        assert_eq!(
            project_session_event_view(&session, result),
            Some(json!({
                "for": "result",
                "view": {
                    "card": "terminal",
                    "output": "out\nerr\n[stdout truncated]\n",
                    "exitCode": 7
                }
            }))
        );
    }

    #[test]
    fn pwsh_call_and_foreground_result_use_the_same_terminal_view_contract() {
        let session = closed_tool_session(
            "pwsh",
            json!({"command": "Write-Output ok"}).to_string(),
            ToolResultData {
                call_id: "pwsh-1".to_owned(),
                outcome: ToolOutcome::Success,
                content: "model-facing result".to_owned(),
                metadata: Some(json!({
                    "kind": "foreground",
                    "stdout": "ok\n",
                    "stderr": "",
                    "exit_code": 0,
                    "signal": null
                })),
            },
        );
        let call = session
            .events()
            .iter()
            .find(|event| matches!(event.data(), EventData::ToolCall { .. }))
            .unwrap();
        let result = session
            .events()
            .iter()
            .find(|event| matches!(event.data(), EventData::ToolResult { .. }))
            .unwrap();

        assert_eq!(
            project_session_event_view(&session, call),
            Some(json!({
                "for": "call",
                "view": {"card": "terminal", "title": "Write-Output ok"}
            }))
        );
        assert_eq!(
            project_session_event_view(&session, result),
            Some(json!({
                "for": "result",
                "view": {"card": "terminal", "output": "ok\n", "exitCode": 0}
            }))
        );
    }

    #[test]
    fn terminal_view_projection_is_fail_closed_for_non_foreground_or_bad_shapes() {
        for (index, metadata) in [
            json!({"kind": "background", "stdout": "not a terminal result"}),
            json!({"kind": "foreground", "stdout": 42}),
            json!({"stdout": "missing kind"}),
        ]
        .into_iter()
        .enumerate()
        {
            let session = closed_tool_session(
                "bash",
                r#"{"command":"true"}"#.to_owned(),
                ToolResultData {
                    call_id: format!("call-{index}"),
                    outcome: ToolOutcome::Success,
                    content: String::new(),
                    metadata: Some(metadata),
                },
            );
            let result = session
                .events()
                .iter()
                .find(|event| matches!(event.data(), EventData::ToolResult { .. }))
                .unwrap();
            assert_eq!(project_session_event_view(&session, result), None);
        }

        let invalid_session = closed_tool_session(
            "bash",
            "{not-json".to_owned(),
            ToolResultData {
                call_id: "bad-bash".to_owned(),
                outcome: ToolOutcome::Error,
                content: "invalid arguments".to_owned(),
                metadata: None,
            },
        );
        let invalid_call = invalid_session
            .events()
            .iter()
            .find(|event| matches!(event.data(), EventData::ToolCall { .. }))
            .unwrap();
        assert_eq!(
            project_session_event_view(&invalid_session, invalid_call),
            None
        );

        // A custom tool may deliberately return the same metadata shape as
        // A native shell. It must remain generic rather than acquiring terminal chrome.
        let custom_session = closed_tool_session(
            "custom",
            "{}".to_owned(),
            ToolResultData {
                call_id: "custom-foreground".to_owned(),
                outcome: ToolOutcome::Success,
                content: "custom output".to_owned(),
                metadata: Some(json!({
                    "kind": "foreground",
                    "stdout": "not bash",
                    "stderr": "",
                    "exit_code": 0
                })),
            },
        );
        let custom_result = custom_session
            .events()
            .iter()
            .find(|event| matches!(event.data(), EventData::ToolResult { .. }))
            .unwrap();
        assert_eq!(
            project_session_event_view(&custom_session, custom_result),
            None
        );
    }

    #[test]
    fn terminal_result_view_restores_legacy_json_content_without_metadata() {
        let session = closed_tool_session(
            "bash",
            r#"{"command":"printf legacy"}"#.to_owned(),
            ToolResultData {
                call_id: "legacy-bash".to_owned(),
                outcome: ToolOutcome::Success,
                content: json!({
                    "kind": "foreground",
                    "stdout": "legacy output\n",
                    "stderr": "",
                    "exit_code": 0,
                    "signal": null
                })
                .to_string(),
                metadata: None,
            },
        );
        let result = session
            .events()
            .iter()
            .find(|event| matches!(event.data(), EventData::ToolResult { .. }))
            .unwrap();
        assert_eq!(
            project_session_event_view(&session, result),
            Some(json!({
                "for": "result",
                "view": {
                    "card": "terminal",
                    "output": "legacy output\n",
                    "exitCode": 0
                }
            }))
        );
    }

    #[tokio::test]
    async fn legacy_live_mux_and_history_both_carry_terminal_views() {
        let cwd = std::env::temp_dir();
        let host = BasicHost::without_provider(config(&cwd));
        let created = host
            .call(
                RpcId::new("create-terminal-view-session"),
                RpcMethod::SessionCreate,
                json!({"cwd": cwd}),
                CancellationToken::new(),
            )
            .await;
        let RpcResult::Success {
            value: Some(created),
        } = created
        else {
            panic!("session creation failed: {created:?}");
        };
        let session_id = created["sessionId"].as_str().unwrap().to_owned();
        let mut mux = host.mux_events();

        host.append_session_event(
            &session_id,
            "tool/call",
            json!({
                "turn": 0,
                "step": 1,
                "callId": "legacy-live-bash",
                "name": "bash",
                "arguments": r#"{"command":"printf live","description":"live projection"}"#,
            }),
            None,
        )
        .await
        .unwrap();
        let live_call = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let frame = mux.next().await.expect("mux remained open").payload;
                if frame["type"] == "session/event"
                    && frame["event"]["type"] == "tool/call"
                    && frame["event"]["data"]["callId"] == "legacy-live-bash"
                {
                    break frame;
                }
            }
        })
        .await
        .expect("live Bash call frame arrived");
        assert_eq!(live_call["view"]["for"], "call");
        assert_eq!(live_call["view"]["view"]["card"], "terminal");

        let result_text = json!({
            "kind": "foreground",
            "stdout": "live output\n",
            "stderr": "",
            "exit_code": 0,
            "signal": null
        })
        .to_string();
        host.append_session_event(
            &session_id,
            "tool/result",
            json!({
                "turn": 0,
                "step": 1,
                "message": {
                    "id": "legacy-live-result",
                    "role": "user",
                    "content": [{
                        "type": "tool-result",
                        "toolCallId": "legacy-live-bash",
                        "content": [{"type": "text", "text": result_text}],
                        "isError": false
                    }],
                    "source": {"kind": "tool", "callId": "legacy-live-bash"}
                }
            }),
            Some("append"),
        )
        .await
        .unwrap();
        let live_result = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let frame = mux.next().await.expect("mux remained open").payload;
                if frame["type"] == "session/event" && frame["event"]["type"] == "tool/result" {
                    break frame;
                }
            }
        })
        .await
        .expect("live Bash result frame arrived");
        assert_eq!(live_result["view"]["for"], "result");
        assert_eq!(live_result["view"]["view"]["output"], "live output\n");

        let history = host
            .call(
                RpcId::new("terminal-view-history"),
                RpcMethod::SessionHistory,
                json!({"sessionId": session_id, "maxMessages": 50}),
                CancellationToken::new(),
            )
            .await;
        let RpcResult::Success {
            value: Some(history),
        } = history
        else {
            panic!("history failed: {history:?}");
        };
        let items = history["events"].as_array().unwrap();
        assert!(items.iter().any(|item| {
            item["event"]["type"] == "tool/call" && item["view"]["view"]["card"] == "terminal"
        }));
        assert!(items.iter().any(|item| {
            item["event"]["type"] == "tool/result"
                && item["view"]["view"]["output"] == "live output\n"
        }));
    }
}

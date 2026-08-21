use std::{collections::VecDeque, path::Path, sync::Arc};

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
    state::{DriverCommand, ModelSelection, QueuedPrompt, SessionRecord, WorkspaceRecord},
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
    pub waiting_next_step_inputs: usize,
    pub issues: Vec<HostRestoreIssue>,
}

#[derive(Debug, thiserror::Error)]
pub enum HostRestoreError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("session {session_id:?} disappeared during Host restoration")]
    SessionDisappeared { session_id: String },
    #[error("session {session_id:?} has an invalid durable inbox: {message}")]
    InvalidInbox { session_id: String, message: String },
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
            let projected_queue_len = queue.len();
            let events = session
                .events()
                .iter()
                .map(|event| restored_web_event(event, &route))
                .collect::<Vec<_>>();
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
            let permission = PermissionPreset::default();
            let record = SessionRecord {
                session_id: session_id.clone(),
                created_at: header.created_at_ms,
                updated_at,
                running: false,
                blank,
                parent_session_id: None,
                origin: Some("restored".to_owned()),
                cwd: cwd.clone(),
                agent_preset: Some("coding".to_owned()),
                title: None,
                model: ModelSelection {
                    provider: route.provider.clone(),
                    model: route.model.clone(),
                    reasoning_effort: route.reasoning_effort.clone(),
                },
                permission_preset: permission,
                events,
                messages,
                queue,
                control: None,
                next_turn,
            };

            {
                let mut state = self.state.write().await;
                attach_workspace(&mut state, &session_id, &cwd, header.created_at_ms);
                state.sessions.insert(session_id.clone(), record);
            }
            report.restored_sessions += 1;
            report.waiting_next_step_inputs += inbox.next_step().len();
            if projected_queue_len > 0 {
                resumable.push((session_id, cwd, route, permission, projected_queue_len));
            }
        }

        // The runtime subscribes and prepares every recovered input before it
        // wakes the durable Agent. Only after that succeeds do we publish the
        // Host-owned driver/control projection.
        for (session_id, cwd, route, permission, projected_count) in resumable {
            match self
                .agent_runtime
                .resume_session(AgentSessionRequest {
                    session_id: session_id.clone(),
                    cwd,
                    route,
                    permission,
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
                    tokio::spawn(async move { host.drive_session(session_id, control_rx).await });
                }
                Err(error) => report.issues.push(HostRestoreIssue {
                    session_id,
                    message: error.to_string(),
                }),
            }
        }

        Ok(report)
    }
}

fn restored_route(session: &Session, config: &crate::HostConfig) -> ModelRoute {
    session
        .events()
        .iter()
        .rev()
        .find_map(|event| match event.data() {
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

fn restored_prompt(input: &xharness_session::InboxMessage) -> QueuedPrompt {
    let (content, source) = input
        .source
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|metadata| {
            Some((
                metadata.get("content")?.as_array()?.clone(),
                metadata.get("source").cloned()?,
            ))
        })
        .unwrap_or_else(|| {
            (
                vec![json!({"type": "text", "text": input.message.content})],
                json!({"kind": "user", "restored": true}),
            )
        });
    QueuedPrompt {
        id: input.id.clone(),
        text: input.message.content.clone(),
        content,
        source,
    }
}

fn restored_web_event(event: &LoggedEvent, route: &ModelRoute) -> Value {
    let (event_type, data, surface_op) = match event.data() {
        EventData::AgentInboxSpliced { .. } | EventData::RequestHeader { .. } => {
            tagged_event_data(event.data())
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
            web_message(message, route, event.seq),
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
                "message": web_message(message, route, event.seq),
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

fn web_message(message: &Message, route: &ModelRoute, seq: u64) -> Value {
    let id = message
        .id
        .clone()
        .unwrap_or_else(|| format!("restored-{}-{seq}", message.role.as_str()));
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
    use futures::stream;
    use tokio::sync::Notify;
    use tokio_util::sync::CancellationToken;
    use xharness_agent::{DurableInbox, InboxMessage, InboxTarget, MemoryLeaseManager};
    use xharness_core::{
        FinishReason, IdentityContextPolicy, ModelProvider, ProviderError, ProviderEvent,
        ProviderRequest, ProviderStream,
    };
    use xharness_session::{
        EventData, MemorySessionStore, Message, RequestHeader, Revision, SessionEvent,
        SessionHeader, Store, TurnEndReason,
    };

    use super::*;
    use crate::{DurableLoopAgentRuntime, HostConfig, NoTools};

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

    fn config(cwd: &Path) -> HostConfig {
        let mut config = HostConfig::new(cwd);
        config.provider_id = "test".to_owned();
        config.provider_display_name = "Test".to_owned();
        config.model_id = "test-model".to_owned();
        config
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
}

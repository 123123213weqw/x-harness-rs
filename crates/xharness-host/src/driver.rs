use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use xharness_agent::InboxProjection;
use xharness_api::{RpcError, RpcErrorCode, RpcId};
use xharness_core::{AgentMessage, LoopCommand, LoopEvent, LoopEventKind, LoopStatus, Role};
use xharness_session::SessionEvent;

use crate::{
    restore::{
        project_session_event_range, project_session_event_tail, restored_agent_preset,
        restored_goal, restored_permission, restored_plan_mode, restored_queue,
        restored_session_mutation_receipts, restored_title,
    },
    runtime::{AgentRuntimeError, AgentTurnRequest, ModelRoute, RunningTurn},
    state::{now_ms, DriverCommand, PendingResponse, QueuePlacement, QueuedPrompt},
    BasicHost,
};

pub(crate) struct PromptAdmission {
    pub rpc_id: RpcId,
    pub session_id: String,
    pub mode: String,
    pub text: String,
    pub content: Vec<Value>,
    pub source: Value,
    pub fingerprint: Option<String>,
}

impl BasicHost {
    /// Commit log-only product facts through the runtime-owned Session when
    /// available, otherwise retain the legacy in-memory projection. The
    /// authoritative path flushes before it refreshes/broadcasts History.
    pub(crate) async fn commit_session_events(
        &self,
        session_id: &str,
        events: Vec<SessionEvent>,
    ) -> Result<(), RpcError> {
        if events.is_empty() {
            return Ok(());
        }
        let cwd = self
            .state
            .read()
            .await
            .sessions
            .get(session_id)
            .map(|session| session.cwd.clone())
            .ok_or_else(|| {
                rpc_error(
                    RpcErrorCode::SessionNotFound,
                    format!("session {session_id:?} was not found"),
                    json!({"sessionId": session_id}),
                )
            })?;
        let authoritative = self
            .agent_runtime
            .persist_session_events(session_id, &cwd, events.clone())
            .await
            .map_err(agent_runtime_error)?;
        if authoritative {
            self.sync_authoritative_session(session_id).await?;
            return Ok(());
        }
        for event in events {
            let mut tagged = serde_json::to_value(event).map_err(|error| {
                RpcError::internal(format!("session event encoding failed: {error}"))
            })?;
            let object = tagged
                .as_object_mut()
                .ok_or_else(|| RpcError::internal("session event must encode as an object"))?;
            let event_type = object
                .remove("type")
                .and_then(|value| value.as_str().map(str::to_owned))
                .ok_or_else(|| RpcError::internal("session event encoding omitted its type"))?;
            let data = object.remove("data").unwrap_or(Value::Null);
            self.append_session_event(session_id, &event_type, data, None)
                .await?;
        }
        Ok(())
    }

    /// Refresh the browser history cache from the runtime-owned append-only
    /// Session. The returned boolean distinguishes a durable runtime from the
    /// legacy ephemeral adapter, even before a Session file exists.
    pub(crate) async fn sync_authoritative_session(
        &self,
        session_id: &str,
    ) -> Result<bool, RpcError> {
        if !self.agent_runtime.has_authoritative_sessions() {
            return Ok(false);
        }
        let Some(session) = self
            .agent_runtime
            .authoritative_session(session_id)
            .await
            .map_err(agent_runtime_error)?
        else {
            return Ok(true);
        };
        let route = {
            let state = self.state.read().await;
            let record = state.sessions.get(session_id).ok_or_else(|| {
                rpc_error(
                    RpcErrorCode::SessionNotFound,
                    format!("session {session_id:?} was not found"),
                    json!({"sessionId": session_id}),
                )
            })?;
            ModelRoute {
                provider: record.model.provider.clone(),
                model: record.model.model.clone(),
                reasoning_effort: record.model.reasoning_effort.clone(),
            }
        };
        let permission = restored_permission(&session);
        let agent_preset = restored_agent_preset(&session);
        let title = restored_title(&session);
        let plan_active = restored_plan_mode(&session);
        let goal = restored_goal(&session);
        let mutation_receipts = restored_session_mutation_receipts(&session);
        let inbox = InboxProjection::from_session(&session).map_err(|error| {
            RpcError::internal(format!(
                "authoritative session {session_id:?} has an invalid inbox: {error}"
            ))
        })?;
        let projected_queue = restored_queue(&inbox);
        let tail = project_session_event_tail(
            &session,
            &route,
            self.config.session_event_cache_capacity,
            self.config.session_event_cache_bytes,
        );
        let (new_events, queue_changed) = {
            let mut state = self.state.write().await;
            let (new_events, queue_changed) = {
                let record = state
                    .sessions
                    .get_mut(session_id)
                    .expect("session checked before projection");
                let previous = record.authoritative_seq.unwrap_or_default();
                let start = usize::try_from(previous)
                    .map_err(|_| RpcError::internal("authoritative session cursor overflow"))?;
                if start > session.events().len() {
                    return Err(RpcError::internal(format!(
                        "authoritative session {session_id:?} moved behind cursor {previous}"
                    )));
                }
                let new_events =
                    project_session_event_range(&session, &route, start, session.events().len());
                record.replace_authoritative_tail(
                    tail.base_seq,
                    tail.next_seq,
                    tail.events,
                    tail.bytes,
                );
                record.messages = session.derive_messages();
                record.permission_preset = permission;
                record.agent_preset = agent_preset;
                record.title = title;
                record.plan_active = plan_active;
                record.goal = goal.clone();
                record.mutation_receipts = mutation_receipts;
                let queue_changed = record.projected_queue != projected_queue;
                record.projected_queue = projected_queue;
                record.updated_at = session
                    .events()
                    .last()
                    .map_or(record.created_at, |event| event.timestamp_ms);
                if session.events().iter().any(|event| {
                    matches!(event.data(), xharness_session::EventData::TurnStart { .. })
                }) {
                    record.blank = false;
                }
                (new_events, queue_changed)
            };
            if let Some(goal) = goal {
                state.goals.insert(session_id.to_owned(), goal);
            } else {
                state.goals.remove(session_id);
            }
            (new_events, queue_changed)
        };
        for event in new_events {
            self.push_mux(json!({
                "type": "session/event",
                "sessionId": session_id,
                "event": event,
            }));
        }
        if queue_changed {
            self.emit_queue(session_id).await;
        }
        Ok(true)
    }

    pub(crate) async fn append_session_event(
        &self,
        session_id: &str,
        event_type: &str,
        data: Value,
        surface_op: Option<&str>,
    ) -> Result<Value, RpcError> {
        let event = {
            let mut state = self.state.write().await;
            let session = state.sessions.get_mut(session_id).ok_or_else(|| {
                rpc_error(
                    RpcErrorCode::SessionNotFound,
                    format!("session {session_id:?} was not found"),
                    json!({"sessionId": session_id}),
                )
            })?;
            let seq = session.next_event_seq();
            let mut event = json!({
                "type": event_type,
                "seq": seq,
                "time": now_ms(),
                "data": data,
            });
            if let Some(surface_op) = surface_op {
                event
                    .as_object_mut()
                    .expect("event is an object")
                    .insert("surfaceOp".to_owned(), json!(surface_op));
            }
            if event_type == "turn/start" {
                session.blank = false;
            }
            if event_type == "user/message" {
                session.updated_at = now_ms();
            }
            session.event_cache_bytes = session
                .event_cache_bytes
                .saturating_add(serde_json::to_vec(&event).map_or(0, |encoded| encoded.len()));
            session.events.push(event.clone());
            event
        };
        self.push_mux(json!({
            "type": "session/event",
            "sessionId": session_id,
            "event": event,
        }));
        Ok(event)
    }

    pub(crate) async fn push_projection(&self, session_id: &str, key: &str, value: Value) {
        let seq = self
            .state
            .read()
            .await
            .sessions
            .get(session_id)
            .map_or(-1, |session| session.last_event_seq_i64());
        if seq >= 0 {
            self.push_mux(json!({
                "type": "session/projection",
                "sessionId": session_id,
                "key": key,
                "value": value,
                "seq": seq,
            }));
        }
    }

    pub(crate) async fn emit_queue(&self, session_id: &str) {
        let items = self
            .state
            .read()
            .await
            .sessions
            .get(session_id)
            .map_or_else(Vec::new, |session| session.queue_view());
        self.push_mux(json!({
            "type": "session/queue",
            "sessionId": session_id,
            "items": items,
        }));
    }

    pub(crate) async fn enqueue_prompt(&self, admission: PromptAdmission) -> Result<(), RpcError> {
        let PromptAdmission {
            rpc_id,
            session_id,
            mode,
            text,
            content,
            source,
            fingerprint,
        } = admission;
        let session_id = session_id.as_str();
        let mode = mode.as_str();
        let (steer_control, admission_request) = {
            let state = self.state.read().await;
            let session = state.sessions.get(session_id).ok_or_else(|| {
                rpc_error(
                    RpcErrorCode::SessionNotFound,
                    format!("session {session_id:?} was not found"),
                    json!({"sessionId": session_id}),
                )
            })?;
            let route = ModelRoute {
                provider: session.model.provider.clone(),
                model: session.model.model.clone(),
                reasoning_effort: session.model.reasoning_effort.clone(),
            };
            if !self.agent_runtime.can_route(&route) {
                return Err(rpc_error(
                    RpcErrorCode::ModelUnavailable,
                    format!(
                        "model route {}/{} is unavailable",
                        route.provider, route.model
                    ),
                    json!({"provider": route.provider, "model": route.model}),
                ));
            }
            let prompt = state
                .prompt_assembly(session_id)
                .map_err(RpcError::internal)?;
            if mode == "steer" && session.running {
                (session.control.clone(), None)
            } else {
                let mut messages = session.messages.clone();
                messages.push(
                    AgentMessage::new(Role::User, text.clone()).with_id(rpc_id.as_str().to_owned()),
                );
                (
                    None,
                    Some(AgentTurnRequest {
                        session_id: session_id.to_owned(),
                        cwd: session.cwd.clone(),
                        route,
                        permission: session.permission_preset,
                        prompt: Some(prompt),
                        messages,
                        input_metadata: Some(json!({
                            "content": content.clone(),
                            "source": source.clone(),
                            "rpcFingerprint": fingerprint.clone(),
                            "rpcSessionId": session_id,
                        })),
                    }),
                )
            }
        };

        if let Some(control) = steer_control {
            let message =
                AgentMessage::new(Role::User, text.clone()).with_id(rpc_id.as_str().to_owned());
            let (acknowledgement, accepted) = oneshot::channel();
            control
                .send(DriverCommand {
                    command: LoopCommand::Steer(message),
                    input_metadata: Some(json!({
                        "content": content.clone(),
                        "source": source.clone(),
                        "rpcFingerprint": fingerprint.clone(),
                        "rpcSessionId": session_id,
                    })),
                    acknowledgement,
                })
                .await
                .map_err(|_| {
                    rpc_error(
                        RpcErrorCode::SteerUnavailable,
                        "the active turn stopped before steering was admitted",
                        json!({"sessionId": session_id}),
                    )
                })?;
            accepted
                .await
                .map_err(|_| {
                    rpc_error(
                        RpcErrorCode::SteerUnavailable,
                        "the active turn closed before steering was applied",
                        json!({"sessionId": session_id}),
                    )
                })?
                .map_err(|error| {
                    rpc_error(
                        RpcErrorCode::SteerUnavailable,
                        error.to_string(),
                        json!({"sessionId": session_id}),
                    )
                })?;
            {
                let mut state = self.state.write().await;
                if let Some(session) = state.sessions.get_mut(session_id) {
                    session.admissions.insert(
                        rpc_id.as_str().to_owned(),
                        QueuedPrompt {
                            id: rpc_id.as_str().to_owned(),
                            text: text.clone(),
                            content: content.clone(),
                            source: source.clone(),
                            fingerprint,
                            placement: QueuePlacement::Steering,
                        },
                    );
                }
            }
            if !self.sync_authoritative_session(session_id).await? {
                self.append_session_event(
                    session_id,
                    "user/message",
                    web_user_message(&self.mint_id("message"), content, source),
                    Some("append"),
                )
                .await?;
            }
            return Ok(());
        }

        if let Some(admission_request) = admission_request {
            // A durable runtime flushes this input before returning. Only
            // after that receipt may the Web API acknowledge session.prompt.
            // Ephemeral runtimes implement this as a no-op and retain the
            // legacy Host-owned queue behavior.
            self.agent_runtime
                .admit_turn(admission_request)
                .await
                .map_err(agent_runtime_error)?;
        }

        let mut start_driver = None;
        {
            let mut state = self.state.write().await;
            let session = state.sessions.get_mut(session_id).ok_or_else(|| {
                rpc_error(
                    RpcErrorCode::SessionNotFound,
                    format!("session {session_id:?} was not found"),
                    json!({"sessionId": session_id}),
                )
            })?;
            session.queue.push_back(QueuedPrompt {
                id: rpc_id.as_str().to_owned(),
                text: text.clone(),
                content: content.clone(),
                source: source.clone(),
                fingerprint: fingerprint.clone(),
                placement: QueuePlacement::Queued,
            });
            session.admissions.insert(
                rpc_id.as_str().to_owned(),
                QueuedPrompt {
                    id: rpc_id.as_str().to_owned(),
                    text,
                    content,
                    source,
                    fingerprint,
                    placement: QueuePlacement::Queued,
                },
            );
            if !session.running {
                let (control_tx, control_rx) = mpsc::channel(64);
                session.running = true;
                session.control = Some(control_tx);
                start_driver = Some(control_rx);
            }
        }
        if !self.sync_authoritative_session(session_id).await? {
            self.emit_queue(session_id).await;
        }
        if let Some(control_rx) = start_driver {
            self.push_host(json!({
                "type": "host/session-status",
                "sessionId": session_id,
                "running": true,
            }));
            let host = self.clone();
            let session_id = session_id.to_owned();
            tokio::spawn(async move { host.drive_session(session_id, control_rx).await });
        }
        Ok(())
    }

    pub(crate) async fn drive_session(
        self,
        session_id: String,
        mut control_rx: mpsc::Receiver<DriverCommand>,
    ) {
        loop {
            let next = {
                let mut state = self.state.write().await;
                state
                    .sessions
                    .get_mut(&session_id)
                    .and_then(|session| session.queue.pop_front())
            };
            let Some(prompt) = next else {
                let mut state = self.state.write().await;
                if let Some(session) = state.sessions.get_mut(&session_id) {
                    session.running = false;
                    session.control = None;
                }
                drop(state);
                self.emit_queue(&session_id).await;
                self.push_host(json!({
                    "type": "host/session-status",
                    "sessionId": session_id,
                    "running": false,
                }));
                return;
            };
            self.emit_queue(&session_id).await;
            if let Err(error) = self.run_turn(&session_id, prompt, &mut control_rx).await {
                self.push_host(json!({
                    "type": "host/agent-error",
                    "sessionId": session_id,
                    "message": error.message,
                }));
            }
        }
    }

    /// Project a turn that was already open at process death and reattached
    /// by the durable runtime. It deliberately bypasses the prompt queue: the
    /// original user input, assistant tool call and approval ask are already
    /// authoritative Session facts. Once recovery settles, normal queued
    /// turns continue through the same control channel.
    pub(crate) async fn drive_recovered_turn(
        self,
        session_id: String,
        mut run: Box<dyn RunningTurn>,
        mut control_rx: mpsc::Receiver<DriverCommand>,
    ) {
        let outcome = async {
            loop {
                tokio::select! {
                    event = run.next_event() => match event {
                        Some(event) => {
                            self.sync_authoritative_session(&session_id).await?;
                            self.project_authoritative_control_event(&session_id, event).await?;
                        }
                        None => break,
                    },
                    command = control_rx.recv() => {
                        if let Some(command) = command {
                            let result = run
                                .send_with_metadata(command.command, command.input_metadata)
                                .await;
                            let _ = command.acknowledgement.send(result);
                        }
                    }
                }
            }
            let _ = run.result().await;
            self.sync_authoritative_session(&session_id).await?;
            self.state
                .write()
                .await
                .pending
                .retain(|_, pending| match pending {
                    PendingResponse::Approval { session_id: id, .. } => id != &session_id,
                });
            Ok::<(), RpcError>(())
        }
        .await;
        if let Err(error) = outcome {
            self.push_host(json!({
                "type": "host/agent-error",
                "sessionId": session_id,
                "message": error.message,
            }));
        }
        self.drive_session(session_id, control_rx).await;
    }

    async fn run_turn(
        &self,
        session_id: &str,
        prompt: QueuedPrompt,
        control_rx: &mut mpsc::Receiver<DriverCommand>,
    ) -> Result<(), RpcError> {
        let (turn, cwd, route, permission, messages) = {
            let mut state = self.state.write().await;
            let session = state.sessions.get_mut(session_id).ok_or_else(|| {
                rpc_error(
                    RpcErrorCode::SessionNotFound,
                    "session disappeared while starting its turn",
                    json!({"sessionId": session_id}),
                )
            })?;
            let turn = session.next_turn;
            session.next_turn = session.next_turn.saturating_add(1);
            session.messages.push(
                AgentMessage::new(Role::User, prompt.text.clone()).with_id(prompt.id.clone()),
            );
            (
                turn,
                session.cwd.clone(),
                ModelRoute {
                    provider: session.model.provider.clone(),
                    model: session.model.model.clone(),
                    reasoning_effort: session.model.reasoning_effort.clone(),
                },
                session.permission_preset,
                session.messages.clone(),
            )
        };

        let authoritative = self.sync_authoritative_session(session_id).await?;
        if !authoritative {
            self.append_session_event(
                session_id,
                "turn/start",
                json!({
                    "turn": turn,
                    "trigger": {"kind": "message", "source": {"kind": "user"}},
                }),
                None,
            )
            .await?;
            self.append_session_event(
                session_id,
                "user/message",
                web_user_message(&prompt.id, prompt.content, prompt.source),
                Some("append"),
            )
            .await?;
        }

        let mut run = self
            .agent_runtime
            .start_turn(AgentTurnRequest {
                session_id: session_id.to_owned(),
                cwd,
                route,
                permission,
                prompt: self
                    .state
                    .read()
                    .await
                    .prompt_assembly(session_id)
                    .map(Some)
                    .map_err(RpcError::internal)?,
                messages,
                input_metadata: None,
            })
            .await
            .map_err(agent_runtime_error)?;
        let mut current_step = None;

        loop {
            tokio::select! {
                event = run.next_event() => match event {
                    Some(event) => {
                        if authoritative {
                            match event.kind {
                                // These fragments are still inside the Core's
                                // bounded journal batch. The following
                                // StreamCheckpoint (or any terminal/control
                                // boundary) refreshes them with authoritative
                                // sequence coordinates in one store read.
                                LoopEventKind::TextDelta(_)
                                | LoopEventKind::ReasoningDelta(_)
                                | LoopEventKind::ToolCallDelta { .. } => {}
                                _ => {
                                    self.sync_authoritative_session(session_id).await?;
                                    self.project_authoritative_control_event(session_id, event).await?;
                                }
                            }
                        } else {
                            self.project_loop_event(session_id, turn, &mut current_step, event)
                                .await?;
                        }
                    }
                    None => break,
                },
                command = control_rx.recv() => {
                    if let Some(command) = command {
                        let result = run
                            .send_with_metadata(command.command, command.input_metadata)
                            .await;
                        let _ = command.acknowledgement.send(result);
                    }
                }
            }
        }

        let result = run.result().await;
        if authoritative {
            self.sync_authoritative_session(session_id).await?;
            self.state
                .write()
                .await
                .pending
                .retain(|_, pending| match pending {
                    PendingResponse::Approval { session_id: id, .. } => id != session_id,
                });
            return Ok(());
        }
        if !result.final_text.is_empty() {
            let model = self
                .state
                .read()
                .await
                .sessions
                .get(session_id)
                .map(|session| session.model.clone())
                .expect("session exists while driver owns it");
            let step = current_step.unwrap_or_else(|| {
                result
                    .step_usage
                    .last()
                    .map_or(0, |usage| usage.step.try_into().unwrap_or(u32::MAX))
            });
            let mut data = json!({
                "turn": turn,
                "step": step,
                "message": web_assistant_message(
                    &self.mint_id("message"),
                    &result.final_text,
                    &model.provider,
                    &model.model,
                ),
            });
            if let Some(usage) = &result.usage {
                data.as_object_mut()
                    .expect("assistant data is object")
                    .insert(
                        "usage".to_owned(),
                        json!({
                            "inputTokens": usage.input_tokens,
                            "outputTokens": usage.output_tokens,
                            "cacheReadTokens": usage.cache_read_tokens,
                            "cacheWriteTokens": usage.cache_write_tokens,
                            "reasoningTokens": usage.reasoning_tokens,
                        }),
                    );
            }
            self.append_session_event(session_id, "assistant/message", data, Some("append"))
                .await?;
        }
        if let Some(step) = current_step {
            self.append_session_event(
                session_id,
                "step/end",
                json!({"turn": turn, "step": step}),
                None,
            )
            .await?;
        }
        {
            let mut state = self.state.write().await;
            if let Some(session) = state.sessions.get_mut(session_id) {
                // System Prompt is a per-request assembly captured by the
                // Request Header, not transcript history or the next turn's
                // mutable message cache.
                session.messages = result
                    .messages
                    .iter()
                    .filter(|message| message.role != Role::System)
                    .cloned()
                    .collect();
            }
            state.pending.retain(|_, pending| match pending {
                PendingResponse::Approval { session_id: id, .. } => id != session_id,
            });
        }
        let reason = match result.status {
            LoopStatus::Completed => json!({"kind": "completed"}),
            LoopStatus::Cancelled => json!({"kind": "cancelled"}),
            LoopStatus::LimitReached => json!({"kind": "max-steps"}),
            LoopStatus::Failed => json!({
                "kind": "error",
                "error": {"message": result.error.unwrap_or_else(|| "loop failed".to_owned()), "code": "LOOP_FAILED"},
            }),
        };
        self.append_session_event(
            session_id,
            "turn/end",
            json!({"turn": turn, "reason": reason}),
            None,
        )
        .await?;
        Ok(())
    }

    async fn project_authoritative_control_event(
        &self,
        session_id: &str,
        event: LoopEvent,
    ) -> Result<(), RpcError> {
        match event.kind {
            LoopEventKind::ToolApprovalRequested { approval_id, call } => {
                let rpc_id = RpcId::new(self.mint_id("approval"));
                let control = self
                    .state
                    .read()
                    .await
                    .sessions
                    .get(session_id)
                    .and_then(|session| session.control.clone())
                    .ok_or_else(|| RpcError::internal("session control channel is unavailable"))?;
                self.state.write().await.pending.insert(
                    rpc_id.as_str().to_owned(),
                    PendingResponse::Approval {
                        session_id: session_id.to_owned(),
                        approval_id: approval_id.clone(),
                        call_id: call.id.clone(),
                        tool_name: call.name.clone(),
                        control,
                    },
                );
                self.push_mux_correlated(
                    rpc_id,
                    json!({
                        "type": "approval/requested",
                        "sessionId": session_id,
                        "approvalId": approval_id,
                        "toolName": call.name,
                        "callId": call.id,
                        "reason": "This tool requires explicit approval.",
                    }),
                );
            }
            LoopEventKind::ToolApprovalResolved {
                approval_id,
                call,
                approved,
                reason: _,
            } => {
                self.push_mux(json!({
                    "type": "approval/resolved",
                    "sessionId": session_id,
                    "approvalId": approval_id,
                    "callId": call.id,
                    "outcome": if approved { "allowed-once" } else { "rejected" },
                }));
            }
            LoopEventKind::RunFailed { error } => {
                self.push_host(json!({
                    "type": "host/agent-error",
                    "sessionId": session_id,
                    "message": error,
                }));
            }
            LoopEventKind::EventsLagged { missed, resume_seq } => {
                self.push_host(json!({
                    "type": "host/agent-error",
                    "sessionId": session_id,
                    "message": format!(
                        "live loop projection lagged by {missed} events; durable history was resynchronized from cursor {resume_seq}"
                    ),
                }));
            }
            _ => {}
        }
        Ok(())
    }

    async fn ensure_step(
        &self,
        session_id: &str,
        turn: u32,
        current_step: &mut Option<u32>,
        step: usize,
    ) -> Result<(), RpcError> {
        let step = u32::try_from(step).unwrap_or(u32::MAX);
        if *current_step != Some(step) {
            if let Some(previous) = *current_step {
                self.append_session_event(
                    session_id,
                    "step/end",
                    json!({"turn": turn, "step": previous}),
                    None,
                )
                .await?;
            }
            self.append_session_event(
                session_id,
                "step/start",
                json!({"turn": turn, "step": step}),
                None,
            )
            .await?;
            self.append_session_event(
                session_id,
                "assistant/chunk",
                json!({
                    "turn": turn,
                    "step": step,
                    "chunk": {"type": "block-start", "index": 0, "blockType": "text"},
                }),
                None,
            )
            .await?;
            *current_step = Some(step);
        }
        Ok(())
    }

    async fn project_loop_event(
        &self,
        session_id: &str,
        turn: u32,
        current_step: &mut Option<u32>,
        event: LoopEvent,
    ) -> Result<(), RpcError> {
        self.ensure_step(session_id, turn, current_step, event.step)
            .await?;
        let step = u32::try_from(event.step).unwrap_or(u32::MAX);
        match event.kind {
            LoopEventKind::TextDelta(text) => {
                self.append_session_event(
                    session_id,
                    "assistant/chunk",
                    json!({
                        "turn": turn,
                        "step": step,
                        "chunk": {"type": "text-delta", "index": 0, "text": text},
                    }),
                    None,
                )
                .await?;
            }
            LoopEventKind::ReasoningDelta(text) => {
                self.append_session_event(
                    session_id,
                    "assistant/chunk",
                    json!({
                        "turn": turn,
                        "step": step,
                        "chunk": {"type": "reasoning-delta", "index": 0, "text": text},
                    }),
                    None,
                )
                .await?;
            }
            LoopEventKind::ToolCallDelta {
                index,
                id,
                name,
                arguments_delta,
            } => {
                self.append_session_event(
                    session_id,
                    "assistant/chunk",
                    json!({
                        "turn": turn,
                        "step": step,
                        "chunk": {
                            "type": "tool-call-delta",
                            "index": index,
                            "id": id,
                            "name": name,
                            "argumentsDelta": arguments_delta,
                        },
                    }),
                    None,
                )
                .await?;
            }
            LoopEventKind::ToolStarted(call) => {
                self.append_session_event(
                    session_id,
                    "tool/call",
                    json!({
                        "turn": turn,
                        "step": step,
                        "callId": call.id,
                        "name": call.name,
                        "arguments": call.arguments_json,
                    }),
                    None,
                )
                .await?;
            }
            LoopEventKind::ToolCompleted { call, result } => {
                self.append_session_event(
                    session_id,
                    "tool/result",
                    json!({
                        "turn": turn,
                        "step": step,
                        "message": {
                            "id": self.mint_id("message"),
                            "role": "user",
                            "content": [{
                                "type": "tool-result",
                                "toolCallId": call.id,
                                "content": [{"type": "text", "text": if result.ok { result.content } else { result.error }}],
                                "isError": !result.ok,
                            }],
                            "source": {"kind": "tool", "callId": call.id},
                        },
                    }),
                    Some("append"),
                )
                .await?;
            }
            LoopEventKind::ToolApprovalRequested { approval_id, call } => {
                self.append_session_event(
                    session_id,
                    "approval/asked",
                    json!({
                        "id": approval_id,
                        "toolName": call.name,
                        "callId": call.id,
                        "reason": "This tool requires explicit approval.",
                    }),
                    None,
                )
                .await?;
                let rpc_id = RpcId::new(self.mint_id("approval"));
                let control = self
                    .state
                    .read()
                    .await
                    .sessions
                    .get(session_id)
                    .and_then(|session| session.control.clone())
                    .ok_or_else(|| RpcError::internal("session control channel is unavailable"))?;
                self.state.write().await.pending.insert(
                    rpc_id.as_str().to_owned(),
                    PendingResponse::Approval {
                        session_id: session_id.to_owned(),
                        approval_id: approval_id.clone(),
                        call_id: call.id.clone(),
                        tool_name: call.name.clone(),
                        control,
                    },
                );
                self.push_mux_correlated(
                    rpc_id,
                    json!({
                        "type": "approval/requested",
                        "sessionId": session_id,
                        "approvalId": approval_id,
                        "toolName": call.name,
                        "callId": call.id,
                        "reason": "This tool requires explicit approval.",
                    }),
                );
            }
            LoopEventKind::ToolApprovalResolved {
                approval_id,
                call,
                approved,
                reason: _,
            } => {
                self.append_session_event(
                    session_id,
                    "approval/decided",
                    json!({
                        "id": approval_id,
                        "outcome": if approved { "allowed-once" } else { "rejected" },
                    }),
                    None,
                )
                .await?;
                self.push_mux(json!({
                    "type": "approval/resolved",
                    "sessionId": session_id,
                    "approvalId": approval_id,
                    "callId": call.id,
                    "outcome": if approved { "allowed-once" } else { "rejected" },
                }));
            }
            LoopEventKind::ModelRetry {
                retry_id,
                attempt,
                max_retries,
                error,
            } => {
                self.append_session_event(
                    session_id,
                    "llm/retry",
                    json!({
                        "retryId": retry_id,
                        "turn": turn,
                        "step": step,
                        "provider": self.config.provider_id,
                        "mode": "normal",
                        "policyKey": format!("xharness:normal:{max_retries}"),
                        "retry": attempt,
                        "maxRetries": max_retries,
                        "delayMs": 0,
                        "failure": {"code": "TRANSPORT", "message": error},
                    }),
                    None,
                )
                .await?;
                self.append_session_event(
                    session_id,
                    "llm/retry-started",
                    json!({
                        "retryId": retry_id,
                        "turn": turn,
                        "step": step,
                        "retry": attempt,
                    }),
                    None,
                )
                .await?;
            }
            LoopEventKind::RunFailed { error } => {
                self.push_host(json!({
                    "type": "host/agent-error",
                    "sessionId": session_id,
                    "message": error,
                }));
            }
            LoopEventKind::EventsLagged { missed, resume_seq } => {
                return Err(RpcError::internal(format!(
                    "ephemeral loop projection lagged by {missed} events; resume cursor is {resume_seq}"
                )));
            }
            LoopEventKind::MessageInjected { .. }
            | LoopEventKind::StreamCheckpoint
            | LoopEventKind::RunPaused
            | LoopEventKind::RunResumed
            | LoopEventKind::ModelInterrupted
            | LoopEventKind::RunCompleted { .. }
            | LoopEventKind::RunCancelled
            | LoopEventKind::LimitReached => {}
        }
        Ok(())
    }
}

pub(crate) fn rpc_error(
    code: RpcErrorCode,
    message: impl Into<String>,
    details: Value,
) -> RpcError {
    RpcError {
        code,
        message: message.into(),
        details,
    }
}

pub(crate) fn agent_runtime_error(error: AgentRuntimeError) -> RpcError {
    match error {
        AgentRuntimeError::ModelUnavailable { provider, model } => rpc_error(
            RpcErrorCode::ModelUnavailable,
            format!("model route {provider}/{model} is unavailable"),
            json!({"provider": provider, "model": model}),
        ),
        AgentRuntimeError::Preparation { message } => {
            RpcError::internal(format!("could not prepare agent turn: {message}"))
        }
    }
}

pub(crate) fn web_user_message(id: &str, content: Vec<Value>, source: Value) -> Value {
    json!({
        "id": id,
        "role": "user",
        "content": content,
        "source": source,
    })
}

fn web_assistant_message(id: &str, text: &str, provider: &str, model: &str) -> Value {
    json!({
        "id": id,
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "source": {"kind": "model", "provider": provider, "model": model},
    })
}

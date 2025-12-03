use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use xharness_api::{
    ApiBackend, ClientResponse, EventStream, ReceiptRejection, RpcError, RpcErrorCode, RpcId,
    RpcMethod, RpcReceipt, RpcResult, ServerRequest, SessionExport,
};
use xharness_control::ControlEvent;
use xharness_core::{AgentMessage, LoopCommand, LoopControlError};
use xharness_session::{
    ApprovalPolicy, CommandResultKind, CommandSource, EventData as SessionEventData,
    GoalChange as SessionGoalChange, GoalChangeKind, GoalClearChange, GoalClearOperation,
    GoalPhase, GoalRef as DurableGoalRef, GoalSnapshotChange, GoalSnapshotOperation, SessionEvent,
    SessionSandboxMode, SessionTitleSource,
};

use crate::{
    control::SessionMutationResponse,
    control::{settings_snapshot, workspace_snapshot},
    driver::{agent_runtime_error, rpc_error, PromptAdmission},
    metrics::MetricsProjectionState,
    restore::{project_session_event_range, project_session_history},
    runtime::{AgentRuntimeError, ModelRoute},
    state::{
        iso_now, now_ms, AgentPreset, AttachmentRecord, DriverCommand, GoalState, ModelSelection,
        PendingResponse, SessionRecord, SettingsNamespace, WorkspaceRecord,
    },
    BasicHost,
};

const DEFAULT_HISTORY_MESSAGES: usize = 50;
const MAX_HISTORY_MESSAGES: usize = 500;
const MAX_DIRECTORY_ENTRIES: usize = 1_000;
const MAX_SEARCH_RESULTS: usize = 20;

#[async_trait]
impl ApiBackend for BasicHost {
    async fn call(
        &self,
        rpc_id: RpcId,
        method: RpcMethod,
        payload: Value,
        cancellation: CancellationToken,
    ) -> RpcResult {
        let result = match method {
            RpcMethod::SessionList => self.session_list(&payload).await,
            RpcMethod::SessionSearch => self.session_search(&payload, &cancellation).await,
            RpcMethod::SessionCreate => self.session_create(&payload).await,
            RpcMethod::SessionHistory => self.session_history(&payload).await,
            RpcMethod::SessionModels => self.session_models(&payload).await,
            RpcMethod::SessionSelectModel => self.session_select_model(rpc_id, &payload).await,
            RpcMethod::SessionRename => self.session_rename(rpc_id, &payload).await,
            RpcMethod::SessionFork => self.session_fork(&payload).await,
            RpcMethod::SessionPrompt => self.session_prompt(rpc_id, &payload).await,
            RpcMethod::SessionAttachment => self.session_attachment(&payload).await,
            RpcMethod::SessionUpdateQueue => self.session_update_queue(&payload).await,
            RpcMethod::SessionCancel => self.session_cancel(&payload).await,
            RpcMethod::SubagentList => self.subagent_list(&payload).await,
            RpcMethod::SubagentHistory => self.subagent_history(&payload).await,
            RpcMethod::SubagentPrompt => self.subagent_prompt(rpc_id, &payload).await,
            RpcMethod::SubagentInterrupt => self.subagent_interrupt(&payload).await,
            RpcMethod::HostDescribe => self.host_describe(&payload).await,
            RpcMethod::HostPickDirectory => self.host_pick_directory(&payload).await,
            RpcMethod::HostListDirectory => self.host_list_directory(&payload).await,
            RpcMethod::HostCreateDirectory => self.host_create_directory(&payload).await,
            RpcMethod::HostOpenPath => self.host_open_path(&payload).await,
            RpcMethod::WorkspaceList => self.workspace_list(&payload).await,
            RpcMethod::WorkspaceCreate => self.workspace_create(rpc_id, &payload).await,
            RpcMethod::WorkspaceRename => self.workspace_rename(rpc_id, &payload).await,
            RpcMethod::WorkspaceDelete => self.workspace_delete(rpc_id, &payload).await,
            RpcMethod::WorkspaceInsertBefore => {
                self.workspace_insert_before(rpc_id, &payload).await
            }
            RpcMethod::WorkspaceInsertSessionBefore => {
                self.workspace_insert_session_before(rpc_id, &payload).await
            }
            RpcMethod::WorkspaceArchiveSession => {
                self.workspace_archive_session(rpc_id, &payload).await
            }
            RpcMethod::SkillList => self.skill_list(&payload).await,
            RpcMethod::AgentPresetList => self.agent_preset_list(&payload).await,
            RpcMethod::AgentPresetSelect => self.agent_preset_select(rpc_id, &payload).await,
            RpcMethod::AgentPresetRead => self.agent_preset_read(&payload).await,
            RpcMethod::AgentPresetCopy => self.agent_preset_copy(&payload).await,
            RpcMethod::AgentPresetOpenDocument => self.agent_preset_open_document(&payload).await,
            RpcMethod::AgentPresetRemove => self.agent_preset_remove(&payload).await,
            RpcMethod::GoalCreate => self.goal_create(rpc_id, &payload).await,
            RpcMethod::GoalEdit => self.goal_edit(rpc_id, &payload).await,
            RpcMethod::GoalPause => self.goal_transition(rpc_id, &payload, "paused").await,
            RpcMethod::GoalResume => self.goal_transition(rpc_id, &payload, "active").await,
            RpcMethod::GoalComplete => self.goal_transition(rpc_id, &payload, "complete").await,
            RpcMethod::GoalClear => self.goal_clear(rpc_id, &payload).await,
            RpcMethod::SettingsDescribe => self.settings_describe(&payload).await,
            RpcMethod::SettingsOpenDocument => self.settings_open_document(&payload).await,
            RpcMethod::SettingsUpdate => self.settings_update(rpc_id, &payload).await,
            RpcMethod::SettingsReplace => self.settings_replace(rpc_id, &payload).await,
            RpcMethod::SettingsMutate => self.settings_mutate(rpc_id, &payload).await,
            RpcMethod::CredentialsDescribe => self.credentials_describe(&payload).await,
            RpcMethod::CredentialsSet => self.credentials_set(&payload).await,
            RpcMethod::CredentialsUnset => self.credentials_unset(&payload).await,
            RpcMethod::LlmProviders => self.llm_providers(&payload).await,
            RpcMethod::LlmModels => self.llm_models(&payload).await,
            RpcMethod::LlmDiscoverModels => self.llm_discover_models(&payload).await,
        };
        match result {
            Ok(value) => RpcResult::success(value),
            Err(error) => RpcResult::failure(error),
        }
    }

    async fn call_dynamic(
        &self,
        _rpc_id: RpcId,
        endpoint: &str,
        payload: Value,
        _cancellation: CancellationToken,
    ) -> Option<RpcResult> {
        let result = match endpoint {
            "commands/list" => self.commands_list(&payload).await.map(Some),
            "commands/execute" => self.commands_execute(&payload).await,
            _ => return None,
        };
        Some(match result {
            Ok(Some(value)) => RpcResult::success(value),
            Ok(None) => RpcResult::Success { value: None },
            Err(error) => RpcResult::failure(error),
        })
    }

    async fn respond(&self, response: ClientResponse) -> RpcReceipt {
        self.respond_pending(response).await
    }

    fn mux_events(&self) -> EventStream {
        let mut receiver = self.mux_tx.subscribe();
        let state = Arc::clone(&self.state);
        let next_id = Arc::clone(&self.next_id);
        Box::pin(async_stream::stream! {
            let baseline = {
            let state = state.read().await;
            let mut frames = Vec::new();
            for session in state.sessions.values() {
                frames.push(ServerRequest::new(
                    RpcId::new(mint_stream_id(&next_id, "subscribed")),
                    "session/subscribed",
                    json!({
                        "type": "session/subscribed",
                        "sessionId": session.session_id,
                        "lastSeq": session.last_event_seq_i64(),
                    }),
                ));
                for (key, value) in session
                    .projection_values()
                    .as_object()
                    .expect("projection values are an object")
                {
                    frames.push(ServerRequest::new(
                        RpcId::new(mint_stream_id(&next_id, "projection")),
                        "session/projection",
                        json!({
                            "type": "session/projection",
                            "sessionId": session.session_id,
                            "key": key,
                            "value": value,
                            "seq": session.last_event_seq_i64(),
                        }),
                    ));
                }
                let items = session.queue_view();
                if !items.is_empty() {
                    frames.push(ServerRequest::new(
                        RpcId::new(mint_stream_id(&next_id, "queue")),
                        "session/queue",
                        json!({
                            "type": "session/queue",
                            "sessionId": session.session_id,
                            "items": items,
                        }),
                    ));
                }
            }
            for (rpc_id, pending) in &state.pending {
                match pending {
                    PendingResponse::Approval {
                        session_id,
                        approval_id,
                        call_id,
                        tool_name,
                        ..
                    } => frames.push(ServerRequest::new(
                        RpcId::new(rpc_id),
                        "approval/requested",
                        json!({
                            "type": "approval/requested",
                            "sessionId": session_id,
                            "approvalId": approval_id,
                            "toolName": tool_name,
                            "callId": call_id,
                            "reason": "This tool requires explicit approval.",
                        }),
                    )),
                }
            }
            frames
            };
            for frame in baseline {
                yield frame;
            }
            loop {
                match receiver.recv().await {
                    Ok(frame) => yield frame,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        yield ServerRequest::new(
                            RpcId::new("stream-lagged"),
                            "stream/error",
                            json!({
                                "type": "stream/error",
                                "error": {
                                    "code": "internal",
                                    "message": format!("mux stream lagged by {skipped} frames; refetch history"),
                                    "details": {},
                                },
                            }),
                        );
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        })
    }

    fn host_events(&self) -> EventStream {
        let mut receiver = self.host_tx.subscribe();
        Box::pin(async_stream::stream! {
            loop {
                match receiver.recv().await {
                    Ok(frame) => yield frame,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        yield ServerRequest::new(
                            RpcId::new("host-stream-lagged"),
                            "stream/error",
                            json!({
                                "type": "stream/error",
                                "error": {
                                    "code": "internal",
                                    "message": format!("host stream lagged by {skipped} frames; refetch host state"),
                                    "details": {},
                                },
                            }),
                        );
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        })
    }

    async fn export_session(
        &self,
        session_id: &str,
        _cancellation: CancellationToken,
    ) -> Result<SessionExport, RpcError> {
        let state = self.state.read().await;
        let session = state.sessions.get(session_id).ok_or_else(|| {
            rpc_error(
                RpcErrorCode::SessionNotFound,
                format!("session {session_id:?} was not found"),
                json!({"sessionId": session_id}),
            )
        })?;
        let bytes = serde_json::to_vec_pretty(&json!({
            "format": "xharness-session-export",
            "version": 1,
            "session": session,
        }))
        .map_err(|error| RpcError::internal(format!("could not encode session: {error}")))?;
        Ok(SessionExport::json(format!("{session_id}.json"), bytes))
    }
}

impl BasicHost {
    async fn commands_list(&self, payload: &Value) -> Result<Value, RpcError> {
        let args = payload
            .get("args")
            .ok_or_else(|| bad_request("commands/list requires args"))?;
        let session_id = required_string(args, "agentId")?;
        if !self.state.read().await.sessions.contains_key(&session_id) {
            return Err(session_not_found(&session_id));
        }
        Ok(json!([
            {
                "name": "permission",
                "description": "Switch the permission preset (sandbox mode + approval policy)",
                "input": {"hint": "<preset>"},
            },
            {
                "name": "plan",
                "description": "Enter or leave plan mode",
                "input": {"hint": "[off|message]", "images": true},
            }
        ]))
    }

    async fn commands_execute(&self, payload: &Value) -> Result<Option<Value>, RpcError> {
        let args = payload
            .get("args")
            .ok_or_else(|| bad_request("commands/execute requires args"))?;
        let session_id = required_string(args, "agentId")?;
        let _session_guard = self.lock_admission(&session_id).await;
        let line = required_string(args, "line")?;
        let images = required_array(args, "images")?;

        if let Some(raw_input) = plan_command_input(&line) {
            return self
                .execute_plan_command(&session_id, raw_input, images)
                .await
                .map(Some);
        }

        let Some(raw_input) = permission_command_input(&line) else {
            return Ok(None);
        };
        let command_id = self.mint_id("command");
        self.commit_session_events(
            &session_id,
            vec![SessionEventData::CommandRun {
                command_id: command_id.clone(),
                name: "permission".to_owned(),
                args: Some(raw_input.to_owned()),
                source: CommandSource::User,
            }
            .into()],
        )
        .await?;

        let result = if !images.is_empty() {
            json!({"kind": "error", "text": "/permission does not accept image attachments"})
        } else if raw_input.trim().is_empty() {
            let current = self
                .state
                .read()
                .await
                .sessions
                .get(&session_id)
                .ok_or_else(|| session_not_found(&session_id))?
                .permission_preset;
            json!({
                "kind": "success",
                "text": format!(
                    "current preset {} (available: workspace-write, danger-full-access)",
                    current.as_str()
                ),
            })
        } else if let Some(preset) = crate::PermissionPreset::parse(raw_input.trim()) {
            let busy = self
                .state
                .read()
                .await
                .sessions
                .get(&session_id)
                .ok_or_else(|| session_not_found(&session_id))?
                .running;
            if busy {
                json!({
                    "kind": "error",
                    "text": "cannot change permissions while the session is running",
                })
            } else {
                self.commit_session_events(&session_id, permission_events(preset))
                    .await?;
                self.state
                    .write()
                    .await
                    .sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| session_not_found(&session_id))?
                    .permission_preset = preset;
                self.push_projection(&session_id, "permissions", preset.select())
                    .await;
                json!({"kind": "success", "text": format!("preset {}", preset.as_str())})
            }
        } else {
            json!({
                "kind": "error",
                "text": format!(
                    "unknown preset {:?} (available: workspace-write, danger-full-access)",
                    raw_input.trim()
                ),
            })
        };

        let kind = match result["kind"].as_str() {
            Some("success") => CommandResultKind::Success,
            _ => CommandResultKind::Error,
        };
        self.commit_session_events(
            &session_id,
            vec![SessionEventData::CommandDone {
                command_id: command_id.clone(),
                kind,
                text: result["text"].as_str().map(str::to_owned),
                source_event_seq: None,
            }
            .into()],
        )
        .await?;
        Ok(Some(json!({"commandId": command_id, "result": result})))
    }

    async fn execute_plan_command(
        &self,
        session_id: &str,
        raw_input: &str,
        images: &[Value],
    ) -> Result<Value, RpcError> {
        let command_id = self.mint_id("command");
        self.commit_session_events(
            session_id,
            vec![SessionEventData::CommandRun {
                command_id: command_id.clone(),
                name: "plan".to_owned(),
                args: Some(raw_input.to_owned()),
                source: CommandSource::User,
            }
            .into()],
        )
        .await?;

        let message = raw_input.trim();
        let result = if message == "off" && !images.is_empty() {
            json!({"kind": "error", "text": "Image attachments cannot accompany /plan off."})
        } else if (message != "off" && !message.is_empty()) || !images.is_empty() {
            json!({
                "kind": "error",
                "text": "Plan-mode messages and images require the pending pre-step steering path, which is not available in this host build.",
            })
        } else {
            let (running, current) = {
                let state = self.state.read().await;
                let session = state
                    .sessions
                    .get(session_id)
                    .ok_or_else(|| session_not_found(session_id))?;
                (session.running, session.plan_active)
            };
            let wanted = message != "off";
            if running {
                json!({
                    "kind": "error",
                    "text": "cannot switch plan mode while the session is running until pending pre-step selection is implemented",
                })
            } else if current == wanted {
                json!({
                    "kind": "success",
                    "text": if wanted {
                        "Plan mode is already active."
                    } else {
                        "Plan mode is already inactive."
                    },
                })
            } else {
                self.commit_session_events(
                    session_id,
                    vec![SessionEventData::PlanMode { active: wanted }.into()],
                )
                .await?;
                self.state
                    .write()
                    .await
                    .sessions
                    .get_mut(session_id)
                    .ok_or_else(|| session_not_found(session_id))?
                    .plan_active = wanted;
                self.push_projection(
                    session_id,
                    "plan",
                    json!({"active": wanted, "pending": false}),
                )
                .await;
                json!({
                    "kind": "success",
                    "text": if wanted {
                        "Plan mode on. Use /plan off to leave."
                    } else {
                        "Plan mode off."
                    },
                })
            }
        };

        let kind = match result["kind"].as_str() {
            Some("success") => CommandResultKind::Success,
            _ => CommandResultKind::Error,
        };
        self.commit_session_events(
            session_id,
            vec![SessionEventData::CommandDone {
                command_id: command_id.clone(),
                kind,
                text: result["text"].as_str().map(str::to_owned),
                source_event_seq: None,
            }
            .into()],
        )
        .await?;
        Ok(json!({"commandId": command_id, "result": result}))
    }

    async fn session_list(&self, payload: &Value) -> Result<Value, RpcError> {
        require_object(payload)?;
        let state = self.state.read().await;
        let mut items = state
            .sessions
            .values()
            .filter(|session| !state.archived_sessions.contains(&session.session_id))
            .map(SessionRecord::summary)
            .collect::<Vec<_>>();
        items.sort_by_key(|item| std::cmp::Reverse(item["updatedAt"].as_u64().unwrap_or(0)));
        Ok(json!({"items": items}))
    }

    async fn session_search(
        &self,
        payload: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let query = required_string(payload, "query")?.trim().to_lowercase();
        if query.is_empty() || query.chars().count() > 500 || query.contains('\0') {
            return Err(bad_request("query must contain 1-500 visible characters"));
        }
        if cancellation.is_cancelled() {
            return Err(rpc_error(
                RpcErrorCode::Cancelled,
                "session search was cancelled",
                json!({}),
            ));
        }
        let state = self.state.read().await;
        let session_ids = state
            .sessions
            .keys()
            .filter(|session_id| !state.archived_sessions.contains(*session_id))
            .cloned()
            .collect::<Vec<_>>();
        if self.agent_runtime.has_authoritative_sessions() {
            drop(state);
            let mut matches = Vec::new();
            for session_id in session_ids {
                if cancellation.is_cancelled() {
                    return Err(rpc_error(
                        RpcErrorCode::Cancelled,
                        "session search was cancelled",
                        json!({}),
                    ));
                }
                let Some(session) = self
                    .agent_runtime
                    .authoritative_session(&session_id)
                    .await
                    .map_err(agent_runtime_error)?
                else {
                    continue;
                };
                if let Some(text) = session.events().iter().find_map(|event| {
                    let text = serde_json::to_string(event).unwrap_or_default();
                    text.to_lowercase().contains(&query).then_some(text)
                }) {
                    matches.push(json!({
                        "sessionId": session_id,
                        "snippet": truncate_chars(&text, 240),
                    }));
                }
                if matches.len() > MAX_SEARCH_RESULTS {
                    break;
                }
            }
            let has_more = matches.len() > MAX_SEARCH_RESULTS;
            matches.truncate(MAX_SEARCH_RESULTS);
            return Ok(json!({"items": matches, "hasMore": has_more}));
        }
        let mut matches = Vec::new();
        for session in state.sessions.values() {
            if state.archived_sessions.contains(&session.session_id) {
                continue;
            }
            if let Some(text) = session.events.iter().find_map(|event| {
                let text = event.to_string();
                text.to_lowercase().contains(&query).then_some(text)
            }) {
                matches.push(json!({
                    "sessionId": session.session_id,
                    "snippet": truncate_chars(&text, 240),
                }));
            }
        }
        let has_more = matches.len() > MAX_SEARCH_RESULTS;
        matches.truncate(MAX_SEARCH_RESULTS);
        Ok(json!({"items": matches, "hasMore": has_more}))
    }

    async fn session_create(&self, payload: &Value) -> Result<Value, RpcError> {
        let object = require_object(payload)?;
        if object.contains_key("workspaceId") && object.contains_key("cwd") {
            return Err(bad_request(
                "session.create accepts workspaceId or cwd, not both",
            ));
        }
        let requested_id = optional_string(payload, "sessionId")?;
        let preset = optional_string(payload, "agentPreset")?;
        let session_id = requested_id.unwrap_or_else(|| self.mint_id("session"));
        // Creating a named session participates in the same per-session admission
        // fence as prompts and control commands.  The guard is intentionally held
        // until the initial durable policy events have crossed their flush barrier,
        // so an idempotent concurrent create can never observe a half-created
        // in-memory record and return success before its receipt is durable.
        let _session_guard = self.lock_admission(&session_id).await;
        let mut state = self.state.write().await;
        if let Some(preset) = &preset {
            if !state.presets.contains_key(preset) {
                return Err(rpc_error(
                    RpcErrorCode::AgentPresetNotFound,
                    format!("agent preset {preset:?} was not found"),
                    json!({"agentPreset": preset}),
                ));
            }
        }
        let workspace_id = optional_string(payload, "workspaceId")?;
        let cwd = if let Some(workspace_id) = &workspace_id {
            state
                .workspaces
                .get(workspace_id)
                .ok_or_else(|| {
                    rpc_error(
                        RpcErrorCode::WorkspaceNotFound,
                        format!("workspace {workspace_id:?} was not found"),
                        json!({"workspaceId": workspace_id}),
                    )
                })?
                .path
                .clone()
        } else {
            optional_string(payload, "cwd")?
                .unwrap_or_else(|| self.config.cwd.to_string_lossy().into_owned())
        };
        let cwd = canonical_directory(&cwd).map_err(|message| {
            rpc_error(
                RpcErrorCode::WorkspaceInvalidPath,
                message,
                json!({"path": cwd}),
            )
        })?;
        if let Some(existing) = state.sessions.get(&session_id) {
            if existing.cwd != cwd {
                return Err(rpc_error(
                    RpcErrorCode::SessionConflict,
                    "session id already exists with another cwd",
                    json!({
                        "sessionId": session_id,
                        "requestedCwd": cwd,
                        "existingCwd": existing.cwd,
                    }),
                ));
            }
            return Ok(json!({
                "sessionId": session_id,
                "agentPreset": existing.agent_preset,
            }));
        }
        let now = now_ms();
        let effective_preset = preset.or_else(|| Some("coding".to_owned()));
        let permission_preset = state
            .settings
            .get("permission")
            .and_then(|namespace| namespace.value.get("defaultPreset"))
            .and_then(Value::as_str)
            .and_then(crate::PermissionPreset::parse)
            .unwrap_or_default();
        let record = SessionRecord {
            session_id: session_id.clone(),
            created_at: now,
            updated_at: now,
            running: false,
            blank: true,
            parent_session_id: None,
            origin: None,
            cwd: cwd.clone(),
            agent_preset: effective_preset.clone(),
            title: None,
            model: ModelSelection::from_config(&self.config),
            permission_preset,
            plan_active: false,
            goal: None,
            events: Vec::new(),
            event_base_seq: 0,
            event_cache_bytes: 0,
            metrics: MetricsProjectionState::default(),
            messages: Vec::new(),
            queue: Default::default(),
            projected_queue: Default::default(),
            admissions: Default::default(),
            mutation_receipts: Default::default(),
            authoritative_seq: None,
            control: None,
            next_turn: 0,
        };
        state.sessions.insert(session_id.clone(), record);
        let workspace_changed = workspace_id.and_then(|workspace_id| {
            let workspace = state.workspaces.get_mut(&workspace_id)?;
            if !workspace.session_ids.contains(&session_id) {
                workspace.session_ids.insert(0, session_id.clone());
                workspace.updated_at = iso_now();
            }
            serde_json::to_value(workspace).ok()
        });
        drop(state);
        let mut initial_events = effective_preset
            .iter()
            .map(|agent_preset| {
                SessionEventData::AgentPresetSelected {
                    agent_preset: agent_preset.clone(),
                }
                .into()
            })
            .collect::<Vec<SessionEvent>>();
        initial_events.extend(permission_events(permission_preset));
        if let Err(error) = self
            .commit_session_events(&session_id, initial_events)
            .await
        {
            let mut state = self.state.write().await;
            state.sessions.remove(&session_id);
            for workspace in state.workspaces.values_mut() {
                workspace
                    .session_ids
                    .retain(|candidate| candidate != &session_id);
            }
            return Err(error);
        }
        self.push_host(json!({
            "type": "host/session-added",
            "sessionId": session_id,
            "blank": true,
            "cwd": cwd,
            "agentPreset": effective_preset,
        }));
        if let Some(workspace) = workspace_changed {
            self.push_host(json!({"type": "host/workspace-changed", "workspace": workspace}));
        }
        Ok(json!({
            "sessionId": session_id,
            "agentPreset": effective_preset,
        }))
    }

    async fn session_history(&self, payload: &Value) -> Result<Value, RpcError> {
        let session_id = required_string(payload, "sessionId")?;
        self.sync_authoritative_session(&session_id).await?;
        let before_seq = optional_u64(payload, "beforeSeq")?;
        let max_messages = optional_u64(payload, "maxMessages")?
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(DEFAULT_HISTORY_MESSAGES)
            .clamp(1, MAX_HISTORY_MESSAGES);

        if self.agent_runtime.has_authoritative_sessions() {
            let durable = self
                .agent_runtime
                .authoritative_session(&session_id)
                .await
                .map_err(agent_runtime_error)?
                .ok_or_else(|| session_not_found(&session_id))?;
            let (route, projections) = {
                let state = self.state.read().await;
                let session = state
                    .sessions
                    .get(&session_id)
                    .ok_or_else(|| session_not_found(&session_id))?;
                (
                    ModelRoute {
                        provider: session.model.provider.clone(),
                        model: session.model.model.clone(),
                        reasoning_effort: session.model.reasoning_effort.clone(),
                    },
                    session.projection_values(),
                )
            };
            let page = project_session_history(&durable, &route, before_seq, max_messages);
            let events = page
                .events
                .into_iter()
                .map(|event| json!({"event": event}))
                .collect::<Vec<_>>();
            let mut value = json!({"events": events, "hasMore": page.has_more});
            if before_seq.is_none() {
                value.as_object_mut().expect("history is object").insert(
                    "projections".to_owned(),
                    json!({
                        "asOfSeq": page.as_of_seq.and_then(|seq| i64::try_from(seq).ok()).unwrap_or(-1),
                        "values": projections,
                    }),
                );
            }
            return Ok(value);
        }

        let state = self.state.read().await;
        let session = state
            .sessions
            .get(&session_id)
            .ok_or_else(|| session_not_found(&session_id))?;
        let end_seq = before_seq
            .unwrap_or_else(|| session.next_event_seq())
            .min(session.next_event_seq());
        let end = usize::try_from(end_seq.saturating_sub(session.event_base_seq))
            .unwrap_or(usize::MAX)
            .min(session.events.len());
        let mut start = end;
        let mut messages = 0usize;
        while start > 0 && messages < max_messages {
            start -= 1;
            if matches!(
                session.events[start].get("type").and_then(Value::as_str),
                Some("user/message" | "assistant/message" | "tool/result")
            ) {
                messages += 1;
            }
        }
        let events = session.events[start..end]
            .iter()
            .map(|event| json!({"event": event}))
            .collect::<Vec<_>>();
        let mut value = json!({
            "events": events,
            "hasMore": start > 0 || session.event_base_seq > 0,
        });
        if before_seq.is_none() {
            value.as_object_mut().expect("history is object").insert(
                "projections".to_owned(),
                json!({
                    "asOfSeq": session.last_event_seq_i64(),
                    "values": session.projection_values(),
                }),
            );
        }
        Ok(value)
    }

    async fn session_models(&self, payload: &Value) -> Result<Value, RpcError> {
        let session_id = required_string(payload, "sessionId")?;
        let state = self.state.read().await;
        let session = state
            .sessions
            .get(&session_id)
            .ok_or_else(|| session_not_found(&session_id))?;
        let route = ModelRoute {
            provider: session.model.provider.clone(),
            model: session.model.model.clone(),
            reasoning_effort: session.model.reasoning_effort.clone(),
        };
        Ok(json!({
            "current": session.model,
            "routable": self.agent_runtime.can_route(&route),
            "groups": self.model_groups(),
            "failures": [],
        }))
    }

    async fn session_select_model(
        &self,
        rpc_id: RpcId,
        payload: &Value,
    ) -> Result<Value, RpcError> {
        let session_id = required_string(payload, "sessionId")?;
        let _session_guard = self.lock_admission(&session_id).await;
        let provider = nonempty(required_string(payload, "provider")?, "provider")?;
        let model = nonempty(required_string(payload, "model")?, "model")?;
        let reasoning_effort = optional_string(payload, "reasoningEffort")?;
        let selected = ModelSelection {
            provider,
            model,
            reasoning_effort,
        };
        let route = ModelRoute {
            provider: selected.provider.clone(),
            model: selected.model.clone(),
            reasoning_effort: selected.reasoning_effort.clone(),
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
        if let Some(response) = self
            .replay_session_mutation_receipt(
                &session_id,
                &rpc_id,
                RpcMethod::SessionSelectModel,
                payload,
            )
            .await?
        {
            return Ok(response);
        }
        let response = self
            .commit_session_mutation(
                &session_id,
                &rpc_id,
                RpcMethod::SessionSelectModel,
                payload,
                vec![SessionEventData::SessionModelSelected {
                    provider: selected.provider.clone(),
                    model: selected.model.clone(),
                    reasoning_effort: selected.reasoning_effort.clone(),
                }
                .into()],
                SessionMutationResponse::fixed(json!({"selected": selected})),
            )
            .await?;
        let mut state = self.state.write().await;
        let session = state
            .sessions
            .get_mut(&session_id)
            .ok_or_else(|| session_not_found(&session_id))?;
        session.model = selected;
        Ok(response)
    }

    async fn session_rename(&self, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
        let session_id = required_string(payload, "sessionId")?;
        let _session_guard = self.lock_admission(&session_id).await;
        let title = required_string(payload, "title")?
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if title.is_empty() {
            return Err(rpc_error(
                RpcErrorCode::TitleInvalid,
                "session title must contain visible characters",
                json!({"sessionId": session_id}),
            ));
        }
        if let Some(response) = self
            .replay_session_mutation_receipt(
                &session_id,
                &rpc_id,
                RpcMethod::SessionRename,
                payload,
            )
            .await?
        {
            return Ok(response);
        }
        let response = self
            .commit_session_mutation(
                &session_id,
                &rpc_id,
                RpcMethod::SessionRename,
                payload,
                vec![SessionEventData::SessionTitle {
                    title: title.clone(),
                    message_seqs: Vec::new(),
                    source: SessionTitleSource::User,
                }
                .into()],
                SessionMutationResponse::with_event_seq(json!({"title": title}), "seq"),
            )
            .await?;
        {
            let mut state = self.state.write().await;
            let session = state
                .sessions
                .get_mut(&session_id)
                .ok_or_else(|| session_not_found(&session_id))?;
            session.title = Some(title.clone());
        }
        self.push_projection(&session_id, "title", json!(title))
            .await;
        Ok(response)
    }

    async fn session_fork(&self, payload: &Value) -> Result<Value, RpcError> {
        let source_id = required_string(payload, "sessionId")?;
        let at_seq = optional_u64(payload, "atSeq")?;
        let (cwd, agent_preset, title, model, permission_preset, plan_active, goal, next_turn) = {
            let state = self.state.read().await;
            let source = state
                .sessions
                .get(&source_id)
                .ok_or_else(|| session_not_found(&source_id))?;
            (
                source.cwd.clone(),
                source.agent_preset.clone(),
                source.title.clone(),
                source.model.clone(),
                source.permission_preset,
                source.plan_active,
                source.goal.clone(),
                source.next_turn,
            )
        };
        let route = ModelRoute {
            provider: model.provider.clone(),
            model: model.model.clone(),
            reasoning_effort: model.reasoning_effort.clone(),
        };
        let durable_source = if self.agent_runtime.has_authoritative_sessions() {
            self.agent_runtime
                .authoritative_session(&source_id)
                .await
                .map_err(agent_runtime_error)?
        } else {
            None
        };
        let (child_events, child_messages, durable_events) = if let Some(source) = durable_source {
            let end = at_seq
                .and_then(|seq| usize::try_from(seq.saturating_add(1)).ok())
                .map_or(source.events().len(), |end| end.min(source.events().len()));
            (
                project_session_event_range(&source, &route, 0, end),
                xharness_session::derive_messages(&source.events()[..end]),
                Some(
                    source.events()[..end]
                        .iter()
                        .map(|event| event.event.clone())
                        .collect::<Vec<_>>(),
                ),
            )
        } else {
            let state = self.state.read().await;
            let source = state
                .sessions
                .get(&source_id)
                .ok_or_else(|| session_not_found(&source_id))?;
            let mut events = source.events.clone();
            if let Some(at_seq) = at_seq {
                let keep = usize::try_from(
                    at_seq
                        .saturating_add(1)
                        .saturating_sub(source.event_base_seq),
                )
                .unwrap_or(usize::MAX)
                .min(events.len());
                events.truncate(keep);
            }
            (events, source.messages.clone(), None)
        };
        if child_events.is_empty() {
            return Err(rpc_error(
                RpcErrorCode::ForkUnavailable,
                "session has no completed history to fork",
                json!({"sessionId": source_id}),
            ));
        }
        let child_id = self.mint_id("session");
        let now = now_ms();
        let child_event_bytes = child_events.iter().fold(0usize, |total, event| {
            total.saturating_add(serde_json::to_vec(event).map_or(0, |encoded| encoded.len()))
        });
        let child_metrics = if durable_events.is_some() {
            MetricsProjectionState::default()
        } else {
            MetricsProjectionState::rebuild(child_events.iter())
        };
        let child = SessionRecord {
            session_id: child_id.clone(),
            created_at: now,
            updated_at: now,
            running: false,
            blank: false,
            parent_session_id: Some(source_id.clone()),
            origin: None,
            cwd: cwd.clone(),
            agent_preset,
            title,
            model,
            permission_preset,
            plan_active,
            goal,
            events: child_events,
            event_base_seq: 0,
            event_cache_bytes: child_event_bytes,
            metrics: child_metrics,
            messages: child_messages,
            queue: Default::default(),
            projected_queue: Default::default(),
            admissions: Default::default(),
            mutation_receipts: Default::default(),
            authoritative_seq: None,
            control: None,
            next_turn,
        };
        let mut state = self.state.write().await;
        state.sessions.insert(child_id.clone(), child);
        let mut changed_workspace = None;
        for workspace in state.workspaces.values_mut() {
            if workspace.session_ids.contains(&source_id) {
                workspace.session_ids.insert(0, child_id.clone());
                workspace.updated_at = iso_now();
                changed_workspace = serde_json::to_value(workspace).ok();
                break;
            }
        }
        drop(state);
        if let Some(events) = durable_events {
            if let Err(error) = self.commit_session_events(&child_id, events).await {
                self.state.write().await.sessions.remove(&child_id);
                return Err(error);
            }
        }
        self.push_host(json!({
            "type": "host/session-added",
            "sessionId": child_id,
            "blank": false,
            "parentSessionId": source_id,
            "cwd": cwd,
        }));
        if let Some(workspace) = changed_workspace {
            self.push_host(json!({"type": "host/workspace-changed", "workspace": workspace}));
        }
        Ok(json!({"sessionId": child_id}))
    }

    async fn session_prompt(&self, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
        let session_id = required_string(payload, "sessionId")?;
        let mode = required_string(payload, "mode")?;
        if mode != "queue" && mode != "steer" {
            return Err(bad_request("mode must be queue or steer"));
        }
        let content = required_array(payload, "content")?.clone();
        let client_time_zone = optional_string(payload, "clientTimeZone")?;
        if let Some(zone) = &client_time_zone {
            if zone.trim().is_empty() || zone.contains('\0') {
                return Err(rpc_error(
                    RpcErrorCode::InvalidTimeZone,
                    "clientTimeZone is invalid",
                    json!({"clientTimeZone": zone}),
                ));
            }
        }
        let fingerprint = prompt_fingerprint(&mode, &content, client_time_zone.as_deref());
        let _admission_guard = self.lock_admission(&session_id).await;
        if self
            .is_duplicate_admission(&session_id, rpc_id.as_str(), &fingerprint)
            .await?
        {
            return Ok(json!({"accepted": true}));
        }

        // Attachment materialization is deliberately after receipt lookup:
        // retrying a successfully admitted request must not mint duplicates.
        let (text, durable) = self.admit_prompt_content(&session_id, &content).await?;
        let mut source = json!({"kind": "user", "rpcId": rpc_id.as_str()});
        if let Some(zone) = client_time_zone {
            source
                .as_object_mut()
                .expect("source is object")
                .insert("clientTimeZone".to_owned(), json!(zone));
        }
        self.enqueue_prompt(PromptAdmission {
            rpc_id,
            session_id,
            mode,
            text,
            content: durable,
            source,
            fingerprint: Some(fingerprint),
        })
        .await?;
        Ok(json!({"accepted": true}))
    }

    async fn is_duplicate_admission(
        &self,
        session_id: &str,
        rpc_id: &str,
        fingerprint: &str,
    ) -> Result<bool, RpcError> {
        let state = self.state.read().await;
        let session = state
            .sessions
            .get(session_id)
            .ok_or_else(|| session_not_found(session_id))?;
        let Some(previous) = session.admissions.get(rpc_id) else {
            return Ok(false);
        };
        if previous.fingerprint.as_deref() == Some(fingerprint) {
            return Ok(true);
        }
        Err(rpc_error(
            RpcErrorCode::SessionConflict,
            "rpc id was already admitted with a different prompt payload",
            json!({"sessionId": session_id, "rpcId": rpc_id}),
        ))
    }

    async fn admit_prompt_content(
        &self,
        session_id: &str,
        content: &[Value],
    ) -> Result<(String, Vec<Value>), RpcError> {
        let mut text = String::new();
        let mut durable = Vec::new();
        for part in content {
            match part.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let value = part
                        .get("text")
                        .and_then(Value::as_str)
                        .ok_or_else(|| bad_request("text content requires string text"))?;
                    text.push_str(value);
                    durable.push(json!({"type": "text", "text": value}));
                }
                Some("image") => {
                    let media_type = part
                        .get("mediaType")
                        .and_then(Value::as_str)
                        .ok_or_else(|| bad_request("image content requires mediaType"))?;
                    if !matches!(
                        media_type,
                        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
                    ) {
                        return Err(rpc_error(
                            RpcErrorCode::AttachmentError,
                            "unsupported image media type",
                            json!({"reason": "UNSUPPORTED_MEDIA_TYPE"}),
                        ));
                    }
                    let data = part
                        .get("data")
                        .and_then(Value::as_str)
                        .ok_or_else(|| bad_request("image content requires base64 data"))?
                        .to_owned();
                    if data.is_empty() {
                        return Err(rpc_error(
                            RpcErrorCode::AttachmentError,
                            "image data is empty",
                            json!({"reason": "EMPTY_IMAGE"}),
                        ));
                    }
                    let attachment_id = self.mint_id("attachment");
                    let bytes = ((data.len() * 3) / 4).max(1);
                    let attachment = json!({
                        "attachmentId": attachment_id,
                        "mediaType": media_type,
                        "bytes": bytes,
                        "width": 1,
                        "height": 1,
                        "name": part.get("name").and_then(Value::as_str),
                    });
                    self.state.write().await.attachments.insert(
                        attachment_id.clone(),
                        AttachmentRecord {
                            attachment: attachment.clone(),
                            data,
                            referenced_by: BTreeSet::from([session_id.to_owned()]),
                        },
                    );
                    text.push_str(&format!("\n[attached image: {attachment_id}]"));
                    durable.push(json!({"type": "image", "attachment": attachment}));
                }
                _ => return Err(bad_request("content part type must be text or image")),
            }
        }
        if durable.is_empty() {
            return Err(bad_request("prompt content must not be empty"));
        }
        Ok((text, durable))
    }

    async fn session_attachment(&self, payload: &Value) -> Result<Value, RpcError> {
        let session_id = required_string(payload, "sessionId")?;
        let attachment_id = required_string(payload, "attachmentId")?;
        let state = self.state.read().await;
        if !state.sessions.contains_key(&session_id) {
            return Err(session_not_found(&session_id));
        }
        let attachment = state.attachments.get(&attachment_id).ok_or_else(|| {
            rpc_error(
                RpcErrorCode::AttachmentError,
                "attachment was not found",
                json!({"reason": "ATTACHMENT_NOT_FOUND"}),
            )
        })?;
        if !attachment.referenced_by.contains(&session_id) {
            return Err(rpc_error(
                RpcErrorCode::AttachmentError,
                "attachment is not referenced by this session",
                json!({"reason": "ATTACHMENT_NOT_REFERENCED"}),
            ));
        }
        Ok(json!({"attachment": attachment.attachment, "data": attachment.data}))
    }

    async fn session_update_queue(&self, payload: &Value) -> Result<Value, RpcError> {
        let session_id = required_string(payload, "sessionId")?;
        let _session_guard = self.lock_admission(&session_id).await;
        let item_id = required_string(payload, "itemId")?;
        let action = payload
            .get("action")
            .and_then(Value::as_object)
            .ok_or_else(|| bad_request("action must be an object"))?;
        let kind = action
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| bad_request("action.kind is required"))?;
        let authoritative = self.agent_runtime.has_authoritative_sessions();
        let item = {
            let state = self.state.read().await;
            let session = state
                .sessions
                .get(&session_id)
                .ok_or_else(|| session_not_found(&session_id))?;
            let item = if authoritative {
                session
                    .projected_queue
                    .iter()
                    .find(|item| item.id == item_id)
                    .cloned()
            } else {
                session
                    .queue
                    .iter()
                    .find(|item| item.id == item_id)
                    .cloned()
            };
            item.ok_or_else(|| {
                rpc_error(
                    RpcErrorCode::QueueItemNotFound,
                    "queued item is no longer pending",
                    json!({"itemId": item_id}),
                )
            })?
        };
        let mut steer_item = None;
        let mut replacement = None;
        match kind {
            "remove" | "steer" => {
                self.agent_runtime
                    .remove_pending_input(&session_id, &item_id)
                    .await
                    .map_err(|error| queue_item_not_found(&item_id, error))?;
                if kind == "steer" {
                    steer_item = Some(item);
                }
            }
            "edit" => {
                let content = action
                    .get("content")
                    .and_then(Value::as_array)
                    .ok_or_else(|| bad_request("edit action requires content"))?
                    .clone();
                if content
                    .iter()
                    .any(|block| block.get("type").and_then(Value::as_str) != Some("text"))
                {
                    return Err(rpc_error(
                        RpcErrorCode::AttachmentError,
                        "queue edits accept text content only",
                        json!({"reason": "QUEUE_EDIT_NON_TEXT"}),
                    ));
                }
                let text = visible_text(&content);
                self.agent_runtime
                    .replace_pending_input(
                        &session_id,
                        AgentMessage::new(xharness_core::Role::User, text.clone())
                            .with_id(item_id.clone()),
                        Some(json!({
                            "content": content.clone(),
                            "source": item.source.clone(),
                            "rpcFingerprint": item.fingerprint,
                            "rpcSessionId": session_id,
                        })),
                    )
                    .await
                    .map_err(|error| queue_item_not_found(&item_id, error))?;
                replacement = Some((content, text));
            }
            _ => return Err(bad_request("unsupported queue action")),
        }

        // The Host driver FIFO is only an attachment index. Keep it aligned
        // for work not yet handed to RunningTurn, but never use it as the Web
        // queue authority when a durable Session exists.
        {
            let mut state = self.state.write().await;
            let session = state
                .sessions
                .get_mut(&session_id)
                .ok_or_else(|| session_not_found(&session_id))?;
            if let Some(index) = session.queue.iter().position(|item| item.id == item_id) {
                if let Some((content, text)) = replacement {
                    if let Some(item) = session.queue.get_mut(index) {
                        item.content = content;
                        item.text = text;
                    }
                } else {
                    session.queue.remove(index);
                }
            }
        }
        if authoritative {
            self.sync_authoritative_session(&session_id).await?;
        } else {
            self.emit_queue(&session_id).await;
        }
        if let Some(item) = steer_item {
            self.enqueue_prompt(PromptAdmission {
                rpc_id: RpcId::new(item.id),
                session_id,
                mode: "steer".to_owned(),
                text: item.text,
                content: item.content,
                source: item.source,
                fingerprint: item.fingerprint,
            })
            .await?;
        }
        Ok(json!({"accepted": true}))
    }

    async fn session_cancel(&self, payload: &Value) -> Result<Value, RpcError> {
        let session_id = required_string(payload, "sessionId")?;
        self.send_control(&session_id, LoopCommand::Cancel).await?;
        Ok(json!({"accepted": true}))
    }

    async fn send_control(&self, session_id: &str, command: LoopCommand) -> Result<(), RpcError> {
        let cancel_is_idempotent = matches!(&command, LoopCommand::Cancel);
        let control = self
            .state
            .read()
            .await
            .sessions
            .get(session_id)
            .ok_or_else(|| session_not_found(session_id))?
            .control
            .clone();
        let Some(control) = control else {
            return Ok(());
        };
        let (acknowledgement, accepted) = oneshot::channel();
        if control
            .send(DriverCommand {
                command,
                input_metadata: None,
                acknowledgement,
            })
            .await
            .is_err()
        {
            return if cancel_is_idempotent {
                Ok(())
            } else {
                Err(RpcError::internal("session driver is no longer available"))
            };
        }
        match accepted.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(LoopControlError::Closed)) | Err(_) if cancel_is_idempotent => Ok(()),
            Ok(Err(error)) => Err(RpcError::internal(error.to_string())),
            Err(_) => Err(RpcError::internal(
                "session driver closed without acknowledgement",
            )),
        }
    }

    async fn subagent_list(&self, payload: &Value) -> Result<Value, RpcError> {
        let parent = required_string(payload, "parentSessionId")?;
        let state = self.state.read().await;
        let parent_available = state.sessions.contains_key(&parent);
        let entries = state
            .sessions
            .values()
            .filter(|session| session.parent_session_id.as_deref() == Some(&parent))
            .map(|session| {
                json!({
                    "kind": "child",
                    "id": session.session_id,
                    "mode": "continuable",
                    "activity": if session.running { "running" } else { "inactive" },
                    "hasChildren": state.sessions.values().any(|candidate| candidate.parent_session_id.as_deref() == Some(&session.session_id)),
                    "label": session.title.clone().unwrap_or_else(|| session.session_id.clone()),
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({"entries": entries, "parentAvailable": parent_available}))
    }

    async fn subagent_history(&self, payload: &Value) -> Result<Value, RpcError> {
        self.authorize_child(payload).await?;
        let mut ordinary = payload.clone();
        ordinary.as_object_mut().expect("validated object").insert(
            "sessionId".to_owned(),
            json!(required_string(payload, "childSessionId")?),
        );
        self.session_history(&ordinary).await
    }

    async fn subagent_prompt(&self, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
        self.authorize_child(payload).await?;
        if required_string(payload, "mode")? != "continuable" {
            return Err(rpc_error(
                RpcErrorCode::SubagentNotResumable,
                "only continuable children accept prompts",
                json!({"childSessionId": required_string(payload, "childSessionId")?}),
            ));
        }
        let child = required_string(payload, "childSessionId")?;
        let content = required_array(payload, "content")?.clone();
        let fingerprint = prompt_fingerprint("continuable", &content, None);
        let _admission_guard = self.lock_admission(&child).await;
        if self
            .is_duplicate_admission(&child, rpc_id.as_str(), &fingerprint)
            .await?
        {
            return Ok(json!({"messageId": rpc_id.as_str()}));
        }
        let text = visible_text(&content);
        self.enqueue_prompt(PromptAdmission {
            rpc_id: rpc_id.clone(),
            session_id: child,
            mode: "queue".to_owned(),
            text,
            content,
            source: json!({"kind": "user", "rpcId": rpc_id.as_str()}),
            fingerprint: Some(fingerprint),
        })
        .await?;
        Ok(json!({"messageId": rpc_id.as_str()}))
    }

    async fn subagent_interrupt(&self, payload: &Value) -> Result<Value, RpcError> {
        self.authorize_child(payload).await?;
        self.send_control(
            &required_string(payload, "childSessionId")?,
            LoopCommand::Cancel,
        )
        .await?;
        Ok(json!({"accepted": true}))
    }

    async fn authorize_child(&self, payload: &Value) -> Result<(), RpcError> {
        let parent = required_string(payload, "parentSessionId")?;
        let child = required_string(payload, "childSessionId")?;
        let state = self.state.read().await;
        if !state.sessions.contains_key(&parent) {
            return Err(rpc_error(
                RpcErrorCode::SubagentParentUnavailable,
                "parent session was not found",
                json!({"parentSessionId": parent}),
            ));
        }
        let record = state.sessions.get(&child).ok_or_else(|| {
            rpc_error(
                RpcErrorCode::SubagentNotFound,
                "child session was not found",
                json!({"parentSessionId": parent, "childSessionId": child}),
            )
        })?;
        if record.parent_session_id.as_deref() != Some(&parent) {
            return Err(rpc_error(
                RpcErrorCode::SubagentUnauthorized,
                "session is not a direct child of this parent",
                json!({"childSessionId": child}),
            ));
        }
        Ok(())
    }

    async fn host_describe(&self, payload: &Value) -> Result<Value, RpcError> {
        require_object(payload)?;
        let attached = self.state.read().await.sessions.len();
        Ok(json!({
            "version": self.config.version,
            "cwd": self.config.cwd,
            "provider": self.config.provider_id,
            "model": self.config.model_id,
            "attachedSessions": attached,
            "home": self.config.home,
            "canOpenPath": cfg!(target_os = "macos"),
        }))
    }

    async fn host_pick_directory(&self, payload: &Value) -> Result<Value, RpcError> {
        require_object(payload)?;
        Ok(json!({"path": Value::Null}))
    }

    async fn host_list_directory(&self, payload: &Value) -> Result<Value, RpcError> {
        require_object(payload)?;
        let requested = optional_string(payload, "path")?
            .unwrap_or_else(|| self.config.home.to_string_lossy().into_owned());
        let path = canonical_directory(&requested).map_err(|message| {
            rpc_error(
                RpcErrorCode::DirectoryUnreadable,
                message,
                json!({"path": requested}),
            )
        })?;
        let mut entries = std::fs::read_dir(&path)
            .map_err(|error| {
                rpc_error(
                    RpcErrorCode::DirectoryUnreadable,
                    error.to_string(),
                    json!({"path": path}),
                )
            })?
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_type()
                    .is_ok_and(|kind| kind.is_dir() || kind.is_symlink())
            })
            .map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                json!({
                    "name": name,
                    "path": entry.path().to_string_lossy(),
                    "hidden": name.starts_with('.'),
                })
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
        let truncated = entries.len() > MAX_DIRECTORY_ENTRIES;
        entries.truncate(MAX_DIRECTORY_ENTRIES);
        let crumbs = breadcrumb_entries(Path::new(&path));
        Ok(json!({
            "path": path,
            "home": self.config.home,
            "crumbs": crumbs,
            "entries": entries,
            "truncated": truncated,
        }))
    }

    async fn host_create_directory(&self, payload: &Value) -> Result<Value, RpcError> {
        let parent = required_string(payload, "path")?;
        let name = required_string(payload, "name")?;
        if name.trim().is_empty()
            || matches!(name.as_str(), "." | "..")
            || name.contains(['/', '\\'])
        {
            return Err(bad_request("name must be one non-blank path segment"));
        }
        let parent = canonical_directory(&parent).map_err(|message| {
            rpc_error(
                RpcErrorCode::DirectoryUnreadable,
                message,
                json!({"path": parent}),
            )
        })?;
        let created = Path::new(&parent).join(name);
        match std::fs::create_dir(&created) {
            Ok(()) => Ok(json!({"path": created.to_string_lossy()})),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(rpc_error(
                RpcErrorCode::DirectoryExists,
                error.to_string(),
                json!({"path": created.to_string_lossy()}),
            )),
            Err(error) => Err(rpc_error(
                RpcErrorCode::DirectoryCreateFailed,
                error.to_string(),
                json!({"path": created.to_string_lossy()}),
            )),
        }
    }

    async fn host_open_path(&self, payload: &Value) -> Result<Value, RpcError> {
        let path = nonempty(required_string(payload, "path")?, "path")?;
        if !Path::new(&path).exists() {
            return Err(rpc_error(
                RpcErrorCode::DirectoryUnreadable,
                "path does not exist",
                json!({"path": path}),
            ));
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("/usr/bin/open")
                .arg(&path)
                .spawn()
                .map_err(|error| RpcError::internal(format!("could not open path: {error}")))?;
            Ok(json!({"opened": true}))
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(RpcError::internal(
                "native path opening is unavailable on this host",
            ))
        }
    }

    async fn workspace_list(&self, payload: &Value) -> Result<Value, RpcError> {
        require_object(payload)?;
        let state = self.state.read().await;
        let items = state
            .workspace_order
            .iter()
            .filter_map(|id| state.workspaces.get(id))
            .collect::<Vec<_>>();
        Ok(json!({
            "items": items,
            "archivedSessionIds": state.archived_sessions,
        }))
    }

    async fn workspace_create(&self, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
        let _control_guard = self.control_gate.lock().await;
        if let Some(response) = self
            .replay_control_receipt(&rpc_id, RpcMethod::WorkspaceCreate, payload)
            .await?
        {
            return Ok(response);
        }
        let raw_path = required_string(payload, "path")?;
        let path = canonical_directory(&raw_path).map_err(|message| {
            rpc_error(
                RpcErrorCode::WorkspaceInvalidPath,
                message,
                json!({"path": raw_path}),
            )
        })?;
        let state = self.state.read().await;
        if let Some(existing) = state
            .workspaces
            .values()
            .find(|workspace| workspace.path == path)
        {
            let response = json!({"workspace": existing, "created": false});
            drop(state);
            return self
                .commit_control_mutation(
                    &rpc_id,
                    RpcMethod::WorkspaceCreate,
                    payload,
                    Vec::new(),
                    response,
                )
                .await;
        }
        let id = self.mint_id("workspace");
        let now = iso_now();
        let title = Path::new(&path)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or(&path)
            .to_owned();
        let workspace = WorkspaceRecord {
            workspace_id: id.clone(),
            path,
            title,
            session_ids: Vec::new(),
            created_at: now.clone(),
            updated_at: now,
        };
        let mut order = state.workspace_order.clone();
        order.push(id);
        drop(state);
        let response = json!({"workspace": workspace, "created": true});
        let response = self
            .commit_control_mutation(
                &rpc_id,
                RpcMethod::WorkspaceCreate,
                payload,
                vec![
                    ControlEvent::WorkspaceDefined {
                        workspace: workspace_snapshot(&workspace),
                    },
                    ControlEvent::WorkspaceOrderSet {
                        workspace_ids: order,
                    },
                ],
                response,
            )
            .await?;
        self.push_host(json!({"type": "host/workspace-changed", "workspace": workspace}));
        Ok(response)
    }

    async fn workspace_rename(&self, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
        let _control_guard = self.control_gate.lock().await;
        if let Some(response) = self
            .replay_control_receipt(&rpc_id, RpcMethod::WorkspaceRename, payload)
            .await?
        {
            return Ok(response);
        }
        let id = required_string(payload, "workspaceId")?;
        let title = required_string(payload, "title")?.trim().to_owned();
        if title.is_empty() {
            return Err(bad_request("workspace title must not be blank"));
        }
        let state = self.state.read().await;
        let mut workspace = state
            .workspaces
            .get(&id)
            .cloned()
            .ok_or_else(|| workspace_not_found(&id))?;
        workspace.title = title;
        workspace.updated_at = iso_now();
        let value = serde_json::to_value(&workspace)
            .map_err(|error| RpcError::internal(error.to_string()))?;
        drop(state);
        let response = self
            .commit_control_mutation(
                &rpc_id,
                RpcMethod::WorkspaceRename,
                payload,
                vec![ControlEvent::WorkspaceDefined {
                    workspace: workspace_snapshot(&workspace),
                }],
                json!({"workspace": value}),
            )
            .await?;
        self.push_host(json!({"type": "host/workspace-changed", "workspace": value}));
        Ok(response)
    }

    async fn workspace_delete(&self, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
        let _control_guard = self.control_gate.lock().await;
        if let Some(response) = self
            .replay_control_receipt(&rpc_id, RpcMethod::WorkspaceDelete, payload)
            .await?
        {
            return Ok(response);
        }
        let id = required_string(payload, "workspaceId")?;
        let state = self.state.read().await;
        if !state.workspaces.contains_key(&id) {
            return Err(workspace_not_found(&id));
        }
        let order = state
            .workspace_order
            .iter()
            .filter(|candidate| *candidate != &id)
            .cloned()
            .collect::<Vec<_>>();
        drop(state);
        let response = self
            .commit_control_mutation(
                &rpc_id,
                RpcMethod::WorkspaceDelete,
                payload,
                vec![
                    ControlEvent::WorkspaceRemoved {
                        workspace_id: id.clone(),
                    },
                    ControlEvent::WorkspaceOrderSet {
                        workspace_ids: order.clone(),
                    },
                ],
                json!({"deleted": true}),
            )
            .await?;
        self.push_host(json!({"type": "host/workspace-removed", "workspaceId": id}));
        self.push_host(json!({
            "type": "host/workspace-order-changed",
            "workspaceIds": order,
        }));
        Ok(response)
    }

    async fn workspace_insert_before(
        &self,
        rpc_id: RpcId,
        payload: &Value,
    ) -> Result<Value, RpcError> {
        let _control_guard = self.control_gate.lock().await;
        if let Some(response) = self
            .replay_control_receipt(&rpc_id, RpcMethod::WorkspaceInsertBefore, payload)
            .await?
        {
            return Ok(response);
        }
        let id = required_string(payload, "workspaceId")?;
        let before = optional_string(payload, "beforeWorkspaceId")?;
        let state = self.state.read().await;
        if !state.workspaces.contains_key(&id) {
            return Err(workspace_not_found(&id));
        }
        if let Some(before) = &before {
            if before == &id || !state.workspaces.contains_key(before) {
                return Err(rpc_error(
                    RpcErrorCode::WorkspaceMoveInvalid,
                    "workspace move anchor is invalid",
                    json!({"workspaceId": id, "beforeWorkspaceId": before}),
                ));
            }
        }
        let mut order = state
            .workspace_order
            .iter()
            .filter(|candidate| *candidate != &id)
            .cloned()
            .collect::<Vec<_>>();
        let index = before
            .as_ref()
            .and_then(|anchor| order.iter().position(|candidate| candidate == anchor))
            .unwrap_or(order.len());
        order.insert(index, id);
        drop(state);
        let response = self
            .commit_control_mutation(
                &rpc_id,
                RpcMethod::WorkspaceInsertBefore,
                payload,
                vec![ControlEvent::WorkspaceOrderSet {
                    workspace_ids: order.clone(),
                }],
                json!({"workspaceIds": order}),
            )
            .await?;
        self.push_host(json!({
            "type": "host/workspace-order-changed",
            "workspaceIds": order,
        }));
        Ok(response)
    }

    async fn workspace_insert_session_before(
        &self,
        rpc_id: RpcId,
        payload: &Value,
    ) -> Result<Value, RpcError> {
        let _control_guard = self.control_gate.lock().await;
        if let Some(response) = self
            .replay_control_receipt(&rpc_id, RpcMethod::WorkspaceInsertSessionBefore, payload)
            .await?
        {
            return Ok(response);
        }
        let workspace_id = required_string(payload, "workspaceId")?;
        let session_id = required_string(payload, "sessionId")?;
        let before = optional_string(payload, "beforeSessionId")?;
        let state = self.state.read().await;
        if !state.sessions.contains_key(&session_id) {
            return Err(session_not_found(&session_id));
        }
        let mut workspace = state
            .workspaces
            .get(&workspace_id)
            .cloned()
            .ok_or_else(|| workspace_not_found(&workspace_id))?;
        if let Some(before) = &before {
            if before == &session_id || !workspace.session_ids.contains(before) {
                return Err(rpc_error(
                    RpcErrorCode::WorkspaceMoveInvalid,
                    "session move anchor is invalid",
                    json!({"workspaceId": workspace_id, "sessionId": session_id}),
                ));
            }
        }
        workspace
            .session_ids
            .retain(|candidate| candidate != &session_id);
        let index = before
            .as_ref()
            .and_then(|anchor| {
                workspace
                    .session_ids
                    .iter()
                    .position(|candidate| candidate == anchor)
            })
            .unwrap_or(workspace.session_ids.len());
        workspace.session_ids.insert(index, session_id);
        workspace.updated_at = iso_now();
        let value = serde_json::to_value(&workspace)
            .map_err(|error| RpcError::internal(error.to_string()))?;
        drop(state);
        let response = self
            .commit_control_mutation(
                &rpc_id,
                RpcMethod::WorkspaceInsertSessionBefore,
                payload,
                vec![ControlEvent::WorkspaceDefined {
                    workspace: workspace_snapshot(&workspace),
                }],
                json!({"workspace": value}),
            )
            .await?;
        self.push_host(json!({"type": "host/workspace-changed", "workspace": value}));
        Ok(response)
    }

    async fn workspace_archive_session(
        &self,
        rpc_id: RpcId,
        payload: &Value,
    ) -> Result<Value, RpcError> {
        let _control_guard = self.control_gate.lock().await;
        if let Some(response) = self
            .replay_control_receipt(&rpc_id, RpcMethod::WorkspaceArchiveSession, payload)
            .await?
        {
            return Ok(response);
        }
        let session_id = required_string(payload, "sessionId")?;
        let state = self.state.read().await;
        if !state.sessions.contains_key(&session_id) {
            return Err(session_not_found(&session_id));
        }
        let mut archived = state.archived_sessions.clone();
        archived.insert(session_id);
        drop(state);
        let archived_ids = archived.iter().cloned().collect::<Vec<_>>();
        let response = self
            .commit_control_mutation(
                &rpc_id,
                RpcMethod::WorkspaceArchiveSession,
                payload,
                vec![ControlEvent::ArchivedSessionsSet {
                    session_ids: archived_ids,
                }],
                json!({"archivedSessionIds": archived}),
            )
            .await?;
        self.push_host(json!({
            "type": "host/archived-sessions-changed",
            "archivedSessionIds": archived,
        }));
        Ok(response)
    }

    async fn skill_list(&self, payload: &Value) -> Result<Value, RpcError> {
        let session_id = required_string(payload, "sessionId")?;
        if !self.state.read().await.sessions.contains_key(&session_id) {
            return Err(session_not_found(&session_id));
        }
        Ok(json!({
            "skills": [{
                "name": "coding",
                "description": "Inspect and modify a local workspace with XHarness coding tools.",
                "whenToUse": "Use for software development, debugging, testing, and repository maintenance.",
                "modelInvocable": true,
            }],
        }))
    }

    async fn agent_preset_list(&self, payload: &Value) -> Result<Value, RpcError> {
        require_object(payload)?;
        let state = self.state.read().await;
        Ok(json!({
            "presets": state.presets.values().collect::<Vec<_>>(),
            "authorable": true,
            "hasDocument": false,
        }))
    }

    async fn agent_preset_select(&self, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
        let session_id = required_string(payload, "sessionId")?;
        let preset = nonempty(required_string(payload, "agentPreset")?, "agentPreset")?;
        let _session_guard = self.lock_admission(&session_id).await;
        if let Some(response) = self
            .replay_session_mutation_receipt(
                &session_id,
                &rpc_id,
                RpcMethod::AgentPresetSelect,
                payload,
            )
            .await?
        {
            return Ok(response);
        }
        {
            let state = self.state.read().await;
            if !state.presets.contains_key(&preset) {
                return Err(preset_not_found(&preset));
            }
            let session = state
                .sessions
                .get(&session_id)
                .ok_or_else(|| session_not_found(&session_id))?;
            if session.running {
                return Err(rpc_error(
                    RpcErrorCode::AgentBusy,
                    "cannot switch presets while the session is running",
                    json!({"reason": "session-running"}),
                ));
            }
        }
        let response = json!({"agentPreset": preset});
        self.commit_session_mutation(
            &session_id,
            &rpc_id,
            RpcMethod::AgentPresetSelect,
            payload,
            vec![SessionEventData::AgentPresetSelected {
                agent_preset: preset.clone(),
            }
            .into()],
            SessionMutationResponse::fixed(response.clone()),
        )
        .await?;
        self.state
            .write()
            .await
            .sessions
            .get_mut(&session_id)
            .ok_or_else(|| session_not_found(&session_id))?
            .agent_preset = Some(preset.clone());
        Ok(response)
    }

    async fn agent_preset_read(&self, payload: &Value) -> Result<Value, RpcError> {
        let id = required_string(payload, "agentPreset")?;
        let state = self.state.read().await;
        let preset = state
            .presets
            .get(&id)
            .ok_or_else(|| preset_not_found(&id))?;
        Ok(json!({
            "agentPreset": preset.id,
            "trust": preset.trust,
            "content": preset.content,
            "name": preset.name,
            "description": preset.description,
        }))
    }

    async fn agent_preset_copy(&self, payload: &Value) -> Result<Value, RpcError> {
        let from = required_string(payload, "from")?;
        let id = nonempty(required_string(payload, "agentPreset")?, "agentPreset")?;
        let name = optional_string(payload, "name")?;
        let mut state = self.state.write().await;
        let source = state
            .presets
            .get(&from)
            .cloned()
            .ok_or_else(|| preset_not_found(&from))?;
        if state.presets.contains_key(&id) {
            return Err(rpc_error(
                RpcErrorCode::AgentPresetConflict,
                "agent preset id already exists",
                json!({"agentPreset": id}),
            ));
        }
        state.presets.insert(
            id.clone(),
            AgentPreset {
                id: id.clone(),
                trust: "user".to_owned(),
                is_default: false,
                name: name.or(source.name),
                description: source.description,
                content: source.content,
            },
        );
        Ok(json!({"agentPreset": id}))
    }

    async fn agent_preset_open_document(&self, payload: &Value) -> Result<Value, RpcError> {
        let id = required_string(payload, "agentPreset")?;
        if !self.state.read().await.presets.contains_key(&id) {
            return Err(preset_not_found(&id));
        }
        Ok(json!({"opened": false, "path": ""}))
    }

    async fn agent_preset_remove(&self, payload: &Value) -> Result<Value, RpcError> {
        let id = required_string(payload, "agentPreset")?;
        let mut state = self.state.write().await;
        let preset = state
            .presets
            .get(&id)
            .ok_or_else(|| preset_not_found(&id))?;
        if preset.trust == "system" {
            return Err(rpc_error(
                RpcErrorCode::AgentPresetReadOnly,
                "system agent presets cannot be removed",
                json!({"agentPreset": id, "reason": "system preset"}),
            ));
        }
        state.presets.remove(&id);
        Ok(json!({}))
    }

    async fn goal_create(&self, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
        let session_id = required_string(payload, "sessionId")?;
        let objective = nonempty(required_string(payload, "objective")?, "objective")?;
        let max_goal_rounds = optional_u64(payload, "maxGoalRounds")?.unwrap_or(256);
        if max_goal_rounds == 0 {
            return Err(bad_request("maxGoalRounds must be positive"));
        }
        let _session_guard = self.lock_admission(&session_id).await;
        if let Some(response) = self
            .replay_session_mutation_receipt(&session_id, &rpc_id, RpcMethod::GoalCreate, payload)
            .await?
        {
            return Ok(response);
        }
        {
            let state = self.state.read().await;
            if !state.sessions.contains_key(&session_id) {
                return Err(session_not_found(&session_id));
            }
            if state
                .goals
                .get(&session_id)
                .is_some_and(|goal| goal.phase != GoalPhase::Complete)
            {
                return Err(bad_request("session already has a non-complete goal"));
            }
        }
        let now = now_ms();
        let goal = GoalState {
            id: self.mint_id("goal"),
            revision: 1,
            objective,
            max_goal_rounds,
            phase: GoalPhase::Active,
            blocked_reason: None,
            rounds_started: 0,
            created_at: now,
            updated_at: now,
        };
        let response = json!({"ref": {"id": goal.id.clone(), "revision": goal.revision}});
        self.commit_session_mutation(
            &session_id,
            &rpc_id,
            RpcMethod::GoalCreate,
            payload,
            vec![goal_snapshot_event(&goal, GoalSnapshotOperation::Create)],
            SessionMutationResponse::fixed(response.clone()),
        )
        .await?;
        {
            let mut state = self.state.write().await;
            state
                .sessions
                .get_mut(&session_id)
                .ok_or_else(|| session_not_found(&session_id))?
                .goal = Some(goal.clone());
            state.goals.insert(session_id.clone(), goal.clone());
        }
        self.push_projection(&session_id, "goal", goal.projection())
            .await;
        Ok(response)
    }

    async fn goal_edit(&self, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
        let session_id = required_string(payload, "sessionId")?;
        let objective = optional_string(payload, "objective")?;
        let max_goal_rounds = optional_u64(payload, "maxGoalRounds")?;
        if objective.is_none() && max_goal_rounds.is_none() {
            return Err(bad_request("goal.edit requires objective or maxGoalRounds"));
        }
        let expected = goal_ref(payload)?;
        let _session_guard = self.lock_admission(&session_id).await;
        if let Some(response) = self
            .replay_session_mutation_receipt(&session_id, &rpc_id, RpcMethod::GoalEdit, payload)
            .await?
        {
            return Ok(response);
        }
        let mut goal = self
            .state
            .read()
            .await
            .goals
            .get(&session_id)
            .cloned()
            .ok_or_else(|| {
                rpc_error(
                    RpcErrorCode::BadRequest,
                    "session has no active goal",
                    json!({"issues": []}),
                )
            })?;
        require_goal_ref(&goal, &expected)?;
        if let Some(objective) = objective {
            goal.objective = nonempty(objective, "objective")?;
        }
        if let Some(rounds) = max_goal_rounds {
            if rounds == 0 {
                return Err(bad_request("maxGoalRounds must be positive"));
            }
            goal.max_goal_rounds = rounds;
        }
        goal.revision = goal.revision.saturating_add(1);
        goal.updated_at = now_ms().max(goal.updated_at);
        let response = json!({"ref": {"id": goal.id.clone(), "revision": goal.revision}});
        self.commit_session_mutation(
            &session_id,
            &rpc_id,
            RpcMethod::GoalEdit,
            payload,
            vec![goal_snapshot_event(&goal, GoalSnapshotOperation::Edit)],
            SessionMutationResponse::fixed(response.clone()),
        )
        .await?;
        {
            let mut state = self.state.write().await;
            state
                .sessions
                .get_mut(&session_id)
                .ok_or_else(|| session_not_found(&session_id))?
                .goal = Some(goal.clone());
            state.goals.insert(session_id.clone(), goal.clone());
        }
        self.push_projection(&session_id, "goal", goal.projection())
            .await;
        Ok(response)
    }

    async fn goal_transition(
        &self,
        rpc_id: RpcId,
        payload: &Value,
        transition: &str,
    ) -> Result<Value, RpcError> {
        let session_id = required_string(payload, "sessionId")?;
        let expected = goal_ref(payload)?;
        let _session_guard = self.lock_admission(&session_id).await;
        let method = match transition {
            "paused" => RpcMethod::GoalPause,
            "active" => RpcMethod::GoalResume,
            "complete" => RpcMethod::GoalComplete,
            _ => return Err(RpcError::internal("unknown goal transition")),
        };
        if let Some(response) = self
            .replay_session_mutation_receipt(&session_id, &rpc_id, method, payload)
            .await?
        {
            return Ok(response);
        }
        let mut goal = self
            .state
            .read()
            .await
            .goals
            .get(&session_id)
            .cloned()
            .ok_or_else(|| bad_request("session has no goal"))?;
        require_goal_ref(&goal, &expected)?;
        let (operation, phase, valid) = match transition {
            "paused" => (
                GoalSnapshotOperation::Pause,
                GoalPhase::Paused,
                goal.phase == GoalPhase::Active,
            ),
            "active" => (
                GoalSnapshotOperation::Resume,
                GoalPhase::Active,
                matches!(
                    goal.phase,
                    GoalPhase::Active | GoalPhase::Paused | GoalPhase::Blocked
                ) && goal.rounds_started < goal.max_goal_rounds,
            ),
            "complete" => (
                GoalSnapshotOperation::Complete,
                GoalPhase::Complete,
                goal.phase != GoalPhase::Complete,
            ),
            _ => unreachable!("transition was validated above"),
        };
        if !valid {
            return Err(bad_request(format!(
                "cannot {transition} goal from phase {:?}",
                goal.phase
            )));
        }
        goal.phase = phase;
        goal.blocked_reason = None;
        goal.revision = goal.revision.saturating_add(1);
        goal.updated_at = now_ms().max(goal.updated_at);
        let response = json!({"ref": {"id": goal.id.clone(), "revision": goal.revision}});
        self.commit_session_mutation(
            &session_id,
            &rpc_id,
            method,
            payload,
            vec![goal_snapshot_event(&goal, operation)],
            SessionMutationResponse::fixed(response.clone()),
        )
        .await?;
        {
            let mut state = self.state.write().await;
            state
                .sessions
                .get_mut(&session_id)
                .ok_or_else(|| session_not_found(&session_id))?
                .goal = Some(goal.clone());
            state.goals.insert(session_id.clone(), goal.clone());
        }
        self.push_projection(&session_id, "goal", goal.projection())
            .await;
        Ok(response)
    }

    async fn goal_clear(&self, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
        let session_id = required_string(payload, "sessionId")?;
        let expected = goal_ref(payload)?;
        let _session_guard = self.lock_admission(&session_id).await;
        if let Some(response) = self
            .replay_session_mutation_receipt(&session_id, &rpc_id, RpcMethod::GoalClear, payload)
            .await?
        {
            return Ok(response);
        }
        let goal = self
            .state
            .read()
            .await
            .goals
            .get(&session_id)
            .cloned()
            .ok_or_else(|| bad_request("session has no goal"))?;
        require_goal_ref(&goal, &expected)?;
        let cleared = DurableGoalRef {
            id: goal.id.clone(),
            revision: goal.revision.saturating_add(1),
        };
        let response = json!({"cleared": true});
        self.commit_session_mutation(
            &session_id,
            &rpc_id,
            RpcMethod::GoalClear,
            payload,
            vec![SessionEventData::GoalChange {
                change: SessionGoalChange::Clear(GoalClearChange {
                    kind: GoalChangeKind::GoalChange,
                    version: 1,
                    operation: GoalClearOperation::Clear,
                    cleared,
                    cleared_at: now_ms().max(goal.updated_at),
                }),
            }
            .into()],
            SessionMutationResponse::fixed(response.clone()),
        )
        .await?;
        {
            let mut state = self.state.write().await;
            state
                .sessions
                .get_mut(&session_id)
                .ok_or_else(|| session_not_found(&session_id))?
                .goal = None;
            state.goals.remove(&session_id);
        }
        self.push_projection(&session_id, "goal", Value::Null).await;
        Ok(response)
    }

    async fn settings_describe(&self, payload: &Value) -> Result<Value, RpcError> {
        require_object(payload)?;
        let state = self.state.read().await;
        Ok(json!({
            "writable": true,
            "hasDocument": false,
            "namespaces": state.settings.values().map(SettingsNamespace::view).collect::<Vec<_>>(),
        }))
    }

    async fn settings_open_document(&self, payload: &Value) -> Result<Value, RpcError> {
        require_object(payload)?;
        Ok(json!({"opened": true}))
    }

    async fn settings_update(&self, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
        let _control_guard = self.control_gate.lock().await;
        if let Some(response) = self
            .replay_control_receipt(&rpc_id, RpcMethod::SettingsUpdate, payload)
            .await?
        {
            return Ok(response);
        }
        let ns = nonempty(required_string(payload, "ns")?, "ns")?;
        let patch = payload
            .get("patch")
            .and_then(Value::as_object)
            .ok_or_else(|| bad_request("patch must be an object"))?
            .clone();
        let expected = optional_u64(payload, "expectedRevision")?;
        if ns == "permission" {
            validate_permission_patch(&patch)?;
        }
        let state = self.state.read().await;
        let mut namespace = state
            .settings
            .get(&ns)
            .cloned()
            .ok_or_else(|| settings_rejected(&ns))?;
        check_revision(&namespace, expected)?;
        merge_object(&mut namespace.user, &Value::Object(patch));
        merge_object(&mut namespace.value, &namespace.user);
        namespace.revision = namespace.revision.saturating_add(1);
        let view = namespace.view();
        drop(state);
        let view = self
            .commit_control_mutation(
                &rpc_id,
                RpcMethod::SettingsUpdate,
                payload,
                vec![ControlEvent::SettingsSet {
                    settings: settings_snapshot(&namespace),
                }],
                view,
            )
            .await?;
        self.push_host(json!({
            "type": "host/remote-event",
            "event": "settings/document-updated",
            "args": [ns],
        }));
        Ok(view)
    }

    async fn settings_replace(&self, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
        let _control_guard = self.control_gate.lock().await;
        if let Some(response) = self
            .replay_control_receipt(&rpc_id, RpcMethod::SettingsReplace, payload)
            .await?
        {
            return Ok(response);
        }
        let ns = nonempty(required_string(payload, "ns")?, "ns")?;
        let section = payload
            .get("section")
            .and_then(Value::as_object)
            .ok_or_else(|| bad_request("section must be an object"))?
            .clone();
        let expected = optional_u64(payload, "expectedRevision")?;
        if ns == "permission" {
            validate_permission_section(&section)?;
        }
        let state = self.state.read().await;
        let mut namespace = state
            .settings
            .get(&ns)
            .cloned()
            .ok_or_else(|| settings_rejected(&ns))?;
        check_revision(&namespace, expected)?;
        namespace.user = Value::Object(section.clone());
        namespace.value = Value::Object(section);
        namespace.revision = namespace.revision.saturating_add(1);
        let view = namespace.view();
        drop(state);
        let view = self
            .commit_control_mutation(
                &rpc_id,
                RpcMethod::SettingsReplace,
                payload,
                vec![ControlEvent::SettingsSet {
                    settings: settings_snapshot(&namespace),
                }],
                view,
            )
            .await?;
        self.push_host(json!({
            "type": "host/remote-event",
            "event": "settings/document-updated",
            "args": [ns],
        }));
        Ok(view)
    }

    async fn settings_mutate(&self, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
        let _control_guard = self.control_gate.lock().await;
        if let Some(response) = self
            .replay_control_receipt(&rpc_id, RpcMethod::SettingsMutate, payload)
            .await?
        {
            return Ok(response);
        }
        let ns = nonempty(required_string(payload, "ns")?, "ns")?;
        let ops = required_array(payload, "ops")?.clone();
        let expected = optional_u64(payload, "expectedRevision")?;
        let state = self.state.read().await;
        let mut namespace = state
            .settings
            .get(&ns)
            .cloned()
            .ok_or_else(|| settings_rejected(&ns))?;
        check_revision(&namespace, expected)?;
        for op in ops {
            let kind = op
                .get("op")
                .and_then(Value::as_str)
                .ok_or_else(|| bad_request("settings op requires op"))?;
            let path = op
                .get("path")
                .and_then(Value::as_array)
                .ok_or_else(|| bad_request("settings op requires path"))?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(ToOwned::to_owned)
                        .ok_or_else(|| bad_request("settings path entries must be strings"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            match kind {
                "set" => {
                    let value = op.get("value").cloned().unwrap_or(Value::Null);
                    if ns == "permission" {
                        if path.as_slice() != ["defaultPreset"] {
                            return Err(settings_rejected(&ns));
                        }
                        validate_permission_value(&value)?;
                    }
                    set_json_path(&mut namespace.user, &path, value)?
                }
                "unset" => {
                    if ns == "permission" {
                        return Err(settings_rejected(&ns));
                    }
                    unset_json_path(&mut namespace.user, &path)?
                }
                _ => return Err(bad_request("settings op must be set or unset")),
            }
        }
        namespace.value = namespace.user.clone();
        namespace.revision = namespace.revision.saturating_add(1);
        let view = namespace.view();
        drop(state);
        let view = self
            .commit_control_mutation(
                &rpc_id,
                RpcMethod::SettingsMutate,
                payload,
                vec![ControlEvent::SettingsSet {
                    settings: settings_snapshot(&namespace),
                }],
                view,
            )
            .await?;
        self.push_host(json!({
            "type": "host/remote-event",
            "event": "settings/document-updated",
            "args": [ns],
        }));
        Ok(view)
    }

    async fn credentials_describe(&self, payload: &Value) -> Result<Value, RpcError> {
        let refs = required_array(payload, "refs")?;
        if refs.len() > 64 {
            return Err(bad_request("at most 64 credential references are accepted"));
        }
        let state = self.state.read().await;
        let mut credentials = Map::new();
        for reference in refs {
            let reference = reference
                .as_str()
                .ok_or_else(|| bad_request("credential references must be strings"))?;
            validate_credential_ref(reference)?;
            let env = std::env::var_os(reference).is_some_and(|value| !value.is_empty());
            let file = state.credentials.contains_key(reference);
            credentials.insert(
                reference.to_owned(),
                json!({
                    "configured": env || file,
                    "source": if env { Some("env") } else if file { Some("memory") } else { None },
                    "writable": !env,
                }),
            );
        }
        Ok(json!({"credentials": credentials}))
    }

    async fn credentials_set(&self, payload: &Value) -> Result<Value, RpcError> {
        let reference = required_string(payload, "ref")?;
        validate_credential_ref(&reference)?;
        let value = nonempty(required_string(payload, "value")?, "value")?;
        if std::env::var_os(&reference).is_some_and(|value| !value.is_empty()) {
            return Err(credential_rejected(&reference));
        }
        self.state
            .write()
            .await
            .credentials
            .insert(reference, value);
        Ok(json!({}))
    }

    async fn credentials_unset(&self, payload: &Value) -> Result<Value, RpcError> {
        let reference = required_string(payload, "ref")?;
        validate_credential_ref(&reference)?;
        if std::env::var_os(&reference).is_some_and(|value| !value.is_empty()) {
            return Err(credential_rejected(&reference));
        }
        self.state.write().await.credentials.remove(&reference);
        Ok(json!({}))
    }

    async fn llm_providers(&self, payload: &Value) -> Result<Value, RpcError> {
        require_object(payload)?;
        let mut providers = Vec::new();
        for model in self.agent_runtime.model_catalog() {
            if providers.iter().any(|provider: &Value| {
                provider.get("provider").and_then(Value::as_str) == Some(&model.provider)
            }) {
                continue;
            }
            providers.push(json!({
                "provider": model.provider,
                "displayName": model.provider_display_name,
                "settingsNs": "xharness",
                "settingsPath": [],
                "active": true,
                "declared": true,
            }));
        }
        Ok(json!({"providers": providers}))
    }

    async fn llm_models(&self, payload: &Value) -> Result<Value, RpcError> {
        require_object(payload)?;
        Ok(json!({"groups": self.model_groups(), "failures": []}))
    }

    async fn llm_discover_models(&self, payload: &Value) -> Result<Value, RpcError> {
        nonempty(required_string(payload, "settingsNs")?, "settingsNs")?;
        let models = self
            .agent_runtime
            .model_catalog()
            .into_iter()
            .map(|model| {
                json!({
                    "id": model.model,
                    "name": model.model_display_name,
                    "provider": model.provider,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({"models": models}))
    }

    fn model_groups(&self) -> Vec<Value> {
        let mut groups: Vec<(String, String, Vec<Value>)> = Vec::new();
        for model in self.agent_runtime.model_catalog() {
            if let Some((_, _, models)) = groups
                .iter_mut()
                .find(|(provider, _, _)| provider == &model.provider)
            {
                models.push(json!({"id": model.model, "name": model.model_display_name}));
            } else {
                groups.push((
                    model.provider,
                    model.provider_display_name,
                    vec![json!({"id": model.model, "name": model.model_display_name})],
                ));
            }
        }
        groups
            .into_iter()
            .map(|(id, name, models)| json!({"id": id, "name": name, "models": models}))
            .collect()
    }

    async fn respond_pending(&self, response: ClientResponse) -> RpcReceipt {
        let rpc_id = response.rpc_id.as_str().to_owned();
        let pending = self.state.read().await.pending.get(&rpc_id).cloned();
        let Some(pending) = pending else {
            return RpcReceipt::Rejected {
                reason: ReceiptRejection::NotPending,
            };
        };
        match pending {
            PendingResponse::Approval {
                session_id,
                approval_id,
                call_id,
                tool_name: _,
                control,
            } => {
                let value = match response.result {
                    RpcResult::Success { value: Some(value) } => value,
                    _ => {
                        return RpcReceipt::Rejected {
                            reason: ReceiptRejection::BadResponse,
                        };
                    }
                };
                if value.get("sessionId").and_then(Value::as_str) != Some(&session_id)
                    || value.get("approvalId").and_then(Value::as_str) != Some(&approval_id)
                {
                    return RpcReceipt::Rejected {
                        reason: ReceiptRejection::BadResponse,
                    };
                }
                let command = match value.get("outcome").and_then(Value::as_str) {
                    Some("allowed-once") => LoopCommand::ApproveTool {
                        call_id: call_id.clone(),
                    },
                    Some("rejected") => LoopCommand::RejectTool {
                        call_id: call_id.clone(),
                        reason: "rejected by user".to_owned(),
                    },
                    _ => {
                        return RpcReceipt::Rejected {
                            reason: ReceiptRejection::BadResponse,
                        };
                    }
                };
                let (acknowledgement, accepted) = oneshot::channel();
                if control
                    .send(DriverCommand {
                        command,
                        input_metadata: None,
                        acknowledgement,
                    })
                    .await
                    .is_err()
                    || !matches!(accepted.await, Ok(Ok(())))
                {
                    return RpcReceipt::Rejected {
                        reason: ReceiptRejection::NotPending,
                    };
                }
                self.state.write().await.pending.remove(&rpc_id);
                RpcReceipt::Accepted
            }
        }
    }
}

pub(crate) fn prompt_fingerprint(
    mode: &str,
    content: &[Value],
    client_time_zone: Option<&str>,
) -> String {
    let canonical = json!({
        "version": 1,
        "mode": mode,
        "content": content,
        "clientTimeZone": client_time_zone,
    });
    let encoded = serde_json::to_vec(&canonical).expect("JSON value serialization cannot fail");
    let digest = Sha256::digest(encoded);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(64);
    for byte in digest {
        output.push(HEX[usize::from(byte >> 4)] as char);
        output.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    output
}

fn require_object(value: &Value) -> Result<&Map<String, Value>, RpcError> {
    value
        .as_object()
        .ok_or_else(|| bad_request("payload must be a JSON object"))
}

fn required_string(value: &Value, field: &str) -> Result<String, RpcError> {
    require_object(value)?
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| bad_request(format!("{field} must be a non-empty string")))
}

fn optional_string(value: &Value, field: &str) -> Result<Option<String>, RpcError> {
    match require_object(value)?.get(field) {
        None => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
        Some(_) => Err(bad_request(format!(
            "{field}, when present, must be a non-empty string"
        ))),
    }
}

fn optional_u64(value: &Value, field: &str) -> Result<Option<u64>, RpcError> {
    match require_object(value)?.get(field) {
        None => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| bad_request(format!("{field} must be a non-negative integer"))),
    }
}

fn required_array<'a>(value: &'a Value, field: &str) -> Result<&'a Vec<Value>, RpcError> {
    require_object(value)?
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| bad_request(format!("{field} must be an array")))
}

fn nonempty(value: String, field: &str) -> Result<String, RpcError> {
    if value.trim().is_empty() {
        Err(bad_request(format!("{field} must not be blank")))
    } else {
        Ok(value)
    }
}

fn bad_request(message: impl Into<String>) -> RpcError {
    RpcError::bad_request(message, json!([]))
}

fn session_not_found(session_id: &str) -> RpcError {
    rpc_error(
        RpcErrorCode::SessionNotFound,
        format!("session {session_id:?} was not found"),
        json!({"sessionId": session_id}),
    )
}

fn workspace_not_found(workspace_id: &str) -> RpcError {
    rpc_error(
        RpcErrorCode::WorkspaceNotFound,
        format!("workspace {workspace_id:?} was not found"),
        json!({"workspaceId": workspace_id}),
    )
}

fn preset_not_found(preset: &str) -> RpcError {
    rpc_error(
        RpcErrorCode::AgentPresetNotFound,
        format!("agent preset {preset:?} was not found"),
        json!({"agentPreset": preset}),
    )
}

fn validate_permission_value(value: &Value) -> Result<(), RpcError> {
    let Some(value) = value.as_str() else {
        return Err(settings_rejected("permission"));
    };
    if crate::PermissionPreset::parse(value).is_none() {
        return Err(settings_rejected("permission"));
    }
    Ok(())
}

fn validate_permission_patch(patch: &Map<String, Value>) -> Result<(), RpcError> {
    if patch.keys().any(|key| key != "defaultPreset") {
        return Err(settings_rejected("permission"));
    }
    if let Some(value) = patch.get("defaultPreset") {
        validate_permission_value(value)?;
    }
    Ok(())
}

fn validate_permission_section(section: &Map<String, Value>) -> Result<(), RpcError> {
    if section.len() != 1 {
        return Err(settings_rejected("permission"));
    }
    validate_permission_value(
        section
            .get("defaultPreset")
            .ok_or_else(|| settings_rejected("permission"))?,
    )
}

fn settings_rejected(ns: &str) -> RpcError {
    rpc_error(
        RpcErrorCode::SettingsRejected,
        format!("settings namespace {ns:?} is unavailable"),
        json!({"ns": ns}),
    )
}

fn credential_rejected(reference: &str) -> RpcError {
    rpc_error(
        RpcErrorCode::CredentialRejected,
        "an environment credential shadows this reference",
        json!({"ref": reference}),
    )
}

fn canonical_directory(path: &str) -> Result<String, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| format!("could not resolve directory {path:?}: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("path {path:?} is not a directory"));
    }
    Ok(canonical.to_string_lossy().into_owned())
}

fn breadcrumb_entries(path: &Path) -> Vec<Value> {
    let mut current = PathBuf::new();
    path.components()
        .map(|component| {
            current.push(component.as_os_str());
            let display = current.to_string_lossy().into_owned();
            let name = component.as_os_str().to_string_lossy();
            json!({
                "name": if name.is_empty() { display.clone() } else { name.into_owned() },
                "path": display,
                "hidden": false,
            })
        })
        .collect()
}

fn truncate_chars(text: &str, max: usize) -> String {
    let mut output = text.chars().take(max).collect::<String>();
    if text.chars().count() > max {
        output.push('…');
    }
    output
}

fn visible_text(content: &[Value]) -> String {
    content
        .iter()
        .filter_map(|block| {
            (block.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| block.get("text").and_then(Value::as_str))
                .flatten()
        })
        .collect::<String>()
}

fn permission_command_input(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("/permission")?;
    if rest.is_empty() || matches!(rest.chars().next(), Some(' ' | '\t' | '\n' | '\r')) {
        Some(rest)
    } else {
        None
    }
}

fn plan_command_input(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("/plan")?;
    if rest.is_empty() || matches!(rest.chars().next(), Some(' ' | '\t' | '\n' | '\r')) {
        Some(rest)
    } else {
        None
    }
}

fn permission_events(preset: crate::PermissionPreset) -> Vec<SessionEvent> {
    vec![
        SessionEventData::PermissionPreset {
            preset: preset.as_str().to_owned(),
        }
        .into(),
        SessionEventData::SandboxMode {
            mode: match preset {
                crate::PermissionPreset::WorkspaceWrite => SessionSandboxMode::WorkspaceWrite,
                crate::PermissionPreset::DangerFullAccess => SessionSandboxMode::DangerFullAccess,
            },
            source: None,
        }
        .into(),
        SessionEventData::ApprovalPolicy {
            policy: match preset {
                crate::PermissionPreset::WorkspaceWrite => ApprovalPolicy::Ask,
                crate::PermissionPreset::DangerFullAccess => ApprovalPolicy::Never,
            },
            source: None,
        }
        .into(),
    ]
}

fn goal_snapshot_event(goal: &GoalState, operation: GoalSnapshotOperation) -> SessionEvent {
    SessionEventData::GoalChange {
        change: SessionGoalChange::Snapshot(GoalSnapshotChange {
            kind: GoalChangeKind::GoalChange,
            version: 1,
            operation,
            goal: goal.snapshot(),
            rounds_started: goal.rounds_started,
            created_at: goal.created_at,
            updated_at: goal.updated_at,
        }),
    }
    .into()
}

#[derive(Clone, Debug)]
struct GoalRef {
    id: String,
    revision: u64,
}

fn goal_ref(payload: &Value) -> Result<GoalRef, RpcError> {
    let reference = payload
        .get("ref")
        .and_then(Value::as_object)
        .ok_or_else(|| bad_request("ref must be an object"))?;
    let id = reference
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| bad_request("ref.id must be a string"))?;
    let revision = reference
        .get("revision")
        .and_then(Value::as_u64)
        .filter(|revision| *revision > 0)
        .ok_or_else(|| bad_request("ref.revision must be positive"))?;
    Ok(GoalRef { id, revision })
}

fn require_goal_ref(goal: &GoalState, expected: &GoalRef) -> Result<(), RpcError> {
    if goal.id != expected.id || goal.revision != expected.revision {
        return Err(bad_request("goal reference is stale or does not match"));
    }
    Ok(())
}

fn check_revision(namespace: &SettingsNamespace, expected: Option<u64>) -> Result<(), RpcError> {
    if let Some(expected) = expected {
        if namespace.revision != expected {
            return Err(rpc_error(
                RpcErrorCode::SettingsConflict,
                "settings revision does not match",
                json!({
                    "ns": namespace.ns,
                    "expected": expected,
                    "actual": namespace.revision,
                }),
            ));
        }
    }
    Ok(())
}

fn merge_object(target: &mut Value, patch: &Value) {
    let Some(patch) = patch.as_object() else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = json!({});
    }
    let target = target.as_object_mut().expect("initialized as object");
    for (key, value) in patch {
        match target.get_mut(key) {
            Some(existing) if existing.is_object() && value.is_object() => {
                merge_object(existing, value);
            }
            _ => {
                target.insert(key.clone(), value.clone());
            }
        }
    }
}

fn set_json_path(target: &mut Value, path: &[String], value: Value) -> Result<(), RpcError> {
    if path.is_empty() {
        *target = value;
        return Ok(());
    }
    if !target.is_object() {
        *target = json!({});
    }
    let mut cursor = target;
    for segment in &path[..path.len() - 1] {
        let object = cursor
            .as_object_mut()
            .ok_or_else(|| bad_request("settings path traverses a non-object"))?;
        cursor = object.entry(segment.clone()).or_insert_with(|| json!({}));
    }
    cursor
        .as_object_mut()
        .ok_or_else(|| bad_request("settings path parent is not an object"))?
        .insert(path.last().expect("non-empty path").clone(), value);
    Ok(())
}

fn unset_json_path(target: &mut Value, path: &[String]) -> Result<(), RpcError> {
    if path.is_empty() {
        *target = json!({});
        return Ok(());
    }
    let mut cursor = target;
    for segment in &path[..path.len() - 1] {
        let Some(next) = cursor
            .as_object_mut()
            .and_then(|object| object.get_mut(segment))
        else {
            return Ok(());
        };
        cursor = next;
    }
    if let Some(object) = cursor.as_object_mut() {
        object.remove(path.last().expect("non-empty path"));
    }
    Ok(())
}

fn validate_credential_ref(reference: &str) -> Result<(), RpcError> {
    let mut chars = reference.chars();
    let Some(first) = chars.next() else {
        return Err(bad_request("credential reference is empty"));
    };
    if !(first == '_' || first.is_ascii_alphabetic())
        || !chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
    {
        return Err(bad_request(
            "credential reference must match [A-Za-z_][A-Za-z0-9_]*",
        ));
    }
    Ok(())
}

fn queue_item_not_found(item_id: &str, error: AgentRuntimeError) -> RpcError {
    rpc_error(
        RpcErrorCode::QueueItemNotFound,
        "queued item is no longer pending",
        json!({"itemId": item_id, "reason": error.to_string()}),
    )
}

fn mint_stream_id(next_id: &AtomicU64, prefix: &str) -> String {
    let ordinal = next_id.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{ordinal}", now_ms())
}

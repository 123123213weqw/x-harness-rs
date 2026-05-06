use std::{
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
use xharness_core::LoopCommand;
use xharness_session::{
    ApprovalPolicy, CommandResultKind, CommandSource, EventData as SessionEventData, SessionEvent,
    SessionSandboxMode,
};

use crate::{
    driver::{agent_runtime_error, rpc_error},
    runtime::AgentRuntimeError,
    state::{now_ms, DriverCommand, PendingResponse},
    BasicHost,
};

mod credentials;
mod goal;
mod model;
mod preset;
mod session;
pub(crate) mod session_lifecycle;
mod settings;
mod subagent;
pub(crate) mod turn;
mod workspace;

const DEFAULT_HISTORY_MESSAGES: usize = 50;
const MAX_HISTORY_MESSAGES: usize = 500;
const MAX_DIRECTORY_ENTRIES: usize = 1_000;

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
            method @ (RpcMethod::SessionList
            | RpcMethod::SessionSearch
            | RpcMethod::SessionHistory
            | RpcMethod::SessionModels) => {
                session::call_read(self, method, &payload, &cancellation).await
            }
            RpcMethod::SessionCreate => session_lifecycle::create(self, &payload).await,
            RpcMethod::SessionSelectModel => {
                session_lifecycle::select_model(self, rpc_id, &payload).await
            }
            RpcMethod::SessionRename => session_lifecycle::rename(self, rpc_id, &payload).await,
            RpcMethod::SessionFork => session_lifecycle::fork(self, &payload).await,
            RpcMethod::SessionPrompt => turn::prompt(self, rpc_id, &payload).await,
            RpcMethod::SessionAttachment => turn::attachment(self, &payload).await,
            RpcMethod::SessionUpdateQueue => turn::update_queue(self, &payload).await,
            RpcMethod::SessionCancel => turn::cancel(self, &payload).await,
            method @ (RpcMethod::SubagentList
            | RpcMethod::SubagentHistory
            | RpcMethod::SubagentPrompt
            | RpcMethod::SubagentInterrupt) => subagent::call(self, rpc_id, method, &payload).await,
            RpcMethod::HostDescribe => self.host_describe(&payload).await,
            RpcMethod::HostPickDirectory => self.host_pick_directory(&payload).await,
            RpcMethod::HostListDirectory => self.host_list_directory(&payload).await,
            RpcMethod::HostCreateDirectory => self.host_create_directory(&payload).await,
            RpcMethod::HostOpenPath => self.host_open_path(&payload).await,
            method @ (RpcMethod::WorkspaceList
            | RpcMethod::WorkspaceCreate
            | RpcMethod::WorkspaceRename
            | RpcMethod::WorkspaceDelete
            | RpcMethod::WorkspaceInsertBefore
            | RpcMethod::WorkspaceInsertSessionBefore
            | RpcMethod::WorkspaceArchiveSession) => {
                workspace::call(self, rpc_id, method, &payload).await
            }
            RpcMethod::SkillList => self.skill_list(&payload).await,
            method @ (RpcMethod::AgentPresetList
            | RpcMethod::AgentPresetSelect
            | RpcMethod::AgentPresetRead
            | RpcMethod::AgentPresetCopy
            | RpcMethod::AgentPresetOpenDocument
            | RpcMethod::AgentPresetRemove) => preset::call(self, rpc_id, method, &payload).await,
            method @ (RpcMethod::GoalCreate
            | RpcMethod::GoalEdit
            | RpcMethod::GoalPause
            | RpcMethod::GoalResume
            | RpcMethod::GoalComplete
            | RpcMethod::GoalClear) => goal::call(self, rpc_id, method, &payload).await,
            method @ (RpcMethod::SettingsDescribe
            | RpcMethod::SettingsOpenDocument
            | RpcMethod::SettingsUpdate
            | RpcMethod::SettingsReplace
            | RpcMethod::SettingsMutate) => settings::call(self, rpc_id, method, &payload).await,
            method @ (RpcMethod::CredentialsDescribe
            | RpcMethod::CredentialsSet
            | RpcMethod::CredentialsUnset) => credentials::call(self, method, &payload).await,
            method @ (RpcMethod::LlmProviders
            | RpcMethod::LlmModels
            | RpcMethod::LlmDiscoverModels) => model::call(self, method, &payload).await,
        };
        match result {
            Ok(value) => RpcResult::success(value),
            Err(error) => RpcResult::failure(error),
        }
    }

    async fn call_dynamic(
        &self,
        rpc_id: RpcId,
        endpoint: &str,
        payload: Value,
        _cancellation: CancellationToken,
    ) -> Option<RpcResult> {
        let result = match endpoint {
            "session.requestSnapshot" => self.request_snapshot(&payload).await.map(Some),
            "commands/list" => self.commands_list(&payload).await.map(Some),
            "commands/execute" => self.commands_execute(&payload).await,
            // The shipped Web client mutates Goals through the upstream
            // namespaced remotes (`/api/goals/*`). Map them onto the flat
            // methods above so every GoalBar action works instead of 404ing.
            // The other upstream namespaces stay unmounted on purpose.
            "goals/create" | "goals/edit" | "goals/pause" | "goals/resume" | "goals/complete"
            | "goals/clear" => goal::remote(self, rpc_id, endpoint, &payload)
                .await
                .map(Some),
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
        let mut receiver = self.event_gateway.subscribe_mux();
        let mut question_receiver = self.questions.subscribe();
        let state = Arc::clone(&self.state);
        let next_id = Arc::clone(&self.next_id);
        let questions = Arc::clone(&self.questions);
        Box::pin(async_stream::stream! {
            let mut baseline = {
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
            baseline.extend(questions.baseline().await);
            for frame in baseline {
                yield frame;
            }
            loop {
                let received = tokio::select! {
                    frame = receiver.recv() => frame,
                    frame = question_receiver.recv() => frame,
                };
                match received {
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
        let mut receiver = self.event_gateway.subscribe_host();
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
        let mut exported =
            serde_json::to_value(session).map_err(|e| RpcError::internal(e.to_string()))?;
        drop(state);
        if let Some(source) = self
            .agent_runtime
            .authoritative_session(session_id)
            .await
            .map_err(agent_runtime_error)?
        {
            exported["messages"] = serde_json::to_value(source.derive_messages())
                .map_err(|e| RpcError::internal(e.to_string()))?;
        }
        let bytes = serde_json::to_vec_pretty(&json!({
            "format": "xharness-session-export",
            "version": 1,
            "session": exported,
            "requestAudit": "full request snapshots remain in the state-directory audit archive",
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
            },
            {"name":"goal","description":"Set a persistent Goal and continue automatically until review, pause or budget limit","input":{"hint":"<objective> | pause | resume | complete | clear | edit <objective> | budget <rounds>"}}
        ]))
    }

    async fn commands_execute(&self, payload: &Value) -> Result<Option<Value>, RpcError> {
        let args = payload
            .get("args")
            .ok_or_else(|| bad_request("commands/execute requires args"))?;
        let session_id = required_string(args, "agentId")?;
        let line = required_string(args, "line")?;
        if line.trim() == "/goal" || line.trim_start().starts_with("/goal ") {
            let images = required_array(args, "images")?;
            return self
                .execute_goal_command(
                    &session_id,
                    line.trim_start().strip_prefix("/goal").unwrap().trim(),
                    images,
                )
                .await
                .map(Some);
        }
        let _session_guard = self.lock_admission(&session_id).await;
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
            let state = self.state.read().await;
            let session = state
                .sessions
                .get(&session_id)
                .ok_or_else(|| session_not_found(&session_id))?;
            let view = session.permission_projection();
            json!({
                "kind":"success",
                "text":format!("selected preset {}; active this turn: {}; pending: {} (available: workspace-write, danger-full-access)",
                    session.permission_preset.as_str(), view["activeValue"].as_str().unwrap_or("none"), view["pending"]),
            })
        } else if let Some(preset) = crate::PermissionPreset::parse(raw_input.trim()) {
            let _permission_guard = self.lock_permission_selection(&session_id).await;
            self.commit_session_events(&session_id, permission_events(preset))
                .await?;
            let pending = {
                let mut state = self.state.write().await;
                let session = state
                    .sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| session_not_found(&session_id))?;
                session.permission_preset = preset;
                session.running && session.active_permission != Some(preset)
            };
            self.push_permission_projection(&session_id).await;
            json!({"kind":"success", "text": if pending {
                format!("preset {} saved; applies to the next turn. Current tools and approvals are unchanged.", preset.as_str())
            } else { format!("preset {}", preset.as_str()) }})
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

    async fn host_describe(&self, payload: &Value) -> Result<Value, RpcError> {
        require_object(payload)?;
        let (attached, startup_issues, model_settings_error) = {
            let state = self.state.read().await;
            (
                state.sessions.len(),
                state.startup_issues.clone(),
                state.model_settings_error.clone(),
            )
        };
        Ok(json!({
            "version": self.config.version,
            "cwd": self.config.cwd,
            "provider": self.config.provider_id,
            "model": self.config.model_id,
            "attachedSessions": attached,
            "home": self.config.home,
            "canOpenPath": cfg!(target_os = "macos"),
            // Durable sessions that startup could not publish. Reported here so
            // the surface can tell the user what was skipped instead of
            // presenting a silently shorter session list.
            "startupIssues": startup_issues,
            // Why the persisted model settings are not live. Without this the
            // user sees every configured provider listed while every session
            // reports its model as unavailable.
            "modelSettingsError": model_settings_error,
        }))
    }

    async fn host_pick_directory(&self, payload: &Value) -> Result<Value, RpcError> {
        require_object(payload)?;
        Ok(json!({"path": Value::Null}))
    }

    async fn host_list_directory(&self, payload: &Value) -> Result<Value, RpcError> {
        let requested = match require_object(payload)?.get("path") {
            None => self.config.home.to_string_lossy().into_owned(),
            Some(Value::String(path)) => path.clone(),
            Some(_) => return Err(bad_request("path, when present, must be a string")),
        };
        // Empty path is a virtual location overview, not the process cwd.
        // Omitted path retains the existing home-directory wire contract.
        if requested.is_empty() {
            let roots = directory_roots().map_err(|message| {
                rpc_error(
                    RpcErrorCode::DirectoryUnreadable,
                    message,
                    json!({"path": ""}),
                )
            })?;
            let entries = roots
                .iter()
                .map(|path| json!({"name": path, "path": path, "hidden": false}))
                .collect::<Vec<_>>();
            return Ok(json!({
                "path": "", "home": self.config.home,
                "crumbs": [], "entries": entries, "truncated": false,
            }));
        }
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
        if !valid_directory_name(&name) {
            return Err(bad_request("name must be one valid, non-blank folder name"));
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

    async fn request_snapshot(&self, payload: &Value) -> Result<Value, RpcError> {
        let id = required_string(payload, "sessionId")?;
        let seq = payload
            .get("seq")
            .and_then(Value::as_u64)
            .ok_or_else(|| bad_request("seq must be a nonnegative integer"))?;
        if !self.state.read().await.sessions.contains_key(&id) {
            return Err(session_not_found(&id));
        }
        let header = self
            .agent_runtime
            .request_header(&id, seq)
            .await
            .map_err(agent_runtime_error)?
            .ok_or_else(|| bad_request("request snapshot not found at this sequence"))?;
        Ok(json!({"sessionId":id,"seq":seq,"header":header}))
    }

    async fn execute_goal_command(
        &self,
        id: &str,
        input: &str,
        images: &[Value],
    ) -> Result<Value, RpcError> {
        let command_id = self.mint_id("command");
        self.commit_session_events(
            id,
            vec![SessionEventData::CommandRun {
                command_id: command_id.clone(),
                name: "goal".into(),
                args: Some(input.into()),
                source: CommandSource::User,
            }
            .into()],
        )
        .await?;
        self.sync_authoritative_session(id).await?;
        let current = self.state.read().await.goals.get(id).cloned();
        let result: Result<String, RpcError> = if !images.is_empty() {
            Err(bad_request(
                "/goal currently accepts text only; send attachments in a normal message first",
            ))
        } else if input.is_empty() {
            Ok(current
                .as_ref()
                .map_or("Usage: /goal <objective>".into(), |g| {
                    format!(
                        "Goal: {} ({:?}, {}/{})",
                        g.objective, g.phase, g.rounds_started, g.max_goal_rounds
                    )
                }))
        } else {
            let rpc = RpcId::new(format!("goal-command:{command_id}"));
            let payload = json!({"sessionId":id,"ref":current.as_ref().map(|g|json!({"id":g.id,"revision":g.revision}))});
            let action = match input {
                "pause" => goal::transition(self, rpc, &payload, "paused").await,
                "resume" => goal::transition(self, rpc, &payload, "active").await,
                "complete" => goal::transition(self, rpc, &payload, "complete").await,
                "clear" => goal::clear(self, rpc, &payload).await,
                _ if input.starts_with("budget ") => match input[7..].trim().parse::<u64>() {
                    Ok(n) => {
                        let mut p = payload;
                        p["maxGoalRounds"] = json!(n);
                        goal::edit(self, rpc, &p).await
                    }
                    Err(_) => Err(bad_request("budget must be a positive integer")),
                },
                _ if input.starts_with("edit ") => {
                    let mut p = payload;
                    p["objective"] = json!(input[5..].trim());
                    goal::edit(self, rpc, &p).await
                }
                _ => goal::create(self, rpc, &json!({"sessionId":id,"objective":input})).await,
            };
            action.map(|_| "Goal updated. The Goal bar shows execution and review status.".into())
        };
        let (kind, text) = match result {
            Ok(text) => (CommandResultKind::Success, text),
            Err(e) => (CommandResultKind::Error, e.message),
        };
        self.commit_session_events(
            id,
            vec![SessionEventData::CommandDone {
                command_id: command_id.clone(),
                kind,
                text: Some(text.clone()),
                source_event_seq: None,
            }
            .into()],
        )
        .await?;
        Ok(
            json!({"commandId":command_id,"result":{"kind":if kind==CommandResultKind::Success {"success"} else {"error"},"text":text}}),
        )
    }

    async fn respond_pending(&self, response: ClientResponse) -> RpcReceipt {
        let rpc_id = response.rpc_id.as_str().to_owned();
        let pending = self.state.read().await.pending.get(&rpc_id).cloned();
        let Some(pending) = pending else {
            return self.questions.respond(response).await;
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

fn canonical_directory(path: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("select a filesystem directory, not the location overview".to_owned());
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| format!("could not resolve directory {path:?}: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("path {path:?} is not a directory"));
    }
    Ok(canonical.to_string_lossy().into_owned())
}

fn directory_roots() -> Result<Vec<std::path::PathBuf>, String> {
    #[cfg(windows)]
    {
        // Do not stat every drive: disconnected mapped drives and empty media
        // should not delay the overview. Read errors belong to the chosen path.
        xharness_win32::logical_drive_roots().map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        Ok(vec![
            std::path::PathBuf::from("/"),
            #[cfg(target_os = "macos")]
            std::path::PathBuf::from("/Volumes"),
        ])
    }
}

fn valid_directory_name(name: &str) -> bool {
    // Path::join replaces the parent for absolute/prefixed paths on Windows.
    // Validate a component, not just the absence of slash characters.
    if name.trim().is_empty() || name.contains(['/', '\\', '\0']) {
        return false;
    }
    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(std::path::Component::Normal(_)))
        || components.next().is_some()
    {
        return false;
    }
    #[cfg(windows)]
    {
        // Reject Win32 aliases even with a verbatim canonical parent path:
        // folders must remain accessible to Explorer and ordinary tools.
        if name.ends_with(['.', ' ']) || name.chars().any(|c| c < ' ' || "<>:\"|?*".contains(c)) {
            return false;
        }
        let stem = name
            .split('.')
            .next()
            .unwrap_or(name)
            .trim_end()
            .to_uppercase();
        if matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) {
            return false;
        }
        if let Some(suffix) = stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
        {
            if matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            ) {
                return false;
            }
        }
    }
    true
}

fn breadcrumb_entries(path: &Path) -> Vec<Value> {
    let mut current = PathBuf::new();
    path.components()
        .filter_map(|component| {
            current.push(component.as_os_str());
            // A Windows drive prefix (e.g. C: or \\?\C:) is not a complete
            // absolute directory. Emit it together with the following root.
            if matches!(component, std::path::Component::Prefix(_)) {
                return None;
            }
            let display = current.to_string_lossy().into_owned();
            let name = component.as_os_str().to_string_lossy();
            Some(json!({
                "name": if matches!(component, std::path::Component::RootDir) || name.is_empty() { display.clone() } else { name.into_owned() },
                "path": display,
                "hidden": false,
            }))
        })
        .collect()
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

pub(crate) fn permission_events(preset: crate::PermissionPreset) -> Vec<SessionEvent> {
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

#[cfg(test)]
mod edit_admission_tests {
    use super::*;
    use crate::{HostConfig, NoTools};

    #[tokio::test]
    async fn edit_admission_rejects_running_invalid_flags_and_text_only_models() {
        let root = std::env::temp_dir().join(format!("xh-edit-admission-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let host = BasicHost::new(HostConfig::new(&root), None, Arc::new(NoTools));
        let created = session_lifecycle::create(&host, &json!({"cwd":root}))
            .await
            .unwrap();
        let id = created["sessionId"].as_str().unwrap();
        host.state
            .write()
            .await
            .sessions
            .get_mut(id)
            .unwrap()
            .running = true;
        let error = turn::prompt(
            &host,
            RpcId::new("edit-running"),
            &json!({
                "sessionId":id,"mode":"queue","requireIdle":true,
                "content":[{"type":"text","text":"draft"}]
            }),
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("started running"));
        assert!(host.state.read().await.sessions[id].queue.is_empty());
        let error = turn::prompt(
            &host,
            RpcId::new("edit-invalid"),
            &json!({
                "sessionId":id,"mode":"queue","requireIdle":"true","content":[]
            }),
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("boolean"));
        {
            let mut state = host.state.write().await;
            let session = state.sessions.get_mut(id).unwrap();
            session.running = false;
            let provider = session.model.provider.clone();
            let model = session.model.model.clone();
            state
                .settings
                .get_mut(crate::MODEL_SETTINGS_NAMESPACE)
                .unwrap()
                .value = json!({
                "providers":{provider:{"models":[{"id":model,"imageInput":false}]}}
            });
        }
        let error = turn::prompt(
            &host,
            RpcId::new("edit-no-vision"),
            &json!({
                "sessionId":id,"mode":"queue","requireIdle":true,
                "content":[{"type":"image_ref","attachmentId":"missing"}]
            }),
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("does not support images"));
        assert!(host.state.read().await.sessions[id].queue.is_empty());
        let _ = std::fs::remove_dir_all(root);
    }
}

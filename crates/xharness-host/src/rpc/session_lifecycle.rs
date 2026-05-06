//! Session creation, model selection, rename, and fork lifecycle adapter.

use serde_json::{json, Value};
use xharness_api::{RpcError, RpcErrorCode, RpcId, RpcMethod};
use xharness_projection::{metrics::MetricsProjectionState, project_session_event_range};
use xharness_session::{EventData as SessionEventData, SessionEvent, SessionTitleSource};

use crate::{
    control::SessionMutationResponse,
    driver::{agent_runtime_error, rpc_error},
    runtime::ModelRoute,
    state::{iso_now, now_ms, ModelSelection, SessionRecord},
    BasicHost,
};

use super::{
    bad_request, canonical_directory, nonempty, optional_string, optional_u64, permission_events,
    require_object, required_string, session_not_found,
};

pub(crate) async fn create(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    create_with_visibility(host, payload, true).await
}

pub(crate) async fn create_with_visibility(
    host: &BasicHost,
    payload: &Value,
    announce: bool,
) -> Result<Value, RpcError> {
    let object = require_object(payload)?;
    if object.contains_key("workspaceId") && object.contains_key("cwd") {
        return Err(bad_request(
            "session.create accepts workspaceId or cwd, not both",
        ));
    }
    let requested_id = optional_string(payload, "sessionId")?;
    let preset = optional_string(payload, "agentPreset")?;
    let session_id = requested_id.unwrap_or_else(|| host.mint_id("session"));
    // Creating a named session participates in the same per-session admission
    // fence as prompts and control commands.  The guard is intentionally held
    // until the initial durable policy events have crossed their flush barrier,
    // so an idempotent concurrent create can never observe a half-created
    // in-memory record and return success before its receipt is durable.
    let _session_guard = host.lock_admission(&session_id).await;
    let mut state = host.state.write().await;
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
            .unwrap_or_else(|| host.config.cwd.to_string_lossy().into_owned())
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
    let effective_preset = preset.or_else(|| Some(state.default_agent_preset().to_owned()));
    let permission_preset = state
        .settings
        .get("permission")
        .and_then(|namespace| namespace.value.get("defaultPreset"))
        .and_then(Value::as_str)
        .and_then(crate::PermissionPreset::parse)
        .unwrap_or_default();
    let mut initial_model = ModelSelection::from_config(&host.config);
    if host.model_settings.get().is_some()
        && !host.agent_runtime.can_route(&ModelRoute::new(
            &initial_model.provider,
            &initial_model.model,
        ))
    {
        if let Some(model) = host.agent_runtime.model_catalog().first() {
            initial_model = ModelSelection {
                provider: model.provider.clone(),
                model: model.model.clone(),
                reasoning_effort: model
                    .reasoning
                    .as_ref()
                    .and_then(|r| r.default_effort.clone()),
                context_window_tokens: model.context_window.effective_hard_max(),
            };
        }
    }
    let record = SessionRecord {
        dispatch_paused: false,
        delegated: false,
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
        model: initial_model.clone(),
        permission_preset,
        active_permission: None,
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
    if host.model_settings.get().is_some() {
        initial_events.push(
            SessionEventData::SessionModelSelected {
                provider: initial_model.provider,
                model: initial_model.model,
                reasoning_effort: initial_model.reasoning_effort,
                context_window_tokens: initial_model.context_window_tokens,
            }
            .into(),
        );
    }
    if let Err(error) = host
        .commit_session_events(&session_id, initial_events)
        .await
    {
        let mut state = host.state.write().await;
        state.sessions.remove(&session_id);
        for workspace in state.workspaces.values_mut() {
            workspace
                .session_ids
                .retain(|candidate| candidate != &session_id);
        }
        return Err(error);
    }
    if announce {
        host.push_host(json!({
            "type": "host/session-added",
            "sessionId": session_id,
            "blank": true,
            "cwd": cwd,
            "agentPreset": effective_preset,
        }));
    }
    if let Some(workspace) = workspace_changed {
        host.push_host(json!({"type": "host/workspace-changed", "workspace": workspace}));
    }
    Ok(json!({
        "sessionId": session_id,
        "agentPreset": effective_preset,
    }))
}

pub(super) async fn select_model(
    host: &BasicHost,
    rpc_id: RpcId,
    payload: &Value,
) -> Result<Value, RpcError> {
    let session_id = required_string(payload, "sessionId")?;
    let _session_guard = host.lock_admission(&session_id).await;
    let provider = nonempty(required_string(payload, "provider")?, "provider")?;
    let model = nonempty(required_string(payload, "model")?, "model")?;
    let current = {
        let state = host.state.read().await;
        state
            .sessions
            .get(&session_id)
            .ok_or_else(|| session_not_found(&session_id))?
            .model
            .clone()
    };
    let same_route = current.provider == provider && current.model == model;
    let descriptor = host
        .agent_runtime
        .model_catalog()
        .into_iter()
        .find(|entry| entry.provider == provider && entry.model == model);
    let reasoning_effort = optional_string(payload, "reasoningEffort")?.or_else(|| {
        descriptor
            .as_ref()
            .and_then(|entry| entry.reasoning.as_ref())
            .and_then(|reasoning| reasoning.default_effort.clone())
    });
    let context_window_tokens = optional_u64(payload, "contextWindowTokens")?
        .or_else(|| {
            same_route
                .then_some(current.context_window_tokens)
                .flatten()
        })
        .or_else(|| {
            descriptor
                .as_ref()
                .and_then(|entry| entry.context_window.effective_hard_max())
        });
    if let Some(selected_tokens) = context_window_tokens {
        let advertised = descriptor
            .as_ref()
            .and_then(|entry| entry.context_window.effective_hard_max());
        if selected_tokens == 0 || advertised.is_none_or(|maximum| selected_tokens > maximum) {
            return Err(rpc_error(
                    RpcErrorCode::ModelUnavailable,
                    match advertised {
                        Some(maximum) => format!(
                            "selected context window {selected_tokens} exceeds the Provider/deployment maximum {maximum} for {provider}/{model}"
                        ),
                        None => format!(
                            "model route {provider}/{model} does not advertise a context-window capability"
                        ),
                    },
                    json!({
                        "provider": provider,
                        "model": model,
                        "requestedContextWindowTokens": selected_tokens,
                        "maximumContextWindowTokens": advertised,
                    }),
                ));
        }
    }
    let selected = ModelSelection {
        provider,
        model,
        reasoning_effort,
        context_window_tokens,
    };
    let route = ModelRoute {
        provider: selected.provider.clone(),
        model: selected.model.clone(),
        reasoning_effort: selected.reasoning_effort.clone(),
        context_window_tokens: selected.context_window_tokens,
    };
    if !host.agent_runtime.can_route(&route) {
        return Err(rpc_error(
            RpcErrorCode::ModelUnavailable,
            format!(
                "model route {}/{} is unavailable",
                route.provider, route.model
            ),
            json!({"provider": route.provider, "model": route.model}),
        ));
    }
    if let Some(response) = host
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
    let response = host
        .commit_session_mutation(
            &session_id,
            &rpc_id,
            RpcMethod::SessionSelectModel,
            payload,
            vec![SessionEventData::SessionModelSelected {
                provider: selected.provider.clone(),
                model: selected.model.clone(),
                reasoning_effort: selected.reasoning_effort.clone(),
                context_window_tokens: selected.context_window_tokens,
            }
            .into()],
            SessionMutationResponse::fixed(json!({"selected": selected})),
        )
        .await?;
    let mut state = host.state.write().await;
    let session = state
        .sessions
        .get_mut(&session_id)
        .ok_or_else(|| session_not_found(&session_id))?;
    session.model = selected;
    drop(state);
    host.queue_title(&session_id);
    Ok(response)
}

pub(super) async fn rename(
    host: &BasicHost,
    rpc_id: RpcId,
    payload: &Value,
) -> Result<Value, RpcError> {
    let session_id = required_string(payload, "sessionId")?;
    let _session_guard = host.lock_admission(&session_id).await;
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
    if let Some(response) = host
        .replay_session_mutation_receipt(&session_id, &rpc_id, RpcMethod::SessionRename, payload)
        .await?
    {
        return Ok(response);
    }
    let response = host
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
        let mut state = host.state.write().await;
        let session = state
            .sessions
            .get_mut(&session_id)
            .ok_or_else(|| session_not_found(&session_id))?;
        session.title = Some(title.clone());
    }
    host.push_projection(&session_id, "title", json!(title))
        .await;
    Ok(response)
}

pub(super) async fn fork(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    let source_id = required_string(payload, "sessionId")?;
    let at_seq = optional_u64(payload, "atSeq")?;
    let (cwd, agent_preset, title, model, permission_preset, plan_active, goal, next_turn) = {
        let state = host.state.read().await;
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
        context_window_tokens: model.context_window_tokens,
    };
    let durable_source = if host.agent_runtime.has_authoritative_sessions() {
        host.agent_runtime
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
        let state = host.state.read().await;
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
    let child_id = host.mint_id("session");
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
        dispatch_paused: false,
        delegated: false,
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
        active_permission: None,
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
    let mut state = host.state.write().await;
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
        if let Err(error) = host.commit_session_events(&child_id, events).await {
            host.state.write().await.sessions.remove(&child_id);
            return Err(error);
        }
    }
    host.push_host(json!({
        "type": "host/session-added",
        "sessionId": child_id,
        "blank": false,
        "parentSessionId": source_id,
        "cwd": cwd,
    }));
    if let Some(workspace) = changed_workspace {
        host.push_host(json!({"type": "host/workspace-changed", "workspace": workspace}));
    }
    Ok(json!({"sessionId": child_id}))
}

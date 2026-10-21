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
    create_inner(host, payload, announce, None, None).await
}

/// Uses the same admission fence and initial policy as ordinary native creation.
pub(super) async fn create_scoped(
    host: &BasicHost,
    request: xharness_api::ScopedSessionCreate,
) -> Result<xharness_api::ScopedSessionCreated, RpcError> {
    if !request.is_bounded() || !host.agent_runtime.has_authoritative_sessions() {
        return Err(RpcError::internal("durable scoped creation unavailable"));
    }
    let payload =
        serde_json::to_value(&request).map_err(|_| RpcError::internal("invalid creation"))?;
    let native_payload =
        json!({"workspaceId": request.workspace, "sessionId": request.session_id()});
    create_inner(
        host,
        &native_payload,
        true,
        Some((&request, &payload)),
        None,
    )
    .await?;
    Ok(request.receipt())
}

pub(super) async fn creation_receipt(
    host: &BasicHost,
    request: &xharness_api::ScopedSessionCreate,
) -> Result<Option<xharness_api::ScopedSessionCreated>, RpcError> {
    if !request.is_bounded() || !host.agent_runtime.has_authoritative_sessions() {
        return Err(RpcError::internal("durable scoped creation unavailable"));
    }
    let _guard = host.lock_admission(&request.session_id()).await;
    checked_creation_receipt(host, request).await
}

// Caller holds the admission fence. Read only: never hydrate, wake, or adopt an
// existing session merely because its ID/cwd matches. Partial initialization
// (a header with no receipt) is ambiguous and cannot be replayed or granted.
async fn checked_creation_receipt(
    host: &BasicHost,
    request: &xharness_api::ScopedSessionCreate,
) -> Result<Option<xharness_api::ScopedSessionCreated>, RpcError> {
    let session_id = request.session_id();
    let state = host.state.read().await;
    let path = state
        .workspaces
        .get(&request.workspace)
        .ok_or_else(|| RpcError::internal("registered creation workspace unavailable"))?
        .path
        .clone();
    if state.deleted_sessions.contains(&session_id) || state.archived_sessions.contains(&session_id)
    {
        return Err(RpcError::internal("creation session unavailable"));
    }
    let warm = state.sessions.get(&session_id);
    let present = warm.is_some();
    if warm.is_some_and(|s| s.cwd != path || s.delegated || s.parent_session_id.is_some()) {
        return Err(RpcError::internal("creation session scope conflict"));
    }
    drop(state);
    let session = host
        .agent_runtime
        .authoritative_session(&session_id)
        .await
        .map_err(agent_runtime_error)?;
    let Some(session) = session else {
        if present || host.lazy_headers.read().await.contains_key(&session_id) {
            return Err(RpcError::internal("creation receipt unavailable"));
        }
        return Ok(None);
    };
    if session.header().id != session_id || session.header().cwd.as_deref() != Some(path.as_str()) {
        return Err(RpcError::internal("creation journal scope conflict"));
    }
    let payload =
        serde_json::to_value(request).map_err(|_| RpcError::internal("invalid creation"))?;
    let fingerprint =
        xharness_control::mutation_fingerprint(RpcMethod::SessionCreate.as_str(), &payload);
    let receipts: Vec<_> = session
        .events()
        .iter()
        .filter_map(|e| match e.data() {
            SessionEventData::SessionMutationCommitted { receipt }
                if receipt.rpc_id == request.receipt_id() =>
            {
                Some(receipt)
            }
            _ => None,
        })
        .collect();
    if receipts.len() != 1
        || receipts[0].method != RpcMethod::SessionCreate.as_str()
        || receipts[0].fingerprint != fingerprint
        || receipts[0].response_event_seq_field.is_some()
        || receipts[0].response
            != serde_json::to_value(request.receipt())
                .map_err(|_| RpcError::internal("invalid creation"))?
    {
        return Err(RpcError::internal("original creation receipt conflict"));
    }
    host.agent_runtime
        .flush_session_revision(&session_id, session.revision())
        .await
        .map_err(agent_runtime_error)?;
    let state = host.state.read().await;
    if state
        .workspaces
        .get(&request.workspace)
        .is_none_or(|w| w.path != path)
        || state.deleted_sessions.contains(&session_id)
        || state.archived_sessions.contains(&session_id)
    {
        return Err(RpcError::internal("creation scope changed"));
    }
    Ok(Some(request.receipt()))
}

pub(crate) async fn create_seeded(
    host: &BasicHost,
    payload: &Value,
    announce: bool,
    imported: Option<&xharness_session_import::Transcript>,
) -> Result<Value, RpcError> {
    create_inner(host, payload, announce, None, imported).await
}

async fn create_inner(
    host: &BasicHost,
    payload: &Value,
    announce: bool,
    creation: Option<(&xharness_api::ScopedSessionCreate, &Value)>,
    imported: Option<&xharness_session_import::Transcript>,
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
    if let Some((request, _)) = creation {
        if let Some(receipt) = checked_creation_receipt(host, request).await? {
            return serde_json::to_value(receipt)
                .map_err(|_| RpcError::internal("invalid creation receipt"));
        }
    }
    let mut state = host.state.write().await;
    if state.deleted_sessions.contains(&session_id) {
        return Err(rpc_error(
            RpcErrorCode::SessionConflict,
            "deleted session id cannot be reused",
            json!({"sessionId": session_id}),
        ));
    }
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
                context_window_tokens: None,
            };
        }
    }
    let record = SessionRecord {
        dispatch_paused: false,
        delegated: false,
        restoring: false,
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
        task_plan: None,
        schedules: Vec::new(),
        schedules_hydrated: true,
        events: Vec::new(),
        event_base_seq: 0,
        event_cache_bytes: 0,
        event_cache_weights: Vec::new(),
        event_cache_resident_bytes: 0,
        event_cache_resident_weights: Vec::new(),
        event_cache_touched: 0,
        projected_model: None,
        metrics: MetricsProjectionState::default(),
        catalog_metrics: None,
        messages: Vec::new(),
        queue: Default::default(),
        projected_queue: Default::default(),
        admissions: crate::admission_cache::AdmissionCache::new(
            host.agent_runtime.has_authoritative_sessions(),
        ),
        mutation_receipts: Default::default(),
        authoritative_seq: None,
        control: None,
        next_turn: 0,
    };
    state.sessions.insert(session_id.clone(), record);
    state.enforce_projection_budget(&session_id, host.config.session_event_cache_total_bytes);
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
    if let Some((request, receipt_payload)) = creation {
        initial_events.push(
            SessionEventData::SessionMutationCommitted {
                receipt: xharness_session::SessionMutationReceipt {
                    rpc_id: request.receipt_id(),
                    method: RpcMethod::SessionCreate.as_str().into(),
                    fingerprint: xharness_control::mutation_fingerprint(
                        RpcMethod::SessionCreate.as_str(),
                        receipt_payload,
                    ),
                    response: serde_json::to_value(request.receipt())
                        .map_err(|_| RpcError::internal("invalid creation receipt"))?,
                    response_event_seq_field: None,
                },
            }
            .into(),
        );
    }
    if let Some(history) = imported {
        initial_events.extend(history.events());
        initial_events.push(
            SessionEventData::SessionTitle {
                title: format!("{} · {}", history.source.label(), history.title),
                message_seqs: Vec::new(),
                source: SessionTitleSource::User,
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
            "blank": imported.is_none(),
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
    let context_window_tokens = optional_u64(payload, "contextWindowTokens")?.or_else(|| {
        same_route
            .then_some(current.context_window_tokens)
            .flatten()
    });
    if let Some(selected_tokens) = context_window_tokens {
        let advertised = descriptor
            .as_ref()
            .and_then(|entry| entry.context_window.effective_hard_max());
        if selected_tokens == 0 || advertised.is_some_and(|maximum| selected_tokens > maximum) {
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

#[derive(Clone, Copy)]
enum ForkBoundary {
    TurnStart,
    TurnEnd,
    StepEnd,
    Other,
}

// Message anchors include their completed turn. Explicit closed-step anchors
// retain the checkpoint-fork contract used by low-level retry experiments;
// those callers own closing the interrupted turn before resuming execution.
fn completed_fork_end(
    events: impl Iterator<Item = (u64, ForkBoundary)>,
    at_seq: Option<u64>,
) -> Option<usize> {
    let mut count = 0;
    let mut last_seq = None;
    let mut open_turn = false;
    let mut closed = None;
    let mut anchored = None;
    for (index, (seq, boundary)) in events.enumerate() {
        count = index + 1;
        last_seq = Some(seq);
        match boundary {
            ForkBoundary::TurnStart => open_turn = true,
            ForkBoundary::TurnEnd => {
                open_turn = false;
                closed = Some(count);
            }
            _ => {}
        }
        let exact_step = at_seq == Some(seq) && matches!(boundary, ForkBoundary::StepEnd);
        let closing_turn = anchored.is_none()
            && at_seq.is_some_and(|anchor| seq >= anchor)
            && matches!(boundary, ForkBoundary::TurnEnd);
        if exact_step || closing_turn {
            anchored = Some(count);
        }
    }
    if at_seq.is_some_and(|anchor| last_seq.is_some_and(|last| anchor <= last)) {
        anchored
    } else if open_turn {
        closed
    } else {
        (count > 0).then_some(count)
    }
}

pub(super) async fn fork(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    let source_id = required_string(payload, "sessionId")?;
    let _source_guard = host.lock_admission(&source_id).await;
    let at_seq = optional_u64(payload, "atSeq")?;
    let before_user_seq = optional_u64(payload, "beforeUserSeq")?;
    if at_seq.is_some() && before_user_seq.is_some() {
        return Err(bad_request(
            "atSeq and beforeUserSeq are mutually exclusive",
        ));
    }
    let (cwd, agent_preset, title, model, permission_preset, plan_active, goal) = {
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
    let (child_events, child_messages, durable_events, next_turn, historical_state) =
        if let Some(source) = durable_source {
            let end = if let Some(target) = before_user_seq {
                let index = source
                    .events()
                    .iter()
                    .position(|event| {
                        event.seq == target
                            && matches!(event.data(), SessionEventData::UserMessage { message, .. }
                    if message.role == xharness_session::MessageRole::User)
                    })
                    .ok_or_else(|| bad_request("beforeUserSeq must identify a user message"))?;
                source.events()[..index]
                    .iter()
                    .rposition(|event| matches!(event.data(), SessionEventData::TurnEnd { .. }))
                    .map(|index| index + 1)
                    .unwrap_or_else(|| {
                        source.events()[..index]
                            .iter()
                            .position(|event| {
                                matches!(event.data(), SessionEventData::TurnStart { .. })
                            })
                            .unwrap_or(index)
                    })
            } else {
                completed_fork_end(
                    source.events().iter().map(|event| {
                        (
                            event.seq,
                            match event.data() {
                                SessionEventData::TurnStart { .. } => ForkBoundary::TurnStart,
                                SessionEventData::TurnEnd { .. } => ForkBoundary::TurnEnd,
                                SessionEventData::StepEnd { .. } => ForkBoundary::StepEnd,
                                _ => ForkBoundary::Other,
                            },
                        )
                    }),
                    at_seq,
                )
                .ok_or_else(|| {
                    rpc_error(
                        RpcErrorCode::ForkUnavailable,
                        "the selected turn is not complete; choose a completed turn",
                        json!({"sessionId": source_id}),
                    )
                })?
            };
            let next_turn = source.events()[..end]
                .iter()
                .filter_map(|event| match event.data() {
                    SessionEventData::TurnStart { turn } => Some(turn.saturating_add(1)),
                    _ => None,
                })
                .max()
                .unwrap_or_default();
            // An edit-fork is a historical snapshot. Derive its settings from
            // the same durable prefix that is copied into the child; using the
            // source's current settings would change the child after restart.
            let historical_state = if before_user_seq.is_some() {
                let prefix = source.events()[..end].to_vec();
                let revision = prefix
                    .last()
                    .map_or(xharness_session::Revision::ZERO, |event| event.revision);
                Some(
                    xharness_session::Session::restore(source.header().clone(), revision, prefix)
                        .map_err(|error| {
                        RpcError::internal(format!("invalid edit-fork boundary: {error}"))
                    })?,
                )
            } else {
                None
            };
            let projection_route = historical_state.as_ref().map_or_else(
                || route.clone(),
                |snapshot| crate::restore::restored_route(snapshot, &host.config),
            );
            (
                project_session_event_range(&source, &projection_route, 0, end),
                xharness_session::derive_messages(&source.events()[..end]),
                Some(source.events()[..end].to_vec()),
                next_turn,
                historical_state,
            )
        } else {
            if before_user_seq.is_some() {
                return Err(rpc_error(
                    RpcErrorCode::ForkUnavailable,
                    "editing a fork requires authoritative session history",
                    json!({"sessionId": source_id}),
                ));
            }
            let state = host.state.read().await;
            let source = state
                .sessions
                .get(&source_id)
                .ok_or_else(|| session_not_found(&source_id))?;
            let mut events = source.events.clone();
            let end = completed_fork_end(
                events.iter().enumerate().map(|(index, event)| {
                    (
                        source.event_base_seq.saturating_add(index as u64),
                        match event["type"].as_str() {
                            Some("turn/start") => ForkBoundary::TurnStart,
                            Some("turn/end") => ForkBoundary::TurnEnd,
                            Some("step/end") => ForkBoundary::StepEnd,
                            _ => ForkBoundary::Other,
                        },
                    )
                }),
                at_seq,
            )
            .ok_or_else(|| {
                rpc_error(
                    RpcErrorCode::ForkUnavailable,
                    "the selected turn is not complete; choose a completed turn",
                    json!({"sessionId": source_id}),
                )
            })?;
            events.truncate(end);
            let next_turn = events
                .iter()
                .filter_map(|event| {
                    (event["type"] == "turn/start")
                        .then(|| {
                            event["data"]["turn"]
                                .as_u64()
                                .and_then(|turn| u32::try_from(turn).ok())
                                .map(|turn| turn.saturating_add(1))
                        })
                        .flatten()
                })
                .max()
                .unwrap_or_default();
            (events, source.messages.clone(), None, next_turn, None)
        };
    if child_events.is_empty() && before_user_seq.is_none() {
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
    let child_blank = child_messages.is_empty();
    let (agent_preset, title, model, permission_preset, plan_active, goal) =
        if let Some(snapshot) = historical_state.as_ref() {
            let boundary_route = crate::restore::restored_route(snapshot, &host.config);
            (
                crate::restore::restored_agent_preset(snapshot),
                crate::restore::restored_title(snapshot),
                ModelSelection {
                    provider: boundary_route.provider,
                    model: boundary_route.model,
                    reasoning_effort: boundary_route.reasoning_effort,
                    context_window_tokens: boundary_route.context_window_tokens,
                },
                crate::restore::restored_permission(snapshot),
                crate::restore::restored_plan_mode(snapshot),
                crate::restore::restored_goal(snapshot),
            )
        } else {
            (
                agent_preset,
                title,
                model,
                permission_preset,
                plan_active,
                goal,
            )
        };
    let child = SessionRecord {
        dispatch_paused: false,
        delegated: false,
        restoring: false,
        session_id: child_id.clone(),
        created_at: now,
        updated_at: now,
        running: false,
        blank: child_blank,
        parent_session_id: Some(source_id.clone()),
        origin: Some("fork".to_owned()),
        cwd: cwd.clone(),
        agent_preset,
        title,
        model,
        permission_preset,
        active_permission: None,
        plan_active,
        goal,
        task_plan: historical_state
            .as_ref()
            .and_then(xharness_session::session_plan),
        schedules: historical_state
            .as_ref()
            .map(xharness_schedule::active_schedules)
            .transpose()
            .map_err(RpcError::internal)?
            .unwrap_or_default(),
        schedules_hydrated: true,
        events: child_events,
        event_base_seq: 0,
        event_cache_bytes: child_event_bytes,
        event_cache_weights: Vec::new(),
        event_cache_resident_bytes: 0,
        event_cache_resident_weights: Vec::new(),
        event_cache_touched: 0,
        projected_model: None,
        metrics: child_metrics,
        catalog_metrics: None,
        messages: child_messages,
        queue: Default::default(),
        projected_queue: Default::default(),
        admissions: crate::admission_cache::AdmissionCache::new(
            host.agent_runtime.has_authoritative_sessions(),
        ),
        mutation_receipts: Default::default(),
        authoritative_seq: None,
        control: None,
        next_turn,
    };
    let marker: SessionEvent = SessionEventData::SessionForkOrigin {
        parent_session_id: source_id.clone(),
        before_user_seq,
    }
    .into();
    let durable = if let Some(events) = durable_events {
        let revision = events
            .last()
            .map_or(xharness_session::Revision::ZERO, |e| e.revision);
        let mut header = xharness_session::SessionHeader::new(&child_id);
        header.cwd = Some(cwd.clone());
        let mut seed = xharness_session::Session::restore(header, revision, events)
            .map_err(|error| RpcError::internal(format!("invalid fork history: {error}")))?;
        seed.append(seed.revision(), marker.clone())
            .map_err(|error| RpcError::internal(format!("invalid fork origin: {error}")))?;
        host.agent_runtime
            .persist_fork_session(seed)
            .await
            .map_err(agent_runtime_error)?;
        true
    } else {
        false
    };
    // Publish neither the child nor workspace membership before its complete
    // journal is durable. A failed seed cannot leave an empty child in the UI.
    {
        let mut state = host.state.write().await;
        state.sessions.insert(child_id.clone(), child);
        state.enforce_projection_budget(&child_id, host.config.session_event_cache_total_bytes);
    }
    if durable {
        host.sync_authoritative_session(&child_id).await?;
    } else if let Err(error) = host.commit_session_events(&child_id, vec![marker]).await {
        host.state.write().await.sessions.remove(&child_id);
        return Err(error);
    }
    let mut changed_workspace = None;
    {
        let mut state = host.state.write().await;
        for workspace in state.workspaces.values_mut() {
            if workspace.session_ids.contains(&source_id) {
                workspace.session_ids.insert(0, child_id.clone());
                workspace.updated_at = iso_now();
                changed_workspace = serde_json::to_value(workspace).ok();
                break;
            }
        }
    }
    host.push_host(json!({
        "type": "host/session-added",
        "sessionId": child_id,
        "blank": child_blank,
        "parentSessionId": source_id,
        "origin": "fork",
        "cwd": cwd,
    }));
    if let Some(workspace) = changed_workspace {
        host.push_host(json!({"type": "host/workspace-changed", "workspace": workspace}));
    }
    Ok(json!({"sessionId": child_id}))
}

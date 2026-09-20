//! Session catalogue, search, history, and model-selection read adapter.
//!
//! State and runtime I/O stay here. Sorting, query policy, result bounding,
//! and local history pagination are owned by `SessionProcessor`.

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use xharness_api::{RpcError, RpcErrorCode, RpcMethod};
use xharness_projection::project_session_history;

use crate::{
    driver::{agent_runtime_error, rpc_error},
    event_gateway::EventGateway,
    runtime::ModelRoute,
    session_processor::{SearchQueryError, SessionProcessor, SessionSearchRecord},
    BasicHost,
};

use super::{
    model, optional_u64, require_object, required_string, session_not_found,
    DEFAULT_HISTORY_MESSAGES, MAX_HISTORY_MESSAGES,
};

pub(super) async fn call_read(
    host: &BasicHost,
    method: RpcMethod,
    payload: &Value,
    cancellation: &CancellationToken,
) -> Result<Value, RpcError> {
    match method {
        RpcMethod::SessionList => list(host, payload).await,
        RpcMethod::SessionSearch => search(host, payload, cancellation).await,
        RpcMethod::SessionHistory => history(host, payload).await,
        RpcMethod::SessionModels => models(host, payload).await,
        _ => unreachable!("session read adapter received non-read method {method}"),
    }
}

async fn list(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    require_object(payload)?;
    let state = host.state.read().await;
    Ok(SessionProcessor::list(
        state
            .sessions
            .values()
            .filter(|session| !state.archived_sessions.contains(&session.session_id))
            .map(|session| session.summary())
            .collect(),
    ))
}

async fn search(
    host: &BasicHost,
    payload: &Value,
    cancellation: &CancellationToken,
) -> Result<Value, RpcError> {
    let query = SessionProcessor::normalize_query(&required_string(payload, "query")?).map_err(
        |SearchQueryError::Invalid| {
            super::bad_request("query must contain 1-500 visible characters")
        },
    )?;
    check_search_cancelled(cancellation)?;

    let state = host.state.read().await;
    let session_ids = state
        .sessions
        .keys()
        .filter(|session_id| !state.archived_sessions.contains(*session_id))
        .cloned()
        .collect::<Vec<_>>();
    if host.agent_runtime.has_authoritative_sessions() {
        drop(state);
        let mut records = Vec::new();
        for session_id in session_ids {
            check_search_cancelled(cancellation)?;
            let Some(session) = host
                .agent_runtime
                .authoritative_session(&session_id)
                .await
                .map_err(agent_runtime_error)?
            else {
                continue;
            };
            records.push(SessionSearchRecord {
                id: session_id,
                event_texts: session
                    .events()
                    .iter()
                    .map(|event| serde_json::to_string(event).unwrap_or_default())
                    .collect(),
            });
        }
        return Ok(SessionProcessor::search(&query, records));
    }

    let records = state
        .sessions
        .values()
        .filter(|session| !state.archived_sessions.contains(&session.session_id))
        .map(|session| SessionSearchRecord {
            id: session.session_id.clone(),
            event_texts: session.events.iter().map(Value::to_string).collect(),
        })
        .collect::<Vec<_>>();
    Ok(SessionProcessor::search(&query, records))
}

fn check_search_cancelled(cancellation: &CancellationToken) -> Result<(), RpcError> {
    if cancellation.is_cancelled() {
        return Err(rpc_error(
            RpcErrorCode::Cancelled,
            "session search was cancelled",
            json!({}),
        ));
    }
    Ok(())
}

pub(super) async fn history(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    let session_id = required_string(payload, "sessionId")?;
    host.sync_authoritative_session(&session_id).await?;
    let before_seq = optional_u64(payload, "beforeSeq")?;
    let max_messages = optional_u64(payload, "maxMessages")?
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(DEFAULT_HISTORY_MESSAGES)
        .clamp(1, MAX_HISTORY_MESSAGES);

    if host.agent_runtime.has_authoritative_sessions() {
        let durable = host
            .agent_runtime
            .authoritative_session(&session_id)
            .await
            .map_err(agent_runtime_error)?
            .ok_or_else(|| session_not_found(&session_id))?;
        let (route, projections) = {
            let state = host.state.read().await;
            let session = state
                .sessions
                .get(&session_id)
                .ok_or_else(|| session_not_found(&session_id))?;
            (
                ModelRoute {
                    provider: session.model.provider.clone(),
                    model: session.model.model.clone(),
                    reasoning_effort: session.model.reasoning_effort.clone(),
                    context_window_tokens: session.model.context_window_tokens,
                },
                session.projection_values(),
            )
        };
        let page = project_session_history(&durable, &route, before_seq, max_messages);
        let events = page
            .events
            .into_iter()
            .map(|event| {
                let view = event
                    .get("seq")
                    .and_then(Value::as_u64)
                    .and_then(|seq| {
                        usize::try_from(seq)
                            .ok()
                            .and_then(|index| durable.events().get(index))
                    })
                    .and_then(|source| EventGateway::durable_view(&durable, source))
                    .or_else(|| EventGateway::live_view(&event, &[]));
                EventGateway::history_event(event, view)
            })
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

    let state = host.state.read().await;
    let session = state
        .sessions
        .get(&session_id)
        .ok_or_else(|| session_not_found(&session_id))?;
    let event_types = session
        .events
        .iter()
        .map(|event| event.get("type").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let window = SessionProcessor::history_window(
        &event_types,
        session.event_base_seq,
        session.next_event_seq(),
        before_seq,
        max_messages,
    );
    let events = session.events[window.start..window.end]
        .iter()
        .map(|event| {
            EventGateway::history_event(
                event.clone(),
                EventGateway::live_view(event, &session.events),
            )
        })
        .collect::<Vec<_>>();
    let mut value = json!({
        "events": events,
        "hasMore": window.has_more,
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

async fn models(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    let session_id = required_string(payload, "sessionId")?;
    if !host.state.read().await.sessions.contains_key(&session_id) {
        return Err(session_not_found(&session_id));
    }
    if payload.get("refreshCapabilities").and_then(Value::as_bool) == Some(true) {
        host.refresh_model_settings()
            .await
            .map_err(crate::model_settings::model_settings_error)?;
    }
    let repaired = host.reconcile_model_routes().await;
    if !repaired.is_empty() {
        host.state.write().await.startup_issues.extend(repaired);
    }
    let (current, route) = {
        let state = host.state.read().await;
        let session = state
            .sessions
            .get(&session_id)
            .ok_or_else(|| session_not_found(&session_id))?;
        let route = ModelRoute {
            provider: session.model.provider.clone(),
            model: session.model.model.clone(),
            reasoning_effort: session.model.reasoning_effort.clone(),
            context_window_tokens: session.model.context_window_tokens,
        };
        (session.model.clone(), route)
    };
    let (groups, failures) = model::catalog_view(host).await;
    Ok(json!({
        "current": current,
        "routable": host.agent_runtime.can_route(&route),
        "groups": groups,
        "failures": failures,
    }))
}

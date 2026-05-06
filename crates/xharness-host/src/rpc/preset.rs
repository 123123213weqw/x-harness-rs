//! Agent Preset RPC compatibility adapter.
//!
//! Wire validation, Host locking and durable Session receipt ordering remain
//! here. Preset decisions are delegated to the pure `PresetProcessor`.

use serde_json::Value;
use xharness_api::{RpcError, RpcId, RpcMethod};

use crate::{
    control::SessionMutationResponse,
    preset_processor::{PresetProcessor, PresetSelection, PresetSessionView, PresetStateView},
    state::HostState,
    BasicHost,
};

use super::{nonempty, optional_string, require_object, required_string, session_not_found};

pub(super) async fn call(
    host: &BasicHost,
    rpc_id: RpcId,
    method: RpcMethod,
    payload: &Value,
) -> Result<Value, RpcError> {
    match method {
        RpcMethod::AgentPresetList => list(host, payload).await,
        RpcMethod::AgentPresetSelect => select(host, rpc_id, payload).await,
        RpcMethod::AgentPresetRead => read(host, payload).await,
        RpcMethod::AgentPresetCopy => copy(host, payload).await,
        RpcMethod::AgentPresetOpenDocument => open_document(host, payload).await,
        RpcMethod::AgentPresetRemove => remove(host, payload).await,
        _ => unreachable!("preset adapter received non-preset method {method}"),
    }
}

async fn list(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    require_object(payload)?;
    Ok(PresetProcessor::new(snapshot(host).await).list())
}

async fn select(host: &BasicHost, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
    let session_id = required_string(payload, "sessionId")?;
    let agent_preset = nonempty(required_string(payload, "agentPreset")?, "agentPreset")?;
    let _session_guard = host.lock_admission(&session_id).await;
    if let Some(response) = host
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
    let selection =
        PresetProcessor::new(snapshot(host).await).select(&session_id, &agent_preset)?;
    commit_selection(host, rpc_id, payload, &session_id, selection).await
}

async fn commit_selection(
    host: &BasicHost,
    rpc_id: RpcId,
    payload: &Value,
    session_id: &str,
    selection: PresetSelection,
) -> Result<Value, RpcError> {
    let response = selection.response;
    host.commit_session_mutation(
        session_id,
        &rpc_id,
        RpcMethod::AgentPresetSelect,
        payload,
        selection
            .session_events
            .into_iter()
            .map(Into::into)
            .collect(),
        SessionMutationResponse::fixed(response.clone()),
    )
    .await?;
    host.state
        .write()
        .await
        .sessions
        .get_mut(session_id)
        .ok_or_else(|| session_not_found(session_id))?
        .agent_preset = Some(selection.agent_preset);
    Ok(response)
}

async fn read(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    let id = required_string(payload, "agentPreset")?;
    PresetProcessor::new(snapshot(host).await).read(&id)
}

async fn copy(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    let from = required_string(payload, "from")?;
    let id = nonempty(required_string(payload, "agentPreset")?, "agentPreset")?;
    let name = optional_string(payload, "name")?;
    let mut state = host.state.write().await;
    let inserted = PresetProcessor::new(state_view(&state)).copy(&from, id, name)?;
    let response = inserted.response;
    state
        .presets
        .insert(inserted.preset.id.clone(), inserted.preset);
    Ok(response)
}

async fn open_document(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    let id = required_string(payload, "agentPreset")?;
    PresetProcessor::new(snapshot(host).await).open_document(&id)
}

async fn remove(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    let id = required_string(payload, "agentPreset")?;
    let mut state = host.state.write().await;
    let removed = PresetProcessor::new(state_view(&state)).remove(&id)?;
    let response = removed.response;
    state.presets.remove(&removed.agent_preset);
    Ok(response)
}

async fn snapshot(host: &BasicHost) -> PresetStateView {
    let state = host.state.read().await;
    state_view(&state)
}

fn state_view(state: &HostState) -> PresetStateView {
    PresetStateView {
        presets: state.presets.clone(),
        default_agent_preset: state.default_agent_preset().to_owned(),
        sessions: state
            .sessions
            .iter()
            .map(|(id, session)| {
                (
                    id.clone(),
                    PresetSessionView {
                        running: session.running,
                    },
                )
            })
            .collect(),
    }
}

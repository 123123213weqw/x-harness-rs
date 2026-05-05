//! Settings RPC compatibility adapter around the pure `SettingsProcessor`.

use serde_json::{json, Value};
use xharness_api::{RpcError, RpcId, RpcMethod};
use xharness_control::ControlEvent;

use crate::{
    control::settings_snapshot,
    settings_processor::{SettingsMutation, SettingsProcessor, SettingsStateView},
    BasicHost,
};

use super::{bad_request, nonempty, optional_u64, require_object, required_array, required_string};

pub(super) async fn call(
    host: &BasicHost,
    rpc_id: RpcId,
    method: RpcMethod,
    payload: &Value,
) -> Result<Value, RpcError> {
    match method {
        RpcMethod::SettingsDescribe => describe(host, payload).await,
        RpcMethod::SettingsOpenDocument => open_document(payload),
        RpcMethod::SettingsUpdate => update(host, rpc_id, payload).await,
        RpcMethod::SettingsReplace => replace(host, rpc_id, payload).await,
        RpcMethod::SettingsMutate => mutate(host, rpc_id, payload).await,
        _ => unreachable!("settings adapter received non-settings method {method}"),
    }
}

async fn describe(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    require_object(payload)?;
    Ok(SettingsProcessor::new(snapshot(host).await).describe())
}

fn open_document(payload: &Value) -> Result<Value, RpcError> {
    require_object(payload)?;
    Ok(json!({"opened": true}))
}

async fn update(host: &BasicHost, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
    let _control_guard = host.control_gate.lock().await;
    if let Some(response) = host
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
    let mutation = SettingsProcessor::new(snapshot(host).await).update(&ns, patch, expected)?;
    commit(host, rpc_id, RpcMethod::SettingsUpdate, payload, mutation).await
}

async fn replace(host: &BasicHost, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
    let _control_guard = host.control_gate.lock().await;
    if let Some(response) = host
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
    let mutation = SettingsProcessor::new(snapshot(host).await).replace(&ns, section, expected)?;
    commit(host, rpc_id, RpcMethod::SettingsReplace, payload, mutation).await
}

async fn mutate(host: &BasicHost, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
    let _control_guard = host.control_gate.lock().await;
    if let Some(response) = host
        .replay_control_receipt(&rpc_id, RpcMethod::SettingsMutate, payload)
        .await?
    {
        return Ok(response);
    }
    let ns = nonempty(required_string(payload, "ns")?, "ns")?;
    let ops = required_array(payload, "ops")?.clone();
    let expected = optional_u64(payload, "expectedRevision")?;
    let mutation = SettingsProcessor::new(snapshot(host).await).mutate(&ns, ops, expected)?;
    commit(host, rpc_id, RpcMethod::SettingsMutate, payload, mutation).await
}

async fn snapshot(host: &BasicHost) -> SettingsStateView {
    SettingsStateView {
        namespaces: host.state.read().await.settings.clone(),
    }
}

async fn commit(
    host: &BasicHost,
    rpc_id: RpcId,
    method: RpcMethod,
    payload: &Value,
    mut mutation: SettingsMutation,
) -> Result<Value, RpcError> {
    let model_change = host.prepare_model_change(&mut mutation.namespace).await?;
    let namespace = mutation.namespace;
    let ns = namespace.ns.clone();
    let response = namespace.view();
    let response = host
        .commit_control_mutation(
            &rpc_id,
            method,
            payload,
            vec![ControlEvent::SettingsSet {
                settings: settings_snapshot(&namespace),
            }],
            response,
        )
        .await?;
    host.apply_model_change(model_change);
    host.push_host(json!({
        "type": "host/remote-event",
        "event": "settings/document-updated",
        "args": [ns],
    }));
    Ok(response)
}

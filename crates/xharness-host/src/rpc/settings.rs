//! Settings, credential and model-catalog RPC command service.
//!
//! Settings RPCs are compatibility adapters around the pure
//! `SettingsProcessor`. Model-catalog RPCs remain here until their application
//! boundary is extracted.

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

impl BasicHost {
    /// Why each declared provider currently has no live route, in the shape the
    /// model selector already renders (`session.models.failures` /
    /// `llm.models.failures`). Empty means every declared provider resolved.
    ///
    /// This is the developer-facing half of the same problem `host.describe`
    /// reports: the Host knows perfectly well that a provider is configured and
    /// absent from the runtime, and until now it answered `failures: []` for
    /// every one of them, so the selector could only say "no models available".
    pub(super) async fn model_catalog_failures(&self) -> Vec<Value> {
        let Some(backend) = self.model_settings.get() else {
            return Vec::new();
        };
        let live = self
            .agent_runtime
            .model_catalog()
            .into_iter()
            .map(|descriptor| descriptor.provider)
            .collect::<std::collections::BTreeSet<_>>();
        let (declared, activation_error) = {
            let state = self.state.read().await;
            (
                crate::parse_model_settings(&state.settings[crate::MODEL_SETTINGS_NAMESPACE].value)
                    .ok()
                    .map(|document| document.providers),
                state.model_settings_error.clone(),
            )
        };
        let Some(declared) = declared else {
            return Vec::new();
        };
        let mut failures = Vec::new();
        for (id, profile) in declared {
            if live.contains(&id) {
                continue;
            }
            let message = match &activation_error {
                // The whole activation failed; every declared provider shares it.
                Some(error) => error.clone(),
                None => match profile.api_key_env.as_deref() {
                    Some(reference) => match backend.credential_info(reference).await {
                        Ok(info) if info["configured"] == json!(true) => {
                            "the provider is configured but the Host built no route for it"
                                .to_owned()
                        }
                        Ok(_) => {
                            format!("credential {reference} is not stored for this state directory")
                        }
                        Err(error) => error,
                    },
                    None => {
                        "the provider is configured but the Host built no route for it".to_owned()
                    }
                },
            };
            failures.push(json!({
                "id": id,
                "name": profile.display_name.clone().unwrap_or_else(|| id.clone()),
                "message": message,
            }));
        }
        failures
    }

    pub(super) async fn llm_providers(&self, payload: &Value) -> Result<Value, RpcError> {
        require_object(payload)?;
        if self.model_settings.get().is_some() {
            let state = self.state.read().await;
            let doc =
                crate::parse_model_settings(&state.settings[crate::MODEL_SETTINGS_NAMESPACE].value)
                    .map_err(crate::model_settings::model_settings_error)?;
            let catalog = self.agent_runtime.model_catalog();
            return Ok(json!({"providers":doc.providers.iter().map(|(id,p)| json!({
                "provider":id,"displayName":p.display_name.as_deref().unwrap_or(id),
                "settingsNs":crate::MODEL_SETTINGS_NAMESPACE,"settingsPath":["providers",id],
                "active":catalog.iter().any(|m| &m.provider == id),"declared":true
            })).collect::<Vec<_>>()}));
        }
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

    pub(super) async fn llm_models(&self, payload: &Value) -> Result<Value, RpcError> {
        require_object(payload)?;
        let failures = self.model_catalog_failures().await;
        Ok(json!({"groups": self.model_groups(), "failures": failures}))
    }

    pub(super) async fn llm_discover_models(&self, payload: &Value) -> Result<Value, RpcError> {
        nonempty(required_string(payload, "settingsNs")?, "settingsNs")?;
        if let Some(backend) = self.model_settings.get() {
            if payload["settingsNs"] != crate::MODEL_SETTINGS_NAMESPACE {
                return Err(bad_request("Unsupported model settings namespace"));
            }
            let section = self.state.read().await.settings[crate::MODEL_SETTINGS_NAMESPACE]
                .value
                .clone();
            return backend
                .discover(&section, payload)
                .await
                .map_err(crate::model_settings::model_settings_error);
        }
        let models = self
            .agent_runtime
            .model_catalog()
            .into_iter()
            .map(|model| {
                let mut value = json!({
                    "id": model.model,
                    "name": model.model_display_name,
                    "provider": model.provider,
                });
                if let Some(maximum) = model.context_window.effective_hard_max() {
                    value["contextWindow"] = json!(maximum);
                }
                value
            })
            .collect::<Vec<_>>();
        Ok(json!({"models": models}))
    }

    pub(super) fn model_groups(&self) -> Vec<Value> {
        let mut groups: Vec<(String, String, Vec<Value>)> = Vec::new();
        for model in self.agent_runtime.model_catalog() {
            let mut model_value = json!({"id": model.model, "name": model.model_display_name});
            model_value["contextWindowCapability"] =
                serde_json::to_value(&model.context_window).unwrap_or(Value::Null);
            if let Some(maximum) = model.context_window.effective_hard_max() {
                model_value["contextWindow"] = json!(maximum);
                model_value["contextWindowSource"] =
                    serde_json::to_value(model.context_window.effective_source())
                        .unwrap_or(Value::Null);
            }
            model_value["reasoningCapability"] = model.reasoning_capability.clone();
            if let Some(reasoning) = model.reasoning {
                let efforts = reasoning
                    .efforts
                    .into_iter()
                    .map(|effort| {
                        let mut value = json!({"id": effort.id, "name": effort.name});
                        if let Some(description) = effort.description {
                            value["description"] = Value::String(description);
                        }
                        value
                    })
                    .collect::<Vec<_>>();
                let mut value = json!({"efforts": efforts});
                if let Some(default_effort) = reasoning.default_effort {
                    value["defaultEffort"] = Value::String(default_effort);
                }
                model_value["reasoning"] = value;
            }
            if let Some((_, _, models)) = groups
                .iter_mut()
                .find(|(provider, _, _)| provider == &model.provider)
            {
                models.push(model_value);
            } else {
                groups.push((
                    model.provider,
                    model.provider_display_name,
                    vec![model_value],
                ));
            }
        }
        groups
            .into_iter()
            .map(|(id, name, models)| json!({"id": id, "name": name, "models": models}))
            .collect()
    }
}

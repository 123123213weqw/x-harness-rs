//! Settings, credential and model-catalog RPC command service.
//! Transport dispatch remains in the parent module; this module owns the
//! mutation/read workflow for its bounded domain.

use serde_json::{json, Map, Value};
use xharness_api::{RpcError, RpcId, RpcMethod};
use xharness_control::ControlEvent;

use crate::{control::settings_snapshot, state::SettingsNamespace, BasicHost};

use super::{
    bad_request, check_revision, credential_rejected, merge_object, nonempty, optional_u64,
    require_object, required_array, required_string, set_json_path, settings_rejected,
    unset_json_path, validate_credential_ref, validate_permission_patch,
    validate_permission_section, validate_permission_value,
};

impl BasicHost {
    pub(super) async fn settings_describe(&self, payload: &Value) -> Result<Value, RpcError> {
        require_object(payload)?;
        let state = self.state.read().await;
        Ok(json!({
            "writable": true,
            "hasDocument": false,
            "namespaces": state.settings.values().map(SettingsNamespace::view).collect::<Vec<_>>(),
        }))
    }

    pub(super) async fn settings_open_document(&self, payload: &Value) -> Result<Value, RpcError> {
        require_object(payload)?;
        Ok(json!({"opened": true}))
    }

    pub(super) async fn settings_update(
        &self,
        rpc_id: RpcId,
        payload: &Value,
    ) -> Result<Value, RpcError> {
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
        crate::preference_settings::validate(&namespace)?;
        merge_object(&mut namespace.value, &namespace.user);
        namespace.revision = namespace.revision.saturating_add(1);
        drop(state);
        let model_change = self.prepare_model_change(&mut namespace).await?;
        let view = namespace.view();
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
        self.apply_model_change(model_change);
        self.push_host(json!({
            "type": "host/remote-event",
            "event": "settings/document-updated",
            "args": [ns],
        }));
        Ok(view)
    }

    pub(super) async fn settings_replace(
        &self,
        rpc_id: RpcId,
        payload: &Value,
    ) -> Result<Value, RpcError> {
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
        crate::preference_settings::validate(&namespace)?;
        namespace.value = Value::Object(section);
        if ns == crate::MODEL_SETTINGS_NAMESPACE {
            namespace.value = namespace.base.clone();
            merge_object(&mut namespace.value, &namespace.user);
        }
        namespace.revision = namespace.revision.saturating_add(1);
        drop(state);
        let model_change = self.prepare_model_change(&mut namespace).await?;
        let view = namespace.view();
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
        self.apply_model_change(model_change);
        self.push_host(json!({
            "type": "host/remote-event",
            "event": "settings/document-updated",
            "args": [ns],
        }));
        Ok(view)
    }

    pub(super) async fn settings_mutate(
        &self,
        rpc_id: RpcId,
        payload: &Value,
    ) -> Result<Value, RpcError> {
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
        crate::preference_settings::validate(&namespace)?;
        namespace.value = namespace.user.clone();
        if ns == crate::MODEL_SETTINGS_NAMESPACE {
            namespace.value = namespace.base.clone();
            merge_object(&mut namespace.value, &namespace.user);
        }
        namespace.revision = namespace.revision.saturating_add(1);
        drop(state);
        let model_change = self.prepare_model_change(&mut namespace).await?;
        let view = namespace.view();
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
        self.apply_model_change(model_change);
        self.push_host(json!({
            "type": "host/remote-event",
            "event": "settings/document-updated",
            "args": [ns],
        }));
        Ok(view)
    }

    pub(super) async fn credentials_describe(&self, payload: &Value) -> Result<Value, RpcError> {
        let refs = required_array(payload, "refs")?;
        if refs.len() > 64 {
            return Err(bad_request("at most 64 credential references are accepted"));
        }
        if let Some(backend) = self.model_settings.get() {
            let _guard = self.control_gate.lock().await;
            let mut credentials = Map::new();
            for reference in refs {
                let reference = reference
                    .as_str()
                    .ok_or_else(|| bad_request("Credential references must be strings"))?;
                validate_credential_ref(reference)?;
                credentials.insert(
                    reference.to_owned(),
                    backend
                        .credential_info(reference)
                        .await
                        .map_err(crate::model_settings::model_settings_error)?,
                );
            }
            return Ok(json!({"credentials":credentials}));
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

    pub(super) async fn credentials_set(&self, payload: &Value) -> Result<Value, RpcError> {
        let reference = required_string(payload, "ref")?;
        validate_credential_ref(&reference)?;
        let value = nonempty(required_string(payload, "value")?, "value")?;
        if let Some(backend) = self.model_settings.get() {
            let _guard = self.control_gate.lock().await;
            let section = self.state.read().await.settings[crate::MODEL_SETTINGS_NAMESPACE]
                .value
                .clone();
            backend.activate(
                backend
                    .set_credential(&reference, &value, &section)
                    .await
                    .map_err(crate::model_settings::model_settings_error)?,
            );
            self.push_host(json!({"type":"host/remote-event","event":"settings/document-updated","args":[crate::MODEL_SETTINGS_NAMESPACE]}));
            return Ok(json!({}));
        }
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

    pub(super) async fn credentials_unset(&self, payload: &Value) -> Result<Value, RpcError> {
        let reference = required_string(payload, "ref")?;
        validate_credential_ref(&reference)?;
        if let Some(backend) = self.model_settings.get() {
            let _guard = self.control_gate.lock().await;
            let section = self.state.read().await.settings[crate::MODEL_SETTINGS_NAMESPACE]
                .value
                .clone();
            backend.activate(
                backend
                    .unset_credential(&reference, &section)
                    .await
                    .map_err(crate::model_settings::model_settings_error)?,
            );
            self.push_host(json!({"type":"host/remote-event","event":"settings/document-updated","args":[crate::MODEL_SETTINGS_NAMESPACE]}));
            return Ok(json!({}));
        }
        if std::env::var_os(&reference).is_some_and(|value| !value.is_empty()) {
            return Err(credential_rejected(&reference));
        }
        self.state.write().await.credentials.remove(&reference);
        Ok(json!({}))
    }

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

//! Pure Settings application decisions.
//!
//! The RPC adapter owns transport validation, receipt replay, locking,
//! persistence and live model activation. This processor only receives a
//! settings snapshot and calculates the next namespace state.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};
use xharness_api::{RpcError, RpcErrorCode};

use crate::state::SettingsNamespace;

#[derive(Clone, Debug)]
pub(crate) struct SettingsStateView {
    pub(crate) namespaces: BTreeMap<String, SettingsNamespace>,
}

#[derive(Debug)]
pub(crate) struct SettingsMutation {
    pub(crate) namespace: SettingsNamespace,
}

pub(crate) struct SettingsProcessor {
    state: SettingsStateView,
}

impl SettingsProcessor {
    pub(crate) fn new(state: SettingsStateView) -> Self {
        Self { state }
    }

    pub(crate) fn describe(&self) -> Value {
        json!({
            "writable": true,
            "hasDocument": false,
            "namespaces": self.state.namespaces.values().map(SettingsNamespace::view).collect::<Vec<_>>(),
        })
    }

    pub(crate) fn update(
        &self,
        ns: &str,
        patch: Map<String, Value>,
        expected_revision: Option<u64>,
    ) -> Result<SettingsMutation, RpcError> {
        if ns == "permission" {
            validate_permission_patch(&patch)?;
        }
        let mut namespace = self.namespace(ns, expected_revision)?;
        merge_object(&mut namespace.user, &Value::Object(patch));
        crate::preference_settings::validate(&namespace)?;
        if ns == crate::MODEL_SETTINGS_NAMESPACE {
            namespace.value = merge_model_layers(&namespace.base, &namespace.user);
        } else {
            merge_object(&mut namespace.value, &namespace.user);
        }
        namespace.revision = namespace.revision.saturating_add(1);
        Ok(SettingsMutation { namespace })
    }

    pub(crate) fn replace(
        &self,
        ns: &str,
        section: Map<String, Value>,
        expected_revision: Option<u64>,
    ) -> Result<SettingsMutation, RpcError> {
        if ns == "permission" {
            validate_permission_section(&section)?;
        }
        let mut namespace = self.namespace(ns, expected_revision)?;
        namespace.user = Value::Object(section.clone());
        crate::preference_settings::validate(&namespace)?;
        namespace.value = Value::Object(section);
        if ns == crate::MODEL_SETTINGS_NAMESPACE {
            namespace.value = merge_model_layers(&namespace.base, &namespace.user);
        }
        namespace.revision = namespace.revision.saturating_add(1);
        Ok(SettingsMutation { namespace })
    }

    pub(crate) fn mutate(
        &self,
        ns: &str,
        ops: Vec<Value>,
        expected_revision: Option<u64>,
    ) -> Result<SettingsMutation, RpcError> {
        let mut namespace = self.namespace(ns, expected_revision)?;
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
                            return Err(settings_rejected(ns));
                        }
                        validate_permission_value(&value)?;
                    }
                    set_json_path(&mut namespace.user, &path, value)?;
                }
                "unset" => {
                    if ns == "permission" {
                        return Err(settings_rejected(ns));
                    }
                    unset_json_path(&mut namespace.user, &path)?;
                }
                _ => return Err(bad_request("settings op must be set or unset")),
            }
        }
        crate::preference_settings::validate(&namespace)?;
        namespace.value = namespace.user.clone();
        if ns == crate::MODEL_SETTINGS_NAMESPACE {
            namespace.value = merge_model_layers(&namespace.base, &namespace.user);
        }
        namespace.revision = namespace.revision.saturating_add(1);
        Ok(SettingsMutation { namespace })
    }

    fn namespace(
        &self,
        ns: &str,
        expected_revision: Option<u64>,
    ) -> Result<SettingsNamespace, RpcError> {
        let namespace = self
            .state
            .namespaces
            .get(ns)
            .cloned()
            .ok_or_else(|| settings_rejected(ns))?;
        check_revision(&namespace, expected_revision)?;
        Ok(namespace)
    }
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

/// Model `value` is derived state, not a replayable snapshot. Rebase user
/// overrides on each deployment's current provider defaults.
pub fn merge_model_layers(base: &Value, user: &Value) -> Value {
    let mut merged = base.clone();
    merge_object(&mut merged, user);
    // Arrays remain user-owned (including order and deletions). Only an omitted
    // output target inherits a matching deployment model's declared maximum.
    // Do not copy a limit across endpoints, protocols or upstream model aliases.
    if let Some(providers) = merged.get_mut("providers").and_then(Value::as_object_mut) {
        for (id, provider) in providers {
            let Some(defaults) = base.get("providers").and_then(|p| p.get(id)) else {
                continue;
            };
            let same_route = ["baseURL", "api"]
                .iter()
                .all(|key| provider.get(*key) == defaults.get(*key));
            if !same_route {
                if user
                    .get("providers")
                    .and_then(|p| p.get(id))
                    .and_then(|p| p.get("maxTokens"))
                    .filter(|v| !v.is_null())
                    .is_none()
                {
                    if let Some(object) = provider.as_object_mut() {
                        object.remove("maxTokens");
                    }
                }
                continue;
            }
            if provider.get("maxTokens").is_some_and(Value::is_null) {
                if let (Some(object), Some(maximum)) =
                    (provider.as_object_mut(), defaults.get("maxTokens"))
                {
                    object.insert("maxTokens".to_owned(), maximum.clone());
                }
            }
            let Some(models) = provider.get_mut("models").and_then(Value::as_array_mut) else {
                continue;
            };
            let Some(base_models) = defaults.get("models").and_then(Value::as_array) else {
                continue;
            };
            for model in models {
                if model.get("maxTokens").is_some_and(|v| !v.is_null()) {
                    continue;
                }
                let Some(default) = base_models.iter().find(|base_model| {
                    model.get("id").is_some()
                        && model.get("id") == base_model.get("id")
                        && model
                            .get("upstreamModel")
                            .filter(|v| !v.is_null())
                            .or_else(|| model.get("id"))
                            == base_model
                                .get("upstreamModel")
                                .filter(|v| !v.is_null())
                                .or_else(|| base_model.get("id"))
                }) else {
                    continue;
                };
                if let (Some(object), Some(maximum)) =
                    (model.as_object_mut(), default.get("maxTokens"))
                {
                    object.insert("maxTokens".to_owned(), maximum.clone());
                }
            }
        }
    }
    merged
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

fn settings_rejected(ns: &str) -> RpcError {
    rpc_error(
        RpcErrorCode::SettingsRejected,
        format!("settings namespace {ns:?} is unavailable"),
        json!({"ns": ns}),
    )
}

fn bad_request(message: impl Into<String>) -> RpcError {
    RpcError::bad_request(message, json!([]))
}

fn rpc_error(code: RpcErrorCode, message: impl Into<String>, details: Value) -> RpcError {
    RpcError {
        code,
        message: message.into(),
        details,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn namespace(ns: &str, revision: u64) -> SettingsNamespace {
        SettingsNamespace {
            ns: ns.to_owned(),
            schema: json!({}),
            base: json!({"base": true}),
            value: json!({"base": true, "nested": {"old": 1}}),
            user: json!({"nested": {"old": 1}}),
            applies: "live".to_owned(),
            revision,
        }
    }

    fn processor(namespace: SettingsNamespace) -> SettingsProcessor {
        SettingsProcessor::new(SettingsStateView {
            namespaces: [(namespace.ns.clone(), namespace)].into_iter().collect(),
        })
    }

    #[test]
    fn update_is_deterministic_and_checks_revision() {
        let processor = processor(namespace("test", 4));
        let patch = json!({"nested": {"new": 2}}).as_object().unwrap().clone();
        let changed = processor.update("test", patch.clone(), Some(4)).unwrap();
        assert_eq!(changed.namespace.revision, 5);
        assert_eq!(
            changed.namespace.user["nested"],
            json!({"old": 1, "new": 2})
        );
        assert_eq!(
            changed.namespace.value["nested"],
            json!({"old": 1, "new": 2})
        );

        let error = processor.update("test", patch, Some(3)).unwrap_err();
        assert_eq!(error.code, RpcErrorCode::SettingsConflict);
        assert_eq!(error.details, json!({"ns":"test","expected":3,"actual":4}));
    }

    #[test]
    fn replace_and_mutate_preserve_model_base() {
        let mut model = namespace(crate::MODEL_SETTINGS_NAMESPACE, 0);
        model.base = json!({"providers":{"base":{"models":[]}}});
        model.value = model.base.clone();
        model.user = json!({});
        let model_processor = processor(model);
        let section = json!({"providers":{"custom":{"models":[]}}})
            .as_object()
            .unwrap()
            .clone();
        let replaced = model_processor
            .replace(crate::MODEL_SETTINGS_NAMESPACE, section, Some(0))
            .unwrap();
        assert!(replaced.namespace.value["providers"]["base"].is_object());
        assert!(replaced.namespace.value["providers"]["custom"].is_object());

        let model_processor = processor(replaced.namespace);
        let mutated = model_processor
            .mutate(
                crate::MODEL_SETTINGS_NAMESPACE,
                vec![json!({"op":"set","path":["providers","custom","displayName"],"value":"Custom"})],
                Some(1),
            )
            .unwrap();
        assert_eq!(
            mutated.namespace.value["providers"]["custom"]["displayName"],
            "Custom"
        );
        assert!(mutated.namespace.value["providers"]["base"].is_object());
    }

    #[test]
    fn rejected_mutation_does_not_change_snapshot() {
        let before = namespace("test", 2);
        let processor = processor(before.clone());
        let error = processor
            .mutate("test", vec![json!({"op":"invalid","path":["x"]})], Some(2))
            .unwrap_err();
        assert_eq!(error.code, RpcErrorCode::BadRequest);
        assert_eq!(processor.state.namespaces["test"].view(), before.view());
    }

    #[test]
    fn permission_namespace_rejects_unknown_fields_and_unset() {
        let mut permission = namespace("permission", 0);
        permission.base = json!({"defaultPreset":"workspace-write"});
        permission.value = permission.base.clone();
        permission.user = json!({});
        let processor = processor(permission);

        let error = processor
            .update(
                "permission",
                json!({"other":true}).as_object().unwrap().clone(),
                Some(0),
            )
            .unwrap_err();
        assert_eq!(error.code, RpcErrorCode::SettingsRejected);

        let error = processor
            .mutate(
                "permission",
                vec![json!({"op":"unset","path":["defaultPreset"]})],
                Some(0),
            )
            .unwrap_err();
        assert_eq!(error.code, RpcErrorCode::SettingsRejected);
    }
}

#[cfg(test)]
mod output_default_tests {
    use super::*;
    #[test]
    fn only_matching_output_defaults_inherit_without_resurrecting_rows() {
        let base = json!({"providers":{"p":{"baseURL":"https://one.example/v1","api":"openai-completions","maxTokens":8000,"models":[{"id":"a","maxTokens":64000,"minimumOutputTokens":8192},{"id":"deleted","maxTokens":9000}]}}});
        let user = json!({"providers":{"p":{"models":[{"id":"new","extra":true},{"id":"a","future":{"keep":true}}]}}});
        let merged = merge_model_layers(&base, &user);
        let rows = merged["providers"]["p"]["models"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], user["providers"]["p"]["models"][0]);
        assert_eq!(rows[1]["maxTokens"], 64000);
        assert!(rows[1].get("minimumOutputTokens").is_none());
        assert_eq!(rows[1]["future"], json!({"keep":true}));
        for patch in [
            json!({"baseURL":"https://two.example/v1"}),
            json!({"api":"openai-responses"}),
        ] {
            let mut changed = user.clone();
            merge_object(&mut changed["providers"]["p"], &patch);
            let next = merge_model_layers(&base, &changed);
            assert!(next["providers"]["p"].get("maxTokens").is_none());
            assert!(next["providers"]["p"]["models"][1]
                .get("maxTokens")
                .is_none());
        }
        let alias = json!({"providers":{"p":{"models":[{"id":"a","upstreamModel":"different"}]}}});
        assert!(
            merge_model_layers(&base, &alias)["providers"]["p"]["models"][0]
                .get("maxTokens")
                .is_none()
        );
        let explicit = json!({"providers":{"p":{"models":[{"id":"a","maxTokens":32000,"minimumOutputTokens":1234}]}}});
        assert_eq!(
            merge_model_layers(&base, &explicit)["providers"]["p"]["models"],
            explicit["providers"]["p"]["models"]
        );
        assert_eq!(
            base["providers"]["p"]["models"].as_array().unwrap().len(),
            2
        );
    }
}

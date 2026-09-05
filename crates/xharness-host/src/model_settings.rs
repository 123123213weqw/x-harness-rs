//! UI-independent model configuration boundary. Secrets never enter settings.
use std::collections::BTreeSet;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use xharness_api::{RpcError, RpcErrorCode};

use crate::{driver::rpc_error, state::SettingsNamespace, BasicHost, ModelRegistry};

pub const MODEL_SETTINGS_NAMESPACE: &str = "llm-pi-ai";

/// Production composition implements this; the Host has no native keychain or
/// HTTP-provider dependency. Preparing must not change the active registry.
#[async_trait]
pub trait ModelSettingsBackend: Send + Sync + 'static {
    async fn prepare(&self, section: &Value) -> Result<ModelRegistry, String>;
    fn activate(&self, registry: ModelRegistry);
    async fn credential_info(&self, reference: &str) -> Result<Value, String>;
    async fn set_credential(&self, reference: &str, value: &str) -> Result<(), String>;
    async fn unset_credential(&self, reference: &str) -> Result<(), String>;
    async fn discover(&self, section: &Value, request: &Value) -> Result<Value, String>;
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModelSettingsDocument {
    #[serde(default)]
    pub providers: std::collections::BTreeMap<String, ProviderProfile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(rename = "baseURL")]
    pub base_url: String,
    pub api: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_env: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    pub models: Vec<ConfiguredModel>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfiguredModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    /// Native metadata is preserved by the upstream model editor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum_output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_safety_margin: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window_capability: Option<Value>,
}

pub fn valid_credential_reference(value: &str) -> bool {
    let mut chars = value.bytes();
    value.len() <= 128
        && matches!(chars.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'_'))
        && chars.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

pub fn parse_model_settings(value: &Value) -> Result<ModelSettingsDocument, String> {
    // Never echo rejected input; it may contain a key pasted in the wrong box.
    let doc: ModelSettingsDocument = serde_json::from_value(value.clone())
        .map_err(|_| "Invalid provider profile fields or field types".to_owned())?;
    if doc.providers.len() > 128 {
        return Err("At most 128 providers are supported".to_owned());
    }
    for (id, profile) in &doc.providers {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err(
                "Provider IDs must contain only letters, digits, hyphens or underscores".to_owned(),
            );
        }
        if !matches!(
            profile.api.as_str(),
            "openai-completions" | "openai-responses"
        ) {
            return Err(
                "Only OpenAI chat completions and responses protocols are supported".to_owned(),
            );
        }
        let url = url::Url::parse(&profile.base_url)
            .map_err(|_| "Invalid provider endpoint".to_owned())?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(
                "Endpoint must be an HTTP(S) URL without credentials, query or fragment".to_owned(),
            );
        }
        if profile
            .api_key_env
            .as_deref()
            .is_some_and(|v| !valid_credential_reference(v))
        {
            return Err("Invalid API key reference".to_owned());
        }
        if profile.models.is_empty() || profile.models.len() > 512 {
            return Err("A provider requires between 1 and 512 models".to_owned());
        }
        let mut ids = BTreeSet::new();
        for model in &profile.models {
            if model.id.trim().is_empty()
                || model.id.trim() != model.id
                || model.id.len() > 512
                || !ids.insert(&model.id)
                || model.id.chars().any(char::is_control)
            {
                return Err(
                    "Model IDs must be nonempty, unique and have no surrounding whitespace"
                        .to_owned(),
                );
            }
            for count in [
                model.context_window,
                model.max_tokens,
                profile.default_context_window,
                profile.max_tokens,
            ] {
                if count.is_some_and(|v| v == 0 || v > 1_000_000_000) {
                    return Err(
                        "Token limits must be positive integers no greater than 1000000000"
                            .to_owned(),
                    );
                }
            }
        }
    }
    Ok(doc)
}

/// Schemastery, not JSON Schema: the bundled client walks providers/<id>/api.
pub fn model_settings_schema() -> Value {
    json!({"uid": 12, "refs": {
        "1": {"type":"string"},
        "2": {"type":"number"},
        "3": {"type":"const", "value":"openai-completions"},
        "4": {"type":"const", "value":"openai-responses"},
        "5": {"type":"union", "list":[3,4]},
        "6": {"type":"any"},
        "7": {"type":"object", "dict": {"id":1,"name":1,"contextWindow":2,"maxTokens":2,"upstreamModel":1,"minimumOutputTokens":2,"tokenSafetyMargin":2,"reasoning":6,"contextWindowCapability":6}},
        "8": {"type":"array", "inner":7},
        "9": {"type":"object", "dict": {"displayName":1,"baseURL":1,"api":5,"apiKeyEnv":1,"defaultContextWindow":2,"maxTokens":2,"models":8}},
        "10": {"type":"dict", "inner":9},
        "12": {"type":"object", "dict":{"providers":10}}
    }})
}

pub(crate) fn empty_model_namespace() -> SettingsNamespace {
    SettingsNamespace {
        ns: MODEL_SETTINGS_NAMESPACE.to_owned(),
        schema: model_settings_schema(),
        base: json!({"providers":{}}),
        value: json!({"providers":{}}),
        user: json!({}),
        applies: "live".to_owned(),
        revision: 0,
    }
}

impl BasicHost {
    /// Call before restore_from_store; then call refresh_model_settings after
    /// restore. Imported defaults remain distinct from user overrides.
    pub async fn install_model_settings(
        &self,
        backend: std::sync::Arc<dyn ModelSettingsBackend>,
        base: Value,
    ) -> Result<(), String> {
        parse_model_settings(&base)?;
        self.model_settings
            .set(backend)
            .map_err(|_| "Model settings already installed".to_owned())?;
        let mut state = self.state.write().await;
        let ns = state
            .settings
            .get_mut(MODEL_SETTINGS_NAMESPACE)
            .expect("model namespace seeded");
        ns.base = base.clone();
        ns.value = base;
        Ok(())
    }

    pub async fn refresh_model_settings(&self) -> Result<(), String> {
        let _guard = self.control_gate.lock().await;
        if let Some(backend) = self.model_settings.get() {
            let section = self.state.read().await.settings[MODEL_SETTINGS_NAMESPACE]
                .value
                .clone();
            backend.activate(backend.prepare(&section).await?);
        }
        Ok(())
    }

    pub(crate) async fn prepare_model_change(
        &self,
        ns: &SettingsNamespace,
    ) -> Result<Option<ModelRegistry>, RpcError> {
        if ns.ns != MODEL_SETTINGS_NAMESPACE {
            return Ok(None);
        }
        let backend = self.model_settings.get().ok_or_else(|| {
            model_settings_error("Model configuration is unavailable in this embedded Host")
        })?;
        parse_model_settings(&ns.value).map_err(model_settings_error)?;
        backend
            .prepare(&ns.value)
            .await
            .map(Some)
            .map_err(model_settings_error)
    }

    pub(crate) fn apply_model_change(&self, registry: Option<ModelRegistry>) {
        if let (Some(backend), Some(registry)) = (self.model_settings.get(), registry) {
            backend.activate(registry);
        }
    }
}

pub(crate) fn model_settings_error(message: impl Into<String>) -> RpcError {
    rpc_error(
        RpcErrorCode::BadRequest,
        message,
        json!({"ns":MODEL_SETTINGS_NAMESPACE}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_profiles_without_accepting_plaintext_secrets() {
        let mut section = json!({"providers":{"local":{"baseURL":"http://127.0.0.1:1234/v1","api":"openai-completions","models":[{"id":"coder"}]}}});
        assert!(parse_model_settings(&section).is_ok());
        section["providers"]["local"]["apiKey"] = json!("not-a-real-secret");
        assert!(parse_model_settings(&section).is_err());
        section["providers"]["local"]
            .as_object_mut()
            .unwrap()
            .remove("apiKey");
        section["providers"]["local"]["models"] = json!([{"id":"coder"},{"id":"coder"}]);
        assert!(parse_model_settings(&section).is_err());
    }
    #[test]
    fn schema_exposes_only_supported_protocols() {
        let s = model_settings_schema();
        assert_eq!(s["refs"]["12"]["dict"]["providers"], 10);
        assert_eq!(s["refs"]["10"]["inner"], 9);
        assert_eq!(s["refs"]["5"]["list"], json!([3, 4]));
    }
}

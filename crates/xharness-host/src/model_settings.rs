//! UI-independent model configuration boundary. Secrets never enter settings.
use std::collections::BTreeSet;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use xharness_api::{RpcError, RpcErrorCode};

use crate::{
    driver::rpc_error,
    state::{ModelSelection, SettingsNamespace},
    BasicHost, ModelDescriptor, ModelRegistry, ModelRoute,
};

pub const MODEL_SETTINGS_NAMESPACE: &str = "llm-pi-ai";

/// Production composition implements this; the Host has no native keychain or
/// HTTP-provider dependency. Preparing must not change the active registry.
#[async_trait]
pub trait ModelSettingsBackend: Send + Sync + 'static {
    async fn prepare(&self, section: &Value) -> Result<ModelRegistry, String>;
    fn activate(&self, registry: ModelRegistry);
    async fn refresh(&self, section: &Value) -> Result<ModelRegistry, String> {
        self.prepare(section).await
    }
    async fn credential_info(&self, reference: &str) -> Result<Value, String>;
    async fn set_credential(
        &self,
        reference: &str,
        value: &str,
        section: &Value,
    ) -> Result<ModelRegistry, String>;
    async fn unset_credential(
        &self,
        reference: &str,
        section: &Value,
    ) -> Result<ModelRegistry, String>;
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
    pub usage_input_semantics: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_env: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    pub models: Vec<ConfiguredModel>,
    /// Optional, explicitly configured capability endpoint; never guessed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_discovery: Option<Value>,
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
    #[serde(
        default,
        deserialize_with = "present_json",
        skip_serializing_if = "Option::is_none"
    )]
    pub reasoning: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window_capability: Option<Value>,
    /// None: unknown; false: reject images before network; true: explicitly supported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_input: Option<bool>,
}

fn present_json<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

/// Fill omitted capability fields only for the same endpoint/protocol/upstream route.
/// Array replacement must not erase capabilities, but explicit null disables reasoning.
/// No deleted models are re-added, and user values always take precedence.
pub(crate) fn inherit_model_capabilities(value: &mut Value, previous: &Value) {
    let Some(providers) = value.get_mut("providers").and_then(Value::as_object_mut) else {
        return;
    };
    for (id, profile) in providers {
        let Some(old) = previous.get("providers").and_then(|p| p.get(id)) else {
            continue;
        };
        if profile.get("baseURL") != old.get("baseURL") || profile.get("api") != old.get("api") {
            continue;
        }
        let Some(models) = profile.get_mut("models").and_then(Value::as_array_mut) else {
            continue;
        };
        for model in models {
            let Some(prior) = old
                .get("models")
                .and_then(Value::as_array)
                .and_then(|ms| ms.iter().find(|m| m.get("id") == model.get("id")))
            else {
                continue;
            };
            if model
                .get("upstreamModel")
                .filter(|v| !v.is_null())
                .or_else(|| model.get("id"))
                != prior
                    .get("upstreamModel")
                    .filter(|v| !v.is_null())
                    .or_else(|| prior.get("id"))
            {
                continue;
            }
            for key in ["reasoning", "contextWindowCapability", "imageInput"] {
                if model.get(key).is_none() {
                    if let Some(v) = prior.get(key) {
                        model[key] = v.clone();
                    }
                }
            }
        }
    }
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
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
        {
            return Err(
                "Provider IDs must contain only letters, digits, dots, hyphens or underscores"
                    .to_owned(),
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
        if profile
            .usage_input_semantics
            .as_deref()
            .is_some_and(|s| !matches!(s, "auto" | "total_includes_cache" | "uncached_input"))
        {
            return Err("Invalid input usage semantics".to_owned());
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
            let context = model
                .context_window
                .or(profile.default_context_window)
                .unwrap_or(32_768);
            let output = model.max_tokens.or(profile.max_tokens).unwrap_or(4_096);
            let margin = model.token_safety_margin.unwrap_or(1_024);
            let minimum = model.minimum_output_tokens.unwrap_or(output);
            if minimum == 0
                || minimum > output
                || margin > 1_000_000_000
                || output.saturating_add(margin) >= context
            {
                return Err("Model output reserve and safety margin must fit its context window; minimum output must be positive and no greater than maximum output".to_owned());
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
        "7": {"type":"object", "dict": {"id":1,"name":1,"contextWindow":2,"maxTokens":2,"upstreamModel":1,"minimumOutputTokens":2,"tokenSafetyMargin":2,"reasoning":6,"contextWindowCapability":6,"imageInput":6}},
        "8": {"type":"array", "inner":7},
        "9": {"type":"object", "dict": {"displayName":1,"baseURL":1,"api":5,"apiKeyEnv":1,"usageInputSemantics":1,"defaultContextWindow":2,"maxTokens":2,"models":8,"reasoningDiscovery":6}},
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
    /// Call before restore_from_store, which activates restored settings before
    /// resuming queued inputs. Imported defaults remain distinct from overrides.
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
            backend.activate(backend.refresh(&section).await?);
        }
        // The registry just changed under the sessions that were pinned to the
        // old one.
        self.reconcile_model_routes().await;
        Ok(())
    }

    pub(crate) async fn prepare_model_change(
        &self,
        ns: &mut SettingsNamespace,
    ) -> Result<Option<ModelRegistry>, RpcError> {
        if ns.ns != MODEL_SETTINGS_NAMESPACE {
            return Ok(None);
        }
        let backend = self.model_settings.get().ok_or_else(|| {
            model_settings_error("Model configuration is unavailable in this embedded Host")
        })?;
        let previous = self.state.read().await.settings[MODEL_SETTINGS_NAMESPACE]
            .value
            .clone();
        inherit_model_capabilities(&mut ns.value, &previous);
        inherit_model_capabilities(&mut ns.value, &ns.base);
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
            if self.config.auto_titles {
                let host = self.clone();
                tokio::spawn(async move {
                    host.backfill_auto_titles().await;
                });
            }
        }
    }
}

/// Repair a stored model selection that the live registry no longer accepts as
/// it stands.
///
/// The stored context window and reasoning effort are snapshots of what the
/// deployment advertised when the user chose them. A later settings edit or an
/// upgraded deployment can shrink either one, and `can_route` then fails for a
/// session whose provider and model are both healthy: the model selector reads
/// `routable: false` and blocks the composer with "model unavailable" while
/// `llm.providers` still reports the provider as active, and nothing explains
/// the disagreement. Clamp the selection back onto what the registry describes
/// and return a description of what changed.
///
/// A route whose provider or model is genuinely absent is deliberately left
/// alone: there is nothing to clamp to, and the user has to choose a
/// replacement.
pub(crate) fn reconcile_session_model(
    selection: &mut ModelSelection,
    catalog: &[ModelDescriptor],
    can_route: &dyn Fn(&ModelRoute) -> bool,
) -> Option<String> {
    let route = |candidate: &ModelSelection| ModelRoute {
        provider: candidate.provider.clone(),
        model: candidate.model.clone(),
        reasoning_effort: candidate.reasoning_effort.clone(),
        context_window_tokens: candidate.context_window_tokens,
    };
    if can_route(&route(selection)) {
        return None;
    }
    let descriptor = catalog
        .iter()
        .find(|entry| entry.provider == selection.provider && entry.model == selection.model)?;
    let window = descriptor.context_window.effective_hard_max();
    let mut efforts = vec![selection.reasoning_effort.clone()];
    if let Some(default) = descriptor
        .reasoning
        .as_ref()
        .and_then(|reasoning| reasoning.default_effort.clone())
    {
        efforts.push(Some(default));
    }
    efforts.push(None);
    for effort in efforts {
        let candidate = ModelSelection {
            provider: selection.provider.clone(),
            model: selection.model.clone(),
            reasoning_effort: effort,
            context_window_tokens: window,
        };
        if !can_route(&route(&candidate)) {
            continue;
        }
        let mut changes = Vec::new();
        if candidate.reasoning_effort != selection.reasoning_effort {
            changes.push(format!(
                "reasoning effort {} -> {}",
                selection.reasoning_effort.as_deref().unwrap_or("none"),
                candidate.reasoning_effort.as_deref().unwrap_or("none")
            ));
        }
        if candidate.context_window_tokens != selection.context_window_tokens {
            changes.push(format!(
                "context window {} -> {}",
                selection
                    .context_window_tokens
                    .map_or_else(|| "none".to_owned(), |value| value.to_string()),
                candidate
                    .context_window_tokens
                    .map_or_else(|| "none".to_owned(), |value| value.to_string())
            ));
        }
        *selection = candidate;
        return Some(changes.join(", "));
    }
    None
}

impl BasicHost {
    /// Re-apply every session's stored model selection to the live registry and
    /// clamp whatever it no longer accepts. Returns one issue per repaired
    /// session so the reason can reach `host.describe.startupIssues`.
    ///
    /// The clamped selection is process state, not a new durable event: it is
    /// recomputed identically from the durable selection on every start, so the
    /// session log keeps recording what the user actually chose.
    pub(crate) async fn reconcile_model_routes(&self) -> Vec<crate::HostRestoreIssue> {
        let catalog = self.agent_runtime.model_catalog();
        if catalog.is_empty() {
            return Vec::new();
        }
        let can_route = |route: &ModelRoute| self.agent_runtime.can_route(route);
        let mut issues = Vec::new();
        let mut state = self.state.write().await;
        let ids = state.sessions.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            let Some(session) = state.sessions.get_mut(&id) else {
                continue;
            };
            let Some(changes) = reconcile_session_model(&mut session.model, &catalog, &can_route)
            else {
                continue;
            };
            issues.push(crate::HostRestoreIssue {
                session_id: id,
                message: format!(
                    "the deployment no longer offers the stored model selection as saved;                      adjusted it to keep the model usable ({changes})"
                ),
            });
        }
        issues
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
    fn preserves_legacy_dotted_provider_routes() {
        for id in [
            "llama.cpp-4080",
            "llama.cpp-v100",
            "my.provider_v2",
            "remote.api_v3",
        ] {
            let section = json!({"providers":{(id):{
                "baseURL":"http://127.0.0.1:1234/v1",
                "api":"openai-completions", "models":[{"id":"coder"}]
            }}});
            let parsed = parse_model_settings(&section).unwrap();
            assert!(
                parsed.providers.contains_key(id),
                "route identity must not change"
            );
        }
        for id in [
            "",
            "with space",
            "path/provider",
            "bad\\route",
            "line\nfeed",
        ] {
            let section = json!({"providers":{(id):{
                "baseURL":"http://127.0.0.1:1234/v1",
                "api":"openai-completions", "models":[{"id":"coder"}]
            }}});
            assert!(parse_model_settings(&section).is_err());
        }
        assert!(
            !valid_credential_reference("llama.cpp"),
            "credential rules stay separate"
        );
    }

    #[test]
    fn schema_exposes_only_supported_protocols() {
        let s = model_settings_schema();
        assert_eq!(s["refs"]["12"]["dict"]["providers"], 10);
        assert_eq!(s["refs"]["10"]["inner"], 9);
        assert_eq!(s["refs"]["5"]["list"], json!([3, 4]));
    }
}

#[cfg(test)]
mod capability_inheritance_tests {
    use super::*;
    fn base() -> Value {
        json!({"providers":{"p":{"baseURL":"https://api.example/v1","api":"openai-completions","models":[{"id":"m","reasoning":{"efforts":[{"id":"high"}]},"imageInput":true}]}}})
    }
    #[test]
    fn omitted_metadata_survives_array_replacement_but_explicit_null_does_not_inherit() {
        let base = base();
        let mut value = base.clone();
        value["providers"]["p"]["models"] = json!([{"id":"m","name":"renamed"}]);
        inherit_model_capabilities(&mut value, &base);
        assert_eq!(
            value["providers"]["p"]["models"][0]["reasoning"],
            base["providers"]["p"]["models"][0]["reasoning"]
        );
        assert_eq!(value["providers"]["p"]["models"][0]["name"], "renamed");
        value["providers"]["p"]["models"][0]["reasoning"] = Value::Null;
        inherit_model_capabilities(&mut value, &base);
        let doc = parse_model_settings(&value).unwrap();
        assert_eq!(doc.providers["p"].models[0].reasoning, Some(Value::Null));
    }
    #[test]
    fn never_inherits_across_endpoint_protocol_or_model_changes() {
        let base = base();
        for (field, new) in [
            ("baseURL", json!("https://other.example/v1")),
            ("api", json!("openai-responses")),
        ] {
            let mut value = base.clone();
            value["providers"]["p"][field] = new;
            value["providers"]["p"]["models"] = json!([{"id":"m"}]);
            inherit_model_capabilities(&mut value, &base);
            assert!(value["providers"]["p"]["models"][0]
                .get("reasoning")
                .is_none());
        }
        for model in [
            json!({"id":"new"}),
            json!({"id":"m","upstreamModel":"other"}),
        ] {
            let mut value = base.clone();
            value["providers"]["p"]["models"] = json!([model]);
            inherit_model_capabilities(&mut value, &base);
            assert!(value["providers"]["p"]["models"][0]
                .get("reasoning")
                .is_none());
        }
        let mut value = base.clone();
        value["providers"]["p"]["models"] = json!([]);
        inherit_model_capabilities(&mut value, &base);
        assert_eq!(value["providers"]["p"]["models"], json!([]));
    }
}

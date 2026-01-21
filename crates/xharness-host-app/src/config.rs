use std::{env, fs, path::Path, sync::Arc};

use serde::Deserialize;
use tokio_util::sync::CancellationToken;
use xharness_core::ModelProvider;
use xharness_debug::DebugRecorder;
use xharness_host::{
    ModelDescriptor, ModelReasoning, ModelReasoningEffort, ModelRegistry, ModelRoute,
    RegisteredModel,
};
use xharness_provider_openai::{
    OpenAiCapabilityProbe, OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig,
    OpenAiReasoningProfile,
};
use xharness_token::{TokenBudget, TokenGuard};

const DEFAULT_MAX_OUTPUT_TOKENS: u64 = 4_096;
const DEFAULT_TOKEN_SAFETY_MARGIN: u64 = 1_024;

pub(crate) struct ModelDeployment {
    pub(crate) default_route: ModelRoute,
    pub(crate) default_provider_display_name: String,
    pub(crate) registry: ModelRegistry,
    pub(crate) default_token_guard: Option<TokenGuard>,
}

pub(crate) struct SingleModelDeployment {
    pub(crate) provider: String,
    pub(crate) model: String,
    pub(crate) base_url: String,
    pub(crate) api_key: String,
    pub(crate) protocol: OpenAiProtocol,
    pub(crate) context_window_tokens: Option<u64>,
    pub(crate) max_output_tokens: u64,
    pub(crate) minimum_output_tokens: Option<u64>,
    pub(crate) token_safety_margin: u64,
}

impl ModelDeployment {
    pub(crate) async fn single_with_debug(
        config: SingleModelDeployment,
        debug: DebugRecorder,
    ) -> Result<Self, String> {
        let default_route = ModelRoute::new(&config.provider, &config.model);
        if config.model == "unconfigured" {
            return Ok(Self {
                default_route,
                default_provider_display_name: config.provider,
                registry: ModelRegistry::new(),
                default_token_guard: None,
            });
        }
        let provider_config = OpenAiProviderConfig::new(
            config.protocol,
            config.base_url,
            config.api_key,
            &config.model,
        )
        .with_context_window_fallback(config.context_window_tokens);
        let adapter = OpenAiProvider::new(provider_config)
            .map_err(|error| error.to_string())?
            .with_debug(debug);
        let capabilities = adapter
            .capabilities(CancellationToken::new())
            .await
            .map_err(|error| error.to_string())?;
        let token_guard = token_guard(
            &config.model,
            capabilities.context_window.effective_hard_max(),
            config.max_output_tokens,
            config.minimum_output_tokens,
            config.token_safety_margin,
        )?;
        let provider: Arc<dyn ModelProvider> = Arc::new(adapter);
        let mut registry = ModelRegistry::new();
        registry
            .register(
                RegisteredModel::new(
                    ModelDescriptor::new(
                        &config.provider,
                        &config.provider,
                        &config.model,
                        &config.model,
                    )
                    .with_context_window(capabilities.context_window),
                    provider,
                )
                .with_token_guard(token_guard.clone()),
            )
            .map_err(|error| error.to_string())?;
        Ok(Self {
            default_route,
            default_provider_display_name: config.provider,
            registry,
            default_token_guard: token_guard,
        })
    }

    pub(crate) async fn from_file_with_debug(
        path: &Path,
        debug: DebugRecorder,
    ) -> Result<Self, String> {
        let bytes = fs::read(path).map_err(|error| {
            format!("could not read provider config {}: {error}", path.display())
        })?;
        let config: ProviderFile = serde_json::from_slice(&bytes).map_err(|error| {
            format!(
                "could not parse provider config {} as JSON: {error}",
                path.display()
            )
        })?;
        config.build_with_debug(debug).await
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderFile {
    default: RouteConfig,
    providers: Vec<ProviderConfig>,
}

impl ProviderFile {
    #[cfg(test)]
    async fn build(self) -> Result<ModelDeployment, String> {
        self.build_with_debug(DebugRecorder::disabled()).await
    }

    async fn build_with_debug(self, debug: DebugRecorder) -> Result<ModelDeployment, String> {
        if self.providers.is_empty() {
            return Err("provider config must declare at least one provider".to_owned());
        }
        let mut default_route = ModelRoute::new(&self.default.provider, &self.default.model);
        default_route.reasoning_effort = self.default.reasoning_effort.clone();
        default_route.context_window_tokens = self.default.context_window_tokens;
        let mut registry = ModelRegistry::new();
        for provider in self.providers {
            provider
                .register_models(&mut registry, debug.clone())
                .await?;
        }
        let default_model = registry
            .models()
            .into_iter()
            .find(|model| {
                model.provider == default_route.provider && model.model == default_route.model
            })
            .ok_or_else(|| {
                format!(
                    "default model route {}/{} is not registered",
                    default_route.provider, default_route.model
                )
            })?;
        if default_route.reasoning_effort.is_none() {
            default_route.reasoning_effort = default_model
                .reasoning
                .as_ref()
                .and_then(|reasoning| reasoning.default_effort.clone());
        }
        if !registry.can_route(&default_route) {
            return Err(format!(
                "default model route {}/{} does not support reasoning effort {:?}",
                default_route.provider,
                default_route.model,
                default_route
                    .reasoning_effort
                    .as_deref()
                    .unwrap_or("provider-default")
            ));
        }
        let default_token_guard = registry.token_guard(&default_route);
        // Copy the default guard into the legacy HostConfig compatibility field;
        // runtime admission always resolves the same guard from the registry.
        Ok(ModelDeployment {
            default_route,
            default_provider_display_name: default_model.provider_display_name,
            registry,
            default_token_guard,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RouteConfig {
    provider: String,
    model: String,
    #[serde(default)]
    reasoning_effort: Option<String>,
    #[serde(default)]
    context_window_tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderConfig {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default = "openai_compatible_kind")]
    kind: String,
    base_url: String,
    #[serde(default = "chat_protocol")]
    protocol: String,
    #[serde(default)]
    api_key_env: Option<String>,
    models: Vec<ModelConfig>,
}

impl ProviderConfig {
    async fn register_models(
        self,
        registry: &mut ModelRegistry,
        debug: DebugRecorder,
    ) -> Result<(), String> {
        if self.kind != "openai-compatible" {
            return Err(format!(
                "provider {:?} uses unsupported kind {:?}; only openai-compatible is available",
                self.id, self.kind
            ));
        }
        if self.models.is_empty() {
            return Err(format!(
                "provider {:?} must declare at least one model",
                self.id
            ));
        }
        let protocol = parse_protocol(&self.protocol)?;
        let api_key = match self.api_key_env {
            Some(reference) => env::var(&reference).map_err(|_| {
                format!(
                    "provider {:?} requires missing or non-Unicode environment variable {reference:?}",
                    self.id
                )
            })?,
            None => String::new(),
        };
        let provider_display_name = self.display_name.unwrap_or_else(|| self.id.clone());
        for model in self.models {
            let ModelConfig {
                id,
                display_name,
                upstream_model,
                fallback_context_window_tokens,
                context_window_capability,
                max_output_tokens,
                minimum_output_tokens,
                token_safety_margin,
                reasoning,
            } = model;
            let upstream_model = upstream_model.unwrap_or_else(|| id.clone());
            let mut provider_config =
                OpenAiProviderConfig::new(protocol, &self.base_url, &api_key, upstream_model)
                    .with_context_window_fallback(fallback_context_window_tokens);
            if let Some(capability) = context_window_capability {
                let mut probe = OpenAiCapabilityProbe::new(
                    capability.url,
                    capability.context_window_json_pointer,
                )
                .with_ttl(std::time::Duration::from_secs(capability.ttl_seconds));
                if let Some(pointer) = capability.model_ceiling_json_pointer {
                    probe = probe.with_model_ceiling_json_pointer(pointer);
                }
                if let Some(pointer) = capability.provider_limit_json_pointer {
                    probe = probe.with_provider_limit_json_pointer(pointer);
                }
                if let Some(pointer) = capability.account_limit_json_pointer {
                    probe = probe.with_account_limit_json_pointer(pointer);
                }
                provider_config = provider_config.with_capability_probe(probe);
            }
            if let Some(reasoning) = &reasoning {
                let profile = OpenAiReasoningProfile::new(
                    reasoning.default_effort.clone(),
                    reasoning
                        .efforts
                        .iter()
                        .map(|effort| (effort.id.clone(), effort.request_patch.clone())),
                )
                .map_err(|error| error.to_string())?;
                provider_config = provider_config.with_reasoning_profile(profile);
            }
            let adapter = OpenAiProvider::new(provider_config)
                .map_err(|error| error.to_string())?
                .with_debug(debug.clone());
            let capabilities = adapter
                .capabilities(CancellationToken::new())
                .await
                .map_err(|error| {
                    format!(
                        "provider {:?} model {:?} capability discovery failed: {error}",
                        self.id, id
                    )
                })?;
            let token_guard = token_guard(
                &id,
                capabilities.context_window.effective_hard_max(),
                max_output_tokens,
                minimum_output_tokens,
                token_safety_margin,
            )?;
            let adapter: Arc<dyn ModelProvider> = Arc::new(adapter);
            let mut descriptor = ModelDescriptor::new(
                &self.id,
                &provider_display_name,
                &id,
                display_name.unwrap_or_else(|| id.clone()),
            )
            .with_context_window(capabilities.context_window);
            if let Some(reasoning) = reasoning {
                let efforts = reasoning
                    .efforts
                    .into_iter()
                    .map(|effort| {
                        let mut public = ModelReasoningEffort::new(effort.id, effort.name);
                        if let Some(description) = effort.description {
                            public = public.with_description(description);
                        }
                        public
                    })
                    .collect();
                let mut public = ModelReasoning::new(efforts);
                if let Some(default) = reasoning.default_effort {
                    public = public.with_default(default);
                }
                descriptor = descriptor.with_reasoning(public);
            }
            registry
                .register(RegisteredModel::new(descriptor, adapter).with_token_guard(token_guard))
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelConfig {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    upstream_model: Option<String>,
    /// Compatibility alias for the former authoritative field. This is only
    /// used when the Provider cannot advertise a live deployment limit.
    #[serde(default, alias = "context_window_tokens")]
    fallback_context_window_tokens: Option<u64>,
    #[serde(default)]
    context_window_capability: Option<ContextWindowCapabilityConfig>,
    #[serde(default = "default_max_output_tokens")]
    max_output_tokens: u64,
    /// Minimum output room admitted before compaction/rejection. Omission
    /// preserves the legacy fixed-output behavior for existing deployments.
    #[serde(default)]
    minimum_output_tokens: Option<u64>,
    #[serde(default = "default_token_safety_margin")]
    token_safety_margin: u64,
    #[serde(default)]
    reasoning: Option<ModelReasoningConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextWindowCapabilityConfig {
    url: String,
    /// Required live limit of this exact deployed model endpoint.
    context_window_json_pointer: String,
    /// Optional architecture/catalog ceiling. This can only lower an
    /// operational limit and never proves that the endpoint accepts requests.
    #[serde(default)]
    model_ceiling_json_pointer: Option<String>,
    /// Optional Provider-wide constraint for this route.
    #[serde(default)]
    provider_limit_json_pointer: Option<String>,
    /// Optional account/tier constraint for the configured credential.
    #[serde(default)]
    account_limit_json_pointer: Option<String>,
    #[serde(default = "default_capability_ttl_seconds")]
    ttl_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelReasoningConfig {
    #[serde(default)]
    default_effort: Option<String>,
    efforts: Vec<ModelReasoningEffortConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelReasoningEffortConfig {
    id: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default = "empty_request_patch")]
    request_patch: serde_json::Value,
}

fn empty_request_patch() -> serde_json::Value {
    serde_json::json!({})
}

fn openai_compatible_kind() -> String {
    "openai-compatible".to_owned()
}

fn chat_protocol() -> String {
    "chat".to_owned()
}

fn default_max_output_tokens() -> u64 {
    DEFAULT_MAX_OUTPUT_TOKENS
}

fn default_token_safety_margin() -> u64 {
    DEFAULT_TOKEN_SAFETY_MARGIN
}

fn default_capability_ttl_seconds() -> u64 {
    300
}

pub(crate) fn parse_protocol(value: &str) -> Result<OpenAiProtocol, String> {
    match value {
        "chat" | "chat-completions" => Ok(OpenAiProtocol::ChatCompletions),
        "responses" => Ok(OpenAiProtocol::Responses),
        _ => Err(format!(
            "unsupported protocol {value:?}; use chat or responses"
        )),
    }
}

pub(crate) fn token_guard(
    model: &str,
    context_window_tokens: Option<u64>,
    max_output_tokens: u64,
    minimum_output_tokens: Option<u64>,
    token_safety_margin: u64,
) -> Result<Option<TokenGuard>, String> {
    if model == "unconfigured" {
        return Ok(None);
    }
    let context_window_tokens = context_window_tokens.ok_or_else(|| {
        "configured models require a Provider/deployment context capability or an explicitly labelled fallback_context_window_tokens value".to_owned()
    })?;
    TokenGuard::conservative(TokenBudget {
        context_window_tokens,
        reserved_output_tokens: max_output_tokens,
        minimum_output_tokens: minimum_output_tokens.unwrap_or(max_output_tokens),
        safety_margin_tokens: token_safety_margin,
    })
    .map(Some)
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_in_deepseek_example_uses_environment_credentials_and_current_models() {
        let config: ProviderFile = serde_json::from_str(include_str!(
            "../../../config/providers.deepseek.example.json"
        ))
        .unwrap();
        assert_eq!(config.default.provider, "deepseek");
        assert_eq!(config.default.model, "deepseek-v4-flash");
        assert_eq!(config.default.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(config.providers.len(), 1);
        let provider = &config.providers[0];
        assert_eq!(provider.base_url, "https://api.deepseek.com");
        assert_eq!(provider.protocol, "chat");
        assert_eq!(provider.api_key_env.as_deref(), Some("DEEPSEEK_API_KEY"));
        assert_eq!(
            provider
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["deepseek-v4-flash", "deepseek-v4-pro"]
        );
        assert!(provider.models.iter().all(|model| {
            model.fallback_context_window_tokens == Some(1_048_576)
                && model
                    .reasoning
                    .as_ref()
                    .is_some_and(|reasoning| reasoning.default_effort.as_deref() == Some("high"))
        }));
    }
    use xharness_core::CapabilitySource;

    #[test]
    fn configured_model_requires_a_reported_capability_or_labelled_fallback() {
        let error = token_guard("model", None, 4_096, None, 1_024).unwrap_err();
        assert!(error.contains("Provider/deployment context capability"));
    }

    #[test]
    fn configured_model_builds_a_hard_budget_and_unconfigured_skips_it() {
        let guard = token_guard("model", Some(53_248), 4_096, None, 1_024)
            .unwrap()
            .unwrap();
        assert_eq!(guard.budget().available_input_tokens(), 48_128);
        assert!(token_guard("unconfigured", None, 4_096, None, 1_024)
            .unwrap()
            .is_none());
    }

    #[test]
    fn capability_config_accepts_independent_limit_pointers() {
        let config: ContextWindowCapabilityConfig = serde_json::from_value(serde_json::json!({
            "url": "https://provider.example/capabilities",
            "context_window_json_pointer": "/deployment/context",
            "model_ceiling_json_pointer": "/model/context",
            "provider_limit_json_pointer": "/provider/context",
            "account_limit_json_pointer": "/account/context",
            "ttl_seconds": 60
        }))
        .unwrap();
        assert_eq!(
            config.model_ceiling_json_pointer.as_deref(),
            Some("/model/context")
        );
        assert_eq!(
            config.provider_limit_json_pointer.as_deref(),
            Some("/provider/context")
        );
        assert_eq!(
            config.account_limit_json_pointer.as_deref(),
            Some("/account/context")
        );
        assert_eq!(config.ttl_seconds, 60);
    }

    #[tokio::test]
    async fn provider_file_builds_two_routable_openai_compatible_endpoints() {
        let config: ProviderFile = serde_json::from_str(
            r#"{
                "default": {"provider": "gpu-4080", "model": "qwen"},
                "providers": [
                    {
                        "id": "gpu-4080",
                        "display_name": "RTX 4080",
                        "base_url": "http://127.0.0.1:19626/v1",
                        "models": [{
                            "id": "qwen",
                            "upstream_model": "/models/qwen-4080.gguf",
                            "context_window_tokens": 53248
                        }]
                    },
                    {
                        "id": "gpu-v100",
                        "display_name": "V100 Server",
                        "base_url": "http://127.0.0.1:8000/v1",
                        "protocol": "chat",
                        "models": [{
                            "id": "qwen-v100",
                            "context_window_tokens": 32768,
                            "max_output_tokens": 4096,
                            "minimum_output_tokens": 2048,
                            "token_safety_margin": 1024
                        }]
                    }
                ]
            }"#,
        )
        .unwrap();
        let deployment = config.build().await.unwrap();
        assert_eq!(
            deployment.default_route,
            ModelRoute::new("gpu-4080", "qwen")
        );
        assert!(deployment
            .registry
            .can_route(&ModelRoute::new("gpu-v100", "qwen-v100")));
        let guard = deployment
            .registry
            .token_guard(&ModelRoute::new("gpu-v100", "qwen-v100"))
            .unwrap();
        assert_eq!(guard.budget().reserved_output_tokens, 4_096);
        assert_eq!(guard.budget().minimum_output_tokens, 2_048);
        assert_eq!(deployment.registry.models().len(), 2);
        assert!(deployment.registry.models().iter().all(|model| {
            model
                .context_window
                .fallback_limit
                .as_ref()
                .is_some_and(|evidence| {
                    evidence.source == CapabilitySource::DeploymentDeclaredFallback
                })
        }));
    }

    #[tokio::test]
    async fn provider_file_binds_a_smaller_default_session_budget_below_the_hard_maximum() {
        let config: ProviderFile = serde_json::from_str(
            r#"{
                "default": {
                    "provider": "gpu",
                    "model": "qwen",
                    "context_window_tokens": 24576
                },
                "providers": [{
                    "id": "gpu",
                    "base_url": "http://127.0.0.1:8000/v1",
                    "models": [{
                        "id": "qwen",
                        "fallback_context_window_tokens": 53248
                    }]
                }]
            }"#,
        )
        .unwrap();
        let deployment = config.build().await.unwrap();
        assert_eq!(deployment.default_route.context_window_tokens, Some(24_576));
        assert_eq!(
            deployment
                .registry
                .models()
                .first()
                .unwrap()
                .context_window
                .effective_hard_max(),
            Some(53_248)
        );
        assert_eq!(
            deployment
                .registry
                .token_guard(&deployment.default_route)
                .unwrap()
                .budget()
                .context_window_tokens,
            24_576
        );
    }

    #[tokio::test]
    async fn provider_file_rejects_an_unregistered_default_route() {
        let config: ProviderFile = serde_json::from_str(
            r#"{
                "default": {"provider": "missing", "model": "missing"},
                "providers": [{
                    "id": "gpu",
                    "base_url": "http://127.0.0.1:8000/v1",
                    "models": [{"id": "qwen", "context_window_tokens": 32768}]
                }]
            }"#,
        )
        .unwrap();
        let error = config.build().await.err().unwrap();
        assert!(error.contains("default model route missing/missing is not registered"));
    }

    #[tokio::test]
    async fn provider_file_declares_exact_model_reasoning_and_materializes_its_default() {
        let config: ProviderFile = serde_json::from_str(
            r#"{
                "default": {"provider": "gpu", "model": "qwen"},
                "providers": [{
                    "id": "gpu",
                    "base_url": "http://127.0.0.1:8000/v1",
                    "models": [{
                        "id": "qwen",
                        "context_window_tokens": 53248,
                        "reasoning": {
                            "default_effort": "high",
                            "efforts": [
                                {
                                    "id": "off",
                                    "name": "关闭",
                                    "request_patch": {
                                        "chat_template_kwargs": {"enable_thinking": false}
                                    }
                                },
                                {
                                    "id": "high",
                                    "name": "高",
                                    "description": "复杂任务",
                                    "request_patch": {"reasoning_effort": "ultra"}
                                }
                            ]
                        }
                    }]
                }]
            }"#,
        )
        .unwrap();
        let deployment = config.build().await.unwrap();
        assert_eq!(
            deployment.default_route.reasoning_effort.as_deref(),
            Some("high")
        );
        assert_eq!(
            deployment
                .registry
                .compaction_reasoning_effort(&deployment.default_route)
                .as_deref(),
            Some("off"),
            "compaction resolves the first declared effort independently of the interactive default"
        );
        let descriptor = &deployment.registry.models()[0];
        let reasoning = descriptor.reasoning.as_ref().unwrap();
        assert_eq!(reasoning.efforts.len(), 2);
        assert_eq!(
            reasoning.efforts[1].description.as_deref(),
            Some("复杂任务")
        );
        let mut invalid = ModelRoute::new("gpu", "qwen");
        invalid.reasoning_effort = Some("max".to_owned());
        assert!(!deployment.registry.can_route(&invalid));
    }

    #[tokio::test]
    async fn provider_file_rejects_reasoning_patches_that_override_core_fields() {
        let config: ProviderFile = serde_json::from_str(
            r#"{
                "default": {"provider": "gpu", "model": "qwen"},
                "providers": [{
                    "id": "gpu",
                    "base_url": "http://127.0.0.1:8000/v1",
                    "models": [{
                        "id": "qwen",
                        "context_window_tokens": 32768,
                        "reasoning": {
                            "efforts": [{
                                "id": "bad",
                                "name": "Bad",
                                "request_patch": {"messages": []}
                            }]
                        }
                    }]
                }]
            }"#,
        )
        .unwrap();
        let error = config.build().await.err().unwrap();
        assert!(error.contains("reserved field \"messages\""));
    }
}

use std::{env, fs, path::Path, sync::Arc};

use serde::Deserialize;
use xharness_core::ModelProvider;
use xharness_debug::DebugRecorder;
use xharness_host::{ModelDescriptor, ModelRegistry, ModelRoute, RegisteredModel};
use xharness_provider_openai::{OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig};
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
    pub(crate) fn single_with_debug(
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
        let token_guard = token_guard(
            &config.model,
            config.context_window_tokens,
            config.max_output_tokens,
            config.minimum_output_tokens,
            config.token_safety_margin,
        )?;
        let provider: Arc<dyn ModelProvider> = Arc::new(
            OpenAiProvider::new(OpenAiProviderConfig::new(
                config.protocol,
                config.base_url,
                config.api_key,
                &config.model,
            ))
            .map_err(|error| error.to_string())?
            .with_debug(debug),
        );
        let mut registry = ModelRegistry::new();
        registry
            .register(
                RegisteredModel::new(
                    ModelDescriptor::new(
                        &config.provider,
                        &config.provider,
                        &config.model,
                        &config.model,
                    ),
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

    pub(crate) fn from_file_with_debug(path: &Path, debug: DebugRecorder) -> Result<Self, String> {
        let bytes = fs::read(path).map_err(|error| {
            format!("could not read provider config {}: {error}", path.display())
        })?;
        let config: ProviderFile = serde_json::from_slice(&bytes).map_err(|error| {
            format!(
                "could not parse provider config {} as JSON: {error}",
                path.display()
            )
        })?;
        config.build_with_debug(debug)
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
    fn build(self) -> Result<ModelDeployment, String> {
        self.build_with_debug(DebugRecorder::disabled())
    }

    fn build_with_debug(self, debug: DebugRecorder) -> Result<ModelDeployment, String> {
        if self.providers.is_empty() {
            return Err("provider config must declare at least one provider".to_owned());
        }
        let default_route = ModelRoute::new(&self.default.provider, &self.default.model);
        let mut registry = ModelRegistry::new();
        for provider in self.providers {
            provider.register_models(&mut registry, debug.clone())?;
        }
        if !registry.can_route(&default_route) {
            return Err(format!(
                "default model route {}/{} is not registered",
                default_route.provider, default_route.model
            ));
        }
        let default_model = registry
            .models()
            .into_iter()
            .find(|model| {
                model.provider == default_route.provider && model.model == default_route.model
            })
            .expect("default route was checked");
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
    fn register_models(
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
            let upstream_model = model
                .upstream_model
                .clone()
                .unwrap_or_else(|| model.id.clone());
            let token_guard = token_guard(
                &model.id,
                Some(model.context_window_tokens),
                model.max_output_tokens,
                model.minimum_output_tokens,
                model.token_safety_margin,
            )?;
            let adapter: Arc<dyn ModelProvider> = Arc::new(
                OpenAiProvider::new(OpenAiProviderConfig::new(
                    protocol,
                    &self.base_url,
                    &api_key,
                    upstream_model,
                ))
                .map_err(|error| error.to_string())?
                .with_debug(debug.clone()),
            );
            registry
                .register(
                    RegisteredModel::new(
                        ModelDescriptor::new(
                            &self.id,
                            &provider_display_name,
                            &model.id,
                            model.display_name.unwrap_or_else(|| model.id.clone()),
                        ),
                        adapter,
                    )
                    .with_token_guard(token_guard),
                )
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
    context_window_tokens: u64,
    #[serde(default = "default_max_output_tokens")]
    max_output_tokens: u64,
    /// Minimum output room admitted before compaction/rejection. Omission
    /// preserves the legacy fixed-output behavior for existing deployments.
    #[serde(default)]
    minimum_output_tokens: Option<u64>,
    #[serde(default = "default_token_safety_margin")]
    token_safety_margin: u64,
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
        "configured models require XHARNESS_CONTEXT_WINDOW or --context-window".to_owned()
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
    fn configured_model_requires_an_explicit_context_window() {
        let error = token_guard("model", None, 4_096, None, 1_024).unwrap_err();
        assert!(error.contains("XHARNESS_CONTEXT_WINDOW"));
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
    fn provider_file_builds_two_routable_openai_compatible_endpoints() {
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
        let deployment = config.build().unwrap();
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
    }

    #[test]
    fn provider_file_rejects_an_unregistered_default_route() {
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
        let error = config.build().err().unwrap();
        assert!(error.contains("default model route missing/missing is not registered"));
    }
}

use serde::{Deserialize, Serialize};

use crate::CompactionError;

pub const DEFAULT_THRESHOLD_RATIO: f64 = 0.8;
pub const DEFAULT_RETAIN_RATIO: f64 = 0.16;
pub const DEFAULT_MAX_SUMMARY_TOKENS: u64 = 8_192;
pub const DEFAULT_COMPACTION_RETRIES: u32 = 1;
pub const DEFAULT_MAX_OVERFLOW_RETRIES: u32 = 1;

/// Exact provider/model route. Overrides never use fuzzy model matching.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTarget {
    pub provider: String,
    pub model: String,
}

impl ModelTarget {
    pub fn new(provider: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            provider: provider.into(),
            model: model.into(),
        }
    }

    fn validate(&self, name: &str) -> Result<(), CompactionError> {
        if self.provider.trim().is_empty() {
            return Err(CompactionError::invalid_config(format!(
                "{name}.provider must not be empty"
            )));
        }
        if self.model.trim().is_empty() {
            return Err(CompactionError::invalid_config(format!(
                "{name}.model must not be empty"
            )));
        }
        Ok(())
    }
}

/// Exactly one recent-tail retention form.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum RetentionPolicy {
    Ratio(f64),
    Tokens(u64),
}

impl RetentionPolicy {
    fn validate(self, threshold_ratio: f64, name: &str) -> Result<(), CompactionError> {
        match self {
            Self::Ratio(ratio) => {
                validate_ratio(ratio, &format!("{name}.retainRatio"))?;
                if ratio >= threshold_ratio {
                    return Err(CompactionError::invalid_config(format!(
                        "{name}.retainRatio ({ratio}) must be smaller than thresholdRatio ({threshold_ratio})"
                    )));
                }
            }
            Self::Tokens(_) => {}
        }
        Ok(())
    }

    fn resolve(self, context_window_tokens: u64) -> u64 {
        match self {
            Self::Ratio(ratio) => scale_floor(context_window_tokens, ratio),
            Self::Tokens(tokens) => tokens,
        }
    }
}

/// Partial policy applied only to one exact provider/model route.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionPolicyOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold_ratio: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retain_ratio: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retain_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summarization_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summarization_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction_retries: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_overflow_retries: Option<u32>,
}

/// Exact-target override entry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCompactionPolicy {
    pub provider: String,
    pub model: String,
    #[serde(flatten)]
    pub policy: CompactionPolicyOverride,
}

impl ModelCompactionPolicy {
    pub fn new(
        provider: impl Into<String>,
        model: impl Into<String>,
        policy: CompactionPolicyOverride,
    ) -> Self {
        Self {
            provider: provider.into(),
            model: model.into(),
            policy,
        }
    }

    fn target(&self) -> ModelTarget {
        ModelTarget::new(&self.provider, &self.model)
    }
}

/// Global defaults plus exact provider/model overrides.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CompactionConfig {
    pub threshold_ratio: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retain_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retain_tokens: Option<u64>,
    pub summarization_provider: String,
    pub summarization_model: String,
    pub max_tokens: u64,
    pub compaction_retries: u32,
    pub max_overflow_retries: u32,
    pub model_policies: Vec<ModelCompactionPolicy>,
    pub auto: bool,
}

impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            threshold_ratio: DEFAULT_THRESHOLD_RATIO,
            retain_ratio: Some(DEFAULT_RETAIN_RATIO),
            retain_tokens: None,
            summarization_provider: String::new(),
            summarization_model: String::new(),
            max_tokens: DEFAULT_MAX_SUMMARY_TOKENS,
            compaction_retries: DEFAULT_COMPACTION_RETRIES,
            max_overflow_retries: DEFAULT_MAX_OVERFLOW_RETRIES,
            model_policies: Vec::new(),
            auto: true,
        }
    }
}

/// Capacity-scaled, route-specific compaction contract.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionSpec {
    pub target: ModelTarget,
    pub context_window_tokens: u64,
    pub threshold_ratio: f64,
    pub threshold_tokens: u64,
    pub retain_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summarization_target: Option<ModelTarget>,
    pub max_tokens: u64,
    pub compaction_retries: u32,
    pub max_overflow_retries: u32,
}

impl CompactionConfig {
    pub fn validate(&self) -> Result<(), CompactionError> {
        validate_ratio(self.threshold_ratio, "CompactionConfig.thresholdRatio")?;
        let retention =
            resolve_retention(self.retain_ratio, self.retain_tokens, "CompactionConfig")?;
        retention.validate(self.threshold_ratio, "CompactionConfig")?;
        validate_summary_pair(
            Some(&self.summarization_provider),
            Some(&self.summarization_model),
            "CompactionConfig",
        )?;
        if self.max_tokens == 0 {
            return Err(CompactionError::invalid_config(
                "CompactionConfig.maxTokens must be greater than zero",
            ));
        }

        let mut targets = std::collections::HashSet::new();
        for (index, override_entry) in self.model_policies.iter().enumerate() {
            let name = format!("CompactionConfig.modelPolicies[{index}]");
            let target = override_entry.target();
            target.validate(&name)?;
            if !targets.insert(target.clone()) {
                return Err(CompactionError::invalid_config(format!(
                    "duplicate model policy for {}/{}",
                    target.provider, target.model
                )));
            }
            validate_override(&override_entry.policy, self, &name)?;
        }
        Ok(())
    }

    /// Resolve exact-target overrides and scale ratios against the adapter-owned
    /// context-window capacity.
    pub fn resolve(
        &self,
        target: ModelTarget,
        context_window_tokens: u64,
    ) -> Result<CompactionSpec, CompactionError> {
        self.validate()?;
        target.validate("target")?;
        if context_window_tokens == 0 {
            return Err(CompactionError::invalid_config(
                "contextWindowTokens must be greater than zero",
            ));
        }

        let override_policy = self
            .model_policies
            .iter()
            .find(|entry| entry.provider == target.provider && entry.model == target.model)
            .map(|entry| &entry.policy);
        let threshold_ratio = override_policy
            .and_then(|policy| policy.threshold_ratio)
            .unwrap_or(self.threshold_ratio);
        let retention = match override_policy {
            Some(policy) if policy.retain_tokens.is_some() || policy.retain_ratio.is_some() => {
                resolve_retention(policy.retain_ratio, policy.retain_tokens, "model policy")?
            }
            _ => resolve_retention(self.retain_ratio, self.retain_tokens, "CompactionConfig")?,
        };
        retention.validate(threshold_ratio, "resolved policy")?;

        let threshold_tokens = scale_floor(context_window_tokens, threshold_ratio);
        let retain_tokens = retention.resolve(context_window_tokens);
        if retain_tokens >= threshold_tokens {
            return Err(CompactionError::invalid_config(format!(
                "retainTokens ({retain_tokens}) must be smaller than thresholdTokens ({threshold_tokens}) for {}/{}",
                target.provider, target.model
            )));
        }

        let (summary_provider, summary_model) = match override_policy {
            Some(policy)
                if policy.summarization_provider.is_some()
                    || policy.summarization_model.is_some() =>
            {
                (
                    policy.summarization_provider.as_deref().unwrap_or_default(),
                    policy.summarization_model.as_deref().unwrap_or_default(),
                )
            }
            _ => (
                self.summarization_provider.as_str(),
                self.summarization_model.as_str(),
            ),
        };
        let summarization_target = if summary_provider.is_empty() {
            None
        } else {
            Some(ModelTarget::new(summary_provider, summary_model))
        };

        Ok(CompactionSpec {
            target,
            context_window_tokens,
            threshold_ratio,
            threshold_tokens,
            retain_tokens,
            summarization_target,
            max_tokens: override_policy
                .and_then(|policy| policy.max_tokens)
                .unwrap_or(self.max_tokens),
            compaction_retries: override_policy
                .and_then(|policy| policy.compaction_retries)
                .unwrap_or(self.compaction_retries),
            max_overflow_retries: override_policy
                .and_then(|policy| policy.max_overflow_retries)
                .unwrap_or(self.max_overflow_retries),
        })
    }
}

fn validate_override(
    policy: &CompactionPolicyOverride,
    defaults: &CompactionConfig,
    name: &str,
) -> Result<(), CompactionError> {
    if let Some(ratio) = policy.threshold_ratio {
        validate_ratio(ratio, &format!("{name}.thresholdRatio"))?;
    }
    let threshold_ratio = policy.threshold_ratio.unwrap_or(defaults.threshold_ratio);
    let retention = if policy.retain_ratio.is_some() || policy.retain_tokens.is_some() {
        resolve_retention(policy.retain_ratio, policy.retain_tokens, name)?
    } else {
        resolve_retention(
            defaults.retain_ratio,
            defaults.retain_tokens,
            "CompactionConfig",
        )?
    };
    retention.validate(threshold_ratio, name)?;
    validate_summary_pair(
        policy.summarization_provider.as_deref(),
        policy.summarization_model.as_deref(),
        name,
    )?;
    if policy.max_tokens == Some(0) {
        return Err(CompactionError::invalid_config(format!(
            "{name}.maxTokens must be greater than zero"
        )));
    }
    Ok(())
}

fn resolve_retention(
    retain_ratio: Option<f64>,
    retain_tokens: Option<u64>,
    name: &str,
) -> Result<RetentionPolicy, CompactionError> {
    match (retain_ratio, retain_tokens) {
        (Some(_), Some(_)) => Err(CompactionError::invalid_config(format!(
            "{name}.retainRatio and retainTokens are mutually exclusive"
        ))),
        (Some(ratio), None) => Ok(RetentionPolicy::Ratio(ratio)),
        (None, Some(tokens)) => Ok(RetentionPolicy::Tokens(tokens)),
        (None, None) => Err(CompactionError::invalid_config(format!(
            "{name} must define retainRatio or retainTokens"
        ))),
    }
}

fn validate_summary_pair(
    provider: Option<&str>,
    model: Option<&str>,
    name: &str,
) -> Result<(), CompactionError> {
    match (provider, model) {
        (None, None) => Ok(()),
        (Some(provider), Some(model)) if provider.is_empty() == model.is_empty() => Ok(()),
        _ => Err(CompactionError::invalid_config(format!(
            "{name}.summarizationProvider and summarizationModel must be set together as an empty or non-empty pair"
        ))),
    }
}

fn validate_ratio(value: f64, name: &str) -> Result<(), CompactionError> {
    if !value.is_finite() || value <= 0.0 || value > 1.0 {
        return Err(CompactionError::invalid_config(format!(
            "{name} ({value}) must be finite and in (0, 1]"
        )));
    }
    Ok(())
}

fn scale_floor(tokens: u64, ratio: f64) -> u64 {
    ((tokens as f64) * ratio).floor() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_deepseek_basic_compaction() {
        let config = CompactionConfig::default();
        assert_eq!(config.threshold_ratio, 0.8);
        assert_eq!(config.retain_ratio, Some(0.16));
        assert_eq!(config.retain_tokens, None);
        assert_eq!(config.max_tokens, 8_192);
        assert_eq!(config.compaction_retries, 1);
        assert_eq!(config.max_overflow_retries, 1);
        assert!(config.auto);

        let spec = config
            .resolve(ModelTarget::new("openai", "qwen3"), 53_248)
            .unwrap();
        assert_eq!(spec.threshold_tokens, 42_598);
        assert_eq!(spec.retain_tokens, 8_519);
        assert_eq!(spec.summarization_target, None);
    }

    #[test]
    fn exact_target_override_is_resolved_without_fuzzy_matching() {
        let mut config = CompactionConfig::default();
        config.model_policies.push(ModelCompactionPolicy::new(
            "local",
            "qwen-27b",
            CompactionPolicyOverride {
                threshold_ratio: Some(0.75),
                retain_ratio: None,
                retain_tokens: Some(4_096),
                summarization_provider: Some("summary".to_owned()),
                summarization_model: Some("small".to_owned()),
                max_tokens: Some(2_048),
                ..CompactionPolicyOverride::default()
            },
        ));
        let spec = config
            .resolve(ModelTarget::new("local", "qwen-27b"), 32_768)
            .unwrap();
        assert_eq!(spec.threshold_tokens, 24_576);
        assert_eq!(spec.retain_tokens, 4_096);
        assert_eq!(
            spec.summarization_target,
            Some(ModelTarget::new("summary", "small"))
        );
        assert_eq!(spec.max_tokens, 2_048);

        let inherited = config
            .resolve(ModelTarget::new("local", "qwen-27b-v2"), 32_768)
            .unwrap();
        assert_eq!(inherited.threshold_tokens, 26_214);
        assert_eq!(inherited.retain_tokens, 5_242);
    }

    #[test]
    fn validation_rejects_ambiguous_or_duplicate_policy() {
        let mut config = CompactionConfig {
            retain_tokens: Some(1),
            ..CompactionConfig::default()
        };
        assert!(config.validate().is_err());

        config.retain_ratio = None;
        config.model_policies = vec![
            ModelCompactionPolicy::new("p", "m", CompactionPolicyOverride::default()),
            ModelCompactionPolicy::new("p", "m", CompactionPolicyOverride::default()),
        ];
        assert!(config.validate().is_err());
    }
}

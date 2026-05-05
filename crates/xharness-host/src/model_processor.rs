//! Pure model-catalog projection and failure-classification policy.
//!
//! Runtime discovery, settings persistence, credentials and network I/O stay
//! in the Host adapter. This module only turns immutable facts into the public
//! model-selector view.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};

use crate::{ModelDescriptor, ModelSettingsDocument};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CredentialFact {
    Configured,
    Missing,
    Error(String),
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ModelFacts {
    pub(crate) configured: Option<ModelSettingsDocument>,
    pub(crate) catalog: Vec<ModelDescriptor>,
    pub(crate) activation_error: Option<String>,
    pub(crate) credentials: BTreeMap<String, CredentialFact>,
}

pub(crate) struct ModelProcessor;

impl ModelProcessor {
    pub(crate) fn providers(facts: &ModelFacts) -> Value {
        let providers: Vec<Value> = if let Some(document) = &facts.configured {
            let active = facts
                .catalog
                .iter()
                .map(|model| model.provider.as_str())
                .collect::<BTreeSet<_>>();
            document
                .providers
                .iter()
                .map(|(id, profile)| {
                    json!({
                        "provider": id,
                        "displayName": profile.display_name.as_deref().unwrap_or(id),
                        "settingsNs": crate::MODEL_SETTINGS_NAMESPACE,
                        "settingsPath": ["providers", id],
                        "active": active.contains(id.as_str()),
                        "declared": true,
                    })
                })
                .collect()
        } else {
            let mut seen = BTreeSet::new();
            facts
                .catalog
                .iter()
                .filter(|model| seen.insert(model.provider.as_str()))
                .map(|model| {
                    json!({
                        "provider": model.provider,
                        "displayName": model.provider_display_name,
                        "settingsNs": "xharness",
                        "settingsPath": [],
                        "active": true,
                        "declared": true,
                    })
                })
                .collect()
        };
        json!({"providers": providers})
    }

    pub(crate) fn groups(catalog: &[ModelDescriptor]) -> Vec<Value> {
        let mut groups: Vec<(String, String, Vec<Value>)> = Vec::new();
        for model in catalog {
            let mut projected = json!({
                "id": model.model,
                "name": model.model_display_name,
                "contextWindowCapability": model.context_window,
                "reasoningCapability": model.reasoning_capability,
            });
            if let Some(maximum) = model.context_window.effective_hard_max() {
                projected["contextWindow"] = json!(maximum);
                projected["contextWindowSource"] =
                    serde_json::to_value(model.context_window.effective_source())
                        .unwrap_or(Value::Null);
            }
            if let Some(reasoning) = &model.reasoning {
                let efforts = reasoning
                    .efforts
                    .iter()
                    .map(|effort| {
                        let mut value = json!({"id": effort.id, "name": effort.name});
                        if let Some(description) = &effort.description {
                            value["description"] = Value::String(description.clone());
                        }
                        value
                    })
                    .collect::<Vec<_>>();
                let mut value = json!({"efforts": efforts});
                if let Some(default_effort) = &reasoning.default_effort {
                    value["defaultEffort"] = Value::String(default_effort.clone());
                }
                projected["reasoning"] = value;
            }
            if let Some((_, _, models)) = groups
                .iter_mut()
                .find(|(provider, _, _)| provider == &model.provider)
            {
                models.push(projected);
            } else {
                groups.push((
                    model.provider.clone(),
                    model.provider_display_name.clone(),
                    vec![projected],
                ));
            }
        }
        groups
            .into_iter()
            .map(|(id, name, models)| json!({"id": id, "name": name, "models": models}))
            .collect()
    }

    pub(crate) fn failures(facts: &ModelFacts) -> Vec<Value> {
        let Some(document) = &facts.configured else {
            return Vec::new();
        };
        let live = facts
            .catalog
            .iter()
            .map(|model| model.provider.as_str())
            .collect::<BTreeSet<_>>();
        document
            .providers
            .iter()
            .filter(|(id, _)| !live.contains(id.as_str()))
            .map(|(id, profile)| {
                let message = if let Some(error) = &facts.activation_error {
                    error.clone()
                } else if let Some(reference) = &profile.api_key_env {
                    match facts.credentials.get(reference) {
                        Some(CredentialFact::Configured) => missing_route_message(),
                        Some(CredentialFact::Error(error)) => error.clone(),
                        Some(CredentialFact::Missing) | None => {
                            format!("credential {reference} is not stored for this state directory")
                        }
                    }
                } else {
                    missing_route_message()
                };
                json!({
                    "id": id,
                    "name": profile.display_name.as_deref().unwrap_or(id),
                    "message": message,
                })
            })
            .collect()
    }
}

fn missing_route_message() -> String {
    "the provider is configured but the Host built no route for it".to_owned()
}

#[cfg(test)]
mod tests {
    use xharness_core::ContextWindowCapability;

    use crate::{ModelReasoning, ModelReasoningEffort, ProviderProfile};

    use super::*;

    fn descriptor(provider: &str, model: &str) -> ModelDescriptor {
        ModelDescriptor::new(
            provider,
            provider.to_uppercase(),
            model,
            model.to_uppercase(),
        )
        .with_context_window(ContextWindowCapability::reported(131_072))
    }

    fn profile(reference: Option<&str>) -> ProviderProfile {
        ProviderProfile {
            display_name: Some("Declared".to_owned()),
            base_url: "https://example.test".to_owned(),
            api: "openai-responses".to_owned(),
            usage_input_semantics: None,
            api_key_env: reference.map(str::to_owned),
            default_context_window: None,
            max_tokens: None,
            models: vec![],
            reasoning_discovery: None,
        }
    }

    #[test]
    fn fallback_providers_are_deduplicated_in_catalog_order() {
        let facts = ModelFacts {
            catalog: vec![
                descriptor("b", "one"),
                descriptor("a", "two"),
                descriptor("b", "three"),
            ],
            ..ModelFacts::default()
        };
        let projected = ModelProcessor::providers(&facts);
        assert_eq!(projected["providers"].as_array().unwrap().len(), 2);
        assert_eq!(projected["providers"][0]["provider"], "b");
        assert_eq!(projected["providers"][1]["provider"], "a");
    }

    #[test]
    fn groups_preserve_capabilities_and_reasoning() {
        let model = descriptor("p", "m").with_reasoning(
            ModelReasoning::new(vec![
                ModelReasoningEffort::new("off", "Off"),
                ModelReasoningEffort::new("high", "High").with_description("deep"),
            ])
            .with_default("high"),
        );
        let groups = ModelProcessor::groups(&[model]);
        assert_eq!(groups[0]["models"][0]["contextWindow"], 131_072);
        assert_eq!(groups[0]["models"][0]["reasoning"]["defaultEffort"], "high");
        assert_eq!(
            groups[0]["models"][0]["reasoning"]["efforts"][1]["description"],
            "deep"
        );
    }

    #[test]
    fn failure_precedence_is_activation_then_credential_then_route() {
        let mut document = ModelSettingsDocument::default();
        document
            .providers
            .insert("p".to_owned(), profile(Some("P_KEY")));
        let mut facts = ModelFacts {
            configured: Some(document),
            activation_error: Some("activation failed".to_owned()),
            ..ModelFacts::default()
        };
        facts
            .credentials
            .insert("P_KEY".to_owned(), CredentialFact::Configured);
        assert_eq!(
            ModelProcessor::failures(&facts)[0]["message"],
            "activation failed"
        );

        facts.activation_error = None;
        facts
            .credentials
            .insert("P_KEY".to_owned(), CredentialFact::Missing);
        assert!(ModelProcessor::failures(&facts)[0]["message"]
            .as_str()
            .unwrap()
            .contains("not stored"));

        facts.credentials.insert(
            "P_KEY".to_owned(),
            CredentialFact::Error("keychain unavailable".to_owned()),
        );
        assert_eq!(
            ModelProcessor::failures(&facts)[0]["message"],
            "keychain unavailable"
        );

        facts
            .credentials
            .insert("P_KEY".to_owned(), CredentialFact::Configured);
        assert!(ModelProcessor::failures(&facts)[0]["message"]
            .as_str()
            .unwrap()
            .contains("built no route"));
    }

    #[test]
    fn live_provider_has_no_failure_and_no_secret_is_projected() {
        let mut document = ModelSettingsDocument::default();
        document
            .providers
            .insert("p".to_owned(), profile(Some("P_KEY")));
        let facts = ModelFacts {
            configured: Some(document),
            catalog: vec![descriptor("p", "m")],
            credentials: BTreeMap::from([(
                "P_KEY".to_owned(),
                CredentialFact::Error("secret-value-must-not-appear".to_owned()),
            )]),
            ..ModelFacts::default()
        };
        assert!(ModelProcessor::failures(&facts).is_empty());
        assert!(!ModelProcessor::providers(&facts)
            .to_string()
            .contains("secret-value"));
    }
}

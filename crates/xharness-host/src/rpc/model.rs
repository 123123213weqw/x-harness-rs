//! Model catalog RPC adapter.
//!
//! This module owns Host/runtime/backend I/O. Projection and failure policy
//! live in `model_processor` and therefore remain transport-independent.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};
use xharness_api::{RpcError, RpcMethod};

use crate::{
    model_processor::{CredentialFact, ModelFacts, ModelProcessor},
    BasicHost,
};

use super::{bad_request, nonempty, require_object, required_string};

pub(super) async fn call(
    host: &BasicHost,
    method: RpcMethod,
    payload: &Value,
) -> Result<Value, RpcError> {
    match method {
        RpcMethod::LlmProviders => providers(host, payload).await,
        RpcMethod::LlmModels => models(host, payload).await,
        RpcMethod::LlmDiscoverModels => discover(host, payload).await,
        _ => unreachable!("model adapter received non-model method {method}"),
    }
}

async fn providers(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    require_object(payload)?;
    Ok(ModelProcessor::providers(&facts(host, false).await))
}

async fn models(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    require_object(payload)?;
    let facts = facts(host, true).await;
    Ok(json!({
        "groups": ModelProcessor::groups(&facts.catalog),
        "failures": ModelProcessor::failures(&facts),
    }))
}

async fn discover(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    nonempty(required_string(payload, "settingsNs")?, "settingsNs")?;
    if let Some(backend) = host.model_settings.get() {
        if payload["settingsNs"] != crate::MODEL_SETTINGS_NAMESPACE {
            return Err(bad_request("Unsupported model settings namespace"));
        }
        let section = host.state.read().await.settings[crate::MODEL_SETTINGS_NAMESPACE]
            .value
            .clone();
        return backend
            .discover(&section, payload)
            .await
            .map_err(crate::model_settings::model_settings_error);
    }
    let models = host
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

pub(super) async fn catalog_view(host: &BasicHost) -> (Vec<Value>, Vec<Value>) {
    let facts = facts(host, true).await;
    (
        ModelProcessor::groups(&facts.catalog),
        ModelProcessor::failures(&facts),
    )
}

async fn facts(host: &BasicHost, include_credentials: bool) -> ModelFacts {
    let catalog = host.agent_runtime.model_catalog();
    let Some(backend) = host.model_settings.get() else {
        return ModelFacts {
            catalog,
            ..ModelFacts::default()
        };
    };
    let (configured, activation_error) = {
        let state = host.state.read().await;
        (
            crate::parse_model_settings(&state.settings[crate::MODEL_SETTINGS_NAMESPACE].value)
                .ok(),
            state.model_settings_error.clone(),
        )
    };
    let mut credentials = BTreeMap::new();
    if include_credentials && activation_error.is_none() {
        let live = catalog
            .iter()
            .map(|model| model.provider.as_str())
            .collect::<BTreeSet<_>>();
        let references = configured
            .as_ref()
            .into_iter()
            .flat_map(|document| document.providers.iter())
            .filter(|(id, _)| !live.contains(id.as_str()))
            .filter_map(|(_, profile)| profile.api_key_env.as_deref())
            .collect::<BTreeSet<_>>();
        for reference in references {
            let fact = match backend.credential_info(reference).await {
                Ok(info) if info["configured"] == json!(true) => CredentialFact::Configured,
                Ok(_) => CredentialFact::Missing,
                Err(error) => CredentialFact::Error(error),
            };
            credentials.insert(reference.to_owned(), fact);
        }
    }
    ModelFacts {
        configured,
        catalog,
        activation_error,
        credentials,
    }
}

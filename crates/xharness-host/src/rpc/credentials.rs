//! Credential RPC compatibility and side-effect adapter.
//!
//! Reference policy and the in-memory fallback are decided by the pure
//! `CredentialProcessor`. Keychain/backend I/O and model-registry activation
//! remain here and secret values never enter responses or durable logs.

use std::collections::BTreeSet;

use serde_json::{json, Map, Value};
use xharness_api::{RpcError, RpcMethod};

use crate::{
    credential_processor::{CredentialMemoryMutation, CredentialProcessor, CredentialStateView},
    BasicHost,
};

use super::{bad_request, nonempty, required_array, required_string};

pub(super) async fn call(
    host: &BasicHost,
    method: RpcMethod,
    payload: &Value,
) -> Result<Value, RpcError> {
    match method {
        RpcMethod::CredentialsDescribe => describe(host, payload).await,
        RpcMethod::CredentialsSet => set(host, payload).await,
        RpcMethod::CredentialsUnset => unset(host, payload).await,
        _ => unreachable!("credential adapter received non-credential method {method}"),
    }
}

async fn describe(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    let refs = required_array(payload, "refs")?;
    if refs.len() > 64 {
        return Err(bad_request("at most 64 credential references are accepted"));
    }
    if let Some(backend) = host.model_settings.get() {
        let _guard = host.control_gate.lock().await;
        let references = parse_references(refs, "Credential references must be strings")?;
        let mut credentials = Map::new();
        for reference in references {
            credentials.insert(
                reference.clone(),
                backend
                    .credential_info(&reference)
                    .await
                    .map_err(crate::model_settings::model_settings_error)?,
            );
        }
        return Ok(json!({"credentials": credentials}));
    }

    let state = host.state.read().await;
    let references = parse_references(refs, "credential references must be strings")?;
    let view = state_view(
        state.credentials.keys().cloned(),
        references.iter().map(String::as_str),
    );
    Ok(CredentialProcessor::new(view).describe(&references))
}

fn parse_references(refs: &[Value], type_error: &str) -> Result<Vec<String>, RpcError> {
    refs.iter()
        .map(|reference| {
            let reference = reference.as_str().ok_or_else(|| bad_request(type_error))?;
            CredentialProcessor::validate_reference(reference)?;
            Ok(reference.to_owned())
        })
        .collect()
}

async fn set(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    let reference = required_string(payload, "ref")?;
    CredentialProcessor::validate_reference(&reference)?;
    let value = nonempty(required_string(payload, "value")?, "value")?;
    if let Some(backend) = host.model_settings.get() {
        let _guard = host.control_gate.lock().await;
        let section = host.state.read().await.settings[crate::MODEL_SETTINGS_NAMESPACE]
            .value
            .clone();
        backend.activate(
            backend
                .set_credential(&reference, &value, &section)
                .await
                .map_err(crate::model_settings::model_settings_error)?,
        );
        publish_model_settings(host);
        return Ok(json!({}));
    }

    let mut state = host.state.write().await;
    let mutation = CredentialProcessor::new(state_view(
        state.credentials.keys().cloned(),
        std::iter::once(reference.as_str()),
    ))
    .set(reference, value)?;
    apply_memory_mutation(&mut state.credentials, mutation);
    Ok(json!({}))
}

async fn unset(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    let reference = required_string(payload, "ref")?;
    CredentialProcessor::validate_reference(&reference)?;
    if let Some(backend) = host.model_settings.get() {
        let _guard = host.control_gate.lock().await;
        let section = host.state.read().await.settings[crate::MODEL_SETTINGS_NAMESPACE]
            .value
            .clone();
        backend.activate(
            backend
                .unset_credential(&reference, &section)
                .await
                .map_err(crate::model_settings::model_settings_error)?,
        );
        publish_model_settings(host);
        return Ok(json!({}));
    }

    let mut state = host.state.write().await;
    let mutation = CredentialProcessor::new(state_view(
        state.credentials.keys().cloned(),
        std::iter::once(reference.as_str()),
    ))
    .unset(reference)?;
    apply_memory_mutation(&mut state.credentials, mutation);
    Ok(json!({}))
}

fn state_view<'a>(
    stored_references: impl Iterator<Item = String>,
    requested_references: impl Iterator<Item = &'a str>,
) -> CredentialStateView {
    CredentialStateView {
        stored_references: stored_references.collect(),
        environment_references: requested_references
            .filter(|reference| std::env::var_os(reference).is_some_and(|value| !value.is_empty()))
            .map(ToOwned::to_owned)
            .collect::<BTreeSet<_>>(),
    }
}

fn apply_memory_mutation(
    credentials: &mut std::collections::BTreeMap<String, String>,
    mutation: CredentialMemoryMutation,
) {
    match mutation {
        CredentialMemoryMutation::Set { reference, value } => {
            credentials.insert(reference, value);
        }
        CredentialMemoryMutation::Unset { reference } => {
            credentials.remove(&reference);
        }
    }
}

fn publish_model_settings(host: &BasicHost) {
    host.push_host(json!({
        "type": "host/remote-event",
        "event": "settings/document-updated",
        "args": [crate::MODEL_SETTINGS_NAMESPACE],
    }));
}

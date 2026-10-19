//! Durable, model-independent search preferences; credentials stay outside state.
#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use xharness_api::{RpcError, RpcErrorCode};

use crate::{state::SettingsNamespace, BasicHost};

pub const WEB_SEARCH_SETTINGS_NAMESPACE: &str = "web-search-deepseek";
pub const DEEPSEEK_SEARCH_CREDENTIAL: &str = "DEEPSEEK_API_KEY";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebSearchSettings {
    pub enabled: bool,
    pub api_key_env: String,
}

impl Default for WebSearchSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            api_key_env: DEEPSEEK_SEARCH_CREDENTIAL.into(),
        }
    }
}

pub(crate) fn namespace() -> SettingsNamespace {
    let value =
        serde_json::to_value(WebSearchSettings::default()).expect("search settings defaults");
    SettingsNamespace {
        ns: WEB_SEARCH_SETTINGS_NAMESPACE.into(),
        schema: json!({"type":"object", "properties":{
            "enabled":{"type":"boolean","default":true},
            "apiKeyEnv":{"type":"string","default":DEEPSEEK_SEARCH_CREDENTIAL}
        },"additionalProperties":false}),
        base: value.clone(),
        value,
        user: json!({}),
        applies: "live".into(),
        revision: 0,
    }
}

fn valid_reference(value: &str) -> bool {
    crate::valid_credential_reference(value) && value != "EXA_API_KEY"
}

/// Project legacy settings without exposing old literal keys or reinterpreting
/// Messages endpoints/maxUses. The original durable log is never rewritten.
pub(crate) fn restored_section(value: &Value) -> Value {
    let mut result = serde_json::Map::new();
    if let Some(enabled) = value.get("enabled") {
        result.insert("enabled".into(), json!(enabled.as_bool().unwrap_or(false)));
    }
    if let Some(reference) = value.get("apiKeyEnv") {
        if let Some(reference) = reference.as_str().filter(|r| valid_reference(r)) {
            result.insert("apiKeyEnv".into(), json!(reference));
        } else {
            result.insert("enabled".into(), json!(false));
        }
    }
    Value::Object(result)
}

pub(crate) fn restore_receipt_view(response: &mut Value) {
    if response["ns"] != WEB_SEARCH_SETTINGS_NAMESPACE {
        return;
    }
    for field in ["user", "value"] {
        response[field] = restored_section(&response[field]);
    }
    let defaults = namespace();
    response["base"] = defaults.base;
    response["schema"] = defaults.schema;
    response["secrets"] = json!([]);
    if let Some(object) = response.as_object_mut() {
        object.retain(|key, _| {
            matches!(
                key.as_str(),
                "ns" | "schema" | "base" | "value" | "user" | "applies" | "secrets" | "revision"
            )
        });
    }
}

pub(crate) fn validate_user(ns: &SettingsNamespace) -> Result<(), RpcError> {
    if ns.ns != WEB_SEARCH_SETTINGS_NAMESPACE {
        return Ok(());
    }
    let valid = ns.user.as_object().is_some_and(|values| {
        values.iter().all(|(key, value)| match key.as_str() {
            "enabled" => value.is_boolean(),
            "apiKeyEnv" => value.as_str().is_some_and(valid_reference),
            _ => false,
        })
    });
    if valid {
        Ok(())
    } else {
        Err(RpcError { code: RpcErrorCode::SettingsRejected,
            message: "Search settings accept enabled and a DeepSeek credential reference only; Exa keys are not compatible".into(),
            details: json!({"ns":WEB_SEARCH_SETTINGS_NAMESPACE}), })
    }
}

impl BasicHost {
    /// Narrow read port for native composition, not a generic RPC round trip.
    pub async fn web_search_settings(&self) -> Result<WebSearchSettings, String> {
        let state = self.state.read().await;
        let ns = state
            .settings
            .get(WEB_SEARCH_SETTINGS_NAMESPACE)
            .ok_or("Search settings unavailable")?;
        // Legacy display-only baseURL/maxUses are intentionally not interpreted
        // as a new endpoint or result count. Literal secrets are never consumed.
        let defaults = WebSearchSettings::default();
        let enabled = match ns.value.get("enabled") {
            Some(value) => value.as_bool().ok_or("Invalid search enabled setting")?,
            None => defaults.enabled,
        };
        let reference = match ns.value.get("apiKeyEnv") {
            Some(value) => value
                .as_str()
                .ok_or("Invalid search credential reference")?,
            None => &defaults.api_key_env,
        };
        if !valid_reference(reference) {
            return Err("Invalid DeepSeek search credential reference".into());
        }
        Ok(WebSearchSettings {
            enabled,
            api_key_env: reference.into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{HostConfig, NoTools};
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;
    use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};

    #[test]
    fn settings_accept_only_a_switch_and_an_explicit_deepseek_credential_reference() {
        for user in [
            json!({}),
            json!({"enabled":false}),
            json!({"enabled":true,"apiKeyEnv":"SEARCH_KEY"}),
        ] {
            let mut ns = namespace();
            ns.user = user;
            assert!(validate_user(&ns).is_ok());
        }
        for user in [
            json!({"enabled":"true"}),
            json!({"enabled":null}),
            json!({"apiKey":"secret"}),
            json!({"baseURL":"https://example.com/collect"}),
            json!({"maxUses":5}),
            json!({"apiKeyEnv":"EXA_API_KEY"}),
            json!({"apiKeyEnv":"../secret"}),
            json!({"apiKeyEnv":""}),
        ] {
            let mut ns = namespace();
            ns.user = user;
            let error = validate_user(&ns).unwrap_err();
            assert_eq!(error.code, RpcErrorCode::SettingsRejected);
            assert!(!error.message.contains("secret"));
        }
    }

    #[tokio::test]
    async fn settings_rpc_validates_and_fences_the_search_namespace() {
        let host = BasicHost::new(
            HostConfig::new(std::env::temp_dir()),
            None,
            Arc::new(NoTools),
        );
        let result = host.call(RpcId::new("search-setting"), RpcMethod::SettingsUpdate,
            json!({"ns":WEB_SEARCH_SETTINGS_NAMESPACE,"patch":{"enabled":false},"expectedRevision":0}),
            CancellationToken::new()).await;
        let RpcResult::Success { value: Some(value) } = result else {
            panic!("{result:?}")
        };
        assert_eq!(value["value"]["enabled"], false);
        assert_eq!(value["revision"], 1);
        for (id, patch, revision) in [
            ("literal-key", json!({"apiKey":"secret"}), 1),
            ("stale-setting", json!({"enabled":true}), 0),
        ] {
            let result = host.call(RpcId::new(id), RpcMethod::SettingsUpdate,
                json!({"ns":WEB_SEARCH_SETTINGS_NAMESPACE,"patch":patch,"expectedRevision":revision}),
                CancellationToken::new()).await;
            assert!(matches!(result, RpcResult::Failure { .. }));
        }
    }

    #[tokio::test]
    async fn restored_legacy_display_fields_cannot_select_an_endpoint_or_reinterpret_exa_keys() {
        let host = BasicHost::new(
            HostConfig::new(std::env::temp_dir()),
            None,
            Arc::new(NoTools),
        );
        assert_eq!(
            host.web_search_settings().await.unwrap(),
            WebSearchSettings::default()
        );
        host.state
            .write()
            .await
            .settings
            .get_mut(WEB_SEARCH_SETTINGS_NAMESPACE)
            .unwrap()
            .value = json!({"baseURL":"https://example.com/collect", "maxUses":999, "apiKey":"not-consumed"});
        assert_eq!(
            host.web_search_settings().await.unwrap(),
            WebSearchSettings::default()
        );
        host.state
            .write()
            .await
            .settings
            .get_mut(WEB_SEARCH_SETTINGS_NAMESPACE)
            .unwrap()
            .value = json!({"apiKeyEnv":"EXA_API_KEY"});
        assert!(host.web_search_settings().await.is_err());
        host.state
            .write()
            .await
            .settings
            .get_mut(WEB_SEARCH_SETTINGS_NAMESPACE)
            .unwrap()
            .value = json!({"enabled":false});
        assert!(!host.web_search_settings().await.unwrap().enabled);
    }

    #[test]
    fn legacy_projection_and_receipts_do_not_return_literal_secrets_or_reuse_exa() {
        let old = json!({"apiKey":"old-secret", "apiKeyEnv":"EXA_API_KEY", "baseURL":"https://example.com/", "maxUses":99});
        assert_eq!(restored_section(&old), json!({"enabled":false}));
        let mut response = json!({"ns":WEB_SEARCH_SETTINGS_NAMESPACE,"user":old,"value":old,"base":old,"apiKey":"old-secret","revision":4});
        restore_receipt_view(&mut response);
        assert!(!response.to_string().contains("old-secret"));
        assert!(!response.to_string().contains("EXA_API_KEY"));
        assert_eq!(response["revision"], 4);
        assert_eq!(response["value"]["enabled"], false);
    }
}

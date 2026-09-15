//! Shipped UI preferences share the durable Host settings pipeline.
use serde_json::{json, Value};
use xharness_api::{RpcError, RpcErrorCode};

use crate::state::{HostState, SettingsNamespace};

fn field(ns: &str) -> Option<(&'static str, &'static [&'static str])> {
    match ns {
        "ui-theme" => Some(("preference", &["light", "dark", "system"])),
        "locale" => Some(("preference", &["zh", "en"])),
        "ui-conversation" => Some(("busyEnter", &["queue", "steer"])),
        "agent-presets" => Some(("default", &[])),
        _ => None,
    }
}

pub(crate) fn namespaces() -> impl Iterator<Item = SettingsNamespace> {
    ["ui-theme", "locale", "ui-conversation", "agent-presets"].into_iter().map(|ns| {
        let (key, choices) = field(ns).unwrap();
        let scalar = if choices.is_empty() {
            json!({"type":"string", "minLength":1, "maxLength":256})
        } else {
            json!({"type":"string", "enum":choices})
        };
        SettingsNamespace {
            ns: ns.to_owned(),
            schema: json!({"type":"object", "properties":{(key):scalar}, "additionalProperties":false}),
            // Absence preserves the UI's own fallback (e.g. browser locale).
            base: json!({}), user: json!({}), value: json!({}),
            applies: "live".to_owned(), revision: 0,
        }
    })
}

/// Validate before journal commit, without altering other settings namespaces.
pub(crate) fn validate(namespace: &SettingsNamespace) -> Result<(), RpcError> {
    let Some((key, choices)) = field(&namespace.ns) else {
        return Ok(());
    };
    let valid = namespace.user.as_object().is_some_and(|section| {
        section.iter().all(|(name, value)| {
            name == key
                && value.as_str().is_some_and(|text| {
                    if choices.is_empty() {
                        !text.trim().is_empty() && text.chars().count() <= 256
                    } else {
                        choices.contains(&text)
                    }
                })
        })
    });
    if valid {
        Ok(())
    } else {
        Err(RpcError {
            code: RpcErrorCode::SettingsRejected,
            message: "invalid UI preference section".to_owned(),
            details: json!({"ns":namespace.ns}),
        })
    }
}

impl HostState {
    pub(crate) fn default_agent_preset(&self) -> &str {
        self.settings
            .get("agent-presets")
            .and_then(|namespace| namespace.value.get("default"))
            .and_then(Value::as_str)
            .filter(|id| self.presets.contains_key(*id))
            .unwrap_or("coding")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preference_sections_match_shipped_enums_and_allow_unset() {
        for mut ns in namespaces() {
            assert!(validate(&ns).is_ok());
            let (key, choices) = field(&ns.ns).unwrap();
            let valid = if choices.is_empty() {
                &["coding", "custom-preset"][..]
            } else {
                choices
            };
            for value in valid {
                ns.user = json!({(key):value});
                assert!(validate(&ns).is_ok());
            }
            for value in [
                json!(null),
                json!(false),
                json!(3),
                json!({}),
                json!([]),
                json!(""),
            ] {
                ns.user = json!({(key):value});
                assert!(validate(&ns).is_err());
            }
            if !choices.is_empty() {
                ns.user = json!({(key):"unsupported"});
                assert!(validate(&ns).is_err());
            }
            ns.user = json!({"unknown":"value"});
            assert!(validate(&ns).is_err());
        }
    }
}

//! Pure settings-layer merge shared by restoration, RPC decisions and migration.
//! No Host runtime, persistence or transport dependencies.

use serde_json::{json, Value};

/// Model `value` is derived state, not a replayable snapshot. Rebase user
/// overrides on each deployment's current provider defaults.
pub fn merge_model_layers(base: &Value, user: &Value) -> Value {
    let mut merged = base.clone();
    merge_object(&mut merged, user);
    // Arrays remain user-owned (including order and deletions). Only an omitted
    // output target inherits a matching deployment model's declared maximum.
    // Do not copy a limit across endpoints, protocols or upstream model aliases.
    if let Some(providers) = merged.get_mut("providers").and_then(Value::as_object_mut) {
        for (id, provider) in providers {
            let Some(defaults) = base.get("providers").and_then(|p| p.get(id)) else {
                continue;
            };
            let same_route = ["baseURL", "api"]
                .iter()
                .all(|key| provider.get(*key) == defaults.get(*key));
            if !same_route {
                if user
                    .get("providers")
                    .and_then(|p| p.get(id))
                    .and_then(|p| p.get("maxTokens"))
                    .filter(|v| !v.is_null())
                    .is_none()
                {
                    if let Some(object) = provider.as_object_mut() {
                        object.remove("maxTokens");
                    }
                }
                continue;
            }
            if provider.get("maxTokens").is_some_and(Value::is_null) {
                if let (Some(object), Some(maximum)) =
                    (provider.as_object_mut(), defaults.get("maxTokens"))
                {
                    object.insert("maxTokens".to_owned(), maximum.clone());
                }
            }
            let Some(models) = provider.get_mut("models").and_then(Value::as_array_mut) else {
                continue;
            };
            let Some(base_models) = defaults.get("models").and_then(Value::as_array) else {
                continue;
            };
            for model in models {
                if model.get("maxTokens").is_some_and(|v| !v.is_null()) {
                    continue;
                }
                let Some(default) = base_models.iter().find(|base_model| {
                    model.get("id").is_some()
                        && model.get("id") == base_model.get("id")
                        && model
                            .get("upstreamModel")
                            .filter(|v| !v.is_null())
                            .or_else(|| model.get("id"))
                            == base_model
                                .get("upstreamModel")
                                .filter(|v| !v.is_null())
                                .or_else(|| base_model.get("id"))
                }) else {
                    continue;
                };
                if let (Some(object), Some(maximum)) =
                    (model.as_object_mut(), default.get("maxTokens"))
                {
                    object.insert("maxTokens".to_owned(), maximum.clone());
                }
            }
        }
    }
    merged
}

pub(crate) fn merge_object(target: &mut Value, patch: &Value) {
    let Some(patch) = patch.as_object() else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = json!({});
    }
    let target = target.as_object_mut().expect("initialized as object");
    for (key, value) in patch {
        match target.get_mut(key) {
            Some(existing) if existing.is_object() && value.is_object() => {
                merge_object(existing, value);
            }
            _ => {
                target.insert(key.clone(), value.clone());
            }
        }
    }
}

#[cfg(test)]
mod output_default_tests {
    use super::*;
    #[test]
    fn only_matching_output_defaults_inherit_without_resurrecting_rows() {
        let base = json!({"providers":{"p":{"baseURL":"https://one.example/v1","api":"openai-completions","maxTokens":8000,"models":[{"id":"a","maxTokens":64000,"minimumOutputTokens":8192},{"id":"deleted","maxTokens":9000}]}}});
        let user = json!({"providers":{"p":{"models":[{"id":"new","extra":true},{"id":"a","future":{"keep":true}}]}}});
        let merged = merge_model_layers(&base, &user);
        let rows = merged["providers"]["p"]["models"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], user["providers"]["p"]["models"][0]);
        assert_eq!(rows[1]["maxTokens"], 64000);
        assert!(rows[1].get("minimumOutputTokens").is_none());
        assert_eq!(rows[1]["future"], json!({"keep":true}));
        for patch in [
            json!({"baseURL":"https://two.example/v1"}),
            json!({"api":"openai-responses"}),
        ] {
            let mut changed = user.clone();
            merge_object(&mut changed["providers"]["p"], &patch);
            let next = merge_model_layers(&base, &changed);
            assert!(next["providers"]["p"].get("maxTokens").is_none());
            assert!(next["providers"]["p"]["models"][1]
                .get("maxTokens")
                .is_none());
        }
        let alias = json!({"providers":{"p":{"models":[{"id":"a","upstreamModel":"different"}]}}});
        assert!(
            merge_model_layers(&base, &alias)["providers"]["p"]["models"][0]
                .get("maxTokens")
                .is_none()
        );
        let explicit = json!({"providers":{"p":{"models":[{"id":"a","maxTokens":32000,"minimumOutputTokens":1234}]}}});
        assert_eq!(
            merge_model_layers(&base, &explicit)["providers"]["p"]["models"],
            explicit["providers"]["p"]["models"]
        );
        assert_eq!(
            base["providers"]["p"]["models"].as_array().unwrap().len(),
            2
        );
    }
}

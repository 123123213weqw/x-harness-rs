//! Host projection of the independent, offline model catalog.
use reasonmap::{bundled, Protocol};
use serde_json::{json, Value};
#[derive(Clone, Debug)]
pub struct Compatibility {
    pub profile: Value,
    pub provenance: Value,
}
pub fn resolve(base: &str, api: &str, upstream_model: &str) -> Option<Compatibility> {
    let protocol = match api {
        "openai-completions" => Protocol::ChatCompletions,
        "openai-responses" => Protocol::Responses,
        _ => return None,
    };
    let found = bundled().ok()?.resolve(base, protocol, upstream_model)?;
    let profile =
        crate::reasoning_discovery::validated_profile(&serde_json::to_value(found.profile).ok()?)
            .ok()?;
    Some(Compatibility {
        profile,
        provenance: json!({"state":"supported","source":"documented","stale":false,
        "catalogVersion":found.catalog_version,"checkedOn":found.checked_on,"family":found.family,
        "sources":found.sources,"canonicalModel":found.identity.canonical_id,"modelVersion":found.identity.snapshot_version,
        "displayName":found.identity.display_name,"legacyAlias":found.identity.legacy_alias}),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_projection_preserves_the_independent_catalog_and_adapter_validation() {
        let catalog = bundled().unwrap();
        let found = resolve(
            "https://api.deepseek.com",
            "openai-completions",
            "deepseek-flash",
        )
        .unwrap();
        assert_eq!(found.provenance["catalogVersion"], catalog.version());
        assert_eq!(found.provenance["modelVersion"], "DeepSeek-V4.1-Flash");
        assert_eq!(found.provenance["source"], "documented");
    }
    #[test]
    fn endpoints_protocols_and_ids_must_match_exactly() {
        for base in [
            "http://api.deepseek.com",
            "https://api.deepseek.com.evil.test",
            "https://proxy.test/v1",
            "https://api.deepseek.com/proxy",
            "https://api.deepseek.com:8443",
            "https://user@api.deepseek.com",
            "https://api.deepseek.com?route=glm",
            "https://api.deepseek.com/#route",
        ] {
            assert!(
                resolve(base, "openai-completions", "deepseek-flash").is_none(),
                "{base}"
            );
        }
        for model in [
            "DeepSeek Flash",
            "deepseek-flash-new",
            "glm-5.3",
            "deepseek-v4.1-flash",
        ] {
            assert!(resolve("https://api.deepseek.com", "openai-completions", model).is_none());
        }
        assert!(resolve(
            "https://api.deepseek.com/v1/",
            "openai-completions",
            "deepseek-flash"
        )
        .is_some());
        assert!(resolve("https://api.z.ai/api/v1", "openai-responses", "glm-5.3").is_none());
        assert!(resolve(
            "https://api.deepseek.com",
            "anthropic-messages",
            "deepseek-flash"
        )
        .is_none());
    }
    #[test]
    fn true_levels_defaults_and_wire_fields_differ_per_model_and_protocol() {
        for (base, api, model, ids, default) in [
            (
                "https://api.deepseek.com",
                "openai-completions",
                "deepseek-flash",
                vec!["off", "low", "high", "max"],
                "high",
            ),
            (
                "https://api.deepseek.com",
                "openai-responses",
                "deepseek-v4-pro",
                vec!["off", "low", "high", "max"],
                "high",
            ),
            (
                "https://open.bigmodel.cn/api/paas/v4",
                "openai-completions",
                "glm-4.7",
                vec!["off", "on"],
                "on",
            ),
            (
                "https://api.z.ai/api/coding/paas/v4",
                "openai-completions",
                "glm-5.2",
                vec!["off", "high", "max"],
                "max",
            ),
            (
                "https://api.z.ai/api/paas/v4",
                "openai-completions",
                "glm-5.3",
                vec!["low", "high", "max"],
                "max",
            ),
        ] {
            let profile = resolve(base, api, model).unwrap().profile;
            assert_eq!(profile["default_effort"], default);
            let levels = profile["efforts"].as_array().unwrap();
            assert_eq!(
                levels
                    .iter()
                    .map(|l| l["id"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                ids
            );
            for level in levels {
                let patch = &level["request_patch"];
                if api == "openai-responses" {
                    assert!(patch.get("thinking").is_none());
                    assert!(patch.get("reasoning_effort").is_none());
                    assert_eq!(
                        patch["reasoning"]["effort"],
                        if level["id"] == "off" {
                            json!("none")
                        } else {
                            level["id"].clone()
                        }
                    );
                } else {
                    assert!(patch.get("reasoning").is_none());
                    assert_eq!(
                        patch["thinking"]["type"],
                        if level["id"] == "off" {
                            "disabled"
                        } else {
                            "enabled"
                        }
                    );
                    if ids.contains(&"on") || level["id"] == "off" {
                        assert!(patch.get("reasoning_effort").is_none())
                    } else {
                        assert_eq!(patch["reasoning_effort"], level["id"])
                    }
                }
            }
        }
    }
}

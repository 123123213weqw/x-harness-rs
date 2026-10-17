//! Input capability defaults are independent of reasoning configuration.
//! Catalog metadata is never guessed from a model name or an unknown proxy.
use reasonmap::{bundled, Protocol};
use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub(crate) struct ImageCapability {
    pub supported: Option<bool>,
    pub provenance: Value,
}

pub(crate) fn resolve(
    base: &str,
    api: &str,
    upstream_model: &str,
    explicit: Option<bool>,
) -> ImageCapability {
    if let Some(supported) = explicit {
        return ImageCapability {
            supported: Some(supported),
            provenance: json!({"state":if supported {"supported"} else {"unsupported"}, "source":"configured"}),
        };
    }
    let protocol = match api {
        "openai-completions" => Some(Protocol::ChatCompletions),
        "openai-responses" => Some(Protocol::Responses),
        _ => None,
    };
    let documented = protocol
        .and_then(|protocol| bundled().ok()?.resolve(base, protocol, upstream_model))
        .filter(|found| !found.identity.input_modalities.is_empty());
    if let Some(found) = documented {
        let supported = found.identity.input_modalities.iter().any(|m| m == "image");
        return ImageCapability {
            supported: Some(supported),
            provenance: json!({"state":if supported {"supported"} else {"unsupported"},
                    "source":"documented", "catalogVersion":found.catalog_version,
                    "checkedOn":found.identity.input_modalities_checked_on, "sources":found.identity.input_modalities_sources,
                    "inputModalities":found.identity.input_modalities}),
        };
    }
    ImageCapability {
        supported: None,
        provenance: json!({"state":"unknown","source":"unknown"}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_documented_routes_and_explicit_overrides_are_independent_of_reasoning() {
        for api in ["openai-completions", "openai-responses"] {
            let found = resolve("https://api.deepseek.com", api, "deepseek-flash", None);
            assert_eq!(found.supported, Some(true));
            assert_eq!(found.provenance["source"], "documented");
            assert_eq!(found.provenance["checkedOn"], "2026-10-18");
            assert!(found.provenance["sources"][0]
                .as_str()
                .unwrap()
                .contains("/vision/"));
            assert_eq!(
                found.provenance["catalogVersion"],
                bundled().unwrap().version()
            );
            assert_eq!(
                resolve(
                    "https://api.deepseek.com",
                    api,
                    "deepseek-flash",
                    Some(false)
                )
                .supported,
                Some(false)
            );
        }
        for (base, api, model) in [
            (
                "https://proxy.test/v1",
                "openai-completions",
                "deepseek-flash",
            ),
            (
                "https://api.deepseek.com",
                "anthropic-messages",
                "deepseek-flash",
            ),
            (
                "https://api.deepseek.com",
                "openai-completions",
                "deepseek-v4-pro",
            ),
            (
                "http://localhost:8080/v1",
                "openai-completions",
                "qwen-vision",
            ),
        ] {
            assert_eq!(resolve(base, api, model, None).supported, None);
        }
        assert_eq!(
            resolve(
                "http://localhost:8080/v1",
                "openai-completions",
                "local",
                Some(true)
            )
            .supported,
            Some(true)
        );
    }
}

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

    #[test]
    fn current_models_resolve_only_through_implemented_exact_protocols() {
        let mut routes = vec![
            (
                "https://api.deepseek.com",
                "openai-completions",
                "deepseek-flash",
            ),
            (
                "https://generativelanguage.googleapis.com/v1beta/openai",
                "openai-completions",
                "gemini-3.8-flash",
            ),
            ("https://api.x.ai/v1", "openai-completions", "grok-4.7"),
        ];
        for api in ["openai-completions", "openai-responses"] {
            for model in ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"] {
                routes.push(("https://api.openai.com/v1", api, model));
            }
            for base in ["https://api.moonshot.cn/v1", "https://api.moonshot.ai/v1"] {
                routes.push((base, api, "kimi-k3"));
            }
        }
        for base in [
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
            "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
            "https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1",
        ] {
            for model in ["qwen3.8-max", "qwen3.8-flash"] {
                routes.push((base, "openai-completions", model));
            }
        }
        for (base, api, model) in routes {
            let found = resolve(base, api, model, None);
            assert_eq!(found.supported, Some(true), "{base}/{api}/{model}");
            assert_eq!(found.provenance["source"], "documented");
            assert_eq!(found.provenance["checkedOn"], "2026-10-18");
            assert_eq!(
                resolve(base, api, model, Some(false)).supported,
                Some(false)
            );
            assert_eq!(
                resolve("https://proxy.test/v1", api, model, None).supported,
                None
            );
        }
        for model in [
            "claude-fable-5-1",
            "claude-opus-5-5",
            "claude-sonnet-5-5",
            "claude-haiku-5-5",
        ] {
            for api in [
                "openai-completions",
                "openai-responses",
                "anthropic-messages",
            ] {
                assert_eq!(
                    resolve("https://api.anthropic.com/v1", api, model, None).supported,
                    None,
                    "catalog facts must not enable an unimplemented adapter: {api}/{model}"
                );
            }
        }
        assert_eq!(
            resolve("https://api.x.ai/v1", "openai-responses", "grok-4.7", None).supported,
            None
        );
    }
}

//! Documented capability fallback, not a claim that /models advertises efforts.
//! Keep vendor details in native Provider composition, never in Loop/UI.
//! Verified 2026-09-07: https://api-docs.deepseek.com/guides/thinking_mode/
use super::{ModelReasoningConfig, ModelReasoningEffortConfig, OpenAiProtocol};
use serde_json::json;

pub(super) fn builtin(
    endpoint: &str,
    upstream_model: &str,
    protocol: OpenAiProtocol,
) -> Option<ModelReasoningConfig> {
    let url = reqwest::Url::parse(endpoint).ok()?;
    // Do not infer a proxy's capabilities from its provider ID or model name.
    if url.scheme() != "https"
        || url.host_str() != Some("api.deepseek.com")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path().trim_end_matches('/'), "" | "/v1" | "/beta")
        || !matches!(
            upstream_model,
            "deepseek-v4-flash" | "deepseek-v4-pro" | "deepseek-v4-flash-vision-exp"
        )
    {
        return None;
    }
    Some(ModelReasoningConfig {
        default_effort: Some("high".into()),
        // Ordering also provides compact's independent lowest-effort fallback.
        efforts: [
            ("off", "关闭思考"),
            ("low", "低"),
            ("high", "高"),
            ("max", "最高"),
        ]
        .into_iter()
        .map(|(id, name)| ModelReasoningEffortConfig {
            id: id.into(),
            name: name.into(),
            description: Some("DeepSeek 官方文档档位；显式模型配置优先".into()),
            request_patch: match protocol {
                OpenAiProtocol::ChatCompletions if id == "off" => {
                    json!({"thinking":{"type":"disabled"}})
                }
                OpenAiProtocol::ChatCompletions => {
                    json!({"thinking":{"type":"enabled"},"reasoning_effort":id})
                }
                OpenAiProtocol::Responses => {
                    json!({"reasoning":{"effort":if id == "off" { "none" } else { id }}})
                }
            },
        })
        .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{registry_from_settings, ProviderFile};
    use std::collections::BTreeMap;
    use xharness_debug::DebugRecorder;
    use xharness_host::{parse_model_settings, ModelRoute};

    #[test]
    fn catalog_is_scoped_to_verified_endpoint_and_exact_upstream_models() {
        for base in [
            "https://api.deepseek.com",
            "https://api.deepseek.com/v1/",
            "https://api.deepseek.com/beta",
        ] {
            for model in [
                "deepseek-v4-flash",
                "deepseek-v4-pro",
                "deepseek-v4-flash-vision-exp",
            ] {
                assert!(builtin(base, model, OpenAiProtocol::ChatCompletions).is_some());
            }
        }
        for base in [
            "http://api.deepseek.com",
            "https://api.deepseek.com.evil.invalid",
            "https://gateway.example/v1",
            "http://127.0.0.1:8000/v1",
            "https://api.deepseek.com:444",
            "https://api.deepseek.com/other",
            "https://api.deepseek.com?x=1",
            "https://user@api.deepseek.com",
            "https://api.deepseek.com/#fragment",
        ] {
            assert!(
                builtin(base, "deepseek-v4-flash", OpenAiProtocol::ChatCompletions).is_none(),
                "{base}"
            );
        }
        for model in [
            "qwen",
            "deepseek-v5",
            "deepseek-v4-flash-custom",
            "deepseek-chat",
        ] {
            assert!(builtin(
                "https://api.deepseek.com",
                model,
                OpenAiProtocol::ChatCompletions
            )
            .is_none());
        }
    }

    #[test]
    fn documented_patches_match_both_protocols_without_invented_levels() {
        for protocol in [OpenAiProtocol::ChatCompletions, OpenAiProtocol::Responses] {
            let profile =
                builtin("https://api.deepseek.com", "deepseek-v4-flash", protocol).unwrap();
            profile.adapter_profile().unwrap();
            assert_eq!(profile.default_effort.as_deref(), Some("high"));
            assert_eq!(
                profile
                    .efforts
                    .iter()
                    .map(|e| e.id.as_str())
                    .collect::<Vec<_>>(),
                ["off", "low", "high", "max"]
            );
            for effort in profile.efforts {
                match protocol {
                    OpenAiProtocol::ChatCompletions if effort.id == "off" => assert_eq!(
                        effort.request_patch,
                        json!({"thinking":{"type":"disabled"}})
                    ),
                    OpenAiProtocol::ChatCompletions => assert_eq!(
                        effort.request_patch,
                        json!({"thinking":{"type":"enabled"},"reasoning_effort":effort.id})
                    ),
                    OpenAiProtocol::Responses => assert_eq!(
                        effort.request_patch,
                        json!({"reasoning":{"effort":if effort.id == "off" {"none"} else {&effort.id}}})
                    ),
                }
            }
        }
    }

    #[tokio::test]
    async fn legacy_settings_rebuild_effective_catalog_without_rewriting_user_values() {
        for api in ["openai-completions", "openai-responses"] {
            let value = json!({"providers":{"renamed":{"baseURL":"https://api.deepseek.com/v1","api":api,"models":[
                {"id":"my-alias","upstreamModel":"deepseek-v4-flash","contextWindow":1000000},
                {"id":"deepseek-v4-pro","contextWindow":1000000},
                {"id":"deepseek-v4-flash-vision-exp","contextWindow":1000000},
                {"id":"unknown","contextWindow":1000000}
            ]}}});
            for _ in 0..2 {
                let doc = parse_model_settings(&value).unwrap();
                let registry =
                    registry_from_settings(&doc, &BTreeMap::new(), DebugRecorder::disabled(), None)
                        .await
                        .unwrap();
                let models = registry.models();
                for model in models.iter().filter(|m| m.model != "unknown") {
                    assert_eq!(model.reasoning.as_ref().unwrap().efforts.len(), 4);
                    let mut route = ModelRoute::new("renamed", &model.model);
                    for effort in ["off", "low", "high", "max"] {
                        route.reasoning_effort = Some(effort.into());
                        assert!(registry.can_route(&route));
                    }
                    route.reasoning_effort = Some("medium".into());
                    assert!(!registry.can_route(&route));
                    assert_eq!(
                        registry
                            .compaction_reasoning_effort(&ModelRoute::new("renamed", &model.model))
                            .as_deref(),
                        Some("off")
                    );
                }
                assert!(models
                    .iter()
                    .find(|m| m.model == "unknown")
                    .unwrap()
                    .reasoning
                    .is_none());
                assert!(doc.providers["renamed"]
                    .models
                    .iter()
                    .all(|m| m.reasoning.is_none()));
            }
        }
    }

    #[tokio::test]
    async fn explicit_profile_wins_and_invalid_profile_is_not_silently_replaced() {
        let mut value = json!({"default":{"provider":"deepseek","model":"deepseek-v4-flash"},"providers":[{"id":"deepseek","base_url":"https://api.deepseek.com","models":[{"id":"deepseek-v4-flash","fallback_context_window_tokens":1000000,"reasoning":{"default_effort":"custom","efforts":[{"id":"custom","name":"自定义","request_patch":{"reasoning_effort":"low"}}]}}]}]});
        let deployment = serde_json::from_value::<ProviderFile>(value.clone())
            .unwrap()
            .build()
            .await
            .unwrap();
        let models = deployment.registry.models();
        assert_eq!(models[0].reasoning.as_ref().unwrap().efforts.len(), 1);
        assert_eq!(
            models[0]
                .reasoning
                .as_ref()
                .unwrap()
                .default_effort
                .as_deref(),
            Some("custom")
        );
        value["providers"][0]["models"][0]["reasoning"] = json!({"efforts":[]});
        assert!(serde_json::from_value::<ProviderFile>(value)
            .unwrap()
            .build()
            .await
            .is_err());
    }
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    use futures::StreamExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_util::sync::CancellationToken;
    use xharness_core::{AgentMessage, ModelProvider, ProviderRequest};
    use xharness_provider_openai::{OpenAiProvider, OpenAiProviderConfig};

    #[tokio::test]
    async fn catalog_is_applied_to_actual_chat_and_responses_request_bodies() {
        for protocol in [OpenAiProtocol::ChatCompletions, OpenAiProtocol::Responses] {
            for requested in [None, Some("off"), Some("low"), Some("high"), Some("max")] {
                let profile =
                    builtin("https://api.deepseek.com", "deepseek-v4-flash", protocol).unwrap();
                let expected = profile
                    .efforts
                    .iter()
                    .find(|e| e.id == requested.unwrap_or("high"))
                    .unwrap()
                    .request_patch
                    .clone();
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let endpoint = format!("http://{}", listener.local_addr().unwrap());
                let server = tokio::spawn(async move {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut bytes = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let body = loop {
                        let n = socket.read(&mut chunk).await.unwrap();
                        assert!(n > 0);
                        bytes.extend_from_slice(&chunk[..n]);
                        if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                            let headers = String::from_utf8_lossy(&bytes[..end]);
                            let len = headers
                                .lines()
                                .find_map(|l| {
                                    l.to_lowercase()
                                        .strip_prefix("content-length:")
                                        .map(|n| n.trim().parse::<usize>().unwrap())
                                })
                                .unwrap();
                            if bytes.len() >= end + 4 + len {
                                break serde_json::from_slice::<serde_json::Value>(
                                    &bytes[end + 4..end + 4 + len],
                                )
                                .unwrap();
                            }
                        }
                    };
                    for (k, v) in expected.as_object().unwrap() {
                        assert_eq!(&body[k], v);
                    }
                    match protocol {
                        OpenAiProtocol::ChatCompletions => {
                            assert!(body.get("reasoning").is_none());
                            if requested == Some("off") {
                                assert!(body.get("reasoning_effort").is_none());
                            }
                        }
                        OpenAiProtocol::Responses => {
                            assert!(body.get("thinking").is_none());
                            assert!(body.get("reasoning_effort").is_none());
                        }
                    }
                    let response=match protocol {
                        OpenAiProtocol::ChatCompletions=>"data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
                        OpenAiProtocol::Responses=>"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n"
                    };
                    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).as_bytes()).await.unwrap();
                });
                let provider = OpenAiProvider::new(
                    OpenAiProviderConfig::new(protocol, endpoint, "test-key", "deepseek-v4-flash")
                        .with_reasoning_profile(profile.adapter_profile().unwrap()),
                )
                .unwrap();
                let request = ProviderRequest {
                    messages: vec![AgentMessage::user("hello")],
                    tools: vec![],
                    step: 1,
                    reasoning_effort: requested.map(str::to_owned),
                    max_output_tokens: Some(128),
                    debug_scope: Default::default(),
                };
                tokio::time::timeout(std::time::Duration::from_secs(10), async {
                    let mut stream = provider
                        .stream(request, CancellationToken::new())
                        .await
                        .unwrap();
                    while let Some(event) = stream.next().await {
                        event.unwrap();
                    }
                    server.await.unwrap();
                })
                .await
                .unwrap();
            }
        }
    }
}

//! Bundled profiles through the real Rust adapter and a local HTTP capture.
//! Official endpoint resolution is tested separately; no real keys/billing.
use serde_json::Value;
use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_util::sync::CancellationToken;
use xharness_attachments::{AttachmentStore, ContentBlock, MemoryAttachmentStore, Upload};
use xharness_core::{AgentMessage, ModelProvider, ProviderRequest};
use xharness_host_app::reasoning_compat::resolve;
use xharness_provider_openai::{
    OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig, OpenAiReasoningProfile,
};

#[tokio::test]
async fn every_curated_level_and_default_transmits_exact_protocol_specific_patch() {
    let catalog: Value = serde_json::from_str(reasonmap::CATALOG_JSON).unwrap();
    let current = [
        "deepseek-flash",
        "gpt-6.1-sol",
        "gpt-6-astra",
        "gpt-6-luna",
        "gemini-3.8-flash",
        "qwen3.8-max",
        "qwen3.8-flash",
        "kimi-k3",
        "grok-4.7",
    ];
    let mut cases = vec![
        (
            "https://api.deepseek.com",
            "openai-completions",
            "deepseek-flash",
        ),
        (
            "https://api.deepseek.com",
            "openai-responses",
            "deepseek-v4-pro",
        ),
        (
            "https://open.bigmodel.cn/api/paas/v4",
            "openai-completions",
            "glm-4.7",
        ),
        (
            "https://api.z.ai/api/coding/paas/v4",
            "openai-completions",
            "glm-5.2",
        ),
        (
            "https://open.bigmodel.cn/api/paas/v4",
            "openai-completions",
            "glm-5.3",
        ),
    ];
    for route in catalog["routes"].as_array().unwrap() {
        let api = route["api"].as_str().unwrap();
        if !matches!(api, "openai-completions" | "openai-responses") {
            continue;
        }
        let base = route["base_urls"][0].as_str().unwrap();
        for model in current {
            let case = (base, api, model);
            if route["models"]
                .as_array()
                .unwrap()
                .contains(&Value::from(model))
                && !cases.contains(&case)
            {
                cases.push(case);
            }
        }
    }
    for (official, api, model) in cases {
        let profile = resolve(official, api, model).unwrap().profile;
        let efforts = profile["efforts"].as_array().unwrap();
        let default = profile["default_effort"].as_str();
        for selected in efforts
            .iter()
            .map(|e| Some(e["id"].as_str().unwrap()))
            .chain([None])
        {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let local = format!("http://{}/v1", listener.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let mut part = [0u8; 4096];
                let (path, body) = loop {
                    let n = socket.read(&mut part).await.unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&part[..n]);
                    if let Some(at) = bytes.windows(4).position(|p| p == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&bytes[..at]);
                        let length: usize = head
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse().unwrap())
                            })
                            .unwrap();
                        if bytes.len() >= at + 4 + length {
                            break (
                                head.lines().next().unwrap().to_owned(),
                                serde_json::from_slice::<Value>(&bytes[at + 4..at + 4 + length])
                                    .unwrap(),
                            );
                        }
                    }
                };
                let reply="data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",reply.len()).as_bytes()).await.unwrap();
                (path, body)
            });
            let reasoning = OpenAiReasoningProfile::new(
                default.map(str::to_owned),
                efforts.iter().map(|e| {
                    (
                        e["id"].as_str().unwrap().to_owned(),
                        e["request_patch"].clone(),
                    )
                }),
            )
            .unwrap();
            let protocol = if api == "openai-responses" {
                OpenAiProtocol::Responses
            } else {
                OpenAiProtocol::ChatCompletions
            };
            let adapter = OpenAiProvider::new(
                OpenAiProviderConfig::new(protocol, local, "fake-test-key", model)
                    .with_reasoning_profile(reasoning),
            )
            .unwrap();
            let store = Arc::new(MemoryAttachmentStore::default());
            let mut message = AgentMessage::user("wire fixture");
            let image = current.contains(&model);
            if image {
                let attachment = store
                    .put(
                        "current-model-wire",
                        Upload {
                            media_type: "image/png".into(),
                            data: include_bytes!(
                                "../../xharness-attachments/tests/fixtures/red-blue.png"
                            )
                            .to_vec(),
                        },
                    )
                    .await
                    .unwrap();
                message = message.with_content_blocks(vec![
                    ContentBlock::Text {
                        text: "wire fixture".into(),
                    },
                    ContentBlock::Image { attachment },
                ]);
            }
            let adapter = adapter
                .with_attachments(store)
                .with_image_support(Some(image));
            let request = ProviderRequest {
                messages: vec![message],
                tools: vec![],
                step: 1,
                reasoning_effort: selected.map(str::to_owned),
                max_output_tokens: Some(1024),
                debug_scope: Default::default(),
            };
            let stream = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                adapter.stream(request, CancellationToken::new()),
            )
            .await
            .unwrap()
            .unwrap();
            drop(stream);
            let (path, body) = server.await.unwrap();
            let expected = selected.or(default).map(|effort| {
                &efforts.iter().find(|e| e["id"] == effort).unwrap()["request_patch"]
            });
            if let Some(expected) = expected {
                for (key, value) in expected.as_object().unwrap() {
                    assert_eq!(&body[key], value, "{model}/{selected:?}: {body}");
                }
            } else {
                assert!(body.get("reasoning_effort").is_none());
                assert!(body.get("reasoning").is_none());
                assert!(body.get("thinking").is_none());
            }
            assert_eq!(body["model"], model);
            assert_eq!(body["stream"], true);
            if api == "openai-responses" {
                assert!(path.starts_with("POST /v1/responses "));
                assert!(body.get("reasoning_effort").is_none());
                assert!(body.get("thinking").is_none());
                assert_eq!(body["max_output_tokens"], 1024);
            } else {
                assert!(path.starts_with("POST /v1/chat/completions "));
                assert!(body.get("reasoning").is_none());
                assert!(body.get("chat_template_kwargs").is_none());
                assert_eq!(body["max_tokens"], 1024);
                if expected.is_none_or(|patch| patch.get("reasoning_effort").is_none()) {
                    assert!(body.get("reasoning_effort").is_none());
                }
            }
            if image {
                let (part, url) = if api == "openai-responses" {
                    let part = &body["input"][0]["content"][1];
                    assert_eq!(part["type"], "input_image");
                    (part, &part["image_url"])
                } else {
                    let part = &body["messages"][0]["content"][1];
                    assert_eq!(part["type"], "image_url");
                    (part, &part["image_url"]["url"])
                };
                assert!(
                    url.as_str().unwrap().starts_with("data:image/png;base64,"),
                    "{model}: {part}"
                );
            }
        }
    }
}

#[tokio::test]
async fn glm_forced_reasoning_rejects_off_before_any_network_request() {
    let p = resolve(
        "https://api.z.ai/api/paas/v4",
        "openai-completions",
        "glm-5.3",
    )
    .unwrap()
    .profile;
    let profile = OpenAiReasoningProfile::new(
        Some("max".into()),
        p["efforts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| (e["id"].as_str().unwrap().into(), e["request_patch"].clone())),
    )
    .unwrap();
    let adapter = OpenAiProvider::new(
        OpenAiProviderConfig::new(
            OpenAiProtocol::ChatCompletions,
            "http://127.0.0.1:1",
            "fake",
            "glm-5.3",
        )
        .with_reasoning_profile(profile),
    )
    .unwrap();
    let request = ProviderRequest {
        messages: vec![AgentMessage::user("fixture")],
        tools: vec![],
        step: 1,
        reasoning_effort: Some("off".into()),
        max_output_tokens: Some(1024),
        debug_scope: Default::default(),
    };
    let error = adapter
        .stream(request, CancellationToken::new())
        .await
        .err()
        .unwrap();
    assert!(error.message.contains("unsupported reasoning effort"));
    assert!(!error.message.contains("network"));
}

#[test]
fn browser_fixture_is_exactly_the_pinned_catalog_not_another_ui_enum() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../scripts/fixtures/reasoning-catalog-v0.4.0.json"
    ))
    .unwrap();
    let catalog: Value = serde_json::from_str(reasonmap::CATALOG_JSON).unwrap();
    assert_eq!(fixture["profiles"], catalog["profiles"]);
    assert_eq!(fixture["catalogVersion"], catalog["version"]);
    assert_eq!(fixture["packageVersion"], "0.4.0");
    assert_eq!(
        fixture["gitRevision"],
        "44159024c3c7a16d175d2cb3a5d665c39fe47d63"
    );
}

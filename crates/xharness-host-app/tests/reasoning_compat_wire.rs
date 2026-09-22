//! Bundled profiles through the real Rust adapter and a local HTTP capture.
//! Official endpoint resolution is tested separately; no real keys/billing.
use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_util::sync::CancellationToken;
use xharness_core::{AgentMessage, ModelProvider, ProviderRequest};
use xharness_host_app::reasoning_compat::resolve;
use xharness_provider_openai::{
    OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig, OpenAiReasoningProfile,
};

#[tokio::test]
async fn every_curated_level_and_default_transmits_exact_protocol_specific_patch() {
    for (official, api, model) in [
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
    ] {
        let profile = resolve(official, api, model).unwrap().profile;
        let efforts = profile["efforts"].as_array().unwrap();
        let default = profile["default_effort"].as_str().unwrap();
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
                Some(default.to_owned()),
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
            let request = ProviderRequest {
                messages: vec![AgentMessage::user("wire fixture")],
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
            let expected = &efforts
                .iter()
                .find(|e| e["id"] == selected.unwrap_or(default))
                .unwrap()["request_patch"];
            for (key, value) in expected.as_object().unwrap() {
                assert_eq!(&body[key], value, "{model}/{selected:?}: {body}");
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
                if selected == Some("off") || model == "glm-4.7" {
                    assert!(body.get("reasoning_effort").is_none());
                }
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
        "../../../scripts/fixtures/reasoning-catalog-v0.1.1.json"
    ))
    .unwrap();
    let catalog: Value = serde_json::from_str(xharness_model_catalog::CATALOG_JSON).unwrap();
    assert_eq!(fixture["profiles"], catalog["profiles"]);
    assert_eq!(fixture["catalogVersion"], catalog["version"]);
    assert_eq!(fixture["packageVersion"], "0.1.1");
    assert_eq!(
        fixture["gitRevision"],
        "b76585abb9102690d2dd85e385550e0d2f688601"
    );
}

use super::*;
use xharness_attachments::{
    AttachmentRef, AttachmentStore, ContentBlock, MemoryAttachmentStore, Upload,
};
use xharness_core::{AgentMessage, TokenUsage};
use xharness_token::{ConservativeByteMeter, TokenBudget, TokenCountAccuracy, TokenGuard};

fn provider(protocol: OpenAiProtocol) -> OpenAiProvider {
    OpenAiProvider::new(OpenAiProviderConfig::new(
        protocol,
        "https://api.deepseek.com",
        "not-a-real-key",
        "deepseek-flash",
    ))
    .unwrap()
}

fn request() -> ProviderRequest {
    ProviderRequest {
        messages: vec![AgentMessage::user("Inspect this screenshot.")],
        tools: vec![],
        step: 1,
        reasoning_effort: None,
        max_output_tokens: Some(4096),
        debug_scope: DebugScope::default(),
    }
}

fn image() -> ContentBlock {
    ContentBlock::Image {
        attachment: AttachmentRef {
            id: "fixture-only".into(),
            session_id: "s".into(),
            media_type: "image/png".into(),
            bytes: 210585,
            width: 3600,
            height: 2400,
        },
    }
}

#[test]
fn cold_large_images_no_longer_force_compaction_but_many_images_still_overflow() {
    let guard = TokenGuard::new(
        Arc::new(ConservativeByteMeter),
        TokenBudget::new(32_768, 4096),
    )
    .unwrap();
    for protocol in [OpenAiProtocol::ChatCompletions, OpenAiProtocol::Responses] {
        let p = provider(protocol);
        let mut r = request();
        let text = p.estimate_input_tokens(&r).unwrap();
        r.messages[0].content_blocks = vec![image()];
        let mixed = p.estimate_input_tokens(&r).unwrap();
        assert_eq!(mixed.input_tokens, text.input_tokens + 1024);
        assert_eq!(mixed.accuracy, TokenCountAccuracy::ConservativeUpperBound);
        assert!(guard.check_provider_count(&mixed).is_ok());
        // Only the allowance changes: the same request with the old generic
        // image cost would exceed admission. Hard limits are not relaxed.
        let old = ProviderInputTokenCount {
            input_tokens: text.input_tokens + 135_000,
            ..mixed.clone()
        };
        assert!(guard.check_provider_count(&old).is_err());
        r.messages[0].content_blocks = vec![image(); 32];
        assert!(guard
            .check_provider_count(&p.estimate_input_tokens(&r).unwrap())
            .is_err());
        r.messages[0].content_blocks.clear();
        assert_eq!(p.estimate_input_tokens(&r).unwrap(), text);
    }
}

#[tokio::test]
async fn warm_text_remains_calibrated_and_caption_and_overflow_guards_survive() {
    for protocol in [OpenAiProtocol::ChatCompletions, OpenAiProtocol::Responses] {
        let p = provider(protocol);
        let mut r = request();
        for i in 0..8 {
            r.messages = vec![AgentMessage::user(format!("{i} {}", "text ".repeat(1000)))];
            let (scope, id, features) = p.count_features(&r).unwrap();
            p.calibration.observe(scope, id, features, 1250).await;
        }
        let text = p.estimate_input_tokens(&r).unwrap();
        assert_eq!(text.accuracy, TokenCountAccuracy::Calibrated);
        r.messages[0].content_blocks = vec![image(); 2];
        let mixed = p.estimate_input_tokens(&r).unwrap();
        assert_eq!(mixed.input_tokens, text.input_tokens + 2048);
        assert_eq!(mixed.accuracy, TokenCountAccuracy::Estimated);
        r.messages[0].content_blocks.push(ContentBlock::Text {
            text: "c".repeat(900_000),
        });
        let captioned = p.estimate_input_tokens(&r).unwrap();
        assert_eq!(captioned.input_tokens, mixed.input_tokens + 900_064);
        let guard = TokenGuard::new(
            Arc::new(ConservativeByteMeter),
            TokenBudget::new(32_768, 4096),
        )
        .unwrap();
        assert!(guard.check_provider_count(&captioned).is_err());
        r.messages[0].content_blocks.pop();
        let (scope, id, features) = p.count_features(&r).unwrap();
        p.calibration
            .observe(scope, id, features, mixed.input_tokens + 1)
            .await;
        r.messages[0].content_blocks.clear();
        // A violated mixed-request bound still invalidates the text scope.
        assert_eq!(
            p.estimate_input_tokens(&r).unwrap().accuracy,
            TokenCountAccuracy::ConservativeUpperBound
        );
        r.messages[0].content_blocks = vec![
            ContentBlock::Text {
                text: "c".repeat(900_000),
            },
            image(),
        ];
        assert!(p.estimate_input_tokens(&r).unwrap().input_tokens >= 901_088);
    }
}

#[tokio::test]
async fn both_wire_protocols_deliver_the_same_bytes_and_exact_counter_still_wins() {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    const PNG: &[u8] = include_bytes!("../../../xharness-attachments/tests/fixtures/red-blue.png");
    for protocol in [OpenAiProtocol::ChatCompletions, OpenAiProtocol::Responses] {
        let store = Arc::new(MemoryAttachmentStore::default());
        let a = store
            .put(
                "s",
                Upload {
                    media_type: "image/png".into(),
                    data: PNG.to_vec(),
                },
            )
            .await
            .unwrap();
        let mut r = request();
        r.messages[0].content_blocks = vec![ContentBlock::Image { attachment: a }];
        let p = provider(protocol).with_attachments(store);
        let before = p.estimate_input_tokens(&r).unwrap();
        let body = p
            .multimodal_body(&r, true, &CancellationToken::new())
            .await
            .unwrap();
        let payload = body.to_string();
        assert_eq!(payload.matches("data:image/png;base64,").count(), 1);
        let fallback = OpenAiProvider::new(OpenAiProviderConfig::new(
            protocol,
            "https://other.example",
            "",
            "deepseek-flash",
        ))
        .unwrap();
        assert_eq!(
            body,
            fallback
                .with_attachments(p.attachments.clone().unwrap())
                .multimodal_body(&r, true, &CancellationToken::new())
                .await
                .unwrap()
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(socket);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert!(line.contains("/input_tokens"));
            let mut bytes = 0;
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some((k, v)) = line.split_once(':') {
                    if k.eq_ignore_ascii_case("content-length") {
                        bytes = v.trim().parse().unwrap();
                    }
                }
            }
            let mut sent = vec![0; bytes];
            reader.read_exact(&mut sent).unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&sent).unwrap(), body);
            write!(reader.get_mut(), "HTTP/1.1 200 OK\r\nContent-Length: 19\r\nConnection: close\r\n\r\n{{\"input_tokens\":73}}").unwrap();
        });
        let mut local = p.clone();
        let mut config = (*local.config).clone();
        config.base_url = format!("http://{addr}");
        local.client = client_builder_for_endpoint(&config.base_url)
            .build()
            .unwrap();
        local.config = Arc::new(config);
        let exact = local
            .count_input_tokens(&r, CancellationToken::new())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(exact.input_tokens, 73);
        assert_eq!(exact.accuracy, TokenCountAccuracy::ExactRequest);
        assert!(before.input_tokens > exact.input_tokens);
        server.join().unwrap();
    }
}

#[tokio::test]
#[ignore = "Paid official DeepSeek experiment; requires explicit key, fixture root and report path"]
async fn live_official_deepseek_image_allowance() {
    let key = std::env::var("XHARNESS_IMAGE_BUDGET_KEY").expect("explicit live credential");
    let root = std::path::PathBuf::from(
        std::env::var_os("XHARNESS_IMAGE_BUDGET_ROOT").expect("fixture root"),
    );
    let output = std::env::var_os("XHARNESS_IMAGE_BUDGET_REPORT").expect("report path");
    let mut rows = Vec::new();
    for protocol in [OpenAiProtocol::ChatCompletions, OpenAiProtocol::Responses] {
        let store = Arc::new(MemoryAttachmentStore::default());
        let mut config =
            OpenAiProviderConfig::new(protocol, "https://api.deepseek.com", &key, "deepseek-flash");
        config.request_timeout = Duration::from_secs(90);
        let p = OpenAiProvider::new(config)
            .unwrap()
            .with_attachments(store.clone());
        let mut text_baseline = None;
        for (name, count) in [
            ("tiny", 0),
            ("tiny", 1),
            ("square", 1),
            ("screenshot", 1),
            ("panorama", 1),
            ("screenshot", 2),
        ] {
            let data = std::fs::read(root.join(format!("{name}.png"))).unwrap();
            let a = store
                .put(
                    "live",
                    Upload {
                        media_type: "image/png".into(),
                        data,
                    },
                )
                .await
                .unwrap();
            let mut r = request();
            r.messages = vec![
                AgentMessage::user("Reply only OK.").with_content_blocks(vec![
                    ContentBlock::Image {
                        attachment: a.clone()
                    };
                    count
                ]),
            ];
            r.max_output_tokens = Some(1024);
            let new = p.estimate_input_tokens(&r).unwrap();
            let (_, _, features) = p.count_features(&r).unwrap();
            let messages = r
                .messages
                .iter()
                .map(serde_json::to_value)
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            let old = features
                .units()
                .saturating_add(xharness_token::image_estimate(&messages).unwrap());
            let mut stream = p.stream(r, CancellationToken::new()).await.unwrap();
            let mut usage: Option<TokenUsage> = None;
            let mut completed = false;
            while let Some(event) = stream.next().await {
                if let ProviderEvent::Completed { usage: u, .. } = event.unwrap() {
                    usage = u;
                    completed = true;
                }
            }
            assert!(completed);
            let u = usage.expect("provider must report complete usage");
            let actual = u
                .input_tokens
                .saturating_add(u.cache_read_tokens)
                .saturating_add(u.cache_write_tokens);
            if count == 0 {
                text_baseline = Some(actual);
            } else {
                assert!(
                    actual > text_baseline.expect("text-only control first"),
                    "image must contribute reported input"
                );
            }
            rows.push(json!({"protocol":format!("{protocol:?}"),"case":name,"images":count,"width":a.width,"height":a.height,"old_estimate":old,"new_estimate":new.input_tokens,"reported_input_including_cache":actual,"usage":u,"bound_covers_usage":actual<=new.input_tokens}));
            std::fs::write(&output, serde_json::to_vec_pretty(&rows).unwrap()).unwrap();
            assert!(
                actual <= new.input_tokens,
                "{protocol:?} {name}: actual {actual} > allowance {}",
                new.input_tokens
            );
        }
    }
    assert_eq!(rows.len(), 12);
}

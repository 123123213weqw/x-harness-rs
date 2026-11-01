use super::*;
use std::sync::Arc;
use xharness_attachments::{AttachmentStore, ContentBlock, MemoryAttachmentStore, Upload};
use xharness_token::TokenCountAccuracy;

#[tokio::test]
async fn image_history_warms_from_completed_http_usage_and_survives_restart_and_overflow() {
    for protocol in [OpenAiProtocol::ChatCompletions, OpenAiProtocol::Responses] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let dir = std::env::temp_dir().join(format!(
            "xh-mixed-history-{}-{}",
            std::process::id(),
            address.port()
        ));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("cache.json");
        let server = tokio::spawn(async move {
            for i in 0..9 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let raw = String::from_utf8(read_http_request(&mut socket).await).unwrap();
                assert!(raw.contains("data:image/png;base64,"));
                let (status, body) = if i == 8 {
                    ("400 Bad Request", json!({"error":{"code":"context_length_exceeded","message":"maximum context length exceeded"}}).to_string())
                } else {
                    let usage = match protocol {
                        OpenAiProtocol::ChatCompletions => {
                            json!({"prompt_tokens":100_000,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":90_000}})
                        }
                        OpenAiProtocol::Responses => {
                            json!({"input_tokens":100_000,"output_tokens":1,"input_tokens_details":{"cached_tokens":90_000}})
                        }
                    };
                    ("200 OK", usage_fixture(protocol, usage))
                };
                socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
        });
        let store = Arc::new(MemoryAttachmentStore::default());
        let image = store
            .put(
                "mixed-history",
                Upload {
                    media_type: "image/png".into(),
                    data: include_bytes!(
                        "../../../xharness-attachments/tests/fixtures/red-blue.png"
                    )
                    .to_vec(),
                },
            )
            .await
            .unwrap();
        let config = OpenAiProviderConfig::new(
            protocol,
            format!("http://{address}/v1"),
            "private-key-marker",
            "fixture",
        );
        let provider = OpenAiProvider::new(config.clone())
            .unwrap()
            .with_attachments(store.clone())
            .with_calibration_store(Arc::new(CalibrationStore::open(path.clone())));
        let mut request = ProviderRequest {
            messages: vec![],
            tools: vec![],
            step: 1,
            reasoning_effort: None,
            max_output_tokens: Some(64),
            debug_scope: Default::default(),
        };
        for i in 0..8 {
            request.messages = vec![
                AgentMessage::user(format!("private-prompt-marker-{i} {}", "x".repeat(400_000))),
                AgentMessage::user("").with_content_blocks(vec![ContentBlock::Image {
                    attachment: image.clone(),
                }]),
            ];
            let mut stream = provider
                .stream(request.clone(), CancellationToken::new())
                .await
                .unwrap();
            while let Some(event) = stream.next().await {
                event.unwrap();
            }
        }
        let before = provider.estimate_input_tokens(&request).unwrap();
        assert_eq!(before.accuracy, TokenCountAccuracy::Estimated);
        assert!(
            before.input_tokens >= 100_000 && before.input_tokens < 150_000,
            "{before:?}"
        );
        drop(provider);
        let restored = OpenAiProvider::new(config)
            .unwrap()
            .with_attachments(store)
            .with_calibration_store(Arc::new(CalibrationStore::open(path.clone())));
        assert_eq!(restored.estimate_input_tokens(&request).unwrap(), before);
        let disk = std::fs::read_to_string(&path).unwrap();
        for secret in [
            "private-key-marker",
            "private-prompt-marker",
            "http://",
            "data:image",
        ] {
            assert!(!disk.contains(secret));
        }
        // The same learned mixed totals must never discount a text-only request.
        let mut text_only = request.clone();
        text_only.messages.pop();
        assert!(
            restored
                .estimate_input_tokens(&text_only)
                .unwrap()
                .input_tokens
                > 390_000
        );
        let error = match restored
            .stream(request.clone(), CancellationToken::new())
            .await
        {
            Err(e) => e,
            Ok(_) => panic!("expected overflow"),
        };
        assert!(error.is_context_overflow());
        assert!(
            restored
                .estimate_input_tokens(&request)
                .unwrap()
                .input_tokens
                > 400_000
        );
        let restarted = CalibrationStore::open(path);
        let disk = std::fs::read_to_string(dir.join("cache.json")).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&disk).unwrap()["mixed_scopes"],
            serde_json::Value::Null
        );
        drop(restarted);
        server.await.unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}

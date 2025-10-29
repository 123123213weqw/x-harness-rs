use futures::StreamExt;
use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_util::sync::CancellationToken;
use xharness_core::{
    AgentMessage, FinishReason, ModelProvider, ProviderEvent, ProviderRequest, ToolDefinition,
};
use xharness_provider_openai::*;

#[test]
fn sse_parser_handles_one_byte_unicode_crlf_and_multiline_data() {
    let source = "id: 7\r\nevent: message\r\ndata: {\"x\":\"汉\"}\r\ndata: second\r\n\r\n";
    let mut parser = SseParser::default();
    let mut events = Vec::new();
    for byte in source.as_bytes() {
        events.extend(parser.feed([*byte], false).unwrap());
    }
    events.extend(parser.feed([], true).unwrap());
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].id, "7");
    assert_eq!(events[0].event, "message");
    assert_eq!(events[0].data, "{\"x\":\"汉\"}\nsecond");
}

#[test]
fn sse_parser_enforces_pending_and_event_byte_limits() {
    let mut pending = SseParser::with_limits(4, 64);
    let error = pending.feed(b"12345", false).unwrap_err();
    assert!(error.message.contains("pending line exceeds 4 bytes"));

    let mut event = SseParser::with_limits(64, 6);
    let error = event.feed(b"data: abc\ndata: def\n", false).unwrap_err();
    assert!(error.message.contains("event exceeds 6 bytes"));
}

#[test]
fn chat_request_and_stream_are_normalized() {
    let request = ProviderRequest {
        messages: vec![AgentMessage::user("hello")],
        tools: vec![ToolDefinition {
            name: "echo".to_owned(),
            description: "echo".to_owned(),
            parameters: json!({"type":"object"}),
        }],
        step: 1,
    };
    let body = build_openai_request(OpenAiProtocol::ChatCompletions, "model", &request);
    assert_eq!(body["tools"][0]["function"]["name"], "echo");
    assert_eq!(body["stream_options"]["include_usage"], true);

    let mut normalizer = OpenAiStreamNormalizer::new(OpenAiProtocol::ChatCompletions);
    let events = normalizer
        .consume(SseEvent {
            data: json!({
                "usage": {
                    "prompt_tokens": 12,
                    "completion_tokens": 3,
                    "prompt_tokens_details": {"cached_tokens": 4},
                    "completion_tokens_details": {"reasoning_tokens": 2}
                },
                "choices":[{"delta":{
                    "reasoning_content":"think",
                    "content":"answer",
                    "tool_calls":[{"index":0,"id":"c1","function":{"name":"echo","arguments":"{}"}}]
                }, "finish_reason":"tool_calls"}]
            })
            .to_string(),
            ..SseEvent::default()
        })
        .unwrap();
    assert!(matches!(&events[0], ProviderEvent::TextDelta(value) if value == "answer"));
    assert!(matches!(&events[1], ProviderEvent::ReasoningDelta(value) if value == "think"));
    assert!(matches!(&events[2], ProviderEvent::ToolCallDelta { id, .. } if id == "c1"));
    let done = normalizer
        .consume(SseEvent {
            data: "[DONE]".to_owned(),
            ..SseEvent::default()
        })
        .unwrap();
    assert!(matches!(
        &done[0],
        ProviderEvent::Completed {
            finish_reason: Some(FinishReason::ToolCalls),
            usage: Some(usage),
            ..
        } if usage.input_tokens == 8
            && usage.output_tokens == 1
            && usage.cache_read_tokens == 4
            && usage.reasoning_tokens == 2
    ));
    normalizer.finish().unwrap();
}

#[test]
fn assembled_system_prompt_is_encoded_first_in_both_wire_protocols() {
    let request = ProviderRequest {
        messages: vec![
            AgentMessage::system("versioned coding policy"),
            AgentMessage::user("inspect"),
        ],
        tools: Vec::new(),
        step: 1,
    };
    let chat = build_openai_request(OpenAiProtocol::ChatCompletions, "model", &request);
    assert_eq!(chat["messages"][0]["role"], "system");
    assert_eq!(chat["messages"][0]["content"], "versioned coding policy");
    assert_eq!(chat["messages"][1]["role"], "user");

    let responses = build_openai_request(OpenAiProtocol::Responses, "model", &request);
    assert_eq!(responses["input"][0]["role"], "system");
    assert_eq!(
        responses["input"][0]["content"][0]["text"],
        "versioned coding policy"
    );
    assert_eq!(responses["input"][1]["role"], "user");
}

#[test]
fn responses_request_replays_opaque_items_and_normalizes_lifecycle() {
    let mut assistant = AgentMessage::assistant("ignored because opaque item exists");
    assistant.provider_items.push(json!({
        "type":"reasoning",
        "id":"reasoning-1",
        "summary":[]
    }));
    let request = ProviderRequest {
        messages: vec![assistant, AgentMessage::tool("call-1", "output")],
        tools: Vec::new(),
        step: 2,
    };
    let body = build_openai_request(OpenAiProtocol::Responses, "model", &request);
    assert_eq!(body["store"], false);
    assert_eq!(body["input"][0]["id"], "reasoning-1");
    assert_eq!(body["input"][1]["type"], "function_call_output");

    let mut normalizer = OpenAiStreamNormalizer::new(OpenAiProtocol::Responses);
    let added = normalizer
        .consume(SseEvent {
            data: json!({
                "type":"response.output_item.added",
                "output_index":0,
                "item":{"type":"function_call","call_id":"call-1","name":"echo","arguments":""}
            })
            .to_string(),
            ..SseEvent::default()
        })
        .unwrap();
    assert!(matches!(&added[0], ProviderEvent::ToolCallDelta { id, .. } if id == "call-1"));
    let delta = normalizer
        .consume(SseEvent {
            data: json!({
                "type":"response.function_call_arguments.delta",
                "output_index":0,
                "delta":"{}"
            })
            .to_string(),
            ..SseEvent::default()
        })
        .unwrap();
    assert!(
        matches!(&delta[0], ProviderEvent::ToolCallDelta { arguments_delta, .. } if arguments_delta == "{}")
    );
    normalizer
        .consume(SseEvent {
            data: json!({
                "type":"response.output_item.done",
                "output_index":0,
                "item":{"type":"function_call","call_id":"call-1","name":"echo","arguments":"{}"}
            })
            .to_string(),
            ..SseEvent::default()
        })
        .unwrap();
    let complete = normalizer
        .consume(SseEvent {
            data: json!({
                "type":"response.completed",
                "response":{"usage":{
                    "input_tokens":10,
                    "output_tokens":2,
                    "input_tokens_details":{"cached_tokens":3},
                    "output_tokens_details":{"reasoning_tokens":1}
                },"output":[]}
            })
            .to_string(),
            ..SseEvent::default()
        })
        .unwrap();
    assert!(matches!(
        &complete[0],
        ProviderEvent::Completed {
            finish_reason: Some(FinishReason::ToolCalls),
            usage: Some(usage),
            provider_items,
        }
            if usage.input_tokens == 7
                && usage.output_tokens == 1
                && usage.cache_read_tokens == 3
                && usage.reasoning_tokens == 1
                && provider_items.len() == 1
    ));
    normalizer.finish().unwrap();
}

#[test]
fn chat_length_and_content_filter_finish_reasons_are_typed() {
    for (wire, expected) in [
        ("length", FinishReason::Length),
        ("content_filter", FinishReason::ContentFilter),
    ] {
        let mut normalizer = OpenAiStreamNormalizer::new(OpenAiProtocol::ChatCompletions);
        normalizer
            .consume(SseEvent {
                data: json!({
                    "choices":[{"delta":{"content":"partial"},"finish_reason":wire}]
                })
                .to_string(),
                ..SseEvent::default()
            })
            .unwrap();
        let done = normalizer
            .consume(SseEvent {
                data: "[DONE]".to_owned(),
                ..SseEvent::default()
            })
            .unwrap();
        assert!(matches!(
            &done[0],
            ProviderEvent::Completed {
                finish_reason: Some(reason),
                ..
            } if reason == &expected
        ));
    }
}

#[test]
fn responses_incomplete_max_output_tokens_is_a_typed_terminal_event() {
    let mut normalizer = OpenAiStreamNormalizer::new(OpenAiProtocol::Responses);
    let terminal = normalizer
        .consume(SseEvent {
            data: json!({
                "type":"response.incomplete",
                "response":{
                    "status":"incomplete",
                    "incomplete_details":{"reason":"max_output_tokens"},
                    "usage":{"input_tokens":5,"output_tokens":9},
                    "output":[]
                }
            })
            .to_string(),
            ..SseEvent::default()
        })
        .unwrap();
    assert!(matches!(
        &terminal[0],
        ProviderEvent::Completed {
            finish_reason: Some(FinishReason::Length),
            usage: Some(usage),
            ..
        } if usage.input_tokens == 5 && usage.output_tokens == 9
    ));
    normalizer.finish().unwrap();
}

#[tokio::test]
async fn native_http_provider_streams_both_protocols() {
    for protocol in [OpenAiProtocol::ChatCompletions, OpenAiProtocol::Responses] {
        let (base_url, server) = spawn_server(protocol).await;
        let provider = OpenAiProvider::new(OpenAiProviderConfig::new(
            protocol,
            base_url,
            "secret",
            "test-model",
        ))
        .unwrap();
        let request = ProviderRequest {
            messages: vec![AgentMessage::user("hello")],
            tools: Vec::new(),
            step: 1,
        };
        let mut stream = provider
            .stream(request, CancellationToken::new())
            .await
            .unwrap();
        let mut events = Vec::new();
        while let Some(event) = stream.next().await {
            events.push(event.unwrap());
        }
        assert!(events
            .iter()
            .any(|event| matches!(event, ProviderEvent::TextDelta(value) if value == "hello")));
        assert!(matches!(
            events.last(),
            Some(ProviderEvent::Completed { .. })
        ));
        server.await.unwrap();
    }
}

#[tokio::test]
async fn provider_bounds_http_error_bodies() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0u8; 1024];
        while !request.windows(4).any(|window| window == b"\r\n\r\n") {
            let count = socket.read(&mut buffer).await.unwrap();
            if count == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..count]);
        }
        let body = "0123456789abcdefSHOULD_NOT_APPEAR";
        let response = format!(
            "HTTP/1.1 400 Bad Request\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    });

    let mut config = OpenAiProviderConfig::new(
        OpenAiProtocol::Responses,
        format!("http://{address}/v1"),
        "secret",
        "test-model",
    );
    config.max_error_body_bytes = 16;
    let provider = OpenAiProvider::new(config).unwrap();
    let request = ProviderRequest {
        messages: vec![AgentMessage::user("hello")],
        tools: Vec::new(),
        step: 1,
    };
    let error = match provider.stream(request, CancellationToken::new()).await {
        Ok(_) => panic!("HTTP error unexpectedly produced a stream"),
        Err(error) => error,
    };
    assert!(error.message.contains("0123456789abcdef [truncated]"));
    assert!(!error.message.contains("SHOULD_NOT_APPEAR"));
    server.await.unwrap();
}

#[test]
fn provider_rejects_zero_stream_budgets() {
    let mut config = OpenAiProviderConfig::new(
        OpenAiProtocol::Responses,
        "http://127.0.0.1:1/v1",
        "secret",
        "test-model",
    );
    config.max_sse_event_bytes = 0;
    assert!(OpenAiProvider::new(config).is_err());
}

async fn spawn_server(protocol: OpenAiProtocol) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let count = socket.read(&mut buffer).await.unwrap();
            if count == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..count]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        let request_text = String::from_utf8_lossy(&request);
        match protocol {
            OpenAiProtocol::ChatCompletions => {
                assert!(request_text.starts_with("POST /v1/chat/completions"))
            }
            OpenAiProtocol::Responses => assert!(request_text.starts_with("POST /v1/responses")),
        }
        assert!(request_text.contains("authorization: Bearer secret"));

        let sse = match protocol {
            OpenAiProtocol::ChatCompletions => concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n",
                "data: [DONE]\n\n"
            ),
            OpenAiProtocol::Responses => concat!(
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"output\":[],\"usage\":{}}}\n\n"
            ),
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            sse.len(),
            sse
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    });
    (format!("http://{address}/v1"), task)
}

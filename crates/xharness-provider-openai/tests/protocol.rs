use futures::StreamExt;
use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_util::sync::CancellationToken;
use xharness_core::{
    AgentMessage, CapabilitySource, ContextPolicy, ContextRequest, FinishReason, ModelProvider,
    ProviderEvent, ProviderRequest, Role, ToolCall, ToolDefinition, ToolResultPruningContextPolicy,
};
use xharness_debug::{DebugRecorder, DebugScope, MemoryDebugSink};
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
        reasoning_effort: None,
        max_output_tokens: None,
        debug_scope: Default::default(),
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

#[tokio::test]
async fn projected_completed_writes_keep_chat_and_responses_call_topology() {
    let arguments = json!({
        "path": "artifact.txt",
        "content": "x".repeat(8 * 1_024),
    })
    .to_string();
    let call = ToolCall {
        id: "execution-write".to_owned(),
        provider_call_id: Some("provider-write".to_owned()),
        index: 0,
        name: "write".to_owned(),
        arguments_json: arguments.clone(),
    };
    let source = vec![
        AgentMessage::user("write it"),
        AgentMessage {
            role: Role::Assistant,
            reasoning: "completed reasoning".to_owned(),
            tool_calls: vec![call],
            provider_items: vec![
                json!({"type":"reasoning","id":"reasoning-1","summary":[]}),
                json!({
                    "type":"function_call",
                    "call_id":"provider-write",
                    "name":"write",
                    "arguments":arguments,
                }),
            ],
            ..AgentMessage::default()
        },
        AgentMessage::tool(
            "provider-write",
            json!({"ok":true,"content":"completed","error":"","truncated":false}).to_string(),
        ),
        AgentMessage::assistant("done"),
        AgentMessage::user("continue"),
    ];
    let surface = ToolResultPruningContextPolicy::default()
        .prepare(ContextRequest::new(source))
        .await
        .unwrap();
    surface.validate().unwrap();

    let request = ProviderRequest {
        messages: surface.messages,
        tools: Vec::new(),
        step: 1,
        reasoning_effort: None,
        max_output_tokens: None,
        debug_scope: Default::default(),
    };
    let chat = build_openai_request(OpenAiProtocol::ChatCompletions, "model", &request);
    let chat_call = &chat["messages"][1]["tool_calls"][0];
    assert_eq!(chat_call["id"], "provider-write");
    assert!(chat_call["function"]["arguments"]
        .as_str()
        .unwrap()
        .contains("tool_arguments_pruned/v1"));
    assert!(chat["messages"][1].get("reasoning_content").is_none());
    assert_eq!(chat["messages"][2]["tool_call_id"], "provider-write");

    let responses = build_openai_request(OpenAiProtocol::Responses, "model", &request);
    let function_call = responses["input"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["type"] == "function_call")
        .unwrap();
    assert_eq!(function_call["call_id"], "provider-write");
    assert!(function_call["arguments"]
        .as_str()
        .unwrap()
        .contains("tool_arguments_pruned/v1"));
    let output = responses["input"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["type"] == "function_call_output")
        .unwrap();
    assert_eq!(output["call_id"], "provider-write");
    assert!(responses["input"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["type"] == "reasoning"));
}

#[test]
fn protocol_replay_uses_provider_call_id_not_internal_execution_id() {
    let call = ToolCall {
        id: "execution-1".to_owned(),
        provider_call_id: Some("provider-call-1".to_owned()),
        index: 0,
        name: "echo".to_owned(),
        arguments_json: "{}".to_owned(),
    };
    let mut assistant = AgentMessage::assistant("");
    assistant.tool_calls.push(call);
    let request = ProviderRequest {
        messages: vec![assistant, AgentMessage::tool("provider-call-1", "output")],
        tools: Vec::new(),
        step: 2,
        reasoning_effort: None,
        max_output_tokens: None,
        debug_scope: Default::default(),
    };

    let chat = build_openai_request(OpenAiProtocol::ChatCompletions, "model", &request);
    assert_eq!(
        chat["messages"][0]["tool_calls"][0]["id"],
        "provider-call-1"
    );
    assert_eq!(chat["messages"][1]["tool_call_id"], "provider-call-1");
    assert_ne!(chat["messages"][0]["tool_calls"][0]["id"], "execution-1");

    let responses = build_openai_request(OpenAiProtocol::Responses, "model", &request);
    assert_eq!(responses["input"][1]["call_id"], "provider-call-1");
    assert_eq!(responses["input"][2]["call_id"], "provider-call-1");
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
        reasoning_effort: None,
        max_output_tokens: Some(4_096),
        debug_scope: Default::default(),
    };
    let chat = build_openai_request(OpenAiProtocol::ChatCompletions, "model", &request);
    assert_eq!(chat["messages"][0]["role"], "system");
    assert_eq!(chat["messages"][0]["content"], "versioned coding policy");
    assert_eq!(chat["messages"][1]["role"], "user");
    assert_eq!(chat["max_tokens"], 4_096);

    let responses = build_openai_request(OpenAiProtocol::Responses, "model", &request);
    assert_eq!(responses["input"][0]["role"], "system");
    assert_eq!(
        responses["input"][0]["content"][0]["text"],
        "versioned coding policy"
    );
    assert_eq!(responses["input"][1]["role"], "user");
    assert_eq!(responses["max_output_tokens"], 4_096);
}

#[test]
fn token_count_body_reuses_the_wire_encoder_without_output_controls() {
    let request = ProviderRequest {
        messages: vec![
            AgentMessage::system("policy"),
            AgentMessage::user("inspect"),
        ],
        tools: vec![ToolDefinition {
            name: "read".to_owned(),
            description: "read a file".to_owned(),
            parameters: json!({"type":"object"}),
        }],
        step: 1,
        reasoning_effort: None,
        max_output_tokens: Some(4_096),
        debug_scope: Default::default(),
    };
    for protocol in [OpenAiProtocol::ChatCompletions, OpenAiProtocol::Responses] {
        let generation = build_openai_request(protocol, "model", &request);
        let count = build_openai_token_count_request(protocol, "model", &request);
        assert_eq!(count["model"], "model");
        assert_eq!(count["tools"], generation["tools"]);
        assert!(count.get("stream").is_none());
        assert!(count.get("stream_options").is_none());
        assert!(count.get("max_tokens").is_none());
        assert!(count.get("max_output_tokens").is_none());
        assert!(count.get("store").is_none());
    }
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
        reasoning_effort: None,
        max_output_tokens: None,
        debug_scope: Default::default(),
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
        let sink = std::sync::Arc::new(MemoryDebugSink::default());
        let provider = OpenAiProvider::new(OpenAiProviderConfig::new(
            protocol,
            base_url,
            "secret",
            "test-model",
        ))
        .unwrap()
        .with_debug(DebugRecorder::new(sink.clone()));
        let request = ProviderRequest {
            messages: vec![AgentMessage::user("hello")],
            tools: Vec::new(),
            step: 1,
            reasoning_effort: None,
            max_output_tokens: None,
            debug_scope: DebugScope::default()
                .with_session("provider-session")
                .with_run("provider-run"),
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
        let trace = sink.events().await;
        for expected in ["request", "response_status", "sse.chunk", "stream.event"] {
            assert!(trace.iter().any(|event| event.event == expected));
        }
        assert!(trace.iter().all(|event| {
            event.scope.session_id.as_deref() == Some("provider-session")
                && event.scope.run_id.as_deref() == Some("provider-run")
        }));
    }
}

#[tokio::test]
async fn active_stream_can_outlive_the_response_header_deadline() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_http_request(&mut socket).await;
        let request = String::from_utf8_lossy(&request);
        assert!(request.contains("accept-encoding: identity"));
        assert!(request.contains("cache-control: no-cache"));

        let first = "data: {\"choices\":[{\"delta\":{\"content\":\"still \"}}]}\n\n";
        let last = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"alive\"}}]}\n\n",
            "data: [DONE]\n\n"
        );
        let head = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            first.len() + last.len(),
        );
        socket.write_all(head.as_bytes()).await.unwrap();
        socket.write_all(first.as_bytes()).await.unwrap();
        socket.flush().await.unwrap();
        // This exceeds request_timeout below. It must not terminate an active
        // body stream because request_timeout only protects response headers.
        tokio::time::sleep(std::time::Duration::from_millis(750)).await;
        socket.write_all(last.as_bytes()).await.unwrap();
    });

    let mut config = OpenAiProviderConfig::new(
        OpenAiProtocol::ChatCompletions,
        format!("http://{address}/v1"),
        "secret",
        "test-model",
    );
    config.request_timeout = std::time::Duration::from_millis(500);
    config.stream_idle_timeout = std::time::Duration::from_secs(2);
    let provider = OpenAiProvider::new(config).unwrap();
    let mut stream = provider
        .stream(
            ProviderRequest {
                messages: vec![AgentMessage::user("hello")],
                tools: Vec::new(),
                step: 1,
                reasoning_effort: None,
                max_output_tokens: None,
                debug_scope: Default::default(),
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let mut text = String::new();
    let mut completed = false;
    while let Some(event) = stream.next().await {
        match event.unwrap() {
            ProviderEvent::TextDelta(delta) => text.push_str(&delta),
            ProviderEvent::Completed { .. } => completed = true,
            _ => {}
        }
    }
    assert_eq!(text, "still alive");
    assert!(completed);
    server.await.unwrap();
}

#[tokio::test]
async fn truncated_stream_reports_transport_diagnostics_after_partial_output() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let _ = read_http_request(&mut socket).await;
        let partial = "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n";
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            partial.len() + 128,
            partial,
        );
        socket.write_all(response.as_bytes()).await.unwrap();
        socket.shutdown().await.unwrap();
    });

    let sink = std::sync::Arc::new(MemoryDebugSink::default());
    let provider = OpenAiProvider::new(OpenAiProviderConfig::new(
        OpenAiProtocol::ChatCompletions,
        format!("http://{address}/v1"),
        "secret",
        "test-model",
    ))
    .unwrap()
    .with_debug(DebugRecorder::new(sink.clone()));
    let mut stream = provider
        .stream(
            ProviderRequest {
                messages: vec![AgentMessage::user("hello")],
                tools: Vec::new(),
                step: 1,
                reasoning_effort: None,
                max_output_tokens: None,
                debug_scope: Default::default(),
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let first = stream.next().await.unwrap().unwrap();
    assert!(matches!(first, ProviderEvent::TextDelta(ref value) if value == "partial"));
    let error = stream.next().await.unwrap().unwrap_err();
    assert!(error.retryable);
    assert!(error.message.contains("OpenAI stream interrupted"));
    assert!(error.message.contains("response_body"));
    assert!(error.message.contains("received 1 chunks"));

    let trace = sink.events().await;
    let diagnostic = trace
        .iter()
        .find(|event| event.event == "stream.transport_error")
        .expect("transport diagnostic event");
    assert_eq!(diagnostic.payload["kind"], "response_body");
    assert_eq!(diagnostic.payload["receivedChunks"], 1);
    assert!(diagnostic.payload["sourceChain"]
        .as_str()
        .is_some_and(|source| !source.is_empty()));
    server.await.unwrap();
}

#[tokio::test]
async fn provider_uses_protocol_native_input_token_count_endpoints() {
    for protocol in [OpenAiProtocol::ChatCompletions, OpenAiProtocol::Responses] {
        let (base_url, server) = spawn_count_server(protocol, 70_857).await;
        let provider = OpenAiProvider::new(OpenAiProviderConfig::new(
            protocol,
            base_url,
            "secret",
            "test-model",
        ))
        .unwrap();
        let request = ProviderRequest {
            messages: vec![AgentMessage::system("policy"), AgentMessage::user("hello")],
            tools: vec![ToolDefinition {
                name: "read".to_owned(),
                description: "read".to_owned(),
                parameters: json!({"type":"object"}),
            }],
            step: 1,
            reasoning_effort: None,
            max_output_tokens: Some(8_192),
            debug_scope: Default::default(),
        };
        let count = provider
            .count_input_tokens(&request, CancellationToken::new())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(count.input_tokens, 70_857);
        assert_eq!(
            count.accuracy,
            xharness_core::TokenCountAccuracy::ExactRequest
        );
        match protocol {
            OpenAiProtocol::ChatCompletions => {
                assert_eq!(count.counter, "openai-compatible/chat-input-tokens/v1")
            }
            OpenAiProtocol::Responses => {
                assert_eq!(count.counter, "openai/responses-input-tokens/v1")
            }
        }
        server.await.unwrap();
    }
}

#[tokio::test]
async fn unsupported_token_count_endpoint_is_cached_as_a_capability_miss() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let _ = read_http_request(&mut socket).await;
        socket
            .write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
            .await
            .unwrap();
    });
    let provider = OpenAiProvider::new(OpenAiProviderConfig::new(
        OpenAiProtocol::ChatCompletions,
        format!("http://{address}/v1"),
        "secret",
        "test-model",
    ))
    .unwrap();
    let request = ProviderRequest {
        messages: vec![AgentMessage::user("hello")],
        tools: Vec::new(),
        step: 1,
        reasoning_effort: None,
        max_output_tokens: None,
        debug_scope: Default::default(),
    };
    assert!(provider
        .count_input_tokens(&request, CancellationToken::new())
        .await
        .unwrap()
        .is_none());
    server.await.unwrap();
    assert!(provider
        .count_input_tokens(&request, CancellationToken::new())
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn provider_preserves_an_explicit_context_fallback_as_non_reported_metadata() {
    let provider = OpenAiProvider::new(
        OpenAiProviderConfig::new(
            OpenAiProtocol::ChatCompletions,
            "http://127.0.0.1:1/v1",
            "secret",
            "test-model",
        )
        .with_context_window_fallback(Some(53_248)),
    )
    .unwrap();

    let capabilities = provider
        .capabilities(CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        capabilities.context_window.effective_hard_max(),
        Some(53_248)
    );
    assert_eq!(
        capabilities
            .context_window
            .fallback_limit
            .as_ref()
            .unwrap()
            .source,
        CapabilitySource::DeploymentDeclaredFallback
    );
}

#[tokio::test]
async fn provider_discovers_and_caches_the_exact_deployment_context_window() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_http_request(&mut socket).await;
        assert!(String::from_utf8_lossy(&request).starts_with("GET /props"));
        let body = json!({
            "model": {"max_context": 1_048_576},
            "provider": {"max_context": 524_288},
            "default_generation_settings": {"n_ctx": 131_072}
        })
        .to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\netag: deployment-r7\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    });
    let provider = OpenAiProvider::new(
        OpenAiProviderConfig::new(
            OpenAiProtocol::ChatCompletions,
            format!("http://{address}/v1"),
            "secret",
            "test-model",
        )
        .with_context_window_fallback(Some(32_768))
        .with_capability_probe(
            OpenAiCapabilityProbe::new(
                format!("http://{address}/props"),
                "/default_generation_settings/n_ctx",
            )
            .with_model_ceiling_json_pointer("/model/max_context")
            .with_provider_limit_json_pointer("/provider/max_context"),
        ),
    )
    .unwrap();

    let first = provider
        .capabilities(CancellationToken::new())
        .await
        .unwrap();
    let second = provider
        .capabilities(CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(first, second);
    assert_eq!(first.context_window.effective_hard_max(), Some(131_072));
    assert_eq!(
        first.context_window.model_ceiling.as_ref().unwrap().tokens,
        1_048_576
    );
    assert_eq!(
        first.context_window.provider_limit.as_ref().unwrap().tokens,
        524_288
    );
    assert_eq!(
        first
            .context_window
            .deployment_limit
            .as_ref()
            .unwrap()
            .source,
        CapabilitySource::DeploymentReported
    );
    assert_eq!(
        first
            .context_window
            .deployment_limit
            .as_ref()
            .unwrap()
            .revision
            .as_deref(),
        Some("deployment-r7")
    );
    let evidence = first.context_window.deployment_limit.as_ref().unwrap();
    assert!(evidence.observed_at_ms.is_some());
    assert!(evidence.expires_at_ms > evidence.observed_at_ms);
    server.await.unwrap();
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
        reasoning_effort: None,
        max_output_tokens: None,
        debug_scope: Default::default(),
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

    let mut config = OpenAiProviderConfig::new(
        OpenAiProtocol::Responses,
        "http://127.0.0.1:1/v1",
        "secret",
        "test-model",
    );
    config.stream_idle_timeout = std::time::Duration::ZERO;
    assert!(OpenAiProvider::new(config).is_err());
}

#[test]
fn provider_rejects_invalid_optional_capability_pointers() {
    let config = OpenAiProviderConfig::new(
        OpenAiProtocol::Responses,
        "http://127.0.0.1:1/v1",
        "secret",
        "test-model",
    )
    .with_capability_probe(
        OpenAiCapabilityProbe::new("http://127.0.0.1:1/props", "/deployment/n_ctx")
            .with_model_ceiling_json_pointer("model/max_context"),
    );
    let error = match OpenAiProvider::new(config) {
        Ok(_) => panic!("invalid optional capability pointer was accepted"),
        Err(error) => error,
    };
    assert!(error.message.contains("model ceiling JSON pointer"));
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

async fn spawn_count_server(
    protocol: OpenAiProtocol,
    input_tokens: u64,
) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = read_http_request(&mut socket).await;
        let split = request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .unwrap();
        let head = String::from_utf8_lossy(&request[..split]);
        match protocol {
            OpenAiProtocol::ChatCompletions => {
                assert!(head.starts_with("POST /v1/chat/completions/input_tokens"))
            }
            OpenAiProtocol::Responses => {
                assert!(head.starts_with("POST /v1/responses/input_tokens"))
            }
        }
        let body: serde_json::Value = serde_json::from_slice(&request[split + 4..]).unwrap();
        assert_eq!(body["model"], "test-model");
        assert!(body.get("stream").is_none());
        assert!(body.get("max_tokens").is_none());
        assert!(body.get("max_output_tokens").is_none());
        assert!(body["tools"].is_array());
        let response_body = json!({
            "object": "response.input_tokens",
            "input_tokens": input_tokens,
        })
        .to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            response_body.len(),
            response_body,
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    });
    (format!("http://{address}/v1"), task)
}

async fn read_http_request(socket: &mut tokio::net::TcpStream) -> Vec<u8> {
    let mut request = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        let count = socket.read(&mut buffer).await.unwrap();
        if count == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..count]);
        let Some(split) = request.windows(4).position(|window| window == b"\r\n\r\n") else {
            continue;
        };
        let head = String::from_utf8_lossy(&request[..split]);
        let content_length = head
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        if request.len() >= split + 4 + content_length {
            break;
        }
    }
    request
}

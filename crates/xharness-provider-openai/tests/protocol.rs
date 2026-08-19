use futures::StreamExt;
use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_util::sync::CancellationToken;
use xharness_core::{AgentMessage, ModelProvider, ProviderEvent, ProviderRequest, ToolDefinition};
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
                "choices":[{"delta":{
                    "reasoning_content":"think",
                    "content":"answer",
                    "tool_calls":[{"index":0,"id":"c1","function":{"name":"echo","arguments":"{}"}}]
                }}]
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
    assert!(matches!(done[0], ProviderEvent::Completed { .. }));
    normalizer.finish().unwrap();
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
                "response":{"usage":{"output_tokens":2},"output":[]}
            })
            .to_string(),
            ..SseEvent::default()
        })
        .unwrap();
    assert!(matches!(
        &complete[0],
        ProviderEvent::Completed { usage: Some(usage), provider_items }
            if usage["output_tokens"] == 2 && provider_items.len() == 1
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

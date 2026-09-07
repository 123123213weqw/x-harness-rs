//! Deterministic network faults: real HTTP + OpenAiProvider + production LoopEngine.
//! No external model, credentials, OS network changes or user sessions are involved.
use futures::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;
use xharness_core::{
    AgentMessage, LoopEngine, LoopEvent, LoopEventKind, LoopRequest, LoopResult, LoopStatus,
    ModelProvider, ProviderEvent, ProviderRequest,
};
use xharness_provider_openai::{OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig};

#[derive(Clone)]
enum Reply {
    Status(u16),
    RetryAfter(&'static str),
    Disconnect,
    Body { text: String, truncated: bool },
    Stall { headers: bool, prefix: String },
}
struct FaultServer {
    url: String,
    attempts: Arc<AtomicUsize>,
    requests: Arc<Mutex<Vec<Value>>>,
    closed: Arc<AtomicUsize>,
    task: JoinHandle<()>,
}
impl Drop for FaultServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn read_request(socket: &mut TcpStream) -> Option<Value> {
    let mut bytes = Vec::new();
    let mut part = [0u8; 4096];
    loop {
        let n = socket.read(&mut part).await.ok()?;
        if n == 0 || bytes.len() > 1024 * 1024 {
            return None;
        }
        bytes.extend_from_slice(&part[..n]);
        if let Some(at) = bytes.windows(4).position(|p| p == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&bytes[..at]).to_ascii_lowercase();
            let length = head
                .lines()
                .find_map(|l| {
                    l.strip_prefix("content-length:")
                        .and_then(|n| n.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            if bytes.len() >= at + 4 + length {
                return serde_json::from_slice(&bytes[at + 4..at + 4 + length]).ok();
            }
        }
    }
}
impl FaultServer {
    async fn start(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let attempts = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let closed = Arc::new(AtomicUsize::new(0));
        let count = attempts.clone();
        let captured = requests.clone();
        let disconnected = closed.clone();
        let task = tokio::spawn(async move {
            let mut replies = VecDeque::from(replies);
            let mut handlers = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (mut socket, _) = accepted.unwrap();
                        let reply = replies.pop_front().unwrap_or(Reply::Status(418));
                        let count = count.clone(); let captured = captured.clone(); let disconnected = disconnected.clone();
                        handlers.spawn(async move {
                            let Some(request) = read_request(&mut socket).await else { return; };
                            captured.lock().unwrap().push(request);
                            count.fetch_add(1, Ordering::SeqCst);
                            let response = match &reply {
                                Reply::Disconnect => return,
                                Reply::RetryAfter(value) => format!("HTTP/1.1 429 Test\r\nRetry-After: {value}\r\nx-request-id: fixture-request\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"),
                                Reply::Status(code) => format!("HTTP/1.1 {code} Test\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"),
                                Reply::Body { text, truncated } => format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}", text.len() + if *truncated { 256 } else { 0 }),
                                Reply::Stall { headers: true, prefix } => format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 100000\r\nConnection: close\r\n\r\n{prefix}"),
                                Reply::Stall { headers: false, .. } => String::new(),
                            };
                            if socket.write_all(response.as_bytes()).await.is_err() { return; }
                            if matches!(reply, Reply::Stall { .. }) {
                                let mut byte = [0u8; 1];
                                if tokio::time::timeout(Duration::from_secs(5), socket.read(&mut byte)).await.is_ok() {
                                    disconnected.fetch_add(1, Ordering::SeqCst);
                                }
                            }
                        });
                    }
                    Some(joined) = handlers.join_next(), if !handlers.is_empty() => { joined.unwrap(); }
                }
            }
        });
        Self {
            url,
            attempts,
            requests,
            closed,
            task,
        }
    }
    fn count(&self) -> usize {
        self.attempts.load(Ordering::SeqCst)
    }
    fn provider(&self, protocol: OpenAiProtocol, idle: Duration) -> Arc<OpenAiProvider> {
        let mut config = OpenAiProviderConfig::new(protocol, &self.url, "fixture-only", "fixture");
        config.connect_timeout = Duration::from_secs(1);
        config.request_timeout = idle;
        config.stream_idle_timeout = idle;
        Arc::new(OpenAiProvider::new(config).unwrap())
    }
}
fn frame(value: Value) -> String {
    format!("data: {value}\n\n")
}
fn text_delta() -> String {
    frame(json!({"choices":[{"delta":{"content":"partial"}}]}))
}
fn success() -> Reply {
    Reply::Body {
        text: frame(json!({"choices":[{"delta":{"content":"recovered"},"finish_reason":"stop"}]}))
            + "data: [DONE]\n\n",
        truncated: false,
    }
}
fn request() -> ProviderRequest {
    ProviderRequest {
        messages: vec![AgentMessage::user("fixture")],
        tools: vec![],
        step: 1,
        reasoning_effort: None,
        max_output_tokens: None,
        debug_scope: Default::default(),
    }
}
async fn run(server: &FaultServer, retries: usize, idle: Duration) -> (Vec<LoopEvent>, LoopResult) {
    let mut request = LoopRequest::new(
        server.provider(OpenAiProtocol::ChatCompletions, idle),
        vec![AgentMessage::user("fixture")],
    );
    request.config.provider_retries = retries;
    request.config.provider_retry_base_delay_ms = 10;
    request.config.provider_retry_max_delay_ms = 100;
    tokio::time::timeout(Duration::from_secs(8), async {
        let mut run = LoopEngine.start(request);
        let mut events = Vec::new();
        while let Some(event) = run.next().await {
            events.push(event);
        }
        (events, run.result().await)
    })
    .await
    .expect("network fixture must not hang")
}
fn retry_count(events: &[LoopEvent]) -> usize {
    events
        .iter()
        .filter(|e| matches!(e.kind, LoopEventKind::ModelRetry { .. }))
        .count()
}
async fn until(check: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while !check() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn http_status_retry_matrix_is_bounded() {
    for status in [400, 401, 403, 404, 422, 408, 429, 500, 502, 503, 504] {
        let expected = if status == 408 || status == 429 || status >= 500 {
            3
        } else {
            1
        };
        let server = FaultServer::start(vec![Reply::Status(status); 4]).await;
        let (events, result) = run(&server, 2, Duration::from_secs(1)).await;
        assert_eq!(result.status, LoopStatus::Failed, "HTTP {status}");
        assert_eq!(server.count(), expected, "HTTP {status}");
        assert_eq!(retry_count(&events), expected - 1, "HTTP {status}");
    }
}

#[tokio::test]
async fn reconnect_before_output_recovers_without_duplicate_text_or_changed_input() {
    let server = FaultServer::start(vec![Reply::Disconnect, Reply::Status(503), success()]).await;
    let (events, result) = run(&server, 2, Duration::from_secs(1)).await;
    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(result.final_text, "recovered");
    assert_eq!(server.count(), 3);
    assert_eq!(retry_count(&events), 2);
    let requests = server.requests.lock().unwrap();
    assert!(requests.windows(2).all(|pair| pair[0] == pair[1]));
}

#[tokio::test]
async fn configured_retry_limit_counts_retries_not_initial_attempt() {
    for retries in [0, 1, 4] {
        let server = FaultServer::start(vec![Reply::Status(503); retries + 2]).await;
        let (events, result) = run(&server, retries, Duration::from_secs(1)).await;
        assert_eq!(result.status, LoopStatus::Failed);
        assert_eq!(server.count(), retries + 1);
        assert_eq!(retry_count(&events), retries);
    }
}

#[tokio::test]
async fn any_model_delta_prevents_replay_even_for_complete_tool_json() {
    let deltas = [
        json!({"content":"partial"}),
        json!({"reasoning_content":"thinking"}),
        json!({"tool_calls":[{"index":0,"id":"call","function":{"name":"write","arguments":"{\"path\":"}}]}),
        json!({"tool_calls":[{"index":0,"id":"call","function":{"name":"write","arguments":"{\"path\":\"x\"}"}}]}),
    ];
    for delta in deltas {
        let server = FaultServer::start(vec![
            Reply::Body {
                text: frame(json!({"choices":[{"delta":delta}]})),
                truncated: true,
            },
            success(),
        ])
        .await;
        let (events, result) = run(&server, 2, Duration::from_secs(1)).await;
        assert_eq!(result.status, LoopStatus::Failed);
        assert_eq!(server.count(), 1);
        assert_eq!(retry_count(&events), 0);
    }
}

#[tokio::test]
async fn clean_http_eof_without_protocol_completion_retries_only_before_delta() {
    for prefix in [String::new(), ": keepalive\n\n".into(), text_delta()] {
        let had_delta = prefix.contains("partial");
        let server = FaultServer::start(vec![
            Reply::Body {
                text: prefix,
                truncated: false,
            },
            success(),
        ])
        .await;
        let (events, result) = run(&server, 2, Duration::from_secs(1)).await;
        assert_eq!(
            result.status,
            if had_delta {
                LoopStatus::Failed
            } else {
                LoopStatus::Completed
            }
        );
        assert_eq!(server.count(), if had_delta { 1 } else { 2 });
        assert_eq!(retry_count(&events), usize::from(!had_delta));
    }
}

#[tokio::test]
async fn completed_protocol_is_terminal_even_if_http_body_is_cut_after_it() {
    for protocol in [OpenAiProtocol::ChatCompletions, OpenAiProtocol::Responses] {
        let text = match protocol {
            OpenAiProtocol::ChatCompletions => "data: [DONE]\n\n".to_owned(),
            OpenAiProtocol::Responses => frame(
                json!({"type":"response.completed","response":{"status":"completed","output":[]}}),
            ),
        };
        let server = FaultServer::start(vec![Reply::Body {
            text,
            truncated: true,
        }])
        .await;
        let mut stream = server
            .provider(protocol, Duration::from_secs(1))
            .stream(request(), CancellationToken::new())
            .await
            .unwrap();
        assert!(matches!(
            stream.next().await.unwrap().unwrap(),
            ProviderEvent::Completed { .. }
        ));
        assert!(
            stream.next().await.is_none(),
            "transport failure must not appear after protocol completion"
        );
        assert_eq!(server.count(), 1);
    }
}

#[tokio::test]
async fn idle_and_header_timeouts_retry_before_output_but_not_after() {
    for (headers, prefix) in [
        (false, String::new()),
        (true, String::new()),
        (true, text_delta()),
    ] {
        let had_delta = !prefix.is_empty();
        let server = FaultServer::start(vec![Reply::Stall { headers, prefix }; 4]).await;
        let (events, result) = run(&server, 2, Duration::from_millis(150)).await;
        assert_eq!(result.status, LoopStatus::Failed);
        assert_eq!(server.count(), if had_delta { 1 } else { 3 });
        assert_eq!(retry_count(&events), if had_delta { 0 } else { 2 });
    }
}

#[tokio::test]
async fn cancel_and_consumer_drop_close_stalled_connections_without_retries() {
    for (headers, drop_consumer, after_delta) in [
        (false, false, false),
        (true, false, false),
        (true, true, false),
        (true, false, true),
        (true, true, true),
    ] {
        let server = FaultServer::start(vec![
            Reply::Stall {
                headers,
                prefix: if after_delta {
                    text_delta()
                } else {
                    String::new()
                }
            };
            4
        ])
        .await;
        let request = LoopRequest::new(
            server.provider(OpenAiProtocol::ChatCompletions, Duration::from_secs(5)),
            vec![AgentMessage::user("fixture")],
        );
        let mut run = LoopEngine.start(request);
        until(|| server.count() == 1).await;
        if after_delta {
            tokio::time::timeout(Duration::from_secs(2), async {
                while let Some(event) = run.next().await {
                    if matches!(event.kind, LoopEventKind::TextDelta(_)) {
                        return;
                    }
                }
                panic!("expected partial output before cancellation");
            })
            .await
            .unwrap();
        }
        if drop_consumer {
            drop(run);
        } else {
            run.cancel();
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(2), run.result())
                    .await
                    .unwrap()
                    .status,
                LoopStatus::Cancelled
            );
        }
        until(|| server.closed.load(Ordering::SeqCst) == 1).await;
        assert_eq!(server.count(), 1);
    }
}

#[tokio::test]
async fn http_retry_after_and_request_id_reach_core_and_actual_wait() {
    let server = FaultServer::start(vec![Reply::RetryAfter("1"), success()]).await;
    let provider = server.provider(OpenAiProtocol::ChatCompletions, Duration::from_secs(2));
    let error = match provider.stream(request(), CancellationToken::new()).await {
        Err(error) => error,
        Ok(_) => panic!("expected HTTP 429"),
    };
    assert_eq!(error.retry_after_ms, Some(1000));
    assert_eq!(error.request_id.as_deref(), Some("fixture-request"));
    assert_eq!(error.diagnostics.unwrap().kind, "http_status");
    let server = FaultServer::start(vec![Reply::RetryAfter("1"), success()]).await;
    let began = tokio::time::Instant::now();
    let (events, result) = run(&server, 2, Duration::from_secs(2)).await;
    assert_eq!(result.status, LoopStatus::Completed);
    assert!(began.elapsed() >= Duration::from_secs(1));
    let scheduled = events
        .iter()
        .position(|e| matches!(e.kind, LoopEventKind::ModelRetry { delay_ms: 1000, .. }))
        .unwrap();
    let started = events
        .iter()
        .position(|e| matches!(e.kind, LoopEventKind::ModelRetryStarted { .. }))
        .unwrap();
    assert!(started > scheduled);
}

#[tokio::test]
async fn recovery_deadline_bounds_stalled_retry_headers_and_body() {
    for headers in [false, true] {
        let server = FaultServer::start(vec![
            Reply::Status(503),
            Reply::Stall {
                headers,
                prefix: String::new(),
            },
        ])
        .await;
        let mut req = LoopRequest::new(
            server.provider(OpenAiProtocol::ChatCompletions, Duration::from_secs(5)),
            vec![AgentMessage::user("go")],
        );
        req.config.provider_retry_base_delay_ms = 10;
        req.config.provider_retry_jitter_percent = 0;
        req.config.provider_retry_budget_ms = 150;
        let mut run = LoopEngine.start(req);
        let result = tokio::time::timeout(Duration::from_secs(2), async {
            while run.next().await.is_some() {}
            run.result().await
        })
        .await
        .unwrap();
        assert_eq!(result.status, LoopStatus::Failed);
        assert!(result.error.unwrap().contains("recovery deadline"));
        assert_eq!(server.count(), 2);
        until(|| server.closed.load(Ordering::SeqCst) >= 1).await;
    }
}

#[tokio::test]
async fn partial_transport_failure_has_metadata_without_enabling_trace() {
    let server = FaultServer::start(vec![Reply::Body {
        text: text_delta(),
        truncated: true,
    }])
    .await;
    let (events, result) = run(&server, 2, Duration::from_secs(1)).await;
    assert_eq!(retry_count(&events), 0);
    assert_eq!(result.final_text, "partial");
    let error = result.error.unwrap();
    assert!(error.contains("receivedChunks") && error.contains("lastChunkAgoMs"));
    assert!(error.contains("protocolCompleted\":false"));
    assert!(!error.contains("fixture-only"));
}

#[tokio::test]
async fn recovered_stream_is_not_cut_off_by_the_pre_output_recovery_deadline() {
    let server = FaultServer::start(vec![
        Reply::Status(503),
        Reply::Stall {
            headers: true,
            prefix: text_delta(),
        },
    ])
    .await;
    let mut req = LoopRequest::new(
        server.provider(OpenAiProtocol::ChatCompletions, Duration::from_millis(500)),
        vec![AgentMessage::user("go")],
    );
    req.config.provider_retry_base_delay_ms = 10;
    req.config.provider_retry_budget_ms = 200;
    let mut run = LoopEngine.start(req);
    let result = tokio::time::timeout(Duration::from_secs(3), async {
        while run.next().await.is_some() {}
        run.result().await
    })
    .await
    .unwrap();
    assert_eq!(result.final_text, "partial");
    let error = result.error.unwrap();
    assert!(error.contains("idle_timeout"));
    assert!(!error.contains("recovery deadline"));
    assert_eq!(server.count(), 2);
}

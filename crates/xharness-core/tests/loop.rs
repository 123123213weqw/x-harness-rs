use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use async_trait::async_trait;
use futures::{stream, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Notify};
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;
use xharness_core::*;

type Script = Vec<Result<ProviderEvent, ProviderError>>;

#[derive(Clone)]
struct ScriptProvider {
    scripts: Arc<Mutex<VecDeque<Result<Script, ProviderError>>>>,
    attempts: Arc<AtomicUsize>,
}

impl ScriptProvider {
    fn new(scripts: impl IntoIterator<Item = Script>) -> Self {
        Self {
            scripts: Arc::new(Mutex::new(
                scripts.into_iter().map(Ok).collect::<VecDeque<_>>(),
            )),
            attempts: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn with_attempts(scripts: impl IntoIterator<Item = Result<Script, ProviderError>>) -> Self {
        Self {
            scripts: Arc::new(Mutex::new(scripts.into_iter().collect())),
            attempts: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn attempts(&self) -> usize {
        self.attempts.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl ModelProvider for ScriptProvider {
    async fn stream(
        &self,
        _request: ProviderRequest,
        _cancellation: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        let script = self
            .scripts
            .lock()
            .unwrap()
            .pop_front()
            .expect("fake provider script exhausted")?;
        Ok(Box::pin(stream::iter(script)))
    }
}

#[derive(Clone)]
struct GatedProvider {
    requests: Arc<Mutex<Vec<ProviderRequest>>>,
    attempts: Arc<AtomicUsize>,
    release_first: Arc<Notify>,
}

impl GatedProvider {
    fn new() -> Self {
        Self {
            requests: Arc::new(Mutex::new(Vec::new())),
            attempts: Arc::new(AtomicUsize::new(0)),
            release_first: Arc::new(Notify::new()),
        }
    }

    fn requests(&self) -> Vec<ProviderRequest> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait]
impl ModelProvider for GatedProvider {
    async fn stream(
        &self,
        request: ProviderRequest,
        cancellation: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        self.requests.lock().unwrap().push(request);
        let attempt = self.attempts.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel(8);
        let release = self.release_first.clone();
        tokio::spawn(async move {
            if attempt == 0 {
                let _ = tx
                    .send(Ok(ProviderEvent::TextDelta("partial".to_owned())))
                    .await;
                tokio::select! {
                    _ = cancellation.cancelled() => {},
                    _ = release.notified() => {
                        let _ = tx.send(Ok(ProviderEvent::TextDelta(" tail".to_owned()))).await;
                        let _ = tx.send(Ok(completed())).await;
                    }
                }
            } else {
                let _ = tx
                    .send(Ok(ProviderEvent::TextDelta("final".to_owned())))
                    .await;
                let _ = tx.send(Ok(completed())).await;
            }
        });
        Ok(Box::pin(ReceiverStream::new(rx)))
    }
}

fn completed() -> ProviderEvent {
    ProviderEvent::Completed {
        usage: Some(json!({"output_tokens": 1})),
        provider_items: Vec::new(),
    }
}

fn tool_delta(index: usize, id: &str, name: &str, arguments: &str) -> ProviderEvent {
    ProviderEvent::ToolCallDelta {
        index,
        id: id.to_owned(),
        name: name.to_owned(),
        arguments_delta: arguments.to_owned(),
    }
}

async fn collect(mut run: LoopRun) -> (Vec<LoopEvent>, LoopResult) {
    let mut events = Vec::new();
    while let Some(event) = run.next().await {
        events.push(event);
    }
    let result = run.result().await;
    (events, result)
}

#[tokio::test]
async fn streams_reasoning_and_text_separately() {
    let provider = Arc::new(ScriptProvider::new([vec![
        Ok(ProviderEvent::ReasoningDelta("想".to_owned())),
        Ok(ProviderEvent::TextDelta("答".to_owned())),
        Ok(ProviderEvent::TextDelta("案".to_owned())),
        Ok(completed()),
    ]]));
    let request = LoopRequest::new(provider, vec![AgentMessage::user("问题")]);
    let (events, result) = collect(LoopEngine.start(request)).await;

    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(result.final_text, "答案");
    assert_eq!(result.messages[1].reasoning, "想");
    assert!(matches!(
        events[0].kind,
        LoopEventKind::ReasoningDelta(ref value) if value == "想"
    ));
    assert_eq!(events.last().unwrap().seq, events.len() as u64);
}

#[tokio::test]
async fn aggregates_fragmented_tool_calls_and_returns_errors_to_model() {
    let provider = Arc::new(ScriptProvider::new([
        vec![
            Ok(tool_delta(0, "bad", "echo", "[1")),
            Ok(tool_delta(0, "", "", ",2]")),
            Ok(tool_delta(1, "missing", "no_such_tool", "{}")),
            Ok(completed()),
        ],
        vec![
            Ok(ProviderEvent::TextDelta("recovered".to_owned())),
            Ok(completed()),
        ],
    ]));
    let tool = ToolSpec::new("echo", "echo", json!({"type":"object"}), |_, _| async {
        ToolResult::success("should not run")
    });
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.tools.push(tool);
    let (_, result) = collect(LoopEngine.start(request)).await;

    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(result.messages[1].tool_calls[0].arguments_json, "[1,2]");
    let first: Value = serde_json::from_str(&result.messages[2].content).unwrap();
    let second: Value = serde_json::from_str(&result.messages[3].content).unwrap();
    assert_eq!(first["ok"], false);
    assert!(first["error"].as_str().unwrap().contains("JSON object"));
    assert!(second["error"].as_str().unwrap().contains("unknown tool"));
}

#[tokio::test]
async fn retries_only_before_the_first_delta() {
    let provider = Arc::new(ScriptProvider::with_attempts([
        Err(ProviderError::retryable("temporary 1")),
        Ok(vec![Err(ProviderError::retryable("temporary 2"))]),
        Ok(vec![
            Ok(ProviderEvent::TextDelta("ok".to_owned())),
            Ok(completed()),
        ]),
    ]));
    let request = LoopRequest::new(provider.clone(), vec![AgentMessage::user("run")]);
    let (events, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(provider.attempts(), 3);
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.kind, LoopEventKind::ModelRetry { .. }))
            .count(),
        2
    );

    let provider = Arc::new(ScriptProvider::new([vec![
        Ok(ProviderEvent::TextDelta("partial".to_owned())),
        Err(ProviderError::retryable("broken stream")),
    ]]));
    let request = LoopRequest::new(provider.clone(), vec![AgentMessage::user("run")]);
    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Failed);
    assert_eq!(provider.attempts(), 1);
}

#[tokio::test]
async fn parallel_completion_is_live_but_history_order_is_stable() {
    let provider = Arc::new(ScriptProvider::new([
        vec![
            Ok(tool_delta(0, "slow", "sleep", r#"{"ms":40}"#)),
            Ok(tool_delta(1, "fast", "sleep", r#"{"ms":1}"#)),
            Ok(completed()),
        ],
        vec![
            Ok(ProviderEvent::TextDelta("done".to_owned())),
            Ok(completed()),
        ],
    ]));
    let tool = ToolSpec::new(
        "sleep",
        "sleep",
        json!({"type":"object"}),
        |args, _| async move {
            let ms = args["ms"].as_u64().unwrap();
            tokio::time::sleep(Duration::from_millis(ms)).await;
            ToolResult::success(ms.to_string())
        },
    );
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.tools.push(tool);
    let (events, result) = collect(LoopEngine.start(request)).await;

    let completion_ids = events
        .iter()
        .filter_map(|event| match &event.kind {
            LoopEventKind::ToolCompleted { call, .. } => Some(call.id.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(completion_ids, ["fast", "slow"]);
    assert_eq!(result.messages[2].tool_call_id.as_deref(), Some("slow"));
    assert_eq!(result.messages[3].tool_call_id.as_deref(), Some("fast"));
}

#[tokio::test]
async fn keyed_tools_serialize_per_key_and_respect_global_cap() {
    let provider = Arc::new(ScriptProvider::new([
        vec![
            Ok(tool_delta(0, "a1", "keyed", r#"{"key":"a","ms":30}"#)),
            Ok(tool_delta(1, "a2", "keyed", r#"{"key":"a","ms":1}"#)),
            Ok(tool_delta(2, "b1", "keyed", r#"{"key":"b","ms":5}"#)),
            Ok(completed()),
        ],
        vec![
            Ok(ProviderEvent::TextDelta("done".to_owned())),
            Ok(completed()),
        ],
    ]));
    let active = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let tool = ToolSpec::new("keyed", "keyed", json!({"type":"object"}), {
        let active = active.clone();
        let maximum = maximum.clone();
        move |args, _| {
            let active = active.clone();
            let maximum = maximum.clone();
            async move {
                let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                maximum.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(args["ms"].as_u64().unwrap())).await;
                active.fetch_sub(1, Ordering::SeqCst);
                ToolResult::success(args["key"].as_str().unwrap())
            }
        }
    })
    .keyed(|args| args["key"].as_str().map(str::to_owned));
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.tools.push(tool);
    request.config.max_tool_concurrency = 2;
    let (events, result) = collect(LoopEngine.start(request)).await;

    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(maximum.load(Ordering::SeqCst), 2);
    let completion_ids = events
        .iter()
        .filter_map(|event| match &event.kind {
            LoopEventKind::ToolCompleted { call, .. } => Some(call.id.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(completion_ids, ["b1", "a1", "a2"]);
}

#[tokio::test]
async fn reaches_step_limit_without_fabricating_an_answer() {
    let mut scripts = Vec::new();
    for step in 0..3 {
        scripts.push(vec![
            Ok(tool_delta(0, &format!("call-{step}"), "echo", "{}")),
            Ok(completed()),
        ]);
    }
    let provider = Arc::new(ScriptProvider::new(scripts));
    let tool = ToolSpec::new("echo", "echo", json!({}), |_, _| async {
        ToolResult::success("ok")
    });
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("loop")]);
    request.tools.push(tool);
    request.config.max_steps = 3;
    let (events, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::LimitReached);
    assert!(matches!(
        events.last().unwrap().kind,
        LoopEventKind::LimitReached
    ));
}

#[test]
fn tool_result_cap_is_utf8_safe_and_valid_json() {
    let result = ToolResult::success("汉字".repeat(1_000));
    let (encoded, truncated) = tool_result_for_model(&result, 256);
    assert!(truncated);
    assert!(encoded.len() <= 256);
    let value: Value = serde_json::from_str(&encoded).unwrap();
    assert_eq!(value["truncated"], true);
}

#[tokio::test]
async fn cancellation_stops_a_running_tool() {
    let provider = Arc::new(ScriptProvider::new([vec![
        Ok(tool_delta(0, "wait", "wait", "{}")),
        Ok(completed()),
    ]]));
    let tool = ToolSpec::new("wait", "wait", json!({}), |_, token| async move {
        token.cancelled().await;
        ToolResult::failure("cancelled")
    });
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.tools.push(tool);
    let mut run = LoopEngine.start(request);
    while let Some(event) = run.next().await {
        if matches!(event.kind, LoopEventKind::ToolStarted(_)) {
            run.cancel();
        }
    }
    assert_eq!(run.result().await.status, LoopStatus::Cancelled);
}

#[tokio::test]
async fn timeout_and_handler_panic_become_tool_results() {
    let provider = Arc::new(ScriptProvider::new([
        vec![
            Ok(tool_delta(0, "timeout", "slow", "{}")),
            Ok(tool_delta(1, "panic", "panic", "{}")),
            Ok(completed()),
        ],
        vec![
            Ok(ProviderEvent::TextDelta("recovered".to_owned())),
            Ok(completed()),
        ],
    ]));
    let slow = ToolSpec::new("slow", "slow", json!({}), |_, _| async {
        tokio::time::sleep(Duration::from_secs(1)).await;
        ToolResult::success("late")
    })
    .timeout(Duration::from_millis(2));
    let panic = ToolSpec::new("panic", "panic", json!({}), |_, _| async { panic!("boom") });
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.tools = vec![slow, panic];
    let (_, result) = collect(LoopEngine.start(request)).await;

    assert_eq!(result.status, LoopStatus::Completed);
    assert!(result.messages[2].content.contains("timed out"));
    assert!(result.messages[3].content.contains("panicked"));
}

#[tokio::test]
async fn exclusive_tool_is_a_barrier() {
    let provider = Arc::new(ScriptProvider::new([
        vec![
            Ok(tool_delta(0, "p1", "parallel", r#"{"ms":20}"#)),
            Ok(tool_delta(1, "p2", "parallel", r#"{"ms":20}"#)),
            Ok(tool_delta(2, "x", "exclusive", "{}")),
            Ok(tool_delta(3, "p3", "parallel", r#"{"ms":1}"#)),
            Ok(completed()),
        ],
        vec![
            Ok(ProviderEvent::TextDelta("done".to_owned())),
            Ok(completed()),
        ],
    ]));
    let parallel = ToolSpec::new("parallel", "parallel", json!({}), |args, _| async move {
        tokio::time::sleep(Duration::from_millis(args["ms"].as_u64().unwrap())).await;
        ToolResult::success("parallel")
    });
    let exclusive = ToolSpec::new("exclusive", "exclusive", json!({}), |_, _| async {
        tokio::time::sleep(Duration::from_millis(2)).await;
        ToolResult::success("exclusive")
    })
    .exclusive();
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.tools = vec![parallel, exclusive];
    let (events, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed);

    let transitions = events
        .iter()
        .filter_map(|event| match &event.kind {
            LoopEventKind::ToolStarted(call) => Some(format!("start:{}", call.id)),
            LoopEventKind::ToolCompleted { call, .. } => Some(format!("done:{}", call.id)),
            _ => None,
        })
        .collect::<Vec<_>>();
    let start_x = transitions
        .iter()
        .position(|item| item == "start:x")
        .unwrap();
    let done_p1 = transitions
        .iter()
        .position(|item| item == "done:p1")
        .unwrap();
    let done_p2 = transitions
        .iter()
        .position(|item| item == "done:p2")
        .unwrap();
    let done_x = transitions
        .iter()
        .position(|item| item == "done:x")
        .unwrap();
    let start_p3 = transitions
        .iter()
        .position(|item| item == "start:p3")
        .unwrap();
    assert!(done_p1 < start_x && done_p2 < start_x);
    assert!(done_x < start_p3);
}

#[tokio::test]
async fn interrupted_tool_batch_is_closed_without_replay() {
    let store = Arc::new(MemorySessionStore::default());
    let mut assistant = AgentMessage::assistant("");
    assistant.tool_calls.push(ToolCall {
        id: "side-effect".to_owned(),
        index: 0,
        name: "dangerous".to_owned(),
        arguments_json: "{}".to_owned(),
    });
    store
        .save(
            "session",
            SessionSnapshot {
                session_id: "session".to_owned(),
                messages: vec![AgentMessage::user("old"), assistant],
                phase: "tool_batch_started".to_owned(),
                step: 1,
                tool_batch_complete: false,
            },
        )
        .await
        .unwrap();

    let provider = Arc::new(ScriptProvider::new([vec![
        Ok(ProviderEvent::TextDelta("safe".to_owned())),
        Ok(completed()),
    ]]));
    let executions = Arc::new(AtomicUsize::new(0));
    let tool = ToolSpec::new("dangerous", "dangerous", json!({}), {
        let executions = executions.clone();
        move |_, _| {
            executions.fetch_add(1, Ordering::SeqCst);
            async { ToolResult::success("ran") }
        }
    });
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("continue")]);
    request.tools.push(tool);
    request.session_id = Some("session".to_owned());
    request.session_store = store;
    let (_, result) = collect(LoopEngine.start(request)).await;

    assert_eq!(executions.load(Ordering::SeqCst), 0);
    assert_eq!(
        result.messages[2].tool_call_id.as_deref(),
        Some("side-effect")
    );
    assert!(result.messages[2].content.contains("was not replayed"));
    assert_eq!(result.messages[3].content, "continue");
}

#[tokio::test]
async fn dropping_the_event_consumer_cancels_and_checkpoints() {
    let store = Arc::new(MemorySessionStore::default());
    let provider = Arc::new(ScriptProvider::new([vec![
        Ok(tool_delta(0, "wait", "wait", "{}")),
        Ok(completed()),
    ]]));
    let tool = ToolSpec::new("wait", "wait", json!({}), |_, token| async move {
        token.cancelled().await;
        ToolResult::failure("cancelled")
    });
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.tools.push(tool);
    request.session_id = Some("drop-test".to_owned());
    request.session_store = store.clone();
    let mut run = LoopEngine.start(request);
    while let Some(event) = run.next().await {
        if matches!(event.kind, LoopEventKind::ToolStarted(_)) {
            break;
        }
    }
    drop(run);
    tokio::time::sleep(Duration::from_millis(20)).await;

    let snapshot = store.load("drop-test").await.unwrap().unwrap();
    assert_eq!(snapshot.phase, "consumer_stopped");
    assert!(!snapshot.tool_batch_complete);
}

#[tokio::test]
async fn next_step_injection_waits_for_the_current_model_round() {
    let provider = Arc::new(GatedProvider::new());
    let request = LoopRequest::new(provider.clone(), vec![AgentMessage::user("original")]);
    let mut run = LoopEngine.start(request);

    while let Some(event) = run.next().await {
        if matches!(event.kind, LoopEventKind::TextDelta(ref text) if text == "partial") {
            break;
        }
    }
    run.send(LoopCommand::InjectMessage {
        message: AgentMessage::user("additional constraint"),
        mode: InjectionMode::NextStep,
    })
    .await
    .unwrap();
    provider.release_first.notify_one();

    while run.next().await.is_some() {}
    let result = run.result().await;
    let requests = provider.requests();
    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].messages.len(), 1);
    assert_eq!(requests[1].messages[2].content, "additional constraint");
    assert_eq!(result.messages[1].content, "partial tail");
    assert_eq!(result.messages[2].content, "additional constraint");
}

#[tokio::test]
async fn steering_interrupts_model_and_preserves_partial_assistant_turn() {
    let provider = Arc::new(GatedProvider::new());
    let request = LoopRequest::new(provider.clone(), vec![AgentMessage::user("original")]);
    let mut run = LoopEngine.start(request);

    while let Some(event) = run.next().await {
        if matches!(event.kind, LoopEventKind::TextDelta(ref text) if text == "partial") {
            break;
        }
    }
    run.send(LoopCommand::Steer(AgentMessage::user("change direction")))
        .await
        .unwrap();

    let mut saw_interrupted_event = false;
    while let Some(event) = run.next().await {
        saw_interrupted_event |= matches!(event.kind, LoopEventKind::ModelInterrupted);
    }
    let result = run.result().await;
    let requests = provider.requests();
    assert!(saw_interrupted_event);
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].messages[1].content, "partial");
    assert!(requests[1].messages[1].interrupted);
    assert_eq!(requests[1].messages[2].content, "change direction");
    assert_eq!(result.final_text, "final");
}

#[tokio::test]
async fn pause_stops_model_event_progress_until_resume() {
    let provider = Arc::new(GatedProvider::new());
    let request = LoopRequest::new(provider.clone(), vec![AgentMessage::user("run")]);
    let mut run = LoopEngine.start(request);

    while let Some(event) = run.next().await {
        if matches!(event.kind, LoopEventKind::TextDelta(ref text) if text == "partial") {
            break;
        }
    }
    run.send(LoopCommand::Pause).await.unwrap();
    while let Some(event) = run.next().await {
        if matches!(event.kind, LoopEventKind::RunPaused) {
            break;
        }
    }
    provider.release_first.notify_one();
    assert!(tokio::time::timeout(Duration::from_millis(25), run.next())
        .await
        .is_err());

    run.send(LoopCommand::Resume).await.unwrap();
    let mut saw_resumed = false;
    let mut saw_tail = false;
    while let Some(event) = run.next().await {
        saw_resumed |= matches!(event.kind, LoopEventKind::RunResumed);
        saw_tail |= matches!(event.kind, LoopEventKind::TextDelta(ref text) if text == " tail");
    }
    assert!(saw_resumed && saw_tail);
    assert_eq!(run.result().await.status, LoopStatus::Completed);
}

#[tokio::test]
async fn approval_blocks_tool_start_until_host_approves() {
    let provider = Arc::new(ScriptProvider::new([
        vec![Ok(tool_delta(0, "", "guarded", "{}")), Ok(completed())],
        vec![
            Ok(ProviderEvent::TextDelta("done".to_owned())),
            Ok(completed()),
        ],
    ]));
    let executions = Arc::new(AtomicUsize::new(0));
    let tool = ToolSpec::new("guarded", "guarded", json!({}), {
        let executions = executions.clone();
        move |_, _| {
            executions.fetch_add(1, Ordering::SeqCst);
            async { ToolResult::success("allowed") }
        }
    })
    .requires_approval();
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.tools.push(tool);
    let mut run = LoopEngine.start(request);

    let call_id = loop {
        let event = run.next().await.unwrap();
        if let LoopEventKind::ToolApprovalRequested { call } = event.kind {
            break call.id;
        }
    };
    assert!(!call_id.is_empty());
    assert_eq!(executions.load(Ordering::SeqCst), 0);
    run.send(LoopCommand::ApproveTool {
        call_id: call_id.clone(),
    })
    .await
    .unwrap();

    let mut saw_started = false;
    while let Some(event) = run.next().await {
        saw_started |=
            matches!(event.kind, LoopEventKind::ToolStarted(ref call) if call.id == call_id);
    }
    assert!(saw_started);
    assert_eq!(executions.load(Ordering::SeqCst), 1);
    assert_eq!(run.result().await.status, LoopStatus::Completed);
}

#[tokio::test]
async fn rejected_tool_never_runs_and_failure_is_written_back() {
    let provider = Arc::new(ScriptProvider::new([
        vec![Ok(tool_delta(0, "deny", "guarded", "{}")), Ok(completed())],
        vec![
            Ok(ProviderEvent::TextDelta("handled".to_owned())),
            Ok(completed()),
        ],
    ]));
    let executions = Arc::new(AtomicUsize::new(0));
    let tool = ToolSpec::new("guarded", "guarded", json!({}), {
        let executions = executions.clone();
        move |_, _| {
            executions.fetch_add(1, Ordering::SeqCst);
            async { ToolResult::success("unexpected") }
        }
    })
    .requires_approval();
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.tools.push(tool);
    let mut run = LoopEngine.start(request);

    while let Some(event) = run.next().await {
        if matches!(event.kind, LoopEventKind::ToolApprovalRequested { .. }) {
            break;
        }
    }
    run.send(LoopCommand::RejectTool {
        call_id: "deny".to_owned(),
        reason: "unsafe arguments".to_owned(),
    })
    .await
    .unwrap();

    let mut saw_started = false;
    while let Some(event) = run.next().await {
        saw_started |= matches!(event.kind, LoopEventKind::ToolStarted(_));
    }
    let result = run.result().await;
    assert!(!saw_started);
    assert_eq!(executions.load(Ordering::SeqCst), 0);
    assert!(result.messages[2].content.contains("tool rejected"));
    assert!(result.messages[2].content.contains("unsafe arguments"));
}

#[tokio::test]
async fn steering_during_tools_is_deferred_until_the_batch_finishes() {
    let provider = Arc::new(ScriptProvider::new([
        vec![Ok(tool_delta(0, "wait", "wait", "{}")), Ok(completed())],
        vec![
            Ok(ProviderEvent::TextDelta("done".to_owned())),
            Ok(completed()),
        ],
    ]));
    let release = Arc::new(Notify::new());
    let tool = ToolSpec::new("wait", "wait", json!({}), {
        let release = release.clone();
        move |_, _| {
            let release = release.clone();
            async move {
                release.notified().await;
                ToolResult::success("tool finished")
            }
        }
    });
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.tools.push(tool);
    let mut run = LoopEngine.start(request);

    while let Some(event) = run.next().await {
        if matches!(event.kind, LoopEventKind::ToolStarted(_)) {
            break;
        }
    }
    run.send(LoopCommand::Steer(AgentMessage::user("new instruction")))
        .await
        .unwrap();
    release.notify_one();

    while run.next().await.is_some() {}
    let result = run.result().await;
    assert_eq!(result.messages[2].role, Role::Tool);
    assert_eq!(result.messages[3].content, "new instruction");
    assert_eq!(result.messages[4].content, "done");
}

#[tokio::test]
async fn commands_are_rejected_after_run_completion() {
    let provider = Arc::new(ScriptProvider::new([vec![Ok(completed())]]));
    let request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    let mut run = LoopEngine.start(request);
    while run.next().await.is_some() {}
    assert_eq!(run.result().await.status, LoopStatus::Completed);
    assert_eq!(
        run.send(LoopCommand::Pause).await,
        Err(LoopControlError::Closed)
    );
}

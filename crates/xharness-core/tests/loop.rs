use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
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
use xharness_prompt::{PromptAssembler, PromptSection};
use xharness_session::{
    AppendReceipt, ApprovalOutcome, AssistantChunk, CommandResultKind, CommandSource,
    EventData as SessionEventData, GoalChange, GoalChangeKind, GoalPhase, GoalSnapshot,
    GoalSnapshotChange, GoalSnapshotOperation, InboxMessage, InboxTarget,
    MemorySessionStore as EventMemorySessionStore, Revision, Session, SessionEvent, SessionHeader,
    SessionInspection, SessionTitleSource, Store as EventStore, StoreError, ToolOutcome,
    TurnEndReason,
};
use xharness_tools::{
    ToolConcurrency as RuntimeToolConcurrency, ToolDefinition as RuntimeToolDefinition,
    ToolExecutor as RuntimeToolExecutor, ToolOutput as RuntimeToolOutput,
    ToolRegistry as RuntimeToolRegistry, ToolSpec as RuntimeToolSpec,
};

type Script = Vec<Result<ProviderEvent, ProviderError>>;

#[derive(Clone)]
struct ScriptProvider {
    scripts: Arc<Mutex<VecDeque<Result<Script, ProviderError>>>>,
    attempts: Arc<AtomicUsize>,
    requests: Arc<Mutex<Vec<ProviderRequest>>>,
}

impl ScriptProvider {
    fn new(scripts: impl IntoIterator<Item = Script>) -> Self {
        Self {
            scripts: Arc::new(Mutex::new(
                scripts.into_iter().map(Ok).collect::<VecDeque<_>>(),
            )),
            attempts: Arc::new(AtomicUsize::new(0)),
            requests: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn with_attempts(scripts: impl IntoIterator<Item = Result<Script, ProviderError>>) -> Self {
        Self {
            scripts: Arc::new(Mutex::new(scripts.into_iter().collect())),
            attempts: Arc::new(AtomicUsize::new(0)),
            requests: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn attempts(&self) -> usize {
        self.attempts.load(Ordering::SeqCst)
    }

    fn requests(&self) -> Vec<ProviderRequest> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait]
impl ModelProvider for ScriptProvider {
    async fn stream(
        &self,
        request: ProviderRequest,
        _cancellation: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        self.requests.lock().unwrap().push(request);
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

#[derive(Clone, Default)]
struct RecordingCompactionPolicy {
    requests: Arc<Mutex<Vec<ContextRequest>>>,
}

impl RecordingCompactionPolicy {
    fn requests(&self) -> Vec<ContextRequest> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait]
impl ContextPolicy for RecordingCompactionPolicy {
    async fn prepare(&self, request: ContextRequest) -> Result<ContextSurface, ContextError> {
        self.requests.lock().unwrap().push(request.clone());
        Ok(ContextSurface::transformed(
            ContextPolicyId::new("test-compaction", 1),
            request.messages.len(),
            vec![AgentMessage::user("compacted surface")],
            vec![SurfaceEdit::new(
                0,
                request.messages.len(),
                1,
                SurfaceEditKind::HistoryCompacted,
            )],
        ))
    }
}

struct DroppingSystemPolicy;

#[async_trait]
impl ContextPolicy for DroppingSystemPolicy {
    async fn prepare(&self, request: ContextRequest) -> Result<ContextSurface, ContextError> {
        Ok(ContextSurface::transformed(
            ContextPolicyId::new("drops-system", 1),
            request.messages.len(),
            vec![AgentMessage::user("history only")],
            vec![SurfaceEdit::new(
                0,
                request.messages.len(),
                1,
                SurfaceEditKind::HistoryCompacted,
            )],
        ))
    }
}

#[derive(Debug)]
struct FixedTokenMeter {
    total: u64,
}

#[derive(Clone)]
struct ExactCountingProvider {
    inner: ScriptProvider,
    input_tokens: u64,
    count_attempts: Arc<AtomicUsize>,
}

impl ExactCountingProvider {
    fn new(input_tokens: u64, scripts: impl IntoIterator<Item = Script>) -> Self {
        Self {
            inner: ScriptProvider::new(scripts),
            input_tokens,
            count_attempts: Arc::new(AtomicUsize::new(0)),
        }
    }
}

#[async_trait]
impl ModelProvider for ExactCountingProvider {
    async fn count_input_tokens(
        &self,
        _request: &ProviderRequest,
        _cancellation: CancellationToken,
    ) -> Result<Option<ProviderInputTokenCount>, ProviderError> {
        self.count_attempts.fetch_add(1, Ordering::SeqCst);
        Ok(Some(ProviderInputTokenCount::exact_request(
            "test-provider/input-tokens/v1",
            self.input_tokens,
        )))
    }

    async fn stream(
        &self,
        request: ProviderRequest,
        cancellation: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        self.inner.stream(request, cancellation).await
    }
}

impl TokenMeter for FixedTokenMeter {
    fn id(&self) -> &str {
        "test-fixed/v1"
    }

    fn estimate(&self, _request: &TokenEstimateRequest) -> Result<TokenBreakdown, TokenMeterError> {
        Ok(TokenBreakdown {
            protocol_tokens: self.total,
            total_input_tokens: self.total,
            ..TokenBreakdown::default()
        })
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

#[derive(Clone, Default)]
struct FailAssistantJournal {
    inner: EventMemorySessionStore,
}

#[async_trait]
impl EventStore for FailAssistantJournal {
    async fn list_headers(&self) -> Result<Vec<SessionHeader>, StoreError> {
        self.inner.list_headers().await
    }

    async fn create(&self, header: SessionHeader) -> Result<Session, StoreError> {
        self.inner.create(header).await
    }

    async fn load(&self, session_id: &str) -> Result<Option<Session>, StoreError> {
        self.inner.load(session_id).await
    }

    async fn append(
        &self,
        session_id: &str,
        expected_revision: Revision,
        events: Vec<SessionEvent>,
    ) -> Result<AppendReceipt, StoreError> {
        if events
            .iter()
            .any(|event| matches!(event.data(), SessionEventData::AssistantMessage { .. }))
        {
            return Err(StoreError::Backend {
                message: "injected assistant journal failure".to_owned(),
            });
        }
        self.inner
            .append(session_id, expected_revision, events)
            .await
    }

    async fn flush(&self, session_id: &str) -> Result<Revision, StoreError> {
        self.inner.flush(session_id).await
    }

    async fn inspect(&self, session_id: &str) -> Result<Option<SessionInspection>, StoreError> {
        self.inner.inspect(session_id).await
    }
}

#[derive(Clone, Default)]
struct BlockingChunkJournal {
    inner: EventMemorySessionStore,
    chunk_append_started: Arc<Notify>,
    release_chunk_append: Arc<Notify>,
    blocked_once: Arc<AtomicBool>,
    append_batches: Arc<Mutex<Vec<Vec<SessionEvent>>>>,
}

impl BlockingChunkJournal {
    fn chunk_batches(&self) -> Vec<Vec<SessionEvent>> {
        self.append_batches
            .lock()
            .unwrap()
            .iter()
            .filter(|events| {
                events
                    .iter()
                    .any(|event| matches!(event.data(), SessionEventData::AssistantChunk { .. }))
            })
            .cloned()
            .collect()
    }
}

#[async_trait]
impl EventStore for BlockingChunkJournal {
    async fn list_headers(&self) -> Result<Vec<SessionHeader>, StoreError> {
        self.inner.list_headers().await
    }

    async fn create(&self, header: SessionHeader) -> Result<Session, StoreError> {
        self.inner.create(header).await
    }

    async fn load(&self, session_id: &str) -> Result<Option<Session>, StoreError> {
        self.inner.load(session_id).await
    }

    async fn append(
        &self,
        session_id: &str,
        expected_revision: Revision,
        events: Vec<SessionEvent>,
    ) -> Result<AppendReceipt, StoreError> {
        let contains_chunk = events
            .iter()
            .any(|event| matches!(event.data(), SessionEventData::AssistantChunk { .. }));
        if contains_chunk && !self.blocked_once.swap(true, Ordering::SeqCst) {
            self.chunk_append_started.notify_one();
            self.release_chunk_append.notified().await;
        }
        self.append_batches.lock().unwrap().push(events.clone());
        self.inner
            .append(session_id, expected_revision, events)
            .await
    }

    async fn flush(&self, session_id: &str) -> Result<Revision, StoreError> {
        self.inner.flush(session_id).await
    }

    async fn inspect(&self, session_id: &str) -> Result<Option<SessionInspection>, StoreError> {
        self.inner.inspect(session_id).await
    }
}

fn completed() -> ProviderEvent {
    ProviderEvent::Completed {
        finish_reason: Some(FinishReason::Stop),
        usage: Some(TokenUsage {
            output_tokens: 1,
            ..TokenUsage::default()
        }),
        provider_items: Vec::new(),
    }
}

fn completed_for_calls() -> ProviderEvent {
    ProviderEvent::Completed {
        finish_reason: Some(FinishReason::ToolCalls),
        usage: Some(TokenUsage {
            output_tokens: 1,
            ..TokenUsage::default()
        }),
        provider_items: Vec::new(),
    }
}

fn completed_with(finish_reason: FinishReason, usage: TokenUsage) -> ProviderEvent {
    ProviderEvent::Completed {
        finish_reason: Some(finish_reason),
        usage: Some(usage),
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
async fn streaming_events_reach_consumers_before_chunk_journal_io_and_persist_as_one_batch() {
    const DELTAS: usize = 32;
    let mut script = (0..DELTAS)
        .map(|_| Ok(ProviderEvent::TextDelta("x".to_owned())))
        .collect::<Vec<_>>();
    script.push(Ok(completed()));
    let provider = Arc::new(ScriptProvider::new([script]));
    let journal = Arc::new(BlockingChunkJournal::default());
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("stream quickly")]);
    request.session_id = Some("batched-stream-journal".to_owned());
    request.journal_store = Some(journal.clone());
    request.config.event_buffer = DELTAS + 32;

    let mut run = LoopEngine.start(request);
    tokio::time::timeout(
        Duration::from_secs(2),
        journal.chunk_append_started.notified(),
    )
    .await
    .expect("the completed model round should reach its chunk journal boundary");

    let mut text_deltas = 0usize;
    while text_deltas < DELTAS {
        let event = tokio::time::timeout(Duration::from_millis(100), run.next())
            .await
            .expect("consumer-visible deltas must not wait for durable chunk append")
            .expect("run remains open while the durable chunk batch is blocked");
        if matches!(event.kind, LoopEventKind::TextDelta(_)) {
            text_deltas += 1;
        }
    }
    assert_eq!(text_deltas, DELTAS);

    journal.release_chunk_append.notify_one();
    while run.next().await.is_some() {}
    let result = run.result().await;
    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(result.final_text.len(), DELTAS);

    let chunk_batches = journal.chunk_batches();
    assert_eq!(chunk_batches.len(), 1);
    assert_eq!(
        chunk_batches[0]
            .iter()
            .filter(|event| matches!(event.data(), SessionEventData::AssistantChunk { .. }))
            .count(),
        DELTAS + 2,
        "text deltas, usage, and finish reason should share one append batch"
    );
    let assistant_position = chunk_batches[0]
        .iter()
        .position(|event| matches!(event.data(), SessionEventData::AssistantMessage { .. }))
        .expect("the completed assistant message is in the same semantic batch");
    let final_chunk_position = chunk_batches[0]
        .iter()
        .rposition(|event| matches!(event.data(), SessionEventData::AssistantChunk { .. }))
        .unwrap();
    assert!(final_chunk_position < assistant_position);
}

#[tokio::test]
async fn long_streams_checkpoint_in_bounded_batches_instead_of_per_delta() {
    const DELTAS: usize = 130;
    let mut script = (0..DELTAS)
        .map(|_| Ok(ProviderEvent::TextDelta("x".to_owned())))
        .collect::<Vec<_>>();
    script.push(Ok(completed()));
    let provider = Arc::new(ScriptProvider::new([script]));
    let journal = Arc::new(BlockingChunkJournal::default());
    journal.release_chunk_append.notify_one();
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("bounded batches")]);
    request.session_id = Some("bounded-stream-journal".to_owned());
    request.journal_store = Some(journal.clone());
    request.config.event_buffer = DELTAS + 32;

    let (events, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.kind, LoopEventKind::TextDelta(_)))
            .count(),
        DELTAS
    );

    let chunk_counts = journal
        .chunk_batches()
        .iter()
        .map(|batch| {
            batch
                .iter()
                .filter(|event| matches!(event.data(), SessionEventData::AssistantChunk { .. }))
                .count()
        })
        .collect::<Vec<_>>();
    assert_eq!(chunk_counts, [64, 64, 4]);
}

#[tokio::test]
async fn buffered_stream_chunks_are_closed_durably_when_the_provider_stream_fails() {
    let provider = Arc::new(ScriptProvider::new([vec![
        Ok(ProviderEvent::ReasoningDelta(
            "partial reasoning".to_owned(),
        )),
        Ok(ProviderEvent::TextDelta("partial answer".to_owned())),
        Err(ProviderError::new("stream broke after output")),
    ]]));
    let journal = Arc::new(EventMemorySessionStore::default());
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("fail after a delta")]);
    request.session_id = Some("failed-buffered-stream".to_owned());
    request.journal_store = Some(journal.clone());

    let (events, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Failed);
    assert!(events.iter().any(
        |event| matches!(&event.kind, LoopEventKind::TextDelta(text) if text == "partial answer")
    ));

    let session = journal
        .load("failed-buffered-stream")
        .await
        .unwrap()
        .unwrap();
    let event_kinds = session
        .events()
        .iter()
        .map(|event| event.data())
        .collect::<Vec<_>>();
    let reasoning = event_kinds
        .iter()
        .position(|event| {
            matches!(
                event,
                SessionEventData::AssistantChunk {
                    chunk: AssistantChunk::ReasoningDelta(text),
                    ..
                } if text == "partial reasoning"
            )
        })
        .expect("partial reasoning remains recoverable");
    let text = event_kinds
        .iter()
        .position(|event| {
            matches!(
                event,
                SessionEventData::AssistantChunk {
                    chunk: AssistantChunk::TextDelta(text),
                    ..
                } if text == "partial answer"
            )
        })
        .expect("partial text remains recoverable");
    let step_end = event_kinds
        .iter()
        .position(|event| matches!(event, SessionEventData::StepEnd { .. }))
        .expect("failed step is closed");
    let turn_end = event_kinds
        .iter()
        .position(|event| matches!(event, SessionEventData::TurnEnd { .. }))
        .expect("failed turn is closed");
    assert!(reasoning < text && text < step_end && step_end < turn_end);
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
async fn context_policy_projects_a_disposable_surface_before_provider_io() {
    let provider = Arc::new(ScriptProvider::new([vec![
        Ok(ProviderEvent::TextDelta("answer".to_owned())),
        Ok(completed()),
    ]]));
    let context = Arc::new(RecordingCompactionPolicy::default());
    let mut request = LoopRequest::new(provider.clone(), vec![AgentMessage::user("full history")]);
    request.context_policy = context.clone();
    request.tools.push(ToolSpec::new(
        "read",
        "read a file",
        json!({"type": "object"}),
        |_, _| async { ToolResult::success("unused") },
    ));

    let (_, result) = collect(LoopEngine.start(request)).await;

    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(result.messages[0].content, "full history");
    assert_eq!(
        provider.requests()[0].messages[0].content,
        "compacted surface"
    );
    let context_requests = context.requests();
    let context_request = &context_requests[0];
    assert_eq!(context_request.provider, "custom");
    assert_eq!(context_request.step, 1);
    assert_eq!(context_request.messages[0].content, "full history");
    assert_eq!(context_request.tools[0]["name"], "read");
}

#[tokio::test]
async fn result_does_not_require_draining_more_events_than_the_legacy_buffer() {
    const DELTAS: usize = 512;
    let mut script = (0..DELTAS)
        .map(|_| Ok(ProviderEvent::TextDelta("x".to_owned())))
        .collect::<Vec<_>>();
    script.push(Ok(completed()));
    let provider = Arc::new(ScriptProvider::new([script]));
    let mut request = LoopRequest::new(provider.clone(), vec![AgentMessage::user("run")]);
    request.config.event_buffer = 1;
    let mut run = LoopEngine.start(request);

    let result = tokio::time::timeout(Duration::from_secs(1), run.result())
        .await
        .expect("result was blocked by event delivery");
    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(result.final_text.len(), DELTAS);

    let lag = run.next().await.expect("lag marker");
    let resume_seq = match lag.kind {
        LoopEventKind::EventsLagged { missed, resume_seq } => {
            assert_eq!(missed, DELTAS as u64);
            resume_seq
        }
        other => panic!("expected lag marker, got {other:?}"),
    };
    let mut replay = run.subscribe_events_from(resume_seq);
    assert!(matches!(
        replay.next().await.unwrap().kind,
        LoopEventKind::RunCompleted { .. }
    ));
    assert!(replay.next().await.is_none());
    assert!(matches!(
        run.next().await.unwrap().kind,
        LoopEventKind::RunCompleted { .. }
    ));
    assert!(run.next().await.is_none());
}

#[tokio::test]
async fn oversized_events_are_evicted_under_the_byte_budget_with_a_resume_cursor() {
    let huge = "x".repeat(16 * 1024);
    let provider = Arc::new(ScriptProvider::new([vec![
        Ok(ProviderEvent::TextDelta(huge.clone())),
        Ok(completed()),
    ]]));
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.config.event_buffer = 128;
    request.config.event_buffer_bytes = 512;
    let mut run = LoopEngine.start(request);

    let result = run.result().await;
    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(result.final_text, huge);
    let lag = run
        .next()
        .await
        .expect("oversized events produce a lag marker");
    assert!(matches!(
        lag.kind,
        LoopEventKind::EventsLagged {
            missed: 2,
            resume_seq: 3,
        }
    ));
    assert!(run.next().await.is_none());
}

#[tokio::test]
async fn aggregates_fragmented_tool_calls_and_returns_errors_to_model() {
    let provider = Arc::new(ScriptProvider::new([
        vec![
            Ok(tool_delta(0, "bad", "echo", "[1")),
            Ok(tool_delta(0, "", "", ",2]")),
            Ok(tool_delta(1, "missing", "no_such_tool", "{}")),
            Ok(completed_for_calls()),
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
async fn contextual_tool_handler_receives_the_journal_execution_id() {
    let provider = Arc::new(ScriptProvider::new([
        vec![
            Ok(tool_delta(0, "provider-call", "inspect", "{}")),
            Ok(completed_for_calls()),
        ],
        vec![
            Ok(ProviderEvent::TextDelta("done".to_owned())),
            Ok(completed()),
        ],
    ]));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let tool = ToolSpec::new_contextual("inspect", "inspect", json!({"type":"object"}), {
        let seen = Arc::clone(&seen);
        move |invocation| {
            let seen = Arc::clone(&seen);
            async move {
                seen.lock()
                    .unwrap()
                    .push((invocation.execution_id, invocation.provider_call_id));
                ToolResult::success("ok")
            }
        }
    });
    let journal = Arc::new(EventMemorySessionStore::default());
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.session_id = Some("contextual-tool-id".to_owned());
    request.journal_store = Some(journal);
    request.tools.push(tool);

    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed);
    let call = &result.messages[1].tool_calls[0];
    assert_eq!(call.provider_call_id.as_deref(), Some("provider-call"));
    assert_eq!(
        seen.lock().unwrap().as_slice(),
        [(call.id.clone(), Some("provider-call".to_owned()))]
    );
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
    let journal = Arc::new(EventMemorySessionStore::default());
    let mut request = LoopRequest::new(provider.clone(), vec![AgentMessage::user("run")]);
    request.session_id = Some("durable-retry".to_owned());
    request.journal_store = Some(journal.clone());
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
    let retry_events = events
        .iter()
        .filter_map(|event| match &event.kind {
            LoopEventKind::ModelRetry {
                retry_id,
                attempt,
                max_retries,
                ..
            } => Some((retry_id.clone(), *attempt, *max_retries)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(retry_events.len(), 2);
    assert_eq!(retry_events[0].0, retry_events[1].0);
    assert_eq!(retry_events[0].1, 1);
    assert_eq!(retry_events[1].1, 2);
    assert_eq!(retry_events[0].2, 2);

    let session = journal.load("durable-retry").await.unwrap().unwrap();
    let durable_retries = session
        .events()
        .iter()
        .filter_map(|event| match event.data() {
            SessionEventData::LlmRetry {
                retry_id,
                retry,
                max_retries,
                ..
            } => Some(("scheduled", retry_id.clone(), *retry, *max_retries)),
            SessionEventData::LlmRetryStarted {
                retry_id, retry, ..
            } => Some(("started", retry_id.clone(), *retry, None)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        durable_retries,
        [
            ("scheduled", retry_events[0].0.clone(), 1, Some(2)),
            ("started", retry_events[0].0.clone(), 1, None),
            ("scheduled", retry_events[0].0.clone(), 2, Some(2)),
            ("started", retry_events[0].0.clone(), 2, None),
        ]
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
            Ok(completed_for_calls()),
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
            Ok(completed_for_calls()),
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
            Ok(completed_for_calls()),
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

#[tokio::test]
async fn token_usage_is_recorded_per_step_and_accumulated() {
    let provider = Arc::new(ScriptProvider::new([
        vec![
            Ok(tool_delta(0, "echo-1", "echo", "{}")),
            Ok(completed_with(
                FinishReason::ToolCalls,
                TokenUsage {
                    input_tokens: 10,
                    output_tokens: 2,
                    cache_read_tokens: 4,
                    cache_write_tokens: 1,
                    reasoning_tokens: 1,
                },
            )),
        ],
        vec![
            Ok(ProviderEvent::TextDelta("done".to_owned())),
            Ok(completed_with(
                FinishReason::Stop,
                TokenUsage {
                    input_tokens: 5,
                    output_tokens: 3,
                    cache_read_tokens: 2,
                    cache_write_tokens: 0,
                    reasoning_tokens: 2,
                },
            )),
        ],
    ]));
    let tool = ToolSpec::new("echo", "echo", json!({}), |_, _| async {
        ToolResult::success("ok")
    });
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.tools.push(tool);

    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(result.finish_reason, Some(FinishReason::Stop));
    assert_eq!(
        result.usage,
        Some(TokenUsage {
            input_tokens: 15,
            output_tokens: 5,
            cache_read_tokens: 6,
            cache_write_tokens: 1,
            reasoning_tokens: 3,
        })
    );
    assert_eq!(result.step_usage.len(), 2);
    assert_eq!(result.step_usage[0].step, 1);
    assert_eq!(result.step_usage[0].finish_reason, FinishReason::ToolCalls);
    assert_eq!(result.step_usage[1].step, 2);
    assert_eq!(result.step_usage[1].finish_reason, FinishReason::Stop);
}

#[tokio::test]
async fn length_finish_is_partial_failure_not_completed() {
    let provider = Arc::new(ScriptProvider::new([vec![
        Ok(ProviderEvent::TextDelta("partial".to_owned())),
        Ok(completed_with(
            FinishReason::Length,
            TokenUsage {
                output_tokens: 7,
                ..TokenUsage::default()
            },
        )),
    ]]));
    let (events, result) =
        collect(LoopEngine.start(LoopRequest::new(provider, vec![AgentMessage::user("run")])))
            .await;

    assert_eq!(result.status, LoopStatus::Failed);
    assert_eq!(result.finish_reason, Some(FinishReason::Length));
    assert_eq!(result.final_text, "partial");
    assert!(result.messages[1].interrupted);
    assert_eq!(result.usage.as_ref().unwrap().output_tokens, 7);
    assert!(result.error.as_deref().unwrap().contains("token limit"));
    assert!(!events
        .iter()
        .any(|event| matches!(event.kind, LoopEventKind::RunCompleted { .. })));
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

#[test]
fn tool_result_reduction_is_deterministic_and_preserves_head_tail_and_digest() {
    let content = format!("HEAD-{}-TAIL", "middle".repeat(1_000));
    let result = ToolResult::success(content.clone());
    let (first, truncated) = tool_result_for_model(&result, 512);
    let (second, _) = tool_result_for_model(&result, 512);
    assert!(truncated);
    assert_eq!(first, second);
    assert!(first.len() <= 512);
    let value: Value = serde_json::from_str(&first).unwrap();
    assert_eq!(value["reduction"]["strategy"], "head_tail/v1");
    assert_eq!(value["reduction"]["original_bytes"], content.len());
    assert!(value["reduction"]["omitted_bytes"].as_u64().unwrap() > 0);
    assert_eq!(value["reduction"]["sha256"].as_str().unwrap().len(), 64);
    let excerpt = value["content"].as_str().unwrap();
    assert!(excerpt.starts_with("HEAD-"));
    assert!(excerpt.ends_with("-TAIL"));
}

#[test]
fn tool_result_cap_never_produces_invalid_json() {
    let result = ToolResult::success("content");
    for limit in 0..MIN_TOOL_RESULT_LIMIT_BYTES {
        let (encoded, truncated) = tool_result_for_model(&result, limit);
        let value: Value = serde_json::from_str(&encoded).unwrap();
        assert!(truncated);
        assert_eq!(value["truncated"], true);
        assert!(value["error"].as_str().unwrap().contains("limit"));
    }
}

#[test]
fn loop_request_validation_rejects_invalid_config_and_tools() {
    let provider = Arc::new(ScriptProvider::new([vec![Ok(completed())]]));

    let mut request = LoopRequest::new(provider.clone(), vec![]);
    request.config.tool_result_limit_bytes = MIN_TOOL_RESULT_LIMIT_BYTES - 1;
    assert!(request
        .validate()
        .unwrap_err()
        .to_string()
        .contains("tool_result_limit_bytes"));

    let mut request = LoopRequest::new(provider.clone(), vec![]);
    request.config.event_buffer_bytes = 0;
    assert!(request
        .validate()
        .unwrap_err()
        .to_string()
        .contains("event_buffer_bytes"));

    let mut request = LoopRequest::new(provider.clone(), vec![]);
    request
        .tools
        .push(ToolSpec::new("", "empty", json!({}), |_, _| async {
            ToolResult::success("")
        }));
    assert!(request
        .validate()
        .unwrap_err()
        .to_string()
        .contains("empty name"));

    let duplicate = ToolSpec::new("same", "same", json!({}), |_, _| async {
        ToolResult::success("")
    });
    let mut request = LoopRequest::new(provider.clone(), vec![]);
    request.tools = vec![duplicate.clone(), duplicate];
    assert!(request
        .validate()
        .unwrap_err()
        .to_string()
        .contains("duplicate tool name"));

    let mut request = LoopRequest::new(provider.clone(), vec![]);
    request.tool_executor = Some(RuntimeToolExecutor::new(Arc::new(
        RuntimeToolRegistry::new(),
    )));
    request.tools.push(ToolSpec::new(
        "legacy",
        "legacy",
        json!({"type":"object"}),
        |_, _| async { ToolResult::success("") },
    ));
    assert!(request
        .validate()
        .unwrap_err()
        .to_string()
        .contains("cannot be configured together"));

    let mut request = LoopRequest::new(provider.clone(), vec![]);
    request.tools.push(
        ToolSpec::new("zero-timeout", "zero", json!({}), |_, _| async {
            ToolResult::success("")
        })
        .timeout(Duration::ZERO),
    );
    assert!(request
        .validate()
        .unwrap_err()
        .to_string()
        .contains("timeout"));

    let mut request = LoopRequest::new(provider, vec![]);
    request.tools.push(ToolSpec::new(
        "bad-schema",
        "bad",
        json!([]),
        |_, _| async { ToolResult::success("") },
    ));
    assert!(request
        .validate()
        .unwrap_err()
        .to_string()
        .contains("schema must be a JSON object"));
}

#[tokio::test]
async fn invalid_request_fails_before_the_provider_is_called() {
    let provider = Arc::new(ScriptProvider::new([vec![Ok(completed())]]));
    let mut request = LoopRequest::new(provider.clone(), vec![AgentMessage::user("run")]);
    request.config.tool_result_limit_bytes = MIN_TOOL_RESULT_LIMIT_BYTES - 1;

    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Failed);
    assert_eq!(provider.attempts(), 0);
    assert!(result
        .error
        .as_deref()
        .unwrap()
        .contains("tool_result_limit_bytes"));
}

#[tokio::test]
async fn hard_token_budget_rejects_64196_before_a_53248_provider_attempt() {
    let provider = Arc::new(ScriptProvider::new([vec![Ok(completed())]]));
    let guard = TokenGuard::new(
        Arc::new(FixedTokenMeter { total: 64_196 }),
        TokenBudget {
            context_window_tokens: 53_248,
            reserved_output_tokens: 4_096,
            safety_margin_tokens: 1_024,
        },
    )
    .unwrap();
    assert_eq!(guard.budget().available_input_tokens(), 48_128);
    let mut request = LoopRequest::new(provider.clone(), vec![AgentMessage::user("large turn")]);
    request.token_guard = Some(guard);

    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Failed);
    assert_eq!(provider.attempts(), 0);
    let error = result.error.unwrap();
    assert!(error.contains("64196"), "{error}");
    assert!(error.contains("context=53248"), "{error}");
}

#[tokio::test]
async fn provider_exact_count_prevents_conservative_byte_false_positive() {
    let provider = Arc::new(ExactCountingProvider::new(70_857, [vec![Ok(completed())]]));
    let journal = Arc::new(EventMemorySessionStore::default());
    let guard = TokenGuard::new(
        Arc::new(FixedTokenMeter { total: 253_908 }),
        TokenBudget {
            context_window_tokens: 262_144,
            reserved_output_tokens: 8_192,
            safety_margin_tokens: 2_048,
        },
    )
    .unwrap();
    let mut request = LoopRequest::new(provider.clone(), vec![AgentMessage::user("continue")]);
    request.session_id = Some("exact-provider-count".to_owned());
    request.journal_store = Some(journal.clone());
    request.token_guard = Some(guard);

    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(provider.inner.attempts(), 1);
    assert_eq!(provider.count_attempts.load(Ordering::SeqCst), 1);

    let session = journal.load("exact-provider-count").await.unwrap().unwrap();
    let header = session
        .events()
        .iter()
        .find_map(|event| match event.data() {
            SessionEventData::RequestHeader { header } => Some(header),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        header.options["tokenBudget"]["meter"],
        "test-provider/input-tokens/v1"
    );
    assert_eq!(header.options["tokenBudget"]["accuracy"], "exact_request");
    assert_eq!(
        header.options["tokenBudget"]["estimate"]["totalInputTokens"],
        70_857
    );
}

#[tokio::test]
async fn cancellation_stops_a_running_tool() {
    let provider = Arc::new(ScriptProvider::new([vec![
        Ok(tool_delta(0, "wait", "wait", "{}")),
        Ok(completed_for_calls()),
    ]]));
    let cleaned = Arc::new(AtomicUsize::new(0));
    let registry = Arc::new(RuntimeToolRegistry::new());
    registry
        .register(RuntimeToolSpec::new(
            RuntimeToolDefinition::new("wait", "wait", json!({"type":"object"})),
            {
                let cleaned = Arc::clone(&cleaned);
                move |context| {
                    let cleaned = Arc::clone(&cleaned);
                    async move {
                        context.cancellation.cancelled().await;
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        cleaned.fetch_add(1, Ordering::SeqCst);
                        Ok(RuntimeToolOutput::text("cancelled"))
                    }
                }
            },
        ))
        .await
        .unwrap();
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.tool_executor = Some(RuntimeToolExecutor::new(registry));
    let mut run = LoopEngine.start(request);
    while let Some(event) = run.next().await {
        if matches!(event.kind, LoopEventKind::ToolStarted(_)) {
            run.cancel();
        }
    }
    assert_eq!(run.result().await.status, LoopStatus::Cancelled);
    assert_eq!(cleaned.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn timeout_and_handler_panic_become_tool_results() {
    let provider = Arc::new(ScriptProvider::new([
        vec![
            Ok(tool_delta(0, "timeout", "slow", "{}")),
            Ok(tool_delta(1, "panic", "panic", "{}")),
            Ok(completed_for_calls()),
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
            Ok(completed_for_calls()),
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
        provider_call_id: None,
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
        Ok(completed_for_calls()),
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
        vec![
            Ok(tool_delta(0, "", "guarded", "{}")),
            Ok(completed_for_calls()),
        ],
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
    let journal = Arc::new(EventMemorySessionStore::default());
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.session_id = Some("durable-approval".to_owned());
    request.journal_store = Some(journal.clone());
    request.tools.push(tool);
    let mut run = LoopEngine.start(request);

    let (approval_id, call_id) = loop {
        let event = run.next().await.unwrap();
        if let LoopEventKind::ToolApprovalRequested { approval_id, call } = event.kind {
            break (approval_id, call.id);
        }
    };
    assert_ne!(approval_id, call_id);
    assert!(!call_id.is_empty());
    assert_eq!(executions.load(Ordering::SeqCst), 0);
    let pending = journal.load("durable-approval").await.unwrap().unwrap();
    assert!(pending.events().iter().any(|event| matches!(
        event.data(),
        SessionEventData::ApprovalAsked { id, call_id: Some(id_call), .. }
            if id == &approval_id && id_call == &call_id
    )));
    assert!(!pending.events().iter().any(|event| matches!(
        event.data(),
        SessionEventData::ApprovalDecided { id, .. } if id == &approval_id
    )));
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
    let completed = journal.load("durable-approval").await.unwrap().unwrap();
    let audit = completed
        .events()
        .iter()
        .filter_map(|event| match event.data() {
            SessionEventData::ApprovalAsked { id, .. } => Some((id.clone(), None)),
            SessionEventData::ApprovalDecided { id, outcome } => Some((id.clone(), Some(*outcome))),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        audit,
        [
            (approval_id.clone(), None),
            (approval_id, Some(ApprovalOutcome::AllowedOnce)),
        ]
    );
}

#[tokio::test]
async fn formal_tool_runtime_owns_approval_lifecycle_and_batch_execution() {
    let provider = Arc::new(ScriptProvider::new([
        vec![
            Ok(tool_delta(0, "provider-runtime", "guarded", "{}")),
            Ok(completed_for_calls()),
        ],
        vec![
            Ok(ProviderEvent::TextDelta("done".to_owned())),
            Ok(completed()),
        ],
    ]));
    let executions = Arc::new(AtomicUsize::new(0));
    let registry = Arc::new(RuntimeToolRegistry::new());
    registry
        .register(
            RuntimeToolSpec::new(
                RuntimeToolDefinition::new(
                    "guarded",
                    "guarded",
                    json!({"type":"object","additionalProperties":false}),
                ),
                {
                    let executions = Arc::clone(&executions);
                    move |context| {
                        let executions = Arc::clone(&executions);
                        async move {
                            assert!(context.execution_id.as_str().contains("xh-"));
                            executions.fetch_add(1, Ordering::SeqCst);
                            Ok(RuntimeToolOutput::text("allowed"))
                        }
                    }
                },
            )
            .requiring_approval(true),
        )
        .await
        .unwrap();
    let journal = Arc::new(EventMemorySessionStore::default());
    let mut request = LoopRequest::new(provider.clone(), vec![AgentMessage::user("run")]);
    request.session_id = Some("formal-tool-runtime".to_owned());
    request.journal_store = Some(journal.clone());
    request.tool_executor = Some(RuntimeToolExecutor::new(registry));
    let mut run = LoopEngine.start(request);

    let call_id = loop {
        let event = run.next().await.unwrap();
        if let LoopEventKind::ToolApprovalRequested { call, .. } = event.kind {
            break call.id;
        }
    };
    assert_eq!(executions.load(Ordering::SeqCst), 0);
    run.send(LoopCommand::ApproveTool {
        call_id: call_id.clone(),
    })
    .await
    .unwrap();

    let mut saw_started = false;
    let mut saw_completed = false;
    while let Some(event) = run.next().await {
        match event.kind {
            LoopEventKind::ToolStarted(call) if call.id == call_id => saw_started = true,
            LoopEventKind::ToolCompleted { call, result } if call.id == call_id => {
                assert!(result.ok);
                saw_completed = true;
            }
            _ => {}
        }
    }
    assert!(saw_started && saw_completed);
    assert_eq!(executions.load(Ordering::SeqCst), 1);
    assert_eq!(run.result().await.status, LoopStatus::Completed);
    let requests = provider.requests();
    assert_eq!(requests[0].tools.len(), 1);
    assert_eq!(requests[0].tools[0].name, "guarded");
    assert_eq!(requests[0].tools[0].description, "guarded");
    assert_eq!(requests[0].tools[0].parameters["type"], "object");
    let session = journal.load("formal-tool-runtime").await.unwrap().unwrap();
    assert!(session.events().iter().any(|event| matches!(
        event.data(),
        SessionEventData::ToolResult { result, .. } if result.call_id == call_id
    )));
}

#[tokio::test]
async fn formal_tool_runtime_materializes_unknown_and_invalid_calls_without_starting_handlers() {
    let provider = Arc::new(ScriptProvider::new([
        vec![
            Ok(tool_delta(0, "unknown", "missing", "{}")),
            Ok(tool_delta(1, "malformed", "guarded", "{")),
            Ok(tool_delta(2, "schema", "guarded", "{}")),
            Ok(completed_for_calls()),
        ],
        vec![
            Ok(ProviderEvent::TextDelta("handled".to_owned())),
            Ok(completed()),
        ],
    ]));
    let executions = Arc::new(AtomicUsize::new(0));
    let registry = Arc::new(RuntimeToolRegistry::new());
    registry
        .register(RuntimeToolSpec::new(
            RuntimeToolDefinition::new(
                "guarded",
                "guarded",
                json!({
                    "type":"object",
                    "required":["value"],
                    "properties":{"value":{"type":"string"}},
                    "additionalProperties":false
                }),
            ),
            {
                let executions = Arc::clone(&executions);
                move |_context| {
                    let executions = Arc::clone(&executions);
                    async move {
                        executions.fetch_add(1, Ordering::SeqCst);
                        Ok(RuntimeToolOutput::text("must not run"))
                    }
                }
            },
        ))
        .await
        .unwrap();
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.tool_executor = Some(RuntimeToolExecutor::new(registry));

    let (events, result) = collect(LoopEngine.start(request)).await;

    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(result.final_text, "handled");
    assert_eq!(executions.load(Ordering::SeqCst), 0);
    assert!(!events
        .iter()
        .any(|event| matches!(event.kind, LoopEventKind::ToolStarted(_))));
    let tool_messages = result
        .messages
        .iter()
        .filter(|message| message.role == Role::Tool)
        .collect::<Vec<_>>();
    assert_eq!(tool_messages.len(), 3);
    assert!(tool_messages[0].content.contains("unknown tool"));
    assert!(tool_messages[1].content.contains("valid JSON"));
    assert!(tool_messages[2].content.contains("required property"));
}

#[tokio::test]
async fn restart_resumes_undecided_approval_without_replaying_or_unknowning_the_tool() {
    let journal = Arc::new(EventMemorySessionStore::default());
    journal
        .create(SessionHeader::new("resume-approval"))
        .await
        .unwrap();
    let call = ToolCall {
        id: "execution-1".to_owned(),
        provider_call_id: Some("provider-call-1".to_owned()),
        index: 0,
        name: "guarded".to_owned(),
        arguments_json: "{}".to_owned(),
    };
    let mut assistant = AgentMessage::assistant("");
    assistant.tool_calls.push(call.clone());
    journal
        .append(
            "resume-approval",
            Revision::ZERO,
            vec![
                SessionEventData::TurnStart { turn: 1 }.into(),
                SessionEventData::UserMessage {
                    message: AgentMessage::user("run"),
                }
                .into(),
                SessionEventData::StepStart { turn: 1, step: 1 }.into(),
                SessionEventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message: assistant,
                    usage: None,
                }
                .into(),
                SessionEventData::ToolCall {
                    turn: 1,
                    step: 1,
                    call: call.clone(),
                }
                .into(),
                SessionEventData::ApprovalAsked {
                    id: "approval-stable".to_owned(),
                    tool_name: "guarded".to_owned(),
                    call_id: Some(call.id.clone()),
                    reason: Some("requires approval".to_owned()),
                }
                .into(),
            ],
        )
        .await
        .unwrap();
    journal.flush("resume-approval").await.unwrap();

    let provider = Arc::new(ScriptProvider::new([vec![
        Ok(ProviderEvent::TextDelta("continued".to_owned())),
        Ok(completed()),
    ]]));
    let executions = Arc::new(AtomicUsize::new(0));
    let registry = Arc::new(RuntimeToolRegistry::new());
    registry
        .register(
            RuntimeToolSpec::new(
                RuntimeToolDefinition::new("guarded", "guarded", json!({"type":"object"})),
                {
                    let executions = Arc::clone(&executions);
                    move |_context| {
                        let executions = Arc::clone(&executions);
                        async move {
                            executions.fetch_add(1, Ordering::SeqCst);
                            Ok(RuntimeToolOutput::text("recovered result"))
                        }
                    }
                },
            )
            .requiring_approval(true),
        )
        .await
        .unwrap();
    let mut request = LoopRequest::new(provider.clone(), Vec::new());
    request.session_id = Some("resume-approval".to_owned());
    request.journal_store = Some(journal.clone());
    request.tool_executor = Some(RuntimeToolExecutor::new(registry));
    let mut run = LoopEngine.start(request);

    let event = run.next().await.unwrap();
    let kind = event.kind;
    let LoopEventKind::ToolApprovalRequested { approval_id, call } = kind else {
        panic!("expected recovered approval, got {kind:?}");
    };
    assert_eq!(approval_id, "approval-stable");
    assert_eq!(call.id, "execution-1");
    assert_eq!(executions.load(Ordering::SeqCst), 0);
    assert_eq!(provider.attempts(), 0);

    run.send(LoopCommand::ApproveTool {
        call_id: call.id.clone(),
    })
    .await
    .unwrap();
    while run.next().await.is_some() {}
    let result = run.result().await;
    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(result.final_text, "continued");
    assert_eq!(executions.load(Ordering::SeqCst), 1);
    assert_eq!(provider.attempts(), 1);
    assert_eq!(provider.requests()[0].step, 2);
    assert_eq!(
        provider.requests()[0].messages[1].tool_calls[0].id,
        "execution-1"
    );
    assert_eq!(
        provider.requests()[0].messages[2].tool_call_id.as_deref(),
        Some("provider-call-1")
    );

    let session = journal.load("resume-approval").await.unwrap().unwrap();
    assert_eq!(session.pending_tool_approvals().len(), 0);
    assert_eq!(
        session
            .events()
            .iter()
            .filter(|event| matches!(event.data(), SessionEventData::ApprovalAsked { .. }))
            .count(),
        1,
        "recovery must reuse the durable approval identity"
    );
    assert!(session.events().iter().any(|event| matches!(
        event.data(),
        SessionEventData::ToolResult { result, .. }
            if result.call_id == "execution-1"
                && result.outcome == ToolOutcome::Success
    )));
    assert!(!session.events().iter().any(|event| matches!(
        event.data(),
        SessionEventData::ToolResult { result, .. }
            if result.call_id == "execution-1"
                && result.outcome == ToolOutcome::OutcomeUnknown
    )));
}

#[tokio::test]
async fn cancellation_closes_every_durable_pending_approval() {
    let provider = Arc::new(ScriptProvider::new([vec![
        Ok(tool_delta(0, "first", "guarded", "{}")),
        Ok(tool_delta(1, "second", "guarded", "{}")),
        Ok(completed_for_calls()),
    ]]));
    let registry = Arc::new(RuntimeToolRegistry::new());
    registry
        .register(
            RuntimeToolSpec::new(
                RuntimeToolDefinition::new("guarded", "guarded", json!({"type":"object"})),
                |_context| async { Ok(RuntimeToolOutput::text("must not run")) },
            )
            .with_concurrency(RuntimeToolConcurrency::Parallel)
            .requiring_approval(true),
        )
        .await
        .unwrap();
    let journal = Arc::new(EventMemorySessionStore::default());
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.session_id = Some("cancel-pending-approvals".to_owned());
    request.journal_store = Some(journal.clone());
    request.tool_executor = Some(RuntimeToolExecutor::new(registry));
    let mut run = LoopEngine.start(request);

    let mut asked = Vec::new();
    while asked.len() < 2 {
        let event = run.next().await.unwrap();
        if let LoopEventKind::ToolApprovalRequested { approval_id, .. } = event.kind {
            asked.push(approval_id);
        }
    }
    run.cancel();
    while run.next().await.is_some() {}
    assert_eq!(run.result().await.status, LoopStatus::Cancelled);

    let session = journal
        .load("cancel-pending-approvals")
        .await
        .unwrap()
        .unwrap();
    let decided = session
        .events()
        .iter()
        .filter_map(|event| match event.data() {
            SessionEventData::ApprovalDecided { id, outcome } => Some((id.clone(), *outcome)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        decided,
        asked
            .into_iter()
            .map(|id| (id, ApprovalOutcome::Cancelled))
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn duplicate_provider_call_ids_get_unique_approval_ids() {
    let provider = Arc::new(ScriptProvider::new([
        vec![
            Ok(tool_delta(0, "duplicate", "guarded", r#"{"value":1}"#)),
            Ok(tool_delta(1, "duplicate", "guarded", r#"{"value":2}"#)),
            Ok(completed_for_calls()),
        ],
        vec![
            Ok(ProviderEvent::TextDelta("done".to_owned())),
            Ok(completed()),
        ],
    ]));
    let executions = Arc::new(AtomicUsize::new(0));
    let registry = Arc::new(RuntimeToolRegistry::new());
    registry
        .register(
            RuntimeToolSpec::new(
                RuntimeToolDefinition::new("guarded", "guarded", json!({"type":"object"})),
                {
                    let executions = Arc::clone(&executions);
                    move |_context| {
                        let executions = Arc::clone(&executions);
                        async move {
                            executions.fetch_add(1, Ordering::SeqCst);
                            Ok(RuntimeToolOutput::text("allowed"))
                        }
                    }
                },
            )
            .with_concurrency(RuntimeToolConcurrency::Parallel)
            .requiring_approval(true),
        )
        .await
        .unwrap();
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.tool_executor = Some(RuntimeToolExecutor::new(registry));
    let mut run = LoopEngine.start(request);

    let mut approval_ids = Vec::new();
    while approval_ids.len() < 2 {
        let event = run.next().await.unwrap();
        if let LoopEventKind::ToolApprovalRequested { call, .. } = event.kind {
            approval_ids.push(call.id);
        }
    }
    assert_ne!(approval_ids[0], approval_ids[1]);
    for call_id in approval_ids {
        run.send(LoopCommand::ApproveTool { call_id })
            .await
            .unwrap();
    }

    while run.next().await.is_some() {}
    let result = run.result().await;
    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(executions.load(Ordering::SeqCst), 2);
    assert_ne!(
        result.messages[1].tool_calls[0].id,
        result.messages[1].tool_calls[1].id
    );
}

#[tokio::test]
async fn rejected_tool_never_runs_and_failure_is_written_back() {
    let provider = Arc::new(ScriptProvider::new([
        vec![
            Ok(tool_delta(0, "deny", "guarded", "{}")),
            Ok(completed_for_calls()),
        ],
        vec![
            Ok(ProviderEvent::TextDelta("handled".to_owned())),
            Ok(completed()),
        ],
    ]));
    let executions = Arc::new(AtomicUsize::new(0));
    let registry = Arc::new(RuntimeToolRegistry::new());
    registry
        .register(
            RuntimeToolSpec::new(
                RuntimeToolDefinition::new("guarded", "guarded", json!({"type":"object"})),
                {
                    let executions = Arc::clone(&executions);
                    move |_context| {
                        let executions = Arc::clone(&executions);
                        async move {
                            executions.fetch_add(1, Ordering::SeqCst);
                            Ok(RuntimeToolOutput::text("unexpected"))
                        }
                    }
                },
            )
            .requiring_approval(true),
        )
        .await
        .unwrap();
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.tool_executor = Some(RuntimeToolExecutor::new(registry));
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
    assert!(result.messages[2].content.contains("approval denied"));
    assert!(result.messages[2].content.contains("unsafe arguments"));
}

#[tokio::test]
async fn steering_during_tools_is_deferred_until_the_batch_finishes() {
    let provider = Arc::new(ScriptProvider::new([
        vec![
            Ok(tool_delta(0, "wait", "wait", "{}")),
            Ok(completed_for_calls()),
        ],
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

#[tokio::test]
async fn explicit_stop_with_tool_calls_fails_closed_without_running_the_tool() {
    let provider = Arc::new(ScriptProvider::new([vec![
        Ok(tool_delta(0, "provider-danger", "dangerous", "{}")),
        // Deliberately inconsistent: this must not be inferred as tool_calls.
        Ok(completed()),
    ]]));
    let journal = Arc::new(EventMemorySessionStore::default());
    let executions = Arc::new(AtomicUsize::new(0));
    let tool = ToolSpec::new("dangerous", "dangerous", json!({"type":"object"}), {
        let executions = Arc::clone(&executions);
        move |_, _| {
            executions.fetch_add(1, Ordering::SeqCst);
            async { ToolResult::success("must not run") }
        }
    });
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("do not trust this")]);
    request.session_id = Some("explicit-stop-mismatch".to_owned());
    request.journal_store = Some(journal.clone());
    request.tools.push(tool);

    let (_, result) = collect(LoopEngine.start(request)).await;

    assert_eq!(result.status, LoopStatus::Failed);
    assert_eq!(result.finish_reason, Some(FinishReason::Stop));
    assert_eq!(result.usage.as_ref().unwrap().output_tokens, 1);
    assert_eq!(executions.load(Ordering::SeqCst), 0);
    assert!(result
        .error
        .as_deref()
        .unwrap()
        .contains("finish reason was stop"));

    let session = journal
        .load("explicit-stop-mismatch")
        .await
        .unwrap()
        .unwrap();
    let raw_finish_reasons = session
        .events()
        .iter()
        .filter_map(|event| match event.data() {
            SessionEventData::AssistantChunk {
                chunk: AssistantChunk::Finish { reason },
                ..
            } => Some(reason.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(raw_finish_reasons, ["stop"]);
    assert_eq!(
        raw_finish_reasons[0],
        result.finish_reason.as_ref().unwrap().description()
    );
    assert!(!session.events().iter().any(|event| matches!(
        event.data(),
        SessionEventData::ToolCall { .. } | SessionEventData::ToolResult { .. }
    )));
}

#[tokio::test]
async fn missing_finish_reason_is_inferred_only_for_legacy_providers() {
    let provider = Arc::new(ScriptProvider::new([
        vec![
            Ok(tool_delta(0, "legacy-call", "echo", "{}")),
            Ok(ProviderEvent::Completed {
                finish_reason: None,
                usage: None,
                provider_items: Vec::new(),
            }),
        ],
        vec![
            Ok(ProviderEvent::TextDelta("done".to_owned())),
            Ok(completed()),
        ],
    ]));
    let executions = Arc::new(AtomicUsize::new(0));
    let tool = ToolSpec::new("echo", "echo", json!({"type":"object"}), {
        let executions = Arc::clone(&executions);
        move |_, _| {
            executions.fetch_add(1, Ordering::SeqCst);
            async { ToolResult::success("ok") }
        }
    });
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("legacy")]);
    request.tools.push(tool);

    let (_, result) = collect(LoopEngine.start(request)).await;

    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(executions.load(Ordering::SeqCst), 1);
    assert_eq!(result.finish_reason, Some(FinishReason::Stop));
}

#[tokio::test]
async fn completed_usage_survives_assistant_journal_failure() {
    let usage = TokenUsage {
        input_tokens: 7,
        output_tokens: 5,
        cache_read_tokens: 3,
        cache_write_tokens: 2,
        reasoning_tokens: 4,
    };
    let provider = Arc::new(ScriptProvider::new([vec![
        Ok(ProviderEvent::TextDelta("billed output".to_owned())),
        Ok(completed_with(FinishReason::Stop, usage.clone())),
    ]]));
    let journal = Arc::new(FailAssistantJournal::default());
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.session_id = Some("failing-assistant-journal".to_owned());
    request.journal_store = Some(journal);

    let (_, result) = collect(LoopEngine.start(request)).await;

    assert_eq!(result.status, LoopStatus::Failed);
    assert_eq!(result.finish_reason, Some(FinishReason::Stop));
    assert_eq!(result.usage, Some(usage.clone()));
    assert_eq!(result.step_usage.len(), 1);
    assert_eq!(result.step_usage[0].step, 1);
    assert_eq!(result.step_usage[0].usage, usage);
    assert_eq!(result.step_usage[0].finish_reason, FinishReason::Stop);
    assert!(result
        .error
        .as_deref()
        .unwrap()
        .contains("injected assistant journal failure"));
}

#[tokio::test]
async fn journal_rejects_invalid_injected_roles_without_stopping_the_run() {
    let provider = Arc::new(GatedProvider::new());
    let journal = Arc::new(EventMemorySessionStore::default());
    let mut request = LoopRequest::new(provider.clone(), vec![AgentMessage::user("run")]);
    request.session_id = Some("reject-invalid-injection".to_owned());
    request.journal_store = Some(journal);
    let mut run = LoopEngine.start(request);

    while let Some(event) = run.next().await {
        if matches!(event.kind, LoopEventKind::TextDelta(ref text) if text == "partial") {
            break;
        }
    }

    let assistant_rejection = run
        .send(LoopCommand::InjectMessage {
            message: AgentMessage::assistant("invalid assistant injection"),
            mode: InjectionMode::NextStep,
        })
        .await;
    assert!(matches!(
        assistant_rejection,
        Err(LoopControlError::Rejected(ref reason)) if reason.contains("user/system")
    ));
    let tool_rejection = run
        .send(LoopCommand::Steer(AgentMessage::tool(
            "provider-call",
            "invalid tool injection",
        )))
        .await;
    assert!(matches!(
        tool_rejection,
        Err(LoopControlError::Rejected(ref reason)) if reason.contains("user/system")
    ));

    provider.release_first.notify_one();
    while run.next().await.is_some() {}
    let result = run.result().await;

    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(provider.requests().len(), 1);
    assert!(!result.messages.iter().any(|message| {
        message.content == "invalid assistant injection"
            || message.content == "invalid tool injection"
    }));
}

#[tokio::test]
async fn event_journal_records_model_input_and_tool_call_before_side_effects() {
    let provider = Arc::new(ScriptProvider::new([
        vec![
            Ok(tool_delta(0, "call-1", "inspect", "{}")),
            Ok(completed_for_calls()),
        ],
        vec![
            Ok(ProviderEvent::TextDelta("done".to_owned())),
            Ok(completed()),
        ],
    ]));
    let journal = Arc::new(EventMemorySessionStore::default());
    let was_durable = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let tool = ToolSpec::new("inspect", "inspect", json!({"type":"object"}), {
        let journal = Arc::clone(&journal);
        let was_durable = Arc::clone(&was_durable);
        move |_, _| {
            let journal = Arc::clone(&journal);
            let was_durable = Arc::clone(&was_durable);
            async move {
                let session = journal.load("journal-run").await.unwrap().unwrap();
                let durable = session.events().iter().any(|event| {
                    matches!(
                        event.data(),
                        SessionEventData::ToolCall { call, .. }
                            if call.name == "inspect" && call.id.starts_with("xh-")
                    )
                });
                was_durable.store(durable, Ordering::SeqCst);
                ToolResult::success("observed")
            }
        }
    });
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("inspect state")]);
    request.session_id = Some("journal-run".to_owned());
    request.journal_store = Some(journal.clone());
    request.tools.push(tool);

    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed);
    assert!(was_durable.load(Ordering::SeqCst));

    let session = journal.load("journal-run").await.unwrap().unwrap();
    let events = session.events();
    let call_position = events
        .iter()
        .position(|event| matches!(event.data(), SessionEventData::ToolCall { .. }))
        .unwrap();
    let result_position = events
        .iter()
        .position(|event| matches!(event.data(), SessionEventData::ToolResult { .. }))
        .unwrap();
    assert!(call_position < result_position);
    let finish_reasons = events
        .iter()
        .filter_map(|event| match event.data() {
            SessionEventData::AssistantChunk {
                chunk: AssistantChunk::Finish { reason },
                ..
            } => Some(reason.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(finish_reasons, ["tool_calls", "stop"]);
    assert!(matches!(
        events.last().unwrap().data(),
        SessionEventData::TurnEnd {
            reason: TurnEndReason::Completed,
            ..
        }
    ));
    let request_header = events
        .iter()
        .find_map(|event| match event.data() {
            SessionEventData::RequestHeader { header } => Some(header),
            _ => None,
        })
        .unwrap();
    assert_eq!(request_header.input[0].content, "inspect state");
    assert_eq!(request_header.provider, "custom");
    assert_eq!(
        request_header.options["context"]["policy"]["name"],
        "identity"
    );
    assert_eq!(
        request_header.options["context"]["visible_message_count"],
        1
    );
}

#[tokio::test]
async fn prompt_is_first_in_every_provider_request_and_audited_in_the_request_header() {
    let provider = Arc::new(ScriptProvider::new([vec![
        Ok(ProviderEvent::TextDelta("done".to_owned())),
        Ok(completed()),
    ]]));
    let journal = Arc::new(EventMemorySessionStore::default());
    let prompt = PromptAssembler
        .assemble([
            PromptSection::new("identity", "1", "System identity."),
            PromptSection::new("workflow", "2", "Inspect, then answer."),
        ])
        .unwrap();
    let expected_audit = prompt.audit().clone();
    let mut request = LoopRequest::new(provider.clone(), vec![AgentMessage::user("hello")]);
    request.session_id = Some("prompt-audit".to_owned());
    request.journal_store = Some(journal.clone());
    request.prompt = Some(prompt);
    request.token_guard = Some(
        TokenGuard::new(
            Arc::new(FixedTokenMeter { total: 42 }),
            TokenBudget {
                context_window_tokens: 8_192,
                reserved_output_tokens: 1_024,
                safety_margin_tokens: 256,
            },
        )
        .unwrap(),
    );

    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed);
    let requests = provider.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].messages[0].role, Role::System);
    assert_eq!(
        requests[0].messages[0].content,
        "System identity.\n\nInspect, then answer."
    );
    assert_eq!(requests[0].messages[1].content, "hello");
    assert_eq!(requests[0].max_output_tokens, Some(1_024));

    let session = journal.load("prompt-audit").await.unwrap().unwrap();
    let header = session
        .events()
        .iter()
        .find_map(|event| match event.data() {
            SessionEventData::RequestHeader { header } => Some(header),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        header.system.as_deref(),
        Some("System identity.\n\nInspect, then answer.")
    );
    assert_eq!(
        header.options["prompt"],
        serde_json::to_value(expected_audit).unwrap()
    );
    assert_eq!(
        header.options["toolDefinitionsSha256"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    assert_eq!(header.options["tokenBudget"]["meter"], "test-fixed/v1");
    assert_eq!(header.options["tokenBudget"]["availableInputTokens"], 6_912);
    assert_eq!(
        header.options["tokenBudget"]["estimate"]["totalInputTokens"],
        42
    );
    assert!(session
        .derive_messages()
        .iter()
        .all(|message| message.role != xharness_session::MessageRole::System));
}

#[tokio::test]
async fn context_policy_cannot_silently_remove_or_rewrite_the_assembled_prompt() {
    let provider = Arc::new(ScriptProvider::new([vec![Ok(completed())]]));
    let prompt = PromptAssembler
        .assemble([PromptSection::new("identity", "1", "must remain")])
        .unwrap();
    let mut request = LoopRequest::new(provider.clone(), vec![AgentMessage::user("hello")]);
    request.prompt = Some(prompt);
    request.context_policy = Arc::new(DroppingSystemPolicy);

    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Failed);
    assert!(result
        .error
        .as_deref()
        .unwrap()
        .contains("context policy removed"));
    assert_eq!(provider.attempts(), 0);
}

#[tokio::test]
async fn journal_namespaces_reused_provider_call_ids_across_steps() {
    let provider = Arc::new(ScriptProvider::new([
        vec![
            Ok(tool_delta(0, "provider-reused", "echo", r#"{"step":1}"#)),
            Ok(completed_for_calls()),
        ],
        vec![
            Ok(tool_delta(0, "provider-reused", "echo", r#"{"step":2}"#)),
            Ok(completed_for_calls()),
        ],
        vec![
            Ok(ProviderEvent::TextDelta("done".to_owned())),
            Ok(completed()),
        ],
    ]));
    let executions = Arc::new(AtomicUsize::new(0));
    let tool = ToolSpec::new("echo", "echo", json!({"type":"object"}), {
        let executions = Arc::clone(&executions);
        move |_, _| {
            executions.fetch_add(1, Ordering::SeqCst);
            async { ToolResult::success("ok") }
        }
    });
    let journal = Arc::new(EventMemorySessionStore::default());
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("twice")]);
    request.session_id = Some("reused-provider-call-ids".to_owned());
    request.journal_store = Some(journal.clone());
    request.tools.push(tool);

    let (_, result) = collect(LoopEngine.start(request)).await;

    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(executions.load(Ordering::SeqCst), 2);
    let session = journal
        .load("reused-provider-call-ids")
        .await
        .unwrap()
        .unwrap();
    let execution_ids = session
        .events()
        .iter()
        .filter_map(|event| match event.data() {
            SessionEventData::ToolCall { call, .. } => Some(call.id.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(execution_ids.len(), 2);
    assert_ne!(execution_ids[0], execution_ids[1]);
    assert!(execution_ids.iter().all(|id| id.starts_with("xh-")));
    assert!(execution_ids.iter().all(|id| id != "provider-reused"));
    let persisted_provider_ids = session
        .events()
        .iter()
        .filter_map(|event| match event.data() {
            SessionEventData::ToolCall { call, .. } => call.provider_call_id.as_deref(),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        persisted_provider_ids,
        ["provider-reused", "provider-reused"]
    );

    let raw_provider_ids = session
        .events()
        .iter()
        .filter_map(|event| match event.data() {
            SessionEventData::AssistantChunk {
                chunk: AssistantChunk::ToolCallDelta { id, .. },
                ..
            } => Some(id.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(raw_provider_ids, ["provider-reused", "provider-reused"]);

    let result_ids = session
        .events()
        .iter()
        .filter_map(|event| match event.data() {
            SessionEventData::ToolResult { result, .. } => Some(result.call_id.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(result_ids, execution_ids);
    let replayed_tool_ids = result
        .messages
        .iter()
        .filter(|message| message.role == Role::Tool)
        .filter_map(|message| message.tool_call_id.as_deref())
        .collect::<Vec<_>>();
    assert_eq!(replayed_tool_ids, ["provider-reused", "provider-reused"]);
}

#[tokio::test]
async fn event_journal_recovers_incomplete_tool_as_outcome_unknown_without_replay() {
    let journal = Arc::new(EventMemorySessionStore::default());
    journal
        .create(SessionHeader::new("recover-journal"))
        .await
        .unwrap();
    let call = ToolCall {
        id: "side-effect".to_owned(),
        provider_call_id: None,
        index: 0,
        name: "dangerous".to_owned(),
        arguments_json: "{}".to_owned(),
    };
    let mut assistant = AgentMessage::assistant("");
    assistant.tool_calls.push(call.clone());
    journal
        .append(
            "recover-journal",
            Revision::ZERO,
            vec![
                SessionEventData::TurnStart { turn: 1 }.into(),
                SessionEventData::UserMessage {
                    message: AgentMessage::user("do it"),
                }
                .into(),
                SessionEventData::StepStart { turn: 1, step: 1 }.into(),
                SessionEventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message: assistant,
                    usage: None,
                }
                .into(),
                SessionEventData::ToolCall {
                    turn: 1,
                    step: 1,
                    call,
                }
                .into(),
            ],
        )
        .await
        .unwrap();

    let provider = Arc::new(ScriptProvider::new([vec![
        Ok(ProviderEvent::TextDelta("verified".to_owned())),
        Ok(completed()),
    ]]));
    let executions = Arc::new(AtomicUsize::new(0));
    let tool = ToolSpec::new("dangerous", "dangerous", json!({"type":"object"}), {
        let executions = Arc::clone(&executions);
        move |_, _| {
            executions.fetch_add(1, Ordering::SeqCst);
            async { ToolResult::success("unexpected") }
        }
    });
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("verify first")]);
    request.session_id = Some("recover-journal".to_owned());
    request.journal_store = Some(journal.clone());
    request.tools.push(tool);

    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(executions.load(Ordering::SeqCst), 0);
    assert!(result
        .messages
        .iter()
        .any(|message| message.content.contains("outcome is unknown")));

    let session = journal.load("recover-journal").await.unwrap().unwrap();
    assert!(session.events().iter().any(|event| {
        matches!(
            event.data(),
            SessionEventData::ToolResult { result, .. }
                if result.call_id == "side-effect" && result.outcome == ToolOutcome::OutcomeUnknown
        )
    }));
    assert!(session.events().iter().any(|event| {
        matches!(
            event.data(),
            SessionEventData::TurnEnd {
                turn: 1,
                reason: TurnEndReason::Interrupted
            }
        )
    }));
}

#[tokio::test]
async fn durable_crash_cut_matrix_closes_or_preserves_each_authoritative_boundary() {
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum CrashCut {
        Claim,
        Request,
        ToolCall,
        ToolResult,
        StepEnd,
        TurnEnd,
    }

    for cut in [
        CrashCut::Claim,
        CrashCut::Request,
        CrashCut::ToolCall,
        CrashCut::ToolResult,
        CrashCut::StepEnd,
        CrashCut::TurnEnd,
    ] {
        let session_id = format!("crash-cut-{cut:?}").to_ascii_lowercase();
        let journal = Arc::new(EventMemorySessionStore::default());
        journal
            .create(SessionHeader::new(&session_id))
            .await
            .unwrap();
        let mut events = vec![
            SessionEventData::TurnStart { turn: 1 }.into(),
            SessionEventData::UserMessage {
                message: AgentMessage::user("durable original").with_id("original-input"),
            }
            .into(),
        ];
        if cut != CrashCut::Claim {
            events.extend([
                SessionEventData::StepStart { turn: 1, step: 1 }.into(),
                SessionEventData::RequestHeader {
                    header: xharness_session::RequestHeader::new("crashed", "model"),
                }
                .into(),
            ]);
        }
        if matches!(cut, CrashCut::ToolCall | CrashCut::ToolResult) {
            let call = ToolCall {
                id: "durable-side-effect".to_owned(),
                provider_call_id: None,
                index: 0,
                name: "dangerous".to_owned(),
                arguments_json: "{}".to_owned(),
            };
            let mut assistant = AgentMessage::assistant("");
            assistant.tool_calls.push(call.clone());
            events.extend([
                SessionEventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message: assistant,
                    usage: None,
                }
                .into(),
                SessionEventData::ToolCall {
                    turn: 1,
                    step: 1,
                    call,
                }
                .into(),
            ]);
            if cut == CrashCut::ToolResult {
                events.push(
                    SessionEventData::ToolResult {
                        turn: 1,
                        step: 1,
                        result: xharness_session::ToolResultData {
                            call_id: "durable-side-effect".to_owned(),
                            outcome: ToolOutcome::Success,
                            content: "authoritative result".to_owned(),
                            metadata: None,
                        },
                    }
                    .into(),
                );
            }
        }
        if matches!(cut, CrashCut::StepEnd | CrashCut::TurnEnd) {
            events.extend([
                SessionEventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message: AgentMessage::assistant("durable answer").with_id("durable-answer"),
                    usage: None,
                }
                .into(),
                SessionEventData::StepEnd { turn: 1, step: 1 }.into(),
            ]);
        }
        if cut == CrashCut::TurnEnd {
            events.push(
                SessionEventData::TurnEnd {
                    turn: 1,
                    reason: TurnEndReason::Completed,
                }
                .into(),
            );
        }
        journal
            .append(&session_id, Revision::ZERO, events)
            .await
            .unwrap();
        journal.flush(&session_id).await.unwrap();

        let provider = Arc::new(ScriptProvider::new([vec![
            Ok(ProviderEvent::TextDelta("recovered".to_owned())),
            Ok(completed()),
        ]]));
        let executions = Arc::new(AtomicUsize::new(0));
        let tool = ToolSpec::new("dangerous", "dangerous", json!({"type":"object"}), {
            let executions = Arc::clone(&executions);
            move |_, _| {
                executions.fetch_add(1, Ordering::SeqCst);
                async { ToolResult::success("must not replay") }
            }
        });
        let mut request =
            LoopRequest::new(provider.clone(), vec![AgentMessage::user("recovery probe")]);
        request.session_id = Some(session_id.clone());
        request.journal_store = Some(journal.clone());
        request.tools.push(tool);

        let (_, result) = collect(LoopEngine.start(request)).await;
        assert_eq!(result.status, LoopStatus::Completed, "cut={cut:?}");
        assert_eq!(executions.load(Ordering::SeqCst), 0, "cut={cut:?}");
        assert_eq!(provider.attempts(), 1, "cut={cut:?}");

        let recovered = journal.load(&session_id).await.unwrap().unwrap();
        assert_eq!(
            recovered
                .derive_messages()
                .iter()
                .filter(|message| message.id.as_deref() == Some("original-input"))
                .count(),
            1,
            "cut={cut:?}"
        );
        let turn_one_end = recovered
            .events()
            .iter()
            .find_map(|event| match event.data() {
                SessionEventData::TurnEnd { turn: 1, reason } => Some(reason),
                _ => None,
            });
        if cut == CrashCut::TurnEnd {
            assert_eq!(turn_one_end, Some(&TurnEndReason::Completed), "cut={cut:?}");
        } else {
            assert_eq!(
                turn_one_end,
                Some(&TurnEndReason::Interrupted),
                "cut={cut:?}"
            );
        }
        assert!(recovered.events().iter().any(|event| matches!(
            event.data(),
            SessionEventData::TurnEnd {
                turn: 2,
                reason: TurnEndReason::Completed,
            }
        )));

        let durable_results = recovered
            .events()
            .iter()
            .filter_map(|event| match event.data() {
                SessionEventData::ToolResult { result, .. }
                    if result.call_id == "durable-side-effect" =>
                {
                    Some(result.outcome)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        match cut {
            CrashCut::ToolCall => {
                assert_eq!(durable_results, [ToolOutcome::OutcomeUnknown]);
            }
            CrashCut::ToolResult => {
                assert_eq!(durable_results, [ToolOutcome::Success]);
            }
            _ => assert!(durable_results.is_empty(), "cut={cut:?}"),
        }
    }
}

#[tokio::test]
async fn cancel_command_is_acknowledged_before_the_run_stops() {
    let provider = Arc::new(ScriptProvider::new([vec![
        Ok(tool_delta(0, "wait", "wait", "{}")),
        Ok(completed_for_calls()),
    ]]));
    let cleaned = Arc::new(AtomicUsize::new(0));
    let registry = Arc::new(RuntimeToolRegistry::new());
    registry
        .register(RuntimeToolSpec::new(
            RuntimeToolDefinition::new("wait", "wait", json!({"type":"object"})),
            {
                let cleaned = Arc::clone(&cleaned);
                move |context| {
                    let cleaned = Arc::clone(&cleaned);
                    async move {
                        context.cancellation.cancelled().await;
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        cleaned.fetch_add(1, Ordering::SeqCst);
                        Ok(RuntimeToolOutput::text("cancelled"))
                    }
                }
            },
        ))
        .await
        .unwrap();
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("run")]);
    request.tool_executor = Some(RuntimeToolExecutor::new(registry));
    let mut run = LoopEngine.start(request);
    while let Some(event) = run.next().await {
        if matches!(event.kind, LoopEventKind::ToolStarted(_)) {
            break;
        }
    }

    assert_eq!(run.send(LoopCommand::Cancel).await, Ok(()));
    while run.next().await.is_some() {}
    assert_eq!(run.result().await.status, LoopStatus::Cancelled);
    assert_eq!(cleaned.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn terminal_vs_steer_never_acknowledges_an_unapplied_command() {
    for iteration in 0..32 {
        let provider = Arc::new(GatedProvider::new());
        let request = LoopRequest::new(provider.clone(), vec![AgentMessage::user("run")]);
        let mut run = LoopEngine.start(request);
        while let Some(event) = run.next().await {
            if matches!(event.kind, LoopEventKind::TextDelta(ref text) if text == "partial") {
                break;
            }
        }

        provider.release_first.notify_one();
        if iteration % 2 == 0 {
            tokio::task::yield_now().await;
        }
        let acceptance = run
            .send(LoopCommand::Steer(AgentMessage::user(
                "terminal race steer",
            )))
            .await;

        while run.next().await.is_some() {}
        let result = run.result().await;
        let requests = provider.requests();
        assert_eq!(result.status, LoopStatus::Completed);
        match acceptance {
            Ok(()) => {
                assert_eq!(requests.len(), 2);
                assert!(result
                    .messages
                    .iter()
                    .any(|message| message.content == "terminal race steer"));
            }
            Err(LoopControlError::Closed) => {
                assert_eq!(requests.len(), 1);
                assert!(!result
                    .messages
                    .iter()
                    .any(|message| message.content == "terminal race steer"));
            }
            Err(LoopControlError::Rejected(reason)) => {
                panic!("valid user steering command was rejected: {reason}")
            }
        }
    }
}

#[tokio::test]
async fn durable_inbox_claim_and_turn_input_share_one_atomic_revision() {
    let journal = Arc::new(EventMemorySessionStore::default());
    journal
        .create(SessionHeader::new("durable-inbox-turn"))
        .await
        .unwrap();
    journal
        .append(
            "durable-inbox-turn",
            Revision::ZERO,
            vec![SessionEventData::AgentInboxSpliced {
                target: InboxTarget::NextTurn,
                start: 0,
                removed_count: 0,
                inserted: vec![InboxMessage::user("prompt-id", "hello")],
                outcome: None,
            }
            .into()],
        )
        .await
        .unwrap();

    let provider = Arc::new(ScriptProvider::new([vec![
        Ok(ProviderEvent::TextDelta("done".to_owned())),
        Ok(completed()),
    ]]));
    let mut request = LoopRequest::new(provider, vec![AgentMessage::user("hello")]);
    request.session_id = Some("durable-inbox-turn".to_owned());
    request.journal_store = Some(journal.clone());
    request.journal_prelude.push(
        SessionEventData::AgentInboxSpliced {
            target: InboxTarget::NextTurn,
            start: 0,
            removed_count: 1,
            inserted: Vec::new(),
            outcome: None,
        }
        .into(),
    );

    let (_, result) = collect(LoopEngine.start(request)).await;
    assert_eq!(result.status, LoopStatus::Completed);
    let session = journal.load("durable-inbox-turn").await.unwrap().unwrap();
    let turn_start = session
        .events()
        .iter()
        .find(|event| matches!(event.data(), SessionEventData::TurnStart { turn: 1 }))
        .unwrap();
    let claim = session
        .events()
        .iter()
        .find(|event| {
            matches!(
                event.data(),
                SessionEventData::AgentInboxSpliced {
                    target: InboxTarget::NextTurn,
                    removed_count: 1,
                    ..
                }
            )
        })
        .unwrap();
    let user = session
        .events()
        .iter()
        .find(|event| matches!(event.data(), SessionEventData::UserMessage { .. }))
        .unwrap();
    assert_eq!(turn_start.revision, claim.revision);
    assert_eq!(claim.revision, user.revision);
}

#[tokio::test]
async fn active_loop_adopts_intervening_durable_control_appends() {
    let journal = Arc::new(EventMemorySessionStore::default());
    let provider = Arc::new(GatedProvider::new());
    let mut request = LoopRequest::new(provider.clone(), vec![AgentMessage::user("run")]);
    request.session_id = Some("live-inbox-writer".to_owned());
    request.journal_store = Some(journal.clone());
    let mut run = LoopEngine.start(request);
    while let Some(event) = run.next().await {
        if matches!(event.kind, LoopEventKind::TextDelta(ref text) if text == "partial") {
            break;
        }
    }

    let session = journal.load("live-inbox-writer").await.unwrap().unwrap();
    journal
        .append(
            "live-inbox-writer",
            session.revision(),
            vec![
                SessionEventData::AgentInboxSpliced {
                    target: InboxTarget::NextTurn,
                    start: 0,
                    removed_count: 0,
                    inserted: vec![InboxMessage::user("later", "next turn")],
                    outcome: None,
                }
                .into(),
                SessionEventData::CommandRun {
                    command_id: "external-command".to_owned(),
                    name: "permission".to_owned(),
                    args: Some(String::new()),
                    source: CommandSource::User,
                }
                .into(),
                SessionEventData::CommandDone {
                    command_id: "external-command".to_owned(),
                    kind: CommandResultKind::Success,
                    text: Some("unchanged".to_owned()),
                    source_event_seq: None,
                }
                .into(),
                SessionEventData::SessionTitle {
                    title: "renamed while running".to_owned(),
                    message_seqs: Vec::new(),
                    source: SessionTitleSource::User,
                }
                .into(),
                SessionEventData::GoalChange {
                    change: GoalChange::Snapshot(GoalSnapshotChange {
                        kind: GoalChangeKind::GoalChange,
                        version: 1,
                        operation: GoalSnapshotOperation::Create,
                        goal: GoalSnapshot {
                            id: "goal-live".to_owned(),
                            revision: 1,
                            objective: "finish safely".to_owned(),
                            phase: GoalPhase::Active,
                            blocked_reason: None,
                            max_goal_rounds: 8,
                        },
                        rounds_started: 0,
                        created_at: 1,
                        updated_at: 1,
                    }),
                }
                .into(),
                SessionEventData::PlanMode { active: true }.into(),
            ],
        )
        .await
        .unwrap();
    provider.release_first.notify_one();
    while run.next().await.is_some() {}
    assert_eq!(run.result().await.status, LoopStatus::Completed);

    let session = journal.load("live-inbox-writer").await.unwrap().unwrap();
    assert!(session.events().iter().any(|event| {
        matches!(
            event.data(),
            SessionEventData::AgentInboxSpliced { inserted, .. }
                if inserted.iter().any(|message| message.id == "later")
        )
    }));
    assert!(session.events().iter().any(|event| {
        matches!(
            event.data(),
            SessionEventData::TurnEnd {
                turn: 1,
                reason: TurnEndReason::Completed
            }
        )
    }));
}

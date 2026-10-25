use crate::retry::{NetworkBackoff, RetryPlan, RetryState};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use futures::{Stream, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_stream::wrappers::WatchStream;
use tokio_util::sync::CancellationToken;
use xharness_compaction::{
    frame_summary, BasicCompactionPlanner, CompactionDecision, CompactionPlan, CompactionRequest,
    CompactionTrigger, ModelTarget, SurfaceNode, SurfaceNodeKind,
};
use xharness_debug::DebugScope;
use xharness_session::{
    ApprovalOutcome, AssistantChunk, CommandResultKind, CompactionEndOutcome, CompactionProgress,
    CompactionStage, EventData as SessionEventData, LlmFailure, LlmRetryMode, PendingToolApproval,
    RequestHeader, Revision, SequenceRange, SessionEvent, SessionHeader,
    Store as EventSessionStore, SurfaceReplace, ToolOutcome, ToolResultData, TurnEndReason,
};

/// Bound both crash-loss and memory growth without returning to one JSONL
/// read/validate/append cycle per provider fragment.
const STREAM_JOURNAL_BATCH_EVENTS: usize = 64;
const STREAM_JOURNAL_BATCH_BYTES: usize = 4 * 1_024;
const STREAM_JOURNAL_BATCH_INTERVAL: Duration = Duration::from_millis(250);
// Tool argument fragments are not a usable model answer. Keep a bounded
// retry-safe prefix private until the stream commits or finishes.
const MAX_RETRY_SAFE_TOOL_PREFIX_BYTES: usize = 256 * 1024;
use xharness_tools::{
    ApprovalDecision as RuntimeApprovalDecision, ApprovalProvider as RuntimeApprovalProvider,
    ApprovalRequest as RuntimeApprovalRequest, MiddlewareError as RuntimeMiddlewareError,
    ToolBatchEvent as RuntimeBatchEvent, ToolBatchRequest as RuntimeBatchRequest,
    ToolBatchRun as RuntimeBatchRun, ToolExecutionContext as RuntimeExecutionContext,
    ToolFailureKind as RuntimeToolFailureKind, ToolLifecycle as RuntimeToolLifecycle,
    ToolRequest as RuntimeToolRequest,
};

use crate::{
    tool_result_for_model, AgentMessage, ContextComposition, ContextRequest, ContextSurface,
    FinishReason, InjectionMode, LoopCommand, LoopControlError, LoopEvent, LoopEventKind,
    LoopRequest, LoopResult, LoopStatus, ProviderError, ProviderEvent, ProviderRequest, Role,
    SessionSnapshot, StepUsage, TokenBudgetError, TokenBudgetReport, TokenEstimateRequest,
    TokenUsage, ToolCall, ToolResult,
};

static NEXT_RUN_ID: AtomicU64 = AtomicU64::new(1);
const TOOL_CLEANUP_GRACE: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StopReason {
    Cancelled,
    ConsumerStopped,
}

enum TokenBudgetCheck {
    Ready(Option<TokenBudgetReport>),
    Exceeded {
        current_input_tokens: u64,
        context_window_tokens: u64,
        error: String,
    },
    Interrupted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CompactionOutcome {
    NotApplied,
    Skipped(CompactionEndOutcome),
    Applied,
    Interrupted,
}

struct CompactionSummaryOutput {
    progress: CompactionProgress,
    text: String,
    usage: Option<TokenUsage>,
    max_output_tokens: u64,
}

pub struct LoopRun {
    pub run_id: String,
    events: LoopEventStream,
    event_journal: Arc<EventJournal>,
    result: watch::Receiver<Option<LoopResult>>,
    cancellation: CancellationToken,
    consumer_dropped: Arc<AtomicBool>,
    command_tx: mpsc::Sender<CommandEnvelope>,
}

/// Non-blocking cursor subscription over one run's bounded event journal.
///
/// Items remain ordered by their real event `seq`. When the requested cursor
/// has already been evicted, the stream first yields `EventsLagged` with the
/// earliest still-readable `resume_seq`.
pub struct LoopEventStream {
    journal: Arc<EventJournal>,
    wake: WatchStream<u64>,
    next_seq: u64,
    run_id: String,
}

struct EventJournal {
    state: Mutex<EventJournalState>,
    wake: watch::Sender<u64>,
    max_events: usize,
    max_bytes: usize,
}

struct EventJournalState {
    events: VecDeque<BufferedLoopEvent>,
    bytes: usize,
    next_seq: u64,
    last_step: usize,
    closed: bool,
}

struct BufferedLoopEvent {
    event: LoopEvent,
    bytes: usize,
}

impl EventJournal {
    fn new(max_events: usize, max_bytes: usize) -> Arc<Self> {
        let (wake, _) = watch::channel(0);
        Arc::new(Self {
            state: Mutex::new(EventJournalState {
                events: VecDeque::new(),
                bytes: 0,
                next_seq: 1,
                last_step: 0,
                closed: false,
            }),
            wake,
            max_events,
            max_bytes,
        })
    }

    fn subscribe(self: &Arc<Self>, run_id: String, next_seq: u64) -> LoopEventStream {
        LoopEventStream {
            journal: Arc::clone(self),
            wake: WatchStream::new(self.wake.subscribe()),
            next_seq: next_seq.max(1),
            run_id,
        }
    }

    fn append(&self, event: LoopEvent) -> Result<(), serde_json::Error> {
        let bytes = serde_json::to_vec(&event)?.len();
        let generation = {
            let mut state = self.state.lock().expect("event journal mutex poisoned");
            debug_assert_eq!(event.seq, state.next_seq);
            state.next_seq = event.seq.saturating_add(1);
            state.last_step = event.step;
            state.bytes = state.bytes.saturating_add(bytes);
            state.events.push_back(BufferedLoopEvent { event, bytes });
            while state.events.len() > self.max_events || state.bytes > self.max_bytes {
                let removed = state
                    .events
                    .pop_front()
                    .expect("an over-budget event journal is non-empty");
                state.bytes = state.bytes.saturating_sub(removed.bytes);
            }
            state.next_seq
        };
        self.wake.send_replace(generation);
        Ok(())
    }

    fn close(&self) {
        let generation = {
            let mut state = self.state.lock().expect("event journal mutex poisoned");
            state.closed = true;
            state.next_seq
        };
        self.wake.send_replace(generation);
    }
}

impl Stream for LoopEventStream {
    type Item = LoopEvent;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            enum Read {
                Event(Box<LoopEvent>),
                Lagged {
                    missed: u64,
                    resume_seq: u64,
                    step: usize,
                },
                Closed,
                Pending,
            }

            let read = {
                let state = self
                    .journal
                    .state
                    .lock()
                    .expect("event journal mutex poisoned");
                let earliest = state
                    .events
                    .front()
                    .map_or(state.next_seq, |buffered| buffered.event.seq);
                if self.next_seq < earliest {
                    Read::Lagged {
                        missed: earliest - self.next_seq,
                        resume_seq: earliest,
                        step: state
                            .events
                            .front()
                            .map_or(state.last_step, |buffered| buffered.event.step),
                    }
                } else if self.next_seq < state.next_seq {
                    let offset = usize::try_from(self.next_seq - earliest).ok();
                    match offset.and_then(|offset| state.events.get(offset)) {
                        Some(buffered) => Read::Event(Box::new(buffered.event.clone())),
                        None => Read::Lagged {
                            missed: state.next_seq.saturating_sub(self.next_seq),
                            resume_seq: state.next_seq,
                            step: state.last_step,
                        },
                    }
                } else if state.closed {
                    Read::Closed
                } else {
                    Read::Pending
                }
            };

            match read {
                Read::Event(event) => {
                    self.next_seq = event.seq.saturating_add(1);
                    return Poll::Ready(Some(*event));
                }
                Read::Lagged {
                    missed,
                    resume_seq,
                    step,
                } => {
                    self.next_seq = resume_seq;
                    return Poll::Ready(Some(LoopEvent {
                        seq: resume_seq.saturating_sub(1),
                        run_id: self.run_id.clone(),
                        step,
                        kind: LoopEventKind::EventsLagged { missed, resume_seq },
                    }));
                }
                Read::Closed => return Poll::Ready(None),
                Read::Pending => match Pin::new(&mut self.wake).poll_next(context) {
                    Poll::Ready(Some(_)) => continue,
                    Poll::Ready(None) | Poll::Pending => return Poll::Pending,
                },
            }
        }
    }
}

struct CommandEnvelope {
    command: LoopCommand,
    acknowledgement: oneshot::Sender<Result<(), LoopControlError>>,
}

impl LoopRun {
    /// Returns this run as a stream. It can only be consumed once, in order.
    pub fn events(&mut self) -> &mut Self {
        self
    }

    /// Create an additional event subscription beginning at the given next
    /// sequence cursor. A stale cursor receives one explicit lag record before
    /// continuing from the retained journal head.
    pub fn subscribe_events_from(&self, next_seq: u64) -> LoopEventStream {
        self.event_journal.subscribe(self.run_id.clone(), next_seq)
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    /// Sends a live control command and waits until the runner has accepted it.
    /// For message injection and steering, success means the message was queued
    /// for the next applicable model boundary; it is not a durability receipt.
    /// If the run wins a terminal race before handling the command, this returns
    /// [`LoopControlError::Closed`] rather than a false success.
    pub async fn send(&self, command: LoopCommand) -> Result<(), LoopControlError> {
        let (acknowledgement, accepted) = oneshot::channel();
        self.command_tx
            .send(CommandEnvelope {
                command,
                acknowledgement,
            })
            .await
            .map_err(|_| LoopControlError::Closed)?;
        accepted.await.unwrap_or(Err(LoopControlError::Closed))
    }

    pub async fn result(&mut self) -> LoopResult {
        loop {
            if let Some(result) = self.result.borrow().clone() {
                return result;
            }
            if self.result.changed().await.is_err() {
                return LoopResult {
                    status: LoopStatus::Failed,
                    final_text: String::new(),
                    messages: Vec::new(),
                    usage: None,
                    step_usage: Vec::new(),
                    finish_reason: None,
                    error: Some("loop task ended without publishing a result".to_owned()),
                };
            }
        }
    }
}

impl Stream for LoopRun {
    type Item = LoopEvent;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.events).poll_next(context)
    }
}

impl Drop for LoopRun {
    fn drop(&mut self) {
        self.consumer_dropped.store(true, Ordering::Release);
        self.cancellation.cancel();
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct LoopEngine;

impl LoopEngine {
    pub fn start(&self, request: LoopRequest) -> LoopRun {
        let startup_error = request.validate().err().map(|error| error.to_string());
        let run_id = new_run_id();
        let cancellation = CancellationToken::new();
        let consumer_dropped = Arc::new(AtomicBool::new(false));
        // Invalid zero-sized command buffers are reported as normal failed
        // runs rather than panicking inside `tokio::sync::mpsc::channel`.
        let event_journal = EventJournal::new(
            request.config.event_buffer.max(1),
            request.config.event_buffer_bytes.max(1),
        );
        let (command_tx, command_rx) = mpsc::channel(request.config.command_buffer.max(1));
        let (result_tx, result_rx) = watch::channel(None);
        let journal = request.journal_store.clone().map(|store| JournalState {
            store,
            session_id: request.session_id.clone().unwrap_or_else(|| run_id.clone()),
            revision: Revision::ZERO,
            next_seq: 0,
            turn: 0,
            step_open: false,
            turn_open: false,
            last_request_context: None,
            pending_stream_events: Vec::new(),
            pending_stream_fragments: 0,
            stream_batch_started_at: None,
        });
        let checkpoint = request.config.checkpoints.initial();
        let runner = Runner {
            run_id: run_id.clone(),
            checkpoint,
            request,
            cancellation: cancellation.clone(),
            consumer_dropped: Arc::clone(&consumer_dropped),
            event_journal: Arc::clone(&event_journal),
            seq: 0,
            messages: Vec::new(),
            user_request_scope: None,
            final_text: String::new(),
            usage: None,
            step_usage: Vec::new(),
            finish_reason: None,
            pending_continuation: None,
            continuation_text: String::new(),
            output_continuations: 0,
            network_continuations: 0,
            network_backoff: NetworkBackoff::default(),
            network_recovery_deadline: None,
            cumulative_output_tokens: 0,
            step: 0,
            tool_batch_complete: true,
            command_rx,
            command_open: true,
            pending_messages: VecDeque::new(),
            paused: false,
            user_interrupted: false,
            approval_decisions: HashMap::new(),
            closed_approval_calls: HashSet::new(),
            startup_error,
            journal,
            recovered_tool_batch: None,
            overflow_recoveries: 0,
            last_input_tokens: None,
            recent_input_growth: VecDeque::new(),
            failed_compactions: HashMap::new(),
            workset_pressure: false,
            workset_input_sample: None,
            workset_selection: None,
            workset_restored: false,
            workset_reselect: false,
        };
        let runner_journal = Arc::clone(&event_journal);
        tokio::spawn(async move {
            let result = runner.run().await;
            runner_journal.close();
            let _ = result_tx.send(Some(result));
        });
        LoopRun {
            events: event_journal.subscribe(run_id.clone(), 1),
            event_journal,
            run_id,
            result: result_rx,
            cancellation,
            consumer_dropped,
            command_tx,
        }
    }
}

fn new_run_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let sequence = NEXT_RUN_ID.fetch_add(1, Ordering::Relaxed);
    format!("{timestamp}-{sequence}")
}

fn normalize_tool_call_ids(calls: &mut [ToolCall], run_id: &str, step: usize, namespace_all: bool) {
    let mut used = HashSet::with_capacity(calls.len());
    for (ordinal, call) in calls.iter_mut().enumerate() {
        if call.provider_call_id.is_none() && !call.id.is_empty() {
            call.provider_call_id = Some(call.id.clone());
        }
        if !namespace_all && !call.id.is_empty() && used.insert(call.id.clone()) {
            continue;
        }

        let base = format!("xh-{run_id}-{step}-{}-{ordinal}", call.index);
        let mut candidate = base.clone();
        let mut collision = 1usize;
        while !used.insert(candidate.clone()) {
            candidate = format!("{base}-{collision}");
            collision += 1;
        }
        call.id = candidate;
    }
}

fn estimate_message_tokens(message: &AgentMessage) -> Result<u64, RunFailure> {
    let bytes = serde_json::to_vec(message)
        .map_err(|error| RunFailure::Failed(format!("could not price context message: {error}")))?
        .len();
    // Planner-local, conservative pricing only. Hard admission is still
    // performed by the selected provider counter / TokenGuard after the
    // replacement. Dividing UTF-8 bytes by three avoids underpricing CJK and
    // JSON-heavy tool observations while staying provider-neutral.
    Ok(u64::try_from(bytes.saturating_add(2) / 3)
        .unwrap_or(u64::MAX)
        .max(1)
        .saturating_add(
            xharness_token::image_estimate(&[
                serde_json::to_value(message).map_err(|e| RunFailure::Failed(e.to_string()))?
            ])
            .map_err(|e| RunFailure::Failed(e.to_string()))?,
        ))
}

fn continuation_instruction(had_tool_call_fragments: bool, visible_text_is_empty: bool) -> String {
    if had_tool_call_fragments {
        return "The previous assistant output reached its token ceiling while emitting one or more tool calls. Those incomplete calls were discarded and were not executed. Continue from the preserved reasoning, then re-emit every required tool call as a complete, valid call. Do not refer to this recovery instruction.".to_owned();
    }
    if visible_text_is_empty {
        return "Continue the unfinished reasoning from the preceding assistant message without restarting or repeating it. Complete the reasoning and provide the final answer. Do not refer to this recovery instruction.".to_owned();
    }
    "Continue exactly from where the preceding assistant response stopped. Do not repeat already emitted text, and close any unfinished Markdown or code structure naturally. Do not refer to this recovery instruction.".to_owned()
}

fn network_continuation_instruction(had_tool_call_fragments: bool) -> String {
    if had_tool_call_fragments {
        return "The previous assistant stream was interrupted by a network transport failure. Its unfinished tool calls were discarded and were NOT executed. Continue the same task without repeating already emitted text or completed tools. If a tool is still needed, emit a fresh complete call. Do not mention this recovery instruction.".to_owned();
    }
    "The previous assistant stream was interrupted by a network transport failure. Continue the same task from the preserved assistant message without repeating already emitted text or completed tools. This is a new generation, not a byte-exact stream resume. Do not mention this recovery instruction.".to_owned()
}

fn surface_node(seq: u64, message: &AgentMessage) -> Result<SurfaceNode, RunFailure> {
    let tokens = estimate_message_tokens(message)?;
    if !message.tool_calls.is_empty() {
        return Ok(SurfaceNode {
            seq,
            tokens,
            kind: SurfaceNodeKind::AssistantToolCalls {
                call_ids: message
                    .tool_calls
                    .iter()
                    .map(|call| call.id.clone())
                    .collect(),
            },
        });
    }
    if message.role == Role::Tool {
        let call_id = message.tool_call_id.clone().ok_or_else(|| {
            RunFailure::Failed("tool surface message has no provider call id".to_owned())
        })?;
        return Ok(SurfaceNode::tool_result(seq, tokens, call_id));
    }
    Ok(SurfaceNode::plain(seq, tokens))
}

struct Runner {
    checkpoint: xharness_session::ExecutionCheckpointState,
    run_id: String,
    request: LoopRequest,
    cancellation: CancellationToken,
    consumer_dropped: Arc<AtomicBool>,
    event_journal: Arc<EventJournal>,
    seq: u64,
    messages: Vec<AgentMessage>,
    /// Authorization identity is independent of the compacted model surface.
    /// Durable sequence changes on every real user message, including identical text.
    user_request_scope: Option<UserRequestScope>,
    final_text: String,
    usage: Option<TokenUsage>,
    step_usage: Vec<StepUsage>,
    finish_reason: Option<FinishReason>,
    /// Ephemeral, model-facing continuation instruction. It is captured in
    /// request/header for audit but never becomes user transcript history.
    pending_continuation: Option<AgentMessage>,
    continuation_text: String,
    output_continuations: usize,
    /// Bounded automatic continuations of a partially committed transport
    /// stream. A successful model response resets this streak.
    network_continuations: usize,
    network_backoff: NetworkBackoff,
    network_recovery_deadline: Option<tokio::time::Instant>,
    cumulative_output_tokens: u64,
    step: usize,
    tool_batch_complete: bool,
    command_rx: mpsc::Receiver<CommandEnvelope>,
    command_open: bool,
    pending_messages: VecDeque<AgentMessage>,
    paused: bool,
    user_interrupted: bool,
    approval_decisions: HashMap<String, ApprovalDecision>,
    closed_approval_calls: HashSet<String>,
    startup_error: Option<String>,
    journal: Option<JournalState>,
    recovered_tool_batch: Option<RecoveredToolBatch>,
    overflow_recoveries: u32,
    last_input_tokens: Option<u64>,
    recent_input_growth: VecDeque<u64>,
    failed_compactions: HashMap<String, String>,
    workset_pressure: bool,
    workset_selection: Option<crate::context_working_set::StableSelection>,
    workset_restored: bool,
    workset_reselect: bool,
    /// Complete request price before the first disposable projection. Local
    /// byte heuristics select candidates only, and must use comparable units.
    workset_input_sample: Option<(u64, u64)>,
}

struct JournalState {
    store: Arc<dyn EventSessionStore>,
    session_id: String,
    revision: Revision,
    next_seq: u64,
    turn: u32,
    step_open: bool,
    turn_open: bool,
    last_request_context: Option<LoggedRequestContext>,
    /// Model stream deltas are written at bounded checkpoints rather than one
    /// JSONL CAS per provider chunk. The completed assistant message, step
    /// end, retry, or turn finalizer drains any remainder atomically before
    /// advancing the durable lifecycle.
    pending_stream_events: Vec<SessionEvent>,
    /// Raw provider fragment count before adjacent text/reasoning deltas are
    /// coalesced. This preserves a hard live-checkpoint bound even when a
    /// provider emits many tiny tokens faster than the time threshold.
    pending_stream_fragments: usize,
    stream_batch_started_at: Option<Instant>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LoggedRequestContext {
    provider: String,
    model: String,
    context_window: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct UserRequestScope {
    seq: Option<u64>,
    sha256: String,
}

impl UserRequestScope {
    fn new(seq: Option<u64>, message: &AgentMessage) -> Self {
        Self {
            seq,
            sha256: format!("{:x}", Sha256::digest(message.content.as_bytes())),
        }
    }
}

impl Runner {
    async fn run(mut self) -> LoopResult {
        self.debug("run.start", || {
            json!({
                "provider": self.request.provider.provider_name(),
                "model": self.request.provider.model_name(),
                "messageCount": self.request.messages.len(),
                "maxSteps": self.request.config.max_steps,
            })
        })
        .await;
        if let Some(error) = self.startup_error.take() {
            self.messages = self.request.messages.clone();
            let _ = self
                .emit(LoopEventKind::RunFailed {
                    error: error.clone(),
                })
                .await;
            self.debug("run.end", || {
                json!({
                    "status": LoopStatus::Failed,
                    "finalText": "",
                    "messages": &self.messages,
                    "error": &error,
                })
            })
            .await;
            return LoopResult {
                status: LoopStatus::Failed,
                final_text: String::new(),
                messages: self.messages,
                usage: None,
                step_usage: Vec::new(),
                finish_reason: None,
                error: Some(error),
            };
        }

        let outcome = self.run_inner().await;
        let mut provider_failure = None;
        let (mut status, mut error, phase) = match outcome {
            Ok(status) => {
                let phase = match status {
                    LoopStatus::Completed => "completed",
                    LoopStatus::MaxTokens => "max_tokens",
                    LoopStatus::LimitReached => "limit_reached",
                    LoopStatus::Cancelled => "cancelled",
                    LoopStatus::Failed => "failed",
                };
                (status, None, phase)
            }
            Err(RunFailure::Stopped(reason)) => {
                let phase = if reason == StopReason::ConsumerStopped {
                    "consumer_stopped"
                } else {
                    "cancelled"
                };
                if reason == StopReason::Cancelled {
                    let _ = self.emit(LoopEventKind::RunCancelled).await;
                }
                (LoopStatus::Cancelled, None, phase)
            }
            Err(RunFailure::Failed(message)) => {
                let _ = self
                    .emit(LoopEventKind::RunFailed {
                        error: message.clone(),
                    })
                    .await;
                (LoopStatus::Failed, Some(message), "failed")
            }
            Err(RunFailure::Provider { message, failure }) => {
                provider_failure = Some(failure);
                let _ = self
                    .emit(LoopEventKind::RunFailed {
                        error: message.clone(),
                    })
                    .await;
                (LoopStatus::Failed, Some(message), "failed")
            }
            Err(RunFailure::ContextOverflow(message)) => {
                let message = format!(
                    "provider rejected the request for context overflow and recovery did not run: {message}"
                );
                let _ = self
                    .emit(LoopEventKind::RunFailed {
                        error: message.clone(),
                    })
                    .await;
                (LoopStatus::Failed, Some(message), "failed")
            }
        };

        if let Err(journal_error) = self
            .finalize_journal(status, error.as_deref(), provider_failure)
            .await
        {
            status = LoopStatus::Failed;
            error = Some(journal_error.clone());
            let _ = self
                .emit(LoopEventKind::RunFailed {
                    error: journal_error,
                })
                .await;
        }
        let _ = self.snapshot(phase, self.tool_batch_complete).await;
        self.debug("run.end", || {
            json!({
                "status": status,
                "finalText": &self.final_text,
                "messages": &self.messages,
                "usage": &self.usage,
                "stepUsage": &self.step_usage,
                "finishReason": &self.finish_reason,
                "error": &error,
            })
        })
        .await;
        LoopResult {
            status,
            final_text: self.final_text,
            messages: self.messages,
            usage: self.usage,
            step_usage: self.step_usage,
            finish_reason: self.finish_reason,
            error,
        }
    }

    async fn run_inner(&mut self) -> Result<LoopStatus, RunFailure> {
        let has_authoritative_input = self.journal.is_some();
        self.restore_messages().await?;
        self.snapshot("input_saved", true).await?;
        // `restore_messages` atomically flushes the journal prelude (including
        // durable-inbox claim deletions), turn/start and user/message. Publish
        // an explicit boundary before any context preparation or provider I/O
        // so authoritative hosts do not hold the user message until TTFT.
        if has_authoritative_input {
            self.emit(LoopEventKind::InputCommitted).await?;
        }

        if let Some(command_id) = self.request.manual_compaction_command_id.clone() {
            return self.run_manual_compaction(&command_id).await;
        }

        if let Some(recovery) = self.recovered_tool_batch.take() {
            self.tool_batch_complete = false;
            self.resume_tool_batch(recovery).await?;
            self.tool_batch_complete = true;
            self.journal_step_end().await?;
            self.reload_journal_messages().await?;
            self.snapshot("recovered_tool_batch_saved", true).await?;
        }

        'steps: loop {
            self.settle_control_at_boundary().await?;
            self.ensure_running()?;
            // Explicit task budgets stop at a boundary, never manufacture a
            // 1-token model request after the budget has already been exhausted.
            if self.remaining_turn_output_tokens() == Some(0) {
                return self.finish_at_output_limit().await;
            }
            if self.step >= self.request.config.max_steps {
                break;
            }
            if let Some(notice) = crate::checkpoint::issue(
                &mut self.checkpoint,
                &self.request.config.checkpoints,
                self.step,
                self.request.config.max_steps,
            ) {
                self.save_checkpoint(Some(notice)).await?;
            }
            self.step += 1;
            self.journal_step_start().await?;
            let mut pressure_attempted = false;
            let mut working_set_attempted = false;
            let (provider_request, prepared, context_tools, token_budget, context_origins) = loop {
                let tool_definitions = self.tool_definitions().await;
                let context_tools = tool_definitions
                    .iter()
                    .map(serde_json::to_value)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| {
                        RunFailure::Failed(format!("could not serialize tool schema: {error}"))
                    })?;
                let crate::context_composition::PreparedContext {
                    surface: prepared,
                    origins: context_origins,
                } = self
                    .prepare_context(self.messages.clone(), &context_tools)
                    .await?;
                self.debug("context.prepared", || {
                    json!({
                        "surface": &prepared,
                        "tools": &context_tools,
                    })
                })
                .await;
                let mut provider_request = ProviderRequest {
                    messages: prepared.messages.clone(),
                    tools: tool_definitions.clone(),
                    step: self.step,
                    reasoning_effort: self.request.reasoning_effort.clone(),
                    max_output_tokens: self
                        .request
                        .token_guard
                        .as_ref()
                        .map(|guard| guard.budget().reserved_output_tokens),
                    debug_scope: self.debug_scope(),
                };
                match self
                    .check_token_budget(&provider_request, &prepared, &context_tools)
                    .await?
                {
                    TokenBudgetCheck::Ready(report) => {
                        if let Some(report) = &report {
                            if !working_set_attempted
                                && context_tools.iter().any(|t| {
                                    t.get("name").and_then(Value::as_str) == Some("history")
                                })
                                && self
                                    .activate_working_set(
                                        report.estimate.total_input_tokens,
                                        report.context_window_tokens,
                                        &prepared,
                                        &context_tools,
                                    )
                                    .await?
                            {
                                working_set_attempted = true;
                                continue;
                            }
                        }
                        if let Some(report) = &report {
                            let input = report.estimate.total_input_tokens;
                            if let Some(previous) = self.last_input_tokens {
                                if input >= previous {
                                    self.recent_input_growth.push_back(input - previous);
                                    if self.recent_input_growth.len() > 8 {
                                        self.recent_input_growth.pop_front();
                                    }
                                } else {
                                    self.recent_input_growth.clear();
                                }
                            }
                            self.last_input_tokens = Some(input);
                        }
                        if !pressure_attempted {
                            pressure_attempted = true;
                            if let Some(report) = report.as_ref() {
                                match self
                                    .try_compact(
                                        CompactionTrigger::Pressure,
                                        report.estimate.total_input_tokens,
                                        report.context_window_tokens,
                                        &context_tools,
                                        None,
                                    )
                                    .await
                                {
                                    Ok(CompactionOutcome::Applied) => continue,
                                    Ok(CompactionOutcome::Interrupted) => {
                                        self.journal_step_end().await?;
                                        self.settle_control_at_boundary().await?;
                                        continue 'steps;
                                    }
                                    Ok(CompactionOutcome::Skipped(_)) => continue,
                                    Ok(CompactionOutcome::NotApplied) => {}
                                    Err(error) => {
                                        self.debug(
                                            "compaction.pressure_failed",
                                            || json!({"error": error.to_string()}),
                                        )
                                        .await;
                                        return Err(error);
                                    }
                                }
                            }
                        }
                        if let Some(report) = report.as_ref() {
                            provider_request.max_output_tokens =
                                Some(report.selected_output_tokens);
                        }
                        // A fresh request gets the route's full safe per-call
                        // allowance. Only an explicitly configured task budget
                        // may reduce it; apply that budget even without a guard.
                        if let Some(remaining) = self.remaining_turn_output_tokens() {
                            provider_request.max_output_tokens = Some(
                                provider_request
                                    .max_output_tokens
                                    .map_or(remaining, |limit| limit.min(remaining)),
                            );
                        }
                        break (
                            provider_request,
                            prepared,
                            context_tools,
                            report,
                            context_origins,
                        );
                    }
                    TokenBudgetCheck::Exceeded {
                        current_input_tokens,
                        context_window_tokens,
                        error,
                    } => {
                        if !working_set_attempted
                            && context_tools
                                .iter()
                                .any(|t| t.get("name").and_then(Value::as_str) == Some("history"))
                            && self
                                .activate_working_set(
                                    current_input_tokens,
                                    context_window_tokens,
                                    &prepared,
                                    &context_tools,
                                )
                                .await?
                        {
                            working_set_attempted = true;
                            continue;
                        }
                        let maximum = self
                            .request
                            .compaction
                            .as_ref()
                            .map(|config| config.max_overflow_retries.saturating_add(1))
                            .unwrap_or(0);
                        if self.overflow_recoveries < maximum {
                            self.overflow_recoveries = self.overflow_recoveries.saturating_add(1);
                            match self
                                .try_compact(
                                    CompactionTrigger::ContextOverflow,
                                    current_input_tokens,
                                    context_window_tokens,
                                    &context_tools,
                                    None,
                                )
                                .await
                            {
                                Ok(CompactionOutcome::Applied) => continue,
                                Ok(CompactionOutcome::Interrupted) => {
                                    self.journal_step_end().await?;
                                    self.settle_control_at_boundary().await?;
                                    continue 'steps;
                                }
                                Ok(
                                    CompactionOutcome::NotApplied | CompactionOutcome::Skipped(_),
                                ) => {}
                                Err(error @ RunFailure::Stopped(_)) => return Err(error),
                                Err(compaction_error) => {
                                    let message = format!("token budget rejected request: {error}; overflow compaction failed: {compaction_error}");
                                    return Err(compaction_error.context(message));
                                }
                            }
                        }
                        return Err(RunFailure::Failed(format!(
                            "token budget rejected request: {error}; no further safe compaction was available"
                        )));
                    }
                    TokenBudgetCheck::Interrupted => {
                        self.journal_step_end().await?;
                        self.settle_control_at_boundary().await?;
                        continue 'steps;
                    }
                }
            };
            if self.request.debug.enabled() {
                self.debug("provider.request.prepared", || {
                    json!({
                        "request": {
                            "messages": &provider_request.messages,
                            "tools": &provider_request.tools,
                            "step": provider_request.step,
                            "maxOutputTokens": provider_request.max_output_tokens,
                        },
                        "tokenBudget": &token_budget,
                    })
                })
                .await;
            }
            self.journal_request_header(
                &prepared,
                &context_tools,
                token_budget.as_ref(),
                &context_origins,
            )
            .await?;

            let mut model = match self.model_round(provider_request).await {
                Ok(model) => model,
                Err(RunFailure::ContextOverflow(message)) => {
                    let maximum = self
                        .request
                        .compaction
                        .as_ref()
                        .map(|config| config.max_overflow_retries.saturating_add(1))
                        .unwrap_or(0);
                    let context_window_tokens = self
                        .request
                        .token_guard
                        .as_ref()
                        .map(|guard| guard.budget().context_window_tokens)
                        .unwrap_or_default();
                    if self.overflow_recoveries >= maximum || context_window_tokens == 0 {
                        return Err(RunFailure::ContextOverflow(message));
                    }
                    self.overflow_recoveries = self.overflow_recoveries.saturating_add(1);
                    match self
                        .try_compact(
                            CompactionTrigger::ContextOverflow,
                            context_window_tokens,
                            context_window_tokens,
                            &context_tools,
                            None,
                        )
                        .await
                    {
                        Ok(CompactionOutcome::Applied | CompactionOutcome::Interrupted) => {
                            self.journal_step_end().await?;
                            self.settle_control_at_boundary().await?;
                            continue 'steps;
                        }
                        Ok(CompactionOutcome::NotApplied | CompactionOutcome::Skipped(_)) => {
                            return Err(RunFailure::ContextOverflow(message));
                        }
                        Err(error @ RunFailure::Stopped(_)) => return Err(error),
                        Err(error) => {
                            let message = format!(
                                "provider context overflow: {message}; recovery failed: {error}"
                            );
                            return Err(error.context(message));
                        }
                    }
                }
                Err(error) => return Err(error),
            };
            // An ephemeral continuation instruction is consumed only after a
            // provider request completes. Context-overflow recovery therefore
            // retains it across compaction and retries.
            self.pending_continuation = None;
            // The durable session contract requires call ids to be globally
            // unique, while providers only guarantee identity within a single
            // response. Journal-backed runs therefore use harness execution
            // ids unconditionally. Raw provider ids remain in stream chunks.
            normalize_tool_call_ids(
                &mut model.calls,
                &self.run_id,
                self.step,
                self.journal.is_some(),
            );

            if model.interrupted {
                let network_error = model.recoverable_transport_error.take();
                let had_tool_fragments = !model.calls_by_index.is_empty();
                if !model.text.is_empty() || !model.reasoning.is_empty() {
                    if network_error.is_some() {
                        self.continuation_text.push_str(&model.text);
                        self.final_text = self.continuation_text.clone();
                    } else {
                        self.final_text = model.text.clone();
                    }
                    self.messages.push(AgentMessage {
                        content_blocks: Vec::new(),
                        id: None,
                        role: Role::Assistant,
                        content: model.text,
                        reasoning: model.reasoning,
                        tool_calls: Vec::new(),
                        tool_call_id: None,
                        provider_items: Vec::new(),
                        interrupted: true,
                    });
                    let message = self
                        .messages
                        .last()
                        .cloned()
                        .expect("interrupted assistant was just appended");
                    self.journal_assistant_message(&message, None).await?;
                    self.snapshot("assistant_interrupted", true).await?;
                }
                if let Some(error) = network_error {
                    // The partial assistant has been committed before another
                    // model request can start. A failed wait retains it in the
                    // journal without creating a synthetic user turn.
                    self.network_continuations = self.network_continuations.saturating_add(1);
                    let mut recovery = RetryState::with_deadline(self.network_recovery_deadline);
                    let entropy = self.retry_entropy();
                    let plan = recovery
                        .next(
                            &self.request.config,
                            &error,
                            entropy,
                            &mut self.network_backoff,
                        )
                        .map_err(|message| RunFailure::provider(&error, message))?
                        .ok_or_else(|| RunFailure::provider(&error, error.diagnostic_message()))?;
                    let steered = self
                        .wait_model_retry(plan, &error, recovery.deadline, true)
                        .await?;
                    self.network_recovery_deadline = recovery.deadline;
                    self.journal_step_end().await?;
                    if steered {
                        self.network_continuations = 0;
                        self.network_recovery_deadline = None;
                        self.continuation_text.clear();
                        self.settle_control_at_boundary().await?;
                        continue 'steps;
                    }
                    self.pending_continuation = Some(AgentMessage::user(
                        network_continuation_instruction(had_tool_fragments),
                    ));
                    continue 'steps;
                }
                self.journal_step_end().await?;
                self.settle_control_at_boundary().await?;
                continue;
            }

            self.network_continuations = 0;
            self.network_recovery_deadline = None;
            self.network_backoff.reset();

            let finish_reason_was_explicit = model.finish_reason.is_some();
            let finish_reason = match model.finish_reason.take() {
                Some(reason) => reason,
                None if model.calls.is_empty() => FinishReason::Stop,
                None => FinishReason::ToolCalls,
            };
            let reached_output_limit = finish_reason == FinishReason::Length;
            let finish_error = if finish_reason_was_explicit
                && finish_reason == FinishReason::Stop
                && !model.calls.is_empty()
            {
                Some(
                    "model protocol mismatch: finish reason was stop but tool calls were emitted"
                        .to_owned(),
                )
            } else if !finish_reason.is_success() && !reached_output_limit {
                Some(format!(
                    "model output was not complete: {}",
                    finish_reason.description()
                ))
            } else if finish_reason == FinishReason::ToolCalls && model.calls.is_empty() {
                Some("model finished for tool calls but emitted no tool call".to_owned())
            } else {
                None
            };
            let assistant = AgentMessage {
                content_blocks: Vec::new(),
                id: None,
                role: Role::Assistant,
                content: model.text.clone(),
                reasoning: model.reasoning,
                tool_calls: if finish_error.is_none() && !reached_output_limit {
                    model.calls.clone()
                } else {
                    Vec::new()
                },
                tool_call_id: None,
                // Provider replay envelopes can contain the same incomplete
                // tool-call blocks. Until adapters expose block-level replay
                // pruning, dropping the envelope is the only safe portable
                // choice for max-token continuations.
                provider_items: if reached_output_limit {
                    Vec::new()
                } else {
                    model.provider_items
                },
                interrupted: finish_error.is_some(),
            };
            self.journal_assistant_message(&assistant, model.usage.clone())
                .await?;
            if reached_output_limit || !self.continuation_text.is_empty() {
                self.continuation_text.push_str(&model.text);
                self.final_text = self.continuation_text.clone();
                if !reached_output_limit {
                    // The continuation sequence ends with this step. The buffer
                    // belongs to the message that was truncated, so a later step
                    // starts its own text instead of being glued onto it.
                    self.continuation_text.clear();
                }
            } else {
                self.final_text = model.text.clone();
            }
            self.messages.push(assistant);
            self.snapshot("assistant_saved", true).await?;

            if let Some(error) = finish_error {
                self.journal_step_end().await?;
                return Err(RunFailure::Failed(error));
            }

            if reached_output_limit {
                self.journal_step_end().await?;
                // An empty truncated response provides nothing to continue.
                // Fail visibly instead of spinning unlimited paid requests.
                let last = self.messages.last().expect("assistant just saved");
                if model.calls.is_empty() && last.content.is_empty() && last.reasoning.is_empty() {
                    return Err(RunFailure::Failed(
                        "provider reported an output-token limit without resumable text, reasoning, or tool-call fragments".into(),
                    ));
                }
                let within_turn_budget = self.remaining_turn_output_tokens() != Some(0);
                if self
                    .request
                    .config
                    .max_output_continuations
                    .is_none_or(|limit| self.output_continuations < limit)
                    && within_turn_budget
                {
                    self.output_continuations = self.output_continuations.saturating_add(1);
                    self.pending_continuation = Some(AgentMessage::user(continuation_instruction(
                        !model.calls.is_empty(),
                        model.text.is_empty(),
                    )));
                    self.emit(LoopEventKind::OutputContinuationScheduled {
                        attempt: self.output_continuations,
                        max_attempts: self.request.config.max_output_continuations,
                        cumulative_output_tokens: self.cumulative_output_tokens,
                    })
                    .await?;
                    continue 'steps;
                }
                return self.finish_at_output_limit().await;
            }

            if self.checkpoint.pending_notice.is_some() {
                self.ensure_running()?;
                let notice = crate::checkpoint::consume(
                    &mut self.checkpoint,
                    &self.request.config.checkpoints,
                    self.step,
                    self.request.config.max_steps,
                    !model.calls.is_empty(),
                );
                self.save_checkpoint(notice).await?;
            }

            if model.calls.is_empty() {
                self.journal_step_end().await?;
                if self.settle_control_at_boundary().await? {
                    continue;
                }
                self.emit(LoopEventKind::RunCompleted {
                    text: self.final_text.clone(),
                })
                .await?;
                return Ok(LoopStatus::Completed);
            }

            self.tool_batch_complete = false;
            self.snapshot("tool_batch_started", false).await?;
            self.execute_tool_batch(model.calls).await?;
            self.tool_batch_complete = true;
            self.journal_step_end().await?;
            self.snapshot("tool_batch_saved", true).await?;
        }

        self.emit(LoopEventKind::LimitReached).await?;
        Ok(LoopStatus::LimitReached)
    }

    fn remaining_turn_output_tokens(&self) -> Option<u64> {
        self.request
            .config
            .max_turn_output_tokens
            .map(|limit| limit.saturating_sub(self.cumulative_output_tokens))
    }

    async fn finish_at_output_limit(&mut self) -> Result<LoopStatus, RunFailure> {
        self.emit(LoopEventKind::RunMaxTokens {
            text: self.final_text.clone(),
            continuations: self.output_continuations,
            cumulative_output_tokens: self.cumulative_output_tokens,
        })
        .await?;
        Ok(LoopStatus::MaxTokens)
    }

    fn record_model_completion(&mut self, usage: Option<TokenUsage>, finish_reason: FinishReason) {
        self.finish_reason = Some(finish_reason.clone());
        let Some(usage) = usage else {
            return;
        };
        self.cumulative_output_tokens = self
            .cumulative_output_tokens
            .saturating_add(usage.output_tokens)
            .saturating_add(usage.reasoning_tokens);
        self.usage
            .get_or_insert_with(TokenUsage::default)
            .saturating_add_assign(&usage);
        self.step_usage.push(StepUsage {
            step: self.step,
            usage,
            finish_reason,
        });
    }

    // Shared by normal requests and pre-commit compaction admission. Keeping
    // policy, continuations and runtime notices identical avoids undercounting
    // a candidate that would grow again immediately after its replacement.
    async fn prepare_context(
        &mut self,
        context_messages: Vec<AgentMessage>,
        context_tools: &[Value],
    ) -> Result<crate::context_composition::PreparedContext, RunFailure> {
        let mut origins = Vec::new();
        let mut attribution = Vec::new();
        let mut working_plan = None;
        {
            if let Some(journal) = &self.journal {
                let session = journal
                    .store
                    .load(&journal.session_id)
                    .await
                    .map_err(|error| {
                        RunFailure::Failed(format!("working set journal load failed: {error}"))
                    })?
                    .ok_or_else(|| RunFailure::Failed("working set session disappeared".into()))?;
                if !self.workset_restored {
                    self.workset_selection =
                        session
                            .events()
                            .iter()
                            .rev()
                            .find_map(|event| {
                                if let SessionEventData::RequestHeader { header } = event.data() {
                                    Some(header.options.get("workingSetSelection").and_then(
                                        crate::context_working_set::StableSelection::restore,
                                    ))
                                } else {
                                    None
                                }
                            })
                            .flatten();
                    self.workset_restored = true;
                }
                working_plan = xharness_session::session_plan(&session);
                let surface = session.derive_surface_messages();
                attribution = crate::context_composition::aligned_origins(
                    &session,
                    &surface,
                    &context_messages,
                );
                let sources = crate::context_working_set::sources(&session, &surface);
                origins =
                    crate::context_working_set::aligned(&context_messages, &surface, &sources);
            }
        }
        let history_available = context_tools
            .iter()
            .any(|tool| tool.get("name").and_then(Value::as_str) == Some("history"));
        let working = if history_available && !origins.is_empty() {
            if let Some(selection) = &self.workset_selection {
                if !selection
                    .matches(&context_messages, &origins)
                    .map_err(|error| RunFailure::Failed(error.to_string()))?
                {
                    // Compaction/edit/prompt changes invalidate the optional cache.
                    // Count the new full surface before deciding whether to retire.
                    self.workset_selection = None;
                    self.workset_pressure = false;
                    self.workset_reselect = false;
                    self.workset_input_sample = None;
                }
            }
            if !self.workset_reselect {
                if let Some(selection) = &self.workset_selection {
                    match xharness_context::reuse_working_set(
                        context_messages.clone(),
                        &origins,
                        selection.ranges(),
                    ) {
                        Ok(working) => working,
                        Err(_) => {
                            // Optional saved metadata must not break a valid chat.
                            // Preserve all input and let admission decide again.
                            self.workset_selection = None;
                            self.workset_pressure = false;
                            self.workset_input_sample = None;
                            ContextSurface::identity(context_messages)
                        }
                    }
                } else {
                    ContextSurface::identity(context_messages)
                }
            } else {
                let working = self.project_working_set_retaining(
                    context_messages.clone(),
                    &origins,
                    context_tools,
                )?;
                self.workset_selection = crate::context_working_set::StableSelection::capture(
                    &context_messages,
                    &origins,
                    &working,
                )
                .map_err(|error| RunFailure::Failed(error.to_string()))?;
                self.workset_reselect = false;
                working
            }
        } else {
            ContextSurface::identity(context_messages)
        };
        self.prepare_context_with_working(
            working,
            context_tools,
            &origins,
            &attribution,
            working_plan.as_ref(),
        )
        .await
    }

    async fn prepare_context_with_working(
        &self,
        working: ContextSurface,
        context_tools: &[Value],
        origins: &[Option<xharness_context::WorkingSetSource>],
        attribution: &[xharness_token::ContextMessageOrigin],
        working_plan: Option<&xharness_session::SessionPlan>,
    ) -> Result<crate::context_composition::PreparedContext, RunFailure> {
        let working_attribution =
            crate::context_composition::project_origins(attribution, &working);
        let mut context_request = ContextRequest::new(working.messages.clone())
            .with_target(
                self.request.provider.provider_name(),
                self.request.provider.model_name(),
            )
            .with_step(self.step)
            .with_tools(context_tools.to_vec())
            .with_tool_result_limit_bytes(self.request.config.tool_result_limit_bytes);
        if origins.len() == working.source_message_count {
            let mut genuine = Vec::new();
            let mut source = 0usize;
            let mut output = 0usize;
            for edit in &working.edits {
                while source < edit.source_start {
                    if origins[source]
                        .is_some_and(|s| s.kind == xharness_context::WorkingSetSourceKind::RawUser)
                    {
                        genuine.push(output);
                    }
                    source += 1;
                    output += 1;
                }
                source = edit.source_end;
                output += edit.replacement_messages;
            }
            while source < origins.len() {
                if origins[source]
                    .is_some_and(|s| s.kind == xharness_context::WorkingSetSourceKind::RawUser)
                {
                    genuine.push(output);
                }
                source += 1;
                output += 1;
            }
            context_request = context_request.with_genuine_user_indices(genuine);
        }
        let mut prepared = self
            .request
            .context_policy
            .prepare(context_request)
            .await
            .map_err(|error| RunFailure::Failed(error.to_string()))?;
        prepared
            .validate()
            .map_err(|error| RunFailure::Failed(error.to_string()))?;
        self.validate_prompt_surface(&prepared)?;
        let mut attribution =
            crate::context_composition::project_origins(&working_attribution, &prepared);
        if !working.edits.is_empty() {
            // Keep source-coordinate retirement evidence in a separate audited
            // surface, rather than mixing two policies' incompatible indexes.
            // Final wire content remains policy output; identity edit is a
            // single valid composite mapping to the original source.
            prepared.edits = vec![xharness_context::SurfaceEdit::new(
                0,
                working.source_message_count,
                prepared.messages.len(),
                xharness_context::SurfaceEditKind::Custom("working_set_and_context_policy".into()),
            )];
            prepared.source_message_count = working.source_message_count;
            prepared.policy =
                xharness_context::ContextPolicyId::new("working-set-and-context-policy", 1);
            prepared
                .validate()
                .map_err(|error| RunFailure::Failed(error.to_string()))?;
        }
        // Account for exactly the image references that will be sent on the
        // wire. In particular, a long conversation must not fail forever once
        // its accumulated attachments exceed one request's resource budget.
        prepared.defer_images_over_budget(crate::MAX_REQUEST_IMAGE_BYTES);
        if let Some(note) =
            crate::plan_context::snapshot(&prepared.messages, working_plan, context_tools)
        {
            let index = crate::plan_context::insert(&mut prepared.messages, note);
            attribution.insert(index, xharness_token::ContextMessageOrigin::RuntimeContext);
        }
        if let Some(continuation) = self.pending_continuation.clone() {
            prepared.messages.push(continuation);
            attribution.push(xharness_token::ContextMessageOrigin::RuntimeContext);
        }
        // Runtime controls are transient, not new user history. Add AFTER
        // policy projection so compaction/custom policies cannot remove
        // an unconsumed notice, and BEFORE admission/counting/audit.
        // A user-role control note keeps the assembled system prompt
        // immutable and works with providers requiring one initial system.
        if let Some(notice) = &self.checkpoint.pending_notice {
            prepared.messages.push(
                AgentMessage::user(notice.clone())
                    .with_id(format!("execution-notice-{}-{}", self.run_id, self.step)),
            );
        }
        if self.checkpoint.pending_notice.is_some() {
            attribution.push(xharness_token::ContextMessageOrigin::RuntimeContext);
        }
        Ok(crate::context_composition::PreparedContext {
            surface: prepared,
            origins: attribution,
        })
    }

    fn project_working_set(
        &self,
        messages: Vec<AgentMessage>,
        sources: &[Option<xharness_context::WorkingSetSource>],
        tools: &[Value],
    ) -> Result<ContextSurface, RunFailure> {
        self.project_working_set_ranges(messages, sources, tools, &[])
    }

    fn project_working_set_retaining(
        &self,
        messages: Vec<AgentMessage>,
        sources: &[Option<xharness_context::WorkingSetSource>],
        tools: &[Value],
    ) -> Result<ContextSurface, RunFailure> {
        self.project_working_set_ranges(
            messages,
            sources,
            tools,
            self.workset_selection
                .as_ref()
                .map_or(&[], |selection| selection.ranges()),
        )
    }

    fn project_working_set_ranges(
        &self,
        messages: Vec<AgentMessage>,
        sources: &[Option<xharness_context::WorkingSetSource>],
        tools: &[Value],
        retired_ranges: &[(usize, usize)],
    ) -> Result<ContextSurface, RunFailure> {
        let available = self
            .request
            .token_guard
            .as_ref()
            .map_or(0, |g| g.budget().available_input_tokens());
        let recent = self
            .request
            .compaction
            .as_ref()
            .and_then(|config| {
                config
                    .resolve(
                        ModelTarget::new(
                            self.request.provider.provider_name(),
                            self.request.provider.model_name().unwrap_or("unknown"),
                        ),
                        self.request
                            .token_guard
                            .as_ref()?
                            .budget()
                            .context_window_tokens,
                    )
                    .ok()
            })
            .map_or(available / 5, |spec| spec.retain_tokens);
        let (local, measured) = self.workset_input_sample.unwrap_or((0, 0));
        let calibrated =
            |tokens| xharness_context::calibrate_working_set_tokens(tokens, local, measured);
        let tool_cost = local_tool_cost(tools)?;
        xharness_context::project_working_set_retaining(
            messages,
            sources,
            &xharness_context::WorkingSetConfig {
                pressure: self.workset_pressure,
                available_input_tokens: calibrated(available.saturating_mul(3) / 5)
                    .saturating_sub(tool_cost),
                recent_tokens: calibrated(recent.min(available / 2)),
                hot_input_budget: Some(calibrated(available).saturating_sub(tool_cost)),
                retain_checkpoints: 2,
            },
            retired_ranges,
        )
        .map_err(|error| RunFailure::Failed(error.to_string()))
    }

    async fn activate_working_set(
        &mut self,
        input: u64,
        context: u64,
        prepared: &ContextSurface,
        tools: &[Value],
    ) -> Result<bool, RunFailure> {
        if self.workset_reselect || self.journal.is_none() {
            return Ok(false);
        }
        let Some(config) = &self.request.compaction else {
            return Ok(false);
        };
        if !config.auto {
            return Ok(false);
        }
        let available = self
            .request
            .token_guard
            .as_ref()
            .map_or(context, |g| g.budget().available_input_tokens());
        let threshold = config
            .resolve(
                ModelTarget::new(
                    self.request.provider.provider_name(),
                    self.request.provider.model_name().unwrap_or("unknown"),
                ),
                context,
            )
            .map_or(available.saturating_mul(4) / 5, |spec| {
                spec.threshold_tokens.min(available.saturating_mul(4) / 5)
            });
        if input >= threshold {
            // Paired prices cover the SAME COMPLETE request, including schemas
            // and the exact policy output/transient notes counted by the guard.
            let local = xharness_context::approximate_working_set_tokens(&prepared.messages)
                .map_err(|error| RunFailure::Failed(error.to_string()))?
                .saturating_add(local_tool_cost(tools)?);
            self.workset_pressure = true;
            self.workset_reselect = true;
            self.workset_input_sample = Some((local, input));
            return Ok(true);
        }
        Ok(false)
    }

    fn validate_prompt_surface(&self, surface: &ContextSurface) -> Result<(), RunFailure> {
        let Some(prompt) = &self.request.prompt else {
            return Ok(());
        };
        let systems = surface
            .messages
            .iter()
            .filter(|message| message.role == Role::System)
            .collect::<Vec<_>>();
        if systems.len() != 1
            || surface.messages.first() != systems.first().copied()
            || systems[0].content != prompt.system()
        {
            return Err(RunFailure::Failed(
                "context policy removed, duplicated, reordered, or modified the assembled system prompt"
                    .to_owned(),
            ));
        }
        Ok(())
    }

    async fn check_token_budget(
        &mut self,
        provider_request: &ProviderRequest,
        surface: &ContextSurface,
        tools: &[Value],
    ) -> Result<TokenBudgetCheck, RunFailure> {
        let Some(guard) = &self.request.token_guard else {
            return Ok(TokenBudgetCheck::Ready(None));
        };
        let guard = guard.clone();
        let provider_cancellation = self.cancellation.child_token();
        let provider = self.request.provider.clone();
        let mut count_future = Box::pin(tokio::time::timeout(
            guard.counter_timeout(),
            provider.count_input_tokens(provider_request, provider_cancellation.clone()),
        ));
        let mut fallback_reason = None;
        let provider_count = loop {
            enum CountProgress {
                Command(Option<CommandEnvelope>),
                Ready(Result<Option<crate::ProviderInputTokenCount>, ProviderError>),
            }
            let progress = tokio::select! {
                _ = self.cancellation.cancelled() => return Err(self.stopped_failure()),
                command = self.command_rx.recv(), if self.command_open => {
                    CountProgress::Command(command)
                }
                count = &mut count_future => CountProgress::Ready(match count {
                    Ok(result)=>result,
                    Err(_)=> { provider_cancellation.cancel(); Err(ProviderError::retryable("input count deadline exceeded")) },
                }),
            };
            match progress {
                CountProgress::Ready(count) => match count {
                    Ok(value) => break value,
                    Err(error) if error.is_context_overflow() => {
                        // A native counter may reject an oversized request before
                        // returning a number. This is a hard overflow signal,
                        // never an auth/general-400 fallback or permission to send.
                        provider_cancellation.cancel();
                        return Ok(TokenBudgetCheck::Exceeded {
                            current_input_tokens: guard.budget().context_window_tokens,
                            context_window_tokens: guard.budget().context_window_tokens,
                            error: format!("provider counter rejected context: {error}"),
                        });
                    }
                    Err(error) if error.retryable && guard.allows_counter_fallback() => {
                        fallback_reason = Some("transient_counter_failure".to_owned());
                        provider.input_counter_failed();
                        self.debug("token_count.fallback",|| json!({"reason":"transient_counter_failure","status":error.http_status})).await;
                        break None;
                    }
                    Err(error) => {
                        return Err(RunFailure::Failed(format!(
                            "provider input token count failed: {error}"
                        )))
                    }
                },
                CountProgress::Command(Some(envelope)) => {
                    let interrupt = self.handle_envelope(envelope, true).await?;
                    if interrupt || self.paused {
                        provider_cancellation.cancel();
                        return Ok(TokenBudgetCheck::Interrupted);
                    }
                }
                CountProgress::Command(None) => self.command_open = false,
            }
        };
        if let Some(count) = provider_count.or_else(|| {
            guard
                .allows_provider_estimate()
                .then(|| provider.estimate_input_tokens(provider_request))
                .flatten()
        }) {
            return match guard.check_provider_count(&count) {
                Ok(mut report) => {
                    report.fallback_reason = fallback_reason.clone();
                    Ok(TokenBudgetCheck::Ready(Some(report)))
                }
                Err(
                    error @ TokenBudgetError::Exceeded {
                        estimated_input_tokens,
                        context_window_tokens,
                        ..
                    },
                ) => Ok(TokenBudgetCheck::Exceeded {
                    current_input_tokens: estimated_input_tokens,
                    context_window_tokens,
                    error: error.to_string(),
                }),
                Err(error) => Err(RunFailure::Failed(format!(
                    "token budget rejected request: {error}"
                ))),
            };
        }
        let mut system_messages = Vec::new();
        let mut conversation_messages = Vec::new();
        for message in &surface.messages {
            let encoded = serde_json::to_value(message).map_err(|error| {
                RunFailure::Failed(format!(
                    "could not serialize message for token guard: {error}"
                ))
            })?;
            if message.role == Role::System {
                system_messages.push(encoded);
            } else {
                conversation_messages.push(encoded);
            }
        }
        match guard.check(&TokenEstimateRequest {
            provider: self.request.provider.provider_name().to_owned(),
            model: self.request.provider.model_name().map(str::to_owned),
            system_messages,
            conversation_messages,
            tools: tools.to_vec(),
        }) {
            Ok(mut report) => {
                report.fallback_reason = fallback_reason.clone();
                Ok(TokenBudgetCheck::Ready(Some(report)))
            }
            Err(
                error @ TokenBudgetError::Exceeded {
                    estimated_input_tokens,
                    context_window_tokens,
                    ..
                },
            ) => Ok(TokenBudgetCheck::Exceeded {
                current_input_tokens: estimated_input_tokens,
                context_window_tokens,
                error: error.to_string(),
            }),
            Err(error) => Err(RunFailure::Failed(format!(
                "token budget rejected request: {error}"
            ))),
        }
    }

    async fn run_manual_compaction(&mut self, command_id: &str) -> Result<LoopStatus, RunFailure> {
        self.workset_pressure = true;
        self.workset_reselect = true;
        let outcome = async {
            let tool_definitions = self.tool_definitions().await;
            let context_tools = tool_definitions
                .iter()
                .map(serde_json::to_value)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| {
                    RunFailure::Failed(format!("could not serialize tool schema: {error}"))
                })?;
            let prepared = self
                .prepare_context(self.messages.clone(), &context_tools)
                .await?
                .surface;
            let provider_request = ProviderRequest {
                messages: prepared.messages.clone(),
                tools: tool_definitions,
                step: self.step,
                reasoning_effort: self.request.reasoning_effort.clone(),
                max_output_tokens: self
                    .request
                    .token_guard
                    .as_ref()
                    .map(|guard| guard.budget().reserved_output_tokens),
                debug_scope: self.debug_scope(),
            };
            let (current_input_tokens, context_window_tokens) = match self
                .check_token_budget(&provider_request, &prepared, &context_tools)
                .await?
            {
                TokenBudgetCheck::Ready(Some(report)) => (
                    report.estimate.total_input_tokens,
                    report.context_window_tokens,
                ),
                TokenBudgetCheck::Ready(None) => {
                    return Err(RunFailure::Failed(
                        "manual compaction requires an active token guard".to_owned(),
                    ))
                }
                TokenBudgetCheck::Exceeded {
                    current_input_tokens,
                    context_window_tokens,
                    ..
                } => (current_input_tokens, context_window_tokens),
                TokenBudgetCheck::Interrupted => {
                    return Err(RunFailure::Stopped(StopReason::Cancelled))
                }
            };
            self.try_compact(
                CompactionTrigger::Manual,
                current_input_tokens,
                context_window_tokens,
                &context_tools,
                Some(command_id),
            )
            .await
        }
        .await;

        match outcome {
            Ok(CompactionOutcome::Applied) => {
                self.journal_append(
                    vec![SessionEventData::CommandDone {
                        command_id: command_id.to_owned(),
                        kind: CommandResultKind::Success,
                        text: Some("Context compacted".to_owned()),
                        source_event_seq: None,
                    }],
                    true,
                )
                .await?;
                Ok(LoopStatus::Completed)
            }
            Ok(CompactionOutcome::NotApplied | CompactionOutcome::Skipped(_)) => {
                self.journal_append(
                    vec![SessionEventData::CommandDone {
                        command_id: command_id.to_owned(),
                        kind: CommandResultKind::Success,
                        text: Some("Compaction not applied; original history retained".to_owned()),
                        source_event_seq: None,
                    }],
                    true,
                )
                .await?;
                Ok(LoopStatus::Completed)
            }
            Ok(CompactionOutcome::Interrupted) => {
                let error = "Compaction was interrupted".to_owned();
                self.journal_append(
                    vec![SessionEventData::CommandDone {
                        command_id: command_id.to_owned(),
                        kind: CommandResultKind::Error,
                        text: Some(error.clone()),
                        source_event_seq: None,
                    }],
                    true,
                )
                .await?;
                Err(RunFailure::Failed(error))
            }
            Err(error) => {
                self.journal_append(
                    vec![SessionEventData::CommandDone {
                        command_id: command_id.to_owned(),
                        kind: CommandResultKind::Error,
                        text: Some(error.to_string()),
                        source_event_seq: None,
                    }],
                    true,
                )
                .await?;
                Err(error)
            }
        }
    }

    async fn try_compact(
        &mut self,
        trigger: CompactionTrigger,
        current_input_tokens: u64,
        context_window_tokens: u64,
        context_tools: &[Value],
        source_command_id: Option<&str>,
    ) -> Result<CompactionOutcome, RunFailure> {
        let Some(config) = self.request.compaction.clone() else {
            return Ok(CompactionOutcome::NotApplied);
        };
        let Some(journal) = self.journal.as_ref() else {
            return Err(RunFailure::Failed(
                "compaction requires an append-only session journal".to_owned(),
            ));
        };
        let store = Arc::clone(&journal.store);
        let session_id = journal.session_id.clone();
        let session = store
            .load(&session_id)
            .await
            .map_err(|error| {
                RunFailure::Failed(format!("compaction session load failed: {error}"))
            })?
            .ok_or_else(|| {
                RunFailure::Failed("compaction session disappeared before planning".to_owned())
            })?;
        let surface = session.derive_surface_messages();
        let origins = crate::context_working_set::sources(&session, &surface);
        let mut protected = crate::context_working_set::protected(&surface, &origins);
        let mut nodes = surface
            .iter()
            .map(|node| {
                if let Some(SessionEventData::ToolResult { result, .. }) =
                    session.events().get(node.seq as usize).map(|e| e.data())
                {
                    return Ok(SurfaceNode::tool_result(
                        node.seq,
                        estimate_message_tokens(&node.message)?,
                        result.call_id.clone(),
                    ));
                }
                surface_node(node.seq, &node.message)
            })
            .collect::<Result<Vec<_>, _>>()?;
        if context_tools
            .iter()
            .any(|tool| tool.get("name").and_then(Value::as_str) == Some("history"))
        {
            let working = self.project_working_set(
                surface.iter().map(|node| node.message.clone()).collect(),
                &origins,
                context_tools,
            )?;
            for edit in &working.edits {
                for index in edit.source_start..edit.source_end {
                    if let Some(node) = nodes.get_mut(index) {
                        protected.insert(node.seq);
                        node.tokens = 0;
                    }
                }
            }
        }
        let minimum_gain = estimate_message_tokens(&AgentMessage::user(
            frame_summary("Technical evidence retained; originals remain readable with history.")
                .map_err(|e| RunFailure::Failed(e.to_string()))?,
        ))?;
        let target = ModelTarget::new(
            self.request.provider.provider_name(),
            self.request.provider.model_name().unwrap_or("unknown"),
        );
        let planner = BasicCompactionPlanner::new(config)
            .map_err(|error| RunFailure::Failed(error.to_string()))?;
        let plan = match planner
            .plan_incremental_with_input_budget(
                &CompactionRequest {
                    trigger,
                    target,
                    context_window_tokens,
                    current_input_tokens,
                    surface_generation: session.revision().get(),
                    nodes,
                },
                self.request
                    .token_guard
                    .as_ref()
                    .map(|guard| guard.budget().available_input_tokens()),
                self.recent_input_growth.iter().copied().max().unwrap_or(0),
                &protected,
                minimum_gain,
            )
            .map_err(|error| RunFailure::Failed(error.to_string()))?
        {
            CompactionDecision::Planned { plan } => *plan,
            CompactionDecision::NoBalancedRange { .. } => {
                return self
                    .end_ineligible_compaction(trigger, source_command_id)
                    .await;
            }
            CompactionDecision::Disabled | CompactionDecision::NotNeeded { .. } => {
                return Ok(CompactionOutcome::NotApplied)
            }
            _ => return Ok(CompactionOutcome::NotApplied),
        };

        let current_provider = self.request.provider.provider_name().to_owned();
        let current_model = self
            .request
            .provider
            .model_name()
            .unwrap_or("unknown")
            .to_owned();
        let summary_target = plan
            .spec
            .summarization_target
            .as_ref()
            .unwrap_or(&plan.spec.target);
        if summary_target.provider != current_provider || summary_target.model != current_model {
            return Err(RunFailure::Failed(format!(
                "compaction summary route {}/{} is not bound to the active provider {}/{}",
                summary_target.provider, summary_target.model, current_provider, current_model
            )));
        }

        let selected = surface
            .get(plan.range.start_index..=plan.range.end_index)
            .ok_or_else(|| {
                RunFailure::Failed(
                    "compaction surface changed before summary input was prepared".to_owned(),
                )
            })?
            .iter()
            .map(|node| node.message.clone())
            .collect::<Vec<_>>();
        let turn = self
            .journal
            .as_ref()
            .map(|journal| journal.turn)
            .ok_or_else(|| RunFailure::Failed("compaction lost journal state".to_owned()))?;
        let compaction_id = format!(
            "compact-{}-{}-{}-{}",
            self.run_id,
            turn,
            self.step,
            self.journal.as_ref().map_or(0, |journal| journal.next_seq)
        );
        self.journal_append(
            vec![SessionEventData::CompactionStart {
                compaction_id: compaction_id.clone(),
                source_command_id: source_command_id.map(str::to_owned),
                turn: Some(turn),
            }],
            true,
        )
        .await?;
        self.debug("compaction.start", || {
            json!({
                "compactionId": &compaction_id,
                "trigger": trigger,
                "range": &plan.range,
                "currentInputTokens": current_input_tokens,
                "reasoningEffort": &self.request.compaction_reasoning_effort,
                "toolCount": 0,
            })
        })
        .await;

        // Cache deterministic failure for this exact source within the run;
        // a later step must not repeatedly pay to summarize the same span.
        let fingerprint = sha256_json(&json!({
            "selected": &selected, "sourceSeqs": &plan.range.shadowed_seqs,
            "system": self.messages.iter().find(|m| m.role == Role::System),
            "target": &plan.spec.target, "context": context_window_tokens,
            "output": plan.spec.max_tokens, "reasoning": &self.request.compaction_reasoning_effort,
            "pipelineVersion":7, "retryConfig":self.request.config.provider_retry_budget_ms,
            "workingSetInputSample":self.workset_input_sample,
            "tools":context_tools, "mainBudget":self.request.token_guard.as_ref().map(|g|g.budget()),
        }))?;
        let summarized = if let Some(error) = self
            .failed_compactions
            .get(&fingerprint)
            .filter(|_| trigger != CompactionTrigger::Manual)
        {
            Err(crate::compaction::SummaryError::NoBenefit(error.clone()))
        } else {
            self.run_compaction_summary(
                &plan,
                &selected,
                &compaction_id,
                source_command_id,
                turn,
                current_input_tokens,
            )
            .await
        };
        let summary = match summarized {
            Ok(summary) => summary,
            Err(error) => {
                if matches!(
                    &error,
                    crate::compaction::SummaryError::NoBenefit(_)
                        | crate::compaction::SummaryError::Input(_)
                        | crate::compaction::SummaryError::Output
                ) {
                    return self
                        .end_no_benefit(
                            &compaction_id,
                            source_command_id,
                            turn,
                            trigger,
                            fingerprint,
                            error.to_string(),
                        )
                        .await;
                }
                let interrupted = matches!(&error, crate::compaction::SummaryError::Interrupted);
                let failure_message = error.to_string();
                let error = match error {
                    crate::compaction::SummaryError::Cancelled => self.stopped_failure(),
                    crate::compaction::SummaryError::Provider(error) => {
                        RunFailure::provider(&error, failure_message)
                    }
                    _ => RunFailure::Failed(failure_message),
                };
                self.journal_append(
                    vec![SessionEventData::CompactionEnd {
                        outcome: Some(if interrupted || matches!(&error, RunFailure::Stopped(_)) {
                            CompactionEndOutcome::Interrupted
                        } else {
                            CompactionEndOutcome::Failed
                        }),
                        fingerprint: None,
                        compaction_id: compaction_id.clone(),
                        source_command_id: source_command_id.map(str::to_owned),
                        turn: Some(turn),
                        error: Some(error.to_string()),
                    }],
                    true,
                )
                .await?;
                return if interrupted {
                    Ok(CompactionOutcome::Interrupted)
                } else {
                    Err(error)
                };
            }
        };
        let mut progress = summary.progress.clone();
        progress.stage = CompactionStage::Validating;
        progress.delay_ms = None;
        self.journal_compaction_progress(&compaction_id, source_command_id, turn, progress.clone())
            .await?;
        let first_source_seq = plan
            .range
            .shadowed_seqs
            .iter()
            .copied()
            .min()
            .unwrap_or(plan.range.start_seq);
        let last_source_seq = plan
            .range
            .shadowed_seqs
            .iter()
            .copied()
            .max()
            .unwrap_or(plan.range.end_seq);
        let evidence = format!("Original event span {}..{}; use history search starting at seq {} to locate original evidence, then history read with the returned seq/offset.\n\n{}",
            first_source_seq,last_source_seq,first_source_seq,summary.text);
        let checkpoint =
            frame_summary(&evidence).map_err(|error| RunFailure::Failed(error.to_string()))?;
        let checkpoint_tokens = estimate_message_tokens(&AgentMessage::user(&checkpoint))?;

        let shadowed_range = SequenceRange {
            start: plan.range.start_seq,
            end: plan.range.end_seq,
        };
        let usage = summary
            .usage
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|error| {
                RunFailure::Failed(format!("could not serialize compaction usage: {error}"))
            })?;
        let checkpoint_message = AgentMessage::user(checkpoint)
            .with_id(format!("compaction-checkpoint-{compaction_id}"));
        // Build exactly the surface that Session::surface_replace will publish,
        // then include the same prompt/policy/tools/control notes as a real call.
        // No candidate summary becomes durable before this admission succeeds.
        let commit_next_seq = self
            .journal
            .as_ref()
            .ok_or_else(|| RunFailure::Failed("compaction lost commit cursor".into()))?
            .next_seq;
        let checkpoint_seq = commit_next_seq
            .checked_add(2)
            .ok_or_else(|| RunFailure::Failed("compaction sequence overflow".into()))?;
        let mut candidate_selection = None;
        let validation: Result<Option<bool>, RunFailure> = async {
            let mut candidate = surface
                .iter()
                .map(|node| node.message.clone())
                .collect::<Vec<_>>();
            candidate.splice(
                plan.range.start_index..=plan.range.end_index,
                [checkpoint_message.clone()],
            );
            let tool_definitions = self.tool_definitions().await;
            let tools = tool_definitions
                .iter()
                .map(serde_json::to_value)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| RunFailure::Failed(error.to_string()))?;
            let mut candidate_origins = origins.clone();
            for source in candidate_origins.iter_mut().flatten() {
                if source.kind == xharness_context::WorkingSetSourceKind::CurrentCheckpoint {
                    source.kind = xharness_context::WorkingSetSourceKind::Checkpoint;
                }
            }
            candidate_origins.splice(
                plan.range.start_index..=plan.range.end_index,
                [Some(xharness_context::WorkingSetSource {
                    seq: checkpoint_seq,
                    kind: xharness_context::WorkingSetSourceKind::Checkpoint,
                    outcome_unknown: false,
                })],
            );
            let prefixed_candidate = self.compaction_prefixed_history(candidate);
            let prefix_len = prefixed_candidate
                .len()
                .saturating_sub(candidate_origins.len());
            candidate_origins.splice(0..0, std::iter::repeat_n(None, prefix_len));
            let working = if tools
                .iter()
                .any(|tool| tool.get("name").and_then(Value::as_str) == Some("history"))
            {
                self.project_working_set(prefixed_candidate.clone(), &candidate_origins, &tools)?
            } else {
                ContextSurface::identity(prefixed_candidate.clone())
            };
            candidate_selection = crate::context_working_set::StableSelection::capture(
                &prefixed_candidate,
                &candidate_origins,
                &working,
            )
            .map_err(|error| RunFailure::Failed(error.to_string()))?;
            let prepared = self
                .prepare_context_with_working(
                    working,
                    &tools,
                    &candidate_origins,
                    &[],
                    xharness_session::session_plan(&session).as_ref(),
                )
                .await?
                .surface;
            let request = ProviderRequest {
                messages: prepared.messages.clone(),
                tools: tool_definitions,
                step: self.step,
                reasoning_effort: self.request.reasoning_effort.clone(),
                max_output_tokens: self
                    .request
                    .token_guard
                    .as_ref()
                    .map(|guard| guard.budget().reserved_output_tokens),
                debug_scope: self.debug_scope(),
            };
            match self.check_token_budget(&request, &prepared, &tools).await? {
                TokenBudgetCheck::Ready(report) => {
                    progress.input_tokens_after =
                        report.as_ref().map(|r| r.estimate.total_input_tokens);
                    self.debug("compaction.candidate_budget", || json!({"budget":report}))
                        .await;
                    if progress
                        .input_tokens_after
                        .is_some_and(|after| after >= current_input_tokens)
                        || (progress.input_tokens_after.is_none()
                            && checkpoint_tokens >= plan.range.shadowed_token_count)
                    {
                        return Ok(Some(false));
                    }
                }
                TokenBudgetCheck::Exceeded { .. } => return Ok(Some(false)),
                TokenBudgetCheck::Interrupted => return Ok(None),
            }
            self.ensure_running()?;
            let latest = store
                .load(&session_id)
                .await
                .map_err(|e| RunFailure::Failed(e.to_string()))?
                .ok_or_else(|| {
                    RunFailure::Failed("compaction session disappeared during validation".into())
                })?;
            if latest.derive_surface_messages() != surface
                || latest.next_seq() != commit_next_seq
                || self
                    .journal
                    .as_ref()
                    .is_none_or(|journal| journal.next_seq != commit_next_seq)
            {
                return Ok(None);
            }
            Ok(Some(true))
        }
        .await;
        if matches!(validation, Ok(Some(false))) {
            return self.end_no_benefit(&compaction_id,source_command_id,turn,trigger,fingerprint,
                "candidate does not reduce the complete request enough to pass admission; original history is unchanged".into()).await;
        }
        if !matches!(validation, Ok(Some(true))) {
            let message = match &validation {
                Ok(None) => {
                    "compaction candidate validation interrupted or source changed; original history is unchanged".to_owned()
                }
                Err(error) => error.to_string(),
                Ok(Some(_)) => unreachable!(),
            };
            self.journal_append(
                vec![SessionEventData::CompactionEnd {
                    outcome: Some(if validation.is_ok() {
                        CompactionEndOutcome::Interrupted
                    } else {
                        CompactionEndOutcome::Failed
                    }),
                    fingerprint: None,
                    compaction_id: compaction_id.clone(),
                    source_command_id: source_command_id.map(str::to_owned),
                    turn: Some(turn),
                    error: Some(message),
                }],
                true,
            )
            .await?;
            return match validation {
                Ok(_) => Ok(CompactionOutcome::Interrupted),
                Err(error) => Err(error),
            };
        }
        self.failed_compactions.clear();
        self.ensure_running()?;
        progress.stage = CompactionStage::Committing;
        let committed = self
            .commit_compaction_events(vec![
                SessionEventData::CompactionProgress {
                    compaction_id: compaction_id.clone(),
                    source_command_id: source_command_id.map(str::to_owned),
                    turn: Some(turn),
                    progress,
                },
                SessionEventData::CompactionSummary {
                    compaction_id: compaction_id.clone(),
                    source_command_id: source_command_id.map(str::to_owned),
                    summary: summary.text,
                    shadowed_range,
                    shadowed_seqs: plan.range.shadowed_seqs.clone(),
                    shadowed_token_count: plan.range.shadowed_token_count,
                    provider: current_provider,
                    model: current_model,
                    max_tokens: Some(summary.max_output_tokens),
                    usage,
                },
                SessionEventData::UserMessage {
                    message: checkpoint_message,
                    surface_replace: Some(SurfaceReplace {
                        compaction_id: compaction_id.clone(),
                        shadowed_range,
                        shadowed_seqs: plan.range.shadowed_seqs.clone(),
                    }),
                },
                SessionEventData::CompactionEnd {
                    outcome: Some(CompactionEndOutcome::Applied),
                    fingerprint: None,
                    compaction_id: compaction_id.clone(),
                    source_command_id: source_command_id.map(str::to_owned),
                    turn: Some(turn),
                    error: None,
                },
            ])
            .await?;
        if !committed {
            self.journal_append(vec![SessionEventData::CompactionEnd {
                compaction_id:compaction_id.clone(),source_command_id:source_command_id.map(str::to_owned),turn:Some(turn),
                outcome:Some(CompactionEndOutcome::Interrupted),fingerprint:None,
                error:Some("compaction commit cursor changed; candidate discarded and original history retained".into()),
            }],true).await?;
            return Ok(CompactionOutcome::Interrupted);
        }
        self.reload_journal_messages().await?;
        // Reuse exactly the candidate admitted before this atomic commit.
        self.workset_selection = candidate_selection;
        self.workset_reselect = false;
        self.workset_restored = true;
        let context_tools_sha256 = sha256_json(&context_tools)?;
        self.debug("compaction.end", || {
            json!({
                "compactionId": &compaction_id,
                "shadowedTokens": plan.range.shadowed_token_count,
                "checkpointTokens": checkpoint_tokens,
                "visibleMessages": self.messages.len(),
                "toolsSha256": context_tools_sha256,
            })
        })
        .await;
        Ok(CompactionOutcome::Applied)
    }

    /// Strict CAS, unlike ordinary journal writes which may adopt external
    /// inbox metadata. Candidate history handles refer to the exact next seq;
    /// any concurrent append invalidates that reservation, even if it does not
    /// change messages. No partial note, replacement or coverage is committed.
    async fn commit_compaction_events(
        &mut self,
        events: Vec<SessionEventData>,
    ) -> Result<bool, RunFailure> {
        let journal = self
            .journal
            .as_ref()
            .ok_or_else(|| RunFailure::Failed("compaction lost journal".into()))?;
        if !journal.pending_stream_events.is_empty() {
            return Err(RunFailure::Failed(
                "compaction commit found undrained stream events".into(),
            ));
        }
        let store = journal.store.clone();
        let id = journal.session_id.clone();
        let revision = journal.revision;
        let receipt = match store
            .append(&id, revision, events.into_iter().map(Into::into).collect())
            .await
        {
            Ok(receipt) => receipt,
            Err(xharness_session::StoreError::RevisionConflict { .. }) => {
                self.reload_journal_messages().await?;
                return Ok(false);
            }
            Err(error) => {
                return Err(RunFailure::Failed(format!(
                    "compaction atomic commit failed: {error}"
                )))
            }
        };
        if let Some(journal) = self.journal.as_mut() {
            journal.revision = receipt.revision;
            journal.next_seq = receipt
                .last_seq
                .map_or(journal.next_seq, |seq| seq.saturating_add(1));
        }
        store.flush(&id).await.map_err(|error| {
            RunFailure::Failed(format!("compaction commit flush failed: {error}"))
        })?;
        Ok(true)
    }

    async fn end_ineligible_compaction(
        &mut self,
        trigger: CompactionTrigger,
        command: Option<&str>,
    ) -> Result<CompactionOutcome, RunFailure> {
        let Some(journal) = &self.journal else {
            return Ok(CompactionOutcome::NotApplied);
        };
        if trigger == CompactionTrigger::ContextOverflow {
            return Err(RunFailure::Failed("no eligible raw span: protected user inputs, open/unknown tools, provider replay state or fixed system/schema overhead cannot be compacted; choose a larger context or reduce the explicit request".into()));
        }
        let turn = journal.turn;
        let id = format!(
            "compact-{}-{}-{}-{}",
            self.run_id, turn, self.step, journal.next_seq
        );
        self.journal_append(
            vec![
                SessionEventData::CompactionStart {
                    compaction_id: id.clone(),
                    source_command_id: command.map(str::to_owned),
                    turn: Some(turn),
                },
                SessionEventData::CompactionEnd {
                    compaction_id: id,
                    source_command_id: command.map(str::to_owned),
                    turn: Some(turn),
                    error: None,
                    outcome: Some(CompactionEndOutcome::NoEligibleSource),
                    fingerprint: None,
                },
            ],
            true,
        )
        .await?;
        Ok(CompactionOutcome::Skipped(
            CompactionEndOutcome::NoEligibleSource,
        ))
    }

    async fn end_no_benefit(
        &mut self,
        id: &str,
        command: Option<&str>,
        turn: u32,
        trigger: CompactionTrigger,
        fingerprint: String,
        reason: String,
    ) -> Result<CompactionOutcome, RunFailure> {
        if self.failed_compactions.len() >= 32 {
            self.failed_compactions.clear();
        }
        self.failed_compactions
            .insert(fingerprint.clone(), reason.clone());
        self.journal_append(
            vec![SessionEventData::CompactionEnd {
                compaction_id: id.to_owned(),
                source_command_id: command.map(str::to_owned),
                turn: Some(turn),
                outcome: Some(CompactionEndOutcome::NoBenefit),
                fingerprint: Some(fingerprint),
                error: None,
            }],
            true,
        )
        .await?;
        self.debug(
            "compaction.skipped",
            || json!({"reason":reason,"trigger":trigger}),
        )
        .await;
        if trigger == CompactionTrigger::ContextOverflow {
            return Err(RunFailure::Failed(format!(
                "required compaction produced no safe gain: {reason}"
            )));
        }
        Ok(CompactionOutcome::Skipped(CompactionEndOutcome::NoBenefit))
    }

    async fn run_compaction_summary(
        &mut self,
        plan: &CompactionPlan,
        selected: &[AgentMessage],
        compaction_id: &str,
        source_command_id: Option<&str>,
        turn: u32,
        input_tokens_before: u64,
    ) -> Result<CompactionSummaryOutput, crate::compaction::SummaryError> {
        if self.cancellation.is_cancelled() {
            return Err(crate::compaction::SummaryError::Cancelled);
        }
        let guard = self.request.token_guard.clone().ok_or_else(|| {
            crate::compaction::SummaryError::Invalid(
                "compaction needs an explicitly bound context budget".into(),
            )
        })?;
        let template = ProviderRequest {
            messages: self
                .messages
                .iter()
                .find(|m| m.role == Role::System)
                .cloned()
                .into_iter()
                .collect(),
            tools: Vec::new(),
            step: self.step,
            reasoning_effort: self.request.compaction_reasoning_effort.clone(),
            max_output_tokens: Some(plan.spec.max_tokens),
            debug_scope: self.debug_scope(),
        };
        let cancellation = self.cancellation.child_token();
        let _cancel_on_drop = cancellation.clone().drop_guard();
        let (progress_tx, mut progress_rx) = mpsc::channel(4);
        let summary = crate::compaction::SummaryRunner::new(
            self.request.provider.clone(),
            guard,
            template,
            cancellation.clone(),
            plan.spec.compaction_retries,
        )
        .with_debug(self.request.debug.clone())
        .with_recovery(self.request.config.clone(), self.retry_entropy())
        .with_progress(progress_tx)
        .run(selected.to_vec());
        tokio::pin!(summary);
        let mut progress_open = true;
        let mut last_progress = CompactionProgress {
            input_tokens_before: Some(input_tokens_before),
            ..Default::default()
        };
        let mut last_progress_at = tokio::time::Instant::now();
        let output = loop {
            tokio::select! {
                biased;
                _ = self.cancellation.cancelled() => return Err(crate::compaction::SummaryError::Cancelled),
                command = self.command_rx.recv(), if self.command_open => {
                    match command {
                        Some(envelope) => {
                            let interrupt = self.handle_envelope(envelope, true).await
                                .map_err(|error| match error {
                                    RunFailure::Stopped(_) => crate::compaction::SummaryError::Cancelled,
                                    _ => crate::compaction::SummaryError::Invalid(error.to_string()),
                                })?;
                            let interrupt = if self.paused && !interrupt {
                                let mut paused = last_progress.clone();
                                paused.stage = CompactionStage::Paused;
                                paused.delay_ms = None;
                                self.journal_compaction_progress(compaction_id, source_command_id, turn, paused).await
                                    .map_err(|e| crate::compaction::SummaryError::Invalid(e.to_string()))?;
                                let interrupted = self.wait_while_paused(true).await
                                    .map_err(|e| match e { RunFailure::Stopped(_) => crate::compaction::SummaryError::Cancelled, _ => crate::compaction::SummaryError::Invalid(e.to_string()) })?;
                                if !interrupted {
                                    // The retry sleep's deadline keeps advancing while
                                    // paused. Do not restart the UI countdown on resume.
                                    if let Some(delay) = last_progress.delay_ms.as_mut() {
                                        *delay = delay.saturating_sub(last_progress_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64);
                                    }
                                    last_progress_at = tokio::time::Instant::now();
                                    self.journal_compaction_progress(compaction_id, source_command_id, turn, last_progress.clone()).await
                                        .map_err(|e| crate::compaction::SummaryError::Invalid(e.to_string()))?;
                                }
                                interrupted
                            } else { interrupt };
                            if interrupt {
                                cancellation.cancel();
                                return Err(crate::compaction::SummaryError::Interrupted);
                            }
                        }
                        None => self.command_open = false,
                    }
                }
                progress = progress_rx.recv(), if progress_open => {
                    if let Some(mut progress) = progress {
                        progress.input_tokens_before = Some(input_tokens_before);
                        last_progress = progress.clone();
                        last_progress_at = tokio::time::Instant::now();
                        self.journal_compaction_progress(compaction_id, source_command_id, turn, progress).await
                            .map_err(|e| crate::compaction::SummaryError::Invalid(e.to_string()))?;
                    } else { progress_open = false; }
                }
                result = &mut summary => break result?,
            }
        };
        self.debug("compaction.summary_completed", || {
            json!({
                "calls": output.calls, "splits": output.splits, "usage": output.usage,
            })
        })
        .await;
        Ok(CompactionSummaryOutput {
            progress: CompactionProgress {
                input_tokens_before: Some(input_tokens_before),
                ..output.progress
            },
            text: output.text,
            usage: output.usage,
            max_output_tokens: output.max_output_tokens,
        })
    }

    async fn journal_compaction_progress(
        &mut self,
        compaction_id: &str,
        source_command_id: Option<&str>,
        turn: u32,
        progress: CompactionProgress,
    ) -> Result<(), RunFailure> {
        self.journal_append(
            vec![SessionEventData::CompactionProgress {
                compaction_id: compaction_id.to_owned(),
                source_command_id: source_command_id.map(str::to_owned),
                turn: Some(turn),
                progress,
            }],
            true,
        )
        .await
    }

    async fn initialize_journal(&mut self) -> Result<(), RunFailure> {
        let Some(journal) = self.journal.as_ref() else {
            return Ok(());
        };
        let store = Arc::clone(&journal.store);
        let session_id = journal.session_id.clone();
        let mut session =
            match store.load(&session_id).await.map_err(|error| {
                RunFailure::Failed(format!("session journal load failed: {error}"))
            })? {
                Some(session) => session,
                None => store
                    .create(SessionHeader::new(&session_id))
                    .await
                    .map_err(|error| {
                        RunFailure::Failed(format!("session journal create failed: {error}"))
                    })?,
            };

        for event in session.events().iter().rev() {
            if self.failed_compactions.len() >= 32 {
                break;
            }
            if let SessionEventData::CompactionEnd {
                outcome: Some(CompactionEndOutcome::NoBenefit),
                fingerprint: Some(fingerprint),
                ..
            } = event.data()
            {
                self.failed_compactions
                    .entry(fingerprint.clone())
                    .or_insert_with(|| "same source/budget previously produced no benefit".into());
            }
        }
        self.user_request_scope = session
            .latest_user_request()
            .map(|(seq, message)| UserRequestScope::new(Some(seq), message));

        let last_turn = session
            .events()
            .iter()
            .rev()
            .find_map(|event| match event.data() {
                SessionEventData::TurnStart { turn } => Some(*turn),
                _ => None,
            });
        let last_request_context =
            session
                .events()
                .iter()
                .rev()
                .find_map(|event| match event.data() {
                    SessionEventData::RequestContext {
                        provider,
                        model,
                        context_window,
                    } => Some(LoggedRequestContext {
                        provider: provider.clone(),
                        model: model.clone(),
                        context_window: *context_window,
                    }),
                    _ => None,
                });
        let last_turn_closed = last_turn.is_none_or(|turn| {
            session.events().iter().rev().any(|event| {
                matches!(event.data(), SessionEventData::TurnEnd { turn: closed, .. } if *closed == turn)
            })
        });
        let open_turn = last_turn.filter(|_| !last_turn_closed);
        let mut open_step = None;
        if let Some(turn) = open_turn {
            for event in session.events().iter().rev() {
                match event.data() {
                    SessionEventData::StepEnd {
                        turn: closed_turn, ..
                    } if *closed_turn == turn => break,
                    SessionEventData::StepStart {
                        turn: open_turn,
                        step,
                    } if *open_turn == turn => {
                        open_step = Some(*step);
                        break;
                    }
                    SessionEventData::TurnStart { .. } => break,
                    _ => {}
                }
            }
        }

        let pending_approvals = match (open_turn, open_step) {
            (Some(turn), Some(step)) => session
                .pending_tool_approvals()
                .into_iter()
                .filter(|approval| approval.turn == turn && approval.step == step)
                .collect::<Vec<_>>(),
            _ => Vec::new(),
        };
        let recoverable_questions = match (open_turn, open_step) {
            (Some(turn), Some(step)) => session
                .recoverable_user_questions()
                .into_iter()
                .filter(|question| question.turn == turn && question.step == step)
                .collect::<Vec<_>>(),
            _ => Vec::new(),
        };
        if !pending_approvals.is_empty() || !recoverable_questions.is_empty() {
            if !self.request.messages.is_empty() || !self.request.journal_prelude.is_empty() {
                return Err(RunFailure::Failed(
                    "session has a recoverable human interaction; resume it before admitting new input"
                        .to_owned(),
                ));
            }
            let turn = open_turn.expect("human interaction belongs to an open turn");
            let step = open_step.expect("human interaction belongs to an open step");
            let pending_by_call = pending_approvals
                .into_iter()
                .map(|approval| (approval.call_id.clone(), approval))
                .collect::<HashMap<_, _>>();
            let question_calls = recoverable_questions
                .into_iter()
                .map(|question| question.call.id)
                .collect::<HashSet<_>>();
            let calls = xharness_session::incomplete_tool_calls(session.events())
                .into_iter()
                .filter(|pending| pending.turn == turn && pending.step == step)
                .map(|pending| RecoveredToolCall {
                    approval: pending_by_call.get(&pending.call.id).cloned(),
                    replay_safe: question_calls.contains(&pending.call.id),
                    call: pending.call,
                })
                .collect::<Vec<_>>();
            if !calls
                .iter()
                .any(|call| call.approval.is_some() || call.replay_safe)
            {
                return Err(RunFailure::Failed(
                    "session interaction recovery lost its referenced tool call".to_owned(),
                ));
            }
            self.messages = self.prompt_prefixed(session.derive_messages());
            self.step = usize::try_from(step)
                .map_err(|_| RunFailure::Failed("session step counter overflow".to_owned()))?;
            if let Some(state) = session.events().iter().rev().find_map(|e| match e.data() {
                SessionEventData::ExecutionCheckpoint { turn: t, state, .. } if *t == turn => {
                    Some(state.clone())
                }
                _ => None,
            }) {
                self.checkpoint = state;
            }
            self.recovered_tool_batch = Some(RecoveredToolBatch { calls });
            if let Some(journal) = self.journal.as_mut() {
                journal.revision = session.revision();
                journal.next_seq = session.next_seq();
                journal.turn = turn;
                journal.step_open = true;
                journal.turn_open = true;
                journal.last_request_context = last_request_context;
            }
            return Ok(());
        }

        if self
            .request
            .journal_expected_revision
            .is_some_and(|r| r != session.revision())
        {
            return Err(RunFailure::Failed(
                "admission revision changed; reload the durable claim".into(),
            ));
        }

        let recovery = session.interrupted_turn_recovery();
        if !recovery.is_empty() {
            store
                .append(&session_id, session.revision(), recovery)
                .await
                .map_err(|error| {
                    RunFailure::Failed(format!("session journal recovery failed: {error}"))
                })?;
            store.flush(&session_id).await.map_err(|error| {
                RunFailure::Failed(format!("session journal recovery flush failed: {error}"))
            })?;
            session = store
                .load(&session_id)
                .await
                .map_err(|error| {
                    RunFailure::Failed(format!("session journal reload failed: {error}"))
                })?
                .ok_or_else(|| {
                    RunFailure::Failed("session journal disappeared after recovery".to_owned())
                })?;
        }
        if let Some(journal) = self.journal.as_mut() {
            journal.last_request_context = last_request_context;
        }

        self.messages = self.prompt_prefixed(session.derive_messages());
        let next_turn = last_turn
            .unwrap_or_default()
            .checked_add(1)
            .ok_or_else(|| RunFailure::Failed("session turn counter overflow".to_owned()))?;
        if let Some(journal) = self.journal.as_mut() {
            journal.revision = session.revision();
            journal.next_seq = session.next_seq();
            journal.turn = next_turn;
        }

        let mut events = vec![SessionEventData::TurnStart { turn: next_turn }.into()];
        events.extend(self.request.journal_prelude.clone());
        for message in &self.request.messages {
            match message.role {
                Role::User => events.push(
                    SessionEventData::UserMessage {
                        message: message.clone(),
                        surface_replace: None,
                    }
                    .into(),
                ),
                Role::System => {}
                Role::Assistant | Role::Tool => {
                    return Err(RunFailure::Failed(
                        "event-sourced runs accept new user/system input only; resume assistant/tool history from the session journal"
                            .to_owned(),
                    ));
                }
            }
        }
        self.journal_append_events(events, true).await?;
        if let Some(journal) = self.journal.as_mut() {
            journal.turn_open = true;
        }
        self.messages.extend(self.request.messages.clone());
        Ok(())
    }

    async fn reload_journal_messages(&mut self) -> Result<(), RunFailure> {
        let Some(journal) = self.journal.as_ref() else {
            return Ok(());
        };
        let store = Arc::clone(&journal.store);
        let session_id = journal.session_id.clone();
        let session = store
            .load(&session_id)
            .await
            .map_err(|error| RunFailure::Failed(format!("session journal reload failed: {error}")))?
            .ok_or_else(|| {
                RunFailure::Failed("session journal disappeared during recovery".to_owned())
            })?;
        self.user_request_scope = session
            .latest_user_request()
            .map(|(seq, message)| UserRequestScope::new(Some(seq), message));
        self.messages = self.compaction_prefixed_history(session.derive_messages());
        if let Some(journal) = self.journal.as_mut() {
            journal.revision = session.revision();
            journal.next_seq = session.next_seq();
        }
        Ok(())
    }

    async fn journal_append(
        &mut self,
        events: Vec<SessionEventData>,
        flush: bool,
    ) -> Result<(), RunFailure> {
        self.journal_append_events(events.into_iter().map(Into::into).collect(), flush)
            .await
    }

    async fn journal_append_events(
        &mut self,
        mut events: Vec<SessionEvent>,
        flush: bool,
    ) -> Result<(), RunFailure> {
        let pending_stream_events = self
            .journal
            .as_ref()
            .map_or_else(Vec::new, |journal| journal.pending_stream_events.clone());
        if !pending_stream_events.is_empty() {
            let mut combined =
                Vec::with_capacity(pending_stream_events.len().saturating_add(events.len()));
            combined.extend(pending_stream_events.iter().cloned());
            combined.append(&mut events);
            events = combined;
        }
        if events.is_empty() {
            return Ok(());
        }
        let Some(journal) = self.journal.as_ref() else {
            return Ok(());
        };
        let store = Arc::clone(&journal.store);
        let session_id = journal.session_id.clone();
        let mut inbox_conflicts = 0usize;
        let receipt = loop {
            let (revision, next_seq) = self
                .journal
                .as_ref()
                .map(|journal| (journal.revision, journal.next_seq))
                .expect("journal checked above");
            match store.append(&session_id, revision, events.clone()).await {
                Ok(receipt) => break receipt,
                Err(xharness_session::StoreError::RevisionConflict { .. }) => {
                    if self.request.journal_expected_revision.is_some()
                        && events
                            .iter()
                            .any(|e| matches!(e.data(), SessionEventData::TurnStart { .. }))
                    {
                        return Err(RunFailure::Failed(
                            "admission revision changed; reload the durable claim".into(),
                        ));
                    }
                    inbox_conflicts = inbox_conflicts.saturating_add(1);
                    if inbox_conflicts > 16 {
                        return Err(RunFailure::Failed(
                            "session journal stayed contended by external control writers"
                                .to_owned(),
                        ));
                    }
                    let session = store
                        .load(&session_id)
                        .await
                        .map_err(|error| {
                            RunFailure::Failed(format!(
                                "session journal conflict reload failed: {error}"
                            ))
                        })?
                        .ok_or_else(|| {
                            RunFailure::Failed(
                                "session journal disappeared during append conflict".to_owned(),
                            )
                        })?;
                    let known = usize::try_from(next_seq).map_err(|_| {
                        RunFailure::Failed("session journal sequence overflow".to_owned())
                    })?;
                    let intervening = session.events().get(known..).ok_or_else(|| {
                        RunFailure::Failed(
                            "session journal moved behind the active writer".to_owned(),
                        )
                    })?;
                    if intervening.is_empty()
                        || intervening.iter().any(|event| {
                            !matches!(
                                event.data(),
                                SessionEventData::AgentInboxSpliced { .. }
                                    | SessionEventData::JobContinuation { .. }
                                    | SessionEventData::AgentDispatchPaused { .. }
                                    | SessionEventData::AgentSettlementDelivered { .. }
                                    | SessionEventData::AgentFailureDelivered { .. }
                                    | SessionEventData::SessionModelSelected { .. }
                                    | SessionEventData::CommandRun { .. }
                                    | SessionEventData::CommandDone { .. }
                                    | SessionEventData::SessionTitle { .. }
                                    | SessionEventData::SessionTitleGeneration { .. }
                                    | SessionEventData::GoalExecution { .. }
                                    | SessionEventData::GoalChange { .. }
                                    | SessionEventData::SessionPlanUpdated { .. }
                                    | SessionEventData::ScheduleChange { .. }
                                    | SessionEventData::SessionMutationCommitted { .. }
                                    | SessionEventData::PlanMode { .. }
                                    | SessionEventData::QuestionRequested { .. }
                                    | SessionEventData::QuestionDeferred { .. }
                                    | SessionEventData::QuestionAnswerDelivered { .. }
                                    | SessionEventData::QuestionDraftUpdated { .. }
                                    | SessionEventData::QuestionResolved { .. }
                                    | SessionEventData::QuestionCancelled { .. }
                            )
                        })
                    {
                        return Err(RunFailure::Failed(
                            "session journal changed outside allowed external control events"
                                .to_owned(),
                        ));
                    }
                    if let Some(journal) = self.journal.as_mut() {
                        journal.revision = session.revision();
                        journal.next_seq = session.next_seq();
                    }
                }
                Err(error) => {
                    return Err(RunFailure::Failed(format!(
                        "session journal append failed: {error}"
                    )))
                }
            }
        };
        if flush {
            store.flush(&session_id).await.map_err(|error| {
                RunFailure::Failed(format!("session journal flush failed: {error}"))
            })?;
        }
        for event in &receipt.events {
            if let SessionEventData::UserMessage {
                message,
                surface_replace: None,
            } = event.data()
            {
                self.user_request_scope = Some(UserRequestScope::new(Some(event.seq), message));
            }
        }
        if let Some(journal) = self.journal.as_mut() {
            journal.revision = receipt.revision;
            journal.next_seq = receipt
                .last_seq
                .map_or(journal.next_seq, |sequence| sequence.saturating_add(1));
            if !pending_stream_events.is_empty() {
                journal.pending_stream_events.clear();
                journal.pending_stream_fragments = 0;
                journal.stream_batch_started_at = None;
            }
        }
        Ok(())
    }

    async fn journal_step_start(&mut self) -> Result<(), RunFailure> {
        let Some(journal) = self.journal.as_ref() else {
            return Ok(());
        };
        let step = u32::try_from(self.step)
            .map_err(|_| RunFailure::Failed("session step counter overflow".to_owned()))?;
        let turn = journal.turn;
        self.journal_append(vec![SessionEventData::StepStart { turn, step }], false)
            .await?;
        if let Some(journal) = self.journal.as_mut() {
            journal.step_open = true;
        }
        Ok(())
    }

    async fn journal_request_header(
        &mut self,
        surface: &ContextSurface,
        tools: &[Value],
        token_budget: Option<&TokenBudgetReport>,
        origins: &[xharness_token::ContextMessageOrigin],
    ) -> Result<(), RunFailure> {
        if self.journal.is_none() {
            return Ok(());
        }
        let provider = self.request.provider.provider_name().to_owned();
        let model = self
            .request
            .provider
            .model_name()
            .unwrap_or("unknown")
            .to_owned();
        let request_context = LoggedRequestContext {
            provider: provider.clone(),
            model: model.clone(),
            context_window: token_budget.map(|report| report.context_window_tokens),
        };
        let capture_full_audit = self
            .journal
            .as_ref()
            .unwrap()
            .store
            .captures_full_request_audit();
        let mut header = RequestHeader::new(provider, model);
        header.options.insert(
            "measurement".into(),
            json!({
                "requestId":format!("{}:{}",self.run_id,self.step),
                "turn":self.journal.as_ref().map(|j|j.turn),"step":self.step,
                "source":"request_admission","phase":"prepared",
            }),
        );
        // Harness inspection is a separate lightweight snapshot; only the
        // conversation input body is gated by full diagnostic capture.
        let system = surface
            .messages
            .iter()
            .filter(|message| message.role == Role::System)
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        header.system = (!system.is_empty()).then_some(system);
        header.tools = tools.to_vec();
        header.options.insert(
            "inputMessageCount".into(),
            Value::from(surface.messages.len() as u64),
        );
        header
            .options
            .insert("toolCount".into(), Value::from(tools.len() as u64));
        if capture_full_audit {
            header.input = surface.messages.clone();
        }
        header.options.insert(
            "toolDefinitionsSha256".to_owned(),
            Value::String(sha256_json(&tools)?),
        );
        if let Some(prompt) = &self.request.prompt {
            header.options.insert(
                "prompt".to_owned(),
                serde_json::to_value(prompt.audit()).map_err(|error| {
                    RunFailure::Failed(format!("could not serialize prompt audit: {error}"))
                })?,
            );
        }
        if let Some(report) = token_budget {
            header.options.insert(
                "tokenBudget".to_owned(),
                serde_json::to_value(report).map_err(|error| {
                    RunFailure::Failed(format!("could not serialize token budget report: {error}"))
                })?,
            );
            // The audit body may be disabled or archived separately. Persist a
            // small, content-free request composition so live and restored UI
            // describe the actual prepared request rather than the whole log.
            let mut estimate_request = TokenEstimateRequest {
                provider: header.provider.clone(),
                model: Some(header.model.clone()),
                tools: tools.to_vec(),
                ..TokenEstimateRequest::default()
            };
            let mut conversation_origins = Vec::new();
            for (index, message) in surface.messages.iter().enumerate() {
                if let Ok(encoded) = serde_json::to_value(message) {
                    if message.role == Role::System {
                        estimate_request.system_messages.push(encoded);
                    } else {
                        estimate_request.conversation_messages.push(encoded);
                        conversation_origins.push(origins.get(index).copied().unwrap_or_default());
                    }
                }
            }
            if let Ok(composition) = ContextComposition::estimate_with_origins(
                &estimate_request,
                report.estimate.total_input_tokens,
                &conversation_origins,
            ) {
                header.options.insert(
                    "contextComposition".to_owned(),
                    serde_json::to_value(composition).map_err(|error| {
                        RunFailure::Failed(format!(
                            "could not serialize context composition: {error}"
                        ))
                    })?,
                );
            }
        }
        header
            .options
            .insert("step".to_owned(), Value::from(self.step as u64));
        if let Some(selection) = &self.workset_selection {
            if let Some(metadata) = selection
                .metadata()
                .map_err(|error| RunFailure::Failed(error.to_string()))?
            {
                header
                    .options
                    .insert("workingSetSelection".into(), metadata);
            }
        }
        header.options.insert(
            "context".to_owned(),
            json!({
                "policy": surface.policy,
                "source_message_count": surface.source_message_count,
                "visible_message_count": surface.messages.len(),
                "edits": surface.edits,
            }),
        );
        let context_changed = self
            .journal
            .as_ref()
            .is_some_and(|journal| journal.last_request_context.as_ref() != Some(&request_context));
        let journal = self.journal.as_ref().unwrap();
        match journal
            .store
            .archive_harness_snapshot(&journal.session_id, &header)
            .await
        {
            Ok(Some(reference)) => {
                header.options.insert("harnessSnapshot".into(), reference);
            }
            Ok(None) => {}
            Err(error) => {
                // Optional inspection must not fail or alter the provider call.
                eprintln!("xharness Harness snapshot capture failed: {error}");
                header.options.insert(
                    "harnessSnapshot".into(),
                    json!({"kind":"omitted","reason":"archive_failed"}),
                );
            }
        }
        let missing_audit = header.metadata_only(json!({
            "kind": "omitted", "reason": "archive_failed",
        }));
        let header = match self
            .journal
            .as_ref()
            .unwrap()
            .store
            .archive_request(header)
            .await
        {
            Ok(header) => header,
            Err(error) => {
                // Optional diagnostics must not turn a healthy provider call
                // into a failed Agent turn. The compact durable request fact
                // still identifies this attempt and its accounting.
                eprintln!("xharness optional request audit capture failed: {error}");
                missing_audit
            }
        };
        let mut events = vec![SessionEventData::RequestHeader { header }];
        if context_changed {
            events.push(SessionEventData::RequestContext {
                provider: request_context.provider.clone(),
                model: request_context.model.clone(),
                context_window: request_context.context_window,
            });
        }
        self.journal_append(events, true).await?;
        if context_changed {
            if let Some(journal) = self.journal.as_mut() {
                journal.last_request_context = Some(request_context);
            }
        }
        Ok(())
    }

    async fn journal_chunk(&mut self, chunk: AssistantChunk) -> Result<bool, RunFailure> {
        let Some(journal) = self.journal.as_mut() else {
            return Ok(false);
        };
        let turn = journal.turn;
        let step = u32::try_from(self.step)
            .map_err(|_| RunFailure::Failed("session step counter overflow".to_owned()))?;
        if journal.pending_stream_events.is_empty() {
            journal.stream_batch_started_at = Some(Instant::now());
        }
        journal.pending_stream_fragments = journal.pending_stream_fragments.saturating_add(1);
        let merged = journal
            .pending_stream_events
            .last_mut()
            .is_some_and(|event| match (event.data_mut(), &chunk) {
                (
                    SessionEventData::AssistantChunk {
                        turn: prior_turn,
                        step: prior_step,
                        chunk: AssistantChunk::TextDelta(buffered),
                    },
                    AssistantChunk::TextDelta(delta),
                ) if *prior_turn == turn && *prior_step == step => {
                    buffered.push_str(delta);
                    true
                }
                (
                    SessionEventData::AssistantChunk {
                        turn: prior_turn,
                        step: prior_step,
                        chunk: AssistantChunk::ReasoningDelta(buffered),
                    },
                    AssistantChunk::ReasoningDelta(delta),
                ) if *prior_turn == turn && *prior_step == step => {
                    buffered.push_str(delta);
                    true
                }
                (
                    SessionEventData::AssistantChunk {
                        turn: prior_turn,
                        step: prior_step,
                        chunk:
                            AssistantChunk::ToolCallDelta {
                                index: buffered_index,
                                id: buffered_id,
                                name: buffered_name,
                                arguments_delta: buffered_arguments,
                            },
                    },
                    AssistantChunk::ToolCallDelta {
                        index,
                        id,
                        name,
                        arguments_delta,
                    },
                ) if *prior_turn == turn
                    && *prior_step == step
                    && *buffered_index == *index
                    && stream_identity_fragment_is_compatible(buffered_id, id)
                    && stream_identity_fragment_is_compatible(buffered_name, name) =>
                {
                    // Chat-style streams normally identify the call only in
                    // the first fragment, while other compatible providers
                    // repeat it. Preserve one stable identity in both cases;
                    // a conflicting non-empty id/name starts a new durable
                    // chunk instead of being silently rewritten.
                    if buffered_id.is_empty() {
                        buffered_id.push_str(id);
                    }
                    if buffered_name.is_empty() {
                        buffered_name.push_str(name);
                    }
                    buffered_arguments.push_str(arguments_delta);
                    true
                }
                _ => false,
            });
        if !merged {
            journal
                .pending_stream_events
                .push(SessionEventData::AssistantChunk { turn, step, chunk }.into());
        }
        let buffered_bytes = journal
            .pending_stream_events
            .iter()
            .map(|event| match event.data() {
                SessionEventData::AssistantChunk { chunk, .. } => assistant_chunk_bytes(chunk),
                _ => 0,
            })
            .sum::<usize>();
        let should_checkpoint = journal.pending_stream_fragments >= STREAM_JOURNAL_BATCH_EVENTS
            || buffered_bytes >= STREAM_JOURNAL_BATCH_BYTES
            || journal
                .stream_batch_started_at
                .is_some_and(|started| started.elapsed() >= STREAM_JOURNAL_BATCH_INTERVAL);
        if should_checkpoint {
            self.journal_append_events(Vec::new(), false).await?;
        }
        Ok(should_checkpoint)
    }

    async fn journal_assistant_message(
        &mut self,
        message: &AgentMessage,
        usage: Option<TokenUsage>,
    ) -> Result<(), RunFailure> {
        let Some(journal) = self.journal.as_ref() else {
            return Ok(());
        };
        let usage = usage
            .map(serde_json::to_value)
            .transpose()
            .map_err(|error| {
                RunFailure::Failed(format!("could not serialize token usage: {error}"))
            })?;
        let turn = journal.turn;
        let step = u32::try_from(self.step)
            .map_err(|_| RunFailure::Failed("session step counter overflow".to_owned()))?;
        let mut events = vec![SessionEventData::AssistantMessage {
            turn,
            step,
            message: message.clone(),
            usage,
        }];
        events.extend(
            message
                .tool_calls
                .iter()
                .cloned()
                .map(|call| SessionEventData::ToolCall { turn, step, call }),
        );
        self.journal_append(events, !message.tool_calls.is_empty())
            .await
    }

    async fn journal_tool_results(
        &mut self,
        executions: &[ToolExecution],
    ) -> Result<(), RunFailure> {
        let Some(journal) = self.journal.as_ref() else {
            return Ok(());
        };
        let turn = journal.turn;
        let step = u32::try_from(self.step)
            .map_err(|_| RunFailure::Failed("session step counter overflow".to_owned()))?;
        let mut events: Vec<SessionEventData> = executions
            .iter()
            .map(|execution| SessionEventData::ToolResult {
                turn,
                step,
                result: ToolResultData {
                    call_id: execution.call.id.clone(),
                    outcome: execution.outcome,
                    content: execution.model_text.clone(),
                    metadata: execution.result.metadata.clone(),
                },
            })
            .collect();
        events.push(SessionEventData::ExecutionCheckpoint {
            turn,
            step,
            state: self.checkpoint.clone(),
            notice: None,
        });
        self.journal_append(events, true).await
    }

    async fn save_checkpoint(
        &mut self,
        notice: Option<xharness_session::ExecutionNotice>,
    ) -> Result<(), RunFailure> {
        if let Some(journal) = &self.journal {
            self.journal_append(
                vec![SessionEventData::ExecutionCheckpoint {
                    turn: journal.turn,
                    step: u32::try_from(self.step)
                        .map_err(|_| RunFailure::Failed("step overflow".into()))?,
                    state: self.checkpoint.clone(),
                    notice: notice.clone(),
                }],
                true,
            )
            .await?;
        }
        if let Some(notice) = notice {
            self.emit(LoopEventKind::ExecutionNotice(notice)).await?;
        }
        Ok(())
    }

    fn approval_id(&self, order: usize) -> String {
        format!("xh-approval-{}-{}-{order}", self.run_id, self.step)
    }

    async fn journal_approval_asked(
        &mut self,
        approval_id: &str,
        call: &ToolCall,
        reasons: &[String],
    ) -> Result<(), RunFailure> {
        self.journal_append(
            vec![SessionEventData::ApprovalAsked {
                id: approval_id.to_owned(),
                tool_name: call.name.clone(),
                call_id: Some(call.id.clone()),
                reason: Some(if reasons.is_empty() {
                    "This tool requires explicit approval.".to_owned()
                } else {
                    reasons.join("\n")
                }),
            }],
            true,
        )
        .await
    }

    async fn journal_approval_decided(
        &mut self,
        approval_id: &str,
        outcome: ApprovalOutcome,
    ) -> Result<(), RunFailure> {
        self.journal_append(
            vec![SessionEventData::ApprovalDecided {
                id: approval_id.to_owned(),
                outcome,
            }],
            true,
        )
        .await
    }

    async fn journal_cancel_pending_approvals(
        &mut self,
        pending_approval_ids: &mut Vec<String>,
    ) -> Result<(), RunFailure> {
        let events = pending_approval_ids
            .drain(..)
            .map(|id| SessionEventData::ApprovalDecided {
                id,
                outcome: ApprovalOutcome::Cancelled,
            })
            .collect();
        self.journal_append(events, true).await
    }

    fn model_retry_id(&self) -> String {
        format!("xh-retry-{}-{}", self.run_id, self.step)
    }

    async fn journal_model_retry_scheduled(
        &mut self,
        retry_id: &str,
        retry: usize,
        max_retries: Option<usize>,
        policy_key: String,
        error: &ProviderError,
        delay_ms: u64,
    ) -> Result<(), RunFailure> {
        let Some(journal) = self.journal.as_ref() else {
            return Ok(());
        };
        let turn = journal.turn;
        let step = u32::try_from(self.step)
            .map_err(|_| RunFailure::Failed("session step counter overflow".to_owned()))?;
        let retry = u32::try_from(retry)
            .map_err(|_| RunFailure::Failed("provider retry counter overflow".to_owned()))?;
        let max_retries = max_retries
            .map(u32::try_from)
            .transpose()
            .map_err(|_| RunFailure::Failed("provider retry limit overflow".to_owned()))?;
        let provider = self.request.provider.provider_name().to_owned();
        let failure = LlmFailure {
            message: error.diagnostic_message(),
            code: error
                .http_status
                .map_or_else(|| "TRANSPORT".to_owned(), |status| format!("HTTP_{status}")),
            status: error.http_status,
            provider_retry_after_ms: error.retry_after_ms,
            request_id: error.request_id.clone(),
        };
        self.journal_append(
            vec![SessionEventData::LlmRetry {
                retry_id: retry_id.to_owned(),
                turn,
                step,
                provider,
                mode: if max_retries.is_some() {
                    LlmRetryMode::Normal
                } else {
                    LlmRetryMode::Always
                },
                policy_key,
                retry,
                max_retries,
                delay_ms,
                failure,
            }],
            true,
        )
        .await
    }

    async fn journal_model_retry_started(
        &mut self,
        retry_id: &str,
        retry: usize,
    ) -> Result<(), RunFailure> {
        let Some(journal) = self.journal.as_ref() else {
            return Ok(());
        };
        let turn = journal.turn;
        let step = u32::try_from(self.step)
            .map_err(|_| RunFailure::Failed("session step counter overflow".to_owned()))?;
        let retry = u32::try_from(retry)
            .map_err(|_| RunFailure::Failed("provider retry counter overflow".to_owned()))?;
        self.journal_append(
            vec![SessionEventData::LlmRetryStarted {
                retry_id: retry_id.to_owned(),
                turn,
                step,
                retry,
            }],
            true,
        )
        .await
    }

    async fn journal_step_end(&mut self) -> Result<(), RunFailure> {
        let Some(journal) = self.journal.as_ref() else {
            return Ok(());
        };
        if !journal.step_open {
            return Ok(());
        }
        let turn = journal.turn;
        let step = u32::try_from(self.step)
            .map_err(|_| RunFailure::Failed("session step counter overflow".to_owned()))?;
        self.journal_append(vec![SessionEventData::StepEnd { turn, step }], false)
            .await?;
        if let Some(journal) = self.journal.as_mut() {
            journal.step_open = false;
        }
        Ok(())
    }

    async fn finalize_journal(
        &mut self,
        status: LoopStatus,
        error: Option<&str>,
        provider_failure: Option<xharness_session::ProviderFailure>,
    ) -> Result<(), String> {
        if self.journal.is_none() {
            if status == LoopStatus::Cancelled && self.user_interrupted {
                let mut marker = xharness_session::user_interruption_message(0);
                marker.id = Some(format!("turn-aborted-{}", self.run_id));
                self.messages.push(marker);
            }
            return Ok(());
        }
        // Settle orphaned call/result pairs before projecting the interruption marker.
        // Cancellation can stop the batch before its final result commit. Reuse
        // recovery's conservative unknown outcome rather than inventing success.
        if status == LoopStatus::Cancelled && self.user_interrupted {
            let journal = self.journal.as_ref().expect("journal checked above");
            let session = journal
                .store
                .load(&journal.session_id)
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "session disappeared during user interruption".to_owned())?;
            let recovery = session.outcome_unknown_recovery();
            if !recovery.is_empty() {
                self.journal_append_events(recovery, true)
                    .await
                    .map_err(|error| error.to_string())?;
            }
        }
        self.journal_step_end()
            .await
            .map_err(|failure| failure.to_string())?;
        let Some(journal) = self.journal.as_ref() else {
            return Ok(());
        };
        if !journal.turn_open {
            return Ok(());
        }
        let reason = match status {
            LoopStatus::Completed => TurnEndReason::Completed,
            LoopStatus::MaxTokens => TurnEndReason::MaxTokens,
            LoopStatus::Cancelled if self.user_interrupted => TurnEndReason::UserInterrupted,
            LoopStatus::Cancelled => TurnEndReason::Cancelled,
            LoopStatus::LimitReached => TurnEndReason::LimitReached,
            LoopStatus::Failed => TurnEndReason::Failed {
                error: error.unwrap_or("loop failed").to_owned(),
                provider_failure,
            },
        };
        let turn = journal.turn;
        self.journal_append(vec![SessionEventData::TurnEnd { turn, reason }], true)
            .await
            .map_err(|failure| failure.to_string())?;
        if let Some(journal) = self.journal.as_mut() {
            journal.turn_open = false;
        }
        if status == LoopStatus::Cancelled && self.user_interrupted {
            self.reload_journal_messages()
                .await
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    async fn settle_control_at_boundary(&mut self) -> Result<bool, RunFailure> {
        loop {
            self.drain_commands(false).await?;
            if !self.paused {
                break;
            }
            self.wait_while_paused(false).await?;
        }
        self.flush_pending_messages().await
    }

    async fn flush_pending_messages(&mut self) -> Result<bool, RunFailure> {
        if self.pending_messages.is_empty() {
            return Ok(false);
        }
        let pending = self.pending_messages.drain(..).collect::<Vec<_>>();
        let mut events = Vec::new();
        if self.journal.is_some() {
            for message in &pending {
                match message.role {
                    Role::User => events.push(SessionEventData::UserMessage {
                        message: message.clone(),
                        surface_replace: None,
                    }),
                    Role::System => {}
                    Role::Assistant | Role::Tool => {
                        return Err(RunFailure::Failed(
                            "event-sourced runtime injection accepts user/system messages only"
                                .to_owned(),
                        ));
                    }
                }
            }
            self.journal_append(events, true).await?;
            // MessageInjected only acknowledges acceptance into the in-memory
            // pending list. Publish consumption only after user/message is durable.
            self.emit(LoopEventKind::InputCommitted).await?;
        }
        if self.journal.is_none() {
            if let Some(message) = pending
                .iter()
                .rev()
                .find(|message| message.role == Role::User)
            {
                self.user_request_scope = Some(UserRequestScope::new(None, message));
            }
        }
        self.messages.extend(pending);
        self.snapshot("message_injected", self.tool_batch_complete)
            .await?;
        Ok(true)
    }

    async fn drain_commands(&mut self, allow_model_interrupt: bool) -> Result<bool, RunFailure> {
        let mut interrupt = false;
        loop {
            match self.command_rx.try_recv() {
                Ok(envelope) => {
                    interrupt |= self
                        .handle_envelope(envelope, allow_model_interrupt)
                        .await?;
                }
                Err(mpsc::error::TryRecvError::Empty) => return Ok(interrupt),
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    self.command_open = false;
                    return Ok(interrupt);
                }
            }
        }
    }

    async fn handle_envelope(
        &mut self,
        envelope: CommandEnvelope,
        allow_model_interrupt: bool,
    ) -> Result<bool, RunFailure> {
        let CommandEnvelope {
            command,
            acknowledgement,
        } = envelope;
        if let Err(error) = self.validate_command(&command) {
            let _ = acknowledgement.send(Err(error));
            return Ok(false);
        }
        if matches!(&command, LoopCommand::Cancel | LoopCommand::InterruptByUser) {
            self.user_interrupted = matches!(&command, LoopCommand::InterruptByUser);
            // Publish acceptance before cancellation tears down the runner and
            // closes the command receiver.
            let _ = acknowledgement.send(Ok(()));
            self.cancellation.cancel();
            return Err(self.stopped_failure());
        }

        match self.handle_command(command, allow_model_interrupt).await {
            Ok(interrupt) => {
                let _ = acknowledgement.send(Ok(()));
                Ok(interrupt)
            }
            Err(error) => {
                let _ = acknowledgement.send(Err(LoopControlError::Closed));
                Err(error)
            }
        }
    }

    fn validate_command(&self, command: &LoopCommand) -> Result<(), LoopControlError> {
        if let LoopCommand::ApproveTool { call_id }
        | LoopCommand::ReviewToolDecision { call_id, .. }
        | LoopCommand::RejectTool { call_id, .. } = command
        {
            if self.closed_approval_calls.contains(call_id) {
                return Err(LoopControlError::Rejected(
                    "approval is no longer pending".into(),
                ));
            }
        }
        if let LoopCommand::ReviewToolDecision {
            user_request_seq,
            user_request_sha256,
            ..
        } = command
        {
            if self
                .pending_messages
                .iter()
                .any(|message| matches!(message.role, Role::User | Role::System))
                || self.user_request_scope.as_ref().is_none_or(|scope| {
                    scope.seq != *user_request_seq || scope.sha256 != *user_request_sha256
                })
            {
                return Err(LoopControlError::Rejected(
                    "reviewed user request changed; manual approval required".into(),
                ));
            }
        }
        if self.journal.is_none() {
            return Ok(());
        }
        let message = match command {
            LoopCommand::InjectMessage { message, .. } | LoopCommand::Steer(message) => message,
            _ => return Ok(()),
        };
        if matches!(message.role, Role::User | Role::System) {
            Ok(())
        } else {
            Err(LoopControlError::Rejected(
                "journal-backed message injection accepts user/system roles only".to_owned(),
            ))
        }
    }

    async fn handle_command(
        &mut self,
        command: LoopCommand,
        allow_model_interrupt: bool,
    ) -> Result<bool, RunFailure> {
        match command {
            LoopCommand::InjectMessage { message, mode } => {
                self.emit(LoopEventKind::MessageInjected {
                    message: message.clone(),
                    mode,
                })
                .await?;
                self.pending_messages.push_back(message);
                if mode == InjectionMode::InterruptModel {
                    self.network_backoff.reset();
                }
                Ok(allow_model_interrupt && mode == InjectionMode::InterruptModel)
            }
            LoopCommand::Steer(message) => {
                self.emit(LoopEventKind::MessageInjected {
                    message: message.clone(),
                    mode: InjectionMode::InterruptModel,
                })
                .await?;
                self.pending_messages.push_back(message);
                self.network_backoff.reset();
                Ok(allow_model_interrupt)
            }
            LoopCommand::Pause => {
                if !self.paused {
                    self.paused = true;
                    self.emit(LoopEventKind::RunPaused).await?;
                }
                Ok(false)
            }
            LoopCommand::Resume => {
                if self.paused {
                    self.paused = false;
                    self.emit(LoopEventKind::RunResumed).await?;
                }
                Ok(false)
            }
            LoopCommand::Cancel | LoopCommand::InterruptByUser => {
                unreachable!("cancel commands are handled by the envelope")
            }
            LoopCommand::ApproveTool { call_id } => {
                self.store_approval(call_id, ApprovalDecision::Approved);
                Ok(false)
            }
            LoopCommand::ReviewToolDecision {
                call_id, approved, ..
            } => {
                self.store_approval(
                    call_id,
                    if approved {
                        ApprovalDecision::Approved
                    } else {
                        ApprovalDecision::Rejected("rejected by independent AI review".into())
                    },
                );
                Ok(false)
            }
            LoopCommand::RejectTool { call_id, reason } => {
                self.store_approval(call_id, ApprovalDecision::Rejected(reason));
                Ok(false)
            }
        }
    }

    fn store_approval(&mut self, call_id: String, decision: ApprovalDecision) {
        const MAX_BUFFERED_APPROVALS: usize = 1_024;
        if self.approval_decisions.len() >= MAX_BUFFERED_APPROVALS
            && !self.approval_decisions.contains_key(&call_id)
        {
            if let Some(oldest) = self.approval_decisions.keys().next().cloned() {
                self.approval_decisions.remove(&oldest);
            }
        }
        self.approval_decisions.insert(call_id, decision);
    }

    async fn wait_while_paused(&mut self, allow_model_interrupt: bool) -> Result<bool, RunFailure> {
        let mut interrupt = false;
        while self.paused && !interrupt {
            if !self.command_open {
                self.cancellation.cancel();
                return Err(RunFailure::Stopped(StopReason::ConsumerStopped));
            }
            let envelope = tokio::select! {
                _ = self.cancellation.cancelled() => return Err(self.stopped_failure()),
                command = self.command_rx.recv() => command,
            };
            match envelope {
                Some(envelope) => {
                    interrupt = self
                        .handle_envelope(envelope, allow_model_interrupt)
                        .await?;
                }
                None => {
                    self.command_open = false;
                    self.cancellation.cancel();
                    return Err(RunFailure::Stopped(StopReason::ConsumerStopped));
                }
            }
        }
        Ok(interrupt)
    }

    fn ensure_running(&self) -> Result<(), RunFailure> {
        if self.cancellation.is_cancelled() {
            Err(self.stopped_failure())
        } else {
            Ok(())
        }
    }

    fn stopped_failure(&self) -> RunFailure {
        RunFailure::Stopped(if self.consumer_dropped.load(Ordering::Acquire) {
            StopReason::ConsumerStopped
        } else {
            StopReason::Cancelled
        })
    }

    async fn emit(&mut self, kind: LoopEventKind) -> Result<(), RunFailure> {
        self.seq += 1;
        let event = LoopEvent {
            seq: self.seq,
            run_id: self.run_id.clone(),
            step: self.step,
            kind,
        };
        self.debug("loop.event", || json!({"event": &event})).await;
        self.event_journal
            .append(event)
            .map_err(|error| RunFailure::Failed(format!("could not serialize loop event: {error}")))
    }

    fn debug(
        &self,
        event: &str,
        payload: impl FnOnce() -> Value,
    ) -> impl std::future::Future<Output = ()> + Send + '_ {
        let scope = self.debug_scope();
        self.request
            .debug
            .record_lossy_with("core", event, scope, payload)
    }

    fn debug_scope(&self) -> DebugScope {
        let mut scope = DebugScope::default().with_run(self.run_id.clone());
        if let Some(session_id) = self.request.session_id.as_ref() {
            scope = scope.with_session(session_id.clone());
        }
        scope.step = u64::try_from(self.step).ok();
        if let Some(journal) = self.journal.as_ref() {
            scope.turn = Some(u64::from(journal.turn));
        }
        scope
    }

    async fn snapshot(&self, phase: &str, tool_batch_complete: bool) -> Result<(), RunFailure> {
        if self.journal.is_some() {
            return Ok(());
        }
        let Some(session_id) = self.request.session_id.as_deref() else {
            return Ok(());
        };
        self.request
            .session_store
            .save(
                session_id,
                SessionSnapshot {
                    session_id: session_id.to_owned(),
                    messages: self.messages.clone(),
                    phase: phase.to_owned(),
                    step: self.step,
                    tool_batch_complete,
                },
            )
            .await
            .map_err(RunFailure::Failed)
    }

    async fn restore_messages(&mut self) -> Result<(), RunFailure> {
        if self.journal.is_some() {
            return self.initialize_journal().await;
        }
        if let Some(session_id) = self.request.session_id.as_deref() {
            if let Some(snapshot) = self
                .request
                .session_store
                .load(session_id)
                .await
                .map_err(RunFailure::Failed)?
            {
                self.messages = snapshot.messages;
                if !snapshot.tool_batch_complete {
                    if let Some(last) = self.messages.last().cloned() {
                        if last.role == Role::Assistant && !last.tool_calls.is_empty() {
                            for call in last.tool_calls {
                                let interrupted = ToolResult::failure(
                                    "tool batch interrupted; result unavailable; call was not replayed",
                                );
                                let (content, _) = tool_result_for_model(
                                    &interrupted,
                                    self.request.config.tool_result_limit_bytes,
                                );
                                self.messages
                                    .push(AgentMessage::tool(call.provider_id(), content));
                            }
                            self.snapshot("interrupted_tool_batch_closed", true).await?;
                        }
                    }
                }
            }
        }
        let history = std::mem::take(&mut self.messages);
        self.messages = self.prompt_prefixed(history);
        self.messages.extend(self.request.messages.clone());
        self.user_request_scope = self
            .messages
            .iter()
            .rev()
            .find(|message| message.role == Role::User)
            .map(|message| UserRequestScope::new(None, message));
        Ok(())
    }

    fn prompt_prefixed(&self, messages: Vec<AgentMessage>) -> Vec<AgentMessage> {
        let Some(prompt) = &self.request.prompt else {
            return messages;
        };
        let mut visible = Vec::with_capacity(messages.len().saturating_add(1));
        visible.push(AgentMessage::system(prompt.system()));
        visible.extend(messages);
        visible
    }

    /// A journal surface does not persist explicit System messages supplied by
    /// a caller without PromptAssembly. Preserve that live prefix when checking
    /// a compaction candidate and when reloading its committed history. This is
    /// deliberately separate from initial admission, which still extends the
    /// caller's messages once after loading the journal.
    fn compaction_prefixed_history(&self, messages: Vec<AgentMessage>) -> Vec<AgentMessage> {
        if self.request.prompt.is_some() {
            return self.prompt_prefixed(messages);
        }
        let mut visible = self
            .messages
            .iter()
            .filter(|message| message.role == Role::System)
            .cloned()
            .collect::<Vec<_>>();
        visible.extend(messages);
        visible
    }

    fn retry_entropy(&self) -> u64 {
        let digest = Sha256::digest(format!("{}:{}:{}", self.run_id, self.step, self.seq));
        u64::from_le_bytes(digest[..8].try_into().expect("hash prefix"))
    }

    async fn wait_model_retry(
        &mut self,
        plan: RetryPlan,
        error: &ProviderError,
        recovery_deadline: Option<tokio::time::Instant>,
        continuation: bool,
    ) -> Result<bool, RunFailure> {
        self.ensure_running()?;
        let RetryPlan {
            attempt,
            max_retries,
            delay_ms,
        } = plan;
        // Each policy/phase owns a separate chain. Transport followed by HTTP,
        // or pre-output retries followed by a partial continuation, cannot
        // reuse an id with a different owner or restart its attempt sequence.
        let mut retry_id = self.model_retry_id();
        if max_retries.is_none() {
            retry_id.push_str("-network");
        }
        let mut policy_key = max_retries.map_or_else(
            || "xharness:network-wait".into(),
            |n| format!("xharness:normal:{n}"),
        );
        if continuation {
            retry_id.push_str("-continuation");
            policy_key.push_str(":continuation");
        }
        self.journal_model_retry_scheduled(
            &retry_id,
            attempt,
            max_retries,
            policy_key.clone(),
            error,
            delay_ms,
        )
        .await?;
        self.emit(LoopEventKind::ModelRetry {
            retry_id: retry_id.clone(),
            policy_key,
            attempt,
            max_retries,
            error: error.diagnostic_message(),
            delay_ms,
        })
        .await?;
        let wake = tokio::time::Instant::now() + Duration::from_millis(delay_ms);
        loop {
            self.ensure_running()?;
            if self.paused && self.wait_while_paused(true).await? {
                return Ok(true);
            }
            if recovery_deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
                return Err(RunFailure::provider(
                    error,
                    "provider recovery deadline exceeded while waiting".into(),
                ));
            }
            tokio::select! {
                _ = self.cancellation.cancelled() => return Err(self.stopped_failure()),
                _ = tokio::time::sleep_until(wake) => break,
                command = self.command_rx.recv(), if self.command_open => {
                    match command {
                        Some(envelope) => if self.handle_envelope(envelope, true).await? { return Ok(true); },
                        None => self.command_open = false,
                    }
                }
            }
        }
        self.ensure_running()?;
        self.journal_model_retry_started(&retry_id, attempt).await?;
        self.emit(LoopEventKind::ModelRetryStarted { retry_id, attempt })
            .await?;
        Ok(false)
    }

    async fn model_round(&mut self, request: ProviderRequest) -> Result<ModelRound, RunFailure> {
        // Share an optional bounded validated snapshot with live observers for
        // this model round. Without it, their checkpoint reads can repeatedly
        // replay an oversized journal and contend with stream writes. Drop on
        // completion, error, steering or cancellation; never retain while idle.
        let _stream_read_scope = self
            .journal
            .as_ref()
            .and_then(|journal| journal.store.read_scope(&journal.session_id).ok());
        let mut round = ModelRound::default();
        let mut recovery = RetryState::with_deadline(self.network_recovery_deadline);
        let mut last_provider_error: Option<ProviderError> = None;
        let mut reception_attempt = 0u32;

        loop {
            self.ensure_running()?;
            let mut reception = crate::reception::ReceptionRecorder::new(reception_attempt);
            reception_attempt = reception_attempt.saturating_add(1);
            let provider_cancellation = self.cancellation.child_token();
            let provider = self.request.provider.clone();
            let mut stream_future =
                Box::pin(provider.stream(request.clone(), provider_cancellation.clone()));
            let stream = loop {
                enum ProviderStart {
                    Command(Option<CommandEnvelope>),
                    Ready(Result<crate::ProviderStream, ProviderError>),
                }
                let next = tokio::select! {
                    _ = self.cancellation.cancelled() => return Err(self.stopped_failure()),
                    _ = recovery_timeout(recovery.deadline), if !round.saw_delta => {
                        provider_cancellation.cancel();
                        let message = "provider recovery deadline exceeded before model output".to_owned();
                        return Err(last_provider_error.as_ref().map_or_else(|| RunFailure::Failed(message.clone()), |e| RunFailure::provider(e, message.clone())));
                    },
                    command = self.command_rx.recv(), if self.command_open => {
                        ProviderStart::Command(command)
                    }
                    stream = &mut stream_future => ProviderStart::Ready(stream),
                };
                match next {
                    ProviderStart::Ready(stream) => break stream,
                    ProviderStart::Command(Some(envelope)) => {
                        let interrupt = self.handle_envelope(envelope, true).await?;
                        let interrupt = if self.paused && !interrupt {
                            self.wait_while_paused(true).await?
                        } else {
                            interrupt
                        };
                        if interrupt {
                            provider_cancellation.cancel();
                            round.interrupted = true;
                            self.emit(LoopEventKind::ModelInterrupted).await?;
                            return Ok(round);
                        }
                    }
                    ProviderStart::Command(None) => self.command_open = false,
                }
            };

            let mut stream = match stream {
                Ok(stream) => stream,
                Err(error) => {
                    // Cancellation may make provider.stream resolve with an error
                    // in the same poll that the cancellation branch becomes ready.
                    self.ensure_running()?;
                    if error.is_context_overflow() && !round.saw_delta {
                        return Err(RunFailure::ContextOverflow(error.message));
                    }
                    last_provider_error = Some(error.clone());
                    if !round.saw_delta {
                        let entropy = self.retry_entropy();
                        if let Some(plan) = recovery
                            .next(
                                &self.request.config,
                                &error,
                                entropy,
                                &mut self.network_backoff,
                            )
                            .map_err(|message| RunFailure::provider(&error, message))?
                        {
                            provider_cancellation.cancel();
                            if self
                                .wait_model_retry(plan, &error, recovery.deadline, false)
                                .await?
                            {
                                round.interrupted = true;
                                self.emit(LoopEventKind::ModelInterrupted).await?;
                                return Ok(round);
                            }
                            continue;
                        }
                    }
                    return Err(RunFailure::provider(&error, error.diagnostic_message()));
                }
            };

            let mut failure: Option<ProviderError> = None;
            let mut pending_tool_deltas = Vec::new();
            let mut pending_tool_bytes = 0usize;
            loop {
                enum ModelInput {
                    Command(Option<CommandEnvelope>),
                    Provider(Option<Result<ProviderEvent, ProviderError>>),
                    JournalDeadline,
                }
                // A quiet provider must not hold already received text until
                // its next delta. This deadline only publishes committed chunks;
                // the retry-safe tool prefix remains private until committed.
                let journal_deadline = self.journal.as_ref().and_then(|journal| {
                    journal
                        .stream_batch_started_at
                        .map(|started| started + STREAM_JOURNAL_BATCH_INTERVAL)
                });
                let next = tokio::select! {
                    _ = self.cancellation.cancelled() => return Err(self.stopped_failure()),
                    _ = recovery_timeout(recovery.deadline), if !round.saw_delta => {
                        provider_cancellation.cancel();
                        let message = "provider recovery deadline exceeded before model output".to_owned();
                        return Err(last_provider_error.as_ref().map_or_else(|| RunFailure::Failed(message.clone()), |e| RunFailure::provider(e, message.clone())));
                    },
                    command = self.command_rx.recv(), if self.command_open => {
                        ModelInput::Command(command)
                    }
                    event = stream.next() => ModelInput::Provider(event),
                    _ = async {
                        match journal_deadline {
                            Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
                            None => std::future::pending::<()>().await,
                        }
                    } => ModelInput::JournalDeadline,
                };
                match next {
                    ModelInput::JournalDeadline => {
                        self.journal_append_events(Vec::new(), false).await?;
                        self.emit(LoopEventKind::StreamCheckpoint).await?;
                    }
                    ModelInput::Command(Some(envelope)) => {
                        let interrupt = self.handle_envelope(envelope, true).await?;
                        let interrupt = if self.paused && !interrupt {
                            self.wait_while_paused(true).await?
                        } else {
                            interrupt
                        };
                        if interrupt {
                            provider_cancellation.cancel();
                            round.calls_by_index.clear();
                            round.provider_items.clear();
                            round.interrupted = true;
                            self.emit(LoopEventKind::ModelInterrupted).await?;
                            return Ok(round);
                        }
                    }
                    ModelInput::Command(None) => self.command_open = false,
                    ModelInput::Provider(Some(Ok(ProviderEvent::TextDelta(delta)))) => {
                        if delta.is_empty() {
                            continue;
                        }
                        if reception.observe("text", &delta) {
                            self.journal_reception(reception.checkpoint(false, None))
                                .await?;
                        }
                        self.commit_tool_prefix(&mut round, &mut pending_tool_deltas)
                            .await?;
                        round.saw_delta = true;
                        round.text.push_str(&delta);
                        let checkpoint = self
                            .journal_chunk(AssistantChunk::TextDelta(delta.clone()))
                            .await?;
                        self.emit(LoopEventKind::TextDelta(delta)).await?;
                        if checkpoint {
                            self.emit(LoopEventKind::StreamCheckpoint).await?;
                        }
                    }
                    ModelInput::Provider(Some(Ok(ProviderEvent::ReasoningDelta(delta)))) => {
                        if delta.is_empty() {
                            continue;
                        }
                        if reception.observe("reasoning", &delta) {
                            self.journal_reception(reception.checkpoint(false, None))
                                .await?;
                        }
                        self.commit_tool_prefix(&mut round, &mut pending_tool_deltas)
                            .await?;
                        round.saw_delta = true;
                        round.reasoning.push_str(&delta);
                        let checkpoint = self
                            .journal_chunk(AssistantChunk::ReasoningDelta(delta.clone()))
                            .await?;
                        self.emit(LoopEventKind::ReasoningDelta(delta)).await?;
                        if checkpoint {
                            self.emit(LoopEventKind::StreamCheckpoint).await?;
                        }
                    }
                    ModelInput::Provider(Some(Ok(ProviderEvent::ToolCallDelta {
                        index,
                        id,
                        name,
                        arguments_delta,
                    }))) => {
                        let observed = if arguments_delta.is_empty() {
                            &name
                        } else {
                            &arguments_delta
                        };
                        if reception.observe("arguments", observed) {
                            self.journal_reception(reception.checkpoint(false, None))
                                .await?;
                        }
                        pending_tool_bytes = pending_tool_bytes
                            .saturating_add(id.len())
                            .saturating_add(name.len())
                            .saturating_add(arguments_delta.len());
                        pending_tool_deltas.push(PendingToolDelta {
                            index,
                            id,
                            name,
                            arguments_delta,
                        });
                        if round.saw_delta || pending_tool_bytes >= MAX_RETRY_SAFE_TOOL_PREFIX_BYTES
                        {
                            // A provider can stream arbitrarily long arguments. Do not
                            // retain an unbounded retry buffer just to preserve retries.
                            // Once any output has been committed, keep later tool deltas live.
                            self.commit_tool_prefix(&mut round, &mut pending_tool_deltas)
                                .await?;
                            pending_tool_bytes = 0;
                        }
                    }
                    ModelInput::Provider(Some(Ok(ProviderEvent::Completed {
                        finish_reason,
                        usage,
                        provider_items,
                    }))) => {
                        // Snapshot the transport clock BEFORE releasing the private prefix.
                        self.journal_reception(reception.checkpoint(true, usage.as_ref()))
                            .await?;
                        self.commit_tool_prefix(&mut round, &mut pending_tool_deltas)
                            .await?;
                        let effective_finish_reason = finish_reason.clone().unwrap_or({
                            if round.calls_by_index.is_empty() {
                                FinishReason::Stop
                            } else {
                                FinishReason::ToolCalls
                            }
                        });
                        // Usage and terminal reason describe a provider request
                        // that has already completed. Account for it before any
                        // fallible journal operation so persistence failures do
                        // not erase billed usage from LoopResult.
                        self.record_model_completion(usage.clone(), effective_finish_reason);
                        if let Some(usage) = usage.as_ref() {
                            let value = serde_json::to_value(usage).map_err(|error| {
                                RunFailure::Failed(format!(
                                    "could not serialize token usage: {error}"
                                ))
                            })?;
                            let _ = self.journal_chunk(AssistantChunk::Usage(value)).await?;
                        }
                        if let Some(reason) = finish_reason.as_ref() {
                            let reason = match serde_json::to_value(reason).map_err(|error| {
                                RunFailure::Failed(format!(
                                    "could not serialize model finish reason: {error}"
                                ))
                            })? {
                                Value::String(reason) => reason,
                                reason => reason.to_string(),
                            };
                            let _ = self
                                .journal_chunk(AssistantChunk::Finish { reason })
                                .await?;
                        }
                        round.finish_reason = finish_reason;
                        round.usage = usage;
                        round.provider_items = provider_items;
                        round.completed = true;
                        break;
                    }
                    ModelInput::Provider(Some(Err(error))) => {
                        self.ensure_running()?;
                        failure = Some(error);
                        break;
                    }
                    ModelInput::Provider(None) => {
                        self.ensure_running()?;
                        failure = Some(ProviderError::new(
                            "provider stream ended without completed event",
                        ));
                        break;
                    }
                }
            }

            drop(stream); // Close the failed response before any backoff sleep.
            if round.completed {
                round.calls = round.calls_by_index.values().cloned().collect();
                return Ok(round);
            }
            let error = failure.expect("an incomplete provider attempt has an error");
            self.journal_reception(reception.checkpoint(true, None))
                .await?;
            if error.is_context_overflow() && !round.saw_delta {
                return Err(RunFailure::ContextOverflow(error.message));
            }
            last_provider_error = Some(error.clone());
            if !round.saw_delta {
                let entropy = self.retry_entropy();
                if let Some(plan) = recovery
                    .next(
                        &self.request.config,
                        &error,
                        entropy,
                        &mut self.network_backoff,
                    )
                    .map_err(|message| RunFailure::provider(&error, message))?
                {
                    provider_cancellation.cancel();
                    if self
                        .wait_model_retry(plan, &error, recovery.deadline, false)
                        .await?
                    {
                        round.interrupted = true;
                        self.emit(LoopEventKind::ModelInterrupted).await?;
                        return Ok(round);
                    }
                    continue;
                }
            }
            if round.saw_delta {
                if error.is_transient_transport()
                    && (self.request.config.network_wait_enabled
                        || (self.network_continuations < self.request.config.provider_retries
                            && recovery
                                .deadline
                                .is_none_or(|deadline| tokio::time::Instant::now() < deadline)))
                    && self.step < self.request.config.max_steps
                {
                    // Never replay a committed stream. Close this attempt and
                    // ask for a fresh continuation after the partial assistant
                    // has been durably recorded by the step loop. Fragmented
                    // tool calls are discarded; no handler has run yet.
                    provider_cancellation.cancel();
                    round.calls.clear();
                    round.provider_items.clear();
                    round.interrupted = true;
                    round.recoverable_transport_error = Some(error);
                    self.network_recovery_deadline = if self.request.config.network_wait_enabled {
                        None
                    } else {
                        recovery.deadline
                    };
                    self.emit(LoopEventKind::ModelInterrupted).await?;
                    return Ok(round);
                }
                // Never execute or replay an unacknowledged fragmented tool call.
                // Keep the original text/reasoning as explicitly interrupted history.
                let partial = AgentMessage {
                    content_blocks: Vec::new(),
                    id: None,
                    role: Role::Assistant,
                    content: round.text,
                    reasoning: round.reasoning,
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                    provider_items: Vec::new(),
                    interrupted: true,
                };
                if !partial.content.is_empty() || !partial.reasoning.is_empty() {
                    self.journal_assistant_message(&partial, None).await?;
                    self.continuation_text.push_str(&partial.content);
                    self.final_text = self.continuation_text.clone();
                    self.messages.push(partial);
                    self.snapshot("network_interrupted", true).await?;
                }
                return Err(RunFailure::provider(&error, format!(
                    "{}\n本轮已中断；已有文本已保留，未完成的工具调用未执行。请发送新消息“继续”明确恢复；这是新的模型请求，可能额外计费，不是原连接的无损续传。", error.diagnostic_message()
                )));
            }
            return Err(RunFailure::provider(&error, error.diagnostic_message()));
        }
    }

    async fn commit_tool_prefix(
        &mut self,
        round: &mut ModelRound,
        pending: &mut Vec<PendingToolDelta>,
    ) -> Result<(), RunFailure> {
        for delta in pending.drain(..) {
            round.saw_delta = true;
            let checkpoint = self
                .journal_chunk(AssistantChunk::ToolCallDelta {
                    index: delta.index,
                    id: delta.id.clone(),
                    name: delta.name.clone(),
                    arguments_delta: delta.arguments_delta.clone(),
                })
                .await?;
            self.emit(LoopEventKind::ToolCallDelta {
                index: delta.index,
                id: delta.id.clone(),
                name: delta.name.clone(),
                arguments_delta: delta.arguments_delta.clone(),
            })
            .await?;
            if checkpoint {
                self.emit(LoopEventKind::StreamCheckpoint).await?;
            }
            let call = round
                .calls_by_index
                .entry(delta.index)
                .or_insert_with(|| ToolCall {
                    index: delta.index,
                    ..ToolCall::default()
                });
            if !delta.id.is_empty() {
                call.id = delta.id;
            }
            if !delta.name.is_empty() {
                call.name = delta.name;
            }
            call.arguments_json.push_str(&delta.arguments_delta);
        }
        Ok(())
    }

    async fn journal_reception(
        &mut self,
        reception: xharness_session::ModelReception,
    ) -> Result<(), RunFailure> {
        let Some(journal) = self.journal.as_ref() else {
            return Ok(());
        };
        let turn = journal.turn;
        let step = u32::try_from(self.step)
            .map_err(|_| RunFailure::Failed("session step counter overflow".into()))?;
        if reception.finished {
            // Capture now, persist with the existing completion/retry batch.
            // Telemetry must not add a synchronous write to every short reply.
            self.journal
                .as_mut()
                .expect("journal checked above")
                .pending_stream_events
                .push(
                    SessionEventData::ModelReception {
                        turn,
                        step,
                        reception,
                    }
                    .into(),
                );
            return Ok(());
        }
        self.journal_append(
            vec![SessionEventData::ModelReception {
                turn,
                step,
                reception,
            }],
            false,
        )
        .await?;
        self.emit(LoopEventKind::StreamCheckpoint).await
    }

    async fn tool_definitions(&self) -> Vec<crate::ToolDefinition> {
        let Some(executor) = &self.request.tool_executor else {
            return Vec::new();
        };
        executor
            .registry()
            .definitions()
            .await
            .into_iter()
            .map(|definition| crate::ToolDefinition {
                name: definition.name,
                description: definition.description,
                parameters: definition.parameters,
            })
            .collect()
    }

    async fn execute_tool_batch(&mut self, calls: Vec<ToolCall>) -> Result<(), RunFailure> {
        self.execute_runtime_tool_batch(calls).await
    }

    async fn execute_runtime_tool_batch(&mut self, calls: Vec<ToolCall>) -> Result<(), RunFailure> {
        let call_count = calls.len();
        let calls = calls.into_iter().enumerate().collect::<Vec<_>>();
        let completed = self.run_runtime_tool_batch(calls, &HashMap::new()).await?;
        let mut ordered = std::iter::repeat_with(|| None)
            .take(call_count)
            .collect::<Vec<_>>();
        for execution in completed {
            let order = execution.order;
            ordered[order] = Some(execution);
        }
        self.finalize_tool_batch(ordered).await
    }

    async fn run_runtime_tool_batch(
        &mut self,
        calls: Vec<(usize, ToolCall)>,
        recovered_approvals: &HashMap<String, String>,
    ) -> Result<Vec<ToolExecution>, RunFailure> {
        let executor = self.request.tool_executor.clone().unwrap_or_else(|| {
            xharness_tools::ToolExecutor::new(Arc::new(xharness_tools::ToolRegistry::new()))
        });
        let (signal_tx, mut signal_rx) = mpsc::unbounded_channel();
        let bridge = Arc::new(CoreToolRuntimeBridge { signal_tx });
        let executor = executor
            .with_approval_provider(bridge.clone())
            .with_lifecycle(bridge);
        let mut requests = Vec::with_capacity(calls.len());
        for (order, call) in &calls {
            let request = RuntimeToolRequest::new(&call.name, &call.arguments_json)
                .with_cancellation(self.cancellation.child_token())
                .requiring_approval(recovered_approvals.contains_key(&call.id))
                .with_execution_id(call.id.clone())
                .map_err(|error| RunFailure::Failed(error.to_string()))?;
            requests.push(RuntimeBatchRequest::new(*order, request));
        }
        let mut batch = match executor
            .start_batch(requests, self.request.config.max_tool_concurrency)
            .await
        {
            Ok(batch) => batch,
            Err(error @ xharness_tools::ToolBatchError::StandaloneRequired { .. }) => {
                // Registry preflight rejected the ENTIRE batch before any
                // lifecycle/approval/handler started. This is a correctable
                // model invocation error, not a failed or unknown operation.
                // Do not silently serialize or execute a subset of the calls.
                let error = format!(
                    "{error}. No tools in this batch were executed. Retry the required work in separate batches; call the standalone tool only after other tool results have settled."
                );
                let mut completed = Vec::with_capacity(calls.len());
                for (order, call) in calls {
                    let mut result = ToolResult::failure(error.clone());
                    result.metadata = Some(json!({
                        "batchRejected": true,
                        "executionStarted": false,
                        "kind": "standalone_required",
                    }));
                    self.emit(LoopEventKind::ToolCompleted {
                        call: call.clone(),
                        result: result.clone(),
                    })
                    .await?;
                    completed.push(ToolExecution {
                        order,
                        call,
                        outcome: ToolOutcome::Error,
                        result,
                        model_text: String::new(),
                    });
                }
                return Ok(completed);
            }
            // Configuration/supervisor/order failures are NOT safe model
            // corrections and retain the original hard failure semantics.
            Err(error) => return Err(RunFailure::Failed(error.to_string())),
        };
        let mut completion_count = 0usize;
        let mut pending_approval_ids = Vec::<String>::new();
        let mut pending_runtime_approvals = Vec::<PendingRuntimeApproval>::new();

        while completion_count < calls.len() {
            enum RuntimeInput {
                Cancelled,
                Command(Option<CommandEnvelope>),
                Signal(Option<ToolRuntimeSignal>),
                Batch(Option<RuntimeBatchEvent>),
            }
            let input = tokio::select! {
                biased;
                _ = self.cancellation.cancelled() => RuntimeInput::Cancelled,
                command = self.command_rx.recv(), if self.command_open => {
                    RuntimeInput::Command(command)
                }
                event = batch.next_event() => RuntimeInput::Batch(event),
                signal = signal_rx.recv() => RuntimeInput::Signal(signal),
            };
            match input {
                RuntimeInput::Cancelled => {
                    self.cancel_runtime_tool_batch(
                        &mut batch,
                        &mut pending_approval_ids,
                        &mut pending_runtime_approvals,
                    )
                    .await?;
                    return Err(self.stopped_failure());
                }
                RuntimeInput::Command(Some(envelope)) => {
                    if let Err(failure) = self.handle_envelope(envelope, false).await {
                        self.cancel_runtime_tool_batch(
                            &mut batch,
                            &mut pending_approval_ids,
                            &mut pending_runtime_approvals,
                        )
                        .await?;
                        return Err(failure);
                    }
                }
                RuntimeInput::Command(None) => {
                    self.command_open = false;
                }
                RuntimeInput::Signal(Some(signal)) => {
                    if let Err(failure) = self
                        .handle_runtime_tool_signal(
                            signal,
                            &calls,
                            recovered_approvals,
                            &mut pending_approval_ids,
                            &mut pending_runtime_approvals,
                        )
                        .await
                    {
                        self.cancel_runtime_tool_batch(
                            &mut batch,
                            &mut pending_approval_ids,
                            &mut pending_runtime_approvals,
                        )
                        .await?;
                        return Err(failure);
                    }
                }
                RuntimeInput::Signal(None) => {
                    self.cancel_runtime_tool_batch(
                        &mut batch,
                        &mut pending_approval_ids,
                        &mut pending_runtime_approvals,
                    )
                    .await?;
                    return Err(RunFailure::Failed(
                        "tool runtime lifecycle channel closed before batch completion".to_owned(),
                    ));
                }
                RuntimeInput::Batch(Some(RuntimeBatchEvent::Completed(completed))) => {
                    let call = calls
                        .iter()
                        .find_map(|(order, call)| (*order == completed.order).then_some(call))
                        .ok_or_else(|| {
                            RunFailure::Failed(format!(
                                "tool runtime returned invalid batch order {}",
                                completed.order
                            ))
                        })?;
                    if completed.result.execution_id.as_str() != call.id {
                        batch.cancel();
                        return Err(RunFailure::Failed(format!(
                            "tool runtime execution id mismatch for order {}",
                            completed.order
                        )));
                    }
                    self.close_runtime_approvals(
                        &mut pending_runtime_approvals,
                        &mut pending_approval_ids,
                        Some(&call.id),
                    )
                    .await?;
                    self.closed_approval_calls.insert(call.id.clone());
                    let result = runtime_tool_result(&completed.result);
                    self.emit(LoopEventKind::ToolCompleted {
                        call: call.clone(),
                        result,
                    })
                    .await?;
                    completion_count += 1;
                }
                RuntimeInput::Batch(None) => {
                    self.cancel_runtime_tool_batch(
                        &mut batch,
                        &mut pending_approval_ids,
                        &mut pending_runtime_approvals,
                    )
                    .await?;
                    return Err(RunFailure::Failed(
                        "tool runtime batch stopped before every result completed".to_owned(),
                    ));
                }
            }
            self.resolve_runtime_approval_decisions(
                &mut pending_runtime_approvals,
                &mut pending_approval_ids,
            )
            .await?;
        }

        let ordered = batch
            .result()
            .await
            .map_err(|error| RunFailure::Failed(error.to_string()))?;
        let completed = ordered
            .into_iter()
            .map(|completed| {
                let call = calls
                    .iter()
                    .find_map(|(order, call)| (*order == completed.order).then_some(call.clone()))
                    .ok_or_else(|| {
                        RunFailure::Failed(format!(
                            "tool runtime returned invalid final order {}",
                            completed.order
                        ))
                    })?;
                let result = runtime_tool_result(&completed.result);
                Ok(ToolExecution {
                    order: completed.order,
                    call,
                    outcome: if result.ok {
                        ToolOutcome::Success
                    } else {
                        ToolOutcome::Error
                    },
                    result,
                    model_text: String::new(),
                })
            })
            .collect::<Result<Vec<_>, RunFailure>>()?;
        Ok(completed)
    }

    async fn cancel_runtime_tool_batch(
        &mut self,
        batch: &mut RuntimeBatchRun,
        pending_approval_ids: &mut Vec<String>,
        pending: &mut Vec<PendingRuntimeApproval>,
    ) -> Result<(), RunFailure> {
        batch.cancel();
        self.close_runtime_approvals(pending, pending_approval_ids, None)
            .await?;
        let journal = self
            .journal_cancel_pending_approvals(pending_approval_ids)
            .await;
        let settled = tokio::time::timeout(
            TOOL_CLEANUP_GRACE.saturating_add(Duration::from_secs(1)),
            batch.result(),
        )
        .await;
        journal?;
        match settled {
            Ok(Ok(results)) => {
                if results.iter().any(|completed| {
                    completed.result.failure_kind() == Some(RuntimeToolFailureKind::CleanupTimeout)
                }) {
                    return Err(RunFailure::Failed(
                        "forced cleanup: one or more tool handlers did not quiesce within the cleanup grace"
                            .to_owned(),
                    ));
                }
                Ok(())
            }
            Ok(Err(error)) => Err(RunFailure::Failed(format!(
                "cancelled tool batch failed to settle: {error}"
            ))),
            Err(_) => Err(RunFailure::Failed(
                "cancelled tool batch exceeded its cleanup grace".to_owned(),
            )),
        }
    }

    async fn handle_runtime_tool_signal(
        &mut self,
        signal: ToolRuntimeSignal,
        calls: &[(usize, ToolCall)],
        recovered_approvals: &HashMap<String, String>,
        pending_approval_ids: &mut Vec<String>,
        pending_runtime_approvals: &mut Vec<PendingRuntimeApproval>,
    ) -> Result<(), RunFailure> {
        match signal {
            ToolRuntimeSignal::Approval {
                execution_id,
                reasons,
                response,
            } => {
                if response.is_closed() {
                    return Ok(());
                }
                let (order, call) = calls
                    .iter()
                    .find(|(_, call)| call.id == execution_id)
                    .ok_or_else(|| {
                        RunFailure::Failed(format!(
                            "tool runtime requested approval for unknown execution {execution_id:?}"
                        ))
                    })?;
                let (approval_id, recovered) = match recovered_approvals.get(&execution_id) {
                    Some(approval_id) => (approval_id.clone(), true),
                    None => (self.approval_id(*order), false),
                };
                if !recovered {
                    self.journal_approval_asked(&approval_id, call, &reasons)
                        .await?;
                }
                pending_approval_ids.push(approval_id.clone());
                self.emit(LoopEventKind::ToolApprovalRequested {
                    approval_id: approval_id.clone(),
                    call: call.clone(),
                })
                .await?;
                pending_runtime_approvals.push(PendingRuntimeApproval {
                    execution_id,
                    approval_id,
                    call: call.clone(),
                    response,
                });
                Ok(())
            }
            ToolRuntimeSignal::Started {
                execution_id,
                acknowledgement,
            } => {
                let call = calls
                    .iter()
                    .find_map(|(_, call)| (call.id == execution_id).then_some(call))
                    .ok_or_else(|| {
                        RunFailure::Failed(format!(
                            "tool runtime started unknown execution {execution_id:?}"
                        ))
                    })?;
                self.emit(LoopEventKind::ToolStarted(call.clone())).await?;
                acknowledgement.send(Ok(())).map_err(|_| {
                    RunFailure::Failed(
                        "tool runtime stopped before lifecycle acknowledgement".to_owned(),
                    )
                })?;
                Ok(())
            }
        }
    }

    async fn close_runtime_approvals(
        &mut self,
        pending: &mut Vec<PendingRuntimeApproval>,
        ids: &mut Vec<String>,
        execution: Option<&str>,
    ) -> Result<(), RunFailure> {
        let mut i = 0;
        while i < pending.len() {
            if execution.is_some_and(|id| id != pending[i].execution_id) {
                i += 1;
                continue;
            }
            let approval = pending.remove(i);
            self.closed_approval_calls
                .insert(approval.execution_id.clone());
            self.approval_decisions.remove(&approval.execution_id);
            self.journal_approval_decided(&approval.approval_id, ApprovalOutcome::Cancelled)
                .await?;
            ids.retain(|id| id != &approval.approval_id);
            self.emit(LoopEventKind::ToolApprovalResolved {
                approval_id: approval.approval_id,
                call: approval.call,
                approved: false,
                cancelled: true,
                reason: Some("approval expired or its tool invocation ended".into()),
            })
            .await?;
        }
        Ok(())
    }

    async fn resolve_runtime_approval_decisions(
        &mut self,
        pending: &mut Vec<PendingRuntimeApproval>,
        pending_approval_ids: &mut Vec<String>,
    ) -> Result<(), RunFailure> {
        let closed = pending
            .iter()
            .filter(|p| p.response.is_closed())
            .map(|p| p.execution_id.clone())
            .collect::<Vec<_>>();
        for id in closed {
            self.close_runtime_approvals(pending, pending_approval_ids, Some(&id))
                .await?;
        }
        if self.paused {
            return Ok(());
        }
        let mut index = 0usize;
        while index < pending.len() {
            let Some(decision) = self.approval_decisions.remove(&pending[index].execution_id)
            else {
                index += 1;
                continue;
            };
            let approval = pending.remove(index);
            self.closed_approval_calls
                .insert(approval.execution_id.clone());
            let (runtime, outcome, approved, reason) = match decision {
                ApprovalDecision::Approved => (
                    RuntimeApprovalDecision::Approved,
                    ApprovalOutcome::AllowedOnce,
                    true,
                    None,
                ),
                ApprovalDecision::Rejected(reason) => {
                    let reason = if reason.trim().is_empty() {
                        "rejected by host".to_owned()
                    } else {
                        reason
                    };
                    (
                        RuntimeApprovalDecision::Denied {
                            reason: reason.clone(),
                        },
                        ApprovalOutcome::Rejected,
                        false,
                        Some(reason),
                    )
                }
            };
            self.journal_approval_decided(&approval.approval_id, outcome)
                .await?;
            pending_approval_ids.retain(|id| id != &approval.approval_id);
            self.emit(LoopEventKind::ToolApprovalResolved {
                approval_id: approval.approval_id,
                call: approval.call,
                approved,
                cancelled: false,
                reason,
            })
            .await?;
            // A deadline may win while the durable decision is being flushed.
            // The executor's terminal result remains authoritative; do not fail
            // the whole agent or revive the expired invocation.
            if approval.response.send(Ok(runtime)).is_err() {
                self.debug(
                    "approval.delivery_expired",
                    || json!({"executionId":approval.execution_id}),
                )
                .await;
            }
        }
        Ok(())
    }

    async fn resume_tool_batch(&mut self, recovery: RecoveredToolBatch) -> Result<(), RunFailure> {
        self.resume_runtime_tool_batch(recovery).await
    }

    async fn resume_runtime_tool_batch(
        &mut self,
        recovery: RecoveredToolBatch,
    ) -> Result<(), RunFailure> {
        let call_count = recovery.calls.len();
        let mut completed = std::iter::repeat_with(|| None)
            .take(call_count)
            .collect::<Vec<Option<ToolExecution>>>();
        let mut pending = Vec::<(usize, ToolCall)>::new();
        let mut recovered_approvals = HashMap::<String, String>::new();

        for (order, recovered) in recovery.calls.into_iter().enumerate() {
            match recovered.approval {
                Some(approval) => {
                    recovered_approvals.insert(recovered.call.id.clone(), approval.id);
                    pending.push((order, recovered.call));
                }
                None if recovered.replay_safe => {
                    pending.push((order, recovered.call));
                }
                None => {
                    let result = ToolResult::failure(xharness_session::OUTCOME_UNKNOWN_CONTENT);
                    let execution = ToolExecution {
                        order,
                        call: recovered.call,
                        outcome: ToolOutcome::OutcomeUnknown,
                        result,
                        model_text: xharness_session::OUTCOME_UNKNOWN_CONTENT.to_owned(),
                    };
                    self.emit(LoopEventKind::ToolCompleted {
                        call: execution.call.clone(),
                        result: execution.result.clone(),
                    })
                    .await?;
                    completed[order] = Some(execution);
                }
            }
        }

        if !pending.is_empty() {
            for execution in self
                .run_runtime_tool_batch(pending, &recovered_approvals)
                .await?
            {
                let order = execution.order;
                completed[order] = Some(execution);
            }
        }
        self.finalize_tool_batch(completed).await
    }

    async fn finalize_tool_batch(
        &mut self,
        completed: Vec<Option<ToolExecution>>,
    ) -> Result<(), RunFailure> {
        let mut completed = completed.into_iter().flatten().collect::<Vec<_>>();
        for execution in &mut completed {
            if execution.outcome == ToolOutcome::OutcomeUnknown {
                continue;
            }
            let limit = self.request.config.tool_result_limit_bytes;
            let raw = serde_json::to_string(&execution.result).map_err(|e| {
                RunFailure::Failed(format!("could not serialize original tool result: {e}"))
            })?;
            if let Some(journal) = &self.journal {
                if raw.len() > limit.min(xharness_session::TOOL_ARCHIVE_THRESHOLD_BYTES) {
                    let reference = journal.store.archive_tool_result(&journal.session_id, &raw).await
                        .map_err(|e| RunFailure::Failed(format!("could not persist original tool result for {}: {e}. The tool may already have performed side effects; it was not retried. No recoverable reference was published.", execution.call.id)))?;
                    execution.model_text = crate::tool::tool_result_with_archive(
                        &execution.result,
                        &reference,
                        // Archival decides where the original lives, not how
                        // much of an already bounded observation the model sees.
                        limit,
                    )
                    .map_err(RunFailure::Failed)?;
                    continue;
                }
            }
            execution.model_text = tool_result_for_model(&execution.result, limit).0;
        }
        for execution in &completed {
            let spec = if let Some(executor) = &self.request.tool_executor {
                executor.registry().get(&execution.call.name).await
            } else {
                None
            };
            if spec.as_ref().is_some_and(|s| s.repetition_exempt) {
                continue;
            }
            let result = &execution.result;
            let mut content = result.content.clone();
            let mut ok = result.ok;
            let mut reliable = !result.truncated;
            if result.ok || !content.is_empty() {
                if let Some(adapter) = spec.as_ref().and_then(|s| s.repetition_observation) {
                    match adapter(&content) {
                        Some((success, value)) => {
                            ok = success;
                            content = serde_json::to_string(&value)
                                .map_err(|e| RunFailure::Failed(e.to_string()))?;
                        }
                        None => reliable = false,
                    }
                }
            }
            crate::checkpoint::observe(
                &mut self.checkpoint,
                &self.request.config.checkpoints,
                &execution.call.name,
                &execution.call.arguments_json,
                ok,
                &content,
                &result.error,
                reliable,
            );
        }
        self.journal_tool_results(&completed).await?;
        for execution in completed {
            let mut message =
                AgentMessage::tool(execution.call.provider_id(), execution.model_text);
            message.content_blocks = xharness_session::ContentBlock::from_tool_metadata(
                execution.result.metadata.as_ref(),
            );
            self.messages.push(message);
        }
        Ok(())
    }
}

fn local_tool_cost(tools: &[Value]) -> Result<u64, RunFailure> {
    let bytes = serde_json::to_vec(tools)
        .map_err(|error| RunFailure::Failed(error.to_string()))?
        .len() as u64;
    Ok(bytes
        .div_ceil(3)
        .saturating_add((tools.len() as u64).saturating_mul(8)))
}

fn sha256_json(value: &impl Serialize) -> Result<String, RunFailure> {
    let encoded = serde_json::to_vec(value)
        .map_err(|error| RunFailure::Failed(format!("could not encode request audit: {error}")))?;
    let mut digest = Sha256::new();
    digest.update(encoded);
    Ok(format!("{:x}", digest.finalize()))
}

#[derive(Default)]
struct ModelRound {
    text: String,
    reasoning: String,
    calls_by_index: std::collections::BTreeMap<usize, ToolCall>,
    calls: Vec<ToolCall>,
    provider_items: Vec<Value>,
    finish_reason: Option<FinishReason>,
    usage: Option<TokenUsage>,
    completed: bool,
    saw_delta: bool,
    interrupted: bool,
    recoverable_transport_error: Option<ProviderError>,
}

struct PendingToolDelta {
    index: usize,
    id: String,
    name: String,
    arguments_delta: String,
}

#[derive(Clone, Debug)]
enum ApprovalDecision {
    Approved,
    Rejected(String),
}

enum ToolRuntimeSignal {
    Approval {
        execution_id: String,
        reasons: Vec<String>,
        response: oneshot::Sender<Result<RuntimeApprovalDecision, RuntimeMiddlewareError>>,
    },
    Started {
        execution_id: String,
        acknowledgement: oneshot::Sender<Result<(), RuntimeMiddlewareError>>,
    },
}

struct PendingRuntimeApproval {
    execution_id: String,
    approval_id: String,
    call: ToolCall,
    response: oneshot::Sender<Result<RuntimeApprovalDecision, RuntimeMiddlewareError>>,
}

struct CoreToolRuntimeBridge {
    signal_tx: mpsc::UnboundedSender<ToolRuntimeSignal>,
}

#[async_trait]
impl RuntimeApprovalProvider for CoreToolRuntimeBridge {
    async fn request_approval(
        &self,
        request: RuntimeApprovalRequest,
    ) -> Result<RuntimeApprovalDecision, RuntimeMiddlewareError> {
        let (response, receiver) = oneshot::channel();
        self.signal_tx
            .send(ToolRuntimeSignal::Approval {
                execution_id: request.context.execution_id.to_string(),
                reasons: request.reasons,
                response,
            })
            .map_err(|_| RuntimeMiddlewareError::new("core tool approval channel is closed"))?;
        receiver
            .await
            .map_err(|_| RuntimeMiddlewareError::new("core tool approval response was dropped"))?
    }
}

#[async_trait]
impl RuntimeToolLifecycle for CoreToolRuntimeBridge {
    async fn started(
        &self,
        context: &RuntimeExecutionContext,
    ) -> Result<(), RuntimeMiddlewareError> {
        let (acknowledgement, receiver) = oneshot::channel();
        self.signal_tx
            .send(ToolRuntimeSignal::Started {
                execution_id: context.execution_id.to_string(),
                acknowledgement,
            })
            .map_err(|_| RuntimeMiddlewareError::new("core tool lifecycle channel is closed"))?;
        receiver.await.map_err(|_| {
            RuntimeMiddlewareError::new("core tool lifecycle acknowledgement was dropped")
        })?
    }
}

fn runtime_tool_result(result: &xharness_tools::ToolResult) -> ToolResult {
    match (&result.output, &result.failure) {
        (Some(output), Some(failure)) => ToolResult {
            ok: false,
            content: output.content.clone(),
            error: failure.message.clone(),
            truncated: false,
            metadata: output.metadata.clone(),
        },
        (Some(output), None) => ToolResult {
            ok: true,
            content: output.content.clone(),
            error: String::new(),
            truncated: false,
            metadata: output.metadata.clone(),
        },
        (_, Some(failure)) => ToolResult::failure(failure.message.clone()),
        (None, None) => ToolResult::failure("tool runtime returned neither output nor failure"),
    }
}

struct RecoveredToolBatch {
    calls: Vec<RecoveredToolCall>,
}

struct RecoveredToolCall {
    call: ToolCall,
    approval: Option<PendingToolApproval>,
    replay_safe: bool,
}

fn assistant_chunk_bytes(chunk: &AssistantChunk) -> usize {
    match chunk {
        AssistantChunk::TextDelta(value)
        | AssistantChunk::ReasoningDelta(value)
        | AssistantChunk::Finish { reason: value } => value.len(),
        AssistantChunk::ToolCallDelta {
            id,
            name,
            arguments_delta,
            ..
        } => id
            .len()
            .saturating_add(name.len())
            .saturating_add(arguments_delta.len()),
        AssistantChunk::Usage(value) | AssistantChunk::Provider(value) => value.to_string().len(),
    }
}

fn stream_identity_fragment_is_compatible(buffered: &str, incoming: &str) -> bool {
    buffered.is_empty() || incoming.is_empty() || buffered == incoming
}

struct ToolExecution {
    order: usize,
    call: ToolCall,
    outcome: ToolOutcome,
    result: ToolResult,
    model_text: String,
}

#[derive(Debug, thiserror::Error)]
enum RunFailure {
    #[error("run stopped: {0:?}")]
    Stopped(StopReason),
    #[error("{0}")]
    Failed(String),
    #[error("provider context overflow: {0}")]
    ContextOverflow(String),
    #[error("{message}")]
    Provider {
        message: String,
        failure: xharness_session::ProviderFailure,
    },
}
impl RunFailure {
    fn provider(error: &ProviderError, message: String) -> Self {
        Self::Provider {
            message,
            failure: xharness_session::ProviderFailure {
                retryable: error.is_transient_transport()
                    || (error.retryable
                        && error
                            .http_status
                            .is_some_and(|s| s == 408 || s == 429 || (500..600).contains(&s))),
                http_status: error.http_status,
                retry_after_ms: error.retry_after_ms,
            },
        }
    }
    fn context(self, context: String) -> Self {
        match self {
            Self::Provider { failure, .. } => Self::Provider {
                message: context,
                failure,
            },
            other @ Self::Stopped(_) => other,
            _ => Self::Failed(context),
        }
    }
}

impl From<String> for RunFailure {
    fn from(value: String) -> Self {
        Self::Failed(value)
    }
}

async fn recovery_timeout(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(at).await,
        None => futures::future::pending::<()>().await,
    }
}

#[cfg(test)]
fn retry_delay_ms(
    config: &crate::LoopConfig,
    retry: usize,
    retry_after: Option<u64>,
    entropy: u64,
) -> u64 {
    crate::retry::retry_delay(
        config,
        retry,
        retry_after,
        entropy,
        config.provider_retry_max_delay_ms,
    )
}

#[cfg(test)]
mod retry_policy_tests {
    use super::*;
    #[test]
    fn failed_command_keeps_captured_output_in_core_projection() {
        let runtime = xharness_tools::ToolResult {
            execution_id: xharness_tools::ExecutionId::new("failed-command").unwrap(),
            tool_name: "bash".to_owned(),
            output: Some(xharness_tools::ToolOutput {
                content: r#"{"success":false,"exit_code":7}"#.to_owned(),
                metadata: Some(json!({"exit_code": 7})),
                command_failure: Some("shell command exited with code 7".to_owned()),
            }),
            failure: Some(xharness_tools::ToolFailure::new(
                xharness_tools::ToolFailureKind::CommandFailed,
                "shell command exited with code 7",
            )),
            started_at_ms: 0,
            completed_at_ms: 1,
            duration_ms: 1,
            observer_errors: Vec::new(),
        };
        let projected = runtime_tool_result(&runtime);
        assert!(!projected.ok);
        assert!(projected.content.contains("\"exit_code\":7"));
        assert!(projected.error.contains("code 7"));
        assert_eq!(projected.metadata.unwrap()["exit_code"], 7);
    }

    #[test]
    fn exponential_delay_jitter_cap_and_server_minimum() {
        let mut config = crate::LoopConfig {
            provider_retry_jitter_percent: 0,
            ..Default::default()
        };
        for (retry, expected) in [
            (1, 500),
            (2, 1000),
            (3, 2000),
            (20, 8000),
            (usize::MAX, 8000),
        ] {
            assert_eq!(retry_delay_ms(&config, retry, None, 0), expected);
        }
        config.provider_retry_jitter_percent = 20;
        let delays: std::collections::BTreeSet<_> = (0..1000)
            .map(|seed| retry_delay_ms(&config, 1, None, seed))
            .collect();
        assert_eq!(delays.first(), Some(&400));
        assert_eq!(delays.last(), Some(&600));
        assert_eq!(retry_delay_ms(&config, 1, Some(30_000), 999), 30_000);
        assert_eq!(retry_delay_ms(&config, 1, Some(u64::MAX), 999), u64::MAX);
    }
}

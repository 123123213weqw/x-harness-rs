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
use futures::{stream::FuturesUnordered, FutureExt, Stream, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_stream::wrappers::WatchStream;
use tokio_util::sync::CancellationToken;
use xharness_compaction::{
    frame_summary, BasicCompactionPlanner, CompactionDecision, CompactionPlan, CompactionRequest,
    CompactionTrigger, ModelTarget, SurfaceNode, SurfaceNodeKind, DEFAULT_COMPACTION_INSTRUCTION,
};
use xharness_debug::{DebugEvent, DebugScope};
use xharness_session::{
    ApprovalOutcome, AssistantChunk, EventData as SessionEventData, LlmFailure, LlmRetryMode,
    PendingToolApproval, RequestHeader, Revision, SequenceRange, SessionEvent, SessionHeader,
    Store as EventSessionStore, SurfaceReplace, ToolOutcome, ToolResultData, TurnEndReason,
};

/// Bound both crash-loss and memory growth without returning to one JSONL
/// read/validate/append cycle per provider fragment.
const STREAM_JOURNAL_BATCH_EVENTS: usize = 64;
const STREAM_JOURNAL_BATCH_BYTES: usize = 4 * 1_024;
const STREAM_JOURNAL_BATCH_INTERVAL: Duration = Duration::from_millis(250);
use xharness_tools::{
    ApprovalDecision as RuntimeApprovalDecision, ApprovalProvider as RuntimeApprovalProvider,
    ApprovalRequest as RuntimeApprovalRequest, MiddlewareError as RuntimeMiddlewareError,
    ToolBatchEvent as RuntimeBatchEvent, ToolBatchRequest as RuntimeBatchRequest,
    ToolBatchRun as RuntimeBatchRun, ToolExecutionContext as RuntimeExecutionContext,
    ToolFailureKind as RuntimeToolFailureKind, ToolLifecycle as RuntimeToolLifecycle,
    ToolRequest as RuntimeToolRequest,
};

use crate::{
    tool_result_for_model, AgentMessage, ContextRequest, ContextSurface, FinishReason,
    InjectionMode, LoopCommand, LoopControlError, LoopEvent, LoopEventKind, LoopRequest,
    LoopResult, LoopStatus, ProviderError, ProviderEvent, ProviderRequest, Role, SessionSnapshot,
    StepUsage, TokenBudgetError, TokenBudgetReport, TokenEstimateRequest, TokenUsage, ToolCall,
    ToolConcurrency, ToolResult, ToolSpec,
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
    Applied,
}

struct CompactionSummaryOutput {
    text: String,
    usage: Option<TokenUsage>,
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
        let runner = Runner {
            run_id: run_id.clone(),
            request,
            cancellation: cancellation.clone(),
            consumer_dropped: Arc::clone(&consumer_dropped),
            event_journal: Arc::clone(&event_journal),
            seq: 0,
            messages: Vec::new(),
            final_text: String::new(),
            usage: None,
            step_usage: Vec::new(),
            finish_reason: None,
            pending_continuation: None,
            continuation_text: String::new(),
            output_continuations: 0,
            cumulative_output_tokens: 0,
            step: 0,
            tool_batch_complete: true,
            command_rx,
            command_open: true,
            pending_messages: VecDeque::new(),
            paused: false,
            approval_decisions: HashMap::new(),
            startup_error,
            journal,
            recovered_tool_batch: None,
            overflow_recoveries: 0,
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
        .max(1))
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
                    .map(|call| call.provider_id().to_owned())
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
    run_id: String,
    request: LoopRequest,
    cancellation: CancellationToken,
    consumer_dropped: Arc<AtomicBool>,
    event_journal: Arc<EventJournal>,
    seq: u64,
    messages: Vec<AgentMessage>,
    final_text: String,
    usage: Option<TokenUsage>,
    step_usage: Vec<StepUsage>,
    finish_reason: Option<FinishReason>,
    /// Ephemeral, model-facing continuation instruction. It is captured in
    /// request/header for audit but never becomes user transcript history.
    pending_continuation: Option<AgentMessage>,
    continuation_text: String,
    output_continuations: usize,
    cumulative_output_tokens: u64,
    step: usize,
    tool_batch_complete: bool,
    command_rx: mpsc::Receiver<CommandEnvelope>,
    command_open: bool,
    pending_messages: VecDeque<AgentMessage>,
    paused: bool,
    approval_decisions: HashMap<String, ApprovalDecision>,
    startup_error: Option<String>,
    journal: Option<JournalState>,
    recovered_tool_batch: Option<RecoveredToolBatch>,
    overflow_recoveries: u32,
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

impl Runner {
    async fn run(mut self) -> LoopResult {
        self.debug(
            "run.start",
            json!({
                "provider": self.request.provider.provider_name(),
                "model": self.request.provider.model_name(),
                "messageCount": self.request.messages.len(),
                "maxSteps": self.request.config.max_steps,
            }),
        )
        .await;
        if let Some(error) = self.startup_error.take() {
            self.messages = self.request.messages.clone();
            let _ = self
                .emit(LoopEventKind::RunFailed {
                    error: error.clone(),
                })
                .await;
            self.debug(
                "run.end",
                json!({
                    "status": LoopStatus::Failed,
                    "finalText": "",
                    "messages": &self.messages,
                    "error": &error,
                }),
            )
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

        if let Err(journal_error) = self.finalize_journal(status, error.as_deref()).await {
            status = LoopStatus::Failed;
            error = Some(journal_error.clone());
            let _ = self
                .emit(LoopEventKind::RunFailed {
                    error: journal_error,
                })
                .await;
        }
        let _ = self.snapshot(phase, self.tool_batch_complete).await;
        self.debug(
            "run.end",
            json!({
                "status": status,
                "finalText": &self.final_text,
                "messages": &self.messages,
                "usage": &self.usage,
                "stepUsage": &self.step_usage,
                "finishReason": &self.finish_reason,
                "error": &error,
            }),
        )
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

        if let Some(recovery) = self.recovered_tool_batch.take() {
            self.tool_batch_complete = false;
            self.resume_tool_batch(recovery).await?;
            self.tool_batch_complete = true;
            self.journal_step_end().await?;
            self.reload_journal_messages().await?;
            self.snapshot("recovered_tool_batch_saved", true).await?;
        }

        'steps: while self.step < self.request.config.max_steps {
            self.settle_control_at_boundary().await?;
            self.step += 1;
            self.journal_step_start().await?;
            let mut pressure_attempted = false;
            let (provider_request, prepared, context_tools, token_budget) = loop {
                let tool_definitions = self.tool_definitions().await;
                let context_tools = tool_definitions
                    .iter()
                    .map(serde_json::to_value)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| {
                        RunFailure::Failed(format!("could not serialize tool schema: {error}"))
                    })?;
                let mut context_messages = self.messages.clone();
                if let Some(continuation) = self.pending_continuation.clone() {
                    context_messages.push(continuation);
                }
                let context_request = ContextRequest::new(context_messages)
                    .with_target(
                        self.request.provider.provider_name(),
                        self.request.provider.model_name(),
                    )
                    .with_step(self.step)
                    .with_tools(context_tools.clone());
                let prepared = self
                    .request
                    .context_policy
                    .prepare(context_request)
                    .await
                    .map_err(|error| RunFailure::Failed(error.to_string()))?;
                prepared
                    .validate()
                    .map_err(|error| RunFailure::Failed(error.to_string()))?;
                self.validate_prompt_surface(&prepared)?;
                self.debug(
                    "context.prepared",
                    json!({
                        "surface": &prepared,
                        "tools": &context_tools,
                    }),
                )
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
                        if !pressure_attempted {
                            pressure_attempted = true;
                            if let Some(report) = report.as_ref() {
                                match self
                                    .try_compact(
                                        CompactionTrigger::Pressure,
                                        report.estimate.total_input_tokens,
                                        report.context_window_tokens,
                                        &tool_definitions,
                                        &context_tools,
                                    )
                                    .await
                                {
                                    Ok(CompactionOutcome::Applied) => continue,
                                    Ok(CompactionOutcome::NotApplied) => {}
                                    Err(error) => {
                                        self.debug(
                                            "compaction.pressure_failed",
                                            json!({"error": error.to_string()}),
                                        )
                                        .await;
                                    }
                                }
                            }
                        }
                        if let Some(report) = report.as_ref() {
                            let turn_remaining = self
                                .request
                                .config
                                .max_turn_output_tokens
                                .saturating_sub(self.cumulative_output_tokens);
                            provider_request.max_output_tokens =
                                Some(report.selected_output_tokens.min(turn_remaining.max(1)));
                        }
                        break (provider_request, prepared, context_tools, report);
                    }
                    TokenBudgetCheck::Exceeded {
                        current_input_tokens,
                        context_window_tokens,
                        error,
                    } => {
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
                                    &tool_definitions,
                                    &context_tools,
                                )
                                .await
                            {
                                Ok(CompactionOutcome::Applied) => continue,
                                Ok(CompactionOutcome::NotApplied) => {}
                                Err(compaction_error) => {
                                    return Err(RunFailure::Failed(format!(
                                        "token budget rejected request: {error}; overflow compaction failed: {compaction_error}"
                                    )));
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
            self.debug(
                "provider.request.prepared",
                json!({
                    "request": {
                        "messages": &provider_request.messages,
                        "tools": &provider_request.tools,
                        "step": provider_request.step,
                        "maxOutputTokens": provider_request.max_output_tokens,
                    },
                    "tokenBudget": &token_budget,
                }),
            )
            .await;
            self.journal_request_header(&prepared, &context_tools, token_budget.as_ref())
                .await?;

            let overflow_tool_definitions = provider_request.tools.clone();
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
                            &overflow_tool_definitions,
                            &context_tools,
                        )
                        .await
                    {
                        Ok(CompactionOutcome::Applied) => {
                            self.journal_step_end().await?;
                            continue 'steps;
                        }
                        Ok(CompactionOutcome::NotApplied) => {
                            return Err(RunFailure::ContextOverflow(message));
                        }
                        Err(error) => {
                            return Err(RunFailure::Failed(format!(
                                "provider context overflow: {message}; recovery failed: {error}"
                            )));
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
                if !model.text.is_empty() || !model.reasoning.is_empty() {
                    self.final_text = model.text.clone();
                    self.messages.push(AgentMessage {
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
                self.journal_step_end().await?;
                self.settle_control_at_boundary().await?;
                continue;
            }

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
                let within_turn_budget =
                    self.cumulative_output_tokens < self.request.config.max_turn_output_tokens;
                if self.output_continuations < self.request.config.max_output_continuations
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
                self.emit(LoopEventKind::RunMaxTokens {
                    text: self.final_text.clone(),
                    continuations: self.output_continuations,
                    cumulative_output_tokens: self.cumulative_output_tokens,
                })
                .await?;
                return Ok(LoopStatus::MaxTokens);
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
        let mut count_future =
            Box::pin(provider.count_input_tokens(provider_request, provider_cancellation.clone()));
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
                count = &mut count_future => CountProgress::Ready(count),
            };
            match progress {
                CountProgress::Ready(count) => {
                    break count.map_err(|error| {
                        RunFailure::Failed(format!("provider input token count failed: {error}"))
                    })?
                }
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
        if let Some(count) = provider_count {
            return match guard.check_provider_count(&count) {
                Ok(report) => Ok(TokenBudgetCheck::Ready(Some(report))),
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
            Ok(report) => Ok(TokenBudgetCheck::Ready(Some(report))),
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

    async fn try_compact(
        &mut self,
        trigger: CompactionTrigger,
        current_input_tokens: u64,
        context_window_tokens: u64,
        tool_definitions: &[crate::ToolDefinition],
        context_tools: &[Value],
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
        let nodes = surface
            .iter()
            .map(|node| surface_node(node.seq, &node.message))
            .collect::<Result<Vec<_>, _>>()?;
        let target = ModelTarget::new(
            self.request.provider.provider_name(),
            self.request.provider.model_name().unwrap_or("unknown"),
        );
        let planner = BasicCompactionPlanner::new(config)
            .map_err(|error| RunFailure::Failed(error.to_string()))?;
        let plan = match planner
            .plan(&CompactionRequest {
                trigger,
                target,
                context_window_tokens,
                current_input_tokens,
                surface_generation: session.revision().get(),
                nodes,
            })
            .map_err(|error| RunFailure::Failed(error.to_string()))?
        {
            CompactionDecision::Planned { plan } => *plan,
            CompactionDecision::Disabled
            | CompactionDecision::NotNeeded { .. }
            | CompactionDecision::NoBalancedRange { .. } => {
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
                source_command_id: None,
                turn: Some(turn),
            }],
            true,
        )
        .await?;
        self.debug(
            "compaction.start",
            json!({
                "compactionId": &compaction_id,
                "trigger": trigger,
                "range": &plan.range,
                "currentInputTokens": current_input_tokens,
            }),
        )
        .await;

        let mut last_error = None;
        let mut summary = None;
        for attempt in 1..=plan.max_summary_attempts {
            match self
                .run_compaction_summary(&plan, &selected, tool_definitions)
                .await
            {
                Ok(output) => {
                    summary = Some(output);
                    break;
                }
                Err(failure @ RunFailure::Stopped(_)) => {
                    self.journal_append(
                        vec![SessionEventData::CompactionEnd {
                            compaction_id: compaction_id.clone(),
                            source_command_id: None,
                            turn: Some(turn),
                            error: Some("compaction cancelled before replacement".to_owned()),
                        }],
                        true,
                    )
                    .await?;
                    return Err(failure);
                }
                Err(error) => {
                    last_error = Some(error.to_string());
                    self.debug(
                        "compaction.summary_retry",
                        json!({
                            "compactionId": &compaction_id,
                            "attempt": attempt,
                            "maxAttempts": plan.max_summary_attempts,
                            "error": error.to_string(),
                        }),
                    )
                    .await;
                }
            }
        }
        let Some(summary) = summary else {
            let error = last_error.unwrap_or_else(|| "summary produced no result".to_owned());
            self.journal_append(
                vec![SessionEventData::CompactionEnd {
                    compaction_id: compaction_id.clone(),
                    source_command_id: None,
                    turn: Some(turn),
                    error: Some(error.clone()),
                }],
                true,
            )
            .await?;
            return Err(RunFailure::Failed(error));
        };
        let checkpoint =
            frame_summary(&summary.text).map_err(|error| RunFailure::Failed(error.to_string()))?;
        let checkpoint_tokens = estimate_message_tokens(&AgentMessage::user(&checkpoint))?;
        if checkpoint_tokens >= plan.range.shadowed_token_count {
            let error = format!(
                "compaction summary was not smaller than its source range: checkpoint={} source={}",
                checkpoint_tokens, plan.range.shadowed_token_count
            );
            self.journal_append(
                vec![SessionEventData::CompactionEnd {
                    compaction_id: compaction_id.clone(),
                    source_command_id: None,
                    turn: Some(turn),
                    error: Some(error.clone()),
                }],
                true,
            )
            .await?;
            return Err(RunFailure::Failed(error));
        }

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
        self.journal_append(
            vec![
                SessionEventData::CompactionSummary {
                    compaction_id: compaction_id.clone(),
                    source_command_id: None,
                    summary: summary.text,
                    shadowed_range,
                    shadowed_seqs: plan.range.shadowed_seqs.clone(),
                    shadowed_token_count: plan.range.shadowed_token_count,
                    provider: current_provider,
                    model: current_model,
                    max_tokens: Some(plan.spec.max_tokens),
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
                    compaction_id: compaction_id.clone(),
                    source_command_id: None,
                    turn: Some(turn),
                    error: None,
                },
            ],
            true,
        )
        .await?;
        self.reload_journal_messages().await?;
        self.debug(
            "compaction.end",
            json!({
                "compactionId": &compaction_id,
                "shadowedTokens": plan.range.shadowed_token_count,
                "checkpointTokens": checkpoint_tokens,
                "visibleMessages": self.messages.len(),
                "toolsSha256": sha256_json(&context_tools)?,
            }),
        )
        .await;
        Ok(CompactionOutcome::Applied)
    }

    async fn run_compaction_summary(
        &mut self,
        plan: &CompactionPlan,
        selected: &[AgentMessage],
        tool_definitions: &[crate::ToolDefinition],
    ) -> Result<CompactionSummaryOutput, RunFailure> {
        self.ensure_running()?;
        let mut messages = Vec::with_capacity(selected.len().saturating_add(2));
        if let Some(system) = self
            .messages
            .iter()
            .find(|message| message.role == Role::System)
        {
            messages.push(system.clone());
        }
        messages.extend_from_slice(selected);
        messages.push(AgentMessage::user(DEFAULT_COMPACTION_INSTRUCTION));
        let request = ProviderRequest {
            messages,
            tools: tool_definitions.to_vec(),
            step: self.step,
            reasoning_effort: self.request.reasoning_effort.clone(),
            max_output_tokens: Some(plan.spec.max_tokens),
            debug_scope: self.debug_scope(),
        };
        let cancellation = self.cancellation.child_token();
        let provider = Arc::clone(&self.request.provider);
        let mut stream = tokio::select! {
            _ = self.cancellation.cancelled() => return Err(self.stopped_failure()),
            stream = provider.stream(request, cancellation.clone()) => {
                stream.map_err(|error| RunFailure::Failed(error.message))?
            }
        };
        let mut text = String::new();
        let mut usage = None;
        let mut completed = false;
        while let Some(event) = tokio::select! {
            _ = self.cancellation.cancelled() => return Err(self.stopped_failure()),
            event = stream.next() => event,
        } {
            match event.map_err(|error| RunFailure::Failed(error.message))? {
                ProviderEvent::TextDelta(delta) => text.push_str(&delta),
                ProviderEvent::ReasoningDelta(_) => {}
                ProviderEvent::ToolCallDelta { .. } => {
                    cancellation.cancel();
                    return Err(RunFailure::Failed(
                        "compaction summary attempted to call a tool".to_owned(),
                    ));
                }
                ProviderEvent::Completed {
                    finish_reason,
                    usage: reported_usage,
                    ..
                } => {
                    let reason = finish_reason.unwrap_or(FinishReason::Stop);
                    if reason != FinishReason::Stop {
                        return Err(RunFailure::Failed(format!(
                            "compaction summary was incomplete: {}",
                            reason.description()
                        )));
                    }
                    usage = reported_usage;
                    completed = true;
                    break;
                }
            }
        }
        if !completed {
            return Err(RunFailure::Failed(
                "compaction summary stream ended without completion".to_owned(),
            ));
        }
        if text.trim().is_empty() {
            return Err(RunFailure::Failed(
                "compaction summary produced no text".to_owned(),
            ));
        }
        Ok(CompactionSummaryOutput { text, usage })
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

        let mut recovery = session.interrupted_compaction_recovery();
        recovery.extend(session.outcome_unknown_recovery());
        if let Some(turn) = open_turn {
            if let Some(step) = open_step {
                recovery.push(SessionEventData::StepEnd { turn, step }.into());
            }
            recovery.push(
                SessionEventData::TurnEnd {
                    turn,
                    reason: TurnEndReason::Interrupted,
                }
                .into(),
            );
        }
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
        self.messages = self.prompt_prefixed(session.derive_messages());
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
                                    | SessionEventData::SessionModelSelected { .. }
                                    | SessionEventData::CommandRun { .. }
                                    | SessionEventData::CommandDone { .. }
                                    | SessionEventData::SessionTitle { .. }
                                    | SessionEventData::GoalChange { .. }
                                    | SessionEventData::ScheduleChange { .. }
                                    | SessionEventData::SessionMutationCommitted { .. }
                                    | SessionEventData::PlanMode { .. }
                                    | SessionEventData::QuestionRequested { .. }
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
        let system = surface
            .messages
            .iter()
            .filter(|message| message.role == Role::System)
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let mut header = RequestHeader::new(provider, model);
        header.system = (!system.is_empty()).then_some(system);
        header.options.insert(
            "toolDefinitionsSha256".to_owned(),
            Value::String(sha256_json(&tools)?),
        );
        header.tools = tools.to_vec();
        header.input = surface.messages.clone();
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
        }
        header
            .options
            .insert("step".to_owned(), Value::from(self.step as u64));
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
        let events = executions
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
        self.journal_append(events, true).await
    }

    fn approval_id(&self, order: usize) -> String {
        format!("xh-approval-{}-{}-{order}", self.run_id, self.step)
    }

    async fn journal_approval_asked(
        &mut self,
        approval_id: &str,
        call: &ToolCall,
    ) -> Result<(), RunFailure> {
        self.journal_append(
            vec![SessionEventData::ApprovalAsked {
                id: approval_id.to_owned(),
                tool_name: call.name.clone(),
                call_id: Some(call.id.clone()),
                reason: Some("This tool requires explicit approval.".to_owned()),
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
        max_retries: usize,
        error: &ProviderError,
    ) -> Result<(), RunFailure> {
        let Some(journal) = self.journal.as_ref() else {
            return Ok(());
        };
        let turn = journal.turn;
        let step = u32::try_from(self.step)
            .map_err(|_| RunFailure::Failed("session step counter overflow".to_owned()))?;
        let retry = u32::try_from(retry)
            .map_err(|_| RunFailure::Failed("provider retry counter overflow".to_owned()))?;
        let max_retries = u32::try_from(max_retries)
            .map_err(|_| RunFailure::Failed("provider retry limit overflow".to_owned()))?;
        let provider = self.request.provider.provider_name().to_owned();
        let failure = LlmFailure {
            message: error.message.clone(),
            code: error
                .http_status
                .map_or_else(|| "TRANSPORT".to_owned(), |status| format!("HTTP_{status}")),
            status: error.http_status,
            provider_retry_after_ms: None,
            request_id: None,
        };
        self.journal_append(
            vec![SessionEventData::LlmRetry {
                retry_id: retry_id.to_owned(),
                turn,
                step,
                provider,
                mode: LlmRetryMode::Normal,
                policy_key: format!("xharness:normal:{max_retries}"),
                retry,
                max_retries: Some(max_retries),
                delay_ms: 0,
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
    ) -> Result<(), String> {
        if self.journal.is_none() {
            return Ok(());
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
            LoopStatus::Cancelled => TurnEndReason::Cancelled,
            LoopStatus::LimitReached => TurnEndReason::LimitReached,
            LoopStatus::Failed => TurnEndReason::Failed {
                error: error.unwrap_or("loop failed").to_owned(),
            },
        };
        let turn = journal.turn;
        self.journal_append(vec![SessionEventData::TurnEnd { turn, reason }], true)
            .await
            .map_err(|failure| failure.to_string())?;
        if let Some(journal) = self.journal.as_mut() {
            journal.turn_open = false;
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
        if matches!(&command, LoopCommand::Cancel) {
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
                Ok(allow_model_interrupt && mode == InjectionMode::InterruptModel)
            }
            LoopCommand::Steer(message) => {
                self.emit(LoopEventKind::MessageInjected {
                    message: message.clone(),
                    mode: InjectionMode::InterruptModel,
                })
                .await?;
                self.pending_messages.push_back(message);
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
            LoopCommand::Cancel => unreachable!("cancel commands are handled by the envelope"),
            LoopCommand::ApproveTool { call_id } => {
                self.store_approval(call_id, ApprovalDecision::Approved);
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
        self.debug("loop.event", json!({"event": &event})).await;
        self.event_journal
            .append(event)
            .map_err(|error| RunFailure::Failed(format!("could not serialize loop event: {error}")))
    }

    async fn debug(&self, event: &str, payload: Value) {
        let scope = self.debug_scope();
        self.request
            .debug
            .record_lossy(DebugEvent::new("core", event, payload).with_scope(scope))
            .await;
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

    async fn model_round(&mut self, request: ProviderRequest) -> Result<ModelRound, RunFailure> {
        let max_attempts = self.request.config.provider_retries.saturating_add(1);
        let mut round = ModelRound::default();

        for attempt in 1..=max_attempts {
            self.ensure_running()?;
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
                    if error.is_context_overflow() && !round.saw_delta {
                        return Err(RunFailure::ContextOverflow(error.message));
                    }
                    if error.retryable && !round.saw_delta && attempt < max_attempts {
                        let retry_id = self.model_retry_id();
                        self.journal_model_retry_scheduled(
                            &retry_id,
                            attempt,
                            self.request.config.provider_retries,
                            &error,
                        )
                        .await?;
                        self.emit(LoopEventKind::ModelRetry {
                            retry_id: retry_id.clone(),
                            attempt,
                            max_retries: self.request.config.provider_retries,
                            error: error.message.clone(),
                        })
                        .await?;
                        self.journal_model_retry_started(&retry_id, attempt).await?;
                        continue;
                    }
                    return Err(RunFailure::Failed(error.message));
                }
            };

            let mut failure: Option<ProviderError> = None;
            loop {
                enum ModelInput {
                    Command(Option<CommandEnvelope>),
                    Provider(Option<Result<ProviderEvent, ProviderError>>),
                }
                let next = tokio::select! {
                    _ = self.cancellation.cancelled() => return Err(self.stopped_failure()),
                    command = self.command_rx.recv(), if self.command_open => {
                        ModelInput::Command(command)
                    }
                    event = stream.next() => ModelInput::Provider(event),
                };
                match next {
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
                        round.saw_delta = true;
                        let checkpoint = self
                            .journal_chunk(AssistantChunk::ToolCallDelta {
                                index,
                                id: id.clone(),
                                name: name.clone(),
                                arguments_delta: arguments_delta.clone(),
                            })
                            .await?;
                        self.emit(LoopEventKind::ToolCallDelta {
                            index,
                            id: id.clone(),
                            name: name.clone(),
                            arguments_delta: arguments_delta.clone(),
                        })
                        .await?;
                        if checkpoint {
                            self.emit(LoopEventKind::StreamCheckpoint).await?;
                        }
                        let call = round
                            .calls_by_index
                            .entry(index)
                            .or_insert_with(|| ToolCall {
                                index,
                                ..ToolCall::default()
                            });
                        if !id.is_empty() {
                            call.id = id;
                        }
                        if !name.is_empty() {
                            call.name = name;
                        }
                        call.arguments_json.push_str(&arguments_delta);
                    }
                    ModelInput::Provider(Some(Ok(ProviderEvent::Completed {
                        finish_reason,
                        usage,
                        provider_items,
                    }))) => {
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
                        failure = Some(error);
                        break;
                    }
                    ModelInput::Provider(None) => {
                        failure = Some(ProviderError::new(
                            "provider stream ended without completed event",
                        ));
                        break;
                    }
                }
            }

            if round.completed {
                round.calls = round.calls_by_index.values().cloned().collect();
                return Ok(round);
            }
            let error = failure.expect("an incomplete provider attempt has an error");
            if error.is_context_overflow() && !round.saw_delta {
                return Err(RunFailure::ContextOverflow(error.message));
            }
            if error.retryable && !round.saw_delta && attempt < max_attempts {
                let retry_id = self.model_retry_id();
                self.journal_model_retry_scheduled(
                    &retry_id,
                    attempt,
                    self.request.config.provider_retries,
                    &error,
                )
                .await?;
                self.emit(LoopEventKind::ModelRetry {
                    retry_id: retry_id.clone(),
                    attempt,
                    max_retries: self.request.config.provider_retries,
                    error: error.message.clone(),
                })
                .await?;
                self.journal_model_retry_started(&retry_id, attempt).await?;
                continue;
            }
            return Err(RunFailure::Failed(error.message));
        }
        Err(RunFailure::Failed(
            "provider retry limit reached".to_owned(),
        ))
    }

    async fn tool_definitions(&self) -> Vec<crate::ToolDefinition> {
        match &self.request.tool_executor {
            Some(executor) => executor
                .registry()
                .definitions()
                .await
                .into_iter()
                .map(|definition| crate::ToolDefinition {
                    name: definition.name,
                    description: definition.description,
                    parameters: definition.parameters,
                })
                .collect(),
            None => self
                .request
                .tools
                .iter()
                .map(|tool| tool.definition.clone())
                .collect(),
        }
    }

    async fn execute_tool_batch(&mut self, calls: Vec<ToolCall>) -> Result<(), RunFailure> {
        if self.request.tool_executor.is_some() {
            return self.execute_runtime_tool_batch(calls).await;
        }
        let mut scheduled = calls
            .into_iter()
            .enumerate()
            .map(|(order, call)| ScheduledTool::new(order, call, &self.request.tools))
            .collect::<Vec<_>>();
        let mut completed = std::iter::repeat_with(|| None)
            .take(scheduled.len())
            .collect::<Vec<Option<ToolExecution>>>();
        let completed_count = self
            .resolve_tool_approvals(&mut scheduled, &mut completed)
            .await?;
        self.run_tool_scheduler(&mut scheduled, &mut completed, completed_count)
            .await?;
        self.finalize_tool_batch(completed).await
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
        let executor = self
            .request
            .tool_executor
            .clone()
            .expect("runtime path requires a configured tool executor");
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
        let mut batch = executor
            .start_batch(requests, self.request.config.max_tool_concurrency)
            .await
            .map_err(|error| RunFailure::Failed(error.to_string()))?;
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
                signal = signal_rx.recv() => RuntimeInput::Signal(signal),
                event = batch.next_event() => RuntimeInput::Batch(event),
            };
            match input {
                RuntimeInput::Cancelled => {
                    self.cancel_runtime_tool_batch(&mut batch, &mut pending_approval_ids)
                        .await?;
                    return Err(self.stopped_failure());
                }
                RuntimeInput::Command(Some(envelope)) => {
                    if let Err(failure) = self.handle_envelope(envelope, false).await {
                        self.cancel_runtime_tool_batch(&mut batch, &mut pending_approval_ids)
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
                        self.cancel_runtime_tool_batch(&mut batch, &mut pending_approval_ids)
                            .await?;
                        return Err(failure);
                    }
                }
                RuntimeInput::Signal(None) => {
                    self.cancel_runtime_tool_batch(&mut batch, &mut pending_approval_ids)
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
                    let result = runtime_tool_result(&completed.result);
                    self.emit(LoopEventKind::ToolCompleted {
                        call: call.clone(),
                        result,
                    })
                    .await?;
                    completion_count += 1;
                }
                RuntimeInput::Batch(None) => {
                    self.cancel_runtime_tool_batch(&mut batch, &mut pending_approval_ids)
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
                let (model_text, _) =
                    tool_result_for_model(&result, self.request.config.tool_result_limit_bytes);
                Ok(ToolExecution {
                    order: completed.order,
                    call,
                    outcome: if result.ok {
                        ToolOutcome::Success
                    } else {
                        ToolOutcome::Error
                    },
                    result,
                    model_text,
                })
            })
            .collect::<Result<Vec<_>, RunFailure>>()?;
        Ok(completed)
    }

    async fn cancel_runtime_tool_batch(
        &mut self,
        batch: &mut RuntimeBatchRun,
        pending_approval_ids: &mut Vec<String>,
    ) -> Result<(), RunFailure> {
        batch.cancel();
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
                let _approval_reasons = reasons;
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
                    self.journal_approval_asked(&approval_id, call).await?;
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

    async fn resolve_runtime_approval_decisions(
        &mut self,
        pending: &mut Vec<PendingRuntimeApproval>,
        pending_approval_ids: &mut Vec<String>,
    ) -> Result<(), RunFailure> {
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
                reason,
            })
            .await?;
            approval.response.send(Ok(runtime)).map_err(|_| {
                RunFailure::Failed(
                    "tool runtime stopped while receiving approval decision".to_owned(),
                )
            })?;
        }
        Ok(())
    }

    async fn resume_tool_batch(&mut self, recovery: RecoveredToolBatch) -> Result<(), RunFailure> {
        if self.request.tool_executor.is_some() {
            return self.resume_runtime_tool_batch(recovery).await;
        }
        let mut scheduled = recovery
            .calls
            .iter()
            .enumerate()
            .map(|(order, recovered)| {
                ScheduledTool::new(order, recovered.call.clone(), &self.request.tools)
            })
            .collect::<Vec<_>>();
        let mut completed = std::iter::repeat_with(|| None)
            .take(scheduled.len())
            .collect::<Vec<Option<ToolExecution>>>();
        let mut completed_count = 0usize;
        let mut pending_approval_ids = recovery
            .calls
            .iter()
            .filter_map(|call| call.approval.as_ref().map(|approval| approval.id.clone()))
            .collect::<Vec<_>>();

        for (order, recovered) in recovery.calls.into_iter().enumerate() {
            let Some(approval) = recovered.approval else {
                if recovered.replay_safe {
                    continue;
                }
                scheduled[order].started = true;
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
                completed_count += 1;
                continue;
            };

            self.emit(LoopEventKind::ToolApprovalRequested {
                approval_id: approval.id.clone(),
                call: recovered.call.clone(),
            })
            .await?;
            let decision = match self.wait_for_approval(&recovered.call.id).await {
                Ok(decision) => decision,
                Err(failure) => {
                    self.journal_cancel_pending_approvals(&mut pending_approval_ids)
                        .await?;
                    return Err(failure);
                }
            };
            match decision {
                ApprovalDecision::Approved => {
                    self.journal_approval_decided(&approval.id, ApprovalOutcome::AllowedOnce)
                        .await?;
                    pending_approval_ids.retain(|pending| pending != &approval.id);
                    self.emit(LoopEventKind::ToolApprovalResolved {
                        approval_id: approval.id,
                        call: recovered.call,
                        approved: true,
                        reason: None,
                    })
                    .await?;
                }
                ApprovalDecision::Rejected(reason) => {
                    let reason = if reason.trim().is_empty() {
                        "rejected by host".to_owned()
                    } else {
                        reason
                    };
                    self.journal_approval_decided(&approval.id, ApprovalOutcome::Rejected)
                        .await?;
                    pending_approval_ids.retain(|pending| pending != &approval.id);
                    self.emit(LoopEventKind::ToolApprovalResolved {
                        approval_id: approval.id,
                        call: recovered.call.clone(),
                        approved: false,
                        reason: Some(reason.clone()),
                    })
                    .await?;
                    scheduled[order].started = true;
                    let result = ToolResult::failure(format!("tool rejected: {reason}"));
                    let (model_text, _) =
                        tool_result_for_model(&result, self.request.config.tool_result_limit_bytes);
                    let execution = ToolExecution {
                        order,
                        call: recovered.call,
                        outcome: ToolOutcome::Error,
                        result,
                        model_text,
                    };
                    self.emit(LoopEventKind::ToolCompleted {
                        call: execution.call.clone(),
                        result: execution.result.clone(),
                    })
                    .await?;
                    completed[order] = Some(execution);
                    completed_count += 1;
                }
            }
        }

        self.run_tool_scheduler(&mut scheduled, &mut completed, completed_count)
            .await?;
        self.finalize_tool_batch(completed).await
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

    async fn run_tool_scheduler(
        &mut self,
        scheduled: &mut [ScheduledTool],
        completed: &mut [Option<ToolExecution>],
        mut completed_count: usize,
    ) -> Result<(), RunFailure> {
        let mut active: FuturesUnordered<ToolFuture> = FuturesUnordered::new();
        let mut active_modes = HashMap::<usize, (ToolConcurrency, String)>::new();

        while completed_count < scheduled.len() {
            self.drain_commands(false).await?;
            if self.paused && active.is_empty() {
                self.wait_while_paused(false).await?;
                continue;
            }

            if !self.paused {
                let mut launched_any = true;
                while launched_any && active.len() < self.request.config.max_tool_concurrency {
                    launched_any = false;
                    let barrier = scheduled
                        .iter()
                        .position(|item| !item.started && item.mode == ToolConcurrency::Exclusive)
                        .unwrap_or(scheduled.len());

                    for item in scheduled.iter_mut().take(barrier) {
                        if active.len() >= self.request.config.max_tool_concurrency {
                            break;
                        }
                        if item.started || !can_launch(item, active_modes.values()) {
                            continue;
                        }
                        self.launch_tool(item, &mut active, &mut active_modes)
                            .await?;
                        launched_any = true;
                    }

                    if !launched_any && barrier < scheduled.len() && active.is_empty() {
                        self.launch_tool(&mut scheduled[barrier], &mut active, &mut active_modes)
                            .await?;
                        launched_any = true;
                    }
                }
            }

            if active.is_empty() {
                return Err(RunFailure::Failed("tool scheduler deadlock".to_owned()));
            }
            enum ToolInput {
                Command(Option<CommandEnvelope>),
                Completed(ToolExecution),
            }
            let input = tokio::select! {
                biased;
                _ = self.cancellation.cancelled() => return Err(self.stopped_failure()),
                command = self.command_rx.recv(), if self.command_open => {
                    ToolInput::Command(command)
                }
                execution = active.next() => {
                    ToolInput::Completed(execution.expect("active tool set is non-empty"))
                },
            };
            let execution = match input {
                ToolInput::Command(Some(envelope)) => {
                    self.handle_envelope(envelope, false).await?;
                    continue;
                }
                ToolInput::Command(None) => {
                    self.command_open = false;
                    continue;
                }
                ToolInput::Completed(execution) => execution,
            };
            active_modes.remove(&execution.order);
            completed_count += 1;
            self.emit(LoopEventKind::ToolCompleted {
                call: execution.call.clone(),
                result: execution.result.clone(),
            })
            .await?;
            let order = execution.order;
            completed[order] = Some(execution);
        }

        Ok(())
    }

    async fn finalize_tool_batch(
        &mut self,
        completed: Vec<Option<ToolExecution>>,
    ) -> Result<(), RunFailure> {
        let completed = completed.into_iter().flatten().collect::<Vec<_>>();
        self.journal_tool_results(&completed).await?;
        for execution in completed {
            self.messages.push(AgentMessage::tool(
                execution.call.provider_id(),
                execution.model_text,
            ));
        }
        Ok(())
    }

    async fn resolve_tool_approvals(
        &mut self,
        scheduled: &mut [ScheduledTool],
        completed: &mut [Option<ToolExecution>],
    ) -> Result<usize, RunFailure> {
        let approval_requests = scheduled
            .iter()
            .filter(|item| item.requires_approval())
            .map(|item| (item.order, self.approval_id(item.order), item.call.clone()))
            .collect::<Vec<_>>();
        let mut pending_approval_ids = Vec::<String>::new();
        for (_, approval_id, call) in &approval_requests {
            self.journal_approval_asked(approval_id, call).await?;
            pending_approval_ids.push(approval_id.clone());
            if let Err(failure) = self
                .emit(LoopEventKind::ToolApprovalRequested {
                    approval_id: approval_id.clone(),
                    call: call.clone(),
                })
                .await
            {
                self.journal_cancel_pending_approvals(&mut pending_approval_ids)
                    .await?;
                return Err(failure);
            }
        }

        let mut rejected_count = 0;
        for item in scheduled.iter_mut().filter(|item| item.requires_approval()) {
            let approval_id = approval_requests
                .iter()
                .find_map(|(order, approval_id, _)| {
                    (*order == item.order).then_some(approval_id.clone())
                })
                .expect("every approval-required tool received an approval identity");
            let decision = match self.wait_for_approval(&item.call.id).await {
                Ok(decision) => decision,
                Err(failure) => {
                    self.journal_cancel_pending_approvals(&mut pending_approval_ids)
                        .await?;
                    return Err(failure);
                }
            };
            match decision {
                ApprovalDecision::Approved => {
                    self.journal_approval_decided(&approval_id, ApprovalOutcome::AllowedOnce)
                        .await?;
                    pending_approval_ids.retain(|pending| pending != &approval_id);
                    if let Err(failure) = self
                        .emit(LoopEventKind::ToolApprovalResolved {
                            approval_id,
                            call: item.call.clone(),
                            approved: true,
                            reason: None,
                        })
                        .await
                    {
                        self.journal_cancel_pending_approvals(&mut pending_approval_ids)
                            .await?;
                        return Err(failure);
                    }
                }
                ApprovalDecision::Rejected(reason) => {
                    let reason = if reason.trim().is_empty() {
                        "rejected by host".to_owned()
                    } else {
                        reason
                    };
                    self.journal_approval_decided(&approval_id, ApprovalOutcome::Rejected)
                        .await?;
                    pending_approval_ids.retain(|pending| pending != &approval_id);
                    if let Err(failure) = self
                        .emit(LoopEventKind::ToolApprovalResolved {
                            approval_id,
                            call: item.call.clone(),
                            approved: false,
                            reason: Some(reason.clone()),
                        })
                        .await
                    {
                        self.journal_cancel_pending_approvals(&mut pending_approval_ids)
                            .await?;
                        return Err(failure);
                    }
                    item.started = true;
                    let result = ToolResult::failure(format!("tool rejected: {reason}"));
                    let (model_text, _) =
                        tool_result_for_model(&result, self.request.config.tool_result_limit_bytes);
                    let execution = ToolExecution {
                        order: item.order,
                        call: item.call.clone(),
                        outcome: ToolOutcome::Error,
                        result,
                        model_text,
                    };
                    if let Err(failure) = self
                        .emit(LoopEventKind::ToolCompleted {
                            call: execution.call.clone(),
                            result: execution.result.clone(),
                        })
                        .await
                    {
                        self.journal_cancel_pending_approvals(&mut pending_approval_ids)
                            .await?;
                        return Err(failure);
                    }
                    let order = execution.order;
                    completed[order] = Some(execution);
                    rejected_count += 1;
                }
            }
        }
        Ok(rejected_count)
    }

    async fn wait_for_approval(&mut self, call_id: &str) -> Result<ApprovalDecision, RunFailure> {
        loop {
            self.drain_commands(false).await?;
            if self.paused {
                self.wait_while_paused(false).await?;
                continue;
            }
            if let Some(decision) = self.approval_decisions.remove(call_id) {
                return Ok(decision);
            }
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
                    self.handle_envelope(envelope, false).await?;
                }
                None => self.command_open = false,
            }
        }
    }

    async fn launch_tool(
        &mut self,
        scheduled: &mut ScheduledTool,
        active: &mut FuturesUnordered<ToolFuture>,
        active_modes: &mut HashMap<usize, (ToolConcurrency, String)>,
    ) -> Result<(), RunFailure> {
        scheduled.started = true;
        active_modes.insert(scheduled.order, (scheduled.mode, scheduled.key.clone()));
        self.emit(LoopEventKind::ToolStarted(scheduled.call.clone()))
            .await?;
        let item = scheduled.clone();
        let cancellation = self.cancellation.child_token();
        let result_limit = self.request.config.tool_result_limit_bytes;
        active.push(Box::pin(async move {
            execute_tool(item, result_limit, cancellation).await
        }));
        Ok(())
    }
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

#[derive(Clone)]
struct ScheduledTool {
    order: usize,
    call: ToolCall,
    spec: Option<ToolSpec>,
    parsed_arguments: Option<Value>,
    argument_error: Option<String>,
    mode: ToolConcurrency,
    key: String,
    started: bool,
}

impl ScheduledTool {
    fn new(order: usize, call: ToolCall, tools: &[ToolSpec]) -> Self {
        let spec = tools
            .iter()
            .find(|tool| tool.definition.name == call.name)
            .cloned();
        let (parsed_arguments, argument_error) =
            match serde_json::from_str::<Value>(&call.arguments_json) {
                Ok(value) if value.is_object() => (Some(value), None),
                Ok(_) => (
                    None,
                    Some("tool arguments must be a valid JSON object".to_owned()),
                ),
                Err(_) => (
                    None,
                    Some("tool arguments must be a valid JSON object".to_owned()),
                ),
            };
        let mut mode = spec
            .as_ref()
            .map(|tool| tool.concurrency)
            .unwrap_or(ToolConcurrency::Parallel);
        let key = if mode == ToolConcurrency::Keyed {
            let resolved = spec
                .as_ref()
                .and_then(|tool| tool.resource_key_resolver.as_ref())
                .and_then(|resolver| {
                    parsed_arguments.as_ref().and_then(|arguments| {
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            resolver(arguments)
                        }))
                        .ok()
                        .flatten()
                    })
                })
                .unwrap_or_default();
            if resolved.is_empty() {
                mode = ToolConcurrency::Exclusive;
            }
            resolved
        } else {
            String::new()
        };
        Self {
            order,
            call,
            spec,
            parsed_arguments,
            argument_error,
            mode,
            key,
            started: false,
        }
    }

    fn requires_approval(&self) -> bool {
        self.spec
            .as_ref()
            .is_some_and(|spec| spec.requires_approval)
    }
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

type ToolFuture = Pin<Box<dyn futures::Future<Output = ToolExecution> + Send + 'static>>;

fn can_launch<'a>(
    item: &ScheduledTool,
    active: impl Iterator<Item = &'a (ToolConcurrency, String)>,
) -> bool {
    let active = active.collect::<Vec<_>>();
    if active
        .iter()
        .any(|(mode, _)| *mode == ToolConcurrency::Exclusive)
    {
        return false;
    }
    match item.mode {
        ToolConcurrency::Exclusive => active.is_empty(),
        ToolConcurrency::Keyed => !active
            .iter()
            .any(|(mode, key)| *mode == ToolConcurrency::Keyed && *key == item.key),
        ToolConcurrency::Parallel => true,
    }
}

async fn execute_tool(
    item: ScheduledTool,
    result_limit: usize,
    cancellation: CancellationToken,
) -> ToolExecution {
    let result = if cancellation.is_cancelled() {
        ToolResult::failure("tool call cancelled")
    } else if item.spec.is_none() {
        ToolResult::failure(format!("unknown tool: {}", item.call.name))
    } else if let Some(error) = item.argument_error.clone() {
        ToolResult::failure(error)
    } else {
        let spec = item.spec.as_ref().expect("tool existence checked above");
        let arguments = item
            .parsed_arguments
            .clone()
            .expect("arguments validity checked above");
        let handler = spec.handler.clone();
        let handler_token = cancellation.child_token();
        let handler_cancellation = handler_token.clone();
        let future = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            handler(crate::ToolInvocation {
                execution_id: item.call.id.clone(),
                provider_call_id: item.call.provider_call_id.clone(),
                arguments,
                cancellation: handler_token,
            })
        }));
        match future {
            Err(_) => ToolResult::failure("tool handler panicked"),
            Ok(future) => {
                let caught = std::panic::AssertUnwindSafe(future).catch_unwind();
                tokio::pin!(caught);
                let deadline = tokio::time::sleep(spec.timeout);
                tokio::pin!(deadline);
                tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => {
                        handler_cancellation.cancel();
                        let _ = tokio::time::timeout(TOOL_CLEANUP_GRACE, &mut caught).await;
                        ToolResult::failure("tool call cancelled")
                    },
                    _ = &mut deadline => {
                        handler_cancellation.cancel();
                        let _ = tokio::time::timeout(TOOL_CLEANUP_GRACE, &mut caught).await;
                        ToolResult::failure(format!(
                            "tool timed out after {} ms",
                            spec.timeout.as_millis()
                        ))
                    },
                    outcome = &mut caught => match outcome {
                        Err(_) => ToolResult::failure("tool handler panicked"),
                        Ok(result) => result,
                    }
                }
            }
        }
    };
    let (model_text, _) = tool_result_for_model(&result, result_limit);
    ToolExecution {
        order: item.order,
        call: item.call,
        outcome: if result.ok {
            ToolOutcome::Success
        } else {
            ToolOutcome::Error
        },
        result,
        model_text,
    }
}

#[derive(Debug, thiserror::Error)]
enum RunFailure {
    #[error("run stopped: {0:?}")]
    Stopped(StopReason),
    #[error("{0}")]
    Failed(String),
    #[error("provider context overflow: {0}")]
    ContextOverflow(String),
}

impl From<String> for RunFailure {
    fn from(value: String) -> Self {
        Self::Failed(value)
    }
}

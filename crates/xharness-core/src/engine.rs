use std::{
    collections::HashMap,
    pin::Pin,
    sync::atomic::{AtomicU64, Ordering},
    task::{Context, Poll},
    time::{SystemTime, UNIX_EPOCH},
};

use futures::{stream::FuturesUnordered, FutureExt, Stream, StreamExt};
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;

use crate::{
    tool_result_for_model, AgentMessage, LoopEvent, LoopEventKind, LoopRequest, LoopResult,
    LoopStatus, ProviderError, ProviderEvent, ProviderRequest, Role, SessionSnapshot, ToolCall,
    ToolConcurrency, ToolResult, ToolSpec,
};

static NEXT_RUN_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StopReason {
    Cancelled,
    ConsumerStopped,
}

pub struct LoopRun {
    pub run_id: String,
    events: ReceiverStream<LoopEvent>,
    result: watch::Receiver<Option<LoopResult>>,
    cancellation: CancellationToken,
}

impl LoopRun {
    /// Returns this run as a stream. It can only be consumed once, in order.
    pub fn events(&mut self) -> &mut Self {
        self
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
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
        self.cancellation.cancel();
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct LoopEngine;

impl LoopEngine {
    pub fn start(&self, mut request: LoopRequest) -> LoopRun {
        if request.config.max_steps == 0 {
            request.config.max_steps = 128;
        }
        if request.config.max_tool_concurrency == 0 {
            request.config.max_tool_concurrency = 8;
        }
        if request.config.tool_result_limit_bytes == 0 {
            request.config.tool_result_limit_bytes = 256 * 1024;
        }
        if request.config.event_buffer == 0 {
            request.config.event_buffer = 128;
        }

        let run_id = new_run_id();
        let cancellation = CancellationToken::new();
        let (event_tx, event_rx) = mpsc::channel(request.config.event_buffer);
        let (result_tx, result_rx) = watch::channel(None);
        let runner = Runner {
            run_id: run_id.clone(),
            request,
            cancellation: cancellation.clone(),
            event_tx,
            seq: 0,
            messages: Vec::new(),
            final_text: String::new(),
            usage: None,
            step: 0,
            tool_batch_complete: true,
        };
        tokio::spawn(async move {
            let result = runner.run().await;
            let _ = result_tx.send(Some(result));
        });
        LoopRun {
            run_id,
            events: ReceiverStream::new(event_rx),
            result: result_rx,
            cancellation,
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

struct Runner {
    run_id: String,
    request: LoopRequest,
    cancellation: CancellationToken,
    event_tx: mpsc::Sender<LoopEvent>,
    seq: u64,
    messages: Vec<AgentMessage>,
    final_text: String,
    usage: Option<Value>,
    step: usize,
    tool_batch_complete: bool,
}

impl Runner {
    async fn run(mut self) -> LoopResult {
        let outcome = self.run_inner().await;
        let (status, error, phase) = match outcome {
            Ok(status) => {
                let phase = match status {
                    LoopStatus::Completed => "completed",
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
        };

        let _ = self.snapshot(phase, self.tool_batch_complete).await;
        LoopResult {
            status,
            final_text: self.final_text,
            messages: self.messages,
            usage: self.usage,
            error,
        }
    }

    async fn run_inner(&mut self) -> Result<LoopStatus, RunFailure> {
        self.restore_messages().await?;
        self.snapshot("input_saved", true).await?;

        while self.step < self.request.config.max_steps {
            self.ensure_running()?;
            self.step += 1;
            let prepared = self
                .request
                .context_policy
                .prepare(&self.messages)
                .await
                .map_err(RunFailure::Failed)?;

            let model = self.model_round(prepared).await?;
            let assistant = AgentMessage {
                role: Role::Assistant,
                content: model.text.clone(),
                reasoning: model.reasoning,
                tool_calls: model.calls.clone(),
                tool_call_id: None,
                provider_items: model.provider_items,
            };
            self.final_text = model.text;
            self.usage = model.usage;
            self.messages.push(assistant);
            self.snapshot("assistant_saved", true).await?;

            if model.calls.is_empty() {
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
            self.snapshot("tool_batch_saved", true).await?;
        }

        self.emit(LoopEventKind::LimitReached).await?;
        Ok(LoopStatus::LimitReached)
    }

    fn ensure_running(&self) -> Result<(), RunFailure> {
        if self.cancellation.is_cancelled() {
            Err(RunFailure::Stopped(if self.event_tx.is_closed() {
                StopReason::ConsumerStopped
            } else {
                StopReason::Cancelled
            }))
        } else {
            Ok(())
        }
    }

    async fn emit(&mut self, kind: LoopEventKind) -> Result<(), RunFailure> {
        self.seq += 1;
        let event = LoopEvent {
            seq: self.seq,
            run_id: self.run_id.clone(),
            step: self.step,
            kind,
        };
        if self.event_tx.send(event).await.is_err() {
            self.cancellation.cancel();
            return Err(RunFailure::Stopped(StopReason::ConsumerStopped));
        }
        Ok(())
    }

    async fn snapshot(&self, phase: &str, tool_batch_complete: bool) -> Result<(), RunFailure> {
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
                                self.messages.push(AgentMessage::tool(call.id, content));
                            }
                            self.snapshot("interrupted_tool_batch_closed", true).await?;
                        }
                    }
                }
            }
        }
        self.messages.extend(self.request.messages.clone());
        Ok(())
    }

    async fn model_round(&mut self, messages: Vec<AgentMessage>) -> Result<ModelRound, RunFailure> {
        let tool_definitions = self
            .request
            .tools
            .iter()
            .map(|tool| tool.definition.clone())
            .collect::<Vec<_>>();
        let max_attempts = self.request.config.provider_retries.saturating_add(1);
        let mut round = ModelRound::default();

        for attempt in 1..=max_attempts {
            self.ensure_running()?;
            let request = ProviderRequest {
                messages: messages.clone(),
                tools: tool_definitions.clone(),
                step: self.step,
            };
            let stream = self
                .request
                .provider
                .stream(request, self.cancellation.child_token())
                .await;

            let mut stream = match stream {
                Ok(stream) => stream,
                Err(error) => {
                    if error.retryable && !round.saw_delta && attempt < max_attempts {
                        self.emit(LoopEventKind::ModelRetry {
                            attempt,
                            error: error.message,
                        })
                        .await?;
                        continue;
                    }
                    return Err(RunFailure::Failed(error.message));
                }
            };

            let mut failure: Option<ProviderError> = None;
            loop {
                let next = tokio::select! {
                    _ = self.cancellation.cancelled() => {
                        return Err(RunFailure::Stopped(if self.event_tx.is_closed() {
                            StopReason::ConsumerStopped
                        } else {
                            StopReason::Cancelled
                        }));
                    }
                    event = stream.next() => event,
                };
                match next {
                    Some(Ok(ProviderEvent::TextDelta(delta))) => {
                        round.saw_delta = true;
                        round.text.push_str(&delta);
                        self.emit(LoopEventKind::TextDelta(delta)).await?;
                    }
                    Some(Ok(ProviderEvent::ReasoningDelta(delta))) => {
                        round.saw_delta = true;
                        round.reasoning.push_str(&delta);
                        self.emit(LoopEventKind::ReasoningDelta(delta)).await?;
                    }
                    Some(Ok(ProviderEvent::ToolCallDelta {
                        index,
                        id,
                        name,
                        arguments_delta,
                    })) => {
                        round.saw_delta = true;
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
                    Some(Ok(ProviderEvent::Completed {
                        usage,
                        provider_items,
                    })) => {
                        round.usage = usage;
                        round.provider_items = provider_items;
                        round.completed = true;
                        break;
                    }
                    Some(Err(error)) => {
                        failure = Some(error);
                        break;
                    }
                    None => {
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
            if error.retryable && !round.saw_delta && attempt < max_attempts {
                self.emit(LoopEventKind::ModelRetry {
                    attempt,
                    error: error.message,
                })
                .await?;
                continue;
            }
            return Err(RunFailure::Failed(error.message));
        }
        Err(RunFailure::Failed(
            "provider retry limit reached".to_owned(),
        ))
    }

    async fn execute_tool_batch(&mut self, calls: Vec<ToolCall>) -> Result<(), RunFailure> {
        let mut scheduled = calls
            .into_iter()
            .enumerate()
            .map(|(order, call)| ScheduledTool::new(order, call, &self.request.tools))
            .collect::<Vec<_>>();
        let mut active: FuturesUnordered<ToolFuture> = FuturesUnordered::new();
        let mut active_modes = HashMap::<usize, (ToolConcurrency, String)>::new();
        let mut completed = std::iter::repeat_with(|| None)
            .take(scheduled.len())
            .collect::<Vec<Option<ToolExecution>>>();
        let mut completed_count = 0usize;

        while completed_count < scheduled.len() {
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

            if active.is_empty() {
                return Err(RunFailure::Failed("tool scheduler deadlock".to_owned()));
            }
            let execution = tokio::select! {
                _ = self.cancellation.cancelled() => {
                    return Err(RunFailure::Stopped(if self.event_tx.is_closed() {
                        StopReason::ConsumerStopped
                    } else {
                        StopReason::Cancelled
                    }));
                }
                execution = active.next() => execution.expect("active tool set is non-empty"),
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

        for execution in completed.into_iter().flatten() {
            self.messages
                .push(AgentMessage::tool(execution.call.id, execution.model_text));
        }
        Ok(())
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

#[derive(Default)]
struct ModelRound {
    text: String,
    reasoning: String,
    calls_by_index: std::collections::BTreeMap<usize, ToolCall>,
    calls: Vec<ToolCall>,
    provider_items: Vec<Value>,
    usage: Option<Value>,
    completed: bool,
    saw_delta: bool,
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
}

struct ToolExecution {
    order: usize,
    call: ToolCall,
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
            handler(arguments, handler_token)
        }));
        match future {
            Err(_) => ToolResult::failure("tool handler panicked"),
            Ok(future) => {
                let caught = std::panic::AssertUnwindSafe(future).catch_unwind();
                tokio::select! {
                    _ = cancellation.cancelled() => ToolResult::failure("tool call cancelled"),
                    timed = tokio::time::timeout(spec.timeout, caught) => {
                        match timed {
                            Err(_) => {
                                handler_cancellation.cancel();
                                ToolResult::failure(format!(
                                    "tool timed out after {} ms",
                                    spec.timeout.as_millis()
                                ))
                            },
                            Ok(Err(_)) => ToolResult::failure("tool handler panicked"),
                            Ok(Ok(result)) => result,
                        }
                    }
                }
            }
        }
    };
    let (model_text, _) = tool_result_for_model(&result, result_limit);
    ToolExecution {
        order: item.order,
        call: item.call,
        result,
        model_text,
    }
}

#[derive(Debug)]
enum RunFailure {
    Stopped(StopReason),
    Failed(String),
}

impl From<String> for RunFailure {
    fn from(value: String) -> Self {
        Self::Failed(value)
    }
}

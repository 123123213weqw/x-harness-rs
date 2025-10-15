use std::{
    collections::{HashMap, VecDeque},
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
    tool_result_for_model, AgentMessage, InjectionMode, LoopCommand, LoopControlError, LoopEvent,
    LoopEventKind, LoopRequest, LoopResult, LoopStatus, ProviderError, ProviderEvent,
    ProviderRequest, Role, SessionSnapshot, ToolCall, ToolConcurrency, ToolResult, ToolSpec,
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
    command_tx: mpsc::Sender<LoopCommand>,
}

impl LoopRun {
    /// Returns this run as a stream. It can only be consumed once, in order.
    pub fn events(&mut self) -> &mut Self {
        self
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    /// Sends a live control command to the running loop.
    pub async fn send(&self, command: LoopCommand) -> Result<(), LoopControlError> {
        self.command_tx
            .send(command)
            .await
            .map_err(|_| LoopControlError::Closed)
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
        if request.config.command_buffer == 0 {
            request.config.command_buffer = 64;
        }

        let run_id = new_run_id();
        let cancellation = CancellationToken::new();
        let (event_tx, event_rx) = mpsc::channel(request.config.event_buffer);
        let (command_tx, command_rx) = mpsc::channel(request.config.command_buffer);
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
            command_rx,
            command_open: true,
            pending_messages: VecDeque::new(),
            paused: false,
            approval_decisions: HashMap::new(),
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
    command_rx: mpsc::Receiver<LoopCommand>,
    command_open: bool,
    pending_messages: VecDeque<AgentMessage>,
    paused: bool,
    approval_decisions: HashMap<String, ApprovalDecision>,
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
            self.settle_control_at_boundary().await?;
            self.step += 1;
            let prepared = self
                .request
                .context_policy
                .prepare(&self.messages)
                .await
                .map_err(RunFailure::Failed)?;

            let mut model = self.model_round(prepared).await?;
            for call in &mut model.calls {
                if call.id.is_empty() {
                    call.id = format!("{}-{}-{}", self.run_id, self.step, call.index);
                }
            }

            if model.interrupted {
                if !model.text.is_empty() || !model.reasoning.is_empty() {
                    self.final_text = model.text.clone();
                    self.messages.push(AgentMessage {
                        role: Role::Assistant,
                        content: model.text,
                        reasoning: model.reasoning,
                        tool_calls: Vec::new(),
                        tool_call_id: None,
                        provider_items: Vec::new(),
                        interrupted: true,
                    });
                    self.snapshot("assistant_interrupted", true).await?;
                }
                self.settle_control_at_boundary().await?;
                continue;
            }

            let assistant = AgentMessage {
                role: Role::Assistant,
                content: model.text.clone(),
                reasoning: model.reasoning,
                tool_calls: model.calls.clone(),
                tool_call_id: None,
                provider_items: model.provider_items,
                interrupted: false,
            };
            self.final_text = model.text;
            self.usage = model.usage;
            self.messages.push(assistant);
            self.snapshot("assistant_saved", true).await?;

            if model.calls.is_empty() {
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
            self.snapshot("tool_batch_saved", true).await?;
        }

        self.emit(LoopEventKind::LimitReached).await?;
        Ok(LoopStatus::LimitReached)
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
        self.messages.extend(self.pending_messages.drain(..));
        self.snapshot("message_injected", self.tool_batch_complete)
            .await?;
        Ok(true)
    }

    async fn drain_commands(&mut self, allow_model_interrupt: bool) -> Result<bool, RunFailure> {
        let mut interrupt = false;
        loop {
            match self.command_rx.try_recv() {
                Ok(command) => {
                    interrupt |= self.handle_command(command, allow_model_interrupt).await?;
                }
                Err(mpsc::error::TryRecvError::Empty) => return Ok(interrupt),
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    self.command_open = false;
                    return Ok(interrupt);
                }
            }
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
            LoopCommand::Cancel => {
                self.cancellation.cancel();
                Err(self.stopped_failure())
            }
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
            let command = tokio::select! {
                _ = self.cancellation.cancelled() => return Err(self.stopped_failure()),
                command = self.command_rx.recv() => command,
            };
            match command {
                Some(command) => {
                    interrupt = self.handle_command(command, allow_model_interrupt).await?;
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
            Err(RunFailure::Stopped(if self.event_tx.is_closed() {
                StopReason::ConsumerStopped
            } else {
                StopReason::Cancelled
            }))
        } else {
            Ok(())
        }
    }

    fn stopped_failure(&self) -> RunFailure {
        RunFailure::Stopped(if self.event_tx.is_closed() {
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
            let provider_cancellation = self.cancellation.child_token();
            let provider = self.request.provider.clone();
            let mut stream_future =
                Box::pin(provider.stream(request, provider_cancellation.clone()));
            let stream = loop {
                enum ProviderStart {
                    Command(Option<LoopCommand>),
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
                    ProviderStart::Command(Some(command)) => {
                        let interrupt = self.handle_command(command, true).await?;
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
                enum ModelInput {
                    Command(Option<LoopCommand>),
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
                    ModelInput::Command(Some(command)) => {
                        let interrupt = self.handle_command(command, true).await?;
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
                        self.emit(LoopEventKind::TextDelta(delta)).await?;
                    }
                    ModelInput::Provider(Some(Ok(ProviderEvent::ReasoningDelta(delta)))) => {
                        round.saw_delta = true;
                        round.reasoning.push_str(&delta);
                        self.emit(LoopEventKind::ReasoningDelta(delta)).await?;
                    }
                    ModelInput::Provider(Some(Ok(ProviderEvent::ToolCallDelta {
                        index,
                        id,
                        name,
                        arguments_delta,
                    }))) => {
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
                    ModelInput::Provider(Some(Ok(ProviderEvent::Completed {
                        usage,
                        provider_items,
                    }))) => {
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
        let mut completed_count = self
            .resolve_tool_approvals(&mut scheduled, &mut completed)
            .await?;

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
                Command(Option<LoopCommand>),
                Completed(ToolExecution),
            }
            let input = tokio::select! {
                _ = self.cancellation.cancelled() => return Err(self.stopped_failure()),
                command = self.command_rx.recv(), if self.command_open => {
                    ToolInput::Command(command)
                }
                execution = active.next() => {
                    ToolInput::Completed(execution.expect("active tool set is non-empty"))
                },
            };
            let execution = match input {
                ToolInput::Command(Some(command)) => {
                    self.handle_command(command, false).await?;
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

        for execution in completed.into_iter().flatten() {
            self.messages
                .push(AgentMessage::tool(execution.call.id, execution.model_text));
        }
        Ok(())
    }

    async fn resolve_tool_approvals(
        &mut self,
        scheduled: &mut [ScheduledTool],
        completed: &mut [Option<ToolExecution>],
    ) -> Result<usize, RunFailure> {
        let approval_calls = scheduled
            .iter()
            .filter(|item| item.requires_approval())
            .map(|item| item.call.clone())
            .collect::<Vec<_>>();
        for call in &approval_calls {
            self.emit(LoopEventKind::ToolApprovalRequested { call: call.clone() })
                .await?;
        }

        let mut rejected_count = 0;
        for item in scheduled.iter_mut().filter(|item| item.requires_approval()) {
            let decision = self.wait_for_approval(&item.call.id).await?;
            match decision {
                ApprovalDecision::Approved => {
                    self.emit(LoopEventKind::ToolApprovalResolved {
                        call: item.call.clone(),
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
                    self.emit(LoopEventKind::ToolApprovalResolved {
                        call: item.call.clone(),
                        approved: false,
                        reason: Some(reason.clone()),
                    })
                    .await?;
                    item.started = true;
                    let result = ToolResult::failure(format!("tool rejected: {reason}"));
                    let (model_text, _) =
                        tool_result_for_model(&result, self.request.config.tool_result_limit_bytes);
                    let execution = ToolExecution {
                        order: item.order,
                        call: item.call.clone(),
                        result,
                        model_text,
                    };
                    self.emit(LoopEventKind::ToolCompleted {
                        call: execution.call.clone(),
                        result: execution.result.clone(),
                    })
                    .await?;
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
            let command = tokio::select! {
                _ = self.cancellation.cancelled() => return Err(self.stopped_failure()),
                command = self.command_rx.recv() => command,
            };
            match command {
                Some(command) => {
                    self.handle_command(command, false).await?;
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
    interrupted: bool,
}

#[derive(Clone, Debug)]
enum ApprovalDecision {
    Approved,
    Rejected(String),
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

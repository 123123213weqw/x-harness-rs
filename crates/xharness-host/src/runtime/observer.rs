//! Durable, input-scoped Host observation and loss recovery.
use super::*;

/// Fallback for a lost terminal broadcast. Scope the transcript to this turn's
/// durable end so an already-started successor cannot contaminate its result.
fn recovered_observer_result(session: &Session, turn: u32) -> Option<LoopResult> {
    use xharness_session::{EventData, TurnEndReason};
    let (end, reason) = session
        .events()
        .iter()
        .enumerate()
        .find_map(|(i, e)| match e.data() {
            EventData::TurnEnd { turn: t, reason } if *t == turn => Some((i, reason)),
            _ => None,
        })?;
    let (status, error) = match reason {
        TurnEndReason::Completed => (LoopStatus::Completed, None),
        TurnEndReason::MaxTokens => (LoopStatus::MaxTokens, None),
        TurnEndReason::Cancelled | TurnEndReason::UserInterrupted => (LoopStatus::Cancelled, None),
        TurnEndReason::LimitReached => (LoopStatus::LimitReached, None),
        TurnEndReason::Failed { error } => (LoopStatus::Failed, Some(error.clone())),
        TurnEndReason::Interrupted => (
            LoopStatus::Failed,
            Some("turn interrupted during recovery".into()),
        ),
    };
    let events = &session.events()[..=end];
    let final_text = events
        .iter()
        .rev()
        .find_map(|e| match e.data() {
            EventData::AssistantMessage {
                turn: t, message, ..
            } if *t == turn => Some(message.content.clone()),
            _ => None,
        })
        .unwrap_or_default();
    // Usage is optional, not zero when absent. Prefer per-request chunks, which
    // include truncated requests; legacy journals may only have message usage.
    let mut by_step = std::collections::BTreeMap::<u32, xharness_core::TokenUsage>::new();
    let mut chunk_steps = std::collections::BTreeSet::new();
    let mut pending_usage = None;
    let mut step_usage = Vec::new();
    let mut finish_reason = None;
    for event in events {
        match event.data() {
            EventData::AssistantChunk {
                turn: t,
                step,
                chunk: xharness_session::AssistantChunk::Usage(value),
            } if *t == turn => {
                if let Ok(usage) =
                    serde_json::from_value::<xharness_core::TokenUsage>(value.clone())
                {
                    by_step
                        .entry(*step)
                        .or_default()
                        .saturating_add_assign(&usage);
                    pending_usage = Some((*step, usage));
                    chunk_steps.insert(*step);
                }
            }
            EventData::AssistantChunk {
                turn: t,
                step,
                chunk: xharness_session::AssistantChunk::Finish { reason },
            } if *t == turn => {
                let parsed = serde_json::from_value::<xharness_core::FinishReason>(
                    serde_json::Value::String(reason.clone()),
                )
                .or_else(|_| serde_json::from_str(reason))
                .ok();
                if let Some(reason) = parsed {
                    finish_reason = Some(reason.clone());
                    if let Some((usage_step, usage)) = pending_usage.take() {
                        if usage_step == *step {
                            step_usage.push(xharness_core::StepUsage {
                                step: *step as usize,
                                usage,
                                finish_reason: reason,
                            });
                        }
                    }
                }
            }
            EventData::AssistantMessage {
                turn: t,
                step,
                usage: Some(value),
                ..
            } if *t == turn && !chunk_steps.contains(step) => {
                if let Ok(usage) = serde_json::from_value(value.clone()) {
                    by_step.insert(*step, usage);
                }
            }
            _ => {}
        }
    }
    let usage = (!by_step.is_empty()).then(|| {
        let mut total = xharness_core::TokenUsage::default();
        for usage in by_step.values() {
            total.saturating_add_assign(usage);
        }
        total
    });
    Some(LoopResult {
        status,
        final_text,
        messages: xharness_session::derive_messages(events),
        usage,
        // Missing metadata in legacy journals remains unavailable, not invented.
        step_usage,
        finish_reason,
        error,
    })
}

pub(super) struct DurableRunningTurn {
    handle: DurableAgentHandle,
    events: broadcast::Receiver<AgentEvent>,
    target_input_id: String,
    turn: Option<u32>,
    result: Option<LoopResult>,
    terminal: bool,
    next_control_id: Arc<AtomicU64>,
}

impl DurableRunningTurn {
    pub(super) fn new(prepared: PreparedDurableTurn, next_control_id: Arc<AtomicU64>) -> Self {
        Self {
            handle: prepared.handle,
            events: prepared.events,
            target_input_id: prepared.input_id,
            turn: None,
            result: None,
            terminal: false,
            next_control_id,
        }
    }

    fn inbox_message(
        &self,
        mut message: AgentMessage,
        source: Option<serde_json::Value>,
    ) -> Result<InboxMessage, LoopControlError> {
        if message.role != Role::User {
            return Err(LoopControlError::Rejected(
                "durable steering currently accepts user messages only".to_owned(),
            ));
        }
        let id = message.id.clone().unwrap_or_else(|| {
            let ordinal = self.next_control_id.fetch_add(1, Ordering::Relaxed);
            format!("control-{}-{ordinal}", self.handle.id())
        });
        message.id = Some(id.clone());
        Ok(InboxMessage {
            id,
            message,
            source,
        })
    }

    fn failed_result(message: impl Into<String>) -> LoopResult {
        let message = message.into();
        LoopResult {
            status: LoopStatus::Failed,
            final_text: String::new(),
            messages: Vec::new(),
            usage: None,
            step_usage: Vec::new(),
            finish_reason: None,
            error: Some(message),
        }
    }

    /// Recover identity/termination from durable facts, never from another turn's
    /// terminal notification. Steering consumes the same input ID inside a turn.
    async fn reconcile(&mut self) -> Result<(), String> {
        use xharness_session::EventData;
        let session = self
            .handle
            .inbox()
            .store()
            .load(self.handle.id())
            .await
            .map_err(|e| e.to_string())?
            .ok_or("observer session disappeared")?;
        let mut active = None;
        let mut bound = None;
        for event in session.events() {
            match event.data() {
                EventData::TurnStart { turn } => active = Some(*turn),
                EventData::UserMessage { message, .. }
                    if message.id.as_deref() == Some(self.target_input_id.as_str()) =>
                {
                    bound = active;
                    break;
                }
                EventData::ApprovalAsked { id, .. }
                    if xharness_agent::approval_recovery_work_id(id) == self.target_input_id =>
                {
                    bound = active;
                    break;
                }
                EventData::QuestionRequested { invocation }
                    if xharness_agent::question_recovery_work_id(&invocation.interaction_id)
                        == self.target_input_id =>
                {
                    bound = active;
                    break;
                }
                EventData::CompactionStart {
                    source_command_id: Some(command_id),
                    ..
                } if command_id == &self.target_input_id => {
                    bound = active;
                    break;
                }
                EventData::TurnEnd { .. } => active = None,
                _ => {}
            }
        }
        self.turn = bound;
        if let Some(turn) = self.turn {
            if let Some(result) = recovered_observer_result(&session, turn) {
                self.result = Some(result);
                self.terminal = true;
            }
        } else if self.handle.status() == xharness_agent::AgentStatus::Idle {
            let inbox = xharness_agent::InboxProjection::from_session(&session)
                .map_err(|e| e.to_string())?;
            let pending = inbox
                .next_turn()
                .iter()
                .chain(inbox.next_step())
                .any(|m| m.id == self.target_input_id);
            if !pending || crate::delegation::restored_dispatch_paused(&session) {
                let mut result =
                    Self::failed_result("pending input was removed or parked before execution");
                result.status = LoopStatus::Cancelled;
                self.result = Some(result);
                self.terminal = true;
            }
        }
        Ok(())
    }

    async fn recover_or_fail(&mut self) {
        if let Err(error) = self.reconcile().await {
            self.result = Some(Self::failed_result(format!(
                "durable observer recovery failed: {error}"
            )));
            self.terminal = true;
        }
    }

    async fn receive_event(&mut self) -> Option<LoopEvent> {
        while !self.terminal {
            let received =
                match tokio::time::timeout(Duration::from_secs(1), self.events.recv()).await {
                    Ok(event) => event,
                    Err(_) => {
                        // No polling of the full transcript while a model/tool is busy.
                        // This also closes a stranded observer after an idle removal.
                        if self.handle.status() == xharness_agent::AgentStatus::Idle {
                            self.recover_or_fail().await;
                        }
                        continue;
                    }
                };
            match received {
                Ok(AgentEvent::Parked { input_ids }) => {
                    self.recover_or_fail().await;
                    if !self.terminal
                        && self.turn.is_none()
                        && input_ids.contains(&self.target_input_id)
                    {
                        let mut result =
                            Self::failed_result("pending work was parked before execution");
                        result.status = LoopStatus::Cancelled;
                        self.result = Some(result);
                        self.terminal = true;
                    }
                }
                Ok(AgentEvent::Status(xharness_agent::AgentStatus::Idle)) => {
                    self.recover_or_fail().await;
                }
                Ok(AgentEvent::TurnStarted { turn, input_ids }) => {
                    if self.turn.is_none() && input_ids.contains(&self.target_input_id) {
                        self.turn = Some(turn);
                    }
                }
                Ok(AgentEvent::TurnEvent { turn, event }) if self.turn == Some(turn) => {
                    return Some(event);
                }
                Ok(AgentEvent::TurnFinished { turn, result }) => {
                    if self.turn == Some(turn) {
                        self.result = Some(result);
                        self.terminal = true;
                    } else {
                        // The target may have been consumed by steering instead of
                        // receiving its own TurnStarted broadcast.
                        self.recover_or_fail().await;
                    }
                }
                Ok(AgentEvent::Error { message }) => {
                    self.recover_or_fail().await;
                    if !self.terminal {
                        self.result = Some(Self::failed_result(message));
                        self.terminal = true;
                    }
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    self.recover_or_fail().await;
                    if !self.terminal {
                        // Host synchronizes authoritative history at this boundary;
                        // no invented model failure, text delta, or replayed tool.
                        return Some(LoopEvent {
                            seq: 0,
                            run_id: format!("observer-{}", self.handle.id()),
                            step: 0,
                            kind: xharness_core::LoopEventKind::StreamCheckpoint,
                        });
                    }
                }
                Err(broadcast::error::RecvError::Closed) => {
                    self.recover_or_fail().await;
                    if !self.terminal {
                        self.result = Some(Self::failed_result(
                            "durable Agent closed before publishing a turn result",
                        ));
                        self.terminal = true;
                    }
                }
            }
        }
        None
    }

    async fn send_command(
        &self,
        command: LoopCommand,
        input_metadata: Option<serde_json::Value>,
    ) -> Result<(), LoopControlError> {
        let result = match command {
            LoopCommand::InjectMessage { message, mode } => {
                let message = self.inbox_message(message, input_metadata)?;
                match mode {
                    InjectionMode::NextStep => self.handle.inject(message).await,
                    InjectionMode::InterruptModel => self.handle.steer(message).await,
                }
            }
            LoopCommand::Steer(message) => {
                self.handle
                    .steer(self.inbox_message(message, input_metadata)?)
                    .await
            }
            LoopCommand::Pause => self.handle.pause().await,
            LoopCommand::Resume => self.handle.resume().await,
            LoopCommand::Cancel => self.handle.cancel_turn().await,
            LoopCommand::InterruptByUser => self.handle.interrupt_by_user().await,
            LoopCommand::ApproveTool { call_id } => self.handle.approve_tool(call_id).await,
            LoopCommand::RejectTool { call_id, reason } => {
                self.handle.reject_tool(call_id, reason).await
            }
        };
        result.map_err(loop_control_error)
    }
}

#[async_trait]
impl RunningTurn for DurableRunningTurn {
    async fn next_event(&mut self) -> Option<LoopEvent> {
        self.receive_event().await
    }

    async fn send(&mut self, command: LoopCommand) -> Result<(), LoopControlError> {
        self.send_command(command, None).await
    }

    async fn send_with_metadata(
        &mut self,
        command: LoopCommand,
        input_metadata: Option<serde_json::Value>,
    ) -> Result<(), LoopControlError> {
        self.send_command(command, input_metadata).await
    }

    async fn result(&mut self) -> LoopResult {
        while self.result.is_none() {
            let _ = self.receive_event().await;
        }
        self.result.clone().unwrap_or_else(|| {
            Self::failed_result("durable Agent ended without publishing a result")
        })
    }
}

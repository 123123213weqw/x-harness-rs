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
        TurnEndReason::Failed { error, .. } => (LoopStatus::Failed, Some(error.clone())),
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

/// Body-free, incremental receipt projection. A successor can be busy while
/// this input has already settled; Agent-wide Idle is not an input receipt.
#[derive(Default)]
struct ObserverReceipt {
    next_seq: usize,
    active: Option<u32>,
    bound: Option<u32>,
    ended: bool,
    cancelled: bool,
    next_turn: Vec<String>,
    next_step: Vec<String>,
    #[cfg(test)]
    examined: usize,
}

impl ObserverReceipt {
    fn update(&mut self, session: &Session, input: &str) -> Result<(), String> {
        use xharness_session::{EventData, InboxSpliceOutcome, InboxTarget};
        let tail = session
            .events()
            .get(self.next_seq..)
            .ok_or("durable observer journal moved behind its receipt cursor")?;
        #[cfg(test)]
        {
            self.examined += tail.len();
        }
        for event in tail {
            match event.data() {
                EventData::TurnStart { turn } => self.active = Some(*turn),
                EventData::UserMessage { message, .. } if message.id.as_deref() == Some(input) => {
                    self.bound = self.bound.or(self.active)
                }
                EventData::ApprovalAsked { id, .. }
                    if xharness_agent::approval_recovery_work_id(id) == input =>
                {
                    self.bound = self.bound.or(self.active)
                }
                EventData::QuestionRequested { invocation }
                    if xharness_agent::question_recovery_work_id(&invocation.interaction_id)
                        == input =>
                {
                    self.bound = self.bound.or(self.active)
                }
                EventData::CompactionStart {
                    source_command_id: Some(id),
                    ..
                } if id == input => self.bound = self.bound.or(self.active),
                EventData::TurnEnd { turn, .. } => {
                    self.ended |= self.bound == Some(*turn);
                    self.active = None;
                }
                EventData::AgentInboxSpliced {
                    target,
                    start,
                    removed_count,
                    inserted,
                    outcome,
                } => {
                    let ids = match target {
                        InboxTarget::NextTurn => &mut self.next_turn,
                        InboxTarget::NextStep => &mut self.next_step,
                    };
                    let end = start
                        .checked_add(*removed_count)
                        .ok_or("durable observer inbox splice overflow")?;
                    let removed = ids
                        .get(*start..end)
                        .ok_or("durable observer inbox splice is inconsistent")?;
                    if *outcome == Some(InboxSpliceOutcome::Cancelled)
                        && removed.iter().any(|id| id == input)
                    {
                        self.cancelled = true;
                    }
                    ids.splice(*start..end, inserted.iter().map(|m| m.id.clone()));
                }
                _ => {}
            }
        }
        self.next_seq = session.events().len();
        Ok(())
    }

    fn pending(&self, input: &str) -> bool {
        self.next_turn
            .iter()
            .chain(&self.next_step)
            .any(|id| id == input)
    }
}

pub(super) struct DurableRunningTurn {
    handle: DurableAgentHandle,
    events: broadcast::Receiver<AgentEvent>,
    target_input_id: String,
    turn: Option<u32>,
    result: Option<LoopResult>,
    terminal: bool,
    receipt: ObserverReceipt,
    initialized: bool,
    reconcile_after: tokio::time::Instant,
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
            receipt: ObserverReceipt::default(),
            initialized: false,
            reconcile_after: tokio::time::Instant::now(),
            next_control_id,
        }
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
        let session = self
            .handle
            .inbox()
            .store()
            .load(self.handle.id())
            .await
            .map_err(|e| e.to_string())?
            .ok_or("observer session disappeared")?;
        self.receipt.update(&session, &self.target_input_id)?;
        // TurnStarted can precede its atomic journal commit. Do not erase that
        // live binding just because a concurrent read still sees the prior cut.
        self.turn = self.receipt.bound.or(self.turn);
        if let Some(turn) = self.turn {
            if let Some(result) = self
                .receipt
                .ended
                .then(|| recovered_observer_result(&session, turn))
                .flatten()
            {
                self.result = Some(result);
                self.terminal = true;
            }
        } else {
            let pending = self.receipt.pending(&self.target_input_id);
            let idle = self.handle.status() == xharness_agent::AgentStatus::Idle;
            // A durable cancellation is sufficient even if a different turn is
            // busy. Mere absence is NOT: /compact may be preparing its prelude.
            if (!pending && self.receipt.cancelled)
                || (idle && (!pending || crate::delegation::restored_dispatch_paused(&session)))
            {
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
        if !self.initialized {
            self.recover_or_fail().await;
            self.initialized = true;
            self.reconcile_after = tokio::time::Instant::now() + Duration::from_secs(1);
        }
        while !self.terminal {
            // An absolute deadline survives next_event cancellation and cannot
            // be starved by a continuous stream belonging to another input.
            if tokio::time::Instant::now() >= self.reconcile_after {
                // A scoped durable end is authoritative even while a successor
                // keeps the Agent busy or its terminal broadcast was lost.
                self.recover_or_fail().await;
                self.reconcile_after = tokio::time::Instant::now() + Duration::from_secs(1);
                continue;
            }
            let received =
                match tokio::time::timeout_at(self.reconcile_after, self.events.recv()).await {
                    Ok(event) => event,
                    Err(_) => {
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

    pub(super) fn bind_turn(&mut self, turn: u32) {
        self.turn = Some(turn);
        self.receipt.bound = Some(turn);
    }
    fn command_future(
        &self,
        command: LoopCommand,
        metadata: Option<serde_json::Value>,
    ) -> TurnControlFuture {
        let control = DurableCommand {
            handle: self.handle.clone(),
            next_control_id: self.next_control_id.clone(),
            turn: self.turn,
        };
        Box::pin(async move { control.send_command(command, metadata).await })
    }
}

struct DurableCommand {
    handle: DurableAgentHandle,
    next_control_id: Arc<AtomicU64>,
    turn: Option<u32>,
}
impl DurableCommand {
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
            command => self.handle.control_turn(self.turn, command).await,
        };
        result.map_err(loop_control_error)
    }
}

#[async_trait]
impl RunningTurn for DurableRunningTurn {
    fn detached_control(
        &self,
        command: LoopCommand,
        metadata: Option<serde_json::Value>,
    ) -> Option<TurnControlFuture> {
        Some(self.command_future(command, metadata))
    }

    async fn next_event(&mut self) -> Option<LoopEvent> {
        self.receive_event().await
    }

    async fn send(&mut self, command: LoopCommand) -> Result<(), LoopControlError> {
        self.command_future(command, None).await
    }

    async fn send_with_metadata(
        &mut self,
        command: LoopCommand,
        input_metadata: Option<serde_json::Value>,
    ) -> Result<(), LoopControlError> {
        self.command_future(command, input_metadata).await
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

#[cfg(test)]
mod receipt_tests {
    use super::*;
    use xharness_session::{EventData, InboxSpliceOutcome, InboxTarget, Revision};

    #[test]
    fn receipt_folds_only_new_events_and_retains_only_pending_ids() {
        let mut session = Session::new(SessionHeader::new("receipt-cursor")).unwrap();
        let mut events = Vec::new();
        for ordinal in 0..5000 {
            events.push(
                EventData::AgentInboxSpliced {
                    target: InboxTarget::NextTurn,
                    start: 0,
                    removed_count: 0,
                    inserted: vec![InboxMessage::user(
                        format!("id-{ordinal}"),
                        "body must not be retained",
                    )],
                    outcome: None,
                }
                .into(),
            );
            events.push(
                EventData::AgentInboxSpliced {
                    target: InboxTarget::NextTurn,
                    start: 0,
                    removed_count: 1,
                    inserted: Vec::new(),
                    outcome: Some(InboxSpliceOutcome::Cancelled),
                }
                .into(),
            );
        }
        session.append_batch(Revision::ZERO, events).unwrap();
        let mut receipt = ObserverReceipt::default();
        for _ in 0..10 {
            receipt.update(&session, "id-4999").unwrap();
        }
        assert_eq!(
            receipt.examined, 10000,
            "unchanged cuts must not be rescanned"
        );
        assert!(receipt.cancelled && receipt.next_turn.is_empty() && receipt.next_step.is_empty());
        session
            .append(
                session.revision(),
                EventData::AgentInboxSpliced {
                    target: InboxTarget::NextStep,
                    start: 0,
                    removed_count: 0,
                    inserted: vec![InboxMessage::user("next", "x".repeat(65536))],
                    outcome: None,
                },
            )
            .unwrap();
        receipt.update(&session, "id-4999").unwrap();
        assert_eq!(receipt.examined, 10001);
        assert_eq!(receipt.next_step, ["next"]);
        assert!(!receipt.pending("id-4999"));
    }

    #[test]
    fn receipt_rejects_regression_instead_of_replaying_or_fabricating_completion() {
        let mut session = Session::new(SessionHeader::new("receipt-regression")).unwrap();
        session
            .append(
                Revision::ZERO,
                EventData::AgentDispatchPaused { paused: true },
            )
            .unwrap();
        let mut receipt = ObserverReceipt::default();
        receipt.update(&session, "input").unwrap();
        let stale = Session::new(SessionHeader::new("receipt-regression")).unwrap();
        assert!(receipt
            .update(&stale, "input")
            .unwrap_err()
            .contains("moved behind"));
    }
    struct FinishFirstThenBlock {
        calls: std::sync::atomic::AtomicUsize,
        release: Arc<tokio::sync::Notify>,
    }
    #[async_trait::async_trait]
    impl xharness_core::ModelProvider for FinishFirstThenBlock {
        async fn stream(
            &self,
            _: xharness_core::ProviderRequest,
            _: CancellationToken,
        ) -> Result<xharness_core::ProviderStream, xharness_core::ProviderError> {
            let first = self.calls.fetch_add(1, Ordering::SeqCst) == 0;
            let release = self.release.clone();
            if first {
                Ok(Box::pin(async_stream::stream! {
                    release.notified().await;
                    yield Ok(xharness_core::ProviderEvent::Completed { finish_reason:Some(xharness_core::FinishReason::Stop), usage:None, provider_items:vec![] });
                }))
            } else {
                Ok(Box::pin(futures::stream::pending()))
            }
        }
    }
    #[tokio::test]
    async fn bound_observer_reconciles_lost_end_even_while_successor_agent_is_busy() {
        let store: Arc<dyn Store> = Arc::new(xharness_session::MemorySessionStore::default());
        let release = Arc::new(tokio::sync::Notify::new());
        let provider = Arc::new(FinishFirstThenBlock {
            calls: std::sync::atomic::AtomicUsize::new(0),
            release: release.clone(),
        });
        let runtime = DurableLoopAgentRuntime::new(
            "test",
            "test",
            Some(provider.clone()),
            Arc::new(crate::NoTools),
            Arc::new(xharness_core::IdentityContextPolicy),
            store.clone(),
            Arc::new(xharness_agent::MemoryLeaseManager::default()),
            64,
        );
        let request = |id: &str| {
            let mut message = AgentMessage::user("synthetic");
            message.id = Some(id.into());
            AgentTurnRequest {
                session_id: "lost-terminal".into(),
                cwd: std::env::temp_dir().to_string_lossy().into(),
                route: ModelRoute::new("test", "test"),
                permission: PermissionPreset::WorkspaceWrite,
                prompt: None,
                messages: vec![message],
                input_metadata: None,
            }
        };
        let prepared = runtime.prepare_turn(request("one")).await.unwrap();
        let handle = prepared.handle.clone();
        handle.wake().await.unwrap();
        let mut observer = DurableRunningTurn::new(prepared, runtime.next_control_id.clone());
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                observer.reconcile().await.unwrap();
                if observer.turn.is_some() && provider.calls.load(Ordering::SeqCst) == 1 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        observer.initialized = true;
        let _second = runtime.prepare_turn(request("two")).await.unwrap();
        release.notify_one();
        tokio::time::timeout(Duration::from_secs(3), async {
            while provider.calls.load(Ordering::SeqCst) < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(handle.status(), xharness_agent::AgentStatus::Running);
        // Deliberate loss without a Lagged notification. The durable receipt,
        // not global Idle or a successor's terminal, must finish this observer.
        observer.events = handle.subscribe();
        observer.reconcile_after = tokio::time::Instant::now();
        assert!(
            tokio::time::timeout(Duration::from_secs(2), observer.next_event())
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(observer.result().await.status, LoopStatus::Completed);
        runtime.shutdown(Duration::from_secs(1)).await;
    }
}

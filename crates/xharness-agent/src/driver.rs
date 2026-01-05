use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use async_trait::async_trait;
use futures::StreamExt;
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;
use xharness_core::{
    AgentMessage, InjectionMode, LoopCommand, LoopControlError, LoopEngine, LoopEvent, LoopRequest,
    LoopResult,
};
use xharness_session::{InboxMessage, InboxTarget};

use crate::{
    AgentActivation, AgentRegistry, AgentStatus, DurableInbox, InboxError, LifecycleError,
    RegistryError,
};

/// Deployment-owned construction of one turn's Provider, tools, context and
/// limits. The durable driver overwrites Session journal fields after return.
#[async_trait]
pub trait TurnRequestFactory: Send + Sync + 'static {
    async fn build(&self, agent_id: &str, input: Vec<AgentMessage>) -> Result<LoopRequest, String>;
}

/// Long-lived events. Loop event sequence numbers remain scoped to one turn;
/// subscribers use the durable Session sequence for restart replay.
#[derive(Clone, Debug, PartialEq)]
pub enum AgentEvent {
    Status(AgentStatus),
    InboxInserted {
        target: InboxTarget,
        message: InboxMessage,
    },
    TurnStarted {
        turn: u32,
        /// Stable durable inbox identities atomically claimed by this turn.
        /// Host adapters use these identities to correlate a pre-admitted
        /// HTTP prompt with its later event stream without relying on timing.
        input_ids: Vec<String>,
    },
    TurnEvent {
        turn: u32,
        event: LoopEvent,
    },
    TurnFinished {
        turn: u32,
        result: LoopResult,
    },
    Error {
        message: String,
    },
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum AgentCommandError {
    #[error("agent driver is closed")]
    Closed,
    #[error("agent command is unavailable while no turn is running")]
    NoActiveTurn,
    #[error("agent command failed: {0}")]
    Failed(String),
}

/// Settlement of one owned Agent worker during runtime shutdown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentShutdownOutcome {
    /// The active Loop accepted cancellation and published its terminal result
    /// before the shared shutdown deadline.
    Graceful,
    /// The worker exceeded the deadline and its task had to be aborted. The
    /// process layer still performs synchronous last-resort group cleanup.
    ForcedCleanup,
}

/// Aggregate, bounded shutdown result for one process-local supervisor.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentShutdownReport {
    pub workers: usize,
    pub graceful: usize,
    pub forced_cleanup: usize,
    pub cleanup_errors: Vec<String>,
}

impl AgentShutdownReport {
    pub const fn is_graceful(&self) -> bool {
        self.forced_cleanup == 0 && self.cleanup_errors.is_empty()
    }
}

struct WorkerDoneGuard(watch::Sender<bool>);

impl Drop for WorkerDoneGuard {
    fn drop(&mut self) {
        self.0.send_replace(true);
    }
}

/// Stable internal work identity used to correlate a restarted approval turn
/// with the Host subscriber that was attached before the worker was woken.
pub fn approval_recovery_work_id(approval_id: &str) -> String {
    format!("approval-recovery:{approval_id}")
}

/// Stable internal work identity used to correlate a restarted user-question
/// tool call with the Host subscriber attached before replay.
pub fn question_recovery_work_id(interaction_id: &str) -> String {
    format!("question-recovery:{interaction_id}")
}

enum DriverCommand {
    /// Explicitly start processing already-durable pending input. Activation
    /// itself never does this because resume callers must first attach event
    /// subscribers and product projections.
    Wake,
    /// Resume one open tool-approval boundary from the durable Session log.
    /// No synthetic user input or new turn is created.
    RecoverOpenTurn,
    Followup(InboxMessage),
    Steer(InboxMessage),
    Inject(InboxMessage),
    Control(LoopCommand),
}

struct CommandEnvelope {
    command: DriverCommand,
    acknowledgement: oneshot::Sender<Result<(), AgentCommandError>>,
}

/// Cloneable control handle for one long-lived Agent worker.
#[derive(Clone)]
pub struct DurableAgentHandle {
    activation: Arc<AgentActivation>,
    commands: mpsc::Sender<CommandEnvelope>,
    events: broadcast::Sender<AgentEvent>,
    status: watch::Receiver<AgentStatus>,
    shutdown: CancellationToken,
    stopped: watch::Receiver<bool>,
    abort: tokio::task::AbortHandle,
}

impl DurableAgentHandle {
    /// Start one worker. It sleeps until a new command or explicit [`Self::wake`]
    /// even when the recovered inbox already contains work. This prevents a
    /// restarted worker from publishing `TurnStarted` before its Host has
    /// attached a replay-safe subscriber.
    pub fn start(
        activation: Arc<AgentActivation>,
        factory: Arc<dyn TurnRequestFactory>,
        event_capacity: usize,
    ) -> Self {
        let (commands, command_rx) = mpsc::channel(64);
        let (events, _) = broadcast::channel(event_capacity.max(16));
        let (status_tx, status) = watch::channel(AgentStatus::Idle);
        let shutdown = activation.cancellation();
        let (stopped_tx, stopped) = watch::channel(false);
        let worker = DriverWorker {
            activation: Arc::clone(&activation),
            factory,
            commands: command_rx,
            events: events.clone(),
            status: status_tx,
            wake_requested: false,
            recovery_requested: false,
            shutdown: shutdown.clone(),
        };
        let task = tokio::spawn(async move {
            let _done = WorkerDoneGuard(stopped_tx);
            worker.run().await;
        });
        let abort = task.abort_handle();
        Self {
            activation,
            commands,
            events,
            status,
            shutdown,
            stopped,
            abort,
        }
    }

    pub fn id(&self) -> &str {
        self.activation.id()
    }

    pub fn inbox(&self) -> &DurableInbox {
        self.activation.inbox()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AgentEvent> {
        self.events.subscribe()
    }

    pub fn status(&self) -> AgentStatus {
        *self.status.borrow()
    }

    pub fn is_same_worker(&self, other: &Self) -> bool {
        self.commands.same_channel(&other.commands)
    }

    pub async fn when_idle(&self) -> Result<(), AgentCommandError> {
        let mut status = self.status.clone();
        loop {
            if *status.borrow_and_update() == AgentStatus::Idle {
                return Ok(());
            }
            status
                .changed()
                .await
                .map_err(|_| AgentCommandError::Closed)?;
        }
    }

    pub fn request_shutdown(&self) {
        self.shutdown.cancel();
    }

    pub async fn when_stopped(&self) {
        let mut stopped = self.stopped.clone();
        while !*stopped.borrow_and_update() {
            if stopped.changed().await.is_err() {
                return;
            }
        }
    }

    pub async fn shutdown(&self, grace: Duration) -> AgentShutdownOutcome {
        self.request_shutdown();
        if tokio::time::timeout(grace, self.when_stopped())
            .await
            .is_ok()
        {
            return AgentShutdownOutcome::Graceful;
        }
        self.abort.abort();
        self.when_stopped().await;
        AgentShutdownOutcome::ForcedCleanup
    }

    pub async fn followup(&self, message: InboxMessage) -> Result<(), AgentCommandError> {
        self.send(DriverCommand::Followup(message)).await
    }

    /// Process work that was already durable before this worker was created.
    /// New followups wake the worker implicitly; startup recovery uses this
    /// method after every pending input has an attached event receiver.
    pub async fn wake(&self) -> Result<(), AgentCommandError> {
        self.send(DriverCommand::Wake).await
    }

    /// Resume a durable approval or user-question boundary after subscribers
    /// have attached.
    pub async fn recover_open_turn(&self) -> Result<(), AgentCommandError> {
        self.send(DriverCommand::RecoverOpenTurn).await
    }

    pub async fn steer(&self, message: InboxMessage) -> Result<(), AgentCommandError> {
        self.send(DriverCommand::Steer(message)).await
    }

    pub async fn inject(&self, message: InboxMessage) -> Result<(), AgentCommandError> {
        self.send(DriverCommand::Inject(message)).await
    }

    pub async fn pause(&self) -> Result<(), AgentCommandError> {
        self.send(DriverCommand::Control(LoopCommand::Pause)).await
    }

    pub async fn resume(&self) -> Result<(), AgentCommandError> {
        self.send(DriverCommand::Control(LoopCommand::Resume)).await
    }

    pub async fn cancel_turn(&self) -> Result<(), AgentCommandError> {
        self.send(DriverCommand::Control(LoopCommand::Cancel)).await
    }

    pub async fn approve_tool(&self, call_id: impl Into<String>) -> Result<(), AgentCommandError> {
        self.send(DriverCommand::Control(LoopCommand::ApproveTool {
            call_id: call_id.into(),
        }))
        .await
    }

    pub async fn reject_tool(
        &self,
        call_id: impl Into<String>,
        reason: impl Into<String>,
    ) -> Result<(), AgentCommandError> {
        self.send(DriverCommand::Control(LoopCommand::RejectTool {
            call_id: call_id.into(),
            reason: reason.into(),
        }))
        .await
    }

    async fn send(&self, command: DriverCommand) -> Result<(), AgentCommandError> {
        let (acknowledgement, accepted) = oneshot::channel();
        self.commands
            .send(CommandEnvelope {
                command,
                acknowledgement,
            })
            .await
            .map_err(|_| AgentCommandError::Closed)?;
        accepted.await.map_err(|_| AgentCommandError::Closed)?
    }
}

/// Process-local owner of exactly one worker per activated Agent. Durable
/// exclusion across processes remains the Registry's Lease responsibility.
pub struct AgentSupervisor {
    registry: Arc<AgentRegistry>,
    factory: Arc<dyn TurnRequestFactory>,
    event_capacity: usize,
    handles: tokio::sync::Mutex<std::collections::HashMap<String, DurableAgentHandle>>,
    closed: AtomicBool,
}

impl AgentSupervisor {
    pub fn new(
        registry: Arc<AgentRegistry>,
        factory: Arc<dyn TurnRequestFactory>,
        event_capacity: usize,
    ) -> Self {
        Self {
            registry,
            factory,
            event_capacity,
            handles: tokio::sync::Mutex::new(std::collections::HashMap::new()),
            closed: AtomicBool::new(false),
        }
    }

    pub async fn activate(
        &self,
        header: xharness_session::SessionHeader,
    ) -> Result<DurableAgentHandle, RegistryError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(RegistryError::Unavailable);
        }
        let id = header.id.clone();
        let mut handles = self.handles.lock().await;
        if self.closed.load(Ordering::Acquire) {
            return Err(RegistryError::Unavailable);
        }
        if let Some(handle) = handles.get(&id) {
            return Ok(handle.clone());
        }
        let activation = self.registry.activate(header).await?;
        let handle =
            DurableAgentHandle::start(activation, Arc::clone(&self.factory), self.event_capacity);
        handles.insert(id, handle.clone());
        Ok(handle)
    }

    pub async fn get(&self, agent_id: &str) -> Option<DurableAgentHandle> {
        self.handles.lock().await.get(agent_id).cloned()
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    /// Stop admission, signal every worker together, then await each worker
    /// against one shared deadline. A late worker is explicitly classified as
    /// forced cleanup instead of being silently detached from Host shutdown.
    pub async fn shutdown(&self, grace: Duration) -> AgentShutdownReport {
        self.closed.store(true, Ordering::Release);
        let handles = {
            let mut active = self.handles.lock().await;
            active.drain().map(|(_, handle)| handle).collect::<Vec<_>>()
        };
        for handle in &handles {
            handle.request_shutdown();
        }
        let deadline = tokio::time::Instant::now() + grace;
        let mut report = AgentShutdownReport {
            workers: handles.len(),
            ..AgentShutdownReport::default()
        };
        for handle in handles {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match handle.shutdown(remaining).await {
                AgentShutdownOutcome::Graceful => report.graceful += 1,
                AgentShutdownOutcome::ForcedCleanup => report.forced_cleanup += 1,
            }
        }
        report
    }
}

struct DriverWorker {
    activation: Arc<AgentActivation>,
    factory: Arc<dyn TurnRequestFactory>,
    commands: mpsc::Receiver<CommandEnvelope>,
    events: broadcast::Sender<AgentEvent>,
    status: watch::Sender<AgentStatus>,
    wake_requested: bool,
    recovery_requested: bool,
    shutdown: CancellationToken,
}

impl DriverWorker {
    async fn run(mut self) {
        if let Err(error) = self.activation.inbox().reconcile_consumed().await {
            self.publish_error(error.to_string());
        }
        loop {
            if self.shutdown.is_cancelled() {
                return;
            }
            if self.recovery_requested {
                self.recovery_requested = false;
                if let Err(error) = self.drive_recovery().await {
                    if self.shutdown.is_cancelled() {
                        return;
                    }
                    self.publish_error(error.to_string());
                    return;
                }
                continue;
            }
            let snapshot = match self.activation.inbox().snapshot().await {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    self.publish_error(error.to_string());
                    return;
                }
            };
            if self.wake_requested {
                self.wake_requested = false;
                if !snapshot.next_turn().is_empty() {
                    if let Err(error) = self.drive_pending().await {
                        if self.shutdown.is_cancelled() {
                            return;
                        }
                        self.publish_error(error.to_string());
                        return;
                    }
                }
                continue;
            }
            tokio::select! {
                biased;
                _ = self.shutdown.cancelled() => return,
                envelope = self.commands.recv() => match envelope {
                    Some(envelope) => self.handle_idle(envelope).await,
                    None => return,
                }
            }
        }
    }

    async fn drive_pending(&mut self) -> Result<(), AgentCommandError> {
        self.activation
            .reserve_driver()
            .await
            .map_err(lifecycle_error)?;
        self.set_status(AgentStatus::Running);
        let result = self.drive_pending_inner().await;
        if let Err(error) = self.activation.finish_driver().await {
            self.publish_error(error.to_string());
        }
        self.set_status(AgentStatus::Idle);
        result
    }

    async fn drive_pending_inner(&mut self) -> Result<(), AgentCommandError> {
        loop {
            if self.shutdown.is_cancelled() {
                return Err(AgentCommandError::Closed);
            }
            let claim = self
                .activation
                .inbox()
                .prepare_claim(InboxTarget::NextTurn)
                .await
                .map_err(inbox_error)?;
            if claim.is_empty() {
                return Ok(());
            }
            let (_expected_revision, claimed, deletion_events) = claim.into_loop_parts();
            let input_ids = claimed
                .iter()
                .map(|message| message.id.clone())
                .collect::<Vec<_>>();
            let input = claimed
                .iter()
                .map(|message| message.message.clone())
                .collect::<Vec<_>>();
            let mut request = self
                .factory
                .build(self.activation.id(), input)
                .await
                .map_err(AgentCommandError::Failed)?;
            request.session_id = Some(self.activation.id().to_owned());
            request.journal_store = Some(self.activation.inbox().store());
            request.journal_prelude = deletion_events;

            let turn = self.next_turn().await?;
            self.drive_request(request, turn, input_ids).await?;
            self.activation
                .inbox()
                .reconcile_consumed()
                .await
                .map_err(inbox_error)?;
            let pending = self
                .activation
                .inbox()
                .snapshot()
                .await
                .map_err(inbox_error)?;
            if pending.next_turn().is_empty() && !self.wake_requested {
                return Ok(());
            }
            self.wake_requested = false;
        }
    }

    async fn drive_recovery(&mut self) -> Result<(), AgentCommandError> {
        self.activation
            .reserve_driver()
            .await
            .map_err(lifecycle_error)?;
        self.set_status(AgentStatus::Running);
        let result = self.drive_recovery_inner().await;
        if let Err(error) = self.activation.finish_driver().await {
            self.publish_error(error.to_string());
        }
        self.set_status(AgentStatus::Idle);
        result
    }

    async fn drive_recovery_inner(&mut self) -> Result<(), AgentCommandError> {
        if self.shutdown.is_cancelled() {
            return Err(AgentCommandError::Closed);
        }
        let session = self
            .activation
            .inbox()
            .store()
            .load(self.activation.id())
            .await
            .map_err(|error| AgentCommandError::Failed(error.to_string()))?
            .ok_or_else(|| AgentCommandError::Failed("agent session disappeared".to_owned()))?;
        let approvals = session.pending_tool_approvals();
        let questions = session.recoverable_user_questions();
        let coordinates = approvals
            .first()
            .map(|approval| (approval.turn, approval.step))
            .or_else(|| {
                questions
                    .first()
                    .map(|question| (question.turn, question.step))
            })
            .ok_or_else(|| {
                AgentCommandError::Failed(
                    "agent has no durable human interaction to recover".to_owned(),
                )
            })?;
        if approvals
            .iter()
            .any(|approval| (approval.turn, approval.step) != coordinates)
            || questions
                .iter()
                .any(|question| (question.turn, question.step) != coordinates)
        {
            return Err(AgentCommandError::Failed(
                "recoverable interactions span more than one open tool batch".to_owned(),
            ));
        }
        let work_id = approvals
            .first()
            .map(|approval| approval_recovery_work_id(&approval.id))
            .or_else(|| {
                questions
                    .first()
                    .map(|question| question_recovery_work_id(&question.invocation.interaction_id))
            })
            .expect("one recoverable interaction exists");
        let mut request = self
            .factory
            .build(self.activation.id(), Vec::new())
            .await
            .map_err(AgentCommandError::Failed)?;
        request.session_id = Some(self.activation.id().to_owned());
        request.journal_store = Some(self.activation.inbox().store());
        self.drive_request(request, coordinates.0, vec![work_id])
            .await
    }

    async fn drive_request(
        &mut self,
        request: LoopRequest,
        turn: u32,
        input_ids: Vec<String>,
    ) -> Result<(), AgentCommandError> {
        let _ = self
            .events
            .send(AgentEvent::TurnStarted { turn, input_ids });
        let mut run = LoopEngine.start(request);
        loop {
            tokio::select! {
                biased;
                _ = self.shutdown.cancelled() => {
                    let _ = run.send(LoopCommand::Cancel).await;
                    while let Some(event) = run.next().await {
                        let _ = self.events.send(AgentEvent::TurnEvent { turn, event });
                    }
                    let result = run.result().await;
                    let _ = self.events.send(AgentEvent::TurnFinished { turn, result });
                    return Err(AgentCommandError::Closed);
                }
                event = run.next() => match event {
                    Some(event) => { let _ = self.events.send(AgentEvent::TurnEvent { turn, event }); }
                    None => break,
                },
                command = self.commands.recv() => match command {
                    Some(command) => self.handle_active(command, &run).await,
                    None => {
                        let _ = run.send(LoopCommand::Cancel).await;
                        while let Some(event) = run.next().await {
                            let _ = self.events.send(AgentEvent::TurnEvent { turn, event });
                        }
                        let result = run.result().await;
                        let _ = self.events.send(AgentEvent::TurnFinished { turn, result });
                        return Err(AgentCommandError::Closed);
                    }
                }
            }
        }
        let result = run.result().await;
        let _ = self.events.send(AgentEvent::TurnFinished { turn, result });
        Ok(())
    }

    async fn next_turn(&self) -> Result<u32, AgentCommandError> {
        let session = self
            .activation
            .inbox()
            .store()
            .load(self.activation.id())
            .await
            .map_err(|error| AgentCommandError::Failed(error.to_string()))?
            .ok_or_else(|| AgentCommandError::Failed("agent session disappeared".to_owned()))?;
        session
            .events()
            .iter()
            .rev()
            .find_map(|event| match event.data() {
                xharness_session::EventData::TurnStart { turn } => Some(*turn),
                _ => None,
            })
            .unwrap_or_default()
            .checked_add(1)
            .ok_or_else(|| AgentCommandError::Failed("turn counter overflow".to_owned()))
    }

    async fn handle_idle(&mut self, envelope: CommandEnvelope) {
        let result = match envelope.command {
            DriverCommand::Wake => {
                self.wake_requested = true;
                Ok(())
            }
            DriverCommand::RecoverOpenTurn => {
                self.recovery_requested = true;
                self.set_status(AgentStatus::Running);
                Ok(())
            }
            DriverCommand::Followup(message) => {
                let result = self.persist(InboxTarget::NextTurn, message).await;
                if result.is_ok() {
                    self.wake_requested = true;
                    self.set_status(AgentStatus::Running);
                }
                result
            }
            DriverCommand::Steer(message) => {
                let result = self.persist(InboxTarget::NextStep, message).await;
                if result.is_ok() {
                    self.wake_requested = true;
                    self.set_status(AgentStatus::Running);
                }
                result
            }
            DriverCommand::Inject(message) => self.persist(InboxTarget::NextStep, message).await,
            DriverCommand::Control(_) => Err(AgentCommandError::NoActiveTurn),
        };
        let _ = envelope.acknowledgement.send(result);
    }

    async fn handle_active(&mut self, envelope: CommandEnvelope, run: &xharness_core::LoopRun) {
        let result = match envelope.command {
            DriverCommand::Wake => {
                self.wake_requested = true;
                Ok(())
            }
            DriverCommand::RecoverOpenTurn => Err(AgentCommandError::Failed(
                "an Agent turn is already running".to_owned(),
            )),
            DriverCommand::Followup(message) => {
                let result = self.persist(InboxTarget::NextTurn, message).await;
                if result.is_ok() {
                    self.wake_requested = true;
                }
                result
            }
            DriverCommand::Steer(message) => {
                match self.persist(InboxTarget::NextStep, message.clone()).await {
                    Ok(()) => {
                        self.wake_requested = true;
                        map_loop_control(run.send(LoopCommand::Steer(message.message)).await, true)
                    }
                    Err(error) => Err(error),
                }
            }
            DriverCommand::Inject(message) => {
                match self.persist(InboxTarget::NextStep, message.clone()).await {
                    Ok(()) => map_loop_control(
                        run.send(LoopCommand::InjectMessage {
                            message: message.message,
                            mode: InjectionMode::NextStep,
                        })
                        .await,
                        true,
                    ),
                    Err(error) => Err(error),
                }
            }
            DriverCommand::Control(command) => map_loop_control(run.send(command).await, false),
        };
        let _ = envelope.acknowledgement.send(result);
    }

    async fn persist(
        &self,
        target: InboxTarget,
        message: InboxMessage,
    ) -> Result<(), AgentCommandError> {
        self.activation
            .inbox()
            .append(target, message.clone())
            .await
            .map_err(inbox_error)?;
        let _ = self
            .events
            .send(AgentEvent::InboxInserted { target, message });
        Ok(())
    }

    fn set_status(&self, status: AgentStatus) {
        self.status.send_replace(status);
        let _ = self.events.send(AgentEvent::Status(status));
    }

    fn publish_error(&self, message: String) {
        let _ = self.events.send(AgentEvent::Error { message });
    }
}

fn map_loop_control(
    result: Result<(), LoopControlError>,
    queued_on_close: bool,
) -> Result<(), AgentCommandError> {
    match result {
        Ok(()) => Ok(()),
        Err(LoopControlError::Closed) if queued_on_close => Ok(()),
        Err(error) => Err(AgentCommandError::Failed(error.to_string())),
    }
}

fn inbox_error(error: InboxError) -> AgentCommandError {
    AgentCommandError::Failed(error.to_string())
}

fn lifecycle_error(error: LifecycleError) -> AgentCommandError {
    AgentCommandError::Failed(error.to_string())
}

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use async_trait::async_trait;
use futures::StreamExt;
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;
use xharness_core::{
    AgentMessage, InjectionMode, LoopCommand, LoopControlError, LoopEngine, LoopEvent, LoopRequest,
    LoopResult,
};
use xharness_session::{EventData, InboxMessage, InboxTarget};

use crate::{
    AgentActivation, AgentRegistry, AgentStatus, DurableInbox, InboxError, LifecycleError,
    RegistryError,
};

/// Deployment-owned construction of one turn's Provider, tools, context and
/// limits. The durable driver overwrites Session journal fields after return.
#[async_trait]
pub trait TurnRequestFactory: Send + Sync + 'static {
    /// Optional shared capacity lease. Held for the complete turn and released on every exit.
    async fn acquire(
        &self,
        _agent_id: &str,
    ) -> Result<Option<tokio::sync::OwnedSemaphorePermit>, String> {
        Ok(None)
    }
    async fn goal_dependencies(&self, _agent_id: &str) -> Result<bool, String> {
        Ok(false)
    }
    async fn goal_changed(&self, _agent_id: &str) {}
    async fn prepare_goal_turn(
        &self,
        _agent_id: &str,
        _input_id: &str,
        _events: broadcast::Receiver<AgentEvent>,
    ) -> Result<(), String> {
        Ok(())
    }
    async fn build(&self, agent_id: &str, input: Vec<AgentMessage>) -> Result<LoopRequest, String>;
    /// Optional host-owned report adapter. Default does not infer completion from prose.
    async fn goal_report(
        &self,
        _agent_id: &str,
        _result: &LoopResult,
    ) -> Result<Option<crate::GoalReportBody>, String> {
        Ok(None)
    }
}

/// Long-lived events. Loop event sequence numbers remain scoped to one turn;
/// subscribers use the durable Session sequence for restart replay.
#[derive(Clone, Debug, PartialEq)]
pub enum AgentEvent {
    /// Pending input was parked without opening a model turn or claiming side effects.
    Parked {
        input_ids: Vec<String>,
    },
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
    #[error("agent worker is temporarily unavailable")]
    Unavailable,
    #[error("agent command is unavailable while no turn is running")]
    NoActiveTurn,
    #[error("agent is busy with another activity")]
    Busy,
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
    /// Admit a maintenance-generated followup only at an idle actor boundary.
    /// Unlike checking [`DurableAgentHandle::status`] before `followup`, this
    /// cannot race a user turn between observation and durable insertion.
    MaintenanceFollowup(InboxMessage),
    Steer(InboxMessage),
    Inject(InboxMessage),
    Control(LoopCommand),
}

struct CommandEnvelope {
    command: DriverCommand,
    acknowledgement: oneshot::Sender<Result<(), AgentCommandError>>,
}

/// Minimum spacing between failed worker generations. Recovery does not depend
/// on a new command; persistent startup failures back off up to 30 seconds.
pub(crate) const WORKER_RESPAWN_BACKOFF: Duration = Duration::from_millis(250);
const WORKER_MAX_BACKOFF: Duration = Duration::from_secs(30);

/// Task availability is distinct from the legacy idle/running activity status.
/// Only the per-agent supervisor publishes this lifecycle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkerAvailability {
    Starting,
    Ready,
    Unavailable,
    Closed,
}

#[derive(Clone)]
enum WorkerState {
    Starting,
    Ready {
        generation: u64,
        commands: mpsc::Sender<CommandEnvelope>,
        status: watch::Receiver<AgentStatus>,
    },
    Unavailable,
    Closed,
}

/// Owns JoinHandles, fences generations and settles death before replacement.
/// It owns no DurableAgentHandle (nor receiver of `state`), avoiding a retention
/// cycle. Dropping the last handle closes `state` and reaps the worker.
struct WorkerSupervisor {
    activation: Arc<AgentActivation>,
    factory: Arc<dyn TurnRequestFactory>,
    events: broadcast::Sender<AgentEvent>,
    state: watch::Sender<WorkerState>,
    shutdown: CancellationToken,
    force: CancellationToken,
    finished: CancellationToken,
}

impl WorkerSupervisor {
    async fn run(self) {
        let mut backoff = WORKER_RESPAWN_BACKOFF;
        let mut generation = 0u64;
        loop {
            if self.shutdown.is_cancelled() || self.state.is_closed() {
                break;
            }
            let Some(next_generation) = generation.checked_add(1) else {
                break;
            };
            generation = next_generation;
            self.state.send_replace(WorkerState::Starting);
            let (commands, command_rx) = mpsc::channel(64);
            let (status_tx, status) = watch::channel(AgentStatus::Idle);
            let (ready_tx, mut ready_rx) = oneshot::channel();
            let worker = DriverWorker {
                activation: Arc::clone(&self.activation),
                factory: Arc::clone(&self.factory),
                commands: command_rx,
                events: self.events.clone(),
                status: status_tx,
                wake_requested: false,
                recovery_requested: false,
                shutdown: self.shutdown.clone(),
            };
            let started = Instant::now();
            let mut task = tokio::spawn(worker.run(ready_tx));
            let mut ready = false;
            let result = loop {
                tokio::select! {
                    biased;
                    result = &mut task => break result,
                    _ = self.force.cancelled() => {
                        task.abort();
                        break task.await;
                    }
                    _ = self.state.closed() => {
                        self.shutdown.cancel();
                        task.abort();
                        break task.await;
                    }
                    outcome = &mut ready_rx, if !ready => {
                        // A failed startup is handled by joining the task, never
                        // advertised as Idle/ready to process commands.
                        ready = true;
                        if outcome.is_ok() && !self.shutdown.is_cancelled() {
                            self.state.send_replace(WorkerState::Ready {
                                generation,
                                commands: commands.clone(),
                                status: status.clone(),
                            });
                        }
                    }
                }
            };
            // Join has settled the predecessor, including Drop of LoopRun and
            // its cancellation guard. No predecessor can publish into a new
            // generation's private status channel or retain its reservation.
            self.activation.release_stale_driver().await;
            self.state.send_replace(WorkerState::Unavailable);
            if self.shutdown.is_cancelled() || self.state.is_closed() {
                break;
            }
            if let Err(error) = result {
                let _ = self.events.send(AgentEvent::Error {
                    message: format!("agent worker stopped unexpectedly: {error}"),
                });
            }
            if started.elapsed() >= WORKER_MAX_BACKOFF {
                backoff = WORKER_RESPAWN_BACKOFF;
            }
            tokio::select! {
                biased;
                _ = self.shutdown.cancelled() => break,
                _ = self.state.closed() => break,
                _ = tokio::time::sleep(backoff) => {}
            }
            backoff = (backoff * 2).min(WORKER_MAX_BACKOFF);
            // Rebuild only the worker. Do NOT replay an unacknowledged command,
            // Wake, tool call or unknown-outcome operation on its behalf.
        }
        self.state.send_replace(WorkerState::Closed);
        self.finished.cancel();
    }
}

/// Stable identity and subscriptions over replaceable worker generations.
#[derive(Clone)]
pub struct DurableAgentHandle {
    activation: Arc<AgentActivation>,
    events: broadcast::Sender<AgentEvent>,
    worker: watch::Receiver<WorkerState>,
    shutdown: CancellationToken,
    force: CancellationToken,
    finished: CancellationToken,
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
        let (events, _) = broadcast::channel(event_capacity.max(16));
        let (state, worker) = watch::channel(WorkerState::Starting);
        let shutdown = activation.cancellation();
        let force = CancellationToken::new();
        let finished = CancellationToken::new();
        tokio::spawn(
            WorkerSupervisor {
                activation: Arc::clone(&activation),
                factory,
                events: events.clone(),
                state,
                shutdown: shutdown.clone(),
                force: force.clone(),
                finished: finished.clone(),
            }
            .run(),
        );
        Self {
            activation,
            events,
            worker,
            shutdown,
            force,
            finished,
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

    /// Activity only; use `availability`/`when_ready` before assuming a worker
    /// exists. An unavailable worker is not an idle worker for admission.
    pub fn status(&self) -> AgentStatus {
        match &*self.worker.borrow() {
            WorkerState::Ready { status, .. } => *status.borrow(),
            _ => AgentStatus::Idle,
        }
    }

    pub fn availability(&self) -> WorkerAvailability {
        match &*self.worker.borrow() {
            WorkerState::Starting => WorkerAvailability::Starting,
            WorkerState::Ready { .. } => WorkerAvailability::Ready,
            WorkerState::Unavailable => WorkerAvailability::Unavailable,
            WorkerState::Closed => WorkerAvailability::Closed,
        }
    }

    pub fn is_same_worker(&self, other: &Self) -> bool {
        self.worker.same_channel(&other.worker)
    }

    /// A failed generation is reaped; recovery is owned by the supervisor, not
    /// by whichever caller happens to issue the next command.
    pub fn is_stopped(&self) -> bool {
        matches!(
            self.availability(),
            WorkerAvailability::Unavailable | WorkerAvailability::Closed
        )
    }

    pub async fn when_idle(&self) -> Result<(), AgentCommandError> {
        let mut worker = self.worker.clone();
        loop {
            if self.shutdown.is_cancelled() {
                return Err(AgentCommandError::Closed);
            }
            let snapshot = worker.borrow_and_update().clone();
            match snapshot {
                WorkerState::Unavailable => return Err(AgentCommandError::Unavailable),
                WorkerState::Closed => return Err(AgentCommandError::Closed),
                WorkerState::Starting => {
                    tokio::select! {
                        _ = self.shutdown.cancelled() => return Err(AgentCommandError::Closed),
                        result = worker.changed() => result.map_err(|_| AgentCommandError::Closed)?,
                    }
                }
                WorkerState::Ready { mut status, .. } => {
                    if *status.borrow_and_update() == AgentStatus::Idle {
                        return Ok(());
                    }
                    tokio::select! {
                        _ = self.shutdown.cancelled() => return Err(AgentCommandError::Closed),
                        result = worker.changed() => result.map_err(|_| AgentCommandError::Closed)?,
                        // Closure means join/cleanup is in progress. Wait for
                        // the supervisor, rather than spin on a closed channel.
                        result = status.changed() => {
                            if result.is_err() {
                                tokio::select! {
                                    _ = self.shutdown.cancelled() => return Err(AgentCommandError::Closed),
                                    result = worker.changed() => result.map_err(|_| AgentCommandError::Closed)?,
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    pub async fn when_ready(&self) -> Result<(), AgentCommandError> {
        self.worker_commands(true).await.map(|_| ())
    }

    pub fn request_shutdown(&self) {
        self.shutdown.cancel();
    }

    pub async fn when_stopped(&self) {
        let mut worker = self.worker.clone();
        let mut observed_generation = None;
        loop {
            match &*worker.borrow_and_update() {
                WorkerState::Unavailable | WorkerState::Closed => return,
                WorkerState::Ready { generation, .. } => {
                    if observed_generation.is_some_and(|old| old != *generation) {
                        return;
                    }
                    observed_generation = Some(*generation);
                }
                WorkerState::Starting => {}
            }
            if worker.changed().await.is_err() {
                return;
            }
        }
    }

    pub async fn shutdown(&self, grace: Duration) -> AgentShutdownOutcome {
        self.request_shutdown();
        // Wait for the supervisor itself, not a transient unavailable state.
        if tokio::time::timeout(grace, self.finished.cancelled())
            .await
            .is_ok()
        {
            return AgentShutdownOutcome::Graceful;
        }
        self.force.cancel();
        self.finished.cancelled().await;
        AgentShutdownOutcome::ForcedCleanup
    }

    pub async fn followup(&self, message: InboxMessage) -> Result<(), AgentCommandError> {
        self.send(DriverCommand::Followup(message)).await
    }

    /// Append and wake one maintenance followup iff the actor is idle when it
    /// handles this command. Callers may wait for [`Self::when_idle`] and retry
    /// after [`AgentCommandError::Busy`].
    pub async fn maintenance_followup(
        &self,
        message: InboxMessage,
    ) -> Result<(), AgentCommandError> {
        self.send(DriverCommand::MaintenanceFollowup(message)).await
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

    pub async fn interrupt_by_user(&self) -> Result<(), AgentCommandError> {
        self.send(DriverCommand::Control(LoopCommand::InterruptByUser))
            .await
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

    /// Wait out supervised recovery without owning a generation lock or
    /// replaying commands. Shutdown always wins over admission.
    async fn worker_commands(
        &self,
        wait_for_recovery: bool,
    ) -> Result<mpsc::Sender<CommandEnvelope>, AgentCommandError> {
        let mut worker = self.worker.clone();
        loop {
            if self.shutdown.is_cancelled() {
                return Err(AgentCommandError::Closed);
            }
            if let WorkerState::Ready { commands, .. } = &*worker.borrow_and_update() {
                if !commands.is_closed() {
                    return Ok(commands.clone());
                }
            }
            if matches!(*worker.borrow(), WorkerState::Closed) {
                return Err(AgentCommandError::Closed);
            }
            if !wait_for_recovery && matches!(*worker.borrow(), WorkerState::Unavailable) {
                return Err(AgentCommandError::Unavailable);
            }
            tokio::select! {
                _ = self.shutdown.cancelled() => return Err(AgentCommandError::Closed),
                result = worker.changed() => result.map_err(|_| AgentCommandError::Closed)?,
            }
        }
    }

    async fn send(&self, command: DriverCommand) -> Result<(), AgentCommandError> {
        let (acknowledgement, accepted) = oneshot::channel();
        let envelope = CommandEnvelope {
            command,
            acknowledgement,
        };
        let commands = self.worker_commands(false).await?;
        tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => return Err(AgentCommandError::Closed),
            result = commands.send(envelope) => result.map_err(|_| AgentCommandError::Closed)?,
        }
        tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => Err(AgentCommandError::Closed),
            result = accepted => result.map_err(|_| AgentCommandError::Closed)?,
        }
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
    fn goal_controller(&self) -> crate::GoalController {
        crate::GoalController::new(self.activation.inbox().store(), self.activation.id())
    }

    async fn run(mut self, ready: oneshot::Sender<()>) {
        if let Err(error) = self.activation.inbox().reconcile_consumed().await {
            self.publish_error(error.to_string());
            return;
        }
        let _ = ready.send(());
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
                }
                continue;
            }
            if self.wake_requested {
                self.wake_requested = false;
                let snapshot = match self.activation.inbox().snapshot().await {
                    Ok(snapshot) => snapshot,
                    Err(error) => {
                        self.publish_error(error.to_string());
                        self.set_status(AgentStatus::Idle);
                        continue;
                    }
                };
                if !snapshot.next_turn().is_empty()
                    || self
                        .goal_controller()
                        .state()
                        .await
                        .ok()
                        .flatten()
                        .is_some_and(|s| {
                            s.definition.execution_enabled
                                && s.definition.snapshot.phase
                                    == xharness_session::GoalPhase::Active
                        })
                {
                    if let Err(error) = self.drive_pending().await {
                        if self.shutdown.is_cancelled() {
                            return;
                        }
                        self.publish_error(error.to_string());
                    }
                } else {
                    self.set_status(AgentStatus::Idle);
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
        if let Err(failure) = &result {
            if let Err(error) = self
                .goal_controller()
                .pause_error(&failure.to_string())
                .await
            {
                self.publish_error(error.to_string());
            }
            if let Err(error) = self.goal_controller().reconcile().await {
                self.publish_error(error.to_string());
            }
            self.factory.goal_changed(self.activation.id()).await;
        }
        if let Err(error) = self.activation.finish_driver().await {
            self.publish_error(error.to_string());
        }
        self.set_status(AgentStatus::Idle);
        result
    }

    async fn drive_pending_inner(&mut self) -> Result<(), AgentCommandError> {
        let mut admission_retries = 0u32;
        loop {
            if self.shutdown.is_cancelled() {
                return Err(AgentCommandError::Closed);
            }
            let stored = self
                .activation
                .inbox()
                .store()
                .load(self.activation.id())
                .await
                .map_err(|e| AgentCommandError::Failed(e.to_string()))?;
            if stored.as_ref().is_some_and(|session| {
                session
                    .events()
                    .iter()
                    .rev()
                    .find_map(|e| match e.data() {
                        EventData::AgentDispatchPaused { paused } => Some(*paused),
                        _ => None,
                    })
                    .unwrap_or(false)
            }) {
                self.park_pending().await?;
                return Ok(());
            }
            // Goal dependency failures belong to automatic Goal work, never to
            // the user's inbox. Inactive Goals must not resolve stale Job refs.
            let goal_active = stored
                .as_ref()
                .and_then(xharness_session::goal::execution_state)
                .is_some_and(|s| {
                    s.definition.execution_enabled
                        && s.definition.snapshot.phase == xharness_session::GoalPhase::Active
                });
            let dependencies = if goal_active {
                match self.factory.goal_dependencies(self.activation.id()).await {
                    Ok(pending) => pending,
                    Err(message) => {
                        // Persist the pause and invalidate automatic input before
                        // continuing to claim ordinary input. Persistence errors
                        // still fail closed; a failed dependency is NOT success.
                        self.goal_controller()
                            .pause_error(&message)
                            .await
                            .map_err(|e| AgentCommandError::Failed(e.to_string()))?;
                        self.factory.goal_changed(self.activation.id()).await;
                        false
                    }
                }
            } else {
                false
            };
            match self
                .goal_controller()
                .reconcile_with_dependencies(dependencies)
                .await
            {
                Ok(_) => {}
                Err(crate::GoalError::Store(xharness_session::StoreError::RevisionConflict {
                    ..
                })) => {
                    admission_retries += 1;
                    if admission_retries >= 16 {
                        return Err(AgentCommandError::Failed(
                            "goal reconcile stayed contended".into(),
                        ));
                    }
                    continue;
                }
                Err(e) => return Err(AgentCommandError::Failed(e.to_string())),
            }
            self.factory.goal_changed(self.activation.id()).await;
            let factory = self.factory.clone();
            let id = self.activation.id().to_owned();
            let acquire = factory.acquire(&id);
            tokio::pin!(acquire);
            let _permit = loop {
                tokio::select! {
                    biased;
                    _ = self.shutdown.cancelled() => return Err(AgentCommandError::Closed),
                    Some(envelope) = self.commands.recv() => {
                        if matches!(envelope.command, DriverCommand::Control(LoopCommand::Cancel | LoopCommand::InterruptByUser)) {
                            self.park_pending().await?;
                            let _ = envelope.acknowledgement.send(Ok(()));
                            return Ok(());
                        }
                        self.handle_idle(envelope).await;
                    }
                    permit = &mut acquire => break permit.map_err(AgentCommandError::Failed)?,
                }
            };
            let claim = self
                .activation
                .inbox()
                .prepare_claim(InboxTarget::NextTurn)
                .await
                .map_err(inbox_error)?;
            if claim.is_empty() {
                return Ok(());
            }
            let (expected_revision, claimed, mut deletion_events) = claim.into_loop_parts();
            for message in &claimed {
                if crate::goal::is_goal_message(message) {
                    self.factory
                        .prepare_goal_turn(
                            self.activation.id(),
                            &message.id,
                            self.events.subscribe(),
                        )
                        .await
                        .map_err(AgentCommandError::Failed)?;
                }
            }
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
            let cut = self
                .activation
                .inbox()
                .store()
                .load(self.activation.id())
                .await
                .map_err(|e| AgentCommandError::Failed(e.to_string()))?
                .ok_or_else(|| AgentCommandError::Failed("session missing".into()))?;
            if cut.revision() != expected_revision {
                // A Goal control may have removed this prepared input before TurnStart.
                // Settle its Host event receiver instead of leaving a phantom running turn.
                let current_goal = xharness_session::goal::execution_state(&cut);
                let parked = claimed
                    .iter()
                    .filter(|m| {
                        crate::is_goal_message(m)
                            && !current_goal.as_ref().is_some_and(|s| {
                                s.definition.execution_enabled
                                    && s.pending.as_ref().is_some_and(|p| p.message_id == m.id)
                            })
                    })
                    .map(|m| m.id.clone())
                    .collect::<Vec<_>>();
                if !parked.is_empty() {
                    let _ = self.events.send(AgentEvent::Parked { input_ids: parked });
                }
                admission_retries += 1;
                if admission_retries >= 16 {
                    return Err(AgentCommandError::Failed("claim stayed contended".into()));
                }
                continue;
            }
            let turn = self.next_turn().await?;
            let goal_events = crate::GoalController::claim_events(&cut, &claimed, turn)
                .map_err(|e| AgentCommandError::Failed(e.to_string()))?;
            if !goal_events.is_empty() {
                request.journal_expected_revision = Some(expected_revision);
            }
            deletion_events.extend(goal_events);
            request.session_id = Some(self.activation.id().to_owned());
            request.journal_store = Some(self.activation.inbox().store());
            request.journal_prelude = deletion_events;

            self.drive_request(request, turn, input_ids).await?;
            let after = self
                .activation
                .inbox()
                .store()
                .load(self.activation.id())
                .await
                .map_err(|e| AgentCommandError::Failed(e.to_string()))?
                .ok_or_else(|| AgentCommandError::Failed("session missing".into()))?;
            if !after
                .events()
                .iter()
                .any(|e| matches!(e.data(), EventData::TurnStart { turn: t } if *t == turn))
            {
                admission_retries += 1;
                if admission_retries >= 16 {
                    self.goal_controller()
                        .pause()
                        .await
                        .map_err(|e| AgentCommandError::Failed(e.to_string()))?;
                    return Err(AgentCommandError::Failed(
                        "goal admission failed repeatedly; paused".into(),
                    ));
                }
                continue;
            }
            admission_retries = 0;

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
            let continue_goal = self
                .goal_controller()
                .state()
                .await
                .map_err(|e| AgentCommandError::Failed(e.to_string()))?
                .is_some_and(|s| {
                    s.definition.execution_enabled
                        && s.definition.snapshot.phase == xharness_session::GoalPhase::Active
                });
            if pending.next_turn().is_empty() && !self.wake_requested && !continue_goal {
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
        if self
            .goal_controller()
            .state()
            .await
            .map_err(|e| AgentCommandError::Failed(e.to_string()))?
            .is_some_and(|s| s.running.as_ref().is_some_and(|r| r.turn == turn))
        {
            let body = match self
                .factory
                .goal_report(self.activation.id(), &result)
                .await
            {
                Ok(body) => body,
                Err(e) => {
                    self.publish_error(format!("goal report rejected: {e}"));
                    None
                }
            };
            if let Err(e) = self.goal_controller().settle(body).await {
                self.publish_error(e.to_string());
                self.goal_controller()
                    .settle(None)
                    .await
                    .map_err(|e| AgentCommandError::Failed(e.to_string()))?;
            }
        }
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

    async fn park_pending(&mut self) -> Result<(), AgentCommandError> {
        self.goal_controller()
            .pause()
            .await
            .map_err(|e| AgentCommandError::Failed(e.to_string()))?;
        self.goal_controller()
            .reconcile()
            .await
            .map_err(|e| AgentCommandError::Failed(e.to_string()))?;
        self.wake_requested = false;
        let pending = self
            .activation
            .inbox()
            .snapshot()
            .await
            .map_err(inbox_error)?;
        let _ = self.events.send(AgentEvent::Parked {
            input_ids: pending.next_turn().iter().map(|m| m.id.clone()).collect(),
        });
        Ok(())
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
            DriverCommand::MaintenanceFollowup(message) => {
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
            DriverCommand::Control(LoopCommand::Cancel | LoopCommand::InterruptByUser) => {
                self.park_pending().await
            }
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
            DriverCommand::MaintenanceFollowup(_) => Err(AgentCommandError::Busy),
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
            DriverCommand::Control(command) => {
                if matches!(command, LoopCommand::Cancel | LoopCommand::InterruptByUser) {
                    if let Err(e) = self.goal_controller().pause().await {
                        let _ = envelope
                            .acknowledgement
                            .send(Err(AgentCommandError::Failed(e.to_string())));
                        return;
                    }
                }
                map_loop_control(run.send(command).await, false)
            }
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

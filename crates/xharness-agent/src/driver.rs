use std::sync::Arc;

use async_trait::async_trait;
use futures::StreamExt;
use tokio::sync::{broadcast, mpsc, oneshot, watch};
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

enum DriverCommand {
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
}

impl DurableAgentHandle {
    /// Start one worker. Pending durable input found during resume wakes it
    /// immediately; otherwise it sleeps without holding a model/tool task.
    pub fn start(
        activation: Arc<AgentActivation>,
        factory: Arc<dyn TurnRequestFactory>,
        event_capacity: usize,
    ) -> Self {
        let (commands, command_rx) = mpsc::channel(64);
        let (events, _) = broadcast::channel(event_capacity.max(16));
        let (status_tx, status) = watch::channel(AgentStatus::Idle);
        let worker = DriverWorker {
            activation: Arc::clone(&activation),
            factory,
            commands: command_rx,
            events: events.clone(),
            status: status_tx,
            wake_requested: false,
        };
        tokio::spawn(worker.run());
        Self {
            activation,
            commands,
            events,
            status,
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

    pub async fn followup(&self, message: InboxMessage) -> Result<(), AgentCommandError> {
        self.send(DriverCommand::Followup(message)).await
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
        }
    }

    pub async fn activate(
        &self,
        header: xharness_session::SessionHeader,
    ) -> Result<DurableAgentHandle, RegistryError> {
        let id = header.id.clone();
        let mut handles = self.handles.lock().await;
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
}

struct DriverWorker {
    activation: Arc<AgentActivation>,
    factory: Arc<dyn TurnRequestFactory>,
    commands: mpsc::Receiver<CommandEnvelope>,
    events: broadcast::Sender<AgentEvent>,
    status: watch::Sender<AgentStatus>,
    wake_requested: bool,
}

impl DriverWorker {
    async fn run(mut self) {
        if let Err(error) = self.activation.inbox().reconcile_consumed().await {
            self.publish_error(error.to_string());
        }
        loop {
            let snapshot = match self.activation.inbox().snapshot().await {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    self.publish_error(error.to_string());
                    return;
                }
            };
            if !snapshot.next_turn().is_empty() || self.wake_requested {
                self.wake_requested = false;
                if let Err(error) = self.drive_pending().await {
                    self.publish_error(error.to_string());
                    return;
                }
                continue;
            }
            let Some(envelope) = self.commands.recv().await else {
                return;
            };
            self.handle_idle(envelope).await;
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
            let _ = self
                .events
                .send(AgentEvent::TurnStarted { turn, input_ids });
            let mut run = LoopEngine.start(request);
            loop {
                tokio::select! {
                    event = run.next() => match event {
                        Some(event) => { let _ = self.events.send(AgentEvent::TurnEvent { turn, event }); }
                        None => break,
                    },
                    command = self.commands.recv() => match command {
                        Some(command) => self.handle_active(command, &run).await,
                        None => {
                            let _ = run.send(LoopCommand::Cancel).await;
                            while run.next().await.is_some() {}
                            let _ = run.result().await;
                            return Err(AgentCommandError::Closed);
                        }
                    }
                }
            }
            let result = run.result().await;
            let _ = self.events.send(AgentEvent::TurnFinished {
                turn,
                result: result.clone(),
            });
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

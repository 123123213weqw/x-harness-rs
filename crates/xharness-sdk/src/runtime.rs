use std::{num::NonZeroUsize, sync::Arc, time::Duration};

use crate::{context::*, execution::*, models::*, storage::*, tools::*};
use xharness_host::{AgentRuntime, DurableLoopAgentRuntime, RunningTurn};

/// SDK setup failures retain the underlying native error rather than inventing
/// successful receipts for unsupported or failed execution.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Models(#[from] ModelRegistryError),
    #[error("runtime execution gate installation failed: {message}")]
    ExecutionGate { message: String },
    #[error(transparent)]
    Runtime(#[from] AgentRuntimeError),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// Explicit native composition. Building never creates a session, starts a
/// provider, restores old work, installs a source, or opens a network listener.
pub struct RuntimeBuilder {
    route: ModelRoute,
    models: ModelRegistry,
    tools: Arc<dyn SessionToolFactory>,
    store: Arc<dyn Store>,
    leases: Arc<dyn LeaseManager>,
    context: Arc<dyn ContextPolicy>,
    event_capacity: usize,
    gate: Option<Arc<dyn ExecutionGate>>,
    compaction: Option<CompactionConfig>,
}

impl RuntimeBuilder {
    pub fn new(
        route: ModelRoute,
        models: ModelRegistry,
        tools: Arc<dyn SessionToolFactory>,
        store: Arc<dyn Store>,
        leases: Arc<dyn LeaseManager>,
    ) -> Self {
        Self {
            route,
            models,
            tools,
            store,
            leases,
            context: Arc::new(IdentityContextPolicy),
            event_capacity: 256,
            gate: None,
            compaction: None,
        }
    }

    /// The native event buffer is bounded; zero is unrepresentable.
    pub fn event_capacity(mut self, capacity: NonZeroUsize) -> Self {
        self.event_capacity = capacity.get();
        self
    }

    pub fn context_policy(mut self, context: Arc<dyn ContextPolicy>) -> Self {
        self.context = context;
        self
    }

    /// The native runtime evaluates this shared gate at its execution boundary.
    pub fn execution_gate(mut self, gate: Arc<dyn ExecutionGate>) -> Self {
        self.gate = Some(gate);
        self
    }

    pub fn compaction(mut self, compaction: CompactionConfig) -> Self {
        self.compaction = Some(compaction);
        self
    }

    pub fn build(self) -> Result<Runtime, Error> {
        // The SDK requires an explicitly configured usable model, unlike the
        // legacy host's intentionally unconfigured setup mode.
        if !self.models.can_route(&self.route) {
            return Err(ModelRegistryError::DefaultRouteUnavailable {
                provider: self.route.provider,
                model: self.route.model,
            }
            .into());
        }
        let mut native = DurableLoopAgentRuntime::from_registry(
            self.route,
            self.models,
            self.tools,
            self.context,
            self.store.clone(),
            self.leases,
            self.event_capacity,
        )?
        .with_compaction(self.compaction);
        if let Some(gate) = self.gate {
            native = native
                .with_execution_gate(gate)
                .map_err(|message| Error::ExecutionGate { message })?;
        }
        Ok(Runtime {
            native,
            store: self.store,
        })
    }
}

/// Owner of one existing durable runtime. It has no independent queue or chat
/// history. Shutdown consumes the SDK owner; embedding code must settle/drop its
/// turn observers and inspect the native shutdown report before replacing it.
pub struct Runtime {
    native: DurableLoopAgentRuntime,
    store: Arc<dyn Store>,
}

impl Runtime {
    /// Create an empty journal only. This does not activate a session or model.
    pub async fn create_session(&self, header: SessionHeader) -> Result<Session, Error> {
        Ok(self.store.create(header).await?)
    }

    /// Authoritative native snapshot, not a second SDK conversation projection.
    pub async fn session(&self, id: &str) -> Result<Option<Session>, Error> {
        Ok(self.store.load(id).await?)
    }

    /// Persist input without waking execution. A stable user-message ID is
    /// required by the native runtime. Successful admission is not completion.
    pub async fn queue(&self, request: AgentTurnRequest) -> Result<(), Error> {
        Ok(self.native.admit_turn(request).await?)
    }

    /// Native admission and execution, with its observer installed before wake.
    /// Do not start the same input twice to recover a lost observer; use resume.
    pub async fn start_turn(&self, request: AgentTurnRequest) -> Result<Turn, Error> {
        Ok(Turn {
            inner: self.native.start_turn(request).await?,
        })
    }

    /// Explicit recovery of ONE known session using its saved configuration.
    /// Pending input is read from its journal, not resent by the embedding app.
    pub async fn resume_session(
        &self,
        request: AgentSessionRequest,
    ) -> Result<AgentResumeReport, Error> {
        Ok(self.native.resume_session(request).await?)
    }

    pub async fn take_resumed_turn(
        &self,
        session: &str,
        input: &str,
    ) -> Result<Option<Turn>, Error> {
        Ok(self
            .native
            .take_resumed_turn(session, input)
            .await?
            .map(|inner| Turn { inner }))
    }

    pub async fn shutdown(self, grace: Duration) -> AgentShutdownReport {
        self.native.shutdown(grace).await
    }
}

/// An observer/control handle, not an additional task, loop or execution owner.
/// Dropping it is NOT cancellation. Explicitly cancel and/or shut down Runtime.
pub struct Turn {
    inner: Box<dyn RunningTurn>,
}

impl Turn {
    pub async fn next_event(&mut self) -> Option<LoopEvent> {
        self.inner.next_event().await
    }

    pub async fn send(&mut self, command: LoopCommand) -> Result<(), LoopControlError> {
        self.inner.send(command).await
    }

    pub async fn cancel(&mut self) -> Result<(), LoopControlError> {
        self.send(LoopCommand::Cancel).await
    }

    pub async fn result(&mut self) -> LoopResult {
        self.inner.result().await
    }
}

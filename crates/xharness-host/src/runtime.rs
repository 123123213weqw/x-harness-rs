use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, RwLock as StdRwLock,
    },
};

use async_trait::async_trait;
use futures::StreamExt;
use tokio::sync::{broadcast, Mutex, RwLock};
use xharness_agent::{
    AgentCommandError, AgentEvent, AgentRegistry, AgentSupervisor, DurableAgentHandle,
    InboxMessage, LeaseManager, RegistryError, TurnRequestFactory,
};
use xharness_core::{
    AgentMessage, ContextPolicy, InjectionMode, LoopCommand, LoopControlError, LoopEngine,
    LoopEvent, LoopRequest, LoopResult, LoopRun, LoopStatus, ModelProvider, Role,
};
use xharness_prompt::PromptAssembly;
use xharness_session::{Session, SessionEvent, SessionHeader, Store, StoreError};
use xharness_token::TokenGuard;

use crate::{PermissionPreset, SessionToolFactory};

/// Provider/model selection requested by one Host session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelRoute {
    pub provider: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
}

/// Browser-visible metadata for one model route accepted by the runtime.
///
/// The route identity is intentionally separate from the adapter's upstream
/// model string. For example, `llama-v100/qwen` and
/// `llama-4080/qwen` may both use the OpenAI-compatible adapter while pointing
/// at different endpoints and wire-level model names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelDescriptor {
    pub provider: String,
    pub provider_display_name: String,
    pub model: String,
    pub model_display_name: String,
}

impl ModelDescriptor {
    pub fn new(
        provider: impl Into<String>,
        provider_display_name: impl Into<String>,
        model: impl Into<String>,
        model_display_name: impl Into<String>,
    ) -> Self {
        Self {
            provider: provider.into(),
            provider_display_name: provider_display_name.into(),
            model: model.into(),
            model_display_name: model_display_name.into(),
        }
    }

    pub fn route(&self) -> ModelRoute {
        ModelRoute::new(&self.provider, &self.model)
    }
}

/// One immutable Provider/Model binding used by [`ModelRegistry`].
#[derive(Clone)]
pub struct RegisteredModel {
    descriptor: ModelDescriptor,
    provider: Arc<dyn ModelProvider>,
    token_guard: Option<TokenGuard>,
}

impl RegisteredModel {
    pub fn new(descriptor: ModelDescriptor, provider: Arc<dyn ModelProvider>) -> Self {
        Self {
            descriptor,
            provider,
            token_guard: None,
        }
    }

    pub fn with_token_guard(mut self, token_guard: Option<TokenGuard>) -> Self {
        self.token_guard = token_guard;
        self
    }

    pub fn descriptor(&self) -> &ModelDescriptor {
        &self.descriptor
    }
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum ModelRegistryError {
    #[error("provider and model route identifiers must be non-empty")]
    EmptyRoute,
    #[error("provider and model display names must be non-empty")]
    EmptyDisplayName,
    #[error("model route {provider}/{model} is registered more than once")]
    DuplicateRoute { provider: String, model: String },
    #[error("default model route {provider}/{model} is not registered")]
    DefaultRouteUnavailable { provider: String, model: String },
}

/// Provider-neutral registry that resolves a selected Host route to one bound
/// adapter and its context budget.
///
/// Registry order is stable and is reused by the Web model picker. Adapters
/// are wrapped so durable request headers retain the public route identity,
/// while the inner adapter remains free to use a different upstream model
/// string in its wire request.
#[derive(Clone, Default)]
pub struct ModelRegistry {
    entries: HashMap<(String, String), RegisteredModel>,
    order: Vec<(String, String)>,
}

impl ModelRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, mut model: RegisteredModel) -> Result<(), ModelRegistryError> {
        let descriptor = &model.descriptor;
        if descriptor.provider.trim().is_empty() || descriptor.model.trim().is_empty() {
            return Err(ModelRegistryError::EmptyRoute);
        }
        if descriptor.provider_display_name.trim().is_empty()
            || descriptor.model_display_name.trim().is_empty()
        {
            return Err(ModelRegistryError::EmptyDisplayName);
        }
        let key = (descriptor.provider.clone(), descriptor.model.clone());
        if self.entries.contains_key(&key) {
            return Err(ModelRegistryError::DuplicateRoute {
                provider: key.0,
                model: key.1,
            });
        }
        model.provider = Arc::new(RouteBoundProvider {
            provider_id: descriptor.provider.clone(),
            model_id: descriptor.model.clone(),
            inner: model.provider,
        });
        self.order.push(key.clone());
        self.entries.insert(key, model);
        Ok(())
    }

    pub fn can_route(&self, route: &ModelRoute) -> bool {
        self.entries
            .contains_key(&(route.provider.clone(), route.model.clone()))
    }

    pub fn models(&self) -> Vec<ModelDescriptor> {
        self.order
            .iter()
            .filter_map(|key| self.entries.get(key))
            .map(|model| model.descriptor.clone())
            .collect()
    }

    pub fn token_guard(&self, route: &ModelRoute) -> Option<TokenGuard> {
        self.resolve(route)
            .and_then(|model| model.token_guard.clone())
    }

    fn resolve(&self, route: &ModelRoute) -> Option<&RegisteredModel> {
        self.entries
            .get(&(route.provider.clone(), route.model.clone()))
    }

    fn set_token_guard(&mut self, route: &ModelRoute, token_guard: Option<TokenGuard>) {
        if let Some(model) = self
            .entries
            .get_mut(&(route.provider.clone(), route.model.clone()))
        {
            model.token_guard = token_guard;
        }
    }
}

struct RouteBoundProvider {
    provider_id: String,
    model_id: String,
    inner: Arc<dyn ModelProvider>,
}

#[async_trait]
impl ModelProvider for RouteBoundProvider {
    fn provider_name(&self) -> &str {
        &self.provider_id
    }

    fn model_name(&self) -> Option<&str> {
        Some(&self.model_id)
    }

    async fn stream(
        &self,
        request: xharness_core::ProviderRequest,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<xharness_core::ProviderStream, xharness_core::ProviderError> {
        self.inner.stream(request, cancellation).await
    }
}

impl ModelRoute {
    pub fn new(provider: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            provider: provider.into(),
            model: model.into(),
            reasoning_effort: None,
        }
    }
}

/// Complete provider-neutral input needed to start one Host turn.
#[derive(Clone, Debug)]
pub struct AgentTurnRequest {
    pub session_id: String,
    pub cwd: String,
    pub route: ModelRoute,
    pub permission: PermissionPreset,
    /// Deterministic System Prompt selected by the Host for this turn.
    pub prompt: Option<PromptAssembly>,
    pub messages: Vec<AgentMessage>,
    /// Optional product/transport metadata retained beside the durable inbox
    /// item. The Web Host stores its structured content blocks and source here
    /// so queue replay does not collapse attachments into plain text.
    pub input_metadata: Option<serde_json::Value>,
}

/// Stable configuration needed to reactivate one durable Agent session after
/// Host startup. Pending input is discovered from the Session log rather than
/// copied through this control-plane request.
#[derive(Clone, Debug)]
pub struct AgentSessionRequest {
    pub session_id: String,
    pub cwd: String,
    pub route: ModelRoute,
    pub permission: PermissionPreset,
    /// Prompt restored for already-durable pending turns.
    pub prompt: Option<PromptAssembly>,
}

/// Durable work attached during one startup-resume operation.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentResumeReport {
    pub pending_turns: usize,
    pub pending_next_step: usize,
    /// Stable internal work id for one open approval turn that was attached
    /// and woken during startup recovery.
    pub recovered_approval_work_id: Option<String>,
}

/// A live turn owned by the Host driver. This seam prevents Web control-plane
/// code from depending on a particular loop or future long-lived Agent
/// implementation.
#[async_trait]
pub trait RunningTurn: Send + 'static {
    async fn next_event(&mut self) -> Option<LoopEvent>;

    async fn send(&mut self, command: LoopCommand) -> Result<(), LoopControlError>;

    /// Send one control command with optional durable product metadata. Plain
    /// Loop runtimes ignore the metadata; durable runtimes retain it beside
    /// injected/steering inbox input for restart receipt reconstruction.
    async fn send_with_metadata(
        &mut self,
        command: LoopCommand,
        _input_metadata: Option<serde_json::Value>,
    ) -> Result<(), LoopControlError> {
        self.send(command).await
    }

    async fn result(&mut self) -> LoopResult;
}

#[async_trait]
impl RunningTurn for LoopRun {
    async fn next_event(&mut self) -> Option<LoopEvent> {
        self.next().await
    }

    async fn send(&mut self, command: LoopCommand) -> Result<(), LoopControlError> {
        LoopRun::send(self, command).await
    }

    async fn result(&mut self) -> LoopResult {
        LoopRun::result(self).await
    }
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum AgentRuntimeError {
    #[error("model route {provider}/{model} is unavailable")]
    ModelUnavailable { provider: String, model: String },
    #[error("agent turn preparation failed: {message}")]
    Preparation { message: String },
}

/// Host-facing Agent execution seam. The Web Host owns queues and projections;
/// the runtime owns model routing, tool preparation, context policy and the
/// actual turn implementation.
#[async_trait]
pub trait AgentRuntime: Send + Sync + 'static {
    fn has_available_route(&self) -> bool;

    fn can_route(&self, route: &ModelRoute) -> bool;

    /// Stable model catalog exposed to the Web picker. A route returned here
    /// must also be accepted by [`Self::can_route`].
    fn model_catalog(&self) -> Vec<ModelDescriptor> {
        Vec::new()
    }

    /// Whether this runtime owns an append-only Session log that is the
    /// authoritative source for browser history and restart projection.
    fn has_authoritative_sessions(&self) -> bool {
        false
    }

    /// Load one immutable authoritative cut. Ephemeral runtimes return `None`;
    /// durable runtimes return the current Session when it has been created.
    async fn authoritative_session(
        &self,
        _session_id: &str,
    ) -> Result<Option<Session>, AgentRuntimeError> {
        Ok(None)
    }

    /// Persist product/control-plane session facts outside an active model
    /// turn. Returns `true` only when this runtime owns and flushed an
    /// authoritative Session log; ephemeral runtimes leave projection to the
    /// Host's compatibility cache.
    async fn persist_session_events(
        &self,
        _session_id: &str,
        _cwd: &str,
        _events: Vec<SessionEvent>,
    ) -> Result<bool, AgentRuntimeError> {
        Ok(false)
    }

    /// Reattach already-durable work after a Host restart. Ephemeral runtimes
    /// have no authoritative inbox and therefore report no recovered work.
    async fn resume_session(
        &self,
        _request: AgentSessionRequest,
    ) -> Result<AgentResumeReport, AgentRuntimeError> {
        Ok(AgentResumeReport::default())
    }

    /// Take a startup-recovered live turn after `resume_session` attached its
    /// event subscriber. Ephemeral runtimes never return one.
    async fn take_resumed_turn(
        &self,
        _session_id: &str,
        _work_id: &str,
    ) -> Result<Option<Box<dyn RunningTurn>>, AgentRuntimeError> {
        Ok(None)
    }

    /// Durably admit one future turn before the Host acknowledges the client.
    /// Ephemeral runtimes use the default no-op and construct work in
    /// `start_turn`; durable runtimes must flush the input before returning.
    async fn admit_turn(&self, _request: AgentTurnRequest) -> Result<(), AgentRuntimeError> {
        Ok(())
    }

    /// Remove a still-pending input. The default is a no-op for ephemeral
    /// runtimes whose queue is owned entirely by the Host.
    async fn remove_pending_input(
        &self,
        _session_id: &str,
        _input_id: &str,
    ) -> Result<(), AgentRuntimeError> {
        Ok(())
    }

    /// Replace a still-pending input in place while preserving its identity.
    async fn replace_pending_input(
        &self,
        _session_id: &str,
        _message: AgentMessage,
        _input_metadata: Option<serde_json::Value>,
    ) -> Result<(), AgentRuntimeError> {
        Ok(())
    }

    async fn start_turn(
        &self,
        request: AgentTurnRequest,
    ) -> Result<Box<dyn RunningTurn>, AgentRuntimeError>;
}

/// Adapter from the v0 [`LoopEngine`] to the Host-facing Agent runtime seam.
/// It is intentionally replaceable by a durable Agent/Inbox runtime later.
pub struct LoopAgentRuntime {
    provider_id: String,
    model_id: String,
    provider: Option<Arc<dyn ModelProvider>>,
    tool_factory: Arc<dyn SessionToolFactory>,
    context_policy: Arc<dyn ContextPolicy>,
    token_guard: Option<TokenGuard>,
}

impl LoopAgentRuntime {
    pub fn new(
        provider_id: impl Into<String>,
        model_id: impl Into<String>,
        provider: Option<Arc<dyn ModelProvider>>,
        tool_factory: Arc<dyn SessionToolFactory>,
        context_policy: Arc<dyn ContextPolicy>,
    ) -> Self {
        Self {
            provider_id: provider_id.into(),
            model_id: model_id.into(),
            provider,
            tool_factory,
            context_policy,
            token_guard: None,
        }
    }

    pub fn with_token_guard(mut self, token_guard: Option<TokenGuard>) -> Self {
        self.token_guard = token_guard;
        self
    }
}

#[async_trait]
impl AgentRuntime for LoopAgentRuntime {
    fn has_available_route(&self) -> bool {
        self.provider.is_some()
    }

    fn can_route(&self, route: &ModelRoute) -> bool {
        self.provider.is_some()
            && route.provider == self.provider_id
            && route.model == self.model_id
    }

    fn model_catalog(&self) -> Vec<ModelDescriptor> {
        if self.provider.is_none() {
            return Vec::new();
        }
        vec![ModelDescriptor::new(
            &self.provider_id,
            &self.provider_id,
            &self.model_id,
            &self.model_id,
        )]
    }

    async fn start_turn(
        &self,
        request: AgentTurnRequest,
    ) -> Result<Box<dyn RunningTurn>, AgentRuntimeError> {
        if !self.can_route(&request.route) {
            return Err(AgentRuntimeError::ModelUnavailable {
                provider: request.route.provider,
                model: request.route.model,
            });
        }
        let provider = Arc::clone(self.provider.as_ref().expect("route checked provider"));
        let tool_executor = self
            .tool_factory
            .executor(&request.session_id, &request.cwd, request.permission)
            .await
            .map_err(|message| AgentRuntimeError::Preparation { message })?;
        let mut loop_request = LoopRequest::new(provider, request.messages);
        loop_request.session_id = Some(request.session_id);
        loop_request.prompt = request.prompt;
        loop_request.tool_executor = Some(tool_executor);
        loop_request.context_policy = Arc::clone(&self.context_policy);
        loop_request.token_guard = self.token_guard.clone();
        Ok(Box::new(LoopEngine.start(loop_request)))
    }
}

#[derive(Clone)]
struct DurableSessionConfig {
    cwd: String,
    permission: PermissionPreset,
    prompt: Option<PromptAssembly>,
    route: ModelRoute,
}

struct DurableTurnFactory {
    models: Arc<StdRwLock<ModelRegistry>>,
    tool_factory: Arc<dyn SessionToolFactory>,
    context_policy: Arc<dyn ContextPolicy>,
    sessions: Arc<RwLock<HashMap<String, DurableSessionConfig>>>,
}

#[async_trait]
impl TurnRequestFactory for DurableTurnFactory {
    async fn build(&self, agent_id: &str, input: Vec<AgentMessage>) -> Result<LoopRequest, String> {
        let config = self
            .sessions
            .read()
            .await
            .get(agent_id)
            .cloned()
            .ok_or_else(|| format!("durable agent {agent_id:?} has no Host configuration"))?;
        let (provider, token_guard) = {
            let models = self.models.read().expect("model registry lock poisoned");
            let model = models.resolve(&config.route).ok_or_else(|| {
                format!(
                    "model route {}/{} is unavailable",
                    config.route.provider, config.route.model
                )
            })?;
            (Arc::clone(&model.provider), model.token_guard.clone())
        };
        let tool_executor = self
            .tool_factory
            .executor(agent_id, &config.cwd, config.permission)
            .await?;
        let mut request = LoopRequest::new(provider, input);
        request.prompt = config.prompt;
        request.tool_executor = Some(tool_executor);
        request.context_policy = Arc::clone(&self.context_policy);
        request.token_guard = token_guard;
        Ok(request)
    }
}

/// Event-sourced adapter used by the Web Host while the HTTP/RPC projection is
/// migrated away from its legacy in-memory queue. Every turn passed to this
/// adapter first enters [`xharness_agent::DurableInbox`]; the Agent driver then atomically
/// claims it beside `turn/start` and the durable `user/message`.
///
/// The Web DTO cache is not authoritative. A later Host-store migration can
/// rebuild it from this runtime's Session log without changing [`AgentRuntime`].
pub struct DurableLoopAgentRuntime {
    models: Arc<StdRwLock<ModelRegistry>>,
    default_route: ModelRoute,
    store: Arc<dyn Store>,
    sessions: Arc<RwLock<HashMap<String, DurableSessionConfig>>>,
    supervisor: AgentSupervisor,
    prepared: Mutex<HashMap<(String, String), PreparedDurableTurn>>,
    next_control_id: Arc<AtomicU64>,
}

struct PreparedDurableTurn {
    handle: DurableAgentHandle,
    events: broadcast::Receiver<AgentEvent>,
    input_id: String,
}

impl DurableLoopAgentRuntime {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        provider_id: impl Into<String>,
        model_id: impl Into<String>,
        provider: Option<Arc<dyn ModelProvider>>,
        tool_factory: Arc<dyn SessionToolFactory>,
        context_policy: Arc<dyn ContextPolicy>,
        store: Arc<dyn Store>,
        leases: Arc<dyn LeaseManager>,
        event_capacity: usize,
    ) -> Self {
        let provider_id = provider_id.into();
        let model_id = model_id.into();
        let default_route = ModelRoute::new(&provider_id, &model_id);
        let mut models = ModelRegistry::new();
        if let Some(provider) = provider {
            models
                .register(RegisteredModel::new(
                    ModelDescriptor::new(&provider_id, &provider_id, &model_id, &model_id),
                    provider,
                ))
                .expect("single model registry entry is valid");
        }
        Self::from_registry(
            default_route,
            models,
            tool_factory,
            context_policy,
            store,
            leases,
            event_capacity,
        )
        .expect("single model registry default route is valid")
    }

    /// Build one durable runtime that can route every registered model while
    /// retaining a single Agent supervisor and Session authority.
    #[allow(clippy::too_many_arguments)]
    pub fn from_registry(
        default_route: ModelRoute,
        models: ModelRegistry,
        tool_factory: Arc<dyn SessionToolFactory>,
        context_policy: Arc<dyn ContextPolicy>,
        store: Arc<dyn Store>,
        leases: Arc<dyn LeaseManager>,
        event_capacity: usize,
    ) -> Result<Self, ModelRegistryError> {
        if !models.entries.is_empty() && !models.can_route(&default_route) {
            return Err(ModelRegistryError::DefaultRouteUnavailable {
                provider: default_route.provider,
                model: default_route.model,
            });
        }
        let sessions = Arc::new(RwLock::new(HashMap::new()));
        let models = Arc::new(StdRwLock::new(models));
        let factory = Arc::new(DurableTurnFactory {
            models: Arc::clone(&models),
            tool_factory,
            context_policy,
            sessions: Arc::clone(&sessions),
        });
        let registry = Arc::new(AgentRegistry::new(Arc::clone(&store), leases));
        Ok(Self {
            models,
            default_route,
            store,
            sessions,
            supervisor: AgentSupervisor::new(registry, factory, event_capacity),
            prepared: Mutex::new(HashMap::new()),
            next_control_id: Arc::new(AtomicU64::new(1)),
        })
    }

    pub fn with_token_guard(self, token_guard: Option<TokenGuard>) -> Self {
        self.models
            .write()
            .expect("model registry lock poisoned")
            .set_token_guard(&self.default_route, token_guard);
        self
    }

    fn validate_turn_input(
        &self,
        request: &AgentTurnRequest,
    ) -> Result<(AgentMessage, String), AgentRuntimeError> {
        if !self.can_route(&request.route) {
            return Err(AgentRuntimeError::ModelUnavailable {
                provider: request.route.provider.clone(),
                model: request.route.model.clone(),
            });
        }
        let input = request
            .messages
            .last()
            .cloned()
            .filter(|message| message.role == Role::User)
            .ok_or_else(|| AgentRuntimeError::Preparation {
                message: "durable turn requires a final user message".to_owned(),
            })?;
        let input_id = input
            .id
            .clone()
            .ok_or_else(|| AgentRuntimeError::Preparation {
                message: "durable turn user message requires a stable id".to_owned(),
            })?;
        Ok((input, input_id))
    }

    async fn prepare_turn(
        &self,
        request: AgentTurnRequest,
    ) -> Result<PreparedDurableTurn, AgentRuntimeError> {
        let (input, input_id) = self.validate_turn_input(&request)?;
        self.sessions.write().await.insert(
            request.session_id.clone(),
            DurableSessionConfig {
                cwd: request.cwd.clone(),
                permission: request.permission,
                prompt: request.prompt.clone(),
                route: request.route,
            },
        );
        let mut header = SessionHeader::new(&request.session_id);
        header.cwd = Some(request.cwd);
        let handle = self
            .supervisor
            .activate(header)
            .await
            .map_err(registry_error)?;
        let events = handle.subscribe();
        handle
            .followup(InboxMessage {
                id: input_id.clone(),
                message: input,
                source: request.input_metadata,
            })
            .await
            .map_err(agent_command_error)?;
        Ok(PreparedDurableTurn {
            handle,
            events,
            input_id,
        })
    }

    fn running_from_prepared(&self, prepared: PreparedDurableTurn) -> Box<dyn RunningTurn> {
        Box::new(DurableRunningTurn {
            handle: prepared.handle,
            events: prepared.events,
            target_input_id: prepared.input_id,
            turn: None,
            result: None,
            terminal: false,
            next_control_id: Arc::clone(&self.next_control_id),
        })
    }
}

#[async_trait]
impl AgentRuntime for DurableLoopAgentRuntime {
    fn has_available_route(&self) -> bool {
        !self
            .models
            .read()
            .expect("model registry lock poisoned")
            .entries
            .is_empty()
    }

    fn can_route(&self, route: &ModelRoute) -> bool {
        self.models
            .read()
            .expect("model registry lock poisoned")
            .can_route(route)
    }

    fn model_catalog(&self) -> Vec<ModelDescriptor> {
        self.models
            .read()
            .expect("model registry lock poisoned")
            .models()
    }

    fn has_authoritative_sessions(&self) -> bool {
        true
    }

    async fn authoritative_session(
        &self,
        session_id: &str,
    ) -> Result<Option<Session>, AgentRuntimeError> {
        self.store
            .load(session_id)
            .await
            .map_err(|error| AgentRuntimeError::Preparation {
                message: format!("could not load durable session {session_id:?}: {error}"),
            })
    }

    async fn persist_session_events(
        &self,
        session_id: &str,
        cwd: &str,
        events: Vec<SessionEvent>,
    ) -> Result<bool, AgentRuntimeError> {
        if events.is_empty() {
            return Ok(true);
        }
        let mut conflicts = 0usize;
        loop {
            let session = match self.store.load(session_id).await.map_err(|error| {
                AgentRuntimeError::Preparation {
                    message: format!("could not load durable session {session_id:?}: {error}"),
                }
            })? {
                Some(session) => session,
                None => {
                    let mut header = SessionHeader::new(session_id);
                    header.cwd = Some(cwd.to_owned());
                    match self.store.create(header).await {
                        Ok(session) => session,
                        Err(StoreError::AlreadyExists { .. }) => continue,
                        Err(error) => {
                            return Err(AgentRuntimeError::Preparation {
                                message: format!(
                                    "could not create durable session {session_id:?}: {error}"
                                ),
                            });
                        }
                    }
                }
            };
            match self
                .store
                .append(session_id, session.revision(), events.clone())
                .await
            {
                Ok(_) => {
                    self.store.flush(session_id).await.map_err(|error| {
                        AgentRuntimeError::Preparation {
                            message: format!(
                                "could not flush durable session {session_id:?}: {error}"
                            ),
                        }
                    })?;
                    return Ok(true);
                }
                Err(StoreError::RevisionConflict { .. }) if conflicts < 16 => {
                    conflicts += 1;
                }
                Err(error) => {
                    return Err(AgentRuntimeError::Preparation {
                        message: format!(
                            "could not append durable session events for {session_id:?}: {error}"
                        ),
                    });
                }
            }
        }
    }

    async fn resume_session(
        &self,
        request: AgentSessionRequest,
    ) -> Result<AgentResumeReport, AgentRuntimeError> {
        if !self.can_route(&request.route) {
            return Err(AgentRuntimeError::ModelUnavailable {
                provider: request.route.provider,
                model: request.route.model,
            });
        }
        self.sessions.write().await.insert(
            request.session_id.clone(),
            DurableSessionConfig {
                cwd: request.cwd.clone(),
                permission: request.permission,
                prompt: request.prompt,
                route: request.route,
            },
        );
        let mut header = SessionHeader::new(&request.session_id);
        header.cwd = Some(request.cwd);
        let handle = self
            .supervisor
            .activate(header)
            .await
            .map_err(registry_error)?;
        let snapshot =
            handle
                .inbox()
                .snapshot()
                .await
                .map_err(|error| AgentRuntimeError::Preparation {
                    message: error.to_string(),
                })?;
        let pending_turns = snapshot.next_turn().len();
        let pending_next_step = snapshot.next_step().len();
        let session = self
            .store
            .load(&request.session_id)
            .await
            .map_err(|error| AgentRuntimeError::Preparation {
                message: format!(
                    "could not inspect durable approval recovery for {:?}: {error}",
                    request.session_id
                ),
            })?
            .ok_or_else(|| AgentRuntimeError::Preparation {
                message: format!("durable session {:?} disappeared", request.session_id),
            })?;
        let pending_approvals = session.pending_tool_approvals();
        let recovered_approval_work_id = pending_approvals
            .first()
            .map(|first| xharness_agent::approval_recovery_work_id(&first.id));
        if let Some(first) = pending_approvals.first() {
            if pending_approvals
                .iter()
                .any(|approval| approval.turn != first.turn || approval.step != first.step)
            {
                return Err(AgentRuntimeError::Preparation {
                    message: "pending approvals span more than one open tool batch".to_owned(),
                });
            }
        }

        // Subscribe once per stable input before the worker is allowed to
        // wake. Each later Web driver can then consume only the turn whose
        // TurnStarted frame names that input ID, even if the Agent completes
        // several turns before the browser reconnects.
        let mut prepared = self.prepared.lock().await;
        for input in snapshot.next_turn() {
            prepared
                .entry((request.session_id.clone(), input.id.clone()))
                .or_insert_with(|| PreparedDurableTurn {
                    handle: handle.clone(),
                    events: handle.subscribe(),
                    input_id: input.id.clone(),
                });
        }
        if let Some(work_id) = &recovered_approval_work_id {
            prepared
                .entry((request.session_id.clone(), work_id.clone()))
                .or_insert_with(|| PreparedDurableTurn {
                    handle: handle.clone(),
                    events: handle.subscribe(),
                    input_id: work_id.clone(),
                });
        }
        drop(prepared);
        if recovered_approval_work_id.is_some() {
            handle
                .recover_open_turn()
                .await
                .map_err(agent_command_error)?;
        }
        if pending_turns > 0 {
            handle.wake().await.map_err(agent_command_error)?;
        }
        Ok(AgentResumeReport {
            pending_turns,
            pending_next_step,
            recovered_approval_work_id,
        })
    }

    async fn take_resumed_turn(
        &self,
        session_id: &str,
        work_id: &str,
    ) -> Result<Option<Box<dyn RunningTurn>>, AgentRuntimeError> {
        Ok(self
            .prepared
            .lock()
            .await
            .remove(&(session_id.to_owned(), work_id.to_owned()))
            .map(|prepared| self.running_from_prepared(prepared)))
    }

    async fn admit_turn(&self, request: AgentTurnRequest) -> Result<(), AgentRuntimeError> {
        let (_, input_id) = self.validate_turn_input(&request)?;
        let key = (request.session_id.clone(), input_id);
        let mut prepared_turns = self.prepared.lock().await;
        if prepared_turns.contains_key(&key) {
            // Retried HTTP admission with the same stable RPC/message ID is
            // idempotent while the prepared turn remains attached.
            return Ok(());
        }
        let prepared = self.prepare_turn(request).await?;
        prepared_turns.insert(key, prepared);
        Ok(())
    }

    async fn remove_pending_input(
        &self,
        session_id: &str,
        input_id: &str,
    ) -> Result<(), AgentRuntimeError> {
        let handle = self.supervisor.get(session_id).await.ok_or_else(|| {
            AgentRuntimeError::Preparation {
                message: format!("durable agent {session_id:?} is not active"),
            }
        })?;
        let removed = handle.inbox().remove(input_id).await.map_err(|error| {
            AgentRuntimeError::Preparation {
                message: error.to_string(),
            }
        })?;
        if removed.is_none() {
            return Err(AgentRuntimeError::Preparation {
                message: format!("durable input {input_id:?} is no longer pending"),
            });
        }
        self.prepared
            .lock()
            .await
            .remove(&(session_id.to_owned(), input_id.to_owned()));
        Ok(())
    }

    async fn replace_pending_input(
        &self,
        session_id: &str,
        mut message: AgentMessage,
        input_metadata: Option<serde_json::Value>,
    ) -> Result<(), AgentRuntimeError> {
        if message.role != Role::User {
            return Err(AgentRuntimeError::Preparation {
                message: "durable queued input must have the user role".to_owned(),
            });
        }
        let input_id = message
            .id
            .clone()
            .ok_or_else(|| AgentRuntimeError::Preparation {
                message: "durable queued input requires a stable id".to_owned(),
            })?;
        message.id = Some(input_id.clone());
        let handle = self.supervisor.get(session_id).await.ok_or_else(|| {
            AgentRuntimeError::Preparation {
                message: format!("durable agent {session_id:?} is not active"),
            }
        })?;
        let replaced = handle
            .inbox()
            .replace(
                &input_id,
                InboxMessage {
                    id: input_id.clone(),
                    message,
                    source: input_metadata,
                },
            )
            .await
            .map_err(|error| AgentRuntimeError::Preparation {
                message: error.to_string(),
            })?;
        if replaced.is_none() {
            return Err(AgentRuntimeError::Preparation {
                message: format!("durable input {input_id:?} is no longer pending"),
            });
        }
        Ok(())
    }

    async fn start_turn(
        &self,
        request: AgentTurnRequest,
    ) -> Result<Box<dyn RunningTurn>, AgentRuntimeError> {
        let (_, input_id) = self.validate_turn_input(&request)?;
        let key = (request.session_id.clone(), input_id.clone());
        let prepared = match self.prepared.lock().await.remove(&key) {
            Some(prepared) => prepared,
            None => self.prepare_turn(request).await?,
        };
        Ok(self.running_from_prepared(prepared))
    }
}

struct DurableRunningTurn {
    handle: DurableAgentHandle,
    events: broadcast::Receiver<AgentEvent>,
    target_input_id: String,
    turn: Option<u32>,
    result: Option<LoopResult>,
    terminal: bool,
    next_control_id: Arc<AtomicU64>,
}

impl DurableRunningTurn {
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

    async fn receive_event(&mut self) -> Option<LoopEvent> {
        while !self.terminal {
            match self.events.recv().await {
                Ok(AgentEvent::TurnStarted { turn, input_ids })
                    if self.turn.is_none()
                        && input_ids
                            .iter()
                            .any(|input_id| input_id == &self.target_input_id) =>
                {
                    self.turn = Some(turn);
                }
                Ok(AgentEvent::TurnEvent { turn, event }) if self.turn == Some(turn) => {
                    return Some(event);
                }
                Ok(AgentEvent::TurnFinished { turn, result }) if self.turn == Some(turn) => {
                    self.result = Some(result);
                    self.terminal = true;
                }
                Ok(AgentEvent::Error { message }) => {
                    self.result = Some(Self::failed_result(message));
                    self.terminal = true;
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    self.result = Some(Self::failed_result(format!(
                        "durable Agent event subscriber lagged by {skipped} events"
                    )));
                    self.terminal = true;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    self.result = Some(Self::failed_result(
                        "durable Agent closed before publishing a turn result",
                    ));
                    self.terminal = true;
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

fn registry_error(error: RegistryError) -> AgentRuntimeError {
    AgentRuntimeError::Preparation {
        message: error.to_string(),
    }
}

fn agent_command_error(error: AgentCommandError) -> AgentRuntimeError {
    AgentRuntimeError::Preparation {
        message: error.to_string(),
    }
}

fn loop_control_error(error: AgentCommandError) -> LoopControlError {
    match error {
        AgentCommandError::Closed => LoopControlError::Closed,
        AgentCommandError::NoActiveTurn => {
            LoopControlError::Rejected("durable Agent has no active turn".to_owned())
        }
        AgentCommandError::Failed(message) => LoopControlError::Rejected(message),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicUsize, Ordering as AtomicOrdering},
            Mutex,
        },
    };

    use super::*;
    use crate::NoTools;
    use futures::stream;
    use tokio::sync::Notify;
    use tokio_util::sync::CancellationToken;
    use xharness_agent::MemoryLeaseManager;
    use xharness_core::{
        FinishReason, IdentityContextPolicy, ProviderError, ProviderEvent, ProviderRequest,
        ProviderStream,
    };
    use xharness_session::MemorySessionStore;

    struct ScriptProvider {
        answers: Mutex<VecDeque<String>>,
    }

    struct BlockingFirstProvider {
        attempts: AtomicUsize,
        release: Arc<Notify>,
    }

    #[async_trait]
    impl ModelProvider for ScriptProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        fn model_name(&self) -> Option<&str> {
            Some("test-model")
        }

        async fn stream(
            &self,
            _request: ProviderRequest,
            _cancellation: CancellationToken,
        ) -> Result<ProviderStream, ProviderError> {
            let answer = self.answers.lock().unwrap().pop_front().unwrap();
            Ok(Box::pin(stream::iter([
                Ok(ProviderEvent::TextDelta(answer)),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::Stop),
                    usage: None,
                    provider_items: Vec::new(),
                }),
            ])))
        }
    }

    #[async_trait]
    impl ModelProvider for BlockingFirstProvider {
        async fn stream(
            &self,
            _request: ProviderRequest,
            _cancellation: CancellationToken,
        ) -> Result<ProviderStream, ProviderError> {
            if self.attempts.fetch_add(1, AtomicOrdering::SeqCst) == 0 {
                self.release.notified().await;
            }
            Ok(Box::pin(stream::iter([
                Ok(ProviderEvent::TextDelta("released".to_owned())),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::Stop),
                    usage: None,
                    provider_items: Vec::new(),
                }),
            ])))
        }
    }

    #[tokio::test]
    async fn unavailable_runtime_rejects_before_turn_construction() {
        let runtime = LoopAgentRuntime::new(
            "provider-a",
            "model-a",
            None,
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
        );
        let route = ModelRoute::new("provider-a", "model-a");
        assert!(!runtime.has_available_route());
        assert!(!runtime.can_route(&route));
        let error = runtime
            .start_turn(AgentTurnRequest {
                session_id: "session".to_owned(),
                cwd: "/workspace".to_owned(),
                route,
                permission: PermissionPreset::WorkspaceWrite,
                prompt: None,
                messages: vec![AgentMessage::user("hello")],
                input_metadata: None,
            })
            .await
            .err()
            .expect("missing provider must reject the turn");
        assert_eq!(
            error,
            AgentRuntimeError::ModelUnavailable {
                provider: "provider-a".to_owned(),
                model: "model-a".to_owned(),
            }
        );
    }

    #[tokio::test]
    async fn durable_runtime_replays_journal_history_across_host_turns() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let provider: Arc<dyn ModelProvider> = Arc::new(ScriptProvider {
            answers: Mutex::new(VecDeque::from([
                "first answer".to_owned(),
                "second answer".to_owned(),
            ])),
        });
        let runtime = DurableLoopAgentRuntime::new(
            "test",
            "test-model",
            Some(provider),
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            Arc::clone(&store),
            Arc::new(MemoryLeaseManager::default()),
            64,
        );

        let first_request = AgentTurnRequest {
            session_id: "durable-host".to_owned(),
            cwd: "/workspace".to_owned(),
            route: ModelRoute::new("test", "test-model"),
            permission: PermissionPreset::WorkspaceWrite,
            prompt: None,
            messages: vec![AgentMessage::user("first").with_id("prompt-1")],
            input_metadata: None,
        };
        runtime.admit_turn(first_request.clone()).await.unwrap();
        let admitted = store.load("durable-host").await.unwrap().unwrap();
        assert!(admitted.events().iter().any(|event| {
            matches!(
                event.data(),
                xharness_session::EventData::AgentInboxSpliced { inserted, .. }
                    if inserted.iter().any(|message| message.id == "prompt-1")
            )
        }));
        let mut first = runtime.start_turn(first_request).await.unwrap();
        while first.next_event().await.is_some() {}
        assert_eq!(first.result().await.final_text, "first answer");

        let second_request = AgentTurnRequest {
            session_id: "durable-host".to_owned(),
            cwd: "/workspace".to_owned(),
            route: ModelRoute::new("test", "test-model"),
            permission: PermissionPreset::WorkspaceWrite,
            prompt: None,
            // The durable Session, not this compatibility DTO, supplies the
            // prior turn to the second model request.
            messages: vec![AgentMessage::user("second").with_id("prompt-2")],
            input_metadata: None,
        };
        runtime.admit_turn(second_request.clone()).await.unwrap();
        let mut second = runtime.start_turn(second_request).await.unwrap();
        while second.next_event().await.is_some() {}
        assert_eq!(second.result().await.final_text, "second answer");

        let session = store.load("durable-host").await.unwrap().unwrap();
        let contents = session
            .derive_messages()
            .into_iter()
            .map(|message| message.content)
            .collect::<Vec<_>>();
        assert_eq!(
            contents,
            ["first", "first answer", "second", "second answer"]
        );
    }

    #[tokio::test]
    async fn durable_registry_routes_each_turn_and_journals_public_route_identity() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let mut models = ModelRegistry::new();
        models
            .register(RegisteredModel::new(
                ModelDescriptor::new("gpu-4080", "RTX 4080", "qwen", "Qwen on 4080"),
                Arc::new(ScriptProvider {
                    answers: Mutex::new(VecDeque::from(["answer-4080".to_owned()])),
                }),
            ))
            .unwrap();
        models
            .register(RegisteredModel::new(
                ModelDescriptor::new("gpu-v100", "V100 Server", "qwen", "Qwen on V100"),
                Arc::new(ScriptProvider {
                    answers: Mutex::new(VecDeque::from(["answer-v100".to_owned()])),
                }),
            ))
            .unwrap();
        let runtime = DurableLoopAgentRuntime::from_registry(
            ModelRoute::new("gpu-4080", "qwen"),
            models,
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            Arc::clone(&store),
            Arc::new(MemoryLeaseManager::default()),
            64,
        )
        .unwrap();
        assert_eq!(runtime.model_catalog().len(), 2);
        assert!(runtime.can_route(&ModelRoute::new("gpu-v100", "qwen")));

        for (ordinal, provider, expected) in [
            (1, "gpu-4080", "answer-4080"),
            (2, "gpu-v100", "answer-v100"),
        ] {
            let request = AgentTurnRequest {
                session_id: "routed-host".to_owned(),
                cwd: "/workspace".to_owned(),
                route: ModelRoute::new(provider, "qwen"),
                permission: PermissionPreset::WorkspaceWrite,
                prompt: None,
                messages: vec![AgentMessage::user(format!("prompt-{ordinal}"))
                    .with_id(format!("prompt-{ordinal}"))],
                input_metadata: None,
            };
            runtime.admit_turn(request.clone()).await.unwrap();
            let mut running = runtime.start_turn(request).await.unwrap();
            while running.next_event().await.is_some() {}
            assert_eq!(running.result().await.final_text, expected);
        }

        let session = store.load("routed-host").await.unwrap().unwrap();
        let routes = session
            .events()
            .iter()
            .filter_map(|event| match event.data() {
                xharness_session::EventData::RequestHeader { header } => {
                    Some((header.provider.as_str(), header.model.as_str()))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(routes, [("gpu-4080", "qwen"), ("gpu-v100", "qwen")]);
    }

    #[tokio::test]
    async fn multiple_pre_admitted_turns_keep_their_own_buffered_event_streams() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let provider: Arc<dyn ModelProvider> = Arc::new(ScriptProvider {
            answers: Mutex::new(VecDeque::from([
                "answer-a".to_owned(),
                "answer-b".to_owned(),
            ])),
        });
        let runtime = DurableLoopAgentRuntime::new(
            "test",
            "test-model",
            Some(provider),
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            store,
            Arc::new(MemoryLeaseManager::default()),
            64,
        );
        let request_a = AgentTurnRequest {
            session_id: "buffered-turns".to_owned(),
            cwd: "/workspace".to_owned(),
            route: ModelRoute::new("test", "test-model"),
            permission: PermissionPreset::WorkspaceWrite,
            prompt: None,
            messages: vec![AgentMessage::user("a").with_id("prompt-a")],
            input_metadata: None,
        };
        let request_b = AgentTurnRequest {
            messages: vec![AgentMessage::user("b").with_id("prompt-b")],
            ..request_a.clone()
        };

        runtime.admit_turn(request_a.clone()).await.unwrap();
        runtime.admit_turn(request_b.clone()).await.unwrap();
        // The durable worker is allowed to finish both turns before either
        // Web projection starts polling. Per-admission receivers retain the
        // frames and correlate by claimed stable input ID.
        tokio::task::yield_now().await;
        let mut turn_a = runtime.start_turn(request_a).await.unwrap();
        let mut turn_b = runtime.start_turn(request_b).await.unwrap();
        while turn_a.next_event().await.is_some() {}
        while turn_b.next_event().await.is_some() {}
        assert_eq!(turn_a.result().await.final_text, "answer-a");
        assert_eq!(turn_b.result().await.final_text, "answer-b");
    }

    #[tokio::test]
    async fn durable_queue_replace_and_remove_update_the_inbox_before_web_projection() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let release = Arc::new(Notify::new());
        let provider: Arc<dyn ModelProvider> = Arc::new(BlockingFirstProvider {
            attempts: AtomicUsize::new(0),
            release: Arc::clone(&release),
        });
        let runtime = DurableLoopAgentRuntime::new(
            "test",
            "test-model",
            Some(provider),
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            Arc::clone(&store),
            Arc::new(MemoryLeaseManager::default()),
            64,
        );
        let first = AgentTurnRequest {
            session_id: "queue-mutations".to_owned(),
            cwd: "/workspace".to_owned(),
            route: ModelRoute::new("test", "test-model"),
            permission: PermissionPreset::WorkspaceWrite,
            prompt: None,
            messages: vec![AgentMessage::user("first").with_id("prompt-first")],
            input_metadata: None,
        };
        let queued = AgentTurnRequest {
            messages: vec![AgentMessage::user("old").with_id("prompt-queued")],
            ..first.clone()
        };
        runtime.admit_turn(first.clone()).await.unwrap();
        for _ in 0..100 {
            let session = store.load("queue-mutations").await.unwrap().unwrap();
            if session.events().iter().any(|event| {
                matches!(
                    event.data(),
                    xharness_session::EventData::UserMessage { message }
                        if message.id.as_deref() == Some("prompt-first")
                )
            }) {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(store
            .load("queue-mutations")
            .await
            .unwrap()
            .unwrap()
            .events()
            .iter()
            .any(|event| matches!(
                event.data(),
                xharness_session::EventData::UserMessage { message }
                    if message.id.as_deref() == Some("prompt-first")
            )));
        runtime.admit_turn(queued).await.unwrap();

        runtime
            .replace_pending_input(
                "queue-mutations",
                AgentMessage::user("edited").with_id("prompt-queued"),
                None,
            )
            .await
            .unwrap();
        let session = store.load("queue-mutations").await.unwrap().unwrap();
        let inbox = xharness_agent::InboxProjection::from_session(&session).unwrap();
        assert_eq!(inbox.next_turn().len(), 1);
        assert_eq!(inbox.next_turn()[0].message.content, "edited");

        runtime
            .remove_pending_input("queue-mutations", "prompt-queued")
            .await
            .unwrap();
        let session = store.load("queue-mutations").await.unwrap().unwrap();
        assert!(!xharness_agent::InboxProjection::from_session(&session)
            .unwrap()
            .has_pending());

        let mut running = runtime.start_turn(first).await.unwrap();
        release.notify_one();
        while running.next_event().await.is_some() {}
        assert_eq!(running.result().await.final_text, "released");
    }

    #[tokio::test]
    async fn durable_runtime_resumes_pending_input_without_appending_a_duplicate() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let mut header = SessionHeader::new("runtime-resume");
        header.cwd = Some("/workspace".to_owned());
        let inbox = xharness_agent::DurableInbox::open(Arc::clone(&store), header)
            .await
            .unwrap();
        inbox
            .append(
                xharness_agent::InboxTarget::NextTurn,
                InboxMessage::user("restored-input", "continue after restart"),
            )
            .await
            .unwrap();

        let provider: Arc<dyn ModelProvider> = Arc::new(ScriptProvider {
            answers: Mutex::new(VecDeque::from(["restored answer".to_owned()])),
        });
        let runtime = DurableLoopAgentRuntime::new(
            "test",
            "test-model",
            Some(provider),
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            Arc::clone(&store),
            Arc::new(MemoryLeaseManager::default()),
            64,
        );
        let report = runtime
            .resume_session(AgentSessionRequest {
                session_id: "runtime-resume".to_owned(),
                cwd: "/workspace".to_owned(),
                route: ModelRoute::new("test", "test-model"),
                permission: PermissionPreset::WorkspaceWrite,
                prompt: None,
            })
            .await
            .unwrap();
        assert_eq!(report.pending_turns, 1);
        assert_eq!(report.pending_next_step, 0);

        let request = AgentTurnRequest {
            session_id: "runtime-resume".to_owned(),
            cwd: "/workspace".to_owned(),
            route: ModelRoute::new("test", "test-model"),
            permission: PermissionPreset::WorkspaceWrite,
            prompt: None,
            messages: vec![AgentMessage::user("continue after restart").with_id("restored-input")],
            input_metadata: None,
        };
        let mut running = runtime.start_turn(request).await.unwrap();
        while running.next_event().await.is_some() {}
        assert_eq!(running.result().await.final_text, "restored answer");

        let session = store.load("runtime-resume").await.unwrap().unwrap();
        let inserted = session
            .events()
            .iter()
            .filter_map(|event| match event.data() {
                xharness_session::EventData::AgentInboxSpliced { inserted, .. } => Some(
                    inserted
                        .iter()
                        .filter(|message| message.id == "restored-input")
                        .count(),
                ),
                _ => None,
            })
            .sum::<usize>();
        assert_eq!(inserted, 1, "resume must not append the prompt again");
        assert_eq!(
            session
                .derive_messages()
                .iter()
                .filter(|message| message.id.as_deref() == Some("restored-input"))
                .count(),
            1
        );
    }
}

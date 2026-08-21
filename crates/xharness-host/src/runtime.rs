use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use futures::StreamExt;
use tokio::sync::{broadcast, RwLock};
use xharness_agent::{
    AgentCommandError, AgentEvent, AgentRegistry, AgentSupervisor, DurableAgentHandle,
    InboxMessage, LeaseManager, RegistryError, TurnRequestFactory,
};
use xharness_core::{
    AgentMessage, ContextPolicy, InjectionMode, LoopCommand, LoopControlError, LoopEngine,
    LoopEvent, LoopRequest, LoopResult, LoopRun, LoopStatus, ModelProvider, Role,
};
use xharness_session::{SessionHeader, Store};

use crate::{PermissionPreset, SessionToolFactory};

/// Provider/model selection requested by one Host session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelRoute {
    pub provider: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
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
    pub messages: Vec<AgentMessage>,
}

/// A live turn owned by the Host driver. This seam prevents Web control-plane
/// code from depending on a particular loop or future long-lived Agent
/// implementation.
#[async_trait]
pub trait RunningTurn: Send + 'static {
    async fn next_event(&mut self) -> Option<LoopEvent>;

    async fn send(&self, command: LoopCommand) -> Result<(), LoopControlError>;

    async fn result(&mut self) -> LoopResult;
}

#[async_trait]
impl RunningTurn for LoopRun {
    async fn next_event(&mut self) -> Option<LoopEvent> {
        self.next().await
    }

    async fn send(&self, command: LoopCommand) -> Result<(), LoopControlError> {
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
        }
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
        let tools = self
            .tool_factory
            .tools(&request.session_id, &request.cwd, request.permission)
            .await
            .map_err(|message| AgentRuntimeError::Preparation { message })?;
        let mut loop_request = LoopRequest::new(provider, request.messages);
        loop_request.session_id = Some(request.session_id);
        loop_request.tools = tools;
        loop_request.context_policy = Arc::clone(&self.context_policy);
        Ok(Box::new(LoopEngine.start(loop_request)))
    }
}

#[derive(Clone)]
struct DurableSessionConfig {
    cwd: String,
    permission: PermissionPreset,
}

struct DurableTurnFactory {
    provider: Option<Arc<dyn ModelProvider>>,
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
        let provider = Arc::clone(
            self.provider
                .as_ref()
                .ok_or_else(|| "model provider is unavailable".to_owned())?,
        );
        let tools = self
            .tool_factory
            .tools(agent_id, &config.cwd, config.permission)
            .await?;
        let mut request = LoopRequest::new(provider, input);
        request.tools = tools;
        request.context_policy = Arc::clone(&self.context_policy);
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
    provider_id: String,
    model_id: String,
    provider_available: bool,
    sessions: Arc<RwLock<HashMap<String, DurableSessionConfig>>>,
    supervisor: AgentSupervisor,
    next_control_id: Arc<AtomicU64>,
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
        let provider_available = provider.is_some();
        let sessions = Arc::new(RwLock::new(HashMap::new()));
        let factory = Arc::new(DurableTurnFactory {
            provider,
            tool_factory,
            context_policy,
            sessions: Arc::clone(&sessions),
        });
        let registry = Arc::new(AgentRegistry::new(store, leases));
        Self {
            provider_id: provider_id.into(),
            model_id: model_id.into(),
            provider_available,
            sessions,
            supervisor: AgentSupervisor::new(registry, factory, event_capacity),
            next_control_id: Arc::new(AtomicU64::new(1)),
        }
    }
}

#[async_trait]
impl AgentRuntime for DurableLoopAgentRuntime {
    fn has_available_route(&self) -> bool {
        self.provider_available
    }

    fn can_route(&self, route: &ModelRoute) -> bool {
        self.provider_available
            && route.provider == self.provider_id
            && route.model == self.model_id
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
        self.sessions.write().await.insert(
            request.session_id.clone(),
            DurableSessionConfig {
                cwd: request.cwd.clone(),
                permission: request.permission,
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
                id: input_id,
                message: input,
                source: None,
            })
            .await
            .map_err(agent_command_error)?;
        Ok(Box::new(DurableRunningTurn {
            handle,
            events,
            turn: None,
            result: None,
            terminal: false,
            next_control_id: Arc::clone(&self.next_control_id),
        }))
    }
}

struct DurableRunningTurn {
    handle: DurableAgentHandle,
    events: broadcast::Receiver<AgentEvent>,
    turn: Option<u32>,
    result: Option<LoopResult>,
    terminal: bool,
    next_control_id: Arc<AtomicU64>,
}

impl DurableRunningTurn {
    fn inbox_message(&self, mut message: AgentMessage) -> Result<InboxMessage, LoopControlError> {
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
            source: None,
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
                Ok(AgentEvent::TurnStarted { turn }) if self.turn.is_none() => {
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
}

#[async_trait]
impl RunningTurn for DurableRunningTurn {
    async fn next_event(&mut self) -> Option<LoopEvent> {
        self.receive_event().await
    }

    async fn send(&self, command: LoopCommand) -> Result<(), LoopControlError> {
        let result = match command {
            LoopCommand::InjectMessage { message, mode } => {
                let message = self.inbox_message(message)?;
                match mode {
                    InjectionMode::NextStep => self.handle.inject(message).await,
                    InjectionMode::InterruptModel => self.handle.steer(message).await,
                }
            }
            LoopCommand::Steer(message) => self.handle.steer(self.inbox_message(message)?).await,
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
    use std::{collections::VecDeque, sync::Mutex};

    use super::*;
    use crate::NoTools;
    use futures::stream;
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
                messages: vec![AgentMessage::user("hello")],
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

        let mut first = runtime
            .start_turn(AgentTurnRequest {
                session_id: "durable-host".to_owned(),
                cwd: "/workspace".to_owned(),
                route: ModelRoute::new("test", "test-model"),
                permission: PermissionPreset::WorkspaceWrite,
                messages: vec![AgentMessage::user("first").with_id("prompt-1")],
            })
            .await
            .unwrap();
        while first.next_event().await.is_some() {}
        assert_eq!(first.result().await.final_text, "first answer");

        let mut second = runtime
            .start_turn(AgentTurnRequest {
                session_id: "durable-host".to_owned(),
                cwd: "/workspace".to_owned(),
                route: ModelRoute::new("test", "test-model"),
                permission: PermissionPreset::WorkspaceWrite,
                // The durable Session, not this compatibility DTO, supplies
                // the prior turn to the second model request.
                messages: vec![AgentMessage::user("second").with_id("prompt-2")],
            })
            .await
            .unwrap();
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
}

//! Stateful, Web-compatible XHarness host.
//!
//! This crate is the first functional implementation behind the transport
//! contract: every upstream RPC method has a validated baseline behavior,
//! while session prompts are driven by the provider-neutral Rust loop.

mod control;
mod driver;
mod metrics;
mod questions;
mod restore;
mod rpc;
mod runtime;
mod state;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex, OwnedMutexGuard, RwLock};
use xharness_api::{RpcId, ServerRequest};
use xharness_control::{ControlStore, MemoryControlStore};
use xharness_core::{ContextPolicy, IdentityContextPolicy, ModelProvider};
use xharness_token::TokenGuard;
use xharness_tools::{ToolExecutor, ToolRegistry};

pub use questions::{
    managed_agent_memory, update_agent_markdown, AgentMarkdownSink, DurableQuestionHub,
    DurableQuestionProvider, NoopAgentMarkdownSink, QuestionHubError, AGENT_MEMORY_BEGIN,
    AGENT_MEMORY_END,
};
pub use restore::{HostRestoreError, HostRestoreIssue, HostRestoreReport};
pub use runtime::{
    AgentResumeReport, AgentRuntime, AgentRuntimeError, AgentSessionRequest, AgentTurnRequest,
    DurableLoopAgentRuntime, LoopAgentRuntime, ModelDescriptor, ModelReasoning,
    ModelReasoningEffort, ModelRegistry, ModelRegistryError, ModelRoute, RegisteredModel,
    RunningTurn,
};
pub use state::{AgentPreset, GoalState, PermissionPreset, SessionRecord, WorkspaceRecord};

/// Host process configuration visible at the browser boundary.
#[derive(Clone, Debug)]
pub struct HostConfig {
    pub cwd: PathBuf,
    pub home: PathBuf,
    pub version: String,
    pub provider_id: String,
    pub provider_display_name: String,
    pub model_id: String,
    /// Default exact-model reasoning effort for newly created sessions.
    pub reasoning_effort: Option<String>,
    /// Provider/model context admission configured by the product host.
    pub token_guard: Option<TokenGuard>,
    pub event_capacity: usize,
    /// Maximum number of projected Session events retained in Host memory for
    /// a durable session. Older history remains queryable from the append-only
    /// Session store through `session.history`.
    pub session_event_cache_capacity: usize,
    /// Serialized byte budget for the same durable projection tail. A single
    /// event larger than this budget is delivered live and remains durable,
    /// but is not pinned in Host memory.
    pub session_event_cache_bytes: usize,
}

impl HostConfig {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        let cwd = cwd.into();
        #[cfg(unix)]
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| cwd.clone());
        #[cfg(windows)]
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .unwrap_or_else(|| cwd.clone());
        Self {
            cwd,
            home,
            version: env!("CARGO_PKG_VERSION").to_owned(),
            provider_id: "openai-compatible".to_owned(),
            provider_display_name: "OpenAI compatible".to_owned(),
            model_id: "unconfigured".to_owned(),
            reasoning_effort: None,
            token_guard: None,
            event_capacity: 2_048,
            session_event_cache_capacity: 2_048,
            session_event_cache_bytes: 16 * 1024 * 1024,
        }
    }
}

#[async_trait]
pub trait SessionToolFactory: Send + Sync + 'static {
    async fn executor(
        &self,
        session_id: &str,
        cwd: &str,
        permission: PermissionPreset,
    ) -> Result<ToolExecutor, String>;

    /// Release factory-owned resources that outlive one Tool batch, such as
    /// persistent PTYs. Stateless factories keep the default no-op.
    async fn shutdown(&self) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NoTools;

#[async_trait]
impl SessionToolFactory for NoTools {
    async fn executor(
        &self,
        _session_id: &str,
        _cwd: &str,
        _permission: PermissionPreset,
    ) -> Result<ToolExecutor, String> {
        Ok(ToolExecutor::new(Arc::new(ToolRegistry::new())))
    }
}

/// In-memory baseline Host. The state model is intentionally explicit so a
/// durable implementation can replace the store without changing the Web API.
#[derive(Clone)]
pub struct BasicHost {
    pub(crate) config: HostConfig,
    pub(crate) agent_runtime: Arc<dyn AgentRuntime>,
    pub(crate) state: Arc<RwLock<state::HostState>>,
    pub(crate) control_store: Arc<dyn ControlStore>,
    pub(crate) control_gate: Arc<Mutex<()>>,
    pub(crate) mux_tx: broadcast::Sender<ServerRequest>,
    pub(crate) host_tx: broadcast::Sender<ServerRequest>,
    pub(crate) questions: Arc<DurableQuestionHub>,
    admission_gates: Arc<Mutex<std::collections::HashMap<String, Arc<Mutex<()>>>>>,
    background_listener_started: Arc<AtomicBool>,
    next_id: Arc<AtomicU64>,
}

impl BasicHost {
    pub fn new(
        config: HostConfig,
        provider: Option<Arc<dyn ModelProvider>>,
        tool_factory: Arc<dyn SessionToolFactory>,
    ) -> Arc<Self> {
        Self::new_with_context_policy(
            config,
            provider,
            tool_factory,
            Arc::new(IdentityContextPolicy),
        )
    }

    /// Build a Host around replaceable model, tool and context capabilities.
    /// Native OS composition belongs in `xharness-host-app`, not this control
    /// plane library.
    pub fn new_with_context_policy(
        config: HostConfig,
        provider: Option<Arc<dyn ModelProvider>>,
        tool_factory: Arc<dyn SessionToolFactory>,
        context_policy: Arc<dyn ContextPolicy>,
    ) -> Arc<Self> {
        let agent_runtime = Arc::new(
            LoopAgentRuntime::new(
                config.provider_id.clone(),
                config.model_id.clone(),
                provider,
                tool_factory,
                context_policy,
            )
            .with_token_guard(config.token_guard.clone()),
        );
        Self::with_agent_runtime(config, agent_runtime)
    }

    /// Primary constructor for alternative durable or remote Agent runtimes.
    /// The Host owns only Web-facing state and projections.
    pub fn with_agent_runtime(
        config: HostConfig,
        agent_runtime: Arc<dyn AgentRuntime>,
    ) -> Arc<Self> {
        Self::with_agent_runtime_and_control_store(
            config,
            agent_runtime,
            Arc::new(MemoryControlStore::default()),
        )
    }

    /// Compose an Agent runtime with an independently durable Host-global
    /// control log. Production uses JSONL; embedded callers may use the
    /// in-memory implementation while preserving identical mutation semantics.
    pub fn with_agent_runtime_and_control_store(
        config: HostConfig,
        agent_runtime: Arc<dyn AgentRuntime>,
        control_store: Arc<dyn ControlStore>,
    ) -> Arc<Self> {
        Self::with_agent_runtime_control_and_questions(
            config,
            agent_runtime,
            control_store,
            DurableQuestionHub::unavailable(),
        )
    }

    /// Compose the Host with the same durable question hub used by its
    /// session-scoped Tool factory.
    pub fn with_agent_runtime_control_and_questions(
        config: HostConfig,
        agent_runtime: Arc<dyn AgentRuntime>,
        control_store: Arc<dyn ControlStore>,
        questions: Arc<DurableQuestionHub>,
    ) -> Arc<Self> {
        let capacity = config.event_capacity.max(16);
        let (mux_tx, _) = broadcast::channel(capacity);
        let (host_tx, _) = broadcast::channel(capacity);
        Arc::new(Self {
            state: Arc::new(RwLock::new(state::HostState::new(&config))),
            config,
            agent_runtime,
            control_store,
            control_gate: Arc::new(Mutex::new(())),
            mux_tx,
            host_tx,
            questions,
            admission_gates: Arc::new(Mutex::new(std::collections::HashMap::new())),
            background_listener_started: Arc::new(AtomicBool::new(false)),
            next_id: Arc::new(AtomicU64::new(1)),
        })
    }

    pub fn without_provider(config: HostConfig) -> Arc<Self> {
        Self::new(config, None, Arc::new(NoTools))
    }

    pub(crate) fn mint_id(&self, prefix: &str) -> String {
        let ordinal = self.next_id.fetch_add(1, Ordering::Relaxed);
        format!("{prefix}-{}-{ordinal}", state::now_ms())
    }

    pub(crate) async fn lock_admission(&self, session_id: &str) -> OwnedMutexGuard<()> {
        let gate = {
            let mut gates = self.admission_gates.lock().await;
            Arc::clone(
                gates
                    .entry(session_id.to_owned())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        gate.lock_owned().await
    }

    pub(crate) fn push_mux(&self, payload: Value) {
        if let Ok(frame) = ServerRequest::frame(RpcId::new(self.mint_id("push")), payload) {
            let _ = self.mux_tx.send(frame);
        }
    }

    pub(crate) fn push_mux_correlated(&self, rpc_id: RpcId, payload: Value) {
        if let Ok(frame) = ServerRequest::frame(rpc_id, payload) {
            let _ = self.mux_tx.send(frame);
        }
    }

    pub(crate) fn push_host(&self, payload: Value) {
        if let Ok(frame) = ServerRequest::frame(RpcId::new(self.mint_id("host")), payload) {
            let _ = self.host_tx.send(frame);
        }
    }

    pub async fn snapshot(&self) -> Value {
        let state = self.state.read().await;
        json!({
            "sessions": state.sessions.values().collect::<Vec<_>>(),
            "workspaces": state.workspace_order.iter()
                .filter_map(|id| state.workspaces.get(id)).collect::<Vec<_>>(),
            "archivedSessionIds": state.archived_sessions,
        })
    }
}

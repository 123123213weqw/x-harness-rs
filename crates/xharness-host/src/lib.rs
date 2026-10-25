//! Stateful, Web-compatible XHarness host.
//!
//! This crate is the first functional implementation behind the transport
//! contract: every upstream RPC method has a validated baseline behavior,
//! while session prompts are driven by the provider-neutral Rust loop.

// Keep only weak references in the index. An active guard (or a task waiting
// for that guard) owns the strong Arc; completed one-shot operations such as
// `agent-operation:*` must not leave a permanent map entry.
type SessionGateMap =
    Arc<Mutex<std::collections::HashMap<(String, bool), std::sync::Weak<Mutex<()>>>>>;

mod approval_review;
mod automation;
mod bootstrap;
pub use bootstrap::{prepare_goal_session, GoalBootstrapReceipt, GoalBootstrapSpec};
mod control;
mod credential_processor;
mod delegation;
mod delegation_concurrency;
#[cfg(test)]
mod gate_tests;
mod goal_edit_tool;
mod goal_processor;
mod goal_report_tool;
mod goals;
mod history_tool;
mod instructions;
mod memory;

pub mod job_continuation;
pub use delegation::AgentTool;
pub use delegation_concurrency::DelegationConcurrency;
pub use memory::{MemoryMode, GLOBAL_MEMORY_URI, MEMORY_MAX_BYTES, MEMORY_URI};
mod display;
mod driver;
mod event_gateway;
mod execution;
pub use execution::ExecutionGate;
mod context_selection;
#[cfg(test)]
mod failed_turn_projection_tests;
mod github_backend;
mod github_review;
mod model_processor;
mod model_settings;
mod web_search_settings;
pub use web_search_settings::{
    WebSearchSettings, DEEPSEEK_SEARCH_CREDENTIAL, WEB_SEARCH_SETTINGS_NAMESPACE,
};
#[cfg(test)]
mod permission_tests;
mod plugin_backend;
pub use github_backend::GitHubBackend;
mod model_settings_layers;
mod preference_settings;
mod preset_processor;
mod questions;
mod restore;
mod restore_checkpoint;
mod rpc;
mod runtime;
mod session_processor;
mod settings_processor;
pub use model_settings_layers::merge_model_layers;
mod state;
#[cfg(test)]
mod statecheck;
mod subagent_processor;
mod swarm_processor;
mod swarm_tasks;
mod titles;
mod workspace_processor;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::sync::{Mutex, OwnedMutexGuard, RwLock};
use tokio_util::sync::CancellationToken;
use xharness_api::RpcId;
use xharness_control::{ControlStore, MemoryControlStore};
use xharness_core::{ContextPolicy, IdentityContextPolicy, ModelProvider};
use xharness_token::TokenGuard;
use xharness_tools::{ToolExecutor, ToolRegistry};

pub use model_settings::{
    automatic_minimum_output_tokens, inherit_model_capabilities, model_settings_schema,
    parse_model_settings, valid_credential_reference, ConfiguredModel, ModelSettingsBackend,
    ModelSettingsDocument, ProviderProfile, MODEL_SETTINGS_NAMESPACE,
};
pub use plugin_backend::PluginBackend;
pub use questions::{
    managed_agent_memory, DurableQuestionHub, DurableQuestionProvider, QuestionHubError,
    AGENT_MEMORY_BEGIN, AGENT_MEMORY_END,
};
pub use restore::{HostRestoreError, HostRestoreIssue, HostRestoreReport, RecoveryPolicy};
pub use runtime::{
    AgentResumeReport, AgentRuntime, AgentRuntimeError, AgentSessionRequest, AgentTurnRequest,
    AuxiliaryModel, DurableLoopAgentRuntime, LoopAgentRuntime, ModelDescriptor, ModelReasoning,
    ModelReasoningEffort, ModelRegistry, ModelRegistryError, ModelRoute, RegisteredModel,
    RunningTurn,
};
pub use state::{AgentPreset, GoalState, PermissionPreset, SessionRecord, WorkspaceRecord};

/// Host process configuration visible at the browser boundary.
#[derive(Clone, Debug)]
pub struct HostConfig {
    /// Local profile-global and workspace memory, outside Git. Embeddings opt in explicitly.
    pub memory_dir: Option<PathBuf>,
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
    /// Explicit default-route soft window (not inferred from a token guard).
    pub selected_context_window_tokens: Option<u64>,
    /// Enabled by the native app composition; embeddings opt in explicitly.
    pub auto_titles: bool,
    pub attachment_store: Arc<dyn xharness_attachments::AttachmentStore>,
    pub event_capacity: usize,
    /// Maximum number of projected Session events retained in Host memory for
    /// a durable session. Older history remains queryable from the append-only
    /// Session store through `session.history`.
    pub session_event_cache_capacity: usize,
    /// Serialized byte budget for the same durable projection tail. A single
    /// event larger than this budget is delivered live and remains durable,
    /// but is not pinned in Host memory.
    pub session_event_cache_bytes: usize,
    /// Shared estimated-resident-byte ceiling across durable display tails. This is not
    /// an RSS limit; snapshots, running tools and provider inputs are separate.
    /// Zero disables resident display tails without deleting durable history.
    pub session_event_cache_total_bytes: usize,
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
            memory_dir: None,
            cwd,
            home,
            version: env!("CARGO_PKG_VERSION").to_owned(),
            provider_id: "openai-compatible".to_owned(),
            provider_display_name: "OpenAI compatible".to_owned(),
            model_id: "unconfigured".to_owned(),
            reasoning_effort: None,
            token_guard: None,
            selected_context_window_tokens: None,
            auto_titles: false,
            attachment_store: Arc::new(xharness_attachments::MemoryAttachmentStore::default()),
            event_capacity: 2_048,
            session_event_cache_capacity: 2_048,
            session_event_cache_bytes: 16 * 1024 * 1024,
            session_event_cache_total_bytes: 64 * 1024 * 1024,
        }
    }
}

#[async_trait]
pub trait SessionToolFactory: Send + Sync + 'static {
    /// Execution inspection is separate from tool/model admission. Factories
    /// expose only jobs owned by the authenticated session.
    async fn process_runs(
        &self,
        _session_id: &str,
    ) -> Result<Vec<xharness_jobs::protocol::JobRun>, String> {
        Ok(Vec::new())
    }
    async fn process_output(
        &self,
        _session_id: &str,
        _id: &str,
        _cursor: xharness_jobs::JobOutputCursor,
    ) -> Result<xharness_jobs::JobRead, String> {
        Err("process output unavailable".into())
    }
    async fn cancel_process_run(&self, _session_id: &str, _id: &str) -> Result<(), String> {
        Err("process cancellation unavailable".into())
    }
    async fn executor(
        &self,
        session_id: &str,
        cwd: &str,
        permission: PermissionPreset,
    ) -> Result<ToolExecutor, String>;

    /// Fixed read-only Git operation; no shell or model-selected argv.
    async fn read_display_diff(
        &self,
        _session_id: &str,
        _cwd: &str,
        _path: &std::path::Path,
        _scope: xharness_api::display::GitDiffScope,
        _cancellation: CancellationToken,
    ) -> Result<xharness_api::display::DisplayFile, String> {
        Err("Git diff display is unavailable on this deployment".into())
    }

    /// Bounded, permission-aware read-only preview; non-native deployments fail closed.
    async fn inspect_display_file(
        &self,
        _session_id: &str,
        _cwd: &str,
        _permission: PermissionPreset,
        _path: &std::path::Path,
        _thumbnail: bool,
    ) -> Result<xharness_api::display::DisplayInspection, String> {
        Err("File inspection is unavailable on this deployment".into())
    }

    async fn read_display_file(
        &self,
        _session_id: &str,
        _cwd: &str,
        _permission: PermissionPreset,
        _path: &std::path::Path,
    ) -> Result<xharness_api::display::DisplayFile, String> {
        Err("file display is unavailable on this deployment".into())
    }

    /// Deployment composition policy for tools injected by Host itself.
    /// Defaults preserve production behavior; restrictions must cover this
    /// second registration seam as well as factory-owned tools.
    fn allows_host_tool(&self, _name: &str) -> bool {
        true
    }

    /// Validate deployment requirements after all factory and Host-owned tools
    /// have been registered, before a turn can call the model provider.
    async fn validate_executor(&self, _executor: &ToolExecutor) -> Result<(), String> {
        Ok(())
    }

    /// Admission-only existence and owner checks for model-supplied Goal resources.
    /// Readiness is separate: a stopped/failed resource can be valid evidence of
    /// a blocker. Stateless factories fail closed for resources they cannot resolve.
    async fn validate_goal_references(
        &self,
        _session_id: &str,
        references: &[xharness_session::goal::GoalEvidence],
    ) -> Result<(), String> {
        if references.iter().any(|reference| {
            matches!(
                reference,
                xharness_session::goal::GoalEvidence::Agent { .. }
                    | xharness_session::goal::GoalEvidence::Job { .. }
            )
        }) {
            return Err("Goal resource reference validation is unavailable".into());
        }
        Ok(())
    }

    async fn goal_dependencies(
        &self,
        _session_id: &str,
        _references: &[xharness_session::goal::GoalEvidence],
    ) -> Result<bool, String> {
        Ok(false)
    }

    /// Release session-scoped caches after its actor has been permanently
    /// retired. Do not shut down shared services or unrelated conversations.
    async fn release_session(&self, _session_id: &str) -> Result<(), String> {
        Ok(())
    }

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
    pub(crate) lazy_store: Arc<std::sync::OnceLock<Arc<dyn xharness_session::Store>>>,
    pub(crate) lazy_headers:
        Arc<RwLock<std::collections::HashMap<String, xharness_session::SessionHeader>>>,
    pub(crate) lazy_restore_gates:
        Arc<Mutex<std::collections::HashMap<String, std::sync::Weak<Mutex<()>>>>>,
    pub(crate) event_gateway: event_gateway::EventGateway,
    pub(crate) questions: Arc<DurableQuestionHub>,
    instructions: instructions::InstructionLoader,
    memory: Arc<memory::MemoryStore>,
    memory_slots: Arc<tokio::sync::Semaphore>,
    pub(crate) model_settings: Arc<std::sync::OnceLock<Arc<dyn ModelSettingsBackend>>>,
    pub(crate) plugins: Arc<std::sync::OnceLock<Arc<dyn PluginBackend>>>,
    pub(crate) github: Arc<std::sync::OnceLock<Arc<dyn GitHubBackend>>>,
    admission_gates: SessionGateMap,
    projection_gates: Arc<Mutex<std::collections::HashMap<String, std::sync::Weak<Mutex<()>>>>>,
    background_listener_started: Arc<AtomicBool>,
    background_listener_lifetime: Arc<driver::BackgroundListenerLifetime>,
    next_id: Arc<AtomicU64>,
    delegation_listener_started: Arc<AtomicBool>,
    title_work: Arc<titles::TitleWork>,
    review_work: Arc<github_review::ReviewWork>,
    self_ref: Arc<std::sync::OnceLock<std::sync::Weak<BasicHost>>>,
    approval_review_slots: Arc<tokio::sync::Semaphore>,
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
        let event_gateway = event_gateway::EventGateway::new(capacity);
        let host = Arc::new(Self {
            state: Arc::new(RwLock::new(state::HostState::new(&config))),
            config,
            agent_runtime,
            control_store,
            control_gate: Arc::new(Mutex::new(())),
            lazy_store: Arc::new(std::sync::OnceLock::new()),
            lazy_headers: Arc::new(RwLock::new(std::collections::HashMap::new())),
            lazy_restore_gates: Arc::new(Mutex::new(std::collections::HashMap::new())),
            event_gateway,
            questions,
            instructions: instructions::InstructionLoader::default(),
            memory: Arc::new(memory::MemoryStore::default()),
            memory_slots: Arc::new(tokio::sync::Semaphore::new(4)),
            model_settings: Arc::new(std::sync::OnceLock::new()),
            plugins: Arc::new(std::sync::OnceLock::new()),
            github: Arc::new(std::sync::OnceLock::new()),
            review_work: Arc::new(github_review::ReviewWork::default()),
            admission_gates: Arc::new(Mutex::new(std::collections::HashMap::new())),
            projection_gates: Arc::new(Mutex::new(std::collections::HashMap::new())),
            background_listener_started: Arc::new(AtomicBool::new(false)),
            background_listener_lifetime: Arc::new(driver::BackgroundListenerLifetime::default()),
            next_id: Arc::new(AtomicU64::new(1)),
            delegation_listener_started: Arc::new(AtomicBool::new(false)),
            title_work: Arc::new(titles::TitleWork::default()),
            self_ref: Arc::new(std::sync::OnceLock::new()),
            approval_review_slots: Arc::new(tokio::sync::Semaphore::new(4)),
        });
        let _ = host.self_ref.set(Arc::downgrade(&host));
        host.questions.bind_host(Arc::downgrade(&host));
        host.agent_runtime.bind_host(Arc::downgrade(&host));
        host
    }

    pub fn without_provider(config: HostConfig) -> Arc<Self> {
        Self::new(config, None, Arc::new(NoTools))
    }

    pub(crate) fn mint_id(&self, prefix: &str) -> String {
        let ordinal = self.next_id.fetch_add(1, Ordering::Relaxed);
        format!("{prefix}-{}-{ordinal}", state::now_ms())
    }

    pub(crate) async fn lock_admission(&self, session_id: &str) -> OwnedMutexGuard<()> {
        self.lock_session_gate(session_id, false).await
    }

    /// Separate lane: turn factories must never wait on a control/admission
    /// lock whose holder may be waiting for that same agent to acknowledge.
    pub(crate) async fn lock_permission_selection(&self, session_id: &str) -> OwnedMutexGuard<()> {
        self.lock_session_gate(session_id, true).await
    }

    async fn lock_session_gate(&self, session_id: &str, permission: bool) -> OwnedMutexGuard<()> {
        let gate = {
            let mut gates = self.admission_gates.lock().await;
            // Prune expired keys before inserting. The map is normally tiny;
            // unlike a size threshold, this also bounds sequential invalid IDs.
            gates.retain(|_, gate| gate.strong_count() > 0);
            let key = (session_id.to_owned(), permission);
            match gates.get(&key).and_then(std::sync::Weak::upgrade) {
                Some(gate) => gate,
                None => {
                    let gate = Arc::new(Mutex::new(()));
                    gates.insert(key, Arc::downgrade(&gate));
                    gate
                }
            }
        };
        gate.lock_owned().await
    }

    pub(crate) async fn lock_projection(&self, session_id: &str) -> OwnedMutexGuard<()> {
        let gate = {
            let mut gates = self.projection_gates.lock().await;
            gates.retain(|_, gate| gate.strong_count() > 0);
            match gates.get(session_id).and_then(std::sync::Weak::upgrade) {
                Some(gate) => gate,
                None => {
                    let gate = Arc::new(Mutex::new(()));
                    gates.insert(session_id.to_owned(), Arc::downgrade(&gate));
                    gate
                }
            }
        };
        gate.lock_owned().await
    }

    pub(crate) fn push_mux(&self, payload: Value) {
        self.event_gateway
            .publish_mux(RpcId::new(self.mint_id("push")), payload);
    }

    pub(crate) fn push_mux_correlated(&self, rpc_id: RpcId, payload: Value) {
        self.event_gateway.publish_mux(rpc_id, payload);
    }

    pub(crate) fn push_host(&self, payload: Value) {
        self.event_gateway
            .publish_host(RpcId::new(self.mint_id("host")), payload);
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

impl BasicHost {
    pub fn attachment_store(&self) -> Arc<dyn xharness_attachments::AttachmentStore> {
        self.config.attachment_store.clone()
    }
    pub async fn session_accepts_images(&self, id: &str) -> bool {
        let state = self.state.read().await;
        let Some(s) = state.sessions.get(id) else {
            return false;
        };
        if let Some(model) = self
            .agent_runtime
            .model_catalog()
            .iter()
            .find(|model| model.provider == s.model.provider && model.model == s.model.model)
        {
            return model.image_input == Some(true);
        }
        // Compatibility for runtimes without descriptors. Unknown is not permission.
        state
            .settings
            .get(crate::MODEL_SETTINGS_NAMESPACE)
            .and_then(|ns| ns.value["providers"][&s.model.provider]["models"].as_array())
            .and_then(|ms| ms.iter().find(|m| m["id"].as_str() == Some(&s.model.model)))
            .and_then(|m| m["imageInput"].as_bool())
            == Some(true)
    }
}

mod admission_cache;

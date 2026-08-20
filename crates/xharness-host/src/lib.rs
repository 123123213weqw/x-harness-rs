//! Stateful, Web-compatible XHarness host.
//!
//! This crate is the first functional implementation behind the transport
//! contract: every upstream RPC method has a validated baseline behavior,
//! while session prompts are driven by the provider-neutral Rust loop.

mod driver;
mod native;
mod rpc;
mod state;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::sync::{broadcast, RwLock};
use xharness_api::{RpcId, ServerRequest};
use xharness_core::{ModelProvider, ToolSpec};

pub use native::NativeToolFactory;
pub use state::{AgentPreset, GoalState, SessionRecord, WorkspaceRecord};

/// Host process configuration visible at the browser boundary.
#[derive(Clone, Debug)]
pub struct HostConfig {
    pub cwd: PathBuf,
    pub home: PathBuf,
    pub version: String,
    pub provider_id: String,
    pub provider_display_name: String,
    pub model_id: String,
    pub event_capacity: usize,
}

impl HostConfig {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        let cwd = cwd.into();
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| cwd.clone());
        Self {
            cwd,
            home,
            version: env!("CARGO_PKG_VERSION").to_owned(),
            provider_id: "openai-compatible".to_owned(),
            provider_display_name: "OpenAI compatible".to_owned(),
            model_id: "unconfigured".to_owned(),
            event_capacity: 2_048,
        }
    }
}

#[async_trait]
pub trait SessionToolFactory: Send + Sync + 'static {
    async fn tools(&self, session_id: &str, cwd: &str) -> Result<Vec<ToolSpec>, String>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NoTools;

#[async_trait]
impl SessionToolFactory for NoTools {
    async fn tools(&self, _session_id: &str, _cwd: &str) -> Result<Vec<ToolSpec>, String> {
        Ok(Vec::new())
    }
}

/// In-memory baseline Host. The state model is intentionally explicit so a
/// durable implementation can replace the store without changing the Web API.
#[derive(Clone)]
pub struct BasicHost {
    pub(crate) config: HostConfig,
    pub(crate) provider: Option<Arc<dyn ModelProvider>>,
    pub(crate) tool_factory: Arc<dyn SessionToolFactory>,
    pub(crate) state: Arc<RwLock<state::HostState>>,
    pub(crate) mux_tx: broadcast::Sender<ServerRequest>,
    pub(crate) host_tx: broadcast::Sender<ServerRequest>,
    next_id: Arc<AtomicU64>,
}

impl BasicHost {
    pub fn new(
        config: HostConfig,
        provider: Option<Arc<dyn ModelProvider>>,
        tool_factory: Arc<dyn SessionToolFactory>,
    ) -> Arc<Self> {
        let capacity = config.event_capacity.max(16);
        let (mux_tx, _) = broadcast::channel(capacity);
        let (host_tx, _) = broadcast::channel(capacity);
        Arc::new(Self {
            state: Arc::new(RwLock::new(state::HostState::new(&config))),
            config,
            provider,
            tool_factory,
            mux_tx,
            host_tx,
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

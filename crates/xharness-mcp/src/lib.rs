//! MCP stdio client boundary. Plugin package validation and user authorization
//! live above this crate; rmcp owns wire framing and protocol negotiation.

use process_wrap::tokio::CommandWrap;
use rmcp::{
    model::CallToolRequestParams, service::RunningService, transport::TokioChildProcess,
    RoleClient, ServiceExt,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    process::Command,
    sync::Mutex,
    time::{timeout, Instant},
};
use tokio_util::sync::CancellationToken;

const START_TIMEOUT: Duration = Duration::from_secs(20);
const CALL_TIMEOUT: Duration = Duration::from_secs(45);
const STOP_TIMEOUT: Duration = Duration::from_secs(6);
const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const IDLE_SWEEP_INTERVAL: Duration = Duration::from_secs(60);
const MAX_TOOLS: usize = 64;
const MAX_TOOL_SCHEMA: usize = 32 * 1024;
const MAX_RESULT: usize = 64 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error("invalid MCP configuration: {0}")]
    Invalid(String),
    #[error("MCP server unavailable: {0}")]
    Unavailable(String),
    #[error("MCP operation timed out")]
    Timeout,
    #[error("MCP tool result exceeds 64 KiB")]
    ResultTooLarge,
}

#[derive(Clone, Debug)]
pub struct StdioServerConfig {
    pub plugin: String,
    pub server: String,
    pub digest: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub plugin: String,
    pub server: String,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

type Client = RunningService<RoleClient, ()>;
type Slot = Arc<Mutex<Option<Arc<Connection>>>>;
struct Connection {
    digest: String,
    client: Mutex<Client>,
    tools: Vec<McpTool>,
    cancelled: CancellationToken,
    last_used: std::sync::Mutex<Instant>,
}

impl Connection {
    fn touch(&self) {
        *self.last_used.lock().expect("MCP idle clock poisoned") = Instant::now();
    }
}

/// Connections are scoped to a chat/session, not shared between agents.
/// A dropped runtime closes its rmcp transports; explicit disconnect awaits
/// process-group / Windows Job Object cleanup.
pub struct McpRuntime {
    connections: Mutex<BTreeMap<(String, String, String), Slot>>,
    plugin_leases: Mutex<BTreeMap<String, CancellationToken>>,
    idle_timeout: Duration,
    call_timeout: Duration,
}

impl Default for McpRuntime {
    fn default() -> Self {
        Self {
            connections: Mutex::new(BTreeMap::new()),
            plugin_leases: Mutex::new(BTreeMap::new()),
            idle_timeout: IDLE_TIMEOUT,
            call_timeout: CALL_TIMEOUT,
        }
    }
}

impl McpRuntime {
    pub fn new() -> Arc<Self> {
        Self::with_idle_timeout(IDLE_TIMEOUT)
    }

    /// Idle stdio children are closed, but their chats can reconnect on demand.
    pub fn with_idle_timeout(idle_timeout: Duration) -> Arc<Self> {
        Self::with_timeouts(idle_timeout, CALL_TIMEOUT)
    }

    /// Bounds can be shortened by tests or deployments with stricter limits.
    pub fn with_timeouts(idle_timeout: Duration, call_timeout: Duration) -> Arc<Self> {
        let idle_timeout = idle_timeout.max(Duration::from_millis(10));
        let call_timeout = call_timeout.max(Duration::from_millis(10));
        let runtime = Arc::new(Self {
            idle_timeout,
            call_timeout,
            ..Self::default()
        });
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let weak = Arc::downgrade(&runtime);
            handle.spawn(async move {
                let interval_duration = IDLE_SWEEP_INTERVAL.min(idle_timeout / 2);
                let mut interval = tokio::time::interval(interval_duration);
                interval.tick().await;
                loop {
                    interval.tick().await;
                    let Some(runtime) = weak.upgrade() else { break };
                    runtime.close_idle(runtime.idle_timeout).await;
                }
            });
        }
        runtime
    }

    /// Capture before checking the plugin manager's enabled state. Revocation
    /// cancels this lease, so a stale configuration cannot launch afterwards.
    pub async fn lease(&self, plugin: &str) -> CancellationToken {
        let mut leases = self.plugin_leases.lock().await;
        leases.entry(plugin.to_owned()).or_default().clone()
    }

    pub async fn list_tools(
        &self,
        owner: &str,
        config: &StdioServerConfig,
    ) -> Result<Vec<McpTool>, McpError> {
        let lease = self.lease(&config.plugin).await;
        self.list_tools_with_lease(owner, config, &lease).await
    }

    pub async fn list_tools_with_lease(
        &self,
        owner: &str,
        config: &StdioServerConfig,
        lease: &CancellationToken,
    ) -> Result<Vec<McpTool>, McpError> {
        let connection = self.ensure_connected(owner, config, lease).await?;
        connection.touch();
        Ok(connection.tools.clone())
    }

    pub async fn call_tool(
        &self,
        owner: &str,
        config: &StdioServerConfig,
        name: &str,
        arguments: Map<String, Value>,
    ) -> Result<Value, McpError> {
        let lease = self.lease(&config.plugin).await;
        self.call_tool_with_lease(owner, config, name, arguments, &lease)
            .await
    }

    pub async fn call_tool_with_lease(
        &self,
        owner: &str,
        config: &StdioServerConfig,
        name: &str,
        arguments: Map<String, Value>,
        lease: &CancellationToken,
    ) -> Result<Value, McpError> {
        let connection = self.ensure_connected(owner, config, lease).await?;
        if !connection.tools.iter().any(|tool| tool.name == name) {
            return Err(McpError::Invalid(format!("unknown server tool {name}")));
        }
        connection.touch();
        let client = connection.client.lock().await;
        let result = tokio::select! {
            result = timeout(self.call_timeout, client.call_tool(CallToolRequestParams::new(name.to_owned()).with_arguments(arguments))) => {
                match result {
                    Ok(Ok(value)) => Ok(value),
                    Ok(Err(error)) => Err(McpError::Unavailable(error.to_string())),
                    Err(_) => Err(McpError::Timeout),
                }
            }
            _ = connection.cancelled.cancelled() => Err(McpError::Unavailable("MCP connection revoked".into())),
            _ = lease.cancelled() => Err(McpError::Unavailable("MCP plugin was disabled".into())),
        };
        drop(client);
        if matches!(&result, Err(McpError::Timeout)) {
            connection.cancelled.cancel();
            self.disconnect_connection(owner, config, &connection).await;
        }
        let result = result?;
        connection.touch();
        let result =
            serde_json::to_value(result).map_err(|e| McpError::Unavailable(e.to_string()))?;
        if result.to_string().len() > MAX_RESULT {
            return Err(McpError::ResultTooLarge);
        }
        Ok(result)
    }

    pub async fn disconnect_plugin(&self, plugin: &str) {
        // Fence calls which have already read the old enabled configuration.
        // The next enablement receives a fresh, non-cancelled lease.
        {
            let mut leases = self.plugin_leases.lock().await;
            if let Some(lease) = leases.remove(plugin) {
                lease.cancel();
            }
        }
        let removed = {
            let mut connections = self.connections.lock().await;
            let keys = connections
                .keys()
                .filter(|(_, name, _)| name == plugin)
                .cloned()
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| connections.remove(&key))
                .collect::<Vec<_>>()
        };
        Self::close_slots(removed).await;
    }

    pub async fn disconnect_owner(&self, owner: &str) {
        let removed = {
            let mut connections = self.connections.lock().await;
            let keys = connections
                .keys()
                .filter(|(id, _, _)| id == owner)
                .cloned()
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| connections.remove(&key))
                .collect::<Vec<_>>()
        };
        Self::close_slots(removed).await;
    }

    async fn disconnect_connection(
        &self,
        owner: &str,
        config: &StdioServerConfig,
        connection: &Arc<Connection>,
    ) {
        let key = (
            owner.to_owned(),
            config.plugin.clone(),
            config.server.clone(),
        );
        let slot = { self.connections.lock().await.get(&key).cloned() };
        if let Some(slot) = slot {
            let mut current = slot.lock().await;
            if current
                .as_ref()
                .is_some_and(|item| Arc::ptr_eq(item, connection))
            {
                let old = current.take().expect("connection was just checked");
                old.cancelled.cancel();
                let mut client = old.client.lock().await;
                let _ = timeout(STOP_TIMEOUT, client.close()).await;
            }
        }
    }

    async fn close_idle(&self, max_idle: Duration) {
        let slots = {
            self.connections
                .lock()
                .await
                .values()
                .cloned()
                .collect::<Vec<_>>()
        };
        for slot in slots {
            let Ok(mut current) = slot.try_lock() else {
                continue;
            };
            let stale = current.as_ref().is_some_and(|connection| {
                Arc::strong_count(connection) == 1
                    && connection
                        .last_used
                        .lock()
                        .expect("MCP idle clock poisoned")
                        .elapsed()
                        >= max_idle
            });
            if stale {
                if let Some(connection) = current.take() {
                    connection.cancelled.cancel();
                    let mut client = connection.client.lock().await;
                    let _ = timeout(STOP_TIMEOUT, client.close()).await;
                }
            }
        }
    }

    /// Close every session-scoped child before the Host exits. A server must
    /// not survive merely because its plugin remains enabled on disk.
    pub async fn shutdown(&self) {
        let slots = {
            let mut connections = self.connections.lock().await;
            std::mem::take(&mut *connections)
                .into_values()
                .collect::<Vec<_>>()
        };
        Self::close_slots(slots).await;
    }

    async fn close_slots(slots: Vec<Slot>) {
        for slot in slots {
            if let Some(connection) = slot.lock().await.take() {
                connection.cancelled.cancel();
                let mut client = connection.client.lock().await;
                let _ = timeout(STOP_TIMEOUT, client.close()).await;
            }
        }
    }

    async fn ensure_connected(
        &self,
        owner: &str,
        config: &StdioServerConfig,
        lease: &CancellationToken,
    ) -> Result<Arc<Connection>, McpError> {
        if lease.is_cancelled() {
            return Err(McpError::Unavailable("MCP plugin was disabled".into()));
        }
        if owner.is_empty() || config.plugin.is_empty() || config.server.is_empty() {
            return Err(McpError::Invalid(
                "owner, plugin and server are required".into(),
            ));
        }
        let key = (
            owner.to_owned(),
            config.plugin.clone(),
            config.server.clone(),
        );
        let slot = {
            let mut connections = self.connections.lock().await;
            Arc::clone(
                connections
                    .entry(key)
                    .or_insert_with(|| Arc::new(Mutex::new(None))),
            )
        };
        // Slow initialization of one server must not block unrelated chats.
        let mut current = slot.lock().await;
        if lease.is_cancelled() {
            return Err(McpError::Unavailable("MCP plugin was disabled".into()));
        }
        if let Some(connection) = current.as_ref() {
            if connection.digest == config.digest
                && !connection.cancelled.is_cancelled()
                && !connection.client.lock().await.is_closed()
            {
                return Ok(Arc::clone(connection));
            }
        }
        if let Some(old) = current.take() {
            old.cancelled.cancel();
            let mut client = old.client.lock().await;
            let _ = timeout(STOP_TIMEOUT, client.close()).await;
        }
        let connection = tokio::select! {
            _ = lease.cancelled() => return Err(McpError::Unavailable("MCP plugin was disabled".into())),
            result = connect(config) => Arc::new(result?),
        };
        if lease.is_cancelled() {
            connection.cancelled.cancel();
            let mut client = connection.client.lock().await;
            let _ = timeout(STOP_TIMEOUT, client.close()).await;
            return Err(McpError::Unavailable("MCP plugin was disabled".into()));
        }
        *current = Some(Arc::clone(&connection));
        Ok(connection)
    }
}

async fn connect(config: &StdioServerConfig) -> Result<Connection, McpError> {
    if config.command.is_empty() || config.args.len() > 64 || config.env.len() > 64 {
        return Err(McpError::Invalid(
            "invalid command, arguments or environment".into(),
        ));
    }
    let mut command = Command::new(&config.command);
    command
        .args(&config.args)
        .current_dir(&config.cwd)
        .env_clear();
    // The child never inherits arbitrary Host/provider secrets. Environment
    // references explicitly approved in the plugin config are added below.
    for key in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "TMPDIR",
        "TEMP",
        "TMP",
        "SystemRoot",
        "APPDATA",
        "LOCALAPPDATA",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command.envs(&config.env);
    let mut wrapped = CommandWrap::from(command);
    #[cfg(unix)]
    {
        wrapped.wrap(process_wrap::tokio::ProcessGroup::leader());
    }
    #[cfg(windows)]
    {
        wrapped.wrap(process_wrap::tokio::JobObject);
    }
    let transport =
        TokioChildProcess::new(wrapped).map_err(|e| McpError::Unavailable(e.to_string()))?;
    let mut client = timeout(START_TIMEOUT, ().serve(transport))
        .await
        .map_err(|_| McpError::Timeout)?
        .map_err(|e| McpError::Unavailable(e.to_string()))?;
    let listed = timeout(START_TIMEOUT, client.list_all_tools())
        .await
        .map_err(|_| McpError::Timeout)?
        .map_err(|e| McpError::Unavailable(e.to_string()))?;
    if listed.len() > MAX_TOOLS {
        let _ = timeout(STOP_TIMEOUT, client.close()).await;
        return Err(McpError::Invalid(
            "server exposes more than 64 tools".into(),
        ));
    }
    let mut tools = Vec::with_capacity(listed.len());
    for tool in listed {
        let schema = Value::Object((*tool.input_schema).clone());
        if schema.to_string().len() > MAX_TOOL_SCHEMA {
            let _ = timeout(STOP_TIMEOUT, client.close()).await;
            return Err(McpError::Invalid("MCP tool schema exceeds 32 KiB".into()));
        }
        tools.push(McpTool {
            plugin: config.plugin.clone(),
            server: config.server.clone(),
            name: tool.name.into_owned(),
            description: tool
                .description
                .map(|description| description.into_owned())
                .unwrap_or_default()
                .chars()
                .take(2000)
                .collect(),
            input_schema: schema,
        });
    }
    Ok(Connection {
        digest: config.digest.clone(),
        client: Mutex::new(client),
        tools,
        cancelled: CancellationToken::new(),
        last_used: std::sync::Mutex::new(Instant::now()),
    })
}

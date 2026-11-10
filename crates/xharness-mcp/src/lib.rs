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
    sync::{Mutex, RwLock},
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
// Image bytes are transient wire payload, not permission to enlarge text history.
const MAX_IMAGE_BASE64: usize = (8 * 1024 * 1024usize).div_ceil(3) * 4;

#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error("invalid MCP configuration: {0}")]
    Invalid(String),
    #[error("MCP server unavailable: {0}")]
    Unavailable(String),
    #[error("MCP operation timed out")]
    Timeout,
    #[error("MCP tool result exceeds its text or image byte budget")]
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
    #[serde(default, skip_serializing)]
    pub app_only: bool,
}

type Client = RunningService<RoleClient, ()>;
/// A visible editor pins only its own session connection against idle eviction.
/// Explicit plugin/session shutdown still revokes and closes the transport.
pub struct PanelPin {
    _connection: Arc<Connection>,
}
impl Drop for PanelPin {
    fn drop(&mut self) {
        self._connection
            .panels
            .fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}
impl PanelPin {
    pub fn set_interactive(&self, value: bool) -> Result<(), McpError> {
        let mut seen = self
            ._connection
            .ui_seen
            .lock()
            .map_err(|_| McpError::Unavailable("editor activity clock unavailable".into()))?;
        *seen = Instant::now();
        self._connection
            .interactive
            .store(value, std::sync::atomic::Ordering::Release);
        Ok(())
    }
    pub fn revoked(&self) -> bool {
        self._connection.cancelled.is_cancelled()
            || self
                ._connection
                .client
                .try_read()
                .is_ok_and(|client| client.is_closed())
    }
}
type Slot = Arc<Mutex<Option<Arc<Connection>>>>;
struct Connection {
    digest: String,
    client: RwLock<Client>,
    operations: Mutex<()>,
    panels: std::sync::atomic::AtomicUsize,
    interactive: std::sync::atomic::AtomicBool,
    ui_seen: std::sync::Mutex<Instant>,
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
    pub async fn panel_is_open(&self, owner: &str, plugin: &str, server: &str) -> bool {
        let slot = self
            .connections
            .lock()
            .await
            .get(&(owner.into(), plugin.into(), server.into()))
            .cloned();
        if let Some(slot) = slot {
            return slot.lock().await.as_ref().is_some_and(|c| {
                !c.cancelled.is_cancelled()
                    && !c.client.try_read().is_ok_and(|client| client.is_closed())
                    && c.panels.load(std::sync::atomic::Ordering::Acquire) > 0
            });
        }
        false
    }

    pub async fn panel_is_interactive(&self, owner: &str, plugin: &str, server: &str) -> bool {
        if !self.panel_is_open(owner, plugin, server).await {
            return false;
        }
        let slot = self
            .connections
            .lock()
            .await
            .get(&(owner.into(), plugin.into(), server.into()))
            .cloned();
        match slot {
            Some(slot) => slot.lock().await.as_ref().is_some_and(|c| {
                c.interactive.load(std::sync::atomic::Ordering::Acquire)
                    && c.ui_seen
                        .lock()
                        .is_ok_and(|seen| seen.elapsed() < Duration::from_secs(30))
            }),
            None => false,
        }
    }

    pub async fn pin_panel(
        &self,
        owner: &str,
        config: &StdioServerConfig,
    ) -> Result<PanelPin, McpError> {
        let lease = self.lease(&config.plugin).await;
        let connection = self.ensure_connected(owner, config, &lease).await?;
        connection
            .panels
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        Ok(PanelPin {
            _connection: connection,
        })
    }

    async fn panel_connection(
        &self,
        owner: &str,
        config: &StdioServerConfig,
    ) -> Result<Arc<Connection>, McpError> {
        let slot = self
            .connections
            .lock()
            .await
            .get(&(owner.into(), config.plugin.clone(), config.server.clone()))
            .cloned()
            .ok_or_else(|| McpError::Unavailable("editor is not open".into()))?;
        let connection = slot
            .lock()
            .await
            .clone()
            .filter(|c| {
                c.digest == config.digest
                    && !c.cancelled.is_cancelled()
                    && c.panels.load(std::sync::atomic::Ordering::Acquire) > 0
            })
            .ok_or_else(|| McpError::Unavailable("editor capability expired".into()))?;
        if connection.client.read().await.is_closed() {
            return Err(McpError::Unavailable(
                "editor disconnected; reopen explicitly".into(),
            ));
        }
        Ok(connection)
    }

    /// UI-only traffic never enters the model tool catalogue. This separate
    /// shared client read permits an app reply while a model call is waiting.
    pub async fn call_app_tool(
        &self,
        owner: &str,
        config: &StdioServerConfig,
        name: &str,
        arguments: Map<String, Value>,
    ) -> Result<Value, McpError> {
        let lease = self.lease(&config.plugin).await;
        let connection = self.panel_connection(owner, config).await?;
        if !connection
            .tools
            .iter()
            .any(|t| t.name == name && t.app_only)
        {
            return Err(McpError::Invalid("tool is not app-only".into()));
        }
        connection.touch();
        let client = connection.client.read().await;
        let result = tokio::select! {
            biased;
            _=lease.cancelled()=>return Err(McpError::Unavailable("plugin disabled".into())),
            _=connection.cancelled.cancelled()=>return Err(McpError::Unavailable("panel disconnected".into())),
            result=timeout(self.call_timeout,client.call_tool(CallToolRequestParams::new(name.to_owned()).with_arguments(arguments)))=>result.map_err(|_|McpError::Timeout)?.map_err(|e|McpError::Unavailable(e.to_string()))?,
        };
        connection.touch();
        let result =
            serde_json::to_value(result).map_err(|e| McpError::Unavailable(e.to_string()))?;
        if result.to_string().len() > 8 * 1024 * 1024 {
            return Err(McpError::ResultTooLarge);
        }
        Ok(result)
    }

    pub async fn read_app_resource(
        &self,
        owner: &str,
        config: &StdioServerConfig,
        uri: &str,
    ) -> Result<Value, McpError> {
        let lease = self.lease(&config.plugin).await;
        let connection = self.panel_connection(owner, config).await?;
        let client = connection.client.read().await;
        let result = tokio::select! {
            biased;
            _=lease.cancelled()=>return Err(McpError::Unavailable("plugin disabled".into())),
            _=connection.cancelled.cancelled()=>return Err(McpError::Unavailable("panel disconnected".into())),
            result=timeout(self.call_timeout,client.read_resource(rmcp::model::ReadResourceRequestParams::new(uri)))=>result.map_err(|_|McpError::Timeout)?.map_err(|e|McpError::Unavailable(e.to_string()))?,
        };
        let value =
            serde_json::to_value(result).map_err(|e| McpError::Unavailable(e.to_string()))?;
        if value.to_string().len() > 4 * 1024 * 1024 {
            return Err(McpError::ResultTooLarge);
        }
        connection.touch();
        Ok(value)
    }

    /// Fail rather than cancel a model operation to close a presentation tab.
    pub async fn close_panel(
        &self,
        owner: &str,
        config: &StdioServerConfig,
    ) -> Result<(), McpError> {
        let key = (
            owner.to_owned(),
            config.plugin.clone(),
            config.server.clone(),
        );
        let slot = self.connections.lock().await.get(&key).cloned();
        if let Some(slot) = slot {
            let mut current = slot.lock().await;
            if let Some(connection) = current.as_ref().cloned() {
                let _idle = connection.operations.try_lock().map_err(|_| {
                    McpError::Unavailable(
                        "an editor tool is still running; retry after completion".into(),
                    )
                })?;
                current.take();
                connection.cancelled.cancel();
                let mut client = connection.client.write().await;
                timeout(STOP_TIMEOUT, client.close())
                    .await
                    .map_err(|_| McpError::Timeout)?
                    .map_err(|e| McpError::Unavailable(e.to_string()))?;
            }
        }
        Ok(())
    }
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
        Ok(connection
            .tools
            .iter()
            .filter(|t| !t.app_only)
            .cloned()
            .collect())
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
        let _operation = connection.operations.lock().await;
        if connection.panels.load(std::sync::atomic::Ordering::Acquire) > 0
            && (!connection
                .interactive
                .load(std::sync::atomic::Ordering::Acquire)
                || !connection
                    .ui_seen
                    .lock()
                    .is_ok_and(|seen| seen.elapsed() < Duration::from_secs(30)))
        {
            return Err(McpError::Unavailable(
                "make the editor visible and ready before invoking tools".into(),
            ));
        }
        if !connection
            .tools
            .iter()
            .any(|tool| tool.name == name && !tool.app_only)
        {
            return Err(McpError::Invalid(format!("unknown server tool {name}")));
        }
        connection.touch();
        let client = connection.client.read().await;
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
        if matches!(&result, Err(McpError::Timeout))
            && connection.panels.load(std::sync::atomic::Ordering::Acquire) == 0
        {
            connection.cancelled.cancel();
            self.disconnect_connection(owner, config, &connection).await;
        }
        let result = result?;
        connection.touch();
        let result =
            serde_json::to_value(result).map_err(|e| McpError::Unavailable(e.to_string()))?;
        validate_result_budget(&result)?;
        Ok(result)
    }

    /// An editor stop cancels one protocol request, not its pinned document or
    /// other sessions using the same plugin. Only the UI-server path uses this
    /// single-round adapter; ordinary MCP/MRTR behavior is unchanged.
    pub async fn call_panel_tool_with_lease(
        &self,
        owner: &str,
        config: &StdioServerConfig,
        name: &str,
        arguments: Map<String, Value>,
        lease: &CancellationToken,
        cancellation: &CancellationToken,
    ) -> Result<Value, McpError> {
        use rmcp::{
            model::{
                CancelledNotification, CancelledNotificationParam, ClientRequest, Request,
                ServerResult,
            },
            service::PeerRequestOptions,
        };
        let connection = self.panel_connection(owner, config).await?;
        let _operation = tokio::select! {
            biased;
            _=cancellation.cancelled()=>return Err(McpError::Unavailable("editor call cancelled before dispatch; document unchanged".into())),
            _=lease.cancelled()=>return Err(McpError::Unavailable("plugin disabled".into())),
            _=connection.cancelled.cancelled()=>return Err(McpError::Unavailable("editor disconnected".into())),
            guard=connection.operations.lock()=>guard,
        };
        if !self
            .panel_is_interactive(owner, &config.plugin, &config.server)
            .await
        {
            return Err(McpError::Unavailable(
                "make the editor visible and ready before invoking tools".into(),
            ));
        }
        if !connection
            .tools
            .iter()
            .any(|t| t.name == name && !t.app_only)
        {
            return Err(McpError::Invalid("unknown editor model tool".into()));
        }
        if cancellation.is_cancelled()
            || lease.is_cancelled()
            || connection.cancelled.is_cancelled()
        {
            return Err(McpError::Unavailable(
                "editor call cancelled before dispatch; document unchanged".into(),
            ));
        }
        connection.touch();
        let client = connection.client.read().await;
        let handle = timeout(
            self.call_timeout,
            client.send_cancellable_request(
                ClientRequest::CallToolRequest(Request::new(
                    CallToolRequestParams::new(name.to_owned()).with_arguments(arguments),
                )),
                PeerRequestOptions::no_options(),
            ),
        )
        .await
        .map_err(|_| McpError::Timeout)?
        .map_err(|e| McpError::Unavailable(e.to_string()))?;
        let id = handle.id.clone();
        let (response, cancel_request) = tokio::select! {
            biased;
            _=cancellation.cancelled()=>(Err(McpError::Unavailable("editor call cancelled; outcome may be unknown, inspect before retrying".into())),true),
            _=lease.cancelled()=>(Err(McpError::Unavailable("plugin disabled".into())),false),
            _=connection.cancelled.cancelled()=>(Err(McpError::Unavailable("editor disconnected".into())),false),
            result=timeout(self.call_timeout,handle.await_response())=>match result {
                Ok(Ok(result))=>(Ok(result),false),
                Ok(Err(error))=>(Err(McpError::Unavailable(error.to_string())),false),
                Err(_)=>(Err(McpError::Timeout),true),
            },
        };
        if cancel_request {
            // Request ID is captured from this exact transport epoch. A late
            // stop cannot target a replacement connection or another editor.
            let notification = CancelledNotification::new(CancelledNotificationParam::new(
                Some(id),
                Some("editor operation cancelled".into()),
            ));
            timeout(STOP_TIMEOUT,client.send_notification(notification.into())).await
                .map_err(|_|McpError::Unavailable("editor cancel delivery timed out; outcome unknown, inspect before retrying".into()))?
                .map_err(|e|McpError::Unavailable(format!("editor cancel delivery failed; outcome unknown: {e}")))?;
        }
        connection.touch();
        match response? {
            ServerResult::CallToolResult(result) => {
                let result = serde_json::to_value(result)
                    .map_err(|e| McpError::Unavailable(e.to_string()))?;
                validate_result_budget(&result)?;
                Ok(result)
            }
            _ => Err(McpError::Unavailable(
                "unsupported editor tool response".into(),
            )),
        }
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
                let mut client = old.client.write().await;
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
                    let mut client = connection.client.write().await;
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
                let mut client = connection.client.write().await;
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
                && !connection.client.read().await.is_closed()
            {
                return Ok(Arc::clone(connection));
            }
        }
        if let Some(old) = current.take() {
            old.cancelled.cancel();
            let mut client = old.client.write().await;
            let _ = timeout(STOP_TIMEOUT, client.close()).await;
        }
        let connection = tokio::select! {
            _ = lease.cancelled() => return Err(McpError::Unavailable("MCP plugin was disabled".into())),
            result = connect(config) => Arc::new(result?),
        };
        if lease.is_cancelled() {
            connection.cancelled.cancel();
            let mut client = connection.client.write().await;
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
            app_only: tool
                .meta
                .as_ref()
                .and_then(|m| m.0.get("ui"))
                .and_then(|ui| ui.get("visibility"))
                .and_then(Value::as_array)
                .is_some_and(|v| v.len() == 1 && v[0] == "app"),
            input_schema: schema,
        });
    }
    Ok(Connection {
        digest: config.digest.clone(),
        client: RwLock::new(client),
        operations: Mutex::new(()),
        panels: std::sync::atomic::AtomicUsize::new(0),
        interactive: std::sync::atomic::AtomicBool::new(false),
        ui_seen: std::sync::Mutex::new(Instant::now()),
        tools,
        cancelled: CancellationToken::new(),
        last_used: std::sync::Mutex::new(Instant::now()),
    })
}

// Count serialized bytes without allocating a second copy of a base64 image.
fn validate_result_budget(result: &Value) -> Result<(), McpError> {
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len());
            if self.0 > MAX_RESULT + MAX_IMAGE_BASE64 {
                return Err(std::io::Error::other("MCP result budget"));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, result).map_err(|_| McpError::ResultTooLarge)?;
    let mut image_bytes = 0;
    let mut images = 0;
    if let Some(content) = result.get("content").and_then(Value::as_array) {
        for block in content {
            if block.get("type").and_then(Value::as_str) != Some("image") {
                continue;
            }
            images += 1;
            let data = block
                .get("data")
                .and_then(Value::as_str)
                .ok_or_else(|| McpError::Invalid("invalid MCP image data".into()))?;
            if images > 1 || data.len() > MAX_IMAGE_BASE64 {
                return Err(McpError::ResultTooLarge);
            }
            if block.get("mimeType").and_then(Value::as_str) != Some("image/png")
                || !data
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
            {
                return Err(McpError::Invalid(
                    "MCP images require PNG and standard base64".into(),
                ));
            }
            image_bytes = data.len();
        }
    }
    // Base64 uses no JSON escapes, so subtracting exactly its bytes preserves
    // the preexisting 64 KiB limit for all text, envelopes and structured data.
    if counter.0.saturating_sub(image_bytes) > MAX_RESULT {
        return Err(McpError::ResultTooLarge);
    }
    Ok(())
}

#[cfg(test)]
mod result_budget_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn image_wire_budget_never_expands_text_budget() {
        let image =
            json!({"type":"image","mimeType":"image/png","data":"A".repeat(MAX_RESULT * 2)});
        assert!(validate_result_budget(&json!({"content":[image.clone()]})).is_ok());
        assert!(matches!(
            validate_result_budget(&json!({"content":[image.clone(),image.clone()]})),
            Err(McpError::ResultTooLarge)
        ));
        assert!(matches!(
            validate_result_budget(
                &json!({"content":[image],"structuredContent":{"text":"x".repeat(MAX_RESULT)}})
            ),
            Err(McpError::ResultTooLarge)
        ));
        assert!(matches!(
            validate_result_budget(
                &json!({"content":[{"type":"text","text":"x".repeat(MAX_RESULT)}]})
            ),
            Err(McpError::ResultTooLarge)
        ));
    }
    #[test]
    fn malformed_or_oversized_media_has_no_budget_exception() {
        for image in [
            json!({"type":"image","mimeType":"image/svg+xml","data":"AAAA"}),
            json!({"type":"image","mimeType":"image/png","data":"not\nbase64"}),
            json!({"type":"image","mimeType":"image/png","data":17}),
            json!({"type":"image","mimeType":"image/png","data":"A".repeat(MAX_IMAGE_BASE64 + 1)}),
        ] {
            assert!(validate_result_budget(&json!({"content":[image]})).is_err());
        }
        assert!(
            validate_result_budget(&json!({"content":[{"type":"text","text":"plain"}]})).is_ok()
        );
    }
}

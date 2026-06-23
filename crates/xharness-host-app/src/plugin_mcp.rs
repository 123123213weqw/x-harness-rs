//! One lazy model tool bridges explicitly enabled plugin stdio servers.
//! Schemas are discovered on demand rather than injected into every request.

use std::{sync::Arc, time::Duration};

use serde_json::{json, Map, Value};
use xharness_mcp::{McpRuntime, StdioServerConfig};
use xharness_plugins::{McpServerSpec, PluginManager};
use xharness_tools::{ToolDefinition, ToolHandlerError, ToolOutput, ToolSpec};

fn error(error: impl ToString) -> ToolHandlerError {
    ToolHandlerError::new(error.to_string())
}

fn config(spec: McpServerSpec) -> Result<StdioServerConfig, ToolHandlerError> {
    let env = spec.resolved_env().map_err(error)?;
    Ok(StdioServerConfig {
        plugin: spec.plugin,
        server: spec.server,
        digest: spec.digest,
        command: spec.command,
        args: spec.args,
        env,
        cwd: spec.cwd,
    })
}

pub fn spec(manager: Arc<PluginManager>, runtime: Arc<McpRuntime>, owner: String) -> ToolSpec {
    ToolSpec::new(
        ToolDefinition::new(
            "plugin_mcp",
            "Use user-enabled local MCP servers. action=list without plugin lists enabled plugins; with plugin lists its servers and tools. action=call invokes one tool by plugin, server and tool name. All servers start lazily and are isolated per chat. Never use this for plugins not enabled by the user.",
            json!({"type":"object","properties":{
                "action":{"type":"string","enum":["list","call"]},
                "plugin":{"type":"string"},"server":{"type":"string"},"tool":{"type":"string"},
                "arguments":{"type":"object"}
            },"required":["action"]}),
        ),
        move |context| {
            let manager = Arc::clone(&manager);
            let runtime = Arc::clone(&runtime);
            let owner = owner.clone();
            async move {
                let args = &context.arguments;
                let action = args.get("action").and_then(Value::as_str).ok_or_else(|| error("action required"))?;
                let plugin = args.get("plugin").and_then(Value::as_str);
                if action == "list" && plugin.is_none() {
                    return Ok(ToolOutput::text(json!({"plugins":manager.enabled_mcp_plugins().await}).to_string()));
                }
                let plugin = plugin.ok_or_else(|| error("plugin required"))?;
                if action == "list" {
                    let server = args.get("server").and_then(Value::as_str);
                    let previews = manager.mcp_preview(plugin).await.map_err(error)?;
                    // A stale tool snapshot cannot start a server after the user
                    // disabled MCP since this lookup checks the current state.
                    if !manager.enabled_mcp_plugins().await.iter().any(|name| name == plugin) {
                        return Err(error("MCP plugin is disabled"));
                    }
                    if server.is_none() {
                        return Ok(ToolOutput::text(json!({"plugin":plugin,"servers":previews.iter().map(|p| &p.server).collect::<Vec<_>>()}).to_string()));
                    }
                    let server = server.unwrap();
                    let config = config(manager.mcp_server(plugin, server).await.map_err(error)?)?;
                    let tools = runtime.list_tools(&owner, &config).await.map_err(error)?;
                    return Ok(ToolOutput::text(json!({"tools":tools}).to_string()));
                }
                if action != "call" { return Err(error("action must be list or call")); }
                let server = args.get("server").and_then(Value::as_str).ok_or_else(|| error("server required"))?;
                let tool = args.get("tool").and_then(Value::as_str).ok_or_else(|| error("tool required"))?;
                let parameters = args.get("arguments").and_then(Value::as_object).cloned().unwrap_or_else(Map::new);
                let config = config(manager.mcp_server(plugin, server).await.map_err(error)?)?;
                let call = runtime.call_tool(&owner, &config, tool, parameters);
                tokio::select! {
                    result = call => Ok(ToolOutput::text(result.map_err(error)?.to_string())),
                    _ = context.cancellation.cancelled() => {
                        runtime.disconnect_plugin(plugin).await;
                        Err(error("MCP call cancelled"))
                    }
                }
            }
        },
    )
    .requiring_approval(true)
    .with_timeout(Duration::from_secs(90))
}

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

// MCP transport success does not imply that the invoked tool succeeded.
// Keep its complete bounded evidence in the failure, instead of returning a
// successful outer tool result containing an inner `isError: true`.
fn call_output(result: Value) -> Result<ToolOutput, ToolHandlerError> {
    match result.get("isError") {
        None | Some(Value::Bool(false)) => Ok(ToolOutput::text(result.to_string())),
        Some(Value::Bool(true)) => Err(error(format!("MCP tool reported failure: {result}"))),
        Some(_) => Err(error("invalid MCP isError: expected a boolean")),
    }
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

pub fn spec(
    manager: Option<Arc<PluginManager>>,
    runtime: Arc<McpRuntime>,
    native: Option<Arc<crate::native_browser::NativeBrowser>>,
    owner: String,
) -> ToolSpec {
    ToolSpec::new(
        ToolDefinition::new(
            "plugin_mcp",
            "Use user-enabled local MCP servers and, when explicitly delegated by the desktop UI, its native browser. action=list without plugin lists enabled plugins; with plugin lists its servers; with plugin and server lists a compact tool index. action=describe returns one tool's input schema. action=call invokes one tool by plugin, server and tool name. Servers start lazily and are isolated per chat.",
            json!({"type":"object","properties":{
                "action":{"type":"string","enum":["list","describe","call"]},
                "plugin":{"type":"string"},"server":{"type":"string"},"tool":{"type":"string"},
                "arguments":{"type":"object"}
            },"required":["action"]}),
        ),
        move |context| {
            let manager = manager.clone();
            let native = native.clone();
            let runtime = Arc::clone(&runtime);
            let owner = owner.clone();
            async move {
                let args = &context.arguments;
                let action = args.get("action").and_then(Value::as_str).ok_or_else(|| error("action required"))?;
                let plugin = args.get("plugin").and_then(Value::as_str);
                if action == "list" && plugin.is_none() {
                    let mut plugins = match &manager { Some(manager) => manager.enabled_mcp_plugins().await, None => Vec::new() };
                    if let Some(native) = &native {
                        if native.available(&owner, &context.cancellation).await { plugins.push(crate::native_browser::PLUGIN.into()); }
                    }
                    return Ok(ToolOutput::text(json!({"plugins":plugins}).to_string()));
                }
                let plugin = plugin.ok_or_else(|| error("plugin required"))?;
                if plugin == crate::native_browser::PLUGIN {
                    let native = native.ok_or_else(|| error("native browser is unavailable"))?;
                    if action == "list" && args.get("server").is_none() {
                        if !native.available(&owner, &context.cancellation).await { return Err(error("native browser is not delegated to this chat")); }
                        return Ok(ToolOutput::text(json!({"servers":[crate::native_browser::SERVER]}).to_string()));
                    }
                    if args.get("server").and_then(Value::as_str) != Some(crate::native_browser::SERVER) { return Err(error("unknown native browser server")); }
                    if action == "call" {
                        let tool = args.get("tool").and_then(Value::as_str).ok_or_else(|| error("tool required"))?;
                        let parameters = match args.get("arguments") { None => Map::new(), Some(Value::Object(parameters)) => parameters.clone(), _ => return Err(error("native arguments must be an object")) };
                        return call_output(native.call(&owner, tool, parameters, &context.cancellation).await.map_err(error)?);
                    }
                    if !native.available(&owner, &context.cancellation).await { return Err(error("native browser is not delegated to this chat")); }
                    let tools = crate::native_browser::tools();
                    if action == "describe" {
                        let name = args.get("tool").and_then(Value::as_str).ok_or_else(|| error("tool required"))?;
                        return Ok(ToolOutput::text(json!({"tool":tools.iter().find(|tool| tool["name"] == name).ok_or_else(|| error("unknown native browser tool"))?}).to_string()));
                    }
                    if action != "list" { return Err(error("action must be list, describe or call")); }
                    return Ok(ToolOutput::text(json!({"tools":tools.iter().map(|tool| json!({"name":tool["name"],"description":tool["description"]})).collect::<Vec<_>>()}).to_string()));
                }
                let manager = manager.ok_or_else(|| error("plugin store unavailable"))?;
                // Capture the runtime lease before reading enabled state. A
                // concurrent disable revokes this exact lease even if the
                // configuration lookup has already succeeded.
                let lease = runtime.lease(plugin).await;
                if action == "list" || action == "describe" {
                    let server = args.get("server").and_then(Value::as_str);
                    let previews = manager.mcp_preview(plugin).await.map_err(error)?;
                    // A stale tool snapshot cannot start a server after the user
                    // disabled MCP since this lookup checks the current state.
                    if !manager.enabled_mcp_plugins().await.iter().any(|name| name == plugin) {
                        return Err(error("MCP plugin is disabled"));
                    }
                    if server.is_none() && action == "list" {
                        return Ok(ToolOutput::text(json!({"plugin":plugin,"servers":previews.iter().map(|p| &p.server).collect::<Vec<_>>()}).to_string()));
                    }
                    let server = server.ok_or_else(|| error("server required"))?;
                    let config = config(manager.mcp_server(plugin, server).await.map_err(error)?)?;
                    let tools = runtime.list_tools_with_lease(&owner, &config, &lease).await.map_err(error)?;
                    if action == "describe" {
                        let name = args.get("tool").and_then(Value::as_str).ok_or_else(|| error("tool required"))?;
                        let tool = tools.iter().find(|tool| tool.name == name).ok_or_else(|| error("unknown server tool"))?;
                        return Ok(ToolOutput::text(json!({"tool":tool}).to_string()));
                    }
                    let index = tools.iter().map(|tool| json!({
                        "name":tool.name,
                        "description":tool.description.chars().take(160).collect::<String>()
                    })).collect::<Vec<_>>();
                    return Ok(ToolOutput::text(json!({"tools":index}).to_string()));
                }
                if action != "call" { return Err(error("action must be list, describe or call")); }
                let server = args.get("server").and_then(Value::as_str).ok_or_else(|| error("server required"))?;
                let tool = args.get("tool").and_then(Value::as_str).ok_or_else(|| error("tool required"))?;
                let parameters = args.get("arguments").and_then(Value::as_object).cloned().unwrap_or_else(Map::new);
                let config = config(manager.mcp_server(plugin, server).await.map_err(error)?)?;
                let call = runtime.call_tool_with_lease(&owner, &config, tool, parameters, &lease);
                tokio::select! {
                    result = call => call_output(result.map_err(error)?),
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

#[cfg(test)]
mod tests {
    use super::*;
    use xharness_tools::{ToolExecutor, ToolRegistry, ToolRequest};

    #[test]
    fn mcp_call_output_obeys_protocol_error_flag() {
        let evidence = json!({"content":[{"type":"text","text":"stale_frame: observe again"}]});
        assert_eq!(
            call_output(evidence.clone()).unwrap().content,
            evidence.to_string()
        );
        let mut success = evidence.clone();
        success["isError"] = json!(false);
        assert!(call_output(success).is_ok());
        let mut failed = evidence;
        failed["isError"] = json!(true);
        let failure = call_output(failed.clone()).unwrap_err();
        assert!(failure.message.contains(&failed.to_string()));
        assert!(
            !failure.retryable,
            "an MCP error must not imply safe action replay"
        );
        assert!(call_output(json!({"isError":"true"})).is_err());
    }

    #[tokio::test]
    async fn mcp_error_reaches_executor_as_failure_with_evidence() {
        let registry = Arc::new(ToolRegistry::new());
        registry.register(ToolSpec::new(
            ToolDefinition::new("mcp_fixture", "MCP projection contract", json!({"type":"object"})),
            |_| async { call_output(json!({"isError":true,"content":[{"type":"text","text":"effect: unknown"}]})) },
        )).await.unwrap();
        let result = ToolExecutor::new(registry)
            .execute(ToolRequest::new("mcp_fixture", "{}"))
            .await;
        assert!(!result.is_ok());
        assert!(result.failure.unwrap().message.contains("effect: unknown"));
    }
}

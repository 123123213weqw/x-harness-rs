//! One lazy model tool bridges built-in Host UI and enabled plugin servers.
//! Schemas are discovered on demand rather than injected into every request.

mod browser_boundary;
#[cfg(test)]
mod browser_e2e;
#[cfg(test)]
mod extension_e2e;
mod media;

use std::{sync::Arc, time::Duration};

use crate::builtin_ui::{self, BuiltinUi};
use serde_json::{json, Map, Value};
use xharness_mcp::{McpRuntime, StdioServerConfig};
use xharness_plugins::{McpServerSpec, PluginManager};
use xharness_tools::{
    GuardDecision, MiddlewareError, MonotonicGuard, ToolDefinition, ToolExecutionContext,
    ToolHandlerError, ToolOutput, ToolSpec,
};

/// Register this spec and its invocation guard together. Built-in read-only UI
/// retains display's original no-approval policy; foreign MCP/native browser
/// invocations retain the existing approval policy. Other guards and durable
/// per-request approval requirements remain monotonic and authoritative.
pub(crate) struct Binding {
    pub(crate) spec: ToolSpec,
    pub(crate) guard: Arc<dyn MonotonicGuard>,
}

struct InvocationPolicy {
    full_access: bool,
    builtin_ui_available: bool,
}

fn is_builtin_ui_request(args: &Value) -> bool {
    let action = args.get("action").and_then(Value::as_str);
    // The compact top-level index cannot start an external MCP server or
    // perform browser actions. Keep lazy UI discovery approval-free too.
    if action == Some("list") && args.get("plugin").is_none() {
        return true;
    }
    if args.get("plugin").and_then(Value::as_str) != Some(builtin_ui::PLUGIN) {
        return false;
    }
    let server = args.get("server").and_then(Value::as_str);
    match (action, server) {
        (Some("list"), None | Some(builtin_ui::SERVER)) => true,
        (Some("describe" | "call"), Some(builtin_ui::SERVER)) => {
            args.get("tool").and_then(Value::as_str) == Some("display")
        }
        _ => false,
    }
}

#[async_trait::async_trait]
impl MonotonicGuard for InvocationPolicy {
    async fn evaluate(
        &self,
        context: &ToolExecutionContext,
    ) -> Result<GuardDecision, MiddlewareError> {
        // An invalid reserved target is not a foreign operation to approve.
        // Reject it before the durable approval path can block a model turn.
        if context.tool_name() == "plugin_mcp"
            && context.arguments.get("plugin").and_then(Value::as_str) == Some(builtin_ui::PLUGIN)
            && (!self.builtin_ui_available || !is_builtin_ui_request(&context.arguments))
        {
            return Ok(GuardDecision::deny(
                "unknown or unavailable builtin UI invocation",
            ));
        }
        if context.tool_name() != "plugin_mcp"
            || self.full_access
            || self.builtin_ui_available && is_builtin_ui_request(&context.arguments)
        {
            Ok(GuardDecision::Allow)
        } else {
            Ok(GuardDecision::require_approval(
                "MCP invocation requires the existing tool approval",
            ))
        }
    }
}

pub(crate) fn bind(
    manager: Option<Arc<PluginManager>>,
    runtime: Option<Arc<McpRuntime>>,
    native: Option<Arc<crate::native_browser::NativeBrowser>>,
    ui: Option<Arc<BuiltinUi>>,
    owner: String,
    full_access: bool,
    media: Option<Arc<dyn xharness_computer::ComputerMediaSink>>,
) -> Binding {
    let guard = Arc::new(InvocationPolicy {
        full_access,
        builtin_ui_available: ui.is_some(),
    });
    Binding {
        spec: spec(manager, runtime, native, ui, owner, media),
        guard,
    }
}

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

fn config(
    mut spec: McpServerSpec,
    owner: &str,
    store: &std::path::Path,
) -> Result<StdioServerConfig, ToolHandlerError> {
    spec.env.retain(|name, _| {
        !name
            .to_ascii_uppercase()
            .starts_with("XHARNESS_BROWSER_CONTEXT_")
    });
    let mut env = spec.resolved_env().map_err(error)?;
    // Reserved identity comes from the executing Host, never plugin configuration
    // or model arguments. Include the store namespace to isolate local instances.
    if spec.plugin == browser_boundary::EXTENSION_PLUGIN && spec.server == "browser" {
        use sha2::{Digest, Sha256};
        let namespace = std::fs::canonicalize(store).map_err(error)?;
        let mut hash = Sha256::new();
        hash.update(namespace.to_string_lossy().as_bytes());
        hash.update([0]);
        hash.update(owner.as_bytes());
        env.insert(
            "XHARNESS_BROWSER_CONTEXT_ID".into(),
            format!("{:x}", hash.finalize()),
        );
        env.insert(
            "XHARNESS_BROWSER_CONTEXT_LABEL".into(),
            format!(
                "XHarness · {}",
                owner
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(64)
                    .collect::<String>()
            ),
        );
    }
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

fn spec(
    manager: Option<Arc<PluginManager>>,
    runtime: Option<Arc<McpRuntime>>,
    native: Option<Arc<crate::native_browser::NativeBrowser>>,
    ui: Option<Arc<BuiltinUi>>,
    owner: String,
    media: Option<Arc<dyn xharness_computer::ComputerMediaSink>>,
) -> ToolSpec {
    ToolSpec::new(
        ToolDefinition::new(
            "plugin_mcp",
            format!("{}{}", "Discover and control XHarness's built-in browser when available; display files or invoke enabled MCP. list -> plugins, +plugin -> servers, +server -> tools; describe loads schema; call invokes. File display: builtin/ui/display. Schemas load lazily; do not bypass approvals.\nBuilt-in browser: Discover availability first; zero open tabs does not mean unavailable. An explicit request to open or view a page requires opening it. Use web_fetch for lightweight public-page reading when opening or rendering is not requested. For JS/interaction, discover built-in before desktop automation; after empty/title-only fetches, check the built-in browser before ending an unresolved page-reading request. Use computer for desktop applications or an explicitly requested external browser. Respect explicit browser choices. Report unavailability/failure; never claim a page opened without a successful result.", browser_boundary::GUIDANCE),
            json!({"type":"object","properties":{
                "action":{"type":"string","enum":["list","describe","call"]},
                "plugin":{"type":"string"},"server":{"type":"string"},"tool":{"type":"string"},
                "arguments":{"type":"object"}
            },"required":["action"]}),
        ),
        move |context| {
            let manager = manager.clone();
            let native = native.clone();
            let runtime = runtime.clone();
            let ui = ui.clone();
            let owner = owner.clone();
            let media = media.clone();
            async move {
                let args = &context.arguments;
                let action = args.get("action").and_then(Value::as_str).ok_or_else(|| error("action required"))?;
                let plugin = args.get("plugin").and_then(Value::as_str);
                if action == "list" && plugin.is_none() {
                    let mut plugins = match &manager { Some(manager) => manager.enabled_mcp_plugins().await, None => Vec::new() };
                    // Reserved host namespace cannot be impersonated by an installed plugin.
                    plugins.retain(|plugin| plugin != builtin_ui::PLUGIN);
                    if ui.is_some() { plugins.push(builtin_ui::PLUGIN.into()); }
                    let mut capabilities = Vec::new();
                    if let Some(native) = &native {
                        let (visible_ready,headless_ready)=native.availability(&owner,&context.cancellation).await;
                        if headless_ready {
                            plugins.push(crate::native_browser::PLUGIN.into());
                            capabilities.push(json!({"plugin":crate::native_browser::PLUGIN,"server":crate::native_browser::HEADLESS_SERVER,"backend":"owned-headless","visibility":"optional-sidebar-preview","session":"chat-owned-independent-profile","description":"Preferred built-in browser. Reuses installed Chrome/Edge in a new isolated instance; sidebar may be collapsed. No existing login inherited. Describe control to open."}));
                        }
                        if visible_ready {
                            if !plugins.iter().any(|plugin|plugin==crate::native_browser::PLUGIN){plugins.push(crate::native_browser::PLUGIN.into());}
                            capabilities.push(browser_boundary::embedded_capability());
                        }
                    }
                    if plugins.iter().any(|plugin| plugin == browser_boundary::HEADLESS_PLUGIN) {
                        if let Some(manager) = &manager {
                            if let Some(capability) = browser_boundary::headless_capability(manager).await {
                                capabilities.push(capability);
                            }
                        }
                    }
                    if plugins.iter().any(|plugin| plugin == browser_boundary::EXTENSION_PLUGIN) {
                        if let Some(manager) = &manager {
                            if let Some(capability) = browser_boundary::extension_capability(manager).await {
                                capabilities.push(capability);
                            }
                        }
                    }
                    return Ok(ToolOutput::text(json!({"plugins":plugins,"capabilities":capabilities}).to_string()));
                }
                let plugin = plugin.ok_or_else(|| error("plugin required"))?;
                if plugin == builtin_ui::PLUGIN {
                    let ui = ui.ok_or_else(|| error("builtin UI is unavailable"))?;
                    if action == "list" && args.get("server").is_none() {
                        return Ok(ToolOutput::text(json!({"servers":[builtin_ui::SERVER]}).to_string()));
                    }
                    if args.get("server").and_then(Value::as_str) != Some(builtin_ui::SERVER) {
                        return Err(error("unknown builtin UI server"));
                    }
                    let definition = BuiltinUi::definition();
                    if action == "list" {
                        return Ok(ToolOutput::text(json!({"tools":[{"name":definition.name,
                            "description":definition.description.chars().take(160).collect::<String>()}]}).to_string()));
                    }
                    let tool = args.get("tool").and_then(Value::as_str).ok_or_else(|| error("tool required"))?;
                    if tool != definition.name { return Err(error("unknown builtin UI tool")); }
                    if action == "describe" {
                        return Ok(ToolOutput::text(json!({"tool":{"name":definition.name,
                            "description":definition.description,"inputSchema":definition.parameters}}).to_string()));
                    }
                    if action != "call" { return Err(error("action must be list, describe or call")); }
                    let parameters = args.get("arguments").cloned().unwrap_or_else(|| json!({}));
                    return ui.call(tool, parameters, &context.cancellation).await;
                }
                if plugin == crate::native_browser::PLUGIN {
                    let native = native.ok_or_else(|| error("native browser is unavailable"))?;
                    if action == "list" && args.get("server").is_none() {
                        let mut servers=Vec::new();
                        let (visible_ready,headless_ready)=native.availability(&owner,&context.cancellation).await;
                        if headless_ready {servers.push(crate::native_browser::HEADLESS_SERVER);}
                        if visible_ready {servers.push(crate::native_browser::SERVER);}
                        if servers.is_empty(){return Err(error("browser bridge unavailable"));}
                        return Ok(ToolOutput::text(json!({"servers":servers}).to_string()));
                    }
                    let headless=args.get("server").and_then(Value::as_str)==Some(crate::native_browser::HEADLESS_SERVER);
                    if !headless&&args.get("server").and_then(Value::as_str) != Some(crate::native_browser::SERVER) { return Err(error("unknown native browser server")); }
                    let native=if headless {Arc::new(native.headless())}else{native};
                    if action == "call" {
                        let tool = args.get("tool").and_then(Value::as_str).ok_or_else(|| error("tool required"))?;
                        let parameters = match args.get("arguments") { None => Map::new(), Some(Value::Object(parameters)) => parameters.clone(), _ => return Err(error("native arguments must be an object")) };
                        if tool=="screenshot" {
                            let media=media.ok_or_else(||error("browser attachment service unavailable"))?;
                            return native.screenshot(&owner,parameters,media.as_ref(),&context.cancellation).await;
                        }
                        return call_output(native.call(&owner, tool, parameters, &context.cancellation).await.map_err(error)?);
                    }
                    if !native.available(&owner, &context.cancellation).await { return Err(error("native browser bridge unavailable")); }
                    let tools = if headless {crate::native_browser::headless_tools()}else{crate::native_browser::tools()};
                    if action == "describe" {
                        let name = args.get("tool").and_then(Value::as_str).ok_or_else(|| error("tool required"))?;
                        return Ok(ToolOutput::text(json!({"tool":tools.iter().find(|tool| tool["name"] == name).ok_or_else(|| error("unknown native browser tool"))?}).to_string()));
                    }
                    if action != "list" { return Err(error("action must be list, describe or call")); }
                    return Ok(ToolOutput::text(json!({"tools":tools.iter().map(|tool| json!({"name":tool["name"],"description":tool["description"]})).collect::<Vec<_>>()}).to_string()));
                }
                let manager = manager.ok_or_else(|| error("plugin store unavailable"))?;
                let runtime = runtime.ok_or_else(|| error("MCP runtime unavailable"))?;
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
                    let config = config(manager.mcp_server(plugin, server).await.map_err(error)?, &owner, manager.storage_root())?;
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
                let config = config(manager.mcp_server(plugin, server).await.map_err(error)?, &owner, manager.storage_root())?;
                let call = runtime.call_tool_with_lease(&owner, &config, tool, parameters, &lease);
                tokio::select! {
                    result = call => media::project(result.map_err(error)?, media.as_deref(), &context.cancellation).await,
                    _ = context.cancellation.cancelled() => {
                        runtime.disconnect_plugin(plugin).await;
                        Err(error("MCP call cancelled"))
                    }
                }
            }
        },
    )
    .with_timeout(Duration::from_secs(90))
}

#[cfg(test)]
mod tests {
    use super::*;
    use xharness_tools::{ToolExecutor, ToolRegistry, ToolRequest};

    #[test]
    fn extension_identity_is_host_owned_stable_and_store_scoped() {
        let root = std::env::temp_dir().join(format!("xh-binding-{}", std::process::id()));
        let other = root.join("other");
        std::fs::create_dir_all(&other).unwrap();
        let spec = McpServerSpec {
            plugin: "browser-extension".into(),
            server: "browser".into(),
            digest: "fixture".into(),
            command: "node".into(),
            args: vec![],
            cwd: root.clone(),
            env: std::collections::BTreeMap::from([
                (
                    "XHARNESS_BROWSER_CONTEXT_ID".into(),
                    "${UNSET_UNTRUSTED_SELECTOR}".into(),
                ),
                ("xharness_browser_context_label".into(), "spoof".into()),
                ("NORMAL".into(), "kept".into()),
            ]),
        };
        let one = config(spec.clone(), "chat-a", &root).unwrap();
        assert_eq!(one.env["NORMAL"], "kept");
        assert!(!one.env.contains_key("xharness_browser_context_label"));
        let key = "XHARNESS_BROWSER_CONTEXT_ID";
        assert_eq!(one.env[key].len(), 64);
        assert_eq!(
            one.env[key],
            config(spec.clone(), "chat-a", &root).unwrap().env[key]
        );
        assert_ne!(
            one.env[key],
            config(spec.clone(), "chat-b", &root).unwrap().env[key]
        );
        assert_ne!(
            one.env[key],
            config(spec.clone(), "chat-a", &other).unwrap().env[key]
        );
        let mut unrelated = spec;
        unrelated.plugin = "other".into();
        assert!(!config(unrelated, "chat-a", &root)
            .unwrap()
            .env
            .contains_key(key));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn absent_bridge_does_not_advertise_a_browser_or_inject_schemas() {
        let binding = bind(None, None, None, None, "owner".into(), true, None);
        let registry = Arc::new(ToolRegistry::new());
        registry.register(binding.spec).await.unwrap();
        let definitions = registry.definitions().await;
        assert_eq!(definitions.len(), 1);
        let description = &definitions[0].description;
        assert!(description
            .starts_with("Discover and control XHarness's built-in browser when available"));
        for rule in [
            "Built-in browser:",
            "Discover availability first",
            "zero open tabs does not mean unavailable",
            "An explicit request to open or view a page requires opening it",
            "Use web_fetch for lightweight public-page reading when opening or rendering is not requested",
            "Use computer for desktop applications or an explicitly requested external browser",
            "check the built-in browser before ending an unresolved page-reading request",
            "Respect explicit browser choices",
            "never claim a page opened without a successful result",
            "do not bypass approvals",
        ] {
            assert!(description.contains(rule), "missing browser guidance: {rule}");
        }
        let executor = ToolExecutor::new(registry).with_guards(vec![binding.guard]);
        let result = executor
            .execute(ToolRequest::new("plugin_mcp", r#"{"action":"list"}"#))
            .await;
        assert!(result.is_ok(), "{result:?}");
        let index: Value = serde_json::from_str(&result.output.unwrap().content).unwrap();
        assert_eq!(index, json!({"plugins":[],"capabilities":[]}));
    }

    #[tokio::test]
    async fn automatic_browser_binding_does_not_bypass_tool_approval() {
        let binding = bind(
            None,
            Some(Arc::new(McpRuntime::default())),
            None,
            None,
            "owner".into(),
            false,
            None,
        );
        let registry = Arc::new(ToolRegistry::new());
        registry.register(binding.spec).await.unwrap();
        let executor = ToolExecutor::new(registry).with_guards(vec![binding.guard]);
        let result = executor
            .execute(ToolRequest::new("plugin_mcp", r#"{"action":"list"}"#))
            .await;
        assert_eq!(
            result.failure.unwrap().kind,
            xharness_tools::ToolFailureKind::ApprovalUnavailable
        );
    }

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

//! Opt-in loopback-only document acceptance harness. Never part of the product binary.
//! No model, credentials, installed application or existing Host are used.
use axum::{extract::State, routing::post, Json, Router};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use xharness_host::{BasicHost, HostConfig, NoTools};
use xharness_host_app::{plugin_panels::PluginPanels, NativePluginBackend};
use xharness_mcp::McpRuntime;
use xharness_plugins::PluginManager;
#[derive(Clone)]
struct Fixture {
    manager: Arc<PluginManager>,
    runtime: Arc<McpRuntime>,
    workspace: String,
}
async fn tool(State(f): State<Fixture>, Json(args): Json<Value>) -> Json<Value> {
    let result = async {
        let spec = f
            .manager
            .mcp_server("wordcraft", "wordcraft")
            .await
            .map_err(|e| e.to_string())?;
        let mut env = spec.resolved_env().map_err(|e| e.to_string())?;
        env.insert("XHARNESS_PLUGIN_WORKSPACE".into(), f.workspace.clone());
        let config = xharness_mcp::StdioServerConfig {
            plugin: spec.plugin,
            server: spec.server,
            digest: spec.digest,
            command: spec.command,
            args: spec.args,
            env,
            cwd: spec.cwd,
        };
        let name = args["name"].as_str().ok_or("missing tool")?;
        if !f
            .runtime
            .panel_is_interactive("wordcraft-test", "wordcraft", "wordcraft")
            .await
        {
            return Err("open the editor first".into());
        }
        f.runtime
            .call_tool(
                "wordcraft-test",
                &config,
                name,
                args["arguments"].as_object().cloned().unwrap_or_default(),
            )
            .await
            .map_err(|e| e.to_string())
    }
    .await;
    Json(match result {
        Ok(v) => json!({"ok":true,"value":v}),
        Err(e) => json!({"ok":false,"error":e}),
    })
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let root =
        PathBuf::from(args.next().ok_or("isolated fixture directory required")?).canonicalize()?;
    if !root
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with("wordcraft-acceptance"))
    {
        return Err("only an isolated wordcraft-acceptance* directory is accepted".into());
    }
    let workspace = root.join("workspace").canonicalize()?;
    let manager = Arc::new(PluginManager::open(root.join("state/plugins"))?);
    let runtime = McpRuntime::new();
    let host = BasicHost::new(HostConfig::new(&workspace), None, Arc::new(NoTools));
    let panels = PluginPanels::new(manager.clone(), runtime.clone(), &host);
    host.install_plugins(Arc::new(
        NativePluginBackend::new(manager.clone(), runtime.clone()).with_panels(panels.clone()),
    ))?;
    let state = Fixture {
        manager,
        runtime: runtime.clone(),
        workspace: workspace.to_string_lossy().into_owned(),
    };
    let router = xharness_server::web_router(host, None)
        .merge(xharness_server::plugin_assets::routes(panels))
        .merge(
            Router::new()
                .route("/fixture/tool", post(tool))
                .with_state(state),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    std::fs::write(
        root.join("fixture.address"),
        listener.local_addr()?.to_string(),
    )?;
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            if let Err(e) = tokio::signal::ctrl_c().await {
                eprintln!("fixture shutdown signal failed: {e}");
            }
        })
        .await?;
    runtime.shutdown().await;
    Ok(())
}

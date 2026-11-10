//! Optional session-owned editors; no background activation or package execution.
#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::let_underscore_must_use,
    unused_must_use
)]
#![cfg_attr(
    not(test),
    forbid(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::let_underscore_must_use,
        unused_must_use
    )
)]
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Weak},
};
use tokio::sync::Mutex;
use xharness_host::BasicHost;
use xharness_mcp::{McpRuntime, PanelPin, StdioServerConfig};
use xharness_plugins::{PluginManager, VerifiedPanel};
use xharness_server::plugin_assets::{PluginAsset, PluginAssets};

const MAX_PANELS: usize = 2;
struct Panel {
    session: String,
    plugin: String,
    path: String,
    config: StdioServerConfig,
    package: VerifiedPanel,
    _pin: PanelPin,
}
/// Only live editor connections are retained. Session truth remains in BasicHost.
pub struct PluginPanels {
    manager: Arc<PluginManager>,
    runtime: Arc<McpRuntime>,
    host: Weak<BasicHost>,
    panels: Mutex<BTreeMap<String, Arc<Panel>>>,
    mutation: Mutex<()>,
}
fn argument<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or_else(|| format!("missing or invalid {key}"))
}
pub(crate) async fn scoped_config(
    manager: &PluginManager,
    plugin: &str,
    server: &str,
    workspace: &str,
) -> Result<StdioServerConfig, String> {
    let spec = manager
        .mcp_server(plugin, server)
        .await
        .map_err(|e| e.to_string())?;
    let mut env = spec.resolved_env().map_err(|e| e.to_string())?;
    // The model and package may not choose the workspace for an enabled UI server.
    if manager.has_panel(plugin).await {
        let panel = manager.panel(plugin).await.map_err(|e| e.to_string())?;
        if panel.manifest.server == server {
            env.insert("XHARNESS_PLUGIN_WORKSPACE".into(), workspace.into());
        }
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
impl PluginPanels {
    pub fn new(
        manager: Arc<PluginManager>,
        runtime: Arc<McpRuntime>,
        host: &Arc<BasicHost>,
    ) -> Arc<Self> {
        Arc::new(Self {
            manager,
            runtime,
            host: Arc::downgrade(host),
            panels: Mutex::new(BTreeMap::new()),
            mutation: Mutex::new(()),
        })
    }
    pub(crate) async fn mutation_guard(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.mutation.lock().await
    }
    pub async fn has_plugin(&self, plugin: &str) -> bool {
        self.panels
            .lock()
            .await
            .values()
            .any(|p| p.plugin == plugin && !p._pin.revoked())
    }
    async fn context(&self, session: &str) -> Result<String, String> {
        self.host
            .upgrade()
            .ok_or("Host unavailable")?
            .plugin_panel_workspace(session)
            .await
    }
    async fn get(&self, cap: &str) -> Result<Arc<Panel>, String> {
        let panel = self
            .panels
            .lock()
            .await
            .get(cap)
            .cloned()
            .ok_or("editor capability expired")?;
        if panel._pin.revoked() {
            return Err("editor was disconnected".into());
        }
        let workspace = self.context(&panel.session).await?;
        if self
            .manager
            .panel(&panel.plugin)
            .await
            .map_err(|e| e.to_string())?
            .digest
            != panel.package.digest
            || panel.config.env.get("XHARNESS_PLUGIN_WORKSPACE") != Some(&workspace)
        {
            return Err("editor scope changed".into());
        }
        Ok(panel)
    }
    fn descriptor(cap: &str, panel: &Panel) -> Value {
        json!({"capability":cap,"sessionId":panel.session,"plugin":panel.plugin,"title":panel.package.manifest.title,
            "source":panel.path,"entry":format!("/plugin-panel/{cap}/{}",panel.package.manifest.entry)})
    }
    pub async fn call(&self, endpoint: &str, args: &Value) -> Result<Value, String> {
        match endpoint {
            "plugins/panelOpen" => {
                let _mutation = self.mutation.lock().await;
                let session = argument(args, "sessionId")?;
                let plugin = argument(args, "name")?;
                let workspace = self.context(session).await?;
                let package = self
                    .manager
                    .panel(plugin)
                    .await
                    .map_err(|e| e.to_string())?;
                let root = tokio::fs::canonicalize(&workspace)
                    .await
                    .map_err(|_| "workspace unavailable")?;
                let raw = argument(args, "path")?;
                let target = tokio::fs::canonicalize(root.join(raw))
                    .await
                    .map_err(|_| "document unavailable")?;
                if !target.starts_with(&root)
                    || !target.is_file()
                    || target
                        .extension()
                        .and_then(|s| s.to_str())
                        .is_none_or(|s| !s.eq_ignore_ascii_case("docx"))
                {
                    return Err("open a DOCX file inside this session workspace".into());
                }
                let relative = target
                    .strip_prefix(&root)
                    .map_err(|_| "document outside workspace")?
                    .to_str()
                    .ok_or("document path is not UTF-8")?
                    .to_owned();
                {
                    let mut panels = self.panels.lock().await;
                    panels.retain(|_, p| !p._pin.revoked());
                    for (cap, panel) in panels.iter() {
                        if panel.session == session && panel.plugin == plugin {
                            return if panel.path == relative {
                                Ok(json!({"panel":Self::descriptor(cap, panel),"initial":null}))
                            } else {
                                Err("save and close the existing editor before opening another document".into())
                            };
                        }
                    }
                    if panels.len() >= MAX_PANELS {
                        return Err("two editors are already open; save and close one first".into());
                    }
                }
                let config =
                    scoped_config(&self.manager, plugin, &package.manifest.server, &workspace)
                        .await?;
                let lease = self.runtime.lease(plugin).await;
                let result = self
                    .runtime
                    .call_tool_with_lease(
                        session,
                        &config,
                        &package.manifest.open_tool,
                        serde_json::Map::from_iter([(
                            "path".into(),
                            Value::String(relative.clone()),
                        )]),
                        &lease,
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                if result.get("isError").and_then(Value::as_bool) == Some(true) {
                    return Err("editor refused to open the document".into());
                }
                let pin = self
                    .runtime
                    .pin_panel(session, &config)
                    .await
                    .map_err(|e| e.to_string())?;
                let latest = self.context(session).await;
                if latest.as_ref() != Ok(&workspace) {
                    self.runtime
                        .close_panel(session, &config)
                        .await
                        .map_err(|e| format!("scope changed; editor cleanup failed: {e}"))?;
                    return Err("session scope changed while opening editor".into());
                }
                // Capture the open result for file-drop delivery after the UI initializes.
                let panel = Arc::new(Panel {
                    session: session.into(),
                    plugin: plugin.into(),
                    path: relative,
                    config,
                    package,
                    _pin: pin,
                });
                let mut random = [0u8; 32];
                getrandom::fill(&mut random).map_err(|_| "editor capability generation failed")?;
                let cap = random
                    .iter()
                    .map(|v| format!("{v:02x}"))
                    .collect::<String>();
                let dto = Self::descriptor(&cap, &panel);
                self.panels.lock().await.insert(cap, panel);
                Ok(json!({"panel":dto,"initial":result}))
            }
            "plugins/panelActivity" => {
                let panel = self.get(argument(args, "capability")?).await?;
                let interactive = args
                    .get("interactive")
                    .and_then(Value::as_bool)
                    .ok_or("missing editor visibility")?;
                panel
                    ._pin
                    .set_interactive(interactive)
                    .map_err(|e| e.to_string())?;
                Ok(json!({"updated":true}))
            }
            "plugins/panelRpc" => {
                let panel = self.get(argument(args, "capability")?).await?;
                let params = args.get("params").cloned().unwrap_or(json!({}));
                match argument(args, "method")? {
                    "tools/call" => {
                        let name = argument(&params, "name")?;
                        let arguments = params
                            .get("arguments")
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();
                        self.runtime
                            .call_app_tool(&panel.session, &panel.config, name, arguments)
                            .await
                            .map_err(|e| e.to_string())
                    }
                    "resources/read" => {
                        let uri = argument(&params, "uri")?;
                        if !uri.starts_with(&format!("ui://{}/", panel.plugin)) {
                            return Err("foreign resource namespace".into());
                        }
                        self.runtime
                            .read_app_resource(&panel.session, &panel.config, uri)
                            .await
                            .map_err(|e| e.to_string())
                    }
                    _ => Err("unsupported panel RPC".into()),
                }
            }
            "plugins/panelSave" => {
                if args.get("overwriteConfirmed") != Some(&Value::Bool(true)) {
                    return Err("confirm the save destination before writing".into());
                }
                let panel = self.get(argument(args, "capability")?).await?;
                if !self
                    .runtime
                    .panel_is_interactive(&panel.session, &panel.plugin, &panel.config.server)
                    .await
                {
                    return Err("make the editor visible and ready before saving".into());
                }
                let root = tokio::fs::canonicalize(self.context(&panel.session).await?)
                    .await
                    .map_err(|_| "workspace unavailable")?;
                let path = root.join(argument(args, "path")?);
                if path
                    .extension()
                    .and_then(|s| s.to_str())
                    .is_none_or(|s| !s.eq_ignore_ascii_case("docx"))
                {
                    return Err("this panel save bridge accepts DOCX only".into());
                }
                let parent = path.parent().ok_or("invalid save path")?;
                let parent = tokio::fs::canonicalize(parent)
                    .await
                    .map_err(|_| "save folder unavailable")?;
                if !parent.starts_with(&root) {
                    return Err("save outside workspace is forbidden".into());
                }
                if let Ok(meta) = tokio::fs::symlink_metadata(&path).await {
                    if !meta.file_type().is_file() || meta.file_type().is_symlink() {
                        return Err("save target must be a regular file".into());
                    }
                }
                let target = parent.join(path.file_name().ok_or("invalid save name")?);
                let relative = target
                    .strip_prefix(&root)
                    .map_err(|_| "save outside workspace")?
                    .to_str()
                    .ok_or("save path is not UTF-8")?;
                let result = self
                    .runtime
                    .call_tool(
                        &panel.session,
                        &panel.config,
                        "save_document",
                        serde_json::Map::from_iter([(
                            "path".into(),
                            Value::String(relative.into()),
                        )]),
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                if result.get("isError").and_then(Value::as_bool) == Some(true) {
                    return Err("editor failed to save; changes remain unsaved".into());
                }
                Ok(json!({"saved":true,"path":relative}))
            }
            "plugins/panelClose" => {
                if args.get("discardConfirmed") != Some(&Value::Bool(true)) {
                    return Err("confirm saved or discarded changes before closing".into());
                }
                let _mutation = self.mutation.lock().await;
                let cap = argument(args, "capability")?;
                let panel = self
                    .panels
                    .lock()
                    .await
                    .get(cap)
                    .cloned()
                    .ok_or("editor already closed")?;
                self.runtime
                    .close_panel(&panel.session, &panel.config)
                    .await
                    .map_err(|e| e.to_string())?;
                self.panels.lock().await.remove(cap);
                Ok(json!({"closed":true}))
            }
            _ => Err("unknown panel endpoint".into()),
        }
    }
}
impl PluginAssets for PluginPanels {
    fn open<'a>(
        &'a self,
        capability: &'a str,
        path: &'a str,
    ) -> futures::future::BoxFuture<'a, Result<PluginAsset, String>> {
        Box::pin(async move {
            let panel = self.get(capability).await?;
            let package = panel.package.clone();
            let path = path.to_owned();
            let (file, asset) = tokio::task::spawn_blocking(move || package.open_asset(&path))
                .await
                .map_err(|_| "asset verification task failed")?
                .map_err(|e| e.to_string())?;
            if panel._pin.revoked() {
                return Err("editor capability expired".into());
            }
            Ok(PluginAsset {
                file,
                mime: asset.mime,
                bytes: asset.bytes,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken;
    use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
    use xharness_host::{HostConfig, NoTools};
    #[tokio::test]
    async fn panel_scope_never_elevates_permission_or_uses_a_fallback_workspace() {
        let root = std::env::temp_dir().join(format!("xh-panel-scope-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let host = BasicHost::new(HostConfig::new(&root), None, Arc::new(NoTools));
        let created = host
            .call(
                RpcId::new("create"),
                RpcMethod::SessionCreate,
                json!({"cwd":root,"sessionId":"panel-test"}),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(created, RpcResult::Success { .. }), "{created:?}");
        assert!(host.plugin_panel_workspace("missing").await.is_err());
        assert!(host
            .plugin_panel_workspace("panel-test")
            .await
            .unwrap_err()
            .contains("full-access"));
        let preset=host.call_dynamic(RpcId::new("permission"),"commands/execute",json!({"args":{"agentId":"panel-test","line":"/permission danger-full-access","images":[]}}),CancellationToken::new()).await.unwrap();
        assert!(matches!(preset, RpcResult::Success { .. }), "{preset:?}");
        assert_eq!(
            std::fs::canonicalize(host.plugin_panel_workspace("panel-test").await.unwrap())
                .unwrap(),
            std::fs::canonicalize(&root).unwrap()
        );
        let manager = Arc::new(PluginManager::open(root.join("plugins")).unwrap());
        let runtime = McpRuntime::new();
        let panels = PluginPanels::new(manager, runtime.clone(), &host);
        assert!(panels
            .call(
                "plugins/panelOpen",
                &json!({"name":"wordcraft","sessionId":"panel-test","path":"x.docx"})
            )
            .await
            .is_err());
        assert!(
            !runtime
                .panel_is_open("panel-test", "wordcraft", "wordcraft")
                .await
        );
        assert!(panels
            .call(
                "plugins/panelRpc",
                &json!({"capability":"forged","method":"tools/call"})
            )
            .await
            .is_err());
        assert!(panels
            .call(
                "plugins/panelSave",
                &json!({"capability":"forged","path":"../escape.docx"})
            )
            .await
            .is_err());
        assert!(panels
            .call("plugins/panelClose", &json!({"capability":"forged"}))
            .await
            .is_err());
        let archived = host
            .call(
                RpcId::new("archive"),
                RpcMethod::WorkspaceArchiveSession,
                json!({"sessionId":"panel-test"}),
                CancellationToken::new(),
            )
            .await;
        assert!(
            matches!(archived, RpcResult::Success { .. }),
            "{archived:?}"
        );
        assert!(host.plugin_panel_workspace("panel-test").await.is_err());
        let deleted = host
            .call(
                RpcId::new("delete"),
                RpcMethod::SessionDelete,
                json!({"sessionId":"panel-test"}),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(deleted, RpcResult::Success { .. }), "{deleted:?}");
        assert!(host.plugin_panel_workspace("panel-test").await.is_err());
        runtime.shutdown().await;
        std::fs::remove_dir_all(root).unwrap();
    }
}

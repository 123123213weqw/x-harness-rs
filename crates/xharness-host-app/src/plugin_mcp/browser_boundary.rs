//! Compact discovery labels, not a browser router or authentication detector.
#![forbid(unsafe_code)]

use serde_json::{json, Value};
use xharness_plugins::PluginManager;

pub(super) const HEADLESS_PLUGIN: &str = "browser-use";
pub(super) const HEADLESS_SERVER: &str = "browser";
pub(super) const EXTENSION_PLUGIN: &str = "browser-extension";

pub(super) const GUIDANCE: &str = " Browser boundary: Use embedded native-browser/webview for the user's visible/current page, an existing signed-in session, or manual user participation. An explicitly enabled browser-use/browser is an isolated headless background backend for independent public-page tasks without an existing login session; it does not display or inherit the WebView's page or login state. Choose by the user's task, not by inspecting cookies. Explicit plugin/server and issued tab/frame refs identify the session; never mix references, transfer cookies/profiles, or silently switch browser backends after failure. If login, CAPTCHA or user participation is required, explain and ask before a fresh visible-browser handoff; do not replay a previous action. An explicitly enabled browser-extension/browser controls only user-paired Chrome/Edge tabs, including background tabs, using its own session and references. Call status for its pairing code; the user grants a tab in the browser extension. Never infer that pairing, tool approval or full access authorizes another tab or origin. Discovery is configuration/capability information, not authorization or proof that a page is ready.";

pub(super) fn embedded_capability() -> Value {
    json!({
        "plugin":crate::native_browser::PLUGIN,
        "server":crate::native_browser::SERVER,
        "backend":"embedded",
        "visibility":"user-visible",
        "session":"chat-bound-visible-tab",
        "description":"Embedded browser: open pages, inspect and interact. Available with zero tabs; describe control to open this chat's sidebar."
    })
}

/// Verify pinned configuration and current opt-in without resolving env or
/// starting an MCP process. A registered plugin is not a ready browser and its
/// name is not a security attestation of the installed package's behavior.
pub(super) async fn headless_capability(manager: &PluginManager) -> Option<Value> {
    manager
        .mcp_server(HEADLESS_PLUGIN, HEADLESS_SERVER)
        .await
        .ok()?;
    Some(json!({
        "plugin":HEADLESS_PLUGIN,
        "server":HEADLESS_SERVER,
        "backend":"headless",
        "visibility":"background",
        "session":"chat-owned-MCP-context",
        "availability":"configured",
        "readiness":"not-probed",
        "description":"Opt-in browser-use backend for independent public-page tasks. Separate from the visible WebView; no inherited WebView login. Describe its browser tool before use."
    }))
}

/// A configured extension is not a paired tab, and discovery never launches it.
pub(super) async fn extension_capability(manager: &PluginManager) -> Option<Value> {
    manager
        .mcp_server(EXTENSION_PLUGIN, HEADLESS_SERVER)
        .await
        .ok()?;
    Some(json!({"plugin":EXTENSION_PLUGIN,"server":HEADLESS_SERVER,
        "backend":"extension","visibility":"authorized-tabs","session":"explicit-per-chat-pairing",
        "availability":"configured","readiness":"not-probed",
        "description":"Chrome/Edge extension: call browser status for its pairing code; only user-authorized tabs can be controlled, including background tabs. No WebView login transfer."}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{
        io::{Cursor, Write},
        path::PathBuf,
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc,
        },
    };
    use xharness_mcp::McpRuntime;
    use xharness_tools::{ToolExecutor, ToolRegistry, ToolRequest};

    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "xharness-browser-boundary-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    async fn install(root: &Root, server: &str) -> (Arc<PluginManager>, PathBuf) {
        install_named(root, HEADLESS_PLUGIN, server).await
    }
    async fn install_named(
        root: &Root,
        plugin: &str,
        server: &str,
    ) -> (Arc<PluginManager>, PathBuf) {
        // A deliberately unlaunchable process makes discovery's no-start claim
        // observable; env resolution would also fail. Neither is needed to list.
        let config = json!({"mcpServers":{(server):{"type":"stdio", "command":"xharness-browser-boundary-never-launch", "args":[],
            "env":{"BOUNDARY_MISSING":"${XHARNESS_BOUNDARY_UNSET_TEST_VARIABLE}"}}}});
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in [
            (
                ".claude-plugin/plugin.json",
                json!({"name":plugin,"version":"1.0.0"}).to_string(),
            ),
            (".mcp.json", config.to_string()),
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes.as_bytes()).unwrap();
        }
        let bytes = zip.finish().unwrap().into_inner();
        let manager = Arc::new(PluginManager::open(root.0.join("plugins")).unwrap());
        manager.import_catalog(&json!({"plugins":[{"name":plugin,"version":"1.0.0","source":{
            "source":"url","type":"zip","url":"https://example.invalid/browser-boundary.zip","sha256":format!("{:x}",Sha256::digest(&bytes))
        }}]}).to_string()).await.unwrap();
        let installed = manager
            .install_verified_archive(plugin, &bytes)
            .await
            .unwrap();
        assert!(!installed.enabled && !installed.mcp_enabled);
        let config_path = root
            .0
            .join("plugins/packages")
            .join(plugin)
            .join(&installed.digest)
            .join(".mcp.json");
        (manager, config_path)
    }
    async fn executor(manager: Arc<PluginManager>, full_access: bool) -> ToolExecutor {
        let binding = super::super::bind(
            Some(manager),
            Some(Arc::new(McpRuntime::default())),
            None,
            None,
            "boundary-owner".into(),
            full_access,
            None,
        );
        let registry = Arc::new(ToolRegistry::new());
        registry.register(binding.spec).await.unwrap();
        ToolExecutor::new(registry).with_guards(vec![binding.guard])
    }
    async fn index(executor: &ToolExecutor) -> Value {
        let result = executor
            .execute(ToolRequest::new("plugin_mcp", r#"{"action":"list"}"#))
            .await;
        assert!(result.is_ok(), "{result:?}");
        serde_json::from_str(&result.output.unwrap().content).unwrap()
    }
    #[tokio::test]
    async fn disabled_headless_is_not_advertised_or_automatically_enabled() {
        let root = Root::new();
        let (manager, _) = install(&root, HEADLESS_SERVER).await;
        let executor = executor(manager.clone(), true).await;
        assert_eq!(
            index(&executor).await,
            json!({"plugins":[],"capabilities":[]})
        );
        assert!(manager.enabled_mcp_plugins().await.is_empty());
    }
    #[tokio::test]
    async fn configured_headless_is_labeled_without_launch_or_env_resolution() {
        let root = Root::new();
        let (manager, _) = install(&root, HEADLESS_SERVER).await;
        manager
            .set_mcp_enabled(HEADLESS_PLUGIN, true)
            .await
            .unwrap();
        let executor = executor(manager.clone(), true).await;
        let discovered = index(&executor).await;
        assert_eq!(discovered["plugins"], json!([HEADLESS_PLUGIN]));
        assert_eq!(discovered["capabilities"].as_array().unwrap().len(), 1);
        let capability = &discovered["capabilities"][0];
        assert_eq!(capability["backend"], "headless");
        assert_eq!(capability["visibility"], "background");
        assert_eq!(capability["availability"], "configured");
        assert_eq!(capability["readiness"], "not-probed");
        let text = discovered.to_string();
        assert!(text.len() < 1024);
        for private in [
            "BOUNDARY_MISSING",
            "XHARNESS_BOUNDARY_UNSET_TEST_VARIABLE",
            "never-launch",
            "inputSchema",
        ] {
            assert!(!text.contains(private));
        }
        manager
            .set_mcp_enabled(HEADLESS_PLUGIN, false)
            .await
            .unwrap();
        assert_eq!(
            index(&executor).await,
            json!({"plugins":[],"capabilities":[]})
        );
    }
    #[tokio::test]
    async fn extension_discovery_is_configured_not_paired_and_does_not_launch() {
        let root = Root::new();
        let (manager, _) = install_named(&root, EXTENSION_PLUGIN, HEADLESS_SERVER).await;
        let executor = executor(manager.clone(), true).await;
        assert_eq!(
            index(&executor).await,
            json!({"plugins":[],"capabilities":[]})
        );
        manager
            .set_mcp_enabled(EXTENSION_PLUGIN, true)
            .await
            .unwrap();
        let value = index(&executor).await;
        assert_eq!(value["plugins"], json!([EXTENSION_PLUGIN]));
        assert_eq!(value["capabilities"][0]["backend"], "extension");
        assert_eq!(
            value["capabilities"][0]["session"],
            "explicit-per-chat-pairing"
        );
        assert_eq!(value["capabilities"][0]["readiness"], "not-probed");
        manager
            .set_mcp_enabled(EXTENSION_PLUGIN, false)
            .await
            .unwrap();
        assert_eq!(
            index(&executor).await,
            json!({"plugins":[],"capabilities":[]})
        );
    }
    #[tokio::test]
    async fn wrong_server_or_changed_pinned_config_cannot_claim_browser_capability() {
        for wrong_server in [true, false] {
            let root = Root::new();
            let (manager, path) = install(
                &root,
                if wrong_server {
                    "other"
                } else {
                    HEADLESS_SERVER
                },
            )
            .await;
            manager
                .set_mcp_enabled(HEADLESS_PLUGIN, true)
                .await
                .unwrap();
            if !wrong_server {
                std::fs::write(path, b"{}").unwrap();
            }
            let executor = executor(manager, true).await;
            let value = index(&executor).await;
            assert_eq!(value["plugins"], json!([HEADLESS_PLUGIN]));
            assert_eq!(value["capabilities"], json!([]));
        }
    }
    #[tokio::test]
    async fn explicit_embedded_request_never_falls_back_to_configured_headless() {
        let root = Root::new();
        let (manager, _) = install(&root, HEADLESS_SERVER).await;
        manager
            .set_mcp_enabled(HEADLESS_PLUGIN, true)
            .await
            .unwrap();
        let executor = executor(manager, true).await;
        let result = executor.execute(ToolRequest::new("plugin_mcp",json!({"action":"call","plugin":crate::native_browser::PLUGIN,
            "server":crate::native_browser::SERVER,"tool":"control","arguments":{"action":"open","url":"https://example.invalid"}}).to_string())).await;
        assert!(!result.is_ok());
        assert!(result
            .failure
            .unwrap()
            .message
            .contains("native browser is unavailable"));
    }
    #[tokio::test]
    async fn explicit_headless_configuration_failure_does_not_switch_to_embedded() {
        let root = Root::new();
        let (manager, _) = install(&root, HEADLESS_SERVER).await;
        manager
            .set_mcp_enabled(HEADLESS_PLUGIN, true)
            .await
            .unwrap();
        let executor = executor(manager, true).await;
        let result = executor
            .execute(ToolRequest::new(
                "plugin_mcp",
                json!({
                    "action":"call", "plugin":HEADLESS_PLUGIN, "server":HEADLESS_SERVER,
                    "tool":"browser", "arguments":{"action":"tabs"}
                })
                .to_string(),
            ))
            .await;
        assert!(!result.is_ok());
        let message = result.failure.unwrap().message;
        assert!(
            message.contains("XHARNESS_BOUNDARY_UNSET_TEST_VARIABLE"),
            "{message}"
        );
        assert!(!message.contains("native browser"), "{message}");
    }
    #[tokio::test]
    async fn background_calls_still_require_existing_tool_approval() {
        let root = Root::new();
        let (manager, _) = install(&root, HEADLESS_SERVER).await;
        manager
            .set_mcp_enabled(HEADLESS_PLUGIN, true)
            .await
            .unwrap();
        // No UI binding: even top-level discovery keeps its existing approval
        // policy. Capability labels must not loosen either call or index guards.
        let executor = executor(manager, false).await;
        let discovery = executor
            .execute(ToolRequest::new("plugin_mcp", r#"{"action":"list"}"#))
            .await;
        assert_eq!(
            discovery.failure.unwrap().kind,
            xharness_tools::ToolFailureKind::ApprovalUnavailable
        );
        let result = executor
            .execute(ToolRequest::new(
                "plugin_mcp",
                json!({"action":"call","plugin":HEADLESS_PLUGIN,
            "server":HEADLESS_SERVER,"tool":"browser","arguments":{"action":"tabs"}})
                .to_string(),
            ))
            .await;
        assert_eq!(
            result.failure.unwrap().kind,
            xharness_tools::ToolFailureKind::ApprovalUnavailable
        );
    }
    #[test]
    fn embedded_labels_are_compact_and_guidance_does_not_claim_automatic_routing() {
        let capability = embedded_capability();
        assert_eq!(capability["backend"], "embedded");
        assert_eq!(capability["visibility"], "user-visible");
        assert_eq!(capability["session"], "chat-bound-visible-tab");
        assert!(capability.to_string().len() < 450);
        for rule in [
            "public-page tasks",
            "not by inspecting cookies",
            "never mix references",
            "silently switch",
            "ask before",
            "not authorization",
        ] {
            assert!(GUIDANCE.contains(rule), "missing boundary guidance: {rule}");
        }
    }
}

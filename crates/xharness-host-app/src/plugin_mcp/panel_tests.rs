//! Discovery must not execute a UI-only server, including after MCP opt-in.
use super::*;
use sha2::{Digest, Sha256};
use std::io::{Cursor, Write};
use xharness_tools::{ToolExecutor, ToolRegistry, ToolRequest};
#[tokio::test]
async fn an_enabled_but_unopened_editor_cannot_start_through_model_discovery() {
    let root = std::env::temp_dir().join(format!("xh-panel-discovery-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let html = b"<html>fixture</html>";
    let panel = json!({"version":1,"server":"editor","resourceUri":"ui://editor/panel.html","entry":"panel.html","title":"Editor","openTool":"open_editor","assets":{"panel.html":{"bytes":html.len(),"sha256":format!("{:x}",Sha256::digest(html)),"mime":"text/html"}}});
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (path,bytes) in [(".claude-plugin/plugin.json",br#"{"name":"editor","version":"0.1.0"}"#.to_vec()),(".mcp.json",br#"{"mcpServers":{"editor":{"command":"must-never-start-unopened-editor","args":[]}}}"#.to_vec()),(".xharness-ui.json",panel.to_string().into_bytes()),("panel.html",html.to_vec())] {
        zip.start_file(format!("editor/{path}"),zip::write::SimpleFileOptions::default()).unwrap();zip.write_all(&bytes).unwrap();
    }
    let bytes = zip.finish().unwrap().into_inner();
    let manager = Arc::new(PluginManager::open(root.join("plugins")).unwrap());
    manager.import_catalog(&json!({"plugins":[{"name":"editor","version":"0.1.0","source":{"source":"url","type":"zip","url":"https://example.invalid/editor.zip","sha256":format!("{:x}",Sha256::digest(&bytes))}}]}).to_string()).await.unwrap();
    let installed = manager
        .install_verified_archive("editor", &bytes)
        .await
        .unwrap();
    assert!(!installed.enabled && !installed.mcp_enabled);
    manager.set_mcp_enabled("editor", true).await.unwrap();
    let config =
        crate::plugin_panels::scoped_config(&manager, "editor", "editor", root.to_str().unwrap())
            .await
            .unwrap();
    assert_eq!(
        config
            .env
            .get("XHARNESS_PLUGIN_WORKSPACE")
            .map(String::as_str),
        root.to_str()
    );
    let runtime = McpRuntime::new();
    let binding = super::bind_with_workspace(
        Some(manager),
        Some(runtime.clone()),
        None,
        None,
        (
            "editor-session".into(),
            Some(root.to_string_lossy().into_owned()),
        ),
        true,
        None,
    );
    let registry = Arc::new(ToolRegistry::new());
    registry.register(binding.spec).await.unwrap();
    let executor = ToolExecutor::new(registry).with_guards(vec![binding.guard]);
    for action in [
        json!({"action":"list","plugin":"editor","server":"editor"}),
        json!({"action":"call","plugin":"editor","server":"editor","tool":"open_editor","arguments":{}}),
    ] {
        let result = executor
            .execute(ToolRequest::new("plugin_mcp", action.to_string()))
            .await;
        assert!(!result.is_ok());
        assert!(
            format!("{result:?}").contains("visible and ready"),
            "{result:?}"
        );
        assert!(
            !runtime
                .panel_is_open("editor-session", "editor", "editor")
                .await
        );
    }
    runtime.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}

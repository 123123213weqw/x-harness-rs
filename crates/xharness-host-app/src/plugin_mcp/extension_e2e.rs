//! Explicit integration through the existing plugin manager, rmcp transport and tool executor.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{Cursor, Write},
    path::PathBuf,
    sync::Arc,
};
use xharness_mcp::McpRuntime;
use xharness_plugins::PluginManager;
use xharness_tools::{ToolExecutor, ToolRegistry, ToolRequest};

#[tokio::test]
#[ignore = "explicit isolated acceptance: requires built browser-extension JS and Node; no browser or model credentials"]
async fn extension_status_uses_real_plugin_mcp_without_granting_tab_authority() {
    let root = std::env::temp_dir().join(format!(
        "xh-extension-mcp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let package = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../plugins/browser-extension");
    let config = json!({"mcpServers":{"browser":{"type":"stdio","command":"node","args":["${PLUGIN_ROOT}/dist/native/mcp.js"],"env":{"HOME":home.to_str().unwrap(),"USERPROFILE":home.to_str().unwrap()}}}});
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let mut files = vec![
        (
            ".claude-plugin/plugin.json".to_owned(),
            br#"{"name":"browser-extension","version":"0.1.0"}"#.to_vec(),
        ),
        (".mcp.json".to_owned(), config.to_string().into_bytes()),
        ("package.json".to_owned(), br#"{"type":"module"}"#.to_vec()),
    ];
    for name in [
        "dist/native/mcp.js",
        "dist/native/common.js",
        "dist/protocol.js",
    ] {
        files.push((
            name.into(),
            std::fs::read(package.join(name)).expect("build the extension first"),
        ));
    }
    for (name, bytes) in files {
        archive
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(&bytes).unwrap();
    }
    let bytes = archive.finish().unwrap().into_inner();
    let manager = Arc::new(PluginManager::open(root.join("plugins")).unwrap());
    manager.import_catalog(&json!({"plugins":[{"name":"browser-extension","version":"0.1.0","source":{"source":"url","type":"zip","url":"https://example.invalid/browser-extension.zip","sha256":format!("{:x}",Sha256::digest(&bytes))}}]}).to_string()).await.unwrap();
    manager
        .install_verified_archive("browser-extension", &bytes)
        .await
        .unwrap();
    manager
        .set_mcp_enabled("browser-extension", true)
        .await
        .unwrap();
    let runtime = Arc::new(McpRuntime::default());
    let binding = super::bind(
        Some(manager),
        Some(runtime.clone()),
        None,
        None,
        "extension-test-owner".into(),
        true,
        None,
    );
    let registry = Arc::new(ToolRegistry::new());
    registry.register(binding.spec).await.unwrap();
    let executor = ToolExecutor::new(registry).with_guards(vec![binding.guard]);
    let status=executor.execute(ToolRequest::new("plugin_mcp",r#"{"action":"call","plugin":"browser-extension","server":"browser","tool":"browser","arguments":{"action":"status"}}"#)).await;
    assert!(status.is_ok(), "{status:?}");
    let output: Value = serde_json::from_str(&status.output.unwrap().content).unwrap();
    let state: Value =
        serde_json::from_str(output["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(state["connected"], false);
    assert_eq!(state["pairCode"].as_str().unwrap().len(), 8);
    assert!(state.get("token").is_none());
    let denied=executor.execute(ToolRequest::new("plugin_mcp",r#"{"action":"call","plugin":"browser-extension","server":"browser","tool":"browser","arguments":{"action":"observe","tabId":1}}"#)).await;
    assert!(
        !denied.is_ok(),
        "unpaired browser must not become a successful outer tool result"
    );
    runtime.disconnect_owner("extension-test-owner").await;
    std::fs::remove_dir_all(root).unwrap();
}

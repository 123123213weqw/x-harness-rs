//! Opt-in acceptance of an actual catalog archive and its stdio MCP server.
//! Run only on an isolated build host with network access and Node/npm.

use std::{path::PathBuf, sync::Arc};

use serde_json::{json, Value};
use xharness_host::{PermissionPreset, PluginBackend, SessionToolFactory};
use xharness_host_app::{NativePluginBackend, NativeToolFactory};
use xharness_mcp::McpRuntime;
use xharness_plugins::PluginManager;
use xharness_tools::ToolRequest;
use xharness_web::WebRuntime;

const URL: &str =
    "https://cdn-zcode.z.ai/zcode/official-plugin/plugins/cloudbase-skills/0.1.0/plugin.zip";
const SHA256: &str = "d60429f6ed70ef7e16b4f1a11b9afccd28dbef1118eb760f3d045bf7726c7f7c";

#[tokio::test]
#[ignore = "requires live CDN, npm and an isolated test machine"]
async fn real_cloudbase_archive_reaches_mcp_discovery_and_revocation() {
    let root: PathBuf = std::env::temp_dir().join(format!(
        "xharness-live-mcp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let manager = Arc::new(PluginManager::open(root.join("plugins")).unwrap());
    manager
        .import_catalog_scoped(
            &json!({"plugins":[{"name":"cloudbase-skills","version":"0.1.0",
                "source":{"source":"url","type":"zip","url":URL,"sha256":SHA256}}]})
            .to_string(),
            "personal",
        )
        .await
        .unwrap();
    let runtime = McpRuntime::new();
    let backend = NativePluginBackend::new(Arc::clone(&manager), Arc::clone(&runtime));
    let installed = backend
        .call(
            "plugins/install",
            &json!({"args":{"name":"cloudbase-skills"}}),
        )
        .await
        .unwrap();
    assert_eq!(installed["plugin"]["mcpEnabled"], false);
    let preview = backend
        .call(
            "plugins/mcpPreview",
            &json!({"args":{"name":"cloudbase-skills"}}),
        )
        .await
        .unwrap();
    assert_eq!(preview["servers"][0]["command"], "npx");
    assert_eq!(preview["servers"][0]["server"], "cloudbase");

    let factory = NativeToolFactory::new(WebRuntime::default());
    factory.bind_plugins(Arc::clone(&manager)).unwrap();
    factory.bind_mcp(Arc::clone(&runtime)).unwrap();
    let cwd = root.to_str().unwrap();
    let before = factory
        .executor("live-mcp", cwd, PermissionPreset::DangerFullAccess)
        .await
        .unwrap();
    assert!(!before
        .registry()
        .definitions()
        .await
        .iter()
        .any(|tool| tool.name == "plugin_mcp"));

    backend
        .call(
            "plugins/mcpEnable",
            &json!({"args":{"name":"cloudbase-skills"}}),
        )
        .await
        .unwrap();
    let executor = factory
        .executor("live-mcp", cwd, PermissionPreset::DangerFullAccess)
        .await
        .unwrap();
    let list = executor
        .execute(ToolRequest::new("plugin_mcp", r#"{"action":"list"}"#))
        .await;
    assert!(list.is_ok());
    assert!(list.output.unwrap().content.contains("cloudbase-skills"));
    let discover = executor
        .execute(ToolRequest::new(
            "plugin_mcp",
            r#"{"action":"list","plugin":"cloudbase-skills","server":"cloudbase"}"#,
        ))
        .await;
    assert!(discover.is_ok(), "MCP discovery failed: {discover:?}");
    let discover_output = discover.output.unwrap().content;
    println!("CloudBase MCP index bytes: {}", discover_output.len());
    assert!(
        discover_output.len() < 16 * 1024,
        "tool index must stay compact"
    );
    let parsed: Value = serde_json::from_str(&discover_output).unwrap();
    let tools = parsed["tools"].as_array().unwrap();
    assert!(!tools.is_empty());
    println!(
        "CloudBase MCP tool names: {:?}",
        tools.iter().map(|tool| &tool["name"]).collect::<Vec<_>>()
    );
    assert!(tools.iter().all(|tool| tool.get("inputSchema").is_none()));
    let described = executor
        .execute(ToolRequest::new(
            "plugin_mcp",
            r#"{"action":"describe","plugin":"cloudbase-skills","server":"cloudbase","tool":"searchKnowledgeBase"}"#,
        ))
        .await;
    assert!(described.is_ok(), "MCP describe failed: {described:?}");
    let described: Value = serde_json::from_str(&described.output.unwrap().content).unwrap();
    assert_eq!(described["tool"]["name"], "searchKnowledgeBase");
    assert_eq!(described["tool"]["inputSchema"]["type"], "object");
    // This action only lists public documentation modules; it does not need
    // credentials or modify a CloudBase environment.
    let called = executor
        .execute(ToolRequest::new(
            "plugin_mcp",
            r#"{"action":"call","plugin":"cloudbase-skills","server":"cloudbase","tool":"searchKnowledgeBase","arguments":{"mode":"docs","action":"listModules"}}"#,
        ))
        .await;
    assert!(called.is_ok(), "MCP call failed: {called:?}");
    let result: Value = serde_json::from_str(&called.output.unwrap().content).unwrap();
    assert_ne!(result["isError"], true, "MCP server returned {result}");
    let text = result["content"][0]["text"].as_str().unwrap();
    let document: Value = serde_json::from_str(text).unwrap();
    assert_eq!(document["success"], true);
    assert!(document["data"]["modules"]
        .as_array()
        .is_some_and(|items| !items.is_empty()));

    backend
        .call(
            "plugins/mcpDisable",
            &json!({"args":{"name":"cloudbase-skills"}}),
        )
        .await
        .unwrap();
    let denied = executor
        .execute(ToolRequest::new(
            "plugin_mcp",
            r#"{"action":"list","plugin":"cloudbase-skills","server":"cloudbase"}"#,
        ))
        .await;
    assert!(!denied.is_ok(), "old tool snapshot must obey revocation");
    runtime.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}

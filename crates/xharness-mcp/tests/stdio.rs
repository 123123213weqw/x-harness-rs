use serde_json::{json, Map};
use std::{collections::BTreeMap, path::PathBuf};
use xharness_mcp::{McpRuntime, StdioServerConfig};

fn fixture() -> StdioServerConfig {
    StdioServerConfig {
        plugin: "fixture".into(),
        server: "stdio".into(),
        digest: "fixture-digest".into(),
        command: env!("CARGO_BIN_EXE_xharness-mcp-fixture").into(),
        args: Vec::new(),
        env: BTreeMap::new(),
        cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
    }
}

#[tokio::test]
async fn stdio_discovers_calls_and_disconnects_by_owner() {
    let runtime = McpRuntime::new();
    let config = fixture();
    let listed = runtime.list_tools("chat-a", &config).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "echo");
    let arguments: Map<String, serde_json::Value> =
        serde_json::from_value(json!({"text":"hello"})).unwrap();
    let result = runtime
        .call_tool("chat-a", &config, "echo", arguments)
        .await
        .unwrap();
    assert_eq!(result["content"][0]["text"], "hello");
    assert!(runtime
        .call_tool("chat-a", &config, "missing", Map::new())
        .await
        .is_err());
    runtime.disconnect_plugin("fixture").await;
    let listed = runtime.list_tools("chat-b", &config).await.unwrap();
    assert_eq!(listed.len(), 1);
    runtime.disconnect_plugin("fixture").await;
}

#[tokio::test]
async fn disable_cancels_an_in_flight_call_and_closes_the_child() {
    let runtime = McpRuntime::new();
    let config = fixture();
    runtime.list_tools("chat-c", &config).await.unwrap();
    let call_runtime = runtime.clone();
    let call_config = config.clone();
    let call = tokio::spawn(async move {
        let arguments = serde_json::from_value(json!({"text":"sleep"})).unwrap();
        call_runtime
            .call_tool("chat-c", &call_config, "echo", arguments)
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let stopped = tokio::time::timeout(
        std::time::Duration::from_secs(7),
        runtime.disconnect_plugin("fixture"),
    )
    .await;
    assert!(
        stopped.is_ok(),
        "disconnect must settle even when a call is blocked"
    );
    assert!(
        call.await.unwrap().is_err(),
        "revoked call may not return a stale success"
    );
}

#[tokio::test]
async fn host_shutdown_cancels_all_session_connections() {
    let runtime = McpRuntime::new();
    let config = fixture();
    runtime.list_tools("chat-one", &config).await.unwrap();
    runtime.list_tools("chat-two", &config).await.unwrap();
    let call_runtime = runtime.clone();
    let call_config = config.clone();
    let call = tokio::spawn(async move {
        let arguments = serde_json::from_value(json!({"text":"sleep"})).unwrap();
        call_runtime
            .call_tool("chat-two", &call_config, "echo", arguments)
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    tokio::time::timeout(std::time::Duration::from_secs(13), runtime.shutdown())
        .await
        .expect("shutdown must close every child");
    assert!(call.await.unwrap().is_err());
}

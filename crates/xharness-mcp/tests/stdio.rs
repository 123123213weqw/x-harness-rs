use serde_json::{json, Map};
use std::{collections::BTreeMap, path::PathBuf};
use xharness_mcp::{McpError, McpRuntime, StdioServerConfig};

async fn fixture_pid(runtime: &McpRuntime, owner: &str, config: &StdioServerConfig) -> String {
    let arguments = serde_json::from_value(json!({"text":"__pid"})).unwrap();
    runtime
        .call_tool(owner, config, "echo", arguments)
        .await
        .unwrap()["content"][0]["text"]
        .as_str()
        .unwrap()
        .to_owned()
}

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

#[tokio::test]
async fn disabled_plugin_rejects_a_stale_lease_before_relaunch() {
    let runtime = McpRuntime::new();
    let config = fixture();
    let old_lease = runtime.lease("fixture").await;
    runtime.disconnect_plugin("fixture").await;
    assert!(matches!(
        runtime
            .list_tools_with_lease("chat", &config, &old_lease)
            .await,
        Err(McpError::Unavailable(_))
    ));
    let fresh_lease = runtime.lease("fixture").await;
    assert_eq!(
        runtime
            .list_tools_with_lease("chat", &config, &fresh_lease)
            .await
            .unwrap()
            .len(),
        1
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn disable_during_stdio_handshake_prevents_late_connection() {
    let runtime = McpRuntime::new();
    let mut config = fixture();
    config
        .env
        .insert("XH_MCP_FIXTURE_START_DELAY_MS".into(), "500".into());
    let lease = runtime.lease("fixture").await;
    let pending_runtime = runtime.clone();
    let pending_config = config.clone();
    let pending_lease = lease.clone();
    let pending = tokio::spawn(async move {
        pending_runtime
            .list_tools_with_lease("chat", &pending_config, &pending_lease)
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        runtime.disconnect_plugin("fixture"),
    )
    .await
    .expect("disable should not wait for a slow handshake");
    assert!(matches!(
        pending.await.unwrap(),
        Err(McpError::Unavailable(_))
    ));
    assert!(matches!(
        runtime.list_tools_with_lease("chat", &config, &lease).await,
        Err(McpError::Unavailable(_))
    ));
    runtime.shutdown().await;
}

#[tokio::test]
async fn timed_out_call_closes_child_before_next_call() {
    let runtime = McpRuntime::with_timeouts(
        std::time::Duration::from_secs(60),
        std::time::Duration::from_millis(100),
    );
    let config = fixture();
    let before = fixture_pid(&runtime, "chat", &config).await;
    let arguments = serde_json::from_value(json!({"text":"sleep"})).unwrap();
    assert!(matches!(
        runtime.call_tool("chat", &config, "echo", arguments).await,
        Err(McpError::Timeout)
    ));
    let after = fixture_pid(&runtime, "chat", &config).await;
    assert_ne!(
        before, after,
        "a timed-out server must not remain in the runtime"
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn idle_chat_child_is_reaped_and_reconnected_on_demand() {
    let runtime = McpRuntime::with_idle_timeout(std::time::Duration::from_millis(100));
    let config = fixture();
    let before = fixture_pid(&runtime, "chat", &config).await;
    tokio::time::sleep(std::time::Duration::from_millis(350)).await;
    let after = fixture_pid(&runtime, "chat", &config).await;
    assert_ne!(before, after, "idle chat child should be closed");
    runtime.shutdown().await;
}

#[tokio::test]
async fn disconnect_owner_does_not_interrupt_other_chats() {
    let runtime = McpRuntime::new();
    let config = fixture();
    let one = fixture_pid(&runtime, "chat-one", &config).await;
    let two = fixture_pid(&runtime, "chat-two", &config).await;
    runtime.disconnect_owner("chat-one").await;
    assert_eq!(two, fixture_pid(&runtime, "chat-two", &config).await);
    assert_ne!(one, fixture_pid(&runtime, "chat-one", &config).await);
    runtime.shutdown().await;
}

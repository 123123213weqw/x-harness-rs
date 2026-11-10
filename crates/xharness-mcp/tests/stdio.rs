use serde_json::{json, Map};
use std::{collections::BTreeMap, path::PathBuf};
use tokio_util::sync::CancellationToken;
use xharness_mcp::{McpError, McpRuntime, StdioServerConfig};

async fn wait_for_panel_dispatch(runtime: &McpRuntime, owner: &str, config: &StdioServerConfig) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let status = runtime
            .call_app_tool(
                owner,
                config,
                "_editor_reply",
                serde_json::from_value(json!({"mode":"started-count"})).unwrap(),
            )
            .await
            .unwrap();
        if status["content"][0]["text"] == "1" {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "fixture did not dispatch the operation"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

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

#[tokio::test]
async fn panel_replies_are_parallel_hidden_and_pinned_until_explicit_close() {
    let runtime = McpRuntime::new();
    let mut config = fixture();
    config.env.insert("XH_MCP_PANEL_FIXTURE".into(), "1".into());
    assert!(
        !runtime
            .panel_is_open("ui-chat", &config.plugin, &config.server)
            .await
    );
    let tools = runtime.list_tools("ui-chat", &config).await.unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "wait_app");
    assert!(serde_json::to_value(&tools[0])
        .unwrap()
        .get("appOnly")
        .is_none());
    assert!(runtime
        .call_tool("ui-chat", &config, "_editor_reply", Map::new())
        .await
        .is_err());
    let pin = runtime.pin_panel("ui-chat", &config).await.unwrap();
    assert!(
        !runtime
            .panel_is_interactive("ui-chat", &config.plugin, &config.server)
            .await
    );
    pin.set_interactive(true).unwrap();
    assert!(
        runtime
            .panel_is_interactive("ui-chat", &config.plugin, &config.server)
            .await
    );
    pin.set_interactive(false).unwrap();
    assert!(
        !runtime
            .panel_is_interactive("ui-chat", &config.plugin, &config.server)
            .await
    );
    assert!(
        runtime
            .panel_is_open("ui-chat", &config.plugin, &config.server)
            .await
    );
    pin.set_interactive(true).unwrap();
    let run = runtime.clone();
    let cfg = config.clone();
    let pending =
        tokio::spawn(async move { run.call_tool("ui-chat", &cfg, "wait_app", Map::new()).await });
    wait_for_panel_dispatch(&runtime, "ui-chat", &config).await;
    assert!(
        runtime.close_panel("ui-chat", &config).await.is_err(),
        "never close a model operation in flight"
    );
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        runtime.call_app_tool("ui-chat", &config, "_editor_reply", Map::new()),
    )
    .await
    .unwrap()
    .unwrap();
    let result = pending.await.unwrap().unwrap();
    assert_eq!(result["content"][0]["text"], "app-replied");
    let resource = runtime
        .read_app_resource("ui-chat", &config, "ui://fixture/panel")
        .await
        .unwrap();
    assert_eq!(resource["contents"][0]["text"], "panel resource");
    runtime.close_panel("ui-chat", &config).await.unwrap();
    assert!(pin.revoked());
    drop(pin);
    runtime.shutdown().await;
}

#[tokio::test]
async fn a_model_timeout_cannot_discard_a_pinned_unsaved_editor() {
    let runtime = McpRuntime::with_timeouts(
        std::time::Duration::from_secs(60),
        std::time::Duration::from_millis(100),
    );
    let mut config = fixture();
    config.env.insert("XH_MCP_PANEL_FIXTURE".into(), "1".into());
    assert!(
        runtime
            .call_app_tool("editor", &config, "_editor_reply", Map::new())
            .await
            .is_err(),
        "app traffic must never start a process"
    );
    let pin = runtime.pin_panel("editor", &config).await.unwrap();
    pin.set_interactive(true).unwrap();
    assert!(matches!(
        runtime
            .call_tool("editor", &config, "wait_app", Map::new())
            .await,
        Err(McpError::Timeout)
    ));
    assert!(
        !pin.revoked(),
        "outcome-unknown tool timeout must preserve editor memory"
    );
    assert!(
        runtime
            .panel_is_open("editor", &config.plugin, &config.server)
            .await
    );
    runtime
        .call_app_tool("editor", &config, "_editor_reply", Map::new())
        .await
        .unwrap();
    runtime.close_panel("editor", &config).await.unwrap();
    assert!(pin.revoked());
    assert!(
        runtime
            .read_app_resource("editor", &config, "ui://fixture/panel")
            .await
            .is_err(),
        "stale UI must not reconnect a closed process"
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn cancelling_one_editor_request_preserves_both_documents_and_other_session_calls() {
    let runtime = McpRuntime::new();
    let mut config = fixture();
    config.env.insert("XH_MCP_PANEL_FIXTURE".into(), "1".into());
    let one = runtime.pin_panel("one", &config).await.unwrap();
    one.set_interactive(true).unwrap();
    let two = runtime.pin_panel("two", &config).await.unwrap();
    two.set_interactive(true).unwrap();
    let lease = runtime.lease(&config.plugin).await;
    let stop = CancellationToken::new();
    let run = runtime.clone();
    let cfg = config.clone();
    let current = lease.clone();
    let token = stop.clone();
    let pending = tokio::spawn(async move {
        run.call_panel_tool_with_lease("one", &cfg, "wait_app", Map::new(), &current, &token)
            .await
    });
    wait_for_panel_dispatch(&runtime, "one", &config).await;
    stop.cancel();
    let result = tokio::time::timeout(std::time::Duration::from_secs(3), pending)
        .await
        .unwrap()
        .unwrap();
    assert!(result.is_err());
    assert!(
        !one.revoked() && !two.revoked(),
        "a stop cannot close either editor connection"
    );
    let stats = runtime
        .call_app_tool(
            "one",
            &config,
            "_editor_reply",
            serde_json::from_value(json!({"mode":"cancelled-count"})).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        stats["content"][0]["text"], "1",
        "the exact request got a cancellation notification"
    );
    runtime
        .call_app_tool("two", &config, "_editor_reply", Map::new())
        .await
        .unwrap();
    let other = runtime
        .call_panel_tool_with_lease(
            "two",
            &config,
            "wait_app",
            Map::new(),
            &lease,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(other["content"][0]["text"], "app-replied");
    let already = CancellationToken::new();
    already.cancel();
    assert!(runtime
        .call_panel_tool_with_lease("one", &config, "wait_app", Map::new(), &lease, &already)
        .await
        .is_err());
    let stats = runtime
        .call_app_tool(
            "one",
            &config,
            "_editor_reply",
            serde_json::from_value(json!({"mode":"cancelled-count"})).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        stats["content"][0]["text"], "1",
        "pre-dispatch cancellation sent no extra request"
    );
    runtime.close_panel("one", &config).await.unwrap();
    runtime.close_panel("two", &config).await.unwrap();
    runtime.shutdown().await;
}

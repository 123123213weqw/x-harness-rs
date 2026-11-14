//! Contract/approval/transport regressions, not a claim about model task quality.
use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use xharness_tools::{ToolExecutor, ToolFailureKind, ToolRegistry, ToolRequest};

#[tokio::test]
async fn production_factory_exposes_native_without_mcp_and_preserves_allowlist_and_approval() {
    use xharness_host::{PermissionPreset, SessionToolFactory};
    let factory = crate::NativeToolFactory::new(crate::WebRuntime::default());
    factory
        .bind_native_browser(
            NativeBrowser::configuration(Some("127.0.0.1:1".into()), Some("a".repeat(64)))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
    factory
        .restrict_tools(
            crate::tool_allowlist::ToolAllowlist::parse("browser_control,browser_observe").unwrap(),
        )
        .unwrap();
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();
    let executor = factory
        .executor("native-no-mcp", &cwd, PermissionPreset::WorkspaceWrite)
        .await
        .unwrap();
    let names = executor
        .registry()
        .definitions()
        .await
        .into_iter()
        .map(|d| d.name)
        .collect::<Vec<_>>();
    assert_eq!(names, vec!["browser_control", "browser_observe"]);
    let denied = call(
        &executor,
        "browser_control",
        json!({"backend":"browser","action":"status"}),
    )
    .await;
    assert_eq!(
        denied.failure.unwrap().kind,
        ToolFailureKind::ApprovalUnavailable
    );
    assert!(call(&executor, "plugin_mcp", json!({"action":"list"}))
        .await
        .failure
        .is_some());
    factory.shutdown().await.unwrap();
}

async fn fixture(
    full_access: bool,
) -> (
    ToolExecutor,
    Arc<ToolRegistry>,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let native = Arc::new(NativeBrowser {
        address: listener.local_addr().unwrap(),
        token: "a".repeat(64),
        headless: false,
        images: Default::default(),
    });
    let count = Arc::new(AtomicUsize::new(0));
    let seen = count.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let n = stream.read_u32().await.unwrap() as usize;
            assert!(n < 64 * 1024);
            let mut bytes = vec![0; n];
            stream.read_exact(&mut bytes).await.unwrap();
            let request: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(request["token"], "a".repeat(64));
            assert_eq!(request["owner"], "hardening-owner");
            seen.fetch_add(1, Ordering::SeqCst);
            // Simulate connection loss AFTER a write may have been dispatched.
            if request["op"] == "control" && request["arguments"]["action"] == "close"
                || request["op"] == "evaluate" && request["arguments"]["code"] == "lost-reply"
            {
                continue;
            }
            let result = match request["op"].as_str().unwrap() {
                "list" => {
                    json!({"available":true,"headless_available":true,"engine":if request["backend"]=="browser" {"chromium-headless"}else{"tauri-webview"},"bound":false})
                }
                "control" => json!({"ok":true,"state":"ready","effect":"applied"}),
                "observe" => {
                    json!({"scope":"page","frame_id":"1".repeat(32),"text":"fixture marker","nodes":[]})
                }
                "evaluate" => {
                    json!({"ok":true,"effect":"applied","status":"completed","value":request["arguments"]["args"],"console":[]})
                }
                _ => panic!("unexpected fixture operation"),
            };
            let reply = serde_json::to_vec(&json!({"ok":true,"result":result})).unwrap();
            stream.write_u32(reply.len() as u32).await.unwrap();
            stream.write_all(&reply).await.unwrap();
        }
    });
    let binding = crate::plugin_mcp::bind(
        None,
        None,
        Some(native),
        None,
        "hardening-owner".into(),
        full_access,
        None,
    );
    let registry = Arc::new(ToolRegistry::new());
    registry.register(binding.spec).await.unwrap();
    for spec in binding.native_specs {
        registry.register(spec).await.unwrap();
    }
    let executor = ToolExecutor::new(registry.clone()).with_guards(vec![binding.guard]);
    (executor, registry, count, server)
}

async fn call(executor: &ToolExecutor, name: &str, args: Value) -> xharness_tools::ToolResult {
    executor
        .execute(ToolRequest::new(name, args.to_string()))
        .await
}

#[tokio::test]
async fn incident_errors_offer_one_step_repairs_before_any_browser_request() {
    let (executor, _, count, server) = fixture(true).await;
    for name in ["open", "help", "status", "open_tab", "navigate"] {
        let r = call(
            &executor,
            "plugin_mcp",
            json!({"action":"describe","plugin":PLUGIN,"server":HEADLESS_SERVER,"tool":name}),
        )
        .await;
        let failure = r.failure.unwrap();
        let e: Value = serde_json::from_str(&failure.message).unwrap();
        assert_eq!(e["code"], "unknown_browser_tool");
        assert_eq!(e["effect"], "not_started");
        assert!(e["valid_tools"]
            .as_array()
            .unwrap()
            .contains(&json!("control")));
        assert_eq!(e["next_call"]["action"], "list");
    }
    for server_name in [SERVER, HEADLESS_SERVER] {
        let r = call(
            &executor,
            "plugin_mcp",
            json!({"action":"describe","plugin":PLUGIN,"server":server_name}),
        )
        .await;
        let e: Value = serde_json::from_str(&r.failure.unwrap().message).unwrap();
        assert_eq!(e["code"], "missing_mcp_target");
        assert_eq!(e["next_call"]["server"], server_name);
    }
    let r=call(&executor,"plugin_mcp",json!({"action":"call","plugin":PLUGIN,"server":SERVER,"tool":"observe","arguments":{"scope":"summary"}})).await;
    let e: Value = serde_json::from_str(&r.failure.unwrap().message).unwrap();
    assert_eq!(e["code"], "invalid_browser_arguments");
    assert_eq!(
        e["inputSchema"]["properties"]["scope"]["enum"],
        json!(["page", "main", "dialog"])
    );
    let wrong_backend = call(
        &executor,
        "plugin_mcp",
        json!({"action":"describe","plugin":PLUGIN,"server":"guessed-browser","tool":"control"}),
    )
    .await;
    let e: Value = serde_json::from_str(&wrong_backend.failure.unwrap().message).unwrap();
    assert_eq!(e["code"], "unknown_browser_backend");
    assert_eq!(e["next_call"], json!({"action":"list","plugin":PLUGIN}));
    assert_eq!(
        count.load(Ordering::SeqCst),
        0,
        "invalid calls must never reach the browser"
    );
    let repaired=call(&executor,"plugin_mcp",json!({"action":"call","plugin":PLUGIN,"server":SERVER,"tool":"observe","arguments":{"scope":"page"}})).await;
    assert!(repaired.is_ok(), "{repaired:?}");
    assert_eq!(count.load(Ordering::SeqCst), 1);
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn fixed_browser_tools_are_typed_and_keep_existing_approval() {
    let (executor, registry, count, server) = fixture(false).await;
    let definitions = registry.definitions().await;
    assert_eq!(definitions.len(), 9);
    let observe = definitions
        .iter()
        .find(|d| d.name == "browser_observe")
        .unwrap();
    assert_eq!(
        observe.parameters["properties"]["scope"]["enum"],
        json!(["page", "main", "dialog"])
    );
    assert!(observe.parameters["required"]
        .as_array()
        .unwrap()
        .contains(&json!("backend")));
    let result = call(
        &executor,
        "browser_control",
        json!({"backend":"browser","action":"open","url":"https://example.com"}),
    )
    .await;
    assert_eq!(
        result.failure.unwrap().kind,
        ToolFailureKind::ApprovalUnavailable
    );
    assert_eq!(count.load(Ordering::SeqCst), 0);
    let denied = call(
        &executor,
        "browser_evaluate",
        json!({"backend":"webview","code":"return document.cookie"}),
    )
    .await;
    assert_eq!(
        denied.failure.unwrap().kind,
        ToolFailureKind::ApprovalUnavailable
    );
    assert_eq!(count.load(Ordering::SeqCst), 0);
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn arbitrary_javascript_is_direct_discoverable_scoped_and_never_replayed() {
    let (executor, registry, count, server) = fixture(true).await;
    let definitions = registry.definitions().await;
    let evaluate = definitions
        .iter()
        .find(|d| d.name == "browser_evaluate")
        .unwrap();
    assert_eq!(
        evaluate.parameters["properties"]["code"]["maxLength"],
        12000
    );
    for backend in [SERVER, HEADLESS_SERVER] {
        let result=call(&executor,"browser_evaluate",json!({"backend":backend,"code":"window.changed=true;return await fetch('/api',{method:'POST'});","args":{"proof":backend}})).await;
        assert!(result.is_ok(), "{result:?}");
        let described = call(
            &executor,
            "plugin_mcp",
            json!({"action":"describe","plugin":PLUGIN,"server":backend,"tool":"evaluate"}),
        )
        .await;
        assert!(described.is_ok(), "{described:?}");
    }
    let sent = count.load(Ordering::SeqCst);
    for args in [
        json!({"backend":SERVER,"code":"return 1","tab_id":"main"}),
        json!({"backend":SERVER,"code":"return 1","owner":"other"}),
        json!({"backend":SERVER,"code":"return 1","timeout_ms":10001}),
        json!({"backend":SERVER,"code":"x".repeat(12001)}),
    ] {
        assert!(call(&executor, "browser_evaluate", args)
            .await
            .failure
            .is_some());
    }
    assert_eq!(count.load(Ordering::SeqCst), sent);
    let lost = call(
        &executor,
        "browser_evaluate",
        json!({"backend":SERVER,"code":"lost-reply"}),
    )
    .await;
    let message = lost.failure.unwrap().message;
    assert!(message.contains("effect: unknown"));
    assert!(message.contains("do not replay automatically"));
    assert_eq!(count.load(Ordering::SeqCst), sent + 1);
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn typed_and_legacy_valid_calls_work_without_schema_discovery() {
    let (executor, _, count, server) = fixture(true).await;
    for name in ["browser_control", "browser_observe"] {
        let args = if name == "browser_control" {
            json!({"backend":"browser","action":"open","url":"https://example.com"})
        } else {
            json!({"backend":"browser"})
        };
        let r = call(&executor, name, args).await;
        assert!(r.is_ok(), "{r:?}");
    }
    let r=call(&executor,"plugin_mcp",json!({"action":"call","plugin":PLUGIN,"server":SERVER,"tool":"control","arguments":{"action":"open","url":"https://example.com"}})).await;
    assert!(r.is_ok(), "{r:?}");
    assert_eq!(count.load(Ordering::SeqCst), 3);
    for args in [
        json!({"backend":"browser","action":"open"}),
        json!({"backend":"browser","action":"open","url":"https://example.com","owner":"other"}),
        json!({"backend":"browser","scope":"summary"}),
        json!({"backend":"browser","node_offset":-1}),
        json!({"backend":"browser","node_offset":1000001}),
    ] {
        let tool = if args.get("action").is_some() {
            "browser_control"
        } else {
            "browser_observe"
        };
        assert!(call(&executor, tool, args).await.failure.is_some());
    }
    assert_eq!(count.load(Ordering::SeqCst), 3);
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

#[tokio::test]
async fn lost_write_response_is_not_replayed_or_switched_to_another_backend() {
    let (executor, _, count, server) = fixture(true).await;
    let r = call(
        &executor,
        "browser_control",
        json!({"backend":"browser","action":"close"}),
    )
    .await;
    let message = r.failure.unwrap().message;
    assert!(message.contains("effect: unknown"));
    assert!(message.contains("do not replay automatically"));
    assert_eq!(count.load(Ordering::SeqCst), 1);
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

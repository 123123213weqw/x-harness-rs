//! Static editor discovery is read-only; model execution keeps normal approval.
use super::*;
use sha2::{Digest, Sha256};
use std::io::{Cursor, Write};
use xharness_tools::{
    ApprovalDecision, ApprovalProvider, ApprovalRequest, ToolExecutor, ToolFailureKind,
    ToolRegistry, ToolRequest,
};
struct Decision(bool);
#[async_trait::async_trait]
impl ApprovalProvider for Decision {
    async fn request_approval(
        &self,
        _: ApprovalRequest,
    ) -> Result<ApprovalDecision, MiddlewareError> {
        Ok(if self.0 {
            ApprovalDecision::Approved
        } else {
            ApprovalDecision::denied("fixture denied")
        })
    }
}
struct WaitingDecision(Arc<tokio::sync::Notify>);
#[async_trait::async_trait]
impl ApprovalProvider for WaitingDecision {
    async fn request_approval(
        &self,
        request: ApprovalRequest,
    ) -> Result<ApprovalDecision, MiddlewareError> {
        self.0.notify_one();
        request.context.cancellation.cancelled().await;
        Err(MiddlewareError::new("cancelled approval"))
    }
}
#[tokio::test]
async fn ordinary_mode_discovers_pinned_tools_without_starting_editor_and_never_approves_calls() {
    let root = std::env::temp_dir().join(format!(
        "xh-panel-discovery-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let html = b"<html>fixture</html>";
    let panel = json!({"version":1,"server":"editor","resourceUri":"ui://editor/panel.html","entry":"panel.html","title":"Editor","openTool":"open_editor","assets":{"panel.html":{"bytes":html.len(),"sha256":format!("{:x}",Sha256::digest(html)),"mime":"text/html"}}});
    let tools = json!([
        {"name":"inspect","description":"Inspect document","inputSchema":{"type":"object"}},
        {"name":"edit","description":"Edit document","inputSchema":{"type":"object"}},
        {"name":"open_editor","inputSchema":{}},
        {"name":"_reply","inputSchema":{},"_meta":{"ui":{"visibility":["app"]}}}
    ]);
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (path,bytes) in [(".claude-plugin/plugin.json",br#"{"name":"editor","version":"0.1.0"}"#.to_vec()),(".mcp.json",br#"{"mcpServers":{"editor":{"command":"must-never-start-unopened-editor","args":[]},"other":{"command":"must-never-start-foreign-server"}}}"#.to_vec()),(".xharness-ui.json",panel.to_string().into_bytes()),("panel.html",html.to_vec()),("dist/tools.json",tools.to_string().into_bytes())] {
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
    assert!(installed.panel_tools_sha256.is_some());
    assert!(manager.panel_tools("editor", "editor").await.is_err());
    manager.set_mcp_enabled("editor", true).await.unwrap();
    // Stored pin survives reopening; no lazy trust-on-first-read migration.
    let reopened = PluginManager::open(root.join("plugins")).unwrap();
    assert_eq!(
        reopened
            .panel_tools("editor", "editor")
            .await
            .unwrap()
            .len(),
        2
    );
    let runtime = McpRuntime::new();
    let binding = super::bind_with_workspace(
        Some(manager.clone()),
        Some(runtime.clone()),
        None,
        None,
        (
            "editor-session".into(),
            Some(root.to_string_lossy().into_owned()),
        ),
        false,
        None,
    );
    let registry = Arc::new(ToolRegistry::new());
    registry.register(binding.spec).await.unwrap();
    let executor = ToolExecutor::new(registry).with_guards(vec![binding.guard]);
    for args in [
        json!({"action":"list","plugin":"editor"}),
        json!({"action":"list","plugin":"editor","server":"editor"}),
        json!({"action":"describe","plugin":"editor","server":"editor","tool":"inspect"}),
    ] {
        let result = executor
            .execute(ToolRequest::new("plugin_mcp", args.to_string()))
            .await;
        assert!(result.is_ok(), "{result:?}");
        let output = result.output.unwrap().content;
        assert!(!output.contains("_reply") && !output.contains("open_editor"));
        assert!(
            !runtime
                .panel_is_open("editor-session", "editor", "editor")
                .await
        );
    }
    let call =
        json!({"action":"call","plugin":"editor","server":"editor","tool":"edit","arguments":{}});
    assert_eq!(
        executor
            .execute(ToolRequest::new("plugin_mcp", call.to_string()))
            .await
            .failure
            .unwrap()
            .kind,
        ToolFailureKind::ApprovalUnavailable
    );
    let forced = ToolRequest::new(
        "plugin_mcp",
        json!({"action":"list","plugin":"editor","server":"editor"}).to_string(),
    )
    .requiring_approval(true);
    assert_eq!(
        executor.execute(forced).await.failure.unwrap().kind,
        ToolFailureKind::ApprovalUnavailable,
        "static metadata cannot waive an already-durable approval requirement"
    );
    let started = Arc::new(tokio::sync::Notify::new());
    let pending = executor
        .clone()
        .with_approval_provider(Arc::new(WaitingDecision(started.clone())));
    let cancellation = tokio_util::sync::CancellationToken::new();
    let (cancelled, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(
            pending.execute(
                ToolRequest::new("plugin_mcp", call.to_string())
                    .with_cancellation(cancellation.clone())
            ),
            async {
                started.notified().await;
                cancellation.cancel();
            }
        )
    })
    .await
    .expect("approval cancellation must settle");
    assert_eq!(cancelled.failure.unwrap().kind, ToolFailureKind::Cancelled);
    let denied = executor
        .clone()
        .with_approval_provider(Arc::new(Decision(false)));
    assert_eq!(
        denied
            .execute(ToolRequest::new("plugin_mcp", call.to_string()))
            .await
            .failure
            .unwrap()
            .kind,
        ToolFailureKind::ApprovalDenied
    );
    // Approval only admits the call; it cannot bypass editor visibility/readiness.
    let approved = executor
        .clone()
        .with_approval_provider(Arc::new(Decision(true)));
    let result = approved
        .execute(ToolRequest::new("plugin_mcp", call.to_string()))
        .await;
    assert!(
        !result.is_ok() && format!("{result:?}").contains("visible and ready"),
        "{result:?}"
    );
    let open=approved.execute(ToolRequest::new("plugin_mcp",json!({"action":"call","plugin":"editor","server":"editor","tool":"open_editor","arguments":{}}).to_string())).await;
    assert!(
        !open.is_ok() && format!("{open:?}").contains("model calls cannot replace"),
        "{open:?}"
    );
    let foreign = json!({"action":"list","plugin":"editor","server":"other"});
    assert_eq!(
        executor
            .execute(ToolRequest::new("plugin_mcp", foreign.to_string()))
            .await
            .failure
            .unwrap()
            .kind,
        ToolFailureKind::ApprovalUnavailable
    );
    for name in ["_reply", "open_editor", "invented"] {
        assert!(!executor
            .execute(ToolRequest::new(
                "plugin_mcp",
                json!({"action":"describe","plugin":"editor","server":"editor","tool":name})
                    .to_string()
            ))
            .await
            .is_ok());
    }
    let catalog = root
        .join("plugins/packages/editor")
        .join(&installed.digest)
        .join("dist/tools.json");
    std::fs::write(&catalog, b"[]").unwrap();
    assert!(manager.panel_tools("editor", "editor").await.is_err());
    let result = executor
        .execute(ToolRequest::new(
            "plugin_mcp",
            json!({"action":"list","plugin":"editor","server":"editor"}).to_string(),
        ))
        .await;
    assert!(
        !result.is_ok() && format!("{result:?}").contains("static panel tool catalog"),
        "{result:?}"
    );
    manager.set_mcp_enabled("editor", false).await.unwrap();
    assert!(manager.panel_tools("editor", "editor").await.is_err());
    runtime.shutdown().await;
    std::fs::remove_dir_all(root).unwrap();
}

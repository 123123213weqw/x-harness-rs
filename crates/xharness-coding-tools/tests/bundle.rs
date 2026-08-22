use std::{fs, path::PathBuf, sync::Arc};

use async_trait::async_trait;
use serde_json::Value;
use xharness_coding_tools::{CodingToolBundle, STANDARD_TOOL_COUNT};
use xharness_platform::{NativePlatform, PlatformConfig};
use xharness_terminal::TerminalRegistry;
use xharness_tools::{
    ApprovalDecision, ApprovalProvider, ApprovalRequest, MiddlewareError, ToolExecutor, ToolRequest,
};
use xharness_web::WebRuntime;

struct TempWorkspace(PathBuf);

impl TempWorkspace {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("xharness-coding-tools-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct ApproveAll;

#[async_trait]
impl ApprovalProvider for ApproveAll {
    async fn request_approval(
        &self,
        _request: ApprovalRequest,
    ) -> Result<ApprovalDecision, MiddlewareError> {
        Ok(ApprovalDecision::Approved)
    }
}

async fn executor(workspace: &TempWorkspace) -> ToolExecutor {
    let platform =
        Arc::new(NativePlatform::new(PlatformConfig::new(&workspace.0).full_access()).unwrap());
    let bundle = CodingToolBundle::new(
        platform,
        Arc::new(TerminalRegistry::default()),
        Arc::new(WebRuntime::default()),
        "session",
        "owner",
    );
    let registry = bundle.registry().await.unwrap();
    assert_eq!(registry.len().await, STANDARD_TOOL_COUNT);
    assert!(registry.get("write").await.unwrap().requires_approval);
    let names: Vec<String> = registry
        .definitions()
        .await
        .into_iter()
        .map(|definition| definition.name)
        .collect();
    assert_eq!(
        names,
        [
            "bash",
            "edit",
            "glob",
            "grep",
            "read",
            "terminal_close",
            "terminal_list",
            "terminal_open",
            "terminal_read",
            "terminal_send",
            "terminal_signal",
            "web_fetch",
            "web_search",
            "write",
        ]
    );
    ToolExecutor::new(registry).with_approval_provider(Arc::new(ApproveAll))
}

#[tokio::test]
async fn fourteen_tools_register_and_basic_file_shell_flow_runs() {
    let workspace = TempWorkspace::new();
    let executor = executor(&workspace).await;

    let write = executor
        .execute(ToolRequest::new(
            "write",
            r#"{"path":"sample.txt","content":"alpha beta\n"}"#,
        ))
        .await;
    assert!(write.is_ok(), "{write:?}");

    let read = executor
        .execute(ToolRequest::new("read", r#"{"path":"sample.txt"}"#))
        .await;
    assert!(read.is_ok(), "{read:?}");
    assert!(read.output.unwrap().content.contains("alpha beta"));

    fs::write(workspace.0.join("pages.txt"), "one\ntwo\nthree\n").unwrap();
    let first_page = executor
        .execute(ToolRequest::new(
            "read",
            r#"{"path":"pages.txt","line_limit":1}"#,
        ))
        .await;
    assert!(first_page.is_ok(), "{first_page:?}");
    let first_page: Value = serde_json::from_str(&first_page.output.unwrap().content).unwrap();
    assert_eq!(first_page["content"], "one\n");
    let cursor = first_page["next_cursor"].as_str().unwrap();
    let second_page = executor
        .execute(ToolRequest::new(
            "read",
            serde_json::json!({"path":"pages.txt", "cursor":cursor}).to_string(),
        ))
        .await;
    assert!(second_page.is_ok(), "{second_page:?}");
    let second_page: Value = serde_json::from_str(&second_page.output.unwrap().content).unwrap();
    assert_eq!(second_page["content"], "two\n");
    let mut forged = cursor.split(':').collect::<Vec<_>>();
    forged[2] = "999999999";
    let forged_page = executor
        .execute(ToolRequest::new(
            "read",
            serde_json::json!({"path":"pages.txt", "cursor":forged.join(":")}).to_string(),
        ))
        .await;
    assert!(!forged_page.is_ok());

    let edit = executor
        .execute(ToolRequest::new(
            "edit",
            r#"{"path":"sample.txt","old":"beta","new":"BETA"}"#,
        ))
        .await;
    assert!(edit.is_ok(), "{edit:?}");
    assert_eq!(
        fs::read_to_string(workspace.0.join("sample.txt")).unwrap(),
        "alpha BETA\n"
    );

    let bash = executor
        .execute(ToolRequest::new("bash", r#"{"command":"printf shell-ok"}"#))
        .await;
    assert!(bash.is_ok(), "{bash:?}");
    assert!(bash.output.unwrap().content.contains("shell-ok"));
}

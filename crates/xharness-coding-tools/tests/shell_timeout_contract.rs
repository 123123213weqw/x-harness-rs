use async_trait::async_trait;
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use xharness_coding_tools::CodingToolBundle;
use xharness_jobs::JobRegistry;
use xharness_platform::{NativePlatform, PlatformConfig};
use xharness_tools::{
    ApprovalDecision, ApprovalProvider, ApprovalRequest, MiddlewareError, ToolExecutor, ToolRequest,
};
use xharness_web::WebRuntime;
struct Approve;
#[async_trait]
impl ApprovalProvider for Approve {
    async fn request_approval(
        &self,
        _: ApprovalRequest,
    ) -> Result<ApprovalDecision, MiddlewareError> {
        Ok(ApprovalDecision::Approved)
    }
}
static NEXT_WORKSPACE: AtomicU64 = AtomicU64::new(0);

struct TempWorkspace(PathBuf);
impl TempWorkspace {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "xh-timeout-contract-{}-{}",
            std::process::id(),
            NEXT_WORKSPACE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
}
impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

async fn executor(workspace: &TempWorkspace) -> ToolExecutor {
    let platform =
        Arc::new(NativePlatform::new(PlatformConfig::new(&workspace.0).full_access()).unwrap());
    let bundle = CodingToolBundle::new(
        platform,
        Arc::new(JobRegistry::default()),
        Arc::new(WebRuntime::default()),
        "test",
        "test",
    );
    ToolExecutor::new(bundle.registry().await.unwrap()).with_approval_provider(Arc::new(Approve))
}

#[tokio::test]
async fn invalid_timeout_never_spawns_a_command() {
    let workspace = TempWorkspace::new();
    let executor = executor(&workspace).await;
    let shell = if cfg!(windows) { "pwsh" } else { "bash" };
    let command = if cfg!(windows) {
        "Set-Content -LiteralPath sentinel.txt -Value BAD"
    } else {
        "printf BAD > sentinel.txt"
    };
    for value in [
        json!(-1),
        json!(i64::MIN),
        json!(0),
        json!(600001),
        json!(u64::MAX),
        json!(null),
        json!(1.5),
        json!("100"),
        json!(true),
    ] {
        let result = executor
            .execute(ToolRequest::new(
                shell,
                json!({"command":command,"timeout_ms":value}).to_string(),
            ))
            .await;
        assert!(!result.is_ok(), "accepted {value}: {result:?}");
        assert!(
            !workspace.0.join("sentinel.txt").exists(),
            "invalid argument spawned a process"
        );
    }
}

#[tokio::test]
async fn omitted_and_valid_timeouts_keep_command_behavior() {
    let workspace = TempWorkspace::new();
    let executor = executor(&workspace).await;
    let shell = if cfg!(windows) { "pwsh" } else { "bash" };
    let command = if cfg!(windows) {
        "Write-Output timeout-contract-ok"
    } else {
        "printf timeout-contract-ok"
    };
    for timeout in [None, Some(30000), Some(600000)] {
        let mut args = json!({"command":command});
        if let Some(v) = timeout {
            args["timeout_ms"] = json!(v)
        }
        let result = executor
            .execute(ToolRequest::new(shell, args.to_string()))
            .await;
        assert!(result.is_ok(), "{result:?}");
        let output: serde_json::Value =
            serde_json::from_str(&result.output.unwrap().content).unwrap();
        assert!(output["stdout"]
            .as_str()
            .unwrap()
            .contains("timeout-contract-ok"));
    }
}

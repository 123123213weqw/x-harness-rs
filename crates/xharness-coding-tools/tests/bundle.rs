#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use serde_json::Value;
use xharness_coding_tools::{CodingToolBundle, STANDARD_TOOL_COUNT};
use xharness_jobs::JobRegistry;
use xharness_platform::{NativePlatform, PlatformConfig};
use xharness_tools::{
    ApprovalDecision, ApprovalProvider, ApprovalRequest, MiddlewareError, ToolExecutor, ToolRequest,
};
#[cfg(target_os = "linux")]
use xharness_tools::{ToolBatchRequest, ToolFailureKind};
use xharness_web::WebRuntime;

struct TempWorkspace(PathBuf);

static NEXT_WORKSPACE_ID: AtomicU64 = AtomicU64::new(0);

impl TempWorkspace {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xharness-coding-tools-{}-{}",
            std::process::id(),
            NEXT_WORKSPACE_ID.fetch_add(1, Ordering::Relaxed)
        ));
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
        Arc::new(JobRegistry::default()),
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
    let shell = if cfg!(windows) { "pwsh" } else { "bash" };
    let mut expected = vec![
        shell.to_owned(),
        "edit".to_owned(),
        "glob".to_owned(),
        "grep".to_owned(),
        "job_kill".to_owned(),
        "job_list".to_owned(),
        "job_output".to_owned(),
        "read".to_owned(),
        "web_fetch".to_owned(),
        "web_search".to_owned(),
        "write".to_owned(),
    ];
    expected.sort();
    assert_eq!(names, expected);
    ToolExecutor::new(registry).with_approval_provider(Arc::new(ApproveAll))
}

#[tokio::test]
async fn standard_tools_register_and_basic_file_shell_flow_runs() {
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

    let (shell, command) = if cfg!(windows) {
        ("pwsh", "[Console]::Out.Write('shell-ok')")
    } else {
        ("bash", "printf shell-ok")
    };
    let shell = executor
        .execute(ToolRequest::new(
            shell,
            serde_json::json!({"command": command}).to_string(),
        ))
        .await;
    assert!(shell.is_ok(), "{shell:?}");
    assert!(shell.output.unwrap().content.contains("shell-ok"));
}

#[cfg(unix)]
#[tokio::test]
async fn bash_propagates_pipeline_failures_and_allows_explicit_recovery() {
    let workspace = TempWorkspace::new();
    let executor = executor(&workspace).await;

    let failed = executor
        .execute(ToolRequest::new(
            "bash",
            r#"{"command":"(echo 'fatal: push failed' >&2; false) 2>&1 | tail -n 4"}"#,
        ))
        .await;
    assert!(
        failed.is_ok(),
        "the bash handler itself should settle: {failed:?}"
    );
    let failed: Value = serde_json::from_str(&failed.output.unwrap().content).unwrap();
    assert_eq!(failed["success"], false);
    assert_eq!(failed["exit_code"], 1);
    assert_eq!(failed["stdout"], "fatal: push failed\n");

    let recovered = executor
        .execute(ToolRequest::new(
            "bash",
            r#"{"command":"false | true || true"}"#,
        ))
        .await;
    assert!(
        recovered.is_ok(),
        "the bash handler itself should settle: {recovered:?}"
    );
    let recovered: Value = serde_json::from_str(&recovered.output.unwrap().content).unwrap();
    assert_eq!(recovered["success"], true);
    assert_eq!(recovered["exit_code"], 0);
}

#[cfg(windows)]
#[tokio::test]
async fn pwsh_propagates_errors_and_allows_explicit_recovery() {
    let workspace = TempWorkspace::new();
    let executor = executor(&workspace).await;

    let failed = executor
        .execute(ToolRequest::new(
            "pwsh",
            r#"{"command":"throw 'fatal: PowerShell failure'"}"#,
        ))
        .await;
    assert!(failed.is_ok(), "the pwsh handler must settle: {failed:?}");
    let failed: Value = serde_json::from_str(&failed.output.unwrap().content).unwrap();
    assert_eq!(failed["success"], false);
    assert_ne!(failed["exit_code"], 0);
    assert!(failed["stderr"]
        .as_str()
        .unwrap_or_default()
        .contains("fatal: PowerShell failure"));

    let recovered = executor
        .execute(ToolRequest::new(
            "pwsh",
            r#"{"command":"try { throw 'bad' } catch { Write-Output 'recovered' }"}"#,
        ))
        .await;
    assert!(
        recovered.is_ok(),
        "the pwsh handler must settle: {recovered:?}"
    );
    let recovered: Value = serde_json::from_str(&recovered.output.unwrap().content).unwrap();
    assert_eq!(recovered["success"], true);
    assert_eq!(recovered["exit_code"], 0);
    assert_eq!(recovered["stdout"], "recovered\r\n");
}

#[cfg(windows)]
#[tokio::test]
async fn pwsh_can_invoke_an_installed_git_bash_for_explicit_unix_commands() {
    let git_bash = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"))
        .join("Git")
        .join("bin")
        .join("bash.exe");
    if !git_bash.is_file() {
        return;
    }

    let workspace = TempWorkspace::new();
    let executor = executor(&workspace).await;
    let escaped = git_bash.to_string_lossy().replace('\'', "''");
    let command = format!("& '{escaped}' -lc 'printf git-bash-ok'");
    let result = executor
        .execute(ToolRequest::new(
            "pwsh",
            serde_json::json!({"command": command}).to_string(),
        ))
        .await;
    assert!(result.is_ok(), "the pwsh handler must settle: {result:?}");
    let result: Value = serde_json::from_str(&result.output.unwrap().content).unwrap();
    assert_eq!(result["success"], true);
    assert_eq!(result["stdout"], "git-bash-ok");
}

#[cfg(unix)]
#[tokio::test]
async fn background_bash_streams_to_job_output_and_preserves_nonzero_exit_status() {
    let workspace = TempWorkspace::new();
    let executor = executor(&workspace).await;

    let started = executor
        .execute(ToolRequest::new(
            "bash",
            r#"{"command":"printf first; sleep 0.05; printf last; printf warn >&2; exit 7","run_in_background":true}"#,
        ))
        .await;
    assert!(started.is_ok(), "{started:?}");
    let started: Value = serde_json::from_str(&started.output.unwrap().content).unwrap();
    assert_eq!(started["kind"], "background");
    let job_id = started["job_id"].as_str().unwrap();

    let collected = executor
        .execute(ToolRequest::new(
            "job_output",
            serde_json::json!({"job_id": job_id, "wait": true, "timeout_ms": 2_000}).to_string(),
        ))
        .await;
    assert!(collected.is_ok(), "{collected:?}");
    let collected: Value = serde_json::from_str(&collected.output.unwrap().content).unwrap();
    assert_eq!(collected["stdout"], "firstlast");
    assert_eq!(collected["stderr"], "warn");
    assert_eq!(collected["snapshot"]["status"], "completed");
    assert_eq!(collected["snapshot"]["detail"], "exit code: 7");
    assert!(collected["snapshot"].get("owner").is_none());
    assert!(collected["snapshot"].get("reported").is_none());
    assert!(collected["snapshot"].get("output_limit_bytes").is_none());
    assert!(collected["snapshot"].get("pid").is_none());

    let consumed = executor
        .execute(ToolRequest::new(
            "job_output",
            serde_json::json!({"job_id": job_id}).to_string(),
        ))
        .await;
    assert!(consumed.is_ok(), "{consumed:?}");
    let consumed: Value = serde_json::from_str(&consumed.output.unwrap().content).unwrap();
    assert_eq!(consumed["stdout"], "");
    assert_eq!(consumed["stderr"], "");

    let listed = executor.execute(ToolRequest::new("job_list", "{}")).await;
    assert!(listed.is_ok(), "{listed:?}");
    let listed: Value = serde_json::from_str(&listed.output.unwrap().content).unwrap();
    assert_eq!(listed["jobs"][0]["id"], job_id);
}

#[cfg(windows)]
#[tokio::test]
async fn background_pwsh_streams_output_and_preserves_nonzero_exit_status() {
    let workspace = TempWorkspace::new();
    let executor = executor(&workspace).await;

    let started = executor
        .execute(ToolRequest::new(
            "pwsh",
            serde_json::json!({
                "command": "[Console]::Out.Write('first'); Start-Sleep -Milliseconds 50; [Console]::Out.Write('last'); [Console]::Error.Write('warn'); exit 7",
                "run_in_background": true
            })
            .to_string(),
        ))
        .await;
    assert!(started.is_ok(), "{started:?}");
    let started: Value = serde_json::from_str(&started.output.unwrap().content).unwrap();
    let job_id = started["job_id"].as_str().unwrap();

    let collected = executor
        .execute(ToolRequest::new(
            "job_output",
            serde_json::json!({"job_id": job_id, "wait": true, "timeout_ms": 5_000}).to_string(),
        ))
        .await;
    assert!(collected.is_ok(), "{collected:?}");
    let collected: Value = serde_json::from_str(&collected.output.unwrap().content).unwrap();
    assert_eq!(collected["stdout"], "firstlast");
    assert_eq!(collected["stderr"], "warn");
    assert_eq!(collected["snapshot"]["status"], "completed");
    assert_eq!(collected["snapshot"]["detail"], "exit code: 7");
}

#[cfg(unix)]
#[tokio::test]
async fn background_bash_kill_settles_and_invalid_option_combinations_fail_before_spawn() {
    let workspace = TempWorkspace::new();
    let executor = executor(&workspace).await;

    let invalid = executor
        .execute(ToolRequest::new(
            "bash",
            r#"{"command":"sleep 30","run_in_background":true,"timeout_ms":100}"#,
        ))
        .await;
    assert!(!invalid.is_ok());
    let listed = executor.execute(ToolRequest::new("job_list", "{}")).await;
    let listed: Value = serde_json::from_str(&listed.output.unwrap().content).unwrap();
    assert_eq!(listed["jobs"].as_array().unwrap().len(), 0);

    let started = executor
        .execute(ToolRequest::new(
            "bash",
            r#"{"command":"trap '' TERM; sleep 30","run_in_background":true}"#,
        ))
        .await;
    assert!(started.is_ok(), "{started:?}");
    let started: Value = serde_json::from_str(&started.output.unwrap().content).unwrap();
    let job_id = started["job_id"].as_str().unwrap();

    let killed = executor
        .execute(ToolRequest::new(
            "job_kill",
            serde_json::json!({"job_id": job_id, "reason": "test complete"}).to_string(),
        ))
        .await;
    assert!(killed.is_ok(), "{killed:?}");
    let killed: Value = serde_json::from_str(&killed.output.unwrap().content).unwrap();
    assert_eq!(killed["result"], "requested");
    assert_eq!(killed["job"]["status"], "stopping");

    let final_read = executor
        .execute(ToolRequest::new(
            "job_output",
            serde_json::json!({"job_id": job_id, "wait": true, "timeout_ms": 5_000}).to_string(),
        ))
        .await;
    assert!(final_read.is_ok(), "{final_read:?}");
    let final_read: Value = serde_json::from_str(&final_read.output.unwrap().content).unwrap();
    assert_eq!(final_read["snapshot"]["status"], "killed");

    let killed_again = executor
        .execute(ToolRequest::new(
            "job_kill",
            serde_json::json!({"job_id": job_id}).to_string(),
        ))
        .await;
    assert!(killed_again.is_ok(), "{killed_again:?}");
    let killed_again: Value = serde_json::from_str(&killed_again.output.unwrap().content).unwrap();
    assert_eq!(killed_again["result"], "already_finished");
}

#[cfg(windows)]
#[tokio::test]
async fn background_pwsh_kill_settles_without_surviving_processes() {
    let workspace = TempWorkspace::new();
    let executor = executor(&workspace).await;
    let started = executor
        .execute(ToolRequest::new(
            "pwsh",
            r#"{"command":"Start-Sleep -Seconds 30","run_in_background":true}"#,
        ))
        .await;
    assert!(started.is_ok(), "{started:?}");
    let started: Value = serde_json::from_str(&started.output.unwrap().content).unwrap();
    let job_id = started["job_id"].as_str().unwrap();
    let killed = executor
        .execute(ToolRequest::new(
            "job_kill",
            serde_json::json!({"job_id": job_id, "reason": "test complete"}).to_string(),
        ))
        .await;
    assert!(killed.is_ok(), "{killed:?}");
    let final_read = executor
        .execute(ToolRequest::new(
            "job_output",
            serde_json::json!({"job_id": job_id, "wait": true, "timeout_ms": 5_000}).to_string(),
        ))
        .await;
    assert!(final_read.is_ok(), "{final_read:?}");
    let final_read: Value = serde_json::from_str(&final_read.output.unwrap().content).unwrap();
    assert_eq!(final_read["snapshot"]["status"], "killed");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn cancelled_bash_result_is_published_only_after_the_process_tree_is_dead() {
    let workspace = TempWorkspace::new();
    let executor = executor(&workspace).await;
    let pid_file = workspace.0.join("cancelled-bash.pids");
    let command = format!(
        "trap '' TERM; /bin/sleep 30 & child=$!; printf '%s %s' \"$$\" \"$child\" > {}; wait \"$child\"",
        pid_file.display()
    );
    let request = ToolRequest::new("bash", serde_json::json!({"command": command}).to_string())
        .with_execution_id("cancelled-bash")
        .unwrap();
    let mut batch = executor
        .start_batch(vec![ToolBatchRequest::new(0, request)], 1)
        .await
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let pids = loop {
        if let Ok(contents) = fs::read_to_string(&pid_file) {
            let pids = contents
                .split_whitespace()
                .map(str::parse::<u32>)
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            if pids.len() == 2 {
                break pids;
            }
        }
        assert!(Instant::now() < deadline, "bash did not publish its pids");
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    assert!(pids
        .iter()
        .all(|pid| std::path::Path::new(&format!("/proc/{pid}")).exists()));

    batch.cancel();
    while batch.next_event().await.is_some() {}
    let results = batch.result().await.unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(
        results[0].result.failure_kind(),
        Some(ToolFailureKind::Cancelled)
    );
    assert!(
        pids.iter()
            .all(|pid| !std::path::Path::new(&format!("/proc/{pid}")).exists()),
        "tool batch settled while a managed process was still alive: {pids:?}"
    );
}

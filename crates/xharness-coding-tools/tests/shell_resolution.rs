//! Real tool-executor coverage, including an explicitly isolated no-PS7 search.
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use xharness_coding_tools::{CodingToolBundle, STANDARD_TOOL_COUNT};
use xharness_jobs::JobRegistry;
use xharness_platform::{NativePlatform, PlatformConfig};
use xharness_process::shell::{Shell, ShellKind};
use xharness_tools::{
    ApprovalDecision, ApprovalProvider, ApprovalRequest, MiddlewareError, ToolExecutor, ToolRequest,
};
use xharness_web::WebRuntime;

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Workspace(PathBuf);
impl Workspace {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xh-shell 中文 space-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
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
fn tool_name() -> &'static str {
    if cfg!(windows) {
        "pwsh"
    } else {
        "bash"
    }
}
async fn executor(workspace: &Workspace, shell: Shell) -> Arc<ToolExecutor> {
    let platform =
        Arc::new(NativePlatform::new(PlatformConfig::new(&workspace.0).full_access()).unwrap());
    let bundle = CodingToolBundle::new(
        platform,
        Arc::new(JobRegistry::default()),
        Arc::new(WebRuntime::default()),
        "test",
        "test",
    )
    .with_shell(shell.clone());
    let registry = bundle.registry().await.unwrap();
    assert_eq!(registry.len().await, STANDARD_TOOL_COUNT);
    let definition = registry
        .definitions()
        .await
        .into_iter()
        .find(|d| d.name == tool_name())
        .unwrap();
    assert!(definition.description.contains(shell.kind.label()));
    assert!(definition.description.contains(shell.syntax_hint()));
    Arc::new(ToolExecutor::new(registry).with_approval_provider(Arc::new(Approve)))
}
fn native_args(fixture: &str) -> Vec<String> {
    vec![
        "--ignored".into(),
        "--exact".into(),
        fixture.into(),
        "--nocapture".into(),
        "--skip".into(),
        "literal space;$(not-a-command)".into(),
    ]
}
fn native_call(fixture: &str) -> Value {
    json!({"program":std::env::current_exe().unwrap(), "args":native_args(fixture)})
}
fn fixture_script(shell: &Shell, fixture: &str) -> String {
    let exe = std::env::current_exe().unwrap().display().to_string();
    match shell.kind {
        ShellKind::PowerShellCore | ShellKind::WindowsPowerShell => format!(
            "& '{}' --ignored --exact {fixture} --nocapture",
            exe.replace('\'', "''")
        ),
        ShellKind::Cmd => format!("\"{exe}\" --ignored --exact {fixture} --nocapture"),
        _ => format!(
            "'{}' --ignored --exact {fixture} --nocapture",
            exe.replace('\'', "'\\''")
        ),
    }
}

// Only child invocations run these fixtures; no permanent commands or model calls.
#[test]
#[ignore]
fn shell_native_success_fixture() {
    println!(
        "你好|{}|{:?}",
        std::env::current_dir().unwrap().display(),
        std::env::args().collect::<Vec<_>>()
    );
    eprintln!("错误诊断");
}
#[test]
#[ignore]
fn shell_native_failure_fixture() {
    let mut count = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("invocations.txt")
        .unwrap();
    use std::io::Write;
    writeln!(count, "once").unwrap();
    eprintln!("native-exit-seven");
    std::process::exit(7);
}
#[test]
#[ignore]
fn shell_native_wait_fixture() {
    fs::write("started.txt", "ready").unwrap();
    std::thread::sleep(Duration::from_secs(30));
    fs::write("survived.txt", "BAD").unwrap();
}

#[tokio::test]
async fn direct_argv_preserves_unicode_spaces_and_failure_without_replay() {
    let workspace = Workspace::new();
    let shell = Shell::discover().unwrap();
    let executor = executor(&workspace, shell).await;
    let result = executor
        .execute(ToolRequest::new(
            tool_name(),
            native_call("shell_native_success_fixture").to_string(),
        ))
        .await;
    assert!(result.is_ok(), "{result:?}");
    let output: Value = serde_json::from_str(&result.output.unwrap().content).unwrap();
    assert_eq!(output["execution"]["mode"], "direct");
    assert!(output["stdout"].as_str().unwrap().contains("你好"));
    assert!(output["stdout"]
        .as_str()
        .unwrap()
        .contains("literal space;$(not-a-command)"));
    assert!(output["stderr"].as_str().unwrap().contains("错误诊断"));
    let result = executor
        .execute(ToolRequest::new(
            tool_name(),
            native_call("shell_native_failure_fixture").to_string(),
        ))
        .await;
    assert!(!result.is_ok(), "{result:?}");
    let output: Value = serde_json::from_str(&result.output.unwrap().content).unwrap();
    assert_eq!(output["exit_code"], 7);
    assert_eq!(
        fs::read_to_string(workspace.0.join("invocations.txt")).unwrap(),
        "once\n"
    );
}

#[tokio::test]
async fn ambiguous_invocations_are_rejected_before_spawn() {
    let workspace = Workspace::new();
    let shell = Shell::discover().unwrap();
    let script = fixture_script(&shell, "shell_native_failure_fixture");
    let executor = executor(&workspace, shell).await;
    for args in [
        json!({}),
        json!({"command":script,"program":std::env::current_exe().unwrap()}),
        json!({"command":script,"args":[]}),
        json!({"program":""}),
        json!({"program":"missing","args":[7]}),
    ] {
        let result = executor
            .execute(ToolRequest::new(tool_name(), args.to_string()))
            .await;
        assert!(!result.is_ok(), "{args}: {result:?}");
    }
    assert!(!workspace.0.join("invocations.txt").exists());
}

#[tokio::test]
async fn direct_process_timeout_cancel_and_background_use_existing_lifecycle() {
    let workspace = Workspace::new();
    let executor = executor(&workspace, Shell::discover().unwrap()).await;
    let mut args = native_call("shell_native_wait_fixture");
    args["timeout_ms"] = json!(500);
    let result = executor
        .execute(ToolRequest::new(tool_name(), args.to_string()))
        .await;
    assert!(!result.is_ok());
    let output: Value = serde_json::from_str(&result.output.unwrap().content).unwrap();
    assert_eq!(output["termination"], "timedout");
    let _ = fs::remove_file(workspace.0.join("started.txt"));
    let cancellation = CancellationToken::new();
    let request = ToolRequest::new(
        tool_name(),
        native_call("shell_native_wait_fixture").to_string(),
    )
    .with_cancellation(cancellation.clone());
    let running = {
        let executor = executor.clone();
        tokio::spawn(async move { executor.execute(request).await })
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        while !workspace.0.join("started.txt").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    cancellation.cancel();
    let result = tokio::time::timeout(Duration::from_secs(6), running)
        .await
        .unwrap()
        .unwrap();
    assert!(!result.is_ok());
    assert!(!workspace.0.join("survived.txt").exists());
    let mut args = native_call("shell_native_failure_fixture");
    args["run_in_background"] = json!(true);
    let result = executor
        .execute(ToolRequest::new(tool_name(), args.to_string()))
        .await;
    assert!(result.is_ok(), "{result:?}");
    let output: Value = serde_json::from_str(&result.output.unwrap().content).unwrap();
    let result = executor
        .execute(ToolRequest::new(
            "job_output",
            json!({"job_id":output["job_id"],"wait":true,"timeout_ms":5000}).to_string(),
        ))
        .await;
    assert!(result.is_ok(), "{result:?}");
    let output: Value = serde_json::from_str(&result.output.unwrap().content).unwrap();
    assert_eq!(output["snapshot"]["status"], "failed");
}

#[cfg(windows)]
#[tokio::test]
async fn no_ps7_search_runs_real_builtin_51_with_unicode_and_native_exit_7() {
    use xharness_process::shell::ShellSearch;
    let mut search = ShellSearch::from_environment();
    search.configured = None;
    search.user_shell = None;
    search.paths.clear();
    search.program_files = std::env::temp_dir().join("nonexistent-powershell-install");
    let shell = search.resolve(|path| path.is_file()).unwrap();
    assert_eq!(shell.kind, ShellKind::WindowsPowerShell);
    let workspace = Workspace::new();
    let executor = executor(&workspace, shell.clone()).await;
    for script in [
        "[Console]::Out.Write('中文成功'); [Console]::Error.Write('错误诊断')".to_owned(),
        fixture_script(&shell, "shell_native_success_fixture"),
    ] {
        let result = executor
            .execute(ToolRequest::new(
                tool_name(),
                json!({"command":script}).to_string(),
            ))
            .await;
        assert!(result.is_ok(), "{result:?}");
        let output: Value = serde_json::from_str(&result.output.unwrap().content).unwrap();
        assert!(
            output["stdout"].as_str().unwrap().contains('中')
                || output["stdout"].as_str().unwrap().contains("你好")
        );
        assert!(output["stderr"].as_str().unwrap().contains("错误诊断"));
    }
    let command = format!(
        "{}; Write-Output 'later-text-does-not-hide-last-native-error'",
        fixture_script(&shell, "shell_native_failure_fixture")
    );
    let result = executor
        .execute(ToolRequest::new(
            tool_name(),
            json!({"command":command}).to_string(),
        ))
        .await;
    assert!(!result.is_ok(), "{result:?}");
    let output: Value = serde_json::from_str(&result.output.unwrap().content).unwrap();
    assert_eq!(output["exit_code"], 7);
    assert_eq!(
        fs::read_to_string(workspace.0.join("invocations.txt")).unwrap(),
        "once\n"
    );
    let result = executor
        .execute(ToolRequest::new(
            tool_name(),
            json!({"command":"throw 'explicit-failure'"}).to_string(),
        ))
        .await;
    assert!(!result.is_ok());
    let result = executor
        .execute(ToolRequest::new(
            tool_name(),
            json!({"command":"try { throw 'recoverable' } catch { Write-Output 'recovered' }"})
                .to_string(),
        ))
        .await;
    assert!(result.is_ok(), "{result:?}");
    let result = executor
        .execute(ToolRequest::new(
            tool_name(),
            json!({"command":"Start-Sleep -Seconds 30","timeout_ms":500}).to_string(),
        ))
        .await;
    assert!(!result.is_ok());
}

#[cfg(windows)]
#[tokio::test]
async fn cmd_fallback_preserves_a_quoted_executable_and_native_exit_code() {
    let path = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32")
        .join("cmd.exe");
    let shell = Shell::configured(path).unwrap();
    assert_eq!(shell.kind, ShellKind::Cmd);
    let workspace = Workspace::new();
    let executor = executor(&workspace, shell.clone()).await;
    let result = executor
        .execute(ToolRequest::new(
            tool_name(),
            json!({"command":fixture_script(&shell, "shell_native_failure_fixture")}).to_string(),
        ))
        .await;
    assert!(!result.is_ok(), "{result:?}");
    let output: Value = serde_json::from_str(&result.output.unwrap().content).unwrap();
    assert_eq!(output["exit_code"], 7, "{output}");
    assert_eq!(
        fs::read_to_string(workspace.0.join("invocations.txt")).unwrap(),
        "once\n"
    );
}

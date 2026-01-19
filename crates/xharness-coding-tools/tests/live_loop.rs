use std::{fs, path::PathBuf, process::Command, sync::Arc};

use futures::StreamExt;
use xharness_coding_tools::CodingToolBundle;
use xharness_core::{
    AgentMessage, LoopCommand, LoopEngine, LoopEventKind, LoopRequest, LoopStatus,
};
use xharness_debug::{DebugRecorder, DebugTraceConfig, DebugTraceMode};
use xharness_jobs::JobRegistry;
use xharness_platform::{NativePlatform, PlatformConfig};
use xharness_provider_openai::{OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig};
use xharness_session::{
    AssistantChunk, EventData as SessionEventData, MemorySessionStore, Store as SessionStore,
};
use xharness_tools::ToolExecutor;
use xharness_web::WebRuntime;

struct LiveWorkspace(PathBuf);

#[cfg(unix)]
const NATIVE_SHELL_TOOL: &str = "bash";
#[cfg(windows)]
const NATIVE_SHELL_TOOL: &str = "pwsh";
#[cfg(unix)]
const PYTHON_PROGRAM: &str = "python3";
#[cfg(windows)]
const PYTHON_PROGRAM: &str = "python";

impl LiveWorkspace {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xharness-live-loop-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&path).expect("create live-test workspace");
        Self(fs::canonicalize(path).expect("canonical live-test workspace"))
    }
}

impl Drop for LiveWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Opt-in real-model integration test.
///
/// Example:
/// XHARNESS_LIVE_BASE_URL=http://127.0.0.1:8000/v1 \
/// XHARNESS_LIVE_MODEL=qwen3.8-27b-uncensored \
/// cargo test -p xharness-coding-tools --test live_loop -- --ignored --nocapture
#[tokio::test]
#[ignore = "requires a live OpenAI-compatible model endpoint"]
async fn live_model_calls_real_tool_and_finishes_the_loop() {
    let base_url = std::env::var("XHARNESS_LIVE_BASE_URL").expect("XHARNESS_LIVE_BASE_URL");
    let model = std::env::var("XHARNESS_LIVE_MODEL").expect("XHARNESS_LIVE_MODEL");
    let api_key = std::env::var("XHARNESS_LIVE_API_KEY").unwrap_or_else(|_| "local".to_owned());

    let workspace = LiveWorkspace::new();
    let platform = Arc::new(NativePlatform::new(PlatformConfig::new(&workspace.0)).unwrap());
    let bundle = CodingToolBundle::new(
        platform,
        Arc::new(JobRegistry::default()),
        Arc::new(WebRuntime::default()),
        "live-session",
        "live-agent",
    );
    let tool_executor = ToolExecutor::new(bundle.registry().await.unwrap());
    let provider = OpenAiProvider::new(OpenAiProviderConfig::new(
        OpenAiProtocol::ChatCompletions,
        base_url,
        api_key,
        model,
    ))
    .unwrap();

    let prompt = concat!(
        "This is an end-to-end coding-agent test. You MUST call the `write` tool exactly once. ",
        "Create `live-loop-proof.txt` with the exact content `v100-loop-ok\\n`. ",
        "After the tool succeeds, do not call another tool and reply with exactly `DONE`."
    );
    let mut request = LoopRequest::new(Arc::new(provider), vec![AgentMessage::user(prompt)]);
    request.tool_executor = Some(tool_executor);
    let mut run = LoopEngine.start(request);

    let mut started = Vec::new();
    let mut completed = Vec::new();
    while let Some(event) = run.next().await {
        println!("step={} event={:?}", event.step, event.kind);
        match event.kind {
            LoopEventKind::ToolApprovalRequested { call, .. } => run
                .send(LoopCommand::ApproveTool { call_id: call.id })
                .await
                .expect("approve requested live tool"),
            LoopEventKind::ToolStarted(call) => started.push(call.name),
            LoopEventKind::ToolCompleted { call, result } => {
                assert!(result.ok, "live tool failed: {}", result.error);
                completed.push(call.name);
            }
            _ => {}
        }
    }
    let result = run.result().await;
    println!("result={result:?}");

    assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
    assert_eq!(started, ["write"]);
    assert_eq!(completed, ["write"]);
    assert_eq!(result.final_text.trim(), "DONE");
    assert_eq!(
        fs::read_to_string(workspace.0.join("live-loop-proof.txt")).unwrap(),
        "v100-loop-ok\n"
    );
}

/// Behavioral probe for the managed-background contract. This deliberately
/// mentions legacy PTY/nohup patterns, then verifies that a real model follows
/// the advertised Harness-native API instead of synthesizing its own daemon.
#[tokio::test]
#[ignore = "requires a live DeepSeek OpenAI-compatible endpoint"]
async fn live_deepseek_uses_managed_jobs_instead_of_pty_or_nohup() {
    let base_url = std::env::var("XHARNESS_LIVE_BASE_URL").expect("XHARNESS_LIVE_BASE_URL");
    let model = std::env::var("XHARNESS_LIVE_MODEL").expect("XHARNESS_LIVE_MODEL");
    let api_key = std::env::var("XHARNESS_LIVE_API_KEY").expect("XHARNESS_LIVE_API_KEY");

    let workspace = LiveWorkspace::new();
    let platform = Arc::new(
        NativePlatform::new(PlatformConfig::new(&workspace.0).full_access())
            .expect("create live-test platform"),
    );
    let bundle = CodingToolBundle::new(
        platform,
        Arc::new(JobRegistry::default()),
        Arc::new(WebRuntime::default()),
        "deepseek-job-session",
        "deepseek-job-agent",
    );
    let registry = bundle.registry().await.expect("register live tools");
    let definitions = registry.definitions().await;
    assert_eq!(
        definitions
            .iter()
            .filter(|tool| tool.name.starts_with("terminal_"))
            .count(),
        0,
        "persistent Terminal tools must not be model-facing"
    );
    let tool_executor = ToolExecutor::new(registry);
    let provider = OpenAiProvider::new(OpenAiProviderConfig::new(
        OpenAiProtocol::ChatCompletions,
        base_url,
        api_key,
        model,
    ))
    .expect("create live DeepSeek provider");

    let background_command = if cfg!(windows) {
        "Start-Sleep -Seconds 1; Write-Output 'deepseek-job-ok'"
    } else {
        "sleep 1; printf 'deepseek-job-ok\\n'"
    };
    let mut request = LoopRequest::new(
        Arc::new(provider),
        vec![
            AgentMessage::system(format!(
                "For long-running non-interactive commands use {NATIVE_SHELL_TOOL} with \
                 run_in_background=true, retain the returned job_id, and collect it with \
                 job_output. Never emulate a managed background job with shell detachment, \
                 nohup, disown, screen, tmux, or a PTY."
            )),
            AgentMessage::user(format!(
                "Run this as a managed background job and return only after collecting its \
                 successful output: `{background_command}`. You must choose the Harness-native \
                 method exposed by the tools."
            )),
        ],
    );
    request.tool_executor = Some(tool_executor);
    let mut run = LoopEngine.start(request);

    let mut calls = Vec::new();
    while let Some(event) = run.next().await {
        println!("step={} event={:?}", event.step, event.kind);
        match event.kind {
            LoopEventKind::ToolApprovalRequested { call, .. } => run
                .send(LoopCommand::ApproveTool { call_id: call.id })
                .await
                .expect("approve live background command"),
            LoopEventKind::ToolStarted(call) => {
                calls.push((call.name, call.arguments_json));
            }
            LoopEventKind::ToolCompleted { call, result } => {
                assert!(result.ok, "{} failed: {}", call.name, result.error);
            }
            _ => {}
        }
    }
    let result = run.result().await;
    println!("deepseek background calls={calls:?}");
    println!("deepseek background result={result:?}");

    assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
    let shell = calls
        .iter()
        .find(|(name, _)| name == NATIVE_SHELL_TOOL)
        .expect("DeepSeek did not call the native shell tool");
    let shell_arguments: serde_json::Value =
        serde_json::from_str(&shell.1).expect("DeepSeek emitted invalid shell arguments");
    assert_eq!(shell_arguments["run_in_background"], true);
    let command = shell_arguments["command"].as_str().unwrap_or_default();
    for forbidden in ["nohup", "disown", "tmux", "screen", "pty"] {
        assert!(
            !command.to_ascii_lowercase().contains(forbidden),
            "DeepSeek bypassed managed jobs with {forbidden}: {command}"
        );
    }
    assert!(
        calls.iter().any(|(name, _)| name == "job_output"),
        "DeepSeek never collected the managed job"
    );
    assert!(result.final_text.contains("deepseek-job-ok"));
}

/// Release-candidate coding acceptance: a real DeepSeek Flash must inspect a
/// small broken program, repair it through the ordinary tools and run its
/// tests. The test then validates the artifact independently and audits the
/// existing Full Debug interface instead of trusting the model's final text.
#[tokio::test]
#[ignore = "requires a live DeepSeek Flash endpoint"]
async fn live_deepseek_flash_repairs_code_and_emits_complete_debug_evidence() {
    let base_url = std::env::var("XHARNESS_LIVE_BASE_URL").expect("XHARNESS_LIVE_BASE_URL");
    let model = std::env::var("XHARNESS_LIVE_MODEL").expect("XHARNESS_LIVE_MODEL");
    let api_key = std::env::var("XHARNESS_LIVE_API_KEY").expect("XHARNESS_LIVE_API_KEY");

    let workspace = LiveWorkspace::new();
    let implementation = workspace.0.join("math_utils.py");
    let tests = workspace.0.join("test_math_utils.py");
    fs::write(
        &implementation,
        concat!(
            "def clamp(value, low, high):\n",
            "    \"\"\"Clamp value to the inclusive [low, high] interval.\"\"\"\n",
            "    if low > high:\n",
            "        raise ValueError('low must not exceed high')\n",
            "    # BUG: the bounds are applied in the wrong order.\n",
            "    return max(high, min(low, value))\n",
        ),
    )
    .unwrap();
    let test_source = concat!(
        "from math_utils import clamp\n",
        "assert clamp(-4, 0, 10) == 0\n",
        "assert clamp(4, 0, 10) == 4\n",
        "assert clamp(40, 0, 10) == 10\n",
        "try:\n",
        "    clamp(1, 2, 1)\n",
        "except ValueError:\n",
        "    pass\n",
        "else:\n",
        "    raise AssertionError('invalid interval must fail')\n",
        "print('coding-task-ok')\n",
    );
    fs::write(&tests, test_source).unwrap();

    let debug_root = std::env::var_os("XHARNESS_LIVE_DEBUG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace.0.join("debug"));
    let (debug, info) =
        DebugRecorder::open(DebugTraceConfig::new(DebugTraceMode::Full, debug_root))
            .await
            .expect("open Full Debug trace");
    let info = info.expect("Full Debug returns trace coordinates");

    let platform = Arc::new(
        NativePlatform::with_debug(PlatformConfig::new(&workspace.0), debug.clone())
            .expect("create debug-enabled platform"),
    );
    let bundle = CodingToolBundle::new(
        platform,
        Arc::new(JobRegistry::default()),
        Arc::new(WebRuntime::default().with_debug(debug.clone())),
        "deepseek-coding-session",
        "deepseek-coding-agent",
    );
    let tool_executor =
        ToolExecutor::new(bundle.registry().await.unwrap()).with_debug(debug.clone());
    let provider = OpenAiProvider::new(OpenAiProviderConfig::new(
        OpenAiProtocol::ChatCompletions,
        base_url,
        api_key.clone(),
        model,
    ))
    .expect("create live DeepSeek provider")
    .with_debug(debug.clone());

    let prompt = format!(
        "You are fixing a real isolated coding task. Inspect `math_utils.py` and \
         `test_math_utils.py`, correct the implementation without changing the test file, \
         then run `{PYTHON_PROGRAM} test_math_utils.py` with the {NATIVE_SHELL_TOOL} tool. \
         Do not merely describe the patch. Finish only after the command succeeds and include \
         `FIXED` in the final answer."
    );
    let mut request = LoopRequest::new(Arc::new(provider), vec![AgentMessage::user(prompt)]);
    request.debug = debug.clone();
    request.tool_executor = Some(tool_executor);
    let journal = Arc::new(MemorySessionStore::default());
    request.session_id = Some("deepseek-flash-coding-acceptance".to_owned());
    request.journal_store = Some(journal.clone());
    let mut run = LoopEngine.start(request);

    let mut calls = Vec::new();
    let mut live_tool_argument_deltas = 0usize;
    while let Some(event) = run.next().await {
        match event.kind {
            LoopEventKind::ToolApprovalRequested { call, .. } => run
                .send(LoopCommand::ApproveTool { call_id: call.id })
                .await
                .expect("approve isolated live tool"),
            LoopEventKind::ToolStarted(call) => {
                println!("coding tool={} args={}", call.name, call.arguments_json);
                calls.push(call.name);
            }
            LoopEventKind::ToolCallDelta { .. } => {
                live_tool_argument_deltas = live_tool_argument_deltas.saturating_add(1);
            }
            LoopEventKind::ToolCompleted { call, result } => {
                println!(
                    "coding tool={} ok={} truncated={}",
                    call.name, result.ok, result.truncated
                );
            }
            _ => {}
        }
    }
    let result = run.result().await;
    debug.flush().await.expect("flush Full Debug trace");
    println!("coding result status={:?}", result.status);
    println!("debug trace={}", info.directory.display());

    assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
    assert!(result.final_text.contains("FIXED"));
    assert!(calls.iter().any(|name| name == "read"));
    assert!(calls.iter().any(|name| name == "edit" || name == "write"));
    assert!(calls.iter().any(|name| name == NATIVE_SHELL_TOOL));
    let durable = journal
        .load("deepseek-flash-coding-acceptance")
        .await
        .unwrap()
        .unwrap();
    let durable_tool_argument_chunks = durable
        .events()
        .iter()
        .filter(|event| {
            matches!(
                event.data(),
                SessionEventData::AssistantChunk {
                    chunk: AssistantChunk::ToolCallDelta { .. },
                    ..
                }
            )
        })
        .count();
    println!(
        "tool argument stream live_deltas={} durable_chunks={}",
        live_tool_argument_deltas, durable_tool_argument_chunks
    );
    assert!(live_tool_argument_deltas >= calls.len());
    assert!(durable_tool_argument_chunks <= live_tool_argument_deltas);
    assert_eq!(
        fs::read_to_string(&tests).unwrap(),
        test_source,
        "the model changed the acceptance test"
    );
    let external = Command::new(PYTHON_PROGRAM)
        .arg("test_math_utils.py")
        .current_dir(&workspace.0)
        .output()
        .expect("run independent acceptance test");
    assert!(
        external.status.success(),
        "external test failed: stdout={} stderr={}",
        String::from_utf8_lossy(&external.stdout),
        String::from_utf8_lossy(&external.stderr)
    );

    let trace = fs::read_to_string(&info.events_path).expect("read flushed debug trace");
    for layer in ["core", "provider.openai", "tools", "process"] {
        assert!(
            trace.contains(&format!(r#""layer":"{layer}""#)),
            "debug trace omitted {layer} evidence"
        );
    }
    assert!(trace.contains(r#""event":"request""#));
    assert!(trace.contains(r#""event":"execute.completed""#));
    assert!(
        !trace.contains(&api_key),
        "Full Debug trace leaked the provider API key"
    );
}

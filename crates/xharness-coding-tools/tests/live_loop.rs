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

/// Release-candidate coding acceptance: a real DeepSeek model must inspect a
/// multi-file scheduling package, repair interacting parsing and dependency
/// bugs through the ordinary tools, and run its visible tests. The harness
/// then runs hidden acceptance cases and audits the Full Debug evidence instead
/// of trusting the model's final text.
#[tokio::test]
#[ignore = "requires a live DeepSeek Flash endpoint"]
async fn live_deepseek_flash_repairs_code_and_emits_complete_debug_evidence() {
    let base_url = std::env::var("XHARNESS_LIVE_BASE_URL").expect("XHARNESS_LIVE_BASE_URL");
    let model = std::env::var("XHARNESS_LIVE_MODEL").expect("XHARNESS_LIVE_MODEL");
    let api_key = std::env::var("XHARNESS_LIVE_API_KEY").expect("XHARNESS_LIVE_API_KEY");

    let workspace = LiveWorkspace::new();
    let requirements = workspace.0.join("REQUIREMENTS.md");
    let duration_implementation = workspace.0.join("duration_utils.py");
    let scheduler_implementation = workspace.0.join("scheduler.py");
    let tests = workspace.0.join("test_scheduler.py");
    let requirements_source = concat!(
        "# Scheduling package\n\n",
        "- `parse_duration` accepts a non-negative integer followed by `ms`, `s`, `m`, or `h`. ",
        "Leading/trailing whitespace and unit case are ignored; malformed or unsupported values raise `ValueError`.\n",
        "- `build_schedule` validates unique task ids and known dependencies, rejects dependency cycles with `ValueError`, ",
        "and returns every task once in stable dependency order.\n",
        "- A task starts when all dependencies finish. Independent tasks start at zero and may overlap. ",
        "Each result contains `id`, `start_ms`, and `finish_ms`.\n",
    );
    fs::write(&requirements, requirements_source).unwrap();
    fs::write(
        &duration_implementation,
        concat!(
            "_UNIT_MS = {'ms': 1, 's': 1_000, 'm': 60_000, 'h': 3_600_000}\n\n",
            "def parse_duration(value):\n",
            "    \"\"\"Parse one duration according to REQUIREMENTS.md.\"\"\"\n",
            "    text = value.strip().lower()\n",
            "    # BUG: this assumes every suffix has exactly one character.\n",
            "    amount = int(text[:-1])\n",
            "    return amount * _UNIT_MS[text[-1]]\n",
        ),
    )
    .unwrap();
    fs::write(
        &scheduler_implementation,
        concat!(
            "from duration_utils import parse_duration\n\n",
            "def build_schedule(tasks):\n",
            "    \"\"\"Build a deterministic dependency-aware schedule.\"\"\"\n",
            "    # BUG: this ignores dependencies and serializes unrelated work.\n",
            "    elapsed = 0\n",
            "    result = []\n",
            "    for task in tasks:\n",
            "        duration_ms = parse_duration(task['duration'])\n",
            "        result.append({\n",
            "            'id': task['id'],\n",
            "            'start_ms': elapsed,\n",
            "            'finish_ms': elapsed + duration_ms,\n",
            "        })\n",
            "        elapsed += duration_ms\n",
            "    return result\n",
        ),
    )
    .unwrap();
    let original_duration = fs::read_to_string(&duration_implementation).unwrap();
    let original_scheduler = fs::read_to_string(&scheduler_implementation).unwrap();
    let test_source = concat!(
        "from duration_utils import parse_duration\n",
        "from scheduler import build_schedule\n\n",
        "assert parse_duration('250ms') == 250\n",
        "assert parse_duration('2s') == 2_000\n",
        "assert parse_duration('3m') == 180_000\n",
        "assert parse_duration('1h') == 3_600_000\n\n",
        "tasks = [\n",
        "    {'id': 'package', 'duration': '500ms', 'depends_on': ['compile']},\n",
        "    {'id': 'lint', 'duration': '2s', 'depends_on': []},\n",
        "    {'id': 'compile', 'duration': '1s', 'depends_on': []},\n",
        "]\n",
        "assert build_schedule(tasks) == [\n",
        "    {'id': 'lint', 'start_ms': 0, 'finish_ms': 2_000},\n",
        "    {'id': 'compile', 'start_ms': 0, 'finish_ms': 1_000},\n",
        "    {'id': 'package', 'start_ms': 1_000, 'finish_ms': 1_500},\n",
        "]\n\n",
        "for invalid in (\n",
        "    [{'id': 'a', 'duration': '1s', 'depends_on': ['missing']}],\n",
        "    [{'id': 'a', 'duration': '1s', 'depends_on': ['b']}, {'id': 'b', 'duration': '1s', 'depends_on': ['a']}],\n",
        "):\n",
        "    try:\n",
        "        build_schedule(invalid)\n",
        "    except ValueError:\n",
        "        pass\n",
        "    else:\n",
        "        raise AssertionError('invalid dependency graph must fail')\n\n",
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
        "You are fixing a real isolated multi-file coding task. Read `REQUIREMENTS.md`, \
         `duration_utils.py`, `scheduler.py`, and `test_scheduler.py`. Correct both implementation \
         files without changing the requirements or test file, then run \
         `{PYTHON_PROGRAM} test_scheduler.py` with the {NATIVE_SHELL_TOOL} tool. Diagnose failures \
         and iterate until the command succeeds. Do not merely describe the patch. Finish only \
         after verification and include `FIXED` in the final answer."
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
    assert_eq!(
        fs::read_to_string(&requirements).unwrap(),
        requirements_source,
        "the model changed the requirements"
    );
    assert_ne!(
        fs::read_to_string(&duration_implementation).unwrap(),
        original_duration,
        "the model did not repair duration_utils.py"
    );
    assert_ne!(
        fs::read_to_string(&scheduler_implementation).unwrap(),
        original_scheduler,
        "the model did not repair scheduler.py"
    );
    let hidden_test = workspace.0.join("hidden_acceptance.py");
    fs::write(
        &hidden_test,
        concat!(
            "from duration_utils import parse_duration\n",
            "from scheduler import build_schedule\n\n",
            "assert parse_duration(' 15S ') == 15_000\n",
            "assert parse_duration('0ms') == 0\n",
            "for invalid_duration in ('-1s', '1d', 'ten seconds', ''):\n",
            "    try:\n",
            "        parse_duration(invalid_duration)\n",
            "    except ValueError:\n",
            "        pass\n",
            "    else:\n",
            "        raise AssertionError(invalid_duration)\n\n",
            "diamond = [\n",
            "    {'id': 'release', 'duration': '1s', 'depends_on': ['build', 'lint']},\n",
            "    {'id': 'build', 'duration': '3s', 'depends_on': ['fetch']},\n",
            "    {'id': 'lint', 'duration': '2s', 'depends_on': ['fetch']},\n",
            "    {'id': 'fetch', 'duration': '500ms', 'depends_on': []},\n",
            "]\n",
            "assert build_schedule(diamond) == [\n",
            "    {'id': 'fetch', 'start_ms': 0, 'finish_ms': 500},\n",
            "    {'id': 'build', 'start_ms': 500, 'finish_ms': 3_500},\n",
            "    {'id': 'lint', 'start_ms': 500, 'finish_ms': 2_500},\n",
            "    {'id': 'release', 'start_ms': 3_500, 'finish_ms': 4_500},\n",
            "]\n",
            "try:\n",
            "    build_schedule([\n",
            "        {'id': 'same', 'duration': '1s', 'depends_on': []},\n",
            "        {'id': 'same', 'duration': '2s', 'depends_on': []},\n",
            "    ])\n",
            "except ValueError:\n",
            "    pass\n",
            "else:\n",
            "    raise AssertionError('duplicate task ids must fail')\n",
            "print('hidden-acceptance-ok')\n",
        ),
    )
    .unwrap();
    let external = Command::new(PYTHON_PROGRAM)
        .arg("hidden_acceptance.py")
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

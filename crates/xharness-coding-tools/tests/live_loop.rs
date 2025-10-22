use std::{fs, path::PathBuf, sync::Arc};

use futures::StreamExt;
use xharness_coding_tools::CodingToolBundle;
use xharness_core::{
    AgentMessage, LoopCommand, LoopEngine, LoopEventKind, LoopRequest, LoopStatus,
};
use xharness_platform::{NativePlatform, PlatformConfig};
use xharness_provider_openai::{OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig};
use xharness_terminal::TerminalRegistry;
use xharness_web::WebRuntime;

struct LiveWorkspace(PathBuf);

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
        Arc::new(TerminalRegistry::default()),
        Arc::new(WebRuntime::default()),
        "live-session",
        "live-agent",
    );
    let tools = bundle.core_specs().await.unwrap();
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
    request.tools = tools;
    let mut run = LoopEngine.start(request);

    let mut started = Vec::new();
    let mut completed = Vec::new();
    while let Some(event) = run.next().await {
        println!("step={} event={:?}", event.step, event.kind);
        match event.kind {
            LoopEventKind::ToolApprovalRequested { call } => run
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

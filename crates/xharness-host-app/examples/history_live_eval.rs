//! Opt-in small real-provider A/B pilot. No shell, paths or credentials exposed to tools.
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use xharness_core::{AgentMessage, IdentityContextPolicy, LoopCommand, TokenUsage};
use xharness_host::{
    AgentRuntime, AgentTurnRequest, DurableLoopAgentRuntime, ModelRoute, PermissionPreset,
    SessionToolFactory,
};
use xharness_provider_openai::{OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig};
use xharness_session::{EventData, SessionHeader, Store};
use xharness_tools::{
    ToolDefinition, ToolExecutor, ToolHandlerError, ToolOutput, ToolRegistry, ToolSpec,
};

struct Fixture {
    source: Arc<Mutex<String>>,
    observed: Arc<AtomicBool>,
    recovery: bool,
}

#[async_trait]
impl SessionToolFactory for Fixture {
    async fn executor(
        &self,
        _: &str,
        _: &str,
        _: PermissionPreset,
    ) -> Result<ToolExecutor, String> {
        let registry = Arc::new(ToolRegistry::new());
        let source = self.source.clone();
        registry
            .register(ToolSpec::new(
                ToolDefinition::new(
                    "read",
                    "Read the current retry.py source. No arguments.",
                    json!({"type":"object","properties":{},"additionalProperties":false}),
                ),
                move |_| {
                    let source = source.clone();
                    async move { Ok(ToolOutput::text(source.lock().unwrap().clone())) }
                },
            ))
            .await
            .map_err(|e| e.to_string())?;
        let source = self.source.clone();
        registry.register(ToolSpec::new(ToolDefinition::new("write", "Replace retry.py. Only plain def retry_ms(attempt), if/raise/return, arithmetic, comparisons, integer literals and min/max/ValueError calls are supported. No imports, attributes, assignments, annotations, loops or other functions. Maximum 8192 bytes.", json!({"type":"object","required":["content"],"properties":{"content":{"type":"string","maxLength":8192}},"additionalProperties":false})), move |ctx| {
            let source=source.clone(); async move {
                let text=ctx.arguments["content"].as_str().ok_or_else(||ToolHandlerError::new("content required"))?;
                if text.len()>8192 { return Err(ToolHandlerError::new("source too large")); }
                *source.lock().unwrap()=text.into(); Ok(ToolOutput::text("retry.py written"))
            }
        })).await.map_err(|e|e.to_string())?;
        if self.recovery {
            let observed = self.observed.clone();
            registry.register(ToolSpec::new(ToolDefinition::new("diagnose", "Capture the one-shot legacy service diagnostic. The RETRY_POLICY record specifies required retry constants. This observation is available once only; subsequent calls cannot reproduce it.", json!({"type":"object","properties":{},"additionalProperties":false})),move |_| {
                let observed=observed.clone(); async move {
                    if observed.swap(true, Ordering::SeqCst) { return Ok(ToolOutput::text("Observation expired; cannot capture again.")); }
                    Ok(ToolOutput::text(format!("{}\nRETRY_POLICY base_ms=173 cap_exponent=6 ceiling_ms=7301\n{}", "healthy worker telemetry, no changes\n".repeat(6000), "healthy worker telemetry, no changes\n".repeat(6000))))
                }
            })).await.map_err(|e|e.to_string())?;
        }
        Ok(ToolExecutor::new(registry))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::path::PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("new output directory required")?,
    );
    let case = std::env::args()
        .nth(2)
        .ok_or("case: ordinary or recovery")?;
    if !["ordinary", "recovery"].contains(&case.as_str()) || root.exists() {
        return Err("invalid case or output already exists".into());
    }
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let cfg: Value = serde_json::from_str(&input)?;
    let model = cfg["model"].as_str().ok_or("model required")?.to_owned();
    let provider = Arc::new(OpenAiProvider::new(OpenAiProviderConfig::new(
        OpenAiProtocol::ChatCompletions,
        "https://api.deepseek.com",
        cfg["api_key"].as_str().ok_or("api_key required")?,
        &model,
    ))?);
    drop(cfg);
    drop(input);
    std::fs::create_dir_all(root.join("work"))?;
    let root = root.canonicalize()?;
    let store: Arc<dyn Store> = Arc::new(
        xharness_session_jsonl::JsonlSessionStore::new(root.join("sessions"))?.for_runtime(),
    );
    store.create(SessionHeader::new("eval")).await?;
    let source = Arc::new(Mutex::new(
        "def retry_ms(attempt):\n    return 0\n".to_string(),
    ));
    let tools = Arc::new(Fixture {
        source: source.clone(),
        observed: Arc::new(AtomicBool::new(false)),
        recovery: case == "recovery",
    });
    let runtime = DurableLoopAgentRuntime::new(
        "eval",
        &model,
        Some(provider),
        tools,
        Arc::new(IdentityContextPolicy),
        store.clone(),
        Arc::new(xharness_agent::MemoryLeaseManager::default()),
        2048,
    );
    let policy = if case == "recovery" {
        "Read diagnose once to obtain the RETRY_POLICY constants. Recover evidence using available tools if the displayed output is incomplete; never invent constants."
    } else {
        "Use base_ms=137, cap_exponent=7, ceiling_ms=9000."
    };
    let prompt=format!("Repair retry.py using the provided read/write tools. Implement retry_ms(attempt) for integer input: reject negative input with ValueError; otherwise return min(ceiling_ms, base_ms * 2 ** min(attempt, cap_exponent)). {policy} Preserve the exact required behavior; no placeholders. Follow the write tool's supported Python subset. Write the implementation, then give a brief final answer. An independent evaluator tests the actual code, not your final message.");
    std::fs::write(root.join("prompt.txt"), &prompt)?;
    let request = AgentTurnRequest {
        session_id: "eval".into(),
        cwd: root.join("work").to_string_lossy().into(),
        route: ModelRoute::new("eval", &model),
        permission: PermissionPreset::WorkspaceWrite,
        prompt: None,
        messages: vec![AgentMessage::user(prompt).with_id("eval-prompt")],
        input_metadata: None,
    };
    let start = Instant::now();
    runtime.admit_turn(request.clone()).await?;
    let mut turn = runtime.start_turn(request).await?;
    let mut steps = 0;
    let outcome = tokio::time::timeout(Duration::from_secs(300), async {
        while let Some(event) = turn.next_event().await {
            if event.step > steps {
                steps = event.step;
                if steps > 16 {
                    let _ = turn.send(LoopCommand::Cancel).await;
                }
            }
        }
        turn.result().await
    })
    .await;
    runtime.shutdown(Duration::from_secs(5)).await;
    let mut usage = TokenUsage::default();
    let mut calls = Vec::new();
    let session = store.load("eval").await?.ok_or("session missing")?;
    for event in session.events() {
        match event.data() {
            EventData::AssistantMessage { usage: Some(u), .. } => {
                let u: TokenUsage = serde_json::from_value(u.clone())?;
                usage.input_tokens += u.input_tokens;
                usage.output_tokens += u.output_tokens;
                usage.cache_read_tokens += u.cache_read_tokens;
                usage.cache_write_tokens += u.cache_write_tokens;
                usage.reasoning_tokens += u.reasoning_tokens;
            }
            EventData::ToolCall { call, .. } => calls.push(call.name.clone()),
            _ => {}
        }
    }
    std::fs::write(
        root.join("work/retry.py"),
        source.lock().unwrap().as_bytes(),
    )?;
    let result = json!({"model":model,"case":case,"elapsed_ms":start.elapsed().as_millis(),"steps":steps,"usage":usage,"tools":calls,"result":outcome.as_ref().map(|r|format!("{:?}",r.status)).unwrap_or_else(|_|"timeout".into()),"answer":outcome.as_ref().map(|r|r.final_text.clone()).unwrap_or_default()});
    std::fs::write(
        root.join("metrics.json"),
        serde_json::to_vec_pretty(&result)?,
    )?;
    println!("{}", result);
    Ok(())
}

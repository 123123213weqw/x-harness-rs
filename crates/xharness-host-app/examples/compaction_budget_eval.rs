//! Opt-in isolated evaluation of the production SummaryRunner and LoopEngine.
//! Credentials enter once on stdin; no deployment, provider discovery, or private history.
use async_trait::async_trait;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
pub use xharness_core::*;
use xharness_prompt::{PromptAssembler, PromptSection};
use xharness_provider_openai::{
    OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig, OpenAiReasoningProfile,
};
use xharness_session::{EventData, Store};
use xharness_tools::{
    ToolDefinition as RuntimeDefinition, ToolExecutor, ToolHandlerError, ToolOutput, ToolRegistry,
    ToolSpec,
};
#[allow(dead_code)] // Production-private module exercised through this opt-in seam.
#[path = "../../xharness-core/src/compaction.rs"]
mod compaction;
#[path = "../../xharness-host/src/history_tool.rs"]
mod history_tool;
#[allow(dead_code)]
#[path = "../../xharness-core/src/retry.rs"]
mod retry;

#[derive(Deserialize)]
struct Init {
    api_key: String,
    model: String,
}
const EVAL_SYSTEM: &str = "You are an engineering assistant. Read current files, make precise changes and use actual tests as evidence. Historical results are not current test proof. Use history to recover truncated original evidence; never guess missing constants. Do not publish or access outside the provided workspace.";
struct Audited {
    inner: OpenAiProvider,
    model: String,
    root: PathBuf,
    records: Arc<Mutex<Vec<Value>>>,
}
fn persist(root: &Path, records: &[Value]) {
    let _ = std::fs::write(
        root.join("provider-ledger.json"),
        serde_json::to_vec_pretty(records).unwrap(),
    );
}
#[async_trait]
impl ModelProvider for Audited {
    fn provider_name(&self) -> &str {
        "deepseek"
    }
    fn model_name(&self) -> Option<&str> {
        Some(&self.model)
    }
    fn estimate_input_tokens(&self, request: &ProviderRequest) -> Option<ProviderInputTokenCount> {
        self.inner.estimate_input_tokens(request)
    }
    async fn stream(
        &self,
        request: ProviderRequest,
        cancel: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let bytes: usize = request
            .messages
            .iter()
            .map(|m| serde_json::to_vec(m).unwrap().len())
            .sum();
        let reserve =
            (bytes as f64 * 2.0 + request.max_output_tokens.unwrap_or(4096) as f64 * 8.0) / 1e6;
        let id;
        {
            let mut records = self.records.lock().unwrap();
            let commitment: f64 = records
                .iter()
                .map(|r| {
                    r["estimated_cny"]
                        .as_f64()
                        .unwrap_or(r["unknown_reserve_cny"].as_f64().unwrap_or(0.0))
                })
                .sum();
            if commitment + reserve > 20.0 {
                return Err(ProviderError::new("isolated evaluation cost ceiling"));
            }
            id = records.len();
            records.push(json!({"id":id,"input_bytes":bytes,"estimated_input":self.inner.estimate_input_tokens(&request),"max_output":request.max_output_tokens,"tools":request.tools.iter().map(|t|t.name.clone()).collect::<Vec<_>>(),"auxiliary":request.tools.is_empty(),"unknown_reserve_cny":reserve}));
            persist(&self.root, &records);
        }
        let audit = self.root.join("provider-audit");
        std::fs::create_dir_all(&audit).map_err(|e| ProviderError::new(e.to_string()))?;
        let mut safe = request.messages.clone();
        for message in &mut safe {
            message.reasoning.clear();
            message.provider_items.clear();
        }
        std::fs::write(
            audit.join(format!("{id}-request.json")),
            serde_json::to_vec_pretty(&safe).unwrap(),
        )
        .map_err(|e| ProviderError::new(e.to_string()))?;
        let started = Instant::now();
        let stream = self.inner.stream(request, cancel).await?;
        let records = self.records.clone();
        let root = self.root.clone();
        let mut visible = String::new();
        Ok(Box::pin(stream.map(move |event| {
            if let Ok(ProviderEvent::TextDelta(text)) = &event {
                visible.push_str(text);
            }
            if matches!(&event, Ok(ProviderEvent::Completed { .. })) {
                let _ = std::fs::write(audit.join(format!("{id}-text.txt")), &visible);
            }
            if let Ok(ProviderEvent::Completed {
                usage: Some(u),
                finish_reason,
                ..
            }) = &event
            {
                let fee = (u.input_tokens as f64 * 2.0
                    + u.cache_read_tokens as f64 * 0.04
                    + u.cache_write_tokens as f64 * 2.0
                    + (u.output_tokens + u.reasoning_tokens) as f64 * 8.0)
                    / 1e6;
                let mut records = records.lock().unwrap();
                records[id]["usage"] = json!(u);
                records[id]["estimated_cny"] = json!(fee);
                records[id]["unknown_reserve_cny"] = json!(0);
                records[id]["finish_reason"] = json!(finish_reason);
                records[id]["elapsed_ms"] = json!(started.elapsed().as_millis());
                persist(&root, &records);
            }
            event
        })))
    }
}
fn guard(context: u64, output: u64) -> Result<TokenGuard, TokenBudgetError> {
    TokenGuard::conservative(TokenBudget {
        context_window_tokens: context,
        reserved_output_tokens: output,
        minimum_output_tokens: 1024.min(output),
        safety_margin_tokens: 1024.min(context / 16),
    })
}
fn local_path(root: &Path, raw: &str) -> Result<PathBuf, ToolHandlerError> {
    let relative = Path::new(raw);
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(ToolHandlerError::new("relative workspace path required"));
    }
    let path = root.join(relative);
    if path.exists()
        && !path
            .canonicalize()
            .map_err(|e| ToolHandlerError::new(e.to_string()))?
            .starts_with(root)
    {
        return Err(ToolHandlerError::new("workspace escape"));
    }
    Ok(path)
}
async fn tools(
    root: PathBuf,
    store: Arc<dyn Store>,
) -> Result<ToolExecutor, Box<dyn std::error::Error>> {
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(history_tool::spec(store, "eval".into()))
        .await?;
    for name in ["read", "write"] {
        let work = root.join("work");
        let schema = if name == "read" {
            json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false})
        } else {
            json!({"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"],"additionalProperties":false})
        };
        registry.register(ToolSpec::new(RuntimeDefinition::new(name, format!("{name} a relative UTF-8 file in the isolated workspace. Available files: parser.py, importer.py, report.py, tests/test_public.py, docs/api.txt, logs/legacy.log. Archived long read results are recoverable with history."), schema), move |ctx| {let work=work.clone();async move {
   let raw=ctx.arguments["path"].as_str().ok_or_else(||ToolHandlerError::new("path required"))?;
   let path=local_path(&work,raw)?;
   if name=="read" {return Ok(ToolOutput::text(std::fs::read_to_string(&path).map_err(|e|ToolHandlerError::new(e.to_string()))?));}
   if !["parser.py","importer.py","report.py"].contains(&raw) {return Err(ToolHandlerError::new("only the three source modules are writable"));}
   let text=ctx.arguments["content"].as_str().ok_or_else(||ToolHandlerError::new("content required"))?;
   if text.len()>32768 {return Err(ToolHandlerError::new("source too large"));}
   std::fs::write(path,text).map_err(|e|ToolHandlerError::new(e.to_string()))?;Ok(ToolOutput::text(format!("wrote {raw}")))
  }})).await?;
    }
    let work = root.join("work");
    registry.register(ToolSpec::new(RuntimeDefinition::new("test", "Run the actual public Python unittest suite in this workspace; no arguments. Code is executed. Hidden acceptance tests are separate and not accessible via this tool.",json!({"type":"object","properties":{},"additionalProperties":false})), move |_| {let work=work.clone();async move {
  let output=tokio::process::Command::new("timeout").args(["20","python3","-m","unittest","discover","-s","tests","-v"]).current_dir(work).kill_on_drop(true).output().await.map_err(|e|ToolHandlerError::new(e.to_string()))?;
  let text=format!("exit={}\n{}\n{}",output.status.code().unwrap_or(-1),String::from_utf8_lossy(&output.stdout),String::from_utf8_lossy(&output.stderr));
  Ok(ToolOutput::text(text))
 }})).await?;
    Ok(ToolExecutor::new(registry))
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("new evidence directory required")?,
    );
    if root.exists() {
        return Err("evidence directory must be new".into());
    }
    std::fs::create_dir_all(root.join("work"))?;
    let root = root.canonicalize()?;
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let first = lines.next().ok_or("initial configuration required")??;
    let init: Init = serde_json::from_str(&first)?;
    let profile = OpenAiReasoningProfile::new(
        Some("off".into()),
        [("off".into(), json!({"thinking":{"type":"disabled"}}))],
    )?;
    let mut cfg = OpenAiProviderConfig::new(
        OpenAiProtocol::ChatCompletions,
        "https://api.deepseek.com",
        &init.api_key,
        &init.model,
    )
    .with_reasoning_profile(profile);
    cfg.connect_timeout = Duration::from_secs(20);
    cfg.request_timeout = Duration::from_secs(180);
    cfg.stream_idle_timeout = Duration::from_secs(90);
    let provider = Arc::new(Audited {
        inner: OpenAiProvider::new(cfg)?,
        model: init.model,
        root: root.clone(),
        records: Arc::new(Mutex::new(Vec::new())),
    });
    drop(first);
    drop(init.api_key);
    let store: Arc<dyn Store> = Arc::new(
        xharness_session_jsonl::JsonlSessionStore::new(root.join("sessions"))?.for_runtime(),
    );
    let executor = tools(root.clone(), store.clone()).await?;
    let mut stdout = io::stdout().lock();
    use sha2::{Digest, Sha256};
    let implementation_hash = format!(
        "{:x}",
        Sha256::digest(include_str!("../../xharness-core/src/compaction.rs").as_bytes())
    );
    writeln!(
        stdout,
        "{}",
        json!({"ready":true,"root":root,"compaction_source_sha256":implementation_hash,"runtime_source_manifest":serde_json::from_str::<Value>(include_str!("compaction_eval_source_manifest.json"))?})
    )?;
    stdout.flush()?;
    for line in lines {
        let line = line?;
        let cmd: Value = serde_json::from_str(&line)?;
        let context = cmd["context"].as_u64().unwrap_or(16384);
        let output = cmd["output"].as_u64().unwrap_or(4096);
        let started = Instant::now();
        let result = match cmd["op"].as_str().unwrap_or("") {
            "compact" => {
                let messages: Vec<AgentMessage> = serde_json::from_value(cmd["messages"].clone())?;
                let source_bytes: usize = messages
                    .iter()
                    .map(|m| serde_json::to_vec(m).unwrap().len())
                    .sum();
                let template=ProviderRequest{messages:vec![AgentMessage::system("You are a coding assistant. Preserve exact implementation details and evidence.")],tools:Vec::new(),step:1,reasoning_effort:Some("off".into()),max_output_tokens:Some(output),debug_scope:Default::default()};
                let result = compaction::SummaryRunner::new(
                    provider.clone(),
                    guard(context, output)?,
                    template,
                    CancellationToken::new(),
                    1,
                )
                .run(messages)
                .await;
                match result {
                    Ok(r) => {
                        json!({"ok":true,"text":r.text,"calls":r.calls,"splits":r.splits,"usage":r.usage,"source_bytes":source_bytes})
                    }
                    Err(e) => json!({"ok":false,"error":e.to_string(),"source_bytes":source_bytes}),
                }
            }
            "turn" | "maintenance" => {
                let maintenance = cmd["op"] == "maintenance";
                let input = if maintenance {
                    Vec::new()
                } else {
                    vec![AgentMessage::user(
                        cmd["user"].as_str().ok_or("user required")?,
                    )]
                };
                let mut req = LoopRequest::new(
                    provider.clone(),
                    if maintenance { Vec::new() } else { input },
                );
                // The production Host assembles a durable request prefix, not
                // a one-off System message in user history. Mirror that path:
                // replay/maintenance must not lose it after the first turn.
                req.prompt = Some(PromptAssembler.assemble([PromptSection::new(
                    "evaluation-workflow",
                    "1",
                    EVAL_SYSTEM,
                )])?);
                req.context_policy = Arc::new(ToolResultPruningContextPolicy::default());
                req.session_id = Some("eval".into());
                req.journal_store = Some(store.clone());
                req.tool_executor = Some(executor.clone());
                req.token_guard = Some(guard(context, output)?);
                req.reasoning_effort = Some("off".into());
                req.compaction_reasoning_effort = Some("off".into());
                req.config.max_steps = 24;
                req.config.tool_result_limit_bytes = 8192;
                req.config.network_wait_enabled = false;
                req.config.provider_retries = 1;
                req.compaction = Some(xharness_compaction::CompactionConfig {
                    threshold_ratio: cmd["pressure_ratio"].as_f64().unwrap_or(0.8),
                    retain_ratio: if maintenance { None } else { Some(0.16) },
                    retain_tokens: if maintenance { Some(0) } else { None },
                    max_tokens: output,
                    ..Default::default()
                });
                if maintenance {
                    let command_id =
                        format!("experiment-{}", cmd["id"].as_str().unwrap_or("compact"));
                    let session = store
                        .load("eval")
                        .await?
                        .ok_or("maintenance requires an existing session")?;
                    store
                        .append(
                            "eval",
                            session.revision(),
                            vec![EventData::CommandRun {
                                command_id,
                                name: "compact".into(),
                                args: None,
                                source: xharness_session::CommandSource::User,
                            }
                            .into()],
                        )
                        .await?;
                    req.manual_compaction_command_id = Some(format!(
                        "experiment-{}",
                        cmd["id"].as_str().unwrap_or("compact")
                    ));
                }
                let mut run = LoopEngine.start(req);
                let mut calls = Vec::new();
                let mut failed_tests = 0;
                let mut tool_evidence = Vec::new();
                let outcome = tokio::time::timeout(Duration::from_secs(600), async {
                    while let Some(e) = run.events().next().await {
                        if let LoopEventKind::ToolCompleted { call, result } = e.kind {
                            if call.name == "test" && !result.content.contains("exit=0") {
                                failed_tests += 1;
                            }
                            let arguments: Value = serde_json::from_str(&call.arguments_json).unwrap_or(Value::Null);
                            let content_sha = arguments.get("content").and_then(Value::as_str).map(|content|format!("{:x}", Sha256::digest(content.as_bytes())));
                            tool_evidence.push(json!({"tool":call.name,"path":arguments.get("path"),"content_sha256":content_sha,"result_sha256":format!("{:x}",Sha256::digest(result.content.as_bytes())),"test_exit_zero":if call.name == "test" {Some(result.content.contains("exit=0"))}else{None}}));
                            calls.push(call.name);
                        }
                    }
                    run.result().await
                })
                .await;
                match outcome {
                    Ok(r) => {
                        json!({"ok":r.error.is_none(),"status":r.status,"error":r.error,"answer":r.final_text,"calls":calls,"failed_tests":failed_tests,"tool_evidence":tool_evidence})
                    }
                    Err(_) => {
                        run.cancel();
                        let _ = tokio::time::timeout(Duration::from_secs(30), run.result()).await;
                        json!({"ok":false,"error":"isolated 600 second timeout","calls":calls,"tool_evidence":tool_evidence})
                    }
                }
            }
            "install_fixture" => {
                let files = cmd["files"].as_object().ok_or("files required")?;
                for (path, text) in files {
                    let target = local_path(&root.join("work"), path)?;
                    std::fs::create_dir_all(target.parent().ok_or("parent")?)?;
                    std::fs::write(target, text.as_str().ok_or("UTF8 text required")?)?;
                }
                json!({"ok":true})
            }
            "metrics" => {
                let session = store.load("eval").await?;
                let mut summaries = Vec::new();
                let mut errors = Vec::new();
                let mut compaction_events = Vec::new();
                let mut replacements = Vec::new();
                if let Some(session) = session {
                    for e in session.events() {
                        match e.data() {
                            EventData::CompactionSummary { summary, .. } => {
                                summaries.push(e.seq);
                                let mut metadata = serde_json::to_value(e.data())?;
                                metadata["data"]
                                    .as_object_mut()
                                    .ok_or("event metadata object")?
                                    .remove("summary");
                                metadata["summary_sha256"] =
                                    json!(format!("{:x}", Sha256::digest(summary.as_bytes())));
                                metadata["summary_bytes"] = json!(summary.len());
                                metadata["seq"] = json!(e.seq);
                                compaction_events.push(metadata);
                            }
                            EventData::CompactionStart { .. }
                            | EventData::CompactionProgress { .. } => {
                                let mut metadata = serde_json::to_value(e.data())?;
                                metadata["seq"] = json!(e.seq);
                                compaction_events.push(metadata);
                            }
                            EventData::UserMessage {
                                surface_replace: Some(replacement),
                                ..
                            } => {
                                replacements.push(json!({"seq":e.seq,"replacement":replacement}));
                            }
                            EventData::CompactionEnd { error, .. } => {
                                if let Some(error) = error {
                                    errors.push(error.clone());
                                }
                                let mut metadata = serde_json::to_value(e.data())?;
                                metadata["seq"] = json!(e.seq);
                                compaction_events.push(metadata);
                            }
                            _ => {}
                        }
                    }
                }
                let mut process_memory = serde_json::Map::new();
                if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
                    for line in status.lines() {
                        if let Some((name, value)) = line.split_once(':') {
                            if matches!(name, "VmRSS" | "VmHWM") {
                                if let Some(kib) = value
                                    .split_whitespace()
                                    .next()
                                    .and_then(|raw| raw.parse::<u64>().ok())
                                {
                                    process_memory.insert(name.to_owned(), json!(kib));
                                }
                            }
                        }
                    }
                }
                json!({"summaries":summaries,"errors":errors,"compaction_events":compaction_events,"replacements":replacements,"provider_calls":provider.records.lock().unwrap().clone(),"process_memory_kib":process_memory})
            }
            _ => return Err("unknown operation".into()),
        };
        let reply =
            json!({"id":cmd["id"],"elapsed_ms":started.elapsed().as_millis(),"result":result});
        writeln!(stdout, "{reply}")?;
        stdout.flush()?;
    }
    Ok(())
}

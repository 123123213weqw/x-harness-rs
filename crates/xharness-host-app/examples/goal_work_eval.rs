//! Opt-in live evaluation. Read only the selected provider configuration from
//! stdin; never log or persist its credential. Run on the remote build host.
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    io::Read,
    sync::Arc,
    time::{Duration, Instant},
};
use xharness_agent::{
    AgentEvent, AgentRegistry, DurableAgentHandle, GoalController, GoalReportBody,
    MemoryLeaseManager, TurnRequestFactory,
};
use xharness_coding_tools::CodingToolBundle;
use xharness_core::{
    AgentMessage, LoopEventKind, LoopRequest, LoopResult, LoopStatus, ModelProvider,
};
use xharness_jobs::JobRegistry;
use xharness_platform::{NativePlatform, PlatformConfig};
use xharness_provider_openai::{
    OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig, OpenAiReasoningProfile,
};
use xharness_session::{
    goal::*, EventData, GoalChange, GoalChangeKind, GoalSnapshotChange, GoalSnapshotOperation,
    SessionHeader, Store,
};
use xharness_session_jsonl::JsonlSessionStore;
use xharness_tools::{ToolExecutor, ToolRegistry};
use xharness_web::{WebConfig, WebRuntime};

struct Factory {
    provider: Arc<dyn ModelProvider>,
    store: Arc<dyn Store>,
    platform: Arc<NativePlatform>,
    jobs: Arc<JobRegistry>,
    web: Arc<WebRuntime>,
    cwd: String,
    effort: Option<String>,
}
#[async_trait]
impl TurnRequestFactory for Factory {
    async fn build(&self, id: &str, mut input: Vec<AgentMessage>) -> Result<LoopRequest, String> {
        let session = self
            .store
            .load(id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("session missing")?;
        let stage = execution_state(&session)
            .ok_or("goal state missing")?
            .rounds_started
            + 1;
        let instruction = match stage {
            1 => "Implement ledger.py core parsing and summarization functions and test_ledger.py basic unit tests. Run your tests. Do not implement CLI yet. End with progress and identify the remaining CLI and robustness work.",
            2 => "Add the argparse CLI python3 ledger.py INPUT.csv, deterministic JSON output, and CLI integration tests. Review validation edge cases and fix defects. End with progress; leave the final robustness audit and README for the next round.",
            _ => "Audit all requirements, add missing edge-case tests (quoting, Unicode, Decimal precision, malformed data, exact headers, invalid real calendar dates), fix any issues and write README.md. Run python3 -m unittest discover -v and CLI smoke. Report complete only if verified; otherwise progress or blocked honestly.",
        };
        input.insert(0, AgentMessage::system(format!("You are implementing a real coding task in {}. Work only in this directory. Use the provided native coding tools to edit and test files. No network, external packages, background jobs or repository operations are needed. All commands must finish before you report. This experiment splits delivery into incremental rounds. Current round {}: {}\nAt the end of EACH round, output only a JSON object with status (progress/blocked/complete), summary, remaining (string array), evidence (array of {{kind:artifact,reference:path}} objects) and blocked_reason (null except blocked, which needs code/message). This is an evaluation report adapter, NOT a new model tool. Do not wrap final JSON in markdown. Do substantive implementation before reporting.", self.cwd, stage, instruction)));
        let bundle = CodingToolBundle::new(
            self.platform.clone(),
            self.jobs.clone(),
            self.web.clone(),
            id,
            id,
        );
        let registry = Arc::new(ToolRegistry::new());
        for mut spec in bundle.specs().into_iter().filter(|s| {
            matches!(
                s.definition.name.as_str(),
                "read" | "write" | "edit" | "bash" | "glob" | "grep"
            )
        }) {
            spec.requires_approval = false;
            registry.register(spec).await.map_err(|e| e.to_string())?;
        }
        let mut request = LoopRequest::new(self.provider.clone(), input);
        request.tool_executor = Some(ToolExecutor::new(registry));
        request.reasoning_effort = self.effort.clone();
        request.config.max_steps = 32;
        request.config.max_turn_output_tokens = 65536;
        Ok(request)
    }
    async fn goal_report(&self, _: &str, r: &LoopResult) -> Result<Option<GoalReportBody>, String> {
        if r.status != LoopStatus::Completed {
            return Ok(None);
        }
        serde_json::from_str(r.final_text.trim())
            .map(Some)
            .map_err(|_| "final report was not valid structured JSON".into())
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("--confirm") {
        let root =
            std::path::PathBuf::from(std::env::args().nth(2).ok_or("evaluation root missing")?);
        let status = std::process::Command::new("python3")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../scripts/goal-ledger-acceptance.py"
            ))
            .arg(root.join("work"))
            .status()?;
        if !status.success() {
            return Err("independent acceptance failed; goal remains unconfirmed".into());
        }
        let store: Arc<dyn Store> = Arc::new(JsonlSessionStore::new(root.join("sessions"))?);
        let goal = GoalController::new(store.clone(), "goal-ledger");
        let session = store.load("goal-ledger").await?.ok_or("session missing")?;
        let state = execution_state(&session).ok_or("goal missing")?;
        if state.rounds_started < 3 {
            return Err("expected at least three real Goal rounds".into());
        }
        let report = state
            .latest_turn
            .and_then(|t| t.report)
            .ok_or("completion report missing")?;
        goal.review(
            session.revision(),
            CompletionReview {
                goal_id: report.goal_id,
                definition_revision: report.definition_revision,
                report_id: report.report_id,
                verdict: ReviewVerdict::Accepted,
            },
        )
        .await?;
        goal.reconcile().await?;
        let state = goal.state().await?.ok_or("goal missing")?;
        if state.definition.snapshot.phase != GoalPhase::Complete {
            return Err("acceptance did not complete Goal".into());
        }
        std::fs::write(
            root.join("goal-confirmed.json"),
            serde_json::to_vec_pretty(&state)?,
        )?;
        println!(
            "{}",
            json!({"event":"goal_verified_complete", "rounds":state.rounds_started})
        );
        return Ok(());
    }
    let mut secret = String::new();
    std::io::stdin().read_to_string(&mut secret)?;
    let config: Value = serde_json::from_str(&secret)?;
    let root = std::env::args()
        .nth(1)
        .ok_or("supply a new isolated evaluation directory")?;
    let root = std::path::PathBuf::from(root);
    if root.exists() {
        return Err("evaluation directory already exists; refusing to overwrite".into());
    }
    std::fs::create_dir_all(root.join("work"))?;
    let cwd = root.join("work").canonicalize()?.display().to_string();
    let mut provider = OpenAiProviderConfig::new(
        OpenAiProtocol::ChatCompletions,
        config["base_url"].as_str().ok_or("base_url missing")?,
        config["api_key"].as_str().ok_or("key missing")?,
        config["model"].as_str().ok_or("model missing")?,
    );
    if let Some(reasoning) = config.get("reasoning") {
        let efforts = reasoning["efforts"]
            .as_array()
            .ok_or("efforts missing")?
            .iter()
            .map(|e| {
                Ok((
                    e["id"].as_str().ok_or("effort id missing")?.to_owned(),
                    e["request_patch"].clone(),
                ))
            })
            .collect::<Result<Vec<_>, &str>>()?;
        provider = provider.with_reasoning_profile(OpenAiReasoningProfile::new(
            reasoning["default_effort"].as_str().map(str::to_owned),
            efforts,
        )?);
    }
    let store: Arc<dyn Store> = Arc::new(JsonlSessionStore::new(root.join("sessions"))?);
    let header = SessionHeader::new("goal-ledger");
    let session = store.create(header.clone()).await?;
    store.append(&header.id, session.revision(), vec![EventData::GoalChange { change: GoalChange::Snapshot(GoalSnapshotChange {
        kind: GoalChangeKind::GoalChange, version: 1, operation: GoalSnapshotOperation::Create,
        goal: GoalSnapshot { id: "ledger-goal".into(), revision: 1, objective: "Create a dependency-free Python 3 CSV ledger summarizer with ledger.py, test_ledger.py, README.md. Export parse_rows(text: str) -> list and summarize(rows) -> dict. CSV header MUST be exactly date,category,amount in that order. Date must be a real YYYY-MM-DD calendar date; category trimmed, nonempty, supports Unicode; amount must be finite signed decimal with at most two fractional digits (no exponents). Reject bad rows/headers using ValueError, with useful row context for bad records. Blank lines may be ignored. summarize returns {count: int, total: two-decimal string, by_category: dict[str,two-decimal string]}, category keys sorted lexically. Decimal must avoid floating rounding errors. Header-only input returns zero. CLI python3 ledger.py INPUT.csv emits one JSON object, supports UTF-8 BOM, outputs no traceback and exits nonzero for invalid input. Add unit/integration tests and usage documentation. Deliver core, CLI, then final robustness audit across successive rounds.".into(), phase: GoalPhase::Active, blocked_reason: None, max_goal_rounds: 5 }, rounds_started: 0, created_at: 1, updated_at: 1,
    }) }.into()]).await?;
    store.flush(&header.id).await?;
    let goal = GoalController::new(store.clone(), &header.id);
    goal.enable(
        store.load(&header.id).await?.unwrap().revision(),
        vec![
            "Independent acceptance tests pass".into(),
            "Working implementation, CLI, tests and README exist".into(),
        ],
        VerificationMode::UserConfirm,
        3,
    )
    .await?;
    let factory = Arc::new(Factory {
        provider: Arc::new(OpenAiProvider::new(provider)?),
        store: store.clone(),
        platform: Arc::new(NativePlatform::new(
            PlatformConfig::new(&cwd).full_access(),
        )?),
        jobs: Arc::new(JobRegistry::default()),
        web: Arc::new(WebRuntime::new(WebConfig::default())?),
        cwd,
        effort: config["effort"].as_str().map(str::to_owned),
    });
    let registry = AgentRegistry::new(store.clone(), Arc::new(MemoryLeaseManager::default()));
    let handle = DurableAgentHandle::start(registry.activate(header.clone()).await?, factory, 2048);
    let mut events = handle.subscribe();
    let start = Instant::now();
    handle.wake().await?;
    let result = tokio::time::timeout(Duration::from_secs(1200), async {
        let mut last_finished_turn = 0;
        loop {
            tokio::select! {
                e = events.recv() => match e {
                    Ok(AgentEvent::TurnStarted { turn, .. }) => println!("{}", json!({"event":"turn_started","turn":turn,"elapsed_ms":start.elapsed().as_millis()})),
                    Ok(AgentEvent::TurnFinished { turn, result }) => { last_finished_turn = turn; println!("{}", json!({"event":"turn_finished","turn":turn,"status":result.status,"usage":result.usage,"report":result.final_text,"error":result.error,"elapsed_ms":start.elapsed().as_millis()})); },
                    Ok(AgentEvent::TurnEvent { turn, event }) => if matches!(event.kind, LoopEventKind::ToolStarted { .. } | LoopEventKind::ToolCompleted { .. }) { println!("{}", json!({"event":"tool","turn":turn,"detail":event.kind})); },
                    Ok(AgentEvent::Error { message }) => return Err(message),
                    Err(e) => return Err(e.to_string()),
                    _ => {},
                },
                _ = tokio::time::sleep(Duration::from_millis(200)) => {}
            }
            let state = goal.state().await.map_err(|e| e.to_string())?.ok_or("goal missing")?;
            if state.latest_turn.as_ref().is_some_and(|t| t.turn <= last_finished_turn) && state.running.is_none() && state.pending.is_none() && state.latest_turn.as_ref().and_then(|t| t.report.as_ref()).is_some_and(|r| r.status == GoalReportStatus::Complete) { return Ok(state); }
            if state.definition.snapshot.phase != GoalPhase::Active { return Err(format!("goal ended without verified completion: {:?} {:?}",state.definition.snapshot.phase, state.pause_reason)); }
        }
    }).await;
    handle.shutdown(Duration::from_secs(10)).await;
    let state = result
        .map_err(|_| "live evaluation timed out")?
        .map_err(std::io::Error::other)?;
    println!(
        "{}",
        json!({"event":"awaiting_independent_acceptance","rounds":state.rounds_started,"elapsed_ms":start.elapsed().as_millis(),"model":config["model"],"effort":config["effort"]})
    );
    std::fs::write(
        root.join("goal-state.json"),
        serde_json::to_vec_pretty(&state)?,
    )?;
    // Re-open JSONL to verify that rounds, reports and receipts survive replay.
    let reopened = JsonlSessionStore::new(root.join("sessions"))?;
    assert_eq!(
        execution_state(&reopened.load(&header.id).await?.ok_or("replay missing")?),
        Some(state)
    );
    Ok(())
}

//! Opt-in real model evaluation of the production Host -> Runtime -> registry path.
//! Credential is read from stdin, never persisted. Run remotely in a NEW directory.
use serde_json::{json, Value};
use std::{
    io::Read,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
use xharness_host::{AgentRuntime, BasicHost, DurableLoopAgentRuntime, HostConfig};
use xharness_provider_openai::{OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig};
use xharness_session::{goal::execution_state, GoalPhase, Store};
async fn call(
    host: &BasicHost,
    id: &str,
    method: RpcMethod,
    payload: Value,
) -> Result<Value, String> {
    match host
        .call(RpcId::new(id), method, payload, CancellationToken::new())
        .await
    {
        RpcResult::Success { value } => Ok(value.unwrap_or(Value::Null)),
        error => Err(format!("{error:?}")),
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("--confirm") {
        let root = std::path::PathBuf::from(std::env::args().nth(2).ok_or("root required")?);
        if !std::process::Command::new("python3")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../scripts/goal-ledger-acceptance.py"
            ))
            .arg(root.join("work"))
            .status()?
            .success()
        {
            return Err("independent acceptance failed".into());
        }
        let store: Arc<dyn Store> = Arc::new(xharness_session_jsonl::JsonlSessionStore::new(
            root.join("sessions"),
        )?);
        let runtime = Arc::new(DurableLoopAgentRuntime::new(
            "test",
            "deepseek",
            None,
            Arc::new(xharness_host::NoTools),
            Arc::new(xharness_core::IdentityContextPolicy),
            store.clone(),
            Arc::new(xharness_agent::MemoryLeaseManager::default()),
            2048,
        ));
        let mut config = HostConfig::new(root.join("work"));
        config.provider_id = "test".into();
        config.model_id = "deepseek".into();
        let host = BasicHost::with_agent_runtime(config, runtime.clone());
        let restore = host.restore_from_store(store.clone()).await?;
        if !restore.issues.is_empty() {
            return Err(format!("restore issues: {:?}", restore.issues).into());
        }
        let state = execution_state(&store.load("goal-product").await?.ok_or("session missing")?)
            .ok_or("Goal missing")?;
        if state.rounds_started < 3
            || !state
                .latest_turn
                .as_ref()
                .and_then(|t| t.report.as_ref())
                .is_some_and(|r| r.status == xharness_session::goal::GoalReportStatus::Complete)
        {
            return Err("three completed rounds and a completion report required".into());
        }
        let payload = json!({"sessionId":"goal-product","ref":{"id":state.definition.snapshot.id,"revision":state.definition.snapshot.revision}});
        call(
            &host,
            "independent-confirm",
            RpcMethod::GoalComplete,
            payload.clone(),
        )
        .await?;
        call(
            &host,
            "independent-confirm",
            RpcMethod::GoalComplete,
            payload,
        )
        .await?;
        let fresh = xharness_session_jsonl::JsonlSessionStore::new(root.join("sessions"))?;
        let state = execution_state(&fresh.load("goal-product").await?.ok_or("session missing")?)
            .ok_or("Goal missing")?;
        if state.definition.snapshot.phase != GoalPhase::Complete {
            return Err("confirmation not durable".into());
        }
        std::fs::write(
            root.join("goal-confirmed.json"),
            serde_json::to_vec_pretty(&state)?,
        )?;
        runtime.shutdown(Duration::from_secs(2)).await;
        println!(
            "{}",
            json!({"event":"product_goal_confirmed","rounds":state.rounds_started,"phase":"complete","replay":"passed","duplicate_confirmation":"idempotent"})
        );
        return Ok(());
    }
    let revise = std::env::args().nth(1).as_deref() == Some("--revise");
    let root = std::path::PathBuf::from(
        std::env::args()
            .nth(if revise { 2 } else { 1 })
            .ok_or("root required")?,
    );
    if root.exists() && !revise {
        return Err("refusing to overwrite an existing evaluation".into());
    }
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let cfg: Value = serde_json::from_str(&input)?;
    let provider = Arc::new(OpenAiProvider::new(OpenAiProviderConfig::new(
        OpenAiProtocol::ChatCompletions,
        cfg["base_url"].as_str().ok_or("base_url missing")?,
        cfg["api_key"].as_str().ok_or("key missing")?,
        cfg["model"].as_str().ok_or("model missing")?,
    ))?);
    drop(input);
    std::fs::create_dir_all(root.join("work"))?;
    let cwd = root.join("work").canonicalize()?;
    let store: Arc<dyn Store> = Arc::new(
        xharness_session_jsonl::JsonlSessionStore::new(root.join("sessions"))?.for_runtime(),
    );
    let tools = xharness_host_app::NativeToolFactory::new(xharness_web::WebRuntime::new(
        xharness_web::WebConfig::default(),
    )?);
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "test",
        "deepseek",
        Some(provider),
        tools.clone(),
        Arc::new(xharness_core::IdentityContextPolicy),
        store.clone(),
        Arc::new(xharness_agent::MemoryLeaseManager::default()),
        8192,
    ));
    let mut config = HostConfig::new(cwd.clone());
    config.provider_id = "test".into();
    config.model_id = "deepseek".into();
    let host = BasicHost::with_agent_runtime(config, runtime.clone());
    host.restore_from_store(store.clone()).await?;
    if !revise {
        call(
            &host,
            "session",
            RpcMethod::SessionCreate,
            json!({"sessionId":"goal-product","cwd":cwd}),
        )
        .await?;
        // Isolated disposable workspace; no external package/network access is needed.
        let permission=host.call_dynamic(RpcId::new("permission"),"commands/execute",json!({"args":{"agentId":"goal-product","line":"/permission danger-full-access","images":[]}}),CancellationToken::new()).await.ok_or("permission route missing")?;
        if !permission.is_ok() {
            return Err("permission setup failed".into());
        }
    }
    let objective=std::env::var("XHARNESS_GOAL_EVAL_OBJECTIVE").unwrap_or_else(|_|"Implement a dependency-free Python CSV ledger in ledger.py, test_ledger.py, README.md. parse_rows(text)->list, summarize(rows)->dict with count, total (two decimal string), by_category sorted keys. Require exactly date,category,amount headers; validate real YYYY-MM-DD dates, nonempty trimmed Unicode categories, finite signed decimal amounts at most 2 decimal places, no exponent syntax. Use Decimal exactly. Reject invalid rows with ValueError and row context. Header-only returns zero. CLI python3 ledger.py INPUT.csv supports UTF-8 BOM and JSON output, invalid data exits nonzero with no traceback. Work exclusively in the current workspace; do not use network, external packages, git or background processes. Deliver in three substantive Goal rounds: (1) parser/core and unit tests, report progress; (2) CLI and integration tests, report progress; (3) robustness audit and README, run all tests, then report complete with evidence via goal action=report. Use actual coding tools, not only prose. Finish each round after reporting; the Goal runtime will resume the next round.".into());
    let start = Instant::now();
    if revise {
        let old = execution_state(&store.load("goal-product").await?.ok_or("missing Goal")?)
            .ok_or("missing Goal state")?;
        let updated=call(&host,"acceptance-feedback",RpcMethod::GoalEdit,json!({"sessionId":"goal-product","ref":{"id":old.definition.snapshot.id,"revision":old.definition.snapshot.revision},"objective":objective})).await?;
        call(
            &host,
            "resume-after-acceptance",
            RpcMethod::GoalResume,
            json!({"sessionId":"goal-product","ref":updated["ref"]}),
        )
        .await?;
    } else {
        call(
            &host,
            "goal",
            RpcMethod::GoalCreate,
            json!({"sessionId":"goal-product","objective":objective,"maxGoalRounds":6}),
        )
        .await?;
    }
    let mut last = 0;
    let snapshot = tokio::time::timeout(Duration::from_secs(1200), async {
        loop {
            let session = store.load("goal-product").await?.ok_or("session missing")?;
            let state = execution_state(&session).ok_or("Goal missing")?;
            if state.rounds_started != last {
                last = state.rounds_started;
                println!(
                    "{}",
                    json!({"event":"round","round":last,"elapsed_ms":start.elapsed().as_millis()})
                );
            }
            if state.running.is_none()
                && state.pending.is_none()
                && (state
                    .latest_turn
                    .as_ref()
                    .and_then(|t| t.report.as_ref())
                    .is_some_and(|r| {
                        r.status == xharness_session::goal::GoalReportStatus::Complete
                    })
                    || state.definition.snapshot.phase != GoalPhase::Active)
            {
                break Ok::<_, Box<dyn std::error::Error>>(state);
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    })
    .await??;
    std::fs::write(
        root.join("goal-state.json"),
        serde_json::to_vec_pretty(&snapshot)?,
    )?;
    runtime.shutdown(Duration::from_secs(10)).await;
    println!(
        "{}",
        json!({"event":"stopped_for_independent_acceptance","rounds":snapshot.rounds_started,"phase":snapshot.definition.snapshot.phase,"report":snapshot.latest_turn.and_then(|t|t.report),"elapsed_ms":start.elapsed().as_millis()})
    );
    Ok(())
}

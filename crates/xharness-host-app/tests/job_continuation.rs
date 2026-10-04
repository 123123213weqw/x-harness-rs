//! Production NativeToolFactory -> durable controller -> Host/Actor regression.
#![cfg(unix)]
use async_trait::async_trait;
use futures::{stream, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use xharness_api::{ApiBackend, ClientResponse, ClientResponseKind, RpcId, RpcMethod, RpcResult};
use xharness_core::{
    FinishReason, IdentityContextPolicy, ModelProvider, ProviderError, ProviderEvent,
    ProviderInputTokenCount, ProviderRequest, ProviderStream, Role, TokenBudget, TokenGuard,
};
use xharness_host::job_continuation::{records, JobContinuationController};
use xharness_host::{
    AgentRuntime, BasicHost, DurableLoopAgentRuntime, HostConfig, PermissionPreset,
    SessionToolFactory,
};
use xharness_host_app::{tool_allowlist::ToolAllowlist, NativeToolFactory};
use xharness_jobs::continuation::JobContinuationPort;
use xharness_session::{EventData, JobContinuationState, Store, TurnEndReason};
use xharness_tools::{
    ApprovalDecision, ApprovalProvider, ApprovalRequest, MiddlewareError, ToolExecutor, ToolRequest,
};
const SESSION: &str = "job-production";
const GATED: &str = "python3 producer.py";
static NEXT: AtomicU64 = AtomicU64::new(0);
struct ApproveFixture;
#[async_trait]
impl ApprovalProvider for ApproveFixture {
    async fn request_approval(
        &self,
        _: ApprovalRequest,
    ) -> Result<ApprovalDecision, MiddlewareError> {
        Ok(ApprovalDecision::Approved)
    }
}
struct ScriptedProvider {
    defer: bool,
    script: String,
    stages: std::sync::Mutex<BTreeMap<String, usize>>,
    requests: AtomicUsize,
    receipts: AtomicUsize,
    overflow: AtomicBool,
    compactions: AtomicUsize,
    hold_entered: Notify,
    hold_release: Notify,
}
fn text_events(text: String) -> ProviderStream {
    Box::pin(stream::iter(vec![
        Ok(ProviderEvent::TextDelta(text)),
        Ok(ProviderEvent::Completed {
            finish_reason: Some(FinishReason::Stop),
            usage: None,
            provider_items: vec![],
        }),
    ]))
}
fn tool_events(name: &str, args: Value) -> ProviderStream {
    Box::pin(stream::iter(vec![
        Ok(ProviderEvent::ToolCallDelta {
            index: 0,
            id: "fixture-call".into(),
            name: name.into(),
            arguments_delta: args.to_string(),
        }),
        Ok(ProviderEvent::Completed {
            finish_reason: Some(FinishReason::ToolCalls),
            usage: None,
            provider_items: vec![],
        }),
    ]))
}
fn tool_observation(message: &xharness_core::AgentMessage) -> Value {
    // The real Core replays ToolResult envelopes, not raw handler outputs.
    let value: Value = serde_json::from_str(&message.content).expect("structured tool envelope");
    if value.get("ok").is_some() {
        assert_eq!(value["ok"], true, "fixture tool failed: {value}");
        serde_json::from_str(value["content"].as_str().expect("tool content"))
            .expect("structured native output")
    } else {
        value
    }
}
#[async_trait]
impl ModelProvider for ScriptedProvider {
    fn provider_name(&self) -> &str {
        "scripted-continuation"
    }
    async fn count_input_tokens(
        &self,
        request: &ProviderRequest,
        _: CancellationToken,
    ) -> Result<Option<ProviderInputTokenCount>, ProviderError> {
        // Explicit fault injection, NOT a real tokenizer/performance measurement.
        let count = if self.overflow.load(Ordering::SeqCst) && !request.tools.is_empty() {
            980
        } else {
            100
        };
        Ok(Some(ProviderInputTokenCount::exact_request(
            "fixture-counter",
            count,
        )))
    }
    async fn stream(
        &self,
        request: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        if self.overflow.load(Ordering::SeqCst) && request.tools.is_empty() {
            self.compactions.fetch_add(1, Ordering::SeqCst);
            return Ok(text_events("NONREDUCING-".repeat(8000)));
        }
        self.requests.fetch_add(1, Ordering::SeqCst);
        let user = request
            .messages
            .iter()
            .rev()
            .find(|m| m.role == Role::User)
            .unwrap();
        let key = user.id.clone().unwrap_or_else(|| user.content.clone());
        let stage = {
            let mut stages = self.stages.lock().unwrap();
            let n = stages.entry(key).or_default();
            *n += 1;
            *n
        };
        if user.content.starts_with("START") {
            match stage {
                1 => {
                    return Ok(tool_events(
                        "bash",
                        json!({"command":self.script,"run_in_background":true}),
                    ))
                }
                2 => {
                    let out = tool_observation(request.messages.last().unwrap());
                    let args = if self.defer {
                        json!({"job_id":out["job_id"],"action":"defer","continuation":"Verify the artifact after completion"})
                    } else {
                        json!({"job_id":out["job_id"],"wait":true,"timeout_ms":3000})
                    };
                    return Ok(tool_events("job_output", args));
                }
                3 if !self.defer => {
                    let out = tool_observation(request.messages.last().unwrap());
                    assert_eq!(out["snapshot"]["status"], "completed");
                    return Ok(tool_events(
                        "bash",
                        json!({"command":"test -f artifact && : > checked"}),
                    ));
                }
                _ => {
                    if self.defer {
                        let out = tool_observation(request.messages.last().unwrap());
                        assert_eq!(
                            out["kind"], "deferred",
                            "fixture registration failed: {out}"
                        );
                    }
                    return Ok(text_events(
                        if self.defer {
                            "BACKGROUND_PENDING"
                        } else {
                            "FINISHED"
                        }
                        .into(),
                    ));
                }
            }
        }
        if user.content.contains("Background Job ") {
            let job_id = user
                .content
                .split("Background Job ")
                .nth(1)
                .unwrap()
                .split_whitespace()
                .next()
                .unwrap();
            let status = user
                .content
                .split("status=")
                .nth(1)
                .unwrap()
                .split('.')
                .next()
                .unwrap();
            let receipt = json!({"job_id":job_id,"status":status});
            match stage {
                1 => {
                    self.receipts.fetch_add(1, Ordering::SeqCst);
                    return Ok(tool_events(
                        "job_output",
                        json!({"job_id":receipt["job_id"]}),
                    ));
                }
                2 if receipt["status"] == "completed" => {
                    let out = tool_observation(request.messages.last().unwrap());
                    assert_eq!(out["snapshot"]["id"], receipt["job_id"]);
                    assert_eq!(out["snapshot"]["status"], "completed");
                    return Ok(tool_events(
                        "bash",
                        json!({"command":"test -f artifact && : > checked"}),
                    ));
                }
                _ => {
                    return Ok(text_events(format!(
                        "RESUMED:{}",
                        receipt["status"].as_str().unwrap()
                    )))
                }
            }
        }
        if user.content == "HOLD_FAIL" {
            self.hold_entered.notify_one();
            self.hold_release.notified().await;
            return Err(ProviderError::new("non-retryable fixture turn failure"));
        }
        if user.content == "HOLD_USER" {
            self.hold_entered.notify_one();
            self.hold_release.notified().await;
        }
        Ok(text_events("PONG".into()))
    }
}

struct Fixture {
    root: PathBuf,
    host: Arc<BasicHost>,
    runtime: Arc<DurableLoopAgentRuntime>,
    tools: Arc<NativeToolFactory>,
    controller: Arc<JobContinuationController>,
    store: Arc<dyn Store>,
    approver: tokio::task::JoinHandle<()>,
    ack_fault: Arc<AtomicBool>,
    block_reads: Arc<AtomicBool>,
    read_blocked: Arc<Notify>,
}
impl Fixture {
    async fn new(provider: Arc<dyn ModelProvider>, fault_budget: bool) -> Self {
        Self::new_inner(provider, fault_budget, false).await
    }
    async fn new_inner(provider: Arc<dyn ModelProvider>, fault_budget: bool, strict: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "xh-job-prod-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::write(root.join("producer.py"),"from pathlib import Path\nimport time\nPath('started').touch()\nfor _ in range(3000):\n if Path('release').exists():\n  Path('artifact').write_text('ARTIFACT_OK'); print('BUILT',flush=True); break\n time.sleep(.02)\nelse: raise SystemExit(99)\n").unwrap();
        fs::write(root.join("consume.py"),"from pathlib import Path\nassert Path('artifact').read_text()=='ARTIFACT_OK'\nPath('checked').write_text('VERIFIED_OK')\nprint('VERIFIED_OK')\n").unwrap();
        let store: Arc<dyn Store> = Arc::new(
            xharness_session_jsonl::JsonlSessionStore::new(root.join("sessions")).unwrap(),
        );
        let ack_fault = Arc::new(AtomicBool::new(false));
        let block_reads = Arc::new(AtomicBool::new(false));
        let read_blocked = Arc::new(Notify::new());
        let store: Arc<dyn Store> = Arc::new(AckFaultStore {
            inner: store,
            fault: ack_fault.clone(),
            block_reads: block_reads.clone(),
            read_blocked: read_blocked.clone(),
        });
        let tools = NativeToolFactory::new(xharness_web::WebRuntime::default());
        tools
            .restrict_tools(ToolAllowlist::parse("bash,job_output,job_list,job_kill").unwrap())
            .unwrap();
        let runtime = DurableLoopAgentRuntime::new(
            "test",
            "model",
            Some(provider),
            Arc::new(FixtureFactory {
                native: tools.clone(),
                strict,
            }),
            Arc::new(IdentityContextPolicy),
            store.clone(),
            Arc::new(xharness_agent::MemoryLeaseManager::default()),
            2048,
        );
        let runtime = if fault_budget {
            runtime
                .with_token_guard(Some(
                    TokenGuard::conservative(TokenBudget {
                        context_window_tokens: 1000,
                        reserved_output_tokens: 40,
                        minimum_output_tokens: 40,
                        safety_margin_tokens: 10,
                    })
                    .unwrap(),
                ))
                .with_compaction(Some(xharness_compaction::CompactionConfig {
                    retain_ratio: None,
                    retain_tokens: Some(10),
                    max_tokens: 64,
                    compaction_retries: 0,
                    max_overflow_retries: 0,
                    ..Default::default()
                }))
        } else {
            runtime
        };
        let runtime = Arc::new(runtime);
        let mut config = HostConfig::new(&root);
        config.provider_id = "test".into();
        config.model_id = "model".into();
        let host = BasicHost::with_agent_runtime(config, runtime.clone());
        tools.bind_agent_host(&host).unwrap();
        let controller = tools
            .enable_job_continuations(store.clone(), &host)
            .unwrap();
        assert!(host
            .call(
                RpcId::new("create"),
                RpcMethod::SessionCreate,
                json!({"sessionId":SESSION,"workspaceId":"workspace-default"}),
                CancellationToken::new()
            )
            .await
            .is_ok());
        assert!(host.call_dynamic(RpcId::new("permission"),"commands/execute",json!({"args":{"agentId":SESSION,"line":"/permission danger-full-access","images":[]}}),CancellationToken::new()).await.unwrap().is_ok());
        let mut events = host.mux_events();
        let h = host.clone();
        let approver = tokio::spawn(async move {
            while let Some(frame) = events.next().await {
                if frame.method == "approval/requested" {
                    assert_eq!(frame.payload["sessionId"], SESSION);
                    assert_eq!(h.respond(ClientResponse{kind:ClientResponseKind::ClientResponse,rpc_id:frame.rpc_id,result:RpcResult::Success{value:Some(json!({"sessionId":SESSION,"approvalId":frame.payload["approvalId"],"outcome":"allowed-once"}))}}).await,xharness_api::RpcReceipt::Accepted);
                }
            }
        });
        controller.start();
        Self {
            root,
            host,
            runtime,
            tools,
            controller,
            store,
            approver,
            ack_fault,
            block_reads,
            read_blocked,
        }
    }
    async fn prompt(&self, id: &str, text: &str) {
        assert!(self
            .host
            .call(
                RpcId::new(id),
                RpcMethod::SessionPrompt,
                json!({"sessionId":SESSION,"mode":"queue","content":[{"type":"text","text":text}]}),
                CancellationToken::new()
            )
            .await
            .is_ok());
    }
    async fn cut(&self) -> xharness_session::Session {
        self.store.load(SESSION).await.unwrap().unwrap()
    }
    async fn wait_for(&self, predicate: impl Fn(&xharness_session::Session) -> bool) {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if predicate(&self.cut().await) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap_or_else(|e| {
            panic!("production fixture condition: {e}");
        });
    }
    async fn output(&self, text: &str) {
        self.wait_for(|s|s.events().iter().any(|e|matches!(e.data(),EventData::AssistantMessage{message,..} if message.content.contains(text)))).await;
    }
    async fn idle(&self) {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let snapshot = self.host.snapshot().await;
                if snapshot["sessions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|s| s["sessionId"] == SESSION)
                    .is_some_and(|s| s["running"] == false)
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("Host idle");
    }
    async fn marker(&self, name: &str) {
        tokio::time::timeout(Duration::from_secs(15), async {
            while !self.root.join(name).is_file() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("fixture marker");
    }
    fn release(&self) {
        fs::write(self.root.join("release"), "go").unwrap();
    }
    async fn executor(&self) -> ToolExecutor {
        self.tools
            .executor(
                SESSION,
                self.root.to_str().unwrap(),
                PermissionPreset::DangerFullAccess,
            )
            .await
            .unwrap()
            .with_approval_provider(Arc::new(ApproveFixture))
    }
    async fn tool(&self, name: &str, args: Value) -> Value {
        let r = self
            .executor()
            .await
            .execute(ToolRequest::new(name, args.to_string()))
            .await;
        assert!(r.is_ok(), "{r:?}");
        serde_json::from_str(&r.output.unwrap().content).unwrap()
    }
    async fn id(&self) -> String {
        records(&self.cut().await).keys().next().unwrap().clone()
    }
    async fn stop(&self) {
        assert!(self
            .host
            .call(
                RpcId::new("stop"),
                RpcMethod::SessionCancel,
                json!({"sessionId":SESSION}),
                CancellationToken::new()
            )
            .await
            .is_ok());
        self.idle().await;
    }
    async fn cleanup(&self) {
        self.controller.shutdown().await.unwrap();
        assert!(self
            .runtime
            .shutdown(Duration::from_secs(5))
            .await
            .is_graceful());
        self.approver.abort();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.approver.abort();
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn model() -> Arc<ScriptedProvider> {
    Arc::new(ScriptedProvider {
        defer: true,
        script: GATED.into(),
        stages: Default::default(),
        requests: AtomicUsize::new(0),
        receipts: AtomicUsize::new(0),
        overflow: AtomicBool::new(false),
        compactions: AtomicUsize::new(0),
        hold_entered: Notify::new(),
        hold_release: Notify::new(),
    })
}

#[tokio::test]
async fn release_user_turn_and_auto_resume_through_native_production_factory() {
    let m = model();
    let f = Fixture::new(m.clone(), true).await;
    let ex = f.executor().await;
    assert!(ex
        .registry()
        .get("job_output")
        .await
        .unwrap()
        .definition
        .parameters["properties"]["action"]
        .is_object());
    f.prompt("start", "START").await;
    f.output("BACKGROUND_PENDING").await;
    f.idle().await;
    f.marker("started").await;
    f.prompt("ping", "PING").await;
    f.output("PONG").await;
    f.idle().await;
    assert!(!f.root.join("artifact").exists());
    f.release();
    f.marker("checked").await;
    f.output("RESUMED:completed").await;
    f.idle().await;
    assert_eq!(m.receipts.load(Ordering::SeqCst), 1);
    assert_eq!(
        records(&f.cut().await).values().next().unwrap().state,
        JobContinuationState::Delivered
    );
    for _ in 0..5 {
        f.controller.reconcile().await.unwrap();
    }
    assert_eq!(m.receipts.load(Ordering::SeqCst), 1);
    f.cleanup().await;
}
#[tokio::test]
async fn same_registration_races_are_idempotent_and_cancel_does_not_kill_producer() {
    let m = model();
    let f = Fixture::new(m.clone(), true).await;
    f.prompt("start", "START").await;
    f.output("BACKGROUND_PENDING").await;
    f.idle().await;
    let id = f.id().await;
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..10 {
        let c = f.controller.clone();
        let id = id.clone();
        tasks.spawn(async move {
            c.defer(SESSION, &id, "Verify the artifact after completion")
                .await
                .unwrap()
        });
    }
    while let Some(r) = tasks.join_next().await {
        r.unwrap();
    }
    assert_eq!(records(&f.cut().await).len(), 1);
    assert!(f.controller.defer("foreign", &id, "x").await.is_err());
    assert!(f
        .controller
        .defer(SESSION, &id, "new intent")
        .await
        .is_err());
    f.tool("job_output", json!({"job_id":id,"action":"cancel_defer"}))
        .await;
    assert_eq!(
        f.tool("job_output", json!({"job_id":id})).await["snapshot"]["status"],
        "running"
    );
    f.release();
    f.marker("artifact").await;
    f.controller.reconcile().await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(m.receipts.load(Ordering::SeqCst), 0);
    assert_eq!(
        records(&f.cut().await).values().next().unwrap().state,
        JobContinuationState::Cancelled
    );
    assert_eq!(
        f.controller
            .defer(SESSION, &id, "Verify the artifact after completion")
            .await
            .unwrap()["state"],
        "cancelled"
    );
    f.cleanup().await;
}
#[tokio::test]
async fn receipt_during_active_user_turn_queues_without_parallel_model_execution() {
    let m = model();
    let f = Fixture::new(m.clone(), true).await;
    f.prompt("start", "START").await;
    f.output("BACKGROUND_PENDING").await;
    f.idle().await;
    f.prompt("hold", "HOLD_USER").await;
    m.hold_entered.notified().await;
    f.release();
    f.marker("artifact").await;
    f.wait_for(|s| {
        records(s)
            .values()
            .any(|r| r.state == JobContinuationState::Delivered)
    })
    .await;
    assert_eq!(m.receipts.load(Ordering::SeqCst), 0);
    m.hold_release.notify_one();
    f.marker("checked").await;
    f.output("RESUMED").await;
    f.idle().await;
    assert_eq!(m.receipts.load(Ordering::SeqCst), 1);
    f.cleanup().await;
}
#[tokio::test]
async fn stopped_session_retains_receipt_until_explicit_user_resume() {
    let m = model();
    let f = Fixture::new(m.clone(), true).await;
    f.prompt("start", "START").await;
    f.output("BACKGROUND_PENDING").await;
    f.idle().await;
    f.stop().await;
    f.release();
    f.marker("artifact").await;
    f.wait_for(|s| {
        records(s)
            .values()
            .any(|r| r.state == JobContinuationState::Delivered)
    })
    .await;
    assert_eq!(m.receipts.load(Ordering::SeqCst), 0);
    let cut = f.cut().await;
    assert_eq!(
        xharness_agent::InboxProjection::from_session(&cut)
            .unwrap()
            .next_turn()
            .len(),
        1
    );
    f.prompt("resume", "PING").await;
    f.marker("checked").await;
    f.output("RESUMED").await;
    f.idle().await;
    f.cleanup().await;
}
#[tokio::test]
async fn nonreducing_compaction_is_not_retriggered_by_terminal_receipt() {
    let m = model();
    let f = Fixture::new(m.clone(), true).await;
    f.prompt("seed", &format!("OLD-CONTEXT:{}", "x".repeat(6000)))
        .await;
    f.output("PONG").await;
    f.idle().await;
    f.prompt("start", "START").await;
    f.output("BACKGROUND_PENDING").await;
    f.idle().await;
    m.overflow.store(true, Ordering::SeqCst);
    f.prompt("overflow", "OVERFLOW").await;
    f.wait_for(|s| {
        s.events().iter().any(|e| {
            matches!(
                e.data(),
                EventData::TurnEnd {
                    reason: TurnEndReason::Failed { .. },
                    ..
                }
            )
        })
    })
    .await;
    f.idle().await;
    let count = m.compactions.load(Ordering::SeqCst);
    let requests = m.requests.load(Ordering::SeqCst);
    assert!(count > 0);
    f.release();
    f.marker("artifact").await;
    f.wait_for(|s| {
        records(s)
            .values()
            .any(|r| r.state == JobContinuationState::Delivered)
    })
    .await;
    for _ in 0..5 {
        f.controller.reconcile().await.unwrap();
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(m.compactions.load(Ordering::SeqCst), count);
    assert_eq!(m.requests.load(Ordering::SeqCst), requests);
    assert_eq!(m.receipts.load(Ordering::SeqCst), 0);
    let cut = f.cut().await;
    assert!(cut
        .derive_messages()
        .iter()
        .any(|m| m.content.contains("OLD-CONTEXT")));
    assert!(!cut
        .events()
        .iter()
        .any(|e| matches!(e.data(), EventData::CompactionSummary { .. })));
    f.cleanup().await;
}

#[tokio::test]
async fn finish_before_registration_failed_producer_is_not_reported_as_success() {
    let m = model();
    let f = Fixture::new(m.clone(), true).await;
    fs::write(
        f.root.join("fail.py"),
        "import sys\nprint('BUILD_FAILED',file=sys.stderr)\nsys.exit(7)\n",
    )
    .unwrap();
    let job = f
        .tool(
            "bash",
            json!({"command":"python3 fail.py","run_in_background":true}),
        )
        .await;
    let id = job["job_id"].as_str().unwrap();
    let result = f
        .tool(
            "job_output",
            json!({"job_id":id,"wait":true,"timeout_ms":3000}),
        )
        .await;
    assert_eq!(result["snapshot"]["status"], "failed");
    f.tool("job_output",json!({"job_id":id,"action":"defer","continuation":"Report the build error without consuming any artifact"})).await;
    f.output("RESUMED:failed").await;
    f.idle().await;
    assert!(!f.root.join("checked").exists());
    assert_eq!(m.receipts.load(Ordering::SeqCst), 1);
    assert_eq!(
        f.controller
            .archived_output(SESSION, id)
            .await
            .unwrap()
            .unwrap()["snapshot"]["status"],
        "failed"
    );
    f.cleanup().await;
}
#[tokio::test]
async fn registry_loss_recovers_interrupted_and_archive_has_explicit_no_cursor_contract() {
    let m = model();
    let f = Fixture::new(m.clone(), true).await;
    f.prompt("start", "START").await;
    f.output("BACKGROUND_PENDING").await;
    f.idle().await;
    let id = f.id().await;
    f.controller.shutdown().await.unwrap();
    let recovered = JobContinuationController::new(
        Arc::new(xharness_jobs::JobRegistry::default()),
        f.store.clone(),
        &f.host,
    );
    recovered.pause_delivery();
    recovered.recover().await.unwrap();
    let archive = recovered
        .archived_output(SESSION, &id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(archive["snapshot"]["status"], "interrupted");
    assert_eq!(archive["cursor_supported"], false);
    assert!(recovered.archived_output("foreign", &id).await.is_err());
    let fresh = NativeToolFactory::new(xharness_web::WebRuntime::default());
    fresh.bind_agent_host(&f.host).unwrap();
    fresh
        .enable_job_continuations(f.store.clone(), &f.host)
        .unwrap();
    let ex = fresh
        .executor(
            SESSION,
            f.root.to_str().unwrap(),
            PermissionPreset::DangerFullAccess,
        )
        .await
        .unwrap()
        .with_approval_provider(Arc::new(ApproveFixture));
    let result = ex
        .execute(ToolRequest::new(
            "job_output",
            json!({"job_id":id}).to_string(),
        ))
        .await;
    assert!(result.is_ok());
    assert_eq!(
        serde_json::from_str::<Value>(&result.output.unwrap().content).unwrap()["snapshot"]
            ["status"],
        "interrupted"
    );
    let cursor = ex
        .execute(ToolRequest::new(
            "job_output",
            json!({"job_id":id,"cursor":{"job_id":id,"stdout":0,"stderr":0}}).to_string(),
        ))
        .await;
    assert!(!cursor.is_ok());
    assert!(!f.root.join("checked").exists());
    assert_eq!(m.receipts.load(Ordering::SeqCst), 0);
    f.tool("job_kill", json!({"job_id":id})).await;
    recovered.shutdown().await.unwrap();
    f.cleanup().await;
}
#[tokio::test]
async fn action_schema_validation_rejects_ambiguous_wait_and_unavailable_actions() {
    let f = Fixture::new(model(), true).await;
    f.prompt("start", "START").await;
    f.output("BACKGROUND_PENDING").await;
    f.idle().await;
    let id = f.id().await;
    let ex = f.executor().await;
    for args in [
        json!({"job_id":id,"action":"defer","wait":true,"continuation":"x"}),
        json!({"job_id":id,"action":"cancel_defer","continuation":"x"}),
        json!({"job_id":id,"continuation":"x"}),
        json!({"job_id":id,"action":"unknown"}),
    ] {
        assert!(!ex
            .execute(ToolRequest::new("job_output", args.to_string()))
            .await
            .is_ok());
    }
    let unbound = NativeToolFactory::new(xharness_web::WebRuntime::default());
    let bare = unbound
        .executor(
            SESSION,
            f.root.to_str().unwrap(),
            PermissionPreset::DangerFullAccess,
        )
        .await
        .unwrap();
    assert!(bare
        .registry()
        .get("job_output")
        .await
        .unwrap()
        .definition
        .parameters["properties"]
        .get("action")
        .is_none());
    f.tool("job_output", json!({"job_id":id,"action":"cancel_defer"}))
        .await;
    f.tool("job_kill", json!({"job_id":id})).await;
    f.cleanup().await;
}
#[tokio::test]
async fn receipt_queued_before_failure_is_parked_by_actor_before_claim() {
    let m = model();
    let f = Fixture::new(m.clone(), true).await;
    f.prompt("start", "START").await;
    f.output("BACKGROUND_PENDING").await;
    f.idle().await;
    f.prompt("fail", "HOLD_FAIL").await;
    m.hold_entered.notified().await;
    f.release();
    f.marker("artifact").await;
    f.wait_for(|s| {
        records(s)
            .values()
            .any(|r| r.state == JobContinuationState::Delivered)
    })
    .await;
    m.hold_release.notify_one();
    f.wait_for(|s| {
        s.events().iter().any(|e| {
            matches!(
                e.data(),
                EventData::TurnEnd {
                    reason: TurnEndReason::Failed { .. },
                    ..
                }
            )
        })
    })
    .await;
    f.idle().await;
    assert_eq!(m.receipts.load(Ordering::SeqCst), 0);
    assert_eq!(
        xharness_agent::InboxProjection::from_session(&f.cut().await)
            .unwrap()
            .next_turn()
            .len(),
        1
    );
    f.cleanup().await;
}

struct FixtureFactory {
    native: Arc<NativeToolFactory>,
    strict: bool,
}
#[async_trait]
impl SessionToolFactory for FixtureFactory {
    async fn executor(
        &self,
        id: &str,
        cwd: &str,
        permission: PermissionPreset,
    ) -> Result<ToolExecutor, String> {
        let ex = self.native.executor(id, cwd, permission).await?;
        Ok(if self.strict {
            ex.with_additional_around(Arc::new(FixtureGuard))
        } else {
            ex
        })
    }
    async fn shutdown(&self) -> Result<(), String> {
        self.native.shutdown().await
    }
    fn allows_host_tool(&self, name: &str) -> bool {
        self.native.allows_host_tool(name)
    }
}
struct FixtureGuard;
impl xharness_tools::AroundMiddleware for FixtureGuard {
    fn around(
        &self,
        c: xharness_tools::ToolExecutionContext,
        next: xharness_tools::AroundNext,
    ) -> xharness_tools::HandlerFuture {
        if c.tool_name() != "bash" {
            return next.run(c);
        }
        let valid = ["producer.py", "consume.py", "fail.py"]
            .iter()
            .any(|script| {
                c.arguments["command"] == format!("python3 {script}")
                    || (matches!(
                        c.arguments["program"].as_str(),
                        Some("python3" | "/usr/bin/python3")
                    ) && c.arguments["args"] == json!([script]))
            })
            && c.arguments.get("cwd").is_none()
            && c.arguments.get("env").is_none();
        if valid {
            next.run(c)
        } else {
            Box::pin(async {
                Err(xharness_tools::ToolHandlerError::new("Isolated fixture permits only python3 producer.py, python3 consume.py, python3 fail.py, without cwd/env changes, edits or shell operators."))
            })
        }
    }
}
struct LiveProvider {
    inner: xharness_provider_openai::OpenAiProvider,
    requests: Arc<AtomicUsize>,
    usage: Arc<std::sync::Mutex<Vec<Value>>>,
}
#[async_trait]
impl ModelProvider for LiveProvider {
    fn provider_name(&self) -> &str {
        "official-deepseek"
    }
    async fn stream(
        &self,
        mut request: ProviderRequest,
        cancellation: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        if self.requests.fetch_add(1, Ordering::SeqCst) >= 16 {
            return Err(ProviderError::new(
                "real-model fixture request limit reached",
            ));
        }
        request.max_output_tokens = Some(1024);
        request.reasoning_effort = Some("off".into());
        let usage = self.usage.clone();
        let stream = self.inner.stream(request, cancellation).await?;
        Ok(Box::pin(stream.map(move |event| {
            if let Ok(ProviderEvent::Completed {
                usage: Some(tokens),
                ..
            }) = &event
            {
                usage
                    .lock()
                    .unwrap()
                    .push(serde_json::to_value(tokens).unwrap());
            }
            event
        })))
    }
}
#[tokio::test]
#[ignore = "Requires explicitly authorized official DeepSeek key; no credentials in the repository"]
async fn live_deepseek_uses_production_defer_and_automatic_continuation() {
    use xharness_provider_openai::{
        OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig, OpenAiReasoningProfile,
    };
    let key = std::env::var("XHARNESS_LIVE_DEEPSEEK_KEY").expect("explicit live key required");
    let model =
        std::env::var("XHARNESS_LIVE_DEEPSEEK_MODEL").unwrap_or_else(|_| "deepseek-flash".into());
    let profile = OpenAiReasoningProfile::new(
        Some("off".into()),
        [("off".into(), json!({"thinking":{"type":"disabled"}}))],
    )
    .unwrap();
    let mut cfg = OpenAiProviderConfig::new(
        OpenAiProtocol::ChatCompletions,
        "https://api.deepseek.com",
        &key,
        &model,
    )
    .with_reasoning_profile(profile);
    cfg.connect_timeout = Duration::from_secs(15);
    cfg.request_timeout = Duration::from_secs(30);
    cfg.stream_idle_timeout = Duration::from_secs(30);
    let requests = Arc::new(AtomicUsize::new(0));
    let usage = Arc::new(std::sync::Mutex::new(vec![]));
    let provider = Arc::new(LiveProvider {
        inner: OpenAiProvider::new(cfg).unwrap(),
        requests: requests.clone(),
        usage: usage.clone(),
    });
    let f = Fixture::new_inner(provider.clone(), false, true).await;
    let started = std::time::Instant::now();
    let result=tokio::time::timeout(Duration::from_secs(150),async {
  f.prompt("live-start","隔离测试目录中有 producer.py 和 consume.py，只可以 python3 运行这两个原样脚本。任务：后台启动 producer.py，完成后运行 consume.py 验证产物。构建在测试控制器释放之前会一直运行，没有独立工作，不能在本轮等待它、轮询或者修改脚本。请利用当前工具注册后台完成后的续跑，然后结束本轮，待系统完成回执再完成依赖步骤。用中文简短报告，不要询问用户。").await;
  f.wait_for(|s|records(s).values().any(|r|r.state==JobContinuationState::Registered)).await;
  f.wait_for(|s|s.events().iter().any(|e|matches!(e.data(),EventData::TurnEnd{reason:TurnEndReason::Completed,..}))).await;
  f.idle().await;f.marker("started").await;assert!(!f.root.join("artifact").exists());
  let released_turn_ms=started.elapsed().as_millis();
  f.prompt("live-ping","只回复 LIVE_PONG，不调用工具；之前后台任务继续由系统等待完成，不要阻塞这条消息。").await;
  f.output("LIVE_PONG").await;f.idle().await;assert!(!f.root.join("artifact").exists());
  f.release();f.marker("checked").await;
  f.wait_for(|s|records(s).values().any(|r|r.state==JobContinuationState::Delivered) && s.events().iter().filter(|e|matches!(e.data(),EventData::TurnEnd{reason:TurnEndReason::Completed,..})).count()>=3).await;
  f.idle().await;
  let cut=f.cut().await;let row=records(&cut).into_values().next().unwrap();
  let receipts=cut.events().iter().filter(|e|matches!(e.data(),EventData::AgentInboxSpliced{inserted,..} if inserted.iter().any(|m|m.id==row.id))).count();assert_eq!(receipts,1);
  let tool_calls:Vec<_>=cut.events().iter().filter_map(|e|match e.data(){EventData::ToolCall{call,..}=>Some(json!({"name":call.name,"arguments":call.arguments_json})),_=>None}).collect();
  let report=json!({"model":model,"endpoint":"https://api.deepseek.com","thinking":"disabled","case":"completed","registration_by_model":true,"production_native_factory":true,"scripted_provider":false,"passed":true,"released_turn_ms":released_turn_ms,"elapsed_ms":started.elapsed().as_millis(),"model_requests":requests.load(Ordering::SeqCst),"usage":usage.lock().unwrap().clone(),"receipt_count":receipts,"artifact":fs::read_to_string(f.root.join("checked")).unwrap(),"calls":tool_calls});
  println!("LIVE_JOB_REPORT {}",report.to_string().replace(&key,"[REDACTED]"));
 }).await;
    f.cleanup().await;
    assert!(
        result.is_ok(),
        "live official DeepSeek production continuation timed out"
    );
    let before = requests.load(Ordering::SeqCst);
    let failure = Fixture::new_inner(provider, false, true).await;
    fs::write(failure.root.join("fail.py"), "import sys,time\nfrom pathlib import Path\nwhile not Path('release').exists(): time.sleep(.02)\nprint('BUILD_FAILED',file=sys.stderr)\nsys.exit(7)\n").unwrap();
    let job = failure
        .tool(
            "bash",
            json!({"command":"python3 fail.py","run_in_background":true}),
        )
        .await;
    let job_id = job["job_id"].as_str().unwrap();
    failure.tool("job_output", json!({"job_id":job_id,"action":"defer","continuation":"检查失败状态和实际错误日志，只用中文报告构建失败，不要运行 consume.py，不要自动重试脚本。"})).await;
    failure.release();
    failure
        .wait_for(|s| {
            s.events().iter().any(|e| {
                matches!(
                    e.data(),
                    EventData::TurnEnd {
                        reason: TurnEndReason::Completed,
                        ..
                    }
                )
            })
        })
        .await;
    failure.idle().await;
    let cut = failure.cut().await;
    let calls: Vec<_> = cut
        .events()
        .iter()
        .filter_map(|e| match e.data() {
            EventData::ToolCall { call, .. } => {
                Some(json!({"name":call.name,"arguments":call.arguments_json}))
            }
            _ => None,
        })
        .collect();
    assert!(!calls
        .iter()
        .any(|c| c["arguments"].as_str().unwrap().contains("consume.py")));
    let final_text = cut
        .events()
        .iter()
        .rev()
        .find_map(|e| match e.data() {
            EventData::AssistantMessage { message, .. } if !message.content.is_empty() => {
                Some(message.content.clone())
            }
            _ => None,
        })
        .unwrap();
    assert!(final_text.contains("失败") || final_text.to_lowercase().contains("failed"));
    assert!(!failure.root.join("checked").exists());
    println!(
        "LIVE_JOB_REPORT {}",
        json!({"case":"failed","model":model,"endpoint":"https://api.deepseek.com","thinking":"disabled","registration_by_model":false,"production_native_factory":true,"scripted_provider":false,"passed":true,"model_requests":requests.load(Ordering::SeqCst)-before,"status":failure.controller.archived_output(SESSION,job_id).await.unwrap().unwrap()["snapshot"]["status"],"calls":calls,"final_text":final_text.replace(&key,"[REDACTED]")})
    );
    failure.cleanup().await;
}

/// Fault ONLY the acknowledgement after durable Inbox admission. All operations
/// otherwise delegate to the real JSONL store; no simulated model or Job here.
struct AckFaultStore {
    inner: Arc<dyn Store>,
    fault: Arc<AtomicBool>,
    block_reads: Arc<AtomicBool>,
    read_blocked: Arc<Notify>,
}
#[async_trait]
impl Store for AckFaultStore {
    async fn list_headers(
        &self,
    ) -> Result<Vec<xharness_session::SessionHeader>, xharness_session::StoreError> {
        self.inner.list_headers().await
    }
    async fn create(
        &self,
        header: xharness_session::SessionHeader,
    ) -> Result<xharness_session::Session, xharness_session::StoreError> {
        self.inner.create(header).await
    }
    async fn load(
        &self,
        id: &str,
    ) -> Result<Option<xharness_session::Session>, xharness_session::StoreError> {
        while self.block_reads.load(Ordering::SeqCst) {
            self.read_blocked.notify_one();
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        self.inner.load(id).await
    }
    async fn append(
        &self,
        id: &str,
        revision: xharness_session::Revision,
        events: Vec<xharness_session::SessionEvent>,
    ) -> Result<xharness_session::AppendReceipt, xharness_session::StoreError> {
        if events.iter().any(|e|matches!(e.data(),EventData::JobContinuation{record} if record.state==JobContinuationState::Delivered)) && self.fault.swap(false,Ordering::SeqCst){return Err(xharness_session::StoreError::Backend{message:"Injected lost delivery acknowledgement".into()});}
        self.inner.append(id, revision, events).await
    }
    async fn flush(
        &self,
        id: &str,
    ) -> Result<xharness_session::Revision, xharness_session::StoreError> {
        self.inner.flush(id).await
    }
    async fn inspect(
        &self,
        id: &str,
    ) -> Result<Option<xharness_session::SessionInspection>, xharness_session::StoreError> {
        self.inner.inspect(id).await
    }
}
#[tokio::test]
async fn lost_delivery_ack_after_consumed_input_does_not_duplicate_continuation() {
    let m = model();
    let f = Fixture::new(m.clone(), true).await;
    f.prompt("start", "START").await;
    f.output("BACKGROUND_PENDING").await;
    f.idle().await;
    f.ack_fault.store(true, Ordering::SeqCst);
    f.release();
    f.marker("checked").await;
    f.output("RESUMED:completed").await;
    f.idle().await;
    assert_eq!(m.receipts.load(Ordering::SeqCst), 1);
    assert_eq!(
        records(&f.cut().await).values().next().unwrap().state,
        JobContinuationState::Settled
    );
    assert!(
        !xharness_agent::InboxProjection::from_session(&f.cut().await)
            .unwrap()
            .has_pending()
    );
    // Reopen the actual persisted cut through a new controller (as after a crash).
    let reopened: Arc<dyn Store> =
        Arc::new(xharness_session_jsonl::JsonlSessionStore::new(f.root.join("sessions")).unwrap());
    let cold = JobContinuationController::new(
        Arc::new(xharness_jobs::JobRegistry::default()),
        reopened,
        &f.host,
    );
    cold.recover().await.unwrap();
    for _ in 0..5 {
        cold.reconcile().await.unwrap();
    }
    assert_eq!(m.receipts.load(Ordering::SeqCst), 1);
    let cut = f.cut().await;
    let row = records(&cut).into_values().next().unwrap();
    assert_eq!(row.state, JobContinuationState::Delivered);
    assert_eq!(cut.events().iter().filter(|e|matches!(e.data(),EventData::AgentInboxSpliced{inserted,..} if inserted.iter().any(|m|m.id==row.id))).count(),1);
    cold.shutdown().await.unwrap();
    f.cleanup().await;
}

#[tokio::test]
async fn cold_host_restores_settlement_and_terminal_output_without_replaying_producer() {
    let m = model();
    let f = Fixture::new(m.clone(), true).await;
    f.prompt("start", "START").await;
    f.output("BACKGROUND_PENDING").await;
    f.idle().await;
    f.cleanup().await;
    let id = f.id().await;
    assert_eq!(
        records(&f.cut().await)[&id].state,
        JobContinuationState::Settled
    );
    let store: Arc<dyn Store> =
        Arc::new(xharness_session_jsonl::JsonlSessionStore::new(f.root.join("sessions")).unwrap());
    let tools = NativeToolFactory::new(xharness_web::WebRuntime::default());
    tools
        .restrict_tools(ToolAllowlist::parse("bash,job_output,job_list,job_kill").unwrap())
        .unwrap();
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "test",
        "model",
        Some(m.clone()),
        tools.clone(),
        Arc::new(IdentityContextPolicy),
        store.clone(),
        Arc::new(xharness_agent::MemoryLeaseManager::default()),
        2048,
    ));
    let mut config = HostConfig::new(&f.root);
    config.provider_id = "test".into();
    config.model_id = "model".into();
    let host = BasicHost::with_agent_runtime(config, runtime.clone());
    tools.bind_agent_host(&host).unwrap();
    let controller = tools
        .enable_job_continuations(store.clone(), &host)
        .unwrap();
    host.restore_from_store(store.clone()).await.unwrap();
    controller.recover().await.unwrap();
    tokio::time::timeout(Duration::from_secs(10),async{loop{let cut=store.load(SESSION).await.unwrap().unwrap();if cut.events().iter().any(|e|matches!(e.data(),EventData::AssistantMessage{message,..} if message.content.contains("RESUMED:killed"))){break;}tokio::time::sleep(Duration::from_millis(5)).await;}}).await.unwrap();
    assert_eq!(m.receipts.load(Ordering::SeqCst), 1);
    assert!(!f.root.join("checked").exists());
    assert!(!f.root.join("artifact").exists());
    assert_eq!(
        controller
            .archived_output(SESSION, &id)
            .await
            .unwrap()
            .unwrap()["snapshot"]["status"],
        "killed"
    );
    controller.shutdown().await.unwrap();
    assert!(runtime.shutdown(Duration::from_secs(5)).await.is_graceful());
}
#[tokio::test]
async fn ordinary_conversation_fork_does_not_inherit_job_subscriptions() {
    let f = Fixture::new(model(), true).await;
    f.prompt("start", "START").await;
    f.output("BACKGROUND_PENDING").await;
    f.idle().await;
    let mut fork = f.cut().await;
    fork.append(
        fork.revision(),
        EventData::SessionForkOrigin {
            parent_session_id: SESSION.into(),
            before_user_seq: None,
        },
    )
    .unwrap();
    assert!(records(&fork).is_empty());
    assert!(!xharness_host::job_continuation::has_pending(&fork));
    let id = f.id().await;
    f.controller.cancel_defer(SESSION, &id).await.unwrap();
    f.tool("job_kill", json!({"job_id":id})).await;
    f.cleanup().await;
}

#[tokio::test]
async fn stuck_outbox_store_does_not_prevent_bounded_native_producer_shutdown() {
    let f = Fixture::new(model(), true).await;
    f.prompt("start", "START").await;
    f.output("BACKGROUND_PENDING").await;
    f.idle().await;
    f.block_reads.store(true, Ordering::SeqCst);
    f.release();
    tokio::time::timeout(Duration::from_secs(3), f.read_blocked.notified())
        .await
        .unwrap();
    let started = std::time::Instant::now();
    let result = tokio::time::timeout(Duration::from_secs(10), f.tools.shutdown())
        .await
        .unwrap();
    assert!(result.is_err());
    assert!(started.elapsed() < Duration::from_secs(10));
    // JobRegistry admission must still close despite outbox timeouts.
    let result = f
        .executor()
        .await
        .execute(ToolRequest::new(
            "bash",
            json!({"command":"python3 producer.py","run_in_background":true}).to_string(),
        ))
        .await;
    assert!(!result.is_ok());
    f.block_reads.store(false, Ordering::SeqCst);
    f.cleanup().await;
}

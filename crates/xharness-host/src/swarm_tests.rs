//! Fresh disk stores and real durable runtime, with a deterministic provider.
use crate::{
    AgentRuntime, BasicHost, DurableLoopAgentRuntime, HostConfig, NoTools, RecoveryPolicy,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use xharness_agent::{AgentOperation, MemoryLeaseManager};
use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
use xharness_control::{ControlStore, JsonlControlStore};
use xharness_core::{
    FinishReason, IdentityContextPolicy, ModelProvider, ProviderError, ProviderEvent,
    ProviderRequest, ProviderStream,
};
use xharness_session::{EventData, Message, Store, ToolCall, ToolOutcome, TurnEndReason};
use xharness_session_jsonl::JsonlSessionStore;

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Disk(PathBuf);
impl Disk {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xh-swarm-{}-{}-{}",
            std::process::id(),
            crate::state::now_ms(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn sessions(&self) -> Arc<dyn Store> {
        Arc::new(JsonlSessionStore::new(self.0.join("sessions")).unwrap())
    }
    fn control(&self) -> Arc<dyn ControlStore> {
        Arc::new(JsonlControlStore::new(self.0.join("control")).unwrap())
    }
}
impl Drop for Disk {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[derive(Default)]
struct Provider(Mutex<Vec<ProviderRequest>>);
#[async_trait]
impl ModelProvider for Provider {
    fn provider_name(&self) -> &str {
        "test"
    }
    async fn stream(
        &self,
        request: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        self.0.lock().unwrap().push(request);
        Ok(Box::pin(futures::stream::iter(vec![
            Ok(ProviderEvent::TextDelta("verified result".into())),
            Ok(ProviderEvent::Completed {
                finish_reason: Some(FinishReason::Stop),
                usage: None,
                provider_items: vec![],
            }),
        ])))
    }
}
fn setup(
    disk: &Disk,
    provider: Arc<Provider>,
) -> (Arc<BasicHost>, Arc<DurableLoopAgentRuntime>, Arc<dyn Store>) {
    setup_with_control(disk, provider, disk.control())
}
fn setup_with_control(
    disk: &Disk,
    provider: Arc<Provider>,
    control: Arc<dyn ControlStore>,
) -> (Arc<BasicHost>, Arc<DurableLoopAgentRuntime>, Arc<dyn Store>) {
    let store = disk.sessions();
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "test",
        "test",
        Some(provider),
        Arc::new(NoTools),
        Arc::new(IdentityContextPolicy),
        store.clone(),
        Arc::new(MemoryLeaseManager::default()),
        2048,
    ));
    let mut config = HostConfig::new(disk.0.clone());
    config.provider_id = "test".into();
    config.model_id = "test".into();
    let host = BasicHost::with_agent_runtime_and_control_store(config, runtime.clone(), control);
    // Match native composition: existing child-settlement delivery is installed once.
    host.start_delegation_listener();
    (host, runtime, store)
}
async fn create_session(host: &BasicHost, id: &str) {
    crate::rpc::session_lifecycle::create(host, &json!({"sessionId":id}))
        .await
        .unwrap();
}
async fn manage(host: &BasicHost, id: &str, owner: &str, command: Value) -> RpcResult {
    host.call_dynamic(
        RpcId::new(id),
        "swarm/manage",
        json!({"ownerSessionId":owner,"command":command}),
        CancellationToken::new(),
    )
    .await
    .unwrap()
}
trait Failure {
    fn is_failure(&self) -> bool;
}
impl Failure for RpcResult {
    fn is_failure(&self) -> bool {
        matches!(self, RpcResult::Failure { .. })
    }
}
fn success(result: RpcResult) -> Value {
    match result {
        RpcResult::Success { value: Some(value) } => value,
        other => panic!("RPC failed: {other:?}"),
    }
}
async fn inspect(host: &BasicHost, owner: &str, id: &str) -> Value {
    success(
        manage(
            host,
            "inspect",
            owner,
            json!({"action":"inspect","swarmId":id}),
        )
        .await,
    )
}
async fn settle(host: &BasicHost, id: &str) {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let idle = {
                let state = host.state.read().await;
                state.sessions.get(id).is_some_and(|s| {
                    !s.running && s.queue.is_empty() && s.projected_queue.is_empty()
                })
            };
            if idle
                && host
                    .agent_runtime
                    .authoritative_session(id)
                    .await
                    .unwrap()
                    .is_some_and(|session| {
                        session
                            .events()
                            .iter()
                            .any(|e| matches!(e.data(), EventData::TurnEnd { .. }))
                    })
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("worker did not settle");
}
async fn start(host: &BasicHost, task: &str) -> String {
    let result = host
        .execute_agent(
            "owner",
            "worker-start",
            AgentOperation::Start {
                task: task.into(),
                label: Some("Worker".into()),
                provider: None,
                model: None,
                reasoning_effort: None,
            },
        )
        .await
        .unwrap();
    result["agent_id"].as_str().unwrap().into()
}
async fn stop_host(host: Arc<BasicHost>, runtime: Arc<DurableLoopAgentRuntime>) {
    host.stop_background_listeners();
    runtime.shutdown(Duration::from_secs(2)).await;
    drop(host);
    drop(runtime);
}

#[tokio::test]
async fn swarm_disk_restart_preserves_identity_members_results_and_exact_rpc_receipts() {
    let disk = Disk::new();
    let provider = Arc::new(Provider::default());
    let (host, runtime, store) = setup(&disk, provider.clone());
    host.restore_from_store_with_policy(store.clone(), RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    create_session(&host, "owner").await;
    create_session(&host, "ordinary").await;
    let child = start(&host, "Inspect parser; report without editing files").await;
    settle(&host, &child).await;
    // Wait for the existing parent settlement path, not a Swarm-owned loop.
    settle(&host, "owner").await;
    let before = store.load(&child).await.unwrap().unwrap();
    let normal_before = store.load("ordinary").await.unwrap().unwrap();
    let calls = provider.0.lock().unwrap().len();
    let create = json!({"action":"create","objective":"Maintain parser reliability"});
    let created = success(manage(&host, "create-team", "owner", create.clone()).await);
    let team = created["swarmId"].as_str().unwrap().to_owned();
    success(manage(&host,"attach","owner",json!({"action":"attach_member","swarmId":team,"expectedRevision":1,"childSessionId":child})).await);
    let snapshot = inspect(&host, "owner", &team).await;
    assert_eq!(snapshot["swarm"]["revision"], 2);
    assert_eq!(
        snapshot["swarm"]["members"][&child]["assignment"],
        "Inspect parser; report without editing files"
    );
    assert_eq!(snapshot["workers"][0]["lastTurnEnd"]["kind"], "completed");
    assert_eq!(
        provider.0.lock().unwrap().len(),
        calls,
        "metadata must not invoke a model"
    );
    assert_eq!(
        store.load(&child).await.unwrap().unwrap(),
        before,
        "linking must not rewrite child history"
    );
    assert_eq!(
        store.load("ordinary").await.unwrap().unwrap(),
        normal_before
    );
    stop_host(host, runtime).await;
    drop(store);

    let cold_provider = Arc::new(Provider::default());
    let (cold, cold_runtime, cold_store) = setup(&disk, cold_provider.clone());
    cold.restore_from_store_with_policy(cold_store.clone(), RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    let restored = inspect(&cold, "owner", &team).await;
    assert_eq!(restored, snapshot);
    assert_eq!(
        success(manage(&cold, "create-team", "owner", create).await),
        created
    );
    assert!(manage(
        &cold,
        "create-team",
        "owner",
        json!({"action":"create","objective":"different"})
    )
    .await
    .is_failure());
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert!(
        cold_provider.0.lock().unwrap().is_empty(),
        "restart must not rerun settled work"
    );
    assert_eq!(
        cold_store.load("ordinary").await.unwrap().unwrap(),
        normal_before
    );
    // Ordinary chat still uses the unchanged prompt/runtime path.
    let result=cold.call(RpcId::new("ordinary-message"),RpcMethod::SessionPrompt,json!({"sessionId":"ordinary","mode":"queue","content":[{"type":"text","text":"Explain Rust ownership"}]}),CancellationToken::new()).await;
    success(result);
    settle(&cold, "ordinary").await;
    {
        let requests = cold_provider.0.lock().unwrap();
        assert_eq!(requests.len(), 1);
        let debug = format!("{:?}", requests[0]);
        assert!(debug.contains("Explain Rust ownership"));
        assert!(!debug.contains("Maintain parser reliability"));
    }
    stop_host(cold, cold_runtime).await;
}

#[tokio::test]
async fn swarm_lifecycle_cas_authorization_and_pause_do_not_change_chat_dispatch() {
    let disk = Disk::new();
    let provider = Arc::new(Provider::default());
    let (host, runtime, store) = setup(&disk, provider.clone());
    create_session(&host, "owner").await;
    create_session(&host, "other").await;
    let team = success(
        manage(
            &host,
            "create",
            "owner",
            json!({"action":"create","objective":"Long lived maintenance"}),
        )
        .await,
    )["swarmId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(manage(
        &host,
        "wrong-owner",
        "other",
        json!({"action":"inspect","swarmId":team})
    )
    .await
    .is_failure());
    assert!(manage(&host,"not-delegated","owner",json!({"action":"attach_member","swarmId":team,"expectedRevision":1,"childSessionId":"other"})).await.is_failure());
    let before = store.load("owner").await.unwrap().unwrap();
    for (revision, status) in [(1, "paused"), (2, "active"), (3, "closed")] {
        success(manage(&host,&format!("status-{revision}"),"owner",json!({"action":"set_status","swarmId":team,"expectedRevision":revision,"status":status})).await);
    }
    for (revision, status) in [(1, "paused"), (4, "active")] {
        assert!(manage(&host,&format!("rejected-{revision}"),"owner",json!({"action":"set_status","swarmId":team,"expectedRevision":revision,"status":status})).await.is_failure());
    }
    assert_eq!(store.load("owner").await.unwrap().unwrap(), before);
    assert!(!host.state.read().await.sessions["owner"].dispatch_paused);
    assert!(provider.0.lock().unwrap().is_empty());
    assert!(manage(
        &host,
        "bad",
        "owner",
        json!({"action":"create","objective":" ","unknown":true})
    )
    .await
    .is_failure());
    stop_host(host, runtime).await;
    let (cold, runtime, store) = setup(&disk, Arc::new(Provider::default()));
    cold.restore_from_store_with_policy(store, RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    assert_eq!(
        inspect(&cold, "owner", &team).await["swarm"]["status"],
        "closed"
    );
    stop_host(cold, runtime).await;
}

#[tokio::test]
async fn swarm_interrupted_tool_stays_unresolved_until_explicit_existing_runtime_resume() {
    let disk = Disk::new();
    let (host, runtime, store) = setup(&disk, Arc::new(Provider::default()));
    create_session(&host, "owner").await;
    let child = start(&host, "Check external state before any retry").await;
    settle(&host, &child).await;
    settle(&host, "owner").await;
    let team = success(
        manage(
            &host,
            "create",
            "owner",
            json!({"action":"create","objective":"Recover interrupted work"}),
        )
        .await,
    )["swarmId"]
        .as_str()
        .unwrap()
        .to_owned();
    success(manage(&host,"attach","owner",json!({"action":"attach_member","swarmId":team,"expectedRevision":1,"childSessionId":child})).await);
    stop_host(host, runtime).await;
    // Simulate process loss after an external effect but before its ToolResult.
    let marker = disk.0.join("external-effect");
    std::fs::write(&marker, "executed once").unwrap();
    let snapshot = store.load(&child).await.unwrap().unwrap();
    let call = ToolCall {
        id: "effect-before-crash".into(),
        name: "external_effect".into(),
        arguments_json: "{}".into(),
        ..Default::default()
    };
    let mut message = Message::assistant("");
    message.tool_calls.push(call.clone());
    store
        .append(
            &child,
            snapshot.revision(),
            vec![
                EventData::TurnStart { turn: 2 }.into(),
                EventData::StepStart { turn: 2, step: 1 }.into(),
                EventData::AssistantMessage {
                    turn: 2,
                    step: 1,
                    message,
                    usage: None,
                }
                .into(),
                EventData::ToolCall {
                    turn: 2,
                    step: 1,
                    call,
                }
                .into(),
            ],
        )
        .await
        .unwrap();
    store.flush(&child).await.unwrap();
    drop(store);

    let provider = Arc::new(Provider::default());
    let (cold, cold_runtime, store) = setup(&disk, provider.clone());
    let report = cold
        .restore_from_store_with_policy(store.clone(), RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    assert_eq!(report.paused_incomplete_tool_sessions, 1);
    let observation = inspect(&cold, "owner", &team).await;
    assert_eq!(
        observation["workers"][0]["activity"],
        "needs_reconciliation"
    );
    assert_eq!(
        observation["workers"][0]["unresolvedToolCalls"],
        json!(["effect-before-crash"])
    );
    assert!(provider.0.lock().unwrap().is_empty());
    let before = store.load(&child).await.unwrap().unwrap();
    inspect(&cold, "owner", &team).await;
    assert_eq!(
        store.load(&child).await.unwrap().unwrap(),
        before,
        "inspection cannot repair or replay tools"
    );
    success(cold.call(RpcId::new("explicit-resume"),RpcMethod::SubagentPrompt,json!({"parentSessionId":"owner","childSessionId":child,"mode":"continuable","content":[{"type":"text","text":"Inspect prior state; do not repeat the effect"}]}),CancellationToken::new()).await);
    settle(&cold, &child).await;
    let recovered = store.load(&child).await.unwrap().unwrap();
    assert!(recovered.events().iter().any(|e|matches!(e.data(),EventData::ToolResult{result,..} if result.call_id=="effect-before-crash" && result.outcome==ToolOutcome::OutcomeUnknown)));
    assert_eq!(std::fs::read_to_string(marker).unwrap(), "executed once");
    assert!(recovered.events().iter().any(|e| matches!(
        e.data(),
        EventData::TurnEnd {
            reason: TurnEndReason::Completed,
            ..
        }
    )));
    stop_host(cold, cold_runtime).await;
}

#[tokio::test]
async fn swarm_concurrent_stale_updates_have_one_winner_and_no_session_writes() {
    let disk = Disk::new();
    let (host, runtime, store) = setup(&disk, Arc::new(Provider::default()));
    create_session(&host, "owner").await;
    let team = success(
        manage(
            &host,
            "create",
            "owner",
            json!({"action":"create","objective":"Concurrent updates"}),
        )
        .await,
    )["swarmId"]
        .as_str()
        .unwrap()
        .to_owned();
    let before = store.load("owner").await.unwrap().unwrap();
    let command =
        json!({"action":"set_status","swarmId":team,"expectedRevision":1,"status":"paused"});
    let (a, b) = tokio::join!(
        manage(&host, "concurrent-a", "owner", command.clone()),
        manage(&host, "concurrent-b", "owner", command)
    );
    assert_ne!(a.is_failure(), b.is_failure());
    assert_eq!(inspect(&host, "owner", &team).await["swarm"]["revision"], 2);
    assert_eq!(store.load("owner").await.unwrap().unwrap(), before);
    stop_host(host, runtime).await;
    let (cold, runtime, store) = setup(&disk, Arc::new(Provider::default()));
    cold.restore_from_store_with_policy(store, RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    assert_eq!(
        inspect(&cold, "owner", &team).await["swarm"]["status"],
        "paused"
    );
    stop_host(cold, runtime).await;
}

#[tokio::test]
async fn swarm_delegation_identity_respects_forks_and_missing_workers_are_not_recreated() {
    let disk = Disk::new();
    let (host, runtime, store) = setup(&disk, Arc::new(Provider::default()));
    create_session(&host, "owner").await;
    create_session(&host, "fork").await;
    create_session(&host, "child").await;
    for id in ["fork", "child"] {
        let session = store.load(id).await.unwrap().unwrap();
        let mut events = vec![EventData::AgentDelegated {
            parent_session_id: "owner".into(),
            invocation_id: "seed".into(),
            task: "Review".into(),
        }
        .into()];
        if id == "fork" {
            events.push(
                EventData::SessionForkOrigin {
                    parent_session_id: "child".into(),
                    before_user_seq: None,
                }
                .into(),
            );
        }
        store.append(id, session.revision(), events).await.unwrap();
    }
    let team = success(
        manage(
            &host,
            "create",
            "owner",
            json!({"action":"create","objective":"Check membership"}),
        )
        .await,
    )["swarmId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(manage(&host,"fork-as-member","owner",json!({"action":"attach_member","swarmId":team,"expectedRevision":1,"childSessionId":"fork"})).await.is_failure());
    assert!(manage(
        &host,
        "child-as-owner",
        "child",
        json!({"action":"create","objective":"Nested team"})
    )
    .await
    .is_failure());
    success(manage(&host,"attach","owner",json!({"action":"attach_member","swarmId":team,"expectedRevision":1,"childSessionId":"child"})).await);
    host.state
        .write()
        .await
        .deleted_sessions
        .insert("child".into());
    let before = store.load("child").await.unwrap().unwrap();
    assert_eq!(
        inspect(&host, "owner", &team).await["workers"][0]["activity"],
        "unavailable"
    );
    assert_eq!(store.load("child").await.unwrap().unwrap(), before);
    // A normal fork of a worker is a root conversation, not a delegated worker.
    success(
        manage(
            &host,
            "fork-as-owner",
            "fork",
            json!({"action":"create","objective":"Independent root"}),
        )
        .await,
    );
    stop_host(host, runtime).await;
}

struct LostFlushAck {
    inner: Arc<dyn ControlStore>,
    once: std::sync::atomic::AtomicBool,
}
#[async_trait]
impl ControlStore for LostFlushAck {
    async fn load(&self) -> Result<xharness_control::ControlLog, xharness_control::ControlError> {
        self.inner.load().await
    }
    async fn append(
        &self,
        revision: xharness_control::ControlRevision,
        events: Vec<xharness_control::ControlEvent>,
    ) -> Result<xharness_control::ControlAppendReceipt, xharness_control::ControlError> {
        self.inner.append(revision, events).await
    }
    async fn flush(
        &self,
    ) -> Result<xharness_control::ControlRevision, xharness_control::ControlError> {
        let revision = self.inner.flush().await?;
        if self.once.swap(false, Ordering::SeqCst) {
            return Err(xharness_control::ControlError::Backend {
                message: "simulated lost durability acknowledgement".into(),
            });
        }
        Ok(revision)
    }
}
#[tokio::test]
async fn swarm_retry_after_lost_flush_ack_returns_committed_identity_not_new_candidate() {
    let disk = Disk::new();
    let control = Arc::new(LostFlushAck {
        inner: disk.control(),
        once: std::sync::atomic::AtomicBool::new(true),
    });
    let (host, runtime, _) = setup_with_control(&disk, Arc::new(Provider::default()), control);
    create_session(&host, "owner").await;
    let command = json!({"action":"create","objective":"Survive a lost commit acknowledgement"});
    assert!(manage(&host, "lost-ack", "owner", command.clone())
        .await
        .is_failure());
    assert!(
        host.state.read().await.swarms.is_empty(),
        "failure must not publish an unacknowledged candidate"
    );
    let committed = disk.control().load().await.unwrap().projection().unwrap();
    let expected = committed.receipts["lost-ack"].response.clone();
    assert_eq!(committed.swarms.len(), 1);
    assert_eq!(
        success(manage(&host, "lost-ack", "owner", command.clone()).await),
        expected
    );
    assert_eq!(
        success(manage(&host, "lost-ack", "owner", command).await),
        expected
    );
    assert_eq!(
        disk.control()
            .load()
            .await
            .unwrap()
            .projection()
            .unwrap()
            .swarms
            .len(),
        1
    );
    stop_host(host, runtime).await;
}

async fn board(host: &BasicHost, id: &str, owner: &str, command: Value) -> RpcResult {
    host.call_dynamic(
        RpcId::new(id),
        "swarm/tasks",
        json!({"ownerSessionId":owner,"command":command}),
        CancellationToken::new(),
    )
    .await
    .unwrap()
}
async fn board_list(host: &BasicHost, team: &str) -> Value {
    success(
        board(
            host,
            "board-read",
            "owner",
            json!({"action":"list","swarmId":team,"includeSettled":true}),
        )
        .await,
    )
}
async fn board_add(host: &BasicHost, team: &str, title: &str, deps: Vec<String>) -> String {
    let revision = board_list(host, team).await["revision"].as_u64().unwrap();
    success(board(host,&format!("add:{title}"),"owner",json!({"action":"add","swarmId":team,"expectedRevision":revision,"title":title,"instructions":format!("Collect evidence for {title}"),"dependencies":deps})).await)["taskId"].as_str().unwrap().into()
}
async fn board_team(host: &BasicHost) -> (String, String) {
    create_session(host, "owner").await;
    let child = start(
        host,
        "Read the assignment and wait for the next specific request",
    )
    .await;
    settle(host, &child).await;
    settle(host, "owner").await;
    let team = success(
        manage(
            host,
            "board-team",
            "owner",
            json!({"action":"create","objective":"Research and synthesize"}),
        )
        .await,
    )["swarmId"]
        .as_str()
        .unwrap()
        .to_owned();
    success(manage(host,"board-member","owner",json!({"action":"attach_member","swarmId":team,"expectedRevision":1,"childSessionId":child})).await);
    (team, child)
}
async fn board_claim(host: &BasicHost, team: &str, task: &str, worker: &str, key: &str) -> Value {
    let revision = board_list(host, team).await["revision"].as_u64().unwrap();
    success(board(host,key,"owner",json!({"action":"claim","swarmId":team,"expectedRevision":revision,"taskId":task,"workerSessionId":worker})).await)
}
async fn board_wait_delivery(host: &BasicHost, child: &str, message: &str) -> u32 {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            host.reconcile_swarm_task_deliveries().await.unwrap();
            let session = host
                .agent_runtime
                .authoritative_session(child)
                .await
                .unwrap()
                .unwrap();
            let mut turn = None;
            let mut found = false;
            for event in session.events() {
                match event.data() {
                    EventData::TurnStart { turn: t } => {
                        turn = Some(*t);
                        found = false
                    }
                    EventData::UserMessage { message: m, .. }
                        if m.id.as_deref() == Some(message) =>
                    {
                        found = true
                    }
                    EventData::TurnEnd { turn: t, .. } if found && turn == Some(*t) => return *t,
                    _ => {}
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("task message did not settle")
}

#[tokio::test]
async fn swarm_board_delivers_real_inbox_work_accepts_exact_turn_and_unlocks_next_task() {
    let disk = Disk::new();
    let provider = Arc::new(Provider::default());
    let (host, runtime, store) = setup(&disk, provider.clone());
    host.restore_from_store_with_policy(store.clone(), RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    let (team, child) = board_team(&host).await;
    create_session(&host, "ordinary-board-control").await;
    let normal = store.load("ordinary-board-control").await.unwrap().unwrap();
    let first = board_add(&host, &team, "sources", vec![]).await;
    let second = board_add(&host, &team, "conclusion", vec![first.clone()]).await;
    let list = board_list(&host, &team).await;
    assert_eq!(
        list["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["task"]["id"] == second)
            .unwrap()["ready"],
        false
    );
    let claim = board_claim(&host, &team, &first, &child, "claim-source").await;
    let message = claim["deliveryId"].as_str().unwrap();
    let turn = board_wait_delivery(&host, &child, message).await;
    let cut = store.load(&child).await.unwrap().unwrap();
    assert_eq!(cut.events().iter().filter(|e|matches!(e.data(),EventData::UserMessage{message:m,..} if m.id.as_deref()==Some(message))).count(),1);
    let revision = board_list(&host, &team).await["revision"].as_u64().unwrap();
    assert!(board(&host,"wrong-turn","owner",json!({"action":"settle","swarmId":team,"expectedRevision":revision,"taskId":first,"messageId":message,"turn":turn-1,"outcome":"completed","summary":"not this assignment"})).await.is_failure());
    let finish = json!({"action":"settle","swarmId":team,"expectedRevision":revision,"taskId":first,"messageId":message,"turn":turn,"outcome":"completed","summary":"Sources collected with evidence"});
    let receipt = success(board(&host, "accept-sources", "owner", finish.clone()).await);
    assert_eq!(
        success(board(&host, "accept-sources", "owner", finish).await),
        receipt
    );
    let after = board_list(&host, &team).await;
    assert_eq!(after["tasks"].as_array().unwrap().len(), 2);
    let active = success(
        board(
            &host,
            "active-board-read",
            "owner",
            json!({"action":"list","swarmId":team}),
        )
        .await,
    );
    assert_eq!(
        active["tasks"].as_array().unwrap().len(),
        1,
        "finished work leaves the active view, not durable history"
    );
    assert_eq!(active["tasks"][0]["task"]["id"], second);
    let page = success(
        board(
            &host,
            "history-page-one",
            "owner",
            json!({"action":"list","swarmId":team,"includeSettled":true,"limit":1}),
        )
        .await,
    );
    assert_eq!(page["hasMore"], true);
    let next=success(board(&host,"history-page-two","owner",json!({"action":"list","swarmId":team,"includeSettled":true,"afterTaskId":page["nextCursor"],"limit":1})).await);
    assert_eq!(next["hasMore"], false);
    assert_ne!(
        page["tasks"][0]["task"]["id"],
        next["tasks"][0]["task"]["id"]
    );

    assert_eq!(
        after["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["task"]["id"] == second)
            .unwrap()["ready"],
        true
    );
    assert_eq!(
        store.load("ordinary-board-control").await.unwrap().unwrap(),
        normal
    );
    stop_host(host, runtime).await;
    let (cold, cold_runtime, cold_store) = setup(&disk, Arc::new(Provider::default()));
    cold.restore_from_store_with_policy(cold_store, RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    assert_eq!(board_list(&cold, &team).await, after);
    stop_host(cold, cold_runtime).await;
}

#[tokio::test]
async fn swarm_board_concurrent_claim_has_one_winner_and_nonmembers_cannot_steal_work() {
    let disk = Disk::new();
    let (host, runtime, store) = setup(&disk, Arc::new(Provider::default()));
    host.restore_from_store_with_policy(store, RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    let (team, child) = board_team(&host).await;
    let task = board_add(&host, &team, "exclusive", vec![]).await;
    let revision = board_list(&host, &team).await["revision"].as_u64().unwrap();
    let payload = json!({"action":"claim","swarmId":team,"expectedRevision":revision,"taskId":task,"workerSessionId":child});
    let (a, b) = tokio::join!(
        board(&host, "claim-a", "owner", payload.clone()),
        board(&host, "claim-b", "owner", payload.clone())
    );
    assert_ne!(a.is_failure(), b.is_failure());
    let key = if a.is_failure() { "claim-b" } else { "claim-a" };
    let response = success(if a.is_failure() { b } else { a });
    assert_eq!(
        success(board(&host, key, "owner", payload.clone()).await),
        response
    );
    assert!(board(&host, "steal", &child, payload).await.is_failure());
    let other = board_add(&host, &team, "other", vec![]).await;
    let r = board_list(&host, &team).await["revision"].as_u64().unwrap();
    assert!(board(&host,"second-task","owner",json!({"action":"claim","swarmId":team,"expectedRevision":r,"taskId":other,"workerSessionId":child})).await.is_failure());
    stop_host(host, runtime).await;
}

#[tokio::test]
async fn swarm_board_cold_restart_recovers_committed_undelivered_claim_without_duplicate_execution()
{
    let disk = Disk::new();
    let (host, runtime, store) = setup(&disk, Arc::new(Provider::default()));
    host.restore_from_store_with_policy(store.clone(), RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    let (team, child) = board_team(&host).await;
    let task = board_add(&host, &team, "recover", vec![]).await;
    // Hold delivery behind the same team gate as pause; simulate the durable
    // claim cut directly, without allowing a listener to admit it first.
    let gate = host
        .lock_admission(&format!("swarm-admission:{team}"))
        .await;
    let rev = board_list(&host, &team).await["revision"].as_u64().unwrap();
    let message = "swarm-crash-cut-claim";
    let change = crate::swarm_processor::SwarmProcessor::task(
        team.clone(),
        rev,
        xharness_control::SwarmTaskChange::Claimed {
            task_id: task.clone(),
            worker_session_id: child.clone(),
            message_id: message.into(),
        },
    );
    host.commit_control_mutation_named(
        &RpcId::new("claim-cut"),
        "test.swarm-claim",
        &json!({}),
        vec![xharness_control::ControlEvent::SwarmChanged { change }],
        json!({}),
    )
    .await
    .unwrap();
    host.stop_background_listeners();
    runtime.shutdown(Duration::from_secs(2)).await;
    // Pause metadata durably so even an already-captured listener cannot dispatch.
    let rev = board_list(&host, &team).await["revision"].as_u64().unwrap();
    host.commit_control_mutation_named(
        &RpcId::new("pause-cut"),
        "test.swarm-pause",
        &json!({}),
        vec![xharness_control::ControlEvent::SwarmChanged {
            change: xharness_control::SwarmChange::StatusChanged {
                id: team.clone(),
                expected_revision: rev,
                status: xharness_control::SwarmStatus::Paused,
            },
        }],
        json!({}),
    )
    .await
    .unwrap();
    drop(gate);
    drop(host);
    drop(runtime);
    drop(store);
    let provider = Arc::new(Provider::default());
    let (cold, cold_runtime, cold_store) = setup(&disk, provider.clone());
    cold.restore_from_store_with_policy(cold_store.clone(), RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    cold.reconcile_swarm_task_deliveries().await.unwrap();
    assert!(!cold_store.load(&child).await.unwrap().unwrap().events().iter().any(|e|matches!(e.data(),EventData::UserMessage{message:m,..}if m.id.as_deref()==Some(message))));
    let rev = board_list(&cold, &team).await["revision"].as_u64().unwrap();
    success(
        manage(
            &cold,
            "resume-task-team",
            "owner",
            json!({"action":"set_status","swarmId":team,"expectedRevision":rev,"status":"active"}),
        )
        .await,
    );
    board_wait_delivery(&cold, &child, message).await;
    let calls = provider.0.lock().unwrap().len();
    cold.reconcile_swarm_task_deliveries().await.unwrap();
    assert_eq!(provider.0.lock().unwrap().len(), calls);
    assert_eq!(cold_store.load(&child).await.unwrap().unwrap().events().iter().filter(|e|matches!(e.data(),EventData::UserMessage{message:m,..} if m.id.as_deref()==Some(message))).count(),1);
    stop_host(cold, cold_runtime).await;
}

struct LostTaskDeliveryAck {
    inner: Arc<dyn ControlStore>,
    armed: std::sync::atomic::AtomicBool,
    fail_flush: std::sync::atomic::AtomicBool,
}
#[async_trait]
impl ControlStore for LostTaskDeliveryAck {
    async fn load(&self) -> Result<xharness_control::ControlLog, xharness_control::ControlError> {
        self.inner.load().await
    }
    async fn append(
        &self,
        revision: xharness_control::ControlRevision,
        events: Vec<xharness_control::ControlEvent>,
    ) -> Result<xharness_control::ControlAppendReceipt, xharness_control::ControlError> {
        let delivery = events.iter().any(|e| {
            matches!(
                e,
                xharness_control::ControlEvent::SwarmChanged {
                    change: xharness_control::SwarmChange::TaskChanged {
                        change: xharness_control::SwarmTaskChange::Delivered { .. },
                        ..
                    }
                }
            )
        });
        let result = self.inner.append(revision, events).await?;
        if delivery && self.armed.swap(false, Ordering::SeqCst) {
            self.fail_flush.store(true, Ordering::SeqCst)
        }
        Ok(result)
    }
    async fn flush(
        &self,
    ) -> Result<xharness_control::ControlRevision, xharness_control::ControlError> {
        let r = self.inner.flush().await?;
        if self.fail_flush.swap(false, Ordering::SeqCst) {
            return Err(xharness_control::ControlError::Backend {
                message: "lost task delivery marker ack".into(),
            });
        }
        Ok(r)
    }
}
#[tokio::test]
async fn swarm_board_retries_lost_delivery_marker_ack_without_readmitting_claim() {
    let disk = Disk::new();
    let control = Arc::new(LostTaskDeliveryAck {
        inner: disk.control(),
        armed: std::sync::atomic::AtomicBool::new(true),
        fail_flush: std::sync::atomic::AtomicBool::new(false),
    });
    let (host, runtime, store) =
        setup_with_control(&disk, Arc::new(Provider::default()), control.clone());
    host.restore_from_store_with_policy(store.clone(), RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    let (team, child) = board_team(&host).await;
    let task = board_add(&host, &team, "lost-delivery-ack", vec![]).await;
    let receipt = board_claim(&host, &team, &task, &child, "claim-loss").await;
    let message = receipt["deliveryId"].as_str().unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            // The deliberately lost flush acknowledgement can be observed by
            // either this reconciler or the native listener; both must converge.
            let _ = host.reconcile_swarm_task_deliveries().await;
            let list = board_list(&host, &team).await;
            if list["tasks"][0]["task"]["state"]["delivered"] == true {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(!control.armed.load(Ordering::SeqCst));
    board_wait_delivery(&host, &child, message).await;
    assert_eq!(store.load(&child).await.unwrap().unwrap().events().iter().filter(|e|matches!(e.data(),EventData::UserMessage{message:m,..} if m.id.as_deref()==Some(message))).count(),1);
    stop_host(host, runtime).await;
}

#[tokio::test]
async fn swarm_board_only_recorded_pre_turn_failure_can_settle_and_keeps_dependencies_blocked() {
    let disk = Disk::new();
    let (host, runtime, store) = setup(&disk, Arc::new(Provider::default()));
    host.restore_from_store_with_policy(store.clone(), RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    let (team, child) = board_team(&host).await;
    let task = board_add(&host, &team, "failure", vec![]).await;
    let dependent = board_add(&host, &team, "blocked-dependent", vec![task.clone()]).await;
    let gate = host
        .lock_admission(&format!("swarm-admission:{team}"))
        .await;
    let r = board_list(&host, &team).await["revision"].as_u64().unwrap();
    let message = "swarm-preflight-failure";
    host.commit_control_mutation_named(
        &RpcId::new("seed-failed-claim"),
        "test.claim",
        &json!({}),
        vec![xharness_control::ControlEvent::SwarmChanged {
            change: crate::swarm_processor::SwarmProcessor::task(
                team.clone(),
                r,
                xharness_control::SwarmTaskChange::Claimed {
                    task_id: task.clone(),
                    worker_session_id: child.clone(),
                    message_id: message.into(),
                },
            ),
        }],
        json!({}),
    )
    .await
    .unwrap();
    host.set_dispatch_paused(&child, true).await.unwrap();
    drop(gate);
    let r = board_list(&host, &team).await["revision"].as_u64().unwrap();
    let request = json!({"action":"settle","swarmId":team,"expectedRevision":r,"taskId":task,"messageId":message,"turn":null,"outcome":"failed","summary":"provider preflight failed"});
    assert!(board(&host, "invented-failure", "owner", request.clone())
        .await
        .is_failure());
    host.commit_session_events(
        &child,
        vec![EventData::AgentDelegationFailure {
            message_id: message.into(),
            error: "route unavailable".into(),
        }
        .into()],
    )
    .await
    .unwrap();
    success(board(&host, "observed-failure", "owner", request).await);
    let list = board_list(&host, &team).await;
    assert_eq!(
        list["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["task"]["id"] == dependent)
            .unwrap()["ready"],
        false
    );
    assert!(list["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["task"]["state"]["outcome"] == "failed"));
    stop_host(host, runtime).await;
}

#[tokio::test]
async fn swarm_board_unknown_external_effect_stays_assigned_across_restart_without_replay() {
    let disk = Disk::new();
    let (host, runtime, store) = setup(&disk, Arc::new(Provider::default()));
    host.restore_from_store_with_policy(store.clone(), RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    let (team, child) = board_team(&host).await;
    let task = board_add(&host, &team, "unknown-effect", vec![]).await;
    let gate = host
        .lock_admission(&format!("swarm-admission:{team}"))
        .await;
    let revision = board_list(&host, &team).await["revision"].as_u64().unwrap();
    let delivery = "swarm-cut-after-side-effect";
    host.commit_control_mutation_named(
        &RpcId::new("effect-claim"),
        "test.effect-claim",
        &json!({}),
        vec![xharness_control::ControlEvent::SwarmChanged {
            change: crate::swarm_processor::SwarmProcessor::task(
                team.clone(),
                revision,
                xharness_control::SwarmTaskChange::Claimed {
                    task_id: task.clone(),
                    worker_session_id: child.clone(),
                    message_id: delivery.into(),
                },
            ),
        }],
        json!({}),
    )
    .await
    .unwrap();
    host.set_dispatch_paused(&child, true).await.unwrap();
    drop(gate);
    stop_host(host, runtime).await;
    let cut = store.load(&child).await.unwrap().unwrap();
    let call = ToolCall {
        id: "task-effect-before-crash".into(),
        name: "external_effect".into(),
        arguments_json: "{}".into(),
        ..Default::default()
    };
    let mut assistant = Message::assistant("");
    assistant.tool_calls.push(call.clone());
    let mut user = Message::user("Perform the assigned task");
    user.id = Some(delivery.into());
    store
        .append(
            &child,
            cut.revision(),
            vec![
                EventData::TurnStart { turn: 2 }.into(),
                EventData::UserMessage {
                    message: user,
                    surface_replace: None,
                }
                .into(),
                EventData::StepStart { turn: 2, step: 1 }.into(),
                EventData::AssistantMessage {
                    turn: 2,
                    step: 1,
                    message: assistant,
                    usage: None,
                }
                .into(),
                EventData::ToolCall {
                    turn: 2,
                    step: 1,
                    call,
                }
                .into(),
            ],
        )
        .await
        .unwrap();
    store.flush(&child).await.unwrap();
    let marker = disk.0.join("task-external-effect");
    std::fs::write(&marker, "performed once").unwrap();
    drop(store);
    let provider = Arc::new(Provider::default());
    let (cold, cold_runtime, cold_store) = setup(&disk, provider.clone());
    cold.restore_from_store_with_policy(cold_store.clone(), RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    for _ in 0..3 {
        cold.reconcile_swarm_task_deliveries().await.unwrap();
    }
    let list = board_list(&cold, &team).await;
    assert_eq!(list["tasks"][0]["task"]["state"]["status"], "assigned");
    assert_eq!(list["tasks"][0]["task"]["state"]["delivered"], false);
    assert_eq!(std::fs::read_to_string(marker).unwrap(), "performed once");
    assert!(
        provider.0.lock().unwrap().is_empty(),
        "inspection/outbox recovery must not call a model to redo an uncertain effect"
    );
    assert!(board(&cold,"false-completion","owner",json!({"action":"settle","swarmId":team,"expectedRevision":list["revision"],"taskId":task,"messageId":delivery,"turn":2,"outcome":"completed","summary":"not actually settled"})).await.is_failure());
    assert_eq!(
        xharness_session::incomplete_tool_calls(
            cold_store.load(&child).await.unwrap().unwrap().events()
        )
        .len(),
        1
    );
    stop_host(cold, cold_runtime).await;
}

#[tokio::test]
async fn swarm_board_blocked_outbox_does_not_block_ordinary_child_result_delivery() {
    let disk = Disk::new();
    let (host, runtime, store) = setup(&disk, Arc::new(Provider::default()));
    host.restore_from_store_with_policy(store.clone(), RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    let (team, child) = board_team(&host).await;
    let task = board_add(&host, &team, "park-outbox", vec![]).await;
    let gate = host
        .lock_admission(&format!("swarm-admission:{team}"))
        .await;
    let r = board_list(&host, &team).await["revision"].as_u64().unwrap();
    host.commit_control_mutation_named(
        &RpcId::new("blocked-outbox-claim"),
        "test.claim",
        &json!({}),
        vec![xharness_control::ControlEvent::SwarmChanged {
            change: crate::swarm_processor::SwarmProcessor::task(
                team.clone(),
                r,
                xharness_control::SwarmTaskChange::Claimed {
                    task_id: task,
                    worker_session_id: child,
                    message_id: "blocked-delivery".into(),
                },
            ),
        }],
        json!({}),
    )
    .await
    .unwrap();
    let other = host
        .execute_agent(
            "owner",
            "ordinary-independent-child",
            AgentOperation::Start {
                task: "Report an independent fact".into(),
                label: None,
                provider: None,
                model: None,
                reasoning_effort: None,
            },
        )
        .await
        .unwrap()["agent_id"]
        .as_str()
        .unwrap()
        .to_owned();
    settle(&host, &other).await;
    let notice = format!("{other}:settlement:1");
    tokio::time::timeout(Duration::from_secs(5),async{
        loop {
            if store.load("owner").await.unwrap().unwrap().events().iter().any(|e|matches!(e.data(),EventData::UserMessage{message,..} if message.id.as_deref()==Some(notice.as_str()))) {break}
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("Swarm outbox must not block ordinary settlement notifications");
    host.set_dispatch_paused(&other, true).await.unwrap();
    drop(gate);
    stop_host(host, runtime).await;
}

#[tokio::test]
async fn swarm_board_owner_can_reject_a_normally_ended_attempt_without_unlocking_dependents() {
    let disk = Disk::new();
    let (host, runtime, store) = setup(&disk, Arc::new(Provider::default()));
    host.restore_from_store_with_policy(store, RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    let (team, child) = board_team(&host).await;
    let first = board_add(&host, &team, "needs-review", vec![]).await;
    let next = board_add(&host, &team, "must-wait", vec![first.clone()]).await;
    let claim = board_claim(&host, &team, &first, &child, "reviewed-claim").await;
    let delivery = claim["deliveryId"].as_str().unwrap();
    let turn = board_wait_delivery(&host, &child, delivery).await;
    let revision = board_list(&host, &team).await["revision"].as_u64().unwrap();
    success(board(&host,"reject-insufficient-result","owner",json!({"action":"settle","swarmId":team,"expectedRevision":revision,"taskId":first,"messageId":delivery,"turn":turn,"outcome":"failed","summary":"Turn ended normally, but the collected evidence is insufficient"})).await);
    let list = board_list(&host, &team).await;
    assert_eq!(
        list["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["task"]["id"] == next)
            .unwrap()["ready"],
        false
    );
    stop_host(host, runtime).await;
}

#[path = "swarm_tasks/coordinator_tests.rs"]
mod coordinator_tests;

#[path = "swarm_tasks/dispatch_tests.rs"]
mod dispatch_tests;

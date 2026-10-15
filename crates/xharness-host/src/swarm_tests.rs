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

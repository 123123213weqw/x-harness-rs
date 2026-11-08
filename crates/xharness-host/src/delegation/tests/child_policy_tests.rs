//! Real durable admission, cancellation, settlement and cold-store tests.
use super::*;
use crate::SessionToolFactory;
use std::sync::atomic::AtomicBool;
use xharness_session::{agent_policy, AgentExecutionPolicy, TurnEndReason};
use xharness_tools::{ToolDefinition, ToolOutput, ToolSpec};

#[derive(Default)]
struct Tools {
    reads: Arc<AtomicUsize>,
    writes: Arc<AtomicUsize>,
    deny_parent_read: AtomicBool,
    child_preparation_gate: Option<CancellationToken>,
}
#[async_trait]
impl SessionToolFactory for Tools {
    async fn executor(
        &self,
        id: &str,
        _: &str,
        _: crate::PermissionPreset,
    ) -> Result<ToolExecutor, String> {
        if id != "p" {
            if let Some(gate) = &self.child_preparation_gate {
                gate.cancelled().await;
            }
        }
        let registry = Arc::new(ToolRegistry::new());
        for (name, calls) in [("read", self.reads.clone()), ("write", self.writes.clone())] {
            if id == "p" && name == "read" && self.deny_parent_read.load(Ordering::SeqCst) {
                continue;
            }
            registry
                .register(ToolSpec::new(
                    ToolDefinition::new(name, name, json!({"type":"object"})),
                    move |_| {
                        let calls = calls.clone();
                        async move {
                            calls.fetch_add(1, Ordering::SeqCst);
                            Ok(ToolOutput::text("done"))
                        }
                    },
                ))
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(ToolExecutor::new(registry))
    }
    async fn validate_executor(&self, executor: &ToolExecutor) -> Result<(), String> {
        // Deliberately requires deployment tools BEFORE child narrowing.
        if executor.registry().get("write").await.is_none() {
            return Err("deployment tool missing".into());
        }
        Ok(())
    }
}
struct Calls {
    child: AtomicUsize,
    requests: std::sync::Mutex<Vec<ProviderRequest>>,
    tool: Option<&'static str>,
    pending: bool,
}
impl Calls {
    fn new(tool: Option<&'static str>, pending: bool) -> Self {
        Self {
            child: AtomicUsize::new(0),
            requests: Default::default(),
            tool,
            pending,
        }
    }
}
#[async_trait]
impl ModelProvider for Calls {
    async fn stream(
        &self,
        request: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let child = request.debug_scope.session_id.as_deref() != Some("p");
        if child {
            self.child.fetch_add(1, Ordering::SeqCst);
            self.requests.lock().unwrap().push(request);
        }
        let pending = child && self.pending;
        let tool = child.then_some(self.tool).flatten();
        Ok(Box::pin(async_stream::stream! {
            if pending { std::future::pending::<()>().await; }
            if let Some(name)=tool {
                yield Ok(ProviderEvent::ToolCallDelta{index:0,id:"provider-call".into(),name:name.into(),arguments_delta:"{}".into()});
            }
            yield Ok(ProviderEvent::Completed{finish_reason:Some(if tool.is_some(){FinishReason::ToolCalls}else{FinishReason::Stop}),usage:None,provider_items:vec![]});
        }))
    }
}
async fn configured(
    store: Arc<dyn Store>,
    provider: Arc<Calls>,
    tools: Arc<Tools>,
) -> Arc<BasicHost> {
    let runtime: Arc<dyn AgentRuntime> = Arc::new(DurableLoopAgentRuntime::new(
        "probe",
        "test",
        Some(provider),
        tools,
        Arc::new(IdentityContextPolicy),
        store,
        Arc::new(MemoryLeaseManager::default()),
        2048,
    ));
    let mut config = HostConfig::new(std::env::current_dir().unwrap());
    config.provider_id = "probe".into();
    config.model_id = "test".into();
    BasicHost::with_agent_runtime(config, runtime)
}
fn op(options: Value) -> AgentOperation {
    let mut args = json!({"action":"start","task":"policy fixture"});
    args.as_object_mut()
        .unwrap()
        .extend(options.as_object().unwrap().clone());
    serde_json::from_value(args).unwrap()
}
async fn terminal(store: &Arc<dyn Store>, id: &str) -> Session {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let s = store.load(id).await.unwrap().unwrap();
            if s.events().iter().any(|e| {
                matches!(
                    e.data(),
                    EventData::TurnEnd { .. } | EventData::AgentDelegationFailure { .. }
                )
            }) {
                return s;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("child did not settle")
}
#[tokio::test]
async fn step_cap_enforces_real_cycles_preserves_receipt_and_does_not_reset_on_send() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let calls = Arc::new(Calls::new(Some("read"), false));
    let tools = Arc::new(Tools::default());
    let host = configured(store.clone(), calls.clone(), tools.clone()).await;
    parent(&host, "p").await;
    let operation = op(json!({"max_steps":2,"tool_allowlist":["read"]}));
    let result = host
        .execute_agent("p", "cap", operation.clone())
        .await
        .unwrap();
    let id = result["agent_id"].as_str().unwrap();
    let s = terminal(&store, id).await;
    settled(&host, id).await;
    assert_eq!(calls.child.load(Ordering::SeqCst), 2);
    assert_eq!(tools.reads.load(Ordering::SeqCst), 2);
    assert_eq!(tools.writes.load(Ordering::SeqCst), 0);
    assert!(s.events().iter().any(|e| matches!(
        e.data(),
        EventData::TurnEnd {
            reason: TurnEndReason::LimitReached,
            ..
        }
    )));
    assert_eq!(agent_policy(&s).unwrap().remaining_steps(), Some(0));
    let replay = host.execute_agent("p", "cap", operation).await.unwrap();
    assert_eq!(replay, result);
    assert!(host
        .execute_agent(
            "p",
            "cap",
            op(json!({"max_steps":3,"tool_allowlist":["read"]}))
        )
        .await
        .is_err());
    host.execute_agent(
        "p",
        "send",
        AgentOperation::Send {
            agent_id: id.into(),
            message: "again".into(),
        },
    )
    .await
    .unwrap();
    // Acknowledgement is inbox admission, not a reset/resume of the child.
    let parked = store.load(id).await.unwrap().unwrap();
    assert!(parked.dispatch_paused());
    assert!(xharness_agent::InboxProjection::from_session(&parked)
        .unwrap()
        .has_pending());
    assert_eq!(calls.child.load(Ordering::SeqCst), 2);
    let denied = host
        .enqueue_prompt(PromptAdmission {
            rpc_id: RpcId::new("human-resume-budget"),
            session_id: id.into(),
            mode: "queue".into(),
            text: "continue".into(),
            content: vec![json!({"type":"text","text":"continue"})],
            source: json!({"kind":"user"}),
            fingerprint: None,
        })
        .await
        .unwrap_err();
    assert!(denied.message.contains("max_steps"));
    assert!(store.load(id).await.unwrap().unwrap().dispatch_paused());
    assert_eq!(
        calls.child.load(Ordering::SeqCst),
        2,
        "human resume must not refill the policy"
    );
    host.deliver_child_settlements(id).await.unwrap();
    let parent_session = store.load("p").await.unwrap().unwrap();
    assert!(parent_session.events().iter().any(|e|matches!(e.data(),EventData::AgentInboxSpliced{inserted,..} if inserted.iter().any(|m|m.message.content.contains("limit_reached") && m.message.content.contains("execution_policy")))));
    assert!(calls.requests.lock().unwrap().iter().all(|r| r
        .tools
        .iter()
        .map(|t| t.name.as_str())
        .collect::<Vec<_>>()
        == ["read"]));
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
}
#[tokio::test]
async fn empty_tools_and_forged_calls_are_enforced_without_mutating_parent_or_siblings() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let calls = Arc::new(Calls::new(Some("write"), false));
    let tools = Arc::new(Tools::default());
    let host = configured(store.clone(), calls.clone(), tools.clone()).await;
    parent(&host, "p").await;
    for (inv, options) in [
        ("empty", json!({"max_steps":1,"tool_allowlist":[]})),
        (
            "read-only",
            json!({"max_steps":1,"tool_allowlist":["read"]}),
        ),
        ("inherited", json!({"max_steps":1})),
    ] {
        let result = host.execute_agent("p", inv, op(options)).await.unwrap();
        let id = result["agent_id"].as_str().unwrap();
        terminal(&store, id).await;
        settled(&host, id).await;
    }
    assert_eq!(tools.writes.load(Ordering::SeqCst), 1);
    assert_eq!(calls.requests.lock().unwrap()[0].tools.len(), 0);
    let names = host
        .agent_runtime
        .available_tool_names("p", ".", crate::PermissionPreset::default())
        .await
        .unwrap();
    assert!(names.contains(&"write".into()));
    assert!(host
        .execute_agent("p", "bad", op(json!({"tool_allowlist":["nonexistent"]})))
        .await
        .is_err());
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
}
#[tokio::test]
async fn whitelist_is_intersected_with_parent_again_after_preparation_and_timeout_cancels_preparation(
) {
    let gate = CancellationToken::new();
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let calls = Arc::new(Calls::new(Some("read"), false));
    let tools = Arc::new(Tools {
        child_preparation_gate: Some(gate.clone()),
        ..Default::default()
    });
    let host = configured(store.clone(), calls.clone(), tools.clone()).await;
    parent(&host, "p").await;
    let result = host
        .execute_agent(
            "p",
            "late",
            op(json!({"max_steps":1,"tool_allowlist":["read"]})),
        )
        .await
        .unwrap();
    let id = result["agent_id"].as_str().unwrap();
    tools.deny_parent_read.store(true, Ordering::SeqCst);
    gate.cancel();
    terminal(&store, id).await;
    settled(&host, id).await;
    assert_eq!(tools.reads.load(Ordering::SeqCst), 0);
    assert!(calls.requests.lock().unwrap()[0].tools.is_empty());
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let calls = Arc::new(Calls::new(None, false));
    let tools = Arc::new(Tools {
        child_preparation_gate: Some(CancellationToken::new()),
        ..Default::default()
    });
    let host = configured(store.clone(), calls.clone(), tools).await;
    parent(&host, "p").await;
    let result = host
        .execute_agent("p", "prep", op(json!({"timeout_seconds":1})))
        .await
        .unwrap();
    let id = result["agent_id"].as_str().unwrap();
    let s = terminal(&store, id).await;
    assert_eq!(calls.child.load(Ordering::SeqCst), 0);
    assert!(s.events().iter().any(|e|matches!(e.data(),EventData::AgentDelegationFailure{error,..} if error.contains("timeout_seconds"))));
    assert!(xharness_agent::InboxProjection::from_session(&s)
        .unwrap()
        .has_pending());
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
}
#[tokio::test]
async fn capacity_wait_expires_without_claiming_input_or_starting_a_fifth_provider() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let calls = Arc::new(Calls::new(None, true));
    let host = configured(store.clone(), calls.clone(), Arc::new(Tools::default())).await;
    parent(&host, "p").await;
    for n in 0..4 {
        host.execute_agent("p", &format!("busy-{n}"), op(json!({})))
            .await
            .unwrap();
    }
    tokio::time::timeout(Duration::from_secs(4), async {
        while calls.child.load(Ordering::SeqCst) < 4 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let result = host
        .execute_agent("p", "waiting", op(json!({"timeout_seconds":1})))
        .await
        .unwrap();
    let id = result["agent_id"].as_str().unwrap();
    host.enqueue_prompt(PromptAdmission {
        rpc_id: RpcId::new("human-during-capacity"),
        session_id: id.into(),
        mode: "queue".into(),
        text: "queued before expiry".into(),
        content: vec![json!({"type":"text","text":"queued before expiry"})],
        source: json!({"kind":"user"}),
        fingerprint: None,
    })
    .await
    .unwrap();
    let s = terminal(&store, id).await;
    settled(&host, id).await;
    assert!(host.state.read().await.sessions[id].dispatch_paused);
    assert_eq!(calls.child.load(Ordering::SeqCst), 4);
    assert!(s.events().iter().any(|e|matches!(e.data(),EventData::AgentDelegationFailure{error,..} if error.contains("timeout_seconds"))));
    assert!(!s
        .events()
        .iter()
        .any(|e| matches!(e.data(), EventData::TurnStart { .. })));
    assert!(xharness_agent::InboxProjection::from_session(&s)
        .unwrap()
        .has_pending());
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
}
#[tokio::test]
async fn timeout_stops_stream_settles_failure_and_releases_slot() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let calls = Arc::new(Calls::new(None, true));
    let host = configured(store.clone(), calls.clone(), Arc::new(Tools::default())).await;
    parent(&host, "p").await;
    let result = host
        .execute_agent("p", "stream", op(json!({"timeout_seconds":1})))
        .await
        .unwrap();
    let id = result["agent_id"].as_str().unwrap();
    let s = terminal(&store, id).await;
    settled(&host, id).await;
    assert!(s.events().iter().any(|e|matches!(e.data(),EventData::TurnEnd{reason:TurnEndReason::Failed{error,..},..} if error.contains("timeout_seconds"))));
    assert_eq!(calls.child.load(Ordering::SeqCst), 1);
    let final_session = store.load(id).await.unwrap().unwrap();
    assert!(final_session.dispatch_paused());
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
}
#[tokio::test]
async fn jsonl_restart_preserves_spent_steps_and_deadline_and_legacy_has_no_policy() {
    let root = std::env::temp_dir().join(format!(
        "child-policy-{}-{}",
        std::process::id(),
        crate::state::now_ms()
    ));
    let store: Arc<dyn Store> =
        Arc::new(xharness_session_jsonl::JsonlSessionStore::new(&root).unwrap());
    let calls = Arc::new(Calls::new(None, false));
    let host = configured(store.clone(), calls, Arc::new(Tools::default())).await;
    parent(&host, "p").await;
    let operation = op(json!({"max_steps":1,"timeout_seconds":60,"tool_allowlist":[]}));
    let result = host
        .execute_agent("p", "disk", operation.clone())
        .await
        .unwrap();
    let id = result["agent_id"].as_str().unwrap().to_owned();
    terminal(&store, &id).await;
    settled(&host, &id).await;
    let original = agent_policy(&store.load(&id).await.unwrap().unwrap())
        .unwrap()
        .policy
        .clone();
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
    host.stop_background_listeners();
    drop(host);
    drop(store);
    let store: Arc<dyn Store> =
        Arc::new(xharness_session_jsonl::JsonlSessionStore::new(&root).unwrap());
    let calls = Arc::new(Calls::new(None, false));
    let cold = configured(store.clone(), calls.clone(), Arc::new(Tools::default())).await;
    cold.restore_from_store(store.clone()).await.unwrap();
    let s = store.load(&id).await.unwrap().unwrap();
    assert_eq!(agent_policy(&s).unwrap().policy, &original);
    assert_eq!(agent_policy(&s).unwrap().remaining_steps(), Some(0));
    assert!(s.dispatch_paused());
    assert_eq!(
        cold.execute_agent("p", "disk", operation).await.unwrap(),
        result
    );
    assert_eq!(calls.child.load(Ordering::SeqCst), 0);
    assert!(AgentExecutionPolicy::admit(None, None, None, 0)
        .unwrap()
        .is_none());
    cold.agent_runtime.shutdown(Duration::from_secs(2)).await;
    cold.stop_background_listeners();
    drop(cold);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn completed_turn_send_and_revert_only_get_unspent_steps_with_the_same_deadline() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let calls = Arc::new(Calls::new(None, false));
    let host = configured(store.clone(), calls.clone(), Arc::new(Tools::default())).await;
    parent(&host, "p").await;
    let result = host
        .execute_agent(
            "p",
            "partial",
            op(json!({"max_steps":3,"timeout_seconds":60,"tool_allowlist":[]})),
        )
        .await
        .unwrap();
    let id = result["agent_id"].as_str().unwrap();
    terminal(&store, id).await;
    settled(&host, id).await;
    let first = store.load(id).await.unwrap().unwrap();
    let policy = agent_policy(&first).unwrap();
    assert_eq!(policy.remaining_steps(), Some(2));
    let deadline = policy.policy.deadline_unix_ms;
    let point = first
        .events()
        .iter()
        .find(|e| matches!(e.data(), EventData::TurnEnd { .. }))
        .unwrap()
        .seq;
    let reverted = host
        .execute_agent(
            "p",
            "correction",
            AgentOperation::Revert {
                agent_id: id.into(),
                checkpoint_seq: point,
                message: "correct direction".into(),
            },
        )
        .await
        .unwrap();
    let branch = reverted["agent_id"].as_str().unwrap();
    terminal(&store, branch).await;
    settled(&host, branch).await;
    let branched = store.load(branch).await.unwrap().unwrap();
    let state = agent_policy(&branched).unwrap();
    assert_eq!(state.policy.max_steps, Some(2));
    assert_eq!(state.remaining_steps(), Some(1));
    assert_eq!(state.policy.deadline_unix_ms, deadline);
    host.execute_agent(
        "p",
        "followup",
        AgentOperation::Send {
            agent_id: id.into(),
            message: "second turn".into(),
        },
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let s = store.load(id).await.unwrap().unwrap();
            if agent_policy(&s).unwrap().steps_used == 2
                && s.events()
                    .iter()
                    .filter(|e| matches!(e.data(), EventData::TurnEnd { .. }))
                    .count()
                    == 2
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    settled(&host, id).await;
    let second = store.load(id).await.unwrap().unwrap();
    let state = agent_policy(&second).unwrap();
    assert_eq!(state.remaining_steps(), Some(1));
    assert_eq!(state.policy.deadline_unix_ms, deadline);
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
}

#[test]
fn authoritative_storage_does_not_silently_opt_a_custom_runtime_into_enforcement() {
    struct StorageOnly;
    #[async_trait]
    impl AgentRuntime for StorageOnly {
        fn has_available_route(&self) -> bool {
            true
        }
        fn can_route(&self, _: &crate::ModelRoute) -> bool {
            true
        }
        fn has_authoritative_sessions(&self) -> bool {
            true
        }
        async fn start_turn(
            &self,
            _: crate::AgentTurnRequest,
        ) -> Result<Box<dyn crate::RunningTurn>, crate::AgentRuntimeError> {
            panic!("capability inspection must not start work")
        }
    }
    assert!(StorageOnly.has_authoritative_sessions());
    assert!(!StorageOnly.supports_child_execution_policy());
}

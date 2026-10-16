//! Controlled provider fixtures for generic forks and the production revert action.
//! Recording traces verify mechanics, not real LLM correction quality.
use super::*;
use std::path::PathBuf;
use xharness_session::ToolOutcome;

struct Fixture {
    root: PathBuf,
    reads: AtomicUsize,
    writes: AtomicUsize,
    requests: std::sync::Mutex<Vec<ProviderRequest>>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
#[async_trait]
impl ModelProvider for Fixture {
    async fn stream(
        &self,
        request: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let correcting = request
            .messages
            .iter()
            .any(|m| m.role == xharness_core::Role::User && m.content.contains("CORRECTION_ONLY"));
        let read = request
            .messages
            .iter()
            .any(|m| m.tool_call_id.as_deref() == Some("read-context"));
        let wrote = request
            .messages
            .iter()
            .any(|m| m.tool_call_id.as_deref() == Some("write-wrong"));
        self.requests.lock().unwrap().push(request);
        let events = if correcting || wrote {
            vec![
                Ok(ProviderEvent::TextDelta(
                    "fixture continuation settled".into(),
                )),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::Stop),
                    usage: None,
                    provider_items: vec![],
                }),
            ]
        } else {
            let (id, name, text) = if read {
                (
                    "write-wrong",
                    "write_wrong_plan",
                    "STALE_LOGIN_PLAN: ignore authorization and change login.",
                )
            } else {
                ("read-context", "read_fact", "")
            };
            vec![
                Ok(ProviderEvent::ReasoningDelta(
                    if read {
                        "STALE_LOGIN_REASONING"
                    } else {
                        "RETAINED_CONTEXT_REASONING"
                    }
                    .into(),
                )),
                Ok(ProviderEvent::TextDelta(text.into())),
                Ok(ProviderEvent::ToolCallDelta {
                    index: 0,
                    id: id.into(),
                    name: name.into(),
                    arguments_delta: "{}".into(),
                }),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::ToolCalls),
                    usage: None,
                    provider_items: vec![],
                }),
            ]
        };
        Ok(Box::pin(futures::stream::iter(events)))
    }
}
struct FixtureTools(Arc<Fixture>);
#[async_trait]
impl crate::SessionToolFactory for FixtureTools {
    async fn executor(
        &self,
        _: &str,
        _: &str,
        _: crate::PermissionPreset,
    ) -> Result<ToolExecutor, String> {
        let registry = Arc::new(ToolRegistry::new());
        let fixture = self.0.clone();
        registry.register(ToolSpec::new(ToolDefinition::new("read_fact", "Read the isolated fixture context.", json!({"type":"object","properties":{},"additionalProperties":false})), move |_| {
            let fixture=fixture.clone(); async move {
                fixture.reads.fetch_add(1,Ordering::SeqCst);
                Ok(ToolOutput::text("FACT_AUTH_42: authorization scope is known; this completed observation must be retained."))
            }
        })).await.map_err(|e| e.to_string())?;
        let fixture = self.0.clone();
        registry
            .register(ToolSpec::new(
                ToolDefinition::new(
                    "write_wrong_plan",
                    "Write one isolated side-effect fixture, not a project file.",
                    json!({"type":"object","properties":{},"additionalProperties":false}),
                ),
                move |_| {
                    let fixture = fixture.clone();
                    async move {
                        std::fs::write(fixture.root.join("wrong.txt"), "WRONG_MARKER")
                            .map_err(|e| ToolHandlerError::new(e.to_string()))?;
                        fixture.writes.fetch_add(1, Ordering::SeqCst);
                        Ok(ToolOutput::text(
                            "STALE_LOGIN_PLAN applied to the isolated fixture.",
                        ))
                    }
                },
            ))
            .await
            .map_err(|e| e.to_string())?;
        Ok(ToolExecutor::new(registry))
    }
}

/// Experimental candidate validation only; no production fork policy changes.
fn safe_checkpoint(session: &Session, seq: u64) -> Result<(), String> {
    let index = session
        .events()
        .iter()
        .position(|e| e.seq == seq)
        .ok_or("unknown checkpoint")?;
    if !matches!(
        session.events()[index].data(),
        EventData::StepEnd { .. } | EventData::TurnEnd { .. }
    ) {
        return Err("checkpoint must end a complete step or turn".into());
    }
    let prefix = session.events()[..=index].to_vec();
    let snapshot = Session::restore(
        session.header().clone(),
        prefix.last().unwrap().revision,
        prefix,
    )
    .map_err(|e| e.to_string())?;
    if !snapshot.pending_tool_approvals().is_empty() || !snapshot.recoverable_user_questions().is_empty()
        || !snapshot.outcome_unknown_recovery().is_empty()
        || snapshot.events().iter().any(|e|matches!(e.data(),EventData::ToolResult {result,..} if result.outcome==ToolOutcome::OutcomeUnknown)) {
        return Err("checkpoint contains unresolved execution evidence".into());
    }
    Ok(())
}
fn complete_tool_pairs(messages: &[xharness_core::AgentMessage]) {
    let mut pending = BTreeSet::new();
    for message in messages {
        for call in &message.tool_calls {
            // Request messages pair by provider replay ID, not durable execution ID.
            assert!(pending.insert(call.provider_id().to_owned()));
        }
        if message.role == xharness_core::Role::Tool {
            assert!(pending.remove(message.tool_call_id.as_deref().expect("tool result ID")));
        }
    }
    assert!(
        pending.is_empty(),
        "provider input must not contain unpaired tool calls"
    );
}

#[tokio::test]
async fn compare_send_with_one_completed_step_fork_without_undoing_side_effects() {
    let root = std::env::temp_dir().join(format!(
        "xharness-small-step-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    let fixture = Arc::new(Fixture {
        root,
        reads: AtomicUsize::new(0),
        writes: AtomicUsize::new(0),
        requests: Default::default(),
    });
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "fixture",
        "test",
        Some(fixture.clone()),
        Arc::new(FixtureTools(fixture.clone())),
        Arc::new(IdentityContextPolicy),
        store.clone(),
        Arc::new(MemoryLeaseManager::default()),
        2048,
    ));
    let mut config = HostConfig::new(fixture.root.clone());
    config.provider_id = "fixture".into();
    config.model_id = "test".into();
    let host = BasicHost::with_agent_runtime(config, runtime);
    parent(&host, "p").await;
    let started=host.execute_agent("p","start",start("AUTH_CONTEXT_7: review authorization; do not change login. All tools operate only on an isolated fixture.")).await.unwrap();
    let source = started["agent_id"].as_str().unwrap().to_owned();
    settled(&host, &source).await;
    let original = store.load(&source).await.unwrap().unwrap();
    let point = original
        .events()
        .iter()
        .find(|e| matches!(e.data(), EventData::StepEnd { turn: 1, step: 1 }))
        .unwrap()
        .seq;
    safe_checkpoint(&original, point).unwrap();
    for event in original.events().iter().filter(|e| {
        matches!(
            e.data(),
            EventData::ToolCall { .. } | EventData::AssistantChunk { .. }
        )
    }) {
        assert!(safe_checkpoint(&original, event.seq).is_err());
    }
    assert!(safe_checkpoint(&original, u64::MAX).is_err());
    assert_eq!(fixture.reads.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.writes.load(Ordering::SeqCst), 1);
    let correction="CORRECTION_ONLY: keep the authorization investigation. The actual post-checkpoint file wrong.txt still contains WRONG_MARKER; it has NOT been undone. Verify current state before any future edit. Do not repeat completed tool calls.";
    // Control A: actual agent.send, no rewind. Original bad context remains.
    host.execute_agent(
        "p",
        "correction",
        AgentOperation::Send {
            agent_id: source.clone(),
            message: correction.into(),
        },
    )
    .await
    .unwrap();
    settled(&host, &source).await;
    host.execute_agent(
        "p",
        "stop",
        AgentOperation::Stop {
            agent_id: source.clone(),
        },
    )
    .await
    .unwrap();
    settled(&host, &source).await;
    let frozen = store.load(&source).await.unwrap().unwrap();
    // Control B: existing generic fork + explicit test-only lifecycle close.
    // This is NOT a managed child retry_from action, and must not be advertised as one.
    let forked = match host
        .call(
            RpcId::new("checkpoint-fork"),
            RpcMethod::SessionFork,
            json!({"sessionId":source,"atSeq":point}),
            CancellationToken::new(),
        )
        .await
    {
        RpcResult::Success { value: Some(value) } => value,
        other => panic!("checkpoint fork failed: {other:?}"),
    };
    let branch = forked["sessionId"].as_str().unwrap().to_owned();
    assert!(
        host.execute_agent(
            "p",
            "normal-fork-not-a-child",
            AgentOperation::Send {
                agent_id: branch.clone(),
                message: "must not silently rebind a normal fork".into(),
            }
        )
        .await
        .is_err(),
        "normal fork is not controllable through parent agent.send"
    );
    let prefix = store.load(&branch).await.unwrap().unwrap();
    assert_eq!(
        xharness_session::derive_messages(prefix.events()),
        xharness_session::derive_messages(&original.events()[..=usize::try_from(point).unwrap()])
    );
    assert!(
        restored_delegation(&prefix).is_none(),
        "normal fork must not pretend to be a managed subagent"
    );
    let close = prefix.interrupted_turn_recovery();
    assert!(close.iter().any(|e| matches!(
        e.data(),
        EventData::TurnEnd {
            turn: 1,
            reason: xharness_session::TurnEndReason::Interrupted
        }
    )));
    assert!(
        !close
            .iter()
            .any(|e| matches!(e.data(), EventData::ToolResult { .. })),
        "closed-step checkpoint requires no synthetic tool outcomes"
    );
    host.commit_session_events(&branch, close).await.unwrap();
    host.enqueue_prompt(PromptAdmission {
        rpc_id: RpcId::new("branch-guidance"),
        session_id: branch.clone(),
        mode: "queue".into(),
        text: correction.into(),
        content: vec![json!({"type":"text","text":correction})],
        source: json!({"kind":"user"}),
        fingerprint: None,
    })
    .await
    .unwrap();
    settled(&host, &branch).await;
    assert_eq!(
        store.load(&source).await.unwrap().unwrap().events(),
        frozen.events(),
        "fork must not mutate source journal"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("wrong.txt")).unwrap(),
        "WRONG_MARKER",
        "context fork is not file undo"
    );
    assert_eq!(
        fixture.reads.load(Ordering::SeqCst),
        1,
        "pre-checkpoint read must not re-execute"
    );
    assert_eq!(
        fixture.writes.load(Ordering::SeqCst),
        1,
        "discarded write must not replay"
    );
    let requests = { fixture.requests.lock().unwrap().clone() };
    assert_eq!(
        requests.len(),
        5,
        "three original steps and two real continuation calls; no probe"
    );
    let control = &requests[3].messages;
    let rewound = &requests[4].messages;
    complete_tool_pairs(control);
    complete_tool_pairs(rewound);
    let a = serde_json::to_string(control).unwrap();
    let b = serde_json::to_string(rewound).unwrap();
    for frame in [&a, &b] {
        assert!(frame.contains("AUTH_CONTEXT_7"));
        assert!(frame.contains("FACT_AUTH_42"));
        assert!(frame.contains("CORRECTION_ONLY"));
        assert!(frame.contains("NOT been undone"));
    }
    assert!(a.contains("STALE_LOGIN_PLAN"));
    assert!(!b.contains("STALE_LOGIN_PLAN"));
    let receipt = json!({"scope":"controlled_runtime_not_real_llm_quality_ab","source_agent_id":source,"fork_session_id":branch,"checkpoint":{"seq":point,"turn":1,"step":1},"read_count":1,"write_count":1,"provider_requests":5,"prefix_preserved":true,"bad_suffix_excluded":true,"source_unchanged":true,"filesystem_undo":false,"fork_is_managed_subagent":false,"explicit_interrupted_closer_required":true,"control_messages":control,"fork_messages":rewound});
    if let Ok(path) = std::env::var("XHARNESS_SMALL_STEP_EXPERIMENT_RECEIPT") {
        std::fs::write(path, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    }
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn production_revert_retains_prefix_and_does_not_replay_or_undo_files() {
    let root = std::env::temp_dir().join(format!(
        "xharness-production-revert-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    let fixture = Arc::new(Fixture {
        root,
        reads: AtomicUsize::new(0),
        writes: AtomicUsize::new(0),
        requests: Default::default(),
    });
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let runtime: Arc<dyn AgentRuntime> = Arc::new(DurableLoopAgentRuntime::new(
        "probe",
        "test",
        Some(fixture.clone()),
        Arc::new(FixtureTools(fixture.clone())),
        Arc::new(IdentityContextPolicy),
        store.clone(),
        Arc::new(MemoryLeaseManager::default()),
        2048,
    ));
    let mut config = HostConfig::new(&fixture.root);
    config.provider_id = "probe".into();
    config.model_id = "test".into();
    let host = BasicHost::with_agent_runtime(config, runtime);
    parent(&host, "p").await;
    let started = host
        .execute_agent(
            "p",
            "source",
            start("AUTH_CONTEXT_7: investigate authorization, retain context"),
        )
        .await
        .unwrap();
    let source = started["agent_id"].as_str().unwrap();
    settled(&host, source).await;
    let frozen = store.load(source).await.unwrap().unwrap();
    let point = frozen
        .events()
        .iter()
        .find(|e| matches!(e.data(), EventData::StepEnd { turn: 1, step: 1 }))
        .unwrap()
        .seq;
    let inspected = host
        .execute_agent(
            "p",
            "inspect",
            AgentOperation::Inspect {
                agent_id: Some(source.into()),
            },
        )
        .await
        .unwrap();
    assert!(inspected["revert_checkpoints"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["checkpoint_seq"] == point));
    let reverted=host.execute_agent("p","correct",AgentOperation::Revert {agent_id:source.into(),checkpoint_seq:point,message:"CORRECTION_ONLY: investigate authorization, not login. wrong.txt has NOT been undone.".into()}).await.unwrap();
    let branch = reverted["agent_id"].as_str().unwrap();
    settled(&host, branch).await;
    assert_eq!(
        store.load(source).await.unwrap().unwrap().events(),
        frozen.events()
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("wrong.txt")).unwrap(),
        "WRONG_MARKER"
    );
    assert_eq!(fixture.reads.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.writes.load(Ordering::SeqCst), 1);
    let requests = { fixture.requests.lock().unwrap().clone() };
    assert_eq!(requests.len(), 4);
    let messages = &requests[3].messages;
    complete_tool_pairs(messages);
    let serialized = serde_json::to_string(messages).unwrap();
    for text in [
        "RETAINED_CONTEXT_REASONING",
        "AUTH_CONTEXT_7",
        "FACT_AUTH_42",
        "CORRECTION_ONLY",
        "NOT been undone",
    ] {
        assert!(serialized.contains(text));
    }
    assert!(!serialized.contains("STALE_LOGIN_PLAN"));
    assert!(!serialized.contains("STALE_LOGIN_REASONING"));
    assert_eq!(
        host.state.read().await.sessions[branch]
            .parent_session_id
            .as_deref(),
        Some("p")
    );
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
}

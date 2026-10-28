//! Isolated observer probes; synthetic IDs, no live sessions, tools or network.
use super::*;

struct CompleteThenBusy(AtomicUsize, bool);
#[async_trait]
impl ModelProvider for CompleteThenBusy {
    async fn stream(
        &self,
        _: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        if self.0.fetch_add(1, AtomicOrdering::SeqCst) == 0 {
            Ok(Box::pin(stream::iter([
                Ok(ProviderEvent::TextDelta("first done".into())),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::Stop),
                    usage: None,
                    provider_items: Vec::new(),
                }),
            ])))
        } else if self.1 {
            Ok(Box::pin(async_stream::stream! {
                loop {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    yield Ok(ProviderEvent::TextDelta("busy".into()));
                }
            }))
        } else {
            Ok(Box::pin(stream::pending()))
        }
    }
}

async fn diagnostic_busy_successor() -> (
    DurableLoopAgentRuntime,
    Arc<CompleteThenBusy>,
    Box<dyn RunningTurn>,
) {
    busy_successor_with_noise(false).await
}

async fn busy_successor_with_noise(
    noisy: bool,
) -> (
    DurableLoopAgentRuntime,
    Arc<CompleteThenBusy>,
    Box<dyn RunningTurn>,
) {
    let provider = Arc::new(CompleteThenBusy(AtomicUsize::new(0), noisy));
    let runtime = DurableLoopAgentRuntime::new(
        "test",
        "test-model",
        Some(provider.clone()),
        Arc::new(NoTools),
        Arc::new(IdentityContextPolicy),
        Arc::new(MemorySessionStore::default()),
        Arc::new(MemoryLeaseManager::default()),
        64,
    );
    let req = |id: &str| AgentTurnRequest {
        session_id: "isolated-queue-diagnosis".into(),
        cwd: "/workspace".into(),
        route: ModelRoute::new("test", "test-model"),
        permission: PermissionPreset::WorkspaceWrite,
        prompt: None,
        messages: vec![AgentMessage::user(id).with_id(id)],
        input_metadata: None,
    };
    let mut first = runtime.start_turn(req("finished-input")).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while first.next_event().await.is_some() {}
    })
    .await
    .unwrap();
    assert_eq!(first.result().await.status, LoopStatus::Completed);
    let second = runtime.start_turn(req("busy-successor")).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while provider.0.load(AtomicOrdering::SeqCst) < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    (runtime, provider, second)
}

#[tokio::test]
async fn completed_observer_must_not_wait_for_busy_successor_to_be_idle() {
    let (runtime, provider, mut second) = diagnostic_busy_successor().await;
    let handle = runtime
        .supervisor
        .get("isolated-queue-diagnosis")
        .await
        .unwrap();
    assert_eq!(handle.status(), xharness_agent::AgentStatus::Running);
    // A late attachment/lost terminal notification: the matching terminal is
    // durable, but no older broadcast exists in this new receiver.
    let events = handle.subscribe();
    let mut old = runtime.running_from_prepared(PreparedDurableTurn {
        handle,
        events,
        input_id: "finished-input".into(),
    });
    let observed = tokio::time::timeout(Duration::from_millis(1500), old.next_event()).await;
    let requests_before_cleanup = provider.0.load(AtomicOrdering::SeqCst);
    second.send(LoopCommand::Cancel).await.unwrap();
    while second.next_event().await.is_some() {}
    runtime.shutdown(Duration::from_secs(1)).await;
    assert_eq!(
        requests_before_cleanup, 2,
        "observation must not execute another turn"
    );
    assert!(
        matches!(observed, Ok(None)),
        "a completed old input observer stayed pending while a different turn was running"
    );
    assert_eq!(old.result().await.status, LoopStatus::Completed);
}

#[tokio::test]
async fn removed_observer_must_not_wait_for_busy_successor_to_be_idle() {
    let (runtime, provider, mut second) = diagnostic_busy_successor().await;
    let handle = runtime
        .supervisor
        .get("isolated-queue-diagnosis")
        .await
        .unwrap();
    let events = handle.subscribe();
    handle
        .inbox()
        .append(
            xharness_session::InboxTarget::NextTurn,
            InboxMessage::user("withdrawn-input", "synthetic queued input"),
        )
        .await
        .unwrap();
    handle
        .inbox()
        .remove("withdrawn-input")
        .await
        .unwrap()
        .unwrap();
    let mut removed = runtime.running_from_prepared(PreparedDurableTurn {
        handle,
        events,
        input_id: "withdrawn-input".into(),
    });
    let observed = tokio::time::timeout(Duration::from_millis(1500), removed.next_event()).await;
    let requests_before_cleanup = provider.0.load(AtomicOrdering::SeqCst);
    second.send(LoopCommand::Cancel).await.unwrap();
    while second.next_event().await.is_some() {}
    runtime.shutdown(Duration::from_secs(1)).await;
    assert_eq!(requests_before_cleanup, 2);
    assert!(
        matches!(observed, Ok(None)),
        "a withdrawn input observer stayed pending while another turn was running"
    );
    assert_eq!(removed.result().await.status, LoopStatus::Cancelled);
}

#[tokio::test]
async fn cancellation_receipt_is_not_starved_by_other_turn_events_or_cancelled_polls() {
    let (runtime, provider, mut second) = busy_successor_with_noise(true).await;
    let handle = runtime
        .supervisor
        .get("isolated-queue-diagnosis")
        .await
        .unwrap();
    handle
        .inbox()
        .append(
            xharness_session::InboxTarget::NextTurn,
            InboxMessage::user("withdrawn-later", "synthetic queued input"),
        )
        .await
        .unwrap();
    let events = handle.subscribe();
    let mut removed = runtime.running_from_prepared(PreparedDurableTurn {
        handle: handle.clone(),
        events,
        input_id: "withdrawn-later".into(),
    });
    // Initialize while still pending, then cancel the receive future repeatedly.
    assert!(
        tokio::time::timeout(Duration::from_millis(50), removed.next_event())
            .await
            .is_err()
    );
    handle
        .inbox()
        .remove("withdrawn-later")
        .await
        .unwrap()
        .unwrap();
    let settled = tokio::time::timeout(Duration::from_millis(1500), async {
        loop {
            match tokio::time::timeout(Duration::from_millis(50), removed.next_event()).await {
                Ok(None) => break,
                Ok(Some(_)) => panic!("another turn's event escaped the input fence"),
                Err(_) => {}
            }
        }
    })
    .await;
    let still_busy = handle.status();
    let requests = provider.0.load(AtomicOrdering::SeqCst);
    second.send(LoopCommand::Cancel).await.unwrap();
    while second.next_event().await.is_some() {}
    runtime.shutdown(Duration::from_secs(1)).await;
    assert!(
        settled.is_ok(),
        "unrelated event traffic starved durable cancellation"
    );
    assert_eq!(still_busy, xharness_agent::AgentStatus::Running);
    assert_eq!(requests, 2);
    assert_eq!(removed.result().await.status, LoopStatus::Cancelled);
}

#[tokio::test]
async fn absent_maintenance_or_pending_input_does_not_inherit_another_turns_completion() {
    let (runtime, _, mut second) = diagnostic_busy_successor().await;
    let handle = runtime
        .supervisor
        .get("isolated-queue-diagnosis")
        .await
        .unwrap();
    handle
        .inbox()
        .append(
            xharness_session::InboxTarget::NextTurn,
            InboxMessage::user("still-queued", "synthetic pending input"),
        )
        .await
        .unwrap();
    for id in ["still-queued", "preparing-compact-command"] {
        let events = handle.subscribe();
        let mut waiting = runtime.running_from_prepared(PreparedDurableTurn {
            handle: handle.clone(),
            events,
            input_id: id.into(),
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(100), waiting.next_event())
                .await
                .is_err(),
            "absence alone must not cancel maintenance before its durable prelude"
        );
    }
    handle
        .inbox()
        .remove("still-queued")
        .await
        .unwrap()
        .unwrap();
    second.send(LoopCommand::Cancel).await.unwrap();
    while second.next_event().await.is_some() {}
    runtime.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn old_input_receipt_does_not_clear_the_successors_host_running_flag() {
    use xharness_api::{ApiBackend, RpcId, RpcMethod};
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let provider = Arc::new(CompleteThenBusy(AtomicUsize::new(0), false));
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "test",
        "test-model",
        Some(provider.clone()),
        Arc::new(NoTools),
        Arc::new(IdentityContextPolicy),
        store.clone(),
        Arc::new(MemoryLeaseManager::default()),
        64,
    ));
    let mut config = crate::HostConfig::new(std::env::current_dir().unwrap());
    config.provider_id = "test".into();
    config.model_id = "test-model".into();
    let host = crate::BasicHost::with_agent_runtime(config, runtime.clone());
    crate::rpc::session_lifecycle::create(&host, &serde_json::json!({"sessionId":"handoff-fence"}))
        .await
        .unwrap();
    for id in ["finished-A", "busy-B"] {
        let response = host.call(RpcId::new(id), RpcMethod::SessionPrompt,
            serde_json::json!({"sessionId":"handoff-fence", "mode":"queue", "content":[{"type":"text","text":id}]}),
            CancellationToken::new()).await;
        assert!(
            matches!(response, xharness_api::RpcResult::Success { .. }),
            "{response:?}"
        );
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        while provider.0.load(AtomicOrdering::SeqCst) < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let handle = runtime.supervisor.get("handoff-fence").await.unwrap();
    let events = handle.subscribe();
    let mut old = runtime.running_from_prepared(PreparedDurableTurn {
        handle,
        events,
        input_id: "finished-A".into(),
    });
    assert!(matches!(
        tokio::time::timeout(Duration::from_millis(1500), old.next_event()).await,
        Ok(None)
    ));
    assert_eq!(old.result().await.status, LoopStatus::Completed);
    assert!(
        host.state.read().await.sessions["handoff-fence"].running,
        "A's late receipt must not publish idle over the active B driver"
    );
    let response = host
        .call(
            RpcId::new("stop-B"),
            RpcMethod::SessionCancel,
            serde_json::json!({"sessionId":"handoff-fence"}),
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(response, xharness_api::RpcResult::Success { .. }));
    super::dispatch_tests::wait_idle(&host, &store, "handoff-fence").await;
    assert_eq!(provider.0.load(AtomicOrdering::SeqCst), 2);
    runtime.shutdown(Duration::from_secs(1)).await;
}

/// Explicitly opt in to this synthetic overnight stress; no provider network.
#[tokio::test]
#[ignore = "isolated 1000-input admission/completion/stop stress"]
async fn long_queue_handoff_preserves_every_input_once() {
    use xharness_api::{ApiBackend, RpcId, RpcMethod};
    let timing = Arc::new(super::queue_timing::TimingStore::default());
    let store: Arc<dyn Store> = timing.clone();
    let (host, runtime) = super::dispatch_tests::fixture(store.clone());
    crate::rpc::session_lifecycle::create(&host, &serde_json::json!({"sessionId":"queue-long"}))
        .await
        .unwrap();
    let started = std::time::Instant::now();
    let settled = tokio::time::timeout(Duration::from_secs(120), async {
        for round in 0..250 {
            let sends = (0..4).map(|lane| {
                let host = host.clone();
                async move {
                    let id = format!("stress-{}", round*4+lane);
                    let response = host.call(RpcId::new(&id), RpcMethod::SessionPrompt,
                        serde_json::json!({"sessionId":"queue-long", "mode":"queue", "content":[{"type":"text","text":id}]}),
                        CancellationToken::new()).await;
                    assert!(matches!(response, xharness_api::RpcResult::Success { .. }), "{response:?}");
                }
            });
            futures::future::join_all(sends).await;
            if round % 13 == 0 {
                let response = host.call(RpcId::new(format!("stop-{round}")), RpcMethod::SessionCancel,
                    serde_json::json!({"sessionId":"queue-long"}), CancellationToken::new()).await;
                assert!(matches!(response, xharness_api::RpcResult::Success { .. }), "{response:?}");
            }
            if round % 25 == 0 {
                eprintln!("queue-stress admitted={} elapsed_ms={} {}", (round+1)*4, started.elapsed().as_millis(), timing.report());
            }
        }
        let response = host.call(RpcId::new("stress-fence"), RpcMethod::SessionPrompt,
            serde_json::json!({"sessionId":"queue-long", "mode":"queue", "content":[{"type":"text","text":"synthetic final fence"}]}),
            CancellationToken::new()).await;
        assert!(matches!(response, xharness_api::RpcResult::Success { .. }));
        loop {
            let session = store.load("queue-long").await.unwrap().unwrap();
            let inbox = xharness_agent::InboxProjection::from_session(&session).unwrap();
            if !host.state.read().await.sessions["queue-long"].running && !inbox.has_pending() { break; }
            tokio::task::yield_now().await;
        }
    }).await;
    eprintln!("queue-stress storage {}", timing.report());
    if settled.is_err() {
        let snapshot = store.load("queue-long").await.unwrap().unwrap();
        let inbox = xharness_agent::InboxProjection::from_session(&snapshot).unwrap();
        let handle = runtime.supervisor.get("queue-long").await.unwrap();
        let state = host.state.read().await;
        let record = &state.sessions["queue-long"];
        eprintln!("queue-stress timeout: journal_events={} user_messages={} starts={} ends={} durable_next_turn={} durable_next_step={} host_running={} host_control={} host_queue={} projected_queue={} agent_status={:?} worker={:?}",
            snapshot.next_seq(),
            snapshot.events().iter().filter(|e| matches!(e.data(), xharness_session::EventData::UserMessage { .. })).count(),
            snapshot.events().iter().filter(|e| matches!(e.data(), xharness_session::EventData::TurnStart { .. })).count(),
            snapshot.events().iter().filter(|e| matches!(e.data(), xharness_session::EventData::TurnEnd { .. })).count(),
            inbox.next_turn().len(), inbox.next_step().len(), record.running, record.control.is_some(), record.queue.len(), record.projected_queue.len(), handle.status(), handle.availability());
    }
    settled.expect("1000-input stress must settle within its declared 120-second budget");
    let session = store.load("queue-long").await.unwrap().unwrap();
    let mut ids = std::collections::BTreeMap::new();
    for event in session.events() {
        if let xharness_session::EventData::UserMessage { message, .. } = event.data() {
            if let Some(id) = message.id.as_deref().filter(|id| id.starts_with("stress-")) {
                *ids.entry(id.to_owned()).or_insert(0usize) += 1;
            }
        }
    }
    {
        let state = host.state.read().await;
        let record = &state.sessions["queue-long"];
        assert!(!record.running && record.control.is_none());
        assert!(record.queue.is_empty() && record.projected_queue.is_empty());
    }
    assert_eq!(
        ids.len(),
        1001,
        "every admitted input must be represented in complete history"
    );
    assert!(
        ids.values().all(|count| *count == 1),
        "no duplicate input execution"
    );
    eprintln!(
        "queue-stress inputs={} journal_events={} elapsed_ms={}",
        ids.len(),
        session.next_seq(),
        started.elapsed().as_millis()
    );
    runtime.shutdown(Duration::from_secs(1)).await;
}

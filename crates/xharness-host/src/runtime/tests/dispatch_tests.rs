//! Input-scoped Host handoff and next-step-only restart regressions.
use super::*;
use serde_json::json;
use std::time::Duration;
use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
use xharness_session::{EventData, InboxMessage, InboxTarget, Revision};

pub(super) fn fixture(
    store: Arc<dyn Store>,
) -> (Arc<crate::BasicHost>, Arc<DurableLoopAgentRuntime>) {
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "test",
        "test-model",
        Some(Arc::new(super::observer_tests::CompleteImmediately)),
        Arc::new(NoTools),
        Arc::new(IdentityContextPolicy),
        store,
        Arc::new(MemoryLeaseManager::default()),
        64,
    ));
    let mut config = crate::HostConfig::new(std::env::current_dir().unwrap());
    config.provider_id = "test".into();
    config.model_id = "test-model".into();
    (
        crate::BasicHost::with_agent_runtime(config, runtime.clone()),
        runtime,
    )
}
pub(super) async fn wait_idle(host: &crate::BasicHost, store: &Arc<dyn Store>, id: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let session = store.load(id).await.unwrap().unwrap();
            let inbox = xharness_agent::InboxProjection::from_session(&session).unwrap();
            if !host.state.read().await.sessions[id].running && !inbox.has_pending() {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("Host observer and durable inbox must both settle");
}

#[tokio::test]
async fn stale_host_running_does_not_route_steering_through_the_previous_turn() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let (host, runtime) = fixture(store.clone());
    crate::rpc::session_lifecycle::create(&host, &json!({"sessionId":"handoff"}))
        .await
        .unwrap();
    // The old Host observer still owns control, but its Agent has already
    // finished. Delay that observer's handoff until after the new RPC returns.
    let (tx, rx) = tokio::sync::mpsc::channel(64);
    {
        let mut state = host.state.write().await;
        let record = state.sessions.get_mut("handoff").unwrap();
        record.running = true;
        record.control = Some(tx);
    }
    let payload =
        json!({"sessionId":"handoff","mode":"steer","content":[{"type":"text","text":"hello"}]});
    for _ in 0..2 {
        let response = tokio::time::timeout(
            Duration::from_secs(2),
            host.call(
                RpcId::new("stable-input"),
                RpcMethod::SessionPrompt,
                payload.clone(),
                CancellationToken::new(),
            ),
        )
        .await
        .expect("admission must not wait for the stale Host control receiver");
        assert!(
            matches!(response, RpcResult::Success { .. }),
            "{response:?}"
        );
    }
    let owned = host.as_ref().clone();
    tokio::spawn(async move { owned.drive_session("handoff".into(), rx).await });
    wait_idle(&host, &store, "handoff").await;
    let session = store.load("handoff").await.unwrap().unwrap();
    assert_eq!(session.events().iter().filter(|e| matches!(e.data(), EventData::UserMessage { message, .. } if message.id.as_deref()==Some("stable-input"))).count(), 1);
    assert_eq!(
        session
            .events()
            .iter()
            .filter(|e| matches!(e.data(), EventData::TurnStart { .. }))
            .count(),
        1
    );
    runtime.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn restart_attaches_and_projects_next_step_only_user_input_in_both_gate_states() {
    for paused in [false, true] {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let id = format!("step-restart-{paused}");
        store.create(SessionHeader::new(&id)).await.unwrap();
        store
            .append(
                &id,
                Revision::ZERO,
                vec![
                    EventData::AgentInboxSpliced {
                        target: InboxTarget::NextStep,
                        start: 0,
                        removed_count: 0,
                        inserted: vec![InboxMessage::user("restored-user", "hello")],
                        outcome: None,
                    }
                    .into(),
                    EventData::AgentDispatchPaused { paused }.into(),
                ],
            )
            .await
            .unwrap();
        let (host, runtime) = fixture(store.clone());
        let report = host.restore_from_store(store.clone()).await.unwrap();
        assert_eq!(report.resumed_pending_turns, 1);
        wait_idle(&host, &store, &id).await;
        let history = host
            .call(
                RpcId::new("history"),
                RpcMethod::SessionHistory,
                json!({"sessionId":id}),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(history, RpcResult::Success { .. }));
        let session = store.load(&id).await.unwrap().unwrap();
        assert_eq!(session.events().iter().filter(|e| matches!(e.data(), EventData::UserMessage { message, .. } if message.id.as_deref()==Some("restored-user"))).count(), 1);
        assert!(!session.dispatch_paused());
        runtime.shutdown(Duration::from_secs(1)).await;
        // A second restart must never run the consumed user input again.
        let (again, runtime) = fixture(store.clone());
        let report = again.restore_from_store(store.clone()).await.unwrap();
        assert_eq!(report.resumed_pending_turns, 0);
        assert_eq!(
            store
                .load(&id)
                .await
                .unwrap()
                .unwrap()
                .events()
                .iter()
                .filter(|e| matches!(e.data(), EventData::TurnStart { .. }))
                .count(),
            1
        );
        runtime.shutdown(Duration::from_secs(1)).await;
    }
}

#[tokio::test]
async fn restart_does_not_dispatch_passive_context_or_reopen_a_stopped_gate() {
    for paused in [false, true] {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let id = format!("passive-restart-{paused}");
        store.create(SessionHeader::new(&id)).await.unwrap();
        let mut input = InboxMessage::user("background", "context only");
        input.source = Some(json!({"kind":"job-settlement"}));
        store
            .append(
                &id,
                Revision::ZERO,
                vec![
                    EventData::AgentInboxSpliced {
                        target: InboxTarget::NextStep,
                        start: 0,
                        removed_count: 0,
                        inserted: vec![input],
                        outcome: None,
                    }
                    .into(),
                    EventData::AgentDispatchPaused { paused }.into(),
                ],
            )
            .await
            .unwrap();
        let (host, runtime) = fixture(store.clone());
        let report = host.restore_from_store(store.clone()).await.unwrap();
        assert_eq!(report.resumed_pending_turns, 0);
        let session = store.load(&id).await.unwrap().unwrap();
        assert_eq!(session.dispatch_paused(), paused);
        assert!(!session
            .events()
            .iter()
            .any(|e| matches!(e.data(), EventData::TurnStart { .. })));
        assert_eq!(
            xharness_agent::InboxProjection::from_session(&session)
                .unwrap()
                .next_step()
                .len(),
            1
        );
        runtime.shutdown(Duration::from_secs(1)).await;
    }
}

#[tokio::test]
async fn active_steering_observer_settles_even_when_it_shares_the_previous_turn() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let provider = Arc::new(super::observer_tests::BlockFirstTurn {
        attempts: AtomicUsize::new(0),
    });
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
    crate::rpc::session_lifecycle::create(&host, &json!({"sessionId":"live-steer"}))
        .await
        .unwrap();
    let prompt = |mode: &str, text: &str| json!({"sessionId":"live-steer","mode":mode,"content":[{"type":"text","text":text}]});
    let response = host
        .call(
            RpcId::new("first"),
            RpcMethod::SessionPrompt,
            prompt("queue", "hello"),
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(response, RpcResult::Success { .. }));
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if provider.attempts.load(AtomicOrdering::SeqCst) > 0 {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let response = host
        .call(
            RpcId::new("change"),
            RpcMethod::SessionPrompt,
            prompt("steer", "goodbye"),
            CancellationToken::new(),
        )
        .await;
    assert!(
        matches!(response, RpcResult::Success { .. }),
        "{response:?}"
    );
    wait_idle(&host, &store, "live-steer").await;
    let session = store.load("live-steer").await.unwrap().unwrap();
    for id in ["first", "change"] {
        assert_eq!(session.events().iter().filter(|e| matches!(e.data(), EventData::UserMessage { message, .. } if message.id.as_deref()==Some(id))).count(), 1);
    }
    runtime.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn burst_steering_keeps_host_tracking_until_all_accepted_inputs_settle() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let (host, runtime) = fixture(store.clone());
    crate::rpc::session_lifecycle::create(&host, &json!({"sessionId":"burst"}))
        .await
        .unwrap();
    for index in 0..32 {
        let response = host.call(RpcId::new(format!("burst-{index}")), RpcMethod::SessionPrompt,
            json!({"sessionId":"burst","mode":"steer","content":[{"type":"text","text":"hello"}]}), CancellationToken::new()).await;
        assert!(
            matches!(response, RpcResult::Success { .. }),
            "{response:?}"
        );
    }
    wait_idle(&host, &store, "burst").await;
    let session = store.load("burst").await.unwrap().unwrap();
    for index in 0..32 {
        let id = format!("burst-{index}");
        assert_eq!(session.events().iter().filter(|e| matches!(e.data(), EventData::UserMessage { message, .. } if message.id.as_deref()==Some(id.as_str()))).count(), 1);
    }
    runtime.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn consumed_steering_crash_window_is_cleaned_without_replay_or_resume_mismatch() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    store
        .create(SessionHeader::new("consumed-step"))
        .await
        .unwrap();
    let input = InboxMessage::user("already-used", "hello");
    store
        .append(
            "consumed-step",
            Revision::ZERO,
            vec![
                EventData::AgentInboxSpliced {
                    target: InboxTarget::NextStep,
                    start: 0,
                    removed_count: 0,
                    inserted: vec![input.clone()],
                    outcome: None,
                }
                .into(),
                EventData::TurnStart { turn: 1 }.into(),
                EventData::UserMessage {
                    message: input.message,
                    surface_replace: None,
                }
                .into(),
                EventData::TurnEnd {
                    turn: 1,
                    reason: xharness_session::TurnEndReason::Completed,
                }
                .into(),
            ],
        )
        .await
        .unwrap();
    let (host, runtime) = fixture(store.clone());
    let report = host.restore_from_store(store.clone()).await.unwrap();
    assert_eq!(report.resumed_pending_turns, 0);
    let session = store.load("consumed-step").await.unwrap().unwrap();
    assert_eq!(
        session
            .events()
            .iter()
            .filter(|e| matches!(e.data(), EventData::TurnStart { .. }))
            .count(),
        1
    );
    assert!(!xharness_agent::InboxProjection::from_session(&session)
        .unwrap()
        .has_pending());
    assert!(host.state.read().await.sessions["consumed-step"]
        .projected_queue
        .is_empty());
    runtime.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn jsonl_restart_recovers_user_steering_once_and_keeps_the_same_wire_history() {
    let dir = std::env::temp_dir().join(format!(
        "xharness-dispatch-restart-{}-{}",
        std::process::id(),
        crate::state::now_ms()
    ));
    let store: Arc<dyn Store> =
        Arc::new(xharness_session_jsonl::JsonlSessionStore::new(&dir).unwrap());
    store.create(SessionHeader::new("disk-step")).await.unwrap();
    store
        .append(
            "disk-step",
            Revision::ZERO,
            vec![EventData::AgentInboxSpliced {
                target: InboxTarget::NextStep,
                start: 0,
                removed_count: 0,
                inserted: vec![InboxMessage::user("disk-input", "hello")],
                outcome: None,
            }
            .into()],
        )
        .await
        .unwrap();
    store.flush("disk-step").await.unwrap();
    drop(store);
    for expected in [1, 0] {
        let store: Arc<dyn Store> =
            Arc::new(xharness_session_jsonl::JsonlSessionStore::new(&dir).unwrap());
        let (host, runtime) = fixture(store.clone());
        let report = host.restore_from_store(store.clone()).await.unwrap();
        assert_eq!(report.resumed_pending_turns, expected);
        wait_idle(&host, &store, "disk-step").await;
        let session = store.load("disk-step").await.unwrap().unwrap();
        assert_eq!(session.events().iter().filter(|e| matches!(e.data(), EventData::UserMessage { message, .. } if message.id.as_deref()==Some("disk-input"))).count(), 1);
        assert_eq!(
            session
                .events()
                .iter()
                .filter(|e| matches!(e.data(), EventData::TurnStart { .. }))
                .count(),
            1
        );
        let response = host
            .call(
                RpcId::new("disk-history"),
                RpcMethod::SessionHistory,
                json!({"sessionId":"disk-step"}),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(response, RpcResult::Success { .. }));
        runtime.shutdown(Duration::from_secs(1)).await;
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn concurrent_duplicate_runtime_admission_keeps_one_input_and_observer() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let (host, runtime) = fixture(store.clone());
    crate::rpc::session_lifecycle::create(&host, &json!({"sessionId":"concurrent-input"}))
        .await
        .unwrap();
    let request = AgentTurnRequest {
        session_id: "concurrent-input".into(),
        cwd: "/workspace".into(),
        route: ModelRoute::new("test", "test-model"),
        permission: PermissionPreset::WorkspaceWrite,
        prompt: None,
        messages: vec![AgentMessage::user("hello").with_id("one-id")],
        input_metadata: None,
    };
    let mut joins = Vec::new();
    for _ in 0..8 {
        let runtime = runtime.clone();
        let request = request.clone();
        joins.push(tokio::spawn(async move {
            runtime.admit_steering(request).await
        }));
    }
    for join in joins {
        join.await.unwrap().unwrap();
    }
    let mut observer = runtime.start_turn(request).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while observer.next_event().await.is_some() {}
    })
    .await
    .expect("input-scoped observer must settle after duplicate admissions");
    assert_eq!(
        observer.result().await.status,
        xharness_core::LoopStatus::Completed
    );
    let session = store.load("concurrent-input").await.unwrap().unwrap();
    assert_eq!(session.events().iter().filter(|e| matches!(e.data(), EventData::UserMessage { message, .. } if message.id.as_deref()==Some("one-id"))).count(), 1);
    assert_eq!(
        session
            .events()
            .iter()
            .filter(|e| matches!(e.data(), EventData::TurnStart { .. }))
            .count(),
        1
    );
    assert!(runtime.prepared.lock().await.is_empty());
    runtime.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn retry_after_losing_the_prepared_receipt_does_not_reexecute_consumed_input() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let (host, runtime) = fixture(store.clone());
    crate::rpc::session_lifecycle::create(&host, &json!({"sessionId":"lost-receipt"}))
        .await
        .unwrap();
    let request = AgentTurnRequest {
        session_id: "lost-receipt".into(),
        cwd: "/workspace".into(),
        route: ModelRoute::new("test", "test-model"),
        permission: PermissionPreset::WorkspaceWrite,
        prompt: None,
        messages: vec![AgentMessage::user("hello").with_id("retry-id")],
        input_metadata: None,
    };
    for _ in 0..2 {
        runtime.admit_steering(request.clone()).await.unwrap();
        let mut observer = runtime.start_turn(request.clone()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while observer.next_event().await.is_some() {}
        })
        .await
        .unwrap();
        assert_eq!(
            observer.result().await.status,
            xharness_core::LoopStatus::Completed
        );
        assert!(runtime.prepared.lock().await.is_empty());
    }
    let session = store.load("lost-receipt").await.unwrap().unwrap();
    assert_eq!(session.events().iter().filter(|e| matches!(e.data(), EventData::UserMessage { message, .. } if message.id.as_deref()==Some("retry-id"))).count(), 1);
    assert_eq!(
        session
            .events()
            .iter()
            .filter(|e| matches!(e.data(), EventData::TurnStart { .. }))
            .count(),
        1
    );
    let mut conflicting = request;
    conflicting.messages[0].content = "different payload".into();
    assert!(runtime.admit_steering(conflicting).await.is_err());
    runtime.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn queued_user_steer_is_promoted_atomically_without_a_cancelled_receipt() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let provider = Arc::new(super::observer_tests::BlockFirstTurn {
        attempts: AtomicUsize::new(0),
    });
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
    crate::rpc::session_lifecycle::create(&host, &json!({"sessionId":"promote"}))
        .await
        .unwrap();
    for id in ["active", "queued"] {
        let response = host
            .call(
                RpcId::new(id),
                RpcMethod::SessionPrompt,
                json!({"sessionId":"promote","mode":"queue","content":[{"type":"text","text":id}]}),
                CancellationToken::new(),
            )
            .await;
        assert!(
            matches!(response, RpcResult::Success { .. }),
            "{response:?}"
        );
        if id == "active" {
            tokio::time::timeout(Duration::from_secs(3), async {
                while provider.attempts.load(AtomicOrdering::SeqCst) == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
    }
    let response = host
        .call(
            RpcId::new("promote-action"),
            RpcMethod::SessionUpdateQueue,
            json!({"sessionId":"promote","itemId":"queued","action":{"kind":"steer"}}),
            CancellationToken::new(),
        )
        .await;
    assert!(
        matches!(response, RpcResult::Success { .. }),
        "{response:?}"
    );
    wait_idle(&host, &store, "promote").await;
    let session = store.load("promote").await.unwrap().unwrap();
    assert_eq!(session.events().iter().filter(|e| matches!(e.data(), EventData::UserMessage { message, .. } if message.id.as_deref()==Some("queued"))).count(), 1);
    assert!(!session.events().iter().any(|e| matches!(
        e.data(),
        EventData::AgentInboxSpliced {
            outcome: Some(xharness_session::InboxSpliceOutcome::Cancelled),
            ..
        }
    )));
    runtime.shutdown(Duration::from_secs(1)).await;
}

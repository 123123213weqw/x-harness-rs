//! Regression coverage for delayed, steered and removed Host observers.
use super::*;

struct FloodThenBlock {
    attempts: AtomicUsize,
    emitted: Arc<AtomicUsize>,
    begin: Arc<Notify>,
    finish: Arc<Notify>,
}
#[async_trait]
impl ModelProvider for FloodThenBlock {
    async fn stream(
        &self,
        _: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        if self.attempts.fetch_add(1, AtomicOrdering::SeqCst) == 0 {
            let (begin, finish, emitted) = (
                self.begin.clone(),
                self.finish.clone(),
                self.emitted.clone(),
            );
            Ok(Box::pin(async_stream::stream! {
                begin.notified().await;
                for _ in 0..2200 {
                    yield Ok(ProviderEvent::TextDelta("x".into()));
                    emitted.fetch_add(1, AtomicOrdering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
                finish.notified().await;
                yield Ok(ProviderEvent::Completed { finish_reason:Some(FinishReason::Stop), usage:None, provider_items:Vec::new() });
            }))
        } else {
            Ok(Box::pin(stream::pending()))
        }
    }
}
#[tokio::test]
async fn lagged_queue_and_steering_observers_finish_after_user_stop() {
    lagged_queue_observer_stop_case(true).await;
}

#[tokio::test]
async fn removed_queue_observer_finishes_after_user_stop() {
    lagged_queue_observer_stop_case(false).await;
}

async fn lagged_queue_observer_stop_case(steer: bool) {
    use std::time::Duration;
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let begin = Arc::new(Notify::new());
    let finish = Arc::new(Notify::new());
    let emitted = Arc::new(AtomicUsize::new(0));
    let runtime = DurableLoopAgentRuntime::new(
        "test",
        "test-model",
        Some(Arc::new(FloodThenBlock {
            attempts: AtomicUsize::new(0),
            emitted: emitted.clone(),
            begin: begin.clone(),
            finish: finish.clone(),
        })),
        Arc::new(NoTools),
        Arc::new(IdentityContextPolicy),
        store.clone(),
        Arc::new(MemoryLeaseManager::default()),
        2048,
    );
    let a = AgentTurnRequest {
        session_id: "stop-repro".into(),
        cwd: "/workspace".into(),
        route: ModelRoute::new("test", "test-model"),
        permission: PermissionPreset::WorkspaceWrite,
        prompt: None,
        messages: vec![AgentMessage::user("a").with_id("a")],
        input_metadata: None,
    };
    let b = AgentTurnRequest {
        messages: vec![AgentMessage::user("b").with_id("b")],
        ..a.clone()
    };
    let c = AgentTurnRequest {
        messages: vec![AgentMessage::user("c").with_id("c")],
        ..a.clone()
    };
    runtime.admit_turn(a.clone()).await.unwrap();
    let mut arun = runtime.start_turn(a).await.unwrap();
    let drain = tokio::spawn(async move {
        while arun.next_event().await.is_some() {}
        arun.result().await
    });
    runtime.admit_turn(b.clone()).await.unwrap();
    begin.notify_one();
    tokio::time::timeout(Duration::from_secs(15), async {
        while emitted.load(AtomicOrdering::SeqCst) < 2200 {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    runtime.admit_turn(c.clone()).await.unwrap();
    finish.notify_one();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(15), drain)
            .await
            .unwrap()
            .unwrap()
            .status,
        LoopStatus::Completed
    );
    let mut brun = runtime.start_turn(b).await.unwrap();
    // Lag is a resynchronization boundary, not a failed model result.
    let event = brun.next_event().await.unwrap();
    assert!(matches!(
        event.kind,
        xharness_core::LoopEventKind::StreamCheckpoint
    ));
    let mut crun = runtime.start_turn(c).await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), crun.next_event())
            .await
            .is_err()
    );
    runtime
        .remove_pending_input("stop-repro", "c")
        .await
        .unwrap();
    if steer {
        crun.send(LoopCommand::Steer(AgentMessage::user("c").with_id("c")))
            .await
            .unwrap();
    }
    crun.send(LoopCommand::InterruptByUser).await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let s = store.load("stop-repro").await.unwrap().unwrap();
            if s.events().iter().any(|e| {
                matches!(
                    e.data(),
                    xharness_session::EventData::TurnEnd {
                        turn: 2,
                        reason: xharness_session::TurnEndReason::UserInterrupted
                    }
                )
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    for run in [&mut brun, &mut crun] {
        tokio::time::timeout(Duration::from_secs(3), async {
            while run.next_event().await.is_some() {}
        })
        .await
        .expect("observer must settle after durable stop");
        assert_eq!(run.result().await.status, LoopStatus::Cancelled);
    }
    let session = store.load("stop-repro").await.unwrap().unwrap();
    assert_eq!(
        session
            .events()
            .iter()
            .filter(|e| matches!(e.data(), xharness_session::EventData::TurnStart { .. }))
            .count(),
        2
    );
    runtime.shutdown(Duration::from_secs(1)).await;
}
#[tokio::test]
async fn late_observer_recovers_only_its_turn_without_reexecuting_input() {
    use std::time::Duration;
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let runtime = DurableLoopAgentRuntime::new(
        "test",
        "test-model",
        Some(Arc::new(ScriptProvider {
            answers: Mutex::new((0..5).map(|n| format!("answer-{n}")).collect()),
        })),
        Arc::new(NoTools),
        Arc::new(IdentityContextPolicy),
        store.clone(),
        Arc::new(MemoryLeaseManager::default()),
        16,
    );
    let request = |n| AgentTurnRequest {
        session_id: "late-observer".into(),
        cwd: "/workspace".into(),
        route: ModelRoute::new("test", "test-model"),
        permission: PermissionPreset::WorkspaceWrite,
        prompt: None,
        messages: vec![AgentMessage::user(format!("input-{n}")).with_id(format!("input-{n}"))],
        input_metadata: None,
    };
    let mut first = runtime.start_turn(request(0)).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if store
                .load("late-observer")
                .await
                .unwrap()
                .unwrap()
                .events()
                .iter()
                .any(|e| {
                    matches!(
                        e.data(),
                        xharness_session::EventData::TurnEnd { turn: 1, .. }
                    )
                })
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    for n in 1..5 {
        let mut next = runtime.start_turn(request(n)).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while next.next_event().await.is_some() {}
        })
        .await
        .unwrap();
        assert_eq!(next.result().await.final_text, format!("answer-{n}"));
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        while first.next_event().await.is_some() {}
    })
    .await
    .unwrap();
    let result = first.result().await;
    assert_eq!(result.status, LoopStatus::Completed);
    assert_eq!(result.final_text, "answer-0");
    assert_eq!(result.finish_reason, Some(FinishReason::Stop));
    assert_eq!(result.messages.len(), 2);
    assert!(!result.messages.iter().any(|m| m.content == "answer-4"));
    let session = store.load("late-observer").await.unwrap().unwrap();
    assert_eq!(
        session
            .events()
            .iter()
            .filter(|e| matches!(e.data(), xharness_session::EventData::TurnStart { .. }))
            .count(),
        5
    );
    runtime.shutdown(Duration::from_secs(1)).await;
}
#[tokio::test]
async fn host_flood_steer_stop_clears_running_and_parks_internal_followup() {
    use serde_json::json;
    use xharness_api::{ApiBackend, RpcId, RpcMethod};
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let begin = Arc::new(Notify::new());
    let finish = Arc::new(Notify::new());
    let emitted = Arc::new(AtomicUsize::new(0));
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "test",
        "test-model",
        Some(Arc::new(FloodThenBlock {
            attempts: AtomicUsize::new(0),
            emitted: emitted.clone(),
            begin: begin.clone(),
            finish: finish.clone(),
        })),
        Arc::new(NoTools),
        Arc::new(IdentityContextPolicy),
        store.clone(),
        Arc::new(MemoryLeaseManager::default()),
        2048,
    ));
    let mut config = crate::HostConfig::new(std::env::current_dir().unwrap());
    config.provider_id = "test".into();
    config.model_id = "test-model".into();
    let host = crate::BasicHost::with_agent_runtime(config, runtime.clone());
    host.session_create(&json!({"sessionId":"host-stop"}))
        .await
        .unwrap();
    let admission = |id: &str| crate::driver::PromptAdmission {
        rpc_id: RpcId::new(id),
        session_id: "host-stop".into(),
        mode: "queue".into(),
        text: id.into(),
        content: vec![json!({"type":"text","text":id})],
        source: json!({"kind":if id=="a" {"user"} else {"agent-settlement"}}),
        fingerprint: None,
    };
    host.enqueue_prompt(admission("a")).await.unwrap();
    host.enqueue_prompt(admission("b")).await.unwrap();
    begin.notify_one();
    tokio::time::timeout(Duration::from_secs(15), async {
        while emitted.load(AtomicOrdering::SeqCst) < 2200 {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    host.enqueue_prompt(admission("c")).await.unwrap();
    finish.notify_one();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let session = store.load("host-stop").await.unwrap().unwrap();
            if session
                .events()
                .iter()
                .any(|e| matches!(e.data(), xharness_session::EventData::TurnStart { turn: 2 }))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    let response = host
        .call(
            RpcId::new("steer-c"),
            RpcMethod::SessionUpdateQueue,
            json!({"sessionId":"host-stop","itemId":"c","action":{"kind":"steer"}}),
            CancellationToken::new(),
        )
        .await;
    assert!(
        matches!(response, xharness_api::RpcResult::Success { .. }),
        "{response:?}"
    );
    let response = host
        .call(
            RpcId::new("stop"),
            RpcMethod::SessionCancel,
            json!({"sessionId":"host-stop"}),
            CancellationToken::new(),
        )
        .await;
    assert!(
        matches!(response, xharness_api::RpcResult::Success { .. }),
        "{response:?}"
    );
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if !host.state.read().await.sessions["host-stop"].running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("Host must clear running after explicit stop");
    host.enqueue_prompt(admission("late-settlement"))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let state = host.state.read().await;
    let record = &state.sessions["host-stop"];
    assert!(!record.running);
    assert!(record.control.is_none());
    assert!(record.dispatch_paused);
    drop(state);
    let session = store.load("host-stop").await.unwrap().unwrap();
    assert_eq!(
        session
            .events()
            .iter()
            .filter(|e| matches!(e.data(), xharness_session::EventData::TurnStart { .. }))
            .count(),
        2
    );
    assert!(session.events().iter().any(|e| matches!(
        e.data(),
        xharness_session::EventData::TurnEnd {
            turn: 2,
            reason: xharness_session::TurnEndReason::UserInterrupted
        }
    )));
    runtime.shutdown(Duration::from_secs(1)).await;
}

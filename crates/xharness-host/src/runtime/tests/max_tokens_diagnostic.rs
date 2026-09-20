//! Diagnostic: asserts the existing max-token notice mismatch, not a fix.
use super::*;
use serde_json::json;
use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};

struct LengthThenPending {
    calls: AtomicUsize,
    release: Arc<Notify>,
}
#[async_trait]
impl ModelProvider for LengthThenPending {
    async fn stream(
        &self,
        _: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let call = self.calls.fetch_add(1, AtomicOrdering::SeqCst);
        if call < 3 {
            let release = self.release.clone();
            Ok(Box::pin(async_stream::stream! {
                if call == 0 { release.notified().await; }
                yield Ok(ProviderEvent::TextDelta(format!("partial-{call}")));
                yield Ok(ProviderEvent::Completed { finish_reason:Some(FinishReason::Length), usage:None, provider_items:Vec::new() });
            }))
        } else {
            Ok(Box::pin(stream::pending()))
        }
    }
}

#[tokio::test]
#[ignore = "diagnostic of known notice mismatch; run explicitly, remove when fixed"]
async fn diagnostic_max_tokens_notice_survives_next_turn_start() {
    for queued in [false, true] {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let release = Arc::new(Notify::new());
        let provider = Arc::new(LengthThenPending {
            calls: AtomicUsize::new(0),
            release: release.clone(),
        });
        let runtime = Arc::new(DurableLoopAgentRuntime::new(
            "test",
            "test-model",
            Some(provider.clone()),
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
        crate::rpc::session_lifecycle::create(&host, &json!({"sessionId":"notice-test"}))
            .await
            .unwrap();
        let admission = |id: &str| crate::driver::PromptAdmission {
            rpc_id: RpcId::new(id),
            session_id: "notice-test".into(),
            mode: "queue".into(),
            text: id.into(),
            content: vec![json!({"type":"text","text":id})],
            source: json!({"kind":"user"}),
            fingerprint: None,
        };
        host.enqueue_prompt(admission("original task"))
            .await
            .unwrap();
        if queued {
            host.enqueue_prompt(admission("independent followup"))
                .await
                .unwrap();
        }
        release.notify_one();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let session = store.load("notice-test").await.unwrap().unwrap();
                let ended = session.events().iter().any(|e| {
                    matches!(
                        e.data(),
                        xharness_session::EventData::TurnEnd {
                            turn: 1,
                            reason: xharness_session::TurnEndReason::MaxTokens
                        }
                    )
                });
                let running = host.state.read().await.sessions["notice-test"].running;
                if ended
                    && running == queued
                    && provider.calls.load(AtomicOrdering::SeqCst) == if queued { 4 } else { 3 }
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("expected output limit and next-turn/idle boundary");
        let response = host
            .call(
                RpcId::new("history"),
                RpcMethod::SessionHistory,
                json!({"sessionId":"notice-test","maxMessages":500}),
                CancellationToken::new(),
            )
            .await;
        let RpcResult::Success {
            value: Some(history),
        } = response
        else {
            panic!("{response:?}")
        };
        let events = history["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["event"].clone())
            .collect::<Vec<_>>();
        assert!(events
            .iter()
            .any(|e| e["type"] == "turn/end" && e["data"]["reason"]["kind"] == "max-tokens"));
        assert!(!events
            .iter()
            .any(|e| e["type"] == "turn/end" && e["data"]["reason"]["kind"] == "max-steps"));
        let starts = events.iter().filter(|e| e["type"] == "turn/start").count();
        assert_eq!(starts, if queued { 2 } else { 1 });
        println!(
            "MAX_TOKENS_DIAGNOSTIC={}",
            json!({"queued":queued,"running":host.state.read().await.sessions["notice-test"].running,
            "provider_calls":provider.calls.load(AtomicOrdering::SeqCst),"events":events.iter().filter(|e|e["type"]=="turn/start"||e["type"]=="turn/end").collect::<Vec<_>>()})
        );
        if queued {
            host.enqueue_prompt(admission("continue")).await.unwrap();
            let view = host.state.read().await.sessions["notice-test"].queue_view();
            assert!(view
                .iter()
                .any(|e| e["id"] == "continue" && e["placement"] == "queued"));
            println!("Extra user continue is queued while followup is running");
        }
        host.call(
            RpcId::new("stop"),
            RpcMethod::SessionCancel,
            json!({"sessionId":"notice-test"}),
            CancellationToken::new(),
        )
        .await;
        runtime.shutdown(Duration::from_secs(2)).await;
    }
}

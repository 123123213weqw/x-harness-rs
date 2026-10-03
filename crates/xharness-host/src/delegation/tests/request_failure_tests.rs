//! Real Host/Inbox/Core paths with injected provider failures; no paid probes.
use super::*;

struct FailFirst {
    calls: AtomicUsize,
    release: CancellationToken,
    status: u16,
    partial: bool,
}
#[async_trait]
impl ModelProvider for FailFirst {
    async fn stream(
        &self,
        _: ProviderRequest,
        cancel: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let first = self.calls.fetch_add(1, Ordering::SeqCst) == 0;
        if first {
            tokio::select! {
                _ = self.release.cancelled() => {},
                _ = cancel.cancelled() => return Err(ProviderError::new("cancelled")),
            }
            let error = ProviderError::http(self.status, "injected real request failure");
            if self.partial {
                return Ok(Box::pin(futures::stream::iter(vec![
                    Ok(ProviderEvent::TextDelta("partial answer".into())),
                    Err(error),
                ])));
            }
            return Err(error);
        }
        Ok(Box::pin(futures::stream::iter(vec![
            Ok(ProviderEvent::TextDelta("review complete".into())),
            Ok(ProviderEvent::Completed {
                finish_reason: Some(FinishReason::Stop),
                usage: None,
                provider_items: vec![],
            }),
        ])))
    }
}

async fn calls(provider: &FailFirst, count: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while provider.calls.load(Ordering::SeqCst) < count {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("real child request did not start");
}
async fn inspect(host: &BasicHost, id: &str) -> Value {
    host.execute_agent(
        "p",
        "inspect",
        AgentOperation::Inspect {
            agent_id: Some(id.into()),
        },
    )
    .await
    .unwrap()
}
async fn failed_child(
    status: u16,
    partial: bool,
) -> (Arc<BasicHost>, Arc<FailFirst>, Arc<dyn Store>, String) {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let provider = Arc::new(FailFirst {
        calls: AtomicUsize::new(0),
        release: CancellationToken::new(),
        status,
        partial,
    });
    let host = setup(store.clone(), provider.clone()).await;
    parent(&host, "p").await;
    let accepted = host
        .execute_agent("p", "start", start("independent review"))
        .await
        .unwrap();
    assert_eq!(accepted["status"], "accepted");
    let id = accepted["agent_id"].as_str().unwrap().to_owned();
    calls(&provider, 1).await;
    // Isolate parent policy: settlement admission may not make a paid parent call.
    host.set_dispatch_paused("p", true).await.unwrap();
    assert!(inspect(&host, &id).await["last_settlement"].is_null());
    assert_eq!(
        provider.calls.load(Ordering::SeqCst),
        1,
        "inspection must not probe"
    );
    provider.release.cancel();
    settled(&host, &id).await;
    (host, provider, store, id)
}

#[tokio::test]
async fn first_request_rejections_are_observable_and_parent_driven_retry_reuses_child() {
    for status in [400, 401, 403, 404] {
        let (host, provider, store, id) = failed_child(status, false).await;
        let failed = inspect(&host, &id).await["last_settlement"].clone();
        assert_eq!(failed["outcome"]["kind"], "failed");
        assert_eq!(failed["outcome"]["provider_failure"]["http_status"], status);
        assert_eq!(failed["outcome"]["provider_failure"]["retryable"], false);
        assert_eq!(failed["execution"]["request"]["provider"], "probe");
        assert_eq!(failed["execution"]["request"]["model"], "test");
        assert_eq!(failed["execution"]["output_observed"], false);
        assert_eq!(failed["execution"]["tool_calls_observed"], false);
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        // Upgrade/crash window: the old-version parent Inbox receipt exists,
        // but the child's delivered marker has not been committed yet.
        let legacy = json!({"agent_id":id,"turn":failed["turn"],"outcome":failed["outcome"],
            "answer":failed["answer"],"truncated":failed["truncated"]});
        host.deliver_agent_message(
            &id,
            "p",
            &format!("{id}:settlement:{}", failed["turn"]),
            legacy.to_string(),
            "agent-settlement",
            false,
        )
        .await
        .unwrap();
        host.deliver_child_settlements(&id).await.unwrap();
        host.deliver_child_settlements(&id).await.unwrap();
        {
            let state = host.state.read().await;
            let receipts = &state.sessions["p"].queue;
            assert_eq!(receipts.len(), 1, "failure receipt is delivered once");
            let content = receipts[0].text.split_once('\n').unwrap().1;
            let receipt = serde_json::from_str::<Value>(content).unwrap();
            let mut expected = failed.clone();
            for field in ["work_id", "settlement_seq", "timestamp_ms", "execution"] {
                expected.as_object_mut().unwrap().remove(field);
            }
            assert_eq!(
                receipt, expected,
                "automatic receipt preserves its legacy shape and authoritative outcome"
            );
        }
        let resumed = setup(store.clone(), provider.clone()).await;
        resumed.restore_from_store(store.clone()).await.unwrap();
        assert_eq!(
            inspect(&resumed, &id).await["last_settlement"],
            failed,
            "observation survives Host reconstruction"
        );
        resumed.deliver_child_settlements(&id).await.unwrap();
        assert_eq!(resumed.state.read().await.sessions["p"].queue.len(), 1);
        resumed.agent_runtime.shutdown(Duration::from_secs(2)).await;
        let retry = AgentOperation::Send {
            agent_id: id.clone(),
            message: "Credentials repaired; retry the same review.".into(),
        };
        host.execute_agent("p", "retry", retry.clone())
            .await
            .unwrap();
        // A parent send is accepted durably, not permission to reopen a
        // non-retryable child's gate. The canonical failure boundary (#278)
        // requires an actual human recovery input after credentials are fixed.
        assert!(store.load(&id).await.unwrap().unwrap().dispatch_paused());
        assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
        host.enqueue_prompt(crate::driver::PromptAdmission {
            rpc_id: RpcId::new("human-recovery"),
            session_id: id.clone(),
            mode: "queue".into(),
            text: "Credentials repaired; resume the queued review.".into(),
            content: vec![
                json!({"type":"text","text":"Credentials repaired; resume the queued review."}),
            ],
            source: json!({"kind":"user"}),
            fingerprint: None,
        })
        .await
        .unwrap();
        // The human recovery turn is claimed first; then the queued parent
        // retry runs as a distinct input. Neither is an automatic receipt.
        calls(&provider, 3).await;
        settled(&host, &id).await;
        host.execute_agent("p", "retry", retry).await.unwrap();
        let success = inspect(&host, &id).await["last_settlement"].clone();
        assert_eq!(success["outcome"]["kind"], "completed");
        assert_eq!(success["execution"]["output_observed"], true);
        assert_eq!(
            success["execution"]["request"],
            failed["execution"]["request"]
        );
        assert!(
            success["settlement_seq"].as_u64().unwrap()
                > failed["settlement_seq"].as_u64().unwrap()
        );
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            3,
            "one human recovery and one queued retry; no probe, auto-respawn or duplicate retry"
        );
        assert_eq!(
            host.state
                .read()
                .await
                .sessions
                .values()
                .filter(|s| s.delegated)
                .count(),
            1
        );
        host.agent_runtime.shutdown(Duration::from_secs(2)).await;
    }
}

#[tokio::test]
async fn partial_failure_is_not_a_success_or_a_no_output_failure() {
    let (host, provider, _, id) = failed_child(400, true).await;
    let notice = inspect(&host, &id).await["last_settlement"].clone();
    assert_eq!(notice["outcome"]["kind"], "failed");
    assert_eq!(notice["execution"]["output_observed"], true);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    host.deliver_child_settlements(&id).await.unwrap();
    assert_eq!(host.state.read().await.sessions["p"].queue.len(), 1);
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn transient_http_failure_uses_existing_core_retry_without_a_separate_probe() {
    for status in [429, 503] {
        let (host, provider, _, id) = failed_child(status, false).await;
        let notice = inspect(&host, &id).await["last_settlement"].clone();
        assert_eq!(notice["outcome"]["kind"], "completed");
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            2,
            "only the real request and its existing retry"
        );
        host.deliver_child_settlements(&id).await.unwrap();
        assert_eq!(host.state.read().await.sessions["p"].queue.len(), 1);
        host.agent_runtime.shutdown(Duration::from_secs(2)).await;
    }
}

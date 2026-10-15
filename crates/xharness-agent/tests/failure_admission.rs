//! Real LoopEngine + durable actor + journal. Only the model transport/count
//! is deterministic: no synthetic failed result or mocked dispatch gate.
use async_trait::async_trait;
use futures::stream;
use serde_json::json;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use xharness_agent::{
    AgentEvent, AgentRegistry, DurableAgentHandle, InboxMessage, MemoryLeaseManager,
    TurnRequestFactory,
};
use xharness_core::{
    AgentMessage, FinishReason, LoopRequest, LoopStatus, ModelProvider, ProviderError,
    ProviderEvent, ProviderInputTokenCount, ProviderRequest, ProviderStream, TokenBudget,
    TokenGuard,
};
use xharness_session::{EventData, MemorySessionStore, SessionHeader, Store, TurnEndReason};

#[derive(Default)]
struct Provider {
    fixed: AtomicBool,
    counts: AtomicUsize,
    summaries: AtomicUsize,
    entered: Notify,
    release: Notify,
    hold_first: bool,
}
fn is_summary(request: &ProviderRequest) -> bool {
    request
        .messages
        .last()
        .is_some_and(|m| m.content.contains("Act as the compaction engine"))
}
#[async_trait]
impl ModelProvider for Provider {
    async fn count_input_tokens(
        &self,
        request: &ProviderRequest,
        _: CancellationToken,
    ) -> Result<Option<ProviderInputTokenCount>, ProviderError> {
        let attempt = self.counts.fetch_add(1, Ordering::SeqCst);
        if self.hold_first && attempt == 0 {
            self.entered.notify_one();
            self.release.notified().await;
        }
        let size: usize = request
            .messages
            .iter()
            .filter(|m| !m.content.contains("Act as the compaction engine"))
            .map(|m| m.content.len())
            .sum();
        let tokens = if self.fixed.load(Ordering::SeqCst) || (is_summary(request) && size <= 9000) {
            1000
        } else {
            300_000
        };
        Ok(Some(ProviderInputTokenCount::exact_request(
            "fixture", tokens,
        )))
    }
    async fn stream(
        &self,
        request: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let text = if is_summary(&request) {
            self.summaries.fetch_add(1, Ordering::SeqCst);
            "non-shrinking ".repeat(650)
        } else {
            "resolved".into()
        };
        Ok(Box::pin(stream::iter([
            Ok(ProviderEvent::TextDelta(text)),
            Ok(ProviderEvent::Completed {
                finish_reason: Some(FinishReason::Stop),
                usage: None,
                provider_items: vec![],
            }),
        ])))
    }
}
struct Factory {
    provider: Arc<Provider>,
    compact: bool,
}
#[async_trait]
impl TurnRequestFactory for Factory {
    async fn build(&self, _: &str, input: Vec<AgentMessage>) -> Result<LoopRequest, String> {
        let mut request = LoopRequest::new(self.provider.clone(), input);
        request.token_guard = Some(
            TokenGuard::conservative(TokenBudget {
                context_window_tokens: 262_144,
                reserved_output_tokens: 4096,
                minimum_output_tokens: 1024,
                safety_margin_tokens: 1024,
            })
            .unwrap(),
        );
        if self.compact {
            request.compaction = Some(Default::default());
            let config = request.compaction.as_mut().unwrap();
            config.retain_ratio = None;
            config.retain_tokens = Some(0);
        }
        Ok(request)
    }
}
fn receipt(id: &str) -> InboxMessage {
    let mut input = InboxMessage::user(id, "child completed; context only");
    input.source = Some(json!({"kind":"agent-settlement","senderSessionId":"child"}));
    input
}
async fn seed(store: &Arc<dyn Store>, id: &str, reason: TurnEndReason) {
    let session = store.create(SessionHeader::new(id)).await.unwrap();
    store
        .append(
            id,
            session.revision(),
            vec![
                EventData::TurnStart { turn: 1 }.into(),
                EventData::UserMessage {
                    message: AgentMessage::user("u".repeat(6000)).with_id("original"),
                    surface_replace: None,
                }
                .into(),
                EventData::StepStart { turn: 1, step: 1 }.into(),
                EventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message: AgentMessage::assistant("a".repeat(6000)),
                    usage: None,
                }
                .into(),
                EventData::StepEnd { turn: 1, step: 1 }.into(),
                EventData::TurnEnd { turn: 1, reason }.into(),
            ],
        )
        .await
        .unwrap();
}
async fn next(events: &mut tokio::sync::broadcast::Receiver<AgentEvent>) -> AgentEvent {
    tokio::time::timeout(Duration::from_secs(5), events.recv())
        .await
        .expect("bounded actor event")
        .unwrap()
}
async fn parked(events: &mut tokio::sync::broadcast::Receiver<AgentEvent>) -> Vec<String> {
    loop {
        if let AgentEvent::Parked { input_ids } = next(events).await {
            return input_ids;
        }
    }
}

#[tokio::test]
async fn nonshrinking_compaction_parks_receipts_and_explicit_user_retry_is_atomic() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    seed(&store, "parent", TurnEndReason::Completed).await;
    let registry = AgentRegistry::new(store.clone(), Arc::new(MemoryLeaseManager::default()));
    let provider = Arc::new(Provider {
        hold_first: true,
        ..Default::default()
    });
    let handle = DurableAgentHandle::start(
        registry
            .activate(SessionHeader::new("parent"))
            .await
            .unwrap(),
        Arc::new(Factory {
            provider: provider.clone(),
            compact: true,
        }),
        64,
    );
    let mut events = handle.subscribe();
    handle
        .followup(InboxMessage::user("start", "continue"))
        .await
        .unwrap();
    provider.entered.notified().await;
    for id in ["child:1", "child:2", "child:3"] {
        handle.followup(receipt(id)).await.unwrap();
    }
    provider.release.notify_one();
    let result = loop {
        if let AgentEvent::TurnFinished { result, .. } = next(&mut events).await {
            break result;
        }
    };
    assert_eq!(result.status, LoopStatus::Failed);
    assert!(result
        .error
        .unwrap()
        .contains("required compaction produced no safe gain"));
    assert_eq!(parked(&mut events).await, ["child:1", "child:2", "child:3"]);
    assert!(store
        .load("parent")
        .await
        .unwrap()
        .unwrap()
        .dispatch_paused());
    let summaries = provider.summaries.load(Ordering::SeqCst);
    assert!(summaries > 0, "the real compaction summary ran");
    assert!(
        store
            .load("parent")
            .await
            .unwrap()
            .unwrap()
            .events()
            .iter()
            .any(|e| matches!(
                e.data(),
                EventData::CompactionEnd {
                    outcome: Some(xharness_session::CompactionEndOutcome::NoBenefit),
                    ..
                }
            )),
        "the real non-shrinking candidate failed budget validation"
    );
    let counts = provider.counts.load(Ordering::SeqCst);
    handle.wake().await.unwrap();
    parked(&mut events).await;
    handle.followup(receipt("child:4")).await.unwrap();
    assert_eq!(parked(&mut events).await.len(), 4);
    assert_eq!(
        provider.counts.load(Ordering::SeqCst),
        counts,
        "internal wake never reaches even token counting"
    );
    assert_eq!(provider.summaries.load(Ordering::SeqCst), summaries);
    assert!(matches!(
        handle
            .maintenance_followup(InboxMessage::user("reminder", "automatic maintenance"))
            .await,
        Err(xharness_agent::AgentCommandError::Failed(_))
    ));
    provider.fixed.store(true, Ordering::SeqCst);
    let snapshot = store.load("parent").await.unwrap().unwrap();
    store
        .append(
            "parent",
            snapshot.revision(),
            vec![EventData::CommandRun {
                command_id: "explicit-maintenance".into(),
                name: "compact".into(),
                args: None,
                source: xharness_session::CommandSource::User,
            }
            .into()],
        )
        .await
        .unwrap();
    handle.compact("explicit-maintenance").await.unwrap();
    loop {
        if let AgentEvent::TurnFinished { result, .. } = next(&mut events).await {
            assert_eq!(result.status, LoopStatus::Completed, "{result:?}");
            break;
        }
    }
    assert_eq!(parked(&mut events).await.len(), 4);
    assert!(
        store
            .load("parent")
            .await
            .unwrap()
            .unwrap()
            .dispatch_paused(),
        "a successful/no-benefit maintenance turn cannot implicitly resume receipts"
    );
    handle
        .followup(InboxMessage::user(
            "explicit-retry",
            "I changed the model; retry",
        ))
        .await
        .unwrap();
    let started = loop {
        if let AgentEvent::TurnStarted { input_ids, .. } = next(&mut events).await {
            break input_ids;
        }
    };
    assert_eq!(
        started,
        ["explicit-retry"],
        "pending child reports cannot precede the human resume"
    );
    let result = loop {
        if let AgentEvent::TurnFinished { result, .. } = next(&mut events).await {
            break result;
        }
    };
    assert_eq!(result.status, LoopStatus::Completed);
    let session = store.load("parent").await.unwrap().unwrap();
    assert!(!session.dispatch_paused());
    let events = session.events();
    let at = events
        .iter()
        .position(|e| matches!(e.data(), EventData::AgentDispatchPaused { paused: false }))
        .unwrap();
    assert_eq!(
        events[at].revision,
        events[at + 1].revision,
        "resume and inbox claim are one CAS append"
    );
    assert!(
        session
            .derive_messages()
            .iter()
            .any(|m| m.id.as_deref() == Some("original")),
        "failed compaction did not discard history"
    );
    handle.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn restored_failed_journal_and_new_receipts_remain_parked_without_a_pause_marker() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    seed(
        &store,
        "restored",
        TurnEndReason::Failed {
            error: "legacy budget failure".into(),
            provider_failure: None,
        },
    )
    .await;
    let registry = AgentRegistry::new(store.clone(), Arc::new(MemoryLeaseManager::default()));
    let provider = Arc::new(Provider::default());
    let handle = DurableAgentHandle::start(
        registry
            .activate(SessionHeader::new("restored"))
            .await
            .unwrap(),
        Arc::new(Factory {
            provider: provider.clone(),
            compact: false,
        }),
        64,
    );
    let mut events = handle.subscribe();
    handle.followup(receipt("late-result")).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), handle.when_idle())
        .await
        .expect("restored failure must settle without model work")
        .unwrap();
    assert_eq!(provider.counts.load(Ordering::SeqCst), 0);
    assert_eq!(parked(&mut events).await, ["late-result"]);
    assert_eq!(
        handle.inbox().snapshot().await.unwrap().next_turn().len(),
        1
    );
    assert_eq!(
        store
            .load("restored")
            .await
            .unwrap()
            .unwrap()
            .events()
            .iter()
            .filter(|e| matches!(e.data(), EventData::TurnStart { .. }))
            .count(),
        1
    );
    handle.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn healthy_agent_still_accepts_automatic_settlements() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let registry = AgentRegistry::new(store.clone(), Arc::new(MemoryLeaseManager::default()));
    let provider = Arc::new(Provider {
        fixed: AtomicBool::new(true),
        ..Default::default()
    });
    let handle = DurableAgentHandle::start(
        registry
            .activate(SessionHeader::new("healthy"))
            .await
            .unwrap(),
        Arc::new(Factory {
            provider,
            compact: false,
        }),
        64,
    );
    let mut events = handle.subscribe();
    handle.followup(receipt("normal-result")).await.unwrap();
    let result = loop {
        if let AgentEvent::TurnFinished { result, .. } = next(&mut events).await {
            break result;
        }
    };
    assert_eq!(result.status, LoopStatus::Completed);
    assert!(!store
        .load("healthy")
        .await
        .unwrap()
        .unwrap()
        .dispatch_paused());
    handle.shutdown(Duration::from_secs(1)).await;
}

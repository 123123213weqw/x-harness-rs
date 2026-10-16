use async_trait::async_trait;
use futures::stream;
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
use xharness_agent::{
    AgentEvent, AgentRegistry, AgentStatus, DurableAgentHandle, InboxMessage, MemoryLeaseManager,
    TurnRequestFactory,
};
use xharness_core::{
    AgentMessage, FinishReason, LoopRequest, ModelProvider, ProviderError, ProviderEvent,
    ProviderRequest, ProviderStream,
};
use xharness_session::{EventData, InboxTarget, MemorySessionStore, SessionHeader, Store};

struct Provider;
#[async_trait]
impl ModelProvider for Provider {
    async fn stream(
        &self,
        _: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        Ok(Box::pin(stream::iter([Ok(ProviderEvent::Completed {
            finish_reason: Some(FinishReason::Stop),
            usage: None,
            provider_items: Vec::new(),
        })])))
    }
}
struct Factory;
#[async_trait]
impl TurnRequestFactory for Factory {
    async fn build(&self, _: &str, input: Vec<AgentMessage>) -> Result<LoopRequest, String> {
        Ok(LoopRequest::new(Arc::new(Provider), input))
    }
}
async fn fixture(id: &str) -> (Arc<dyn Store>, DurableAgentHandle) {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let registry = AgentRegistry::new(store.clone(), Arc::new(MemoryLeaseManager::default()));
    let activation = registry.activate(SessionHeader::new(id)).await.unwrap();
    let handle = DurableAgentHandle::start(activation, Arc::new(Factory), 1024);
    handle.when_ready().await.unwrap();
    (store, handle)
}
async fn finished(events: &mut tokio::sync::broadcast::Receiver<AgentEvent>) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match events.recv().await.unwrap() {
                AgentEvent::TurnFinished { result, .. } => {
                    assert_eq!(result.status, xharness_core::LoopStatus::Completed);
                    return;
                }
                AgentEvent::Error { message } => panic!("{message}"),
                _ => {}
            }
        }
    })
    .await
    .expect("accepted user input must not remain stranded in Idle");
}
#[tokio::test]
async fn idle_steer_after_a_finished_turn_starts_the_successor() {
    let (_, handle) = fixture("idle-steer").await;
    let mut events = handle.subscribe();
    handle
        .followup(InboxMessage::user("first", "hello"))
        .await
        .unwrap();
    finished(&mut events).await;
    handle.when_idle().await.unwrap();
    handle
        .steer(InboxMessage::user("second", "goodbye"))
        .await
        .unwrap();
    finished(&mut events).await;
    assert!(!handle.inbox().snapshot().await.unwrap().has_pending());
    handle.shutdown(Duration::from_secs(1)).await;
}
#[tokio::test]
async fn explicit_wake_dispatches_user_next_step_input_with_either_gate_state() {
    for paused in [false, true] {
        let (store, handle) = fixture(&format!("wake-{paused}")).await;
        if paused {
            let session = store.load(handle.id()).await.unwrap().unwrap();
            store
                .append(
                    handle.id(),
                    session.revision(),
                    vec![EventData::AgentDispatchPaused { paused: true }.into()],
                )
                .await
                .unwrap();
        }
        let mut events = handle.subscribe();
        handle
            .inject(InboxMessage::user("restored", "hello"))
            .await
            .unwrap();
        handle.wake().await.unwrap();
        finished(&mut events).await;
        assert!(!handle.inbox().snapshot().await.unwrap().has_pending());
        assert!(!store
            .load(handle.id())
            .await
            .unwrap()
            .unwrap()
            .dispatch_paused());
        handle.shutdown(Duration::from_secs(1)).await;
    }
}
#[tokio::test]
async fn passive_next_step_context_does_not_wake_or_reopen_a_stopped_agent() {
    for paused in [false, true] {
        let (store, handle) = fixture(&format!("context-{paused}")).await;
        if paused {
            let session = store.load(handle.id()).await.unwrap().unwrap();
            store
                .append(
                    handle.id(),
                    session.revision(),
                    vec![EventData::AgentDispatchPaused { paused: true }.into()],
                )
                .await
                .unwrap();
        }
        let mut message = InboxMessage::user("context", "background context");
        message.source = Some(serde_json::json!({"kind":"job-settlement"}));
        handle.inject(message).await.unwrap();
        let mut events = handle.subscribe();
        handle.wake().await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                match events.recv().await.unwrap() {
                    AgentEvent::Status(AgentStatus::Idle) => return,
                    AgentEvent::TurnStarted { .. } => panic!("passive context started a turn"),
                    _ => {}
                }
            }
        })
        .await
        .unwrap();
        let session = store.load(handle.id()).await.unwrap().unwrap();
        assert_eq!(session.dispatch_paused(), paused);
        assert!(!session
            .events()
            .iter()
            .any(|e| matches!(e.data(), EventData::TurnStart { .. })));
        assert_eq!(
            handle.inbox().snapshot().await.unwrap().next_step().len(),
            1
        );
        handle.shutdown(Duration::from_secs(1)).await;
    }
}
#[tokio::test]
async fn repeated_idle_and_end_boundary_steering_consumes_each_identity_once() {
    let (store, handle) = fixture("boundary-steer").await;
    for index in 0..48 {
        handle
            .steer(InboxMessage::user(format!("input-{index}"), "hello"))
            .await
            .unwrap();
        if index % 3 == 0 {
            tokio::time::timeout(Duration::from_secs(3), handle.when_idle())
                .await
                .unwrap()
                .unwrap();
        }
    }
    tokio::time::timeout(Duration::from_secs(3), handle.when_idle())
        .await
        .unwrap()
        .unwrap();
    let session = store.load(handle.id()).await.unwrap().unwrap();
    for index in 0..48 {
        let id = format!("input-{index}");
        assert_eq!(session.events().iter().filter(|event| matches!(event.data(), EventData::UserMessage { message, .. } if message.id.as_deref()==Some(id.as_str()))).count(), 1, "{id}");
    }
    assert!(!handle.inbox().snapshot().await.unwrap().has_pending());
    handle.shutdown(Duration::from_secs(1)).await;
}
#[tokio::test]
async fn only_passive_next_step_has_no_independent_recovery_observer() {
    let (_, handle) = fixture("passive-observer").await;
    let mut context = InboxMessage::user("context", "background");
    context.source = Some(serde_json::json!({"kind":"agent-settlement"}));
    handle
        .inbox()
        .append(InboxTarget::NextStep, context)
        .await
        .unwrap();
    assert_eq!(
        handle
            .inbox()
            .snapshot()
            .await
            .unwrap()
            .dispatch_inputs()
            .count(),
        0
    );
    handle.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn queue_promotion_is_one_revision_and_cancelled_or_consumed_ids_never_replay() {
    use xharness_agent::DurableInbox;
    use xharness_session::TurnEndReason;
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let inbox = DurableInbox::open(store.clone(), SessionHeader::new("atomic-promote"))
        .await
        .unwrap();
    let input = InboxMessage::user("same-id", "hello");
    inbox
        .append(InboxTarget::NextTurn, input.clone())
        .await
        .unwrap();
    let before = store
        .load("atomic-promote")
        .await
        .unwrap()
        .unwrap()
        .revision();
    assert!(inbox.admit_steering(input.clone()).await.unwrap());
    let promoted = store.load("atomic-promote").await.unwrap().unwrap();
    assert_eq!(promoted.revision().get(), before.get() + 1);
    let tail = &promoted.events()[promoted.events().len() - 2..];
    assert_eq!(tail[0].revision, tail[1].revision);
    assert!(inbox.snapshot().await.unwrap().next_turn().is_empty());
    assert_eq!(inbox.snapshot().await.unwrap().next_step().len(), 1);
    assert!(!inbox.admit_steering(input.clone()).await.unwrap());
    inbox.remove("same-id").await.unwrap();
    assert!(!inbox.admit_steering(input).await.unwrap());
    assert!(!inbox.snapshot().await.unwrap().has_pending());

    let used = InboxMessage::user("used-id", "goodbye");
    inbox
        .append(InboxTarget::NextStep, used.clone())
        .await
        .unwrap();
    let session = store.load("atomic-promote").await.unwrap().unwrap();
    store
        .append(
            "atomic-promote",
            session.revision(),
            vec![
                EventData::TurnStart { turn: 1 }.into(),
                EventData::UserMessage {
                    message: used.message.clone(),
                    surface_replace: None,
                }
                .into(),
                EventData::TurnEnd {
                    turn: 1,
                    reason: TurnEndReason::Completed,
                }
                .into(),
            ],
        )
        .await
        .unwrap();
    assert!(!inbox.admit_steering(used.clone()).await.unwrap());
    assert!(!inbox.snapshot().await.unwrap().has_pending());
    assert!(!inbox.admit_steering(used).await.unwrap());
}

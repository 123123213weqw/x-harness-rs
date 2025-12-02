use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    task::Poll,
    time::Duration,
};

use async_trait::async_trait;
use futures::stream;
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::sync::CancellationToken;
use xharness_agent::{
    AgentEvent, AgentRegistry, AgentShutdownOutcome, AgentSupervisor, DurableAgentHandle,
    InboxMessage, MemoryLeaseManager, TurnRequestFactory,
};
use xharness_core::{
    AgentMessage, FinishReason, LoopRequest, ModelProvider, ProviderError, ProviderEvent,
    ProviderRequest, ProviderStream,
};
use xharness_session::{MemorySessionStore, SessionHeader, Store};

type Script = Vec<Result<ProviderEvent, ProviderError>>;

#[derive(Clone)]
struct ScriptProvider {
    scripts: Arc<Mutex<VecDeque<Script>>>,
}

#[async_trait]
impl ModelProvider for ScriptProvider {
    async fn stream(
        &self,
        _request: ProviderRequest,
        _cancellation: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let script = self.scripts.lock().unwrap().pop_front().unwrap();
        Ok(Box::pin(stream::iter(script)))
    }
}

struct Factory {
    provider: Arc<dyn ModelProvider>,
}

struct StreamDropGuard(Arc<AtomicBool>);

impl Drop for StreamDropGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

struct HangingProvider {
    polled: Arc<tokio::sync::Notify>,
    stream_dropped: Arc<AtomicBool>,
}

#[async_trait]
impl ModelProvider for HangingProvider {
    async fn stream(
        &self,
        _request: ProviderRequest,
        _cancellation: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let polled = Arc::clone(&self.polled);
        let guard = StreamDropGuard(Arc::clone(&self.stream_dropped));
        let mut first = true;
        Ok(Box::pin(stream::poll_fn(move |_context| {
            let _ = &guard;
            if first {
                first = false;
                polled.notify_one();
            }
            Poll::Pending
        })))
    }
}

#[derive(Clone, Default)]
struct SteeringProvider {
    attempts: Arc<AtomicUsize>,
}

#[async_trait]
impl ModelProvider for SteeringProvider {
    async fn stream(
        &self,
        _request: ProviderRequest,
        cancellation: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let attempt = self.attempts.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = tokio::sync::mpsc::channel(8);
        tokio::spawn(async move {
            if attempt == 0 {
                let _ = tx
                    .send(Ok(ProviderEvent::TextDelta("partial".to_owned())))
                    .await;
                cancellation.cancelled().await;
            } else {
                let _ = tx
                    .send(Ok(ProviderEvent::TextDelta("steered".to_owned())))
                    .await;
                let _ = tx
                    .send(Ok(ProviderEvent::Completed {
                        finish_reason: Some(FinishReason::Stop),
                        usage: None,
                        provider_items: Vec::new(),
                    }))
                    .await;
            }
        });
        Ok(Box::pin(ReceiverStream::new(rx)))
    }
}

#[async_trait]
impl TurnRequestFactory for Factory {
    async fn build(
        &self,
        _agent_id: &str,
        input: Vec<AgentMessage>,
    ) -> Result<LoopRequest, String> {
        Ok(LoopRequest::new(Arc::clone(&self.provider), input))
    }
}

fn answer(text: &str) -> Script {
    vec![
        Ok(ProviderEvent::TextDelta(text.to_owned())),
        Ok(ProviderEvent::Completed {
            finish_reason: Some(FinishReason::Stop),
            usage: None,
            provider_items: Vec::new(),
        }),
    ]
}

#[tokio::test]
async fn durable_driver_consumes_followups_across_multiple_turns() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let registry = AgentRegistry::new(Arc::clone(&store), Arc::new(MemoryLeaseManager::default()));
    let activation = registry
        .activate(SessionHeader::new("driver"))
        .await
        .unwrap();
    let provider: Arc<dyn ModelProvider> = Arc::new(ScriptProvider {
        scripts: Arc::new(Mutex::new(VecDeque::from([
            answer("first answer"),
            answer("second answer"),
        ]))),
    });
    let handle = DurableAgentHandle::start(activation, Arc::new(Factory { provider }), 64);
    let mut events = handle.subscribe();

    handle
        .followup(InboxMessage::user("prompt-1", "first"))
        .await
        .unwrap();
    handle
        .followup(InboxMessage::user("prompt-2", "second"))
        .await
        .unwrap();

    let mut finished = Vec::new();
    while finished.len() < 2 {
        if let AgentEvent::TurnFinished { turn, result } = events.recv().await.unwrap() {
            finished.push((turn, result.final_text));
        }
    }
    assert_eq!(
        finished,
        [
            (1, "first answer".to_owned()),
            (2, "second answer".to_owned())
        ]
    );

    let session = store.load("driver").await.unwrap().unwrap();
    assert_eq!(
        session
            .derive_messages()
            .iter()
            .filter(|message| message.role == xharness_session::MessageRole::User)
            .filter_map(|message| message.id.as_deref())
            .collect::<Vec<_>>(),
        ["prompt-1", "prompt-2"]
    );
    assert!(!handle.inbox().snapshot().await.unwrap().has_pending());
}

#[tokio::test]
async fn idle_injection_stays_pending_until_a_waking_message_arrives() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let registry = AgentRegistry::new(Arc::clone(&store), Arc::new(MemoryLeaseManager::default()));
    let activation = registry
        .activate(SessionHeader::new("inject"))
        .await
        .unwrap();
    let provider: Arc<dyn ModelProvider> = Arc::new(ScriptProvider {
        scripts: Arc::new(Mutex::new(VecDeque::from([answer("done")]))),
    });
    let handle =
        DurableAgentHandle::start(Arc::clone(&activation), Arc::new(Factory { provider }), 64);
    let mut events = handle.subscribe();

    handle
        .inject(InboxMessage::user("context", "extra context"))
        .await
        .unwrap();
    tokio::task::yield_now().await;
    assert_eq!(
        activation
            .inbox()
            .snapshot()
            .await
            .unwrap()
            .next_step()
            .len(),
        1
    );

    handle
        .followup(InboxMessage::user("prompt", "answer now"))
        .await
        .unwrap();
    loop {
        if matches!(
            events.recv().await.unwrap(),
            AgentEvent::TurnFinished { .. }
        ) {
            break;
        }
    }
    let session = store.load("inject").await.unwrap().unwrap();
    assert_eq!(
        session
            .derive_messages()
            .iter()
            .filter(|message| message.role == xharness_session::MessageRole::User)
            .filter_map(|message| message.id.as_deref())
            .collect::<Vec<_>>(),
        ["context", "prompt"]
    );
}

#[tokio::test]
async fn recovered_followup_waits_for_explicit_wake_after_subscriber_attachment() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let registry = AgentRegistry::new(Arc::clone(&store), Arc::new(MemoryLeaseManager::default()));
    let activation = registry
        .activate(SessionHeader::new("resume-gate"))
        .await
        .unwrap();
    activation
        .inbox()
        .append(
            xharness_agent::InboxTarget::NextTurn,
            InboxMessage::user("restored-prompt", "resume me"),
        )
        .await
        .unwrap();
    let provider: Arc<dyn ModelProvider> = Arc::new(ScriptProvider {
        scripts: Arc::new(Mutex::new(VecDeque::from([answer("resumed")]))),
    });
    let handle = DurableAgentHandle::start(activation, Arc::new(Factory { provider }), 64);
    let mut events = handle.subscribe();

    tokio::task::yield_now().await;
    assert_eq!(
        handle.inbox().snapshot().await.unwrap().next_turn()[0].id,
        "restored-prompt"
    );
    assert!(matches!(
        events.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));

    handle.wake().await.unwrap();
    let result = loop {
        if let AgentEvent::TurnFinished { result, .. } = events.recv().await.unwrap() {
            break result;
        }
    };
    assert_eq!(result.final_text, "resumed");
    assert!(!handle.inbox().snapshot().await.unwrap().has_pending());
}

#[tokio::test]
async fn active_steer_is_durable_and_consumed_at_the_next_step() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let registry = AgentRegistry::new(Arc::clone(&store), Arc::new(MemoryLeaseManager::default()));
    let activation = registry
        .activate(SessionHeader::new("steering"))
        .await
        .unwrap();
    let provider = Arc::new(SteeringProvider::default());
    let provider_dyn: Arc<dyn ModelProvider> = provider.clone();
    let handle = DurableAgentHandle::start(
        activation,
        Arc::new(Factory {
            provider: provider_dyn,
        }),
        64,
    );
    let mut events = handle.subscribe();
    handle
        .followup(InboxMessage::user("prompt", "begin"))
        .await
        .unwrap();

    loop {
        if matches!(
            events.recv().await.unwrap(),
            AgentEvent::TurnEvent {
                event: xharness_core::LoopEvent {
                    kind: xharness_core::LoopEventKind::TextDelta(ref text),
                    ..
                },
                ..
            } if text == "partial"
        ) {
            break;
        }
    }
    handle
        .steer(InboxMessage::user("steer", "change"))
        .await
        .unwrap();
    let final_text = loop {
        if let AgentEvent::TurnFinished { result, .. } = events.recv().await.unwrap() {
            break result.final_text;
        }
    };
    assert_eq!(final_text, "steered");
    assert_eq!(provider.attempts.load(Ordering::SeqCst), 2);

    let session = store.load("steering").await.unwrap().unwrap();
    assert_eq!(
        session
            .derive_messages()
            .iter()
            .filter(|message| message.role == xharness_session::MessageRole::User)
            .filter_map(|message| message.id.as_deref())
            .collect::<Vec<_>>(),
        ["prompt", "steer"]
    );
    assert!(!handle.inbox().snapshot().await.unwrap().has_pending());
}

#[tokio::test]
async fn supervisor_publishes_only_one_worker_per_agent() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let registry = Arc::new(AgentRegistry::new(
        store,
        Arc::new(MemoryLeaseManager::default()),
    ));
    let provider: Arc<dyn ModelProvider> = Arc::new(ScriptProvider {
        scripts: Arc::new(Mutex::new(VecDeque::new())),
    });
    let factory: Arc<dyn TurnRequestFactory> = Arc::new(Factory { provider });
    let supervisor = AgentSupervisor::new(registry, factory, 64);
    let first = supervisor
        .activate(SessionHeader::new("one-worker"))
        .await
        .unwrap();
    let second = supervisor
        .activate(SessionHeader::new("one-worker"))
        .await
        .unwrap();
    assert!(first.is_same_worker(&second));
    let report = supervisor.shutdown(Duration::from_secs(1)).await;
    assert_eq!(report.workers, 1);
    assert_eq!(report.graceful, 1);
    assert_eq!(report.forced_cleanup, 0);
    assert!(supervisor
        .activate(SessionHeader::new("after-shutdown"))
        .await
        .is_err());
}

#[tokio::test]
async fn handle_shutdown_waits_until_the_active_provider_stream_is_dropped() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let registry = AgentRegistry::new(Arc::clone(&store), Arc::new(MemoryLeaseManager::default()));
    let activation = registry
        .activate(SessionHeader::new("shutdown-active"))
        .await
        .unwrap();
    let polled = Arc::new(tokio::sync::Notify::new());
    let stream_dropped = Arc::new(AtomicBool::new(false));
    let provider: Arc<dyn ModelProvider> = Arc::new(HangingProvider {
        polled: Arc::clone(&polled),
        stream_dropped: Arc::clone(&stream_dropped),
    });
    let handle = DurableAgentHandle::start(activation, Arc::new(Factory { provider }), 64);
    handle
        .followup(InboxMessage::user("shutdown-prompt", "wait forever"))
        .await
        .unwrap();
    polled.notified().await;

    let outcome = handle.shutdown(Duration::from_secs(2)).await;
    assert_eq!(outcome, AgentShutdownOutcome::Graceful);
    assert!(stream_dropped.load(Ordering::Acquire));
    assert!(store
        .load("shutdown-active")
        .await
        .unwrap()
        .unwrap()
        .events()
        .iter()
        .any(|event| matches!(
            event.data(),
            xharness_session::EventData::TurnEnd {
                reason: xharness_session::TurnEndReason::Cancelled,
                ..
            }
        )));
}

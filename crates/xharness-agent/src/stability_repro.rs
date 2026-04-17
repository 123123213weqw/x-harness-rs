//! Regression tests for worker lifecycle recovery.
//!
//! Each test failed against the code that cached a dead worker handle forever;
//! they now guard the invariants that make a worker replaceable: identity that
//! survives a respawn, subscribers that outlive one, and a lifecycle
//! reservation that does not outlive its task.

use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Duration,
};

use async_trait::async_trait;
use futures::stream;
use tokio_util::sync::CancellationToken;
use xharness_core::{
    AgentMessage, FinishReason, LoopRequest, ModelProvider, ProviderError, ProviderEvent,
    ProviderRequest, ProviderStream,
};
use xharness_session::{
    AppendReceipt, MemorySessionStore, Revision, Session, SessionEvent, SessionHeader,
    SessionInspection, Store, StoreError,
};

use crate::{
    driver::WORKER_RESPAWN_BACKOFF, AgentEvent, AgentRegistry, AgentSupervisor, InboxMessage,
    MemoryLeaseManager, TurnRequestFactory,
};

/// Wait out the respawn gate so the next command is allowed to spawn a worker.
/// Derived from the implementation constant so the two cannot drift apart.
async fn wait_out_respawn_backoff() {
    tokio::time::sleep(WORKER_RESPAWN_BACKOFF + Duration::from_millis(150)).await;
}

/// A store that can be switched into failing reads and appends.
struct ToggleFailStore {
    inner: Arc<dyn Store>,
    failing: Arc<AtomicBool>,
}

#[async_trait]
impl Store for ToggleFailStore {
    async fn list_headers(&self) -> Result<Vec<SessionHeader>, StoreError> {
        self.inner.list_headers().await
    }

    async fn create(&self, header: SessionHeader) -> Result<Session, StoreError> {
        self.inner.create(header).await
    }

    async fn load(&self, session_id: &str) -> Result<Option<Session>, StoreError> {
        if self.failing.load(Ordering::Acquire) {
            return Err(StoreError::Backend {
                message: "injected read failure".to_owned(),
            });
        }
        self.inner.load(session_id).await
    }

    async fn append(
        &self,
        session_id: &str,
        expected_revision: Revision,
        events: Vec<SessionEvent>,
    ) -> Result<AppendReceipt, StoreError> {
        if self.failing.load(Ordering::Acquire) {
            return Err(StoreError::Backend {
                message: "injected append failure".to_owned(),
            });
        }
        self.inner
            .append(session_id, expected_revision, events)
            .await
    }

    async fn flush(&self, session_id: &str) -> Result<Revision, StoreError> {
        self.inner.flush(session_id).await
    }

    async fn inspect(&self, session_id: &str) -> Result<Option<SessionInspection>, StoreError> {
        if self.failing.load(Ordering::Acquire) {
            return Err(StoreError::Backend {
                message: "injected inspect failure".to_owned(),
            });
        }
        self.inner.inspect(session_id).await
    }
}

type Script = Vec<Result<ProviderEvent, ProviderError>>;

struct ScriptProvider {
    scripts: StdMutex<VecDeque<Script>>,
}

#[async_trait]
impl ModelProvider for ScriptProvider {
    async fn stream(
        &self,
        _request: ProviderRequest,
        _cancellation: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let script = self.scripts.lock().unwrap().pop_front().unwrap_or_else(|| {
            vec![Ok(ProviderEvent::Completed {
                finish_reason: Some(FinishReason::Stop),
                usage: None,
                provider_items: Vec::new(),
            })]
        });
        Ok(Box::pin(stream::iter(script)))
    }
}

struct Factory(Arc<dyn ModelProvider>);

#[async_trait]
impl TurnRequestFactory for Factory {
    async fn build(
        &self,
        _agent_id: &str,
        input: Vec<AgentMessage>,
    ) -> Result<LoopRequest, String> {
        Ok(LoopRequest::new(Arc::clone(&self.0), input))
    }
}

fn stop_script() -> Script {
    vec![
        Ok(ProviderEvent::TextDelta("ok".to_owned())),
        Ok(ProviderEvent::Completed {
            finish_reason: Some(FinishReason::Stop),
            usage: None,
            provider_items: Vec::new(),
        }),
    ]
}

/// Reproduction: one transient store error permanently bricks an agent.
///
/// Every `Err` out of the worker loop makes the worker task `return`, while
/// `AgentSupervisor::activate` keeps handing back the cached handle with no
/// liveness check, and nothing ever evicts it. Once the store recovers the
/// session stays dead: every later command answers `Closed` until the process
/// is restarted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_transient_store_error_permanently_bricks_the_agent() {
    let inner: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    inner.create(SessionHeader::new("bricked")).await.unwrap();
    let failing = Arc::new(AtomicBool::new(false));
    let store: Arc<dyn Store> = Arc::new(ToggleFailStore {
        inner: Arc::clone(&inner),
        failing: Arc::clone(&failing),
    });

    let registry = Arc::new(AgentRegistry::new(
        Arc::clone(&store),
        Arc::new(MemoryLeaseManager::default()),
    ));
    let provider: Arc<dyn ModelProvider> = Arc::new(ScriptProvider {
        scripts: StdMutex::new(VecDeque::from([stop_script()])),
    });
    let supervisor = AgentSupervisor::new(Arc::clone(&registry), Arc::new(Factory(provider)), 64);

    let handle = supervisor
        .activate(SessionHeader::new("bricked"))
        .await
        .unwrap();
    // Healthy baseline: the worker serves a command.
    handle.wake().await.unwrap();

    // A single transient storage fault.
    failing.store(true, Ordering::Release);
    let _ = tokio::time::timeout(Duration::from_secs(2), handle.wake()).await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    // The fault is gone; storage is healthy again.
    failing.store(false, Ordering::Release);
    tokio::time::sleep(Duration::from_millis(100)).await;

    // A fresh activate() still returns the cached, dead worker.
    let revived = supervisor
        .activate(SessionHeader::new("bricked"))
        .await
        .unwrap();
    let outcome = revived.wake().await;
    assert!(
        outcome.is_ok(),
        "the agent never recovered from a transient store error: {outcome:?}"
    );

    supervisor.shutdown(Duration::from_secs(2)).await;
}

/// Verifies the design claim behind the respawn fix: the event channels belong
/// to the *handle*, so a subscriber that attached before the worker died still
/// observes the replacement worker's turns.
///
/// This is what lets every long-lived holder of an old handle — the Host goal
/// watcher, `goals.prepared`, and the Schedule owner's prepared deliveries —
/// recover without being re-created.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_subscriber_attached_before_the_death_observes_the_respawned_worker() {
    let inner: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    inner.create(SessionHeader::new("resub")).await.unwrap();
    let failing = Arc::new(AtomicBool::new(false));
    let store: Arc<dyn Store> = Arc::new(ToggleFailStore {
        inner: Arc::clone(&inner),
        failing: Arc::clone(&failing),
    });
    let registry = Arc::new(AgentRegistry::new(
        Arc::clone(&store),
        Arc::new(MemoryLeaseManager::default()),
    ));
    let provider: Arc<dyn ModelProvider> = Arc::new(ScriptProvider {
        scripts: StdMutex::new(VecDeque::from([stop_script(), stop_script()])),
    });
    let supervisor = AgentSupervisor::new(Arc::clone(&registry), Arc::new(Factory(provider)), 64);
    let handle = supervisor
        .activate(SessionHeader::new("resub"))
        .await
        .unwrap();

    // Attached before anything fails, exactly like a Host observer.
    let mut early = handle.subscribe();

    // Turn 1 runs on the original worker.
    handle
        .followup(InboxMessage::user("prompt-1", "first"))
        .await
        .unwrap();
    let first = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(AgentEvent::TurnFinished { turn, .. }) = early.recv().await {
                return turn;
            }
        }
    })
    .await
    .expect("turn 1 must finish on the original worker");
    assert_eq!(first, 1);

    // One transient store error ends that worker task. Whether *this* call
    // observes the death (`Err`) or is acknowledged just before it (`Ok`) is a
    // race between the worker returning to its idle snapshot and this command,
    // so only the invariant is asserted: the worker stops.
    failing.store(true, Ordering::Release);
    let _ = handle.wake().await;
    tokio::time::timeout(Duration::from_secs(2), handle.when_stopped())
        .await
        .expect("the worker must stop after the transient store error");
    assert!(handle.is_stopped());

    // Storage recovers; the next durable input must run on the replacement.
    failing.store(false, Ordering::Release);
    wait_out_respawn_backoff().await;
    handle
        .followup(InboxMessage::user("prompt-2", "second"))
        .await
        .unwrap();
    let second = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(AgentEvent::TurnFinished { turn, .. }) = early.recv().await {
                return turn;
            }
        }
    })
    .await
    .expect("the pre-death subscriber must observe the respawned worker's turn");
    assert_eq!(second, 2);
    assert!(!handle.is_stopped());

    supervisor.shutdown(Duration::from_secs(2)).await;
}

/// A factory that panics while building its first request, simulating any panic
/// inside the worker's drive path after the lifecycle reservation was taken.
struct PanicOnceFactory {
    panicked: Arc<AtomicBool>,
    provider: Arc<dyn ModelProvider>,
}

#[async_trait]
impl TurnRequestFactory for PanicOnceFactory {
    async fn build(
        &self,
        _agent_id: &str,
        input: Vec<AgentMessage>,
    ) -> Result<LoopRequest, String> {
        if !self.panicked.swap(true, Ordering::AcqRel) {
            panic!("injected panic while building the first turn");
        }
        Ok(LoopRequest::new(Arc::clone(&self.provider), input))
    }
}

/// Verifies that a worker which died *mid-drive* can still be replaced.
///
/// A panic (or abort) after `reserve_driver()` skips `finish_driver()`, so the
/// durable lifecycle phase stays `Running`; the replacement worker's
/// `drive_pending()` then fails `reserve_driver()` with `AlreadyActive`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_worker_that_died_mid_drive_can_still_be_replaced() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    store.create(SessionHeader::new("panicked")).await.unwrap();
    let registry = Arc::new(AgentRegistry::new(
        Arc::clone(&store),
        Arc::new(MemoryLeaseManager::default()),
    ));
    let provider: Arc<dyn ModelProvider> = Arc::new(ScriptProvider {
        scripts: StdMutex::new(VecDeque::from([stop_script()])),
    });
    let factory: Arc<dyn TurnRequestFactory> = Arc::new(PanicOnceFactory {
        panicked: Arc::new(AtomicBool::new(false)),
        provider,
    });
    let supervisor = AgentSupervisor::new(Arc::clone(&registry), factory, 64);
    let handle = supervisor
        .activate(SessionHeader::new("panicked"))
        .await
        .unwrap();
    let mut events = handle.subscribe();

    // The first turn panic-dies the worker after it reserved the driver.
    let _ = handle
        .followup(InboxMessage::user("prompt-1", "first"))
        .await;
    tokio::time::timeout(Duration::from_secs(2), handle.when_stopped())
        .await
        .expect("the worker must die on the injected panic");
    assert!(handle.is_stopped());

    // Past the respawn backoff, a second input must still run.
    wait_out_respawn_backoff().await;
    handle
        .followup(InboxMessage::user("prompt-2", "second"))
        .await
        .unwrap();
    let finished = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match events.recv().await {
                Ok(AgentEvent::TurnFinished { turn, .. }) => return turn,
                Ok(_) => {}
                Err(error) => panic!("event stream ended: {error}"),
            }
        }
    })
    .await;

    supervisor.shutdown(Duration::from_secs(2)).await;
    assert!(
        finished.is_ok(),
        "no turn finished: a worker that died mid-drive blocks its own replacement"
    );
}

//! Regression tests for worker lifecycle recovery.
//!
//! Stable identity/subscriptions, recoverable errors, supervised panic recovery,
//! bounded backoff, cancellation, and reservation cleanup.

use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
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
    reads: Arc<AtomicUsize>,
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
        self.reads.fetch_add(1, Ordering::AcqRel);
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

/// A recoverable storage error must not require worker replacement.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_transient_store_error_does_not_kill_the_worker() {
    let inner: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    inner.create(SessionHeader::new("bricked")).await.unwrap();
    let failing = Arc::new(AtomicBool::new(false));
    let store: Arc<dyn Store> = Arc::new(ToggleFailStore {
        inner: Arc::clone(&inner),
        failing: Arc::clone(&failing),
        reads: Arc::new(AtomicUsize::new(0)),
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

    assert_eq!(handle.availability(), crate::WorkerAvailability::Ready);
    // Re-activation preserves the stable handle.
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

/// Existing subscribers survive a failed operation on the live worker.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn subscriptions_survive_a_recoverable_storage_error() {
    let inner: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    inner.create(SessionHeader::new("resub")).await.unwrap();
    let failing = Arc::new(AtomicBool::new(false));
    let store: Arc<dyn Store> = Arc::new(ToggleFailStore {
        inner: Arc::clone(&inner),
        failing: Arc::clone(&failing),
        reads: Arc::new(AtomicUsize::new(0)),
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

    // Recoverable command/store errors stay in the same live worker.
    failing.store(true, Ordering::Release);
    let _ = handle.wake().await;
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if matches!(early.recv().await, Ok(AgentEvent::Error { .. })) {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert!(!handle.is_stopped());
    assert_eq!(handle.availability(), crate::WorkerAvailability::Ready);
    failing.store(false, Ordering::Release);
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
    .expect("the original subscriber must observe the next turn");
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

// A waiter attached to the public handle must settle after death without a new command.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn when_idle_does_not_hang_after_worker_panic() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    store
        .create(SessionHeader::new("review-idle"))
        .await
        .unwrap();
    let registry = Arc::new(AgentRegistry::new(
        store,
        Arc::new(MemoryLeaseManager::default()),
    ));
    let factory: Arc<dyn TurnRequestFactory> = Arc::new(PanicOnceFactory {
        panicked: Arc::new(AtomicBool::new(false)),
        provider: Arc::new(ScriptProvider {
            scripts: StdMutex::new(VecDeque::new()),
        }),
    });
    let supervisor = AgentSupervisor::new(registry, factory, 64);
    let handle = supervisor
        .activate(SessionHeader::new("review-idle"))
        .await
        .unwrap();
    let _ = handle.followup(InboxMessage::user("first", "first")).await;
    tokio::time::timeout(Duration::from_secs(2), handle.when_stopped())
        .await
        .unwrap();
    let settled = tokio::time::timeout(Duration::from_millis(200), handle.when_idle()).await;
    assert_eq!(settled.unwrap(), Err(crate::AgentCommandError::Unavailable));
    assert_eq!(
        handle.wake().await,
        Err(crate::AgentCommandError::Unavailable)
    );
    // No followup/wake is sent: supervision alone must recover readiness.
    tokio::time::timeout(Duration::from_secs(2), handle.when_ready())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(handle.when_idle().await, Ok(()));

    supervisor.shutdown(Duration::from_secs(1)).await;
}

async fn panic_fixture(id: &str) -> (AgentSupervisor, crate::DurableAgentHandle) {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let registry = Arc::new(AgentRegistry::new(
        store,
        Arc::new(MemoryLeaseManager::default()),
    ));
    let supervisor = AgentSupervisor::new(
        registry,
        Arc::new(PanicOnceFactory {
            panicked: Arc::new(AtomicBool::new(false)),
            provider: Arc::new(ScriptProvider {
                scripts: StdMutex::new(VecDeque::new()),
            }),
        }),
        256,
    );
    let handle = supervisor.activate(SessionHeader::new(id)).await.unwrap();
    (supervisor, handle)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recovery_without_commands_does_not_replay_pending_work() {
    let (supervisor, handle) = panic_fixture("no-replay").await;
    let mut events = handle.subscribe();
    handle
        .followup(InboxMessage::user("first", "first"))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), handle.when_stopped())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), handle.when_ready())
        .await
        .unwrap()
        .unwrap();
    assert!(handle.inbox().snapshot().await.unwrap().has_pending());
    while let Ok(event) = events.try_recv() {
        assert!(!matches!(
            event,
            AgentEvent::TurnStarted { .. } | AgentEvent::TurnFinished { .. }
        ));
    }
    // Only an explicit wake may retry the pending, not-yet-claimed input.
    handle.wake().await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !matches!(
            events.recv().await.unwrap(),
            AgentEvent::TurnFinished { .. }
        ) {}
    })
    .await
    .unwrap();
    assert!(!handle.inbox().snapshot().await.unwrap().has_pending());
    supervisor.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_recovery_waiters_share_one_generation() {
    let (supervisor, handle) = panic_fixture("concurrent-recovery").await;
    handle
        .followup(InboxMessage::user("first", "first"))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), handle.when_stopped())
        .await
        .unwrap();
    let mut events = handle.subscribe();
    let mut callers = tokio::task::JoinSet::new();
    for i in 0..16 {
        let handle = handle.clone();
        callers.spawn(async move {
            handle.when_ready().await.unwrap();
            handle
                .followup(InboxMessage::user(format!("input-{i}"), "next"))
                .await
                .unwrap();
        });
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(result) = callers.join_next().await {
            result.unwrap();
        }
        let mut turns = std::collections::HashSet::new();
        while turns.len() < 17 {
            if let AgentEvent::TurnFinished { turn, .. } = events.recv().await.unwrap() {
                assert!(turns.insert(turn), "a turn was replayed");
            }
        }
    })
    .await
    .unwrap();
    assert!(!handle.inbox().snapshot().await.unwrap().has_pending());
    supervisor.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_during_backoff_never_respawns_and_wakes_waiters() {
    let (supervisor, handle) = panic_fixture("stop-backoff").await;
    handle
        .followup(InboxMessage::user("first", "first"))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), handle.when_stopped())
        .await
        .unwrap();
    let waiter = {
        let handle = handle.clone();
        tokio::spawn(async move { handle.when_ready().await })
    };
    let report = supervisor.shutdown(Duration::from_secs(1)).await;
    assert!(report.is_graceful());
    assert_eq!(waiter.await.unwrap(), Err(crate::AgentCommandError::Closed));
    wait_out_respawn_backoff().await;
    assert_eq!(handle.availability(), crate::WorkerAvailability::Closed);
    assert_eq!(handle.wake().await, Err(crate::AgentCommandError::Closed));
    assert_eq!(
        handle.when_idle().await,
        Err(crate::AgentCommandError::Closed)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn persistent_startup_fault_has_backoff_and_recovers_without_a_command() {
    let failing = Arc::new(AtomicBool::new(false));
    let reads = Arc::new(AtomicUsize::new(0));
    let store: Arc<dyn Store> = Arc::new(ToggleFailStore {
        inner: Arc::new(MemorySessionStore::default()),
        failing: failing.clone(),
        reads: reads.clone(),
    });
    let registry = AgentRegistry::new(store, Arc::new(MemoryLeaseManager::default()));
    let activation = registry
        .activate(SessionHeader::new("startup-fault"))
        .await
        .unwrap();
    failing.store(true, Ordering::Release);
    reads.store(0, Ordering::Release);
    let handle = crate::DurableAgentHandle::start(
        activation,
        Arc::new(Factory(Arc::new(ScriptProvider {
            scripts: StdMutex::new(VecDeque::new()),
        }))),
        64,
    );
    tokio::time::sleep(Duration::from_millis(900)).await;
    let attempts = reads.load(Ordering::Acquire);
    assert!(
        (1..=3).contains(&attempts),
        "startup busy loop: {attempts} reads"
    );
    failing.store(false, Ordering::Release);
    tokio::time::timeout(Duration::from_secs(3), handle.when_ready())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(handle.when_idle().await, Ok(()));
    handle.shutdown(Duration::from_secs(1)).await;
}

struct StuckFactory {
    entered: Arc<tokio::sync::Notify>,
    dropped: Arc<AtomicBool>,
}
struct BuildDrop(Arc<AtomicBool>);
impl Drop for BuildDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
#[async_trait]
impl TurnRequestFactory for StuckFactory {
    async fn build(&self, _: &str, _: Vec<AgentMessage>) -> Result<LoopRequest, String> {
        let _guard = BuildDrop(self.dropped.clone());
        self.entered.notify_one();
        std::future::pending().await
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forced_shutdown_reaps_worker_and_releases_reservation() {
    let registry = AgentRegistry::new(
        Arc::new(MemorySessionStore::default()),
        Arc::new(MemoryLeaseManager::default()),
    );
    let activation = registry
        .activate(SessionHeader::new("forced"))
        .await
        .unwrap();
    let entered = Arc::new(tokio::sync::Notify::new());
    let dropped = Arc::new(AtomicBool::new(false));
    let handle = crate::DurableAgentHandle::start(
        activation.clone(),
        Arc::new(StuckFactory {
            entered: entered.clone(),
            dropped: dropped.clone(),
        }),
        64,
    );
    handle
        .followup(InboxMessage::user("first", "first"))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    assert_eq!(
        handle.shutdown(Duration::from_millis(10)).await,
        crate::AgentShutdownOutcome::ForcedCleanup
    );
    assert!(dropped.load(Ordering::Acquire));
    assert_eq!(activation.status().await, crate::AgentStatus::Idle);
    assert_eq!(handle.availability(), crate::WorkerAvailability::Closed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_last_handle_releases_activation_and_supervisor() {
    let registry = AgentRegistry::new(
        Arc::new(MemorySessionStore::default()),
        Arc::new(MemoryLeaseManager::default()),
    );
    let activation = registry
        .activate(SessionHeader::new("drop-handle"))
        .await
        .unwrap();
    let weak = Arc::downgrade(&activation);
    let handle = crate::DurableAgentHandle::start(
        activation,
        Arc::new(Factory(Arc::new(ScriptProvider {
            scripts: StdMutex::new(VecDeque::new()),
        }))),
        64,
    );
    handle.when_ready().await.unwrap();
    drop(handle);
    tokio::time::timeout(Duration::from_secs(2), async {
        while weak.upgrade().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("supervisor retained the activation after all handles were dropped");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopped_waiter_detects_replacement_even_if_it_missed_backoff() {
    let (supervisor, handle) = panic_fixture("generation-fence").await;
    handle.when_ready().await.unwrap();
    let stopped = handle.when_stopped();
    tokio::pin!(stopped);
    assert!(futures::poll!(&mut stopped).is_pending());
    handle
        .followup(InboxMessage::user("first", "first"))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), handle.when_stopped())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), handle.when_ready())
        .await
        .unwrap()
        .unwrap();
    // Deliberately do not poll the original waiter during Unavailable.
    tokio::time::timeout(Duration::from_millis(100), &mut stopped)
        .await
        .unwrap();
    supervisor.shutdown(Duration::from_secs(1)).await;
}

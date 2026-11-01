//! Exercise the real timer loop without wall-clock timing tolerances.

use super::*;

struct FlushFaultStore {
    inner: Arc<dyn Store>,
    failing: AtomicBool,
    attempts: AtomicUsize,
}

#[async_trait]
impl Store for FlushFaultStore {
    async fn list_headers(&self) -> Result<Vec<SessionHeader>, StoreError> {
        self.inner.list_headers().await
    }

    async fn create(&self, header: SessionHeader) -> Result<Session, StoreError> {
        self.inner.create(header).await
    }

    async fn load(&self, id: &str) -> Result<Option<Session>, StoreError> {
        self.inner.load(id).await
    }

    async fn append(
        &self,
        id: &str,
        revision: xharness_session::Revision,
        events: Vec<SessionEvent>,
    ) -> Result<xharness_session::AppendReceipt, StoreError> {
        self.inner.append(id, revision, events).await
    }

    async fn flush(&self, id: &str) -> Result<xharness_session::Revision, StoreError> {
        self.attempts.fetch_add(1, Ordering::Relaxed);
        // A regression to immediate retry must fail an assertion, not starve
        // the test task indefinitely on otherwise immediately-ready awaits.
        tokio::task::yield_now().await;
        if self.failing.load(Ordering::Acquire) {
            return Err(StoreError::Backend {
                message: "injected persistent flush failure".into(),
            });
        }
        self.inner.flush(id).await
    }

    async fn inspect(
        &self,
        id: &str,
    ) -> Result<Option<xharness_session::SessionInspection>, StoreError> {
        self.inner.inspect(id).await
    }
}

struct Fixture {
    clock: Arc<FixedClock>,
    store: Arc<FlushFaultStore>,
    manager: Arc<ScheduleManager>,
    handle: DurableAgentHandle,
}

// Keep a runnable task while draining in-memory work: paused Tokio time must
// move only through advance(), not auto-advance to the next timer deadline.
async fn drain() {
    let now = tokio::time::Instant::now();
    for _ in 0..128 {
        tokio::task::yield_now().await;
    }
    assert_eq!(tokio::time::Instant::now(), now);
}

impl Fixture {
    async fn new() -> Self {
        let inner: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let session = inner
            .create(SessionHeader::new("flush-backoff"))
            .await
            .unwrap();
        inner
            .append(
                "flush-backoff",
                session.revision(),
                vec![SessionEvent::new(EventData::ScheduleChange {
                    change: ScheduleChange::Create {
                        version: 1,
                        schedule: ScheduleRecord {
                            automation: None,
                            id: "schedule-1".into(),
                            kind: ScheduleKind::After,
                            prompt: "once after recovery".into(),
                            after_seconds: Some(1),
                            every_seconds: None,
                            scheduled_at: "1970-01-01T00:00:01.000Z".into(),
                        },
                    },
                })],
            )
            .await
            .unwrap();
        inner.flush("flush-backoff").await.unwrap();

        // Only the schedule owner sees the fault. A dead Agent would exercise
        // the separate when_ready() gate and falsely look like flush backoff.
        let registry =
            AgentRegistry::new(Arc::clone(&inner), Arc::new(MemoryLeaseManager::default()));
        let activation = registry
            .activate(SessionHeader::new("flush-backoff"))
            .await
            .unwrap();
        let provider: Arc<dyn ModelProvider> = Arc::new(ScriptProvider {
            scripts: StdMutex::new(VecDeque::from([vec![Ok(ProviderEvent::Completed {
                finish_reason: Some(FinishReason::Stop),
                usage: None,
                provider_items: Vec::new(),
            })]])),
        });
        let handle = DurableAgentHandle::start(activation, Arc::new(Factory(provider)), 64);
        handle.when_ready().await.unwrap();
        let store = Arc::new(FlushFaultStore {
            inner,
            failing: AtomicBool::new(true),
            attempts: AtomicUsize::new(0),
        });
        let clock = FixedClock::new(0);
        let manager = ScheduleManager::with_clock(store.clone(), clock.clone());
        manager.attach(handle.clone()).await.unwrap();
        drain().await;
        // attach() can leave one initial notification in addition to the first
        // drive. Neither is a timer retry, so establish the baseline after it.
        assert!((1..=2).contains(&store.attempts.load(Ordering::Relaxed)));
        assert_eq!(
            handle.availability(),
            xharness_agent::WorkerAvailability::Ready
        );
        Self {
            clock,
            store,
            manager,
            handle,
        }
    }

    async fn advance(&self, millis: i64) {
        self.clock.set(self.clock.now_ms() + millis);
        tokio::time::advance(Duration::from_millis(millis as u64)).await;
        drain().await;
    }

    fn attempts(&self) -> usize {
        self.store.attempts.load(Ordering::Relaxed)
    }

    async fn close(&self) {
        self.manager.shutdown().await.unwrap();
        self.handle.shutdown(Duration::from_secs(1)).await;
    }
}

#[tokio::test(start_paused = true)]
async fn persistent_flush_failure_backs_off_then_recovers_once() {
    let fixture = Fixture::new().await;
    let mut deliveries = fixture.manager.subscribe_deliveries();
    let baseline = fixture.attempts();
    for retry in 1..=3 {
        fixture.advance(999).await;
        assert_eq!(
            fixture.attempts(),
            baseline + retry - 1,
            "retried before the deadline"
        );
        fixture.advance(1).await;
        assert_eq!(
            fixture.attempts(),
            baseline + retry,
            "retry stopped or spun"
        );
        assert!(matches!(
            deliveries.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    fixture.store.failing.store(false, Ordering::Release);
    fixture.advance(999).await;
    assert_eq!(fixture.attempts(), baseline + 3);
    fixture.advance(1).await;
    let notice = deliveries
        .try_recv()
        .expect("healthy storage must resume delivery");
    assert_eq!(notice.session_id, "flush-backoff");
    fixture.advance(5_000).await;
    assert!(matches!(
        deliveries.try_recv(),
        Err(broadcast::error::TryRecvError::Empty)
    ));
    let session = fixture
        .store
        .inner
        .load("flush-backoff")
        .await
        .unwrap()
        .unwrap();
    let dispatches = session
        .events()
        .iter()
        .filter(|event| {
            matches!(
                event.data(),
                EventData::ScheduleChange { change: ScheduleChange::Dispatch { id, .. } }
                    if id == "schedule-1"
            )
        })
        .count();
    assert_eq!(dispatches, 1, "recovery duplicated the durable dispatch");
    fixture.close().await;
}

#[tokio::test(start_paused = true)]
async fn shutdown_interrupts_flush_retry_wait() {
    let fixture = Fixture::new().await;
    let attempts = fixture.attempts();
    let before = tokio::time::Instant::now();
    fixture.manager.shutdown().await.unwrap();
    assert_eq!(
        tokio::time::Instant::now(),
        before,
        "shutdown waited for the retry deadline"
    );
    fixture.advance(5_000).await;
    assert_eq!(
        fixture.attempts(),
        attempts,
        "flush continued after shutdown"
    );
    fixture.handle.shutdown(Duration::from_secs(1)).await;
}

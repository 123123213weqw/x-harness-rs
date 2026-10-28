//! Diagnostic wrapper: preserve MemoryStore semantics and measure storage work.
use super::*;
use std::sync::atomic::AtomicU64;
use xharness_session::{AppendReceipt, Revision, SessionEvent, SessionInspection, StoreError};

#[derive(Default)]
pub(super) struct TimingStore {
    inner: MemorySessionStore,
    append_ns: AtomicU64,
    append_count: AtomicU64,
    load_ns: AtomicU64,
    flush_ns: AtomicU64,
}

impl TimingStore {
    pub(super) fn report(&self) -> String {
        format!(
            "append_ms={} appends={} load_ms={} flush_ms={}",
            self.append_ns.load(AtomicOrdering::Relaxed) / 1_000_000,
            self.append_count.load(AtomicOrdering::Relaxed),
            self.load_ns.load(AtomicOrdering::Relaxed) / 1_000_000,
            self.flush_ns.load(AtomicOrdering::Relaxed) / 1_000_000,
        )
    }
}

#[async_trait]
impl Store for TimingStore {
    async fn list_headers(&self) -> Result<Vec<SessionHeader>, StoreError> {
        self.inner.list_headers().await
    }
    async fn create(&self, header: SessionHeader) -> Result<Session, StoreError> {
        self.inner.create(header).await
    }
    async fn load(&self, id: &str) -> Result<Option<Session>, StoreError> {
        let start = std::time::Instant::now();
        let result = self.inner.load(id).await;
        self.load_ns
            .fetch_add(start.elapsed().as_nanos() as u64, AtomicOrdering::Relaxed);
        result
    }
    async fn append(
        &self,
        id: &str,
        revision: Revision,
        events: Vec<SessionEvent>,
    ) -> Result<AppendReceipt, StoreError> {
        let start = std::time::Instant::now();
        let result = self.inner.append(id, revision, events).await;
        self.append_ns
            .fetch_add(start.elapsed().as_nanos() as u64, AtomicOrdering::Relaxed);
        self.append_count.fetch_add(1, AtomicOrdering::Relaxed);
        result
    }
    async fn flush(&self, id: &str) -> Result<Revision, StoreError> {
        let start = std::time::Instant::now();
        let result = self.inner.flush(id).await;
        self.flush_ns
            .fetch_add(start.elapsed().as_nanos() as u64, AtomicOrdering::Relaxed);
        result
    }
    async fn inspect(&self, id: &str) -> Result<Option<SessionInspection>, StoreError> {
        self.inner.inspect(id).await
    }
}

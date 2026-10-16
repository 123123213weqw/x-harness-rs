use super::*;
use async_trait::async_trait;
use std::sync::atomic::AtomicUsize;
use xharness_session::{
    AppendReceipt, MemorySessionStore, Revision, SessionHeader, SessionInspection,
};
fn request(key: char, control: SavedAutomationControl) -> SavedAutomationInvocation {
    SavedAutomationInvocation {
        invocation: format!("remote-automation-{}", key.to_string().repeat(64)),
        fingerprint: automation::digest(&serde_json::to_string(&control).unwrap()),
        control,
    }
}
async fn create(m: &ScheduleManager, session: &str) -> String {
    m.execute(
        session,
        "create",
        serde_json::from_value(
            json!({"action":"create","prompt":"owned saved user task","after_seconds":3600}),
        )
        .unwrap(),
    )
    .await["id"]
        .as_str()
        .unwrap()
        .into()
}
async fn setup() -> (Arc<MemorySessionStore>, Arc<ScheduleManager>, String) {
    let store = Arc::new(MemorySessionStore::default());
    store.create(SessionHeader::new("s")).await.unwrap();
    let m = ScheduleManager::new(store.clone());
    let id = create(&m, "s").await;
    (store, m, id)
}
#[tokio::test]
async fn original_pause_receipt_never_repauses_after_a_later_resume_and_reopen() {
    let (store, m, id) = setup().await;
    let pause = request('a', SavedAutomationControl::Pause { id: id.clone() });
    let original = m.saved_control_once("s", pause.clone()).await.unwrap();
    let first = store.load("s").await.unwrap().unwrap();
    assert_eq!(first.events().len(), 3);
    assert_eq!(first.events()[1].revision, first.events()[2].revision);
    m.saved_control_once(
        "s",
        request('b', SavedAutomationControl::Resume { id: id.clone() }),
    )
    .await
    .unwrap();
    let before = store.load("s").await.unwrap().unwrap();
    assert!(
        !active_schedules(&before).unwrap()[0]
            .automation
            .as_ref()
            .unwrap()
            .paused
    );
    assert_eq!(
        m.saved_control_once("s", pause.clone()).await.unwrap(),
        original
    );
    assert_eq!(
        store.load("s").await.unwrap().unwrap().events(),
        before.events()
    );
    m.shutdown().await.unwrap();
    let fresh = ScheduleManager::new(store.clone());
    assert_eq!(
        fresh.saved_control_receipt("s", &pause).await.unwrap(),
        Some(original.clone())
    );
    assert_eq!(
        fresh.saved_control_once("s", pause).await.unwrap(),
        original
    );
    assert_eq!(
        store.load("s").await.unwrap().unwrap().events(),
        before.events()
    );
    fresh.shutdown().await.unwrap();
}
#[tokio::test]
async fn exact_key_conflicts_foreign_targets_and_closed_control_input_never_append() {
    let (store, m, id) = setup().await;
    let pause = request('a', SavedAutomationControl::Pause { id: id.clone() });
    m.saved_control_once("s", pause.clone()).await.unwrap();
    let before = store.load("s").await.unwrap().unwrap();
    let mut bad = pause.clone();
    bad.control = SavedAutomationControl::Resume { id: id.clone() };
    assert_eq!(
        m.saved_control_once("s", bad).await.unwrap_err(),
        SavedAutomationError::Conflict
    );
    let mut bad = pause.clone();
    bad.fingerprint = "b".repeat(64);
    assert_eq!(
        m.saved_control_receipt("s", &bad).await.unwrap_err(),
        SavedAutomationError::Conflict
    );
    store.create(SessionHeader::new("other")).await.unwrap();
    assert_eq!(
        m.saved_control_once("other", pause).await.unwrap_err(),
        SavedAutomationError::NotActive
    );
    for invocation in [
        "remote-automation-🧪".into(),
        "random".into(),
        format!("remote-automation-{}", "A".repeat(64)),
    ] {
        let mut bad = request('c', SavedAutomationControl::Delete { id: id.clone() });
        bad.invocation = invocation;
        assert_eq!(
            m.saved_control_once("s", bad).await.unwrap_err(),
            SavedAutomationError::Invalid
        );
    }
    assert!(serde_json::from_value::<SavedAutomationControl>(
        json!({"action":"pause","id":id,"prompt":"no"})
    )
    .is_err());
    assert_eq!(
        store.load("s").await.unwrap().unwrap().events(),
        before.events()
    );
    m.shutdown().await.unwrap();
}
#[tokio::test]
async fn twenty_concurrent_same_identity_controls_write_one_state_receipt_batch() {
    let (store, m, id) = setup().await;
    let r = request('a', SavedAutomationControl::Delete { id });
    let mut jobs = Vec::new();
    for _ in 0..20 {
        let m = m.clone();
        let r = r.clone();
        jobs.push(tokio::spawn(
            async move { m.saved_control_once("s", r).await },
        ));
    }
    for j in jobs {
        assert_eq!(
            j.await.unwrap().unwrap().state,
            SavedAutomationState::Deleted
        );
    }
    let session = store.load("s").await.unwrap().unwrap();
    assert_eq!(session.events().len(), 3);
    assert!(active_schedules(&session).unwrap().is_empty());
    assert!(m.saved_control_receipt("s", &r).await.unwrap().is_some());
    m.shutdown().await.unwrap();
}
#[derive(Default)]
struct FaultStore {
    inner: MemorySessionStore,
    fail_receipt_flush: AtomicBool,
    regress_receipt_flush: AtomicBool,
    block_receipt_append: AtomicBool,
    appends: AtomicUsize,
    entered: Notify,
    release: Notify,
}
#[async_trait]
impl Store for FaultStore {
    async fn create(&self, h: SessionHeader) -> Result<Session, StoreError> {
        self.inner.create(h).await
    }
    async fn load(&self, s: &str) -> Result<Option<Session>, StoreError> {
        self.inner.load(s).await
    }
    async fn list_headers(&self) -> Result<Vec<SessionHeader>, StoreError> {
        self.inner.list_headers().await
    }
    async fn append(
        &self,
        s: &str,
        r: Revision,
        e: Vec<SessionEvent>,
    ) -> Result<AppendReceipt, StoreError> {
        let receipt = e
            .iter()
            .any(|e| matches!(e.data(), EventData::SessionMutationCommitted { .. }));
        let result = self.inner.append(s, r, e).await?;
        self.appends.fetch_add(1, Ordering::SeqCst);
        if receipt && self.block_receipt_append.load(Ordering::SeqCst) {
            self.entered.notify_one();
            self.release.notified().await;
        }
        Ok(result)
    }
    async fn flush(&self, s: &str) -> Result<Revision, StoreError> {
        let receipt = self.inner.load(s).await?.is_some_and(|s| {
            s.events()
                .iter()
                .any(|e| matches!(e.data(), EventData::SessionMutationCommitted { .. }))
        });
        if receipt && self.fail_receipt_flush.load(Ordering::SeqCst) {
            return Err(StoreError::Backend {
                message: "PRIVATE_STORE_ERROR".into(),
            });
        }
        if receipt && self.regress_receipt_flush.load(Ordering::SeqCst) {
            return Ok(Revision::ZERO);
        }
        self.inner.flush(s).await
    }
    async fn inspect(&self, s: &str) -> Result<Option<SessionInspection>, StoreError> {
        self.inner.inspect(s).await
    }
}
async fn fault_setup() -> (Arc<FaultStore>, Arc<ScheduleManager>, String) {
    let store = Arc::new(FaultStore::default());
    store.create(SessionHeader::new("s")).await.unwrap();
    let m = ScheduleManager::new(store.clone());
    let id = create(&m, "s").await;
    (store, m, id)
}
#[tokio::test]
async fn logically_visible_receipt_is_not_certified_after_failed_or_regressed_flush() {
    for regress in [false, true] {
        let (store, m, id) = fault_setup().await;
        store.fail_receipt_flush.store(!regress, Ordering::SeqCst);
        store.regress_receipt_flush.store(regress, Ordering::SeqCst);
        let r = request('a', SavedAutomationControl::Pause { id });
        assert_eq!(
            m.saved_control_once("s", r.clone()).await.unwrap_err(),
            SavedAutomationError::Unavailable
        );
        assert_eq!(
            m.saved_control_receipt("s", &r).await.unwrap_err(),
            SavedAutomationError::Unavailable
        );
        let before = store.inner.load("s").await.unwrap().unwrap();
        assert_eq!(before.events().len(), 3);
        store.fail_receipt_flush.store(false, Ordering::SeqCst);
        store.regress_receipt_flush.store(false, Ordering::SeqCst);
        assert!(m.saved_control_receipt("s", &r).await.unwrap().is_some());
        m.saved_control_once("s", r).await.unwrap();
        assert_eq!(
            store.inner.load("s").await.unwrap().unwrap().events(),
            before.events()
        );
        assert_eq!(store.appends.load(Ordering::SeqCst), 2);
        m.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn caller_abort_retains_owned_writer_and_shutdown_drains_actual_append() {
    let (store, m, id) = fault_setup().await;
    store.block_receipt_append.store(true, Ordering::SeqCst);
    let r = request('a', SavedAutomationControl::Pause { id });
    let m2 = m.clone();
    let r2 = r.clone();
    let caller = tokio::spawn(async move { m2.saved_control_once("s", r2).await });
    store.entered.notified().await;
    caller.abort();
    let _ = caller.await;
    let m2 = m.clone();
    let close = tokio::spawn(async move { m2.shutdown().await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!close.is_finished());
    store.release.notify_one();
    close.await.unwrap().unwrap();
    let fresh = ScheduleManager::new(store.clone());
    assert!(fresh
        .saved_control_receipt("s", &r)
        .await
        .unwrap()
        .is_some());
    assert_eq!(store.appends.load(Ordering::SeqCst), 2);
    fresh.shutdown().await.unwrap();
}
#[tokio::test]
async fn shared_thirty_two_slot_capacity_is_explicit_and_closed_manager_never_writes() {
    let (store, m, id) = setup().await;
    let slot = m
        .saved_control_slots
        .clone()
        .acquire_many_owned(32)
        .await
        .unwrap();
    let r = request('a', SavedAutomationControl::Pause { id });
    assert_eq!(
        m.saved_control_once("s", r.clone()).await.unwrap_err(),
        SavedAutomationError::Capacity
    );
    assert_eq!(store.load("s").await.unwrap().unwrap().events().len(), 1);
    drop(slot);
    m.saved_control_once("s", r.clone()).await.unwrap();
    m.shutdown().await.unwrap();
    assert_eq!(
        m.saved_control_once("s", r).await.unwrap_err(),
        SavedAutomationError::Unavailable
    );
}

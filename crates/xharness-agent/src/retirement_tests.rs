#![forbid(unsafe_code)]

use crate::{
    AgentRegistry, AgentShutdownOutcome, AgentSupervisor, InboxMessage, LeaseManager,
    MemoryLeaseManager, TurnRequestFactory,
};
use async_trait::async_trait;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::sync::Notify;
use xharness_core::{AgentMessage, LoopRequest};
use xharness_session::{MemorySessionStore, SessionHeader, Store};

struct IdleFactory;
#[async_trait]
impl TurnRequestFactory for IdleFactory {
    async fn build(&self, _: &str, _: Vec<AgentMessage>) -> Result<LoopRequest, String> {
        Err("no turn was requested".into())
    }
}

#[tokio::test]
async fn retirement_releases_the_lease_and_fences_only_its_session() {
    let leases = Arc::new(MemoryLeaseManager::default());
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let registry = Arc::new(AgentRegistry::new(store.clone(), leases.clone()));
    let supervisor = AgentSupervisor::new(registry.clone(), Arc::new(IdleFactory), 16);
    let deleted = supervisor
        .activate(SessionHeader::new("deleted"))
        .await
        .unwrap();
    let other = supervisor
        .activate(SessionHeader::new("other"))
        .await
        .unwrap();
    deleted.when_ready().await.unwrap();
    let activation = Arc::downgrade(&registry.get("deleted").await.unwrap());
    drop(deleted);
    assert_eq!(
        supervisor
            .retire("deleted", Duration::from_secs(1))
            .await
            .unwrap(),
        AgentShutdownOutcome::Graceful
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        while activation.upgrade().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(leases.acquire("deleted").await.is_ok());
    assert!(supervisor.get("deleted").await.is_none());
    assert!(supervisor
        .activate(SessionHeader::new("deleted"))
        .await
        .is_err());
    assert!(
        store.load("deleted").await.unwrap().is_some(),
        "retirement must not delete durable data"
    );
    other.when_ready().await.unwrap();
    assert_eq!(
        supervisor.retire("deleted", Duration::ZERO).await.unwrap(),
        AgentShutdownOutcome::Graceful
    );
    assert!(supervisor
        .shutdown(Duration::from_secs(1))
        .await
        .is_graceful());
}

struct BuildGuard(Arc<AtomicBool>);
impl Drop for BuildGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
struct ParkedFactory {
    entered: Arc<Notify>,
    dropped: Arc<AtomicBool>,
}
#[async_trait]
impl TurnRequestFactory for ParkedFactory {
    async fn build(&self, _: &str, _: Vec<AgentMessage>) -> Result<LoopRequest, String> {
        let _guard = BuildGuard(self.dropped.clone());
        self.entered.notify_one();
        std::future::pending().await
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_a_retirement_waiter_does_not_detach_or_reactivate_the_worker() {
    let entered = Arc::new(Notify::new());
    let dropped = Arc::new(AtomicBool::new(false));
    let registry = Arc::new(AgentRegistry::new(
        Arc::new(MemorySessionStore::default()),
        Arc::new(MemoryLeaseManager::default()),
    ));
    let supervisor = Arc::new(AgentSupervisor::new(
        registry,
        Arc::new(ParkedFactory {
            entered: entered.clone(),
            dropped: dropped.clone(),
        }),
        16,
    ));
    let handle = supervisor
        .activate(SessionHeader::new("parked"))
        .await
        .unwrap();
    let mut message = AgentMessage::user("park");
    message.id = Some("input".into());
    handle
        .followup(InboxMessage {
            id: "input".into(),
            message,
            source: None,
        })
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    let retiring = supervisor.clone();
    let waiter =
        tokio::spawn(async move { retiring.retire("parked", Duration::from_secs(1)).await });
    while supervisor.get("parked").await.is_some() {
        tokio::task::yield_now().await;
    }
    waiter.abort();
    let _ = waiter.await;
    assert!(supervisor
        .activate(SessionHeader::new("parked"))
        .await
        .is_err());
    let other = tokio::time::timeout(
        Duration::from_secs(2),
        supervisor.activate(SessionHeader::new("other")),
    )
    .await
    .unwrap()
    .unwrap();
    other.when_ready().await.unwrap();
    let (first, second) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(
            supervisor.retire("parked", Duration::ZERO),
            supervisor.retire("parked", Duration::ZERO)
        )
    })
    .await
    .unwrap();
    assert_eq!(first.unwrap(), AgentShutdownOutcome::ForcedCleanup);
    assert_eq!(second.unwrap(), AgentShutdownOutcome::ForcedCleanup);
    assert!(dropped.load(Ordering::Acquire));
    handle.closed().await;
    assert!(supervisor
        .shutdown(Duration::from_secs(2))
        .await
        .is_graceful());
}

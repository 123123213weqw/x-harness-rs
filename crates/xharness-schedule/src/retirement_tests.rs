#![forbid(unsafe_code)]
use super::*;
use async_trait::async_trait;
use xharness_agent::{AgentRegistry, AgentSupervisor, MemoryLeaseManager, TurnRequestFactory};
use xharness_core::{AgentMessage, LoopRequest};
use xharness_session::{MemorySessionStore, SessionHeader};

struct IdleFactory;
#[async_trait]
impl TurnRequestFactory for IdleFactory {
    async fn build(&self, _: &str, _: Vec<AgentMessage>) -> Result<LoopRequest, String> {
        Err("no turns requested".into())
    }
}

#[tokio::test]
async fn retiring_one_timer_reaps_its_owner_and_preserves_other_owners() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let supervisor = AgentSupervisor::new(
        Arc::new(AgentRegistry::new(
            store.clone(),
            Arc::new(MemoryLeaseManager::default()),
        )),
        Arc::new(IdleFactory),
        16,
    );
    let manager = ScheduleManager::new(store.clone());
    let deleted = supervisor
        .activate(SessionHeader::new("deleted"))
        .await
        .unwrap();
    let other = supervisor
        .activate(SessionHeader::new("other"))
        .await
        .unwrap();
    manager.attach(deleted.clone()).await.unwrap();
    manager.attach(other.clone()).await.unwrap();
    let owner = Arc::downgrade(&manager.owner("deleted").await.unwrap());
    manager.deliveries.lock().await.insert(
        ("deleted".into(), "work".into()),
        PreparedScheduleDelivery {
            handle: deleted.clone(),
            events: deleted.subscribe(),
            input_id: "work".into(),
        },
    );
    manager.retire_session("deleted").await.unwrap();
    assert!(owner.upgrade().is_none());
    assert!(manager.take_delivery("deleted", "work").await.is_none());
    assert!(manager.attach(deleted).await.is_err());
    assert!(manager.owner("deleted").await.is_err());
    manager.attach(other).await.unwrap();
    assert!(store.load("deleted").await.unwrap().is_some());
    manager.retire_session("deleted").await.unwrap();
    manager.shutdown().await.unwrap();
    supervisor.shutdown(Duration::from_secs(1)).await;
}

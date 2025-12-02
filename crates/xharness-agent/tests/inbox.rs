use std::sync::Arc;

use xharness_agent::{
    AgentLifecycle, AgentPhase, AgentRegistry, AgentStatus, DurableInbox, FileLeaseManager,
    InboxProjection, LeaseManager, MemoryLeaseManager,
};
use xharness_session::{
    EventData, InboxMessage, InboxTarget, MemorySessionStore, Message, Revision, SessionEvent,
    SessionHeader, Store, TurnEndReason,
};

#[tokio::test]
async fn inbox_replays_next_turn_and_next_step_in_order() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let inbox = DurableInbox::open(Arc::clone(&store), SessionHeader::new("ordered"))
        .await
        .unwrap();
    inbox
        .append(InboxTarget::NextTurn, InboxMessage::user("turn-a", "A"))
        .await
        .unwrap();
    inbox
        .append(InboxTarget::NextStep, InboxMessage::user("step-a", "S"))
        .await
        .unwrap();
    inbox
        .prepend(InboxTarget::NextTurn, InboxMessage::user("turn-b", "B"))
        .await
        .unwrap();

    let snapshot = inbox.snapshot().await.unwrap();
    assert_eq!(
        snapshot
            .next_turn()
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        ["turn-b", "turn-a"]
    );
    assert_eq!(snapshot.next_step()[0].id, "step-a");

    let restored = store.load("ordered").await.unwrap().unwrap();
    assert_eq!(InboxProjection::from_session(&restored).unwrap(), snapshot);
}

#[tokio::test]
async fn queue_editing_is_durable_and_duplicate_ids_are_rejected() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let inbox = DurableInbox::open(Arc::clone(&store), SessionHeader::new("editing"))
        .await
        .unwrap();
    inbox
        .append(InboxTarget::NextTurn, InboxMessage::user("one", "old"))
        .await
        .unwrap();
    let duplicate = inbox
        .append(
            InboxTarget::NextStep,
            InboxMessage::user("one", "duplicate"),
        )
        .await
        .unwrap_err();
    assert!(duplicate.to_string().contains("already pending"));

    assert!(inbox
        .replace("one", InboxMessage::user("two", "new"))
        .await
        .unwrap()
        .is_some());
    assert!(inbox.remove("missing").await.unwrap().is_none());
    assert!(inbox.remove("two").await.unwrap().is_some());
    assert!(!inbox.snapshot().await.unwrap().has_pending());
}

#[tokio::test]
async fn claim_is_committed_atomically_with_its_turn() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let inbox = DurableInbox::open(Arc::clone(&store), SessionHeader::new("claim"))
        .await
        .unwrap();
    inbox
        .append(InboxTarget::NextTurn, InboxMessage::user("turn", "prompt"))
        .await
        .unwrap();
    inbox
        .append(InboxTarget::NextStep, InboxMessage::user("step", "context"))
        .await
        .unwrap();

    let claim = inbox.prepare_claim(InboxTarget::NextTurn).await.unwrap();
    assert_eq!(
        claim
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        ["step", "turn"]
    );
    let prefix = vec![SessionEvent::new(EventData::TurnStart { turn: 1 })];
    let suffix = claim
        .messages
        .iter()
        .map(|message| {
            SessionEvent::new(EventData::UserMessage {
                message: message.message.clone(),
                surface_replace: None,
            })
        })
        .chain([SessionEvent::new(EventData::TurnEnd {
            turn: 1,
            reason: TurnEndReason::Completed,
        })])
        .collect();
    let receipt = inbox.commit_claim(claim, prefix, suffix).await.unwrap();
    assert_eq!(receipt.messages.len(), 2);
    assert!(!inbox.snapshot().await.unwrap().has_pending());

    let session = store.load("claim").await.unwrap().unwrap();
    assert_eq!(
        session
            .derive_messages()
            .iter()
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>(),
        ["context", "prompt"]
    );
}

#[tokio::test]
async fn stale_claim_cannot_remove_newer_queue_state() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let first = DurableInbox::open(Arc::clone(&store), SessionHeader::new("stale"))
        .await
        .unwrap();
    let second = DurableInbox::open(Arc::clone(&store), SessionHeader::new("stale"))
        .await
        .unwrap();
    first
        .append(InboxTarget::NextTurn, InboxMessage::user("one", "1"))
        .await
        .unwrap();
    let claim = first.prepare_claim(InboxTarget::NextTurn).await.unwrap();
    second
        .append(InboxTarget::NextTurn, InboxMessage::user("two", "2"))
        .await
        .unwrap();
    let error = first
        .commit_claim(claim, Vec::new(), Vec::new())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("revision conflict"));
    assert_eq!(first.snapshot().await.unwrap().next_turn().len(), 2);
}

#[tokio::test]
async fn recovery_reconciles_a_consumed_steer_left_pending_by_a_crash() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let inbox = DurableInbox::open(Arc::clone(&store), SessionHeader::new("reconcile"))
        .await
        .unwrap();
    let steering = InboxMessage::user("steer-id", "change direction");
    inbox
        .append(InboxTarget::NextStep, steering.clone())
        .await
        .unwrap();
    let session = store.load("reconcile").await.unwrap().unwrap();
    store
        .append(
            "reconcile",
            session.revision(),
            vec![
                EventData::TurnStart { turn: 1 }.into(),
                EventData::UserMessage {
                    message: steering.message,
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

    assert_eq!(inbox.snapshot().await.unwrap().next_step().len(), 1);
    assert!(inbox.reconcile_consumed().await.unwrap().is_some());
    assert!(!inbox.snapshot().await.unwrap().has_pending());
    assert!(inbox.reconcile_consumed().await.unwrap().is_none());
}

#[test]
fn lifecycle_matches_idle_running_and_maintenance_contract() {
    let mut lifecycle = AgentLifecycle::new(3);
    assert_eq!(lifecycle.status(), AgentStatus::Idle);
    lifecycle.reserve_driver().unwrap();
    assert_eq!(lifecycle.open_turn().unwrap(), 4);
    assert_eq!(lifecycle.open_step().unwrap(), (4, 1));
    assert_eq!(lifecycle.phase(), AgentPhase::Running { turn: 4, step: 1 });
    lifecycle.finish_driver().unwrap();
    lifecycle.reserve_maintenance().unwrap();
    assert_eq!(lifecycle.status(), AgentStatus::Idle);
    lifecycle.finish_maintenance().unwrap();
}

#[test]
fn inbox_events_are_not_provider_messages() {
    let mut session = xharness_session::Session::new(SessionHeader::new("projection")).unwrap();
    session
        .append(
            Revision::ZERO,
            EventData::AgentInboxSpliced {
                target: InboxTarget::NextTurn,
                start: 0,
                removed_count: 0,
                inserted: vec![InboxMessage {
                    id: "pending".to_owned(),
                    message: Message::user("not claimed").with_id("pending"),
                    source: None,
                }],
                outcome: None,
            },
        )
        .unwrap();
    assert!(session.derive_messages().is_empty());
}

#[tokio::test]
async fn registry_returns_one_live_activation_and_resumes_last_turn() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let leases: Arc<dyn LeaseManager> = Arc::new(MemoryLeaseManager::default());
    let registry = AgentRegistry::new(Arc::clone(&store), leases);
    let first = registry
        .activate(SessionHeader::new("activation"))
        .await
        .unwrap();
    let second = registry
        .activate(SessionHeader::new("activation"))
        .await
        .unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    first.reserve_driver().await.unwrap();
    assert_eq!(first.open_turn().await.unwrap(), 1);
    first.finish_driver().await.unwrap();
    assert_eq!(first.status().await, AgentStatus::Idle);
}

#[tokio::test]
async fn file_lease_excludes_other_managers_until_guard_drops() {
    let root = std::env::temp_dir().join(format!(
        "xharness-agent-lease-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let first = FileLeaseManager::new(&root).unwrap();
    let second = FileLeaseManager::new(&root).unwrap();
    let guard = first.acquire("owned").await.unwrap();
    assert!(second.acquire("owned").await.is_err());
    drop(guard);
    second.acquire("owned").await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

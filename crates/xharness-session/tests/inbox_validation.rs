//! Full append/restore retain the original inbox contract and atomic rollback.
use xharness_session::{
    EventData, InboxMessage, InboxTarget, LoggedEvent, Revision, Session, SessionError,
    SessionHeader,
};

fn splice(target: InboxTarget, start: usize, removed_count: usize, ids: &[&str]) -> EventData {
    EventData::AgentInboxSpliced {
        target,
        start,
        removed_count,
        inserted: ids
            .iter()
            .map(|id| InboxMessage::user(*id, "synthetic payload"))
            .collect(),
        outcome: None,
    }
}

#[test]
fn append_and_restore_reject_cross_queue_duplicates_without_publishing_partial_state() {
    let mut session = Session::new(SessionHeader::new("inbox-validation")).unwrap();
    session
        .append(
            Revision::ZERO,
            splice(InboxTarget::NextTurn, 0, 0, &["a", "b"]),
        )
        .unwrap();
    let before = session.clone();
    let invalid = splice(InboxTarget::NextStep, 0, 0, &["a"]);
    let error = session
        .append_batch(
            session.revision(),
            vec![
                EventData::AgentDispatchPaused { paused: true }.into(),
                invalid.clone().into(),
            ],
        )
        .unwrap_err();
    assert!(
        matches!(error, SessionError::DuplicateInboxMessage { ref message_id, .. } if message_id=="a")
    );
    assert_eq!(
        session, before,
        "all batch facts, revision and cursor must roll back"
    );
    let revision = Revision(session.revision().0 + 1);
    let mut events = session.events().to_vec();
    events.push(LoggedEvent {
        seq: session.next_seq(),
        revision,
        timestamp_ms: 1,
        event: invalid.into(),
    });
    assert!(
        matches!(Session::restore(session.header().clone(), revision, events),
        Err(SessionError::DuplicateInboxMessage { message_id, .. }) if message_id=="a")
    );
}

#[test]
fn atomic_remove_reinsert_and_same_identity_replacement_keep_complete_history() {
    let mut session = Session::new(SessionHeader::new("inbox-move")).unwrap();
    session
        .append(
            Revision::ZERO,
            splice(InboxTarget::NextTurn, 0, 0, &["a", "b"]),
        )
        .unwrap();
    let before = session.clone();
    session
        .append_batch(
            session.revision(),
            vec![
                splice(InboxTarget::NextTurn, 0, 1, &[]).into(),
                splice(InboxTarget::NextStep, 0, 0, &["a"]).into(),
                splice(InboxTarget::NextTurn, 0, 1, &["b"]).into(),
            ],
        )
        .unwrap();
    assert_eq!(&session.events()[..before.events().len()], before.events());
    assert_eq!(session.events().len(), before.events().len() + 3);
    assert_eq!(
        Session::restore(
            session.header().clone(),
            session.revision(),
            session.events().to_vec()
        )
        .unwrap(),
        session
    );
}

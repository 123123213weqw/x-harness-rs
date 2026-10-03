use serde_json::json;
use xharness_session::{
    EventData, InboxMessage, InboxTarget, Message, Session, SessionHeader, TurnEndReason,
};

fn append(session: &mut Session, data: EventData) {
    session.append(session.revision(), data).unwrap();
}

fn failed(session: &mut Session, turn: u32) {
    append(session, EventData::TurnStart { turn });
    append(
        session,
        EventData::TurnEnd {
            turn,
            reason: TurnEndReason::Failed {
                error: "any typed failure, not a magic error string".into(),
                provider_failure: None,
            },
        },
    );
}

#[test]
fn legacy_failure_closes_gate_and_runtime_receipts_cannot_reopen_it() {
    let mut session = Session::new(SessionHeader::new("gate")).unwrap();
    append(
        &mut session,
        EventData::AgentDispatchPaused { paused: false },
    );
    failed(&mut session, 1);
    assert!(session.dispatch_paused());
    let mut receipt = InboxMessage::user("child:settlement:1", "user-shaped runtime context");
    receipt.source = Some(json!({"kind":"agent-settlement"}));
    append(
        &mut session,
        EventData::AgentInboxSpliced {
            target: InboxTarget::NextTurn,
            start: 0,
            removed_count: 0,
            inserted: vec![receipt],
            outcome: None,
        },
    );
    assert!(session.dispatch_paused());
    append(
        &mut session,
        EventData::AgentDispatchPaused { paused: false },
    );
    assert!(!session.dispatch_paused());
    failed(&mut session, 2);
    assert!(
        session.dispatch_paused(),
        "a later failure closes an earlier resume"
    );
}

#[test]
fn normal_completion_does_not_clear_an_explicit_pause_and_a_fork_is_independent() {
    let mut session = Session::new(SessionHeader::new("gate")).unwrap();
    append(
        &mut session,
        EventData::AgentDispatchPaused { paused: true },
    );
    append(&mut session, EventData::TurnStart { turn: 1 });
    append(
        &mut session,
        EventData::TurnEnd {
            turn: 1,
            reason: TurnEndReason::Completed,
        },
    );
    assert!(session.dispatch_paused());
    append(
        &mut session,
        EventData::SessionForkOrigin {
            parent_session_id: "parent".into(),
            before_user_seq: None,
        },
    );
    assert!(!session.dispatch_paused());
}

#[test]
fn provenance_not_model_role_controls_user_admission() {
    let mut input = InboxMessage::user("input", "Agent settlement text is not provenance");
    assert!(input.is_user_authored());
    input.source = Some(json!({"kind":"user"}));
    assert!(input.is_user_authored());
    input.source = Some(json!({"content":[],"source":{"kind":"user"}}));
    assert!(
        input.is_user_authored(),
        "Host metadata keeps human provenance"
    );
    for source in [
        json!({"kind":"agent-settlement"}),
        json!({"kind":"agent-message"}),
        json!({"kind":"goal"}),
        json!({"content":[],"source":{"kind":"agent-settlement"}}),
        json!({}),
        json!(null),
    ] {
        input.source = Some(source);
        assert!(!input.is_user_authored());
        assert_eq!(input.message.role, Message::user("").role);
    }
}

#[test]
fn typed_retryable_provider_failure_preserves_goal_backoff_but_not_explicit_stop() {
    let mut session = Session::new(SessionHeader::new("retryable")).unwrap();
    failed(&mut session, 1);
    append(&mut session, EventData::TurnStart { turn: 2 });
    append(
        &mut session,
        EventData::TurnEnd {
            turn: 2,
            reason: TurnEndReason::Failed {
                error: "exhausted transient requests".into(),
                provider_failure: Some(xharness_session::ProviderFailure {
                    retryable: true,
                    http_status: Some(503),
                    retry_after_ms: Some(5000),
                }),
            },
        },
    );
    assert!(
        !session.dispatch_paused(),
        "Goal recovery still owns classified retries"
    );
    append(
        &mut session,
        EventData::AgentDispatchPaused { paused: true },
    );
    append(&mut session, EventData::TurnStart { turn: 3 });
    append(
        &mut session,
        EventData::TurnEnd {
            turn: 3,
            reason: TurnEndReason::Failed {
                error: "late retryable error after user stop".into(),
                provider_failure: Some(xharness_session::ProviderFailure {
                    retryable: true,
                    http_status: Some(503),
                    retry_after_ms: Some(5000),
                }),
            },
        },
    );
    assert!(session.dispatch_paused());
}

#[test]
fn recovered_legacy_turn_is_not_blocked_by_a_historical_failure() {
    let mut session = Session::new(SessionHeader::new("legacy-recovered")).unwrap();
    failed(&mut session, 1);
    append(&mut session, EventData::TurnStart { turn: 2 });
    append(
        &mut session,
        EventData::TurnEnd {
            turn: 2,
            reason: TurnEndReason::Completed,
        },
    );
    assert!(!session.dispatch_paused());
    failed(&mut session, 3);
    assert!(session.dispatch_paused());
}

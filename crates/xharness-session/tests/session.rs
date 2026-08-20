use std::sync::Arc;

use serde_json::json;
use xharness_session::{
    derive_messages, incomplete_tool_calls, AssistantChunk, EventData, LoggedEvent,
    MemorySessionStore, Message, MessageRole, RequestHeader, Revision, Session, SessionError,
    SessionEvent, SessionHeader, Store, StoreError, ToolCall, ToolOutcome, ToolResultData,
    TurnEndReason, OUTCOME_UNKNOWN_CONTENT,
};

fn header(id: &str) -> SessionHeader {
    SessionHeader {
        version: SessionHeader::FORMAT_VERSION,
        id: id.to_owned(),
        created_at_ms: 123,
        cwd: Some("/workspace".to_owned()),
    }
}

fn event(data: EventData) -> SessionEvent {
    data.into()
}

fn call(id: &str, index: usize) -> ToolCall {
    ToolCall {
        id: id.to_owned(),
        index,
        name: "read_file".to_owned(),
        arguments_json: r#"{"path":"README.md"}"#.to_owned(),
    }
}

#[test]
fn message_constructors_and_role_spellings_are_stable() {
    assert_eq!(MessageRole::System.as_str(), "system");
    assert_eq!(MessageRole::User.as_str(), "user");
    assert_eq!(MessageRole::Assistant.as_str(), "assistant");
    assert_eq!(MessageRole::Tool.as_str(), "tool");

    assert_eq!(
        Message::system("policy"),
        Message::new(MessageRole::System, "policy")
    );
    assert_eq!(
        Message::user("hello"),
        Message::new(MessageRole::User, "hello")
    );
    assert_eq!(
        Message::assistant("world"),
        Message::new(MessageRole::Assistant, "world")
    );
}

#[test]
fn append_is_contiguous_and_one_revision_per_atomic_batch() {
    let mut session = Session::new(header("s1")).unwrap();
    let receipt = session
        .append_batch_at(
            Revision::ZERO,
            vec![
                event(EventData::TurnStart { turn: 1 }),
                event(EventData::StepStart { turn: 1, step: 1 }),
            ],
            500,
        )
        .unwrap();

    assert_eq!(receipt.previous_revision, Revision::ZERO);
    assert_eq!(receipt.revision, Revision(1));
    assert_eq!(receipt.first_seq, 0);
    assert_eq!(receipt.last_seq, Some(1));
    assert_eq!(receipt.events[0].seq, 0);
    assert_eq!(receipt.events[1].seq, 1);
    assert_eq!(receipt.events[0].revision, Revision(1));
    assert_eq!(receipt.events[1].revision, Revision(1));
    assert_eq!(receipt.events[0].timestamp_ms, 500);
    assert_eq!(session.next_seq(), 2);
    assert_eq!(session.revision(), Revision(1));

    let empty = session
        .append_batch_at(Revision(1), Vec::new(), 600)
        .unwrap();
    assert_eq!(empty.revision, Revision(1));
    assert_eq!(empty.first_seq, 2);
    assert_eq!(empty.last_seq, None);
    assert_eq!(session.events(), receipt.events);
}

#[test]
fn stale_revision_rejects_without_partial_mutation() {
    let mut session = Session::new(header("s1")).unwrap();
    session
        .append_at_for_test(Revision::ZERO, event(EventData::TurnStart { turn: 1 }), 10)
        .unwrap();
    let before = session.clone();

    let error = session
        .append_batch_at(
            Revision::ZERO,
            vec![event(EventData::TurnEnd {
                turn: 1,
                reason: TurnEndReason::Completed,
            })],
            11,
        )
        .unwrap_err();
    assert_eq!(
        error,
        SessionError::RevisionConflict {
            expected: Revision::ZERO,
            actual: Revision(1),
        }
    );
    assert_eq!(session, before);
}

#[test]
fn restore_rejects_sequence_gaps_and_bad_revisions() {
    let first = LoggedEvent {
        seq: 0,
        revision: Revision(1),
        timestamp_ms: 1,
        event: event(EventData::TurnStart { turn: 1 }),
    };
    let mut gap = first.clone();
    gap.seq = 2;
    assert!(matches!(
        Session::restore(header("s1"), Revision(1), vec![gap]),
        Err(SessionError::SequenceMismatch {
            expected: 0,
            actual: 2
        })
    ));

    let mut skipped_revision = first;
    skipped_revision.revision = Revision(2);
    assert!(matches!(
        Session::restore(header("s1"), Revision(2), vec![skipped_revision]),
        Err(SessionError::LoggedRevisionMismatch { .. })
    ));
}

#[test]
fn every_first_version_event_round_trips_through_serde() {
    let events = vec![
        event(EventData::RequestHeader {
            header: RequestHeader::new("openai", "gpt-test"),
        }),
        event(EventData::TurnStart { turn: 1 }),
        event(EventData::StepStart { turn: 1, step: 1 }),
        event(EventData::UserMessage {
            message: Message::user("hello"),
        }),
        event(EventData::AssistantChunk {
            turn: 1,
            step: 1,
            chunk: AssistantChunk::TextDelta("hi".to_owned()),
        }),
        event(EventData::AssistantMessage {
            turn: 1,
            step: 1,
            message: Message::assistant("hi"),
            usage: Some(json!({"input_tokens": 2, "output_tokens": 1})),
        }),
        event(EventData::ToolCall {
            turn: 1,
            step: 1,
            call: call("call-1", 0),
        }),
        event(EventData::ToolResult {
            turn: 1,
            step: 1,
            result: ToolResultData::success("call-1", "ok"),
        }),
        event(EventData::StepEnd { turn: 1, step: 1 }),
        event(EventData::TurnEnd {
            turn: 1,
            reason: TurnEndReason::Completed,
        }),
        event(EventData::SessionEndSeed),
    ];

    for candidate in events {
        let json = serde_json::to_string(&candidate).unwrap();
        let decoded: SessionEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, candidate);
    }
}

#[test]
fn derive_messages_is_a_pure_surface_projection() {
    let mut assistant = Message::assistant("I will read it");
    assistant.reasoning = "need the file".to_owned();
    assistant.tool_calls = vec![call("call-1", 0)];
    let mut session = Session::new(header("s1")).unwrap();
    session
        .append_batch_at(
            Revision::ZERO,
            vec![
                event(EventData::TurnStart { turn: 1 }),
                event(EventData::UserMessage {
                    message: Message::user("read README"),
                }),
                event(EventData::StepStart { turn: 1, step: 1 }),
                event(EventData::RequestHeader {
                    header: RequestHeader::new("openai", "gpt-test"),
                }),
                event(EventData::AssistantChunk {
                    turn: 1,
                    step: 1,
                    chunk: AssistantChunk::TextDelta("I will".to_owned()),
                }),
                event(EventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message: assistant.clone(),
                    usage: None,
                }),
                event(EventData::ToolCall {
                    turn: 1,
                    step: 1,
                    call: call("call-1", 0),
                }),
                event(EventData::ToolResult {
                    turn: 1,
                    step: 1,
                    result: ToolResultData::success("call-1", "contents"),
                }),
                event(EventData::StepEnd { turn: 1, step: 1 }),
            ],
            100,
        )
        .unwrap();

    let expected = vec![
        Message::user("read README"),
        assistant,
        Message::tool("call-1", "contents"),
    ];
    assert_eq!(session.derive_messages(), expected);
    assert_eq!(derive_messages(session.events()), expected);
    assert_eq!(session.derive_messages(), expected);
}

#[test]
fn message_roles_and_tool_pairing_are_validated_atomically() {
    let mut session = Session::new(header("s1")).unwrap();
    let invalid_role = event(EventData::UserMessage {
        message: Message::assistant("not a user"),
    });
    assert!(matches!(
        session.append(Revision::ZERO, invalid_role),
        Err(SessionError::InvalidMessageRole { .. })
    ));
    assert!(session.events().is_empty());

    let orphan = event(EventData::ToolResult {
        turn: 1,
        step: 1,
        result: ToolResultData::error("missing", "failed"),
    });
    assert!(matches!(
        session.append(Revision::ZERO, orphan),
        Err(SessionError::UnknownToolCall { .. })
    ));
    assert!(session.events().is_empty());
}

#[test]
fn incomplete_calls_produce_pure_outcome_unknown_recovery_candidates() {
    let mut session = Session::new(header("s1")).unwrap();
    let mut assistant = Message::assistant("using tools");
    assistant.tool_calls = vec![call("done", 0), call("unknown", 1)];
    session
        .append_batch_at(
            Revision::ZERO,
            vec![
                event(EventData::TurnStart { turn: 1 }),
                event(EventData::StepStart { turn: 1, step: 1 }),
                event(EventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message: assistant,
                    usage: None,
                }),
                event(EventData::ToolCall {
                    turn: 1,
                    step: 1,
                    call: call("done", 0),
                }),
                event(EventData::ToolCall {
                    turn: 1,
                    step: 1,
                    call: call("unknown", 1),
                }),
                event(EventData::ToolResult {
                    turn: 1,
                    step: 1,
                    result: ToolResultData::success("done", "ok"),
                }),
            ],
            100,
        )
        .unwrap();
    let before = session.clone();

    let incomplete = incomplete_tool_calls(session.events());
    assert_eq!(incomplete.len(), 1);
    assert_eq!(incomplete[0].call.id, "unknown");
    let recovery = session.outcome_unknown_recovery();
    assert_eq!(session, before, "recovery inspection must be pure");
    assert_eq!(recovery.len(), 1);
    match recovery[0].data() {
        EventData::ToolResult { result, .. } => {
            assert_eq!(result.call_id, "unknown");
            assert_eq!(result.outcome, ToolOutcome::OutcomeUnknown);
            assert_eq!(result.content, OUTCOME_UNKNOWN_CONTENT);
        }
        other => panic!("unexpected recovery event: {other:?}"),
    }

    session.append(Revision(1), recovery[0].clone()).unwrap();
    assert!(session.outcome_unknown_recovery().is_empty());
    let messages = session.derive_messages();
    assert_eq!(messages.last().unwrap().role, MessageRole::Tool);
    assert_eq!(
        messages.last().unwrap().tool_call_id.as_deref(),
        Some("unknown")
    );
}

#[tokio::test]
async fn memory_store_create_load_flush_and_inspect_are_detached() {
    let store = MemorySessionStore::default();
    let created = store.create(header("s1")).await.unwrap();
    assert_eq!(created.revision(), Revision::ZERO);
    assert!(matches!(
        store.create(header("s1")).await,
        Err(StoreError::AlreadyExists { .. })
    ));

    let receipt = store
        .append(
            "s1",
            Revision::ZERO,
            vec![
                event(EventData::TurnStart { turn: 1 }),
                event(EventData::UserMessage {
                    message: Message::user("hello"),
                }),
            ],
        )
        .await
        .unwrap();
    assert_eq!(receipt.revision, Revision(1));
    assert_eq!(store.flush("s1").await.unwrap(), Revision(1));

    let mut detached = store.load("s1").await.unwrap().unwrap();
    detached
        .append(
            Revision(1),
            event(EventData::StepStart { turn: 1, step: 1 }),
        )
        .unwrap();
    let authoritative = store.load("s1").await.unwrap().unwrap();
    assert_eq!(authoritative.revision(), Revision(1));
    assert_eq!(authoritative.events().len(), 2);

    let inspection = store.inspect("s1").await.unwrap().unwrap();
    assert_eq!(inspection.revision, Revision(1));
    assert_eq!(inspection.next_seq, 2);
    assert_eq!(inspection.events.as_slice(), authoritative.events());
}

#[tokio::test]
async fn memory_store_cas_allows_only_one_writer_for_a_revision() {
    let store = Arc::new(MemorySessionStore::default());
    store.create(header("s1")).await.unwrap();

    let first = {
        let store = Arc::clone(&store);
        tokio::spawn(async move {
            store
                .append(
                    "s1",
                    Revision::ZERO,
                    vec![
                        event(EventData::TurnStart { turn: 1 }),
                        event(EventData::UserMessage {
                            message: Message::user("first"),
                        }),
                    ],
                )
                .await
        })
    };
    let second = {
        let store = Arc::clone(&store);
        tokio::spawn(async move {
            store
                .append(
                    "s1",
                    Revision::ZERO,
                    vec![
                        event(EventData::TurnStart { turn: 1 }),
                        event(EventData::UserMessage {
                            message: Message::user("second"),
                        }),
                    ],
                )
                .await
        })
    };

    let outcomes = [first.await.unwrap(), second.await.unwrap()];
    assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        outcomes
            .iter()
            .filter(|result| matches!(result, Err(StoreError::RevisionConflict { .. })))
            .count(),
        1
    );
    let stored = store.load("s1").await.unwrap().unwrap();
    assert_eq!(stored.revision(), Revision(1));
    assert_eq!(stored.events().len(), 2);
}

trait AppendAtForTest {
    fn append_at_for_test(
        &mut self,
        expected_revision: Revision,
        event: SessionEvent,
        timestamp_ms: u64,
    ) -> Result<LoggedEvent, SessionError>;
}

impl AppendAtForTest for Session {
    fn append_at_for_test(
        &mut self,
        expected_revision: Revision,
        event: SessionEvent,
        timestamp_ms: u64,
    ) -> Result<LoggedEvent, SessionError> {
        Ok(self
            .append_batch_at(expected_revision, vec![event], timestamp_ms)?
            .events
            .into_iter()
            .next()
            .unwrap())
    }
}

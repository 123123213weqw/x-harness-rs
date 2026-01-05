use std::sync::Arc;

use serde_json::json;
use xharness_interaction::{
    AnswerDestination, AskUserQuestionRequest, QuestionAnswer, QuestionInvocation, QuestionOption,
    QuestionSpec, QuestionTerminalState, ResolveAction, ASK_USER_QUESTION_TOOL,
};
use xharness_session::{
    derive_messages, incomplete_tool_calls, ApprovalOutcome, ApprovalPolicy, AssistantChunk,
    CommandResultKind, CommandSource, EventData, GoalChange, GoalChangeKind, GoalClearChange,
    GoalClearOperation, GoalPhase, GoalRef, GoalSnapshot, GoalSnapshotChange,
    GoalSnapshotOperation, LlmFailure, LlmRetryMode, LoggedEvent, MemorySessionStore, Message,
    MessageRole, PolicySource, RequestHeader, Revision, Session, SessionError, SessionEvent,
    SessionHeader, SessionMutationReceipt, SessionSandboxMode, SessionTitleSource, Store,
    StoreError, SurfaceReplace, ToolCall, ToolOutcome, ToolResultData, TurnEndReason,
    OUTCOME_UNKNOWN_CONTENT,
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
        provider_call_id: None,
        index,
        name: "read_file".to_owned(),
        arguments_json: r#"{"path":"README.md"}"#.to_owned(),
    }
}

fn question_request() -> AskUserQuestionRequest {
    AskUserQuestionRequest {
        questions: vec![QuestionSpec {
            id: "mode".to_owned(),
            header: "模式".to_owned(),
            question: "选择运行模式".to_owned(),
            options: vec![QuestionOption {
                id: "safe".to_owned(),
                label: "安全模式".to_owned(),
                description: None,
                recommended: true,
            }],
            allow_custom: true,
            destination: AnswerDestination::Context,
        }],
    }
}

fn question_call() -> ToolCall {
    ToolCall {
        id: "question-execution".to_owned(),
        provider_call_id: Some("provider-question".to_owned()),
        index: 0,
        name: ASK_USER_QUESTION_TOOL.to_owned(),
        arguments_json: serde_json::to_string(&question_request()).unwrap(),
    }
}

fn goal_snapshot_event(
    revision: u64,
    objective: &str,
    phase: GoalPhase,
    max_goal_rounds: u64,
    operation: GoalSnapshotOperation,
    updated_at: u64,
) -> SessionEvent {
    event(EventData::GoalChange {
        change: GoalChange::Snapshot(GoalSnapshotChange {
            kind: GoalChangeKind::GoalChange,
            version: 1,
            operation,
            goal: GoalSnapshot {
                id: "goal-1".to_owned(),
                revision,
                objective: objective.to_owned(),
                phase,
                blocked_reason: None,
                max_goal_rounds,
            },
            rounds_started: 0,
            created_at: 10,
            updated_at,
        }),
    })
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

    let legacy: ToolCall = serde_json::from_value(json!({
        "id": "legacy-call",
        "index": 0,
        "name": "read",
        "arguments_json": "{}"
    }))
    .unwrap();
    assert_eq!(legacy.provider_call_id, None);
    assert_eq!(legacy.provider_id(), "legacy-call");
}

#[test]
fn compaction_transaction_replaces_surface_without_deleting_source_history() {
    let mut session = Session::new(header("compact-session")).unwrap();
    session
        .append_batch(
            Revision::ZERO,
            vec![
                event(EventData::TurnStart { turn: 1 }),
                event(EventData::UserMessage {
                    message: Message::user("very old context"),
                    surface_replace: None,
                }),
                event(EventData::StepStart { turn: 1, step: 1 }),
                event(EventData::CompactionStart {
                    compaction_id: "compact-1".to_owned(),
                    source_command_id: None,
                    turn: Some(1),
                }),
            ],
        )
        .unwrap();
    let range = xharness_session::SequenceRange { start: 1, end: 1 };
    session
        .append_batch(
            Revision(1),
            vec![
                event(EventData::CompactionSummary {
                    compaction_id: "compact-1".to_owned(),
                    source_command_id: None,
                    summary: "## Current Work\n- continue".to_owned(),
                    shadowed_range: range,
                    shadowed_seqs: vec![1],
                    shadowed_token_count: 100,
                    provider: "openai".to_owned(),
                    model: "test".to_owned(),
                    max_tokens: Some(32),
                    usage: Some(json!({"input_tokens": 10, "output_tokens": 4})),
                }),
                event(EventData::UserMessage {
                    message: Message::user("checkpoint"),
                    surface_replace: Some(SurfaceReplace {
                        compaction_id: "compact-1".to_owned(),
                        shadowed_range: range,
                        shadowed_seqs: vec![1],
                    }),
                }),
                event(EventData::CompactionEnd {
                    compaction_id: "compact-1".to_owned(),
                    source_command_id: None,
                    turn: Some(1),
                    error: None,
                }),
            ],
        )
        .unwrap();

    assert_eq!(session.events().len(), 7, "source log stays append-only");
    assert!(session.events().iter().any(|event| {
        matches!(event.data(), EventData::UserMessage { message, surface_replace: None }
            if message.content == "very old context")
    }));
    let surface = session.derive_surface_messages();
    assert_eq!(surface.len(), 1);
    assert_eq!(surface[0].seq, 5);
    assert_eq!(surface[0].message.content, "checkpoint");
    assert_eq!(session.derive_messages(), vec![Message::user("checkpoint")]);
}

#[test]
fn interrupted_compaction_recovery_closes_without_mutating_surface() {
    let mut session = Session::new(header("compact-recovery")).unwrap();
    session
        .append_batch(
            Revision::ZERO,
            vec![
                event(EventData::TurnStart { turn: 1 }),
                event(EventData::UserMessage {
                    message: Message::user("keep me"),
                    surface_replace: None,
                }),
                event(EventData::StepStart { turn: 1, step: 1 }),
                event(EventData::CompactionStart {
                    compaction_id: "compact-crash".to_owned(),
                    source_command_id: None,
                    turn: Some(1),
                }),
            ],
        )
        .unwrap();
    let recovery = session.interrupted_compaction_recovery();
    assert_eq!(recovery.len(), 1);
    session.append_batch(Revision(1), recovery).unwrap();
    assert_eq!(session.derive_messages(), vec![Message::user("keep me")]);
    assert!(matches!(
        session.events().last().unwrap().data(),
        EventData::CompactionEnd { error: Some(_), .. }
    ));
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
fn user_question_lifecycle_is_validated_projected_and_never_unknowned() {
    let mut session = Session::new(header("question-lifecycle")).unwrap();
    let call = question_call();
    session
        .append_batch(
            Revision::ZERO,
            vec![
                event(EventData::TurnStart { turn: 1 }),
                event(EventData::UserMessage {
                    message: Message::user("需要选择"),
                    surface_replace: None,
                }),
                event(EventData::StepStart { turn: 1, step: 1 }),
                event(EventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message: {
                        let mut assistant = Message::assistant("");
                        assistant.tool_calls.push(call.clone());
                        assistant
                    },
                    usage: None,
                }),
                event(EventData::ToolCall {
                    turn: 1,
                    step: 1,
                    call: call.clone(),
                }),
                event(EventData::QuestionRequested {
                    invocation: QuestionInvocation::new(call.id.clone(), question_request()),
                }),
            ],
        )
        .unwrap();
    assert_eq!(session.pending_user_questions().len(), 1);
    assert_eq!(session.recoverable_user_questions().len(), 1);
    assert!(session.outcome_unknown_recovery().is_empty());

    let invalid_result = session.append(
        session.revision(),
        event(EventData::ToolResult {
            turn: 1,
            step: 1,
            result: ToolResultData::success(&call.id, "too early"),
        }),
    );
    assert!(matches!(
        invalid_result,
        Err(SessionError::InvalidLifecycle { .. })
    ));

    let mut interaction = xharness_interaction::QuestionInteraction::new(QuestionInvocation::new(
        call.id.clone(),
        question_request(),
    ))
    .unwrap();
    let resolution = interaction
        .resolve(
            ResolveAction::Continue,
            vec![QuestionAnswer {
                question_id: "mode".to_owned(),
                selected_option_id: Some("safe".to_owned()),
                custom_text: None,
            }],
        )
        .unwrap();
    session
        .append(
            session.revision(),
            event(EventData::QuestionResolved {
                interaction_id: "question:question-execution".to_owned(),
                resolution,
            }),
        )
        .unwrap();
    assert!(session.pending_user_questions().is_empty());
    assert!(matches!(
        session.recoverable_user_questions()[0].terminal,
        QuestionTerminalState::Resolved(_)
    ));
    assert!(session.outcome_unknown_recovery().is_empty());

    session
        .append(
            session.revision(),
            event(EventData::ToolResult {
                turn: 1,
                step: 1,
                result: ToolResultData {
                    call_id: call.id,
                    outcome: ToolOutcome::Success,
                    content: "answered".to_owned(),
                    metadata: None,
                },
            }),
        )
        .unwrap();
    assert!(session.recoverable_user_questions().is_empty());
}

#[test]
fn every_first_version_event_round_trips_through_serde() {
    let events = vec![
        event(EventData::AgentPresetSelected {
            agent_preset: "coding".to_owned(),
        }),
        event(EventData::SessionModelSelected {
            provider: "openai".to_owned(),
            model: "gpt-test".to_owned(),
            reasoning_effort: Some("high".to_owned()),
        }),
        event(EventData::RequestHeader {
            header: RequestHeader::new("openai", "gpt-test"),
        }),
        event(EventData::RequestContext {
            provider: "openai".to_owned(),
            model: "gpt-test".to_owned(),
            context_window: Some(128_000),
        }),
        event(EventData::ApprovalAsked {
            id: "approval-1".to_owned(),
            tool_name: "bash".to_owned(),
            call_id: Some("call-1".to_owned()),
            reason: Some("requires permission".to_owned()),
        }),
        event(EventData::ApprovalDecided {
            id: "approval-1".to_owned(),
            outcome: ApprovalOutcome::AllowedOnce,
        }),
        event(EventData::PermissionPreset {
            preset: "workspace-write".to_owned(),
        }),
        event(EventData::SandboxMode {
            mode: SessionSandboxMode::WorkspaceWrite,
            source: Some(PolicySource::Delegation),
        }),
        event(EventData::ApprovalPolicy {
            policy: ApprovalPolicy::Ask,
            source: None,
        }),
        event(EventData::CommandRun {
            command_id: "command-1".to_owned(),
            name: "permission".to_owned(),
            args: Some(" danger-full-access".to_owned()),
            source: CommandSource::User,
        }),
        event(EventData::CommandDone {
            command_id: "command-1".to_owned(),
            kind: CommandResultKind::Success,
            text: Some("updated".to_owned()),
            source_event_seq: None,
        }),
        event(EventData::SessionTitle {
            title: "A durable title".to_owned(),
            message_seqs: Vec::new(),
            source: SessionTitleSource::User,
        }),
        event(EventData::SessionMutationCommitted {
            receipt: SessionMutationReceipt {
                rpc_id: "rpc-1".to_owned(),
                method: "session.rename".to_owned(),
                fingerprint: "a".repeat(64),
                response: json!({"title": "A durable title"}),
                response_event_seq_field: None,
            },
        }),
        goal_snapshot_event(
            1,
            "Ship it",
            GoalPhase::Active,
            8,
            GoalSnapshotOperation::Create,
            10,
        ),
        event(EventData::PlanMode { active: true }),
        event(EventData::LlmRetry {
            retry_id: "retry-1".to_owned(),
            turn: 1,
            step: 1,
            provider: "openai".to_owned(),
            mode: LlmRetryMode::Normal,
            policy_key: "normal:2".to_owned(),
            retry: 1,
            max_retries: Some(2),
            delay_ms: 0,
            failure: LlmFailure::transport("connection reset"),
        }),
        event(EventData::LlmRetryStarted {
            retry_id: "retry-1".to_owned(),
            turn: 1,
            step: 1,
            retry: 1,
        }),
        event(EventData::TurnStart { turn: 1 }),
        event(EventData::StepStart { turn: 1, step: 1 }),
        event(EventData::UserMessage {
            message: Message::user("hello"),
            surface_replace: None,
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

    let asked = serde_json::to_value(event(EventData::ApprovalAsked {
        id: "approval-wire".to_owned(),
        tool_name: "bash".to_owned(),
        call_id: Some("call-wire".to_owned()),
        reason: None,
    }))
    .unwrap();
    assert_eq!(asked["type"], "approval/asked");
    assert_eq!(asked["data"]["toolName"], "bash");
    assert_eq!(asked["data"]["callId"], "call-wire");
    assert!(asked["data"].get("tool_name").is_none());

    let goal = serde_json::to_value(goal_snapshot_event(
        1,
        "Wire goal",
        GoalPhase::Active,
        8,
        GoalSnapshotOperation::Create,
        10,
    ))
    .unwrap();
    assert_eq!(goal["type"], "goal/change");
    assert_eq!(goal["data"]["kind"], "goal/change");
    assert_eq!(goal["data"]["operation"], "create");
    assert_eq!(goal["data"]["goal"]["maxGoalRounds"], 8);
    assert!(goal["data"].get("change").is_none());
}

#[test]
fn session_mutation_receipt_is_atomic_unique_and_secret_free() {
    let mut session = Session::new(header("mutation-receipt")).unwrap();
    let receipt = SessionMutationReceipt {
        rpc_id: "rpc-preset".to_owned(),
        method: "agentPreset.select".to_owned(),
        fingerprint: "b".repeat(64),
        response: json!({"agentPreset": "coding"}),
        response_event_seq_field: None,
    };
    let committed = session
        .append_batch_at(
            Revision::ZERO,
            vec![
                event(EventData::AgentPresetSelected {
                    agent_preset: "coding".to_owned(),
                }),
                event(EventData::SessionMutationCommitted {
                    receipt: receipt.clone(),
                }),
            ],
            500,
        )
        .unwrap();
    assert_eq!(committed.revision, Revision(1));
    assert_eq!(committed.events.len(), 2);
    assert!(session.derive_messages().is_empty());

    let duplicate = session
        .append_batch_at(
            Revision(1),
            vec![
                event(EventData::AgentPresetSelected {
                    agent_preset: "coding".to_owned(),
                }),
                event(EventData::SessionMutationCommitted { receipt }),
            ],
            501,
        )
        .unwrap_err();
    assert!(matches!(duplicate, SessionError::InvalidLifecycle { .. }));
    assert_eq!(session.revision(), Revision(1));

    let secret = session
        .append_batch_at(
            Revision(1),
            vec![
                event(EventData::AgentPresetSelected {
                    agent_preset: "coding".to_owned(),
                }),
                event(EventData::SessionMutationCommitted {
                    receipt: SessionMutationReceipt {
                        rpc_id: "rpc-secret".to_owned(),
                        method: "agentPreset.select".to_owned(),
                        fingerprint: "c".repeat(64),
                        response: json!({"apiKey": "must-not-persist"}),
                        response_event_seq_field: None,
                    },
                }),
            ],
            502,
        )
        .unwrap_err();
    assert!(matches!(secret, SessionError::InvalidLifecycle { .. }));
    assert_eq!(session.revision(), Revision(1));
}

#[test]
fn approval_audit_is_turn_enclosed_paired_and_call_correlated() {
    let mut assistant = Message::assistant("");
    assistant.tool_calls = vec![call("call-1", 0)];
    let mut session = Session::new(header("approval-lifecycle")).unwrap();
    session
        .append_batch_at(
            Revision::ZERO,
            vec![
                event(EventData::TurnStart { turn: 1 }),
                event(EventData::UserMessage {
                    message: Message::user("run"),
                    surface_replace: None,
                }),
                event(EventData::StepStart { turn: 1, step: 1 }),
                event(EventData::RequestHeader {
                    header: RequestHeader::new("openai", "gpt-test"),
                }),
                event(EventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message: assistant,
                    usage: None,
                }),
                event(EventData::ToolCall {
                    turn: 1,
                    step: 1,
                    call: call("call-1", 0),
                }),
                event(EventData::ApprovalAsked {
                    id: "approval-1".to_owned(),
                    tool_name: "read_file".to_owned(),
                    call_id: Some("call-1".to_owned()),
                    reason: None,
                }),
                event(EventData::ApprovalDecided {
                    id: "approval-1".to_owned(),
                    outcome: ApprovalOutcome::Rejected,
                }),
                event(EventData::ToolResult {
                    turn: 1,
                    step: 1,
                    result: ToolResultData::error("call-1", "rejected"),
                }),
            ],
            1,
        )
        .unwrap();

    let revision = session.revision();
    assert!(matches!(
        session.append(
            revision,
            event(EventData::ApprovalDecided {
                id: "missing".to_owned(),
                outcome: ApprovalOutcome::Rejected,
            })
        ),
        Err(SessionError::InvalidLifecycle { .. })
    ));
    assert_eq!(session.revision(), revision);
}

#[test]
fn retry_audit_requires_request_route_and_ordered_started_pairs() {
    let mut session = Session::new(header("retry-lifecycle")).unwrap();
    let scheduled = EventData::LlmRetry {
        retry_id: "retry-1".to_owned(),
        turn: 1,
        step: 1,
        provider: "openai".to_owned(),
        mode: LlmRetryMode::Normal,
        policy_key: "normal:2".to_owned(),
        retry: 1,
        max_retries: Some(2),
        delay_ms: 0,
        failure: LlmFailure::transport("connection reset"),
    };
    session
        .append_batch_at(
            Revision::ZERO,
            vec![
                event(EventData::TurnStart { turn: 1 }),
                event(EventData::UserMessage {
                    message: Message::user("run"),
                    surface_replace: None,
                }),
                event(EventData::StepStart { turn: 1, step: 1 }),
                event(EventData::RequestHeader {
                    header: RequestHeader::new("openai", "gpt-test"),
                }),
                event(scheduled),
                event(EventData::LlmRetryStarted {
                    retry_id: "retry-1".to_owned(),
                    turn: 1,
                    step: 1,
                    retry: 1,
                }),
            ],
            1,
        )
        .unwrap();

    let revision = session.revision();
    assert!(matches!(
        session.append(
            revision,
            event(EventData::LlmRetryStarted {
                retry_id: "retry-1".to_owned(),
                turn: 1,
                step: 1,
                retry: 1,
            })
        ),
        Err(SessionError::InvalidLifecycle { .. })
    ));
    assert_eq!(session.revision(), revision);
}

#[test]
fn command_lifecycle_and_permission_policy_are_durable_outside_turns() {
    let mut session = Session::new(header("command-policy")).unwrap();
    session
        .append_batch_at(
            Revision::ZERO,
            vec![
                event(EventData::CommandRun {
                    command_id: "command-1".to_owned(),
                    name: "permission".to_owned(),
                    args: Some(" danger-full-access".to_owned()),
                    source: CommandSource::User,
                }),
                event(EventData::PermissionPreset {
                    preset: "danger-full-access".to_owned(),
                }),
                event(EventData::SandboxMode {
                    mode: SessionSandboxMode::DangerFullAccess,
                    source: None,
                }),
                event(EventData::ApprovalPolicy {
                    policy: ApprovalPolicy::Never,
                    source: None,
                }),
                event(EventData::CommandDone {
                    command_id: "command-1".to_owned(),
                    kind: CommandResultKind::Success,
                    text: Some("preset danger-full-access".to_owned()),
                    source_event_seq: Some(1),
                }),
            ],
            1,
        )
        .unwrap();

    let revision = session.revision();
    assert!(matches!(
        session.append(
            revision,
            event(EventData::CommandDone {
                command_id: "command-1".to_owned(),
                kind: CommandResultKind::Success,
                text: None,
                source_event_seq: None,
            })
        ),
        Err(SessionError::InvalidLifecycle { .. })
    ));
    assert_eq!(session.revision(), revision);
}

#[test]
fn session_title_source_and_message_sequences_are_validated_atomically() {
    let mut session = Session::new(header("title-lifecycle")).unwrap();
    session
        .append(
            Revision::ZERO,
            event(EventData::SessionTitle {
                title: "User title".to_owned(),
                message_seqs: Vec::new(),
                source: SessionTitleSource::User,
            }),
        )
        .unwrap();

    let revision = session.revision();
    assert!(matches!(
        session.append(
            revision,
            event(EventData::SessionTitle {
                title: "Invalid fallback".to_owned(),
                message_seqs: Vec::new(),
                source: SessionTitleSource::Fallback,
            })
        ),
        Err(SessionError::InvalidLifecycle { .. })
    ));
    assert_eq!(session.revision(), revision);

    assert!(matches!(
        session.append(
            revision,
            event(EventData::SessionTitle {
                title: "Invalid user reference".to_owned(),
                message_seqs: vec![0],
                source: SessionTitleSource::User,
            })
        ),
        Err(SessionError::InvalidLifecycle { .. })
    ));
    assert_eq!(session.revision(), revision);
}

#[test]
fn goal_changes_require_full_monotonic_snapshots_and_a_revisioned_tombstone() {
    let mut session = Session::new(header("goal-lifecycle")).unwrap();
    session
        .append_batch_at(
            Revision::ZERO,
            vec![
                goal_snapshot_event(
                    1,
                    "Ship it",
                    GoalPhase::Active,
                    8,
                    GoalSnapshotOperation::Create,
                    10,
                ),
                goal_snapshot_event(
                    2,
                    "Ship safely",
                    GoalPhase::Active,
                    10,
                    GoalSnapshotOperation::Edit,
                    11,
                ),
                goal_snapshot_event(
                    3,
                    "Ship safely",
                    GoalPhase::Paused,
                    10,
                    GoalSnapshotOperation::Pause,
                    12,
                ),
                goal_snapshot_event(
                    4,
                    "Ship safely",
                    GoalPhase::Active,
                    10,
                    GoalSnapshotOperation::Resume,
                    13,
                ),
                goal_snapshot_event(
                    5,
                    "Ship safely",
                    GoalPhase::Complete,
                    10,
                    GoalSnapshotOperation::Complete,
                    14,
                ),
                event(EventData::GoalChange {
                    change: GoalChange::Clear(GoalClearChange {
                        kind: GoalChangeKind::GoalChange,
                        version: 1,
                        operation: GoalClearOperation::Clear,
                        cleared: GoalRef {
                            id: "goal-1".to_owned(),
                            revision: 6,
                        },
                        cleared_at: 15,
                    }),
                }),
            ],
            15,
        )
        .unwrap();
    let revision = session.revision();

    assert!(matches!(
        session.append(
            revision,
            goal_snapshot_event(
                1,
                "Reused identity",
                GoalPhase::Active,
                8,
                GoalSnapshotOperation::Create,
                16,
            )
        ),
        Err(SessionError::InvalidLifecycle { .. })
    ));
    assert_eq!(session.revision(), revision);
}

#[test]
fn derive_messages_is_a_pure_surface_projection() {
    let mut assistant = Message::assistant("I will read it");
    assistant.reasoning = "need the file".to_owned();
    let mut tool_call = call("execution-1", 0);
    tool_call.provider_call_id = Some("provider-call-1".to_owned());
    assistant.tool_calls = vec![tool_call.clone()];
    let mut session = Session::new(header("s1")).unwrap();
    session
        .append_batch_at(
            Revision::ZERO,
            vec![
                event(EventData::TurnStart { turn: 1 }),
                event(EventData::UserMessage {
                    message: Message::user("read README"),
                    surface_replace: None,
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
                    call: tool_call,
                }),
                event(EventData::ToolResult {
                    turn: 1,
                    step: 1,
                    result: ToolResultData::success("execution-1", "contents"),
                }),
                event(EventData::StepEnd { turn: 1, step: 1 }),
            ],
            100,
        )
        .unwrap();

    let expected = vec![
        Message::user("read README"),
        assistant,
        Message::tool("provider-call-1", "contents"),
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
        surface_replace: None,
    });
    assert!(matches!(
        session.append(Revision::ZERO, invalid_role),
        Err(SessionError::InvalidMessageRole { .. })
    ));
    assert!(session.events().is_empty());

    let mut invalid_call = call("execution-1", 0);
    invalid_call.provider_call_id = Some(String::new());
    let mut assistant = Message::assistant("");
    assistant.tool_calls.push(invalid_call);
    assert!(matches!(
        session.append_batch(
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
            ],
        ),
        Err(SessionError::EmptyProviderToolCallId { .. })
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

#[test]
fn undecided_approval_is_projected_and_not_converted_to_outcome_unknown() {
    let mut session = Session::new(header("approval-recovery")).unwrap();
    let mut assistant = Message::assistant("waiting for approval");
    assistant.tool_calls = vec![call("execution-1", 0), call("execution-2", 1)];
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
                    call: call("execution-1", 0),
                }),
                event(EventData::ToolCall {
                    turn: 1,
                    step: 1,
                    call: call("execution-2", 1),
                }),
                event(EventData::ApprovalAsked {
                    id: "approval-1".to_owned(),
                    tool_name: "echo".to_owned(),
                    call_id: Some("execution-1".to_owned()),
                    reason: Some("needs user approval".to_owned()),
                }),
            ],
            100,
        )
        .unwrap();

    let pending = session.pending_tool_approvals();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, "approval-1");
    assert_eq!(pending[0].call_id, "execution-1");
    assert_eq!(pending[0].turn, 1);
    assert_eq!(pending[0].step, 1);
    assert_eq!(pending[0].call.id, "execution-1");

    let recovery = session.outcome_unknown_recovery();
    assert_eq!(recovery.len(), 1);
    assert!(matches!(
        recovery[0].data(),
        EventData::ToolResult { result, .. }
            if result.call_id == "execution-2"
                && result.outcome == ToolOutcome::OutcomeUnknown
    ));
}

#[test]
fn message_projection_restores_tool_results_in_assistant_call_order() {
    let mut session = Session::new(header("ordered-recovery-results")).unwrap();
    let mut assistant = Message::assistant("");
    assistant.tool_calls = vec![call("first", 0), call("second", 1)];
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
                    call: call("first", 0),
                }),
                event(EventData::ToolCall {
                    turn: 1,
                    step: 1,
                    call: call("second", 1),
                }),
                // A recovery writer may obtain the second result before it
                // can materialize the first one. Provider history must still
                // follow the assistant call list, not append timing.
                event(EventData::ToolResult {
                    turn: 1,
                    step: 1,
                    result: ToolResultData::success("second", "result two"),
                }),
                event(EventData::ToolResult {
                    turn: 1,
                    step: 1,
                    result: ToolResultData::success("first", "result one"),
                }),
                event(EventData::StepEnd { turn: 1, step: 1 }),
                event(EventData::TurnEnd {
                    turn: 1,
                    reason: TurnEndReason::Completed,
                }),
            ],
            100,
        )
        .unwrap();

    let messages = session.derive_messages();
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[1].tool_call_id.as_deref(), Some("first"));
    assert_eq!(messages[1].content, "result one");
    assert_eq!(messages[2].tool_call_id.as_deref(), Some("second"));
    assert_eq!(messages[2].content, "result two");
}

#[tokio::test]
async fn memory_store_create_load_flush_and_inspect_are_detached() {
    let store = MemorySessionStore::default();
    store.create(header("z-session")).await.unwrap();
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
                    surface_replace: None,
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

    assert_eq!(
        store
            .list_headers()
            .await
            .unwrap()
            .into_iter()
            .map(|header| header.id)
            .collect::<Vec<_>>(),
        ["s1", "z-session"]
    );
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
                            surface_replace: None,
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
                            surface_replace: None,
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

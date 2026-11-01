use super::*;
use xharness_agent::{DurableInbox, GoalController, GoalReportBody, InboxProjection};
use xharness_session::{
    goal::*, GoalChangeKind, GoalClearChange, GoalClearOperation, GoalPhase, GoalRef,
    MemorySessionStore, SessionHeader, TurnEndReason,
};
use xharness_tools::{ToolExecutor, ToolRegistry, ToolRequest};

const ID: &str = "objective-owner";

async fn fixture(store: Arc<dyn Store>, enabled: bool) -> Arc<dyn Store> {
    store.create(SessionHeader::new(ID)).await.unwrap();
    let session = store.load(ID).await.unwrap().unwrap();
    store
        .append(
            ID,
            session.revision(),
            vec![EventData::GoalChange {
                change: GoalChange::Snapshot(GoalSnapshotChange {
                    kind: GoalChangeKind::GoalChange,
                    version: 1,
                    operation: GoalSnapshotOperation::Create,
                    goal: xharness_session::GoalSnapshot {
                        id: "user-created".into(),
                        revision: 1,
                        objective: "original objective".into(),
                        phase: GoalPhase::Active,
                        max_goal_rounds: 1,
                        blocked_reason: None,
                    },
                    rounds_started: 0,
                    created_at: 1,
                    updated_at: 1,
                }),
            }
            .into()],
        )
        .await
        .unwrap();
    if enabled {
        let session = store.load(ID).await.unwrap().unwrap();
        GoalController::new(store.clone(), ID)
            .enable(
                session.revision(),
                vec!["all tests pass".into()],
                VerificationMode::UserConfirm,
                3,
            )
            .await
            .unwrap();
    }
    store
}

async fn memory(enabled: bool) -> Arc<dyn Store> {
    fixture(Arc::new(MemorySessionStore::default()), enabled).await
}

async fn executor(
    store: &Arc<dyn Store>,
) -> (ToolExecutor, tokio::sync::broadcast::Receiver<String>) {
    let observed = fence(&store.load(ID).await.unwrap().unwrap()).unwrap();
    let registry = Arc::new(ToolRegistry::new());
    let (tx, rx) = tokio::sync::broadcast::channel(16);
    let tool = spec(store.clone(), tx, ID.into(), observed);
    assert_eq!(
        tool.batch_policy,
        xharness_tools::ToolBatchPolicy::Standalone
    );
    registry.register(tool).await.unwrap();
    (ToolExecutor::new(registry), rx)
}

fn request(objective: &str) -> ToolRequest {
    ToolRequest::new(
        "edit_goal_objective",
        json!({"objective":objective}).to_string(),
    )
}

async fn append(store: &Arc<dyn Store>, events: Vec<SessionEvent>) {
    let session = store.load(ID).await.unwrap().unwrap();
    store.append(ID, session.revision(), events).await.unwrap();
}

async fn claim(store: &Arc<dyn Store>) {
    GoalController::new(store.clone(), ID)
        .reconcile()
        .await
        .unwrap();
    let inbox = DurableInbox::open(store.clone(), SessionHeader::new(ID))
        .await
        .unwrap();
    let claim = inbox.prepare_claim(InboxTarget::NextTurn).await.unwrap();
    let session = store.load(ID).await.unwrap().unwrap();
    let mut events = GoalController::claim_events(&session, &claim.messages, 1).unwrap();
    events.extend(claim.messages.iter().map(|m| {
        EventData::UserMessage {
            message: m.message.clone(),
            surface_replace: None,
        }
        .into()
    }));
    inbox
        .commit_claim(claim, vec![EventData::TurnStart { turn: 1 }.into()], events)
        .await
        .unwrap();
}

#[tokio::test]
async fn no_goal_or_disarmed_legacy_goal_has_no_capability_until_user_activation() {
    let store = memory(false).await;
    store.create(SessionHeader::new("ordinary")).await.unwrap();
    let ordinary = store.load("ordinary").await.unwrap().unwrap();
    assert!(
        fence(&ordinary).is_none(),
        "natural language cannot activate a Goal"
    );
    let legacy = store.load(ID).await.unwrap().unwrap();
    assert!(
        fence(&legacy).is_none(),
        "an active-looking v1 snapshot is not execution authorization"
    );
    assert!(execution_state(&legacy).is_none());
    GoalController::new(store.clone(), ID)
        .enable(
            legacy.revision(),
            vec!["all tests pass".into()],
            VerificationMode::UserConfirm,
            3,
        )
        .await
        .unwrap();
    let (executor, _) = executor(&store).await;
    assert!(executor
        .execute(request("new text\n保留换行"))
        .await
        .is_ok());
    let session = store.load(ID).await.unwrap().unwrap();
    assert_eq!(
        execution_state(&session)
            .unwrap()
            .definition
            .snapshot
            .objective,
        "new text\n保留换行"
    );
    assert_eq!(
        store.load("ordinary").await.unwrap().unwrap().revision(),
        ordinary.revision()
    );
}

#[tokio::test]
async fn schema_rejects_all_lifecycle_scope_and_oversized_fields_without_writes() {
    let store = memory(true).await;
    let before = store.load(ID).await.unwrap().unwrap();
    let (executor, _) = executor(&store).await;
    let defs = executor.registry().definitions().await;
    assert_eq!(
        defs[0].parameters["properties"].as_object().unwrap().len(),
        1
    );
    for field in [
        "action",
        "sessionId",
        "goal_id",
        "phase",
        "execution_enabled",
        "verification",
        "maxGoalRounds",
        "acceptance_criteria",
    ] {
        let mut args = json!({"objective":"attempt"});
        args[field] = json!("complete");
        assert!(
            !executor
                .execute(ToolRequest::new("edit_goal_objective", args.to_string()))
                .await
                .is_ok(),
            "{field}"
        );
    }
    for invalid in [String::new(), " \n ".into(), "x".repeat(32769)] {
        assert!(!executor.execute(request(&invalid)).await.is_ok());
    }
    let cancelled = tokio_util::sync::CancellationToken::new();
    cancelled.cancel();
    assert!(!executor
        .execute(request("cancelled").with_cancellation(cancelled))
        .await
        .is_ok());
    assert_eq!(
        store.load(ID).await.unwrap().unwrap().revision(),
        before.revision()
    );
}

#[tokio::test]
async fn running_edit_preserves_lifecycle_and_rejects_replays_and_old_report_fences() {
    let store = memory(true).await;
    // Capture before the claim: round-only snapshot revisions must be tolerated.
    let (executor, mut changes) = executor(&store).await;
    claim(&store).await;
    let before = execution_state(&store.load(ID).await.unwrap().unwrap()).unwrap();
    assert!(executor
        .execute(request(
            "revised objective\nall original requirements retained"
        ))
        .await
        .is_ok());
    assert_eq!(changes.try_recv().unwrap(), ID);
    let session = store.load(ID).await.unwrap().unwrap();
    let after = execution_state(&session).unwrap();
    let mut expected = before.clone();
    expected.definition.snapshot = after.definition.snapshot.clone();
    expected.definition.definition_revision = after.definition.definition_revision;
    assert_eq!(after, expected);
    assert_eq!(after.definition.verification, VerificationMode::UserConfirm);
    assert_eq!(after.rounds_started, 1);
    assert!(after.definition.execution_enabled);
    assert_eq!(after.definition.snapshot.phase, GoalPhase::Active);
    assert!(
        crate::goal_report_tool::fence(&session, &[]).is_none(),
        "recovery cannot report against the old definition"
    );
    assert!(
        crate::goals::validate_report(
            &store,
            &(Arc::new(crate::NoTools) as Arc<dyn crate::SessionToolFactory>),
            ID,
            after.definition.clone(),
            after.activation_epoch,
            complete()
        )
        .await
        .is_err(),
        "even a fresh definition cannot report from the old running claim"
    );
    assert!(crate::goals::validate_report(
        &store,
        &(Arc::new(crate::NoTools) as Arc<dyn crate::SessionToolFactory>),
        ID,
        before.definition,
        before.activation_epoch,
        complete()
    )
    .await
    .is_err());
    assert!(!executor
        .execute(request("another edit in stale executor"))
        .await
        .is_ok());
    assert_eq!(
        store.load(ID).await.unwrap().unwrap().revision(),
        session.revision()
    );
}

#[tokio::test]
async fn pending_edit_discards_only_goal_input_and_keeps_user_work() {
    let store = memory(true).await;
    let controller = GoalController::new(store.clone(), ID);
    controller.reconcile().await.unwrap();
    let inbox = DurableInbox::open(store.clone(), SessionHeader::new(ID))
        .await
        .unwrap();
    inbox
        .append(
            InboxTarget::NextTurn,
            xharness_session::InboxMessage::user("user-priority", "user priority"),
        )
        .await
        .unwrap();
    let (executor, _) = executor(&store).await;
    assert!(executor.execute(request("new objective")).await.is_ok());
    let session = store.load(ID).await.unwrap().unwrap();
    let state = execution_state(&session).unwrap();
    assert!(state.pending.is_none());
    assert_eq!(state.rounds_started, 0);
    let remaining = InboxProjection::from_session(&session).unwrap();
    assert_eq!(remaining.next_turn().len(), 1);
    assert_eq!(remaining.next_turn()[0].message.content, "user priority");
    assert!(matches!(
        controller.reconcile().await.unwrap(),
        GoalDecision::Wait {
            reason: WaitReason::UserPriority
        }
    ));
}

#[tokio::test]
async fn paused_or_completed_goals_hide_tool_and_reject_previously_captured_invocations() {
    for phase in [GoalPhase::Paused, GoalPhase::Complete] {
        let store = memory(true).await;
        let (old_executor, _) = executor(&store).await;
        let session = store.load(ID).await.unwrap().unwrap();
        let mut snapshot = xharness_agent::goal_snapshot(&session).unwrap();
        snapshot.version = 1;
        snapshot.goal.revision += 1;
        snapshot.goal.phase = phase;
        snapshot.operation = if phase == GoalPhase::Paused {
            GoalSnapshotOperation::Pause
        } else {
            GoalSnapshotOperation::Complete
        };
        append(
            &store,
            vec![EventData::GoalChange {
                change: GoalChange::Snapshot(snapshot),
            }
            .into()],
        )
        .await;
        let before = store.load(ID).await.unwrap().unwrap();
        assert!(fence(&before).is_none());
        assert!(!old_executor
            .execute(request("must not edit an inactive Goal"))
            .await
            .is_ok());
        assert_eq!(
            store.load(ID).await.unwrap().unwrap().revision(),
            before.revision()
        );
    }
}

#[tokio::test]
async fn tool_reappears_on_explicit_resume_but_old_activation_executor_stays_stale() {
    let store = memory(true).await;
    let controller = GoalController::new(store.clone(), ID);
    let (old_executor, _) = executor(&store).await;
    controller.pause().await.unwrap();
    let paused = store.load(ID).await.unwrap().unwrap();
    assert!(
        !execution_state(&paused)
            .unwrap()
            .definition
            .execution_enabled,
        "user pause explicitly revokes execution authorization"
    );
    assert!(fence(&paused).is_none());
    assert!(!old_executor
        .execute(request("not while paused"))
        .await
        .is_ok());
    let mut snapshot = xharness_agent::goal_snapshot(&paused).unwrap();
    snapshot.version = 1;
    snapshot.operation = GoalSnapshotOperation::Resume;
    snapshot.goal.revision += 1;
    snapshot.goal.phase = GoalPhase::Active;
    append(
        &store,
        vec![EventData::GoalChange {
            change: GoalChange::Snapshot(snapshot),
        }
        .into()],
    )
    .await;
    let disarmed = store.load(ID).await.unwrap().unwrap();
    assert!(
        fence(&disarmed).is_none(),
        "active phase alone must not imply activation"
    );
    controller
        .enable(
            disarmed.revision(),
            vec!["all tests pass".into()],
            VerificationMode::UserConfirm,
            3,
        )
        .await
        .unwrap();
    assert!(!old_executor
        .execute(request("old epoch must remain stale"))
        .await
        .is_ok());
    let (new_executor, _) = executor(&store).await;
    assert!(new_executor
        .execute(request("autonomous refinement after activation"))
        .await
        .is_ok());
}

#[tokio::test]
async fn pause_external_edit_clear_and_replacement_invalidate_captured_capability() {
    for control in ["pause", "edit", "clear", "replace"] {
        let store = memory(true).await;
        let (executor, _) = executor(&store).await;
        let session = store.load(ID).await.unwrap().unwrap();
        let mut snapshot = xharness_agent::goal_snapshot(&session).unwrap();
        snapshot.version = 1;
        snapshot.goal.revision += 1;
        if matches!(control, "clear" | "replace") {
            append(
                &store,
                vec![EventData::GoalChange {
                    change: GoalChange::Clear(GoalClearChange {
                        kind: GoalChangeKind::GoalChange,
                        version: 1,
                        operation: GoalClearOperation::Clear,
                        cleared: GoalRef {
                            id: snapshot.goal.id.clone(),
                            revision: snapshot.goal.revision,
                        },
                        cleared_at: 2,
                    }),
                }
                .into()],
            )
            .await;
            if control == "replace" {
                snapshot.operation = GoalSnapshotOperation::Create;
                snapshot.goal.id = "replacement".into();
                snapshot.goal.revision = 1;
                append(
                    &store,
                    vec![EventData::GoalChange {
                        change: GoalChange::Snapshot(snapshot),
                    }
                    .into()],
                )
                .await;
            }
        } else {
            snapshot.operation = if control == "pause" {
                GoalSnapshotOperation::Pause
            } else {
                GoalSnapshotOperation::Edit
            };
            if control == "pause" {
                snapshot.goal.phase = GoalPhase::Paused;
            } else {
                snapshot.goal.objective = "user's edit wins".into();
            }
            append(
                &store,
                vec![EventData::GoalChange {
                    change: GoalChange::Snapshot(snapshot),
                }
                .into()],
            )
            .await;
        }
        let after_control = store.load(ID).await.unwrap().unwrap();
        assert!(
            !executor
                .execute(request("must not overwrite control"))
                .await
                .is_ok(),
            "{control}"
        );
        assert_eq!(
            store.load(ID).await.unwrap().unwrap().revision(),
            after_control.revision()
        );
    }
}

fn complete() -> GoalReportBody {
    GoalReportBody {
        status: GoalReportStatus::Complete,
        summary: "old objective complete".into(),
        remaining: vec![],
        evidence: vec![GoalEvidence::Artifact {
            reference: "test://old".into(),
        }],
        blocked_reason: None,
    }
}

#[tokio::test]
async fn edited_running_turn_cannot_complete_new_objective_but_cancellation_still_pauses() {
    for (reason, should_pause) in [
        (TurnEndReason::Completed, false),
        (TurnEndReason::Cancelled, true),
        (TurnEndReason::LimitReached, true),
        (TurnEndReason::MaxTokens, true),
        (TurnEndReason::Interrupted, true),
        (
            TurnEndReason::Failed {
                error: "fixture failure".into(),
                provider_failure: None,
            },
            true,
        ),
    ] {
        let store = memory(true).await;
        claim(&store).await;
        let (executor, _) = executor(&store).await;
        assert!(executor
            .execute(request("new unmet objective"))
            .await
            .is_ok());
        append(&store, vec![EventData::TurnEnd { turn: 1, reason }.into()]).await;
        let controller = GoalController::new(store.clone(), ID);
        controller.settle(Some(complete())).await.unwrap();
        let session = store.load(ID).await.unwrap().unwrap();
        let state = execution_state(&session).unwrap();
        let result = state.latest_turn.as_ref().unwrap();
        assert_eq!(
            result.definition_revision,
            state.definition.definition_revision
        );
        assert!(
            result.report.is_none(),
            "no old completion may bind to revised text"
        );
        let decision = controller.reconcile().await.unwrap();
        if should_pause {
            assert!(
                matches!(decision, GoalDecision::Pause { .. }),
                "{decision:?}"
            );
        } else {
            assert!(
                matches!(decision, GoalDecision::Continue { .. }),
                "{decision:?}"
            );
            let session = store.load(ID).await.unwrap().unwrap();
            let queued = InboxProjection::from_session(&session).unwrap();
            assert!(queued.next_turn()[0]
                .message
                .content
                .contains("new unmet objective"));
        }
        assert_ne!(
            execution_state(&store.load(ID).await.unwrap().unwrap())
                .unwrap()
                .definition
                .snapshot
                .phase,
            GoalPhase::Complete
        );
    }
}

#[tokio::test]
async fn journal_rejects_objective_edits_that_change_control_or_omit_atomic_companions() {
    let store = memory(true).await;
    GoalController::new(store.clone(), ID)
        .reconcile()
        .await
        .unwrap();
    let session = store.load(ID).await.unwrap().unwrap();
    let observed = fence(&session).unwrap();
    let valid = edit_events(&session, &observed, "new objective", 3).unwrap();
    for mutation in [
        "enabled",
        "epoch",
        "verification",
        "criteria",
        "rounds",
        "definition",
        "pending",
        "phase",
        "snapshot-only",
        "execution-only",
        "retain-inbox",
    ] {
        let mut events = valid.clone();
        for event in &mut events {
            if let EventData::GoalExecution { change } = event.data_mut() {
                let s = &mut change.state;
                match mutation {
                    "enabled" => s.definition.execution_enabled = false,
                    "epoch" => s.activation_epoch += 1,
                    "verification" => s.definition.verification = VerificationMode::AgentReport,
                    "criteria" => s.definition.acceptance_criteria.clear(),
                    "rounds" => s.rounds_started += 1,
                    "definition" => s.definition.definition_revision -= 1,
                    "pending" => s.pending = execution_state(&session).unwrap().pending,
                    "phase" => s.definition.snapshot.phase = GoalPhase::Complete,
                    _ => {}
                }
            }
        }
        match mutation {
            "snapshot-only" => events.retain(|e| matches!(e.data(), EventData::GoalChange { .. })),
            "execution-only" => {
                events.retain(|e| matches!(e.data(), EventData::GoalExecution { .. }))
            }
            "retain-inbox" => {
                events.retain(|e| !matches!(e.data(), EventData::AgentInboxSpliced { .. }))
            }
            _ => {}
        }
        assert!(
            store.append(ID, session.revision(), events).await.is_err(),
            "{mutation}"
        );
    }
    assert_eq!(
        store.load(ID).await.unwrap().unwrap().revision(),
        session.revision()
    );
}

#[tokio::test]
async fn concurrent_captured_editors_commit_at_most_one_definition() {
    let store = memory(true).await;
    let (one, _) = executor(&store).await;
    let (two, _) = executor(&store).await;
    let (a, b) = tokio::join!(
        one.execute(request("first")),
        two.execute(request("second"))
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let session = store.load(ID).await.unwrap().unwrap();
    assert_eq!(session.events().iter().filter(|e| matches!(e.data(), EventData::GoalExecution { change } if change.operation == GoalExecutionOperation::EditObjective)).count(), 1);
}

#[tokio::test]
async fn jsonl_cold_reload_keeps_edited_text_policy_and_pending_removal() {
    let nonce = std::time::SystemTime::UNIX_EPOCH
        .elapsed()
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("goal-objective-{}-{nonce}", std::process::id()));
    std::fs::create_dir(&path).unwrap();
    {
        let store = fixture(
            Arc::new(xharness_session_jsonl::JsonlSessionStore::new(&path).unwrap()),
            true,
        )
        .await;
        GoalController::new(store.clone(), ID)
            .reconcile()
            .await
            .unwrap();
        let (executor, _) = executor(&store).await;
        assert!(executor
            .execute(request("cold persisted objective\n完整多行"))
            .await
            .is_ok());
    }
    let store = xharness_session_jsonl::JsonlSessionStore::new(&path).unwrap();
    let session = store.load(ID).await.unwrap().unwrap();
    let state = execution_state(&session).unwrap();
    assert_eq!(
        state.definition.snapshot.objective,
        "cold persisted objective\n完整多行"
    );
    assert_eq!(state.definition.verification, VerificationMode::UserConfirm);
    assert!(state.definition.execution_enabled);
    assert!(state.pending.is_none());
    assert!(InboxProjection::from_session(&session)
        .unwrap()
        .next_turn()
        .is_empty());
    std::fs::remove_dir_all(path).unwrap();
}

#[tokio::test]
async fn controller_pause_hides_tool_even_when_execution_authorization_is_retained() {
    let store = memory(true).await;
    claim(&store).await;
    append(
        &store,
        vec![EventData::TurnEnd {
            turn: 1,
            reason: TurnEndReason::Cancelled,
        }
        .into()],
    )
    .await;
    let controller = GoalController::new(store.clone(), ID);
    controller.settle(None).await.unwrap();
    assert!(matches!(
        controller.reconcile().await.unwrap(),
        GoalDecision::Pause { .. }
    ));
    let session = store.load(ID).await.unwrap().unwrap();
    let state = execution_state(&session).unwrap();
    assert!(state.definition.execution_enabled);
    assert_eq!(state.definition.snapshot.phase, GoalPhase::Paused);
    assert!(
        fence(&session).is_none(),
        "enabled alone cannot expose the edit tool while phase is paused"
    );
}

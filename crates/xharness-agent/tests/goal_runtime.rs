use async_trait::async_trait;
use futures::stream;
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use xharness_agent::*;
use xharness_core::{
    AgentMessage, FinishReason, LoopRequest, LoopResult, ModelProvider, ProviderError,
    ProviderEvent, ProviderRequest, ProviderStream,
};
use xharness_goal::*;
use xharness_session::{
    EventData, GoalChange, GoalChangeKind, GoalSnapshotChange, GoalSnapshotOperation,
    MemorySessionStore, SessionHeader, Store, TurnEndReason,
};

async fn setup() -> (Arc<dyn Store>, DurableInbox, GoalController) {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let inbox = DurableInbox::open(store.clone(), SessionHeader::new("goal-test"))
        .await
        .unwrap();
    let s = store.load("goal-test").await.unwrap().unwrap();
    store
        .append(
            "goal-test",
            s.revision(),
            vec![EventData::GoalChange {
                change: GoalChange::Snapshot(GoalSnapshotChange {
                    kind: GoalChangeKind::GoalChange,
                    version: 1,
                    operation: GoalSnapshotOperation::Create,
                    goal: GoalSnapshot {
                        id: "g".into(),
                        revision: 1,
                        objective: "implement and test a parser".into(),
                        phase: GoalPhase::Active,
                        blocked_reason: None,
                        max_goal_rounds: 4,
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
    let controller = GoalController::new(store.clone(), "goal-test");
    (store, inbox, controller)
}
async fn enable(store: &Arc<dyn Store>, c: &GoalController) {
    c.enable(
        store.load("goal-test").await.unwrap().unwrap().revision(),
        vec!["tests pass".into()],
        VerificationMode::AgentReport,
        3,
    )
    .await
    .unwrap();
}
async fn claim(store: &Arc<dyn Store>, inbox: &DurableInbox, turn: u32) {
    let claim = inbox.prepare_claim(InboxTarget::NextTurn).await.unwrap();
    let session = store.load("goal-test").await.unwrap().unwrap();
    let mut suffix = GoalController::claim_events(&session, &claim.messages, turn).unwrap();
    suffix.extend(claim.messages.iter().map(|m| {
        EventData::UserMessage {
            message: m.message.clone(),
            surface_replace: None,
        }
        .into()
    }));
    inbox
        .commit_claim(claim, vec![EventData::TurnStart { turn }.into()], suffix)
        .await
        .unwrap();
}
async fn close(store: &Arc<dyn Store>, turn: u32, reason: TurnEndReason) {
    let s = store.load("goal-test").await.unwrap().unwrap();
    store
        .append(
            "goal-test",
            s.revision(),
            vec![EventData::TurnEnd { turn, reason }.into()],
        )
        .await
        .unwrap();
}
fn body(status: GoalReportStatus) -> GoalReportBody {
    GoalReportBody {
        status,
        summary: "work done".into(),
        remaining: vec![],
        evidence: vec![],
        blocked_reason: None,
    }
}

#[tokio::test]
async fn legacy_goal_does_not_execute_until_explicit_enable() {
    let (store, inbox, c) = setup().await;
    assert!(matches!(
        c.reconcile().await.unwrap(),
        GoalDecision::Idle { .. }
    ));
    assert!(!inbox.snapshot().await.unwrap().has_pending());
    enable(&store, &c).await;
    assert!(matches!(
        c.reconcile().await.unwrap(),
        GoalDecision::Continue { .. }
    ));
    assert_eq!(c.state().await.unwrap().unwrap().rounds_started, 0);
    claim(&store, &inbox, 1).await;
    assert_eq!(c.state().await.unwrap().unwrap().rounds_started, 1);
}
#[tokio::test]
async fn concurrent_reconcile_only_queues_one_and_replay_retains_receipt() {
    let (store, inbox, c) = setup().await;
    enable(&store, &c).await;
    let other = GoalController::new(store.clone(), "goal-test");
    let (a, b) = tokio::join!(c.reconcile(), other.reconcile());
    assert!(a.is_ok() || b.is_ok());
    assert_eq!(inbox.snapshot().await.unwrap().next_turn().len(), 1);
    let restarted = GoalController::new(store.clone(), "goal-test");
    assert!(matches!(
        restarted.reconcile().await.unwrap(),
        GoalDecision::Wait {
            reason: WaitReason::ContinuationPending
        }
    ));
    assert_eq!(restarted.state().await.unwrap().unwrap().admitted.len(), 1);
}
#[tokio::test]
async fn claim_is_revision_fenced_and_user_input_takes_priority() {
    let (store, inbox, c) = setup().await;
    enable(&store, &c).await;
    c.reconcile().await.unwrap();
    let stale = inbox.prepare_claim(InboxTarget::NextTurn).await.unwrap();
    inbox
        .append(
            InboxTarget::NextTurn,
            InboxMessage::user("user", "do this first"),
        )
        .await
        .unwrap();
    assert!(inbox.commit_claim(stale, vec![], vec![]).await.is_err());
    let user = inbox.prepare_claim(InboxTarget::NextTurn).await.unwrap();
    assert_eq!(user.messages[0].id, "user");
    assert!(matches!(
        c.reconcile().await.unwrap(),
        GoalDecision::Wait {
            reason: WaitReason::UserPriority
        }
    ));
    assert_eq!(c.state().await.unwrap().unwrap().rounds_started, 0);
}
#[tokio::test]
async fn legacy_pause_invalidates_queued_continuation() {
    let (store, inbox, c) = setup().await;
    enable(&store, &c).await;
    c.reconcile().await.unwrap();
    let s = store.load("goal-test").await.unwrap().unwrap();
    let mut g = goal_snapshot(&s).unwrap();
    g.operation = GoalSnapshotOperation::Pause;
    g.goal.revision += 1;
    g.goal.phase = GoalPhase::Paused;
    store
        .append(
            "goal-test",
            s.revision(),
            vec![EventData::GoalChange {
                change: GoalChange::Snapshot(g),
            }
            .into()],
        )
        .await
        .unwrap();
    assert!(inbox
        .prepare_claim(InboxTarget::NextTurn)
        .await
        .unwrap()
        .is_empty());
    c.reconcile().await.unwrap();
    assert!(!inbox.snapshot().await.unwrap().has_pending());
    assert!(
        !c.state()
            .await
            .unwrap()
            .unwrap()
            .definition
            .execution_enabled
    );
}
#[tokio::test]
async fn clear_removes_orphan_and_never_executes_as_user_input() {
    let (store, inbox, c) = setup().await;
    enable(&store, &c).await;
    c.reconcile().await.unwrap();
    let s = store.load("goal-test").await.unwrap().unwrap();
    store
        .append(
            "goal-test",
            s.revision(),
            vec![EventData::GoalChange {
                change: GoalChange::Clear(xharness_session::GoalClearChange {
                    kind: GoalChangeKind::GoalChange,
                    version: 1,
                    operation: xharness_session::GoalClearOperation::Clear,
                    cleared: xharness_session::GoalRef {
                        id: "g".into(),
                        revision: 2,
                    },
                    cleared_at: 2,
                }),
            }
            .into()],
        )
        .await
        .unwrap();
    assert!(inbox
        .prepare_claim(InboxTarget::NextTurn)
        .await
        .unwrap()
        .is_empty());
    c.reconcile().await.unwrap();
    assert!(!inbox.snapshot().await.unwrap().has_pending());
}
#[tokio::test]
async fn restart_after_claim_waits_for_recovery_without_repeating_side_effects() {
    let (store, inbox, c) = setup().await;
    enable(&store, &c).await;
    c.reconcile().await.unwrap();
    claim(&store, &inbox, 1).await;
    let restarted = GoalController::new(store.clone(), "goal-test");
    assert!(matches!(
        restarted.reconcile().await.unwrap(),
        GoalDecision::Wait {
            reason: WaitReason::Recovery
        }
    ));
    assert!(!inbox.snapshot().await.unwrap().has_pending());
    close(&store, 1, TurnEndReason::Interrupted).await;
    assert!(matches!(
        restarted.reconcile().await.unwrap(),
        GoalDecision::Pause {
            reason: PauseReason::OutcomeUnknown,
            ..
        }
    ));
    assert_eq!(restarted.state().await.unwrap().unwrap().rounds_started, 1);
}
#[tokio::test]
async fn settled_cancel_and_output_limits_never_spawn_a_new_round() {
    for reason in [
        TurnEndReason::Cancelled,
        TurnEndReason::MaxTokens,
        TurnEndReason::LimitReached,
    ] {
        let (store, inbox, c) = setup().await;
        enable(&store, &c).await;
        c.reconcile().await.unwrap();
        claim(&store, &inbox, 1).await;
        close(&store, 1, reason).await;
        c.settle(Some(body(GoalReportStatus::Complete)))
            .await
            .unwrap();
        assert!(matches!(
            c.reconcile().await.unwrap(),
            GoalDecision::Pause { .. }
        ));
        assert!(!inbox.snapshot().await.unwrap().has_pending());
    }
}
#[tokio::test]
async fn malformed_atomic_claim_is_rejected_without_consuming_queue() {
    let (store, inbox, c) = setup().await;
    enable(&store, &c).await;
    c.reconcile().await.unwrap();
    let s = store.load("goal-test").await.unwrap().unwrap();
    let prepared = inbox.prepare_claim(InboxTarget::NextTurn).await.unwrap();
    let events = GoalController::claim_events(&s, &prepared.messages, 1).unwrap();
    assert!(store
        .append("goal-test", s.revision(), events)
        .await
        .is_err());
    assert_eq!(inbox.snapshot().await.unwrap().next_turn().len(), 1);
    assert_eq!(c.state().await.unwrap().unwrap().rounds_started, 0);
}

struct Provider(Arc<AtomicUsize>);
#[async_trait]
impl ModelProvider for Provider {
    async fn stream(
        &self,
        _: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let n = self.0.fetch_add(1, Ordering::SeqCst);
        let b = body(if n < 2 {
            GoalReportStatus::Progress
        } else {
            GoalReportStatus::Complete
        });
        Ok(Box::pin(stream::iter(vec![
            Ok(ProviderEvent::TextDelta(serde_json::to_string(&b).unwrap())),
            Ok(ProviderEvent::Completed {
                finish_reason: Some(FinishReason::Stop),
                usage: None,
                provider_items: vec![],
            }),
        ])))
    }
}
struct Factory(Arc<AtomicUsize>);
#[async_trait]
impl TurnRequestFactory for Factory {
    async fn build(&self, _: &str, input: Vec<AgentMessage>) -> Result<LoopRequest, String> {
        Ok(LoopRequest::new(Arc::new(Provider(self.0.clone())), input))
    }
    async fn goal_report(
        &self,
        _: &str,
        result: &LoopResult,
    ) -> Result<Option<GoalReportBody>, String> {
        serde_json::from_str(&result.final_text)
            .map(Some)
            .map_err(|e| e.to_string())
    }
}
#[tokio::test]
async fn actual_durable_driver_advances_three_rounds_and_stops_on_goal_completion() {
    let (store, _, c) = setup().await;
    enable(&store, &c).await;
    let count = Arc::new(AtomicUsize::new(0));
    let registry = AgentRegistry::new(store.clone(), Arc::new(MemoryLeaseManager::default()));
    let activation = registry
        .activate(SessionHeader::new("goal-test"))
        .await
        .unwrap();
    let handle = DurableAgentHandle::start(activation, Arc::new(Factory(count.clone())), 128);
    let mut events = handle.subscribe();
    handle.wake().await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if c.state().await.unwrap().unwrap().definition.snapshot.phase == GoalPhase::Complete { break; }
            tokio::select! { e = events.recv() => { if let Ok(AgentEvent::Error { message }) = e { panic!("{message}"); } }, _ = tokio::time::sleep(Duration::from_millis(10)) => {} }
        }
    }).await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 3);
    let s = c.state().await.unwrap().unwrap();
    assert_eq!(s.rounds_started, 3);
    assert_eq!(s.admitted.len(), 3);
    assert!(s.pending.is_none() && s.running.is_none());
    handle.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn persisted_confirmation_requires_exact_report_and_survives_replay() {
    let (store, inbox, c) = setup().await;
    c.enable(
        store.load("goal-test").await.unwrap().unwrap().revision(),
        vec![],
        VerificationMode::UserConfirm,
        3,
    )
    .await
    .unwrap();
    c.reconcile().await.unwrap();
    claim(&store, &inbox, 1).await;
    close(&store, 1, TurnEndReason::Completed).await;
    c.settle(Some(body(GoalReportStatus::Complete)))
        .await
        .unwrap();
    assert!(matches!(
        c.reconcile().await.unwrap(),
        GoalDecision::Wait {
            reason: WaitReason::CompletionConfirmation
        }
    ));
    let report = c
        .state()
        .await
        .unwrap()
        .unwrap()
        .latest_turn
        .unwrap()
        .report
        .unwrap();
    let rev = store.load("goal-test").await.unwrap().unwrap().revision();
    let mut review = CompletionReview {
        goal_id: report.goal_id,
        definition_revision: report.definition_revision,
        report_id: "wrong".into(),
        verdict: ReviewVerdict::Accepted,
    };
    assert!(c.review(rev, review.clone()).await.is_err());
    review.report_id = report.report_id;
    c.review(rev, review).await.unwrap();
    let reopened = GoalController::new(store, "goal-test");
    assert!(matches!(
        reopened.reconcile().await.unwrap(),
        GoalDecision::Complete { .. }
    ));
    assert_eq!(
        reopened
            .state()
            .await
            .unwrap()
            .unwrap()
            .definition
            .snapshot
            .phase,
        GoalPhase::Complete
    );
}

#[tokio::test]
async fn missing_reports_pause_after_three_settled_empty_rounds() {
    let (store, inbox, c) = setup().await;
    enable(&store, &c).await;
    for turn in 1..=3 {
        assert!(matches!(
            c.reconcile().await.unwrap(),
            GoalDecision::Continue { .. }
        ));
        claim(&store, &inbox, turn).await;
        close(&store, turn, TurnEndReason::Completed).await;
        c.settle(None).await.unwrap();
    }
    assert!(matches!(
        c.reconcile().await.unwrap(),
        GoalDecision::Pause {
            reason: PauseReason::ReportProtocolStalled,
            ..
        }
    ));
    assert_eq!(c.state().await.unwrap().unwrap().rounds_started, 3);
}

struct PauseDuringBuild {
    store: Arc<dyn Store>,
    calls: Arc<AtomicUsize>,
}
#[async_trait]
impl TurnRequestFactory for PauseDuringBuild {
    async fn build(&self, id: &str, input: Vec<AgentMessage>) -> Result<LoopRequest, String> {
        GoalController::new(self.store.clone(), id)
            .pause()
            .await
            .map_err(|e| e.to_string())?;
        Ok(LoopRequest::new(
            Arc::new(Provider(self.calls.clone())),
            input,
        ))
    }
}
#[tokio::test]
async fn pause_between_prepare_and_start_never_calls_model_or_counts_round() {
    let (store, inbox, c) = setup().await;
    enable(&store, &c).await;
    let calls = Arc::new(AtomicUsize::new(0));
    let registry = AgentRegistry::new(store.clone(), Arc::new(MemoryLeaseManager::default()));
    let handle = DurableAgentHandle::start(
        registry
            .activate(SessionHeader::new("goal-test"))
            .await
            .unwrap(),
        Arc::new(PauseDuringBuild {
            store: store.clone(),
            calls: calls.clone(),
        }),
        64,
    );
    handle.wake().await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if c.state().await.unwrap().unwrap().definition.snapshot.phase == GoalPhase::Paused
                && !inbox.snapshot().await.unwrap().has_pending()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(c.state().await.unwrap().unwrap().rounds_started, 0);
    handle.shutdown(Duration::from_secs(1)).await;
}

struct LostAckStore {
    inner: Arc<dyn Store>,
    fail: std::sync::atomic::AtomicBool,
}
#[async_trait]
impl Store for LostAckStore {
    async fn list_headers(&self) -> Result<Vec<SessionHeader>, xharness_session::StoreError> {
        self.inner.list_headers().await
    }
    async fn create(
        &self,
        h: SessionHeader,
    ) -> Result<xharness_session::Session, xharness_session::StoreError> {
        self.inner.create(h).await
    }
    async fn load(
        &self,
        id: &str,
    ) -> Result<Option<xharness_session::Session>, xharness_session::StoreError> {
        self.inner.load(id).await
    }
    async fn append(
        &self,
        id: &str,
        r: Revision,
        events: Vec<xharness_session::SessionEvent>,
    ) -> Result<xharness_session::AppendReceipt, xharness_session::StoreError> {
        let receipt = self.inner.append(id, r, events).await?;
        self.inner.flush(id).await?;
        if self.fail.swap(false, Ordering::SeqCst) {
            return Err(xharness_session::StoreError::Backend {
                message: "injected lost acknowledgement after durable commit".into(),
            });
        }
        Ok(receipt)
    }
    async fn flush(&self, id: &str) -> Result<Revision, xharness_session::StoreError> {
        self.inner.flush(id).await
    }
    async fn inspect(
        &self,
        id: &str,
    ) -> Result<Option<xharness_session::SessionInspection>, xharness_session::StoreError> {
        self.inner.inspect(id).await
    }
}
#[tokio::test]
async fn lost_commit_ack_does_not_duplicate_continuation_on_retry() {
    let (store, inbox, c) = setup().await;
    enable(&store, &c).await;
    let faulted = GoalController::new(
        Arc::new(LostAckStore {
            inner: store.clone(),
            fail: std::sync::atomic::AtomicBool::new(true),
        }),
        "goal-test",
    );
    assert!(faulted.reconcile().await.is_err());
    assert!(matches!(
        c.reconcile().await.unwrap(),
        GoalDecision::Wait {
            reason: WaitReason::ContinuationPending
        }
    ));
    assert_eq!(inbox.snapshot().await.unwrap().next_turn().len(), 1);
    assert_eq!(c.state().await.unwrap().unwrap().admitted.len(), 1);
}

#[tokio::test]
async fn removing_queued_goal_input_pauses_instead_of_waiting_forever() {
    let (store, inbox, c) = setup().await;
    enable(&store, &c).await;
    c.reconcile().await.unwrap();
    let id = c
        .state()
        .await
        .unwrap()
        .unwrap()
        .pending
        .unwrap()
        .message_id;
    inbox.remove(&id).await.unwrap();
    c.reconcile().await.unwrap();
    let s = c.state().await.unwrap().unwrap();
    assert_eq!(s.definition.snapshot.phase, GoalPhase::Paused);
    assert_eq!(s.pause_reason, Some(PauseReason::Cancelled));
    assert_eq!(s.rounds_started, 0);
    assert!(s.pending.is_none());
}

#[tokio::test]
async fn pause_resume_preserves_round_budget_and_requires_explicit_reenable() {
    let (store, inbox, c) = setup().await;
    enable(&store, &c).await;
    c.reconcile().await.unwrap();
    claim(&store, &inbox, 1).await;
    close(&store, 1, TurnEndReason::Completed).await;
    c.settle(Some(body(GoalReportStatus::Progress)))
        .await
        .unwrap();
    c.pause().await.unwrap();
    let s = store.load("goal-test").await.unwrap().unwrap();
    let mut g = goal_snapshot(&s).unwrap();
    g.version = 1;
    g.operation = GoalSnapshotOperation::Resume;
    g.goal.phase = GoalPhase::Active;
    g.goal.revision += 1;
    store
        .append(
            "goal-test",
            s.revision(),
            vec![EventData::GoalChange {
                change: GoalChange::Snapshot(g),
            }
            .into()],
        )
        .await
        .unwrap();
    assert!(matches!(
        c.reconcile().await.unwrap(),
        GoalDecision::Idle {
            reason: IdleReason::Disabled
        }
    ));
    enable(&store, &c).await;
    let s = c.state().await.unwrap().unwrap();
    assert_eq!(s.rounds_started, 1);
    assert_eq!(s.activation_epoch, 2);
    assert!(s.latest_turn.is_none());
    c.reconcile().await.unwrap();
    claim(&store, &inbox, 2).await;
    assert_eq!(c.state().await.unwrap().unwrap().rounds_started, 2);
}
#[tokio::test]
async fn late_completion_after_pause_never_reactivates_goal() {
    let (store, inbox, c) = setup().await;
    enable(&store, &c).await;
    c.reconcile().await.unwrap();
    claim(&store, &inbox, 1).await;
    c.pause().await.unwrap();
    close(&store, 1, TurnEndReason::Completed).await;
    c.settle(Some(body(GoalReportStatus::Complete)))
        .await
        .unwrap();
    assert!(matches!(
        c.reconcile().await.unwrap(),
        GoalDecision::Idle {
            reason: IdleReason::Paused
        }
    ));
    assert!(!inbox.snapshot().await.unwrap().has_pending());
}

#[tokio::test]
async fn abandoned_goal_turn_is_closed_unknown_and_not_reexecuted() {
    let (store, inbox, c) = setup().await;
    enable(&store, &c).await;
    c.reconcile().await.unwrap();
    claim(&store, &inbox, 1).await;
    c.recover_abandoned().await.unwrap();
    let state = c.state().await.unwrap().unwrap();
    assert_eq!(state.definition.snapshot.phase, GoalPhase::Paused);
    assert_eq!(state.pause_reason, Some(PauseReason::OutcomeUnknown));
    assert_eq!(state.rounds_started, 1);
    assert!(state.running.is_none());
    assert!(!inbox.snapshot().await.unwrap().has_pending());
    let revision = store.load("goal-test").await.unwrap().unwrap().revision();
    c.recover_abandoned().await.unwrap();
    assert_eq!(
        store.load("goal-test").await.unwrap().unwrap().revision(),
        revision
    );
}

#[tokio::test]
async fn dependencies_wait_without_spending_rounds_then_continue_once() {
    let (store, inbox, c) = setup().await;
    enable(&store, &c).await;
    assert!(matches!(
        c.reconcile_with_dependencies(true).await.unwrap(),
        GoalDecision::Wait {
            reason: WaitReason::Dependencies
        }
    ));
    assert!(!inbox.snapshot().await.unwrap().has_pending());
    assert_eq!(c.state().await.unwrap().unwrap().rounds_started, 0);
    c.reconcile_with_dependencies(false).await.unwrap();
    c.reconcile_with_dependencies(false).await.unwrap();
    assert_eq!(inbox.snapshot().await.unwrap().next_turn().len(), 1);
    assert_eq!(c.state().await.unwrap().unwrap().admitted.len(), 1);
}

#[tokio::test]
async fn preparation_failure_persists_diagnostic_and_discards_only_goal_intent() {
    let (store, inbox, c) = setup().await;
    enable(&store, &c).await;
    c.reconcile().await.unwrap();
    c.pause_error("required job is missing after restart")
        .await
        .unwrap();
    let state = c.state().await.unwrap().unwrap();
    assert_eq!(state.pause_reason, Some(PauseReason::ExecutionError));
    assert_eq!(
        state.pause_detail.as_deref(),
        Some("required job is missing after restart")
    );
    assert_eq!(state.definition.snapshot.phase, GoalPhase::Paused);
    assert!(!inbox.snapshot().await.unwrap().has_pending());
    assert_eq!(state.rounds_started, 0);
    let revision = store.load("goal-test").await.unwrap().unwrap().revision();
    c.pause_error("duplicate error").await.unwrap();
    assert_eq!(
        store.load("goal-test").await.unwrap().unwrap().revision(),
        revision
    );
}

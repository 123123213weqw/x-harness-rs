//! Durable deadline, cancellation and deferred-question regression scenarios.
use super::*;
use xharness_session::goal::{
    GoalDecision, IdleReason, PauseReason, WaitReason, MAX_GOAL_PROVIDER_RETRIES,
};
use xharness_session::{
    Message, ProviderFailure, ToolCall, ToolOutcome, ToolResultData, TurnEndReason,
};

async fn finish(store: &Arc<dyn Store>, turn: u32, reason: TurnEndReason) -> GoalController {
    let s = store.load("report-gate").await.unwrap().unwrap();
    store
        .append(
            "report-gate",
            s.revision(),
            vec![EventData::TurnEnd { turn, reason }.into()],
        )
        .await
        .unwrap();
    let c = GoalController::new(store.clone(), "report-gate");
    c.settle(None).await.unwrap();
    c
}
fn transient(after: Option<u64>) -> TurnEndReason {
    TurnEndReason::Failed {
        error: "temporary provider outage".into(),
        provider_failure: Some(ProviderFailure {
            retryable: true,
            http_status: Some(503),
            retry_after_ms: after,
        }),
    }
}
async fn next_claim(store: &Arc<dyn Store>, turn: u32) {
    let inbox = DurableInbox::open(store.clone(), SessionHeader::new("report-gate"))
        .await
        .unwrap();
    let claim = inbox.prepare_claim(InboxTarget::NextTurn).await.unwrap();
    let s = store.load("report-gate").await.unwrap().unwrap();
    let mut events = GoalController::claim_events(&s, &claim.messages, turn).unwrap();
    events.extend(claim.messages.iter().map(|m| {
        EventData::UserMessage {
            message: m.message.clone(),
            surface_replace: None,
        }
        .into()
    }));
    inbox
        .commit_claim(claim, vec![EventData::TurnStart { turn }.into()], events)
        .await
        .unwrap();
}

#[tokio::test]
async fn retry_deadline_survives_jsonl_restart_and_only_enqueues_once() {
    use xharness_session_jsonl::JsonlSessionStore;
    let dir = std::env::temp_dir().join(format!(
        "xh-goal-retry-{}-{}",
        std::process::id(),
        crate::state::now_ms()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let (store, _, _) =
        fixture_with_store(Arc::new(JsonlSessionStore::new(&dir).unwrap()), 20).await;
    let c = finish(&store, 1, transient(Some(17_000))).await;
    let state = c.state().await.unwrap().unwrap();
    let retry = state.retry.clone().unwrap();
    let s = store.load("report-gate").await.unwrap().unwrap();
    let ended = s
        .events()
        .iter()
        .find(|e| matches!(e.data(), EventData::TurnEnd { turn: 1, .. }))
        .unwrap()
        .timestamp_ms;
    assert_eq!(retry.retry_at_ms, ended + 17_000);
    assert_eq!(
        state.empty_report_rounds, 0,
        "network wait is not missing substantive progress"
    );
    assert_eq!(
        c.reconcile_at(false, retry.retry_at_ms - 1).await.unwrap(),
        GoalDecision::Wait {
            reason: WaitReason::NetworkBackoff
        }
    );
    store.flush("report-gate").await.unwrap();
    drop(c);
    drop(store);
    let store: Arc<dyn Store> = Arc::new(JsonlSessionStore::new(&dir).unwrap());
    let c = GoalController::new(store.clone(), "report-gate");
    assert_eq!(c.state().await.unwrap().unwrap().retry, Some(retry.clone()));
    let restored = store.load("report-gate").await.unwrap().unwrap();
    let mut forged = restored.events().to_vec();
    let event = forged.last_mut().unwrap();
    let EventData::GoalExecution { change } = event.event.data_mut() else {
        panic!("expected settlement")
    };
    change.state.retry.as_mut().unwrap().retry_at_ms += 1;
    assert!(
        xharness_session::Session::restore(restored.header().clone(), restored.revision(), forged)
            .is_err(),
        "retry deadline must be derived from the authoritative turn closer"
    );
    assert_eq!(
        c.reconcile_at(false, retry.retry_at_ms - 1).await.unwrap(),
        GoalDecision::Wait {
            reason: WaitReason::NetworkBackoff
        }
    );
    assert!(matches!(
        c.reconcile_at(false, retry.retry_at_ms).await.unwrap(),
        GoalDecision::Continue { .. }
    ));
    assert_eq!(
        c.reconcile_at(false, retry.retry_at_ms + 1).await.unwrap(),
        GoalDecision::Wait {
            reason: WaitReason::ContinuationPending
        }
    );
    let inbox = DurableInbox::open(store.clone(), SessionHeader::new("report-gate"))
        .await
        .unwrap();
    assert_eq!(inbox.snapshot().await.unwrap().next_turn().len(), 1);
    assert_eq!(c.state().await.unwrap().unwrap().rounds_started, 1);
    next_claim(&store, 2).await;
    let c = finish(&store, 2, TurnEndReason::Completed).await;
    assert!(
        c.state().await.unwrap().unwrap().retry.is_none(),
        "successful turn resets consecutive failure count"
    );
    drop(c);
    drop(inbox);
    drop(store);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn repeated_failures_back_off_then_pause_with_reason_and_keep_round_accounting() {
    let (store, _, _) = fixture_with_store(Arc::new(MemorySessionStore::default()), 20).await;
    for turn in 1..=MAX_GOAL_PROVIDER_RETRIES + 1 {
        let c = finish(&store, turn, transient(None)).await;
        let s = c.state().await.unwrap().unwrap();
        let r = s.retry.unwrap();
        assert_eq!(r.attempts, turn);
        assert_eq!(s.rounds_started, u64::from(turn));
        let end = store
            .load("report-gate")
            .await
            .unwrap()
            .unwrap()
            .events()
            .iter()
            .rev()
            .find(|e| matches!(e.data(), EventData::TurnEnd {turn:t,..} if *t==turn))
            .unwrap()
            .timestamp_ms;
        assert_eq!(r.retry_at_ms - end, 5_000 * (1u64 << (turn - 1)));
        if turn <= MAX_GOAL_PROVIDER_RETRIES {
            assert_eq!(
                c.reconcile_at(false, r.retry_at_ms - 1).await.unwrap(),
                GoalDecision::Wait {
                    reason: WaitReason::NetworkBackoff
                }
            );
            assert!(matches!(
                c.reconcile_at(false, r.retry_at_ms).await.unwrap(),
                GoalDecision::Continue { .. }
            ));
            next_claim(&store, turn + 1).await;
        } else {
            assert!(matches!(
                c.reconcile_at(false, r.retry_at_ms).await.unwrap(),
                GoalDecision::Pause {
                    reason: PauseReason::ExecutionError,
                    ..
                }
            ));
            let s = c.state().await.unwrap().unwrap();
            assert!(s
                .pause_detail
                .as_deref()
                .unwrap()
                .contains("exhausted after 5 retries"));
            assert_eq!(s.definition.snapshot.phase, GoalPhase::Paused);
        }
    }
}

#[tokio::test]
async fn permanent_and_legacy_failures_never_retry_even_if_text_says_network() {
    for provider_failure in [
        None,
        Some(ProviderFailure {
            retryable: false,
            http_status: Some(401),
            retry_after_ms: Some(5),
        }),
    ] {
        let (store, _, _) = fixture().await;
        let c = finish(
            &store,
            1,
            TurnEndReason::Failed {
                error: "network retryable timeout (not classification)".into(),
                provider_failure,
            },
        )
        .await;
        assert!(c.state().await.unwrap().unwrap().retry.is_none());
        assert!(matches!(
            c.reconcile().await.unwrap(),
            GoalDecision::Pause {
                reason: PauseReason::ExecutionError,
                ..
            }
        ));
    }
}

#[tokio::test]
async fn user_pause_and_user_input_take_priority_over_an_expired_retry() {
    let (store, _, _) = fixture().await;
    let c = finish(&store, 1, transient(None)).await;
    let due = c.state().await.unwrap().unwrap().retry.unwrap().retry_at_ms;
    let inbox = DurableInbox::open(store.clone(), SessionHeader::new("report-gate"))
        .await
        .unwrap();
    inbox
        .append(
            InboxTarget::NextTurn,
            xharness_session::InboxMessage::user("new-scope", "do this instead"),
        )
        .await
        .unwrap();
    assert_eq!(
        c.reconcile_at(false, due).await.unwrap(),
        GoalDecision::Wait {
            reason: WaitReason::UserPriority
        }
    );
    c.pause().await.unwrap();
    assert_eq!(
        c.reconcile_at(false, due + 1).await.unwrap(),
        GoalDecision::Idle {
            reason: IdleReason::Paused
        }
    );
    assert_eq!(
        inbox.snapshot().await.unwrap().next_turn()[0].id,
        "new-scope"
    );
    assert_eq!(c.state().await.unwrap().unwrap().rounds_started, 1);
}

#[tokio::test]
async fn unknown_tool_outcome_prevents_provider_recovery() {
    let (store, _, _) = fixture().await;
    let s = store.load("report-gate").await.unwrap().unwrap();
    let call = ToolCall {
        id: "uncertain-write".into(),
        name: "write".into(),
        arguments_json: "{}".into(),
        ..Default::default()
    };
    let mut assistant = Message::assistant("");
    assistant.tool_calls.push(call.clone());
    store
        .append(
            "report-gate",
            s.revision(),
            vec![
                EventData::StepStart { turn: 1, step: 1 }.into(),
                EventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message: assistant,
                    usage: None,
                }
                .into(),
                EventData::ToolCall {
                    turn: 1,
                    step: 1,
                    call,
                }
                .into(),
                EventData::ToolResult {
                    turn: 1,
                    step: 1,
                    result: ToolResultData {
                        call_id: "uncertain-write".into(),
                        outcome: ToolOutcome::OutcomeUnknown,
                        content: "write outcome unknown".into(),
                        metadata: None,
                    },
                }
                .into(),
                EventData::StepEnd { turn: 1, step: 1 }.into(),
            ],
        )
        .await
        .unwrap();
    let c = finish(&store, 1, transient(None)).await;
    assert!(c.state().await.unwrap().unwrap().retry.is_none());
    assert!(matches!(
        c.reconcile().await.unwrap(),
        GoalDecision::Pause { .. }
    ));
}

#[tokio::test]
async fn blocking_and_nonblocking_questions_remain_answerable_but_only_required_ones_gate_goal() {
    for blocks in [None, Some(true), Some(false)] {
        let (store, _, _) = fixture().await;
        let mut args = json!({"questions":[{"id":"scope","header":"Scope","question":"Which deployment target?"}]});
        if let Some(blocks) = blocks {
            args["questions"][0]["blocksGoal"] = json!(blocks);
        }
        let call = ToolCall {
            id: "ask-target".into(),
            name: "ask_user_question".into(),
            arguments_json: args.to_string(),
            ..Default::default()
        };
        let invocation=serde_json::from_value(json!({"interactionId":"question:ask-target","executionId":"ask-target","request":args})).unwrap();
        let mut assistant = Message::assistant("");
        assistant.tool_calls.push(call.clone());
        let s = store.load("report-gate").await.unwrap().unwrap();
        store
            .append(
                "report-gate",
                s.revision(),
                vec![
                    EventData::StepStart { turn: 1, step: 1 }.into(),
                    EventData::AssistantMessage {
                        turn: 1,
                        step: 1,
                        message: assistant,
                        usage: None,
                    }
                    .into(),
                    EventData::ToolCall {
                        turn: 1,
                        step: 1,
                        call,
                    }
                    .into(),
                    EventData::QuestionRequested { invocation }.into(),
                    EventData::QuestionDeferred {
                        interaction_id: "question:ask-target".into(),
                    }
                    .into(),
                    EventData::ToolResult {
                        turn: 1,
                        step: 1,
                        result: ToolResultData::success(
                            "ask-target",
                            r#"{"status":"deferred","unansweredQuestionIds":["scope"]}"#,
                        ),
                    }
                    .into(),
                    EventData::StepEnd { turn: 1, step: 1 }.into(),
                ],
            )
            .await
            .unwrap();
        let c = finish(&store, 1, TurnEndReason::Completed).await;
        let s = store.load("report-gate").await.unwrap().unwrap();
        // Full journal replay, not a pre-computed state snapshot.
        let logged = serde_json::from_str(&serde_json::to_string(s.events()).unwrap()).unwrap();
        let replay =
            xharness_session::Session::restore(s.header().clone(), s.revision(), logged).unwrap();
        assert!(xharness_session::has_unanswered_deferred_question(
            replay.events()
        ));
        assert_eq!(replay.pending_user_questions().len(), 1);
        let d = c.reconcile().await.unwrap();
        if blocks == Some(false) {
            assert!(matches!(d, GoalDecision::Continue { .. }));
            assert_eq!(
                execution_projection(&store.load("report-gate").await.unwrap().unwrap())["state"],
                "queued"
            );
        } else {
            assert_eq!(
                d,
                GoalDecision::Wait {
                    reason: WaitReason::Answer
                }
            );
            assert_eq!(execution_projection(&s)["state"], "awaiting_answer");
        }
        let s = store.load("report-gate").await.unwrap().unwrap();
        store
            .append(
                "report-gate",
                s.revision(),
                vec![EventData::QuestionCancelled {
                    interaction_id: "question:ask-target".into(),
                    reason: "user closed".into(),
                }
                .into()],
            )
            .await
            .unwrap();
        assert!(
            !xharness_session::has_unanswered_blocking_deferred_question(
                store.load("report-gate").await.unwrap().unwrap().events()
            )
        );
    }
}

struct OutageThenReport(AtomicUsize);
#[async_trait]
impl xharness_core::ModelProvider for OutageThenReport {
    async fn stream(
        &self,
        _: xharness_core::ProviderRequest,
        _: tokio_util::sync::CancellationToken,
    ) -> Result<xharness_core::ProviderStream, xharness_core::ProviderError> {
        use xharness_core::{FinishReason, ProviderError, ProviderEvent};
        let step = self.0.fetch_add(1, Ordering::SeqCst);
        // Default Core gives the initial call two short retries. All three fail.
        if step < 3 {
            return Err(ProviderError::http(503, "temporary test outage"));
        }
        let events = if step == 3 {
            vec![
            Ok(ProviderEvent::ToolCallDelta {index:0,id:"recovered-report".into(),name:"goal".into(),arguments_delta:json!({"action":"report","report":{"status":"complete","summary":"outage recovered","evidence":[{"kind":"artifact","reference":"test://verified"}]}}).to_string()}),
            Ok(ProviderEvent::Completed {finish_reason:Some(FinishReason::ToolCalls),usage:None,provider_items:vec![]}),
        ]
        } else {
            vec![
                Ok(ProviderEvent::TextDelta("Recovered".into())),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::Stop),
                    usage: None,
                    provider_items: vec![],
                }),
            ]
        };
        Ok(Box::pin(futures::stream::iter(events)))
    }
}
#[tokio::test]
async fn actual_host_watcher_resumes_after_exhausted_core_retries_without_user_input() {
    use crate::{BasicHost, DurableLoopAgentRuntime, HostConfig};
    use std::time::Duration;
    use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let model = Arc::new(OutageThenReport(AtomicUsize::new(0)));
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "test",
        "test",
        Some(model.clone()),
        Arc::new(NoTools),
        Arc::new(xharness_core::IdentityContextPolicy),
        store.clone(),
        Arc::new(xharness_agent::MemoryLeaseManager::default()),
        128,
    ));
    let mut config = HostConfig::new(std::env::temp_dir());
    config.provider_id = "test".into();
    config.model_id = "test".into();
    let host = BasicHost::with_agent_runtime(config, runtime);
    host.start_background_turn_listener();
    for (method, args) in [
        (RpcMethod::SessionCreate, json!({"sessionId":"report-gate"})),
        (
            RpcMethod::GoalCreate,
            json!({"sessionId":"report-gate","objective":"recover test outage","maxGoalRounds":3}),
        ),
    ] {
        assert!(matches!(
            host.call(
                RpcId::new(format!("{method:?}")),
                method,
                args,
                tokio_util::sync::CancellationToken::new()
            )
            .await,
            RpcResult::Success { .. }
        ));
    }
    let mut observed_wait = false;
    tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            let s = store.load("report-gate").await.unwrap().unwrap();
            let projection = execution_projection(&s);
            if projection["state"] == "network_backoff" {
                observed_wait = true;
                let state = execution_state(&s).unwrap();
                assert_eq!(state.definition.snapshot.phase, GoalPhase::Active);
                assert_eq!(state.rounds_started, 1);
            }
            if projection["state"] == "awaiting_confirmation" {
                let state = execution_state(&s).unwrap();
                assert_eq!(state.rounds_started, 2);
                assert!(state.retry.is_none());
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(observed_wait);
    assert_eq!(model.0.load(Ordering::SeqCst), 5);
    host.agent_runtime.shutdown(Duration::from_secs(1)).await;
}

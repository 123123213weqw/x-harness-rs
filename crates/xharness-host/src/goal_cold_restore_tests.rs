//! Real Host restoration of a settled Goal, not just controller replay.
use super::*;
use crate::{AgentRuntime, BasicHost, DurableLoopAgentRuntime, HostConfig};
use std::{path::PathBuf, time::Duration};
use xharness_core::{FinishReason, ModelProvider, ProviderEvent};
use xharness_session::{Message, ProviderFailure, ToolCall, ToolResultData, TurnEndReason};
use xharness_session_jsonl::JsonlSessionStore;

struct HistoryDir(PathBuf);
impl HistoryDir {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "xh-goal-cold-{label}-{}-{}",
            std::process::id(),
            crate::state::now_ms()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for HistoryDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn seed_closed_user_confirm_goal(store: &Arc<dyn Store>, reason: TurnEndReason) {
    crate::prepare_goal_session(
        store.as_ref(),
        &GoalBootstrapSpec {
            operation_id: "cold-bootstrap".into(),
            session_id: "report-gate".into(),
            goal_id: "cold-goal".into(),
            objective: "verify cold restoration".into(),
            acceptance_criteria: vec![],
            max_goal_rounds: 5,
            created_at_ms: 1,
            workspace: std::env::temp_dir().to_str().unwrap().into(),
            provider: "test".into(),
            model: "test".into(),
            reasoning_effort: None,
            context_window_tokens: None,
            permission: PermissionPreset::WorkspaceWrite,
        },
        false,
    )
    .await
    .unwrap();
    let controller = GoalController::new(store.clone(), "report-gate");
    let session = store.load("report-gate").await.unwrap().unwrap();
    // Explicit persisted policy: future product defaults must not silently
    // remove the legacy user-confirmation restoration regression.
    controller
        .enable(session.revision(), vec![], VerificationMode::UserConfirm, 3)
        .await
        .unwrap();
    controller.reconcile().await.unwrap();
    let inbox = DurableInbox::open(store.clone(), SessionHeader::new("report-gate"))
        .await
        .unwrap();
    let claim = inbox.prepare_claim(InboxTarget::NextTurn).await.unwrap();
    let session = store.load("report-gate").await.unwrap().unwrap();
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

    let body = report(
        GoalReportStatus::Complete,
        vec![GoalEvidence::Artifact {
            reference: "test://cold-verified".into(),
        }],
    );
    let call = ToolCall {
        id: "before-restart-report".into(),
        name: "goal".into(),
        arguments_json: json!({"action":"report","report":body}).to_string(),
        ..Default::default()
    };
    let mut message = Message::assistant("");
    message.tool_calls.push(call.clone());
    let mut result = ToolResultData::success(call.id.clone(), "Report recorded");
    result.metadata = Some(json!({"goalReport":body}));
    let session = store.load("report-gate").await.unwrap().unwrap();
    store
        .append(
            "report-gate",
            session.revision(),
            vec![
                EventData::StepStart { turn: 1, step: 1 }.into(),
                EventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message,
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
                    result,
                }
                .into(),
                EventData::StepEnd { turn: 1, step: 1 }.into(),
                EventData::TurnEnd { turn: 1, reason }.into(),
            ],
        )
        .await
        .unwrap();
    controller.settle(None).await.unwrap();
    store.flush("report-gate").await.unwrap();
}

#[derive(Default)]
struct ReportAfterRestart(AtomicUsize);
#[async_trait]
impl ModelProvider for ReportAfterRestart {
    async fn stream(
        &self,
        _: xharness_core::ProviderRequest,
        _: tokio_util::sync::CancellationToken,
    ) -> Result<xharness_core::ProviderStream, xharness_core::ProviderError> {
        let call = self.0.fetch_add(1, Ordering::SeqCst);
        let events = if call == 0 {
            vec![
                Ok(ProviderEvent::ToolCallDelta {
                    index: 0,
                    id: "after-restart-report".into(),
                    name: "goal".into(),
                    arguments_delta: json!({"action":"report","report":{
                        "status":"complete","summary":"cold retry recovered",
                        "evidence":[{"kind":"artifact","reference":"test://cold-verified"}]
                    }})
                    .to_string(),
                }),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::ToolCalls),
                    usage: None,
                    provider_items: vec![],
                }),
            ]
        } else {
            vec![Ok(ProviderEvent::Completed {
                finish_reason: Some(FinishReason::Stop),
                usage: None,
                provider_items: vec![],
            })]
        };
        Ok(Box::pin(futures::stream::iter(events)))
    }
}

fn restored_runtime(
    store: Arc<dyn Store>,
    model: Arc<ReportAfterRestart>,
) -> Arc<DurableLoopAgentRuntime> {
    Arc::new(DurableLoopAgentRuntime::new(
        "test",
        "test",
        Some(model),
        Arc::new(NoTools),
        Arc::new(xharness_core::IdentityContextPolicy),
        store,
        Arc::new(xharness_agent::MemoryLeaseManager::default()),
        128,
    ))
}
fn restored_host(runtime: Arc<DurableLoopAgentRuntime>) -> Arc<BasicHost> {
    let mut config = HostConfig::new(std::env::temp_dir());
    config.provider_id = "test".into();
    config.model_id = "test".into();
    BasicHost::with_agent_runtime(config, runtime)
}

#[tokio::test]
async fn cold_host_restores_retry_after_complete_report_in_failed_turn() {
    let dir = HistoryDir::new("retry");
    let store: Arc<dyn Store> = Arc::new(JsonlSessionStore::new(&dir.0).unwrap());
    seed_closed_user_confirm_goal(
        &store,
        TurnEndReason::Failed {
            error: "connection lost after report".into(),
            provider_failure: Some(ProviderFailure {
                retryable: true,
                http_status: Some(503),
                retry_after_ms: Some(5_000),
            }),
        },
    )
    .await;
    drop(store);
    let store: Arc<dyn Store> = Arc::new(JsonlSessionStore::new(&dir.0).unwrap());
    let session = store.load("report-gate").await.unwrap().unwrap();
    let state = execution_state(&session).unwrap();
    assert!(state.pending.is_none() && state.running.is_none());
    assert!(xharness_agent::InboxProjection::from_session(&session)
        .unwrap()
        .next_turn()
        .is_empty());
    assert_eq!(
        state.latest_turn.as_ref().unwrap().outcome,
        GoalTurnOutcome::Failed
    );
    assert_eq!(execution_projection(&session)["state"], "network_backoff");
    let retry = state.retry.as_ref().unwrap();
    assert_eq!(retry.attempts, 1);
    let model = Arc::new(ReportAfterRestart::default());
    let runtime = restored_runtime(store.clone(), model.clone());
    assert!(
        runtime.needs_session_resume(&session).unwrap(),
        "settled failures must attach the recovery watcher on cold start"
    );
    let host = restored_host(runtime.clone());
    let restored = host.restore_from_store(store.clone()).await.unwrap();
    assert!(restored.issues.is_empty(), "{restored:?}");
    assert!(
        store
            .catalog_entry("report-gate")
            .await
            .unwrap()
            .unwrap()
            .needs_recovery,
        "catalog must not mark retryable work safely idle"
    );
    // Reconciliation must honor the persisted deadline before any model call.
    assert_eq!(
        GoalController::new(store.clone(), "report-gate")
            .reconcile_at(false, retry.retry_at_ms - 1)
            .await
            .unwrap(),
        xharness_session::goal::GoalDecision::Wait {
            reason: xharness_session::goal::WaitReason::NetworkBackoff
        }
    );
    assert_eq!(model.0.load(Ordering::SeqCst), 0);
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let session = store.load("report-gate").await.unwrap().unwrap();
            if execution_projection(&session)["state"] == "awaiting_confirmation" {
                let state = execution_state(&session).unwrap();
                assert_eq!(state.rounds_started, 2);
                assert!(state.retry.is_none());
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    assert_eq!(
        model.0.load(Ordering::SeqCst),
        2,
        "one continuation, no duplicate retry or completion loop"
    );
    let session = store.load("report-gate").await.unwrap().unwrap();
    assert!(!runtime.needs_session_resume(&session).unwrap());
    host.stop_background_listeners();
    runtime.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn cold_host_does_not_resume_successful_user_confirmation_report() {
    let dir = HistoryDir::new("confirmation");
    let store: Arc<dyn Store> = Arc::new(JsonlSessionStore::new(&dir.0).unwrap());
    seed_closed_user_confirm_goal(&store, TurnEndReason::Completed).await;
    drop(store);
    let store: Arc<dyn Store> = Arc::new(JsonlSessionStore::new(&dir.0).unwrap());
    let session = store.load("report-gate").await.unwrap().unwrap();
    assert_eq!(
        execution_projection(&session)["state"],
        "awaiting_confirmation"
    );
    let revision = session.revision();
    let model = Arc::new(ReportAfterRestart::default());
    let runtime = restored_runtime(store.clone(), model.clone());
    assert!(!runtime.needs_session_resume(&session).unwrap());
    let host = restored_host(runtime.clone());
    let restored = host.restore_from_store(store.clone()).await.unwrap();
    assert!(restored.issues.is_empty(), "{restored:?}");
    assert!(
        !store
            .catalog_entry("report-gate")
            .await
            .unwrap()
            .unwrap()
            .needs_recovery
    );
    tokio::time::sleep(Duration::from_millis(1_100)).await;
    assert_eq!(model.0.load(Ordering::SeqCst), 0);
    assert_eq!(
        store.load("report-gate").await.unwrap().unwrap().revision(),
        revision
    );
    host.stop_background_listeners();
    runtime.shutdown(Duration::from_secs(1)).await;
}

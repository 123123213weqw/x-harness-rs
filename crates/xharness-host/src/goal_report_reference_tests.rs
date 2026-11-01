//! Incoming-report admission regressions; historical journal validation is unchanged.
use super::*;
use crate::{GoalBootstrapSpec, NoTools, PermissionPreset, SessionToolFactory};
use async_trait::async_trait;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use xharness_agent::{DurableInbox, GoalController};
use xharness_session::{InboxTarget, MemorySessionStore, SessionHeader};
use xharness_tools::{ToolExecutor, ToolRegistry, ToolRequest};

#[derive(Default)]
struct ReferenceTools {
    pending: AtomicBool,
    validations: AtomicUsize,
    readiness_checks: AtomicUsize,
}
#[async_trait]
impl SessionToolFactory for ReferenceTools {
    async fn executor(
        &self,
        _: &str,
        _: &str,
        _: PermissionPreset,
    ) -> Result<ToolExecutor, String> {
        Ok(ToolExecutor::new(Arc::new(ToolRegistry::new())))
    }
    async fn validate_goal_references(
        &self,
        owner: &str,
        refs: &[GoalEvidence],
    ) -> Result<(), String> {
        self.validations.fetch_add(1, Ordering::SeqCst);
        for evidence in refs {
            let reference = match evidence {
                GoalEvidence::Agent { reference } | GoalEvidence::Job { reference } => reference,
                _ => continue,
            };
            if owner != "report-gate"
                || !["agent-owned", "job-owned", "job-failed"].contains(&reference.as_str())
            {
                return Err("resource missing or belongs to another conversation".into());
            }
        }
        Ok(())
    }
    async fn goal_dependencies(&self, _: &str, refs: &[GoalEvidence]) -> Result<bool, String> {
        self.readiness_checks.fetch_add(1, Ordering::SeqCst);
        if refs
            .iter()
            .any(|r| matches!(r, GoalEvidence::Job { reference } if reference == "job-failed"))
        {
            return Err("required job failed".into());
        }
        Ok(self.pending.load(Ordering::SeqCst))
    }
}

async fn fixture() -> (Arc<dyn Store>, GoalDefinition, u64) {
    fixture_with_store(Arc::new(MemorySessionStore::default()), 3).await
}
async fn fixture_with_store(
    store: Arc<dyn Store>,
    rounds: u64,
) -> (Arc<dyn Store>, GoalDefinition, u64) {
    crate::prepare_goal_session(
        store.as_ref(),
        &GoalBootstrapSpec {
            operation_id: "report-gate-bootstrap".into(),
            session_id: "report-gate".into(),
            goal_id: "report-goal".into(),
            objective: "verify a report".into(),
            acceptance_criteria: vec![],
            max_goal_rounds: rounds,
            created_at_ms: 1,
            workspace: std::env::temp_dir()
                .join("goal-report-workspace")
                .to_str()
                .unwrap()
                .into(),
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
    let state = execution_state(&store.load("report-gate").await.unwrap().unwrap()).unwrap();
    (store, state.definition, state.activation_epoch)
}

#[tokio::test]
async fn report_visibility_requires_exact_goal_input_or_same_open_turn_recovery() {
    use crate::goal_report_tool::fence;
    use xharness_session::{Message, Revision, Session};
    let (store, _, _) = fixture().await;
    let running = store.load("report-gate").await.unwrap().unwrap();
    let claim_revision = running
        .events()
        .iter()
        .find(|event| matches!(event.data(), EventData::TurnStart { turn: 1 }))
        .unwrap()
        .revision;
    let prefix = running
        .events()
        .iter()
        .take_while(|event| event.revision < claim_revision)
        .cloned()
        .collect::<Vec<_>>();
    let revision = prefix.last().map_or(Revision::ZERO, |event| event.revision);
    let pending = Session::restore(running.header().clone(), revision, prefix).unwrap();
    let intent = execution_state(&pending).unwrap().pending.unwrap();
    let input = pending
        .events()
        .iter()
        .rev()
        .find_map(|event| match event.data() {
            EventData::AgentInboxSpliced { inserted, .. } => inserted
                .iter()
                .find(|m| m.id == intent.message_id)
                .map(|m| m.message.clone()),
            _ => None,
        })
        .unwrap();
    assert!(fence(&pending, std::slice::from_ref(&input)).is_some());
    assert!(
        fence(&pending, &[]).is_none(),
        "pending work is not an open-turn recovery"
    );
    assert!(
        fence(&pending, &[Message::user(input.content.clone())]).is_none(),
        "quoted Goal text is not an admitted Goal input"
    );
    assert!(fence(&pending, &[input, Message::user("new user scope")]).is_none());
    assert!(
        fence(&running, &[]).is_some(),
        "approval/question recovery keeps the same report capability"
    );
    assert!(fence(&running, &[Message::user("ordinary prompt")]).is_none());
    let mut closed = running.clone();
    closed
        .append(
            closed.revision(),
            EventData::TurnEnd {
                turn: 1,
                reason: xharness_session::TurnEndReason::Completed,
            },
        )
        .unwrap();
    assert!(
        fence(&closed, &[]).is_none(),
        "a settled turn cannot regain the report tool"
    );
    GoalController::new(store.clone(), "report-gate")
        .pause()
        .await
        .unwrap();
    assert!(fence(&store.load("report-gate").await.unwrap().unwrap(), &[]).is_none());
    assert!(fence(&Session::new(SessionHeader::new("ordinary")).unwrap(), &[]).is_none());
}

#[tokio::test]
async fn report_schema_and_handler_have_no_lifecycle_or_plan_actions() {
    let (store, definition, epoch) = fixture().await;
    let original = store.load("report-gate").await.unwrap().unwrap();
    let registry = Arc::new(ToolRegistry::new());
    let spec = crate::goal_report_tool::spec(
        store.clone(),
        Arc::new(NoTools),
        "report-gate".into(),
        (definition, epoch),
    );
    assert_eq!(
        spec.batch_policy,
        xharness_tools::ToolBatchPolicy::Standalone
    );
    registry.register(spec).await.unwrap();
    let definitions = registry.definitions().await;
    assert_eq!(definitions.len(), 1);
    assert_eq!(definitions[0].name, "goal_report");
    let fields = definitions[0].parameters["properties"].as_object().unwrap();
    assert_eq!(fields.len(), 5);
    assert!(
        !fields.contains_key("action")
            && !fields.contains_key("objective")
            && !fields.contains_key("items")
    );
    let executor = ToolExecutor::new(registry);
    for action in [
        "create",
        "get",
        "update",
        "pause",
        "resume",
        "complete",
        "clear",
        "update_plan",
        "report",
    ] {
        let result=executor.execute(ToolRequest::new("goal_report",json!({"action":action,"status":"progress","summary":"must reject mixed lifecycle fields"}).to_string())).await;
        assert!(!result.is_ok(), "{action}");
    }
    let cancelled = tokio_util::sync::CancellationToken::new();
    cancelled.cancel();
    let result = executor
        .execute(
            ToolRequest::new(
                "goal_report",
                json!({"status":"progress","summary":"cancelled"}).to_string(),
            )
            .with_cancellation(cancelled),
        )
        .await;
    assert!(!result.is_ok());
    assert_eq!(store.load("report-gate").await.unwrap().unwrap(), original);
}

fn report(status: GoalReportStatus, evidence: Vec<GoalEvidence>) -> GoalReportBody {
    GoalReportBody {
        status,
        summary: "inspect the result".into(),
        remaining: vec![],
        evidence,
        blocked_reason: (status == GoalReportStatus::Blocked).then(|| GoalBlockReason {
            code: "needs_help".into(),
            message: "resource failed".into(),
        }),
    }
}

#[tokio::test]
async fn all_report_statuses_reject_annotated_unknown_and_foreign_resource_ids_without_mutation() {
    let (store, definition, epoch) = fixture().await;
    let tools = Arc::new(ReferenceTools::default());
    let factory: Arc<dyn SessionToolFactory> = tools.clone();
    let original = store.load("report-gate").await.unwrap().unwrap();
    for status in [
        GoalReportStatus::Progress,
        GoalReportStatus::Blocked,
        GoalReportStatus::Complete,
    ] {
        for kind in ["agent", "job"] {
            for value in [
                "owned (running)",
                " owned",
                "owned\n",
                "owned\u{200b}",
                "missing",
                "foreign",
            ] {
                let reference = format!("{kind}-{value}");
                let evidence = if kind == "agent" {
                    GoalEvidence::Agent { reference }
                } else {
                    GoalEvidence::Job { reference }
                };
                let result = validate_report(
                    &store,
                    &factory,
                    "report-gate",
                    definition.clone(),
                    epoch,
                    report(status, vec![evidence]),
                )
                .await;
                assert!(result.is_err(), "{status:?}/{kind}/{value}");
                assert!(result
                    .unwrap_err()
                    .to_string()
                    .contains("invalid_goal_reference"));
                assert_eq!(store.load("report-gate").await.unwrap().unwrap(), original);
            }
        }
    }
    assert_eq!(tools.readiness_checks.load(Ordering::SeqCst), 0);
    assert!(xharness_agent::recorded_goal_report(&original).is_none());
}

#[tokio::test]
async fn progress_and_blocked_reports_validate_identity_not_readiness_or_artifact_text() {
    let (store, definition, epoch) = fixture().await;
    let tools = Arc::new(ReferenceTools::default());
    tools.pending.store(true, Ordering::SeqCst);
    let factory: Arc<dyn SessionToolFactory> = tools.clone();
    for status in [GoalReportStatus::Progress, GoalReportStatus::Blocked] {
        let output = validate_report(
            &store,
            &factory,
            "report-gate",
            definition.clone(),
            epoch,
            report(
                status,
                vec![
                    GoalEvidence::Agent {
                        reference: "agent-owned".into(),
                    },
                    GoalEvidence::Job {
                        reference: "job-owned".into(),
                    },
                    GoalEvidence::Job {
                        reference: "job-failed".into(),
                    },
                    GoalEvidence::Artifact {
                        reference: "folder with spaces/result (verified).txt".into(),
                    },
                ],
            ),
        )
        .await
        .unwrap();
        assert!(output.metadata.unwrap().get("goalReport").is_some());
    }
    assert_eq!(tools.validations.load(Ordering::SeqCst), 2);
    assert_eq!(tools.readiness_checks.load(Ordering::SeqCst), 0);
    assert!(validate_report(
        &store,
        &factory,
        "report-gate",
        definition.clone(),
        epoch,
        report(
            GoalReportStatus::Complete,
            vec![GoalEvidence::Job {
                reference: "job-owned".into()
            }]
        )
    )
    .await
    .is_err());
    tools.pending.store(false, Ordering::SeqCst);
    validate_report(
        &store,
        &factory,
        "report-gate",
        definition,
        epoch,
        report(
            GoalReportStatus::Complete,
            vec![GoalEvidence::Job {
                reference: "job-owned".into(),
            }],
        ),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn unsupported_factories_fail_closed_only_for_resource_references() {
    let (store, definition, epoch) = fixture().await;
    let factory: Arc<dyn SessionToolFactory> = Arc::new(NoTools);
    assert!(validate_report(
        &store,
        &factory,
        "report-gate",
        definition.clone(),
        epoch,
        report(
            GoalReportStatus::Progress,
            vec![GoalEvidence::Agent {
                reference: "agent-owned".into()
            }]
        )
    )
    .await
    .is_err());
    validate_report(
        &store,
        &factory,
        "report-gate",
        definition,
        epoch,
        report(
            GoalReportStatus::Complete,
            vec![GoalEvidence::Artifact {
                reference: "https://example.test/a?b=1".into(),
            }],
        ),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn registered_goal_report_can_correct_a_bad_reference_in_the_same_active_turn() {
    let (store, definition, epoch) = fixture().await;
    let tools: Arc<dyn SessionToolFactory> = Arc::new(ReferenceTools::default());
    let registry = Arc::new(ToolRegistry::new());
    registry
        .register(crate::goal_report_tool::spec(
            store.clone(),
            tools,
            "report-gate".into(),
            (definition, epoch),
        ))
        .await
        .unwrap();
    let executor = ToolExecutor::new(registry);
    for (reference, expected_ok) in [("agent-owned (running)", false), ("agent-owned", true)] {
        let result = executor.execute(ToolRequest::new("goal_report", json!({
            "status":"progress", "summary":"child is running", "evidence":[{"kind":"agent","reference":reference}]
        }).to_string())).await;
        assert_eq!(result.is_ok(), expected_ok);
        if !expected_ok {
            assert!(result.output.is_none());
        }
        let state = execution_state(&store.load("report-gate").await.unwrap().unwrap()).unwrap();
        assert_eq!(state.definition.snapshot.phase, GoalPhase::Active);
        assert_eq!(state.rounds_started, 1);
        assert!(state.running.is_some() && state.pause_reason.is_none());
    }
}

#[tokio::test]
async fn host_agent_reference_validation_checks_exact_identity_and_parent_not_running_state() {
    use crate::{BasicHost, HostConfig};
    use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
    let host = BasicHost::new(
        HostConfig::new(std::env::temp_dir()),
        None,
        Arc::new(NoTools),
    );
    for id in ["report-gate", "agent-owned"] {
        assert!(matches!(
            host.call(
                RpcId::new(id),
                RpcMethod::SessionCreate,
                json!({"sessionId":id}),
                tokio_util::sync::CancellationToken::new()
            )
            .await,
            RpcResult::Success { .. }
        ));
    }
    {
        let mut state = host.state.write().await;
        let child = state.sessions.get_mut("agent-owned").unwrap();
        child.parent_session_id = Some("report-gate".into());
        child.dispatch_paused = true;
    }
    host.validate_goal_agent_reference("report-gate", "agent-owned")
        .await
        .unwrap();
    assert!(host
        .validate_goal_agent_reference("other", "agent-owned")
        .await
        .is_err());
    assert!(host
        .validate_goal_agent_reference("report-gate", "agent-owned (stopped)")
        .await
        .is_err());
    assert!(host
        .validate_goal_agent_reference("report-gate", "missing")
        .await
        .is_err());
    assert!(
        host.goal_agent_dependency("report-gate", "agent-owned")
            .await
            .is_err(),
        "readiness guard stays separate"
    );
}

struct CorrectingModel(AtomicUsize);
#[async_trait]
impl xharness_core::ModelProvider for CorrectingModel {
    async fn stream(
        &self,
        request: xharness_core::ProviderRequest,
        _: tokio_util::sync::CancellationToken,
    ) -> Result<xharness_core::ProviderStream, xharness_core::ProviderError> {
        use xharness_core::{FinishReason, ProviderEvent};
        let step = self.0.fetch_add(1, Ordering::SeqCst);
        let events = match step {
            0 | 1 => {
                if step == 1 {
                    assert!(
                        request
                            .messages
                            .iter()
                            .any(|m| m.role == xharness_session::MessageRole::Tool
                                && m.content.contains("invalid_goal_reference")),
                        "model must receive the gate error"
                    );
                }
                let (status, reference) = if step == 0 {
                    ("progress", "agent-owned (running)")
                } else {
                    ("complete", "agent-owned")
                };
                vec![
                    Ok(ProviderEvent::ToolCallDelta {
                        index: 0, id: format!("report-gate-{step}"), name: "goal_report".into(),
                        arguments_delta: json!({
                            "status":status,"summary":"verified fixture","evidence":[{"kind":"agent","reference":reference}]
                        })
                        .to_string(),
                    }),
                    Ok(ProviderEvent::Completed { finish_reason:Some(FinishReason::ToolCalls), usage:None, provider_items:vec![] }),
                ]
            }
            2 => vec![
                Ok(ProviderEvent::TextDelta("Report corrected.".into())),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::Stop),
                    usage: None,
                    provider_items: vec![],
                }),
            ],
            _ => panic!("unexpected extra model request"),
        };
        Ok(Box::pin(futures::stream::iter(events)))
    }
}

#[tokio::test]
async fn actual_host_loop_delivers_reference_error_and_accepts_correction_without_pausing() {
    use crate::{BasicHost, DurableLoopAgentRuntime, HostConfig};
    use std::time::Duration;
    use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let model = Arc::new(CorrectingModel(AtomicUsize::new(0)));
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "test",
        "test",
        Some(model.clone()),
        Arc::new(ReferenceTools::default()),
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
    let cancel = tokio_util::sync::CancellationToken::new();
    assert!(matches!(
        host.call(
            RpcId::new("create-session"),
            RpcMethod::SessionCreate,
            json!({"sessionId":"report-gate"}),
            cancel.clone()
        )
        .await,
        RpcResult::Success { .. }
    ));
    assert!(matches!(
        host.call(
            RpcId::new("create-goal"),
            RpcMethod::GoalCreate,
            json!({"sessionId":"report-gate","objective":"verify fixture","maxGoalRounds":2}),
            cancel
        )
        .await,
        RpcResult::Success { .. }
    ));
    let session = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let s = store.load("report-gate").await.unwrap().unwrap();
            if execution_projection(&s)["state"] == "complete" {
                break s;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let state = execution_state(&session).unwrap();
    assert_eq!(state.rounds_started, 1);
    assert_eq!(state.definition.snapshot.phase, GoalPhase::Complete);
    assert!(state.pause_reason.is_none());
    let report = state.latest_turn.unwrap().report.unwrap();
    assert_eq!(report.status, GoalReportStatus::Complete);
    assert_eq!(
        report.evidence,
        [GoalEvidence::Agent {
            reference: "agent-owned".into()
        }]
    );
    assert_eq!(model.0.load(Ordering::SeqCst), 3);
    assert_eq!(session.events().iter().filter(|e| matches!(e.data(), EventData::ToolResult { result, .. }
        if result.outcome == xharness_session::ToolOutcome::Error && result.content.contains("invalid_goal_reference"))).count(), 1);
    host.agent_runtime.shutdown(Duration::from_secs(1)).await;
}

#[path = "goal_resilience_tests.rs"]
mod resilience;

#[path = "goal_cold_restore_tests.rs"]
mod cold_restore;

//! Product adapter for the existing Goal controller, tool registry and UI protocol.
use crate::runtime::PreparedDurableTurn;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use tokio::sync::{broadcast, Mutex, RwLock};
use xharness_agent::{AgentEvent, DurableAgentHandle, GoalReportBody};
use xharness_session::{goal::*, EventData, Session, SessionEvent, Store};
use xharness_tools::{ToolHandlerError, ToolOutput};

pub(crate) struct GoalBridge {
    pub host: std::sync::OnceLock<std::sync::Weak<crate::BasicHost>>,
    pub handles: RwLock<HashMap<String, DurableAgentHandle>>,
    pub prepared: Mutex<HashMap<(String, String), PreparedDurableTurn>>,
    pub notices: broadcast::Sender<xharness_schedule::ScheduleDeliveryNotice>,
    pub changes: broadcast::Sender<String>,
    pub shutdown: tokio_util::sync::CancellationToken,
    pub watched: Mutex<HashSet<String>>,
    announced: Mutex<HashSet<(String, String)>>,
}
impl Default for GoalBridge {
    fn default() -> Self {
        Self {
            host: Default::default(),
            handles: RwLock::new(HashMap::new()),
            prepared: Mutex::new(HashMap::new()),
            notices: broadcast::channel(2048).0,
            changes: broadcast::channel(2048).0,
            shutdown: Default::default(),
            watched: Default::default(),
            announced: Default::default(),
        }
    }
}
impl GoalBridge {
    pub async fn prepare(
        &self,
        id: &str,
        input_id: &str,
        events: broadcast::Receiver<AgentEvent>,
    ) -> Result<(), String> {
        let handle = self
            .handles
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or("goal has no runtime handle")?;
        let mut announced = self.announced.lock().await;
        if !announced.insert((id.into(), input_id.into())) {
            return Ok(());
        }
        let mut prepared = self.prepared.lock().await;
        let key = (id.to_owned(), input_id.to_owned());
        if let std::collections::hash_map::Entry::Vacant(entry) = prepared.entry(key) {
            entry.insert(PreparedDurableTurn {
                handle,
                events,
                input_id: input_id.to_owned(),
            });
            let _ = self
                .notices
                .send(xharness_schedule::ScheduleDeliveryNotice {
                    session_id: id.into(),
                    work_id: input_id.into(),
                });
        }
        Ok(())
    }
}

pub(crate) async fn validate_report(
    store: &Arc<dyn Store>,
    tools: &Arc<dyn crate::SessionToolFactory>,
    id: &str,
    definition: GoalDefinition,
    epoch: u64,
    body: GoalReportBody,
) -> Result<ToolOutput, ToolHandlerError> {
    let session = store
        .load(id)
        .await
        .map_err(|e| ToolHandlerError::new(e.to_string()))?
        .ok_or_else(|| ToolHandlerError::new("session missing"))?;
    let state = execution_state(&session).ok_or_else(|| ToolHandlerError::new("no active Goal"))?;
    if !state.definition.execution_enabled
        || state.definition.definition_revision != definition.definition_revision
        || state.definition.snapshot.id != definition.snapshot.id
        || state.activation_epoch != epoch
        || state.running.is_none()
    {
        return Err(ToolHandlerError::new(
            "Goal changed or paused; report is stale",
        ));
    }
    let r = GoalReport {
        goal_id: definition.snapshot.id,
        definition_revision: definition.definition_revision,
        turn: state.running.as_ref().unwrap().turn,
        report_id: "validation".into(),
        status: body.status,
        summary: body.summary.clone(),
        remaining: body.remaining.clone(),
        evidence: body.evidence.clone(),
        blocked_reason: body.blocked_reason.clone(),
    };
    r.validate()
        .map_err(|e| ToolHandlerError::new(e.to_string()))?;
    if body.status == GoalReportStatus::Complete && body.evidence.is_empty() {
        return Err(ToolHandlerError::new(
            "complete requires evidence references",
        ));
    }
    if body.status == GoalReportStatus::Complete
        && tools
            .goal_dependencies(id, &body.evidence)
            .await
            .map_err(ToolHandlerError::new)?
    {
        return Err(ToolHandlerError::new(
            "required background work is still running; report progress instead",
        ));
    }
    Ok(ToolOutput {
        content:
            "Goal report recorded; finish this turn. Completion still requires user confirmation."
                .into(),
        metadata: Some(json!({"goalReport":body})),
    })
}

pub(crate) fn enable_event(
    snapshot: xharness_session::GoalSnapshot,
    rounds: u64,
    old: Option<GoalExecutionState>,
    criteria: Vec<String>,
) -> Result<SessionEvent, String> {
    if old
        .as_ref()
        .is_some_and(|s| s.running.is_some() || s.pending.is_some())
    {
        return Err("wait for current Goal turn/queued work to settle before resuming".into());
    }
    let state = GoalExecutionState {
        definition: GoalDefinition {
            definition_revision: snapshot.revision,
            snapshot,
            acceptance_criteria: criteria,
            execution_enabled: true,
            verification: VerificationMode::UserConfirm,
        },
        activation_epoch: old
            .as_ref()
            .map_or(1, |s| s.activation_epoch.saturating_add(1)),
        rounds_started: rounds,
        pending: None,
        running: None,
        latest_turn: None,
        admitted: old.map_or_else(Default::default, |s| s.admitted),
        empty_report_rounds: 0,
        empty_report_limit: 3,
        review: None,
        pause_reason: None,
        pause_detail: None,
    };
    state.definition.validate().map_err(|e| e.to_string())?;
    Ok(EventData::GoalExecution {
        change: Box::new(GoalExecutionChange {
            version: 2,
            operation: GoalExecutionOperation::Enable,
            state,
        }),
    }
    .into())
}

pub(crate) fn execution_projection(session: &Session) -> Value {
    let Some(s) = execution_state(session) else {
        return json!({"enabled":false,"state":"disabled"});
    };
    let report = s.latest_turn.as_ref().and_then(|t| t.report.as_ref());
    let awaiting = report.is_some_and(|r| r.status == GoalReportStatus::Complete)
        && s.definition.snapshot.phase == xharness_session::GoalPhase::Active
        && s.running.is_none()
        && s.review.is_none();
    let state = if s.definition.snapshot.phase == xharness_session::GoalPhase::Complete {
        "complete"
    } else if s.definition.snapshot.phase == xharness_session::GoalPhase::Blocked {
        "blocked"
    } else if s.definition.snapshot.phase == xharness_session::GoalPhase::Paused {
        "paused"
    } else if !s.definition.execution_enabled {
        "disabled"
    } else if !session.pending_tool_approvals().is_empty() {
        "awaiting_approval"
    } else if !session.recoverable_user_questions().is_empty()
        || xharness_session::has_unanswered_deferred_question(session.events())
    {
        "awaiting_answer"
    } else if s.running.is_some() {
        "running"
    } else if awaiting {
        "awaiting_confirmation"
    } else if s.pending.is_some() {
        "queued"
    } else {
        "waiting"
    };
    json!({"enabled":s.definition.execution_enabled,"state":state,"roundsStarted":s.rounds_started,"maxGoalRounds":s.definition.snapshot.max_goal_rounds,"pauseReason":s.pause_reason,"pauseDetail":s.pause_detail,"report":report,"acceptanceCriteria":s.definition.acceptance_criteria})
}

impl crate::BasicHost {
    pub(crate) async fn activate_goal(&self, id: &str) -> Result<(), xharness_api::RpcError> {
        if !self.agent_runtime.has_authoritative_sessions() {
            return Ok(());
        }
        if !self
            .agent_runtime
            .authoritative_session(id)
            .await
            .map_err(crate::driver::agent_runtime_error)?
            .as_ref()
            .and_then(execution_state)
            .is_some_and(|s| s.definition.execution_enabled)
        {
            return Ok(());
        }
        let request = {
            let state = self.state.read().await;
            let record = state
                .sessions
                .get(id)
                .ok_or_else(|| xharness_api::RpcError::internal("session missing"))?;
            crate::AgentSessionRequest {
                session_id: id.into(),
                cwd: record.cwd.clone(),
                route: crate::ModelRoute {
                    provider: record.model.provider.clone(),
                    model: record.model.model.clone(),
                    reasoning_effort: record.model.reasoning_effort.clone(),
                    context_window_tokens: record.model.context_window_tokens,
                },
                permission: record.permission_preset,
                prompt: Some(
                    state
                        .prompt_assembly(id)
                        .map_err(xharness_api::RpcError::internal)?,
                ),
            }
        };
        self.agent_runtime
            .resume_session(request)
            .await
            .map_err(crate::driver::agent_runtime_error)?;
        Ok(())
    }
    pub(crate) async fn goal_enable_events(
        &self,
        id: &str,
        goal: &crate::state::GoalState,
    ) -> Result<Vec<SessionEvent>, xharness_api::RpcError> {
        if !self.agent_runtime.has_authoritative_sessions() {
            return Ok(vec![]);
        }
        let session = self
            .agent_runtime
            .authoritative_session(id)
            .await
            .map_err(crate::driver::agent_runtime_error)?;
        // Enabling during an ordinary turn only records authorization. The
        // controller's open-turn fence waits until that turn has settled; it
        // must not require an idle Host when invoked by the goal tool itself.
        // enable_event below still rejects a running/pending Goal generation.
        let route = {
            let state = self.state.read().await;
            let r = state
                .sessions
                .get(id)
                .ok_or_else(|| xharness_api::RpcError::internal("session missing"))?;
            crate::ModelRoute {
                provider: r.model.provider.clone(),
                model: r.model.model.clone(),
                reasoning_effort: r.model.reasoning_effort.clone(),
                context_window_tokens: r.model.context_window_tokens,
            }
        };
        if !self.agent_runtime.can_route(&route) {
            return Err(crate::driver::agent_runtime_error(
                crate::AgentRuntimeError::ModelUnavailable {
                    provider: route.provider,
                    model: route.model,
                },
            ));
        }
        let old = session
            .as_ref()
            .and_then(execution_state)
            .filter(|s| s.definition.snapshot.id == goal.id);
        let criteria = old
            .as_ref()
            .map_or_else(Vec::new, |s| s.definition.acceptance_criteria.clone());
        Ok(vec![enable_event(
            goal.snapshot(),
            goal.rounds_started,
            old,
            criteria,
        )
        .map_err(xharness_api::RpcError::internal)?])
    }
}

impl crate::BasicHost {
    /// Only a child owned by this parent can be a required Goal dependency.
    pub async fn goal_agent_dependency(&self, caller: &str, child: &str) -> Result<bool, String> {
        let state = self.state.read().await;
        let record = state
            .sessions
            .get(child)
            .ok_or("required child agent is missing")?;
        if record.parent_session_id.as_deref() != Some(caller) {
            return Err("required child agent is not owned by this Goal session".into());
        }
        if record.dispatch_paused {
            return Err("required child agent is stopped; resume it or revise the Goal".into());
        }
        if record.running || !record.projected_queue.is_empty() {
            return Ok(true);
        }
        drop(state);
        let session = self
            .agent_runtime
            .authoritative_session(child)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("required child history unavailable")?;
        let end = session.events().iter().rev().find_map(|e| match e.data() {
            EventData::TurnEnd { reason, .. } => Some(reason),
            _ => None,
        });
        match end {
            Some(xharness_session::TurnEndReason::Completed) => Ok(false),
            Some(_) => Err("required child did not finish successfully; inspect its result".into()),
            None => Ok(true),
        }
    }
}

impl crate::BasicHost {
    /// Reuse the durable Inbox splice format: invalidate queued Goal work in the same control commit.
    pub(crate) async fn invalidate_goal_pending(
        &self,
        id: &str,
        goal: Option<&crate::state::GoalState>,
    ) -> Result<Vec<SessionEvent>, xharness_api::RpcError> {
        let Some(session) = self
            .agent_runtime
            .authoritative_session(id)
            .await
            .map_err(crate::driver::agent_runtime_error)?
        else {
            return Ok(vec![]);
        };
        let Some(mut state) = execution_state(&session) else {
            return Ok(vec![]);
        };
        let Some(pending) = state.pending.take() else {
            return Ok(vec![]);
        };
        let inbox = xharness_agent::InboxProjection::from_session(&session)
            .map_err(|e| xharness_api::RpcError::internal(e.to_string()))?;
        let mut events = Vec::new();
        if let Some(start) = inbox
            .next_turn()
            .iter()
            .position(|m| m.id == pending.message_id)
        {
            events.push(
                EventData::AgentInboxSpliced {
                    target: xharness_session::InboxTarget::NextTurn,
                    start,
                    removed_count: 1,
                    inserted: vec![],
                    outcome: Some(xharness_session::InboxSpliceOutcome::Cancelled),
                }
                .into(),
            )
        }
        if let Some(goal) = goal {
            state.definition.snapshot = goal.snapshot();
            state.definition.execution_enabled = false;
            events.push(
                EventData::GoalExecution {
                    change: Box::new(GoalExecutionChange {
                        version: 2,
                        operation: GoalExecutionOperation::Discard,
                        state,
                    }),
                }
                .into(),
            );
        }
        Ok(events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BasicHost, DurableLoopAgentRuntime, HostConfig, NoTools};
    use async_trait::async_trait;
    use std::{
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };
    use tokio_util::sync::CancellationToken;
    use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
    use xharness_core::{
        FinishReason, IdentityContextPolicy, ModelProvider, ProviderError, ProviderEvent,
        ProviderRequest, ProviderStream,
    };
    struct Model {
        rounds: AtomicUsize,
        status: &'static str,
    }
    #[async_trait]
    impl ModelProvider for Model {
        async fn stream(
            &self,
            r: ProviderRequest,
            _: CancellationToken,
        ) -> Result<ProviderStream, ProviderError> {
            let events = if r.step == 1 {
                assert!(r.tools.iter().any(|t| t.name == "goal"));
                let n = self.rounds.fetch_add(1, Ordering::SeqCst) + 1;
                assert!(!r.tools.iter().any(|t| t.name == "goal_report"));
                if self.status == "create_goal" && n == 1 {
                    return Ok(Box::pin(futures::stream::iter(vec![
                        Ok(ProviderEvent::ToolCallDelta {index:0,id:"create-from-normal-turn".into(),name:"goal".into(),arguments_delta:json!({"action":"create","objective":"Implement parser and test","max_goal_rounds":2}).to_string()}),
                        Ok(ProviderEvent::Completed {finish_reason:Some(FinishReason::ToolCalls),usage:None,provider_items:vec![]}),
                    ])));
                }
                let status = if self.status == "create_goal" {
                    "complete"
                } else if self.status == "three" {
                    if n < 3 {
                        "progress"
                    } else {
                        "complete"
                    }
                } else {
                    self.status
                };
                let mut body = json!({"status":status,"summary":format!("round {n}"),"evidence":[{"kind":"artifact","reference":"tests/result.txt"}]});
                if self.status == "dependency" {
                    body["status"] = json!(if n == 1 { "progress" } else { "complete" });
                    if n == 1 {
                        body["evidence"] = json!([{"kind":"job","reference":"required-job"}]);
                    }
                }
                if status == "blocked" {
                    body["blocked_reason"] =
                        json!({"code":"needs_input","message":"Need a choice"});
                }
                vec![
                    Ok(ProviderEvent::ToolCallDelta {
                        index: 0,
                        id: format!("report-{n}"),
                        name: "goal".into(),
                        arguments_delta: json!({"action":"report","report":body}).to_string(),
                    }),
                    Ok(ProviderEvent::Completed {
                        finish_reason: Some(FinishReason::ToolCalls),
                        usage: None,
                        provider_items: vec![],
                    }),
                ]
            } else {
                vec![
                    Ok(ProviderEvent::TextDelta("finished this round".into())),
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
    async fn setup(status: &'static str) -> (Arc<BasicHost>, Arc<dyn Store>, Arc<Model>) {
        setup_with_tools(status, Arc::new(NoTools)).await
    }
    async fn setup_with_tools(
        status: &'static str,
        tools: Arc<dyn crate::SessionToolFactory>,
    ) -> (Arc<BasicHost>, Arc<dyn Store>, Arc<Model>) {
        let store: Arc<dyn Store> = Arc::new(xharness_session::MemorySessionStore::default());
        let model = Arc::new(Model {
            rounds: AtomicUsize::new(0),
            status,
        });
        let rt = Arc::new(DurableLoopAgentRuntime::new(
            "test",
            "goal",
            Some(model.clone()),
            tools,
            Arc::new(IdentityContextPolicy),
            store.clone(),
            Arc::new(xharness_agent::MemoryLeaseManager::default()),
            2048,
        ));
        let mut config = HostConfig::new(std::env::temp_dir());
        config.provider_id = "test".into();
        config.model_id = "goal".into();
        let host = BasicHost::with_agent_runtime(config, rt);
        host.start_background_turn_listener();
        call(
            &host,
            "session",
            RpcMethod::SessionCreate,
            json!({"sessionId":"g"}),
        )
        .await;
        (host, store, model)
    }
    async fn call(host: &BasicHost, id: &str, method: RpcMethod, payload: Value) -> Value {
        match host
            .call(RpcId::new(id), method, payload, CancellationToken::new())
            .await
        {
            RpcResult::Success { value } => value.unwrap_or(Value::Null),
            e => panic!("RPC failed: {e:?}"),
        }
    }
    async fn wait(host: &BasicHost, store: &Arc<dyn Store>, state: &str) -> Session {
        let outcome = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let session = store.load("g").await.unwrap().unwrap();
                host.sync_authoritative_session("g").await.unwrap();
                if execution_projection(&session)["state"] == state
                    && !host.state.read().await.sessions["g"].running
                {
                    break session;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        outcome.expect("goal did not converge")
    }
    async fn goal_executor(
        host: &Arc<BasicHost>,
        store: Arc<dyn Store>,
    ) -> xharness_tools::ToolExecutor {
        let registry = Arc::new(xharness_tools::ToolRegistry::new());
        registry
            .register(crate::goal_tool::spec(
                Arc::downgrade(host),
                store,
                Arc::new(NoTools),
                "g".into(),
                None,
            ))
            .await
            .unwrap();
        xharness_tools::ToolExecutor::new(registry)
    }
    #[tokio::test]
    async fn ordinary_provider_turn_sees_goal_and_can_create_then_auto_report() {
        let (host, store, model) = setup("create_goal").await;
        call(&host,"user-create",RpcMethod::SessionPrompt,json!({"sessionId":"g","mode":"queue","content":[{"type":"text","text":"Set a persistent goal: implement parser and test it"}]})).await;
        let session = wait(&host, &store, "awaiting_confirmation").await;
        let goal = execution_state(&session).unwrap();
        assert_eq!(
            goal.rounds_started, 1,
            "ordinary creator turn must not count as a Goal round"
        );
        assert_eq!(model.rounds.load(Ordering::SeqCst), 2);
        assert!(session.events().iter().any(|e|matches!(e.data(),EventData::ToolCall{call,..} if call.name=="goal" && call.arguments_json.contains("create"))));
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }

    #[tokio::test]
    async fn ordinary_goal_tool_creates_reads_updates_replays_and_fences_user_changes() {
        let (host, store, _) = setup("complete").await;
        let ex = goal_executor(&host, store.clone()).await;
        let request = xharness_tools::ToolRequest::new(
            "goal",
            json!({"action":"create","objective":"Check parser","max_goal_rounds":4}).to_string(),
        )
        .with_execution_id("create-tool-1")
        .unwrap();
        let first = ex.execute(request.clone()).await;
        assert!(first.is_ok(), "{first:?}");
        wait(&host, &store, "awaiting_confirmation").await;
        let replay = ex.execute(request).await;
        assert!(replay.is_ok(), "{replay:?}");
        assert_eq!(first.output, replay.output);
        let get = ex
            .execute(xharness_tools::ToolRequest::new(
                "goal",
                r#"{"action":"get"}"#,
            ))
            .await;
        let value: Value = serde_json::from_str(&get.output.as_ref().unwrap().content).unwrap();
        assert_eq!(value["goal"]["objective"], "Check parser");
        assert_eq!(value["execution"]["state"], "awaiting_confirmation");
        let old_ref = value["ref"].clone();
        let edit = ex
            .execute(xharness_tools::ToolRequest::new(
                "goal",
                json!({"action":"update","ref":old_ref,"max_goal_rounds":8}).to_string(),
            ))
            .await;
        assert!(edit.is_ok(), "{edit:?}");
        wait(&host, &store, "disabled").await;
        let stale = ex
            .execute(xharness_tools::ToolRequest::new(
                "goal",
                json!({"action":"resume","ref":old_ref}).to_string(),
            ))
            .await;
        assert!(
            !stale.is_ok(),
            "stale tool must not overwrite user/CAS changes"
        );
        let current = host.state.read().await.goals["g"].clone();
        assert_eq!(current.max_goal_rounds, 8);
        assert_eq!(current.phase, xharness_session::GoalPhase::Active);
        assert_eq!(current.execution.as_ref().unwrap()["enabled"], false);
        let resume = ex
            .execute(xharness_tools::ToolRequest::new(
                "goal",
                json!({"action":"resume","ref":{"id":current.id,"revision":current.revision}})
                    .to_string(),
            ))
            .await;
        assert!(resume.is_ok(), "{resume:?}");
        wait(&host, &store, "awaiting_confirmation").await;
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }
    #[tokio::test]
    async fn ordinary_goal_tool_rejects_invalid_actions_identity_and_cancel_without_mutation() {
        let (host, store, _) = setup("complete").await;
        let ex = goal_executor(&host, store).await;
        for args in [
            json!({"action":"get","session_id":"other"}),
            json!({"action":"complete"}),
            json!({"action":"clear"}),
            json!({"action":"create","objective":"   "}),
            json!({"action":"create","objective":"x","max_goal_rounds":0}),
            json!({"action":"create","objective":"x","executionEnabled":false}),
            json!({"action":"pause"}),
            json!({"action":"get","objective":"mixed fields"}),
            json!({"action":"report","report":{"status":"complete","summary":"done","evidence":[{"kind":"artifact","reference":"test.py"}]}}),
        ] {
            let result = ex
                .execute(xharness_tools::ToolRequest::new("goal", args.to_string()))
                .await;
            assert!(!result.is_ok(), "{args}: {result:?}");
        }
        let cancel = CancellationToken::new();
        cancel.cancel();
        let result = ex
            .execute(
                xharness_tools::ToolRequest::new(
                    "goal",
                    json!({"action":"create","objective":"must not create"}).to_string(),
                )
                .with_cancellation(cancel),
            )
            .await;
        assert!(!result.is_ok());
        assert!(!host.state.read().await.goals.contains_key("g"));
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }

    #[tokio::test]
    async fn product_three_rounds_report_confirm_clear_and_live_history() {
        let (host, store, model) = setup("three").await;
        let mut frames = host.agent_runtime.subscribe_background_turns().unwrap();
        let payload = json!({"sessionId":"g","objective":"Implement parser and check tests","maxGoalRounds":5});
        let first = call(&host, "create", RpcMethod::GoalCreate, payload.clone()).await;
        assert_eq!(
            call(&host, "create", RpcMethod::GoalCreate, payload).await,
            first
        );
        let session = wait(&host, &store, "awaiting_confirmation").await;
        assert_eq!(model.rounds.load(Ordering::SeqCst), 3);
        assert_eq!(execution_state(&session).unwrap().rounds_started, 3);
        assert_eq!(std::iter::from_fn(|| frames.try_recv().ok()).count(), 3);
        let projected = host.state.read().await.goals["g"].projection();
        assert_eq!(
            projected,
            crate::restore::restored_goal(&session)
                .unwrap()
                .projection()
        );
        let reference =
            json!({"id":projected["goal"]["id"],"revision":projected["goal"]["revision"]});
        let done = call(
            &host,
            "confirm",
            RpcMethod::GoalComplete,
            json!({"sessionId":"g","ref":reference}),
        )
        .await;
        assert_eq!(
            wait(&host, &store, "complete").await.revision(),
            store.load("g").await.unwrap().unwrap().revision()
        );
        call(
            &host,
            "clear",
            RpcMethod::GoalClear,
            json!({"sessionId":"g","ref":done["ref"]}),
        )
        .await;
        assert!(execution_state(&store.load("g").await.unwrap().unwrap()).is_none());
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }
    #[tokio::test]
    async fn blocked_visible_resume_preserves_rounds_and_stale_ref_rejected() {
        let (host, store, model) = setup("blocked").await;
        let initial = call(
            &host,
            "create",
            RpcMethod::GoalCreate,
            json!({"sessionId":"g","objective":"Need help","maxGoalRounds":4}),
        )
        .await;
        let session = wait(&host, &store, "blocked").await;
        let g = crate::restore::restored_goal(&session).unwrap();
        assert_eq!(g.blocked_reason.as_ref().unwrap().message, "Need a choice");
        assert!(!host
            .call(
                RpcId::new("stale"),
                RpcMethod::GoalResume,
                json!({"sessionId":"g","ref":initial["ref"]}),
                CancellationToken::new()
            )
            .await
            .is_ok());
        call(
            &host,
            "resume",
            RpcMethod::GoalResume,
            json!({"sessionId":"g","ref":{"id":g.id,"revision":g.revision}}),
        )
        .await;
        tokio::time::timeout(Duration::from_secs(5), async {
            while model.rounds.load(Ordering::SeqCst) < 2 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            execution_state(&wait(&host, &store, "blocked").await)
                .unwrap()
                .rounds_started,
            2
        );
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }
    #[tokio::test]
    async fn slash_command_uses_real_goal_rpc_and_budget_stops_without_fake_completion() {
        let (host, store, _) = setup("progress").await;
        let created = call(
            &host,
            "create",
            RpcMethod::GoalCreate,
            json!({"sessionId":"g","objective":"Keep checking","maxGoalRounds":2}),
        )
        .await;
        assert!(created["ref"].is_object());
        let session = wait(&host, &store, "paused").await;
        assert_eq!(
            execution_projection(&session)["pauseReason"],
            "round_budget"
        );
        let result = host
            .call_dynamic(
                RpcId::new("show"),
                "commands/execute",
                json!({"args":{"agentId":"g","line":"/goal","images":[]}}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(result.is_ok());
        let invalid = host
            .call_dynamic(
                RpcId::new("invalid-budget"),
                "commands/execute",
                json!({"args":{"agentId":"g","line":"/goal budget invalid","images":[]}}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(
            matches!(invalid,RpcResult::Success{value:Some(ref v)} if v["result"]["kind"]=="error")
        );
        let edited = host
            .call_dynamic(
                RpcId::new("budget"),
                "commands/execute",
                json!({"args":{"agentId":"g","line":"/goal budget 4","images":[]}}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(
            matches!(edited,RpcResult::Success{value:Some(ref v)} if v["result"]["kind"]=="success")
        );
        let goal = crate::restore::restored_goal(&store.load("g").await.unwrap().unwrap()).unwrap();
        assert_eq!(goal.max_goal_rounds, 4);
        assert_eq!(goal.rounds_started, 2);
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }
    #[tokio::test]
    async fn report_registry_rejects_unknown_fields_missing_evidence_and_stale_goal() {
        let (host, store, _) = setup("complete").await;
        call(
            &host,
            "create",
            RpcMethod::GoalCreate,
            json!({"sessionId":"g","objective":"Check","maxGoalRounds":2}),
        )
        .await;
        let session = wait(&host, &store, "awaiting_confirmation").await;
        let state = execution_state(&session).unwrap();
        let registry = Arc::new(xharness_tools::ToolRegistry::new());
        registry
            .register(crate::goal_tool::spec(
                Arc::downgrade(&host),
                store.clone(),
                Arc::new(NoTools),
                "g".into(),
                Some((state.definition, state.activation_epoch)),
            ))
            .await
            .unwrap();
        let ex = xharness_tools::ToolExecutor::new(registry);
        for body in [
            json!({"status":"complete","summary":"ok","goal_id":"forged"}),
            json!({"status":"complete","summary":"ok"}),
            json!({"status":"progress","summary":"late"}),
        ] {
            let r = ex
                .execute(xharness_tools::ToolRequest::new(
                    "goal",
                    json!({"action":"report","report":body}).to_string(),
                ))
                .await;
            assert!(!r.is_ok(), "late or invalid report must fail");
        }
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }
    struct DependencyTools(std::sync::atomic::AtomicBool);
    #[async_trait]
    impl crate::SessionToolFactory for DependencyTools {
        async fn executor(
            &self,
            _: &str,
            _: &str,
            _: crate::PermissionPreset,
        ) -> Result<xharness_tools::ToolExecutor, String> {
            Ok(xharness_tools::ToolExecutor::new(Arc::new(
                xharness_tools::ToolRegistry::new(),
            )))
        }
        async fn goal_dependencies(&self, _: &str, refs: &[GoalEvidence]) -> Result<bool, String> {
            Ok(!refs.is_empty() && self.0.load(Ordering::SeqCst))
        }
    }
    #[tokio::test]
    async fn dependency_settlement_wakes_same_runtime_without_another_user_message() {
        let tools = Arc::new(DependencyTools(std::sync::atomic::AtomicBool::new(true)));
        let (host, store, model) = setup_with_tools("dependency", tools.clone()).await;
        call(
            &host,
            "create",
            RpcMethod::GoalCreate,
            json!({"sessionId":"g","objective":"Wait for required job","maxGoalRounds":5}),
        )
        .await;
        wait(&host, &store, "waiting").await;
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert_eq!(model.rounds.load(Ordering::SeqCst), 1);
        tools.0.store(false, Ordering::SeqCst);
        wait(&host, &store, "awaiting_confirmation").await;
        assert_eq!(model.rounds.load(Ordering::SeqCst), 2);
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }
    #[tokio::test]
    async fn startup_queued_goal_uses_background_bridge_once_not_user_queue() {
        let (old, store, model) = setup("complete").await;
        call(&old,"create",RpcMethod::GoalCreate,json!({"sessionId":"g","objective":"Check after restart","maxGoalRounds":4,"executionEnabled":false})).await;
        let c = xharness_agent::GoalController::new(store.clone(), "g");
        c.enable(
            store.load("g").await.unwrap().unwrap().revision(),
            vec![],
            VerificationMode::UserConfirm,
            3,
        )
        .await
        .unwrap();
        c.reconcile().await.unwrap();
        old.agent_runtime.shutdown(Duration::from_secs(1)).await;
        let runtime = Arc::new(DurableLoopAgentRuntime::new(
            "test",
            "goal",
            Some(model.clone()),
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            store.clone(),
            Arc::new(xharness_agent::MemoryLeaseManager::default()),
            2048,
        ));
        let mut config = HostConfig::new(std::env::temp_dir());
        config.provider_id = "test".into();
        config.model_id = "goal".into();
        let host = BasicHost::with_agent_runtime(config, runtime);
        let report = host.restore_from_store(store.clone()).await.unwrap();
        assert!(report.issues.is_empty(), "{:?}", report.issues);
        assert_eq!(
            report.resumed_pending_turns, 0,
            "Goal is not an ordinary user prompt"
        );
        let session = wait(&host, &store, "awaiting_confirmation").await;
        assert_eq!(execution_state(&session).unwrap().rounds_started, 1);
        assert_eq!(model.rounds.load(Ordering::SeqCst), 1);
        assert!(host.state.read().await.sessions["g"].queue.is_empty());
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }
    #[tokio::test]
    async fn pause_atomically_discards_queued_goal_before_resume() {
        let (host, store, model) = setup("complete").await;
        let created = call(
            &host,
            "create",
            RpcMethod::GoalCreate,
            json!({"sessionId":"g","objective":"Check","executionEnabled":false}),
        )
        .await;
        let c = xharness_agent::GoalController::new(store.clone(), "g");
        c.enable(
            store.load("g").await.unwrap().unwrap().revision(),
            vec![],
            VerificationMode::UserConfirm,
            3,
        )
        .await
        .unwrap();
        c.reconcile().await.unwrap();
        let paused = call(
            &host,
            "pause",
            RpcMethod::GoalPause,
            json!({"sessionId":"g","ref":created["ref"]}),
        )
        .await;
        let session = store.load("g").await.unwrap().unwrap();
        assert!(execution_state(&session).unwrap().pending.is_none());
        assert!(!xharness_agent::InboxProjection::from_session(&session)
            .unwrap()
            .has_pending());
        assert_eq!(model.rounds.load(Ordering::SeqCst), 0);
        call(
            &host,
            "resume",
            RpcMethod::GoalResume,
            json!({"sessionId":"g","ref":paused["ref"]}),
        )
        .await;
        assert_eq!(
            execution_state(&wait(&host, &store, "awaiting_confirmation").await)
                .unwrap()
                .rounds_started,
            1
        );
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }
    struct PreparingTools {
        entered: CancellationToken,
        release: CancellationToken,
    }
    #[async_trait]
    impl crate::SessionToolFactory for PreparingTools {
        async fn executor(
            &self,
            _: &str,
            _: &str,
            _: crate::PermissionPreset,
        ) -> Result<xharness_tools::ToolExecutor, String> {
            self.entered.cancel();
            self.release.cancelled().await;
            Ok(xharness_tools::ToolExecutor::new(Arc::new(
                xharness_tools::ToolRegistry::new(),
            )))
        }
    }
    #[tokio::test]
    async fn pause_during_preparation_settles_live_host_without_phantom_running() {
        let tools = Arc::new(PreparingTools {
            entered: CancellationToken::new(),
            release: CancellationToken::new(),
        });
        let (host, store, model) = setup_with_tools("complete", tools.clone()).await;
        let created = call(
            &host,
            "create",
            RpcMethod::GoalCreate,
            json!({"sessionId":"g","objective":"Do not start after pause"}),
        )
        .await;
        tokio::time::timeout(Duration::from_secs(2), tools.entered.cancelled())
            .await
            .unwrap();
        call(
            &host,
            "pause",
            RpcMethod::GoalPause,
            json!({"sessionId":"g","ref":created["ref"]}),
        )
        .await;
        tools.release.cancel();
        let session = wait(&host, &store, "paused").await;
        assert_eq!(model.rounds.load(Ordering::SeqCst), 0);
        assert_eq!(execution_state(&session).unwrap().rounds_started, 0);
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }
    #[tokio::test]
    async fn request_snapshot_is_on_demand_scoped_and_durable_host_does_not_cache_messages() {
        let (host, store, _) = setup_with_tools("complete", Arc::new(crate::NoTools)).await;
        call(
            &host,
            "create",
            RpcMethod::GoalCreate,
            json!({"sessionId":"g","objective":"Complete the fixture"}),
        )
        .await;
        let session = wait(&host, &store, "awaiting_confirmation").await;
        let seq = session
            .events()
            .iter()
            .find(|e| matches!(e.data(), EventData::RequestHeader { .. }))
            .unwrap()
            .seq;
        let result = host
            .call_dynamic(
                xharness_api::RpcId::new("snapshot"),
                "session.requestSnapshot",
                json!({"sessionId":"g","seq":seq}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let xharness_api::RpcResult::Success { value: Some(value) } = result else {
            panic!("snapshot failed")
        };
        assert!(!value["header"]["input"].as_array().unwrap().is_empty());
        assert!(host.state.read().await.sessions["g"].messages.is_empty());
        let exported = host
            .export_session("g", CancellationToken::new())
            .await
            .unwrap();
        let exported: Value = serde_json::from_slice(&exported.bytes).unwrap();
        assert!(!exported["session"]["messages"]
            .as_array()
            .unwrap()
            .is_empty());
        for payload in [
            json!({"sessionId":"missing","seq":seq}),
            json!({"sessionId":"g","seq":-1}),
            json!({"sessionId":"g","seq":999999}),
        ] {
            assert!(!host
                .call_dynamic(
                    xharness_api::RpcId::new("invalid"),
                    "session.requestSnapshot",
                    payload,
                    CancellationToken::new()
                )
                .await
                .unwrap()
                .is_ok());
        }
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }
}

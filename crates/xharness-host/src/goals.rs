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
    pub async fn retire_announcements(&self, id: &str) {
        self.announced
            .lock()
            .await
            .retain(|(session, _)| session != id);
    }

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
        || state.running.as_ref().is_none_or(|running| {
            running.intent.key.goal_id != definition.snapshot.id
                || running.intent.key.definition_revision != definition.definition_revision
                || running.intent.key.activation_epoch != epoch
        })
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
    // Validate incoming reports only, never tighten historical journal decoding.
    // Do not trim, split or guess a resource ID supplied by the model.
    for (index, evidence) in body.evidence.iter().enumerate() {
        let reference = match evidence {
            GoalEvidence::Agent { reference } | GoalEvidence::Job { reference } => reference,
            _ => continue,
        };
        if reference.is_empty()
            || reference.len() > 2048
            || !reference
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
        {
            return Err(ToolHandlerError::new(format!(
                "invalid_goal_reference: evidence[{index}].reference must be an exact resource ID, without whitespace or annotations; put explanations in summary and retry the report"
            )));
        }
    }
    tools
        .validate_goal_references(id, &body.evidence)
        .await
        .map_err(|error| ToolHandlerError::new(format!(
            "invalid_goal_reference: {error}; use exact existing resource IDs owned by this conversation and retry the report"
        )))?;
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
    let completion_note = match definition.verification {
        VerificationMode::AgentReport => "Goal report recorded; finish this turn. A valid complete report ends the Goal automatically after this turn settles normally.",
        VerificationMode::UserConfirm => "Goal report recorded; finish this turn. This Goal still requires user confirmation of completion.",
    };
    Ok(ToolOutput {
        content: completion_note.into(),
        metadata: Some(json!({"goalReport":body})),
        command_failure: None,
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
            // Preserve the persisted policy of an existing Goal; only new
            // executions default to accepting the model's completion report.
            verification: old
                .as_ref()
                .map_or(VerificationMode::AgentReport, |s| s.definition.verification),
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
        retry: None,
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
    let awaiting = s.definition.verification == VerificationMode::UserConfirm
        && s.latest_turn
            .as_ref()
            .is_some_and(|t| t.outcome == GoalTurnOutcome::Completed)
        && report.is_some_and(|r| r.status == GoalReportStatus::Complete)
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
        || xharness_session::has_unanswered_blocking_deferred_question(session.events())
    {
        "awaiting_answer"
    } else if s.running.is_some() {
        "running"
    } else if awaiting {
        "awaiting_confirmation"
    } else if s.pending.is_some() {
        "queued"
    } else if s
        .retry
        .as_ref()
        .is_some_and(|r| r.attempts <= MAX_GOAL_PROVIDER_RETRIES)
    {
        "network_backoff"
    } else {
        "waiting"
    };
    json!({"enabled":s.definition.execution_enabled,"state":state,"roundsStarted":s.rounds_started,"maxGoalRounds":s.definition.snapshot.max_goal_rounds,"pauseReason":s.pause_reason,"pauseDetail":s.pause_detail,"retry":s.retry,"report":report,"acceptanceCriteria":s.definition.acceptance_criteria,"verificationMode":s.definition.verification})
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
        let (mut request, sections) = {
            let state = self.state.read().await;
            let record = state
                .sessions
                .get(id)
                .ok_or_else(|| xharness_api::RpcError::internal("session missing"))?;
            (
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
                    prompt: None,
                },
                state
                    .prompt_sections(id)
                    .map_err(xharness_api::RpcError::internal)?,
            )
        };
        request.prompt = Some(
            self.assemble_prompt(request.cwd.clone(), sections)
                .await
                .map_err(xharness_api::RpcError::internal)?,
        );
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
        // must not require an idle Host for an explicit user command.
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

fn owned_goal_agent<'a>(
    state: &'a crate::state::HostState,
    caller: &str,
    child: &str,
) -> Result<&'a crate::state::SessionRecord, String> {
    let record = state
        .sessions
        .get(child)
        .ok_or("required child agent is missing")?;
    if record.parent_session_id.as_deref() != Some(caller) {
        return Err("required child agent is not owned by this Goal session".into());
    }
    Ok(record)
}

impl crate::BasicHost {
    /// Admission validates identity/ownership, not the child's execution outcome.
    pub async fn validate_goal_agent_reference(
        &self,
        caller: &str,
        child: &str,
    ) -> Result<(), String> {
        let state = self.state.read().await;
        owned_goal_agent(&state, caller, child).map(|_| ())
    }

    /// Only a child owned by this parent can be a required Goal dependency.
    pub async fn goal_agent_dependency(&self, caller: &str, child: &str) -> Result<bool, String> {
        let state = self.state.read().await;
        let record = owned_goal_agent(&state, caller, child)?;
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
            if self.status == "legacy_plan_retained" {
                self.rounds.fetch_add(1, Ordering::SeqCst);
                let notes = r
                    .messages
                    .iter()
                    .filter(|m| m.id.as_deref() == Some("session-working-plan-context"))
                    .collect::<Vec<_>>();
                assert!(
                    notes.is_empty(),
                    "retired goal.get hydration must not advertise an unavailable tool"
                );
                assert!(!r
                    .tools
                    .iter()
                    .any(|t| matches!(t.name.as_str(), "goal" | "goal_report" | "update_plan")));
                assert_eq!(
                    r.messages.last().unwrap().content,
                    "Only report; do not resume verification"
                );
                return Ok(Box::pin(futures::stream::iter(vec![
                    Ok(ProviderEvent::TextDelta(
                        "Verification is still pending; no execution requested".into(),
                    )),
                    Ok(ProviderEvent::Completed {
                        finish_reason: Some(FinishReason::Stop),
                        usage: None,
                        provider_items: vec![],
                    }),
                ])));
            }
            if self.status == "ordinary" || self.status == "retired_goal" {
                self.rounds.fetch_add(1, Ordering::SeqCst);
                assert!(!r.tools.iter().any(|t| t.name == "edit_goal_objective"));
                assert!(!r
                    .tools
                    .iter()
                    .any(|t| matches!(t.name.as_str(), "goal" | "goal_report" | "update_plan")));
                let events = if self.status == "retired_goal" && r.step == 1 {
                    let mut calls = Vec::new();
                    for (index, action) in [
                        "create",
                        "get",
                        "update",
                        "pause",
                        "resume",
                        "report",
                        "update_plan",
                    ]
                    .into_iter()
                    .enumerate()
                    {
                        calls.push(Ok(ProviderEvent::ToolCallDelta {
                            index, id: format!("retired-{action}"), name: "goal".into(),
                            arguments_delta: json!({"action":action,"objective":"must not create","plan_revision":0,"items":[]}).to_string(),
                        }));
                    }
                    calls.push(Ok(ProviderEvent::ToolCallDelta {index:7,id:"forged-report".into(),name:"goal_report".into(),arguments_delta:json!({"status":"complete","summary":"forged","evidence":[{"kind":"artifact","reference":"test://forged"}]}).to_string()}));
                    calls.push(Ok(ProviderEvent::Completed {
                        finish_reason: Some(FinishReason::ToolCalls),
                        usage: None,
                        provider_items: vec![],
                    }));
                    calls
                } else {
                    vec![
                        Ok(ProviderEvent::TextDelta(
                            "Use /goal to explicitly enable a persistent Goal.".into(),
                        )),
                        Ok(ProviderEvent::Completed {
                            finish_reason: Some(FinishReason::Stop),
                            usage: None,
                            provider_items: vec![],
                        }),
                    ]
                };
                return Ok(Box::pin(futures::stream::iter(events)));
            }
            let events = if r.step == 1 {
                assert!(!r.tools.iter().any(|t| t.name == "goal"));
                assert_eq!(
                    r.tools.iter().filter(|t| t.name == "goal_report").count(),
                    1
                );
                let n = self.rounds.fetch_add(1, Ordering::SeqCst) + 1;
                if self.status == "edit_objective" && n == 1 {
                    assert!(r.tools.iter().any(|t| t.name == "edit_goal_objective"));
                    return Ok(Box::pin(futures::stream::iter(vec![
                        Ok(ProviderEvent::ToolCallDelta {
                            index: 0, id: "revise-objective".into(), name: "edit_goal_objective".into(),
                            arguments_delta: json!({"objective":"Implement parser and test it\nPreserve the original acceptance requirements"}).to_string(),
                        }),
                        Ok(ProviderEvent::Completed { finish_reason: Some(FinishReason::ToolCalls), usage: None, provider_items: vec![] }),
                    ])));
                }
                if self.status == "text_only" {
                    return Ok(Box::pin(futures::stream::iter(vec![
                        Ok(ProviderEvent::TextDelta("All done".into())),
                        Ok(ProviderEvent::Completed {
                            finish_reason: Some(FinishReason::Stop),
                            usage: None,
                            provider_items: vec![],
                        }),
                    ])));
                }
                let status =
                    if self.status == "reported_then_failed" || self.status == "edit_objective" {
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
                        name: "goal_report".into(),
                        arguments_delta: body.to_string(),
                    }),
                    Ok(ProviderEvent::Completed {
                        finish_reason: Some(FinishReason::ToolCalls),
                        usage: None,
                        provider_items: vec![],
                    }),
                ]
            } else {
                if self.status == "reported_then_failed" {
                    return Err(ProviderError::http(
                        401,
                        "fixture permanent failure after report",
                    ));
                }
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
        setup_with_store(
            status,
            tools,
            Arc::new(xharness_session::MemorySessionStore::default()),
        )
        .await
    }
    async fn setup_with_store(
        status: &'static str,
        tools: Arc<dyn crate::SessionToolFactory>,
        store: Arc<dyn Store>,
    ) -> (Arc<BasicHost>, Arc<dyn Store>, Arc<Model>) {
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
    async fn wait_ordinary_turn(store: &Arc<dyn Store>) -> Session {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let session = store.load("g").await.unwrap().unwrap();
                if session.events().iter().any(|e| {
                    matches!(
                        e.data(),
                        EventData::TurnEnd {
                            reason: xharness_session::TurnEndReason::Completed,
                            ..
                        }
                    )
                }) {
                    return session;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("ordinary turn must finish without Goal activation")
    }

    #[tokio::test]
    async fn retired_goal_actions_cannot_create_manage_report_or_update_plans() {
        let (host, store, model) = setup("retired_goal").await;
        call(&host,"retired-prompt",RpcMethod::SessionPrompt,json!({"sessionId":"g","mode":"queue","content":[{"type":"text","text":"Set a persistent Goal and track this work"}]})).await;
        let session = wait_ordinary_turn(&store).await;
        let results = session
            .events()
            .iter()
            .filter_map(|event| match event.data() {
                EventData::ToolResult { result, .. } => Some(result),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(results.len(), 8);
        assert!(results
            .iter()
            .all(|result| result.outcome != xharness_session::ToolOutcome::Success));
        assert!(xharness_session::session_plan(&session).is_none());
        assert!(xharness_agent::goal_snapshot(&session).is_none());
        assert!(!session.events().iter().any(|e| matches!(
            e.data(),
            EventData::GoalExecution { .. } | EventData::SessionPlanUpdated { .. }
        )));
        assert_eq!(model.rounds.load(Ordering::SeqCst), 2);
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }

    #[tokio::test]
    async fn working_plan_rpc_is_independent_replay_safe_and_clearable() {
        let (host, store, model) = setup("complete").await;
        let args = json!({"sessionId":"g","planRevision":0,"items":[
            {"id":"a","title":"Implement","status":"in_progress"},
            {"id":"b","title":"Parallel research","status":"in_progress"}
        ]});
        let first = call(&host, "plan-once", RpcMethod::GoalUpdatePlan, args.clone()).await;
        assert_eq!(
            call(&host, "plan-once", RpcMethod::GoalUpdatePlan, args).await,
            first
        );
        let snapshot = store.load("g").await.unwrap().unwrap();
        assert_eq!(
            xharness_session::session_plan(&snapshot).unwrap().revision,
            1
        );
        assert_eq!(
            snapshot
                .events()
                .iter()
                .filter(|e| matches!(e.data(), EventData::SessionPlanUpdated { .. }))
                .count(),
            1
        );
        assert!(xharness_agent::goal_snapshot(&snapshot).is_none());
        assert!(!snapshot.events().iter().any(|e| matches!(
            e.data(),
            EventData::TurnStart { .. } | EventData::GoalExecution { .. }
        )));
        assert_eq!(first["plan"]["items"].as_array().unwrap().len(), 2);
        call(
            &host,
            "plan-clear",
            RpcMethod::GoalUpdatePlan,
            json!({"sessionId":"g","planRevision":1,"items":[]}),
        )
        .await;
        assert!(
            xharness_session::session_plan(&store.load("g").await.unwrap().unwrap())
                .unwrap()
                .items
                .is_empty()
        );
        assert_eq!(model.rounds.load(Ordering::SeqCst), 0);
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }

    #[tokio::test]
    async fn working_plan_stale_duplicate_invalid_and_session_isolation() {
        let (host, store, model) = setup("complete").await;
        let args = json!({"sessionId":"g","planRevision":0,"items":[{"id":"a","title":"Task","status":"pending"}]});
        let one = host.call(
            RpcId::new("plan-one"),
            RpcMethod::GoalUpdatePlan,
            args.clone(),
            CancellationToken::new(),
        );
        let two = host.call(
            RpcId::new("plan-two"),
            RpcMethod::GoalUpdatePlan,
            args.clone(),
            CancellationToken::new(),
        );
        let (a, b) = tokio::join!(one, two);
        assert_ne!(
            matches!(a, RpcResult::Success { .. }),
            matches!(b, RpcResult::Success { .. })
        );
        assert!(
            matches!(if matches!(a,RpcResult::Failure{..}) {a} else {b}, RpcResult::Failure {error} if error.code == xharness_api::RpcErrorCode::SessionConflict)
        );
        for invalid in [
            json!([{"id":"a","title":"Task","status":"completed"},{"id":"a","title":"Duplicate","status":"pending"}]),
            json!([{"id":"a","title":" ","status":"pending"}]),
            json!([{"id":"a","title":"Task","status":"made_up"}]),
        ] {
            let result = host
                .call(
                    RpcId::new(format!("bad-{}", invalid)),
                    RpcMethod::GoalUpdatePlan,
                    json!({"sessionId":"g","planRevision":1,"items":invalid}),
                    CancellationToken::new(),
                )
                .await;
            assert!(matches!(result, RpcResult::Failure { .. }));
        }
        call(
            &host,
            "second-session",
            RpcMethod::SessionCreate,
            json!({"sessionId":"other"}),
        )
        .await;
        call(
            &host,
            "other-plan",
            RpcMethod::GoalUpdatePlan,
            json!({"sessionId":"other","planRevision":0,"items":[]}),
        )
        .await;
        let source = store.load("g").await.unwrap().unwrap();
        assert_eq!(
            xharness_session::session_plan(&source).unwrap().items.len(),
            1
        );
        assert_eq!(model.rounds.load(Ordering::SeqCst), 0);
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }

    #[tokio::test]
    async fn working_plan_never_resumes_paused_or_completes_existing_goal() {
        let (host, store, model) = setup("complete").await;
        let created = call(&host,"disabled-goal",RpcMethod::GoalCreate,json!({"sessionId":"g","objective":"Wait for explicit resume","executionEnabled":false})).await;
        call(
            &host,
            "pause-first",
            RpcMethod::GoalPause,
            json!({"sessionId":"g","ref":created["ref"]}),
        )
        .await;
        let before = xharness_agent::goal_snapshot(&store.load("g").await.unwrap().unwrap());
        call(&host,"completed-plan",RpcMethod::GoalUpdatePlan,json!({"sessionId":"g","planRevision":0,"items":[{"id":"a","title":"Plan done","status":"completed"}]})).await;
        let after = xharness_agent::goal_snapshot(&store.load("g").await.unwrap().unwrap());
        assert_eq!(before, after);
        assert_eq!(model.rounds.load(Ordering::SeqCst), 0);
        assert_eq!(
            host.state.read().await.sessions["g"].projection_values()["taskPlan"]["items"][0]
                ["status"],
            "completed"
        );
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }

    #[tokio::test]
    async fn legacy_plan_jsonl_restore_retains_state_without_retired_tool_context() {
        let root = std::env::temp_dir().join(format!(
            "xh-plan-context-cold-{}-{}",
            std::process::id(),
            crate::state::now_ms()
        ));
        let store: Arc<dyn Store> =
            Arc::new(xharness_session_jsonl::JsonlSessionStore::new(&root).unwrap());
        let (host, _, model) =
            setup_with_store("legacy_plan_retained", Arc::new(NoTools), store.clone()).await;
        call(&host, "context-persist", RpcMethod::GoalUpdatePlan, json!({"sessionId":"g","planRevision":0,"items":[{"id":"verify","title":"Persisted verification","status":"pending"}]})).await;
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
        drop(host);
        drop(store);
        // A fresh store instance, Host and runtime read the on-disk journal.
        let store: Arc<dyn Store> =
            Arc::new(xharness_session_jsonl::JsonlSessionStore::new(&root).unwrap());
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
        host.restore_from_store(store.clone()).await.unwrap();
        assert_eq!(
            model.rounds.load(Ordering::SeqCst),
            0,
            "restore alone never starts a model call"
        );
        call(&host, "context-report", RpcMethod::SessionPrompt, json!({"sessionId":"g","mode":"queue","content":[{"type":"text","text":"Only report; do not resume verification"}]})).await;
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let session = store.load("g").await.unwrap().unwrap();
                if session
                    .events()
                    .iter()
                    .any(|e| matches!(e.data(), EventData::TurnEnd { .. }))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let session = store.load("g").await.unwrap().unwrap();
        assert_eq!(
            model.rounds.load(Ordering::SeqCst),
            1,
            "a pending plan never continues the ordinary turn"
        );
        assert_eq!(
            xharness_session::session_plan(&session).unwrap().revision,
            1
        );
        assert!(session
            .derive_messages()
            .iter()
            .all(|m| m.id.as_deref() != Some("session-working-plan-context")));
        assert!(xharness_agent::goal_snapshot(&session).is_none());
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
        drop(host);
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn working_plan_jsonl_cold_restore_and_receipt_do_not_start_work() {
        let root = std::env::temp_dir().join(format!(
            "xh-plan-cold-{}-{}",
            std::process::id(),
            crate::state::now_ms()
        ));
        let store: Arc<dyn Store> =
            Arc::new(xharness_session_jsonl::JsonlSessionStore::new(&root).unwrap());
        let (host, _, model) = setup_with_store("complete", Arc::new(NoTools), store.clone()).await;
        call(&host,"cold-plan",RpcMethod::GoalUpdatePlan,json!({"sessionId":"g","planRevision":0,"items":[{"id":"a","title":"Persisted","status":"in_progress"}]})).await;
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
        drop(host);
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
        let restored = BasicHost::with_agent_runtime(config, runtime);
        restored.restore_from_store(store.clone()).await.unwrap();
        restored.sync_authoritative_session("g").await.unwrap();
        assert_eq!(
            restored.state.read().await.sessions["g"].projection_values()["taskPlan"]["items"][0]
                ["title"],
            "Persisted"
        );
        let result = call(&restored,"cold-plan",RpcMethod::GoalUpdatePlan,json!({"sessionId":"g","planRevision":0,"items":[{"id":"a","title":"Persisted","status":"in_progress"}]})).await;
        assert_eq!(result["plan"]["revision"], 1);
        assert_eq!(model.rounds.load(Ordering::SeqCst), 0);
        restored
            .agent_runtime
            .shutdown(Duration::from_secs(1))
            .await;
        drop(restored);
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn natural_language_request_does_not_implicitly_create_a_goal() {
        let (host, store, model) = setup("ordinary").await;
        call(&host,"user-text",RpcMethod::SessionPrompt,json!({"sessionId":"g","mode":"queue","content":[{"type":"text","text":"Set a persistent goal: implement parser and test it"}]})).await;
        let session = wait_ordinary_turn(&store).await;
        assert!(execution_state(&session).is_none());
        assert!(xharness_agent::goal_snapshot(&session).is_none());
        assert_eq!(model.rounds.load(Ordering::SeqCst), 1);
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }

    #[tokio::test]
    async fn slash_goal_create_runs_with_scoped_report_and_existing_objective_tools() {
        let (host, store, model) = setup("complete").await;
        let result = host.call_dynamic(
            RpcId::new("slash-create"), "commands/execute",
            json!({"args":{"agentId":"g","line":"/goal Implement parser and test it","images":[]}}),
            CancellationToken::new(),
        ).await.unwrap();
        assert!(
            matches!(result,RpcResult::Success{value:Some(ref v)} if v["result"]["kind"]=="success"),
            "{result:?}"
        );
        let session = wait(&host, &store, "complete").await;
        let state = execution_state(&session).unwrap();
        assert_eq!(
            state.definition.snapshot.objective,
            "Implement parser and test it"
        );
        assert_eq!(state.rounds_started, 1);
        assert_eq!(model.rounds.load(Ordering::SeqCst), 1);
        assert!(!session
            .events()
            .iter()
            .any(|event| matches!(event.data(),EventData::ToolCall{call,..} if call.name=="goal")));
        assert!(session.events().iter().any(
            |event| matches!(event.data(),EventData::ToolCall{call,..} if call.name=="goal_report")
        ));
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }

    #[tokio::test]
    async fn slash_goal_then_real_model_edit_projects_text_and_reassesses_next_round() {
        let (host, store, model) = setup("edit_objective").await;
        let result = host.call_dynamic(
            RpcId::new("slash-edit-fixture"), "commands/execute",
            json!({"args":{"agentId":"g","line":"/goal Implement parser and test it","images":[]}}),
            CancellationToken::new(),
        ).await.unwrap();
        assert!(matches!(result, RpcResult::Success { .. }));
        let session = wait(&host, &store, "complete").await;
        let state = execution_state(&session).unwrap();
        assert_eq!(model.rounds.load(Ordering::SeqCst), 2);
        assert_eq!(state.rounds_started, 2);
        assert_eq!(state.activation_epoch, 1);
        assert_eq!(state.definition.verification, VerificationMode::AgentReport);
        assert_eq!(
            host.state.read().await.goals["g"].objective,
            state.definition.snapshot.objective
        );
        assert!(state
            .definition
            .snapshot
            .objective
            .contains("Preserve the original acceptance requirements"));
        let settled = session
            .events()
            .iter()
            .filter_map(|e| match e.data() {
                EventData::GoalExecution { change }
                    if change.operation == GoalExecutionOperation::Settle =>
                {
                    change.state.latest_turn.clone()
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(settled.len(), 2);
        assert!(settled[0].report.is_none());
        assert_eq!(
            settled[1].report.as_ref().unwrap().status,
            GoalReportStatus::Complete
        );
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }

    #[tokio::test]
    async fn user_goal_controls_are_replay_safe_and_fence_stale_changes() {
        let (host, store, model) = setup("complete").await;
        let args = json!({"sessionId":"g","objective":"Check parser","maxGoalRounds":4});
        let created = call(&host, "user-create", RpcMethod::GoalCreate, args.clone()).await;
        wait(&host, &store, "complete").await;
        assert_eq!(
            call(&host, "user-create", RpcMethod::GoalCreate, args).await,
            created
        );
        let goal = host.state.read().await.goals["g"].clone();
        let old_ref = json!({"id":goal.id,"revision":goal.revision});
        call(
            &host,
            "user-edit",
            RpcMethod::GoalEdit,
            json!({"sessionId":"g","ref":old_ref,"maxGoalRounds":8}),
        )
        .await;
        let stale = host
            .call(
                RpcId::new("stale-user-resume"),
                RpcMethod::GoalResume,
                json!({"sessionId":"g","ref":old_ref}),
                CancellationToken::new(),
            )
            .await;
        assert!(
            !stale.is_ok(),
            "a stale control must not overwrite newer settings"
        );
        let current = host.state.read().await.goals["g"].clone();
        assert_eq!(current.max_goal_rounds, 8);
        assert_eq!(current.phase, xharness_session::GoalPhase::Complete);
        call(
            &host,
            "user-resume",
            RpcMethod::GoalResume,
            json!({"sessionId":"g","ref":{"id":current.id,"revision":current.revision}}),
        )
        .await;
        let reopened = wait(&host, &store, "complete").await;
        assert_eq!(model.rounds.load(Ordering::SeqCst), 2);
        assert_eq!(execution_state(&reopened).unwrap().rounds_started, 2);
        assert!(execution_state(&reopened).unwrap().activation_epoch > 1);
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }

    #[tokio::test]
    async fn product_three_rounds_auto_complete_clear_and_live_history() {
        let (host, store, model) = setup("three").await;
        let mut frames = host.agent_runtime.subscribe_background_turns().unwrap();
        let payload = json!({"sessionId":"g","objective":"Implement parser and check tests","maxGoalRounds":5});
        let first = call(&host, "create", RpcMethod::GoalCreate, payload.clone()).await;
        assert_eq!(
            call(&host, "create", RpcMethod::GoalCreate, payload).await,
            first
        );
        let session = wait(&host, &store, "complete").await;
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
        assert_eq!(
            execution_state(&session).unwrap().definition.verification,
            VerificationMode::AgentReport
        );
        assert_eq!(projected["execution"]["verificationMode"], "agent_report");
        assert_eq!(projected["goal"]["phase"], "complete");
        // No GoalComplete RPC is sent: the model report is settled by the runtime.
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert_eq!(
            model.rounds.load(Ordering::SeqCst),
            3,
            "completed Goals must not start another round"
        );
        let done =
            json!({"ref":{"id":projected["goal"]["id"],"revision":projected["goal"]["revision"]}});
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
    async fn completion_requires_a_report_and_a_normally_settled_turn() {
        for (status, pause_reason, rounds, has_report) in [
            ("text_only", "report_protocol_stalled", 3, false),
            ("reported_then_failed", "execution_error", 1, true),
        ] {
            let (host, store, model) = setup(status).await;
            call(
                &host,
                "create",
                RpcMethod::GoalCreate,
                json!({"sessionId":"g","objective":"Do not falsely complete","maxGoalRounds":5}),
            )
            .await;
            let session = wait(&host, &store, "paused").await;
            let state = execution_state(&session).unwrap();
            assert_eq!(state.definition.verification, VerificationMode::AgentReport);
            assert_eq!(
                state.definition.snapshot.phase,
                xharness_session::GoalPhase::Paused
            );
            assert_eq!(execution_projection(&session)["pauseReason"], pause_reason);
            assert_eq!(model.rounds.load(Ordering::SeqCst), rounds);
            assert_eq!(
                state
                    .latest_turn
                    .as_ref()
                    .and_then(|t| t.report.as_ref())
                    .is_some(),
                has_report
            );
            host.agent_runtime.shutdown(Duration::from_secs(1)).await;
        }
    }

    #[tokio::test]
    async fn persisted_user_confirmation_still_waits_and_can_be_confirmed() {
        let (host, store, model) = setup("complete").await;
        call(&host, "legacy-create", RpcMethod::GoalCreate,
            json!({"sessionId":"g","objective":"Legacy confirmation","maxGoalRounds":5,"executionEnabled":false})).await;
        let controller = xharness_agent::GoalController::new(store.clone(), "g");
        controller
            .enable(
                store.load("g").await.unwrap().unwrap().revision(),
                vec![],
                VerificationMode::UserConfirm,
                3,
            )
            .await
            .unwrap();
        host.activate_goal("g").await.unwrap();
        let session = wait(&host, &store, "awaiting_confirmation").await;
        assert_eq!(
            execution_projection(&session)["verificationMode"],
            "user_confirm"
        );
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert_eq!(
            model.rounds.load(Ordering::SeqCst),
            1,
            "legacy confirmation must not auto-finish or continue"
        );
        let snapshot = execution_state(&session).unwrap().definition.snapshot;
        call(
            &host,
            "legacy-confirm",
            RpcMethod::GoalComplete,
            json!({"sessionId":"g","ref":{"id":snapshot.id,"revision":snapshot.revision}}),
        )
        .await;
        let session = wait(&host, &store, "complete").await;
        assert_eq!(
            execution_state(&session).unwrap().definition.verification,
            VerificationMode::UserConfirm
        );
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
    async fn legacy_round_limit_is_inert_and_retired_budget_command_cannot_mutate_goal() {
        let (host, store, _) = setup("three").await;
        let created = call(
            &host,
            "create",
            RpcMethod::GoalCreate,
            json!({"sessionId":"g","objective":"Keep checking","maxGoalRounds":1}),
        )
        .await;
        assert!(created["ref"].is_object());
        let session = wait(&host, &store, "complete").await;
        let execution = execution_state(&session).unwrap();
        assert_eq!(execution.rounds_started, 3);
        assert_eq!(execution.definition.snapshot.max_goal_rounds, 1);
        assert!(execution.pause_reason.is_none());
        let before_command = crate::restore::restored_goal(&session).unwrap();
        let result = host
            .call_dynamic(
                RpcId::new("show"),
                "commands/execute",
                json!({"args":{"agentId":"g","line":"/goal","images":[]}}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(matches!(result, RpcResult::Success {value: Some(ref v)}
            if v["result"]["text"].as_str().is_some_and(|text| text.contains("3 rounds") && !text.contains("3/1"))));
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
            matches!(edited,RpcResult::Success{value:Some(ref v)} if v["result"]["kind"]=="error" && v["result"]["text"].as_str().unwrap().contains("statistics only"))
        );
        let goal = crate::restore::restored_goal(&store.load("g").await.unwrap().unwrap()).unwrap();
        assert_eq!(goal.max_goal_rounds, 1);
        assert_eq!(goal.rounds_started, 3);
        assert_eq!(goal.revision, before_command.revision);
        assert_eq!(goal.phase, GoalPhase::Complete);
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
        let session = wait(&host, &store, "complete").await;
        let state = execution_state(&session).unwrap();
        let registry = Arc::new(xharness_tools::ToolRegistry::new());
        registry
            .register(crate::goal_report_tool::spec(
                store.clone(),
                Arc::new(NoTools),
                "g".into(),
                (state.definition, state.activation_epoch),
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
                    "goal_report",
                    body.to_string(),
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
        async fn validate_goal_references(
            &self,
            _: &str,
            refs: &[GoalEvidence],
        ) -> Result<(), String> {
            if refs.iter().all(|r| match r {
                GoalEvidence::Job { reference } => reference == "required-job",
                GoalEvidence::Agent { .. } => false,
                _ => true,
            }) {
                Ok(())
            } else {
                Err("unknown fixture dependency".into())
            }
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
        wait(&host, &store, "complete").await;
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
        assert_eq!(
            execution_state(&session).unwrap().definition.verification,
            VerificationMode::UserConfirm
        );
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
        assert_eq!(
            c.state().await.unwrap().unwrap().definition.verification,
            VerificationMode::UserConfirm
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
        let session = wait(&host, &store, "complete").await;
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
        let result = host
            .call_dynamic(
                xharness_api::RpcId::new("harness-snapshot"),
                "session.requestSnapshot",
                json!({"sessionId":"g","seq":seq,"scope":"harness"}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let xharness_api::RpcResult::Success {
            value: Some(surface),
        } = result
        else {
            panic!("Harness snapshot failed")
        };
        assert!(surface["header"].get("input").is_none());
        assert_eq!(surface["header"]["tools"], value["header"]["tools"]);
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
            json!({"sessionId":"g","seq":seq,"scope":"all"}),
            json!({"sessionId":"g","seq":seq,"scope":true}),
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

    /// The shipped Web client mutates Goals through the upstream namespaced
    /// remotes (`/api/goals/*`). Without the bridge every GoalBar verb except the
    /// `/goal` command answered `404` ("client api: goals/clear failed:
    /// transport failure for /api/goals/clear: HTTP 404"), so the trash, pause,
    /// resume, edit and confirm buttons were all dead in the real UI.
    #[tokio::test]
    async fn namespaced_goal_remotes_serve_every_goal_bar_action() {
        async fn remote(host: &BasicHost, endpoint: &str, payload: Value) -> Value {
            match host
                .call_dynamic(
                    xharness_api::RpcId::new(format!("{endpoint}-{}", next_rpc())),
                    endpoint,
                    payload,
                    CancellationToken::new(),
                )
                .await
                .unwrap_or_else(|| panic!("{endpoint} is not mounted"))
            {
                xharness_api::RpcResult::Success { value: Some(value) } => value,
                other => panic!("{endpoint} failed: {other:?}"),
            }
        }
        async fn fails(host: &BasicHost, endpoint: &str, payload: Value) -> bool {
            !host
                .call_dynamic(
                    xharness_api::RpcId::new(format!("{endpoint}-{}", next_rpc())),
                    endpoint,
                    payload,
                    CancellationToken::new(),
                )
                .await
                .unwrap_or_else(|| panic!("{endpoint} is not mounted"))
                .is_ok()
        }
        // Every client call mints its own rpcId; reuse would hit the durable
        // mutation receipt and fail with SessionConflict on purpose.
        fn next_rpc() -> usize {
            static NEXT: AtomicUsize = AtomicUsize::new(1);
            NEXT.fetch_add(1, Ordering::Relaxed)
        }
        let (host, store, _) = setup("progress").await;
        let created = call(
            &host,
            "create",
            RpcMethod::GoalCreate,
            json!({
                "sessionId": "g",
                "objective": "Namespaced remotes",
                "maxGoalRounds": 3,
                "executionEnabled": false,
            }),
        )
        .await;
        // Creation keeps the flat `{ref}` result its schema expects; nothing runs
        // yet because automatic execution is off.
        let reference = created["ref"].clone();
        assert!(reference["id"].as_str().is_some_and(|id| !id.is_empty()));
        assert_eq!(reference["revision"], 1);

        // Edit answers with the whole goal state, not just the flat ref.
        let edited = remote(
            &host,
            "goals/edit",
            json!({"args": {
                "agentId": "g",
                "ref": reference,
                "request": {"objective": "Edited remotely", "maxGoalRounds": 3},
            }}),
        )
        .await;
        assert_eq!(edited["ref"]["id"], created["ref"]["id"]);
        assert_eq!(edited["ref"]["revision"], 2);
        assert_eq!(edited["id"], created["ref"]["id"]);
        assert_eq!(edited["revision"], 2);
        assert_eq!(edited["objective"], "Edited remotely");
        assert_eq!(edited["maxGoalRounds"], 3);
        assert_eq!(edited["roundsStarted"], 0);
        assert_eq!(edited["phase"], "active");
        assert_eq!(edited["activation"], "disarmed");
        assert!(edited["createdAt"].as_u64().unwrap() > 0);
        assert!(edited["updatedAt"].as_u64().unwrap() > 0);

        // Pause, confirm and clear drive the same durable transitions as the bar.
        let paused = remote(
            &host,
            "goals/pause",
            json!({"args": {"agentId": "g", "ref": edited["ref"]}}),
        )
        .await;
        assert_eq!(paused["phase"], "paused");
        assert_eq!(paused["activation"], "disarmed");
        assert_eq!(paused["ref"]["revision"], 3);
        let completed = remote(
            &host,
            "goals/complete",
            json!({"args": {"agentId": "g", "ref": paused["ref"]}}),
        )
        .await;
        assert_eq!(completed["phase"], "complete");
        assert_eq!(completed["activation"], "disarmed");
        let cleared = remote(
            &host,
            "goals/clear",
            json!({"args": {"agentId": "g", "ref": completed["ref"]}}),
        )
        .await;
        assert_eq!(
            cleared,
            json!({"id": completed["id"], "revision": completed["revision"].as_u64().unwrap() + 1})
        );
        let session = store.load("g").await.unwrap().unwrap();
        assert!(session.events().iter().any(|event| matches!(
            event.data(),
            EventData::GoalChange {
                change: xharness_session::GoalChange::Clear(_)
            }
        )));
        // The cleared session has no goal left, so the same verbs fail like the
        // flat methods instead of reporting success.
        assert!(
            fails(
                &host,
                "goals/resume",
                json!({"args": {"agentId": "g", "ref": completed["ref"]}})
            )
            .await
        );

        // A second goal proves the resume path arms automatic continuation and
        // answers with the full state contract, key set included.
        let second = call(
            &host,
            "create-second",
            RpcMethod::GoalCreate,
            json!({
                "sessionId": "g",
                "objective": "Resume remotely",
                "maxGoalRounds": 1,
                "executionEnabled": false,
            }),
        )
        .await;
        let paused_second = remote(
            &host,
            "goals/pause",
            json!({"args": {"agentId": "g", "ref": second["ref"]}}),
        )
        .await;
        let resumed = remote(
            &host,
            "goals/resume",
            json!({"args": {"agentId": "g", "ref": paused_second["ref"]}}),
        )
        .await;
        assert_eq!(resumed["ref"]["id"], second["ref"]["id"]);
        // Arming starts rounds immediately, and each round bumps the revision,
        // so only the lower bound is stable here.
        assert!(
            resumed["ref"]["revision"].as_u64().unwrap()
                > paused_second["ref"]["revision"].as_u64().unwrap()
        );
        let mut keys = resumed
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "activation",
                "createdAt",
                "id",
                "maxGoalRounds",
                "objective",
                "phase",
                "ref",
                "revision",
                "roundsStarted",
                "updatedAt",
            ]
        );
        // Round settlement is asynchronous, so read the durable arming instead.
        let session = store.load("g").await.unwrap().unwrap();
        assert!(session.events().iter().any(|event| matches!(
            event.data(),
            EventData::GoalExecution { change }
                if change.operation == GoalExecutionOperation::Enable
        )));

        // The other upstream namespaces stay unmounted instead of silently
        // succeeding, which is what keeps unknown endpoints a 404.
        assert!(host
            .call_dynamic(
                xharness_api::RpcId::new("files"),
                "fileReferences/list",
                json!({"args": {"agentId": "g", "query": ""}}),
                CancellationToken::new(),
            )
            .await
            .is_none());
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }
    #[tokio::test]
    async fn goal_remote_receipts_replay_original_state_after_edit_clear_and_replacement() {
        async fn remote(host: &BasicHost, id: &str, endpoint: &str, args: Value) -> Value {
            match host
                .call_dynamic(
                    RpcId::new(id),
                    endpoint,
                    json!({"args":args}),
                    CancellationToken::new(),
                )
                .await
                .unwrap()
            {
                RpcResult::Success { value: Some(value) } => value,
                other => panic!("{other:?}"),
            }
        }
        let (host, store, _) = setup("progress").await;
        let created = call(
            &host,
            "create",
            RpcMethod::GoalCreate,
            json!({"sessionId":"g", "objective":"original", "executionEnabled":false}),
        )
        .await;
        let edit_args =
            json!({"agentId":"g", "ref":created["ref"], "request":{"objective":"edited"}});
        let edited = remote(&host, "remote-edit", "goals/edit", edit_args.clone()).await;
        let paused = remote(
            &host,
            "remote-pause",
            "goals/pause",
            json!({"agentId":"g", "ref":edited["ref"]}),
        )
        .await;
        assert_eq!(
            remote(&host, "remote-edit", "goals/edit", edit_args.clone()).await,
            edited
        );
        let clear_args = json!({"agentId":"g", "ref":paused["ref"]});
        let cleared = remote(&host, "remote-clear", "goals/clear", clear_args.clone()).await;
        assert_eq!(
            cleared,
            json!({"id":paused["id"], "revision":paused["revision"].as_u64().unwrap()+1})
        );
        assert_eq!(
            remote(&host, "remote-edit", "goals/edit", edit_args.clone()).await,
            edited
        );
        assert_eq!(
            remote(&host, "remote-clear", "goals/clear", clear_args.clone()).await,
            cleared
        );
        let second = call(
            &host,
            "second",
            RpcMethod::GoalCreate,
            json!({"sessionId":"g", "objective":"replacement", "executionEnabled":false}),
        )
        .await;
        assert_eq!(
            remote(&host, "remote-clear", "goals/clear", clear_args).await,
            cleared
        );
        assert_eq!(
            host.state.read().await.goals["g"].id,
            second["ref"]["id"].as_str().unwrap()
        );
        // Receipts include the immutable wire response in the durable event,
        // not just the flattened method's ref or a read of the latest Goal.
        let session = store.load("g").await.unwrap().unwrap();
        let receipt = session
            .events()
            .iter()
            .find_map(|e| match e.data() {
                EventData::SessionMutationCommitted { receipt }
                    if receipt.rpc_id == "remote-edit" =>
                {
                    Some(receipt)
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(receipt.response, edited);
        // Reusing an id for a different request or flat protocol cannot replay
        // a different-shaped response or silently mutate the replacement.
        let bad = host
            .call_dynamic(
                RpcId::new("remote-edit"),
                "goals/edit",
                json!({"args":{"agentId":"g","ref":second["ref"],"request":{"objective":"wrong"}}}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(!bad.is_ok());
        assert!(!host
            .call(
                RpcId::new("remote-clear"),
                RpcMethod::GoalClear,
                json!({"sessionId":"g","ref":paused["ref"]}),
                CancellationToken::new()
            )
            .await
            .is_ok());
        let flat = call(
            &host,
            "flat-clear",
            RpcMethod::GoalClear,
            json!({"sessionId":"g","ref":second["ref"]}),
        )
        .await;
        assert_eq!(flat, json!({"cleared":true}));
        host.agent_runtime.shutdown(Duration::from_secs(1)).await;
    }
}

#[cfg(test)]
#[path = "goal_report_reference_tests.rs"]
mod report_reference_tests;

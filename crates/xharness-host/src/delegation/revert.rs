//! Explicit, parent-controlled context correction. No tool replay, file undo,
//! model probe or automatic recovery policy. Reuses the durable Session/Inbox.
use super::*;
use crate::state::{now_ms, ModelSelection, SessionRecord};
use xharness_agent::InboxProjection;
use xharness_projection::metrics::MetricsProjectionState;
use xharness_session::ToolOutcome;

fn unresolved(session: &Session) -> Result<(), String> {
    if InboxProjection::from_session(session)
        .map_err(|e| e.to_string())?
        .has_pending()
        || !session.pending_tool_approvals().is_empty()
        || !session.recoverable_user_questions().is_empty()
        || !session.pending_user_questions().is_empty()
        || !session.interrupted_compaction_recovery().is_empty()
        || !session.outcome_unknown_recovery().is_empty()
        || session.events().iter().any(|event| {
            matches!(event.data(),
            EventData::ToolResult { result, .. } if result.outcome == ToolOutcome::OutcomeUnknown)
        })
    {
        return Err(
            "revert requires no pending inbox, approval, question or unknown tool outcome".into(),
        );
    }
    // Autonomous scheduling must not be cloned into the corrected branch.
    if crate::restore::restored_goal(session).is_some()
        || !xharness_schedule::active_schedules(session)
            .map_err(|e| e.to_string())?
            .is_empty()
    {
        return Err("revert does not clone goals or schedules".into());
    }
    Ok(())
}

pub(super) fn branch_source(session: &Session) -> Option<&str> {
    let ownership = session
        .events()
        .iter()
        .rposition(|e| matches!(e.data(), EventData::AgentDelegated { .. }))?;
    session.events()[..ownership]
        .iter()
        .rev()
        .find_map(|e| match e.data() {
            EventData::SessionForkOrigin {
                parent_session_id, ..
            } => Some(parent_session_id.as_str()),
            _ => None,
        })
}

pub(super) fn checkpoint(session: &Session, seq: u64) -> Result<Session, String> {
    let index = session
        .events()
        .iter()
        .position(|event| event.seq == seq)
        .ok_or("unknown revert checkpoint")?;
    if !matches!(
        session.events()[index].data(),
        EventData::StepEnd { .. } | EventData::TurnEnd { .. }
    ) {
        return Err("revert checkpoint must end a completed step or turn".into());
    }
    let snapshot = Session::restore(
        session.header().clone(),
        session.events()[index].revision,
        session.events()[..=index].to_vec(),
    )
    .map_err(|e| e.to_string())?;
    unresolved(&snapshot)?;
    Ok(snapshot)
}

/// Bounded suggestions, not a policy restricting how many steps may be undone.
/// All decisions are made again against the authoritative journal at admission.
pub(super) fn checkpoints(session: &Session) -> Value {
    let points: Vec<_> = session
        .events()
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, event)| {
            matches!(
                event.data(),
                EventData::StepEnd { .. } | EventData::TurnEnd { .. }
            )
        })
        .take(8)
        .filter_map(|(index, event)| {
            let (turn, step) = match event.data() {
                EventData::StepEnd { turn, step } => (*turn, Some(*step)),
                EventData::TurnEnd { turn, .. } => (*turn, None),
                _ => return None,
            };
            checkpoint(session, event.seq).ok()?;
            // Give the parent factual landmarks, not just opaque sequence IDs.
            // No tool arguments, result bodies or hidden reasoning are exposed.
            let begin = session.events()[..=index].iter().rposition(|e| match (step, e.data()) {
                (Some(selected), EventData::StepStart { turn: t, step: s }) => *t == turn && *s == selected,
                (None, EventData::TurnStart { turn: t }) => *t == turn,
                _ => false,
            }).unwrap_or(index);
            let tools: Vec<_> = session.events()[begin..=index].iter().filter_map(|e| match e.data() {
                EventData::ToolCall { call, .. } => Some(call.name.as_str()),
                _ => None,
            }).take(16).collect();
            let outcome = match event.data() { EventData::TurnEnd { reason, .. } => json!(reason), _ => Value::Null };
            Some(json!({"checkpoint_seq":event.seq,"turn":turn,"step":step,"tools":tools,"turn_outcome":outcome}))
        })
        .collect();
    json!(points)
}

fn correction(source: &str, seq: u64, message: &str) -> String {
    format!("Context correction selected by the parent agent. Historical context before the selected checkpoint is retained; the original conversation remains available. Files and external effects after that point have NOT been undone. Verify their current state before repeating side-effecting operations. Do not replay completed calls just because later context is absent.\n{}", json!({"source_agent_id":source,"checkpoint_seq":seq,"correction":message}))
}

impl BasicHost {
    pub(super) async fn revert_delegated(
        &self,
        caller: &str,
        id: &str,
        source: &str,
        seq: u64,
        message: String,
    ) -> Result<Value, String> {
        if !self.agent_runtime.has_authoritative_sessions() {
            return Err("revert requires authoritative session history".into());
        }
        self.authorize_delegated(caller, source).await?;
        self.hydrate_session(caller)
            .await
            .map_err(|e| e.to_string())?;
        self.hydrate_session(source)
            .await
            .map_err(|e| e.to_string())?;
        self.authorize_delegated(caller, source).await?;
        let task = correction(source, seq, &message);
        // Same creation capacity/fences as start. No waiting for execution under
        // these locks; a running source is rejected rather than secretly stopped.
        {
            let _creation = self.lock_admission("agent-creation").await;
            let _parent = self.lock_admission(caller).await;
            let _source = self.lock_admission(source).await;
            let _branch = self.lock_admission(id).await;
            let existing = self
                .agent_runtime
                .authoritative_session(id)
                .await
                .map_err(|e| e.to_string())?;
            let (cwd, existing) = {
                let state = self.state.read().await;
                let parent = state
                    .sessions
                    .get(caller)
                    .ok_or("calling agent does not exist")?;
                if parent.delegated || parent.dispatch_paused {
                    return Err("only an unpaused main agent may revert its direct child".into());
                }
                if state.deleted_sessions.contains(id) {
                    return Err("deleted agent invocation cannot be reused".into());
                }
                let child = state
                    .sessions
                    .get(source)
                    .ok_or("source agent does not exist")?;
                if !child.delegated || child.parent_session_id.as_deref() != Some(caller) {
                    return Err("revert requires an owned direct child".into());
                }
                // Replays below use the durable receipt, even if the source or
                // branch has since run/paused. They never readmit completed work.
                let admitted = existing.as_ref().is_some_and(|s| {
                    s.events()
                        .iter()
                        .any(|e| matches!(e.data(), EventData::AgentDelegated { .. }))
                });
                if !admitted {
                    if child.running
                        || child.restoring
                        || child.dispatch_paused
                        || !child.queue.is_empty()
                        || !child.projected_queue.is_empty()
                    {
                        return Err("source must be idle and unpaused with no queued work; stopped children require human resume".into());
                    }
                    if state
                        .sessions
                        .values()
                        .filter(|s| s.delegated && s.parent_session_id.as_deref() == Some(caller))
                        .count()
                        >= 128
                        || state
                            .sessions
                            .values()
                            .filter(|s| s.delegated && s.running)
                            .count()
                            >= 16
                    {
                        return Err("delegation capacity reached; wait for child settlement".into());
                    }
                }
                (child.cwd.clone(), existing)
            };
            let branch = if let Some(branch) = existing.filter(|s| !s.events().is_empty()) {
                let admitted = branch.events().iter().rev().find_map(|e| match e.data() {
                    EventData::AgentDelegated {
                        parent_session_id,
                        invocation_id,
                        task,
                    } => Some((parent_session_id, invocation_id, task)),
                    _ => None,
                });
                if branch_source(&branch) != Some(source)
                    || !matches!(admitted, Some((parent, invocation, previous)) if parent == caller && invocation == id && previous == &task)
                {
                    return Err("invocation id already used for another agent operation".into());
                }
                branch
            } else {
                let source_session = self
                    .agent_runtime
                    .authoritative_session(source)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or("source history unavailable")?;
                unresolved(&source_session)?;
                // Refuse an abandoned current turn too, even if the requested
                // historical prefix is complete. Reconciliation comes first.
                if !source_session.interrupted_turn_recovery().is_empty() {
                    return Err(
                        "source has an unsettled turn; reconcile it before reverting".into(),
                    );
                }
                let prefix = checkpoint(&source_session, seq)?;
                let route = crate::restore::restored_route(&prefix, &self.config);
                let current_route = crate::restore::restored_route(&source_session, &self.config);
                if route != current_route
                    || crate::restore::restored_permission(&prefix)
                        != crate::restore::restored_permission(&source_session)
                    || crate::restore::restored_agent_preset(&prefix)
                        != crate::restore::restored_agent_preset(&source_session)
                    || crate::restore::restored_plan_mode(&prefix)
                        != crate::restore::restored_plan_mode(&source_session)
                {
                    return Err("checkpoint settings differ from current child; revert cannot change model or execution policy".into());
                }
                if !self.agent_runtime.can_route(&route) {
                    return Err("checkpoint model route is unavailable".into());
                }
                // Preserve provider-visible history exactly. Only old delegation
                // administration is removed; consumed inbox facts remain paired.
                let mut events: Vec<_> = prefix
                    .events()
                    .iter()
                    .filter(|e| {
                        !matches!(
                            e.data(),
                            EventData::SessionMutationCommitted { .. }
                                | EventData::AgentDelegated { .. }
                                | EventData::AgentDispatchPaused { .. }
                                | EventData::AgentDelegationFailure { .. }
                                | EventData::AgentFailureDelivered { .. }
                                | EventData::AgentSettlementDelivered { .. }
                        )
                    })
                    .map(|e| e.event.clone())
                    .collect();
                events.extend(prefix.interrupted_turn_recovery());
                events.push(
                    EventData::SessionForkOrigin {
                        parent_session_id: source.into(),
                        before_user_seq: None,
                    }
                    .into(),
                );
                events.push(
                    EventData::AgentDelegated {
                        parent_session_id: caller.into(),
                        invocation_id: id.into(),
                        task: task.clone(),
                    }
                    .into(),
                );
                // One durable batch includes both prefix and fresh ownership.
                // A crash before inbox delivery is recovered by the existing
                // initial-task listener; a retry cannot create a second branch.
                self.agent_runtime
                    .persist_session_events(id, &cwd, events)
                    .await
                    .map_err(|e| e.to_string())?;
                self.agent_runtime
                    .authoritative_session(id)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or("branch receipt unavailable")?
            };
            if self
                .state
                .read()
                .await
                .sessions
                .get(id)
                .is_none_or(|record| !record.delegated || record.restoring)
            {
                let route = crate::restore::restored_route(&branch, &self.config);
                let now = now_ms();
                self.state.write().await.sessions.insert(
                    id.into(),
                    SessionRecord {
                        dispatch_paused: restored_dispatch_paused(&branch),
                        delegated: true,
                        restoring: false,
                        session_id: id.into(),
                        created_at: branch.header().created_at_ms,
                        updated_at: now,
                        running: false,
                        blank: false,
                        parent_session_id: Some(caller.into()),
                        origin: Some("subagent".into()),
                        cwd,
                        agent_preset: crate::restore::restored_agent_preset(&branch),
                        title: crate::restore::restored_title(&branch),
                        model: ModelSelection {
                            provider: route.provider,
                            model: route.model,
                            reasoning_effort: route.reasoning_effort,
                            context_window_tokens: route.context_window_tokens,
                        },
                        permission_preset: crate::restore::restored_permission(&branch),
                        active_permission: None,
                        plan_active: crate::restore::restored_plan_mode(&branch),
                        goal: None,
                        task_plan: xharness_session::session_plan(&branch),
                        schedules: vec![],
                        schedules_hydrated: true,
                        events: vec![],
                        event_base_seq: 0,
                        event_cache_bytes: 0,
                        event_cache_weights: Vec::new(),
                        event_cache_resident_bytes: 0,
                        event_cache_resident_weights: Vec::new(),
                        event_cache_touched: 0,
                        projected_model: None,
                        metrics: MetricsProjectionState::default(),
                        catalog_metrics: None,
                        messages: vec![],
                        queue: Default::default(),
                        projected_queue: Default::default(),
                        admissions: crate::admission_cache::AdmissionCache::new(true),
                        mutation_receipts: Default::default(),
                        authoritative_seq: None,
                        control: None,
                        next_turn: branch
                            .events()
                            .iter()
                            .filter_map(|e| match e.data() {
                                EventData::TurnStart { turn } => Some(turn.saturating_add(1)),
                                _ => None,
                            })
                            .max()
                            .unwrap_or_default(),
                    },
                );
                self.sync_authoritative_session(id)
                    .await
                    .map_err(|e| e.message)?;
                self.push_host(json!({"type":"host/session-added","sessionId":id,"parentSessionId":caller,"origin":"subagent","blank":false,"cwd":branch.header().cwd,"revertedFrom":{"agentId":source,"checkpointSeq":seq}}));
            }
        }
        self.deliver_agent_message(
            caller,
            id,
            &format!("{id}:initial"),
            task,
            "agent-message",
            false,
        )
        .await?;
        Ok(
            json!({"ok":true,"agent_id":id,"source_agent_id":source,"checkpoint_seq":seq,"message_id":format!("{id}:initial"),"status":"accepted","filesystem_rollback":false}),
        )
    }
}

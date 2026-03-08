//! Deferred answers remain human-owned; releasing a tool never grants consent.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use xharness_tools::{GuardDecision, MiddlewareError, MonotonicGuard, ToolExecutionContext};

pub(super) fn deferred_resolution(invocation: &QuestionInvocation) -> QuestionResolution {
    QuestionResolution {
        status: xharness_interaction::ResolutionStatus::Deferred,
        action: ResolveAction::Continue,
        answers: vec![],
        unanswered_question_ids: invocation
            .request
            .questions
            .iter()
            .map(|q| q.id.clone())
            .collect(),
    }
}

impl DurableQuestionHub {
    pub(crate) fn bind_host(&self, host: std::sync::Weak<crate::BasicHost>) {
        let _ = self.host.set(host);
    }

    async fn snapshot(&self, id: &str) -> Result<xharness_session::Session, QuestionHubError> {
        self.store
            .as_ref()
            .ok_or_else(|| QuestionHubError::Persistence("question store unavailable".into()))?
            .load(id)
            .await
            .map_err(store_error)?
            .ok_or_else(|| QuestionHubError::Persistence("session missing".into()))
    }

    pub(super) async fn defer_if_due(
        &self,
        pending: &PendingQuestion,
    ) -> Result<bool, QuestionHubError> {
        let _gate = pending.gate.lock().await;
        let session = self.snapshot(&pending.session_id).await?;
        let id = &pending.invocation.interaction_id;
        let Some(question) = xharness_session::all_user_questions(session.events())
            .into_iter()
            .find(|q| &q.invocation.interaction_id == id)
        else {
            return Ok(false);
        };
        if !matches!(question.terminal, QuestionTerminalState::Pending) {
            return Ok(false);
        }
        let already = xharness_session::question_is_deferred(session.events(), id);
        let opened = session
            .events()
            .iter()
            .find_map(|e| match e.data() {
                EventData::QuestionRequested { invocation } if &invocation.interaction_id == id => {
                    Some(e.timestamp_ms)
                }
                _ => None,
            })
            .ok_or_else(|| {
                QuestionHubError::Persistence("question opening timestamp missing".into())
            })?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        if !already && now.saturating_sub(opened) < self.wait_timeout.as_millis() as u64 {
            return Ok(false);
        }
        if !already {
            // CAS validation rejects a concurrent answer/cancel, never reclassifies it.
            let store = self.store.as_ref().expect("snapshot requires store");
            match store
                .append(
                    &pending.session_id,
                    session.revision(),
                    vec![EventData::QuestionDeferred {
                        interaction_id: id.clone(),
                    }
                    .into()],
                )
                .await
            {
                Ok(_) => store
                    .flush(&pending.session_id)
                    .await
                    .map_err(store_error)
                    .map(|_| ())?,
                Err(StoreError::RevisionConflict { .. }) => return Ok(false),
                Err(e) => return Err(store_error(e)),
            }
        }
        if !pending.deferred.swap(true, Ordering::AcqRel) {
            let _ = self.events.send(question_requested_frame(pending));
        }
        Ok(true)
    }

    /// Durable resolution is an outbox. Stable RPC identity makes retries after
    /// an accepted-but-unacknowledged enqueue harmless across process restarts.
    pub(super) async fn deliver_late_answer(
        &self,
        pending: &PendingQuestion,
    ) -> Result<(), QuestionHubError> {
        let session = self.snapshot(&pending.session_id).await?;
        let id = &pending.invocation.interaction_id;
        if !xharness_session::question_is_deferred(session.events(), id) || session.events().iter().any(|e| matches!(e.data(), EventData::QuestionAnswerDelivered { interaction_id } if interaction_id == id)) {return Ok(())}
        let Some(question) = xharness_session::all_user_questions(session.events())
            .into_iter()
            .find(|q| &q.invocation.interaction_id == id)
        else {
            return Ok(());
        };
        let outcome = match question.terminal {
            QuestionTerminalState::Pending => return Ok(()),
            QuestionTerminalState::Resolved(answer) => {
                self.persist_agent_markdown(&pending.workspace, &pending.invocation, &answer)
                    .await?;
                json!({"answer":answer})
            }
            QuestionTerminalState::Cancelled(reason) => {
                json!({"cancelled":true,"reason":reason,"notice":"The user dismissed the question without granting permission. Do not assume an answer."})
            }
        };
        let host = self
            .host
            .get()
            .and_then(std::sync::Weak::upgrade)
            .ok_or_else(|| {
                QuestionHubError::Persistence(
                    "late-answer delivery host unavailable; answer retained for retry".into(),
                )
            })?;
        host.session_prompt(RpcId::new(format!("question-late-answer:{id}")), &json!({
            "sessionId":pending.session_id,"mode":"steer",
            "content":[{"type":"text","text":format!("User response to pending question {id}: {outcome}")}]
        })).await.map_err(|e| QuestionHubError::Persistence(e.message))?;
        self.append_and_flush(
            &pending.session_id,
            EventData::QuestionAnswerDelivered {
                interaction_id: id.clone(),
            }
            .into(),
        )
        .await
    }

    /// Reuse the Host's existing startup scan, never reread every conversation.
    pub(crate) async fn restore_snapshot(&self, session: &xharness_session::Session) {
        if !session
            .events()
            .iter()
            .any(|e| matches!(e.data(), EventData::QuestionDeferred { .. }))
        {
            return;
        }
        let header = session.header();
        for q in xharness_session::all_user_questions(session.events()) {
            if !xharness_session::question_is_deferred(session.events(), &q.invocation.interaction_id)
                || session.events().iter().any(|e| matches!(e.data(), EventData::QuestionAnswerDelivered { interaction_id } if interaction_id == &q.invocation.interaction_id)) {continue}
            let mut all = self.pending.write().await;
            let pending = all
                .entry(q.invocation.interaction_id.clone())
                .or_insert_with(|| {
                    Arc::new(PendingQuestion {
                        session_id: header.id.clone(),
                        workspace: header.cwd.clone().unwrap_or_default(),
                        invocation: q.invocation,
                        settlement: watch::channel(None).0,
                        gate: tokio::sync::Mutex::new(()),
                        deferred: AtomicBool::new(true),
                    })
                });
            pending.deferred.store(true, Ordering::Release);
        }
    }

    pub(crate) async fn deliver_restored_answers(&self) -> Result<(), QuestionHubError> {
        let pending = self
            .pending
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut errors = Vec::new();
        for p in pending {
            if !p.deferred.load(Ordering::Acquire) {
                continue;
            }
            let _gate = p.gate.lock().await;
            let state = self
                .question_state(&p.session_id, &p.invocation.interaction_id)
                .await?;
            let Some((_, terminal)) = state else { continue };
            if matches!(terminal, QuestionTerminalState::Pending) {
                continue;
            }
            if let Err(error) = self.deliver_late_answer(&p).await {
                errors.push(format!("{}: {error}", p.session_id));
                continue;
            }
            self.finish_pending(
                &p,
                if matches!(terminal, QuestionTerminalState::Cancelled(_)) {
                    QuestionOutcome::Cancelled
                } else {
                    QuestionOutcome::Answered
                },
            )
            .await;
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(QuestionHubError::Persistence(errors.join("; ")))
        }
    }

    #[cfg(test)]
    pub(crate) async fn restore_detached(&self) -> Result<(), QuestionHubError> {
        if let Some(store) = &self.store {
            for header in store.list_headers().await.map_err(store_error)? {
                self.restore_snapshot(&self.snapshot(&header.id).await?)
                    .await;
            }
        }
        self.deliver_restored_answers().await
    }

    /// Conservative Host-owned allowlist, independent of full-access approval.
    /// Once latched, remains read-only for this turn even if an answer arrives
    /// between preflight and handler entry. The next turn builds a fresh guard.
    pub fn exploration_guard(self: &Arc<Self>, session: &str) -> Arc<dyn MonotonicGuard> {
        Arc::new(ExplorationGuard {
            hub: self.clone(),
            session: session.into(),
            restricted: AtomicBool::new(false),
        })
    }
}

struct ExplorationGuard {
    hub: Arc<DurableQuestionHub>,
    session: String,
    restricted: AtomicBool,
}
#[async_trait]
impl MonotonicGuard for ExplorationGuard {
    async fn evaluate(&self, ctx: &ToolExecutionContext) -> Result<GuardDecision, MiddlewareError> {
        let s = self
            .hub
            .snapshot(&self.session)
            .await
            .map_err(|e| MiddlewareError::new(e.to_string()))?;
        if !self.restricted.load(Ordering::Acquire)
            && !s
                .events()
                .iter()
                .any(|e| matches!(e.data(), EventData::QuestionDeferred { .. }))
        {
            return Ok(GuardDecision::Allow);
        }
        let current_turn = s.events().iter().rev().find_map(|e| match e.data() {
            EventData::TurnStart { turn } => Some(*turn),
            _ => None,
        });
        let deferred_this_turn = xharness_session::all_user_questions(s.events())
            .iter()
            .any(|q| {
                Some(q.turn) == current_turn
                    && xharness_session::question_is_deferred(
                        s.events(),
                        &q.invocation.interaction_id,
                    )
            });
        if deferred_this_turn || xharness_session::has_unanswered_deferred_question(s.events()) {
            self.restricted.store(true, Ordering::Release)
        }
        if !self.restricted.load(Ordering::Acquire) {
            return Ok(GuardDecision::Allow);
        }
        let allowed = matches!(ctx.tool_name(), "read" | "glob" | "grep" | "read_image")
            || (ctx.tool_name() == "goal"
                && ctx.arguments.get("action").and_then(Value::as_str) == Some("get"))
            || (ctx.tool_name() == "goal"
                && ctx.arguments["action"] == "report"
                && matches!(
                    ctx.arguments["report"]["status"].as_str(),
                    Some("progress" | "blocked")
                ));
        Ok(if allowed {
            GuardDecision::Allow
        } else {
            GuardDecision::deny("An unanswered question has deferred this turn. Only scoped read/glob/grep/read_image and goal get are allowed. No Bash, writes, network fetches, jobs, subagents, scheduling or repeated questions. Investigate independently or finish and wait; do not assume consent.")
        })
    }
}

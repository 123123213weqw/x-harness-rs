use std::{collections::BTreeMap, path::Path, sync::Arc, time::Duration};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::sync::{broadcast, watch, RwLock};
use tokio_util::sync::CancellationToken;
use xharness_api::{
    ClientResponse, ClientResponseKind, QuestionOutcome, ReceiptRejection, RpcId, RpcReceipt,
    RpcResult, ServerRequest,
};
use xharness_interaction::{
    AnswerDestination, QuestionAnswer, QuestionInteraction, QuestionInvocation,
    QuestionProviderError, QuestionResolution, QuestionTerminalState, ResolveAction,
    UserQuestionProvider,
};
use xharness_session::{EventData, SessionEvent, Store, StoreError};

mod continuation;

const APPEND_RETRIES: usize = 16;
pub(crate) const DELEGATED_QUESTION_POLICY: &str = "You are a delegated child agent. Clarifications belong to your parent agent, not directly to the human user. Do not call ask_user_question (ask_question) or create a replacement user-question tool. If essential information remains missing after inspecting available context and tools, finish this turn with a concise clarification report: what is missing, why it matters, and any safe options. Your result is automatically delivered to the parent; do not poll or wait for a human answer. The parent can answer using agent(action=send) and resume your work. Neither a clarification nor a parent reply grants permission: existing approval requirements remain authoritative.";
pub const AGENT_MEMORY_BEGIN: &str = "<!-- XHARNESS:USER-MEMORY:BEGIN -->";
pub const AGENT_MEMORY_END: &str = "<!-- XHARNESS:USER-MEMORY:END -->";

/// Close obsolete child/user waits on upgrade, rather than merely hiding their
/// dialogs and leaving autonomous work blocked. The original question remains
/// in history; this is a runtime-policy cancellation, never a human answer.
pub(crate) fn delegated_question_cancellations(
    session: &xharness_session::Session,
) -> Vec<SessionEvent> {
    if crate::delegation::restored_delegation(session).is_none() {
        return Vec::new();
    }
    xharness_session::all_user_questions(session.events())
        .into_iter()
        .filter(|question| matches!(question.terminal, QuestionTerminalState::Pending))
        .map(|question| EventData::QuestionCancelled {
            interaction_id: question.invocation.interaction_id,
            reason: "Runtime policy closed an obsolete delegated-agent user question. Report the clarification to the parent agent instead. This was not a user cancellation or answer and grants no permission.".into(),
        }.into())
        .collect()
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum QuestionHubError {
    #[error("question interaction is not pending")]
    NotPending,
    #[error("invalid question response: {0}")]
    BadResponse(String),
    #[error("question persistence failed: {0}")]
    Persistence(String),
    #[error("agent markdown persistence failed: {0}")]
    AgentMarkdown(String),
}

#[async_trait]
pub trait AgentMarkdownSink: Send + Sync + 'static {
    async fn persist(
        &self,
        workspace: &Path,
        invocation: &QuestionInvocation,
        resolution: &QuestionResolution,
    ) -> Result<(), String>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NoopAgentMarkdownSink;

#[async_trait]
impl AgentMarkdownSink for NoopAgentMarkdownSink {
    async fn persist(
        &self,
        _workspace: &Path,
        _invocation: &QuestionInvocation,
        _resolution: &QuestionResolution,
    ) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum QuestionSettlement {
    Resolved(QuestionResolution),
    Cancelled(String),
}

struct PendingQuestion {
    session_id: String,
    workspace: String,
    invocation: QuestionInvocation,
    settlement: watch::Sender<Option<QuestionSettlement>>,
    gate: tokio::sync::Mutex<()>,
    deferred: std::sync::atomic::AtomicBool,
}

/// Process-local answer routing over a durable Session authority. Pending
/// entries are reconstructed by replaying the safe question Tool call after a
/// restart; the stable interaction id is also its Web RPC id.
pub struct DurableQuestionHub {
    store: Option<Arc<dyn Store>>,
    sink: Arc<dyn AgentMarkdownSink>,
    pending: RwLock<BTreeMap<String, Arc<PendingQuestion>>>,
    events: broadcast::Sender<ServerRequest>,
    host: std::sync::OnceLock<std::sync::Weak<crate::BasicHost>>,
    wait_timeout: Duration,
}

impl DurableQuestionHub {
    pub fn new(store: Arc<dyn Store>, sink: Arc<dyn AgentMarkdownSink>) -> Arc<Self> {
        let (events, _) = broadcast::channel(256);
        Arc::new(Self {
            store: Some(store),
            sink,
            pending: RwLock::new(BTreeMap::new()),
            events,
            host: std::sync::OnceLock::new(),
            wait_timeout: Duration::from_secs(60),
        })
    }

    pub(crate) fn unavailable() -> Arc<Self> {
        let (events, _) = broadcast::channel(16);
        Arc::new(Self {
            store: None,
            sink: Arc::new(NoopAgentMarkdownSink),
            pending: RwLock::new(BTreeMap::new()),
            events,
            host: std::sync::OnceLock::new(),
            wait_timeout: Duration::from_secs(60),
        })
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<ServerRequest> {
        self.events.subscribe()
    }

    /// Use durable delegation identity, not a model-supplied parent id or a
    /// copied fork header. A regular fork of a child is still user-owned.
    pub async fn allows_user_questions(
        &self,
        session_id: &str,
    ) -> Result<bool, QuestionProviderError> {
        // Live Host ownership is rebuilt from those durable events. Avoid
        // rereading a long conversation just to construct each turn's tools.
        if let Some(host) = self.host.get().and_then(std::sync::Weak::upgrade) {
            if let Some(session) = host.state.read().await.sessions.get(session_id) {
                return Ok(!session.delegated);
            }
        }
        let session = self.snapshot(session_id).await.map_err(provider_error)?;
        Ok(crate::delegation::restored_delegation(&session).is_none())
    }

    pub(crate) async fn baseline(&self) -> Vec<ServerRequest> {
        let pending = self
            .pending
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut frames = Vec::new();
        for question in pending {
            if self
                .allows_user_questions(&question.session_id)
                .await
                .unwrap_or(false)
            {
                frames.push(question_requested_frame(&question));
            }
        }
        frames
    }

    async fn ask(
        &self,
        session_id: &str,
        workspace: &str,
        invocation: QuestionInvocation,
        cancellation: CancellationToken,
    ) -> Result<QuestionResolution, QuestionProviderError> {
        // Enforce ownership even when an old/custom executor still exposes the
        // tool. Reject new/waiting child questions before persisting or publishing.
        // Replaying an answer already accepted before upgrade creates no question.
        let may_ask = self.allows_user_questions(session_id).await?;
        let existing = self
            .question_state(session_id, &invocation.interaction_id)
            .await
            .map_err(provider_error)?;
        match existing {
            Some((durable, QuestionTerminalState::Resolved(resolution))) => {
                if durable.invocation() != &invocation {
                    return Err(QuestionProviderError::new(
                        "durable question identity conflicts with this tool invocation",
                    ));
                }
                self.persist_agent_markdown(workspace, &invocation, &resolution)
                    .await
                    .map_err(provider_error)?;
                return Ok(resolution);
            }
            Some((durable, QuestionTerminalState::Cancelled(reason))) => {
                if durable.invocation() != &invocation {
                    return Err(QuestionProviderError::new(
                        "durable question identity conflicts with this tool invocation",
                    ));
                }
                return Err(QuestionProviderError::new(reason));
            }
            Some((durable, QuestionTerminalState::Pending)) => {
                if durable.invocation() != &invocation {
                    return Err(QuestionProviderError::new(
                        "durable question identity conflicts with this tool invocation",
                    ));
                }
                if !may_ask {
                    return Err(QuestionProviderError::new(DELEGATED_QUESTION_POLICY));
                }
            }
            None => {
                if !may_ask {
                    return Err(QuestionProviderError::new(DELEGATED_QUESTION_POLICY));
                }
                self.append_and_flush(
                    session_id,
                    EventData::QuestionRequested {
                        invocation: invocation.clone(),
                    }
                    .into(),
                )
                .await
                .map_err(provider_error)?;
            }
        }

        let rpc_id = invocation.interaction_id.clone();
        let (pending, publish) = {
            let mut all = self.pending.write().await;
            if let Some(existing) = all.get(&rpc_id) {
                if existing.session_id != session_id || existing.invocation != invocation {
                    return Err(QuestionProviderError::new(
                        "question RPC identity is already owned by another request",
                    ));
                }
                (Arc::clone(existing), false)
            } else {
                let (settlement, _) = watch::channel(None);
                let pending = Arc::new(PendingQuestion {
                    session_id: session_id.to_owned(),
                    workspace: workspace.to_owned(),
                    invocation,
                    settlement,
                    gate: tokio::sync::Mutex::new(()),
                    deferred: std::sync::atomic::AtomicBool::new(false),
                });
                all.insert(rpc_id, Arc::clone(&pending));
                (pending, true)
            }
        };
        if publish {
            let _ = self.events.send(question_requested_frame(&pending));
        }
        let mut settlement = pending.settlement.subscribe();
        let mut durable_poll = tokio::time::interval(Duration::from_millis(500));
        durable_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // `interval` fires immediately once. Consume that tick because the
        // durable state was folded just above; subsequent ticks are the
        // fallback for answers committed by another Host/process or a missed
        // process-local notification.
        durable_poll.tick().await;
        loop {
            if let Some(result) = settlement.borrow().clone() {
                return settlement_result(result);
            }
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => {
                    return Err(QuestionProviderError { message: "question execution cancelled; pending question retained".into(), retryable: true });
                }
                changed = settlement.changed() => {
                    if changed.is_err() {
                        return Err(QuestionProviderError {
                            message: "question answer channel closed before settlement".to_owned(),
                            retryable: true,
                        });
                    }
                }
                _ = durable_poll.tick() => {
                    let durable = self
                        .question_state(session_id, &pending.invocation.interaction_id)
                        .await
                        .map_err(provider_error)?
                        .ok_or_else(|| QuestionProviderError {
                            message: "durable question disappeared before settlement".to_owned(),
                            retryable: true,
                        })?;
                    if durable.0.invocation() != &pending.invocation {
                        return Err(QuestionProviderError::new(
                            "durable question identity changed while waiting",
                        ));
                    }
                    match durable.1 {
                        QuestionTerminalState::Pending => {
                            if !cancellation.is_cancelled() && self.defer_if_due(&pending).await.map_err(provider_error)? {
                                if cancellation.is_cancelled() { return Err(QuestionProviderError::new("question execution cancelled")); }
                                return Ok(continuation::deferred_resolution(&pending.invocation));
                            }
                        }
                        QuestionTerminalState::Resolved(resolution) => {
                            self.persist_agent_markdown(
                                &pending.workspace,
                                &pending.invocation,
                                &resolution,
                            )
                            .await
                            .map_err(provider_error)?;
                            self.finish_pending(&pending, QuestionOutcome::Answered).await;
                            return Ok(resolution);
                        }
                        QuestionTerminalState::Cancelled(reason) => {
                            self.finish_pending(&pending, QuestionOutcome::Cancelled).await;
                            return Err(QuestionProviderError::new(reason));
                        }
                    }
                }
                _ = cancellation.cancelled() => {
                    // Cancellation detaches this execution but deliberately
                    // leaves the durable interaction pending. Shutdown and
                    // process replacement must not silently answer for the user.
                    return Err(QuestionProviderError {
                        message: "ask_user_question execution detached before the user answered".to_owned(),
                        retryable: true,
                    });
                }
            }
        }
    }

    pub(crate) async fn respond(&self, response: ClientResponse) -> RpcReceipt {
        if response.kind != ClientResponseKind::ClientResponse {
            return rejected(ReceiptRejection::BadResponse);
        }
        let rpc_id = response.rpc_id.as_str();
        let pending = self.pending.read().await.get(rpc_id).cloned();
        let Some(pending) = pending else {
            return rejected(ReceiptRejection::NotPending);
        };
        let result = match response.result {
            RpcResult::Success { value: Some(value) } => {
                self.resolve_response(&pending, value).await
            }
            RpcResult::Failure { error } if error.code == xharness_api::RpcErrorCode::Cancelled => {
                self.cancel_pending(&pending, error.message).await
            }
            _ => Err(QuestionHubError::BadResponse(
                "question response must contain an answer or cancelled error".to_owned(),
            )),
        };
        match result {
            Ok(()) => RpcReceipt::Accepted,
            Err(QuestionHubError::NotPending) => rejected(ReceiptRejection::NotPending),
            Err(_) => rejected(ReceiptRejection::BadResponse),
        }
    }

    async fn resolve_response(
        &self,
        pending: &Arc<PendingQuestion>,
        value: Value,
    ) -> Result<(), QuestionHubError> {
        let _gate = pending.gate.lock().await;
        if value.get("sessionId").and_then(Value::as_str) != Some(&pending.session_id) {
            return Err(QuestionHubError::BadResponse(
                "sessionId does not own this question".to_owned(),
            ));
        }
        let answers = parse_answers(&pending.invocation, &value)?;
        let mut interaction = self
            .question_state(&pending.session_id, &pending.invocation.interaction_id)
            .await?
            .ok_or(QuestionHubError::NotPending)?
            .0;
        let resolution = match interaction.terminal_state() {
            QuestionTerminalState::Pending | QuestionTerminalState::Resolved(_) => interaction
                .resolve(ResolveAction::Continue, answers)
                .map_err(|error| QuestionHubError::BadResponse(error.to_string()))?,
            QuestionTerminalState::Cancelled(_) => return Err(QuestionHubError::NotPending),
        };
        if matches!(
            self.question_state(&pending.session_id, &pending.invocation.interaction_id)
                .await?
                .map(|(_, state)| state),
            Some(QuestionTerminalState::Pending)
        ) {
            self.append_and_flush(
                &pending.session_id,
                EventData::QuestionResolved {
                    interaction_id: pending.invocation.interaction_id.clone(),
                    resolution: resolution.clone(),
                }
                .into(),
            )
            .await?;
        }
        self.persist_agent_markdown(&pending.workspace, &pending.invocation, &resolution)
            .await?;
        self.deliver_late_answer(pending).await?;
        pending
            .settlement
            .send_replace(Some(QuestionSettlement::Resolved(resolution)));
        self.finish_pending(pending, QuestionOutcome::Answered)
            .await;
        Ok(())
    }

    async fn cancel_pending(
        &self,
        pending: &Arc<PendingQuestion>,
        reason: String,
    ) -> Result<(), QuestionHubError> {
        let _gate = pending.gate.lock().await;
        let reason = if reason.trim().is_empty() {
            "the user closed this question request".to_owned()
        } else {
            reason
        };
        let state = self
            .question_state(&pending.session_id, &pending.invocation.interaction_id)
            .await?
            .ok_or(QuestionHubError::NotPending)?
            .1;
        if let QuestionTerminalState::Cancelled(previous) = &state {
            self.deliver_late_answer(pending).await?;
            pending
                .settlement
                .send_replace(Some(QuestionSettlement::Cancelled(previous.clone())));
            self.finish_pending(pending, QuestionOutcome::Cancelled)
                .await;
            return Ok(());
        }
        if !matches!(state, QuestionTerminalState::Pending) {
            return Err(QuestionHubError::NotPending);
        }
        self.append_and_flush(
            &pending.session_id,
            EventData::QuestionCancelled {
                interaction_id: pending.invocation.interaction_id.clone(),
                reason: reason.clone(),
            }
            .into(),
        )
        .await?;
        self.deliver_late_answer(pending).await?;
        pending
            .settlement
            .send_replace(Some(QuestionSettlement::Cancelled(reason)));
        self.finish_pending(pending, QuestionOutcome::Cancelled)
            .await;
        Ok(())
    }

    async fn finish_pending(&self, pending: &PendingQuestion, outcome: QuestionOutcome) {
        let removed = self
            .pending
            .write()
            .await
            .remove(&pending.invocation.interaction_id)
            .is_some();
        if !removed {
            return;
        }
        let payload = json!({
            "type": "question/resolved",
            "sessionId": pending.session_id,
            "questionRpcId": pending.invocation.interaction_id,
            "outcome": outcome,
        });
        let _ = self.events.send(ServerRequest::new(
            RpcId::new(format!(
                "question-resolution:{}",
                pending.invocation.interaction_id
            )),
            "question/resolved",
            payload,
        ));
    }

    async fn question_state(
        &self,
        session_id: &str,
        interaction_id: &str,
    ) -> Result<Option<(QuestionInteraction, QuestionTerminalState)>, QuestionHubError> {
        let store = self.store.as_ref().ok_or_else(|| {
            QuestionHubError::Persistence("durable question service is unavailable".to_owned())
        })?;
        let session = store
            .load(session_id)
            .await
            .map_err(store_error)?
            .ok_or_else(|| QuestionHubError::Persistence("session not found".to_owned()))?;
        let question = xharness_session::all_user_questions(session.events())
            .into_iter()
            .find(|question| question.invocation.interaction_id == interaction_id);
        let Some(question) = question else {
            return Ok(None);
        };
        let mut interaction = QuestionInteraction::new(question.invocation)
            .map_err(|error| QuestionHubError::Persistence(error.to_string()))?;
        if !question.draft.is_empty() {
            interaction
                .update_draft(question.draft)
                .map_err(|error| QuestionHubError::Persistence(error.to_string()))?;
        }
        match &question.terminal {
            QuestionTerminalState::Pending => {}
            QuestionTerminalState::Resolved(resolution) => {
                let answers = resolution
                    .answers
                    .iter()
                    .map(|answer| QuestionAnswer {
                        question_id: answer.question_id.clone(),
                        selected_option_id: answer.selected_option_id.clone(),
                        custom_text: answer.custom_text.clone(),
                    })
                    .collect();
                interaction
                    .resolve(resolution.action, answers)
                    .map_err(|error| QuestionHubError::Persistence(error.to_string()))?;
            }
            QuestionTerminalState::Cancelled(reason) => interaction
                .cancel(reason.clone())
                .map_err(|error| QuestionHubError::Persistence(error.to_string()))?,
        }
        let terminal = interaction.terminal_state();
        Ok(Some((interaction, terminal)))
    }

    async fn append_and_flush(
        &self,
        session_id: &str,
        event: SessionEvent,
    ) -> Result<(), QuestionHubError> {
        let store = self.store.as_ref().ok_or_else(|| {
            QuestionHubError::Persistence("durable question service is unavailable".to_owned())
        })?;
        for attempt in 0..APPEND_RETRIES {
            let session = store
                .load(session_id)
                .await
                .map_err(store_error)?
                .ok_or_else(|| QuestionHubError::Persistence("session not found".to_owned()))?;
            match store
                .append(session_id, session.revision(), vec![event.clone()])
                .await
            {
                Ok(_) => {
                    store.flush(session_id).await.map_err(store_error)?;
                    return Ok(());
                }
                Err(StoreError::RevisionConflict { .. }) if attempt + 1 < APPEND_RETRIES => {}
                Err(error) => return Err(store_error(error)),
            }
        }
        Err(QuestionHubError::Persistence(
            "question append exceeded its conflict retry budget".to_owned(),
        ))
    }

    async fn persist_agent_markdown(
        &self,
        workspace: &str,
        invocation: &QuestionInvocation,
        resolution: &QuestionResolution,
    ) -> Result<(), QuestionHubError> {
        if !resolution
            .answers
            .iter()
            .any(|answer| answer.destination == AnswerDestination::AgentMarkdown)
        {
            return Ok(());
        }
        self.sink
            .persist(Path::new(workspace), invocation, resolution)
            .await
            .map_err(QuestionHubError::AgentMarkdown)
    }
}

#[derive(Clone)]
pub struct DurableQuestionProvider {
    hub: Arc<DurableQuestionHub>,
    session_id: String,
    workspace: String,
}

impl DurableQuestionProvider {
    pub fn new(
        hub: Arc<DurableQuestionHub>,
        session_id: impl Into<String>,
        workspace: impl Into<String>,
    ) -> Self {
        Self {
            hub,
            session_id: session_id.into(),
            workspace: workspace.into(),
        }
    }
}

#[async_trait]
impl UserQuestionProvider for DurableQuestionProvider {
    async fn ask(
        &self,
        invocation: QuestionInvocation,
        cancellation: CancellationToken,
    ) -> Result<QuestionResolution, QuestionProviderError> {
        self.hub
            .ask(&self.session_id, &self.workspace, invocation, cancellation)
            .await
    }
}

fn parse_answers(
    invocation: &QuestionInvocation,
    value: &Value,
) -> Result<Vec<QuestionAnswer>, QuestionHubError> {
    let raw = value
        .get("answer")
        .and_then(|answer| answer.get("answers"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            QuestionHubError::BadResponse("answer.answers must be an array".to_owned())
        })?;
    let mut seen = BTreeMap::<String, ()>::new();
    let mut answers = Vec::with_capacity(raw.len());
    for item in raw {
        let id = item.get("id").and_then(Value::as_str).ok_or_else(|| {
            QuestionHubError::BadResponse("answer id must be a string".to_owned())
        })?;
        if seen.insert(id.to_owned(), ()).is_some() {
            return Err(QuestionHubError::BadResponse(format!(
                "question {id:?} appears more than once"
            )));
        }
        let question = invocation
            .request
            .questions
            .iter()
            .find(|question| question.id == id)
            .ok_or_else(|| QuestionHubError::BadResponse(format!("unknown question {id:?}")))?;
        let selected = item
            .get("selected")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                QuestionHubError::BadResponse(format!("question {id:?} selected must be an array"))
            })?;
        if selected.len() > 1 {
            return Err(QuestionHubError::BadResponse(format!(
                "question {id:?} is single-select"
            )));
        }
        let selected_option_id = selected
            .first()
            .map(|selected| {
                let label = selected.as_str().ok_or_else(|| {
                    QuestionHubError::BadResponse(format!(
                        "question {id:?} selection must be a string"
                    ))
                })?;
                question
                    .options
                    .iter()
                    .find(|option| option.label == label)
                    .map(|option| option.id.clone())
                    .ok_or_else(|| {
                        QuestionHubError::BadResponse(format!(
                            "question {id:?} has unknown option label {label:?}"
                        ))
                    })
            })
            .transpose()?;
        let custom_text = item
            .get("custom")
            .map(|custom| {
                custom.as_str().map(str::to_owned).ok_or_else(|| {
                    QuestionHubError::BadResponse(format!(
                        "question {id:?} custom answer must be a string"
                    ))
                })
            })
            .transpose()?;
        answers.push(QuestionAnswer {
            question_id: id.to_owned(),
            selected_option_id,
            custom_text,
        });
    }
    Ok(answers)
}

fn question_requested_frame(pending: &PendingQuestion) -> ServerRequest {
    let questions = pending
        .invocation
        .request
        .questions
        .iter()
        .map(|question| {
            let options = question
                .options
                .iter()
                .map(|option| {
                    let mut value = json!({ "label": option.label });
                    if let Some(description) = &option.description {
                        value["description"] = Value::String(description.clone());
                    }
                    value
                })
                .collect::<Vec<_>>();
            json!({
                "id": question.id,
                "header": question.header,
                "question": question.question,
                "options": options,
                "multiSelect": false,
            })
        })
        .collect::<Vec<_>>();
    ServerRequest::new(
        RpcId::new(&pending.invocation.interaction_id),
        "question/requested",
        json!({
            "type": "question/requested",
            "sessionId": pending.session_id,
            "questions": questions,
            "deferred": pending.deferred.load(std::sync::atomic::Ordering::Acquire),
            "waitTimeoutSeconds": 60,
        }),
    )
}

fn settlement_result(
    settlement: QuestionSettlement,
) -> Result<QuestionResolution, QuestionProviderError> {
    match settlement {
        QuestionSettlement::Resolved(resolution) => Ok(resolution),
        QuestionSettlement::Cancelled(reason) => Err(QuestionProviderError::new(reason)),
    }
}

fn provider_error(error: QuestionHubError) -> QuestionProviderError {
    QuestionProviderError {
        message: error.to_string(),
        retryable: matches!(error, QuestionHubError::Persistence(_)),
    }
}

fn store_error(error: StoreError) -> QuestionHubError {
    QuestionHubError::Persistence(error.to_string())
}

/// Extract only the Host-managed memory section for prompt injection. Other
/// AGENTS.md content keeps its ordinary repository semantics and is not
/// silently promoted by this product-specific sink.
pub fn managed_agent_memory(text: &str) -> Option<String> {
    let start = text.find(AGENT_MEMORY_BEGIN)? + AGENT_MEMORY_BEGIN.len();
    let tail = &text[start..];
    let end = tail.find(AGENT_MEMORY_END)?;
    let content = tail[..end].trim();
    (!content.is_empty()).then(|| content.to_owned())
}

/// Idempotently upsert one accepted durable-answer entry into the managed
/// AGENTS.md section while preserving every byte outside that section.
pub fn update_agent_markdown(
    existing: &str,
    invocation: &QuestionInvocation,
    resolution: &QuestionResolution,
) -> Result<String, String> {
    let durable = resolution
        .answers
        .iter()
        .filter(|answer| answer.destination == AnswerDestination::AgentMarkdown)
        .collect::<Vec<_>>();
    if durable.is_empty() {
        return Ok(existing.to_owned());
    }
    let key = invocation
        .interaction_id
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let entry_begin = format!("<!-- XHARNESS:ENTRY:{key}:BEGIN -->");
    let entry_end = format!("<!-- XHARNESS:ENTRY:{key}:END -->");
    let mut body = String::new();
    body.push_str(&entry_begin);
    body.push('\n');
    for answer in durable {
        let question = invocation
            .request
            .questions
            .iter()
            .find(|question| question.id == answer.question_id)
            .ok_or_else(|| {
                format!(
                    "resolution references unknown question {:?}",
                    answer.question_id
                )
            })?;
        let mut values = Vec::new();
        if let Some(label) = &answer.selected_label {
            values.push(label.trim().to_owned());
        }
        if let Some(custom) = &answer.custom_text {
            let custom = custom.trim();
            if !custom.is_empty() {
                values.push(custom.to_owned());
            }
        }
        let value = if values.is_empty() {
            "（未回答）".to_owned()
        } else {
            values.join("；")
        };
        body.push_str("- **");
        body.push_str(&sanitize_managed_markers(&question.question));
        body.push_str("**：");
        body.push_str(&sanitize_managed_markers(&value));
        body.push('\n');
    }
    body.push_str(&entry_end);

    let mut output = existing.to_owned();
    match (
        output.find(AGENT_MEMORY_BEGIN),
        output.find(AGENT_MEMORY_END),
    ) {
        (Some(section_start), Some(section_end)) if section_start < section_end => {
            let content_start = section_start + AGENT_MEMORY_BEGIN.len();
            let section = &output[content_start..section_end];
            if let Some(relative_start) = section.find(&entry_begin) {
                let absolute_start = content_start + relative_start;
                let after_start = absolute_start + entry_begin.len();
                let relative_end = output[after_start..section_end]
                    .find(&entry_end)
                    .ok_or_else(|| "managed AGENTS.md entry has no closing marker".to_owned())?;
                let absolute_end = after_start + relative_end + entry_end.len();
                output.replace_range(absolute_start..absolute_end, &body);
            } else {
                let insertion = format!("\n\n{body}\n");
                output.insert_str(section_end, &insertion);
            }
        }
        (None, None) => {
            if !output.is_empty() && !output.ends_with('\n') {
                output.push('\n');
            }
            if !output.is_empty() {
                output.push('\n');
            }
            output.push_str(AGENT_MEMORY_BEGIN);
            output.push_str("\n## XHarness 持久目标\n\n");
            output.push_str(&body);
            output.push('\n');
            output.push_str(AGENT_MEMORY_END);
            output.push('\n');
        }
        _ => return Err("managed AGENTS.md section markers are unbalanced".to_owned()),
    }
    Ok(output)
}

fn sanitize_managed_markers(text: &str) -> String {
    text.replace("<!-- XHARNESS:", "&lt;!-- XHARNESS:")
}

const fn rejected(reason: ReceiptRejection) -> RpcReceipt {
    RpcReceipt::Rejected { reason }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::{stream, StreamExt};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex as StdMutex,
    };
    use xharness_core::{
        AgentMessage, FinishReason, LoopEngine, LoopRequest, LoopStatus, ModelProvider,
        ProviderError, ProviderEvent, ProviderRequest, ProviderStream, TokenUsage,
    };
    use xharness_interaction::{
        AnswerDestination, AskUserQuestionRequest, AskUserQuestionTool, QuestionOption,
        QuestionSpec,
    };
    use xharness_session::{MemorySessionStore, Message, Revision, SessionHeader, ToolCall};

    #[derive(Default)]
    struct RecordingSink(StdMutex<Vec<String>>);

    #[async_trait]
    impl AgentMarkdownSink for RecordingSink {
        async fn persist(
            &self,
            _workspace: &Path,
            invocation: &QuestionInvocation,
            _resolution: &QuestionResolution,
        ) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .push(invocation.interaction_id.clone());
            Ok(())
        }
    }

    #[derive(Default)]
    struct QuestionLoopProvider(AtomicUsize);

    #[async_trait]
    impl ModelProvider for QuestionLoopProvider {
        async fn stream(
            &self,
            _request: ProviderRequest,
            _cancellation: CancellationToken,
        ) -> Result<ProviderStream, ProviderError> {
            let step = self.0.fetch_add(1, Ordering::SeqCst);
            let events = if step == 0 {
                vec![
                    Ok(ProviderEvent::ToolCallDelta {
                        index: 0,
                        id: "provider-question".to_owned(),
                        name: xharness_interaction::ASK_USER_QUESTION_TOOL.to_owned(),
                        arguments_delta: serde_json::to_string(&request(
                            AnswerDestination::Context,
                        ))
                        .unwrap(),
                    }),
                    Ok(ProviderEvent::Completed {
                        finish_reason: Some(FinishReason::ToolCalls),
                        usage: Some(TokenUsage::default()),
                        provider_items: Vec::new(),
                    }),
                ]
            } else {
                vec![
                    Ok(ProviderEvent::TextDelta("continued".to_owned())),
                    Ok(ProviderEvent::Completed {
                        finish_reason: Some(FinishReason::Stop),
                        usage: Some(TokenUsage::default()),
                        provider_items: Vec::new(),
                    }),
                ]
            };
            Ok(Box::pin(stream::iter(events)))
        }
    }

    fn request(destination: AnswerDestination) -> AskUserQuestionRequest {
        AskUserQuestionRequest {
            questions: vec![QuestionSpec {
                id: "target".to_owned(),
                header: "部署".to_owned(),
                question: "部署到哪里？".to_owned(),
                options: vec![
                    QuestionOption {
                        id: "tokyo".to_owned(),
                        label: "东京 (Recommended)".to_owned(),
                        description: Some("公开服务".to_owned()),
                        recommended: true,
                    },
                    QuestionOption {
                        id: "local".to_owned(),
                        label: "本机".to_owned(),
                        description: None,
                        recommended: false,
                    },
                ],
                allow_custom: true,
                destination,
                blocks_goal: true,
            }],
        }
    }

    async fn session_with_question_call(store: &Arc<dyn Store>, session_id: &str) {
        let mut header = SessionHeader::new(session_id);
        header.cwd = Some("/workspace".to_owned());
        store.create(header).await.unwrap();
        let call = ToolCall {
            id: "execution-1".to_owned(),
            provider_call_id: Some("provider-1".to_owned()),
            index: 0,
            name: xharness_interaction::ASK_USER_QUESTION_TOOL.to_owned(),
            arguments_json: serde_json::to_string(&request(AnswerDestination::AgentMarkdown))
                .unwrap(),
        };
        let mut assistant = Message::assistant("");
        assistant.tool_calls.push(call.clone());
        store
            .append(
                session_id,
                Revision::ZERO,
                vec![
                    EventData::TurnStart { turn: 1 }.into(),
                    EventData::UserMessage {
                        message: Message::user("开始"),
                        surface_replace: None,
                    }
                    .into(),
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
                ],
            )
            .await
            .unwrap();
        store.flush(session_id).await.unwrap();
    }

    #[tokio::test]
    async fn delegated_question_gate_rejects_before_ui_or_persistence_even_after_restart() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        session_with_question_call(&store, "delegated-question").await;
        let snapshot = store.load("delegated-question").await.unwrap().unwrap();
        store
            .append(
                "delegated-question",
                snapshot.revision(),
                vec![EventData::AgentDelegated {
                    parent_session_id: "parent".into(),
                    invocation_id: "delegate".into(),
                    task: "review".into(),
                }
                .into()],
            )
            .await
            .unwrap();
        let before = store.load("delegated-question").await.unwrap().unwrap();
        for _ in 0..2 {
            let sink = Arc::new(RecordingSink::default());
            let hub = DurableQuestionHub::new(store.clone(), sink.clone());
            let mut frames = hub.subscribe();
            assert!(!hub
                .allows_user_questions("delegated-question")
                .await
                .unwrap());
            let provider =
                DurableQuestionProvider::new(hub.clone(), "delegated-question", "/workspace");
            let error = tokio::time::timeout(
                Duration::from_secs(1),
                provider.ask(
                    QuestionInvocation::new(
                        "execution-1",
                        request(AnswerDestination::AgentMarkdown),
                    ),
                    CancellationToken::new(),
                ),
            )
            .await
            .unwrap()
            .unwrap_err();
            assert!(error.message.contains("parent agent"));
            assert!(!error.retryable);
            assert!(frames.try_recv().is_err());
            assert!(hub.baseline().await.is_empty());
            assert!(sink.0.lock().unwrap().is_empty());
            assert_eq!(
                store
                    .load("delegated-question")
                    .await
                    .unwrap()
                    .unwrap()
                    .events(),
                before.events()
            );
        }
    }

    #[tokio::test]
    async fn delegated_question_gate_allows_normal_forks_and_fails_closed_without_identity() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        session_with_question_call(&store, "question-fork").await;
        let snapshot = store.load("question-fork").await.unwrap().unwrap();
        store
            .append(
                "question-fork",
                snapshot.revision(),
                vec![
                    EventData::AgentDelegated {
                        parent_session_id: "parent".into(),
                        invocation_id: "old".into(),
                        task: "copied history".into(),
                    }
                    .into(),
                    EventData::SessionForkOrigin {
                        parent_session_id: "old-child".into(),
                        before_user_seq: None,
                    }
                    .into(),
                ],
            )
            .await
            .unwrap();
        let hub = DurableQuestionHub::new(store, Arc::new(NoopAgentMarkdownSink));
        assert!(hub.allows_user_questions("question-fork").await.unwrap());
        assert!(hub.allows_user_questions("missing").await.is_err());
        assert!(DurableQuestionHub::unavailable()
            .allows_user_questions("unknown")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn delegated_question_gate_does_not_restore_old_child_question_dialogs() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        session_with_question_call(&store, "old-child-question").await;
        let invocation =
            QuestionInvocation::new("execution-1", request(AnswerDestination::AgentMarkdown));
        let snapshot = store.load("old-child-question").await.unwrap().unwrap();
        store
            .append(
                "old-child-question",
                snapshot.revision(),
                vec![
                    EventData::AgentDelegated {
                        parent_session_id: "parent".into(),
                        invocation_id: "old".into(),
                        task: "review".into(),
                    }
                    .into(),
                    EventData::QuestionRequested {
                        invocation: invocation.clone(),
                    }
                    .into(),
                    EventData::QuestionDeferred {
                        interaction_id: invocation.interaction_id,
                    }
                    .into(),
                ],
            )
            .await
            .unwrap();
        let hub = DurableQuestionHub::new(store.clone(), Arc::new(NoopAgentMarkdownSink));
        let snapshot = store.load("old-child-question").await.unwrap().unwrap();
        let cancellations = delegated_question_cancellations(&snapshot);
        assert_eq!(cancellations.len(), 1);
        store
            .append("old-child-question", snapshot.revision(), cancellations)
            .await
            .unwrap();
        let closed = store.load("old-child-question").await.unwrap().unwrap();
        assert!(!xharness_session::has_unanswered_deferred_question(
            closed.events()
        ));
        assert!(
            matches!(xharness_session::all_user_questions(closed.events())[0].terminal,
            QuestionTerminalState::Cancelled(ref reason) if reason.starts_with("Runtime policy"))
        );
        assert!(
            delegated_question_cancellations(&closed).is_empty(),
            "migration must be idempotent"
        );
        hub.restore_snapshot(&closed).await;
        assert!(hub.baseline().await.is_empty());
        assert!(hub.pending.read().await.is_empty());
        assert_eq!(
            store
                .load("old-child-question")
                .await
                .unwrap()
                .unwrap()
                .events(),
            closed.events()
        );
    }

    #[tokio::test]
    async fn delegated_question_gate_preserves_previously_accepted_answer_without_dialog() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let id = "answered-child";
        session_with_question_call(&store, id).await;
        let invocation =
            QuestionInvocation::new("execution-1", request(AnswerDestination::AgentMarkdown));
        let mut interaction = QuestionInteraction::new(invocation.clone()).unwrap();
        let resolution = interaction
            .resolve(
                ResolveAction::Continue,
                vec![QuestionAnswer {
                    question_id: "target".into(),
                    selected_option_id: None,
                    custom_text: Some("local".into()),
                }],
            )
            .unwrap();
        let before = store.load(id).await.unwrap().unwrap();
        store
            .append(
                id,
                before.revision(),
                vec![
                    EventData::AgentDelegated {
                        parent_session_id: "parent".into(),
                        invocation_id: "old".into(),
                        task: "review".into(),
                    }
                    .into(),
                    EventData::QuestionRequested {
                        invocation: invocation.clone(),
                    }
                    .into(),
                    EventData::QuestionDeferred {
                        interaction_id: invocation.interaction_id.clone(),
                    }
                    .into(),
                    EventData::QuestionResolved {
                        interaction_id: invocation.interaction_id.clone(),
                        resolution: resolution.clone(),
                    }
                    .into(),
                ],
            )
            .await
            .unwrap();
        let snapshot = store.load(id).await.unwrap().unwrap();
        assert!(delegated_question_cancellations(&snapshot).is_empty());
        let hub = DurableQuestionHub::new(store.clone(), Arc::new(NoopAgentMarkdownSink));
        hub.restore_snapshot(&snapshot).await;
        assert_eq!(
            hub.pending.read().await.len(),
            1,
            "accepted late answer outbox must survive"
        );
        assert!(
            hub.baseline().await.is_empty(),
            "old accepted answer must not reopen a child dialog"
        );
        let mut frames = hub.subscribe();
        let provider = DurableQuestionProvider::new(hub, id, "/workspace");
        assert_eq!(
            provider
                .ask(invocation, CancellationToken::new())
                .await
                .unwrap(),
            resolution
        );
        assert!(provider
            .ask(
                QuestionInvocation::new("new-question", request(AnswerDestination::Context)),
                CancellationToken::new()
            )
            .await
            .is_err());
        assert!(frames.try_recv().is_err());
        assert_eq!(
            store.load(id).await.unwrap().unwrap().events(),
            snapshot.events()
        );
    }

    #[tokio::test]
    async fn deferred_wait_is_not_an_answer_replays_once_and_survives_restore() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        session_with_question_call(&store, "deferred").await;
        let sink = Arc::new(RecordingSink::default());
        let mut hub = DurableQuestionHub::new(store.clone(), sink.clone());
        Arc::get_mut(&mut hub).unwrap().wait_timeout = Duration::ZERO;
        let invocation =
            QuestionInvocation::new("execution-1", request(AnswerDestination::AgentMarkdown));
        let answer = hub
            .ask(
                "deferred",
                "/workspace",
                invocation.clone(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            answer.status,
            xharness_interaction::ResolutionStatus::Deferred
        );
        assert!(answer.answers.is_empty());
        assert_eq!(answer.unanswered_question_ids, ["target"]);
        assert!(sink.0.lock().unwrap().is_empty());
        assert_eq!(hub.baseline().await[0].payload["deferred"], true);
        let restored = DurableQuestionHub::new(store.clone(), sink);
        restored.restore_detached().await.unwrap();
        assert_eq!(restored.baseline().await.len(), 1);
        // Default 60 seconds does not reset an already-expired persisted wait.
        let replay = restored
            .ask(
                "deferred",
                "/workspace",
                invocation,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(replay, answer);
        let session = store.load("deferred").await.unwrap().unwrap();
        assert_eq!(
            session
                .events()
                .iter()
                .filter(|e| matches!(e.data(), EventData::QuestionDeferred { .. }))
                .count(),
            1
        );
        assert!(xharness_session::has_unanswered_deferred_question(
            session.events()
        ));
        assert!(!session
            .events()
            .iter()
            .any(|e| matches!(e.data(), EventData::QuestionResolved { .. })));
    }

    #[tokio::test]
    async fn answer_before_deadline_and_deadline_race_do_not_double_settle() {
        for expire in [false, true] {
            let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
            session_with_question_call(&store, "deadline-race").await;
            let mut hub = DurableQuestionHub::new(store.clone(), Arc::new(NoopAgentMarkdownSink));
            if expire {
                Arc::get_mut(&mut hub).unwrap().wait_timeout = Duration::ZERO;
            }
            let invocation =
                QuestionInvocation::new("execution-1", request(AnswerDestination::AgentMarkdown));
            let mut frames = hub.subscribe();
            let h = hub.clone();
            let waiter = tokio::spawn(async move {
                h.ask(
                    "deadline-race",
                    "/workspace",
                    invocation,
                    CancellationToken::new(),
                )
                .await
            });
            frames.recv().await.unwrap();
            let pending = hub
                .pending
                .read()
                .await
                .get("question:execution-1")
                .unwrap()
                .clone();
            if !expire {
                assert!(!hub.defer_if_due(&pending).await.unwrap());
            }
            let response = json!({"sessionId":"deadline-race","answer":{"answers":[{"id":"target","selected":["本机"]}]}});
            let (_, answer) = tokio::join!(
                hub.defer_if_due(&pending),
                hub.resolve_response(&pending, response)
            );
            if !expire {
                assert!(answer.is_ok());
            }
            let result = tokio::time::timeout(Duration::from_secs(2), waiter)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_ne!(
                result.status,
                xharness_interaction::ResolutionStatus::Skipped
            );
            let session = store.load("deadline-race").await.unwrap().unwrap();
            assert_eq!(
                session
                    .events()
                    .iter()
                    .filter(|e| matches!(e.data(), EventData::QuestionResolved { .. }))
                    .count(),
                1
            );
            assert!(
                session
                    .events()
                    .iter()
                    .filter(|e| matches!(e.data(), EventData::QuestionDeferred { .. }))
                    .count()
                    <= 1
            );
            assert!(!xharness_session::has_unanswered_deferred_question(
                session.events()
            ));
        }
    }

    #[tokio::test]
    async fn cancellation_does_not_trigger_timeout_continuation() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        session_with_question_call(&store, "cancel-defer").await;
        let mut hub = DurableQuestionHub::new(store.clone(), Arc::new(NoopAgentMarkdownSink));
        Arc::get_mut(&mut hub).unwrap().wait_timeout = Duration::ZERO;
        let cancel = CancellationToken::new();
        cancel.cancel();
        let result = hub
            .ask(
                "cancel-defer",
                "/workspace",
                QuestionInvocation::new("execution-1", request(AnswerDestination::AgentMarkdown)),
                cancel,
            )
            .await;
        assert!(result.is_err());
        tokio::time::sleep(Duration::from_millis(550)).await;
        let session = store.load("cancel-defer").await.unwrap().unwrap();
        assert!(!xharness_session::question_is_deferred(
            session.events(),
            "question:execution-1"
        ));
    }

    #[tokio::test]
    async fn live_loop_deferred_question_keeps_question_without_restricting_tools() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        store
            .create(SessionHeader::new("live-defer"))
            .await
            .unwrap();
        let mut hub = DurableQuestionHub::new(store.clone(), Arc::new(NoopAgentMarkdownSink));
        Arc::get_mut(&mut hub).unwrap().wait_timeout = Duration::ZERO;
        let registry = Arc::new(xharness_tools::ToolRegistry::new());
        AskUserQuestionTool::new(Arc::new(DurableQuestionProvider::new(
            hub.clone(),
            "live-defer",
            "/workspace",
        )))
        .register(&registry)
        .await
        .unwrap();
        let mut request = LoopRequest::new(
            Arc::new(QuestionLoopProvider::default()),
            vec![AgentMessage::user("ask")],
        );
        request.session_id = Some("live-defer".into());
        request.journal_store = Some(store.clone());
        request.tool_executor = Some(xharness_tools::ToolExecutor::new(registry));
        let mut run = LoopEngine.start(request);
        while run.next().await.is_some() {}
        let result = run.result().await;
        assert_eq!(result.status, LoopStatus::Completed, "{:?}", result.error);
        let s = store.load("live-defer").await.unwrap().unwrap();
        assert!(s.recoverable_user_questions().is_empty());
        assert_eq!(s.pending_user_questions().len(), 1);
        assert_eq!(hub.baseline().await.len(), 1);
        // A late answer remains durable even if delivery is temporarily unavailable.
        let pending = hub.pending.read().await.values().next().unwrap().clone();
        let error=hub.resolve_response(&pending,json!({"sessionId":"live-defer","answer":{"answers":[{"id":"target","selected":["本机"]}]}})).await.unwrap_err();
        assert!(error.to_string().contains("retained for retry"));
        let s = store.load("live-defer").await.unwrap().unwrap();
        assert!(!xharness_session::has_unanswered_deferred_question(
            s.events()
        ));
        assert!(matches!(
            xharness_session::all_user_questions(s.events())[0].terminal,
            QuestionTerminalState::Resolved(_)
        ));
    }

    #[tokio::test]
    async fn durable_provider_projects_web_frame_persists_answer_and_replays_resolution() {
        let concrete = Arc::new(MemorySessionStore::default());
        let store: Arc<dyn Store> = concrete;
        session_with_question_call(&store, "question-session").await;
        let sink = Arc::new(RecordingSink::default());
        let hub = DurableQuestionHub::new(store.clone(), sink.clone());
        let mut frames = hub.subscribe();
        let provider =
            DurableQuestionProvider::new(Arc::clone(&hub), "question-session", "/workspace");
        let invocation =
            QuestionInvocation::new("execution-1", request(AnswerDestination::AgentMarkdown));
        let expected_invocation = invocation.clone();
        let waiting =
            tokio::spawn(async move { provider.ask(invocation, CancellationToken::new()).await });
        let frame = frames.recv().await.unwrap();
        assert_eq!(frame.rpc_id.as_str(), "question:execution-1");
        assert_eq!(frame.payload["type"], "question/requested");
        assert_eq!(
            frame.payload["questions"][0]["options"][0]["label"],
            "东京 (Recommended)"
        );
        let pending = hub
            .pending
            .read()
            .await
            .get("question:execution-1")
            .cloned()
            .unwrap();

        let receipt = hub
            .respond(ClientResponse {
                kind: ClientResponseKind::ClientResponse,
                rpc_id: frame.rpc_id,
                result: RpcResult::success(json!({
                    "sessionId": "question-session",
                    "answer": {"answers": [{
                        "id": "target",
                        "selected": ["东京 (Recommended)"],
                    }]},
                })),
            })
            .await;
        assert_eq!(receipt, RpcReceipt::Accepted);
        let resolution = waiting.await.unwrap().unwrap();
        assert_eq!(
            resolution.answers[0].selected_option_id.as_deref(),
            Some("tokyo")
        );
        assert_eq!(sink.0.lock().unwrap().as_slice(), ["question:execution-1"]);
        assert!(hub.baseline().await.is_empty());

        let session = store.load("question-session").await.unwrap().unwrap();
        assert!(session.pending_user_questions().is_empty());
        assert_eq!(session.recoverable_user_questions().len(), 1);
        assert!(matches!(
            session.recoverable_user_questions()[0].terminal,
            QuestionTerminalState::Resolved(_)
        ));

        let replayed =
            DurableQuestionProvider::new(Arc::clone(&hub), "question-session", "/workspace")
                .ask(expected_invocation, CancellationToken::new())
                .await
                .unwrap();
        assert_eq!(replayed, resolution);
        assert_eq!(sink.0.lock().unwrap().len(), 2);

        let conflicting = hub
            .resolve_response(
                &pending,
                json!({
                    "sessionId": "question-session",
                    "answer": {"answers": [{
                        "id": "target",
                        "selected": ["本机"],
                    }]},
                }),
            )
            .await;
        assert!(matches!(conflicting, Err(QuestionHubError::BadResponse(_))));
    }

    #[tokio::test]
    async fn durable_provider_observes_a_resolution_committed_outside_its_process_channel() {
        let concrete = Arc::new(MemorySessionStore::default());
        let store: Arc<dyn Store> = concrete;
        session_with_question_call(&store, "external-settlement").await;
        let hub = DurableQuestionHub::new(store.clone(), Arc::new(NoopAgentMarkdownSink));
        let mut frames = hub.subscribe();
        let invocation =
            QuestionInvocation::new("execution-1", request(AnswerDestination::AgentMarkdown));
        let provider =
            DurableQuestionProvider::new(Arc::clone(&hub), "external-settlement", "/workspace");
        let waiting =
            tokio::spawn(async move { provider.ask(invocation, CancellationToken::new()).await });
        frames.recv().await.unwrap();

        let mut interaction = QuestionInteraction::new(QuestionInvocation::new(
            "execution-1",
            request(AnswerDestination::AgentMarkdown),
        ))
        .unwrap();
        let resolution = interaction
            .resolve(
                ResolveAction::Continue,
                vec![QuestionAnswer {
                    question_id: "target".to_owned(),
                    selected_option_id: Some("local".to_owned()),
                    custom_text: None,
                }],
            )
            .unwrap();
        let session = store.load("external-settlement").await.unwrap().unwrap();
        store
            .append(
                "external-settlement",
                session.revision(),
                vec![EventData::QuestionResolved {
                    interaction_id: "question:execution-1".to_owned(),
                    resolution: resolution.clone(),
                }
                .into()],
            )
            .await
            .unwrap();
        store.flush("external-settlement").await.unwrap();

        let observed = tokio::time::timeout(Duration::from_secs(2), waiting)
            .await
            .expect("durable settlement poll did not wake")
            .unwrap()
            .unwrap();
        assert_eq!(observed, resolution);
        assert!(hub.baseline().await.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn live_core_tool_batch_continues_without_restarting_after_the_web_answer() {
        let concrete = Arc::new(MemorySessionStore::default());
        let store: Arc<dyn Store> = concrete;
        store
            .create(SessionHeader::new("live-question-loop"))
            .await
            .unwrap();
        let hub = DurableQuestionHub::new(store.clone(), Arc::new(NoopAgentMarkdownSink));
        let mut frames = hub.subscribe();
        let registry = Arc::new(xharness_tools::ToolRegistry::new());
        xharness_interaction::AskUserQuestionTool::new(Arc::new(DurableQuestionProvider::new(
            Arc::clone(&hub),
            "live-question-loop",
            "/workspace",
        )))
        .register(&registry)
        .await
        .unwrap();
        let mut request = LoopRequest::new(
            Arc::new(QuestionLoopProvider::default()),
            vec![AgentMessage::user("ask")],
        );
        request.session_id = Some("live-question-loop".to_owned());
        request.journal_store = Some(store.clone());
        request.tool_executor = Some(xharness_tools::ToolExecutor::new(registry));
        let mut run = LoopEngine.start(request);
        let completed = tokio::spawn(async move {
            while run.next().await.is_some() {}
            run.result().await
        });

        let frame = frames.recv().await.unwrap();
        assert_eq!(frame.payload["type"], "question/requested");
        assert_eq!(
            hub.respond(ClientResponse {
                kind: ClientResponseKind::ClientResponse,
                rpc_id: frame.rpc_id,
                result: RpcResult::success(json!({
                    "sessionId": "live-question-loop",
                    "answer": {"answers": [{
                        "id": "target",
                        "selected": ["本机"],
                    }]},
                })),
            })
            .await,
            RpcReceipt::Accepted
        );
        let result = tokio::time::timeout(Duration::from_secs(3), completed)
            .await
            .expect("live question tool batch stayed blocked after answer")
            .unwrap();
        assert_eq!(
            result.status,
            LoopStatus::Completed,
            "live question loop failed: {:?}",
            result.error
        );
        assert_eq!(result.final_text, "continued");
    }

    #[tokio::test]
    async fn web_cancel_is_durable_and_unblocks_the_tool_with_an_error() {
        let concrete = Arc::new(MemorySessionStore::default());
        let store: Arc<dyn Store> = concrete;
        session_with_question_call(&store, "cancel-session").await;
        let hub = DurableQuestionHub::new(store, Arc::new(NoopAgentMarkdownSink));
        let mut frames = hub.subscribe();
        let provider = DurableQuestionProvider::new(Arc::clone(&hub), "cancel-session", "/tmp");
        let waiting = tokio::spawn(async move {
            provider
                .ask(
                    QuestionInvocation::new(
                        "execution-1",
                        request(AnswerDestination::AgentMarkdown),
                    ),
                    CancellationToken::new(),
                )
                .await
        });
        let frame = frames.recv().await.unwrap();
        let receipt = hub
            .respond(ClientResponse {
                kind: ClientResponseKind::ClientResponse,
                rpc_id: frame.rpc_id,
                result: RpcResult::failure(xharness_api::RpcError {
                    code: xharness_api::RpcErrorCode::Cancelled,
                    message: "用户跳过整组问题".to_owned(),
                    details: json!({}),
                }),
            })
            .await;
        assert_eq!(receipt, RpcReceipt::Accepted);
        assert!(waiting
            .await
            .unwrap()
            .unwrap_err()
            .message
            .contains("用户跳过"));
    }

    #[test]
    fn managed_agent_markdown_upsert_is_idempotent_and_preserves_user_content() {
        let invocation =
            QuestionInvocation::new("execution-1", request(AnswerDestination::AgentMarkdown));
        let mut interaction = QuestionInteraction::new(invocation.clone()).unwrap();
        let resolution = interaction
            .resolve(
                ResolveAction::Continue,
                vec![QuestionAnswer {
                    question_id: "target".to_owned(),
                    selected_option_id: Some("tokyo".to_owned()),
                    custom_text: Some("端口 8443".to_owned()),
                }],
            )
            .unwrap();
        let first =
            update_agent_markdown("# 用户规则\n\n保留。\n", &invocation, &resolution).unwrap();
        let second = update_agent_markdown(&first, &invocation, &resolution).unwrap();
        assert_eq!(first, second);
        assert!(first.starts_with("# 用户规则\n\n保留。"));
        let memory = managed_agent_memory(&first).unwrap();
        assert!(memory.contains("部署到哪里"));
        assert!(memory.contains("东京 (Recommended)；端口 8443"));
    }
}

//! Thin model adapter and Host composition of durable child conversations.
//! No provider loop or shell job is implemented here.
use crate::{driver::PromptAdmission, rpc::permission_events, BasicHost};
use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{atomic::Ordering, Arc, Weak},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use xharness_agent::{AgentOperation, DelegationRuntime};
use xharness_api::{RpcError, RpcId};
use xharness_core::LoopCommand;
use xharness_session::{EventData, Session, SessionEvent};
use xharness_tools::{ToolConcurrency, ToolDefinition, ToolHandlerError, ToolOutput, ToolSpec};

/// Bind an authenticated caller outside model-controlled arguments.
pub struct AgentTool;
impl AgentTool {
    pub fn spec(runtime: Arc<dyn DelegationRuntime>, caller: impl Into<String>) -> ToolSpec {
        let caller = caller.into();
        ToolSpec::new(ToolDefinition::new("agent",
            "Delegate independent work to a child agent. action=start requires task (optional label); action=send requires agent_id and message; action=inspect optionally takes agent_id (omit to list your children); action=stop requires agent_id. Do not mix fields between actions. Children have separate context: include all necessary background in task. Start/send acknowledge inbox admission, NOT completion. Completion/failure is automatically delivered later; do not repeatedly poll inspect. Stop interrupts the current turn, preserves the conversation and parks pending work; a user prompt can resume it. Children cannot delegate further. Never delegate dependent edits to the same files in parallel.",
            json!({"type":"object","properties":{
                "action":{"type":"string","enum":["start","send","inspect","stop"]},
                "task":{"type":"string"},"label":{"type":"string"},
                "agent_id":{"type":"string"},"message":{"type":"string"}},
                "required":["action"],"additionalProperties":false})), move |context| {
            let runtime = runtime.clone(); let caller = caller.clone();
            async move {
                let operation: AgentOperation = serde_json::from_value((*context.arguments).clone())
                    .map_err(|e| ToolHandlerError::new(format!("invalid agent arguments: {e}")))?;
                operation.validate().map_err(ToolHandlerError::new)?;
                let value = runtime.execute(&caller, context.execution_id.as_str(), operation, context.cancellation).await
                    .map_err(ToolHandlerError::new)?;
                Ok(ToolOutput::text(value.to_string()))
            }
        }).with_concurrency(ToolConcurrency::Parallel).with_timeout(Duration::from_secs(45))
    }
    pub fn for_host(host: &Arc<BasicHost>, caller: &str) -> ToolSpec {
        Self::spec(Arc::new(HostDelegation(Arc::downgrade(host))), caller)
    }
}

struct HostDelegation(Weak<BasicHost>);
#[async_trait]
impl DelegationRuntime for HostDelegation {
    async fn execute(
        &self,
        caller: &str,
        invocation: &str,
        operation: AgentOperation,
        cancellation: CancellationToken,
    ) -> Result<Value, String> {
        operation.validate()?;
        if cancellation.is_cancelled() {
            return Err("agent operation cancelled before admission".into());
        }
        let host = self.0.upgrade().ok_or("agent host is shutting down")?;
        let caller = caller.to_owned();
        let invocation = invocation.to_owned();
        // Once admission begins it must finish even if the tool consumer goes away.
        // A persisted receipt makes retries deterministic; cancellation never rolls
        // back already accepted child work.
        tokio::spawn(async move { host.execute_agent(&caller, &invocation, operation).await })
            .await
            .map_err(|e| format!("agent admission task failed: {e}"))?
    }
}

fn identity(caller: &str, invocation: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(caller.as_bytes());
    hash.update([0]);
    hash.update(invocation.as_bytes());
    format!("agent-{:x}", hash.finalize())
}
fn bounded(text: &str, max: usize) -> &str {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}
pub(crate) fn restored_delegation(session: &Session) -> Option<String> {
    session
        .events()
        .iter()
        .find_map(|event| match event.data() {
            EventData::AgentDelegated {
                parent_session_id, ..
            } => Some(parent_session_id.clone()),
            _ => None,
        })
}
pub(crate) fn restored_dispatch_paused(session: &Session) -> bool {
    session
        .events()
        .iter()
        .rev()
        .find_map(|event| match event.data() {
            EventData::AgentDispatchPaused { paused } => Some(*paused),
            _ => None,
        })
        .unwrap_or(false)
}

impl BasicHost {
    pub(crate) async fn set_dispatch_paused(&self, id: &str, paused: bool) -> Result<(), RpcError> {
        let current = self
            .state
            .read()
            .await
            .sessions
            .get(id)
            .map(|s| s.dispatch_paused)
            .ok_or_else(|| RpcError::internal("agent session not found"))?;
        if current != paused {
            self.commit_session_events(id, vec![EventData::AgentDispatchPaused { paused }.into()])
                .await?;
            if let Some(record) = self.state.write().await.sessions.get_mut(id) {
                record.dispatch_paused = paused;
            }
        }
        Ok(())
    }

    async fn execute_agent(
        &self,
        caller: &str,
        invocation: &str,
        operation: AgentOperation,
    ) -> Result<Value, String> {
        let key = identity(caller, invocation);
        let _operation = self.lock_admission(&format!("agent-operation:{key}")).await;
        match operation {
            AgentOperation::Start { task, label } => {
                self.create_delegated(caller, &key, task, label).await
            }
            AgentOperation::Inspect { agent_id } => {
                let state = self.state.read().await;
                if !state.sessions.contains_key(caller) {
                    return Err("calling agent does not exist".into());
                }
                if let Some(id) = &agent_id {
                    if !state.sessions.get(id).is_some_and(|s| {
                        s.delegated && s.parent_session_id.as_deref() == Some(caller)
                    }) {
                        return Err("agent is not a direct delegated child of this caller".into());
                    }
                }
                let entries: Vec<_> = state.sessions.values().filter(|s| s.delegated && s.parent_session_id.as_deref()==Some(caller)
                    && agent_id.as_ref().is_none_or(|id| id == &s.session_id)).take(128).map(|s| json!({
                    "agent_id":s.session_id,"label":s.title,"status":if s.dispatch_paused && s.running {"stopping"} else if s.dispatch_paused {"paused"} else if s.running {"running"} else {"idle"},
                    "pending_messages":s.queue.len().max(s.projected_queue.len())})).collect();
                Ok(json!({"ok":true,"agents":entries}))
            }
            AgentOperation::Send { agent_id, message } => {
                self.authorize_delegated(caller, &agent_id).await?;
                self.deliver_agent_message(caller, &agent_id, &key, message, "agent-message", true)
                    .await?;
                Ok(json!({"ok":true,"agent_id":agent_id,"message_id":key,"status":"accepted"}))
            }
            AgentOperation::Stop { agent_id } => {
                self.authorize_delegated(caller, &agent_id).await?;
                self.send_control(&agent_id, LoopCommand::Cancel)
                    .await
                    .map_err(|e| e.message)?;
                Ok(json!({"ok":true,"agent_id":agent_id,"accepted":true}))
            }
        }
    }

    async fn authorize_delegated(&self, caller: &str, child: &str) -> Result<(), String> {
        let state = self.state.read().await;
        if !state.sessions.contains_key(caller)
            || !state
                .sessions
                .get(child)
                .is_some_and(|s| s.delegated && s.parent_session_id.as_deref() == Some(caller))
        {
            return Err("agent is not a direct delegated child of this caller".into());
        }
        Ok(())
    }

    async fn create_delegated(
        &self,
        caller: &str,
        id: &str,
        task: String,
        label: Option<String>,
    ) -> Result<Value, String> {
        // This is a creation fence, not an execution queue. Actual work stays in Inbox.
        let _creation = self.lock_admission("agent-creation").await;
        let (cwd, model, permission, preset, plan_active, existing) = {
            let state = self.state.read().await;
            let parent = state
                .sessions
                .get(caller)
                .ok_or("calling agent does not exist")?;
            if parent.delegated {
                return Err("delegation depth limit reached: children cannot start agents".into());
            }
            if parent.dispatch_paused {
                return Err("parent is paused; cannot start new agents".into());
            }
            let existing = state
                .sessions
                .get(id)
                .is_some_and(|s| s.delegated && s.parent_session_id.as_deref() == Some(caller));
            if !existing
                && state
                    .sessions
                    .values()
                    .filter(|s| s.delegated && s.parent_session_id.as_deref() == Some(caller))
                    .count()
                    >= 128
            {
                return Err("child catalog limit reached (128)".into());
            }
            if !existing
                && state
                    .sessions
                    .values()
                    .filter(|s| s.delegated && s.running)
                    .count()
                    >= 16
            {
                return Err(
                    "delegation admission queue is full (16); wait for completion notices".into(),
                );
            }
            (
                parent.cwd.clone(),
                parent.model.clone(),
                parent.permission_preset,
                parent.agent_preset.clone(),
                parent.plan_active,
                existing,
            )
        };
        if existing {
            if let Some(session) = self
                .agent_runtime
                .authoritative_session(id)
                .await
                .map_err(|e| e.to_string())?
            {
                if session.events().iter().any(|e| matches!(e.data(), EventData::AgentDelegated { task: prior, .. } if prior != &task)) {
                    return Err("invocation id already used for a different task".into());
                }
            }
        } else {
            self.session_create_with_visibility(&json!({"sessionId":id,"cwd":cwd}), false)
                .await
                .map_err(|e| e.message)?;
            let mut events = permission_events(permission);
            events.push(
                EventData::SessionModelSelected {
                    provider: model.provider.clone(),
                    model: model.model.clone(),
                    reasoning_effort: model.reasoning_effort.clone(),
                    context_window_tokens: model.context_window_tokens,
                }
                .into(),
            );
            if let Some(preset) = &preset {
                events.push(
                    EventData::AgentPresetSelected {
                        agent_preset: preset.clone(),
                    }
                    .into(),
                );
            }
            events.push(
                EventData::PlanMode {
                    active: plan_active,
                }
                .into(),
            );
            events.push(
                EventData::SessionTitle {
                    title: label.clone().unwrap_or_else(|| bounded(&task, 80).into()),
                    message_seqs: vec![],
                    source: xharness_session::SessionTitleSource::User,
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
            self.commit_session_events(id, events)
                .await
                .map_err(|e| e.message)?;
            let mut state = self.state.write().await;
            let child = state
                .sessions
                .get_mut(id)
                .ok_or("child disappeared during creation")?;
            child.delegated = true;
            child.parent_session_id = Some(caller.into());
            child.model = model;
            child.permission_preset = permission;
            child.agent_preset = preset.clone();
            child.plan_active = plan_active;
            child.title = label.or_else(|| Some(bounded(&task, 80).into()));
            drop(state);
            self.push_host(
                json!({"type":"host/session-added","sessionId":id,"parentSessionId":caller,"blank":true,"cwd":cwd,"agentPreset":preset}),
            );
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
            json!({"ok":true,"agent_id":id,"message_id":format!("{id}:initial"),"status":"accepted"}),
        )
    }

    async fn deliver_agent_message(
        &self,
        sender: &str,
        target: &str,
        id: &str,
        text: String,
        kind: &str,
        steer: bool,
    ) -> Result<(), String> {
        let _admission = self.lock_admission(target).await;
        let fingerprint = json!({"sender":sender,"text":text,"kind":kind}).to_string();
        if self
            .is_duplicate_admission(target, id, &fingerprint)
            .await
            .map_err(|e| e.message)?
        {
            return Ok(());
        }
        let (paused, running) = {
            let state = self.state.read().await;
            let record = state
                .sessions
                .get(target)
                .ok_or("target agent does not exist")?;
            if record.queue.len().max(record.projected_queue.len()) >= 32 {
                return Err("target agent inbox is full (32)".into());
            }
            (record.dispatch_paused, record.running)
        };
        let content =
            vec![json!({"type":"text","text":format!("Agent {sender} ({kind}):\n{text}")})];
        self.enqueue_prompt(PromptAdmission {
            rpc_id: RpcId::new(id),
            session_id: target.into(),
            mode: if steer && running && !paused {
                "steer"
            } else {
                "queue"
            }
            .into(),
            text: content[0]["text"].as_str().unwrap().into(),
            content,
            source: json!({"kind":kind,"senderSessionId":sender}),
            fingerprint: Some(fingerprint),
        })
        .await
        .map_err(|e| e.message)
    }

    /// TurnEnd is the durable outbox source. Delivery is retried until both the
    /// parent's deduplicated Inbox receipt and child delivery marker exist.
    pub fn start_delegation_listener(self: &Arc<Self>) {
        if self
            .delegation_listener_started
            .swap(true, Ordering::AcqRel)
        {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            let mut checked = BTreeMap::new();
            loop {
                tick.tick().await;
                let Some(host) = weak.upgrade() else {
                    break;
                };
                let children: Vec<_> = host
                    .state
                    .read()
                    .await
                    .sessions
                    .values()
                    .filter(|s| s.delegated && !s.running)
                    .map(|s| (s.session_id.clone(), s.next_event_seq()))
                    .collect();
                for (child, seq) in children {
                    if checked.get(&child) == Some(&seq) {
                        continue;
                    }
                    match host.deliver_child_settlements(&child).await {
                        Ok(()) => {
                            checked.insert(child, seq);
                        }
                        Err(error) => host.push_host(
                            json!({"type":"host/agent-error","sessionId":child,"message":error}),
                        ),
                    }
                }
            }
        });
    }

    pub(crate) async fn record_delegation_failure(
        &self,
        id: &str,
        work: &str,
        error: &str,
    ) -> Result<(), RpcError> {
        if !self
            .state
            .read()
            .await
            .sessions
            .get(id)
            .is_some_and(|s| s.delegated)
        {
            return Ok(());
        }
        let Some(session) = self
            .agent_runtime
            .authoritative_session(id)
            .await
            .map_err(|e| RpcError::internal(e.to_string()))?
        else {
            return Ok(());
        };
        let start=session.events().iter().position(|e|matches!(e.data(),EventData::UserMessage { message,.. } if message.id.as_deref()==Some(work)));
        if start.is_some_and(|index| {
            session.events()[index..]
                .iter()
                .any(|e| matches!(e.data(), EventData::TurnEnd { .. }))
        }) {
            return Ok(());
        }
        if !session.events().iter().any(|e|matches!(e.data(),EventData::AgentDelegationFailure { message_id,.. } if message_id==work)) {
            self.commit_session_events(id,vec![EventData::AgentDelegationFailure {message_id:work.into(),error:bounded(error,4096).into()}.into()]).await?;
        }
        self.set_dispatch_paused(id, true).await
    }

    async fn deliver_child_settlements(&self, child: &str) -> Result<(), String> {
        let Some(session) = self
            .agent_runtime
            .authoritative_session(child)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(());
        };
        let Some(parent) = restored_delegation(&session) else {
            return Ok(());
        };
        if let Some((invocation, task)) = session.events().iter().find_map(|e| match e.data() {
            EventData::AgentDelegated {
                invocation_id,
                task,
                ..
            } => Some((invocation_id, task)),
            _ => None,
        }) {
            self.deliver_agent_message(
                &parent,
                child,
                &format!("{invocation}:initial"),
                task.clone(),
                "agent-message",
                false,
            )
            .await?;
        }
        let delivered: BTreeSet<u32> = session
            .events()
            .iter()
            .filter_map(|e| match e.data() {
                EventData::AgentSettlementDelivered { turn } => Some(*turn),
                _ => None,
            })
            .collect();
        for event in session.events() {
            if let EventData::TurnEnd { turn, reason } = event.data() {
                if delivered.contains(turn) {
                    continue;
                }
                let answer = session
                    .events()
                    .iter()
                    .rev()
                    .find_map(|e| match e.data() {
                        EventData::AssistantMessage {
                            turn: t, message, ..
                        } if t == turn => Some(message.content.as_str()),
                        _ => None,
                    })
                    .unwrap_or("");
                let notice = json!({"agent_id":child,"turn":turn,"outcome":reason,"answer":bounded(answer,8192),"truncated":answer.len()>8192});
                self.deliver_agent_message(
                    child,
                    &parent,
                    &format!("{child}:settlement:{turn}"),
                    notice.to_string(),
                    "agent-settlement",
                    false,
                )
                .await?;
                self.commit_session_events(
                    child,
                    vec![SessionEvent::from(EventData::AgentSettlementDelivered {
                        turn: *turn,
                    })],
                )
                .await
                .map_err(|e| e.message)?;
            }
        }
        let failed_delivered: BTreeSet<_> = session
            .events()
            .iter()
            .filter_map(|e| match e.data() {
                EventData::AgentFailureDelivered { message_id } => Some(message_id.as_str()),
                _ => None,
            })
            .collect();
        for event in session.events() {
            if let EventData::AgentDelegationFailure { message_id, error } = event.data() {
                if failed_delivered.contains(message_id.as_str()) {
                    continue;
                }
                let notice = json!({"agent_id":child,"outcome":{"kind":"failed","error":error},"work_id":message_id});
                self.deliver_agent_message(
                    child,
                    &parent,
                    &format!("{child}:failure:{message_id}"),
                    notice.to_string(),
                    "agent-settlement",
                    false,
                )
                .await?;
                self.commit_session_events(
                    child,
                    vec![EventData::AgentFailureDelivered {
                        message_id: message_id.clone(),
                    }
                    .into()],
                )
                .await
                .map_err(|e| e.message)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentRuntime, DurableLoopAgentRuntime, HostConfig, NoTools};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use xharness_agent::MemoryLeaseManager;
    use xharness_core::{
        FinishReason, IdentityContextPolicy, ModelProvider, ProviderError, ProviderEvent,
        ProviderRequest, ProviderStream,
    };
    use xharness_session::{MemorySessionStore, Store};
    use xharness_tools::{ToolExecutor, ToolRegistry, ToolRequest};

    #[derive(Default)]
    struct Probe {
        active: Arc<AtomicUsize>,
        maximum: Arc<AtomicUsize>,
        calls: Arc<AtomicUsize>,
    }
    struct Active(Arc<AtomicUsize>);
    impl Drop for Active {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
    #[async_trait]
    impl ModelProvider for Probe {
        fn provider_name(&self) -> &str {
            "probe"
        }
        async fn stream(
            &self,
            _request: ProviderRequest,
            _cancel: CancellationToken,
        ) -> Result<ProviderStream, ProviderError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let current = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.maximum.fetch_max(current, Ordering::SeqCst);
            let active = Active(self.active.clone());
            Ok(Box::pin(async_stream::stream! {
                let _active = active;
                tokio::time::sleep(Duration::from_millis(120)).await;
                yield Ok(ProviderEvent::TextDelta("checked; no edits".into()));
                yield Ok(ProviderEvent::Completed { finish_reason:Some(FinishReason::Stop),usage:None,provider_items:vec![] });
            }))
        }
    }
    async fn setup(store: Arc<dyn Store>, probe: Arc<Probe>) -> Arc<BasicHost> {
        let runtime: Arc<dyn AgentRuntime> = Arc::new(DurableLoopAgentRuntime::new(
            "probe",
            "test",
            Some(probe),
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            store,
            Arc::new(MemoryLeaseManager::default()),
            2048,
        ));
        let mut config = HostConfig::new(std::env::current_dir().unwrap());
        config.provider_id = "probe".into();
        config.model_id = "test".into();
        BasicHost::with_agent_runtime(config, runtime)
    }
    async fn parent(host: &BasicHost, id: &str) {
        host.session_create(&json!({"sessionId":id})).await.unwrap();
    }
    fn start(task: &str) -> AgentOperation {
        AgentOperation::Start {
            task: task.into(),
            label: None,
        }
    }
    async fn settled(host: &BasicHost, id: &str) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if !host.state.read().await.sessions[id].running {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("driver did not settle");
    }
    #[tokio::test]
    async fn duplicate_start_authority_depth_and_followup() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let host = setup(store, Arc::new(Probe::default())).await;
        parent(&host, "p").await;
        parent(&host, "other").await;
        let (a, b) = tokio::join!(
            host.execute_agent("p", "call", start("inspect files")),
            host.execute_agent("p", "call", start("inspect files"))
        );
        let a = a.unwrap();
        assert_eq!(a, b.unwrap());
        let id = a["agent_id"].as_str().unwrap();
        assert_eq!(
            host.state
                .read()
                .await
                .sessions
                .values()
                .filter(|s| s.delegated)
                .count(),
            1
        );
        assert!(host
            .execute_agent("p", "call", start("different"))
            .await
            .is_err());
        assert!(host
            .execute_agent(
                "other",
                "send",
                AgentOperation::Send {
                    agent_id: id.into(),
                    message: "steal".into()
                }
            )
            .await
            .is_err());
        assert!(host
            .execute_agent(id, "nested", start("nested"))
            .await
            .is_err());
        settled(&host, id).await;
        let op = AgentOperation::Send {
            agent_id: id.into(),
            message: "continue".into(),
        };
        let first = host.execute_agent("p", "send", op.clone()).await.unwrap();
        assert_eq!(first, host.execute_agent("p", "send", op).await.unwrap());
        settled(&host, id).await;
        host.agent_runtime.shutdown(Duration::from_secs(2)).await;
    }
    #[tokio::test]
    async fn capacity_is_two_real_model_turns_and_results_deliver_once() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let probe = Arc::new(Probe::default());
        let host = setup(store.clone(), probe.clone()).await;
        parent(&host, "p").await;
        let mut children = vec![];
        for n in 0..6 {
            children.push(
                host.execute_agent("p", &format!("call{n}"), start("inspect independently"))
                    .await
                    .unwrap()["agent_id"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            );
        }
        for id in &children {
            settled(&host, id).await;
        }
        assert_eq!(probe.maximum.load(Ordering::SeqCst), 2);
        assert_eq!(probe.calls.load(Ordering::SeqCst), 6);
        host.set_dispatch_paused("p", true).await.unwrap();
        for id in &children {
            host.deliver_child_settlements(id).await.unwrap();
            host.deliver_child_settlements(id).await.unwrap();
        }
        assert_eq!(host.state.read().await.sessions["p"].queue.len(), 6);
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(
            probe.calls.load(Ordering::SeqCst),
            6,
            "settlements must not wake paused parent"
        );
        assert!(!host.state.read().await.sessions["p"].running);
        host.agent_runtime.shutdown(Duration::from_secs(2)).await;
        let resumed = setup(store.clone(), Arc::new(Probe::default())).await;
        resumed.restore_from_store(store).await.unwrap();
        assert!(resumed.state.read().await.sessions["p"].dispatch_paused);
        for id in &children {
            assert_eq!(
                resumed.state.read().await.sessions[id]
                    .parent_session_id
                    .as_deref(),
                Some("p")
            );
            resumed.deliver_child_settlements(id).await.unwrap();
        }
        assert_eq!(resumed.state.read().await.sessions["p"].queue.len(), 6);
        resumed.agent_runtime.shutdown(Duration::from_secs(2)).await;
    }
    #[tokio::test]
    async fn stop_parks_pending_work_until_explicit_user_prompt() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let probe = Arc::new(Probe::default());
        let host = setup(store.clone(), probe.clone()).await;
        parent(&host, "p").await;
        let value = host
            .execute_agent("p", "start", start("long work"))
            .await
            .unwrap();
        let id = value["agent_id"].as_str().unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        host.execute_agent(
            "p",
            "stop",
            AgentOperation::Stop {
                agent_id: id.into(),
            },
        )
        .await
        .unwrap();
        settled(&host, id).await;
        let ended = store.load(id).await.unwrap().unwrap();
        assert!(
            ended.events().iter().any(|e| matches!(
                e.data(),
                EventData::TurnEnd {
                    reason: xharness_session::TurnEndReason::Cancelled,
                    ..
                }
            )),
            "stop must durably record cancellation, not silently fail journal conflict"
        );
        let calls = probe.calls.load(Ordering::SeqCst);
        host.execute_agent(
            "p",
            "follow",
            AgentOperation::Send {
                agent_id: id.into(),
                message: "park this".into(),
            },
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(180)).await;
        assert_eq!(probe.calls.load(Ordering::SeqCst), calls);
        assert!(!host.state.read().await.sessions[id].queue.is_empty());
        host.enqueue_prompt(PromptAdmission {
            rpc_id: RpcId::new("human-resume"),
            session_id: id.into(),
            mode: "queue".into(),
            text: "continue".into(),
            content: vec![json!({"type":"text","text":"continue"})],
            source: json!({"kind":"user"}),
            fingerprint: None,
        })
        .await
        .unwrap();
        settled(&host, id).await;
        assert!(probe.calls.load(Ordering::SeqCst) > calls);
        host.agent_runtime.shutdown(Duration::from_secs(2)).await;
    }
    #[tokio::test]
    async fn registry_has_one_tool_and_invalid_action_never_reaches_runtime() {
        struct Never;
        #[async_trait]
        impl DelegationRuntime for Never {
            async fn execute(
                &self,
                _: &str,
                _: &str,
                _: AgentOperation,
                _: CancellationToken,
            ) -> Result<Value, String> {
                panic!("invalid arguments reached runtime")
            }
        }
        let registry = Arc::new(ToolRegistry::new());
        registry
            .register(AgentTool::spec(Arc::new(Never), "p"))
            .await
            .unwrap();
        assert_eq!(registry.definitions().await.len(), 1);
        let executor = ToolExecutor::new(registry);
        for args in [
            json!({"action":"stop"}),
            json!({"action":"start","task":"x","message":"bad"}),
            json!({"action":"send","agent_id":"a","message":" "}),
        ] {
            let result = executor
                .execute(ToolRequest::new("agent", args.to_string()))
                .await;
            assert!(!result.is_ok());
        }
    }
    #[tokio::test]
    async fn stop_while_waiting_for_capacity_never_claims_input_or_hangs() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let probe = Arc::new(Probe::default());
        let host = setup(store.clone(), probe.clone()).await;
        parent(&host, "p").await;
        let mut ids = vec![];
        for n in 0..3 {
            ids.push(
                host.execute_agent("p", &format!("start{n}"), start("work"))
                    .await
                    .unwrap()["agent_id"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            );
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        tokio::time::timeout(
            Duration::from_secs(2),
            host.execute_agent(
                "p",
                "stop",
                AgentOperation::Stop {
                    agent_id: ids[2].clone(),
                },
            ),
        )
        .await
        .unwrap()
        .unwrap();
        for id in &ids {
            settled(&host, id).await;
        }
        let session = store.load(&ids[2]).await.unwrap().unwrap();
        assert!(!session
            .events()
            .iter()
            .any(|e| matches!(e.data(), EventData::TurnStart { .. })));
        assert!(xharness_agent::InboxProjection::from_session(&session)
            .unwrap()
            .has_pending());
        assert_eq!(probe.calls.load(Ordering::SeqCst), 2);
        host.agent_runtime.shutdown(Duration::from_secs(2)).await;
    }

    #[tokio::test]
    async fn cancelled_before_admission_does_not_create_child() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let host = setup(store, Arc::new(Probe::default())).await;
        parent(&host, "p").await;
        let runtime = HostDelegation(Arc::downgrade(&host));
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(runtime
            .execute("p", "c", start("work"), cancel)
            .await
            .is_err());
        assert_eq!(host.state.read().await.sessions.len(), 1);
        host.agent_runtime.shutdown(Duration::from_secs(2)).await;
    }
    #[tokio::test]
    async fn preparation_failure_is_durable_notified_once_and_not_auto_replayed() {
        struct BrokenTools;
        #[async_trait]
        impl crate::SessionToolFactory for BrokenTools {
            async fn executor(
                &self,
                _: &str,
                _: &str,
                _: crate::PermissionPreset,
            ) -> Result<ToolExecutor, String> {
                Err("fixture: tool preparation unavailable".into())
            }
        }
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let mut config = HostConfig::new(std::env::current_dir().unwrap());
        config.provider_id = "probe".into();
        config.model_id = "test".into();
        let runtime: Arc<dyn AgentRuntime> = Arc::new(DurableLoopAgentRuntime::new(
            "probe",
            "test",
            Some(Arc::new(Probe::default())),
            Arc::new(BrokenTools),
            Arc::new(IdentityContextPolicy),
            store.clone(),
            Arc::new(MemoryLeaseManager::default()),
            2048,
        ));
        let host = BasicHost::with_agent_runtime(config, runtime);
        parent(&host, "p").await;
        let value = host
            .execute_agent("p", "start", start("work"))
            .await
            .unwrap();
        let id = value["agent_id"].as_str().unwrap();
        settled(&host, id).await;
        let session = store.load(id).await.unwrap().unwrap();
        assert!(session
            .events()
            .iter()
            .any(|e| matches!(e.data(), EventData::AgentDelegationFailure { .. })));
        assert!(host.state.read().await.sessions[id].dispatch_paused);
        host.set_dispatch_paused("p", true).await.unwrap();
        host.deliver_child_settlements(id).await.unwrap();
        host.deliver_child_settlements(id).await.unwrap();
        assert_eq!(host.state.read().await.sessions["p"].queue.len(), 1);
        host.agent_runtime.shutdown(Duration::from_secs(2)).await;
        let restored = setup(store.clone(), Arc::new(Probe::default())).await;
        restored.restore_from_store(store).await.unwrap();
        assert!(restored.state.read().await.sessions[id].dispatch_paused);
        assert!(!restored.state.read().await.sessions[id].running);
        restored
            .agent_runtime
            .shutdown(Duration::from_secs(2))
            .await;
    }
    #[tokio::test]
    async fn concurrent_history_refresh_and_child_control_never_regress_cursor() {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let host = setup(store.clone(), Arc::new(Probe::default())).await;
        parent(&host, "p").await;
        let mut tasks = vec![];
        for _ in 0..8 {
            let host = host.clone();
            tasks.push(tokio::spawn(async move {
                let mut previous = 0;
                for _ in 0..32 {
                    host.sync_authoritative_session("p").await.unwrap();
                    let seq = host.state.read().await.sessions["p"].next_event_seq();
                    assert!(seq >= previous);
                    previous = seq;
                    tokio::task::yield_now().await;
                }
            }));
        }
        for n in 0..32 {
            host.commit_session_events(
                "p",
                vec![EventData::AgentDispatchPaused { paused: n % 2 == 0 }.into()],
            )
            .await
            .unwrap();
        }
        for task in tasks {
            task.await.unwrap();
        }
        let session = store.load("p").await.unwrap().unwrap();
        assert_eq!(
            host.state.read().await.sessions["p"].next_event_seq() as usize,
            session.events().len()
        );
        host.agent_runtime.shutdown(Duration::from_secs(2)).await;
    }
}

//! Compact, read-only idle recovery. Execution retains full journal replay.
//! No transcript, raw tool output, provider request or live task is serialized.
use crate::{
    state::{
        GoalState, ModelSelection, ProjectedSessionMutationReceipt, QueuedPrompt, SessionRecord,
    },
    BasicHost, PermissionPreset,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use xharness_projection::metrics::MetricsProjectionState;
use xharness_session::{EventData, Session, SessionRecoveryCheckpoint, SessionRecoveryTail};

pub(crate) const SCHEMA: &str = "xharness.host.idle-recovery.v1";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct IdleState {
    updated_at: u64,
    blank: bool,
    parent_session_id: Option<String>,
    origin: Option<String>,
    agent_preset: Option<String>,
    title: Option<String>,
    model: ModelSelection,
    route_from_config: bool,
    permission: PermissionPreset,
    plan_active: bool,
    goal: Option<GoalState>,
    dispatch_paused: bool,
    delegated: bool,
    next_turn: u32,
    #[serde(default)]
    auto_title_settled: bool,
    metrics: MetricsProjectionState,
    // Exact RPC admission/receipt deduplication, not a lossy ID-only summary.
    admissions: BTreeMap<String, QueuedPrompt>,
    mutation_receipts: BTreeMap<String, ProjectedSessionMutationReceipt>,
}

/// Conservative boundary: never certify live/deferred human interactions,
/// interrupted work, unfinished compaction or runtime-owned work as idle.
fn eligible(host: &BasicHost, session: &Session, record: &SessionRecord) -> bool {
    if !host.agent_runtime.supports_idle_restore_checkpoint()
        || !record.queue.is_empty()
        || !record.projected_queue.is_empty()
        || xharness_schedule::active_schedules(session).map_or(true, |s| !s.is_empty())
        || crate::restore::restored_goal(session)
            .as_ref()
            .is_some_and(|g| g.phase == xharness_session::GoalPhase::Active)
        || host
            .agent_runtime
            .needs_session_resume(session)
            .unwrap_or(true)
        || !session.interrupted_turn_recovery().is_empty()
        || !session.pending_tool_approvals().is_empty()
        || !session.pending_user_questions().is_empty()
        || !session.recoverable_user_questions().is_empty()
        || !xharness_session::incomplete_tool_calls(session.events()).is_empty()
        || !xharness_session::stale_approval_cancellations(session.events()).is_empty()
    {
        return false;
    }
    // Linear set folding; many historical deferred questions must not turn
    // checkpoint publication into a quadratic nested history scan.
    let mut deferred = std::collections::BTreeSet::new();
    let mut delivered = std::collections::BTreeSet::new();
    for event in session.events() {
        match event.data() {
            EventData::QuestionDeferred { interaction_id } => {
                deferred.insert(interaction_id);
            }
            EventData::QuestionAnswerDelivered { interaction_id } => {
                delivered.insert(interaction_id);
            }
            _ => {}
        }
    }
    if !deferred.is_subset(&delivered) {
        return false;
    }
    let inbox = xharness_agent::InboxProjection::from_session(session);
    if inbox.map_or(true, |i| i.has_pending()) {
        return false;
    }
    // Standard runtime handles compaction itself; this additional guard also
    // protects opt-in embeddings whose custom resume predicate omits it.
    let mut compactions = std::collections::BTreeSet::new();
    for e in session.events() {
        match e.data() {
            EventData::CompactionStart { compaction_id, .. } => {
                compactions.insert(compaction_id);
            }
            EventData::CompactionEnd { compaction_id, .. } => {
                compactions.remove(compaction_id);
            }
            _ => {}
        }
    }
    compactions.is_empty()
}

pub(crate) fn checkpoint(
    host: &BasicHost,
    session: &Session,
    record: &SessionRecord,
) -> Option<SessionRecoveryCheckpoint> {
    if record.authoritative_seq != Some(session.next_seq()) || !eligible(host, session, record) {
        return None;
    }
    // Use the durable route, not a concurrently changing Host preference.
    let route = crate::restore::restored_route(session, &host.config);
    let state = IdleState {
        updated_at: session
            .events()
            .last()
            .map_or(session.header().created_at_ms, |e| e.timestamp_ms),
        blank: !session.events().iter().any(|e| {
            matches!(
                e.data(),
                EventData::UserMessage { .. } | EventData::AssistantMessage { .. }
            )
        }),
        parent_session_id: record.parent_session_id.clone(),
        origin: record.origin.clone(),
        agent_preset: crate::restore::restored_agent_preset(session),
        title: crate::restore::restored_title(session),
        model: ModelSelection {
            provider: route.provider,
            model: route.model,
            reasoning_effort: route.reasoning_effort,
            context_window_tokens: route.context_window_tokens,
        },
        route_from_config: !session.events().iter().any(|e| {
            matches!(
                e.data(),
                EventData::SessionModelSelected { .. } | EventData::RequestHeader { .. }
            )
        }),
        permission: crate::restore::restored_permission(session),
        plan_active: crate::restore::restored_plan_mode(session),
        goal: crate::restore::restored_goal(session),
        dispatch_paused: crate::delegation::restored_dispatch_paused(session),
        delegated: crate::delegation::restored_delegation(session).is_some(),
        next_turn: session
            .events()
            .iter()
            .filter_map(|e| match e.data() {
                EventData::TurnStart { turn } => Some(*turn),
                _ => None,
            })
            .max()
            .unwrap_or_default(),
        auto_title_settled: crate::titles::title_recovery_settled(session),
        // This cache has consumed the exact authoritative cursor; reuse its
        // private fold instead of rescanning all metric events on every turn.
        metrics: record.metrics.clone(),
        admissions: crate::restore::restored_admissions(session),
        mutation_receipts: crate::restore::restored_session_mutation_receipts(session),
    };
    Some(SessionRecoveryCheckpoint {
        schema: SCHEMA.into(),
        header: session.header().clone(),
        next_seq: session.next_seq(),
        revision: session.revision(),
        state: serde_json::to_value(state).ok()?,
    })
}

fn restored_state(host: &BasicHost, tail: &SessionRecoveryTail) -> Option<IdleState> {
    if !host.agent_runtime.supports_idle_restore_checkpoint() || tail.checkpoint.schema != SCHEMA {
        return None;
    }
    let mut state: IdleState = serde_json::from_value(tail.checkpoint.state.clone()).ok()?;
    if state
        .goal
        .as_ref()
        .is_some_and(|g| g.phase == xharness_session::GoalPhase::Active)
    {
        return None;
    }
    if state.route_from_config {
        state.model = ModelSelection::from_config(&host.config);
        state.model.reasoning_effort = None;
    }
    if tail
        .checkpoint
        .next_seq
        .checked_add(tail.events.len() as u64)
        != Some(tail.next_seq)
    {
        return None;
    }
    // Only context-free metadata transitions qualify. No turn/inbox/tool/Goal/
    // approval/question/schedule event can enter this path by accident.
    for e in &tail.events {
        match e.data() {
            EventData::SessionModelSelected { .. }
            | EventData::PermissionPreset { .. }
            | EventData::AgentPresetSelected { .. }
            | EventData::PlanMode { .. }
            | EventData::SessionMutationCommitted { .. } => {}
            EventData::SessionTitle {
                source: xharness_session::SessionTitleSource::User,
                ..
            } => {}
            _ => return None,
        }
    }
    // Reuse the existing semantic validator for the independent metadata cut.
    // This throwaway validation object is never published, used for recovery
    // work, or supplied as model history; original cursors below stay intact.
    let mut validation = tail.events.clone();
    for (seq, e) in validation.iter_mut().enumerate() {
        e.seq = seq as u64;
        e.revision.0 = e.revision.0.checked_sub(tail.checkpoint.revision.0)?;
    }
    Session::restore(
        tail.checkpoint.header.clone(),
        xharness_session::Revision(tail.revision.0.checked_sub(tail.checkpoint.revision.0)?),
        validation,
    )
    .ok()?;
    for (index, e) in tail.events.iter().enumerate() {
        match e.data() {
            EventData::SessionModelSelected {
                provider,
                model,
                reasoning_effort,
                context_window_tokens,
            } => {
                state.model = ModelSelection {
                    provider: provider.clone(),
                    model: model.clone(),
                    reasoning_effort: reasoning_effort.clone(),
                    context_window_tokens: *context_window_tokens,
                };
            }
            EventData::PermissionPreset { preset } => {
                state.permission = PermissionPreset::parse(preset)?;
            }
            EventData::AgentPresetSelected { agent_preset } => {
                state.agent_preset = Some(agent_preset.clone());
            }
            EventData::SessionTitle { title, .. } => {
                state.title = Some(title.clone());
                state.auto_title_settled = true;
            }
            EventData::PlanMode { active } => {
                state.plan_active = *active;
            }
            EventData::SessionMutationCommitted { receipt } => {
                if state.mutation_receipts.contains_key(&receipt.rpc_id) {
                    return None;
                }
                state.mutation_receipts.insert(
                    receipt.rpc_id.clone(),
                    ProjectedSessionMutationReceipt {
                        receipt: receipt.clone(),
                        state_event_seq: tail.events.get(index.checked_sub(1)?)?.seq,
                    },
                );
            }
            _ => return None,
        }
        state.metrics.apply_logged(e);
        state.updated_at = e.timestamp_ms;
    }
    Some(state)
}

/// A source-validated terminal title state may avoid a background full load.
/// Missing/unsupported/stale evidence is unknown, never "title is complete".
pub(crate) fn title_is_settled(host: &BasicHost, tail: &SessionRecoveryTail) -> bool {
    restored_state(host, tail).is_some_and(|state| state.auto_title_settled)
}

pub(crate) fn restore(host: &BasicHost, tail: &SessionRecoveryTail) -> Option<SessionRecord> {
    let state = restored_state(host, tail)?;
    let header = &tail.checkpoint.header;
    Some(SessionRecord {
        dispatch_paused: state.dispatch_paused,
        delegated: state.delegated,
        restoring: false,
        session_id: header.id.clone(),
        created_at: header.created_at_ms,
        updated_at: state.updated_at,
        running: false,
        blank: state.blank,
        parent_session_id: state.parent_session_id,
        origin: state.origin,
        cwd: header
            .cwd
            .clone()
            .unwrap_or_else(|| host.config.cwd.to_string_lossy().into_owned()),
        agent_preset: state.agent_preset,
        title: state.title,
        model: state.model,
        permission_preset: state.permission,
        active_permission: None,
        plan_active: state.plan_active,
        goal: state.goal,
        schedules: Vec::new(),
        schedules_hydrated: true,
        events: Vec::new(),
        event_base_seq: tail.next_seq,
        event_cache_bytes: 0,
        metrics: state.metrics,
        catalog_metrics: None,
        messages: Vec::new(),
        queue: VecDeque::new(),
        projected_queue: Vec::new(),
        admissions: state.admissions,
        mutation_receipts: state.mutation_receipts,
        authoritative_seq: Some(tail.next_seq),
        control: None,
        next_turn: state.next_turn,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AgentRuntime, AgentRuntimeError, AgentTurnRequest, HostConfig, RecoveryPolicy, RunningTurn,
    };
    use async_trait::async_trait;
    use serde_json::{json, Value};
    use std::{
        path::PathBuf,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
    };
    use xharness_session::{
        AppendReceipt, Revision, SessionEvent, SessionHeader, SessionInspection, Store, StoreError,
    };
    use xharness_session_jsonl::JsonlSessionStore;

    struct Dir(PathBuf);
    impl Dir {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "xh-host-checkpoint-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir(&p).unwrap();
            Self(p)
        }
        fn store(&self) -> Arc<ProbeStore> {
            Arc::new(ProbeStore {
                inner: JsonlSessionStore::new(&self.0).unwrap().for_runtime(),
                loads: AtomicUsize::new(0),
            })
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    struct ProbeStore {
        inner: JsonlSessionStore,
        loads: AtomicUsize,
    }
    #[async_trait]
    impl Store for ProbeStore {
        async fn list_headers(&self) -> Result<Vec<SessionHeader>, StoreError> {
            self.inner.list_headers().await
        }
        async fn scan_startup_candidates(
            &self,
        ) -> Result<(Vec<SessionHeader>, Vec<xharness_session::UnreadableSession>), StoreError>
        {
            self.inner.scan_startup_candidates().await
        }
        async fn create(&self, h: SessionHeader) -> Result<Session, StoreError> {
            self.inner.create(h).await
        }
        async fn load(&self, id: &str) -> Result<Option<Session>, StoreError> {
            self.loads.fetch_add(1, Ordering::SeqCst);
            self.inner.load(id).await
        }
        async fn append(
            &self,
            id: &str,
            r: Revision,
            e: Vec<SessionEvent>,
        ) -> Result<AppendReceipt, StoreError> {
            self.inner.append(id, r, e).await
        }
        async fn flush(&self, id: &str) -> Result<Revision, StoreError> {
            self.inner.flush(id).await
        }
        async fn inspect(&self, id: &str) -> Result<Option<SessionInspection>, StoreError> {
            self.inner.inspect(id).await
        }
        async fn recovery_tail(
            &self,
            id: &str,
            s: &str,
        ) -> Result<Option<SessionRecoveryTail>, StoreError> {
            self.inner.recovery_tail(id, s).await
        }
        async fn publish_recovery_checkpoint(
            &self,
            c: SessionRecoveryCheckpoint,
        ) -> Result<(), StoreError> {
            self.inner.publish_recovery_checkpoint(c).await
        }
    }
    struct Runtime {
        store: Arc<dyn Store>,
        opted_in: bool,
    }
    #[async_trait]
    impl AgentRuntime for Runtime {
        fn has_available_route(&self) -> bool {
            true
        }
        fn can_route(&self, _: &crate::ModelRoute) -> bool {
            true
        }
        fn has_authoritative_sessions(&self) -> bool {
            true
        }
        fn supports_idle_restore_checkpoint(&self) -> bool {
            self.opted_in
        }
        async fn authoritative_session(
            &self,
            id: &str,
        ) -> Result<Option<Session>, AgentRuntimeError> {
            self.store
                .load(id)
                .await
                .map_err(|e| AgentRuntimeError::Preparation {
                    message: e.to_string(),
                })
        }
        async fn start_turn(
            &self,
            _: AgentTurnRequest,
        ) -> Result<Box<dyn RunningTurn>, AgentRuntimeError> {
            panic!("restore must not execute model work")
        }
    }
    fn host(store: Arc<dyn Store>, opted_in: bool) -> Arc<BasicHost> {
        let mut config = HostConfig::new("/tmp");
        config.provider_id = "test".into();
        config.model_id = "model".into();
        BasicHost::with_agent_runtime(config, Arc::new(Runtime { store, opted_in }))
    }
    fn closed_turn(turn: u32) -> Vec<SessionEvent> {
        use xharness_session::{AssistantChunk, Message, RequestHeader, TurnEndReason};
        vec![
            EventData::TurnStart{turn}.into(),
            EventData::UserMessage{message:Message::user("only current work"),surface_replace:None}.into(),
            EventData::StepStart{turn,step:1}.into(),
            EventData::RequestHeader{header:RequestHeader::new("test","model")}.into(),
            EventData::AssistantChunk{turn,step:1,chunk:AssistantChunk::Usage(json!({"inputTokens":100,"outputTokens":20,"cacheReadTokens":80,"cacheWriteTokens":5}))}.into(),
            EventData::AssistantMessage{turn,step:1,message:Message::assistant("answer"),usage:Some(json!({"inputTokens":100,"outputTokens":20,"cacheReadTokens":80,"cacheWriteTokens":5}))}.into(),
            EventData::StepEnd{turn,step:1}.into(),
            EventData::TurnEnd{turn,reason:TurnEndReason::Completed}.into(),
        ]
    }
    async fn record_json(host: &BasicHost) -> Value {
        let state = host.state.read().await;
        let record = &state.sessions["test"];
        json!({"summary":record.summary(),"nextTurn":record.next_turn,"admissions":record.admissions,
            "receipts":record.mutation_receipts,"dispatchPaused":record.dispatch_paused,"delegated":record.delegated})
    }
    #[tokio::test]
    async fn cold_restart_matches_full_restore_without_any_authoritative_load() {
        let d = Dir::new();
        let s = d.store();
        let session = s.create(SessionHeader::new("test")).await.unwrap();
        s.append("test", session.revision(), closed_turn(1))
            .await
            .unwrap();
        let first = host(s.clone(), true);
        let full = first.restore_from_store(s.clone()).await.unwrap();
        assert_eq!(full.checkpoint_restored_sessions, 0);
        let expected = record_json(&first).await;
        assert!(d.0.join("test.recovery-checkpoint").exists());
        drop(first);
        let cold = d.store();
        let fast = host(cold.clone(), true);
        let report = fast.restore_from_store(cold.clone()).await.unwrap();
        assert_eq!(report.checkpoint_restored_sessions, 1);
        assert_eq!(cold.loads.load(Ordering::SeqCst), 0);
        assert_eq!(record_json(&fast).await, expected);
        // The original complete transcript is still obtained for execution.
        assert_eq!(
            cold.load("test")
                .await
                .unwrap()
                .unwrap()
                .derive_messages()
                .len(),
            2
        );
    }
    #[tokio::test]
    async fn metadata_tail_and_exact_mutation_receipts_match_full_replay() {
        let d = Dir::new();
        let s = d.store();
        let session = s.create(SessionHeader::new("test")).await.unwrap();
        let first = host(s.clone(), true);
        first.restore_from_store(s.clone()).await.unwrap();
        drop(first);
        let receipt = xharness_session::SessionMutationReceipt {
            rpc_id: "permission-rpc".into(),
            method: "session.permission".into(),
            fingerprint: "a".repeat(64),
            response: json!({"ok":true}),
            response_event_seq_field: Some("eventSeq".into()),
        };
        s.append(
            "test",
            session.revision(),
            vec![
                EventData::PermissionPreset {
                    preset: "danger-full-access".into(),
                }
                .into(),
                EventData::SessionMutationCommitted { receipt }.into(),
            ],
        )
        .await
        .unwrap();
        let session = s.load("test").await.unwrap().unwrap();
        s.append(
            "test",
            session.revision(),
            vec![
                EventData::SessionModelSelected {
                    provider: "other".into(),
                    model: "next".into(),
                    reasoning_effort: Some("high".into()),
                    context_window_tokens: Some(8192),
                }
                .into(),
                EventData::PlanMode { active: true }.into(),
                EventData::SessionTitle {
                    title: "新名称".into(),
                    message_seqs: vec![],
                    source: xharness_session::SessionTitleSource::User,
                }
                .into(),
                EventData::AgentPresetSelected {
                    agent_preset: "custom".into(),
                }
                .into(),
            ],
        )
        .await
        .unwrap();
        let cold = d.store();
        let fast = host(cold.clone(), true);
        let report = fast.restore_from_store(cold.clone()).await.unwrap();
        assert_eq!(report.checkpoint_restored_sessions, 1);
        assert_eq!(report.checkpoint_tail_events, 6);
        assert_eq!(cold.loads.load(Ordering::SeqCst), 0);
        let expected = record_json(&fast).await;
        std::fs::remove_file(d.0.join("test.recovery-checkpoint")).unwrap();
        let slowstore = d.store();
        let slow = host(slowstore.clone(), true);
        slow.restore_from_store(slowstore.clone()).await.unwrap();
        assert_eq!(record_json(&slow).await, expected);
        assert_eq!(
            slow.state.read().await.sessions["test"].mutation_receipts["permission-rpc"].response()
                ["eventSeq"],
            0
        );
    }
    #[tokio::test]
    async fn model_turn_tail_and_corrupt_checkpoint_take_full_validation_path() {
        let d = Dir::new();
        let s = d.store();
        let session = s.create(SessionHeader::new("test")).await.unwrap();
        let first = host(s.clone(), true);
        first.restore_from_store(s.clone()).await.unwrap();
        drop(first);
        s.append("test", session.revision(), closed_turn(1))
            .await
            .unwrap();
        let cold = d.store();
        let restored = host(cold.clone(), true);
        let report = restored.restore_from_store(cold.clone()).await.unwrap();
        assert_eq!(report.checkpoint_restored_sessions, 0);
        assert_eq!(cold.loads.load(Ordering::SeqCst), 1);
        std::fs::write(d.0.join("test.recovery-checkpoint"), "broken").unwrap();
        let cold = d.store();
        let restored = host(cold.clone(), true);
        let report = restored.restore_from_store(cold.clone()).await.unwrap();
        assert_eq!(report.checkpoint_restored_sessions, 0);
        assert_eq!(cold.loads.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn non_opted_in_runtime_cannot_use_or_publish_idle_checkpoint() {
        let d = Dir::new();
        let s = d.store();
        s.create(SessionHeader::new("test")).await.unwrap();
        let first = host(s.clone(), true);
        first.restore_from_store(s.clone()).await.unwrap();
        let cold = d.store();
        let restored = host(cold.clone(), false);
        let report = restored.restore_from_store(cold.clone()).await.unwrap();
        assert_eq!(report.checkpoint_restored_sessions, 0);
        assert_eq!(cold.loads.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn inherited_default_route_is_resolved_using_current_configuration() {
        let d = Dir::new();
        let s = d.store();
        s.create(SessionHeader::new("test")).await.unwrap();
        let first = host(s.clone(), true);
        first.restore_from_store(s.clone()).await.unwrap();
        drop(first);
        let cold = d.store();
        let mut config = HostConfig::new("/new-workspace");
        config.provider_id = "new-default".into();
        config.model_id = "new-model".into();
        config.reasoning_effort = Some("high".into());
        let restored = BasicHost::with_agent_runtime(
            config,
            Arc::new(Runtime {
                store: cold.clone(),
                opted_in: true,
            }),
        );
        let report = restored.restore_from_store(cold.clone()).await.unwrap();
        assert_eq!(report.checkpoint_restored_sessions, 1);
        let state = restored.state.read().await;
        let record = &state.sessions["test"];
        assert_eq!(record.model.provider, "new-default");
        assert_eq!(record.model.model, "new-model");
        assert!(record.model.reasoning_effort.is_none());
        assert_eq!(record.cwd, "/new-workspace");
    }
    #[tokio::test]
    async fn unsupported_work_tail_always_rejects_the_fast_reducer() {
        let d = Dir::new();
        let s = d.store();
        s.create(SessionHeader::new("test")).await.unwrap();
        let first = host(s.clone(), true);
        first.restore_from_store(s.clone()).await.unwrap();
        let tail = s.recovery_tail("test", SCHEMA).await.unwrap().unwrap();
        let examples = vec![
            EventData::TurnStart { turn: 1 },
            EventData::AgentDispatchPaused { paused: true },
            EventData::CompactionStart {
                compaction_id: "c".into(),
                source_command_id: None,
                turn: None,
            },
            EventData::AgentInboxSpliced {
                target: xharness_session::InboxTarget::NextTurn,
                start: 0,
                removed_count: 0,
                inserted: vec![],
                outcome: None,
            },
            EventData::QuestionDeferred {
                interaction_id: "q".into(),
            },
            EventData::ApprovalDecided {
                id: "a".into(),
                outcome: xharness_session::ApprovalOutcome::Rejected,
            },
            EventData::ToolResult {
                turn: 1,
                step: 1,
                result: xharness_session::ToolResultData::error("call", "failed"),
            },
        ];
        for data in examples {
            let mut candidate = tail.clone();
            candidate.events = vec![xharness_session::LoggedEvent {
                seq: tail.next_seq,
                revision: Revision(1),
                timestamp_ms: 123,
                event: data.into(),
            }];
            candidate.next_seq += 1;
            candidate.revision = Revision(1);
            assert!(restore(&first, &candidate).is_none());
        }
    }
    #[tokio::test]
    async fn incomplete_tool_tail_remains_paused_and_is_never_reexecuted() {
        use xharness_session::{Message, RequestHeader, ToolCall};
        let d = Dir::new();
        let s = d.store();
        let session = s.create(SessionHeader::new("test")).await.unwrap();
        let first = host(s.clone(), true);
        first.restore_from_store(s.clone()).await.unwrap();
        drop(first);
        let call = ToolCall {
            id: "side-effect".into(),
            provider_call_id: None,
            index: 0,
            name: "bash".into(),
            arguments_json: "{}".into(),
        };
        let mut assistant = Message::assistant("");
        assistant.tool_calls.push(call.clone());
        s.append(
            "test",
            session.revision(),
            vec![
                EventData::TurnStart { turn: 1 }.into(),
                EventData::StepStart { turn: 1, step: 1 }.into(),
                EventData::RequestHeader {
                    header: RequestHeader::new("test", "model"),
                }
                .into(),
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
        let before = std::fs::read(d.0.join("test.jsonl")).unwrap();
        let cold = d.store();
        let restored = host(cold.clone(), true);
        let report = restored
            .restore_from_store_with_policy(cold.clone(), RecoveryPolicy::PauseIncompleteTools)
            .await
            .unwrap();
        assert_eq!(report.checkpoint_restored_sessions, 0);
        assert_eq!(report.paused_incomplete_tool_sessions, 1);
        assert!(restored.state.read().await.sessions["test"].dispatch_paused);
        assert_eq!(std::fs::read(d.0.join("test.jsonl")).unwrap(), before);
    }
    #[tokio::test]
    async fn semantically_invalid_metadata_tail_is_reported_not_hidden_by_checkpoint() {
        use std::io::Write;
        let d = Dir::new();
        let s = d.store();
        s.create(SessionHeader::new("test")).await.unwrap();
        let first = host(s.clone(), true);
        first.restore_from_store(s.clone()).await.unwrap();
        drop(first);
        let e = xharness_session::LoggedEvent {
            seq: 0,
            revision: Revision(1),
            timestamp_ms: 124,
            event: EventData::SessionModelSelected {
                provider: String::new(),
                model: "model".into(),
                reasoning_effort: None,
                context_window_tokens: None,
            }
            .into(),
        };
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(d.0.join("test.jsonl"))
            .unwrap();
        serde_json::to_writer(
            &mut file,
            &json!({"record":"batch","previous_revision":0,"revision":1,"events":[e]}),
        )
        .unwrap();
        file.write_all(b"\n").unwrap();
        file.sync_all().unwrap();
        drop(file);
        let cold = d.store();
        let restored = host(cold.clone(), true);
        let report = restored.restore_from_store(cold.clone()).await.unwrap();
        assert_eq!(report.restored_sessions, 0);
        assert_eq!(report.checkpoint_restored_sessions, 0);
        assert_eq!(report.issues.len(), 1);
        assert_eq!(report.issues[0].session_id, "test");
        assert_eq!(cold.loads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn terminal_auto_title_does_not_rematerialize_checkpoint_restored_history() {
        let d = Dir::new();
        let s = d.store();
        let session = s.create(SessionHeader::new("test")).await.unwrap();
        s.append(
            "test",
            session.revision(),
            vec![EventData::SessionTitle {
                title: "User title".into(),
                message_seqs: vec![],
                source: xharness_session::SessionTitleSource::User,
            }
            .into()],
        )
        .await
        .unwrap();
        let first = host(s.clone(), true);
        first.restore_from_store(s.clone()).await.unwrap();
        drop(first);
        let cold = d.store();
        let mut config = HostConfig::new("/tmp");
        config.auto_titles = true;
        let h = BasicHost::with_agent_runtime(
            config,
            Arc::new(Runtime {
                store: cold.clone(),
                opted_in: true,
            }),
        );
        h.prepare_startup_basics(cold.clone()).await.unwrap();
        let report = h.restore_from_store(cold.clone()).await.unwrap();
        assert_eq!(report.checkpoint_restored_sessions, 1);
        h.start_auto_titles().await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        h.shutdown_auto_titles().await;
        assert_eq!(cold.loads.load(Ordering::SeqCst), 0);
        let tail = cold.recovery_tail("test", SCHEMA).await.unwrap().unwrap();
        assert!(title_is_settled(&h, &tail));
        let session = cold.load("test").await.unwrap().unwrap();
        cold.append("test", session.revision(), closed_turn(1))
            .await
            .unwrap();
        let tail = cold.recovery_tail("test", SCHEMA).await.unwrap().unwrap();
        assert!(
            !title_is_settled(&h, &tail),
            "new work must not inherit a stale title certificate"
        );
    }

    /// Synthetic data only. Run each mode as a separate remote process under
    /// /usr/bin/time -v; never aim this helper at an installed app data root.
    #[tokio::test]
    #[ignore = "explicit remote cold-recovery performance acceptance"]
    async fn recovery_checkpoint_performance_acceptance() {
        use sha2::{Digest, Sha256};
        use std::io::Write;
        let mode = std::env::var("XHARNESS_RECOVERY_BENCH_MODE").expect("explicit mode required");
        let root = PathBuf::from(
            std::env::var_os("XHARNESS_RECOVERY_BENCH_ROOT").expect("isolated temp root required"),
        );
        assert!(root.is_absolute() && root.starts_with(std::env::temp_dir()));
        let marker = root.join("synthetic-recovery-benchmark");
        let store = Arc::new(ProbeStore {
            inner: JsonlSessionStore::new(&root)
                .unwrap()
                .for_runtime()
                .with_cache_limits(0, 0),
            loads: AtomicUsize::new(0),
        });
        const TURNS: u32 = 512;
        if mode == "fixture" {
            assert!(!marker.exists() && !root.join("test.jsonl").exists());
            std::fs::write(&marker, "synthetic only").unwrap();
            store.create(SessionHeader::new("test")).await.unwrap();
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(root.join("test.jsonl"))
                .unwrap();
            let mut seq = 0;
            for turn in 1..=TURNS {
                let mut events = closed_turn(turn);
                if let EventData::RequestHeader { header } = events[3].data_mut() {
                    header.input = vec![xharness_session::Message::user("x".repeat(256 * 1024))];
                }
                if let EventData::AssistantMessage { message, .. } = events[5].data_mut() {
                    message.content = "answer".repeat(5461);
                }
                let events = events
                    .into_iter()
                    .map(|event| {
                        let e = xharness_session::LoggedEvent {
                            seq,
                            revision: Revision(u64::from(turn)),
                            timestamp_ms: 123,
                            event,
                        };
                        seq += 1;
                        e
                    })
                    .collect::<Vec<_>>();
                serde_json::to_writer(&mut file,&json!({"record":"batch","previous_revision":turn-1,"revision":turn,"events":events})).unwrap();
                file.write_all(b"\n").unwrap();
            }
            file.sync_all().unwrap();
            drop(file);
            let first = host(store.clone(), true);
            first.restore_from_store(store.clone()).await.unwrap();
            assert!(root.join("test.recovery-checkpoint").exists());
            println!(
                "RECOVERY_BENCH fixture_bytes={} checkpoint_bytes={}",
                std::fs::metadata(root.join("test.jsonl")).unwrap().len(),
                std::fs::metadata(root.join("test.recovery-checkpoint"))
                    .unwrap()
                    .len()
            );
            return;
        }
        assert!(marker.is_file());
        if mode == "append-tail" {
            let e = xharness_session::LoggedEvent {
                seq: u64::from(TURNS) * 8,
                revision: Revision(u64::from(TURNS) + 1),
                timestamp_ms: 124,
                event: EventData::PlanMode { active: true }.into(),
            };
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(root.join("test.jsonl"))
                .unwrap();
            serde_json::to_writer(&mut file,&json!({"record":"batch","previous_revision":TURNS,"revision":TURNS+1,"events":[e]})).unwrap();
            file.write_all(b"\n").unwrap();
            file.sync_all().unwrap();
            return;
        }
        assert!(matches!(mode.as_str(), "full" | "checkpoint"));
        for repeat in 0..3 {
            let start = std::time::Instant::now();
            let h = host(store.clone(), mode == "checkpoint");
            let report = h.restore_from_store(store.clone()).await.unwrap();
            let state = record_json(&h).await;
            assert_eq!(
                report.checkpoint_restored_sessions,
                usize::from(mode == "checkpoint")
            );
            let elapsed = start.elapsed().as_micros();
            println!("RECOVERY_BENCH mode={mode} repetition={repeat} elapsed_us={elapsed} checkpoint_hits={} tail_events={} loads={} digest={:x}",report.checkpoint_restored_sessions,report.checkpoint_tail_events,store.loads.load(Ordering::SeqCst),Sha256::digest(serde_json::to_vec(&state).unwrap()));
            drop(h);
        }
    }
}

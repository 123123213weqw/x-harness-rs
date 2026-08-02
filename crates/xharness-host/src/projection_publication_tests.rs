//! Synthetic snapshot-only tests: no model, tool execution or production state.
use super::*;
use crate::{runtime::AgentRuntime, HostConfig};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
use xharness_session::{
    EventData, MemorySessionStore, Message, RequestHeader, Revision, ScheduleChange, ScheduleKind,
    ScheduleRecord, Session, SessionHeader, SessionTitleSource, Store, TurnEndReason,
};
use xharness_session_jsonl::JsonlSessionStore;

const ID: &str = "projection-publication";

struct SnapshotRuntime(Arc<dyn Store>);

#[async_trait::async_trait]
impl AgentRuntime for SnapshotRuntime {
    fn has_available_route(&self) -> bool {
        false
    }
    fn can_route(&self, _: &ModelRoute) -> bool {
        false
    }
    fn has_authoritative_sessions(&self) -> bool {
        true
    }
    async fn authoritative_session(&self, id: &str) -> Result<Option<Session>, AgentRuntimeError> {
        self.0
            .load(id)
            .await
            .map_err(|error| AgentRuntimeError::Preparation {
                message: error.to_string(),
            })
    }
    async fn persist_session_events(
        &self,
        id: &str,
        cwd: &str,
        events: Vec<xharness_session::SessionEvent>,
    ) -> Result<bool, AgentRuntimeError> {
        let mut session =
            self.0
                .load(id)
                .await
                .map_err(|error| AgentRuntimeError::Preparation {
                    message: error.to_string(),
                })?;
        if session.is_none() {
            let mut header = SessionHeader::new(id);
            header.cwd = Some(cwd.to_owned());
            session = Some(self.0.create(header).await.map_err(|error| {
                AgentRuntimeError::Preparation {
                    message: error.to_string(),
                }
            })?);
        }
        self.0
            .append(id, session.unwrap().revision(), events)
            .await
            .map_err(|error| AgentRuntimeError::Preparation {
                message: error.to_string(),
            })?;
        self.0
            .flush(id)
            .await
            .map_err(|error| AgentRuntimeError::Preparation {
                message: error.to_string(),
            })?;
        Ok(true)
    }
    async fn start_turn(
        &self,
        _: AgentTurnRequest,
    ) -> Result<Box<dyn RunningTurn>, AgentRuntimeError> {
        panic!("projection tests must not start turns")
    }
}

fn title(value: &str) -> SessionEvent {
    EventData::SessionTitle {
        title: value.into(),
        message_seqs: vec![],
        source: SessionTitleSource::User,
    }
    .into()
}

async fn fixture() -> (Arc<BasicHost>, Arc<dyn Store>) {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    store.create(SessionHeader::new(ID)).await.unwrap();
    store
        .append(ID, Revision::ZERO, vec![title("initial")])
        .await
        .unwrap();
    let host = BasicHost::with_agent_runtime(
        HostConfig::new(std::env::temp_dir()),
        Arc::new(SnapshotRuntime(store.clone())),
    );
    host.restore_from_store(store.clone()).await.unwrap();
    (host, store)
}

#[tokio::test]
async fn projection_inputs_reject_stale_cursor_identity_and_each_route_field() {
    let (host, _) = fixture().await;
    let state = host.state.read().await;
    let original = &state.sessions[ID];
    let inputs = ProjectionInputs::capture(original);
    assert!(inputs.matches(original));
    for field in 0..9 {
        let mut changed = ProjectionInputs::capture(original);
        match field {
            0 => changed.cursor = Some(original.authoritative_seq.unwrap() + 1),
            1 => changed.cursor = None,
            2 => changed.cache_base_seq += 1,
            3 => changed.created_at += 1,
            4 => changed.schedules_hydrated = !changed.schedules_hydrated,
            5 => changed.route.provider.push_str("-new"),
            6 => changed.route.model.push_str("-new"),
            7 => changed.route.reasoning_effort = Some("different".into()),
            _ => changed.route.context_window_tokens = Some(123),
        }
        assert!(!changed.matches(original), "changed field {field}");
    }
}

fn scheduled_reminder() -> ScheduleRecord {
    ScheduleRecord {
        automation: None,
        id: "reminder-old".into(),
        kind: ScheduleKind::Every,
        prompt: "check progress".into(),
        after_seconds: None,
        every_seconds: Some(300),
        scheduled_at: "2099-01-01T00:00:00.000Z".into(),
    }
}

#[tokio::test]
async fn schedule_catalog_survives_paged_history_and_restart() {
    let (host, store) = fixture().await;
    let reminder = scheduled_reminder();
    let initial = store.load(ID).await.unwrap().unwrap();
    store
        .append(
            ID,
            initial.revision(),
            vec![EventData::ScheduleChange {
                change: ScheduleChange::Create {
                    version: 1,
                    schedule: reminder.clone(),
                },
            }
            .into()],
        )
        .await
        .unwrap();
    // A reminder can outlive many ordinary messages. Its create event must not
    // need to be present in the latest history page for the catalog to render.
    let request_header = store
        .archive_request(RequestHeader::new("test", "test"))
        .await
        .unwrap();
    for index in 0..60 {
        let snapshot = store.load(ID).await.unwrap().unwrap();
        store
            .append(
                ID,
                snapshot.revision(),
                completed_turn(index + 1, &format!("message {index}"), &request_header),
            )
            .await
            .unwrap();
    }
    let history = rpc_value(&host, RpcMethod::SessionHistory, json!({"sessionId": ID})).await;
    assert!(history["hasMore"].as_bool().unwrap());
    assert!(!history["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|event| event["type"] == "schedule/change"));
    assert_eq!(
        history["projections"]["values"]["schedules"],
        json!([reminder])
    );

    let restored = BasicHost::with_agent_runtime(
        HostConfig::new(std::env::temp_dir()),
        Arc::new(SnapshotRuntime(store.clone())),
    );
    restored.restore_from_store(store.clone()).await.unwrap();
    let after_restart = rpc_value(
        &restored,
        RpcMethod::SessionHistory,
        json!({"sessionId": ID}),
    )
    .await;
    assert_eq!(
        after_restart["projections"]["values"]["schedules"],
        history["projections"]["values"]["schedules"]
    );
}

#[tokio::test]
async fn schedule_catalog_hydrates_without_new_events_and_updates_live() {
    let (host, store) = fixture().await;
    let reminder = scheduled_reminder();
    let initial = store.load(ID).await.unwrap().unwrap();
    store
        .append(
            ID,
            initial.revision(),
            vec![EventData::ScheduleChange {
                change: ScheduleChange::Create {
                    version: 1,
                    schedule: reminder.clone(),
                },
            }
            .into()],
        )
        .await
        .unwrap();
    host.sync_authoritative_session(ID).await.unwrap();
    {
        let mut state = host.state.write().await;
        let record = state.sessions.get_mut(ID).unwrap();
        record.schedules.clear();
        record.schedules_hydrated = false;
        assert!(record.projection_values().get("schedules").is_none());
    }
    let mut receiver = host.event_gateway.subscribe_mux();
    // Metadata-only startup can hold the latest seq without having folded the
    // full log. Hydration must not depend on seeing a new schedule/change.
    host.sync_authoritative_session(ID).await.unwrap();
    let state = host.state.read().await;
    assert!(state.sessions[ID].schedules_hydrated);
    assert_eq!(
        state.sessions[ID].projection_values()["schedules"],
        json!([reminder])
    );
    drop(state);
    let mut saw_catalog = false;
    while let Ok(frame) = receiver.try_recv() {
        if frame.payload["type"] == "session/projection" && frame.payload["key"] == "schedules" {
            assert_eq!(frame.payload["value"], json!([reminder]));
            saw_catalog = true;
        }
    }
    assert!(saw_catalog);

    let current = store.load(ID).await.unwrap().unwrap();
    store
        .append(
            ID,
            current.revision(),
            vec![EventData::ScheduleChange {
                change: ScheduleChange::Delete {
                    version: 1,
                    id: reminder.id,
                },
            }
            .into()],
        )
        .await
        .unwrap();
    host.sync_authoritative_session(ID).await.unwrap();
    assert_eq!(
        host.state.read().await.sessions[ID].projection_values()["schedules"],
        json!([])
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn projection_preparation_needs_no_global_write_lock() {
    let (host, store) = fixture().await;
    let session = store.load(ID).await.unwrap().unwrap();
    let guard = host.state.write().await;
    let route = ProjectionInputs::capture(&guard.sessions[ID]).route;
    let expected = project_session_event_range(&session, &route, 0, session.events().len());
    let prepared = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::spawn(async move { prepare_projection_events(&session, &route, 0).unwrap() }),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        prepared
            .into_iter()
            .map(|(event, _)| event)
            .collect::<Vec<_>>(),
        expected
    );
    drop(guard);
}

#[tokio::test]
async fn projection_preparation_checks_cursor_boundaries() {
    let (_, store) = fixture().await;
    let session = store.load(ID).await.unwrap().unwrap();
    let route = ModelRoute::new("test", "test");
    assert!(
        prepare_projection_events(&session, &route, session.next_seq())
            .unwrap()
            .is_empty()
    );
    assert!(prepare_projection_events(&session, &route, session.next_seq() + 1).is_err());
    assert!(prepare_projection_events(&session, &route, u64::MAX).is_err());
}

#[test]
fn prepared_tool_views_keep_durable_sequence_and_original_arguments() {
    use xharness_session::{Message, RequestHeader, ToolCall, ToolResultData, TurnEndReason};
    let mut session = Session::new(SessionHeader::new("synthetic-tool-view")).unwrap();
    let arguments =
        r#"{"command":"synthetic-never-executed","cwd":"subdir","description":"projection only"}"#
            .to_owned();
    let call = ToolCall {
        id: "call-1".into(),
        provider_call_id: Some("provider-1".into()),
        index: 0,
        name: "pwsh".into(),
        arguments_json: arguments.clone(),
    };
    let mut message = Message::assistant("");
    message.tool_calls.push(call.clone());
    let mut result = ToolResultData::success("call-1", "synthetic content");
    result.metadata =
        Some(json!({"kind":"foreground", "stdout":"synthetic", "stderr":"", "exit_code":0}));
    session
        .append_batch_at(
            Revision::ZERO,
            vec![
                EventData::TurnStart { turn: 1 }.into(),
                EventData::UserMessage {
                    message: Message::user("synthetic"),
                    surface_replace: None,
                }
                .into(),
                EventData::StepStart { turn: 1, step: 1 }.into(),
                EventData::RequestHeader {
                    header: RequestHeader::new("test", "test"),
                }
                .into(),
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
                EventData::TurnEnd {
                    turn: 1,
                    reason: TurnEndReason::Completed,
                }
                .into(),
            ],
            1,
        )
        .unwrap();
    let route = ModelRoute::new("test", "test");
    let prepared = prepare_projection_events(&session, &route, 5).unwrap();
    let expected_events = project_session_event_range(&session, &route, 5, session.events().len());
    assert_eq!(
        prepared
            .iter()
            .map(|(event, _)| event.clone())
            .collect::<Vec<_>>(),
        expected_events
    );
    assert_eq!(prepared[0].0["data"]["arguments"], arguments);
    for (event, view) in &prepared {
        let seq = event["seq"].as_u64().unwrap() as usize;
        assert_eq!(
            *view,
            EventGateway::durable_view(&session, &session.events()[seq])
        );
    }
    // The test exercises a real call-view projection, not only None values.
    assert!(prepared[0].1.is_some());
    assert!(prepared[1].1.is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_projection_sync_publishes_each_new_event_once() {
    let (host, store) = fixture().await;
    let prior = store.load(ID).await.unwrap().unwrap();
    store
        .append(ID, prior.revision(), vec![title("new")])
        .await
        .unwrap();
    let mut receiver = host.event_gateway.subscribe_mux();
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..16 {
        let host = host.clone();
        tasks.spawn(async move { host.sync_authoritative_session(ID).await });
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(result) = tasks.join_next().await {
            assert!(result.unwrap().unwrap());
        }
    })
    .await
    .unwrap();
    let session = store.load(ID).await.unwrap().unwrap();
    let state = host.state.read().await;
    let record = &state.sessions[ID];
    let route = ProjectionInputs::capture(record).route;
    let expected =
        project_session_event_tail_from(&session, &route, prior.next_seq(), 2048, 16 * 1024 * 1024);
    assert_eq!(record.events, expected.events);
    assert_eq!(record.authoritative_seq, Some(session.next_seq()));
    assert_eq!(record.title.as_deref(), Some("new"));
    let mut published = Vec::new();
    while let Ok(frame) = receiver.try_recv() {
        if frame.payload["type"] == "session/event" {
            published.push(frame.payload["event"]["seq"].as_u64().unwrap());
        }
    }
    assert_eq!(published, vec![prior.next_seq()]);
}

async fn rpc_value(host: &BasicHost, method: RpcMethod, payload: Value) -> Value {
    match host
        .call(
            RpcId::new(format!("projection-regression-{method}")),
            method,
            payload,
            tokio_util::sync::CancellationToken::new(),
        )
        .await
    {
        RpcResult::Success { value: Some(value) } => value,
        result => panic!("{method} failed: {result:?}"),
    }
}

fn completed_turn(
    turn: u32,
    label: &str,
    request_header: &RequestHeader,
) -> Vec<xharness_session::SessionEvent> {
    vec![
        EventData::TurnStart { turn }.into(),
        EventData::UserMessage {
            message: Message::user(format!("question {label}")),
            surface_replace: None,
        }
        .into(),
        EventData::StepStart { turn, step: 1 }.into(),
        EventData::RequestHeader {
            header: request_header.clone(),
        }
        .into(),
        EventData::AssistantMessage {
            turn,
            step: 1,
            message: Message::assistant(format!("answer {label}")),
            usage: None,
        }
        .into(),
        EventData::StepEnd { turn, step: 1 }.into(),
        EventData::TurnEnd {
            turn,
            reason: TurnEndReason::Completed,
        }
        .into(),
    ]
}

#[tokio::test]
async fn live_refresh_restart_and_fork_use_the_same_durable_projection() {
    let root = std::env::temp_dir().join(format!(
        "xharness-projection-differential-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let store: Arc<dyn Store> = Arc::new(
        JsonlSessionStore::new(root.join("sessions"))
            .unwrap()
            .for_runtime(),
    );
    let mut header = SessionHeader::new(ID);
    header.cwd = Some(root.to_string_lossy().into_owned());
    store.create(header).await.unwrap();
    let request_header = store
        .archive_request(RequestHeader::new("test", "test"))
        .await
        .unwrap();
    let first = store
        .append(
            ID,
            Revision::ZERO,
            completed_turn(1, "before fork", &request_header),
        )
        .await
        .unwrap();
    store.flush(ID).await.unwrap();
    let fork_at_seq = store.load(ID).await.unwrap().unwrap().next_seq() - 1;
    let host = BasicHost::with_agent_runtime(
        HostConfig::new(&root),
        Arc::new(SnapshotRuntime(store.clone())),
    );
    assert!(host
        .restore_from_store(store.clone())
        .await
        .unwrap()
        .issues
        .is_empty());
    let mut live = host.event_gateway.subscribe_mux();

    let second = completed_turn(2, "after fork", &request_header);
    store.append(ID, first.revision, second).await.unwrap();
    store.flush(ID).await.unwrap();
    assert!(host.sync_authoritative_session(ID).await.unwrap());
    let live_events = std::iter::from_fn(|| live.try_recv().ok())
        .filter(|frame| frame.payload["type"] == "session/event")
        .map(|frame| frame.payload["event"].clone())
        .collect::<Vec<_>>();
    let refreshed = rpc_value(&host, RpcMethod::SessionHistory, json!({"sessionId": ID})).await;
    let refreshed_events = refreshed["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["event"].clone())
        .collect::<Vec<_>>();
    assert_eq!(live_events, refreshed_events[(fork_at_seq as usize + 1)..]);

    let fork = rpc_value(
        &host,
        RpcMethod::SessionFork,
        json!({"sessionId": ID, "atSeq": fork_at_seq}),
    )
    .await;
    let child_id = fork["sessionId"].as_str().unwrap().to_owned();
    let child_history = rpc_value(
        &host,
        RpcMethod::SessionHistory,
        json!({"sessionId": child_id}),
    )
    .await;
    assert_eq!(
        child_history["events"].as_array().unwrap().len(),
        fork_at_seq as usize + 2 // copied prefix plus durable fork-origin marker
    );
    assert!(!child_history.to_string().contains("after fork"));

    drop(host);
    drop(store);
    let reopened: Arc<dyn Store> = Arc::new(
        JsonlSessionStore::new(root.join("sessions"))
            .unwrap()
            .for_runtime(),
    );
    let restored = BasicHost::with_agent_runtime(
        HostConfig::new(&root),
        Arc::new(SnapshotRuntime(reopened.clone())),
    );
    let report = restored.restore_from_store(reopened).await.unwrap();
    assert!(report.issues.is_empty(), "{:?}", report.issues);
    let after_restart = rpc_value(
        &restored,
        RpcMethod::SessionHistory,
        json!({"sessionId": ID}),
    )
    .await;
    let child_after_restart = rpc_value(
        &restored,
        RpcMethod::SessionHistory,
        json!({"sessionId": child_id}),
    )
    .await;
    assert_eq!(after_restart["events"], refreshed["events"]);
    assert_eq!(after_restart["projections"], refreshed["projections"]);
    assert_eq!(child_after_restart["events"], child_history["events"]);
    {
        let state = restored.state.read().await;
        let restored_record = &state.sessions[&child_id];
        assert_eq!(restored_record.parent_session_id.as_deref(), Some(ID));
        assert_eq!(restored_record.origin.as_deref(), Some("fork"));
    }
    assert_eq!(
        child_after_restart["projections"],
        child_history["projections"]
    );
    drop(restored);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn edit_fork_cuts_before_selected_user_message_including_the_first_message() {
    let (host, store) = fixture().await;
    let header = store
        .archive_request(RequestHeader::new("test", "test"))
        .await
        .unwrap();
    let first = store.load(ID).await.unwrap().unwrap();
    let receipt = store
        .append(ID, first.revision(), completed_turn(1, "first", &header))
        .await
        .unwrap();
    store
        .append(ID, receipt.revision, completed_turn(2, "second", &header))
        .await
        .unwrap();
    host.sync_authoritative_session(ID).await.unwrap();
    let source = store.load(ID).await.unwrap().unwrap();
    let user_seqs: Vec<_> = source
        .events()
        .iter()
        .filter_map(|event| {
            matches!(event.data(), EventData::UserMessage { .. }).then_some(event.seq)
        })
        .collect();
    assert_eq!(user_seqs.len(), 2);
    for (index, target) in user_seqs.iter().enumerate() {
        let fork = rpc_value(
            &host,
            RpcMethod::SessionFork,
            json!({"sessionId":ID,"beforeUserSeq":target}),
        )
        .await;
        let id = fork["sessionId"].as_str().unwrap();
        let child = store.load(id).await.unwrap().unwrap();
        let texts: Vec<_> = child
            .events()
            .iter()
            .filter_map(|event| match event.data() {
                EventData::UserMessage { message, .. } => Some(message.content.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(texts.len(), index);
        assert!(!texts.iter().any(|text| text.contains("second")));
        assert!(matches!(child.events().last().unwrap().data(),
            EventData::SessionForkOrigin { parent_session_id, before_user_seq }
            if parent_session_id == ID && *before_user_seq == Some(*target)));
        let record = &host.state.read().await.sessions[id];
        assert_eq!(record.parent_session_id.as_deref(), Some(ID));
        assert_eq!(record.blank, index == 0);
    }
    let invalid = host
        .call(
            RpcId::new("invalid-edit-fork"),
            RpcMethod::SessionFork,
            json!({"sessionId":ID,"beforeUserSeq":u64::MAX}),
            tokio_util::sync::CancellationToken::new(),
        )
        .await;
    assert!(matches!(invalid, RpcResult::Failure { .. }));
}

#[tokio::test]
async fn edit_fork_restores_the_settings_at_the_historical_boundary() {
    let (_, store) = fixture().await;
    let source = store.load(ID).await.unwrap().unwrap();
    let initial = store
        .append(
            ID,
            source.revision(),
            vec![
                EventData::SessionModelSelected {
                    provider: "historical".into(),
                    model: "old-model".into(),
                    reasoning_effort: Some("low".into()),
                    context_window_tokens: Some(32_768),
                }
                .into(),
                EventData::PermissionPreset {
                    preset: "workspace-write".into(),
                }
                .into(),
            ],
        )
        .await
        .unwrap();
    let header = store
        .archive_request(RequestHeader::new("historical", "old-model"))
        .await
        .unwrap();
    let first = store
        .append(ID, initial.revision, completed_turn(1, "first", &header))
        .await
        .unwrap();
    let second = store
        .append(ID, first.revision, completed_turn(2, "second", &header))
        .await
        .unwrap();
    store
        .append(
            ID,
            second.revision,
            vec![
                EventData::SessionModelSelected {
                    provider: "current".into(),
                    model: "new-model".into(),
                    reasoning_effort: Some("high".into()),
                    context_window_tokens: Some(65_536),
                }
                .into(),
                EventData::PermissionPreset {
                    preset: "danger-full-access".into(),
                }
                .into(),
            ],
        )
        .await
        .unwrap();
    let make_host = || {
        BasicHost::with_agent_runtime(
            HostConfig::new(std::env::temp_dir()),
            Arc::new(SnapshotRuntime(store.clone())),
        )
    };
    let host = make_host();
    host.restore_from_store(store.clone()).await.unwrap();
    assert_eq!(
        host.state.read().await.sessions[ID].model.model,
        "new-model"
    );
    let target = store
        .load(ID)
        .await
        .unwrap()
        .unwrap()
        .events()
        .iter()
        .filter_map(|event| {
            matches!(event.data(), EventData::UserMessage { .. }).then_some(event.seq)
        })
        .nth(1)
        .unwrap();
    let fork = rpc_value(
        &host,
        RpcMethod::SessionFork,
        json!({"sessionId":ID,"beforeUserSeq":target}),
    )
    .await;
    let child_id = fork["sessionId"].as_str().unwrap();
    {
        let state = host.state.read().await;
        let child = &state.sessions[child_id];
        assert_eq!(child.model.provider, "historical");
        assert_eq!(child.model.model, "old-model");
        assert_eq!(child.model.reasoning_effort.as_deref(), Some("low"));
        assert_eq!(child.model.context_window_tokens, Some(32_768));
        assert_eq!(
            child.permission_preset,
            crate::PermissionPreset::WorkspaceWrite
        );
    }
    let restored = make_host();
    restored.restore_from_store(store.clone()).await.unwrap();
    let state = restored.state.read().await;
    let child = &state.sessions[child_id];
    assert_eq!(child.model.provider, "historical");
    assert_eq!(child.model.model, "old-model");
    assert_eq!(child.model.reasoning_effort.as_deref(), Some("low"));
    assert_eq!(child.model.context_window_tokens, Some(32_768));
    assert_eq!(
        child.permission_preset,
        crate::PermissionPreset::WorkspaceWrite
    );
}

#[test]
fn fork_of_subagent_does_not_restore_as_a_delegated_child() {
    let mut session = Session::new(SessionHeader::new("fork-of-child")).unwrap();
    session
        .append(
            session.revision(),
            EventData::AgentDelegated {
                parent_session_id: "old-parent".into(),
                invocation_id: "invocation".into(),
                task: "task".into(),
            },
        )
        .unwrap();
    session
        .append(
            session.revision(),
            EventData::AgentDispatchPaused { paused: true },
        )
        .unwrap();
    session
        .append(
            session.revision(),
            EventData::SessionForkOrigin {
                parent_session_id: "actual-source".into(),
                before_user_seq: Some(5),
            },
        )
        .unwrap();
    assert_eq!(crate::delegation::restored_delegation(&session), None);
    assert!(!crate::delegation::restored_dispatch_paused(&session));
}

#[tokio::test]
async fn automatic_compaction_views_match_live_history_and_restart() {
    use std::collections::BTreeMap;
    use xharness_session::{SequenceRange, SurfaceReplace};

    for error in [
        None,
        Some("network timeout"),
        Some("cancelled"),
        Some("output token limit"),
    ] {
        let (host, store) = fixture().await;
        let initial = store.load(ID).await.unwrap().unwrap();
        let history_seq = initial.next_seq() + 1;
        let started = store
            .append(
                ID,
                initial.revision(),
                vec![
                    EventData::TurnStart { turn: 1 }.into(),
                    EventData::UserMessage {
                        message: Message::user("large history"),
                        surface_replace: None,
                    }
                    .into(),
                    EventData::StepStart { turn: 1, step: 1 }.into(),
                    EventData::CompactionStart {
                        compaction_id: "compact-view".into(),
                        source_command_id: None,
                        turn: Some(1),
                    }
                    .into(),
                ],
            )
            .await
            .unwrap();
        let mut receiver = host.event_gateway.subscribe_mux();
        host.sync_authoritative_session(ID).await.unwrap();
        let mut live = BTreeMap::new();
        while let Ok(frame) = receiver.try_recv() {
            if frame.payload["type"] == "session/event"
                && frame.payload["view"]["for"] == "compaction"
            {
                live.insert(
                    frame.payload["event"]["seq"].as_u64().unwrap(),
                    frame.payload["view"].clone(),
                );
            }
        }
        assert_eq!(live.len(), 1);
        assert_eq!(live.values().next().unwrap()["view"]["phase"], "running");

        let mut end_events: Vec<SessionEvent> = Vec::new();
        if error.is_none() {
            let range = SequenceRange {
                start: history_seq,
                end: history_seq,
            };
            end_events.extend([
                EventData::CompactionSummary {
                    compaction_id: "compact-view".into(),
                    source_command_id: None,
                    summary: "摘要 🧪".into(),
                    shadowed_range: range,
                    shadowed_seqs: vec![history_seq],
                    shadowed_token_count: 128,
                    provider: "test".into(),
                    model: "test".into(),
                    max_tokens: Some(64),
                    usage: None,
                }
                .into(),
                EventData::UserMessage {
                    message: Message::user("checkpoint"),
                    surface_replace: Some(SurfaceReplace {
                        compaction_id: "compact-view".into(),
                        shadowed_range: range,
                        shadowed_seqs: vec![history_seq],
                    }),
                }
                .into(),
            ]);
        }
        end_events.extend([
            EventData::CompactionEnd {
                compaction_id: "compact-view".into(),
                source_command_id: None,
                turn: Some(1),
                error: error.map(str::to_owned),
            }
            .into(),
            EventData::StepEnd { turn: 1, step: 1 }.into(),
            EventData::TurnEnd {
                turn: 1,
                reason: error.map_or(TurnEndReason::Completed, |error| TurnEndReason::Failed {
                    error: error.into(),
                }),
            }
            .into(),
        ]);
        store
            .append(ID, started.revision, end_events)
            .await
            .unwrap();
        host.sync_authoritative_session(ID).await.unwrap();
        while let Ok(frame) = receiver.try_recv() {
            if frame.payload["type"] == "session/event"
                && frame.payload["view"]["for"] == "compaction"
            {
                live.insert(
                    frame.payload["event"]["seq"].as_u64().unwrap(),
                    frame.payload["view"].clone(),
                );
            }
        }
        assert_eq!(live.len(), 2);
        assert_eq!(
            live.values().last().unwrap()["view"]["phase"],
            if error.is_some() {
                "failed"
            } else {
                "succeeded"
            }
        );
        let expected = live;
        let restarted = BasicHost::with_agent_runtime(
            HostConfig::new(std::env::temp_dir()),
            Arc::new(SnapshotRuntime(store.clone())),
        );
        restarted.restore_from_store(store.clone()).await.unwrap();
        for candidate in [&host, &restarted] {
            let history = rpc_value(
                candidate,
                RpcMethod::SessionHistory,
                json!({"sessionId": ID}),
            )
            .await;
            let actual = history["events"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|row| row["view"]["for"] == "compaction")
                .map(|row| (row["event"]["seq"].as_u64().unwrap(), row["view"].clone()))
                .collect::<BTreeMap<_, _>>();
            assert_eq!(actual, expected, "live/history/restart mismatch: {error:?}");
        }
    }
}

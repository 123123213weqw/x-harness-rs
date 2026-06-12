//! Synthetic snapshot-only tests: no model, tool execution or production state.
use super::*;
use crate::{runtime::AgentRuntime, HostConfig};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
use xharness_session::{
    EventData, MemorySessionStore, Message, RequestHeader, Revision, Session, SessionHeader,
    SessionTitleSource, Store, TurnEndReason,
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
    for field in 0..8 {
        let mut changed = ProjectionInputs::capture(original);
        match field {
            0 => changed.cursor = Some(original.authoritative_seq.unwrap() + 1),
            1 => changed.cursor = None,
            2 => changed.cache_base_seq += 1,
            3 => changed.created_at += 1,
            4 => changed.route.provider.push_str("-new"),
            5 => changed.route.model.push_str("-new"),
            6 => changed.route.reasoning_effort = Some("different".into()),
            _ => changed.route.context_window_tokens = Some(123),
        }
        assert!(!changed.matches(original), "changed field {field}");
    }
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
        fork_at_seq as usize + 1
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
    assert!(restored
        .restore_from_store(reopened)
        .await
        .unwrap()
        .issues
        .is_empty());
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
    assert_eq!(
        child_after_restart["projections"],
        child_history["projections"]
    );
    drop(restored);
    std::fs::remove_dir_all(root).unwrap();
}

#![forbid(unsafe_code)]
use super::*;
use xharness_session::{AssistantChunk, SessionEvent, ToolCall, ToolResultData};

fn streamed_turn(turn: u32, header: &xharness_session::RequestHeader) -> Vec<SessionEvent> {
    let call = ToolCall {
        id: format!("call-{turn}"),
        provider_call_id: Some(format!("provider-{turn}")),
        index: 0,
        name: "bash".into(),
        arguments_json: r#"{"command":"printf 'Δ\\n'","description":"inert fixture"}"#.into(),
    };
    let mut message = Message::assistant("a complete answer Δ✓");
    message.tool_calls.push(call.clone());
    vec![
        EventData::TurnStart { turn }.into(),
        EventData::UserMessage {
            message: Message::user("unchanged user input ".repeat(40)),
            surface_replace: None,
        }
        .into(),
        EventData::StepStart { turn, step: 1 }.into(),
        EventData::RequestHeader {
            header: header.clone(),
        }
        .into(),
        EventData::AssistantChunk {
            turn,
            step: 1,
            chunk: AssistantChunk::TextDelta("large partial Δ✓ ".repeat(200)),
        }
        .into(),
        EventData::AssistantChunk {
            turn,
            step: 1,
            chunk: AssistantChunk::ReasoningDelta("reasoning ".repeat(100)),
        }
        .into(),
        EventData::AssistantMessage {
            turn,
            step: 1,
            message,
            usage: None,
        }
        .into(),
        EventData::ToolCall {
            turn,
            step: 1,
            call,
        }
        .into(),
        EventData::ToolResult {
            turn,
            step: 1,
            result: ToolResultData::success(format!("call-{turn}"), "result ".repeat(200)),
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

// Tool-call declarations and their audit events are one atomic journal batch.
// A standalone declaration is not a reachable, valid Session snapshot.
fn reachable_batches(events: Vec<SessionEvent>) -> Vec<Vec<SessionEvent>> {
    let mut events = events.into_iter();
    let mut batches = Vec::new();
    while let Some(event) = events.next() {
        let calls = match event.data() {
            EventData::AssistantMessage { message, .. } => message.tool_calls.len(),
            _ => 0,
        };
        let mut batch = vec![event];
        batch.extend(events.by_ref().take(calls));
        assert_eq!(batch.len(), calls + 1);
        batches.push(batch);
    }
    batches
}

async fn limited_fixture(
    count: usize,
    bytes: usize,
    total: usize,
) -> (Arc<BasicHost>, Arc<dyn Store>) {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    store.create(SessionHeader::new(ID)).await.unwrap();
    let mut config = HostConfig::new(std::env::temp_dir());
    config.session_event_cache_capacity = count;
    config.session_event_cache_bytes = bytes;
    config.session_event_cache_total_bytes = total;
    let host = BasicHost::with_agent_runtime(config, Arc::new(SnapshotRuntime(store.clone())));
    host.restore_from_store(store.clone()).await.unwrap();
    (host, store)
}

#[tokio::test]
async fn working_plan_survives_zero_display_budget_history_and_restart() {
    let (host, store) = limited_fixture(2048, 16 * 1024 * 1024, 0).await;
    let reply = rpc_value(
        &host,
        RpcMethod::GoalUpdatePlan,
        json!({"sessionId":ID,"planRevision":0,"items":[{"id":"verify","title":"Verify after eviction","status":"in_progress"}]}),
    )
    .await;
    let expected = reply["plan"].clone();
    assert_eq!(expected["revision"], 1);
    {
        let state = host.state.read().await;
        assert!(state.sessions[ID].events.is_empty());
        assert_eq!(state.sessions[ID].event_cache_resident_bytes, 0);
    }
    let mut config = HostConfig::new(std::env::temp_dir());
    config.session_event_cache_total_bytes = 0;
    let restarted = BasicHost::with_agent_runtime(config, Arc::new(SnapshotRuntime(store.clone())));
    restarted.restore_from_store(store.clone()).await.unwrap();
    for candidate in [&*host, &restarted] {
        let history = rpc_value(
            candidate,
            RpcMethod::SessionHistory,
            json!({"sessionId":ID}),
        )
        .await;
        assert_eq!(history["projections"]["values"]["taskPlan"], expected);
        assert!(candidate.state.read().await.sessions[ID].events.is_empty());
    }
    assert!(xharness_session::session_plan(&store.load(ID).await.unwrap().unwrap()).is_some());
}

#[tokio::test]
async fn incremental_cache_matches_full_projection_at_every_prefix_and_eviction_boundary() {
    for count in [0, 1, 7, 64] {
        for bytes in [0, 1, 512, 4096, 64 * 1024] {
            let (host, store) = limited_fixture(count, bytes, usize::MAX).await;
            let header = store
                .archive_request(RequestHeader::new("test", "test"))
                .await
                .unwrap();
            for turn in 1..=3 {
                for batch in reachable_batches(streamed_turn(turn, &header)) {
                    let floor = host.state.read().await.sessions[ID].event_base_seq;
                    let before = store.load(ID).await.unwrap().unwrap();
                    store.append(ID, before.revision(), batch).await.unwrap();
                    let current = store.load(ID).await.unwrap().unwrap();
                    let route =
                        ProjectionInputs::capture(&host.state.read().await.sessions[ID]).route;
                    let expected =
                        project_session_event_tail_from(&current, &route, floor, count, bytes);
                    host.sync_authoritative_session(ID).await.unwrap();
                    let state = host.state.read().await;
                    let actual = &state.sessions[ID];
                    assert_eq!(
                        actual.events,
                        expected.events,
                        "count={count} bytes={bytes} seq={}",
                        current.next_seq()
                    );
                    assert_eq!(actual.event_cache_bytes, expected.bytes);
                    assert_eq!(actual.event_cache_weights, expected.event_bytes);
                    assert_eq!(actual.event_cache_resident_bytes, expected.resident_bytes);
                    assert_eq!(
                        actual.event_cache_resident_weights,
                        expected.event_resident_bytes
                    );
                    assert_eq!(actual.event_base_seq, expected.base_seq);
                    assert_eq!(actual.authoritative_seq, Some(current.next_seq()));
                    assert!(actual.events.len() <= count.max(1));
                    assert!(actual.event_cache_bytes <= bytes);
                }
            }
        }
    }
}

#[tokio::test]
async fn appending_a_delta_keeps_old_payload_allocations_and_finalization_replaces_only_chunks() {
    let (host, store) = limited_fixture(2048, 16 * 1024 * 1024, usize::MAX).await;
    let header = store
        .archive_request(RequestHeader::new("test", "test"))
        .await
        .unwrap();
    let mut events = streamed_turn(1, &header);
    let suffix = events.split_off(4);
    store.append(ID, Revision::ZERO, events).await.unwrap();
    host.sync_authoritative_session(ID).await.unwrap();
    let (seq, old_pointer) = {
        let state = host.state.read().await;
        let event = state.sessions[ID]
            .events
            .iter()
            .find(|event| event["type"] == "user/message")
            .unwrap();
        (
            event["seq"].as_u64().unwrap(),
            event["data"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .as_ptr() as usize,
        )
    };
    for batch in reachable_batches(suffix) {
        let before = store.load(ID).await.unwrap().unwrap();
        store.append(ID, before.revision(), batch).await.unwrap();
        host.sync_authoritative_session(ID).await.unwrap();
        let state = host.state.read().await;
        let event = state.sessions[ID]
            .events
            .iter()
            .find(|event| event["seq"] == seq)
            .unwrap();
        assert_eq!(
            event["data"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .as_ptr() as usize,
            old_pointer
        );
    }
    let state = host.state.read().await;
    assert!(!state.sessions[ID]
        .events
        .iter()
        .any(|event| event["type"] == "assistant/chunk"));
    assert_eq!(
        state.sessions[ID]
            .events
            .iter()
            .filter(|event| event["data"]["kind"] == "folded-assistant-chunk")
            .count(),
        2
    );
}

#[tokio::test]
async fn global_budget_evicts_display_data_without_losing_history_or_running_state() {
    for budget in [0, 512, 4096] {
        let (host, store) = limited_fixture(2048, 16 * 1024 * 1024, budget).await;
        let header = store
            .archive_request(RequestHeader::new("test", "test"))
            .await
            .unwrap();
        for index in 1..8 {
            store
                .create(SessionHeader::new(format!("cache-owner-{index}")))
                .await
                .unwrap();
        }
        host.restore_from_store(store.clone()).await.unwrap();
        for index in 0..8 {
            let id = if index == 0 {
                ID.into()
            } else {
                format!("cache-owner-{index}")
            };
            store
                .append(&id, Revision::ZERO, streamed_turn(1, &header))
                .await
                .unwrap();
            host.state
                .write()
                .await
                .sessions
                .get_mut(&id)
                .unwrap()
                .running = true;
            host.sync_authoritative_session(&id).await.unwrap();
            let state = host.state.read().await;
            assert!(state.sessions[&id].running);
            assert!(
                state
                    .sessions
                    .values()
                    .map(|record| record.event_cache_resident_bytes)
                    .sum::<usize>()
                    <= budget
            );
            for record in state.sessions.values() {
                assert_eq!(
                    record.event_cache_bytes,
                    record.event_cache_weights.iter().sum::<usize>()
                );
                assert_eq!(record.events.len(), record.event_cache_weights.len());
                assert_eq!(
                    record.events.len(),
                    record.event_cache_resident_weights.len()
                );
                assert_eq!(
                    record.event_cache_resident_bytes,
                    record.event_cache_resident_weights.iter().sum::<usize>()
                );
                assert!(record.event_cache_resident_bytes >= record.event_cache_bytes);
                assert_eq!(
                    record.event_cache_resident_weights,
                    record
                        .events
                        .iter()
                        .zip(&record.event_cache_weights)
                        .map(|(event, encoded)| {
                            xharness_projection::estimated_event_resident_bytes(event).max(*encoded)
                        })
                        .collect::<Vec<_>>()
                );
                if record.events.is_empty() {
                    assert_eq!(record.events.capacity(), 0);
                    assert_eq!(record.event_cache_weights.capacity(), 0);
                    assert_eq!(record.event_cache_resident_weights.capacity(), 0);
                }
                assert_eq!(
                    record.next_event_seq(),
                    record.event_base_seq + record.events.len() as u64
                );
            }
        }
        let history = rpc_value(
            &host,
            RpcMethod::SessionHistory,
            json!({"sessionId":ID,"maxMessages":2000}),
        )
        .await;
        assert_eq!(history["hasMore"], false);
        assert!(history["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["event"]["type"] == "user/message"));
        assert!(store.load(ID).await.unwrap().unwrap().events().len() > 8);
    }
}

#[tokio::test]
async fn global_budget_respects_history_access_recency_and_keeps_cursors_and_metrics() {
    let (host, store) = limited_fixture(2048, 16 * 1024 * 1024, usize::MAX).await;
    for id in ["cold-owner", "preferred-owner"] {
        store.create(SessionHeader::new(id)).await.unwrap();
    }
    host.restore_from_store(store.clone()).await.unwrap();
    let header = store
        .archive_request(RequestHeader::new("test", "test"))
        .await
        .unwrap();
    for id in [ID, "cold-owner", "preferred-owner"] {
        store
            .append(id, Revision::ZERO, streamed_turn(1, &header))
            .await
            .unwrap();
        host.sync_authoritative_session(id).await.unwrap();
    }
    // A read refreshes recency, without needing another model event.
    rpc_value(&host, RpcMethod::SessionHistory, json!({"sessionId":ID})).await;
    let mut state = host.state.write().await;
    let total = state
        .sessions
        .values()
        .map(|r| r.event_cache_resident_bytes)
        .sum::<usize>();
    let cold_bytes = state.sessions["cold-owner"].event_cache_resident_bytes;
    let cursor = state.sessions["cold-owner"].authoritative_seq;
    let metrics = state.sessions["cold-owner"].metrics.catalog_snapshot();
    state.enforce_projection_budget("preferred-owner", total - cold_bytes);
    assert!(state.sessions["cold-owner"].events.is_empty());
    assert!(!state.sessions[ID].events.is_empty());
    assert!(!state.sessions["preferred-owner"].events.is_empty());
    assert_eq!(state.sessions["cold-owner"].authoritative_seq, cursor);
    assert_eq!(
        state.sessions["cold-owner"].metrics.catalog_snapshot(),
        metrics
    );
}

#[tokio::test]
async fn concurrent_prefix_eviction_can_rebase_a_prepared_final_message() {
    let (host, store) = limited_fixture(2048, 16 * 1024 * 1024, usize::MAX).await;
    let header = store
        .archive_request(RequestHeader::new("test", "test"))
        .await
        .unwrap();
    let mut events = streamed_turn(1, &header);
    let suffix = events.split_off(6);
    store.append(ID, Revision::ZERO, events).await.unwrap();
    host.sync_authoritative_session(ID).await.unwrap();
    let inputs = ProjectionInputs::capture(&host.state.read().await.sessions[ID]);
    let current = store.load(ID).await.unwrap().unwrap();
    store
        .append(ID, current.revision(), suffix[..2].to_vec())
        .await
        .unwrap();
    let current = store.load(ID).await.unwrap().unwrap();
    let update = prepare_session_tail_update(
        &current,
        &inputs.route,
        inputs.cache_base_seq,
        inputs.cursor,
        true,
        2048,
        16 * 1024 * 1024,
    );
    let mut state = host.state.write().await;
    let record = state.sessions.get_mut(ID).unwrap();
    record.trim_event_cache(0, 0);
    assert!(inputs.matches(record));
    let expected = project_session_event_tail_from(
        &current,
        &inputs.route,
        record.event_base_seq,
        2048,
        16 * 1024 * 1024,
    );
    record.apply_tail_update(update, 2048, 16 * 1024 * 1024);
    assert_eq!(record.events, expected.events);
    assert_eq!(record.event_cache_bytes, expected.bytes);
    assert_eq!(record.event_cache_weights, expected.event_bytes);
}

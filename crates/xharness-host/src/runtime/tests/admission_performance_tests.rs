//! Real RPC/durable-runtime admission; isolated synthetic journals and fake provider only.
#![forbid(unsafe_code)]
use super::*;
use serde_json::json;
use std::time::Instant;
use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
use xharness_session::{AssistantChunk, EventData, Message, RequestHeader};
use xharness_session_jsonl::JsonlSessionStore;

struct TestDir(std::path::PathBuf);
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn exercise(chunks: usize, scoped: bool, recover: bool, warm_projection: bool) {
    let dir = TestDir(std::env::temp_dir().join(format!(
        "xh-admission-{}-{}-{chunks}-{scoped}",
        std::process::id(),
        crate::state::now_ms()
    )));
    let disk = JsonlSessionStore::new(&dir.0)
        .unwrap()
        .for_runtime()
        .with_cache_limits(1024, 1);
    let disk = Arc::new(if scoped {
        disk
    } else {
        disk.with_replay_scope_cache_limit(0)
    });
    let store: Arc<dyn Store> = disk.clone();
    let (host, runtime) = super::dispatch_tests::fixture(store.clone());
    let id = "large-admission";
    crate::rpc::session_lifecycle::create(&host, &json!({"sessionId":id}))
        .await
        .unwrap();
    let revision = store.load(id).await.unwrap().unwrap().revision();
    let mut events = vec![
        EventData::TurnStart { turn: 1 }.into(),
        EventData::UserMessage {
            message: Message::user("synthetic previous task"),
            surface_replace: None,
        }
        .into(),
        EventData::StepStart { turn: 1, step: 1 }.into(),
        EventData::RequestHeader {
            header: RequestHeader::new("test", "test-model"),
        }
        .into(),
    ];
    for _ in 0..chunks {
        events.push(
            EventData::AssistantChunk {
                turn: 1,
                step: 1,
                chunk: AssistantChunk::TextDelta("synthetic stream data ".repeat(20)),
            }
            .into(),
        );
    }
    events.extend([
        EventData::AssistantMessage {
            turn: 1,
            step: 1,
            message: Message::assistant("previous answer"),
            usage: None,
        }
        .into(),
        EventData::StepEnd { turn: 1, step: 1 }.into(),
        EventData::TurnEnd {
            turn: 1,
            reason: TurnEndReason::Completed,
        }
        .into(),
    ]);
    store.append(id, revision, events).await.unwrap();
    store.flush(id).await.unwrap();
    // A long-used conversation normally already has a current browser
    // projection. Keep first-open hydration outside the warm send measurement.
    if warm_projection {
        host.sync_authoritative_session(id).await.unwrap();
    }
    // Model an existing Host observer that owns the running conversation. It
    // must not cause a new provider turn merely to acknowledge queued input.
    let (tx, _rx) = tokio::sync::mpsc::channel(64);
    {
        let mut state = host.state.write().await;
        let record = state.sessions.get_mut(id).unwrap();
        record.running = true;
        record.control = Some(tx);
    }
    let before = disk.authoritative_replay_count();
    let payload =
        json!({"sessionId":id,"mode":"queue","content":[{"type":"text","text":"new task"}]});
    let start = Instant::now();
    let response = host
        .call(
            RpcId::new("long-input"),
            RpcMethod::SessionPrompt,
            payload.clone(),
            CancellationToken::new(),
        )
        .await;
    let elapsed = start.elapsed();
    assert!(
        matches!(response, RpcResult::Success { .. }),
        "{response:?}"
    );
    let replays = disk.authoritative_replay_count() - before;
    assert_eq!(
        disk.replay_scope_cache_stats().accounted_bytes,
        0,
        "RPC must release temporary snapshots"
    );
    assert_eq!(
        disk.cache_stats().entries,
        0,
        "snapshot deliberately exceeds resident budget"
    );
    if scoped {
        assert_eq!(
            replays, 1,
            "all admission stages must share one authoritative replay"
        );
    } else {
        assert!(
            replays >= 4,
            "control must exercise redundant replay, got {replays}"
        );
    }
    println!("ADMISSION_BENCH chunks={chunks} scoped={scoped} warm_projection={warm_projection} rpc_ms={} full_replays={replays} journal_bytes={}",
        elapsed.as_millis(), std::fs::metadata(dir.0.join(format!("{id}.jsonl"))).unwrap().len());
    // Retry must be idempotent, and conflicting reuse must still be rejected.
    assert!(host
        .call(
            RpcId::new("long-input"),
            RpcMethod::SessionPrompt,
            payload.clone(),
            CancellationToken::new()
        )
        .await
        .is_ok());
    let mut conflict = payload.clone();
    conflict["content"][0]["text"] = json!("different task");
    assert!(!host
        .call(
            RpcId::new("long-input"),
            RpcMethod::SessionPrompt,
            conflict,
            CancellationToken::new()
        )
        .await
        .is_ok());
    assert_eq!(
        disk.replay_scope_cache_stats().accounted_bytes,
        0,
        "error/retry must release reuse too"
    );
    let snapshot = store.load(id).await.unwrap().unwrap();
    assert_eq!(
        xharness_agent::InboxProjection::from_session(&snapshot)
            .unwrap()
            .next_turn()
            .len(),
        1
    );
    assert_eq!(
        snapshot
            .events()
            .iter()
            .filter(|e| matches!(e.data(), EventData::AssistantChunk { .. }))
            .count(),
        chunks
    );
    runtime.shutdown(Duration::from_secs(1)).await;
    drop(snapshot);
    drop(host);
    drop(runtime);
    drop(store);
    drop(disk);
    if recover {
        let store: Arc<dyn Store> = Arc::new(JsonlSessionStore::new(&dir.0).unwrap().for_runtime());
        let (host, runtime) = super::dispatch_tests::fixture(store.clone());
        let report = host.restore_from_store(store.clone()).await.unwrap();
        assert_eq!(report.resumed_pending_turns, 1);
        super::dispatch_tests::wait_idle(&host, &store, id).await;
        let session = store.load(id).await.unwrap().unwrap();
        assert_eq!(session.events().iter().filter(|e| matches!(e.data(), EventData::UserMessage { message, .. } if message.id.as_deref() == Some("long-input"))).count(), 1);
        assert!(host
            .call(
                RpcId::new("long-input"),
                RpcMethod::SessionPrompt,
                payload,
                CancellationToken::new()
            )
            .await
            .is_ok());
        assert!(!xharness_agent::InboxProjection::from_session(
            &store.load(id).await.unwrap().unwrap()
        )
        .unwrap()
        .has_pending());
        runtime.shutdown(Duration::from_secs(1)).await;
    }
}

#[tokio::test]
async fn oversized_history_rpc_replays_once_and_recovers_queued_input_exactly_once() {
    exercise(4096, true, true, false).await;
}

#[tokio::test]
#[ignore = "remote optimized real-RPC A/B acceptance, no network/model calls"]
async fn large_history_rpc_performance_acceptance() {
    for chunks in [1_000, 10_000, 115_000] {
        exercise(chunks, false, false, true).await;
        exercise(chunks, true, false, true).await;
    }
    exercise(115_000, true, false, false).await;
}

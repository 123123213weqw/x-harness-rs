//! Actual Host/RPC + Core streaming + JSONL; no network, credentials or user data.
#![forbid(unsafe_code)]
use super::*;
use futures::StreamExt;
use serde_json::json;
use xharness_api::{ApiBackend, RpcId, RpcMethod};
use xharness_session::{AssistantChunk, EventData, Message};
use xharness_session_jsonl::JsonlSessionStore;

struct TestDir(std::path::PathBuf);
impl TestDir {
    fn new(label: &str) -> Self {
        Self(std::env::temp_dir().join(format!(
            "xh-stream-{}-{}-{label}",
            std::process::id(),
            crate::state::now_ms()
        )))
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct StreamingProvider {
    frames: usize,
    completed: Arc<AtomicUsize>,
    fail: bool,
    disk: Option<Arc<JsonlSessionStore>>,
    samples: Arc<Mutex<Vec<(usize, usize)>>>,
    gates: Option<(Arc<tokio::sync::Barrier>, Arc<tokio::sync::Barrier>)>,
}
#[async_trait]
impl ModelProvider for StreamingProvider {
    async fn stream(
        &self,
        _: ProviderRequest,
        cancel: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let frames = self.frames;
        let completed = Arc::clone(&self.completed);
        let fail = self.fail;
        let disk = self.disk.clone();
        let samples = self.samples.clone();
        let gates = self.gates.clone();
        Ok(Box::pin(async_stream::stream! {
            if let Some((start, _)) = &gates {
                start.wait().await;
            }
            let replays_before = disk.as_ref().map_or(0, |d| d.authoritative_replay_count());
            for n in 0..frames {
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = tokio::time::sleep(Duration::from_millis(2)) => {}
                }
                yield Ok(if n % 2 == 0 {
                    ProviderEvent::TextDelta("text".into())
                } else {
                    ProviderEvent::ReasoningDelta("mind".into())
                });
            }
            samples.lock().unwrap().push((
                replays_before,
                disk.as_ref().map_or(0, |d| d.authoritative_replay_count()),
            ));
            if let Some((_, end)) = &gates {
                end.wait().await;
            }
            completed.fetch_add(1, AtomicOrdering::SeqCst);
            if fail {
                yield Err(ProviderError::new("synthetic stream failure"));
            } else {
                yield Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::Stop),
                    usage: None,
                    provider_items: vec![],
                });
            }
        }))
    }
}

async fn seed(store: &dyn Store, id: &str) {
    let revision = store.load(id).await.unwrap().unwrap().revision();
    let mut events = vec![
        EventData::TurnStart { turn: 1 }.into(),
        EventData::UserMessage {
            message: Message::user("synthetic history"),
            surface_replace: None,
        }
        .into(),
        EventData::StepStart { turn: 1, step: 1 }.into(),
    ];
    for _ in 0..2048 {
        events.push(
            EventData::AssistantChunk {
                turn: 1,
                step: 1,
                chunk: AssistantChunk::TextDelta("history ".repeat(64)),
            }
            .into(),
        );
    }
    events.extend([
        EventData::AssistantMessage {
            turn: 1,
            step: 1,
            message: Message::assistant("old answer"),
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
}

#[tokio::test]
async fn oversized_live_host_streams_have_bounded_replay_and_exact_history() {
    for sessions in [1, 4] {
        let dir = TestDir::new(&format!("host-{sessions}"));
        let disk = Arc::new(
            JsonlSessionStore::new(&dir.0)
                .unwrap()
                .for_runtime()
                .with_cache_limits(1024, 1),
        );
        let store: Arc<dyn Store> = disk.clone();
        let completed = Arc::new(AtomicUsize::new(0));
        let samples = Arc::new(Mutex::new(Vec::new()));
        let runtime = Arc::new(DurableLoopAgentRuntime::new(
            "test",
            "test-model",
            Some(Arc::new(StreamingProvider {
                frames: 128,
                completed: completed.clone(),
                fail: false,
                disk: Some(disk.clone()),
                samples: samples.clone(),
                gates: Some((
                    Arc::new(tokio::sync::Barrier::new(sessions)),
                    Arc::new(tokio::sync::Barrier::new(sessions)),
                )),
            })),
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            store.clone(),
            Arc::new(MemoryLeaseManager::default()),
            64,
        ));
        let mut config = crate::HostConfig::new(std::env::current_dir().unwrap());
        config.provider_id = "test".into();
        config.model_id = "test-model".into();
        let host = crate::BasicHost::with_agent_runtime(config, runtime.clone());
        for n in 0..sessions {
            let id = format!("stream-{n}");
            crate::rpc::session_lifecycle::create(&host, &json!({"sessionId":id}))
                .await
                .unwrap();
            seed(store.as_ref(), &id).await;
            host.sync_authoritative_session(&id).await.unwrap();
        }
        let before = disk.authoritative_replay_count();
        let start = std::time::Instant::now();
        for n in 0..sessions {
            let id = format!("stream-{n}");
            assert!(host
                .call(
                    RpcId::new(format!("prompt-{n}")),
                    RpcMethod::SessionPrompt,
                    json!({"sessionId":id,"mode":"queue","content":[{"type":"text","text":"stream now"}]}),
                    CancellationToken::new(),
                )
                .await
                .is_ok());
        }
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if completed.load(AtomicOrdering::SeqCst) == sessions
                    && host
                        .state
                        .read()
                        .await
                        .sessions
                        .values()
                        .all(|record| !record.running)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("durable streams and Host observers must settle");
        let replays = disk.authoritative_replay_count() - before;
        eprintln!(
            "STREAM_PHASE samples={:?} scope={:?}",
            samples.lock().unwrap(),
            disk.replay_scope_cache_stats()
        );
        println!(
            "HOST_STREAM sessions={sessions} frames=128 elapsed_ms={} full_replays={replays}",
            start.elapsed().as_millis()
        );
        // Measure source-emission only: admission/finalization legitimately
        // replay structural state. Barriers exclude those phases, rather than
        // allowing checkpoint reads to hide behind a loose whole-RPC budget.
        let stream_replays = {
            let readings = samples.lock().unwrap();
            let first = readings.iter().map(|p| p.0).min().unwrap();
            let last = readings.iter().map(|p| p.1).max().unwrap();
            last - first
        };
        assert!(
            stream_replays <= sessions,
            "stream checkpoints must reuse at most one initial replay per active model: {stream_replays}",
        );
        assert_eq!(
            disk.replay_scope_cache_stats().accounted_bytes,
            0,
            "finished model scopes must release their snapshots"
        );
        assert_eq!(
            disk.cache_stats().entries,
            0,
            "oversized fixture must not be promoted into the LRU"
        );
        for n in 0..sessions {
            let id = format!("stream-{n}");
            let fresh = JsonlSessionStore::new(&dir.0)
                .unwrap()
                .load(&id)
                .await
                .unwrap()
                .unwrap();
            let answer = fresh.derive_messages().pop().unwrap();
            assert_eq!(answer.content, "text".repeat(64));
            assert_eq!(answer.reasoning, "mind".repeat(64));
            let cursor = host.state.read().await.sessions[&id].authoritative_seq;
            assert_eq!(
                cursor,
                Some(fresh.next_seq()),
                "live view and restart must reach the identical durable cut"
            );
        }
        runtime.shutdown(Duration::from_secs(1)).await;
    }
}

#[tokio::test]
async fn model_scope_releases_on_cancel_and_provider_failure() {
    use xharness_core::{AgentMessage, LoopEngine, LoopEventKind, LoopRequest, LoopStatus};
    for fail in [false, true] {
        let dir = TestDir::new(&format!("terminal-{fail}"));
        let disk = Arc::new(
            JsonlSessionStore::new(&dir.0)
                .unwrap()
                .for_runtime()
                .with_cache_limits(1024, 1),
        );
        disk.create(SessionHeader::new("terminal")).await.unwrap();
        seed(disk.as_ref(), "terminal").await;
        let mut request = LoopRequest::new(
            Arc::new(StreamingProvider {
                frames: if fail { 8 } else { 1000 },
                completed: Arc::new(AtomicUsize::new(0)),
                fail,
                disk: None,
                samples: Arc::new(Mutex::new(Vec::new())),
                gates: None,
            }),
            vec![AgentMessage::user("synthetic request")],
        );
        request.session_id = Some("terminal".into());
        request.journal_store = Some(disk.clone());
        let mut run = LoopEngine.start(request);
        if !fail {
            let mut events = run.subscribe_events_from(0);
            while let Some(event) = events.next().await {
                if matches!(event.kind, LoopEventKind::TextDelta(_)) {
                    run.cancel();
                    break;
                }
            }
        }
        let result = tokio::time::timeout(Duration::from_secs(10), run.result())
            .await
            .unwrap();
        assert_eq!(
            result.status,
            if fail {
                LoopStatus::Failed
            } else {
                LoopStatus::Cancelled
            }
        );
        assert_eq!(disk.replay_scope_cache_stats().accounted_bytes, 0);
        JsonlSessionStore::new(&dir.0)
            .unwrap()
            .load("terminal")
            .await
            .unwrap()
            .unwrap();
    }
}

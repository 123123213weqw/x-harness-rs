//! Synthetic journal pressure, not a model-speed benchmark. No credentials or
//! real conversations are read. Generate once; run before/after in fresh processes.
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use xharness_session::{
    AssistantChunk, EventData, Message, ModelReception, Revision, SessionHeader, Store,
    TurnEndReason,
};
use xharness_session_jsonl::JsonlSessionStore;

#[tokio::main(worker_threads = 8)]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args: Vec<_> = std::env::args().collect();
    let mode = args.get(1).ok_or("generate/run required")?;
    let root = PathBuf::from(args.get(2).ok_or("fixture directory required")?);
    if mode == "generate" {
        let sessions: usize = args.get(3).ok_or("sessions required")?.parse()?;
        let mib: usize = args.get(4).ok_or("history MiB required")?.parse()?;
        if root.exists() || !(1..=16).contains(&sessions) || !(1..=96).contains(&mib) {
            return Err("new fixture directory, 1..16 sessions, 1..96 MiB required".into());
        }
        let store = JsonlSessionStore::new(&root)?;
        for n in 0..sessions {
            let id = format!("pressure-{n}");
            store.create(SessionHeader::new(&id)).await?;
            let mut events = vec![
                EventData::TurnStart { turn: 1 }.into(),
                EventData::UserMessage {
                    message: Message::user("synthetic history"),
                    surface_replace: None,
                }
                .into(),
                EventData::StepStart { turn: 1, step: 1 }.into(),
            ];
            for _ in 0..mib * 128 {
                events.push(
                    EventData::AssistantChunk {
                        turn: 1,
                        step: 1,
                        chunk: AssistantChunk::TextDelta("x".repeat(8192)),
                    }
                    .into(),
                );
            }
            events.extend([
                EventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message: Message::assistant("synthetic historical answer"),
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
            store.append(&id, Revision::ZERO, events).await?;
            store.flush(&id).await?;
        }
        std::fs::write(
            root.join("stream-pressure.json"),
            serde_json::to_vec(&serde_json::json!({"sessions":sessions,"historyMiB":mib}))?,
        )?;
        println!(
            "{}",
            serde_json::json!({"generated":sessions,"historyMiB":mib})
        );
        return Ok(());
    }
    let observed = mode == "run-observed";
    if mode != "run" && !observed {
        return Err("generate/run required".into());
    }
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("stream-pressure.json"))?)?;
    let sessions = manifest["sessions"]
        .as_u64()
        .ok_or("invalid fixture manifest")? as usize;
    let frames: usize = args.get(3).ok_or("frames required")?.parse()?;
    let pace_ms: u64 = args.get(4).map_or(Ok(0), |s| s.parse())?;
    if !(1..=16).contains(&sessions) || !(1..=4096).contains(&frames) || pace_ms > 1000 {
        return Err("fixture/pressure bounds exceeded".into());
    }
    let store = Arc::new(JsonlSessionStore::new(&root)?.for_runtime());
    let mut cuts = Vec::new();
    for n in 0..sessions {
        let id = format!("pressure-{n}");
        let cut = store.load(&id).await?.ok_or("missing fixture session")?;
        let turn = cut
            .events()
            .iter()
            .filter_map(|e| match e.data() {
                EventData::TurnStart { turn } => Some(*turn),
                _ => None,
            })
            .max()
            .unwrap_or(0)
            + 1;
        let revision = store
            .append(
                &id,
                cut.revision(),
                vec![
                    EventData::TurnStart { turn }.into(),
                    EventData::UserMessage {
                        message: Message::user("synthetic stream"),
                        surface_replace: None,
                    }
                    .into(),
                    EventData::StepStart { turn, step: 1 }.into(),
                ],
            )
            .await?
            .revision;
        cuts.push((id, turn, revision));
    }
    let before = store.authoritative_replay_count();
    let start = Instant::now();
    let barrier = Arc::new(tokio::sync::Barrier::new(sessions + 1));
    let mut tasks = Vec::new();
    for (id, turn, mut revision) in cuts {
        let store = Arc::clone(&store);
        let barrier = Arc::clone(&barrier);
        tasks.push(tokio::spawn(async move {
            let _scope = if observed {
                Some(store.read_scope(&id)?)
            } else {
                None
            };
            barrier.wait().await;
            let mut latencies = Vec::new();
            for n in 0..frames {
                if pace_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(pace_ms)).await;
                }
                let sample = ModelReception {
                    attempt: 0,
                    start_ms: 1000,
                    first_delta_ms: Some(1001),
                    elapsed_ms: n as u64 + 2,
                    reception_ms: n as u64 + 1,
                    estimated_units: n as u64 * 256,
                    estimated_reasoning_units: 0,
                    finished: false,
                    output_tokens: None,
                    reasoning_tokens: None,
                    samples: vec![],
                };
                let at = Instant::now();
                revision = store
                    .append(
                        &id,
                        revision,
                        vec![
                            EventData::AssistantChunk {
                                turn,
                                step: 1,
                                chunk: AssistantChunk::TextDelta(format!(
                                    "{n}:{}",
                                    "y".repeat(256)
                                )),
                            }
                            .into(),
                            EventData::ModelReception {
                                turn,
                                step: 1,
                                reception: sample,
                            }
                            .into(),
                        ],
                    )
                    .await?
                    .revision;
                latencies.push(at.elapsed().as_micros() as u64);
                if observed {
                    let cut = store.load(&id).await?.expect("fixture still exists");
                    assert_eq!(cut.revision(), revision);
                }
            }
            Ok::<_, xharness_session::StoreError>((id, turn, revision, latencies))
        }));
    }
    barrier.wait().await;
    let mut durations = Vec::new();
    let mut completed = Vec::new();
    for task in tasks {
        let (id, turn, revision, latencies) = task.await??;
        durations.extend(latencies);
        completed.push((id, turn, revision));
    }
    let elapsed_ms = start.elapsed().as_millis();
    let replays = store.authoritative_replay_count() - before;
    // Verify the actual disk replay independently, after timing the hot path.
    for (id, turn, revision) in completed {
        store
            .append(
                &id,
                revision,
                vec![
                    EventData::AssistantMessage {
                        turn,
                        step: 1,
                        message: Message::assistant(format!("{frames} synthetic frames completed")),
                        usage: None,
                    }
                    .into(),
                    EventData::StepEnd { turn, step: 1 }.into(),
                    EventData::TurnEnd {
                        turn,
                        reason: TurnEndReason::Completed,
                    }
                    .into(),
                ],
            )
            .await?;
        store.flush(&id).await?;
        let reopened = JsonlSessionStore::new(&root)?
            .load(&id)
            .await?
            .ok_or("missing replay")?;
        let observed = reopened
            .events()
            .iter()
            .filter(|e| matches!(e.data(), EventData::ModelReception { turn: t, .. } if *t == turn))
            .count();
        if observed != frames {
            return Err("missing or duplicate persisted samples".into());
        }
    }
    durations.sort_unstable();
    let percentile = |p: usize| durations[(durations.len() - 1) * p / 100] as f64 / 1000.0;
    let cache = store.cache_stats();
    println!(
        "{}",
        serde_json::json!({"sessions":sessions,"historyMiB":manifest["historyMiB"],"framesPerSession":frames,"paceMs":pace_ms,
        "elapsedMs":elapsed_ms,"observed":observed,"appendP50Ms":percentile(50),"appendP95Ms":percentile(95),"appendP99Ms":percentile(99),
        "hotPathAuthoritativeReplays":replays,"residentCacheBytes":cache.accounted_bytes,"residentCacheLimit":cache.max_bytes,"replayVerified":true})
    );
    Ok(())
}

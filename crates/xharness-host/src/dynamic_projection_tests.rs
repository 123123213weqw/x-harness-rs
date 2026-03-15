//! Opt-in dynamic incident experiment. Only synthetic commands/data are accepted.
//! The same test module is overlaid onto both release revisions by CI. No model,
//! user configuration, historical commands or production state are accessed.
use super::*;
use crate::{
    runtime::{AgentRuntime, AgentRuntimeError, AgentTurnRequest, RunningTurn},
    HostConfig,
};
use async_trait::async_trait;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use xharness_session::{Revision, SessionEvent, SessionHeader, ToolCall, ToolResultData};
use xharness_session_jsonl::JsonlSessionStore;

const ID: &str = "dynamic-projection-synthetic";
const WARM_TURNS: u32 = 512;
const LIVE_TURNS: u32 = 64;

struct SnapshotOnlyRuntime(Arc<dyn Store>);

#[async_trait]
impl AgentRuntime for SnapshotOnlyRuntime {
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
    async fn start_turn(
        &self,
        _: AgentTurnRequest,
    ) -> Result<Box<dyn RunningTurn>, AgentRuntimeError> {
        panic!("offline test must never execute an Agent turn")
    }
}

fn closed_turn(turn: u32, request_header: &RequestHeader) -> Vec<SessionEvent> {
    vec![
        EventData::TurnStart { turn }.into(),
        EventData::UserMessage {
            message: Message::user("synthetic"),
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
            message: Message::assistant("synthetic reply"),
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

async fn append(
    store: &dyn Store,
    revision: &mut Revision,
    events: Vec<SessionEvent>,
    host: &BasicHost,
) {
    *revision = store.append(ID, *revision, events).await.unwrap().revision;
    assert!(host.sync_authoritative_session(ID).await.unwrap());
    tokio::task::yield_now().await;
}

fn host_config(root: &Path) -> HostConfig {
    let mut config = HostConfig::new(root);
    config.provider_id = "offline".into();
    config.model_id = "offline".into();
    config.event_capacity = 8192;
    config.session_event_cache_capacity = 64;
    config.session_event_cache_bytes = 256 * 1024;
    config
}

// Fixed local shell probes, not commands obtained from a journal or model.
#[cfg(windows)]
async fn pwsh_result(root: &Path, index: u32) -> String {
    use xharness_process::{ProcessRuntime, SpawnSpec, TerminationReason};
    let script = match index % 3 {
        0 => "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::Out.Write(('你好🧪' * 4096)); [Console]::Error.Write('stderr probe'); exit 0",
        1 => "[Console]::Out.Write('nonzero probe'); exit 17",
        _ => "Start-Sleep -Seconds 30",
    };
    let spec = SpawnSpec::new("pwsh.exe", root)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .timeout(if index % 3 == 2 {
            Duration::from_millis(200)
        } else {
            Duration::from_secs(15)
        })
        .output_limits(8192, 8192);
    let mut spec = spec;
    spec.env = std::env::vars_os().collect();
    let output = ProcessRuntime::new()
        .spawn(spec.scrub_secrets())
        .unwrap()
        .wait()
        .await
        .unwrap();
    match index % 3 {
        0 => {
            assert!(output.status.success);
            assert!(output.stdout.truncated);
        }
        1 => assert_eq!(output.status.code, Some(17)),
        _ => assert_eq!(output.termination, TerminationReason::TimedOut),
    }
    json!({"kind":"foreground", "pid":output.pid, "success":output.status.success,
        "exit_code":output.status.code, "stdout":output.stdout.text, "stderr":output.stderr.text,
        "stdout_truncated":output.stdout.truncated, "stderr_truncated":output.stderr.truncated})
    .to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "bounded dynamic replay; explicit CI/local incident investigation only"]
async fn offline_dynamic_projection_stress() {
    tokio::time::timeout(Duration::from_secs(150), experiment())
        .await
        .expect("dynamic experiment time limit");
}

async fn experiment() {
    let start = std::time::Instant::now();
    let root = std::env::temp_dir().join(format!(
        "xharness-dynamic-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    // Dedicated directory is retained on failure for inspection; contains no user data.
    let store: Arc<dyn Store> = Arc::new(
        JsonlSessionStore::new(root.join("sessions"))
            .unwrap()
            .for_runtime(),
    );
    let mut header = SessionHeader::new(ID);
    header.cwd = Some(root.to_string_lossy().into_owned());
    store.create(header).await.unwrap();
    // Match production's archived request representation. Directly appending
    // legacy audit bodies would intentionally produce a different cold runtime
    // view and would invalidate the hot/cold equality assertion below.
    let request_header = store
        .archive_request(RequestHeader::new("offline", "offline"))
        .await
        .unwrap();
    let mut revision = store
        .append(
            ID,
            Revision::ZERO,
            (1..=WARM_TURNS)
                .flat_map(|turn| closed_turn(turn, &request_header))
                .collect(),
        )
        .await
        .unwrap()
        .revision;
    let host = BasicHost::with_agent_runtime(
        host_config(&root),
        Arc::new(SnapshotOnlyRuntime(store.clone())),
    );
    let report = host.restore_from_store(store.clone()).await.unwrap();
    assert_eq!(report.restored_sessions, 1);
    assert!(report.issues.is_empty());
    let initial_seq = store.load(ID).await.unwrap().unwrap().next_seq();
    let mut mux = host.mux_tx.subscribe();
    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
    let frames = tokio::spawn(async move {
        let mut expected = initial_seq;
        loop {
            tokio::select! {
                biased;
                frame = mux.recv() => {
                    let frame = frame.expect("projection publication must not lag");
                    let encoded = serde_json::to_vec(&frame).unwrap();
                    let decoded: xharness_api::ServerRequest = serde_json::from_slice(&encoded).unwrap();
                    assert!(decoded == frame, "published frame round trip");
                    if frame.method == "session/event" {
                        assert_eq!(frame.payload["event"]["seq"].as_u64(), Some(expected), "duplicated, reordered or missing publication");
                        expected += 1;
                    }
                }
                _ = &mut stop_rx => break,
            }
        }
        expected
    });
    let done = Arc::new(AtomicBool::new(false));
    let barrier = Arc::new(tokio::sync::Barrier::new(4));
    let readers = (0..3)
        .map(|_| {
            let (store, host, done, barrier) =
                (store.clone(), host.clone(), done.clone(), barrier.clone());
            tokio::spawn(async move {
                barrier.wait().await;
                let route = ModelRoute::new("offline", "offline");
                let mut rounds = 0;
                let mut prior = 0;
                let mut changes = 0;
                while !done.load(Ordering::Acquire) || rounds < 64 {
                    let old = store.load(ID).await.unwrap().unwrap();
                    let seq = old.next_seq();
                    assert!(seq >= prior, "journal snapshot moved backwards");
                    changes += usize::from(seq > prior);
                    prior = seq;
                    let last = old.events().last().cloned();
                    // Hold an old Arc cut across writes to exercise copy-on-write ownership.
                    tokio::time::sleep(Duration::from_millis(2)).await;
                    assert_eq!(old.next_seq(), seq);
                    assert!(
                        old.events().last() == last.as_ref(),
                        "old snapshot changed after append"
                    );
                    let history = project_session_history(&old, &route, None, 20);
                    std::hint::black_box(serde_json::to_vec(&history.events).unwrap());
                    assert!(host.sync_authoritative_session(ID).await.unwrap());
                    let state = host.state.read().await;
                    let record = &state.sessions[ID];
                    assert!(record.authoritative_seq.unwrap() >= seq);
                    assert_eq!(
                        record.event_base_seq + record.events.len() as u64,
                        record.next_event_seq()
                    );
                    rounds += 1;
                }
                assert!(changes > 2, "reader never overlapped dynamic writes");
                rounds
            })
        })
        .collect::<Vec<_>>();
    barrier.wait().await;
    let native_enabled =
        cfg!(windows) && std::env::var("XHARNESS_DYNAMIC_PWSH").as_deref() == Ok("1");
    let mut native_runs = 0;
    let mut recovery_results = 0;
    for index in 0..LIVE_TURNS {
        let turn = WARM_TURNS + index + 1;
        append(
            store.as_ref(),
            &mut revision,
            vec![
                EventData::TurnStart { turn }.into(),
                EventData::UserMessage {
                    message: Message::user("synthetic dynamic turn"),
                    surface_replace: None,
                }
                .into(),
                EventData::StepStart { turn, step: 1 }.into(),
                EventData::RequestHeader {
                    header: request_header.clone(),
                }
                .into(),
            ],
            &host,
        )
        .await;
        for step in 1..=2 {
            for chunk in 0..8 {
                append(
                    store.as_ref(),
                    &mut revision,
                    vec![EventData::AssistantChunk {
                        turn,
                        step,
                        chunk: AssistantChunk::ReasoningDelta(format!(
                            "dynamic {index}/{step}/{chunk}: {}",
                            "推理 🧪 ".repeat(32)
                        )),
                    }
                    .into()],
                    &host,
                )
                .await;
            }
            if step == 1 {
                let call = ToolCall {
                    id: format!("dynamic-tool-{turn}"),
                    name: "pwsh".into(),
                    arguments_json: r#"{"command":"synthetic observation; never replay"}"#.into(),
                    ..Default::default()
                };
                let mut message = Message::assistant("");
                message.tool_calls.push(call.clone());
                append(
                    store.as_ref(),
                    &mut revision,
                    vec![
                        EventData::AssistantMessage {
                            turn,
                            step,
                            message,
                            usage: None,
                        }
                        .into(),
                        EventData::ToolCall {
                            turn,
                            step,
                            call: call.clone(),
                        }
                        .into(),
                    ],
                    &host,
                )
                .await;
                if index % 8 == 7 {
                    let cut = store.load(ID).await.unwrap().unwrap();
                    let repair = cut.outcome_unknown_recovery();
                    assert_eq!(repair.len(), 1);
                    append(store.as_ref(), &mut revision, repair, &host).await;
                    recovery_results += 1;
                } else {
                    let mut content = json!({"kind":"foreground", "stdout":"synthetic tool result", "stderr":"", "exit_code":0}).to_string();
                    if native_enabled && index % 4 == 0 {
                        content = pwsh_result(&root, native_runs).await;
                        native_runs += 1;
                    }
                    // A large result crosses the small browser-tail byte budget.
                    if index % 8 == 1 {
                        content = "large synthetic result 🧪".repeat(16384);
                    }
                    append(
                        store.as_ref(),
                        &mut revision,
                        vec![EventData::ToolResult {
                            turn,
                            step,
                            result: ToolResultData {
                                call_id: call.id,
                                outcome: ToolOutcome::Success,
                                content,
                                metadata: None,
                            },
                        }
                        .into()],
                        &host,
                    )
                    .await;
                }
                append(
                    store.as_ref(),
                    &mut revision,
                    vec![
                        EventData::StepEnd { turn, step }.into(),
                        EventData::StepStart { turn, step: 2 }.into(),
                        EventData::RequestHeader {
                            header: request_header.clone(),
                        }
                        .into(),
                    ],
                    &host,
                )
                .await;
            } else {
                append(
                    store.as_ref(),
                    &mut revision,
                    vec![
                        EventData::AssistantMessage {
                            turn,
                            step,
                            message: Message::assistant("completed synthetic answer"),
                            usage: None,
                        }
                        .into(),
                        EventData::StepEnd { turn, step }.into(),
                        EventData::TurnEnd {
                            turn,
                            reason: TurnEndReason::Completed,
                        }
                        .into(),
                    ],
                    &host,
                )
                .await;
            }
        }
    }
    done.store(true, Ordering::Release);
    let mut reads = 0;
    for reader in readers {
        reads += reader.await.unwrap();
    }
    host.sync_authoritative_session(ID).await.unwrap();
    stop_tx.send(()).unwrap();
    let published_end = frames.await.unwrap();
    let final_cut = store.load(ID).await.unwrap().unwrap();
    assert_eq!(published_end, final_cut.next_seq());
    assert!(final_cut.outcome_unknown_recovery().is_empty());
    let reopened: Arc<dyn Store> = Arc::new(
        JsonlSessionStore::new(root.join("sessions"))
            .unwrap()
            .for_runtime(),
    );
    let cold = reopened.load(ID).await.unwrap().unwrap();
    assert!(
        cold == final_cut,
        "cold replay differs from hot runtime snapshot"
    );
    let restored = BasicHost::with_agent_runtime(
        host_config(&root),
        Arc::new(SnapshotOnlyRuntime(reopened.clone())),
    );
    assert!(restored
        .restore_from_store(reopened)
        .await
        .unwrap()
        .issues
        .is_empty());
    {
        let live = host.state.read().await;
        let cold = restored.state.read().await;
        assert!(
            live.sessions[ID].events == cold.sessions[ID].events,
            "live/restart tail mismatch"
        );
        assert_eq!(
            live.sessions[ID].authoritative_seq,
            cold.sessions[ID].authoritative_seq
        );
    }
    if native_enabled {
        assert_eq!(native_runs, 16);
    }
    eprintln!("dynamic projection passed: warm_turns={WARM_TURNS}, live_turns={LIVE_TURNS}, appended_events={}, history_reads={reads}, recovered_unknown={recovery_results}, native_pwsh={native_runs}, elapsed_ms={}",
        final_cut.next_seq() - initial_seq, start.elapsed().as_millis());
}

#[cfg(not(windows))]
async fn pwsh_result(_: &Path, _: u32) -> String {
    panic!("native PowerShell experiment requires Windows")
}

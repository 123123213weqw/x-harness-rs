//! Real Host publication/history pipeline, with controlled durable tool events.
//! File payloads are synthetic; render intents are never supplied by the test.
#![forbid(unsafe_code)]

use super::*;
use xharness_session::{ToolCall, ToolOutcome, ToolResultData};

// Match SnapshotRuntime's provider-free default route so live/restored model
// attribution is identical; this fixture does not mutate model settings.
fn events() -> Vec<SessionEvent> {
    let mut events = vec![
        EventData::TurnStart { turn: 1 }.into(),
        EventData::UserMessage {
            message: Message::user("Controlled file-card projection fixture; no model runs."),
            surface_replace: None,
        }
        .into(),
    ];
    let specifications = [
        ("write", "reports/报告.md", ToolOutcome::Success, Some(true)),
        ("edit", "reports/报告.md", ToolOutcome::Success, None),
        ("write", "updated.txt", ToolOutcome::Success, Some(false)),
        ("edit", "edited.txt", ToolOutcome::Success, None),
        ("write", "failed.txt", ToolOutcome::Error, Some(true)),
        (
            "write",
            "uncertain.txt",
            ToolOutcome::OutcomeUnknown,
            Some(true),
        ),
        ("read", "read-only.txt", ToolOutcome::Success, None),
        (
            "bash",
            "not-an-artifact.pdf",
            ToolOutcome::Success,
            Some(true),
        ),
    ];
    for (index, (name, path, outcome, created)) in specifications.into_iter().enumerate() {
        let step = u32::try_from(index).unwrap() + 1;
        let call = ToolCall {
            id: format!("file-call-{step}"),
            provider_call_id: Some(format!("provider-{step}")),
            index: 0,
            name: name.into(),
            arguments_json: json!({"path":path,"content":"new","old":"old","new":"new", "command":"echo not-an-artifact.pdf"}).to_string(),
        };
        let mut message = Message::assistant("");
        message.tool_calls.push(call.clone());
        let mut metadata = json!({"path":format!("/controlled-workspace/{path}"),"bytes_written":3,"sha256":"a".repeat(64)});
        if let Some(created) = created {
            metadata["created"] = json!(created);
        }
        // Same envelope and structured metadata as the native JSON Tool output.
        let mut result = ToolResultData::success(
            &call.id,
            json!({"content":metadata.to_string(),"metadata":metadata}).to_string(),
        );
        result.metadata = Some(metadata);
        result.outcome = outcome;
        events.extend([
            EventData::StepStart { turn: 1, step }.into(),
            EventData::RequestHeader {
                header: RequestHeader::new("openai-compatible", "unconfigured"),
            }
            .into(),
            EventData::AssistantMessage {
                turn: 1,
                step,
                message,
                usage: None,
            }
            .into(),
            EventData::ToolCall {
                turn: 1,
                step,
                call,
            }
            .into(),
            EventData::ToolResult {
                turn: 1,
                step,
                result,
            }
            .into(),
            EventData::StepEnd { turn: 1, step }.into(),
        ]);
    }
    let mut closing = Message::assistant("Done. No filenames in this closing prose.");
    closing.id = Some("file-fixture-closing".into());
    events.extend([
        EventData::StepStart { turn: 1, step: 9 }.into(),
        EventData::RequestHeader {
            header: RequestHeader::new("openai-compatible", "unconfigured"),
        }
        .into(),
        EventData::AssistantMessage {
            turn: 1,
            step: 9,
            message: closing,
            usage: None,
        }
        .into(),
        EventData::StepEnd { turn: 1, step: 9 }.into(),
        EventData::TurnEnd {
            turn: 1,
            reason: TurnEndReason::Completed,
        }
        .into(),
        EventData::TurnStart { turn: 2 }.into(),
        EventData::UserMessage {
            message: Message::user("A second turn produces no files."),
            surface_replace: None,
        }
        .into(),
        EventData::StepStart { turn: 2, step: 1 }.into(),
        EventData::RequestHeader {
            header: RequestHeader::new("openai-compatible", "unconfigured"),
        }
        .into(),
        EventData::AssistantMessage {
            turn: 2,
            step: 1,
            message: Message::assistant("Nothing written."),
            usage: None,
        }
        .into(),
        EventData::StepEnd { turn: 2, step: 1 }.into(),
        EventData::TurnEnd {
            turn: 2,
            reason: TurnEndReason::Completed,
        }
        .into(),
    ]);
    events
}

fn mutation_locations(entries: &[Value]) -> Vec<String> {
    entries
        .iter()
        .filter(|entry| entry["event"]["type"] == "tool/call")
        .filter_map(|entry| {
            entry
                .pointer("/view/view/locations/0/path")
                .and_then(Value::as_str)
        })
        .map(ToOwned::to_owned)
        .collect()
}

// Live headers can carry an in-memory audit reference while a JSONL history
// page carries its lazy durable audit reference. This test owns file views,
// not audit-reference identity; preserve raw exports and compare everything else.
fn comparable(entries: &[Value]) -> Vec<Value> {
    entries
        .iter()
        .cloned()
        .map(|mut row| {
            if row["event"]["type"] == "request/header" {
                row["event"]["data"]["header"]["options"]["auditSnapshot"] = Value::Null;
            }
            row
        })
        .collect()
}

#[tokio::test]
async fn native_file_artifact_wire_survives_live_history_and_jsonl_restart() {
    let root = std::env::temp_dir().join(format!(
        "xh-file-card-wire-{}-{}",
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
    let host = BasicHost::with_agent_runtime(
        HostConfig::new(&root),
        Arc::new(SnapshotRuntime(store.clone())),
    );
    host.restore_from_store(store.clone()).await.unwrap();
    let mut receiver = host.event_gateway.subscribe_mux();
    store.append(ID, Revision::ZERO, events()).await.unwrap();
    store.flush(ID).await.unwrap();
    host.sync_authoritative_session(ID).await.unwrap();
    let mut live = Vec::new();
    while let Ok(frame) = receiver.try_recv() {
        if frame.payload["type"] == "session/event" {
            let mut entry = json!({"event":frame.payload["event"]});
            if let Some(view) = frame.payload.get("view") {
                entry["view"] = view.clone();
            }
            live.push(entry);
        }
    }
    let history = rpc_value(
        &host,
        RpcMethod::SessionHistory,
        json!({"sessionId":ID,"maxMessages":100}),
    )
    .await;
    assert_eq!(live, history["events"].as_array().unwrap().clone());
    // This assertion fails on the pre-fix native projector, despite successful
    // writes in the journal. No test-created view can hide that regression.
    assert_eq!(
        mutation_locations(&live),
        [
            "reports/报告.md",
            "reports/报告.md",
            "updated.txt",
            "edited.txt",
            "failed.txt",
            "uncertain.txt"
        ]
    );
    let first_result = live
        .iter()
        .find(|entry| entry["event"]["type"] == "tool/result")
        .unwrap()["event"]["seq"]
        .as_u64()
        .unwrap();
    let page = rpc_value(
        &host,
        RpcMethod::SessionHistory,
        json!({"sessionId":ID,"maxMessages":1,"beforeSeq":first_result+1}),
    )
    .await;
    assert!(page["hasMore"].as_bool().unwrap());
    let prefix = rpc_value(
        &host,
        RpcMethod::SessionHistory,
        json!({"sessionId":ID,"maxMessages":100,"beforeSeq":first_result+1}),
    )
    .await;
    drop(receiver);
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
        .restore_from_store(reopened.clone())
        .await
        .unwrap()
        .issues
        .is_empty());
    let after = rpc_value(
        &restored,
        RpcMethod::SessionHistory,
        json!({"sessionId":ID,"maxMessages":100}),
    )
    .await;
    let before = comparable(history["events"].as_array().unwrap());
    let reloaded = comparable(after["events"].as_array().unwrap());
    assert_eq!(before.len(), reloaded.len());
    for (before, reloaded) in before.iter().zip(&reloaded) {
        assert_eq!(
            before, reloaded,
            "reopened event seq {}",
            before["event"]["seq"]
        );
    }
    assert_eq!(history["hasMore"], after["hasMore"]);
    if let Some(path) = std::env::var_os("XHARNESS_PRODUCED_FILES_WIRE") {
        let path = std::path::PathBuf::from(path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, serde_json::to_vec_pretty(&json!({
            "schema":1,"source":"real BasicHost mux, session.history and reopened JSONL; controlled tool payloads",
            "live":live,"history":history["events"],"restart":after["events"],
            "partial":page["events"],"prefix":prefix["events"],
            "expectedPaths":["reports/报告.md","updated.txt","edited.txt"]
        })).unwrap()).unwrap();
    }
    drop(restored);
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}

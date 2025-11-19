use std::{
    net::{SocketAddr, TcpListener as StdTcpListener},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use futures::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use tokio::{process::Command, time};
use tokio_tungstenite::connect_async;
use xharness_session::{
    EventData, Message, RequestHeader, Revision, SessionHeader, Store, TurnEndReason,
};
use xharness_session_jsonl::JsonlSessionStore;

struct TempWorkspace(PathBuf);

impl TempWorkspace {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xharness-host-restart-{}-{}",
            std::process::id(),
            unique_port()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(std::fs::canonicalize(path).unwrap())
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct HostProcess(tokio::process::Child);

impl HostProcess {
    async fn stop(mut self) {
        let _ = self.0.start_kill();
        let _ = time::timeout(Duration::from_secs(5), self.0.wait()).await;
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        let _ = self.0.start_kill();
    }
}

fn unique_port() -> u16 {
    StdTcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn spawn_host(address: SocketAddr, workspace: &Path) -> HostProcess {
    spawn_host_with_extra(address, workspace, &[])
}

fn spawn_host_with_extra(
    address: SocketAddr,
    workspace: &Path,
    extra_args: &[String],
) -> HostProcess {
    let mut command = Command::new(env!("CARGO_BIN_EXE_xharness-host"));
    command
        .args([
            "--bind",
            &address.to_string(),
            "--workspace",
            &workspace.to_string_lossy(),
            "--model",
            "unconfigured",
            "--state-dir",
            &workspace.join(".xharness-state").to_string_lossy(),
        ])
        .args(extra_args)
        .env_remove("XHARNESS_DEBUG_TRACE")
        .env_remove("XHARNESS_DEBUG_DIR")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let child = command.spawn().expect("host process starts");
    HostProcess(child)
}

async fn workspace_list(client: &Client, address: SocketAddr) -> Option<Value> {
    rpc_call(client, address, "workspace.list", json!({})).await
}

async fn rpc_call(
    client: &Client,
    address: SocketAddr,
    method: &str,
    payload: Value,
) -> Option<Value> {
    let response = client
        .post(format!("http://{address}/api/{method}"))
        .json(&json!({
            "type": "client-request",
            "rpcId": format!("restart-test-{method}"),
            "method": method,
            "payload": payload,
        }))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<Value>().await.ok()
}

async fn wait_for_workspace(client: &Client, address: SocketAddr, expected: &Path) -> Value {
    let deadline = time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(value) = workspace_list(client, address).await {
            let items = value["result"]["value"]["items"].as_array();
            if items.is_some_and(|items| {
                items.iter().any(|item| {
                    item["workspaceId"] == "workspace-default"
                        && item["path"] == expected.to_string_lossy().as_ref()
                })
            }) {
                return value;
            }
        }
        assert!(time::Instant::now() < deadline, "host did not become ready");
        time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn real_restart_restores_the_boot_workspace_and_websocket_carrier() {
    let workspace = TempWorkspace::new();
    let custom_workspace = workspace.0.join("custom-workspace");
    std::fs::create_dir(&custom_workspace).unwrap();
    let store = JsonlSessionStore::new(workspace.0.join(".xharness-state/sessions")).unwrap();
    let mut header = SessionHeader::new("persisted-session");
    header.cwd = Some(workspace.0.to_string_lossy().into_owned());
    store.create(header).await.unwrap();
    store
        .append(
            "persisted-session",
            Revision::ZERO,
            vec![
                EventData::TurnStart { turn: 1 }.into(),
                EventData::UserMessage {
                    message: Message::user("survive restart").with_id("persisted-prompt"),
                }
                .into(),
                EventData::StepStart { turn: 1, step: 1 }.into(),
                EventData::RequestHeader {
                    header: RequestHeader::new("openai-compatible", "unconfigured"),
                }
                .into(),
                EventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message: Message::assistant("still here"),
                    usage: None,
                }
                .into(),
                EventData::StepEnd { turn: 1, step: 1 }.into(),
                EventData::TurnEnd {
                    turn: 1,
                    reason: TurnEndReason::Completed,
                }
                .into(),
            ],
        )
        .await
        .unwrap();
    store.flush("persisted-session").await.unwrap();

    let address = SocketAddr::from(([127, 0, 0, 1], unique_port()));
    let client = Client::new();

    let first = spawn_host(address, &workspace.0);
    let first_list = wait_for_workspace(&client, address, &workspace.0).await;
    assert_eq!(
        first_list["result"]["value"]["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let first_sessions = rpc_call(&client, address, "session.list", json!({}))
        .await
        .expect("first Host lists restored sessions");
    assert_eq!(
        first_sessions["result"]["value"]["items"][0]["sessionId"],
        "persisted-session"
    );
    let first_history = rpc_call(
        &client,
        address,
        "session.history",
        json!({"sessionId": "persisted-session"}),
    )
    .await
    .expect("first Host projects restored history");
    assert!(first_history["result"]["value"]["events"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["event"]["type"] == "assistant/message"));
    let created_workspace = rpc_call(
        &client,
        address,
        "workspace.create",
        json!({"path": custom_workspace.to_string_lossy()}),
    )
    .await
    .expect("first Host persists a custom workspace");
    let custom_workspace_id = created_workspace["result"]["value"]["workspace"]["workspaceId"]
        .as_str()
        .unwrap()
        .to_owned();
    let renamed = rpc_call(
        &client,
        address,
        "workspace.rename",
        json!({"workspaceId": custom_workspace_id, "title": "Restart durable"}),
    )
    .await
    .expect("first Host persists workspace metadata");
    assert_eq!(
        renamed["result"]["value"]["workspace"]["title"],
        "Restart durable"
    );
    let settings = rpc_call(
        &client,
        address,
        "settings.replace",
        json!({
            "ns": "ui-onboarding",
            "section": {"welcomeNoticeVersion": "restart-v1"},
            "expectedRevision": 0,
        }),
    )
    .await
    .expect("first Host persists settings");
    assert_eq!(settings["result"]["value"]["revision"], 1);
    let (mut first_socket, _) = connect_async(format!("ws://{address}/api/events.host"))
        .await
        .expect("first websocket connects");

    first.stop().await;
    time::timeout(Duration::from_secs(5), async {
        while let Some(frame) = first_socket.next().await {
            if frame.is_err() {
                break;
            }
        }
    })
    .await
    .expect("old websocket observes host shutdown");

    let second = spawn_host(address, &workspace.0);
    let second_list = wait_for_workspace(&client, address, &workspace.0).await;
    let second_workspaces = second_list["result"]["value"]["items"].as_array().unwrap();
    assert_eq!(second_workspaces.len(), 2);
    assert!(second_workspaces.iter().any(|item| {
        item["workspaceId"] == custom_workspace_id && item["title"] == "Restart durable"
    }));
    let second_sessions = rpc_call(&client, address, "session.list", json!({}))
        .await
        .expect("second Host lists restored sessions");
    assert_eq!(
        second_sessions["result"]["value"]["items"][0]["sessionId"],
        "persisted-session"
    );
    let second_settings = rpc_call(&client, address, "settings.describe", json!({}))
        .await
        .expect("second Host restores settings");
    assert!(second_settings["result"]["value"]["namespaces"]
        .as_array()
        .unwrap()
        .iter()
        .any(|namespace| {
            namespace["ns"] == "ui-onboarding"
                && namespace["value"]["welcomeNoticeVersion"] == "restart-v1"
                && namespace["revision"] == 1
        }));
    let replayed_create = rpc_call(
        &client,
        address,
        "workspace.create",
        json!({"path": custom_workspace.to_string_lossy()}),
    )
    .await
    .expect("second Host replays the original mutation receipt");
    assert_eq!(replayed_create, created_workspace);
    let (_second_socket, _) = connect_async(format!("ws://{address}/api/events.host"))
        .await
        .expect("new websocket connects after restart");

    second.stop().await;
}

#[tokio::test]
async fn full_debug_cli_writes_private_host_lifecycle_trace() {
    let workspace = TempWorkspace::new();
    let debug_dir = workspace.0.join("debug-traces");
    let address = SocketAddr::from(([127, 0, 0, 1], unique_port()));
    let client = Client::new();
    let extra_args = vec![
        "--debug-trace".to_owned(),
        "full".to_owned(),
        "--debug-dir".to_owned(),
        debug_dir.to_string_lossy().into_owned(),
        "--api-key".to_owned(),
        "literal-debug-secret".to_owned(),
    ];
    let host = spawn_host_with_extra(address, &workspace.0, &extra_args);
    wait_for_workspace(&client, address, &workspace.0).await;
    host.stop().await;

    let trace_dirs: Vec<PathBuf> = std::fs::read_dir(&debug_dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.is_dir())
        .collect();
    assert_eq!(trace_dirs.len(), 1);
    let events = std::fs::read_to_string(trace_dirs[0].join("events.jsonl")).unwrap();
    let events: Vec<Value> = events
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(events.len() >= 5);
    assert_eq!(events[0]["event"], "start");
    assert_eq!(events[1]["event"], "restore");
    assert_eq!(events[2]["event"], "listening");
    assert!(events
        .iter()
        .any(|event| { event["layer"] == "server" && event["event"] == "rpc.request" }));
    assert!(events
        .iter()
        .any(|event| { event["layer"] == "server" && event["event"] == "rpc.response" }));
    assert!(!events
        .iter()
        .any(|event| event.to_string().contains("literal-debug-secret")));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&trace_dirs[0])
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(trace_dirs[0].join("events.jsonl"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

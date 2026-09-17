//! The shipped Web client mutates Goals through the upstream namespaced
//! remotes (`/api/goals/*`) instead of the flat `goal.*` methods. A real Host
//! process therefore has to answer those six routes, and every other upstream
//! namespace has to stay unmounted. Regression for the GoalBar buttons that
//! answered `HTTP 404 not found` and surfaced in the bar as
//! `client api: goals/clear failed: transport failure for /api/goals/clear`.
use std::{
    net::{SocketAddr, TcpListener as StdTcpListener},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use tokio::{
    net::{TcpListener, TcpStream},
    process::Command,
    sync::Mutex,
    time,
};

struct TempWorkspace(PathBuf);

impl TempWorkspace {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xharness-goal-remotes-{}-{}",
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

fn unique_port() -> u16 {
    StdTcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn spawn_host(
    address: SocketAddr,
    workspace: &Path,
    model_endpoint: SocketAddr,
) -> tokio::process::Child {
    let mut command = Command::new(env!("CARGO_BIN_EXE_xharness-host"));
    command
        .args([
            "--bind",
            &address.to_string(),
            "--workspace",
            &workspace.to_string_lossy(),
            "--model",
            "goal-remotes-unreachable",
            // A route that exists but never answers: arming a goal is allowed,
            // and the round it starts stays in flight instead of failing, so the
            // CAS revision below stops moving once the round has begun.
            "--base-url",
            &format!("http://{model_endpoint}/v1"),
            "--api-key",
            "goal-remotes-unused",
            "--context-window",
            "32768",
            "--state-dir",
            &workspace.join(".xharness-state").to_string_lossy(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    command.spawn().expect("host process starts")
}

/// Every client call mints its own rpcId; reusing one would replay the durable
/// mutation receipt and fail with SessionConflict on purpose. Returns `None`
/// while the freshly spawned process has not bound its port yet.
async fn try_rpc(
    client: &Client,
    address: SocketAddr,
    endpoint: &str,
    payload: Value,
) -> Option<(StatusCode, Value)> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let rpc_id = format!("goal-remotes-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let response = client
        .post(format!("http://{address}/api/{endpoint}"))
        .json(&json!({
            "type": "client-request",
            "rpcId": rpc_id,
            "method": endpoint,
            "payload": payload,
        }))
        .send()
        .await
        .ok()?;
    let status = response.status();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    Some((status, body))
}

/// [`try_rpc`] for requests that must reach a host that is already listening.
async fn rpc(
    client: &Client,
    address: SocketAddr,
    endpoint: &str,
    payload: Value,
) -> (StatusCode, Value) {
    try_rpc(client, address, endpoint, payload)
        .await
        .expect("host answers")
}

/// Namespaced remotes wrap their arguments in `args` and read `args.agentId`.
async fn goal_rpc(
    client: &Client,
    address: SocketAddr,
    verb: &str,
    args: Value,
) -> (StatusCode, Value) {
    rpc(
        client,
        address,
        &format!("goals/{verb}"),
        json!({"args": args}),
    )
    .await
}

async fn wait_for_workspace(client: &Client, address: SocketAddr, expected: &Path) {
    let deadline = time::Instant::now() + Duration::from_secs(20);
    loop {
        if let Some((status, value)) = try_rpc(client, address, "workspace.list", json!({})).await {
            if status.is_success() {
                let found = value["result"]["value"]["items"]
                    .as_array()
                    .is_some_and(|items| {
                        items.iter().any(|item| {
                            item["workspaceId"] == "workspace-default"
                                && item["path"] == expected.to_string_lossy().as_ref()
                        })
                    });
                if found {
                    return;
                }
            }
        }
        assert!(time::Instant::now() < deadline, "host did not become ready");
        time::sleep(Duration::from_millis(50)).await;
    }
}

/// Accepts connections and never answers, so the round a goal starts stays in
/// flight for the whole test without any provider being called.
async fn hanging_model_server() -> (SocketAddr, Arc<Mutex<Vec<TcpStream>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let held: Arc<Mutex<Vec<TcpStream>>> = Arc::new(Mutex::new(Vec::new()));
    let accepted = held.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            accepted.lock().await.push(stream);
        }
    });
    (address, held)
}

/// The upstream `goals/*` schema validates the whole goal object for
/// edit/pause/resume/complete; a bare `{ref}` is rejected by the client.
fn assert_goal_object(goal: &Value) {
    let keys: Vec<&str> = goal
        .as_object()
        .unwrap_or_else(|| panic!("goal object expected: {goal}"))
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "activation",
            "createdAt",
            "id",
            "maxGoalRounds",
            "objective",
            "phase",
            "ref",
            "revision",
            "roundsStarted",
            "updatedAt",
        ],
        "{goal}"
    );
}

#[tokio::test]
async fn shipped_goal_bar_verbs_answer_over_http_and_other_namespaces_stay_unmounted() {
    let workspace = TempWorkspace::new();
    let client = Client::new();
    let address: SocketAddr = format!("127.0.0.1:{}", unique_port()).parse().unwrap();
    let (model_endpoint, _hanging_round) = hanging_model_server().await;
    let _host = spawn_host(address, &workspace.0, model_endpoint);
    wait_for_workspace(&client, address, &workspace.0).await;

    let (status, created_session) = rpc(
        &client,
        address,
        "session.create",
        json!({"workspaceId": "workspace-default"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let session_id = created_session["result"]["value"]["sessionId"]
        .as_str()
        .expect("session id")
        .to_owned();

    // Control: an endpoint that was already mounted keeps answering, so a 404
    // below really is about the namespace boundary instead of a dead harness.
    let (status, listed) = rpc(
        &client,
        address,
        "commands/list",
        json!({"args": {"agentId": session_id}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["type"], "server-response");
    assert_eq!(listed["result"]["ok"], true, "{listed}");

    // Automatic execution starts disabled so every verb below is the only thing
    // that runs and each revision bump stays deterministic.
    let (status, created) = goal_rpc(
        &client,
        address,
        "create",
        json!({
            "agentId": session_id,
            "request": {
                "objective": "GoalBar 路由复验",
                "maxGoalRounds": 3,
                "executionEnabled": false,
            },
        }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "goals/create must not 404: {created}"
    );
    assert_eq!(created["result"]["ok"], true, "{created}");
    // Creation keeps the flat `{ref}` result its schema expects.
    let created_ref = created["result"]["value"]["ref"].clone();
    assert!(created_ref["id"].as_str().is_some_and(|id| !id.is_empty()));
    assert_eq!(created_ref["revision"], 1);

    // Pause answers with the whole goal object the upstream schema validates.
    let (status, paused) = goal_rpc(
        &client,
        address,
        "pause",
        json!({"agentId": session_id, "ref": created_ref}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "goals/pause must not 404: {paused}");
    assert_eq!(paused["result"]["ok"], true, "{paused}");
    let paused = paused["result"]["value"].clone();
    assert_goal_object(&paused);
    assert_eq!(paused["ref"]["id"], created_ref["id"]);
    assert_eq!(paused["ref"]["revision"], 2);
    assert_eq!(paused["objective"], "GoalBar 路由复验");
    assert_eq!(paused["phase"], "paused");
    assert_eq!(paused["activation"], "disarmed");

    let (status, edited) = goal_rpc(
        &client,
        address,
        "edit",
        json!({
            "agentId": session_id,
            "ref": paused["ref"],
            "request": {"objective": "Edited over http", "maxGoalRounds": 5},
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "goals/edit must not 404: {edited}");
    assert_eq!(edited["result"]["ok"], true, "{edited}");
    let edited = edited["result"]["value"].clone();
    assert_goal_object(&edited);
    assert_eq!(edited["ref"]["id"], created_ref["id"]);
    assert_eq!(edited["ref"]["revision"], 3);
    assert_eq!(edited["objective"], "Edited over http");
    assert_eq!(edited["maxGoalRounds"], 5);
    assert_eq!(edited["activation"], "disarmed");

    let (status, completed) = goal_rpc(
        &client,
        address,
        "complete",
        json!({"agentId": session_id, "ref": edited["ref"]}),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "goals/complete must not 404: {completed}"
    );
    assert_eq!(completed["result"]["ok"], true, "{completed}");
    let completed = completed["result"]["value"].clone();
    assert_goal_object(&completed);
    assert_eq!(completed["ref"]["id"], created_ref["id"]);
    assert_eq!(completed["phase"], "complete");
    assert_eq!(completed["activation"], "disarmed");

    let (status, cleared) = goal_rpc(
        &client,
        address,
        "clear",
        json!({"agentId": session_id, "ref": completed["ref"]}),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "goals/clear must not 404: {cleared}"
    );
    assert_eq!(cleared["result"]["value"], json!({"cleared": true}));

    // Resume arms automatic continuation, so it goes last on a fresh goal: the
    // round it starts hangs against the never-answering route, which keeps the
    // provider out of the test and leaves nothing that could race the assertions.
    let (status, second) = goal_rpc(
        &client,
        address,
        "create",
        json!({
            "agentId": session_id,
            "request": {
                "objective": "Resume over http",
                "maxGoalRounds": 1,
                "executionEnabled": false,
            },
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "second goals/create: {second}");
    let second_ref = second["result"]["value"]["ref"].clone();
    let (status, resumed) = goal_rpc(
        &client,
        address,
        "resume",
        json!({"agentId": session_id, "ref": second_ref}),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "goals/resume must not 404: {resumed}"
    );
    assert_eq!(resumed["result"]["ok"], true, "{resumed}");
    let resumed = resumed["result"]["value"].clone();
    assert_goal_object(&resumed);
    assert_eq!(resumed["ref"]["id"], second_ref["id"]);
    assert_eq!(resumed["activation"], "armed");

    // Only those six verbs are mounted: unknown goals endpoints and the other
    // upstream namespaces keep answering 404 so the boundary stays visible.
    for endpoint in [
        "goals",
        "goals/unknown",
        "fileReferences/list",
        "pluginInventory/list",
        "dynamicCordisRunner/status",
    ] {
        let (status, _) = rpc(&client, address, endpoint, json!({})).await;
        assert_eq!(
            status,
            StatusCode::NOT_FOUND,
            "{endpoint} must stay unmounted"
        );
    }
}

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
    let child = Command::new(env!("CARGO_BIN_EXE_xharness-host"))
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
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("host process starts");
    HostProcess(child)
}

async fn workspace_list(client: &Client, address: SocketAddr) -> Option<Value> {
    let response = client
        .post(format!("http://{address}/api/workspace.list"))
        .json(&json!({
            "type": "client-request",
            "rpcId": "restart-test",
            "method": "workspace.list",
            "payload": {},
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
    assert_eq!(
        second_list["result"]["value"]["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let (_second_socket, _) = connect_async(format!("ws://{address}/api/events.host"))
        .await
        .expect("new websocket connects after restart");

    second.stop().await;
}

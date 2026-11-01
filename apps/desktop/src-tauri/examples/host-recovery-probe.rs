//! Real, disposable Host + paused local provider. No desktop/model credentials
//! or user profiles are inherited. Run the already compiled binary with a Host
//! executable path. UI-owner death must not restart the Host or cancel its turn.
#[path = "../src/desktop_recovery.rs"]
#[allow(dead_code)]
mod desktop_recovery;

use serde_json::{json, Value};
use std::{
    fs,
    net::SocketAddr,
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};

struct OwnedHost(Child);
impl Drop for OwnedHost {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

async fn rpc(
    client: &reqwest::Client,
    address: SocketAddr,
    token: &str,
    id: &str,
    method: &str,
    payload: Value,
) -> Result<Value, Box<dyn std::error::Error>> {
    let response: Value = client
        .post(format!("http://{address}/api/{method}"))
        .header("x-xharness-desktop-token", token)
        .json(&json!({"type":"client-request","rpcId":id,"method":method,"payload":payload}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if response["result"]["ok"] != true {
        return Err(format!("fixture RPC {method} rejected").into());
    }
    Ok(response["result"]["value"].clone())
}

async fn run(host: PathBuf, temp: &tempfile::TempDir) -> Result<(), Box<dyn std::error::Error>> {
    let root = temp.path().join("runtime");
    let state = temp.path().join("state");
    let workspace = temp.path().join("工作区");
    for path in [&root, &state, &workspace] {
        fs::create_dir(path)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
    }
    let store = desktop_recovery::RecoveryStore::open(&root, &state, &workspace)?;
    let runtime_id = desktop_recovery::secret()?;
    let token = desktop_recovery::secret()?;
    let bridge_token = desktop_recovery::secret()?;
    let bridge = TcpListener::bind("127.0.0.1:0").await?;
    let bridge_address = bridge.local_addr()?;
    store.save(&runtime_id, &token, bridge_address, &bridge_token)?;
    let ready = root.join(format!("ready-{runtime_id}.address"));
    let shutdown = root.join(format!("shutdown-{runtime_id}.request"));
    let provider = TcpListener::bind("127.0.0.1:0").await?;
    let provider_address = provider.local_addr()?;
    let (started, seen) = oneshot::channel();
    let (finish, release) = oneshot::channel();
    let model = tokio::spawn(async move {
        let mut started = Some(started);
        let mut release = Some(release);
        // Auto-title/prewarm requests can precede the actual agent stream.
        // Serve those separately; the paused request must be the tool-enabled
        // agent request, not merely the first connection to the fake provider.
        loop {
            let (mut stream, _) = provider.accept().await?;
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0; 1024];
                let n = stream.read(&mut chunk).await?;
                if n == 0 {
                    return Err(std::io::Error::other("fixture request ended"));
                }
                bytes.extend_from_slice(&chunk[..n]);
                if bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                    break;
                }
                if bytes.len() > 1024 * 1024 {
                    return Err(std::io::Error::other("fixture request too large"));
                }
            }
            let header_end = bytes
                .windows(4)
                .position(|part| part == b"\r\n\r\n")
                .unwrap()
                + 4;
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let length = headers
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            if length > 1024 * 1024 {
                return Err(std::io::Error::other("fixture body exceeds budget"));
            }
            while bytes.len() < header_end + length {
                let mut chunk = [0; 4096];
                let n = stream.read(&mut chunk).await?;
                if n == 0 {
                    return Err(std::io::Error::other("fixture body interrupted"));
                }
                bytes.extend_from_slice(&chunk[..n]);
            }
            if bytes.starts_with(b"GET ") && length == 0 {
                let body=json!({"object":"list","data":[{"id":"recovery-fixture","object":"model","context_window":32768}]}).to_string();
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await?;
                continue;
            }
            if String::from_utf8_lossy(&bytes[..header_end])
                .lines()
                .next()
                .is_some_and(|line| line.contains("/input_tokens"))
            {
                let body = r#"{"input_tokens":100}"#;
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await?;
                continue;
            }
            let request: Value = serde_json::from_slice(&bytes[header_end..header_end + length])
                .map_err(std::io::Error::other)?;
            let agent_request = request["stream"] == true
                && request["tools"]
                    .as_array()
                    .is_some_and(|tools| !tools.is_empty());
            if !agent_request {
                let body = if request["stream"] == true {
                    "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Recovery fixture\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n".to_owned()
                } else {
                    json!({"id":"fixture-title","choices":[{"index":0,"message":{"role":"assistant","content":"Recovery fixture"},"finish_reason":"stop"}]}).to_string()
                };
                let kind = if request["stream"] == true {
                    "text/event-stream"
                } else {
                    "application/json"
                };
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await?;
                continue;
            }
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"id\":\"local-recovery\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"recovery-probe-\"}}]}\n\n").await?;
            let _ = started.take().unwrap().send(());
            let _ = release.take().unwrap().await;
            stream.write_all(b"data: {\"id\":\"local-recovery\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"complete\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":4,\"total_tokens\":104}}\n\ndata: [DONE]\n\n").await?;
            return Ok::<_, std::io::Error>(());
        }
    });
    let stderr = fs::File::create(temp.path().join("fixture-host.stderr"))?;
    let home = temp.path().join("home");
    fs::create_dir(&home)?;
    let mut command = Command::new(host);
    command
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("APPDATA", &home)
        .env("LOCALAPPDATA", &home)
        .env("TEMP", temp.path())
        .env("TMP", temp.path());
    for key in ["SystemRoot", "WINDIR", "COMSPEC"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut process = OwnedHost(
        command
            .args([
                "--bind",
                "127.0.0.1:0",
                "--model",
                "recovery-fixture",
                "--base-url",
                &format!("http://{provider_address}/v1"),
                "--api-key",
                "fixture-only",
                "--desktop-token",
                &token,
            ])
            .arg("--workspace")
            .arg(&workspace)
            .arg("--state-dir")
            .arg(&state)
            .arg("--ready-file")
            .arg(&ready)
            .arg("--shutdown-file")
            .arg(&shutdown)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(stderr)
            .spawn()?,
    );
    let pid = process.0.id();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(4))
        .build()?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let address = loop {
        if let Ok(text) = fs::read_to_string(&ready) {
            if let Ok(address) = text.parse::<SocketAddr>() {
                if client
                    .get(format!("http://{address}/health/ready"))
                    .send()
                    .await
                    .is_ok_and(|r| r.status().is_success())
                {
                    break address;
                }
            }
        }
        if process.0.try_wait()?.is_some() {
            return Err("isolated Host exited during startup".into());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("isolated Host readiness timed out".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let created = rpc(
        &client,
        address,
        &token,
        "create",
        "session.create",
        json!({"sessionId":"recovery-active-turn"}),
    )
    .await?;
    let id = created["sessionId"]
        .as_str()
        .ok_or("missing created session")?;
    rpc(
        &client,
        address,
        &token,
        "prompt",
        "session.prompt",
        json!({"sessionId":id,"mode":"queue","content":[{"type":"text","text":"Return recovery-probe-complete"}]}),
    )
    .await?;
    match tokio::time::timeout(Duration::from_secs(15), seen).await {
        Ok(Ok(())) => {}
        Ok(Err(_)) => {
            let result = model.await?;
            return Err(format!("provider fixture ended before agent request: {result:?}").into());
        }
        Err(error) => return Err(error.into()),
    }
    assert!(store.host_owned()?);
    // Simulate the old desktop's process-owned resources disappearing. The
    // real Host and its pending model TCP request are deliberately untouched.
    drop(bridge);
    drop(store);
    let replacement = desktop_recovery::RecoveryStore::open(&root, &state, &workspace)?;
    let launch = replacement.load()?.ok_or("missing private handoff")?;
    assert!(replacement.host_owned()?);
    assert!(launch.compatible());
    assert_eq!(launch.token, token);
    assert!(desktop_recovery::authenticate_with_retry(address, &launch.token).await?);
    assert!(!desktop_recovery::authenticate(address, &desktop_recovery::secret()?).await?);
    let rebound = TcpListener::bind(launch.browser_address).await?;
    assert_eq!(rebound.local_addr()?, bridge_address);
    assert!(process.0.try_wait()?.is_none());
    assert_eq!(process.0.id(), pid);
    let listed = rpc(
        &client,
        address,
        &launch.token,
        "list-after-reconnect",
        "session.list",
        json!({}),
    )
    .await?;
    assert!(listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["sessionId"] == id));
    let _ = finish.send(());
    model.await??;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let text = fs::read_to_string(state.join("sessions").join(format!("{id}.jsonl")))?;
        let events: Vec<Value> = text
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .flat_map(|record| record["events"].as_array().cloned().unwrap_or_default())
            .collect();
        if let Some(end) = events
            .iter()
            .find(|event| event["event"]["type"] == "turn/end")
        {
            assert_eq!(
                end["event"]["data"]["reason"]["kind"], "completed",
                "turn must complete, not fail/cancel"
            );
            let messages: Vec<_> = events
                .iter()
                .filter(|event| event["event"]["type"] == "assistant/message")
                .collect();
            assert_eq!(messages.len(), 1, "exactly one committed assistant message");
            assert_eq!(
                messages[0]["event"]["data"]["message"]["content"],
                "recovery-probe-complete"
            );
            for kind in ["user/message", "turn/start", "turn/end"] {
                assert_eq!(
                    events
                        .iter()
                        .filter(|event| event["event"]["type"] == kind)
                        .count(),
                    1,
                    "exactly one {kind}, no replay"
                );
            }
            assert!(!text.contains("outcome_unknown"));
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("active turn did not finish after desktop handoff".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(process.0.try_wait()?.is_none());
    fs::write(&shutdown, b"shutdown")?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = process.0.try_wait()? {
            assert!(status.success());
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("isolated graceful shutdown timed out".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!replacement.host_owned()?);
    assert!(state.join("ownership/host.agent.lock").is_file());
    println!(
        "HOST_RECOVERY_EVIDENCE {}",
        json!({"passed":true,"same_host":true,"active_turn_preserved":true,"bridge_rebound":true,"challenge_verified":true,"wrong_key_denied":true,"shutdown_verified_by_lease":true,"lock_not_deleted":true,"external_model_calls":0,"test_only":true})
    );
    Ok(())
}

fn main() {
    let host = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .expect("explicit test Host path required");
    let temp = tempfile::tempdir().expect("private probe directory");
    let result = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(run(host, &temp));
    if let Err(error) = result {
        if let Ok(files) = fs::read_dir(temp.path().join("state/sessions")) {
            for file in files.flatten().filter(|file| {
                file.path()
                    .extension()
                    .is_some_and(|extension| extension == "jsonl")
            }) {
                let text = fs::read_to_string(file.path()).unwrap_or_default();
                let events: Vec<Value> = text
                    .lines()
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                    .flat_map(|record| record["events"].as_array().cloned().unwrap_or_default())
                    .collect();
                let kinds: Vec<_> = events
                    .iter()
                    .filter_map(|event| event["event"]["type"].as_str())
                    .collect();
                eprintln!(
                    "Fixture journal metadata: {}",
                    json!({"bytes":text.len(),"has_complete":text.contains("recovery-probe-complete"),"has_end":text.contains("turn/end"),"event_kinds":kinds})
                );
                for event in events.iter().filter(|event| {
                    matches!(
                        event["event"]["type"].as_str(),
                        Some("turn/end" | "assistant/message" | "llm/retry")
                    )
                }) {
                    eprintln!("Fixture terminal event: {}", event["event"]);
                }
            }
        }
        eprintln!("Host recovery probe failed: {error}");
        std::process::exit(1);
    }
}

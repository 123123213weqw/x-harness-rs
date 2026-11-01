//! Real executable + HTTP carrier + on-disk settings restart test. The fake
//! credential is injected into this child only; native keychain has a separate
//! Windows integration test and is never required on a headless Linux runner.
use serde_json::{json, Value};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::process::{Child, Command};

struct TestHost {
    process: Child,
    endpoint: String,
}
impl TestHost {
    async fn start(dir: &std::path::Path) -> Self {
        Self::start_with_providers(dir, None).await
    }
    async fn start_with_providers(
        dir: &std::path::Path,
        providers: Option<&std::path::Path>,
    ) -> Self {
        let ready = dir.join("ready.address");
        let _ = std::fs::remove_file(&ready);
        let mut command = Command::new(env!("CARGO_BIN_EXE_xharness-host"));
        command
            .arg("--bind")
            .arg("127.0.0.1:0")
            .arg("--workspace")
            .arg(dir)
            .arg("--state-dir")
            .arg(dir.join("state"))
            .arg("--ready-file")
            .arg(&ready)
            .arg("--model")
            .arg("unconfigured")
            .env_remove("XHARNESS_PROVIDERS_FILE")
            .env_remove("XHARNESS_DESKTOP_TOKEN")
            .env("XHARNESS_SETTINGS_PROCESS_KEY", "fake-process-test-key")
            .env("XHARNESS_DEBUG_TRACE", "off")
            .kill_on_drop(true)
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        if let Some(providers) = providers {
            command.arg("--providers-file").arg(providers);
        }
        let mut process = command.spawn().unwrap();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(1))
            .no_proxy()
            .build()
            .unwrap();
        let endpoint = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                assert!(
                    process.try_wait().unwrap().is_none(),
                    "Host exited before readiness"
                );
                // The address file announces a bound listener, not completion
                // of control/model restoration. Never race a settings mutation
                // against the production readiness gate.
                if let Some(endpoint) = ready_endpoint(&client, &ready).await {
                    break endpoint;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap();
        Self { process, endpoint }
    }
    async fn call(&self, id: &str, method: &str, payload: Value) -> Value {
        let response: Value = reqwest::Client::new()
            .post(format!("{}/api/{method}", self.endpoint))
            .json(&json!({"type":"client-request","rpcId":id,"method":method,"payload":payload}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(response["result"]["ok"], true, "{response}");
        response["result"]["value"].clone()
    }

    async fn wait_for_session_catalogue(&self, session_id: &str) {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(1))
            .no_proxy()
            .build()
            .unwrap();
        // Ready restores model settings, not every historical session. The
        // production catalogue is intentionally discovered after Ready. Wait
        // for its read-only publication; never retry/mask a failed models RPC.
        tokio::time::timeout(Duration::from_secs(20), async {
            while !catalogue_contains(&client, &self.endpoint, session_id).await {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("durable session did not appear in the background catalogue");
    }
}

async fn catalogue_contains(client: &reqwest::Client, endpoint: &str, session_id: &str) -> bool {
    let response: Value = client
        .post(format!("{endpoint}/api/session.list"))
        .json(
            &json!({"type":"client-request","rpcId":"catalogue-discovery",
            "method":"session.list","payload":{}}),
        )
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["result"]["ok"], true, "{response}");
    response["result"]["value"]["items"]
        .as_array()
        .expect("catalogue must return an item array")
        .iter()
        .any(|item| item["sessionId"] == session_id)
}

async fn ready_endpoint(client: &reqwest::Client, ready: &std::path::Path) -> Option<String> {
    let address = std::fs::read_to_string(ready).ok()?;
    let endpoint = format!("http://{}", address.trim());
    let response = client
        .get(format!("{endpoint}/health/ready"))
        .send()
        .await
        .ok()?;
    (response.status() == reqwest::StatusCode::OK).then_some(endpoint)
}

#[tokio::test]
async fn listener_address_does_not_imply_model_settings_readiness() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let dir = TestDir(std::env::temp_dir().join(format!(
        "xharness-readiness-probe-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )));
    std::fs::create_dir_all(&dir.0).unwrap();
    let ready = dir.0.join("ready.address");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .no_proxy()
        .build()
        .unwrap();
    assert!(ready_endpoint(&client, &ready).await.is_none());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    std::fs::write(&ready, format!("{address}\n")).unwrap();
    let server = tokio::spawn(async move {
        for status in ["503 Service Unavailable", "200 OK"] {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(stream.read_u8().await.unwrap());
                assert!(request.len() <= 4096);
            }
            assert!(request.starts_with(b"GET /health/ready HTTP/1.1\r\n"));
            stream
                .write_all(
                    format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .as_bytes(),
                )
                .await
                .unwrap();
        }
    });
    // A real listener with an address file still rejects admission while the
    // restoration gate is closed. The very same address becomes usable later.
    assert!(ready_endpoint(&client, &ready).await.is_none());
    assert_eq!(
        ready_endpoint(&client, &ready).await,
        Some(format!("http://{address}"))
    );
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn ready_does_not_imply_that_a_cold_session_is_already_catalogued() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let endpoint = format!("http://{address}");
    let dir = TestDir(std::env::temp_dir().join(format!(
        "xharness-catalogue-probe-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )));
    std::fs::create_dir_all(&dir.0).unwrap();
    let ready = dir.0.join("ready.address");
    std::fs::write(&ready, address.to_string()).unwrap();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .no_proxy()
        .build()
        .unwrap();
    let server = tokio::spawn(async move {
        for (index, items) in [
            json!([]),
            json!([]),
            json!([{"sessionId":"other"}]),
            json!([{"sessionId":"cold"}]),
        ]
        .into_iter()
        .enumerate()
        {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(stream.read_u8().await.unwrap());
                assert!(header.len() <= 4096);
            }
            let header = String::from_utf8(header).unwrap();
            if index == 0 {
                assert!(header.starts_with("GET /health/ready HTTP/1.1\r\n"));
            } else {
                assert!(header.starts_with("POST /api/session.list HTTP/1.1\r\n"));
                let length: usize = header
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|value| value.trim().parse().unwrap())
                    })
                    .unwrap();
                assert!(length <= 4096);
                let mut body = vec![0; length];
                stream.read_exact(&mut body).await.unwrap();
                let body: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(body["method"], "session.list");
            }
            let body = json!({"result":{"ok":true,"value":{"items":items}}}).to_string();
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
    });
    assert_eq!(
        ready_endpoint(&client, &ready).await,
        Some(endpoint.clone())
    );
    assert!(!catalogue_contains(&client, &endpoint, "cold").await);
    assert!(!catalogue_contains(&client, &endpoint, "cold").await);
    assert!(catalogue_contains(&client, &endpoint, "cold").await);
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
}

fn model_namespace(settings: &Value) -> &Value {
    settings["namespaces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|namespace| namespace["ns"] == "llm-pi-ai")
        .unwrap()
}

#[tokio::test]
async fn provider_base_change_rebases_user_overrides_after_restart_and_update() {
    let dir = TestDir(std::env::temp_dir().join(format!(
        "xharness-model-rebase-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )));
    std::fs::create_dir_all(&dir.0).unwrap();
    let config = |providers: &[(&str, &str)]| {
        json!({
            "default":{"provider":"alpha","model":"a"},
            "providers": providers.iter().map(|(id, model)| json!({
                "id":id,"base_url":"http://127.0.0.1:9/v1","protocol":"chat",
                "models":[{"id":model,"fallback_context_window_tokens":32768,"max_output_tokens":4096}]
            })).collect::<Vec<_>>()
        })
    };
    let old = dir.0.join("old-providers.json");
    let new = dir.0.join("new-providers.json");
    std::fs::write(&old, config(&[("alpha", "a")]).to_string()).unwrap();
    std::fs::write(&new, config(&[("alpha", "a"), ("gamma", "g")]).to_string()).unwrap();

    let mut app = TestHost::start_with_providers(&dir.0, Some(&old)).await;
    let saved = app
        .call(
            "add-beta",
            "settings.mutate",
            json!({
                "ns":"llm-pi-ai","expectedRevision":0,
                "ops":[{"op":"set","path":["providers","beta"],"value":{
                    "baseURL":"http://127.0.0.1:9/v1","api":"openai-completions",
                    "models":[{"id":"b"}]
                }}]
            }),
        )
        .await;
    assert_eq!(saved["revision"], 1);
    app.process.kill().await.unwrap();
    app.process.wait().await.unwrap();

    let mut app = TestHost::start_with_providers(&dir.0, Some(&new)).await;
    let described = app
        .call("describe-rebased", "settings.describe", json!({}))
        .await;
    let ns = model_namespace(&described);
    assert!(ns["base"]["providers"].get("gamma").is_some());
    assert!(ns["user"]["providers"].get("beta").is_some());
    for id in ["alpha", "beta", "gamma"] {
        assert!(
            ns["value"]["providers"].get(id).is_some(),
            "missing {id} after rebase: {ns}"
        );
    }
    let models = app.call("rebased-models", "llm.models", json!({})).await;
    assert!(
        models["groups"]
            .as_array()
            .unwrap()
            .iter()
            .any(|group| group["id"] == "gamma"),
        "{models}"
    );
    let updated = app
        .call(
            "update-beta",
            "settings.update",
            json!({
                "ns":"llm-pi-ai","expectedRevision":1,
                "patch":{"providers":{"beta":{"displayName":"Beta"}}}
            }),
        )
        .await;
    assert_eq!(updated["revision"], 2);
    assert!(
        updated["value"]["providers"].get("gamma").is_some(),
        "{updated}"
    );
    app.process.kill().await.unwrap();
    app.process.wait().await.unwrap();

    let mut app = TestHost::start_with_providers(&dir.0, Some(&new)).await;
    let replayed = model_namespace(
        &app.call("describe-replayed", "settings.describe", json!({}))
            .await,
    )
    .clone();
    assert_eq!(replayed["revision"], 2);
    assert!(
        replayed["value"]["providers"].get("gamma").is_some(),
        "{replayed}"
    );
    app.process.kill().await.unwrap();
    app.process.wait().await.unwrap();
}
struct TestDir(PathBuf);
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn clean_executable_can_add_and_restore_models_over_http() {
    let dir = TestDir(std::env::temp_dir().join(format!(
            "xharness-model-process-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )));
    std::fs::create_dir_all(&dir.0).unwrap();
    let mut app = TestHost::start(&dir.0).await;
    let saved=app.call("add-profile","settings.mutate",json!({"ns":"llm-pi-ai","expectedRevision":0,"ops":[{"op":"set","path":["providers","gateway"],"value":{"baseURL":"http://127.0.0.1:12345/v1","api":"openai-completions","apiKeyEnv":"XHARNESS_SETTINGS_PROCESS_KEY","models":[{"id":"coder"}]}}]})).await;
    assert_eq!(saved["revision"], 1);
    assert_eq!(
        app.call("models", "llm.models", json!({})).await["groups"][0]["models"][0]["id"],
        "coder"
    );
    let created = app
        .call("new-session", "session.create", json!({"cwd":dir.0}))
        .await;
    let session_id = created["sessionId"].as_str().unwrap().to_owned();
    assert_eq!(
        app.call(
            "selected",
            "session.models",
            json!({"sessionId":session_id})
        )
        .await["current"]["model"],
        "coder"
    );
    // Observe only: do not repair a catalogue or modify the journal in the
    // fixture. An abrupt stop must retain the exact acknowledged session bytes.
    let journal = dir
        .0
        .join("state/sessions")
        .join(format!("{session_id}.jsonl"));
    let durable = std::fs::read(&journal).unwrap();
    assert!(!durable.is_empty());
    app.process.kill().await.unwrap();
    app.process.wait().await.unwrap();
    assert_eq!(std::fs::read(&journal).unwrap(), durable);
    let mut app = TestHost::start(&dir.0).await;
    let replay=app.call("add-profile","settings.mutate",json!({"ns":"llm-pi-ai","expectedRevision":0,"ops":[{"op":"set","path":["providers","gateway"],"value":{"baseURL":"http://127.0.0.1:12345/v1","api":"openai-completions","apiKeyEnv":"XHARNESS_SETTINGS_PROCESS_KEY","models":[{"id":"coder"}]}}]})).await;
    assert_eq!(
        replay, saved,
        "lost responses replay the same namespace, including schema"
    );
    app.wait_for_session_catalogue(&session_id).await;
    let model = app
        .call(
            "restored-selection",
            "session.models",
            json!({"sessionId":session_id}),
        )
        .await;
    assert_eq!(model["current"]["model"], "coder");
    assert_eq!(model["routable"], true);
    app.process.kill().await.unwrap();
    app.process.wait().await.unwrap();
}

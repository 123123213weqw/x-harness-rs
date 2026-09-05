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
        let ready = dir.join("ready.address");
        let _ = std::fs::remove_file(&ready);
        let process = Command::new(env!("CARGO_BIN_EXE_xharness-host"))
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
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let endpoint = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                if let Ok(address) = std::fs::read_to_string(&ready) {
                    break format!("http://{}", address.trim());
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
    app.process.kill().await.unwrap();
    app.process.wait().await.unwrap();
    let mut app = TestHost::start(&dir.0).await;
    let replay=app.call("add-profile","settings.mutate",json!({"ns":"llm-pi-ai","expectedRevision":0,"ops":[{"op":"set","path":["providers","gateway"],"value":{"baseURL":"http://127.0.0.1:12345/v1","api":"openai-completions","apiKeyEnv":"XHARNESS_SETTINGS_PROCESS_KEY","models":[{"id":"coder"}]}}]})).await;
    assert_eq!(
        replay, saved,
        "lost responses replay the same namespace, including schema"
    );
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

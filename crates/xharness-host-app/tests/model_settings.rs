use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;
use xharness_agent::MemoryLeaseManager;
use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
use xharness_control::{ControlStore, JsonlControlStore};
use xharness_core::{AgentMessage, IdentityContextPolicy};
use xharness_debug::DebugRecorder;
use xharness_host::{
    AgentRuntime, AgentTurnRequest, BasicHost, DurableLoopAgentRuntime, HostConfig, ModelRegistry,
    ModelRoute, NoTools, PermissionPreset, MODEL_SETTINGS_NAMESPACE,
};
use xharness_host_app::model_settings::{CredentialStore, NativeModelSettings};
use xharness_session::{MemorySessionStore, Store};

static NEXT: AtomicU64 = AtomicU64::new(1);
struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "xharness-model-settings-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct TestCredentials(tokio::sync::Mutex<BTreeMap<String, String>>);
#[async_trait]
impl CredentialStore for TestCredentials {
    async fn get(&self, r: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().await.get(r).cloned())
    }
    async fn set(&self, r: &str, v: &str) -> Result<(), String> {
        self.0.lock().await.insert(r.to_owned(), v.to_owned());
        Ok(())
    }
    async fn delete(&self, r: &str) -> Result<(), String> {
        self.0.lock().await.remove(r);
        Ok(())
    }
}

async fn fixture(
    dir: &TempDir,
    credentials: Arc<dyn CredentialStore>,
) -> (Arc<BasicHost>, Arc<DurableLoopAgentRuntime>) {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let runtime = Arc::new(
        DurableLoopAgentRuntime::from_registry(
            ModelRoute::new("none", "unconfigured"),
            ModelRegistry::new(),
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            store.clone(),
            Arc::new(MemoryLeaseManager::default()),
            128,
        )
        .unwrap(),
    );
    let control: Arc<dyn ControlStore> =
        Arc::new(JsonlControlStore::new(dir.0.join("control")).unwrap());
    let host = BasicHost::with_agent_runtime_and_control_store(
        HostConfig::new(&dir.0),
        runtime.clone(),
        control,
    );
    host.install_model_settings(
        Arc::new(NativeModelSettings::new(
            runtime.clone(),
            credentials,
            DebugRecorder::disabled(),
        )),
        json!({"providers":{}}),
    )
    .await
    .unwrap();
    host.restore_from_store(store).await.unwrap();
    host.refresh_model_settings().await.unwrap();
    (host, runtime)
}
async fn rpc(host: &BasicHost, method: RpcMethod, payload: Value) -> Value {
    let id = RpcId::new(format!(
        "settings-test-{}",
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    match host
        .call(id, method, payload, CancellationToken::new())
        .await
    {
        RpcResult::Success { value: Some(v) } => v,
        other => panic!("RPC failed: {other:?}"),
    }
}
fn profile(endpoint: &str) -> Value {
    json!({"displayName":"Test gateway","baseURL":endpoint,"api":"openai-completions","apiKeyEnv":"XHARNESS_SETTINGS_TEST_KEY","models":[{"id":"coder","name":"Coding model","contextWindow":32768,"maxTokens":4096}]})
}
async fn add(host: &BasicHost, p: Value) -> Value {
    rpc(host,RpcMethod::SettingsMutate,json!({"ns":MODEL_SETTINGS_NAMESPACE,"expectedRevision":0,"ops":[{"op":"set","path":["providers","test-gateway"],"value":p}]})).await
}

#[tokio::test]
async fn settings_credentials_routes_and_restart_are_one_pipeline() {
    let dir = TempDir::new();
    let keys = Arc::new(TestCredentials::default());
    let (host, runtime) = fixture(&dir, keys.clone()).await;
    let saved = add(&host, profile("http://127.0.0.1:12345/v1")).await;
    assert_eq!(saved["revision"], 1);
    assert!(
        !runtime.has_available_route(),
        "missing credential must not advertise a usable model"
    );
    let providers = rpc(&host, RpcMethod::LlmProviders, json!({})).await;
    assert_eq!(
        providers["providers"][0]["settingsPath"],
        json!(["providers", "test-gateway"])
    );
    assert_eq!(providers["providers"][0]["active"], false);
    rpc(
        &host,
        RpcMethod::CredentialsSet,
        json!({"ref":"XHARNESS_SETTINGS_TEST_KEY","value":"test-only-private-value"}),
    )
    .await;
    assert!(runtime.can_route(&ModelRoute::new("test-gateway", "coder")));
    let info = rpc(
        &host,
        RpcMethod::CredentialsDescribe,
        json!({"refs":["XHARNESS_SETTINGS_TEST_KEY"]}),
    )
    .await;
    assert_eq!(
        info["credentials"]["XHARNESS_SETTINGS_TEST_KEY"]["configured"],
        true
    );
    assert!(!info.to_string().contains("test-only-private-value"));
    let stale=host.call(RpcId::new("stale"),RpcMethod::SettingsMutate,json!({"ns":MODEL_SETTINGS_NAMESPACE,"expectedRevision":0,"ops":[{"op":"unset","path":["providers","test-gateway"]}]}),CancellationToken::new()).await;
    assert!(matches!(stale, RpcResult::Failure { .. }));
    drop(host);
    drop(runtime);
    let (host, runtime) = fixture(&dir, keys).await;
    assert!(runtime.can_route(&ModelRoute::new("test-gateway", "coder")));
    let desc = rpc(&host, RpcMethod::SettingsDescribe, json!({})).await;
    assert!(!desc.to_string().contains("test-only-private-value"));
    let ns = desc["namespaces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["ns"] == MODEL_SETTINGS_NAMESPACE)
        .unwrap();
    assert_eq!(ns["revision"], 1);
    rpc(
        &host,
        RpcMethod::CredentialsUnset,
        json!({"ref":"XHARNESS_SETTINGS_TEST_KEY"}),
    )
    .await;
    assert!(!runtime.has_available_route());
    rpc(&host,RpcMethod::SettingsMutate,json!({"ns":MODEL_SETTINGS_NAMESPACE,"expectedRevision":1,"ops":[{"op":"unset","path":["providers","test-gateway"]}]})).await;
    assert_eq!(
        rpc(&host, RpcMethod::LlmProviders, json!({})).await["providers"],
        json!([])
    );
    fn check_files(path: &std::path::Path) {
        for entry in std::fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                check_files(&path)
            } else {
                let text = std::fs::read_to_string(path).unwrap();
                assert!(!text.contains("test-only-private-value"));
            }
        }
    }
    check_files(&dir.0.join("control"));
}

#[tokio::test]
async fn configured_route_sends_authenticated_request_to_real_http_adapter() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&chunk[..n]);
            if let Some(header_end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..header_end]);
                let length = headers
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if bytes.len() >= header_end + 4 + length {
                    break;
                }
            }
        }
        let request = String::from_utf8(bytes).unwrap();
        assert!(request.starts_with("POST /v1/chat/completions"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer test-http-key"));
        assert!(request.contains("coder"));
        let body="data: {\"choices\":[{\"delta\":{\"content\":\"model configuration works\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
    });
    let dir = TempDir::new();
    let (host, runtime) = fixture(&dir, Arc::new(TestCredentials::default())).await;
    add(&host, profile(&endpoint)).await;
    rpc(
        &host,
        RpcMethod::CredentialsSet,
        json!({"ref":"XHARNESS_SETTINGS_TEST_KEY","value":"test-http-key"}),
    )
    .await;
    let request = AgentTurnRequest {
        session_id: "model-settings-http".to_owned(),
        cwd: dir.0.to_string_lossy().into_owned(),
        route: ModelRoute::new("test-gateway", "coder"),
        permission: PermissionPreset::WorkspaceWrite,
        prompt: None,
        messages: vec![AgentMessage::user("hello").with_id("input-1")],
        input_metadata: None,
    };
    runtime.admit_turn(request.clone()).await.unwrap();
    let mut turn = runtime.start_turn(request).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        while turn.next_event().await.is_some() {}
        assert_eq!(turn.result().await.final_text, "model configuration works");
        server.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn invalid_settings_do_not_commit_or_erase_existing_profiles() {
    let dir = TempDir::new();
    let (host, _) = fixture(&dir, Arc::new(TestCredentials::default())).await;
    add(&host, profile("http://127.0.0.1:12345/v1")).await;
    for (field, value) in [
        ("baseURL", json!("https://user:password@example.com")),
        ("apiKey", json!("do-not-persist")),
        ("models", json!([])),
    ] {
        let result=host.call(RpcId::new(format!("reject-{field}")),RpcMethod::SettingsMutate,json!({"ns":MODEL_SETTINGS_NAMESPACE,"expectedRevision":1,"ops":[{"op":"set","path":["providers","test-gateway",field],"value":value}]}),CancellationToken::new()).await;
        assert!(matches!(result, RpcResult::Failure { .. }));
    }
    let desc = rpc(&host, RpcMethod::SettingsDescribe, json!({})).await;
    let ns = desc["namespaces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["ns"] == MODEL_SETTINGS_NAMESPACE)
        .unwrap();
    assert_eq!(ns["revision"], 1);
    assert!(!desc.to_string().contains("do-not-persist"));
}

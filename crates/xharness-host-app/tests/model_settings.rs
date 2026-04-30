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
    AgentRuntime, AgentTurnRequest, BasicHost, DurableLoopAgentRuntime, HostConfig,
    HostRestoreReport, ModelRegistry, ModelRoute, NoTools, PermissionPreset,
    MODEL_SETTINGS_NAMESPACE,
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
    fixture_with_store(dir, credentials, Arc::new(MemorySessionStore::default())).await
}
async fn fixture_with_store(
    dir: &TempDir,
    credentials: Arc<dyn CredentialStore>,
    store: Arc<dyn Store>,
) -> (Arc<BasicHost>, Arc<DurableLoopAgentRuntime>) {
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
    let report = host.restore_from_store(store).await.unwrap();
    assert!(report.model_settings_error.is_none(), "{report:?}");
    assert!(report.issues.is_empty(), "{report:?}");
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
async fn restored_settings_activate_before_queued_input_reaches_real_http_adapter() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        loop {
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
            if request.starts_with("POST /v1/chat/completions/input_tokens ") {
                let body = "{\"input_tokens\":20}";
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
                continue;
            }
            let body="data: {\"choices\":[{\"delta\":{\"content\":\"model configuration works\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
            break;
        }
    });
    let dir = TempDir::new();
    let keys = Arc::new(TestCredentials::default());
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let (host, runtime) = fixture_with_store(&dir, keys.clone(), store.clone()).await;
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
    // Record the explicit route just as session.selectModel does. Admission
    // has not yet emitted a provider RequestHeader.
    let session = store.load(&request.session_id).await.unwrap().unwrap();
    store
        .append(
            &request.session_id,
            session.revision(),
            vec![xharness_session::EventData::SessionModelSelected {
                provider: request.route.provider.clone(),
                model: request.route.model.clone(),
                reasoning_effort: None,
                context_window_tokens: None,
            }
            .into()],
        )
        .await
        .unwrap();
    drop(host);
    drop(runtime);
    let (_host, _runtime) = fixture_with_store(&dir, keys, store.clone()).await;
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let session = store.load(&request.session_id).await.unwrap().unwrap();
            if session.events().iter().any(|e| {
                matches!(
                    e.data(),
                    xharness_session::EventData::TurnEnd {
                        reason: xharness_session::TurnEndReason::Completed,
                        ..
                    }
                )
            }) {
                assert!(xharness_agent::InboxProjection::from_session(&session)
                    .unwrap()
                    .next_turn()
                    .is_empty());
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
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

#[cfg(windows)]
#[tokio::test]
async fn windows_credential_store_survives_recreation_without_plaintext_files() {
    use xharness_host_app::model_settings::NativeCredentialStore;
    let dir = TempDir::new();
    let first = NativeCredentialStore::new(&dir.0).unwrap();
    first
        .set("XHARNESS_TEST_PERSISTENCE", "test-only-native-key")
        .await
        .unwrap();
    let second = NativeCredentialStore::new(&dir.0).unwrap();
    let read = second.get("XHARNESS_TEST_PERSISTENCE").await;
    second.delete("XHARNESS_TEST_PERSISTENCE").await.unwrap();
    assert_eq!(read.unwrap().as_deref(), Some("test-only-native-key"));
    assert_eq!(second.get("XHARNESS_TEST_PERSISTENCE").await.unwrap(), None);
    assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 0);
}

struct UnavailableCredentials;
#[async_trait]
impl CredentialStore for UnavailableCredentials {
    async fn get(&self, _: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    async fn set(&self, _: &str, _: &str) -> Result<(), String> {
        Err("test credential store unavailable".to_owned())
    }
    async fn delete(&self, _: &str) -> Result<(), String> {
        Err("test credential store unavailable".to_owned())
    }
}

#[tokio::test]
async fn credential_storage_failure_does_not_activate_unsaved_key() {
    let dir = TempDir::new();
    let (host, runtime) = fixture(&dir, Arc::new(UnavailableCredentials)).await;
    add(&host, profile("http://127.0.0.1:12345/v1")).await;
    let result = host
        .call(
            RpcId::new("failed-key-write"),
            RpcMethod::CredentialsSet,
            json!({"ref":"XHARNESS_SETTINGS_TEST_KEY","value":"unsaved-test-key"}),
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(result, RpcResult::Failure { .. }));
    assert!(!runtime.has_available_route());
}

#[tokio::test]
async fn declared_effort_selection_survives_restore_and_model_switch() {
    let dir = TempDir::new();
    let keys = Arc::new(TestCredentials::default());
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let (host, runtime) = fixture_with_store(&dir, keys.clone(), store.clone()).await;
    // No credential and no network call is needed to construct a descriptor.
    // Efforts are declared by the deployment, so any endpoint can describe them.
    add(
        &host,
        json!({"baseURL":"https://api.example.com/v1", "api":"openai-completions", "models":[
            {"id":"chat-model","contextWindow":1000000,"reasoning":{"defaultEffort":"high","efforts":[
                {"id":"off","name":"Off","requestPatch":{"reasoning_effort":"none"}},
                {"id":"low","name":"Low","requestPatch":{"reasoning_effort":"low"}},
                {"id":"high","name":"High","requestPatch":{"reasoning_effort":"high"}},
                {"id":"max","name":"Max","requestPatch":{"reasoning_effort":"max"}}
            ]}},
            {"id":"unknown","contextWindow":32768}
        ]}),
    )
    .await;
    let created = rpc(&host, RpcMethod::SessionCreate, json!({"cwd":dir.0})).await;
    let id = created["sessionId"].as_str().unwrap();
    for effort in ["off", "low", "high", "max"] {
        rpc(&host,RpcMethod::SessionSelectModel,json!({"sessionId":id,"provider":"test-gateway","model":"chat-model","reasoningEffort":effort,"contextWindowTokens":65536})).await;
        let catalog = rpc(&host, RpcMethod::SessionModels, json!({"sessionId":id})).await;
        assert_eq!(catalog["current"]["reasoningEffort"], effort);
        assert_eq!(catalog["current"]["contextWindowTokens"], 65536);
    }
    drop(host);
    drop(runtime);
    let (host, _) = fixture_with_store(&dir, keys, store).await;
    let catalog = rpc(&host, RpcMethod::SessionModels, json!({"sessionId":id})).await;
    assert_eq!(catalog["current"]["reasoningEffort"], "max");
    assert_eq!(catalog["current"]["contextWindowTokens"], 65536);
    rpc(
        &host,
        RpcMethod::SessionSelectModel,
        json!({"sessionId":id,"provider":"test-gateway","model":"unknown"}),
    )
    .await;
    let switched = rpc(&host, RpcMethod::SessionModels, json!({"sessionId":id})).await;
    assert!(switched["current"]["reasoningEffort"].is_null());
    let groups = rpc(&host, RpcMethod::LlmModels, json!({})).await;
    assert!(groups["groups"][0]["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "unknown")
        .unwrap()["reasoning"]
        .is_null());
}

struct LockedCredentials;
#[async_trait]
impl CredentialStore for LockedCredentials {
    async fn get(&self, _: &str) -> Result<Option<String>, String> {
        Err("test keychain locked".to_owned())
    }
    async fn set(&self, _: &str, _: &str) -> Result<(), String> {
        unreachable!()
    }
    async fn delete(&self, _: &str) -> Result<(), String> {
        unreachable!()
    }
}

#[tokio::test]
async fn restore_activation_failure_clears_stale_routes_but_preserves_settings_repair() {
    let dir = TempDir::new();
    let (old_host, runtime) = fixture(&dir, Arc::new(TestCredentials::default())).await;
    add(&old_host, profile("http://127.0.0.1:12345/v1")).await;
    rpc(
        &old_host,
        RpcMethod::CredentialsSet,
        json!({"ref":"XHARNESS_SETTINGS_TEST_KEY","value":"test-only-key"}),
    )
    .await;
    assert!(runtime.has_available_route());
    drop(old_host);
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
            Arc::new(LockedCredentials),
            DebugRecorder::disabled(),
        )),
        json!({"providers":{}}),
    )
    .await
    .unwrap();
    let report = host
        .restore_from_store(Arc::new(MemorySessionStore::default()))
        .await
        .unwrap();
    assert_eq!(
        report.model_settings_error.as_deref(),
        Some("test keychain locked")
    );
    assert!(
        !runtime.has_available_route(),
        "stale bootstrap routes must fail closed"
    );
    let settings = rpc(&host, RpcMethod::SettingsDescribe, json!({})).await;
    assert!(
        settings.to_string().contains("test-gateway"),
        "settings remain available for repair"
    );
}

#[tokio::test]
async fn configured_usage_semantics_reaches_the_native_adapter() {
    use futures::StreamExt;
    use xharness_core::{ProviderEvent, ProviderRequest};
    for (semantics, expected_uncached) in [("total_includes_cache", 3), ("uncached_input", 3003)] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buf = [0; 4096];
            loop {
                let n = socket.read(&mut buf).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
                if let Some(end) = bytes.windows(4).position(|x| x == b"\r\n\r\n") {
                    let length = String::from_utf8_lossy(&bytes[..end])
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|x| x.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let body="data: {\"choices\":[],\"usage\":{\"input_tokens\":3003,\"cache_read_input_tokens\":2000,\"cache_creation_input_tokens\":1000}}\n\ndata: [DONE]\n\n";
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        });
        let dir = TempDir::new();
        let (host, runtime) = fixture(&dir, Arc::new(TestCredentials::default())).await;
        let mut p = profile(&endpoint);
        p.as_object_mut().unwrap().remove("apiKeyEnv");
        p["usageInputSemantics"] = json!(semantics);
        add(&host, p).await;
        let model = runtime
            .auxiliary_model(&ModelRoute::new("test-gateway", "coder"))
            .unwrap();
        let req = ProviderRequest {
            messages: vec![AgentMessage::user("test")],
            tools: vec![],
            step: 1,
            reasoning_effort: None,
            max_output_tokens: None,
            debug_scope: Default::default(),
        };
        let mut stream = model
            .provider
            .stream(req, CancellationToken::new())
            .await
            .unwrap();
        let mut seen = false;
        while let Some(event) = stream.next().await {
            if let ProviderEvent::Completed {
                usage: Some(usage), ..
            } = event.unwrap()
            {
                assert_eq!(
                    [
                        usage.input_tokens,
                        usage.cache_read_tokens,
                        usage.cache_write_tokens
                    ],
                    [expected_uncached, 2000, 1000]
                );
                seen = true;
            }
        }
        assert!(seen);
        server.await.unwrap();
        let result=host.call(RpcId::new("bad-usage-semantics"),RpcMethod::SettingsMutate,json!({"ns":MODEL_SETTINGS_NAMESPACE,"expectedRevision":1,"ops":[{"op":"set","path":["providers","test-gateway","usageInputSemantics"],"value":"guess"}]}),CancellationToken::new()).await;
        assert!(matches!(result, RpcResult::Failure { .. }));
    }
}

#[tokio::test]
async fn omitted_reasoning_survives_edit_restart_and_explicit_disable() {
    let dir = TempDir::new();
    let keys = Arc::new(TestCredentials::default());
    let (host, runtime) = fixture(&dir, keys.clone()).await;
    let mut p = profile("http://127.0.0.1:12345/v1");
    p["apiKeyEnv"] = Value::Null;
    p["models"] = json!([{"id":"coder","contextWindow":32768,"reasoning":{"default_effort":"deep","efforts":[{"id":"deep","name":"Deep","request_patch":{"custom_reasoning":{"level":7}}}]}}]);
    add(&host, p).await;
    assert!(runtime.model_catalog()[0].reasoning.is_some());
    let section = json!({"providers":{"test-gateway":{"baseURL":"http://127.0.0.1:12345/v1","api":"openai-completions","models":[{"id":"coder","name":"Renamed","contextWindow":32768}]}}});
    rpc(
        &host,
        RpcMethod::SettingsReplace,
        json!({"ns":MODEL_SETTINGS_NAMESPACE,"section":section}),
    )
    .await;
    assert!(runtime.model_catalog()[0].reasoning.is_some());
    drop(host);
    drop(runtime);
    let (host, runtime) = fixture(&dir, keys).await;
    assert_eq!(
        runtime.model_catalog()[0]
            .reasoning
            .as_ref()
            .unwrap()
            .default_effort
            .as_deref(),
        Some("deep")
    );
    let mut section = section;
    section["providers"]["test-gateway"]["models"][0]["reasoning"] = Value::Null;
    rpc(
        &host,
        RpcMethod::SettingsReplace,
        json!({"ns":MODEL_SETTINGS_NAMESPACE,"section":section}),
    )
    .await;
    assert!(runtime.model_catalog()[0].reasoning.is_none());
    assert_eq!(
        runtime.model_catalog()[0].reasoning_capability["state"],
        "disabled"
    );
}

#[tokio::test]
async fn capability_refresh_rpc_updates_native_levels_and_keeps_last_good_on_failure() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        for level in [Some("brief"), Some("deep"), None] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 8192];
            let n = socket.read(&mut request).await.unwrap();
            assert!(String::from_utf8_lossy(&request[..n]).starts_with("GET /capabilities "));
            let (status, body) = match level {
                Some(level) => (
                    "200 OK",
                    json!({"data":[{"id":"coder","levels":[level],"default":level}]}).to_string(),
                ),
                None => ("503 Service Unavailable", "{}".into()),
            };
            socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
    });
    let dir = TempDir::new();
    let (host, runtime) = fixture(&dir, Arc::new(TestCredentials::default())).await;
    let mut p = profile(&base);
    p["apiKeyEnv"] = Value::Null;
    p["reasoningDiscovery"] = json!({"url":format!("{base}/capabilities"),"effortsPointer":"/levels","defaultEffortPointer":"/default","requestTemplate":{"thinking":{"level":"$effort"}}});
    add(&host, p).await;
    assert_eq!(
        runtime.model_catalog()[0]
            .reasoning
            .as_ref()
            .unwrap()
            .default_effort
            .as_deref(),
        Some("brief")
    );
    let created = rpc(&host, RpcMethod::SessionCreate, json!({"cwd":dir.0})).await;
    let id = created["sessionId"].as_str().unwrap();
    for stale in [false, true] {
        rpc(
            &host,
            RpcMethod::SessionModels,
            json!({"sessionId":id,"refreshCapabilities":true}),
        )
        .await;
        let models = runtime.model_catalog();
        assert_eq!(
            models[0]
                .reasoning
                .as_ref()
                .unwrap()
                .default_effort
                .as_deref(),
            Some("deep")
        );
        assert_eq!(
            models[0].reasoning_capability["stale"]
                .as_bool()
                .unwrap_or(false),
            stale
        );
    }
    server.await.unwrap();
}

// ---------------------------------------------------------------------------
// REPRO for "我已经配置模型了，他却显示模型不可用".
//
// The user's exact string is the model selector's `blocked.composer` copy
// ("当前模型不可用，请先选择模型"), rendered when `session.models` reports
// `routable: false`. These tests drive the real RPCs the client calls, against
// the real `BasicHost`, the real `NativeModelSettings` and a real on-disk
// control log across a restart. The credential store is the only stand-in,
// because it is the component that fails intermittently in the field.
// ---------------------------------------------------------------------------

/// Wired like `fixture_with_store`, but returns the startup report instead of
/// asserting it succeeded, so a failing refresh stays observable.
async fn reported_fixture(
    dir: &TempDir,
    credentials: Arc<dyn CredentialStore>,
    store: Arc<dyn Store>,
) -> (
    Arc<BasicHost>,
    Arc<DurableLoopAgentRuntime>,
    HostRestoreReport,
) {
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
    let report = host.restore_from_store(store).await.unwrap();
    (host, runtime, report)
}

/// Configure a provider, store its key, and open a session on it. Returns the
/// session id; the caller drops the host to simulate quitting the app.
async fn configure_select_and_quit(dir: &TempDir, store: &Arc<dyn Store>) -> String {
    let (host, runtime, report) =
        reported_fixture(dir, Arc::new(TestCredentials::default()), store.clone()).await;
    assert!(report.model_settings_error.is_none(), "{report:?}");
    add(&host, profile("http://127.0.0.1:12345/v1")).await;
    rpc(
        &host,
        RpcMethod::CredentialsSet,
        json!({"ref":"XHARNESS_SETTINGS_TEST_KEY","value":"test-only-private-value"}),
    )
    .await;
    let created = rpc(&host, RpcMethod::SessionCreate, json!({"cwd":dir.0})).await;
    let id = created["sessionId"].as_str().unwrap().to_owned();
    rpc(
        &host,
        RpcMethod::SessionSelectModel,
        json!({"sessionId":id,"provider":"test-gateway","model":"coder"}),
    )
    .await;
    let catalog = rpc(&host, RpcMethod::SessionModels, json!({"sessionId":id})).await;
    assert_eq!(
        catalog["routable"],
        json!(true),
        "the composer must not be blocked before the restart: {catalog}"
    );
    println!("phase 1  session.models = {catalog}");
    drop(host);
    drop(runtime);
    id
}

#[tokio::test]
async fn repro_a_locked_keychain_blocks_the_composer_and_shows_no_reason() {
    let dir = TempDir::new();
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let id = configure_select_and_quit(&dir, &store).await;

    // Next start: the keychain cannot be read at all.
    let (host, runtime, report) = reported_fixture(&dir, Arc::new(LockedCredentials), store).await;

    println!(
        "phase 2  report.model_settings_error = {:?}",
        report.model_settings_error
    );
    println!("phase 2  report.issues               = {:?}", report.issues);
    println!(
        "phase 2  has_available_route         = {}",
        runtime.has_available_route()
    );
    let catalog = rpc(&host, RpcMethod::SessionModels, json!({"sessionId":id})).await;
    println!("phase 2  session.models              = {catalog}");
    let providers = rpc(&host, RpcMethod::LlmProviders, json!({})).await;
    println!("phase 2  llm.providers               = {providers}");
    let describe = rpc(&host, RpcMethod::HostDescribe, json!({})).await;
    println!("phase 2  host.describe               = {describe}");

    // The reason exists, but only in the startup report. `LockedCredentials`
    // carries the same shape a real locked keychain produces.
    assert_eq!(
        report.model_settings_error.as_deref(),
        Some("test keychain locked"),
        "startup records the real reason"
    );
    // The whole registry was replaced, so every route is gone.
    assert!(
        !runtime.has_available_route(),
        "the last good registry was discarded"
    );
    // This is the bit the model selector turns into
    // "当前模型不可用，请先选择模型".
    assert_eq!(
        catalog["routable"],
        json!(false),
        "routable false is what blocks the composer: {catalog}"
    );
    // The settings still declare exactly the model the user configured.
    assert_eq!(providers["providers"][0]["provider"], json!("test-gateway"));
    assert_eq!(providers["providers"][0]["declared"], json!(true));
    assert_eq!(providers["providers"][0]["active"], json!(false));
    // The catalog is empty, not merely missing this one model.
    assert_eq!(
        catalog["groups"],
        json!([]),
        "every group disappeared, not just the selected model: {catalog}"
    );
    // The declared provider is reported as a failure with the real reason, in
    // the channel the selector already renders.
    assert_eq!(catalog["failures"][0]["id"], json!("test-gateway"));
    assert_eq!(catalog["failures"][0]["name"], json!("Test gateway"));
    assert!(
        catalog["failures"][0]["message"]
            .as_str()
            .is_some_and(|message| message.contains("test keychain locked")),
        "the selector can explain the missing model: {catalog}"
    );
    // And a client that asks the Host directly gets the same answer.
    assert!(
        describe["modelSettingsError"]
            .as_str()
            .is_some_and(|error| error.contains("test keychain locked")),
        "host.describe carries the activation reason: {describe}"
    );
}

#[tokio::test]
async fn repro_b_a_missing_key_blocks_the_composer_with_no_error_anywhere() {
    let dir = TempDir::new();
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let id = configure_select_and_quit(&dir, &store).await;

    // Next start: the entry is simply absent -- another state directory, a
    // cleared keychain, a restored machine.
    let (host, runtime, report) =
        reported_fixture(&dir, Arc::new(UnavailableCredentials), store).await;

    println!(
        "phase 2  report.model_settings_error = {:?}",
        report.model_settings_error
    );
    println!("phase 2  report.issues               = {:?}", report.issues);
    println!(
        "phase 2  has_available_route         = {}",
        runtime.has_available_route()
    );
    let catalog = rpc(&host, RpcMethod::SessionModels, json!({"sessionId":id})).await;
    println!("phase 2  session.models              = {catalog}");
    let providers = rpc(&host, RpcMethod::LlmProviders, json!({})).await;
    println!("phase 2  llm.providers               = {providers}");

    // Activation itself succeeded, so there is no startup error to report.
    assert!(
        report.model_settings_error.is_none(),
        "credential absence is not an activation failure: {report:?}"
    );
    assert!(!runtime.has_available_route());
    assert_eq!(catalog["routable"], json!(false), "{catalog}");
    assert_eq!(providers["providers"][0]["declared"], json!(true));
    assert_eq!(providers["providers"][0]["active"], json!(false));
    // The provider is dropped from the registry, so the only place the user can
    // learn why is the catalog failures list.
    assert_eq!(catalog["failures"][0]["id"], json!("test-gateway"));
    assert!(
        catalog["failures"][0]["message"]
            .as_str()
            .is_some_and(|message| message.contains("XHARNESS_SETTINGS_TEST_KEY")),
        "the missing credential is named: {catalog}"
    );
}

#[tokio::test]
async fn repro_c_the_composer_blocks_when_the_stored_window_outgrows_the_model() {
    let dir = TempDir::new();
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    // Reused across the "restart", so no credential problem is involved: this
    // test isolates the descriptor check inside `can_route`.
    let keys = Arc::new(TestCredentials::default());

    let (host, runtime, report) = reported_fixture(&dir, keys.clone(), store.clone()).await;
    assert!(report.model_settings_error.is_none(), "{report:?}");
    add(&host, profile("http://127.0.0.1:12345/v1")).await;
    rpc(
        &host,
        RpcMethod::CredentialsSet,
        json!({"ref":"XHARNESS_SETTINGS_TEST_KEY","value":"test-only-private-value"}),
    )
    .await;
    let created = rpc(&host, RpcMethod::SessionCreate, json!({"cwd":dir.0})).await;
    let id = created["sessionId"].as_str().unwrap().to_owned();
    // Accepted here: 32768 does not exceed the advertised 32768.
    rpc(
        &host,
        RpcMethod::SessionSelectModel,
        json!({"sessionId":id,"provider":"test-gateway","model":"coder","contextWindowTokens":32768}),
    )
    .await;
    let before = rpc(&host, RpcMethod::SessionModels, json!({"sessionId":id})).await;
    assert_eq!(before["routable"], json!(true), "{before}");

    // The same model is reconfigured with a smaller window: a settings edit, or
    // a deployment shipping a different default.
    rpc(
        &host,
        RpcMethod::SettingsMutate,
        json!({"ns":MODEL_SETTINGS_NAMESPACE,"expectedRevision":1,"ops":[{"op":"set",
            "path":["providers","test-gateway"],
            "value":json!({"displayName":"Test gateway","baseURL":"http://127.0.0.1:12345/v1",
                "api":"openai-completions","apiKeyEnv":"XHARNESS_SETTINGS_TEST_KEY",
                "models":[{"id":"coder","name":"Coding model","contextWindow":16384,"maxTokens":4096}]})}]}),
    )
    .await;
    drop(host);
    drop(runtime);

    let (host, runtime, report) = reported_fixture(&dir, keys, store).await;
    let catalog = rpc(&host, RpcMethod::SessionModels, json!({"sessionId":id})).await;
    println!(
        "phase 2  model_settings_error = {:?}",
        report.model_settings_error
    );
    println!("phase 2  report.issues        = {:?}", report.issues);
    println!(
        "phase 2  has_available_route  = {}",
        runtime.has_available_route()
    );
    println!("phase 2  session.models       = {catalog}");
    let providers = rpc(&host, RpcMethod::LlmProviders, json!({})).await;
    println!("phase 2  llm.providers        = {providers}");

    // The registry is healthy -- the provider and model are both live.
    assert!(
        runtime.has_available_route(),
        "no credential or refresh failure here"
    );
    assert_eq!(providers["providers"][0]["active"], json!(true));
    assert_eq!(providers["providers"][0]["declared"], json!(true));
    // The stored window was clamped onto what the model now advertises, so the
    // composer keeps working instead of blocking on a stale snapshot.
    assert_eq!(
        catalog["current"]["contextWindowTokens"],
        json!(16384),
        "the stale selection was clamped: {catalog}"
    );
    assert_eq!(
        catalog["routable"],
        json!(true),
        "a healthy provider must not read as an unavailable model: {catalog}"
    );
    assert_eq!(catalog["failures"], json!([]));
    // And the repair is reported rather than silent.
    assert!(
        report
            .issues
            .iter()
            .any(|issue| issue.message.contains("context window 32768 -> 16384")),
        "the clamp is explained: {report:?}"
    );
}

#[tokio::test]
async fn repro_c_live_settings_edit_heals_without_a_restart() {
    let dir = TempDir::new();
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let (host, _runtime, report) =
        reported_fixture(&dir, Arc::new(TestCredentials::default()), store).await;
    assert!(report.model_settings_error.is_none(), "{report:?}");
    add(&host, profile("http://127.0.0.1:12345/v1")).await;
    rpc(
        &host,
        RpcMethod::CredentialsSet,
        json!({"ref":"XHARNESS_SETTINGS_TEST_KEY","value":"test-only-private-value"}),
    )
    .await;
    let created = rpc(&host, RpcMethod::SessionCreate, json!({"cwd":dir.0})).await;
    let id = created["sessionId"].as_str().unwrap().to_owned();
    rpc(
        &host,
        RpcMethod::SessionSelectModel,
        json!({"sessionId":id,"provider":"test-gateway","model":"coder","contextWindowTokens":32768}),
    )
    .await;

    rpc(
        &host,
        RpcMethod::SettingsMutate,
        json!({"ns":MODEL_SETTINGS_NAMESPACE,"expectedRevision":1,"ops":[{"op":"set",
            "path":["providers","test-gateway"],
            "value":json!({"displayName":"Test gateway","baseURL":"http://127.0.0.1:12345/v1",
                "api":"openai-completions","apiKeyEnv":"XHARNESS_SETTINGS_TEST_KEY",
                "models":[{"id":"coder","name":"Coding model","contextWindow":16384,"maxTokens":4096}]})}]}),
    )
    .await;

    // No restart, no manual re-selection: the next catalog load repairs it.
    let catalog = rpc(&host, RpcMethod::SessionModels, json!({"sessionId":id})).await;
    println!("live  session.models = {catalog}");
    assert_eq!(catalog["current"]["contextWindowTokens"], json!(16384));
    assert_eq!(catalog["routable"], json!(true), "{catalog}");
    let describe = rpc(&host, RpcMethod::HostDescribe, json!({})).await;
    assert!(
        describe["startupIssues"]
            .to_string()
            .contains("context window 32768 -> 16384"),
        "the live repair is reported too: {describe}"
    );
}

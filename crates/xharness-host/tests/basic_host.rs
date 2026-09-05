use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use async_trait::async_trait;
use futures::{stream, StreamExt};
use serde_json::{json, Value};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use xharness_api::{
    ApiBackend, ClientResponse, ClientResponseKind, RpcId, RpcMethod, RpcReceipt, RpcResult,
};
use xharness_core::{
    CapabilitySource, ContextError, ContextPolicy, ContextPolicyId, ContextRequest, ContextSurface,
    ContextWindowCapability, FinishReason, ModelProvider, ProviderError, ProviderEvent,
    ProviderRequest, ProviderStream, Role, SurfaceEdit, SurfaceEditKind, TokenUsage,
};
use xharness_host::{
    AgentRuntime, AgentRuntimeError, AgentTurnRequest, BasicHost, HostConfig, LoopAgentRuntime,
    ModelDescriptor, ModelReasoning, ModelReasoningEffort, ModelRoute, NoTools, PermissionPreset,
    RunningTurn, SessionToolFactory,
};
use xharness_tools::{ToolDefinition, ToolExecutor, ToolOutput, ToolRegistry, ToolSpec};

struct TextProvider;

#[async_trait]
impl ModelProvider for TextProvider {
    fn provider_name(&self) -> &str {
        "test"
    }

    fn model_name(&self) -> Option<&str> {
        Some("test-model")
    }

    async fn stream(
        &self,
        _request: ProviderRequest,
        _cancellation: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        Ok(Box::pin(stream::iter([
            Ok(ProviderEvent::TextDelta("hello from Rust".to_owned())),
            Ok(ProviderEvent::Completed {
                finish_reason: Some(FinishReason::Stop),
                usage: Some(TokenUsage {
                    input_tokens: 3,
                    output_tokens: 4,
                    ..TokenUsage::default()
                }),
                provider_items: Vec::new(),
            }),
        ])))
    }
}

#[derive(Default)]
struct CapturingProvider {
    requests: Arc<Mutex<Vec<ProviderRequest>>>,
}

#[async_trait]
impl ModelProvider for CapturingProvider {
    fn provider_name(&self) -> &str {
        "capture"
    }

    fn model_name(&self) -> Option<&str> {
        Some("capture-model")
    }

    async fn stream(
        &self,
        request: ProviderRequest,
        _cancellation: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        self.requests.lock().unwrap().push(request);
        Ok(Box::pin(stream::iter([
            Ok(ProviderEvent::TextDelta("projected".to_owned())),
            Ok(ProviderEvent::Completed {
                finish_reason: Some(FinishReason::Stop),
                usage: None,
                provider_items: Vec::new(),
            }),
        ])))
    }
}

struct CompactingPolicy;

struct GatedAdmissionRuntime {
    inner: LoopAgentRuntime,
    entered: Arc<AtomicBool>,
    release: Arc<Notify>,
    admitted_message_id: Arc<Mutex<Option<String>>>,
}

struct GatedPersistenceRuntime {
    inner: LoopAgentRuntime,
    entered: Arc<AtomicBool>,
    release: Arc<Notify>,
    persist_calls: Arc<Mutex<usize>>,
}

struct CatalogRuntime;

#[async_trait]
impl AgentRuntime for CatalogRuntime {
    fn has_available_route(&self) -> bool {
        true
    }

    fn can_route(&self, route: &ModelRoute) -> bool {
        let maximum = match (route.provider.as_str(), route.model.as_str()) {
            ("gpu-4080", "qwen-4080") if route.reasoning_effort.is_none() => 131_072,
            ("gpu-v100", "qwen-v100")
                if matches!(
                    route.reasoning_effort.as_deref(),
                    None | Some("high") | Some("max")
                ) =>
            {
                53_248
            }
            _ => 0,
        };
        maximum > 0
            && route
                .context_window_tokens
                .is_none_or(|selected| selected > 0 && selected <= maximum)
    }

    fn model_catalog(&self) -> Vec<ModelDescriptor> {
        vec![
            ModelDescriptor::new("gpu-4080", "RTX 4080", "qwen-4080", "Qwen · 4080")
                .with_context_window(ContextWindowCapability::reported(131_072)),
            ModelDescriptor::new("gpu-v100", "V100 Server", "qwen-v100", "Qwen · V100")
                .with_reasoning(
                    ModelReasoning::new(vec![
                        ModelReasoningEffort::new("high", "High")
                            .with_description("Balanced reasoning"),
                        ModelReasoningEffort::new("max", "Max"),
                    ])
                    .with_default("high"),
                )
                .with_context_window(ContextWindowCapability::reported(53_248)),
        ]
    }

    async fn start_turn(
        &self,
        _request: AgentTurnRequest,
    ) -> Result<Box<dyn RunningTurn>, AgentRuntimeError> {
        Err(AgentRuntimeError::Preparation {
            message: "catalog fixture does not execute turns".to_owned(),
        })
    }
}

#[async_trait]
impl AgentRuntime for GatedAdmissionRuntime {
    fn has_available_route(&self) -> bool {
        self.inner.has_available_route()
    }

    fn can_route(&self, route: &ModelRoute) -> bool {
        self.inner.can_route(route)
    }

    async fn admit_turn(&self, request: AgentTurnRequest) -> Result<(), AgentRuntimeError> {
        *self.admitted_message_id.lock().unwrap() = request
            .messages
            .last()
            .and_then(|message| message.id.clone());
        self.entered.store(true, Ordering::SeqCst);
        self.release.notified().await;
        Ok(())
    }

    async fn start_turn(
        &self,
        request: AgentTurnRequest,
    ) -> Result<Box<dyn RunningTurn>, AgentRuntimeError> {
        self.inner.start_turn(request).await
    }
}

#[async_trait]
impl AgentRuntime for GatedPersistenceRuntime {
    fn has_available_route(&self) -> bool {
        self.inner.has_available_route()
    }

    fn can_route(&self, route: &ModelRoute) -> bool {
        self.inner.can_route(route)
    }

    async fn persist_session_events(
        &self,
        _session_id: &str,
        _cwd: &str,
        _events: Vec<xharness_session::SessionEvent>,
    ) -> Result<bool, AgentRuntimeError> {
        *self.persist_calls.lock().unwrap() += 1;
        self.entered.store(true, Ordering::SeqCst);
        self.release.notified().await;
        Ok(false)
    }

    async fn start_turn(
        &self,
        request: AgentTurnRequest,
    ) -> Result<Box<dyn RunningTurn>, AgentRuntimeError> {
        self.inner.start_turn(request).await
    }
}

#[async_trait]
impl ContextPolicy for CompactingPolicy {
    async fn prepare(&self, request: ContextRequest) -> Result<ContextSurface, ContextError> {
        let mut messages = request
            .messages
            .iter()
            .filter(|message| message.role == Role::System)
            .cloned()
            .collect::<Vec<_>>();
        messages.push(xharness_core::AgentMessage::user("host projected context"));
        Ok(ContextSurface::transformed(
            ContextPolicyId::new("host-test", 1),
            request.messages.len(),
            messages,
            vec![SurfaceEdit::new(
                0,
                request.messages.len(),
                1,
                SurfaceEditKind::HistoryCompacted,
            )],
        ))
    }
}

struct Fixture {
    root: PathBuf,
    host: Arc<BasicHost>,
    invoked: HashSet<RpcMethod>,
    next_rpc: u64,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "xharness-host-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let mut config = HostConfig::new(&root);
        config.provider_id = "test".to_owned();
        config.provider_display_name = "Test Provider".to_owned();
        config.model_id = "test-model".to_owned();
        let host = BasicHost::new(config, Some(Arc::new(TextProvider)), Arc::new(NoTools));
        Self {
            root,
            host,
            invoked: HashSet::new(),
            next_rpc: 1,
        }
    }

    async fn call(&mut self, method: RpcMethod, payload: Value) -> RpcResult {
        self.invoked.insert(method);
        let rpc_id = RpcId::new(format!("rpc-{}", self.next_rpc));
        self.next_rpc += 1;
        self.host
            .call(rpc_id, method, payload, CancellationToken::new())
            .await
    }

    async fn value(&mut self, method: RpcMethod, payload: Value) -> Value {
        match self.call(method, payload).await {
            RpcResult::Success { value: Some(value) } => value,
            other => panic!("{method} did not return a value: {other:?}"),
        }
    }

    async fn wait_for_assistant(&mut self, session_id: &str) {
        for _ in 0..100 {
            let history = self
                .value(RpcMethod::SessionHistory, json!({"sessionId": session_id}))
                .await;
            if history["events"].as_array().is_some_and(|events| {
                events
                    .iter()
                    .any(|entry| entry["event"]["type"].as_str() == Some("assistant/message"))
            }) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("assistant reply did not settle");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn full_access_is_advertised_confirmed_once_and_applied_to_current_and_future_sessions() {
    let mut fx = Fixture::new();
    let root = fx.root.to_string_lossy().into_owned();
    let created = fx
        .value(RpcMethod::SessionCreate, json!({"cwd": root}))
        .await;
    let session_id = created["sessionId"].as_str().unwrap().to_owned();

    let history = fx
        .value(RpcMethod::SessionHistory, json!({"sessionId": session_id}))
        .await;
    assert_eq!(
        history["projections"]["values"]["permissions"]["currentValue"],
        "workspace-write"
    );

    let listed = fx
        .host
        .call_dynamic(
            RpcId::new("commands-list"),
            "commands/list",
            json!({"args": {"agentId": session_id}}),
            CancellationToken::new(),
        )
        .await
        .expect("commands/list is mounted");
    let RpcResult::Success {
        value: Some(listed),
    } = listed
    else {
        panic!("commands/list failed: {listed:?}");
    };
    assert_eq!(listed[0]["name"], "permission");
    assert_eq!(listed[1]["name"], "plan");

    let switched = fx
        .host
        .call_dynamic(
            RpcId::new("commands-execute"),
            "commands/execute",
            json!({
                "args": {
                    "agentId": session_id,
                    "line": "/permission danger-full-access",
                    "images": []
                }
            }),
            CancellationToken::new(),
        )
        .await
        .expect("commands/execute is mounted");
    let RpcResult::Success {
        value: Some(switched),
    } = switched
    else {
        panic!("permission switch failed: {switched:?}");
    };
    assert_eq!(switched["result"]["kind"], "success");

    let history = fx
        .value(RpcMethod::SessionHistory, json!({"sessionId": session_id}))
        .await;
    assert_eq!(
        history["projections"]["values"]["permissions"]["currentValue"],
        "danger-full-access"
    );
    let types = history["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["event"]["type"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        types,
        [
            "agent-preset/selected",
            "permission/preset",
            "sandbox/mode",
            "approval/policy",
            "command/run",
            "permission/preset",
            "sandbox/mode",
            "approval/policy",
            "command/done",
        ]
    );
    let sandbox_event = history["events"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|entry| entry["event"]["type"] == "sandbox/mode")
        .unwrap();
    assert!(sandbox_event["event"]["data"].get("enabled").is_none());
    assert_eq!(sandbox_event["event"]["data"]["mode"], "danger-full-access");

    let settings = fx.value(RpcMethod::SettingsDescribe, json!({})).await;
    let permission = settings["namespaces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["ns"] == "permission")
        .unwrap();
    assert_eq!(permission["value"]["defaultPreset"], "workspace-write");
    assert_eq!(
        permission["schema"]["refs"]["2"]["value"],
        "danger-full-access"
    );
    fx.value(
        RpcMethod::SettingsMutate,
        json!({
            "ns": "permission",
            "ops": [{"op": "set", "path": ["defaultPreset"], "value": "danger-full-access"}],
            "expectedRevision": permission["revision"],
        }),
    )
    .await;
    let second = fx
        .value(
            RpcMethod::SessionCreate,
            json!({
                "sessionId": "full-access-default",
                "cwd": root,
            }),
        )
        .await;
    let second_history = fx
        .value(
            RpcMethod::SessionHistory,
            json!({"sessionId": second["sessionId"]}),
        )
        .await;
    assert_eq!(
        second_history["projections"]["values"]["permissions"]["currentValue"],
        "danger-full-access"
    );
}

#[tokio::test]
async fn idle_plan_command_is_log_backed_and_unsupported_payloads_fail_without_flipping() {
    let mut fx = Fixture::new();
    let created = fx
        .value(
            RpcMethod::SessionCreate,
            json!({"cwd": fx.root.to_string_lossy()}),
        )
        .await;
    let session_id = created["sessionId"].as_str().unwrap().to_owned();

    let unsupported = fx
        .host
        .call_dynamic(
            RpcId::new("plan-message"),
            "commands/execute",
            json!({
                "args": {
                    "agentId": session_id,
                    "line": "/plan investigate first",
                    "images": [],
                }
            }),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let RpcResult::Success {
        value: Some(unsupported),
    } = unsupported
    else {
        panic!("plan command failed at transport level: {unsupported:?}");
    };
    assert_eq!(unsupported["result"]["kind"], "error");

    let enabled = fx
        .host
        .call_dynamic(
            RpcId::new("plan-on"),
            "commands/execute",
            json!({"args": {"agentId": session_id, "line": "/plan", "images": []}}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(enabled.is_ok());
    let history = fx
        .value(RpcMethod::SessionHistory, json!({"sessionId": session_id}))
        .await;
    assert_eq!(
        history["projections"]["values"]["plan"],
        json!({"active": true, "pending": false})
    );
    assert_eq!(
        history["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["event"]["type"] == "plan/mode")
            .count(),
        1
    );

    let rejected_off = fx
        .host
        .call_dynamic(
            RpcId::new("plan-off-image"),
            "commands/execute",
            json!({
                "args": {
                    "agentId": session_id,
                    "line": "/plan off",
                    "images": [{"type": "image", "data": "ignored"}],
                }
            }),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let RpcResult::Success {
        value: Some(rejected_off),
    } = rejected_off
    else {
        panic!("plan off command failed at transport level: {rejected_off:?}");
    };
    assert_eq!(rejected_off["result"]["kind"], "error");
    let snapshot = fx.host.snapshot().await;
    assert_eq!(snapshot["sessions"][0]["planActive"], true);
}

#[tokio::test]
async fn configured_cwd_is_always_available_as_the_boot_workspace() {
    let mut fx = Fixture::new();
    let listed = fx.value(RpcMethod::WorkspaceList, json!({})).await;
    let items = listed["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["workspaceId"], "workspace-default");
    let canonical_root = std::fs::canonicalize(&fx.root).unwrap();
    assert_eq!(items[0]["path"], canonical_root.to_string_lossy().as_ref());

    let created = fx
        .value(RpcMethod::WorkspaceCreate, json!({"path": fx.root}))
        .await;
    assert_eq!(created["created"], false);
    assert_eq!(created["workspace"]["workspaceId"], "workspace-default");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_injects_the_configured_context_policy_into_each_turn() {
    let root = std::env::temp_dir().join(format!("xharness-host-context-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let mut config = HostConfig::new(&root);
    config.provider_id = "capture".to_owned();
    config.model_id = "capture-model".to_owned();
    let provider = Arc::new(CapturingProvider::default());
    let host = BasicHost::new_with_context_policy(
        config,
        Some(provider.clone()),
        Arc::new(NoTools),
        Arc::new(CompactingPolicy),
    );

    let created = host
        .call(
            RpcId::new("context-create"),
            RpcMethod::SessionCreate,
            json!({"cwd": root}),
            CancellationToken::new(),
        )
        .await;
    let session_id = match created {
        RpcResult::Success { value: Some(value) } => {
            value["sessionId"].as_str().unwrap().to_owned()
        }
        other => panic!("create failed: {other:?}"),
    };
    assert!(host
        .call(
            RpcId::new("context-prompt"),
            RpcMethod::SessionPrompt,
            json!({
                "sessionId": session_id,
                "mode": "queue",
                "content": [{"type": "text", "text": "full host history"}],
            }),
            CancellationToken::new(),
        )
        .await
        .is_ok());

    for _ in 0..100 {
        if !provider.requests.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    {
        let requests = provider.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].messages[0].role, Role::System);
        assert_eq!(requests[0].messages[1].content, "host projected context");
    }

    let snapshot = host.snapshot().await;
    assert_eq!(
        snapshot["sessions"][0]["messages"][0]["content"],
        "full host history"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn selected_preset_and_plan_policy_reach_the_provider_as_versioned_system_prompt() {
    let root = std::env::temp_dir().join(format!("xharness-host-prompt-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("AGENTS.md"),
        concat!(
            "# Repository instructions\n\nDo not promote this whole file.\n\n",
            "<!-- XHARNESS:USER-MEMORY:BEGIN -->\n",
            "## XHarness 持久目标\n\n- 发布到东京\n",
            "<!-- XHARNESS:USER-MEMORY:END -->\n",
        ),
    )
    .unwrap();
    let mut config = HostConfig::new(&root);
    config.provider_id = "capture".to_owned();
    config.model_id = "capture-model".to_owned();
    let provider = Arc::new(CapturingProvider::default());
    let host = BasicHost::new(config, Some(provider.clone()), Arc::new(NoTools));

    let created = host
        .call(
            RpcId::new("prompt-create"),
            RpcMethod::SessionCreate,
            json!({"cwd": root}),
            CancellationToken::new(),
        )
        .await;
    let session_id = match created {
        RpcResult::Success { value: Some(value) } => {
            value["sessionId"].as_str().unwrap().to_owned()
        }
        other => panic!("create failed: {other:?}"),
    };
    let selected = host
        .call_dynamic(
            RpcId::new("prompt-plan"),
            "commands/execute",
            json!({"args": {"agentId": session_id, "line": "/plan", "images": []}}),
            CancellationToken::new(),
        )
        .await
        .expect("plan command is mounted");
    assert!(matches!(selected, RpcResult::Success { .. }));

    assert!(host
        .call(
            RpcId::new("prompt-run"),
            RpcMethod::SessionPrompt,
            json!({
                "sessionId": session_id,
                "mode": "queue",
                "content": [{"type": "text", "text": "show the exact prompt"}],
            }),
            CancellationToken::new(),
        )
        .await
        .is_ok());

    for _ in 0..100 {
        if !provider.requests.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].messages[0].role, Role::System);
    let system = &requests[0].messages[0].content;
    assert!(system.contains("You are a coding agent."));
    assert!(system.contains("workspace-write isolation"));
    assert!(system.contains("continue only the needed page with next_cursor"));
    assert!(system.contains("Once the evidence is sufficient, answer directly."));
    assert!(system.contains("bash with run_in_background=true"));
    assert!(system.contains("Do not emulate managed jobs with shell &"));
    assert!(system.contains("Plan mode is active."));
    assert!(system.contains("User-approved persistent goals for this workspace:"));
    assert!(system.contains("发布到东京"));
    assert!(!system.contains("Do not promote this whole file."));
    assert_eq!(requests[0].messages[1].content, "show the exact prompt");
    drop(requests);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn unroutable_session_model_is_rejected_before_prompt_queueing() {
    let root = std::env::temp_dir().join(format!("xharness-host-route-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let mut config = HostConfig::new(&root);
    config.provider_id = "capture".to_owned();
    config.model_id = "capture-model".to_owned();
    let provider = Arc::new(CapturingProvider::default());
    let host = BasicHost::new(config, Some(provider.clone()), Arc::new(NoTools));
    let created = host
        .call(
            RpcId::new("route-create"),
            RpcMethod::SessionCreate,
            json!({"cwd": root}),
            CancellationToken::new(),
        )
        .await;
    let session_id = match created {
        RpcResult::Success { value: Some(value) } => {
            value["sessionId"].as_str().unwrap().to_owned()
        }
        other => panic!("create failed: {other:?}"),
    };
    let selection = host
        .call(
            RpcId::new("route-select"),
            RpcMethod::SessionSelectModel,
            json!({
                "sessionId": session_id,
                "provider": "capture",
                "model": "not-routable",
            }),
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(
        selection,
        RpcResult::Failure {
            error: xharness_api::RpcError {
                code: xharness_api::RpcErrorCode::ModelUnavailable,
                ..
            }
        }
    ));
    assert!(provider.requests.lock().unwrap().is_empty());
    let snapshot = host.snapshot().await;
    assert_eq!(snapshot["sessions"][0]["running"], false);
    assert_eq!(snapshot["sessions"][0]["model"]["model"], "capture-model");
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn web_model_catalog_exposes_and_selects_multiple_runtime_routes() {
    let root = std::env::temp_dir().join(format!("xharness-host-catalog-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let mut config = HostConfig::new(&root);
    config.provider_id = "gpu-4080".to_owned();
    config.provider_display_name = "RTX 4080".to_owned();
    config.model_id = "qwen-4080".to_owned();
    let host = BasicHost::with_agent_runtime(config, Arc::new(CatalogRuntime));

    let providers = host
        .call(
            RpcId::new("catalog-providers"),
            RpcMethod::LlmProviders,
            json!({}),
            CancellationToken::new(),
        )
        .await;
    let providers = match providers {
        RpcResult::Success { value: Some(value) } => value,
        other => panic!("provider catalog failed: {other:?}"),
    };
    assert_eq!(providers["providers"].as_array().unwrap().len(), 2);
    assert_eq!(providers["providers"][1]["provider"], "gpu-v100");

    let models = host
        .call(
            RpcId::new("catalog-models"),
            RpcMethod::LlmModels,
            json!({}),
            CancellationToken::new(),
        )
        .await;
    let models = match models {
        RpcResult::Success { value: Some(value) } => value,
        other => panic!("model catalog failed: {other:?}"),
    };
    assert_eq!(models["groups"].as_array().unwrap().len(), 2);
    assert_eq!(models["groups"][1]["models"][0]["id"], "qwen-v100");
    assert_eq!(models["groups"][1]["models"][0]["contextWindow"], 53_248);
    assert_eq!(
        models["groups"][1]["models"][0]["contextWindowCapability"]["providerLimit"]["source"],
        serde_json::to_value(CapabilitySource::ProviderReported).unwrap()
    );
    assert_eq!(
        models["groups"][1]["models"][0]["contextWindowSource"],
        serde_json::to_value(CapabilitySource::ProviderReported).unwrap()
    );
    assert_eq!(
        models["groups"][1]["models"][0]["reasoning"]["defaultEffort"],
        "high"
    );
    assert_eq!(
        models["groups"][1]["models"][0]["reasoning"]["efforts"][0]["description"],
        "Balanced reasoning"
    );

    let created = host
        .call(
            RpcId::new("catalog-create"),
            RpcMethod::SessionCreate,
            json!({"cwd": root}),
            CancellationToken::new(),
        )
        .await;
    let session_id = match created {
        RpcResult::Success { value: Some(value) } => {
            value["sessionId"].as_str().unwrap().to_owned()
        }
        other => panic!("session create failed: {other:?}"),
    };
    let selected_default = host
        .call(
            RpcId::new("catalog-select-default"),
            RpcMethod::SessionSelectModel,
            json!({
                "sessionId": session_id,
                "provider": "gpu-v100",
                "model": "qwen-v100",
            }),
            CancellationToken::new(),
        )
        .await;
    let selected_default = match selected_default {
        RpcResult::Success { value: Some(value) } => value,
        other => panic!("default model effort selection failed: {other:?}"),
    };
    assert_eq!(selected_default["selected"]["reasoningEffort"], "high");
    assert_eq!(selected_default["selected"]["contextWindowTokens"], 53_248);
    let selected = host
        .call(
            RpcId::new("catalog-select-max"),
            RpcMethod::SessionSelectModel,
            json!({
                "sessionId": session_id,
                "provider": "gpu-v100",
                "model": "qwen-v100",
                "reasoningEffort": "max",
                "contextWindowTokens": 32768,
            }),
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(selected, RpcResult::Success { .. }));
    let current = host
        .call(
            RpcId::new("catalog-current"),
            RpcMethod::SessionModels,
            json!({"sessionId": session_id}),
            CancellationToken::new(),
        )
        .await;
    let current = match current {
        RpcResult::Success { value: Some(value) } => value,
        other => panic!("session models failed: {other:?}"),
    };
    assert_eq!(current["current"]["provider"], "gpu-v100");
    assert_eq!(current["current"]["model"], "qwen-v100");
    assert_eq!(current["current"]["reasoningEffort"], "max");
    assert_eq!(current["current"]["contextWindowTokens"], 32_768);
    assert_eq!(current["routable"], true);

    let same_model_partial_update = host
        .call(
            RpcId::new("catalog-same-model-partial-update"),
            RpcMethod::SessionSelectModel,
            json!({
                "sessionId": session_id,
                "provider": "gpu-v100",
                "model": "qwen-v100",
                "reasoningEffort": "high",
            }),
            CancellationToken::new(),
        )
        .await;
    let same_model_partial_update = match same_model_partial_update {
        RpcResult::Success { value: Some(value) } => value,
        other => panic!("same-model partial update failed: {other:?}"),
    };
    assert_eq!(
        same_model_partial_update["selected"]["contextWindowTokens"], 32_768,
        "changing only reasoning on the same route must preserve its selected soft window"
    );

    let switched_to_larger_model = host
        .call(
            RpcId::new("catalog-switch-to-4080"),
            RpcMethod::SessionSelectModel,
            json!({
                "sessionId": session_id,
                "provider": "gpu-4080",
                "model": "qwen-4080",
            }),
            CancellationToken::new(),
        )
        .await;
    let switched_to_larger_model = match switched_to_larger_model {
        RpcResult::Success { value: Some(value) } => value,
        other => panic!("switching to the larger model failed: {other:?}"),
    };
    assert_eq!(
        switched_to_larger_model["selected"]["contextWindowTokens"], 131_072,
        "a model switch must materialize the destination maximum instead of inheriting 32K"
    );

    let switched_to_smaller_model = host
        .call(
            RpcId::new("catalog-switch-back-to-v100"),
            RpcMethod::SessionSelectModel,
            json!({
                "sessionId": session_id,
                "provider": "gpu-v100",
                "model": "qwen-v100",
            }),
            CancellationToken::new(),
        )
        .await;
    let switched_to_smaller_model = match switched_to_smaller_model {
        RpcResult::Success { value: Some(value) } => value,
        other => panic!("switching back to the smaller model failed: {other:?}"),
    };
    assert_eq!(
        switched_to_smaller_model["selected"]["contextWindowTokens"], 53_248,
        "a model switch must never carry the previous model's 131K window into a 53K route"
    );
    assert_eq!(
        switched_to_smaller_model["selected"]["reasoningEffort"],
        "high"
    );

    let rejected = host
        .call(
            RpcId::new("catalog-select-unsupported-effort"),
            RpcMethod::SessionSelectModel,
            json!({
                "sessionId": session_id,
                "provider": "gpu-v100",
                "model": "qwen-v100",
                "reasoningEffort": "ultra",
            }),
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(
        rejected,
        RpcResult::Failure {
            error: xharness_api::RpcError {
                code: xharness_api::RpcErrorCode::ModelUnavailable,
                ..
            }
        }
    ));
    let rejected_context = host
        .call(
            RpcId::new("catalog-select-oversized-context"),
            RpcMethod::SessionSelectModel,
            json!({
                "sessionId": session_id,
                "provider": "gpu-v100",
                "model": "qwen-v100",
                "reasoningEffort": "max",
                "contextWindowTokens": 53249,
            }),
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(
        rejected_context,
        RpcResult::Failure {
            error: xharness_api::RpcError {
                code: xharness_api::RpcErrorCode::ModelUnavailable,
                ..
            }
        }
    ));
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_prompt_waits_for_runtime_admission_and_passes_the_rpc_message_id() {
    let root = std::env::temp_dir().join(format!("xharness-host-admission-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let mut config = HostConfig::new(&root);
    config.provider_id = "test".to_owned();
    config.model_id = "test-model".to_owned();
    let entered = Arc::new(AtomicBool::new(false));
    let release = Arc::new(Notify::new());
    let admitted_message_id = Arc::new(Mutex::new(None));
    let runtime = Arc::new(GatedAdmissionRuntime {
        inner: LoopAgentRuntime::new(
            "test",
            "test-model",
            Some(Arc::new(TextProvider)),
            Arc::new(NoTools),
            Arc::new(xharness_core::IdentityContextPolicy),
        ),
        entered: Arc::clone(&entered),
        release: Arc::clone(&release),
        admitted_message_id: Arc::clone(&admitted_message_id),
    });
    let host = BasicHost::with_agent_runtime(config, runtime);
    let created = host
        .call(
            RpcId::new("admission-create"),
            RpcMethod::SessionCreate,
            json!({"cwd": root}),
            CancellationToken::new(),
        )
        .await;
    let session_id = match created {
        RpcResult::Success { value: Some(value) } => {
            value["sessionId"].as_str().unwrap().to_owned()
        }
        other => panic!("create failed: {other:?}"),
    };

    let prompt_host = Arc::clone(&host);
    let prompt = tokio::spawn(async move {
        prompt_host
            .call(
                RpcId::new("admission-prompt"),
                RpcMethod::SessionPrompt,
                json!({
                    "sessionId": session_id,
                    "mode": "queue",
                    "content": [{"type": "text", "text": "persist before ack"}],
                }),
                CancellationToken::new(),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(1), async {
        while !entered.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("session.prompt never reached runtime admission");
    assert!(entered.load(Ordering::SeqCst));
    assert!(
        !prompt.is_finished(),
        "HTTP receipt escaped before admission"
    );
    assert_eq!(
        admitted_message_id.lock().unwrap().as_deref(),
        Some("admission-prompt")
    );

    release.notify_one();
    assert!(prompt.await.unwrap().is_ok());
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_named_session_create_waits_for_the_initial_event_flush() {
    let root =
        std::env::temp_dir().join(format!("xharness-host-create-fence-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let mut config = HostConfig::new(&root);
    config.provider_id = "test".to_owned();
    config.model_id = "test-model".to_owned();
    let entered = Arc::new(AtomicBool::new(false));
    let release = Arc::new(Notify::new());
    let persist_calls = Arc::new(Mutex::new(0));
    let runtime = Arc::new(GatedPersistenceRuntime {
        inner: LoopAgentRuntime::new(
            "test",
            "test-model",
            Some(Arc::new(TextProvider)),
            Arc::new(NoTools),
            Arc::new(xharness_core::IdentityContextPolicy),
        ),
        entered: Arc::clone(&entered),
        release: Arc::clone(&release),
        persist_calls: Arc::clone(&persist_calls),
    });
    let host = BasicHost::with_agent_runtime(config, runtime);
    let payload = json!({
        "sessionId": "durable-create",
        "cwd": root,
        "agentPreset": "coding",
    });

    let first_host = Arc::clone(&host);
    let first_payload = payload.clone();
    let first = tokio::spawn(async move {
        first_host
            .call(
                RpcId::new("create-first"),
                RpcMethod::SessionCreate,
                first_payload,
                CancellationToken::new(),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(1), async {
        while !entered.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("session.create never reached the persistence barrier");

    let second_host = Arc::clone(&host);
    let second = tokio::spawn(async move {
        second_host
            .call(
                RpcId::new("create-second"),
                RpcMethod::SessionCreate,
                payload,
                CancellationToken::new(),
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert!(
        !second.is_finished(),
        "idempotent create escaped before the first durable receipt"
    );

    release.notify_one();
    let first = first.await.unwrap();
    let second = second.await.unwrap();
    assert!(first.is_ok());
    assert_eq!(first, second);
    assert_eq!(*persist_calls.lock().unwrap(), 1);

    let snapshot = host.snapshot().await;
    let events = snapshot["sessions"][0]["events"]
        .as_array()
        .expect("session events");
    assert_eq!(
        events
            .iter()
            .filter_map(|event| event["type"].as_str())
            .collect::<Vec<_>>(),
        [
            "agent-preset/selected",
            "permission/preset",
            "sandbox/mode",
            "approval/policy",
        ]
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_prompt_retry_is_admitted_once_and_payload_reuse_conflicts() {
    let mut fx = Fixture::new();
    let created = fx
        .value(
            RpcMethod::SessionCreate,
            json!({"cwd": fx.root.to_string_lossy()}),
        )
        .await;
    let session_id = created["sessionId"].as_str().unwrap().to_owned();
    let payload = json!({
        "sessionId": session_id,
        "mode": "queue",
        "content": [{"type": "text", "text": "exactly once"}],
    });
    let first_host = Arc::clone(&fx.host);
    let second_host = Arc::clone(&fx.host);
    let first_payload = payload.clone();
    let second_payload = payload.clone();
    let (first, second) = tokio::join!(
        first_host.call(
            RpcId::new("same-prompt-rpc"),
            RpcMethod::SessionPrompt,
            first_payload,
            CancellationToken::new(),
        ),
        second_host.call(
            RpcId::new("same-prompt-rpc"),
            RpcMethod::SessionPrompt,
            second_payload,
            CancellationToken::new(),
        ),
    );
    assert!(matches!(first, RpcResult::Success { .. }));
    assert!(matches!(second, RpcResult::Success { .. }));
    fx.wait_for_assistant(&session_id).await;

    let conflict = fx
        .host
        .call(
            RpcId::new("same-prompt-rpc"),
            RpcMethod::SessionPrompt,
            json!({
                "sessionId": session_id,
                "mode": "queue",
                "content": [{"type": "text", "text": "must conflict"}],
            }),
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(
        conflict,
        RpcResult::Failure {
            error: xharness_api::RpcError {
                code: xharness_api::RpcErrorCode::SessionConflict,
                ..
            }
        }
    ));

    let history = fx
        .value(RpcMethod::SessionHistory, json!({"sessionId": session_id}))
        .await;
    assert_eq!(
        history["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["event"]["type"] == "user/message")
            .count(),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_upstream_rpc_has_baseline_behavior() {
    let mut fx = Fixture::new();

    fx.value(RpcMethod::HostDescribe, json!({})).await;
    fx.value(RpcMethod::HostPickDirectory, json!({})).await;
    fx.value(RpcMethod::HostListDirectory, json!({"path": fx.root}))
        .await;
    fx.value(
        RpcMethod::HostCreateDirectory,
        json!({"path": fx.root, "name": "created"}),
    )
    .await;
    let _ = fx
        .call(
            RpcMethod::HostOpenPath,
            json!({"path": fx.root.join("missing")}),
        )
        .await;

    fx.value(RpcMethod::WorkspaceList, json!({})).await;
    let workspace = fx
        .value(RpcMethod::WorkspaceCreate, json!({"path": fx.root}))
        .await;
    let workspace_id = workspace["workspace"]["workspaceId"]
        .as_str()
        .unwrap()
        .to_owned();
    fx.value(
        RpcMethod::WorkspaceRename,
        json!({"workspaceId": workspace_id, "title": "Fixture"}),
    )
    .await;
    fx.value(
        RpcMethod::WorkspaceInsertBefore,
        json!({"workspaceId": workspace_id}),
    )
    .await;

    fx.value(RpcMethod::AgentPresetList, json!({})).await;
    fx.value(RpcMethod::AgentPresetRead, json!({"agentPreset": "coding"}))
        .await;
    fx.value(
        RpcMethod::AgentPresetCopy,
        json!({"from": "coding", "agentPreset": "fixture"}),
    )
    .await;
    fx.value(
        RpcMethod::AgentPresetOpenDocument,
        json!({"agentPreset": "fixture"}),
    )
    .await;

    let created = fx
        .value(
            RpcMethod::SessionCreate,
            json!({"workspaceId": workspace_id, "agentPreset": "coding"}),
        )
        .await;
    let session_id = created["sessionId"].as_str().unwrap().to_owned();
    fx.value(RpcMethod::SessionList, json!({})).await;
    fx.value(RpcMethod::SessionModels, json!({"sessionId": session_id}))
        .await;
    fx.value(
        RpcMethod::SessionSelectModel,
        json!({"sessionId": session_id, "provider": "test", "model": "test-model"}),
    )
    .await;
    fx.value(
        RpcMethod::AgentPresetSelect,
        json!({"sessionId": session_id, "agentPreset": "fixture"}),
    )
    .await;
    fx.value(
        RpcMethod::SessionRename,
        json!({"sessionId": session_id, "title": "  Rust session  "}),
    )
    .await;
    let listed = fx.value(RpcMethod::SessionList, json!({})).await;
    let renamed = listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["sessionId"] == session_id)
        .expect("renamed session remains listed");
    assert_eq!(renamed["projections"]["values"]["title"], "Rust session");
    assert!(renamed["projections"]["values"]
        .get("sessionTitle")
        .is_none());
    fx.value(
        RpcMethod::SessionPrompt,
        json!({
            "sessionId": session_id,
            "mode": "queue",
            "content": [{"type": "text", "text": "hello"}],
            "clientTimeZone": "Asia/Shanghai",
        }),
    )
    .await;
    fx.wait_for_assistant(&session_id).await;
    fx.value(RpcMethod::SessionSearch, json!({"query": "hello"}))
        .await;
    let _ = fx
        .call(
            RpcMethod::SessionAttachment,
            json!({"sessionId": session_id, "attachmentId": "missing"}),
        )
        .await;
    let _ = fx
        .call(
            RpcMethod::SessionUpdateQueue,
            json!({"sessionId": session_id, "itemId": "missing", "action": {"kind": "remove"}}),
        )
        .await;
    fx.value(RpcMethod::SessionCancel, json!({"sessionId": session_id}))
        .await;

    let fork = fx
        .value(RpcMethod::SessionFork, json!({"sessionId": session_id}))
        .await;
    let child_id = fork["sessionId"].as_str().unwrap().to_owned();
    fx.value(
        RpcMethod::WorkspaceInsertSessionBefore,
        json!({"workspaceId": workspace_id, "sessionId": child_id}),
    )
    .await;
    fx.value(
        RpcMethod::SubagentList,
        json!({"parentSessionId": session_id}),
    )
    .await;
    fx.value(
        RpcMethod::SubagentHistory,
        json!({
            "parentSessionId": session_id,
            "childSessionId": child_id,
            "mode": "continuable",
        }),
    )
    .await;
    fx.value(
        RpcMethod::SubagentPrompt,
        json!({
            "parentSessionId": session_id,
            "childSessionId": child_id,
            "mode": "continuable",
            "content": [{"type": "text", "text": "child followup"}],
        }),
    )
    .await;
    fx.value(
        RpcMethod::SubagentInterrupt,
        json!({
            "parentSessionId": session_id,
            "childSessionId": child_id,
            "mode": "continuable",
        }),
    )
    .await;

    fx.value(RpcMethod::SkillList, json!({"sessionId": session_id}))
        .await;
    let goal = fx
        .value(
            RpcMethod::GoalCreate,
            json!({"sessionId": session_id, "objective": "ship it"}),
        )
        .await;
    let mut goal_ref = goal["ref"].clone();
    let edited = fx
        .value(
            RpcMethod::GoalEdit,
            json!({"sessionId": session_id, "ref": goal_ref, "maxGoalRounds": 8}),
        )
        .await;
    goal_ref = edited["ref"].clone();
    for (method, status) in [
        (RpcMethod::GoalPause, "paused"),
        (RpcMethod::GoalResume, "active"),
        (RpcMethod::GoalComplete, "complete"),
    ] {
        let response = fx
            .value(method, json!({"sessionId": session_id, "ref": goal_ref}))
            .await;
        goal_ref = response["ref"].clone();
        let _ = status;
    }
    fx.value(
        RpcMethod::GoalClear,
        json!({"sessionId": session_id, "ref": goal_ref}),
    )
    .await;

    let described_settings = fx.value(RpcMethod::SettingsDescribe, json!({})).await;
    let settings_namespaces = described_settings["namespaces"].as_array().unwrap();
    let onboarding_namespace = settings_namespaces
        .iter()
        .find(|namespace| namespace["ns"] == "ui-onboarding")
        .expect("settings describe includes the upstream onboarding namespace");
    assert_eq!(onboarding_namespace["applies"], "live");
    assert!(settings_namespaces
        .iter()
        .all(|namespace| { matches!(namespace["applies"].as_str(), Some("live" | "restart")) }));
    let onboarding = fx
        .value(
            RpcMethod::SettingsMutate,
            json!({
                "ns": "ui-onboarding",
                "ops": [{
                    "op": "set",
                    "path": ["welcomeNoticeVersion"],
                    "value": "2026-08-13.1"
                }],
                "expectedRevision": 0
            }),
        )
        .await;
    assert_eq!(onboarding["value"]["welcomeNoticeVersion"], "2026-08-13.1");
    fx.value(RpcMethod::SettingsOpenDocument, json!({})).await;
    let settings = fx
        .value(
            RpcMethod::SettingsUpdate,
            json!({"ns": "xharness", "patch": {"theme": "dark"}, "expectedRevision": 0}),
        )
        .await;
    let settings = fx
        .value(
            RpcMethod::SettingsMutate,
            json!({
                "ns": "xharness",
                "ops": [{"op": "set", "path": ["nested", "enabled"], "value": true}],
                "expectedRevision": settings["revision"],
            }),
        )
        .await;
    fx.value(
        RpcMethod::SettingsReplace,
        json!({"ns": "xharness", "section": {}, "expectedRevision": settings["revision"]}),
    )
    .await;

    fx.value(
        RpcMethod::CredentialsDescribe,
        json!({"refs": ["FIXTURE_API_KEY"]}),
    )
    .await;
    fx.value(
        RpcMethod::CredentialsSet,
        json!({"ref": "FIXTURE_API_KEY", "value": "secret"}),
    )
    .await;
    fx.value(
        RpcMethod::CredentialsUnset,
        json!({"ref": "FIXTURE_API_KEY"}),
    )
    .await;
    fx.value(RpcMethod::LlmProviders, json!({})).await;
    fx.value(RpcMethod::LlmModels, json!({})).await;
    fx.value(
        RpcMethod::LlmDiscoverModels,
        json!({"settingsNs": "xharness"}),
    )
    .await;

    fx.value(
        RpcMethod::WorkspaceArchiveSession,
        json!({"sessionId": child_id}),
    )
    .await;
    fx.value(
        RpcMethod::AgentPresetRemove,
        json!({"agentPreset": "fixture"}),
    )
    .await;
    fx.value(
        RpcMethod::WorkspaceDelete,
        json!({"workspaceId": workspace_id}),
    )
    .await;

    let receipt = fx
        .host
        .respond(ClientResponse {
            kind: ClientResponseKind::ClientResponse,
            rpc_id: RpcId::new("not-pending"),
            result: RpcResult::success(json!({})),
        })
        .await;
    assert!(matches!(receipt, RpcReceipt::Rejected { .. }));
    let export = fx
        .host
        .export_session(&session_id, CancellationToken::new())
        .await
        .unwrap();
    assert!(export.bytes.starts_with(b"{"));

    assert_eq!(fx.invoked.len(), RpcMethod::ALL.len());
    assert!(RpcMethod::ALL
        .iter()
        .all(|method| fx.invoked.contains(method)));
}

struct ToolProvider;

#[async_trait]
impl ModelProvider for ToolProvider {
    async fn stream(
        &self,
        request: ProviderRequest,
        _cancellation: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let events = if request.step == 1 {
            vec![
                Ok(ProviderEvent::ToolCallDelta {
                    index: 0,
                    id: "provider-call".to_owned(),
                    name: "gated".to_owned(),
                    arguments_delta: "{}".to_owned(),
                }),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::ToolCalls),
                    usage: None,
                    provider_items: Vec::new(),
                }),
            ]
        } else {
            vec![
                Ok(ProviderEvent::TextDelta("approved".to_owned())),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::Stop),
                    usage: None,
                    provider_items: Vec::new(),
                }),
            ]
        };
        Ok(Box::pin(stream::iter(events)))
    }
}

struct OneTool {
    executed: Arc<AtomicBool>,
}

#[async_trait]
impl SessionToolFactory for OneTool {
    async fn executor(
        &self,
        _session_id: &str,
        _cwd: &str,
        _permission: PermissionPreset,
    ) -> Result<ToolExecutor, String> {
        let executed = Arc::clone(&self.executed);
        let registry = Arc::new(ToolRegistry::new());
        registry
            .register(
                ToolSpec::new(
                    ToolDefinition::new(
                        "gated",
                        "approval test",
                        json!({"type": "object", "properties": {}}),
                    ),
                    move |_context| {
                        let executed = Arc::clone(&executed);
                        async move {
                            executed.store(true, Ordering::SeqCst);
                            Ok(ToolOutput::text("ok"))
                        }
                    },
                )
                .requiring_approval(true),
            )
            .await
            .map_err(|error| error.to_string())?;
        Ok(ToolExecutor::new(registry))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn web_response_resumes_a_real_tool_approval() {
    let root = std::env::temp_dir().join(format!("xharness-approval-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let mut config = HostConfig::new(&root);
    config.provider_id = "test".to_owned();
    config.model_id = "tool-model".to_owned();
    let executed = Arc::new(AtomicBool::new(false));
    let host = BasicHost::new(
        config,
        Some(Arc::new(ToolProvider)),
        Arc::new(OneTool {
            executed: Arc::clone(&executed),
        }),
    );
    let created = host
        .call(
            RpcId::new("create"),
            RpcMethod::SessionCreate,
            json!({"cwd": root}),
            CancellationToken::new(),
        )
        .await;
    let session_id = match created {
        RpcResult::Success { value: Some(value) } => {
            value["sessionId"].as_str().unwrap().to_owned()
        }
        other => panic!("create failed: {other:?}"),
    };
    let mut mux = host.mux_events();
    let prompt = host
        .call(
            RpcId::new("prompt"),
            RpcMethod::SessionPrompt,
            json!({
                "sessionId": session_id,
                "mode": "queue",
                "content": [{"type": "text", "text": "run it"}],
            }),
            CancellationToken::new(),
        )
        .await;
    assert!(prompt.is_ok());

    let approval = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let frame = mux.next().await.expect("mux stayed open");
            if frame.payload["type"] == "approval/requested" {
                break frame;
            }
        }
    })
    .await
    .expect("approval frame timed out");
    let receipt = host
        .respond(ClientResponse {
            kind: ClientResponseKind::ClientResponse,
            rpc_id: approval.rpc_id,
            result: RpcResult::success(json!({
                "sessionId": session_id,
                "approvalId": approval.payload["approvalId"],
                "outcome": "allowed-once",
            })),
        })
        .await;
    assert_eq!(receipt, RpcReceipt::Accepted);
    tokio::time::timeout(Duration::from_secs(2), async {
        while !executed.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("approved tool was not executed");
    let _ = std::fs::remove_dir_all(root);
}

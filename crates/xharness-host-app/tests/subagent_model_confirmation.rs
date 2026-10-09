//! Production NativeToolFactory wiring, not a replacement test factory.
//! This fails if native/full-access registration ever drops the model guard.
use async_trait::async_trait;
use futures::{stream, StreamExt};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use xharness_agent::MemoryLeaseManager;
use xharness_api::{ApiBackend, ClientResponse, ClientResponseKind, RpcId, RpcMethod, RpcReceipt};
use xharness_core::{
    FinishReason, IdentityContextPolicy, ModelProvider, ProviderError, ProviderEvent,
    ProviderRequest, ProviderStream,
};
use xharness_host::{
    AgentRuntime, BasicHost, DurableLoopAgentRuntime, HostConfig, ModelDescriptor, ModelReasoning,
    ModelReasoningEffort, ModelRegistry, ModelRoute, RegisteredModel,
};
use xharness_host_app::NativeToolFactory;
use xharness_session::{EventData, MemorySessionStore, Store, TurnEndReason};
use xharness_web::WebRuntime;

struct Workspace(PathBuf);
impl Workspace {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xharness-native-model-confirm-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(std::fs::canonicalize(path).unwrap())
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct ParentModel(AtomicBool);
#[async_trait]
impl ModelProvider for ParentModel {
    async fn stream(
        &self,
        request: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let events = if !self.0.swap(true, Ordering::SeqCst) {
            assert!(request.tools.iter().any(|t| t.name == "agent"));
            vec![
                Ok(ProviderEvent::ToolCallDelta { index: 0, id: "native-delegate".into(), name: "agent".into(), arguments_delta: json!({"action":"start","task":"independent read-only review","model":"small","reasoning_effort":"vendor-3"}).to_string() }),
                Ok(ProviderEvent::Completed { finish_reason: Some(FinishReason::ToolCalls), usage: None, provider_items: vec![] }),
            ]
        } else {
            done()
        };
        Ok(Box::pin(stream::iter(events)))
    }
}
#[derive(Default)]
struct ChildModel(Mutex<Vec<ProviderRequest>>);
#[async_trait]
impl ModelProvider for ChildModel {
    async fn stream(
        &self,
        request: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        self.0.lock().unwrap().push(request);
        Ok(Box::pin(stream::iter(done())))
    }
}
fn done() -> Vec<Result<ProviderEvent, ProviderError>> {
    vec![
        Ok(ProviderEvent::TextDelta("done".into())),
        Ok(ProviderEvent::Completed {
            finish_reason: Some(FinishReason::Stop),
            usage: None,
            provider_items: vec![],
        }),
    ]
}

#[tokio::test]
async fn native_full_access_preserves_manual_confirmation_and_routes_only_after_the_user_answers() {
    let workspace = Workspace::new();
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let parent = Arc::new(ParentModel(AtomicBool::new(false)));
    let child = Arc::new(ChildModel::default());
    let mut models = ModelRegistry::new();
    models
        .register(RegisteredModel::new(
            ModelDescriptor::new("test", "Test", "main", "Main").with_reasoning(
                ModelReasoning::new(vec![ModelReasoningEffort::new("high", "High")])
                    .with_default("high"),
            ),
            parent,
        ))
        .unwrap();
    models
        .register(RegisteredModel::new(
            ModelDescriptor::new("test", "Test", "small", "Small").with_reasoning(
                ModelReasoning::new(vec![
                    ModelReasoningEffort::new("off", "Off"),
                    ModelReasoningEffort::new("vendor-3", "Custom"),
                ])
                .with_default("off"),
            ),
            child.clone(),
        ))
        .unwrap();
    let tools = NativeToolFactory::new(WebRuntime::default());
    let runtime = Arc::new(
        DurableLoopAgentRuntime::from_registry(
            ModelRoute::new("test", "main"),
            models,
            tools.clone(),
            Arc::new(IdentityContextPolicy),
            store.clone(),
            Arc::new(MemoryLeaseManager::default()),
            64,
        )
        .unwrap(),
    );
    let mut config = HostConfig::new(&workspace.0);
    config.provider_id = "test".into();
    config.model_id = "main".into();
    config.reasoning_effort = Some("high".into());
    let host = BasicHost::with_agent_runtime(config, runtime.clone());
    tools.bind_agent_host(&host).unwrap();
    assert!(host
        .call(
            RpcId::new("create"),
            RpcMethod::SessionCreate,
            json!({"sessionId":"parent","workspaceId":"workspace-default"}),
            CancellationToken::new()
        )
        .await
        .is_ok());
    assert!(host.call_dynamic(RpcId::new("full-access"), "commands/execute", json!({"args":{"agentId":"parent","line":"/permission danger-full-access","images":[]}}), CancellationToken::new()).await.unwrap().is_ok());
    let mut events = host.mux_events();
    assert!(host.call(RpcId::new("request"), RpcMethod::SessionPrompt, json!({"sessionId":"parent","mode":"queue","content":[{"type":"text","text":"Use the configured small model at vendor-3 for an independent read-only review; ask me to confirm the switch."}]}), CancellationToken::new()).await.is_ok());
    let approval = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let frame = events.next().await.unwrap();
            if frame.payload["type"] == "approval/requested" {
                break frame;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(approval.payload["toolName"], "agent");
    assert_eq!(approval.payload["reviewing"], false);
    assert!(approval.payload["reason"]
        .as_str()
        .unwrap()
        .contains("test/small"));
    assert!(approval.payload["reason"]
        .as_str()
        .unwrap()
        .contains("vendor-3"));
    assert!(child.0.lock().unwrap().is_empty());
    assert_eq!(
        host.snapshot().await["sessions"].as_array().unwrap().len(),
        1
    );
    assert_eq!(host.respond(ClientResponse { kind: ClientResponseKind::ClientResponse, rpc_id: approval.rpc_id, result: xharness_api::RpcResult::Success { value: Some(json!({"sessionId":"parent","approvalId":approval.payload["approvalId"],"outcome":"allowed-once"})) } }).await, RpcReceipt::Accepted);
    let child_id = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let headers = store.list_headers().await.unwrap();
            if let Some(id) = headers
                .into_iter()
                .map(|header| header.id)
                .find(|id| id != "parent")
            {
                if let Some(session) = store.load(&id).await.unwrap() {
                    if session.events().iter().any(|e| {
                        matches!(
                            e.data(),
                            EventData::TurnEnd {
                                reason: TurnEndReason::Completed,
                                ..
                            }
                        )
                    }) {
                        break id;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let session = store.load(&child_id).await.unwrap().unwrap();
    assert!(session.events().iter().any(|e| matches!(e.data(), EventData::SessionModelSelected { model, reasoning_effort: Some(effort), context_window_tokens: None, .. } if model == "small" && effort == "vendor-3")));
    assert_eq!(child.0.lock().unwrap().len(), 1);
    assert_eq!(
        child.0.lock().unwrap()[0].reasoning_effort.as_deref(),
        Some("vendor-3")
    );
    runtime.shutdown(Duration::from_secs(2)).await;
    host.stop_background_listeners();
}

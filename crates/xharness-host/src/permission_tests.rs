use crate::{
    BasicHost, DurableLoopAgentRuntime, HostConfig, NoTools, PermissionPreset, SessionToolFactory,
};
use async_trait::async_trait;
use futures::{stream, StreamExt};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, Semaphore};
use tokio_util::sync::CancellationToken;
use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
use xharness_core::{
    FinishReason, IdentityContextPolicy, ModelProvider, ProviderError, ProviderEvent,
    ProviderRequest, ProviderStream,
};
use xharness_session::{MemorySessionStore, Store};
use xharness_tools::{ToolExecutor, ToolRegistry};

struct PausedModel {
    requests: mpsc::UnboundedSender<ProviderRequest>,
    release: Arc<Semaphore>,
}
#[async_trait]
impl ModelProvider for PausedModel {
    async fn stream(
        &self,
        request: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        self.requests.send(request).unwrap();
        let release = self.release.clone();
        Ok(Box::pin(
            stream::once(async move {
                release.acquire().await.unwrap().forget();
                Ok(ProviderEvent::TextDelta("ok".into()))
            })
            .chain(stream::iter([Ok(ProviderEvent::Completed {
                finish_reason: Some(FinishReason::Stop),
                usage: None,
                provider_items: vec![],
            })])),
        ))
    }
}
#[derive(Default)]
struct CaptureTools(Mutex<Vec<PermissionPreset>>);
#[async_trait]
impl SessionToolFactory for CaptureTools {
    async fn executor(
        &self,
        _: &str,
        _: &str,
        permission: PermissionPreset,
    ) -> Result<ToolExecutor, String> {
        self.0.lock().unwrap().push(permission);
        Ok(ToolExecutor::new(Arc::new(ToolRegistry::new())))
    }
}
async fn call(host: &BasicHost, id: &str, method: RpcMethod, payload: Value) -> Value {
    match host
        .call(RpcId::new(id), method, payload, CancellationToken::new())
        .await
    {
        RpcResult::Success { value: Some(v) } => v,
        other => panic!("{other:?}"),
    }
}
async fn select(host: &BasicHost, id: &str, preset: &str) -> Value {
    let r = host
        .call_dynamic(
            RpcId::new(id),
            "commands/execute",
            json!({"args":{"agentId":"p","line":format!("/permission {preset}"),"images":[]}}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    match r {
        RpcResult::Success { value: Some(v) } => v,
        other => panic!("{other:?}"),
    }
}
async fn view(host: &BasicHost) -> Value {
    call(
        host,
        "view",
        RpcMethod::SessionHistory,
        json!({"sessionId":"p"}),
    )
    .await["projections"]["values"]["permissions"]
        .clone()
}
async fn next(rx: &mut mpsc::UnboundedReceiver<ProviderRequest>) -> ProviderRequest {
    tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap()
}
fn system(r: &ProviderRequest) -> String {
    r.messages
        .iter()
        .filter(|m| m.role == xharness_core::Role::System)
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn running_permission_selection_uses_latest_at_next_real_turn_in_both_runtimes() {
    for durable in [false, true] {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let release = Arc::new(Semaphore::new(0));
        let model = Arc::new(PausedModel {
            requests: tx,
            release: release.clone(),
        });
        let tools = Arc::new(CaptureTools::default());
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        let mut config = HostConfig::new(std::env::temp_dir());
        config.provider_id = "test".into();
        config.model_id = "test".into();
        let host = if durable {
            let rt = Arc::new(DurableLoopAgentRuntime::new(
                "test",
                "test",
                Some(model),
                tools.clone(),
                Arc::new(IdentityContextPolicy),
                store.clone(),
                Arc::new(xharness_agent::MemoryLeaseManager::default()),
                1024,
            ));
            BasicHost::with_agent_runtime(config, rt)
        } else {
            BasicHost::new(config, Some(model), tools.clone())
        };
        call(
            &host,
            "create",
            RpcMethod::SessionCreate,
            json!({"sessionId":"p"}),
        )
        .await;
        call(
            &host,
            "first",
            RpcMethod::SessionPrompt,
            json!({"sessionId":"p","mode":"queue","content":[{"type":"text","text":"first"}]}),
        )
        .await;
        let first = next(&mut rx).await;
        assert!(system(&first).contains("workspace-write isolation"));
        // Queue BEFORE selecting: admission-time configuration must not stick.
        call(
            &host,
            "second",
            RpcMethod::SessionPrompt,
            json!({"sessionId":"p","mode":"queue","content":[{"type":"text","text":"second"}]}),
        )
        .await;
        for (id, preset) in [
            ("full1", "danger-full-access"),
            ("restricted", "workspace-write"),
            ("full2", "danger-full-access"),
        ] {
            assert_eq!(select(&host, id, preset).await["result"]["kind"], "success");
        }
        let pending = view(&host).await;
        assert_eq!(pending["currentValue"], "danger-full-access");
        assert_eq!(pending["activeValue"], "workspace-write");
        assert_eq!(pending["pending"], true);
        assert_eq!(
            *tools.0.lock().unwrap(),
            vec![PermissionPreset::WorkspaceWrite]
        );
        assert_eq!(
            select(&host, "invalid", "invalid").await["result"]["kind"],
            "error"
        );
        assert_eq!(view(&host).await["currentValue"], "danger-full-access");
        release.add_permits(1);
        let second = next(&mut rx).await;
        assert!(system(&second).contains("user selected danger-full-access"));
        assert!(!system(&second).contains("workspace-write isolation"));
        assert_eq!(
            *tools.0.lock().unwrap(),
            vec![
                PermissionPreset::WorkspaceWrite,
                PermissionPreset::DangerFullAccess
            ]
        );
        assert_eq!(view(&host).await["pending"], false);
        assert_eq!(view(&host).await["activeValue"], "danger-full-access");
        // Tightening is also deferred, never presented as revocation of a running executor.
        select(&host, "tighten", "workspace-write").await;
        assert_eq!(view(&host).await["activeValue"], "danger-full-access");
        release.add_permits(1);
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if !host.state.read().await.sessions["p"].running {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(view(&host).await["pending"], false);
        assert_eq!(view(&host).await["activeValue"], Value::Null);
        if durable {
            let restored = BasicHost::new(
                HostConfig::new(std::env::temp_dir()),
                None,
                Arc::new(NoTools),
            );
            restored.restore_from_store(store).await.unwrap();
            assert_eq!(view(&restored).await["currentValue"], "workspace-write");
            assert_eq!(view(&restored).await["pending"], false);
        }
        host.agent_runtime.shutdown(Duration::from_secs(2)).await;
    }
}

struct RejectPermissionRuntime;
#[async_trait]
impl crate::AgentRuntime for RejectPermissionRuntime {
    fn has_available_route(&self) -> bool {
        false
    }
    fn can_route(&self, _: &crate::ModelRoute) -> bool {
        false
    }
    async fn persist_session_events(
        &self,
        _: &str,
        _: &str,
        events: Vec<xharness_session::SessionEvent>,
    ) -> Result<bool, crate::AgentRuntimeError> {
        if events.iter().any(|e|matches!(e.data(),xharness_session::EventData::PermissionPreset{preset} if preset=="danger-full-access")){
   return Err(crate::AgentRuntimeError::Preparation{message:"injected permission write failure".into()});
  }
        Ok(false)
    }
    async fn start_turn(
        &self,
        _: crate::AgentTurnRequest,
    ) -> Result<Box<dyn crate::RunningTurn>, crate::AgentRuntimeError> {
        unreachable!()
    }
}
#[tokio::test]
async fn failed_permission_commit_does_not_change_selection_or_active_snapshot() {
    let host = BasicHost::with_agent_runtime(
        HostConfig::new(std::env::temp_dir()),
        Arc::new(RejectPermissionRuntime),
    );
    call(
        &host,
        "create",
        RpcMethod::SessionCreate,
        json!({"sessionId":"p"}),
    )
    .await;
    let before = view(&host).await;
    let result = host
        .call_dynamic(
            RpcId::new("fail"),
            "commands/execute",
            json!({"args":{"agentId":"p","line":"/permission danger-full-access","images":[]}}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(matches!(result, RpcResult::Failure { .. }));
    assert_eq!(view(&host).await, before);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permission_snapshot_and_selection_are_serialized_without_control_lock_deadlock() {
    let host = BasicHost::new(
        HostConfig::new(std::env::temp_dir()),
        None,
        Arc::new(NoTools),
    );
    call(
        &host,
        "create",
        RpcMethod::SessionCreate,
        json!({"sessionId":"p"}),
    )
    .await;
    host.state
        .write()
        .await
        .sessions
        .get_mut("p")
        .unwrap()
        .running = true;
    // An admission/control waiter must not stop a factory from preparing its turn.
    let gate = host.lock_admission("p").await;
    tokio::time::timeout(Duration::from_secs(1), host.capture_turn_permission("p"))
        .await
        .unwrap()
        .unwrap();
    drop(gate);
    for i in 0..24 {
        let target = if i % 2 == 0 {
            "danger-full-access"
        } else {
            "workspace-write"
        };
        let id = format!("race-{i}");
        let (captured, selected) = tokio::join!(
            host.capture_turn_permission("p"),
            select(&host, &id, target)
        );
        let (permission, prompt) = captured.unwrap();
        assert_eq!(selected["result"]["kind"], "success");
        assert_eq!(
            prompt.system().contains("workspace-write isolation"),
            permission == PermissionPreset::WorkspaceWrite
        );
        let v = view(&host).await;
        assert_eq!(v["currentValue"], target);
        assert_eq!(v["activeValue"], permission.as_str());
        assert_eq!(v["pending"], permission.as_str() != target);
        assert_eq!(
            host.state.read().await.sessions["p"].execution_permission(),
            permission,
            "children inherit active, not a pending escalation"
        );
    }
}

//! Offline public-SDK consumers exercising the real native actor/loop/store.
use async_trait::async_trait;
use futures::stream;
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::{Mutex, Notify};
use xharness_sdk::{
    execution::*, models::*, storage::*, tools::*, Error, Runtime, RuntimeBuilder, Turn,
};

static NEXT: AtomicU64 = AtomicU64::new(0);
const TIMEOUT: Duration = Duration::from_secs(10);
type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

struct Dir(PathBuf);
impl Dir {
    fn new() -> TestResult<Self> {
        let path = std::env::temp_dir().join(format!(
            "xharness-sdk-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path)?;
        Ok(Self(path))
    }
    fn builder(
        &self,
        provider: Arc<dyn ModelProvider>,
        tools: Arc<dyn SessionToolFactory>,
    ) -> TestResult<RuntimeBuilder> {
        let mut models = ModelRegistry::new();
        models.register(RegisteredModel::new(
            ModelDescriptor::new("offline", "Offline", "fixture", "Fixture"),
            provider,
        ))?;
        Ok(RuntimeBuilder::new(
            route(),
            models,
            tools,
            Arc::new(JsonlSessionStore::new(self.0.join("sessions"))?.for_runtime()),
            Arc::new(FileLeaseManager::new(self.0.join("leases"))?),
        ))
    }
    fn request(&self, session: &str, id: &str) -> AgentTurnRequest {
        AgentTurnRequest {
            session_id: session.into(),
            cwd: self.0.to_string_lossy().into_owned(),
            route: route(),
            permission: PermissionPreset::WorkspaceWrite,
            prompt: None,
            messages: vec![AgentMessage::user("你好，SDK 😀").with_id(id)],
            input_metadata: Some(json!({"kind":"sdk-fixture"})),
        }
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _temporary_fixture_cleanup = std::fs::remove_dir_all(&self.0);
    }
}
fn route() -> ModelRoute {
    ModelRoute::new("offline", "fixture")
}

#[derive(Default)]
struct Provider {
    calls: AtomicUsize,
    requests: Mutex<Vec<ProviderRequest>>,
    call_tool: bool,
    argument_key: Option<&'static str>,
    block: bool,
    entered: Notify,
}
#[async_trait]
impl ModelProvider for Provider {
    async fn stream(
        &self,
        request: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let first = request.step == 1;
        self.requests.lock().await.push(request);
        self.entered.notify_one();
        if self.block {
            return Ok(Box::pin(stream::pending()));
        }
        let events = if first && self.call_tool {
            vec![
                Ok(ProviderEvent::ToolCallDelta {
                    index: 0,
                    id: "offline-call".into(),
                    name: "echo".into(),
                    arguments_delta: json!({(self.argument_key.unwrap_or("value")):"工具 😀"})
                        .to_string(),
                }),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::ToolCalls),
                    usage: None,
                    provider_items: vec![],
                }),
            ]
        } else {
            vec![
                Ok(ProviderEvent::TextDelta("完成 😀".into())),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::Stop),
                    usage: None,
                    provider_items: vec![],
                }),
            ]
        };
        Ok(Box::pin(stream::iter(events)))
    }
}

#[derive(Default)]
struct EchoFactory {
    calls: Arc<AtomicUsize>,
    bindings: Mutex<Vec<(String, String, PermissionPreset)>>,
    version: String,
}
#[async_trait]
impl SessionToolFactory for EchoFactory {
    async fn executor(
        &self,
        session: &str,
        cwd: &str,
        permission: PermissionPreset,
    ) -> Result<ToolExecutor, String> {
        self.bindings
            .lock()
            .await
            .push((session.into(), cwd.into(), permission));
        // This tool only echoes a string. A filesystem/process factory must
        // enforce the supplied permission through its native policy pipeline.
        let registry = Arc::new(ToolRegistry::new());
        let calls = self.calls.clone();
        let field = if self.version == "v2" {
            "payload"
        } else {
            "value"
        };
        registry
            .register(ToolSpec::new(
                ToolDefinition::new(
                    "echo",
                    format!("echo {}", self.version),
                    json!({"type":"object","properties":{(field):{"type":"string"}},
                        "required":[field],"additionalProperties":false}),
                ),
                move |context| {
                    let calls = calls.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(ToolOutput::text(context.arguments[field].to_string()))
                    }
                },
            ))
            .await
            .map_err(|e| e.to_string())?;
        Ok(ToolExecutor::new(registry))
    }
}

async fn finish(turn: &mut Turn) -> TestResult<LoopResult> {
    Ok(tokio::time::timeout(TIMEOUT, async {
        while turn.next_event().await.is_some() {}
        turn.result().await
    })
    .await?)
}
async fn close(runtime: Runtime) -> TestResult {
    let report = tokio::time::timeout(TIMEOUT, runtime.shutdown(Duration::from_secs(3))).await?;
    assert!(report.is_graceful(), "{report:?}");
    Ok(())
}

#[tokio::test]
async fn build_is_inert_and_requires_a_configured_model() -> TestResult {
    let d = Dir::new()?;
    let p = Arc::new(Provider::default());
    let runtime = d.builder(p.clone(), Arc::new(NoTools))?.build()?;
    assert_eq!(p.calls.load(Ordering::SeqCst), 0);
    assert!(runtime.session("untouched").await?.is_none());
    runtime.create_session(SessionHeader::new("empty")).await?;
    assert!(runtime
        .session("empty")
        .await?
        .ok_or_else(|| std::io::Error::other("missing fixture value"))?
        .events()
        .is_empty());
    assert!(matches!(
        runtime.create_session(SessionHeader::new("empty")).await,
        Err(Error::Store(StoreError::AlreadyExists { .. }))
    ));
    close(runtime).await?;
    let invalid = RuntimeBuilder::new(
        route(),
        ModelRegistry::new(),
        Arc::new(NoTools),
        Arc::new(MemorySessionStore::default()),
        Arc::new(MemoryLeaseManager::default()),
    )
    .build();
    assert!(matches!(
        invalid,
        Err(Error::Models(
            ModelRegistryError::DefaultRouteUnavailable { .. }
        ))
    ));
    Ok(())
}

#[tokio::test]
async fn actual_model_tool_result_loop_uses_one_authoritative_journal() -> TestResult {
    let d = Dir::new()?;
    let p = Arc::new(Provider {
        call_tool: true,
        ..Provider::default()
    });
    let factory = Arc::new(EchoFactory::default());
    let runtime = d.builder(p.clone(), factory.clone())?.build()?;
    let mut turn = runtime.start_turn(d.request("tools", "input-one")).await?;
    assert_eq!(finish(&mut turn).await?.final_text, "完成 😀");
    assert_eq!(p.calls.load(Ordering::SeqCst), 2);
    assert_eq!(factory.calls.load(Ordering::SeqCst), 1);
    let seen = p.requests.lock().await;
    assert_eq!(seen[0].tools[0].name, "echo");
    assert_eq!(seen[0].tools[0].parameters["required"], json!(["value"]));
    assert!(seen[1]
        .messages
        .iter()
        .any(|m| m.role == Role::Tool && m.content.contains("工具 😀")));
    drop(seen);
    let session = runtime
        .session("tools")
        .await?
        .ok_or_else(|| std::io::Error::other("missing fixture value"))?;
    assert_eq!(session.events().iter().filter(|e| matches!(e.data(), EventData::UserMessage { message, .. } if message.id.as_deref() == Some("input-one"))).count(), 1);
    let binding = factory.bindings.lock().await[0].clone();
    assert_eq!(
        binding,
        (
            "tools".into(),
            d.0.to_string_lossy().into_owned(),
            PermissionPreset::WorkspaceWrite
        )
    );
    drop(turn);
    close(runtime).await?;
    let disk = JsonlSessionStore::new(d.0.join("sessions"))?;
    assert_eq!(
        disk.load("tools")
            .await?
            .ok_or_else(|| std::io::Error::other("missing fixture value"))?,
        session
    );
    Ok(())
}

#[tokio::test]
async fn queued_input_does_not_run_and_reopens_without_resending_or_duplicate_work() -> TestResult {
    let d = Dir::new()?;
    let p = Arc::new(Provider::default());
    let runtime = d.builder(p.clone(), Arc::new(NoTools))?.build()?;
    runtime.queue(d.request("recovery", "saved-input")).await?;
    runtime.queue(d.request("recovery", "saved-input")).await?;
    assert_eq!(p.calls.load(Ordering::SeqCst), 0);
    close(runtime).await?;
    let restored = d.builder(p.clone(), Arc::new(NoTools))?.build()?;
    let report = restored
        .resume_session(AgentSessionRequest {
            session_id: "recovery".into(),
            cwd: d.0.to_string_lossy().into_owned(),
            route: route(),
            permission: PermissionPreset::WorkspaceWrite,
            prompt: None,
        })
        .await?;
    assert_eq!(report.pending_turns, 1);
    let mut turn = restored
        .take_resumed_turn("recovery", "saved-input")
        .await?
        .ok_or_else(|| std::io::Error::other("missing fixture value"))?;
    assert_eq!(finish(&mut turn).await?.status, LoopStatus::Completed);
    assert!(restored
        .take_resumed_turn("recovery", "saved-input")
        .await?
        .is_none());
    assert_eq!(p.calls.load(Ordering::SeqCst), 1);
    drop(turn);
    close(restored).await?;
    Ok(())
}

#[tokio::test]
async fn invalid_inputs_and_model_routes_are_not_silently_executed() -> TestResult {
    let d = Dir::new()?;
    let p = Arc::new(Provider::default());
    let runtime = d.builder(p.clone(), Arc::new(NoTools))?.build()?;
    let mut missing_id = d.request("invalid", "id");
    missing_id.messages[0].id = None;
    assert!(matches!(
        runtime.start_turn(missing_id).await,
        Err(Error::Runtime(AgentRuntimeError::Preparation { .. }))
    ));
    let mut missing_model = d.request("invalid", "id");
    missing_model.route = ModelRoute::new("unconfigured", "other");
    assert!(matches!(
        runtime.start_turn(missing_model).await,
        Err(Error::Runtime(AgentRuntimeError::ModelUnavailable { .. }))
    ));
    assert_eq!(p.calls.load(Ordering::SeqCst), 0);
    assert!(runtime.session("invalid").await?.is_none());
    close(runtime).await?;
    Ok(())
}

struct Deny;
impl ExecutionGate for Deny {
    fn require_active(&self) -> Result<(), String> {
        Err("fixture paused".into())
    }
}

#[tokio::test]
async fn native_execution_gate_is_not_bypassed_by_sdk() -> TestResult {
    let d = Dir::new()?;
    let p = Arc::new(Provider::default());
    let runtime = d
        .builder(p.clone(), Arc::new(NoTools))?
        .execution_gate(Arc::new(Deny))
        .build()?;
    assert!(matches!(
        runtime.start_turn(d.request("paused", "id")).await,
        Err(Error::Runtime(AgentRuntimeError::Preparation { .. }))
    ));
    assert_eq!(p.calls.load(Ordering::SeqCst), 0);
    close(runtime).await?;
    Ok(())
}

#[tokio::test]
async fn explicit_cancel_settles_a_real_native_turn() -> TestResult {
    let d = Dir::new()?;
    let p = Arc::new(Provider {
        block: true,
        ..Provider::default()
    });
    let runtime = d.builder(p.clone(), Arc::new(NoTools))?.build()?;
    let mut turn = runtime.start_turn(d.request("cancel", "id")).await?;
    tokio::time::timeout(TIMEOUT, p.entered.notified()).await?;
    turn.cancel().await?;
    assert_eq!(finish(&mut turn).await?.status, LoopStatus::Cancelled);
    drop(turn);
    close(runtime).await?;
    Ok(())
}

#[tokio::test]
async fn updated_tool_registration_is_visible_after_explicit_runtime_replacement() -> TestResult {
    let d = Dir::new()?;
    for version in ["v1", "v2"] {
        let field = if version == "v2" { "payload" } else { "value" };
        let p = Arc::new(Provider {
            call_tool: true,
            argument_key: Some(field),
            ..Provider::default()
        });
        let factory = Arc::new(EchoFactory {
            version: version.into(),
            ..EchoFactory::default()
        });
        let runtime = d.builder(p.clone(), factory.clone())?.build()?;
        let mut turn = runtime.start_turn(d.request("versioned", version)).await?;
        assert_eq!(finish(&mut turn).await?.status, LoopStatus::Completed);
        assert_eq!(
            p.requests.lock().await[0].tools[0].description,
            format!("echo {version}")
        );
        assert_eq!(
            p.requests.lock().await[0].tools[0].parameters["required"],
            json!([field])
        );
        assert_eq!(factory.calls.load(Ordering::SeqCst), 1);
        drop(turn);
        close(runtime).await?;
    }
    Ok(())
}

struct FailingTools;
#[async_trait]
impl SessionToolFactory for FailingTools {
    async fn executor(
        &self,
        _: &str,
        _: &str,
        _: PermissionPreset,
    ) -> Result<ToolExecutor, String> {
        Err("fixture tool preparation failed".into())
    }

    async fn shutdown(&self) -> Result<(), String> {
        Err("fixture tool cleanup failed".into())
    }
}

#[tokio::test]
async fn tool_preparation_and_shutdown_failures_remain_observable() -> TestResult {
    let d = Dir::new()?;
    let p = Arc::new(Provider::default());
    let runtime = d.builder(p.clone(), Arc::new(FailingTools))?.build()?;
    match runtime.start_turn(d.request("failure", "id")).await {
        Ok(mut turn) => {
            let result = finish(&mut turn).await?;
            assert_eq!(result.status, LoopStatus::Failed);
            assert!(result
                .error
                .as_deref()
                .is_some_and(|e| e.contains("fixture tool preparation failed")));
        }
        Err(error) => assert!(error
            .to_string()
            .contains("fixture tool preparation failed")),
    }
    assert_eq!(p.calls.load(Ordering::SeqCst), 0);
    let report = runtime.shutdown(Duration::from_secs(3)).await;
    assert!(!report.is_graceful());
    assert!(report
        .cleanup_errors
        .iter()
        .any(|e| e.contains("fixture tool cleanup failed")));
    Ok(())
}

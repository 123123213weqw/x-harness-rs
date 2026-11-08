//! Offline provider fixture with a real durable XHarness runtime and JSONL store.
//! Run only on the authorized remote build host; no network or paid model calls.
use async_trait::async_trait;
use futures::stream;
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use xharness_sdk::{
    execution::{AgentTurnRequest, PermissionPreset},
    models::*,
    storage::*,
    tools::NoTools,
    RuntimeBuilder,
};

struct OfflineEcho;
#[async_trait]
impl ModelProvider for OfflineEcho {
    async fn stream(
        &self,
        _: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        Ok(Box::pin(stream::iter([
            Ok(ProviderEvent::TextDelta(
                "XHarness SDK 离线示例完成 😀".into(),
            )),
            Ok(ProviderEvent::Completed {
                finish_reason: Some(FinishReason::Stop),
                usage: None,
                provider_items: vec![],
            }),
        ])))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| std::io::Error::other("provide an absolute isolated state directory"))?;
    if !path.is_absolute() {
        return Err(std::io::Error::other("state directory must be absolute").into());
    }
    std::fs::create_dir_all(&path)?;
    let route = ModelRoute::new("offline", "echo");
    let mut models = ModelRegistry::new();
    models.register(RegisteredModel::new(
        ModelDescriptor::new("offline", "Offline", "echo", "Echo"),
        Arc::new(OfflineEcho),
    ))?;
    let runtime = RuntimeBuilder::new(
        route.clone(),
        models,
        Arc::new(NoTools),
        Arc::new(JsonlSessionStore::new(path.join("sessions"))?.for_runtime()),
        Arc::new(FileLeaseManager::new(path.join("leases"))?),
    )
    .build()?;
    let outcome = async {
        let mut turn = runtime
            .start_turn(AgentTurnRequest {
                session_id: "offline-demo".into(),
                cwd: path.to_string_lossy().into_owned(),
                route,
                permission: PermissionPreset::WorkspaceWrite,
                prompt: None,
                messages: vec![AgentMessage::user("你好，SDK").with_id(format!(
                    "demo-{}",
                    SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
                ))],
                input_metadata: None,
            })
            .await?;
        while let Some(event) = turn.next_event().await {
            println!("{event:?}");
        }
        let result = turn.result().await;
        println!("result: {:?}: {}", result.status, result.final_text);
        Ok::<_, Box<dyn std::error::Error>>(())
    }
    .await;
    let report = runtime.shutdown(Duration::from_secs(5)).await;
    if !report.is_graceful() {
        return Err(std::io::Error::other(format!("shutdown: {report:?}")).into());
    }
    outcome
}

//! Actual durable model loop → lazy MCP entry → same session-owned UI events.
//! Scripted provider only: no credentials, paid model calls or live user state.
use async_trait::async_trait;
use futures::{stream, StreamExt};
use serde_json::json;
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use xharness_agent::MemoryLeaseManager;
use xharness_api::{ApiBackend, RpcId, RpcMethod};
use xharness_core::{
    FinishReason, IdentityContextPolicy, ModelProvider, ProviderError, ProviderEvent,
    ProviderRequest, ProviderStream,
};
use xharness_host::{AgentRuntime, BasicHost, DurableLoopAgentRuntime, HostConfig};
use xharness_host_app::NativeToolFactory;
use xharness_session::{EventData, MemorySessionStore, Store, ToolOutcome, TurnEndReason};
use xharness_web::WebRuntime;

struct Workspace(PathBuf);
impl Workspace {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "xh-display-mcp-loop-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        std::fs::write(
            path.join("report.md"),
            "# Private preview bytes\nNot model input.\n",
        )
        .unwrap();
        std::fs::write(path.join("change.patch"), "--- a/example.rs\n+++ b/example.rs\n@@ -1 +1 @@\n-old_private_preview\n+new_private_preview\n").unwrap();
        Self(std::fs::canonicalize(path).unwrap())
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct DisplayProvider {
    requests: Mutex<Vec<(BTreeSet<String>, String)>>,
}
#[async_trait]
impl ModelProvider for DisplayProvider {
    fn provider_name(&self) -> &str {
        "display-mcp-test"
    }
    fn model_name(&self) -> Option<&str> {
        Some("scripted")
    }
    async fn stream(
        &self,
        request: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let step = {
            let mut requests = self.requests.lock().unwrap();
            let step = requests.len();
            requests.push((
                request.tools.into_iter().map(|tool| tool.name).collect(),
                format!("{:?}", request.messages),
            ));
            step
        };
        let call = match step {
            0 => Some(json!({"action":"list","plugin":"builtin","server":"ui"})),
            1 => {
                Some(json!({"action":"describe","plugin":"builtin","server":"ui","tool":"display"}))
            }
            2 => Some(
                json!({"action":"call","plugin":"builtin","server":"ui","tool":"display","arguments":{"path":"report.md"}}),
            ),
            3 => Some(
                json!({"action":"call","plugin":"builtin","server":"ui","tool":"display","arguments":{"path":"change.patch"}}),
            ),
            _ => None,
        };
        let events = match call {
            Some(arguments) => vec![
                Ok(ProviderEvent::ToolCallDelta {
                    index: 0,
                    id: format!("ui-call-{step}"),
                    name: "plugin_mcp".into(),
                    arguments_delta: arguments.to_string(),
                }),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::ToolCalls),
                    usage: None,
                    provider_items: Vec::new(),
                }),
            ],
            None => vec![
                Ok(ProviderEvent::TextDelta(
                    "Display requests submitted.".into(),
                )),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::Stop),
                    usage: None,
                    provider_items: Vec::new(),
                }),
            ],
        };
        Ok(Box::pin(stream::iter(events)))
    }
}

#[tokio::test]
async fn durable_model_uses_only_lazy_mcp_and_never_receives_preview_contents() {
    let workspace = Workspace::new();
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let provider = Arc::new(DisplayProvider::default());
    let tools = NativeToolFactory::new(WebRuntime::default());
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "display-mcp-test",
        "scripted",
        Some(provider.clone()),
        tools.clone(),
        Arc::new(IdentityContextPolicy),
        store.clone(),
        Arc::new(MemoryLeaseManager::default()),
        64,
    ));
    let mut config = HostConfig::new(&workspace.0);
    config.provider_id = "display-mcp-test".into();
    config.model_id = "scripted".into();
    let host = BasicHost::with_agent_runtime(config, runtime.clone());
    tools.bind_agent_host(&host).unwrap();
    let mut events = host.host_events();
    for (id, method, payload) in [
        (
            "create",
            RpcMethod::SessionCreate,
            json!({"sessionId":"display-loop","workspaceId":"workspace-default"}),
        ),
        (
            "prompt",
            RpcMethod::SessionPrompt,
            json!({"sessionId":"display-loop","mode":"queue","content":[{"type":"text","text":"Show report.md and change.patch in my panel."}]}),
        ),
    ] {
        assert!(host
            .call(RpcId::new(id), method, payload, CancellationToken::new())
            .await
            .is_ok());
    }
    let session = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let session = store.load("display-loop").await.unwrap().unwrap();
            if session
                .events()
                .iter()
                .any(|event| matches!(event.data(), EventData::TurnEnd { .. }))
            {
                break session;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(session.events().iter().any(|event| matches!(
        event.data(),
        EventData::TurnEnd {
            reason: TurnEndReason::Completed,
            ..
        }
    )));
    let results: Vec<_> = session
        .events()
        .iter()
        .filter_map(|event| match event.data() {
            EventData::ToolResult { result, .. } => Some(result),
            _ => None,
        })
        .collect();
    assert_eq!(results.len(), 4);
    assert!(results
        .iter()
        .all(|result| result.outcome == ToolOutcome::Success));
    for result in &results[2..] {
        assert!(result.content.contains("requested"));
        assert!(!result.content.contains("Private preview bytes"));
        assert!(!result.content.contains("old_private_preview"));
    }
    {
        let requests = provider.requests.lock().unwrap();
        assert_eq!(requests.len(), 5);
        for (names, messages) in requests.iter() {
            assert!(names.contains("plugin_mcp"));
            assert!(!names.contains("display"));
            assert!(!messages.contains("Private preview bytes"));
            assert!(!messages.contains("old_private_preview"));
        }
    }
    let intents = tokio::time::timeout(Duration::from_secs(2), async {
        let mut intents = Vec::new();
        while intents.len() < 2 {
            let event = serde_json::to_value(events.next().await.unwrap())
                .unwrap()
                .to_string();
            if event.contains("display/open") {
                intents.push(event);
            }
        }
        intents
    })
    .await
    .unwrap();
    assert!(intents[0].contains("report.md"));
    assert!(intents[1].contains("change.patch"));
    for intent in intents {
        assert!(intent.contains("display-loop"));
        assert!(!intent.contains("Private preview bytes"));
        assert!(!intent.contains("old_private_preview"));
    }
    runtime.shutdown(Duration::from_secs(1)).await;
}

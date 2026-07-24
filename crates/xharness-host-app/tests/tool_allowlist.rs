//! Exercise the final Host registry with the native factory and a local
//! scripted provider, including calls to tools injected after the factory.
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use async_trait::async_trait;
use futures::stream;
use serde_json::json;
use tokio_util::sync::CancellationToken;
use xharness_agent::MemoryLeaseManager;
use xharness_api::{ApiBackend, RpcId, RpcMethod};
use xharness_core::{
    FinishReason, IdentityContextPolicy, ModelProvider, ProviderError, ProviderEvent,
    ProviderRequest, ProviderStream,
};
use xharness_host::{
    AgentRuntime, AgentRuntimeError, AgentTurnRequest, BasicHost, DurableLoopAgentRuntime,
    HostConfig, LoopAgentRuntime, ModelRoute, PermissionPreset,
};
use xharness_host_app::{tool_allowlist::ToolAllowlist, NativeToolFactory};
use xharness_session::{EventData, MemorySessionStore, Store, ToolOutcome, TurnEndReason};
use xharness_web::WebRuntime;

struct Workspace(PathBuf);

impl Workspace {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "xharness-tool-allowlist-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
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

struct ToolProvider {
    tool: &'static str,
    definitions: Mutex<Option<BTreeSet<String>>>,
}

#[async_trait]
impl ModelProvider for ToolProvider {
    fn provider_name(&self) -> &str {
        "allowlist-test"
    }

    fn model_name(&self) -> Option<&str> {
        Some("local-model")
    }

    async fn stream(
        &self,
        request: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let first = {
            let mut definitions = self.definitions.lock().unwrap();
            let first = definitions.is_none();
            *definitions = Some(request.tools.into_iter().map(|tool| tool.name).collect());
            first
        };
        let events = if first {
            let arguments = match self.tool {
                "history" => json!({"action":"search","query":"allowlist evidence"}),
                "goal" => json!({"action":"get"}),
                _ => unreachable!(),
            };
            vec![
                Ok(ProviderEvent::ToolCallDelta {
                    index: 0,
                    id: "local-tool-call".into(),
                    name: self.tool.into(),
                    arguments_delta: arguments.to_string(),
                }),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::ToolCalls),
                    usage: None,
                    provider_items: Vec::new(),
                }),
            ]
        } else {
            vec![
                Ok(ProviderEvent::TextDelta("completed locally".into())),
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

async fn run_case(allowlist: Option<&str>, tool: &'static str, outcome: ToolOutcome) {
    let workspace = Workspace::new();
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let provider = Arc::new(ToolProvider {
        tool,
        definitions: Mutex::new(None),
    });
    let tools = NativeToolFactory::new(WebRuntime::default());
    if let Some(allowlist) = allowlist {
        tools
            .restrict_tools(ToolAllowlist::parse(allowlist).unwrap())
            .unwrap();
    }
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "allowlist-test",
        "local-model",
        Some(provider.clone()),
        tools.clone(),
        Arc::new(IdentityContextPolicy),
        store.clone(),
        Arc::new(MemoryLeaseManager::default()),
        64,
    ));
    let mut config = HostConfig::new(&workspace.0);
    config.provider_id = "allowlist-test".into();
    config.model_id = "local-model".into();
    let host = BasicHost::with_agent_runtime(config, runtime.clone());
    tools.bind_agent_host(&host).unwrap();
    for (id, method, payload) in [
        (
            "create",
            RpcMethod::SessionCreate,
            json!({"sessionId":"allowlist","workspaceId":"workspace-default"}),
        ),
        (
            "prompt",
            RpcMethod::SessionPrompt,
            json!({"sessionId":"allowlist","mode":"queue","content":[{"type":"text","text":"allowlist evidence"}]}),
        ),
    ] {
        assert!(host
            .call(RpcId::new(id), method, payload, CancellationToken::new())
            .await
            .is_ok());
    }
    let session = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let session = store.load("allowlist").await.unwrap().unwrap();
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
    .unwrap_or_else(|_| panic!("turn did not finish with allowlist {allowlist:?}"));
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
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].outcome, outcome, "{}", results[0].content);
    let definitions = provider.definitions.lock().unwrap().clone().unwrap();
    if let Some(allowlist) = allowlist {
        let expected = allowlist
            .split(',')
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect();
        assert_eq!(definitions, expected);
    } else {
        assert!(definitions.contains("read"));
        assert!(definitions.contains("history"));
        assert!(definitions.contains("goal"));
    }
    runtime.shutdown(Duration::from_secs(1)).await;
}

#[tokio::test]
async fn host_owned_tools_run_after_allowlist_validation() {
    run_case(Some("read,history"), "history", ToolOutcome::Success).await;
    run_case(Some("goal"), "goal", ToolOutcome::Success).await;
    run_case(Some("read,goal"), "goal", ToolOutcome::Success).await;
    run_case(None, "history", ToolOutcome::Success).await;
}

#[tokio::test]
async fn omitted_host_tools_remain_unavailable_even_if_the_model_calls_them() {
    run_case(Some("read"), "history", ToolOutcome::Error).await;
    run_case(Some("read"), "goal", ToolOutcome::Error).await;
    run_case(Some(""), "history", ToolOutcome::Error).await;
}

#[tokio::test]
async fn incomplete_registries_are_rejected_before_the_provider_runs() {
    let workspace = Workspace::new();
    // The legacy runtime does not inject Host tools. Deferring validation must
    // not turn a missing capability or a typo into a silently reduced suite.
    for name in ["history", "goal", "computer", "unknown_tool"] {
        let provider = Arc::new(ToolProvider {
            tool: "history",
            definitions: Mutex::new(None),
        });
        let tools = NativeToolFactory::new(WebRuntime::default());
        tools
            .restrict_tools(ToolAllowlist::parse(name).unwrap())
            .unwrap();
        let runtime = LoopAgentRuntime::new(
            "allowlist-test",
            "local-model",
            Some(provider.clone()),
            tools,
            Arc::new(IdentityContextPolicy),
        );
        let result = runtime
            .start_turn(AgentTurnRequest {
                session_id: "incomplete".into(),
                cwd: workspace.0.to_string_lossy().into_owned(),
                route: ModelRoute::new("allowlist-test", "local-model"),
                permission: PermissionPreset::WorkspaceWrite,
                prompt: None,
                messages: Vec::new(),
                input_metadata: None,
            })
            .await;
        match result {
            Err(AgentRuntimeError::Preparation { message }) => {
                assert_eq!(
                    message,
                    format!("allowlisted tool {name:?} is unavailable under this session policy")
                );
            }
            _ => panic!("runtime accepted unavailable tool {name:?}"),
        }
        assert!(provider.definitions.lock().unwrap().is_none());
    }
}

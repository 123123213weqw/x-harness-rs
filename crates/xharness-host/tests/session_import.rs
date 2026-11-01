use async_trait::async_trait;
use futures::stream;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;
use xharness_agent::MemoryLeaseManager;
use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
use xharness_core::{
    FinishReason, IdentityContextPolicy, ModelProvider, ProviderError, ProviderEvent,
    ProviderRequest, ProviderStream,
};
use xharness_host::{BasicHost, DurableLoopAgentRuntime, HostConfig, NoTools, RecoveryPolicy};
use xharness_session::{EventData, Store};
use xharness_session_jsonl::JsonlSessionStore;
#[derive(Default)]
struct Capture(Mutex<Vec<ProviderRequest>>);
#[async_trait]
impl ModelProvider for Capture {
    fn provider_name(&self) -> &str {
        "test"
    }
    async fn stream(
        &self,
        r: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        self.0.lock().unwrap().push(r);
        Ok(Box::pin(stream::iter([
            Ok(ProviderEvent::TextDelta("continued".into())),
            Ok(ProviderEvent::Completed {
                finish_reason: Some(FinishReason::Stop),
                usage: None,
                provider_items: vec![],
            }),
        ])))
    }
}
fn value(result: RpcResult) -> Value {
    match result {
        RpcResult::Success { value: Some(v) } => v,
        other => panic!("{other:?}"),
    }
}
fn host(root: &std::path::Path, store: Arc<dyn Store>, provider: Arc<Capture>) -> Arc<BasicHost> {
    let mut config = HostConfig::new(root);
    config.provider_id = "test".into();
    config.model_id = "test-model".into();
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "test",
        "test-model",
        Some(provider),
        Arc::new(NoTools),
        Arc::new(IdentityContextPolicy),
        store,
        Arc::new(MemoryLeaseManager::default()),
        32,
    ));
    BasicHost::with_agent_runtime(config, runtime)
}
#[tokio::test]
async fn preview_import_retry_restart_and_continue_use_only_native_tools() {
    let root = std::env::temp_dir().join(format!("xh-import-acceptance-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let store: Arc<dyn Store> = Arc::new(JsonlSessionStore::new(root.join("sessions")).unwrap());
    let provider = Arc::new(Capture::default());
    let host1 = host(&root, store.clone(), provider.clone());
    let jsonl=[json!({"type":"session_meta","payload":{"id":"source","cwd":"/does/not/exist","model":"foreign"}}),json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"find the regression"}]}}),json!({"type":"response_item","payload":{"type":"function_call","call_id":"old","name":"exec_command","arguments":"{\"cmd\":\"touch SHOULD_NOT_RUN\"}"}})].iter().map(|v|format!("{v}\n")).collect::<String>();
    let mut payload = json!({"source":"codex","jsonl":jsonl,"preview":true,"cwd":root});
    let preview = value(
        host1
            .call(
                RpcId::new("preview"),
                RpcMethod::SessionImport,
                payload.clone(),
                CancellationToken::new(),
            )
            .await,
    );
    assert!(preview.get("sessionId").is_none());
    assert_eq!(store.list_headers().await.unwrap().len(), 0);
    assert!(provider.0.lock().unwrap().is_empty());
    payload["preview"] = json!(false);
    let first = value(
        host1
            .call(
                RpcId::new("import"),
                RpcMethod::SessionImport,
                payload.clone(),
                CancellationToken::new(),
            )
            .await,
    );
    let id = first["sessionId"].as_str().unwrap();
    let again = value(
        host1
            .call(
                RpcId::new("retry"),
                RpcMethod::SessionImport,
                payload,
                CancellationToken::new(),
            )
            .await,
    );
    assert_eq!(first["sessionId"], again["sessionId"]);
    assert_eq!(store.list_headers().await.unwrap().len(), 1);
    let session = store.load(id).await.unwrap().unwrap();
    assert!(session.events().iter().all(|e| !matches!(
        e.data(),
        EventData::ToolCall { .. } | EventData::ToolResult { .. }
    )));
    assert!(!root.join("SHOULD_NOT_RUN").exists());
    assert!(provider.0.lock().unwrap().is_empty());
    let before = value(
        host1
            .call(
                RpcId::new("history"),
                RpcMethod::SessionHistory,
                json!({"sessionId":id}),
                CancellationToken::new(),
            )
            .await,
    );
    let host2 = host(&root, store.clone(), provider.clone());
    let report = host2
        .restore_from_store_with_policy(store.clone(), RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    assert_eq!(report.resumed_pending_turns, 0);
    assert!(provider.0.lock().unwrap().is_empty());
    let after = value(
        host2
            .call(
                RpcId::new("restored-history"),
                RpcMethod::SessionHistory,
                json!({"sessionId":id}),
                CancellationToken::new(),
            )
            .await,
    );
    assert!(!before["events"].as_array().unwrap().is_empty());
    assert_eq!(before["events"], after["events"]);
    assert!(host2.call(RpcId::new("continue"),RpcMethod::SessionPrompt,json!({"sessionId":id,"mode":"queue","content":[{"type":"text","text":"verify the current files"}]}),CancellationToken::new()).await.is_ok());
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if !provider.0.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await
        }
    })
    .await
    .unwrap();
    {
        let requests = provider.0.lock().unwrap();
        let r = &requests[0];
        // NoTools is the workspace factory; the durable runtime still injects
        // history reader, but no Goal tools in this ordinary imported turn.
        // The source exec_command is not a tool.
        let mut names = r
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>();
        names.sort_unstable();
        assert_eq!(
            names,
            ["history"],
            "ordinary imports must not gain Goal tools"
        );
        assert!(r
            .messages
            .iter()
            .all(|m| m.tool_calls.is_empty() && m.provider_items.is_empty()));
        assert!(r
            .messages
            .iter()
            .any(|m| m.content.contains("exec_command")));
        assert!(r
            .messages
            .iter()
            .any(|m| m.content == "verify the current files"));
    }
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if host2.snapshot().await["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .all(|s| s["running"] == false)
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    drop(host1);
    drop(host2);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn invalid_import_never_publishes_a_half_created_session() {
    let host = BasicHost::without_provider(HostConfig::new(std::env::temp_dir()));
    assert!(!host
        .call(
            RpcId::new("bad"),
            RpcMethod::SessionImport,
            json!({"source":"codex","jsonl":"invalid\n","preview":false}),
            CancellationToken::new()
        )
        .await
        .is_ok());
    let list = value(
        host.call(
            RpcId::new("list"),
            RpcMethod::SessionList,
            json!({}),
            CancellationToken::new(),
        )
        .await,
    );
    assert_eq!(list["items"].as_array().unwrap().len(), 0);
}

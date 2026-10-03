//! Scripted provider, real Host/Loop/JSONL. These are not paid model evaluations.
use crate::{BasicHost, DurableLoopAgentRuntime, HostConfig, PermissionPreset, SessionToolFactory};
use async_trait::async_trait;
use futures::{stream, StreamExt};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::{mpsc, Semaphore};
use tokio_util::sync::CancellationToken;
use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
use xharness_core::{
    FinishReason, IdentityContextPolicy, ModelProvider, ProviderError, ProviderEvent,
    ProviderRequest, ProviderStream, Role,
};
use xharness_session::{EventData, Store};
use xharness_tools::{ToolDefinition, ToolExecutor, ToolOutput, ToolRegistry, ToolSpec};

use super::tests::Root;

#[derive(Clone, Copy)]
enum FirstReply {
    Tool,
    Text,
    Retry,
}

struct PausedProvider {
    requests: mpsc::UnboundedSender<ProviderRequest>,
    release: Arc<Semaphore>,
    calls: AtomicUsize,
    first_reply: FirstReply,
}
#[async_trait]
impl ModelProvider for PausedProvider {
    async fn stream(
        &self,
        request: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let first = self.calls.fetch_add(1, Ordering::SeqCst) == 0;
        let tool = first && matches!(self.first_reply, FirstReply::Tool);
        let retry = first && matches!(self.first_reply, FirstReply::Retry);
        self.requests.send(request).unwrap();
        let release = self.release.clone();
        Ok(Box::pin(
            stream::once(async move {
                release.acquire().await.unwrap().forget();
                if retry {
                    return Err(ProviderError::retryable(
                        "fixture offline before committed output",
                    ));
                }
                Ok(if tool {
                    ProviderEvent::ToolCallDelta {
                        index: 0,
                        id: "advance-call".into(),
                        name: "advance".into(),
                        arguments_delta: "{}".into(),
                    }
                } else {
                    ProviderEvent::TextDelta("done".into())
                })
            })
            .chain(stream::iter([Ok(ProviderEvent::Completed {
                finish_reason: Some(if tool {
                    FinishReason::ToolCalls
                } else {
                    FinishReason::Stop
                }),
                usage: None,
                provider_items: vec![],
            })])),
        ))
    }
}
struct Tools;
#[async_trait]
impl SessionToolFactory for Tools {
    async fn executor(
        &self,
        _: &str,
        _: &str,
        _: PermissionPreset,
    ) -> Result<ToolExecutor, String> {
        let registry = Arc::new(ToolRegistry::new());
        registry
            .register(ToolSpec::new(
                ToolDefinition::new(
                    "advance",
                    "advance scripted test",
                    json!({"type":"object","properties":{}}),
                ),
                |_| async { Ok(ToolOutput::text("advanced")) },
            ))
            .await
            .map_err(|e| e.to_string())?;
        Ok(ToolExecutor::new(registry))
    }
}
struct Fixture {
    host: Arc<BasicHost>,
    requests: mpsc::UnboundedReceiver<ProviderRequest>,
    release: Arc<Semaphore>,
    store_path: PathBuf,
}
impl Fixture {
    fn new(root: &Root, durable: bool, first_reply: FirstReply) -> Self {
        let (tx, requests) = mpsc::unbounded_channel();
        let release = Arc::new(Semaphore::new(0));
        let provider = Arc::new(PausedProvider {
            requests: tx,
            release: release.clone(),
            calls: AtomicUsize::new(0),
            first_reply,
        });
        let mut config = HostConfig::new(&root.0);
        config.memory_dir = Some(root.0.join("memory"));
        config.provider_id = "fixture".into();
        config.model_id = "fixture".into();
        let store_path = root.0.join("state");
        let host = if durable {
            let store: Arc<dyn Store> =
                Arc::new(xharness_session_jsonl::JsonlSessionStore::new(&store_path).unwrap());
            BasicHost::with_agent_runtime(
                config,
                Arc::new(DurableLoopAgentRuntime::new(
                    "fixture",
                    "fixture",
                    Some(provider),
                    Arc::new(Tools),
                    Arc::new(IdentityContextPolicy),
                    store,
                    Arc::new(xharness_agent::MemoryLeaseManager::default()),
                    1024,
                )),
            )
        } else {
            BasicHost::new(config, Some(provider), Arc::new(Tools))
        };
        Self {
            host,
            requests,
            release,
            store_path,
        }
    }
    async fn call(&self, id: &str, method: RpcMethod, payload: Value) -> Value {
        match self
            .host
            .call(RpcId::new(id), method, payload, CancellationToken::new())
            .await
        {
            RpcResult::Success { value: Some(value) } => value,
            other => panic!("{other:?}"),
        }
    }
    async fn create(&self) {
        self.call(
            "create",
            RpcMethod::SessionCreate,
            json!({"sessionId":"chat"}),
        )
        .await;
    }
    async fn prompt(&self, id: &str) {
        self.call(
            id,
            RpcMethod::SessionPrompt,
            json!({"sessionId":"chat","mode":"queue","content":[{"type":"text","text":id}]}),
        )
        .await;
    }
    async fn next(&mut self) -> ProviderRequest {
        tokio::time::timeout(Duration::from_secs(5), self.requests.recv())
            .await
            .unwrap()
            .unwrap()
    }
    async fn idle(&self) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if !self.host.state.read().await.sessions["chat"].running {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }
    async fn stop(&self) {
        self.host.stop_background_listeners();
        self.host
            .agent_runtime
            .shutdown(Duration::from_secs(2))
            .await;
    }
}
fn system(request: &ProviderRequest) -> String {
    assert_eq!(
        request
            .messages
            .iter()
            .filter(|m| m.role == Role::System)
            .count(),
        1
    );
    request
        .messages
        .iter()
        .find(|m| m.role == Role::System)
        .unwrap()
        .content
        .clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_turn_refreshes_queued_rules_but_tool_steps_keep_one_snapshot() {
    for durable in [false, true] {
        let root = Root::new();
        root.write("ROOT_RULE_V1");
        let mut fx = Fixture::new(&root, durable, FirstReply::Tool);
        fx.create().await;
        fx.host
            .memory_update(
                root.0.to_string_lossy().into_owned(),
                "save",
                &json!({"content":"MEMORY_V1","version":null}),
            )
            .await
            .unwrap();
        fx.host
            .memory_update(
                crate::memory::MemoryScope::Global,
                "save",
                &json!({"content":"GLOBAL_V1","version":null}),
            )
            .await
            .unwrap();
        fx.prompt("first").await;
        let first = system(&fx.next().await);
        assert!(first.contains("ROOT_RULE_V1"));
        assert!(first.contains("MEMORY_V1"));
        assert!(first.contains("GLOBAL_V1"));
        // Queue while the old file is present; the next actual turn must
        // refresh, while this turn's following tool step must not.
        fx.prompt("queued").await;
        root.write("ROOT_RULE_V2");
        let memory = fx
            .host
            .memory_view(root.0.to_string_lossy().into_owned())
            .await
            .unwrap();
        fx.host
            .memory_update(
                root.0.to_string_lossy().into_owned(),
                "save",
                &json!({"content":"MEMORY_V2","version":memory["version"]}),
            )
            .await
            .unwrap();
        let global = fx
            .host
            .memory_view(crate::memory::MemoryScope::Global)
            .await
            .unwrap();
        fx.host
            .memory_update(
                crate::memory::MemoryScope::Global,
                "save",
                &json!({"content":"GLOBAL_V2","version":global["version"]}),
            )
            .await
            .unwrap();
        fx.release.add_permits(1);
        let second = system(&fx.next().await);
        assert_eq!(first, second);
        fx.release.add_permits(1);
        let third = system(&fx.next().await);
        assert!(third.contains("ROOT_RULE_V2"));
        assert!(third.contains("MEMORY_V2"));
        assert!(third.contains("GLOBAL_V2"));
        assert!(!third.contains("GLOBAL_V1"));
        assert!(!third.contains("MEMORY_V1"));
        assert!(!third.contains("ROOT_RULE_V1"));
        assert_eq!(third.matches("ROOT_RULE_V2").count(), 1);
        fx.release.add_permits(1);
        fx.idle().await;
        std::fs::remove_file(root.0.join("AGENTS.md")).unwrap();
        fx.prompt("after-delete").await;
        let fourth = fx.next().await;
        assert!(!system(&fourth).contains("ROOT_RULE_V"));
        assert!(fourth
            .messages
            .iter()
            .filter(|m| m.role != Role::System)
            .all(|m| !m.content.contains("ROOT_RULE_V")));
        fx.release.add_permits(1);
        fx.idle().await;
        fx.stop().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cold_jsonl_restore_keeps_harness_audit_and_loads_current_rules_for_new_turn() {
    let root = Root::new();
    root.write("BEFORE_RESTART_RULE");
    let mut fx = Fixture::new(&root, true, FirstReply::Text);
    fx.create().await;
    fx.prompt("before-restart").await;
    assert!(system(&fx.next().await).contains("BEFORE_RESTART_RULE"));
    fx.release.add_permits(1);
    fx.idle().await;
    fx.stop().await;
    let path = fx.store_path.clone();
    drop(fx);
    root.write("AFTER_RESTART_RULE");
    let store: Arc<dyn Store> =
        Arc::new(xharness_session_jsonl::JsonlSessionStore::new(path).unwrap());
    let old = store.load("chat").await.unwrap().unwrap();
    let seq = old
        .events()
        .iter()
        .position(|e| matches!(e.data(), EventData::RequestHeader { .. }))
        .unwrap() as u64;
    let old_snapshot = store.harness_header("chat", seq).await.unwrap().unwrap();
    assert!(old_snapshot
        .system
        .as_ref()
        .unwrap()
        .contains("BEFORE_RESTART_RULE"));
    assert!(old_snapshot.options["prompt"]["sections"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["id"] == "workspace/instructions/AGENTS.md"));
    let mut restored = Fixture::new(&root, true, FirstReply::Text);
    restored
        .host
        .restore_from_store(store.clone())
        .await
        .unwrap();
    restored.prompt("after-restart").await;
    let request = system(&restored.next().await);
    assert!(request.contains("AFTER_RESTART_RULE"));
    assert!(!request.contains("BEFORE_RESTART_RULE"));
    // Inspecting the old Harness request never substitutes current file bytes.
    assert_eq!(
        old_snapshot,
        store.harness_header("chat", seq).await.unwrap().unwrap()
    );
    restored.release.add_permits(1);
    restored.idle().await;
    restored.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn network_retry_does_not_refresh_rules_inside_a_running_loop() {
    for durable in [false, true] {
        let root = Root::new();
        root.write("NETWORK_RULE_V1");
        let mut fx = Fixture::new(&root, durable, FirstReply::Retry);
        fx.create().await;
        fx.prompt("retry-test").await;
        let first = system(&fx.next().await);
        root.write("NETWORK_RULE_V2");
        fx.release.add_permits(1);
        let retry = system(&fx.next().await);
        assert_eq!(first, retry);
        assert!(!retry.contains("NETWORK_RULE_V2"));
        fx.release.add_permits(1);
        fx.idle().await;
        fx.prompt("new-turn").await;
        assert!(system(&fx.next().await).contains("NETWORK_RULE_V2"));
        fx.release.add_permits(1);
        fx.idle().await;
        fx.stop().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn steering_does_not_reload_a_now_invalid_file_but_new_admission_fails_visibly() {
    for durable in [false, true] {
        let root = Root::new();
        root.write("ACTIVE_RULE");
        let mut fx = Fixture::new(&root, durable, FirstReply::Tool);
        fx.create().await;
        fx.prompt("active").await;
        let first = system(&fx.next().await);
        root.write([0xff]);
        fx.call("steer", RpcMethod::SessionPrompt, json!({"sessionId":"chat","mode":"steer","content":[{"type":"text","text":"please finish"}]})).await;
        fx.release.add_permits(1);
        assert_eq!(first, system(&fx.next().await));
        fx.release.add_permits(1);
        fx.idle().await;
        let result = fx.host.call(RpcId::new("invalid-next"), RpcMethod::SessionPrompt, json!({"sessionId":"chat","mode":"queue","content":[{"type":"text","text":"next"}]}), CancellationToken::new()).await;
        let RpcResult::Failure { error } = result else {
            panic!("invalid rules admitted a model request");
        };
        assert!(error.message.contains("UTF-8"));
        assert!(fx.requests.try_recv().is_err());
        assert!(!fx.host.state.read().await.sessions["chat"].running);
        fx.stop().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_rules_do_not_abort_host_restore_or_consume_pending_input() {
    let root = Root::new();
    root.write([0xff]);
    let mut fx = Fixture::new(&root, true, FirstReply::Text);
    let store: Arc<dyn Store> =
        Arc::new(xharness_session_jsonl::JsonlSessionStore::new(&fx.store_path).unwrap());
    let mut header = xharness_session::SessionHeader::new("chat");
    header.cwd = Some(root.0.to_string_lossy().into());
    let inbox = xharness_agent::DurableInbox::open(store.clone(), header)
        .await
        .unwrap();
    inbox
        .append(
            xharness_session::InboxTarget::NextTurn,
            xharness_agent::InboxMessage::user("pending", "resume only after repairing rules"),
        )
        .await
        .unwrap();
    let report = fx.host.restore_from_store(store.clone()).await.unwrap();
    assert_eq!(report.restored_sessions, 1);
    assert_eq!(report.resumed_pending_turns, 0);
    assert!(report
        .issues
        .iter()
        .any(|i| i.session_id == "chat" && i.message.contains("UTF-8")));
    assert_eq!(inbox.snapshot().await.unwrap().next_turn().len(), 1);
    assert!(fx.requests.try_recv().is_err());
    assert!(!fx.host.state.read().await.startup_issues.is_empty());
    // Repairing and retrying restoration can resume that exact pending input.
    root.write("REPAIRED_PROJECT_RULE");
    let repaired = fx.host.restore_from_store(store).await.unwrap();
    assert_eq!(repaired.resumed_pending_turns, 1);
    assert!(system(&fx.next().await).contains("REPAIRED_PROJECT_RULE"));
    fx.release.add_permits(1);
    fx.idle().await;
    fx.stop().await;
}

//! Native durable transfer into the real Host, then continue without replay.
#![forbid(unsafe_code)]
use async_trait::async_trait;
use serde_json::json;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;
use xharness_api::{ApiBackend, RpcId, RpcMethod};
use xharness_core::{
    FinishReason, IdentityContextPolicy, ModelProvider, ProviderError, ProviderEvent,
    ProviderRequest, ProviderStream,
};
use xharness_host::{BasicHost, DurableLoopAgentRuntime, HostConfig, NoTools};
use xharness_session::{EventData as E, Message, SessionHeader, Store, TurnEndReason};
use xharness_session_jsonl::{
    handoff::{Destination, WorkspaceCheckpoint},
    JsonlSessionStore,
};
struct Root(PathBuf);
impl Drop for Root {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
#[derive(Default)]
struct Provider {
    calls: AtomicUsize,
    inputs: Mutex<Vec<ProviderRequest>>,
}
#[async_trait]
impl ModelProvider for Provider {
    fn provider_name(&self) -> &str {
        "fixture"
    }
    fn model_name(&self) -> Option<&str> {
        Some("fixture")
    }
    async fn stream(
        &self,
        r: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.inputs.lock().unwrap().push(r);
        Ok(Box::pin(futures::stream::iter(vec![
            Ok(ProviderEvent::TextDelta("continued exactly once".into())),
            Ok(ProviderEvent::Completed {
                finish_reason: Some(FinishReason::Stop),
                usage: None,
                provider_items: vec![],
            }),
        ])))
    }
}
fn dest(owner: &str, cwd: &std::path::Path) -> Destination {
    Destination {
        owner: owner.repeat(64),
        cwd: cwd.to_str().unwrap().into(),
        workspace: WorkspaceCheckpoint {
            binding: "b".repeat(64),
            generation: 1,
            manifest: "c".repeat(64),
            transaction: "d".repeat(64),
        },
    }
}
#[tokio::test]
async fn target_host_continues_old_session_and_relinquished_source_never_calls_provider() {
    let root = Root(std::env::temp_dir().join(format!(
            "xh-handoff-host-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )));
    let cwd = root.0.join("cloud-workspace");
    std::fs::create_dir_all(&cwd).unwrap();
    let a = Arc::new(JsonlSessionStore::new(root.0.join("local-sessions")).unwrap());
    let b = Arc::new(JsonlSessionStore::new(root.0.join("cloud-sessions")).unwrap());
    let mut header = SessionHeader::new("old-session");
    header.cwd = Some("/old/local/code".into());
    let s = a.create(header).await.unwrap();
    a.append(
        "old-session",
        s.revision(),
        vec![
            E::SessionModelSelected {
                provider: "fixture".into(),
                model: "fixture".into(),
                reasoning_effort: None,
                context_window_tokens: None,
            }
            .into(),
            E::TurnStart { turn: 1 }.into(),
            E::UserMessage {
                message: Message::user("remember old checkpoint alpha"),
                surface_replace: None,
            }
            .into(),
            E::StepStart { turn: 1, step: 1 }.into(),
            E::AssistantMessage {
                turn: 1,
                step: 1,
                message: Message::assistant("alpha is saved"),
                usage: None,
            }
            .into(),
            E::StepEnd { turn: 1, step: 1 }.into(),
            E::TurnEnd {
                turn: 1,
                reason: TurnEndReason::Completed,
            }
            .into(),
        ],
    )
    .await
    .unwrap();
    let bundle = a
        .freeze_handoff("old-session", "a".repeat(64), dest("e", &cwd))
        .await
        .unwrap();
    let p = b
        .prepare_handoff("e".repeat(64), dest("e", &cwd), bundle)
        .await
        .unwrap();
    let r = a.release_handoff(p).await.unwrap();
    b.activate_handoff("e".repeat(64), dest("e", &cwd), r)
        .await
        .unwrap();
    let provider = Arc::new(Provider::default());
    for (source, store) in [(true, a), (false, b.clone())] {
        let runtime = Arc::new(DurableLoopAgentRuntime::new(
            "fixture",
            "fixture",
            Some(provider.clone()),
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            store.clone(),
            Arc::new(xharness_agent::MemoryLeaseManager::default()),
            64,
        ));
        let mut config = HostConfig::new(&cwd);
        config.provider_id = "fixture".into();
        config.model_id = "fixture".into();
        config.auto_titles = false;
        let host = BasicHost::with_agent_runtime(config, runtime);
        let report = host.restore_from_store(store).await.unwrap();
        if source {
            assert_eq!(report.restored_sessions, 0);
            assert_eq!(report.issues.len(), 1);
            assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
            continue;
        }
        assert_eq!(
            provider.calls.load(Ordering::SeqCst),
            0,
            "restore is not execution"
        );
        let response=host.call(RpcId::new("continue"),RpcMethod::SessionPrompt,json!({"sessionId":"old-session","mode":"queue","content":[{"type":"text","text":"continue alpha"}]}),CancellationToken::new()).await;
        assert!(response.is_ok(), "{response:?}");
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let s = b.load("old-session").await.unwrap().unwrap();
                if s.events()
                    .iter()
                    .any(|e| matches!(e.data(), E::TurnEnd { turn: 2, .. }))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    let inputs = provider.inputs.lock().unwrap();
    let serialized = serde_json::to_string(&inputs[0].messages).unwrap();
    assert!(serialized.contains("remember old checkpoint alpha"));
    assert!(serialized.contains("alpha is saved"));
    assert!(serialized.contains("continue alpha"));
}

#[test]
fn handoff_wire_never_accepts_roots_or_execution_authority() {
    use xharness_host_app::session_handoff::Request;
    for value in [
        json!({"operation":"describe","root":"/"}),
        json!({"operation":"status","session":"s","execute":true}),
        json!({"operation":"execute","command":"sh"}),
        json!({"operation":"bind","epoch":1}),
    ] {
        assert!(serde_json::from_value::<Request>(value).is_err());
    }
}

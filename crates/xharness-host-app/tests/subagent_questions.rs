//! Real NativeToolFactory + durable Host inbox/settlement routing, fake model.
use async_trait::async_trait;
use futures::{stream, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use xharness_agent::MemoryLeaseManager;
use xharness_api::{ApiBackend, RpcId, RpcMethod};
use xharness_core::{
    FinishReason, IdentityContextPolicy, ModelProvider, ProviderError, ProviderEvent,
    ProviderRequest, ProviderStream, Role,
};
use xharness_debug::DebugRecorder;
use xharness_host::{
    AgentRuntime, BasicHost, DurableLoopAgentRuntime, DurableQuestionHub, HostConfig,
    PermissionPreset, SessionToolFactory,
};
use xharness_host_app::NativeToolFactory;
use xharness_interaction::ASK_USER_QUESTION_TOOL;
use xharness_session::{EventData, Store};
use xharness_web::WebRuntime;

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "xh-subagent-questions-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        Self(std::fs::canonicalize(p).unwrap())
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct ModelState {
    started: bool,
    answered: bool,
    child_calls: BTreeMap<String, usize>,
    requests: usize,
}
#[derive(Default)]
struct Model(Mutex<ModelState>);
fn done(text: &str) -> Vec<Result<ProviderEvent, ProviderError>> {
    vec![
        Ok(ProviderEvent::TextDelta(text.into())),
        Ok(ProviderEvent::Completed {
            finish_reason: Some(FinishReason::Stop),
            usage: None,
            provider_items: vec![],
        }),
    ]
}
fn tool(id: &str, name: &str, args: Value) -> Vec<Result<ProviderEvent, ProviderError>> {
    vec![
        Ok(ProviderEvent::ToolCallDelta {
            index: 0,
            id: id.into(),
            name: name.into(),
            arguments_delta: args.to_string(),
        }),
        Ok(ProviderEvent::Completed {
            finish_reason: Some(FinishReason::ToolCalls),
            usage: None,
            provider_items: vec![],
        }),
    ]
}
#[async_trait]
impl ModelProvider for Model {
    async fn stream(
        &self,
        request: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let sid = request.debug_scope.session_id.as_deref().unwrap();
        let has_question = request
            .tools
            .iter()
            .any(|t| t.name == ASK_USER_QUESTION_TOOL);
        let child_policy = request.messages.iter().any(|m| {
            m.role == Role::System
                && m.content
                    .contains("Clarifications belong to your parent agent")
        });
        let mut state = self.0.lock().unwrap();
        state.requests += 1;
        let events = if sid == "parent" {
            assert!(has_question, "primary agent lost its question tool");
            assert!(
                !child_policy,
                "child-only policy leaked into primary prompt"
            );
            if !state.started {
                state.started = true;
                tool(
                    "delegate",
                    "agent",
                    json!({"action":"start","task":"Read-only task: ask the parent which deployment target to use if missing."}),
                )
            } else {
                let notice = request
                    .messages
                    .iter()
                    .rev()
                    .filter_map(|m| {
                        m.content
                            .split_once("(agent-settlement):\n")
                            .map(|(_, text)| text)
                    })
                    .filter_map(|text| serde_json::from_str::<Value>(text).ok())
                    .find(|v| {
                        v["answer"]
                            .as_str()
                            .is_some_and(|s| s.contains("CLARIFICATION_REQUIRED"))
                    });
                if let Some(notice) = notice.filter(|_| !state.answered) {
                    state.answered = true;
                    tool(
                        "answer-child",
                        "agent",
                        json!({"action":"send","agent_id":notice["agent_id"],"message":"PARENT_ANSWER: use local. This clarification grants no additional permissions."}),
                    )
                } else {
                    done("Parent continues independent work.")
                }
            }
        } else {
            assert!(
                !has_question,
                "delegated child still sees the user question schema"
            );
            assert!(
                child_policy,
                "child clarification policy never reached model"
            );
            let call = state.child_calls.entry(sid.into()).or_default();
            let index = *call;
            *call += 1;
            match index {
                // Force a stale/misbehaving model to try the removed tool anyway.
                0 => tool(
                    "stale-child-question",
                    ASK_USER_QUESTION_TOOL,
                    json!({"questions":[{"id":"target","header":"Target","question":"Which target?","options":[],"allowCustom":true,"destination":"context"}]}),
                ),
                1 => {
                    assert!(request.messages.iter().any(
                        |m| m.role == Role::Tool && m.content.contains(ASK_USER_QUESTION_TOOL)
                    ));
                    done("CLARIFICATION_REQUIRED: Which deployment target should I use? Options: local or test. No deployment performed.")
                }
                _ => {
                    assert!(
                        request
                            .messages
                            .iter()
                            .any(|m| m.content.contains("PARENT_ANSWER: use local")),
                        "child resumed without parent answer"
                    );
                    done("CHILD_RESUMED: used the parent's local target; no permissions changed.")
                }
            }
        };
        drop(state);
        Ok(Box::pin(stream::iter(events)))
    }
}
fn compose(
    root: &Root,
    store: Arc<dyn Store>,
    model: Arc<Model>,
) -> (
    Arc<BasicHost>,
    Arc<DurableLoopAgentRuntime>,
    Arc<NativeToolFactory>,
) {
    let hub = DurableQuestionHub::new(store.clone());
    let tools = NativeToolFactory::new_with_questions(
        WebRuntime::default(),
        DebugRecorder::disabled(),
        hub.clone(),
    );
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "test",
        "model",
        Some(model),
        tools.clone(),
        Arc::new(IdentityContextPolicy),
        store,
        Arc::new(MemoryLeaseManager::default()),
        64,
    ));
    let mut config = HostConfig::new(&root.0);
    config.provider_id = "test".into();
    config.model_id = "model".into();
    config.event_capacity = 4096;
    let host = BasicHost::with_agent_runtime_control_and_questions(
        config,
        runtime.clone(),
        Arc::new(xharness_control::MemoryControlStore::default()),
        hub,
    );
    tools.bind_agent_host(&host).unwrap();
    (host, runtime, tools)
}
#[tokio::test]
async fn subagent_questions_report_to_parent_and_resume_without_user_dialog_after_cold_restore() {
    let root = Root::new();
    let store: Arc<dyn Store> =
        Arc::new(xharness_session_jsonl::JsonlSessionStore::new(root.0.join("sessions")).unwrap());
    let model = Arc::new(Model::default());
    let (host, runtime, tools) = compose(&root, store.clone(), model.clone());
    let mut frames = host.mux_events();
    host.start_delegation_listener();
    assert!(host
        .call(
            RpcId::new("create"),
            RpcMethod::SessionCreate,
            json!({"sessionId":"parent","workspaceId":"workspace-default"}),
            CancellationToken::new()
        )
        .await
        .is_ok());
    assert!(host.call(RpcId::new("start"),RpcMethod::SessionPrompt,json!({"sessionId":"parent","mode":"queue","content":[{"type":"text","text":"Delegate the read-only target investigation."}]}),CancellationToken::new()).await.is_ok());
    let child=tokio::time::timeout(Duration::from_secs(12),async {
        loop {
            let headers=store.list_headers().await.unwrap();
            for h in headers.iter().filter(|h| h.id!="parent") {
                let s=store.load(&h.id).await.unwrap().unwrap();
                if s.events().iter().any(|e| matches!(e.data(),EventData::AssistantMessage {message,..} if message.content.contains("CHILD_RESUMED"))) && s.events().iter().filter(|e| matches!(e.data(),EventData::AgentSettlementDelivered {..})).count()>=2 {return h.id.clone();}
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("child clarification did not complete via parent send");
    assert!(model.0.lock().unwrap().answered);
    let mut child_question_frames = 0;
    while let Ok(Some(frame)) = tokio::time::timeout(Duration::from_millis(30), frames.next()).await
    {
        if frame.payload["type"] == "question/requested" {
            child_question_frames += 1;
        }
    }
    assert_eq!(child_question_frames, 0);
    for header in store.list_headers().await.unwrap() {
        let s = store.load(&header.id).await.unwrap().unwrap();
        assert!(!s.events().iter().any(|e| matches!(
            e.data(),
            EventData::QuestionRequested { .. } | EventData::QuestionResolved { .. }
        )));
    }
    assert!(runtime.shutdown(Duration::from_secs(2)).await.is_graceful());
    host.stop_background_listeners();
    drop(frames);
    drop(tools);
    drop(host);
    drop(runtime);
    drop(store);
    let reopened: Arc<dyn Store> =
        Arc::new(xharness_session_jsonl::JsonlSessionStore::new(root.0.join("sessions")).unwrap());
    let (restored, runtime, tools) = compose(&root, reopened.clone(), model.clone());
    restored.restore_from_store(reopened.clone()).await.unwrap();
    for permission in [
        PermissionPreset::WorkspaceWrite,
        PermissionPreset::DangerFullAccess,
    ] {
        let child_executor = tools
            .executor(&child, &root.0.to_string_lossy(), permission)
            .await
            .unwrap();
        assert!(child_executor
            .registry()
            .get(ASK_USER_QUESTION_TOOL)
            .await
            .is_none());
        let parent_executor = tools
            .executor("parent", &root.0.to_string_lossy(), permission)
            .await
            .unwrap();
        assert!(parent_executor
            .registry()
            .get(ASK_USER_QUESTION_TOOL)
            .await
            .is_some());
    }
    let count = model.0.lock().unwrap().requests;
    assert!(restored.call(RpcId::new("resume-after-restart"),RpcMethod::SessionPrompt,json!({"sessionId":child,"mode":"queue","content":[{"type":"text","text":"Read-only verification of the previous parent answer."}]}),CancellationToken::new()).await.is_ok());
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if model.0.lock().unwrap().requests > count {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(runtime.shutdown(Duration::from_secs(2)).await.is_graceful());
    restored.stop_background_listeners();
}

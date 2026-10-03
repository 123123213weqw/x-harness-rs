//! Real native Registry, Host response routing and cold JSONL replay; no model.
use futures::StreamExt;
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc, time::Duration};
use xharness_api::{ApiBackend, ClientResponse, ClientResponseKind, RpcReceipt, RpcResult};
use xharness_core::IdentityContextPolicy;
use xharness_debug::DebugRecorder;
use xharness_host::{
    BasicHost, DurableQuestionHub, HostConfig, LoopAgentRuntime, PermissionPreset,
    SessionToolFactory,
};
use xharness_host_app::NativeToolFactory;
use xharness_interaction::ASK_USER_QUESTION_TOOL;
use xharness_session::{EventData, Message, Revision, SessionHeader, Store, ToolCall};
use xharness_session_jsonl::JsonlSessionStore;
use xharness_tools::{ToolExecutor, ToolRequest};
use xharness_web::WebRuntime;

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "xh-question-no-memory-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("workspace")).unwrap();
        Self(std::fs::canonicalize(root).unwrap())
    }
    fn store(&self) -> Arc<dyn Store> {
        Arc::new(JsonlSessionStore::new(self.0.join("sessions")).unwrap())
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn arguments() -> String {
    // An old model/unfinished call may still supply this legacy enum value.
    json!({"questions":[{"id":"target","header":"Target","question":"Deploy where?", "options":[],
        "allowCustom":true,"destination":"agent_markdown"}]})
    .to_string()
}
fn request() -> ToolRequest {
    ToolRequest::new(ASK_USER_QUESTION_TOOL, arguments())
        .with_execution_id("original-question")
        .unwrap()
}
async fn prepare(store: &Arc<dyn Store>) {
    store.create(SessionHeader::new("session")).await.unwrap();
    let call = ToolCall {
        id: "original-question".into(),
        provider_call_id: None,
        index: 0,
        name: ASK_USER_QUESTION_TOOL.into(),
        arguments_json: arguments(),
    };
    let mut message = Message::assistant("");
    message.tool_calls.push(call.clone());
    store
        .append(
            "session",
            Revision::ZERO,
            vec![
                EventData::TurnStart { turn: 1 }.into(),
                EventData::UserMessage {
                    message: Message::user("Choose a deployment target"),
                    surface_replace: None,
                }
                .into(),
                EventData::StepStart { turn: 1, step: 1 }.into(),
                EventData::AssistantMessage {
                    turn: 1,
                    step: 1,
                    message,
                    usage: None,
                }
                .into(),
                EventData::ToolCall {
                    turn: 1,
                    step: 1,
                    call,
                }
                .into(),
            ],
        )
        .await
        .unwrap();
    store.flush("session").await.unwrap();
}
async fn compose(root: &Root, store: Arc<dyn Store>) -> (Arc<BasicHost>, ToolExecutor) {
    let hub = DurableQuestionHub::new(store);
    let tools = NativeToolFactory::new_with_questions(
        WebRuntime::default(),
        DebugRecorder::disabled(),
        hub.clone(),
    );
    let runtime = Arc::new(LoopAgentRuntime::new(
        "fixture",
        "none",
        None,
        tools.clone(),
        Arc::new(IdentityContextPolicy),
    ));
    let workspace = root.0.join("workspace");
    let host = BasicHost::with_agent_runtime_control_and_questions(
        HostConfig::new(&workspace),
        runtime,
        Arc::new(xharness_control::MemoryControlStore::default()),
        hub,
    );
    let executor = tools
        .executor(
            "session",
            &workspace.to_string_lossy(),
            PermissionPreset::DangerFullAccess,
        )
        .await
        .unwrap();
    (host, executor)
}
async fn question_frame(host: &BasicHost) -> xharness_api::ServerRequest {
    let mut frames = host.mux_events();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let frame = frames.next().await.unwrap();
            if frame.method == "question/requested" {
                return frame;
            }
        }
    })
    .await
    .unwrap()
}
fn model_answer(result: xharness_tools::ToolResult) -> Value {
    assert!(result.is_ok(), "{result:?}");
    let output = result.output.unwrap();
    assert!(output
        .metadata
        .unwrap()
        .get("requestsAgentMarkdown")
        .is_none());
    let value: Value = serde_json::from_str(&output.content).unwrap();
    assert_eq!(value["answers"][0]["destination"], "context");
    assert_eq!(value["answers"][0]["customText"], "local, this task only");
    value
}

#[tokio::test]
async fn questions_never_create_or_modify_agents_even_on_legacy_cold_replay() {
    for kind in ["absent", "existing", "readonly", "directory"] {
        for restart_pending in [false, true] {
            let root = Root::new();
            let path = root.0.join("workspace/AGENTS.md");
            let existing = b"# User rules\nKeep every byte.\n<!-- XHARNESS:USER-MEMORY:BEGIN -->\nOld note.\n<!-- XHARNESS:USER-MEMORY:END -->\n";
            if kind == "directory" {
                std::fs::create_dir(&path).unwrap();
                std::fs::write(path.join("sentinel"), b"unchanged").unwrap();
            } else if kind != "absent" {
                std::fs::write(&path, existing).unwrap();
            }
            let original_permissions = (kind == "readonly").then(|| {
                let original = std::fs::metadata(&path).unwrap().permissions();
                let mut readonly = original.clone();
                readonly.set_readonly(true);
                std::fs::set_permissions(&path, readonly).unwrap();
                original
            });
            let store = root.store();
            prepare(&store).await;
            let (host, executor) = compose(&root, store.clone()).await;
            let waiting = tokio::spawn(async move { executor.execute(request()).await });
            let frame = question_frame(&host).await;
            let (host, waiting, frame) = if restart_pending {
                waiting.abort();
                let _ = waiting.await;
                drop(host);
                drop(store);
                let (host, executor) = compose(&root, root.store()).await;
                let waiting = tokio::spawn(async move { executor.execute(request()).await });
                let restored = question_frame(&host).await;
                assert_eq!(restored.rpc_id, frame.rpc_id);
                (host, waiting, restored)
            } else {
                (host, waiting, frame)
            };
            assert_eq!(
                host.respond(ClientResponse {
                    kind: ClientResponseKind::ClientResponse,
                    rpc_id: frame.rpc_id,
                    result: RpcResult::success(json!({"sessionId":"session","answer":{"answers":[{
                    "id":"target","selected":[],"custom":"local, this task only"}]}})),
                })
                .await,
                RpcReceipt::Accepted
            );
            let answer = model_answer(
                tokio::time::timeout(Duration::from_secs(5), waiting)
                    .await
                    .unwrap()
                    .unwrap(),
            );
            drop(host);
            // Reopen the JSONL store and replay the already answered old call.
            // No second answer or request event may be created.
            let store = root.store();
            let (host, executor) = compose(&root, store.clone()).await;
            let replayed =
                tokio::time::timeout(Duration::from_secs(5), executor.execute(request()))
                    .await
                    .unwrap();
            assert_eq!(model_answer(replayed), answer);
            let session = store.load("session").await.unwrap().unwrap();
            assert_eq!(
                session
                    .events()
                    .iter()
                    .filter(|event| matches!(event.data(), EventData::QuestionRequested { .. }))
                    .count(),
                1
            );
            assert_eq!(
                session
                    .events()
                    .iter()
                    .filter(|event| matches!(event.data(), EventData::QuestionResolved { .. }))
                    .count(),
                1
            );
            match kind {
                "absent" => assert!(!path.exists()),
                "directory" => {
                    assert_eq!(std::fs::read(path.join("sentinel")).unwrap(), b"unchanged")
                }
                _ => assert_eq!(std::fs::read(&path).unwrap(), existing),
            }
            if let Some(permissions) = original_permissions {
                std::fs::set_permissions(&path, permissions).unwrap();
            }
            drop(host);
        }
    }
}

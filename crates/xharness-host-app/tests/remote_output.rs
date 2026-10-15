//! Actual native Agent journal -> scoped projection -> Telegram-shaped HTTP.
//! Fixture provider and loopback platform only, not real-platform/model acceptance.
use async_trait::async_trait;
use axum::{
    body::Bytes,
    extract::{OriginalUri, State},
    http::HeaderMap,
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
use xharness_channel_telegram::{
    format_command_reply, run_interactions, BotToken, Client, Replies,
};
use xharness_core::{
    FinishReason, IdentityContextPolicy, ModelProvider, ProviderError, ProviderEvent,
    ProviderRequest, ProviderStream,
};
use xharness_host::{
    AgentRuntime, BasicHost, DurableLoopAgentRuntime, HostConfig, PermissionPreset,
    SessionToolFactory,
};
use xharness_remote::*;
struct Provider(AtomicUsize);
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
        request: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        if request.step == 1 {
            return Ok(Box::pin(futures::stream::iter([
                Ok(ProviderEvent::ToolCallDelta {
                    index: 0,
                    id: "fixture-media-call".into(),
                    name: "fixture_media".into(),
                    arguments_delta: "{}".into(),
                }),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::ToolCalls),
                    usage: None,
                    provider_items: vec![],
                }),
            ])));
        }
        Ok(Box::pin(futures::stream::iter([
            Ok(ProviderEvent::TextDelta("Native response 你好 🧪".into())),
            Ok(ProviderEvent::Completed {
                finish_reason: Some(FinishReason::Stop),
                usage: None,
                provider_items: vec![],
            }),
        ])))
    }
}

const PNG: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
    0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240, 31, 0,
    5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];
struct MediaTools {
    store: Arc<xharness_attachments::FileAttachmentStore>,
    executions: Arc<AtomicUsize>,
}
#[async_trait]
impl SessionToolFactory for MediaTools {
    async fn executor(
        &self,
        session: &str,
        _: &str,
        _: PermissionPreset,
    ) -> Result<xharness_tools::ToolExecutor, String> {
        use xharness_attachments::{AttachmentStore, Upload};
        use xharness_tools::{
            ToolDefinition, ToolExecutor, ToolHandlerError, ToolOutput, ToolRegistry, ToolSpec,
        };
        let registry = Arc::new(ToolRegistry::new());
        let store = self.store.clone();
        let session = session.to_owned();
        let executions = self.executions.clone();
        registry
            .register(ToolSpec::new(
                ToolDefinition::new(
                    "fixture_media",
                    "disposable attachment tool",
                    json!({"type":"object","properties":{}}),
                ),
                move |_| {
                    let store = store.clone();
                    let session = session.clone();
                    let executions = executions.clone();
                    async move {
                        executions.fetch_add(1, Ordering::SeqCst);
                        let file = store
                            .put_file(
                                &session,
                                Upload {
                                    media_type: "text/plain".into(),
                                    data: b"native tool attachment\n".to_vec(),
                                },
                            )
                            .await
                            .map_err(|_| ToolHandlerError::new("fixture file storage"))?;
                        let image = store
                            .put(
                                &session,
                                Upload {
                                    media_type: "image/png".into(),
                                    data: PNG.to_vec(),
                                },
                            )
                            .await
                            .map_err(|_| ToolHandlerError::new("fixture image storage"))?;
                        let blocks = vec![
                            xharness_session::ContentBlock::File {
                                attachment: file,
                                name: Some("PRIVATE_TOOL_PATH.txt".into()),
                            },
                            xharness_session::ContentBlock::Image { attachment: image },
                        ];
                        Ok(ToolOutput {
                            content: "PRIVATE_TOOL_STDOUT".into(),
                            metadata: Some(json!({"xharnessContentBlocks":blocks})),
                            command_failure: None,
                        })
                    }
                },
            ))
            .await
            .map_err(|e| e.to_string())?;
        Ok(ToolExecutor::new(registry))
    }
}

struct Root(std::path::PathBuf);
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
type Requests = Arc<Mutex<Vec<(String, Value)>>>;
async fn platform(
    State(requests): State<Requests>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    raw: Bytes,
) -> Json<Value> {
    let method = uri.path().rsplit('/').next().unwrap();
    let body = if method == "sendDocument" || method == "sendPhoto" {
        let text = String::from_utf8_lossy(&raw);
        assert!(headers["content-type"]
            .to_str()
            .unwrap()
            .starts_with("multipart/form-data; boundary="));
        let media = if method == "sendPhoto" {
            assert!(raw.windows(PNG.len()).any(|w| w == PNG));
            "png"
        } else if text.contains("native tool attachment\n") {
            "tool_file"
        } else {
            assert!(text.contains("disposable attachment\n"));
            "user_file"
        };
        assert!(text.contains(if method == "sendPhoto" {
            "filename=\"attachment.png\""
        } else {
            "filename=\"attachment.txt\""
        }));
        assert!(!text.contains("private-source-name"));
        assert!(!text.contains("PRIVATE_TOOL"));
        json!({"chat_id":42,"fixture_bytes":media})
    } else {
        serde_json::from_slice::<Value>(&raw).unwrap()
    };
    let mut requests = requests.lock().unwrap();
    requests.push((method.into(), body.clone()));
    let result = match method {
        "getMe" => json!({"id":123456,"is_bot":true}),
        "getWebhookInfo" => json!({"url":""}),
        "sendMessage" | "sendDocument" | "sendPhoto" => {
            json!({"message_id":requests.len(),"chat":{"id":body["chat_id"],"type":"private"}})
        }
        "editMessageText" => {
            json!({"message_id":body["message_id"],"chat":{"id":body["chat_id"],"type":"private"}})
        }
        _ => panic!("unexpected fixture request"),
    };
    Json(json!({"ok":true,"result":result}))
}
#[tokio::test]
async fn native_prompt_to_durable_output_http_once_and_reopen_without_model_or_send_replay() {
    let root = Root(std::env::temp_dir().join(format!("xh-native-output-{}", std::process::id())));
    std::fs::create_dir_all(root.0.join("workspace")).unwrap();
    let provider = Arc::new(Provider(AtomicUsize::new(0)));
    let attachments = Arc::new(
        xharness_attachments::FileAttachmentStore::new(root.0.join("attachments")).unwrap(),
    );
    let executions = Arc::new(AtomicUsize::new(0));
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "fixture",
        "fixture",
        Some(provider.clone()),
        Arc::new(MediaTools {
            store: attachments.clone(),
            executions: executions.clone(),
        }),
        Arc::new(IdentityContextPolicy),
        Arc::new(xharness_session::MemorySessionStore::default()),
        Arc::new(xharness_agent::MemoryLeaseManager::default()),
        64,
    ));
    let mut config = HostConfig::new(root.0.join("workspace"));
    config.provider_id = "fixture".into();
    config.model_id = "fixture".into();
    config.auto_titles = false;
    config.attachment_store = attachments.clone();
    let host = BasicHost::with_agent_runtime(config, runtime.clone());
    let created = host
        .call(
            RpcId::new("create"),
            RpcMethod::SessionCreate,
            json!({"workspaceId":"workspace-default","sessionId":"s"}),
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(created, RpcResult::Success { .. }), "{created:?}");
    let g = Gateway::open(&root.0.join("remote"), "h".into(), host.clone()).unwrap();
    let sender = Sender {
        channel: Channel::Telegram,
        account: "123456".into(),
        user: "42".into(),
    };
    g.set_principal(Principal {
        id: "p".into(),
        host: "h".into(),
        sender: sender.clone(),
        workspaces: ["workspace-default".into()].into(),
        sessions: ["s".into()].into(),
        revision: 1,
        revoked: false,
    })
    .await
    .unwrap();
    g.bind(Binding {
        id: "b".into(),
        principal: "p".into(),
        conversation: "42".into(),
        workspace: "workspace-default".into(),
        session: "s".into(),
        generation: 1,
    })
    .await
    .unwrap();
    let requests: Requests = Default::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/{*path}", post(platform))
        .with_state(requests.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = Arc::new(
        Client::loopback_fixture(
            BotToken::new("123456:fixture-only".into()).unwrap(),
            &format!("http://{addr}"),
        )
        .unwrap(),
    );
    let transport = Arc::new(Replies::connect(client, 123456).await.unwrap());
    let lease = g
        .acquire_account(transport.account().clone())
        .await
        .unwrap();
    let scope = Subscription {
        principal: "p".into(),
        sender: sender.clone(),
        conversation: "42".into(),
        binding: "b".into(),
        generation: 1,
    };
    let admitted = g
        .accept(
            "p",
            sender,
            "42".into(),
            Inbound {
                request_id: "native-prompt".into(),
                binding: "b".into(),
                generation: 1,
                command: Command::Prompt {
                    mode: PromptMode::Queue,
                    content: vec![
                        Content::Text {
                            text: "respond".into(),
                        },
                        Content::File {
                            media_type: "text/plain".into(),
                            data: "ZGlzcG9zYWJsZSBhdHRhY2htZW50Cg==".into(),
                            name: Some("private-source-name.txt".into()),
                        },
                    ],
                    client_time_zone: None,
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(
        g.dispatch(&admitted.key).await.unwrap().state,
        DeliveryState::Completed
    );
    // Finish before starting the observer: proves the first-result startup race.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let page = host
                .session_event_page("workspace-default", "s", Some(0))
                .await
                .unwrap();
            if page
                .events
                .iter()
                .any(|f| f.payload["event"]["type"] == "turn/end")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let stop = CancellationToken::new();
    let observer = tokio::spawn({
        let g = g.clone();
        let lease = lease.clone();
        let stop = stop.clone();
        async move {
            let result = run_interactions(g, lease, stop).await;
            if result.is_err() {
                eprintln!("NATIVE_MEDIA_OBSERVER_RESULT: {result:?}");
            }
            result
        }
    });
    let sends = tokio::spawn({
        let g = g.clone();
        let lease = lease.clone();
        let transport = transport.clone();
        let stop = stop.clone();
        async move {
            let result = g.run_replies(lease, transport, stop).await;
            if result.is_err() {
                eprintln!("NATIVE_MEDIA_SENDER_RESULT: {result:?}");
            }
            result
        }
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let cp = g
                .projection_checkpoint(&lease, scope.clone())
                .await
                .unwrap();
            let head = host
                .session_event_page("workspace-default", "s", None)
                .await
                .unwrap()
                .head_seq;
            let mut done = cp.next_seq == head;
            for k in &cp.pending {
                done &= g.inspect_reply(k).await.unwrap().unwrap().state == ReplyState::Delivered;
            }
            if done {
                break;
            }
            if observer.is_finished() || sends.is_finished() {
                eprintln!("NATIVE_MEDIA_CHECKPOINT: {cp:?}");
                for k in &cp.pending {
                    eprintln!(
                        "NATIVE_MEDIA_OUTBOX: {:?}",
                        g.inspect_reply(k).await.unwrap()
                    );
                }
                eprintln!(
                    "NATIVE_MEDIA_PAGE: {:?}",
                    host.session_event_page("workspace-default", "s", Some(0))
                        .await
                        .unwrap()
                );
                panic!("native media worker failed");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(provider.0.load(Ordering::SeqCst), 2);
    let history = g
        .accept(
            "p",
            scope.sender.clone(),
            "42".into(),
            Inbound {
                request_id: "history-no-cursor".into(),
                binding: "b".into(),
                generation: 1,
                command: Command::History {
                    before_seq: None,
                    max_messages: 25,
                },
            },
        )
        .await
        .unwrap();
    let read = g.dispatch(&history.key).await.unwrap();
    assert!(
        matches!(read.result, Some(RpcResult::Success { .. })),
        "{read:?}"
    );
    let formatted = format_command_reply(&read).unwrap();
    assert!(
        formatted
            .iter()
            .any(|p| p.body.text.starts_with("History — session s")),
        "native history shape: {read:?}; formatted: {formatted:?}"
    );
    let media = formatted
        .iter()
        .find_map(|p| p.body.attachment.as_ref())
        .expect("genuine native file history");
    let resolved = host
        .session_event_attachment("workspace-default", "s", media.event_seq, &media.id)
        .await
        .unwrap();
    assert_eq!(resolved.data, b"disposable attachment\n");
    assert!(host
        .session_event_attachment("foreign", "s", media.event_seq, &media.id)
        .await
        .is_err());
    assert!(host
        .session_event_attachment("workspace-default", "s", media.event_seq + 1, &media.id)
        .await
        .is_err());
    assert!(host
        .session_event_attachment("workspace-default", "s", media.event_seq, &"0".repeat(64))
        .await
        .is_err());
    let unreferenced = xharness_attachments::AttachmentStore::put_file(
        attachments.as_ref(),
        "s",
        xharness_attachments::Upload {
            media_type: "text/plain".into(),
            data: b"unreferenced stored bytes".to_vec(),
        },
    )
    .await
    .unwrap();
    assert!(
        host.session_event_attachment("workspace-default", "s", media.event_seq, &unreferenced.id)
            .await
            .is_err(),
        "same-owner disk presence is not event membership"
    );
    let tail = g
        .accept(
            "p",
            scope.sender.clone(),
            "42".into(),
            Inbound {
                request_id: "history-tail".into(),
                binding: "b".into(),
                generation: 1,
                command: Command::History {
                    before_seq: None,
                    max_messages: 1,
                },
            },
        )
        .await
        .unwrap();
    let tail = g.dispatch(&tail.key).await.unwrap();
    let tail_text = format_command_reply(&tail)
        .unwrap()
        .into_iter()
        .map(|p| p.body.text)
        .collect::<String>();
    assert!(tail_text.contains("Native response 你好 🧪"), "{tail_text}");
    let cursor = tail_text
        .lines()
        .find(|l| l.starts_with("Earlier history: /history 1 "))
        .unwrap()
        .split_whitespace()
        .last()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let older = g
        .accept(
            "p",
            scope.sender.clone(),
            "42".into(),
            Inbound {
                request_id: "history-older".into(),
                binding: "b".into(),
                generation: 1,
                command: Command::History {
                    before_seq: Some(cursor),
                    max_messages: 25,
                },
            },
        )
        .await
        .unwrap();
    let older = g.dispatch(&older.key).await.unwrap();
    let older_text = format_command_reply(&older)
        .unwrap()
        .into_iter()
        .map(|p| p.body.text)
        .collect::<String>();
    assert!(older_text.contains("User\nrespond"), "{older_text}");
    assert!(!older_text.contains("Native response 你好 🧪"));
    assert_eq!(provider.0.load(Ordering::SeqCst), 2);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let sent = requests.lock().unwrap().iter().any(|(m, b)| {
                m == "sendMessage"
                    && b["text"].as_str().is_some_and(|text| {
                        text.starts_with("History — session s")
                            && text.contains("Native response 你好 🧪")
                    })
            });
            if sent
                && g.command_reply_candidate(&lease, scope.clone())
                    .await
                    .unwrap()
                    .is_none()
                && g.pending_replies(&lease).await.unwrap().is_empty()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    {
        let wire = requests.lock().unwrap();
        assert_eq!(
            wire.iter().filter(|(m, _)| m == "sendDocument").count(),
            5,
            "one live tool file plus user/tool files for each explicit history page"
        );
        assert_eq!(wire.iter().filter(|(m, _)| m == "sendPhoto").count(), 3);
        assert_eq!(
            wire.iter()
                .filter(|(m, b)| m == "sendDocument" && b["fixture_bytes"] == "user_file")
                .count(),
            2,
            "incoming file never echoed by live output"
        );
        assert!(!serde_json::to_string(&*wire)
            .unwrap()
            .contains("PRIVATE_TOOL_STDOUT"));
        assert_eq!(executions.load(Ordering::SeqCst), 1);
        assert!(
            wire.iter().any(|(m, b)| m == "sendMessage"
                && b["text"] == "Assistant response\nNative response 你好 🧪"),
            "{wire:?}"
        );
        assert!(
            wire.iter()
                .any(|(m, b)| m == "sendMessage" && b["text"] == "Task completed"),
            "{wire:?}"
        );
    }
    stop.cancel();
    observer.await.unwrap().unwrap();
    sends.await.unwrap().unwrap();
    g.close().await.unwrap();
    let count = requests.lock().unwrap().len();
    let g = Gateway::open(&root.0.join("remote"), "h".into(), host).unwrap();
    let lease = g
        .acquire_account(transport.account().clone())
        .await
        .unwrap();
    let stop = CancellationToken::new();
    let observer = tokio::spawn(run_interactions(g.clone(), lease.clone(), stop.clone()));
    let sends = tokio::spawn(g.clone().run_replies(lease, transport, stop.clone()));
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(requests.lock().unwrap().len(), count);
    assert_eq!(provider.0.load(Ordering::SeqCst), 2);
    stop.cancel();
    observer.await.unwrap().unwrap();
    sends.await.unwrap().unwrap();
    g.close().await.unwrap();
    assert_eq!(executions.load(Ordering::SeqCst), 1);
    runtime.shutdown(Duration::from_secs(1)).await;
    server.abort();
}

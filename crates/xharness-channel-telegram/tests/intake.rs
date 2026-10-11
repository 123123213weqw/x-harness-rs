//! Real HTTP + SQLite + Gateway intake fixtures, not real Telegram/model acceptance.
use async_trait::async_trait;
use axum::{
    extract::{OriginalUri, State},
    http::StatusCode,
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use futures::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex},
};
use tokio::{sync::Semaphore, task::JoinHandle};
use tokio_util::sync::CancellationToken;
use xharness_api::{
    ApiBackend, ClientResponse, EventStream, RpcError, RpcId, RpcMethod, RpcReceipt, RpcResult,
};
use xharness_channel_telegram::Error;
use xharness_channel_telegram::*;
use xharness_remote::*;

#[derive(Default)]
struct Host {
    calls: Mutex<Vec<(RpcMethod, Value)>>,
    pending: Mutex<Option<xharness_api::ScopedInteraction>>,
    answers: Mutex<Vec<xharness_api::ScopedInteractionAnswer>>,
    subscriptions: std::sync::atomic::AtomicUsize,
    initial_gap: std::sync::atomic::AtomicBool,
    output_events: Mutex<Vec<Value>>,
    history_result: Mutex<Option<Value>>,
    catalogue_calls: std::sync::atomic::AtomicUsize,
}
#[async_trait]
impl ApiBackend for Host {
    async fn call(
        &self,
        _: RpcId,
        method: RpcMethod,
        payload: Value,
        _: CancellationToken,
    ) -> RpcResult {
        let history = method == RpcMethod::SessionHistory;
        self.calls.lock().unwrap().push((method, payload));
        if history {
            return RpcResult::success(
                self.history_result
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or(json!({"events":[],"hasMore":false})),
            );
        }
        RpcResult::success(json!({"accepted":true}))
    }
    async fn prompt_receipt(
        &self,
        _: &str,
        _: &RpcId,
        _: &Value,
    ) -> Result<Option<RpcResult>, RpcError> {
        Ok(None)
    }
    async fn session_in_workspace(&self, workspace: &str, session: &str) -> Result<bool, RpcError> {
        Ok(workspace == "w" && session == "s")
    }
    async fn scoped_catalogue(
        &self,
        q: xharness_api::ScopedCatalogueQuery,
    ) -> Result<ScopedCataloguePage, RpcError> {
        self.catalogue_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(ScopedCataloguePage {
            workspaces: vec![CatalogueWorkspace {
                id: "w".into(),
                title: "Workspace".into(),
            }],
            sessions: if q.after.is_some() {
                vec![]
            } else {
                vec![CatalogueSession {
                    workspace: "w".into(),
                    id: "s".into(),
                    title: Some("Durable title".into()),
                    running: false,
                    restoring: false,
                }]
            },
            next: None,
        })
    }
    async fn session_events(
        &self,
        workspace: &str,
        session: &str,
    ) -> Result<EventStream, RpcError> {
        assert_eq!((workspace, session), ("w", "s"));
        let ordinal = self
            .subscriptions
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let initial = self
            .pending
            .lock()
            .unwrap()
            .as_ref()
            .map(|p| p.frame.clone());
        let mut initial = initial.into_iter().collect::<Vec<_>>();
        if ordinal == 0 && self.initial_gap.load(std::sync::atomic::Ordering::SeqCst) {
            initial.push(
                xharness_api::MuxFrame::StreamError {
                    error: RpcError::internal("must-not-leak"),
                }
                .into_server_request(RpcId::new("gap")),
            );
        }
        Ok(Box::pin(
            futures::stream::iter(initial).chain(futures::stream::pending()),
        ))
    }
    async fn session_event_page(
        &self,
        w: &str,
        s: &str,
        after: Option<u64>,
    ) -> Result<xharness_api::ScopedEventPage, RpcError> {
        assert_eq!((w, s), ("w", "s"));
        let events = self.output_events.lock().unwrap();
        let head = events.len() as u64;
        let start = after.unwrap_or(head);
        if start > head {
            return Err(RpcError::internal("bad event cursor"));
        }
        let frames = events
            .iter()
            .enumerate()
            .skip(start as usize)
            .take(128)
            .map(|(seq, event)| {
                xharness_api::MuxFrame::SessionEvent {
                    session_id: s.into(),
                    event: event.clone(),
                    view: None,
                }
                .into_server_request(RpcId::new(format!("event-{seq}")))
            })
            .collect::<Vec<_>>();
        Ok(xharness_api::ScopedEventPage {
            start_seq: start,
            next_seq: start + frames.len() as u64,
            head_seq: head,
            events: frames,
        })
    }
    async fn session_interaction(
        &self,
        _: &str,
        _: &str,
        _: &RpcId,
    ) -> Result<Option<xharness_api::ScopedInteraction>, RpcError> {
        Ok(self.pending.lock().unwrap().clone())
    }
    async fn answer_session_interaction(
        &self,
        _: &str,
        _: &str,
        expected: xharness_api::ScopedInteraction,
        answer: xharness_api::ScopedInteractionAnswer,
    ) -> Result<xharness_api::ScopedInteractionReceipt, RpcError> {
        assert_eq!(self.pending.lock().unwrap().as_ref(), Some(&expected));
        self.answers.lock().unwrap().push(answer);
        Ok(xharness_api::ScopedInteractionReceipt::Accepted)
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("intake must never forward arbitrary responses")
    }
    fn mux_events(&self) -> EventStream {
        Box::pin(futures::stream::empty())
    }
    fn host_events(&self) -> EventStream {
        panic!("intake must never subscribe global events")
    }
}
struct FileGate {
    entered: Semaphore,
    release: Semaphore,
}
#[derive(Clone)]
struct Data {
    updates: Arc<Mutex<Value>>,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    file_status: Arc<Mutex<u16>>,
    send_status: Arc<Mutex<u16>>,
    file_gate: Arc<Mutex<Option<Arc<FileGate>>>>,
}
struct Fixture {
    client: Arc<Client>,
    data: Data,
    task: JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Fixture {
    async fn new(updates: Value) -> Self {
        let data = Data {
            updates: Arc::new(Mutex::new(updates)),
            requests: Default::default(),
            file_status: Arc::new(Mutex::new(200)),
            send_status: Arc::new(Mutex::new(200)),
            file_gate: Default::default(),
        };
        let app = Router::new()
            .route("/{*path}", post(handler).get(file_handler))
            .with_state(data.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = Arc::new(
            Client::loopback_fixture(
                BotToken::new("123456:fixture-intake-only".into()).unwrap(),
                &format!("http://{addr}"),
            )
            .unwrap(),
        );
        Self { client, data, task }
    }
    fn count(&self, method: &str) -> usize {
        self.data
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| m == method)
            .count()
    }
}
async fn handler(
    State(data): State<Data>,
    OriginalUri(uri): OriginalUri,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let method = uri.path().rsplit('/').next().unwrap();
    data.requests
        .lock()
        .unwrap()
        .push((method.into(), payload.clone()));
    let (status, value) = match method {
        "getMe" => (200, json!({"ok":true,"result":{"id":123456,"is_bot":true}})),
        "getWebhookInfo" => (200, json!({"ok":true,"result":{"url":""}})),
        "getUpdates" => (
            200,
            json!({"ok":true,"result":data.updates.lock().unwrap().clone()}),
        ),
        "answerCallbackQuery" => (200, json!({"ok":true,"result":true})),
        "sendMessage" => {
            let status = *data.send_status.lock().unwrap();
            if status != 200 {
                return (
                    StatusCode::from_u16(status).unwrap(),
                    Json(json!({"ok":false,"error_code":status})),
                );
            }
            let count = data
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|(m, _)| m == "sendMessage")
                .count();
            (
                200,
                json!({"ok":true,"result":{"message_id":199+count,"chat":{"id":payload["chat_id"],"type":"private"}}}),
            )
        }
        "editMessageText" => (
            200,
            json!({"ok":true,"result":{"message_id":payload["message_id"],"chat":{"id":payload["chat_id"],"type":"private"}}}),
        ),
        "getFile" => {
            let gate = data.file_gate.lock().unwrap().clone();
            if let Some(gate) = gate {
                gate.entered.add_permits(1);
                gate.release.acquire().await.unwrap().forget();
            }
            let status = *data.file_status.lock().unwrap();
            if status == 200 {
                (
                    200,
                    json!({"ok":true,"result":{"file_path":"photos/fixture.jpg","file_size":12}}),
                )
            } else {
                (status, json!({"ok":false,"error_code":status}))
            }
        }
        _ => (500, json!({"ok":false,"error_code":500})),
    };
    (StatusCode::from_u16(status).unwrap(), Json(value))
}
async fn file_handler() -> impl IntoResponse {
    (StatusCode::OK, b"fixture jpeg".to_vec())
}
fn message(id: u64, user: i64, text: &str) -> Value {
    json!({"update_id":id,"message":{"message_id":8,"from":{"id":user,"is_bot":false},"chat":{"id":user,"type":"private"},"text":text}})
}
fn photo(id: u64, user: i64) -> Value {
    let mut value = message(id, user, "");
    value["message"].as_object_mut().unwrap().remove("text");
    value["message"]["photo"] = json!([{"file_id":"photo-fixture","width":10,"height":20}]);
    value
}
fn principal() -> Principal {
    Principal {
        id: "p".into(),
        host: "h".into(),
        sender: Sender {
            channel: Channel::Telegram,
            account: "123456".into(),
            user: "42".into(),
        },
        workspaces: BTreeSet::from(["w".into()]),
        sessions: BTreeSet::from(["s".into()]),
        revision: 1,
        revoked: false,
    }
}
fn binding() -> Binding {
    Binding {
        id: "b".into(),
        principal: "p".into(),
        conversation: "42".into(),
        workspace: "w".into(),
        session: "s".into(),
        generation: 1,
    }
}
async fn gateway() -> (tempfile::TempDir, Arc<Gateway>, Arc<Host>) {
    let temp = tempfile::tempdir().unwrap();
    let host = Arc::new(Host::default());
    let gateway = Gateway::open(temp.path(), "h".into(), host.clone()).unwrap();
    gateway.set_principal(principal()).await.unwrap();
    gateway.bind(binding()).await.unwrap();
    (temp, gateway, host)
}
async fn connect(f: &Fixture, g: &Arc<Gateway>) -> Intake {
    Intake::connect(f.client.clone(), g.clone(), 123456)
        .await
        .unwrap()
}
fn delivery_key(receipt: &ReceiveReceipt) -> &str {
    match &receipt.outcome {
        ReceiveOutcome::Accepted { delivery_key } => delivery_key,
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn durable_intake_does_not_dispatch_or_send_and_restart_uses_committed_offset() {
    let fixture = Fixture::new(json!([message(17, 42, "hello")])).await;
    let (temp, g, host) = gateway().await;
    let mut intake = connect(&fixture, &g).await;
    let receipts = intake.poll_once(0).await.unwrap();
    assert_eq!(receipts.len(), 1);
    let key = delivery_key(&receipts[0]).to_owned();
    assert_eq!(
        g.inspect(&key).await.unwrap().unwrap().state,
        DeliveryState::Queued
    );
    assert!(host.calls.lock().unwrap().is_empty());
    assert_eq!(fixture.count("sendMessage"), 0);
    drop(intake);
    drop(g);
    let restored = Gateway::open(temp.path(), "h".into(), host.clone()).unwrap();
    let mut intake = connect(&fixture, &restored).await;
    assert!(intake.poll_once(0).await.unwrap().is_empty());
    {
        let requests = fixture.data.requests.lock().unwrap();
        let polls: Vec<_> = requests
            .iter()
            .filter(|(method, _)| method == "getUpdates")
            .collect();
        assert!(polls[0].1["offset"].is_null());
        assert_eq!(polls[1].1["offset"], 18);
    }
    restored.dispatch(&key).await.unwrap();
    assert_eq!(host.calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn unbound_poison_callbacks_and_unsupported_media_have_durable_dispositions() {
    let mut unknown_media = message(20, 42, "do not discard this attachment");
    unknown_media["message"]["voice"] = json!({"file_id":"must-not-fetch"});
    let callback = json!({"update_id":19,"callback_query":{"id":"fixture","from":{"id":42,"is_bot":false},
        "message":{"message_id":8,"chat":{"id":42,"type":"private"}},"data":"session.cancel:s"}});
    let fixture = Fixture::new(
        json!([photo(17,99), {"update_id":18,"message":{"bad":"shape"}},callback,unknown_media]),
    )
    .await;
    let (_temp, g, host) = gateway().await;
    let mut intake = connect(&fixture, &g).await;
    let receipts = intake.poll_once(0).await.unwrap();
    assert_eq!(
        receipts
            .iter()
            .map(|r| r.outcome.clone())
            .collect::<Vec<_>>(),
        vec![
            ReceiveOutcome::Rejected {
                code: RejectionCode::UnboundSender
            },
            ReceiveOutcome::Rejected {
                code: RejectionCode::Malformed
            },
            ReceiveOutcome::Rejected {
                code: RejectionCode::Unsupported
            },
            ReceiveOutcome::Rejected {
                code: RejectionCode::Unsupported
            }
        ]
    );
    assert_eq!(fixture.count("getFile"), 0);
    assert!(host.calls.lock().unwrap().is_empty());
    let next = g.acquire_account(intake.account().clone()).await.unwrap();
    assert_eq!(next.cursor, "21");
}

#[tokio::test]
async fn partial_batch_failure_keeps_first_receipt_and_retries_only_uncommitted_suffix() {
    let fixture = Fixture::new(json!([message(17, 42, "first"), photo(18, 42)])).await;
    let (_temp, g, host) = gateway().await;
    let mut intake = connect(&fixture, &g).await;
    *fixture.data.file_status.lock().unwrap() = 500;
    assert!(matches!(
        intake.poll_once(0).await,
        Err(IntakeError::Transport(Error::Rejected { status: 500 }))
    ));
    let pending = g.pending().await.unwrap();
    assert_eq!(pending.len(), 1);
    *fixture.data.file_status.lock().unwrap() = 200;
    let receipts = intake.poll_once(0).await.unwrap();
    assert_eq!(receipts.len(), 1);
    let image = g
        .inspect(delivery_key(&receipts[0]))
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(&image.inbound.command,Command::Prompt {content,..} if matches!(&content[0],Content::Image {..}))
    );
    assert_eq!(image.state, DeliveryState::Queued);
    assert_ne!(image.key, pending[0].key);
    assert_eq!(g.pending().await.unwrap().len(), 1); // Only the FIFO head is eligible.
    assert!(host.calls.lock().unwrap().is_empty());
    let polls = fixture.data.requests.lock().unwrap();
    assert_eq!(
        polls.iter().rfind(|(m, _)| m == "getUpdates").unwrap().1["offset"],
        18
    );
}

#[tokio::test]
async fn unknown_or_unordered_update_id_never_acknowledges_earlier_batch_elements() {
    let fixture =
        Fixture::new(json!([message(17,42,"first"),{"message":{"text":"missing id"}}])).await;
    let (_temp, g, _host) = gateway().await;
    let mut intake = connect(&fixture, &g).await;
    assert!(matches!(
        intake.poll_once(0).await,
        Err(IntakeError::Transport(Error::MalformedResponse))
    ));
    assert!(g.pending().await.unwrap().is_empty());
    *fixture.data.updates.lock().unwrap() = json!([message(18, 42, "a"), message(17, 42, "b")]);
    assert!(intake.poll_once(0).await.is_err());
    assert!(g.pending().await.unwrap().is_empty());
    assert_eq!(fixture.count("getFile"), 0);
}

#[tokio::test]
async fn new_poller_fences_old_and_wrong_bot_token_cannot_take_over_cursor() {
    let fixture = Fixture::new(json!([message(17, 42, "first")])).await;
    let (_temp, g, _host) = gateway().await;
    let mut old = connect(&fixture, &g).await;
    assert!(matches!(
        Intake::connect(fixture.client.clone(), g.clone(), 654321).await,
        Err(IntakeError::Transport(Error::Configuration))
    ));
    old.poll_once(0).await.unwrap();
    let mut new = connect(&fixture, &g).await;
    let count = fixture.count("getUpdates");
    assert!(matches!(old.poll_once(0).await, Err(IntakeError::Journal)));
    assert_eq!(fixture.count("getUpdates"), count);
    assert!(new.poll_once(0).await.unwrap().is_empty());
}

#[tokio::test]
async fn revoke_during_media_fetch_prevents_admission_and_cursor_still_records_rejection() {
    let fixture = Fixture::new(json!([photo(17, 42)])).await;
    let (_temp, g, host) = gateway().await;
    let mut intake = connect(&fixture, &g).await;
    let gate = Arc::new(FileGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    *fixture.data.file_gate.lock().unwrap() = Some(gate.clone());
    let task = tokio::spawn(async move { intake.poll_once(0).await });
    gate.entered.acquire().await.unwrap().forget();
    g.revoke("p").await.unwrap();
    gate.release.add_permits(1);
    let receipts = task.await.unwrap().unwrap();
    assert_eq!(
        receipts[0].outcome,
        ReceiveOutcome::Rejected {
            code: RejectionCode::Forbidden
        }
    );
    assert!(g.pending().await.unwrap().is_empty());
    assert!(host.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn ambiguous_desktop_route_fails_closed_before_file_network_or_cursor_advance() {
    let fixture = Fixture::new(json!([photo(17, 42)])).await;
    let (_temp, g, _host) = gateway().await;
    let mut intake = connect(&fixture, &g).await;
    let mut other = binding();
    other.id = "other".into();
    g.bind(other).await.unwrap();
    assert!(matches!(
        intake.poll_once(0).await,
        Err(IntakeError::Journal)
    ));
    assert_eq!(fixture.count("getFile"), 0);
    assert!(g.pending().await.unwrap().is_empty());
}

#[tokio::test]
async fn typed_commands_have_no_arbitrary_rpc_and_file_errors_do_not_silently_drop_media() {
    let fixture = Fixture::new(json!([
        message(17, 42, "/cancel"),
        message(18, 42, "/history 12"),
        message(19, 42, "/steer next"),
        message(20, 42, "/host.openPath /etc/passwd"),
        photo(21, 42)
    ]))
    .await;
    let (_temp, g, _host) = gateway().await;
    let mut intake = connect(&fixture, &g).await;
    *fixture.data.file_status.lock().unwrap() = 400;
    let receipts = intake.poll_once(0).await.unwrap();
    assert_eq!(receipts.len(), 5);
    assert!(matches!(
        g.inspect(delivery_key(&receipts[0]))
            .await
            .unwrap()
            .unwrap()
            .inbound
            .command,
        Command::Cancel
    ));
    assert!(matches!(
        g.inspect(delivery_key(&receipts[1]))
            .await
            .unwrap()
            .unwrap()
            .inbound
            .command,
        Command::History {
            max_messages: 12,
            ..
        }
    ));
    assert!(matches!(
        g.inspect(delivery_key(&receipts[2]))
            .await
            .unwrap()
            .unwrap()
            .inbound
            .command,
        Command::Prompt {
            mode: PromptMode::Steer,
            ..
        }
    ));
    assert!(receipts[3..].iter().all(|r| r.outcome
        == ReceiveOutcome::Rejected {
            code: RejectionCode::InvalidCommand
        }));
    for receipt in &receipts[..3] {
        assert_eq!(
            g.inspect(delivery_key(receipt))
                .await
                .unwrap()
                .unwrap()
                .state,
            DeliveryState::Queued
        );
    }
    assert_eq!(g.pending().await.unwrap().len(), 1);
}

#[tokio::test]
async fn cancelling_poll_lifetime_leaves_accepted_work_available_to_supervisor() {
    let fixture = Fixture::new(json!([message(17, 42, "durable")])).await;
    let (_temp, g, host) = gateway().await;
    let mut intake = connect(&fixture, &g).await;
    let receipt = intake.poll_once(0).await.unwrap().remove(0);
    let stop = CancellationToken::new();
    stop.cancel();
    intake.run(stop).await.unwrap();
    assert_eq!(fixture.count("getUpdates"), 1);
    g.dispatch(delivery_key(&receipt)).await.unwrap();
    assert_eq!(host.calls.lock().unwrap().len(), 1);
}

fn approval_snapshot() -> xharness_api::ScopedInteraction {
    xharness_api::ScopedInteraction {
        nonce: "native-test-instance".into(),
        frame: xharness_api::ServerRequest::new(
            RpcId::new("approval"),
            "approval/requested",
            json!({"type":"approval/requested","sessionId":"s","approvalId":"a","toolName":"fixture","callId":"c","reviewing":false}),
        ),
    }
}
fn callback(id: u64, user: i64, data: String) -> Value {
    json!({"update_id":id,"callback_query":{"id":format!("platform-callback-{id}"),"from":{"id":user,"is_bot":false},"message":{"message_id":8,"from":{"id":123456,"is_bot":true},"chat":{"id":user,"type":"private"}},"data":data}})
}
fn subscription() -> Subscription {
    Subscription {
        principal: "p".into(),
        sender: principal().sender,
        conversation: "42".into(),
        binding: "b".into(),
        generation: 1,
    }
}
#[tokio::test]
async fn actual_http_callback_journals_before_ack_then_native_ticket_dispatches_once() {
    let fixture = Fixture::new(json!([])).await;
    let (_dir, g, host) = gateway().await;
    *host.pending.lock().unwrap() = Some(approval_snapshot());
    let ticket = g
        .mint_interaction_ticket(subscription(), RpcId::new("approval"), 60)
        .await
        .unwrap();
    let mut intake = connect(&fixture, &g).await;
    *fixture.data.updates.lock().unwrap() =
        json!([callback(17, 42, format!("a:{}", ticket.token.as_str()))]);
    let receipts = intake.poll_once(0).await.unwrap();
    let ReceiveOutcome::Accepted { delivery_key } = &receipts[0].outcome else {
        panic!("callback must journal");
    };
    assert!(host.answers.lock().unwrap().is_empty()); // Polling never responds to Host.
    assert_eq!(
        g.account_checkpoint(&intake.lease()).await.unwrap().cursor,
        "18"
    );
    assert_eq!(fixture.count("answerCallbackQuery"), 1);
    let ack = fixture
        .data
        .requests
        .lock()
        .unwrap()
        .iter()
        .find(|(m, _)| m == "answerCallbackQuery")
        .unwrap()
        .1
        .clone();
    assert_eq!(ack["text"], "Received"); // Not a false "approved".
    assert_eq!(
        g.dispatch(delivery_key).await.unwrap().state,
        DeliveryState::Completed
    );
    assert_eq!(
        host.answers.lock().unwrap().as_slice(),
        &[xharness_api::ScopedInteractionAnswer::Approval { allowed: true }]
    );
    assert!(intake.poll_once(0).await.unwrap().is_empty()); // Offset reload, no callback/control replay.
    *fixture.data.updates.lock().unwrap() =
        json!([callback(18, 42, format!("r:{}", ticket.token.as_str()))]);
    assert_eq!(
        intake.poll_once(0).await.unwrap()[0].outcome,
        ReceiveOutcome::Rejected {
            code: RejectionCode::Forbidden
        }
    );
    assert_eq!(host.answers.lock().unwrap().len(), 1);
    assert!(host.calls.lock().unwrap().is_empty());
}
#[tokio::test]
async fn callback_handle_does_not_authorize_forwarded_sender_or_forged_raw_rpc() {
    let fixture = Fixture::new(json!([])).await;
    let (_dir, g, host) = gateway().await;
    *host.pending.lock().unwrap() = Some(approval_snapshot());
    let ticket = g
        .mint_interaction_ticket(subscription(), RpcId::new("approval"), 60)
        .await
        .unwrap();
    let mut p = principal();
    p.id = "p2".into();
    p.sender.user = "43".into();
    g.set_principal(p).await.unwrap();
    let mut b = binding();
    b.id = "b2".into();
    b.principal = "p2".into();
    b.conversation = "43".into();
    g.bind(b).await.unwrap();
    *fixture.data.updates.lock().unwrap() = json!([
        callback(17, 43, format!("a:{}", ticket.token.as_str())),
        callback(18, 42, "a:".to_string() + &"b".repeat(48)),
        callback(19, 42, "session.cancel:s".into())
    ]);
    let mut intake = connect(&fixture, &g).await;
    let receipts = intake.poll_once(0).await.unwrap();
    assert_eq!(
        receipts[0].outcome,
        ReceiveOutcome::Rejected {
            code: RejectionCode::Forbidden
        }
    );
    assert_eq!(
        receipts[1].outcome,
        ReceiveOutcome::Rejected {
            code: RejectionCode::Forbidden
        }
    );
    assert_eq!(
        receipts[2].outcome,
        ReceiveOutcome::Rejected {
            code: RejectionCode::Unsupported
        }
    );
    assert!(host.answers.lock().unwrap().is_empty());
    assert!(host.calls.lock().unwrap().is_empty());
    assert_eq!(
        g.account_checkpoint(&intake.lease()).await.unwrap().cursor,
        "20"
    );
}
#[tokio::test]
async fn full_typed_question_answer_has_no_raw_response_or_silently_dropped_media() {
    let fixture = Fixture::new(json!([])).await;
    let (_dir, g, host) = gateway().await;
    *host.pending.lock().unwrap() = Some(xharness_api::ScopedInteraction {
        nonce: "question-instance".into(),
        frame: xharness_api::ServerRequest::new(
            RpcId::new("question"),
            "question/requested",
            json!({"type":"question/requested","sessionId":"s","questions":[{"id":"target","header":"Pick","question":"Where?","options":[{"label":"Local"}],"multiSelect":false}]}),
        ),
    });
    let ticket = g
        .mint_interaction_ticket(subscription(), RpcId::new("question"), 60)
        .await
        .unwrap();
    let text = format!(
        "/answer {} {}",
        ticket.token.as_str(),
        json!([{"id":"target","selected":"Local","custom":null}])
    );
    let mut with_media = message(18, 42, &text);
    with_media["message"]["photo"] = json!([{"file_id":"never-fetch","width":1,"height":1}]);
    let raw = format!(
        "/answer {} {}",
        ticket.token.as_str(),
        json!([{"id":"target","selected":"Local","custom":null,"rpcId":"forged"}])
    );
    *fixture.data.updates.lock().unwrap() =
        json!([message(17, 42, &text), with_media, message(19, 42, &raw)]);
    let mut intake = connect(&fixture, &g).await;
    let receipts = intake.poll_once(0).await.unwrap();
    let ReceiveOutcome::Accepted { delivery_key } = &receipts[0].outcome else {
        panic!("typed question answer must journal")
    };
    assert_eq!(
        receipts[1].outcome,
        ReceiveOutcome::Rejected {
            code: RejectionCode::InvalidCommand
        }
    );
    assert_eq!(
        receipts[2].outcome,
        ReceiveOutcome::Rejected {
            code: RejectionCode::InvalidCommand
        }
    );
    assert_eq!(fixture.count("getFile"), 0);
    assert!(host.answers.lock().unwrap().is_empty());
    assert_eq!(
        g.dispatch(delivery_key).await.unwrap().state,
        DeliveryState::Completed
    );
    assert!(
        matches!(&host.answers.lock().unwrap()[0],xharness_api::ScopedInteractionAnswer::Question{answers} if answers[0].selected.as_deref()==Some("Local"))
    );
}

async fn wait_for(mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !predicate() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn actual_scoped_observer_produces_durable_button_restart_reuses_it_and_click_is_once_only() {
    let fixture = Fixture::new(json!([])).await;
    let (_dir, g, host) = gateway().await;
    *host.pending.lock().unwrap() = Some(approval_snapshot());
    host.initial_gap
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let mut intake = connect(&fixture, &g).await;
    let replies = Arc::new(
        Replies::connect(fixture.client.clone(), 123456)
            .await
            .unwrap(),
    );
    let sender_stop = CancellationToken::new();
    let sender = tokio::spawn(
        g.clone()
            .run_replies(intake.lease(), replies, sender_stop.clone()),
    );
    let first_stop = CancellationToken::new();
    let first = tokio::spawn(run_interactions(
        g.clone(),
        intake.lease(),
        first_stop.clone(),
    ));
    wait_for(|| fixture.count("sendMessage") == 1).await;
    let sent = fixture
        .data
        .requests
        .lock()
        .unwrap()
        .iter()
        .find(|(m, _)| m == "sendMessage")
        .unwrap()
        .1
        .clone();
    assert_eq!(sent["chat_id"], 42);
    assert!(sent.get("parse_mode").is_none());
    let button = sent["reply_markup"]["inline_keyboard"][0][0]["callback_data"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(button.starts_with("a:") && button.len() <= 64);
    assert!(host.calls.lock().unwrap().is_empty());
    assert!(host.answers.lock().unwrap().is_empty());
    wait_for(|| host.subscriptions.load(std::sync::atomic::Ordering::SeqCst) >= 2).await;
    assert_eq!(fixture.count("sendMessage"), 1); // Actual gap reconnect did not resend.
    first_stop.cancel();
    first.await.unwrap().unwrap();
    let second_stop = CancellationToken::new();
    let second = tokio::spawn(run_interactions(
        g.clone(),
        intake.lease(),
        second_stop.clone(),
    ));
    wait_for(|| host.subscriptions.load(std::sync::atomic::Ordering::SeqCst) >= 3).await;
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    assert_eq!(fixture.count("sendMessage"), 1);
    *fixture.data.updates.lock().unwrap() = json!([callback(17, 42, button.clone())]);
    let receipt = intake.poll_once(0).await.unwrap().remove(0);
    assert!(host.answers.lock().unwrap().is_empty());
    assert_eq!(
        g.dispatch(delivery_key(&receipt)).await.unwrap().state,
        DeliveryState::Completed
    );
    wait_for(|| fixture.count("sendMessage") == 2).await;
    assert!(fixture
        .data
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|(m, p)| m == "sendMessage" && p["text"] == "Native response recorded."));
    *fixture.data.updates.lock().unwrap() = json!([callback(18, 42, button)]);
    assert_eq!(
        intake.poll_once(0).await.unwrap()[0].outcome,
        ReceiveOutcome::Rejected {
            code: RejectionCode::Forbidden
        }
    );
    assert_eq!(host.answers.lock().unwrap().len(), 1);
    let mut revoked = principal();
    revoked.revision = 2;
    revoked.revoked = true;
    g.set_principal(revoked).await.unwrap();
    second_stop.cancel();
    second.await.unwrap().unwrap();
    sender_stop.cancel();
    sender.await.unwrap().unwrap();
    assert_eq!(fixture.count("sendMessage"), 2); // Original decision notice plus the durable command receipt.
    g.close().await.unwrap();
}
#[tokio::test]
async fn actual_observer_question_choice_maps_index_to_native_label_not_controller_rpc_fields() {
    let fixture = Fixture::new(json!([])).await;
    let (_dir, g, host) = gateway().await;
    *host.pending.lock().unwrap() = Some(xharness_api::ScopedInteraction {
        nonce: "native-question".into(),
        frame: xharness_api::ServerRequest::new(
            RpcId::new("question"),
            "question/requested",
            json!({"type":"question/requested","sessionId":"s","questions":[{"id":"target","header":"Pick","question":"Where?","options":[{"label":"Local"},{"label":"Remote"}],"multiSelect":false}]}),
        ),
    });
    let mut intake = connect(&fixture, &g).await;
    let stop = CancellationToken::new();
    let observer = tokio::spawn(run_interactions(g.clone(), intake.lease(), stop.clone()));
    let sender = tokio::spawn(
        g.clone().run_replies(
            intake.lease(),
            Arc::new(
                Replies::connect(fixture.client.clone(), 123456)
                    .await
                    .unwrap(),
            ),
            stop.clone(),
        ),
    );
    wait_for(|| fixture.count("sendMessage") == 1).await;
    let sent = fixture
        .data
        .requests
        .lock()
        .unwrap()
        .iter()
        .find(|(m, _)| m == "sendMessage")
        .unwrap()
        .1
        .clone();
    let choice = sent["reply_markup"]["inline_keyboard"][0][1]["callback_data"]
        .as_str()
        .unwrap()
        .to_owned();
    let raw = choice.split(':').nth(1).unwrap();
    *fixture.data.updates.lock().unwrap() = json!([
        callback(17, 42, format!("q:{raw}:02")),
        callback(18, 42, format!("q:{raw}:31")),
        callback(19, 42, format!("a:{raw}")),
        callback(20, 42, choice.clone())
    ]);
    let receipts = intake.poll_once(0).await.unwrap();
    assert!(receipts[..3].iter().all(|r| r.outcome
        == ReceiveOutcome::Rejected {
            code: RejectionCode::InvalidCommand
        }));
    assert!(host.answers.lock().unwrap().is_empty());
    g.dispatch(delivery_key(&receipts[3])).await.unwrap();
    assert_eq!(
        host.answers.lock().unwrap()[0],
        ScopedInteractionAnswer::Question {
            answers: vec![ScopedQuestionAnswer {
                id: "target".into(),
                selected: Some("Remote".into()),
                custom: None
            }]
        }
    );
    stop.cancel();
    observer.await.unwrap().unwrap();
    sender.await.unwrap().unwrap();
}
#[tokio::test]
async fn interaction_formatter_is_lossless_bounded_and_complete_for_multi_question_custom_answers()
{
    let (_dir, g, host) = gateway().await;
    let labels = (0..32)
        .map(|i| json!({"label":format!("Label {i}")}))
        .collect::<Vec<_>>();
    let question = json!({"id":"target","header":"Header","question":"😀".repeat(5000),"options":labels,"multiSelect":false});
    let mut snapshot = xharness_api::ScopedInteraction {
        nonce: "question-shape".into(),
        frame: xharness_api::ServerRequest::new(
            RpcId::new("question"),
            "question/requested",
            json!({"type":"question/requested","sessionId":"s","questions":[question.clone()]}),
        ),
    };
    *host.pending.lock().unwrap() = Some(snapshot.clone());
    let ticket = g
        .mint_interaction_ticket(subscription(), RpcId::new("question"), 60)
        .await
        .unwrap();
    let plans = format_interaction(&ticket).unwrap();
    assert!(plans.len() > 2);
    assert!(plans
        .iter()
        .all(|p| p.body.text.encode_utf16().count() <= 4096));
    assert!(plans[..plans.len() - 1]
        .iter()
        .all(|p| p.body.buttons.is_empty()));
    assert_eq!(
        plans
            .last()
            .unwrap()
            .body
            .buttons
            .iter()
            .map(Vec::len)
            .sum::<usize>(),
        33
    );
    assert!(plans.last().unwrap().body.buttons.len() <= 16);
    let all = plans
        .iter()
        .map(|p| p.body.text.as_str())
        .collect::<String>();
    assert!(all.contains(&"😀".repeat(5000)));
    assert!(all.contains("Label 31"));
    g.enqueue_replies(subscription(), plans).await.unwrap(); // Actual durable keyboard bounds.
    snapshot.nonce = "second-shape".into();
    let mut second = question;
    second["id"] = json!("another");
    snapshot.frame.payload["questions"]
        .as_array_mut()
        .unwrap()
        .push(second);
    *host.pending.lock().unwrap() = Some(snapshot);
    let ticket = g
        .mint_interaction_ticket(subscription(), RpcId::new("question"), 60)
        .await
        .unwrap();
    let plans = format_interaction(&ticket).unwrap();
    assert_eq!(
        plans.last().unwrap().body.buttons.iter().flatten().count(),
        1
    ); // No partial-answer buttons.
    let text = plans
        .iter()
        .map(|p| p.body.text.as_str())
        .collect::<String>();
    let command = text
        .lines()
        .find(|line| line.starts_with("/answer "))
        .unwrap();
    let answers: Vec<ScopedQuestionAnswer> =
        serde_json::from_str(command.splitn(3, ' ').nth(2).unwrap()).unwrap();
    assert_eq!(answers.len(), 2);
    assert_eq!(answers[0].id, "target");
    assert_eq!(answers[1].id, "another");
}

#[tokio::test]
async fn full_subscription_generation_rotation_drains_old_workers_before_replacement_permits() {
    let fixture = Fixture::new(json!([])).await;
    let (_dir, g, host) = gateway().await;
    *host.pending.lock().unwrap() = Some(approval_snapshot());
    let intake = connect(&fixture, &g).await;
    let mut bindings = vec![binding()];
    for index in 0..31 {
        let mut p = principal();
        p.id = format!("p-{index}");
        p.sender.user = (100 + index).to_string();
        let mut b = binding();
        b.id = format!("b-{index}");
        b.principal = p.id.clone();
        b.conversation = p.sender.user.clone();
        g.set_principal(p).await.unwrap();
        g.bind(b.clone()).await.unwrap();
        bindings.push(b);
    }
    let stop = CancellationToken::new();
    let observer = tokio::spawn(run_interactions(g.clone(), intake.lease(), stop.clone()));
    wait_for(|| host.subscriptions.load(std::sync::atomic::Ordering::SeqCst) == 32).await;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while g.pending_replies(&intake.lease()).await.unwrap().len() != 32 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    eprintln!("rotation: initial 32 journals ready");
    for mut b in bindings {
        b.generation = 2;
        tokio::time::timeout(std::time::Duration::from_secs(3), g.bind(b))
            .await
            .expect("binding update stalled")
            .unwrap();
    }
    eprintln!("rotation: bindings updated");
    wait_for(|| host.subscriptions.load(std::sync::atomic::Ordering::SeqCst) >= 64).await;
    eprintln!("rotation: replacement 32 subscriptions ready");
    assert!(!observer.is_finished());
    stop.cancel();
    tokio::time::timeout(std::time::Duration::from_secs(3), observer)
        .await
        .expect("observer drain stalled")
        .unwrap()
        .unwrap();
    eprintln!("rotation: drained");
    assert!(host.calls.lock().unwrap().is_empty());
    assert!(host.answers.lock().unwrap().is_empty());
    assert_eq!(fixture.count("sendMessage"), 0); // Observer journals, does not own provider sends.
}

fn text_event(text: &str, final_message: bool) -> Value {
    if final_message {
        json!({"type":"assistant/message","data":{"turn":0,"step":0,"message":{"role":"assistant","content":[{"type":"reasoning","text":"PRIVATE_REASONING"},{"type":"text","text":text}]}}})
    } else {
        json!({"type":"assistant/chunk","data":{"turn":0,"step":0,"chunk":{"type":"text-delta","text":text}}})
    }
}
fn append_output(host: &Host, mut event: Value) {
    let mut events = host.output_events.lock().unwrap();
    event["seq"] = json!(events.len());
    events.push(event);
}
async fn delivered_output(g: &Gateway, l: &AccountLease, s: Subscription, min_seq: u64) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let cp = g.projection_checkpoint(l, s.clone()).await.unwrap();
            let mut delivered = cp.next_seq >= min_seq;
            for key in &cp.pending {
                delivered &=
                    g.inspect_reply(key).await.unwrap().unwrap().state == ReplyState::Delivered;
            }
            if delivered {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
fn output_scope() -> Subscription {
    let b = binding();
    Subscription {
        principal: b.principal,
        sender: principal().sender,
        conversation: b.conversation,
        binding: b.id,
        generation: b.generation,
    }
}
#[tokio::test]
async fn actual_http_output_stream_edits_known_receipts_and_restores_unread_history_after_restart_once(
) {
    let fixture = Fixture::new(json!([])).await;
    let (dir, g, host) = gateway().await;
    let intake = connect(&fixture, &g).await;
    let lease = intake.lease();
    let scope = output_scope();
    g.projection_checkpoint(&lease, scope.clone())
        .await
        .unwrap();
    let observer_stop = CancellationToken::new();
    let sender_stop = CancellationToken::new();
    let observer = tokio::spawn(run_interactions(
        g.clone(),
        lease.clone(),
        observer_stop.clone(),
    ));
    let sender = tokio::spawn(
        g.clone().run_replies(
            lease.clone(),
            Arc::new(
                Replies::connect(fixture.client.clone(), 123456)
                    .await
                    .unwrap(),
            ),
            sender_stop.clone(),
        ),
    );
    append_output(&host, text_event("hello", false));
    delivered_output(&g, &lease, scope.clone(), 1).await;
    assert_eq!(fixture.count("sendMessage"), 1);
    append_output(&host, text_event(" 🧪", false));
    delivered_output(&g, &lease, scope.clone(), 2).await;
    assert_eq!(fixture.count("editMessageText"), 1);
    observer_stop.cancel();
    observer.await.unwrap().unwrap();
    sender_stop.cancel();
    sender.await.unwrap().unwrap();
    g.close().await.unwrap();
    append_output(&host, text_event("hello 🧪", true));
    append_output(
        &host,
        json!({"type":"turn/end","data":{"turn":0,"reason":{"kind":"error","error":{"message":"PRIVATE_PROVIDER_ERROR"}}}}),
    );
    let g = Gateway::open(dir.path(), "h".into(), host.clone()).unwrap();
    let lease = connect(&fixture, &g).await.lease();
    let stop = CancellationToken::new();
    let observer = tokio::spawn(run_interactions(g.clone(), lease.clone(), stop.clone()));
    let sender = tokio::spawn(
        g.clone().run_replies(
            lease.clone(),
            Arc::new(
                Replies::connect(fixture.client.clone(), 123456)
                    .await
                    .unwrap(),
            ),
            stop.clone(),
        ),
    );
    delivered_output(&g, &lease, scope.clone(), 4).await;
    assert_eq!(fixture.count("sendMessage"), 2);
    assert_eq!(fixture.count("editMessageText"), 2);
    let wire = serde_json::to_string(&*fixture.data.requests.lock().unwrap()).unwrap();
    assert!(!wire.contains("PRIVATE_REASONING"));
    assert!(!wire.contains("PRIVATE_PROVIDER_ERROR"));
    assert!(fixture
        .data
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|(method, p)| method == "editMessageText"
            && p["message_id"] == 200
            && p["text"] == "Assistant response\nhello 🧪"));
    stop.cancel();
    observer.await.unwrap().unwrap();
    sender.await.unwrap().unwrap();
    g.close().await.unwrap();
    let g = Gateway::open(dir.path(), "h".into(), host.clone()).unwrap();
    let lease = connect(&fixture, &g).await.lease();
    let stop = CancellationToken::new();
    let observer = tokio::spawn(run_interactions(g.clone(), lease, stop.clone()));
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    stop.cancel();
    observer.await.unwrap().unwrap();
    assert_eq!(fixture.count("sendMessage"), 2);
    assert_eq!(fixture.count("editMessageText"), 2);
    assert!(host.calls.lock().unwrap().is_empty());
}
#[tokio::test]
async fn first_output_completed_before_observer_start_is_backfilled_not_lost() {
    let fixture = Fixture::new(json!([])).await;
    let (_dir, g, host) = gateway().await;
    append_output(&host, text_event("completed before observer", true));
    let lease = connect(&fixture, &g).await.lease();
    let stop = CancellationToken::new();
    let observer = tokio::spawn(run_interactions(g.clone(), lease.clone(), stop.clone()));
    let sender = tokio::spawn(
        g.clone().run_replies(
            lease.clone(),
            Arc::new(
                Replies::connect(fixture.client.clone(), 123456)
                    .await
                    .unwrap(),
            ),
            stop.clone(),
        ),
    );
    delivered_output(&g, &lease, output_scope(), 1).await;
    assert_eq!(fixture.count("sendMessage"), 1);
    stop.cancel();
    observer.await.unwrap().unwrap();
    sender.await.unwrap().unwrap();
    assert!(host.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn uncertain_output_send_pauses_cursor_and_survives_restart_without_guessing_or_replay() {
    let fixture = Fixture::new(json!([])).await;
    *fixture.data.send_status.lock().unwrap() = 500;
    let (dir, g, host) = gateway().await;
    append_output(&host, text_event("first partial", false));
    let lease = connect(&fixture, &g).await.lease();
    let stop = CancellationToken::new();
    let observer = tokio::spawn(run_interactions(g.clone(), lease.clone(), stop.clone()));
    let sender = tokio::spawn(
        g.clone().run_replies(
            lease.clone(),
            Arc::new(
                Replies::connect(fixture.client.clone(), 123456)
                    .await
                    .unwrap(),
            ),
            stop.clone(),
        ),
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let cp = g
                .projection_checkpoint(&lease, output_scope())
                .await
                .unwrap();
            if let Some(key) = cp.pending.first() {
                if g.inspect_reply(key).await.unwrap().unwrap().state == ReplyState::Uncertain {
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let expected = g
        .projection_checkpoint(&lease, output_scope())
        .await
        .unwrap();
    assert_eq!(expected.next_seq, 1);
    append_output(
        &host,
        text_event("canonical final after unknown receipt", true),
    );
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    assert_eq!(
        g.projection_checkpoint(&lease, output_scope())
            .await
            .unwrap(),
        expected
    );
    stop.cancel();
    observer.await.unwrap().unwrap();
    sender.await.unwrap().unwrap();
    g.close().await.unwrap();
    *fixture.data.send_status.lock().unwrap() = 200;
    let g = Gateway::open(dir.path(), "h".into(), host.clone()).unwrap();
    let lease = connect(&fixture, &g).await.lease();
    let stop = CancellationToken::new();
    let observer = tokio::spawn(run_interactions(g.clone(), lease.clone(), stop.clone()));
    let sender = tokio::spawn(
        g.clone().run_replies(
            lease.clone(),
            Arc::new(
                Replies::connect(fixture.client.clone(), 123456)
                    .await
                    .unwrap(),
            ),
            stop.clone(),
        ),
    );
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    assert_eq!(
        g.projection_checkpoint(&lease, output_scope())
            .await
            .unwrap(),
        expected
    );
    assert_eq!(fixture.count("sendMessage"), 1);
    assert_eq!(fixture.count("editMessageText"), 0);
    stop.cancel();
    observer.await.unwrap().unwrap();
    sender.await.unwrap().unwrap();
    assert!(host.calls.lock().unwrap().is_empty());
}

fn history_fixture() -> Value {
    json!({"events":[
        {"event":{"seq":10,"type":"user/message","data":{"role":"user","content":[{"type":"text","text":"history user"}]}}},
        {"event":{"seq":12,"type":"assistant/message","data":{"turn":0,"step":0,"message":{"role":"assistant","content":[{"type":"reasoning","text":"PRIVATE_REASONING"},{"type":"text","text":"history actual response 🧪"}]}}},"view":{"private":"PRIVATE_VIEW"}}
    ],"hasMore":true,"projections":{"private":"PRIVATE_METADATA"}})
}
#[tokio::test]
async fn actual_http_explicit_history_uses_committed_native_result_and_reopen_does_not_reexecute_or_resend(
) {
    let fixture = Fixture::new(json!([message(17, 42, "/history 2 40")])).await;
    let (dir, g, host) = gateway().await;
    *host.history_result.lock().unwrap() = Some(history_fixture());
    let mut intake = connect(&fixture, &g).await;
    let lease = intake.lease();
    let receipt = intake.poll_once(0).await.unwrap().remove(0);
    let d = g.dispatch(delivery_key(&receipt)).await.unwrap();
    assert_eq!(
        host.calls.lock().unwrap()[0],
        (
            RpcMethod::SessionHistory,
            json!({"sessionId":"s","maxMessages":2,"beforeSeq":40})
        )
    );
    let stop = CancellationToken::new();
    let observer = tokio::spawn(run_interactions(g.clone(), lease.clone(), stop.clone()));
    let sender = tokio::spawn(
        g.clone().run_replies(
            lease.clone(),
            Arc::new(
                Replies::connect(fixture.client.clone(), 123456)
                    .await
                    .unwrap(),
            ),
            stop.clone(),
        ),
    );
    wait_for(|| fixture.count("sendMessage") == 1).await;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if g.command_reply_candidate(&lease, output_scope())
                .await
                .unwrap()
                .is_none()
                && g.pending_replies(&lease).await.unwrap().is_empty()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let sent = fixture
        .data
        .requests
        .lock()
        .unwrap()
        .iter()
        .find(|(m, _)| m == "sendMessage")
        .unwrap()
        .1
        .clone();
    let text = sent["text"].as_str().unwrap();
    assert!(text.contains("history user"));
    assert!(text.contains("history actual response 🧪"));
    assert!(text.ends_with("Earlier history: /history 2 10"));
    assert!(!text.contains("PRIVATE_"));
    assert!(sent.get("parse_mode").is_none());
    assert_eq!(
        g.enqueue_command_replies(
            &lease,
            output_scope(),
            d.clone(),
            format_command_reply(&d).unwrap()
        )
        .await
        .unwrap()
        .len(),
        1
    );
    stop.cancel();
    observer.await.unwrap().unwrap();
    sender.await.unwrap().unwrap();
    g.close().await.unwrap();
    *host.history_result.lock().unwrap() = Some(json!({"must_not_read":"CHANGED"}));
    let g = Gateway::open(dir.path(), "h".into(), host.clone()).unwrap();
    let lease = connect(&fixture, &g).await.lease();
    let stop = CancellationToken::new();
    let observer = tokio::spawn(run_interactions(g.clone(), lease.clone(), stop.clone()));
    let sender = tokio::spawn(
        g.clone().run_replies(
            lease,
            Arc::new(
                Replies::connect(fixture.client.clone(), 123456)
                    .await
                    .unwrap(),
            ),
            stop.clone(),
        ),
    );
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    assert_eq!(fixture.count("sendMessage"), 1);
    assert_eq!(host.calls.lock().unwrap().len(), 1);
    stop.cancel();
    observer.await.unwrap().unwrap();
    sender.await.unwrap().unwrap();
    g.close().await.unwrap();
}
#[tokio::test]
async fn uncertain_history_reply_is_consumed_durably_but_never_reexecuted_or_resent() {
    let fixture = Fixture::new(json!([message(17, 42, "/history 2 40")])).await;
    *fixture.data.send_status.lock().unwrap() = 500;
    let (dir, g, host) = gateway().await;
    *host.history_result.lock().unwrap() = Some(history_fixture());
    let mut intake = connect(&fixture, &g).await;
    let lease = intake.lease();
    let receipt = intake.poll_once(0).await.unwrap().remove(0);
    let d = g.dispatch(delivery_key(&receipt)).await.unwrap();
    let stop = CancellationToken::new();
    let observer = tokio::spawn(run_interactions(g.clone(), lease.clone(), stop.clone()));
    let sender = tokio::spawn(
        g.clone().run_replies(
            lease.clone(),
            Arc::new(
                Replies::connect(fixture.client.clone(), 123456)
                    .await
                    .unwrap(),
            ),
            stop.clone(),
        ),
    );
    wait_for(|| fixture.count("sendMessage") == 1).await;
    let records = g
        .enqueue_command_replies(
            &lease,
            output_scope(),
            d.clone(),
            format_command_reply(&d).unwrap(),
        )
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while g
            .inspect_reply(&records[0].key)
            .await
            .unwrap()
            .unwrap()
            .state
            != ReplyState::Uncertain
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(g
        .command_reply_candidate(&lease, output_scope())
        .await
        .unwrap()
        .is_none());
    stop.cancel();
    observer.await.unwrap().unwrap();
    sender.await.unwrap().unwrap();
    g.close().await.unwrap();
    *fixture.data.send_status.lock().unwrap() = 200;
    let g = Gateway::open(dir.path(), "h".into(), host.clone()).unwrap();
    let lease = connect(&fixture, &g).await.lease();
    let stop = CancellationToken::new();
    let observer = tokio::spawn(run_interactions(g.clone(), lease.clone(), stop.clone()));
    let sender = tokio::spawn(
        g.clone().run_replies(
            lease.clone(),
            Arc::new(
                Replies::connect(fixture.client.clone(), 123456)
                    .await
                    .unwrap(),
            ),
            stop.clone(),
        ),
    );
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    assert_eq!(fixture.count("sendMessage"), 1);
    assert_eq!(host.calls.lock().unwrap().len(), 1);
    assert!(g
        .command_reply_candidate(&lease, output_scope())
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        g.inspect_reply(&records[0].key)
            .await
            .unwrap()
            .unwrap()
            .state,
        ReplyState::Uncertain
    );
    stop.cancel();
    observer.await.unwrap().unwrap();
    sender.await.unwrap().unwrap();
    g.close().await.unwrap();
}
#[tokio::test]
async fn explicit_history_cursor_parser_rejects_noncanonical_or_extra_fields_before_native_effect()
{
    let invalid = [
        "/history 25 0001",
        "/history 10 -1",
        "/history 10 18446744073709551616",
        "/history 10 9 extra",
        "/history 0 9",
        "/history 501 9",
    ];
    let mut updates = invalid
        .into_iter()
        .enumerate()
        .map(|(i, t)| message(17 + i as u64, 42, t))
        .collect::<Vec<_>>();
    updates.push(message(23, 42, "/history 10 9"));
    let fixture = Fixture::new(json!(updates)).await;
    let (_dir, g, host) = gateway().await;
    let mut intake = connect(&fixture, &g).await;
    let receipts = intake.poll_once(0).await.unwrap();
    assert!(receipts[..6].iter().all(|r| r.outcome
        == ReceiveOutcome::Rejected {
            code: RejectionCode::InvalidCommand
        }));
    let d = g
        .inspect(delivery_key(&receipts[6]))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        d.inbound.command,
        Command::History {
            before_seq: Some(9),
            max_messages: 10
        }
    );
    assert!(host.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn sessions_command_normalizes_json_cursor_and_dispatches_only_scoped_metadata() {
    let fixture=Fixture::new(json!([message(17,42,"/sessions"),message(18,42,"/sessions {\"workspace\":\"w\",\"session\":\"s\"}"),message(19,42,"/sessions {\"workspace\":\"workspace with spaces\",\"session\":\"session with spaces\"}")])).await;
    let (_temp, g, host) = gateway().await;
    let mut intake = connect(&fixture, &g).await;
    let receipts = intake.poll_once(0).await.unwrap();
    assert_eq!(receipts.len(), 3);
    let first = g
        .inspect(delivery_key(&receipts[0]))
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        first.inbound.command,
        Command::Catalogue { after: None }
    ));
    let done = g.dispatch(&first.key).await.unwrap();
    assert_eq!(done.state, DeliveryState::Completed);
    assert!(format_command_reply(&done)
        .unwrap()
        .iter()
        .any(|p| p.body.text.contains("Durable title")));
    let second = g.dispatch(delivery_key(&receipts[1])).await.unwrap();
    assert!(format_command_reply(&second)
        .unwrap()
        .iter()
        .any(|p| p.body.text.contains("No accessible unarchived sessions")));
    let third = g
        .inspect(delivery_key(&receipts[2]))
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(third.inbound.command,Command::Catalogue{after:Some(ref cursor)} if cursor.workspace=="workspace with spaces"&&cursor.session=="session with spaces")
    );
    assert_eq!(
        g.dispatch(&third.key).await.unwrap().state,
        DeliveryState::Rejected
    );
    assert_eq!(
        host.catalogue_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        2
    );
    assert!(host.calls.lock().unwrap().is_empty());
    assert_eq!(intake.lease().cursor, "20");
}
#[tokio::test]
async fn malformed_or_media_sessions_commands_are_durably_rejected_before_download() {
    let mut attached = photo(30, 42);
    attached["message"]["caption"] = json!("/sessions");
    let mut updates = vec![];
    for (n, text) in [
        "/sessions w s",
        "/sessions []",
        "/sessions null",
        "/sessions {}",
        "/sessions {\"workspace\":\"w\",\"session\":\"s\",\"cwd\":\"PRIVATE_PATH\"}",
        "/sessions {\"workspace\":\"w\",\"session\":\"s\"} extra",
        "/sessions {\"workspace\":\"\",\"session\":\"s\"}",
        "/sessions {\"workspace\":\"w\",\"session\":\"\\u0000\"}",
    ]
    .into_iter()
    .enumerate()
    {
        updates.push(message(n as u64 + 17, 42, text));
    }
    updates.push(attached);
    let fixture = Fixture::new(json!(updates)).await;
    let (_temp, g, host) = gateway().await;
    let mut intake = connect(&fixture, &g).await;
    let receipts = intake.poll_once(0).await.unwrap();
    assert_eq!(receipts.len(), 9);
    assert!(receipts.iter().all(|r| r.outcome
        == ReceiveOutcome::Rejected {
            code: RejectionCode::InvalidCommand
        }));
    assert!(g.pending().await.unwrap().is_empty());
    assert_eq!(fixture.count("getFile"), 0);
    assert!(host.calls.lock().unwrap().is_empty());
    assert_eq!(intake.lease().cursor, "31");
}

#[tokio::test]
async fn select_is_closed_json_durable_noop_or_unauthorized_target_not_prompt_text() {
    let fixture = Fixture::new(json!([
        message(17, 42, "/select {\"workspace\":\"w\",\"session\":\"s\"}"),
        message(
            18,
            42,
            "/select {\"workspace\":\"w\",\"session\":\"foreign\"}"
        )
    ]))
    .await;
    let (_temp, g, host) = gateway().await;
    let mut intake = connect(&fixture, &g).await;
    let receipts = intake.poll_once(0).await.unwrap();
    assert_eq!(receipts.len(), 2);
    let first = g.dispatch(delivery_key(&receipts[0])).await.unwrap();
    assert!(matches!(first.inbound.command, Command::Select { .. }));
    let plans = format_command_reply(&first).unwrap();
    assert!(plans[0].body.text.starts_with("Session selected."));
    assert!(plans[0].body.text.contains("Binding generation: 1"));
    let lease = intake.lease();
    let scope = g.account_subscriptions(&lease).await.unwrap().remove(0);
    let records = g
        .enqueue_command_replies(&lease, scope.clone(), first.clone(), plans.clone())
        .await
        .unwrap();
    assert_eq!(
        g.enqueue_command_replies(&lease, scope, first, plans)
            .await
            .unwrap(),
        records
    );
    assert_eq!(
        g.dispatch(delivery_key(&receipts[1])).await.unwrap().state,
        DeliveryState::Rejected
    );
    assert_eq!(
        host.catalogue_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    assert!(host.calls.lock().unwrap().is_empty());
    assert_eq!(intake.lease().cursor, "19");
}
#[tokio::test]
async fn malformed_or_media_select_rejects_before_download_and_never_guesses_ids() {
    let mut attached = photo(30, 42);
    attached["message"]["caption"] = json!("/select {\"workspace\":\"w\",\"session\":\"s\"}");
    let mut updates = vec![];
    for (n, text) in [
        "/select",
        "/select w s",
        "/select null",
        "/select []",
        "/select {}",
        "/select {\"workspace\":\"w\",\"session\":\"s\",\"cwd\":\"PRIVATE_PATH\"}",
        "/select {\"workspace\":\"w\",\"session\":\"s\"} extra",
        "/select {\"workspace\":\"\",\"session\":\"s\"}",
        "/select {\"workspace\":\"w\",\"session\":\"\\u0000\"}",
    ]
    .into_iter()
    .enumerate()
    {
        updates.push(message(n as u64 + 17, 42, text));
    }
    updates.push(attached);
    let fixture = Fixture::new(json!(updates)).await;
    let (_temp, g, host) = gateway().await;
    let mut intake = connect(&fixture, &g).await;
    let receipts = intake.poll_once(0).await.unwrap();
    assert_eq!(receipts.len(), 10);
    assert!(receipts.iter().all(|r| r.outcome
        == ReceiveOutcome::Rejected {
            code: RejectionCode::InvalidCommand
        }));
    assert!(g.pending().await.unwrap().is_empty());
    assert_eq!(fixture.count("getFile"), 0);
    assert!(host.calls.lock().unwrap().is_empty());
    assert_eq!(intake.lease().cursor, "31");
}

#[tokio::test]
async fn new_command_is_closed_workspace_json_and_default_off_before_native_creation() {
    let fixture = Fixture::new(json!([
        message(17, 42, "/new {\"workspace\":\"w\"}"),
        message(18, 42, "/new {\"workspace\":\"workspace with spaces\"}")
    ]))
    .await;
    let (_temp, g, host) = gateway().await;
    let mut intake = connect(&fixture, &g).await;
    let receipts = intake.poll_once(0).await.unwrap();
    assert_eq!(receipts.len(), 2);
    let d = g
        .inspect(delivery_key(&receipts[0]))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        d.inbound.command,
        Command::CreateSession {
            workspace: "w".into()
        }
    );
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Rejected
    );
    let d = g
        .inspect(delivery_key(&receipts[1]))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        d.inbound.command,
        Command::CreateSession {
            workspace: "workspace with spaces".into()
        }
    );
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Rejected
    );
    assert!(host.calls.lock().unwrap().is_empty());
    assert_eq!(intake.lease().cursor, "19");
}
#[tokio::test]
async fn malformed_or_media_new_rejects_before_download_without_user_request_or_session_ids() {
    let mut attached = photo(30, 42);
    attached["message"]["caption"] = json!("/new {\"workspace\":\"w\"}");
    let mut updates = vec![];
    for (n, text) in [
        "/new",
        "/new w",
        "/new null",
        "/new []",
        "/new {}",
        "/new {\"workspace\":\"w\",\"session\":\"foreign\"}",
        "/new {\"workspace\":\"w\",\"request_id\":\"other\"}",
        "/new {\"workspace\":\"w\",\"cwd\":\"PRIVATE_PATH\"}",
        "/new {\"workspace\":\"w\"} extra",
        "/new {\"workspace\":\"\"}",
        "/new {\"workspace\":\"\\u0000\"}",
    ]
    .into_iter()
    .enumerate()
    {
        updates.push(message(n as u64 + 17, 42, text));
    }
    updates.push(attached);
    let fixture = Fixture::new(json!(updates)).await;
    let (_temp, g, host) = gateway().await;
    let mut intake = connect(&fixture, &g).await;
    let receipts = intake.poll_once(0).await.unwrap();
    assert_eq!(receipts.len(), 12);
    assert!(receipts.iter().all(|r| r.outcome
        == ReceiveOutcome::Rejected {
            code: RejectionCode::InvalidCommand
        }));
    assert!(g.pending().await.unwrap().is_empty());
    assert_eq!(fixture.count("getFile"), 0);
    assert!(host.calls.lock().unwrap().is_empty());
    assert_eq!(intake.lease().cursor, "31");
}

#[tokio::test]
async fn saved_automation_forms_are_closed_json_without_user_scope_or_native_keys() {
    let forms = [
        (
            "/automations",
            Command::AutomationRead {
                read: xharness_remote::AutomationRead::List { after: None },
            },
        ),
        (
            "/automations {\"after\":\"saved 你好\"}",
            Command::AutomationRead {
                read: xharness_remote::AutomationRead::List {
                    after: Some("saved 你好".into()),
                },
            },
        ),
        (
            "/automation {\"action\":\"view\",\"id\":\"saved 你好\"}",
            Command::AutomationRead {
                read: xharness_remote::AutomationRead::View {
                    id: "saved 你好".into(),
                },
            },
        ),
        (
            "/automation {\"action\":\"pause\",\"id\":\"saved 你好\"}",
            Command::AutomationControl {
                control: xharness_remote::AutomationControl::Pause {
                    id: "saved 你好".into(),
                },
            },
        ),
        (
            "/automation {\"action\":\"resume\",\"id\":\"saved 你好\"}",
            Command::AutomationControl {
                control: xharness_remote::AutomationControl::Resume {
                    id: "saved 你好".into(),
                },
            },
        ),
        (
            "/automation {\"action\":\"delete\",\"id\":\"saved 你好\"}",
            Command::AutomationControl {
                control: xharness_remote::AutomationControl::Delete {
                    id: "saved 你好".into(),
                },
            },
        ),
    ];
    let updates: Vec<_> = forms
        .iter()
        .enumerate()
        .map(|(n, (text, _))| message(n as u64 + 17, 42, text))
        .collect();
    let fixture = Fixture::new(json!(updates)).await;
    let (_temp, g, host) = gateway().await;
    let mut intake = connect(&fixture, &g).await;
    let receipts = intake.poll_once(0).await.unwrap();
    assert_eq!(receipts.len(), forms.len());
    for (r, (_, expected)) in receipts.iter().zip(forms) {
        let d = g.inspect(delivery_key(r)).await.unwrap().unwrap();
        assert_eq!(d.inbound.command, expected);
        assert_eq!(d.binding.workspace, "w");
        assert_eq!(d.binding.session, "s");
    }
    assert_eq!(fixture.count("getFile"), 0);
    assert!(host.calls.lock().unwrap().is_empty());
    assert_eq!(intake.lease().cursor, "23");
}
#[tokio::test]
async fn malformed_and_media_automation_commands_reject_before_download() {
    let invalid = [
        "/automations null",
        "/automations {}",
        "/automations {\"after\":null}",
        "/automations {\"after\":\"\"}",
        "/automations {\"after\":\"saved\",\"session\":\"foreign\"}",
        "/automation",
        "/automation pause saved",
        "/automation {\"action\":\"list\"}",
        "/automation {\"action\":\"create\",\"id\":\"saved\"}",
        "/automation {\"action\":\"update\",\"id\":\"saved\"}",
        "/automation {\"action\":\"pause\",\"id\":\"saved\",\"request_key\":\"foreign\"}",
        "/automation {\"action\":\"view\",\"id\":\"saved\",\"workspace\":\"foreign\"}",
        "/automation {\"action\":\"resume\",\"id\":null}",
        "/automation {\"action\":\"delete\",\"id\":\"\\u0000\"}",
        "/automation {\"action\":\"view\",\"id\":\"saved\"} trailing",
    ];
    let mut updates: Vec<_> = invalid
        .iter()
        .enumerate()
        .map(|(n, text)| message(n as u64 + 17, 42, text))
        .collect();
    let mut attached = photo(40, 42);
    attached["message"]["caption"] = json!("/automation {\"action\":\"pause\",\"id\":\"saved\"}");
    updates.push(attached);
    let fixture = Fixture::new(json!(updates)).await;
    let (_temp, g, host) = gateway().await;
    let mut intake = connect(&fixture, &g).await;
    let receipts = intake.poll_once(0).await.unwrap();
    assert_eq!(receipts.len(), invalid.len() + 1);
    assert!(receipts.iter().all(|r| r.outcome
        == ReceiveOutcome::Rejected {
            code: RejectionCode::InvalidCommand
        }));
    assert!(g.pending().await.unwrap().is_empty());
    assert_eq!(fixture.count("getFile"), 0);
    assert!(host.calls.lock().unwrap().is_empty());
    assert_eq!(intake.lease().cursor, "41");
}

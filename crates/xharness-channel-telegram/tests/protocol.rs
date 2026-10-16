//! Local HTTP fixtures only. These do not certify a real Telegram account.
use axum::{
    extract::{OriginalUri, State},
    http::StatusCode,
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio::task::JoinHandle;
use xharness_channel_telegram::*;
use xharness_remote::RejectionCode;

type Responses = Arc<Mutex<BTreeMap<String, (u16, Value)>>>;
#[derive(Clone)]
struct StateData {
    responses: Responses,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
}
struct Fixture {
    client: Arc<Client>,
    state: StateData,
    task: JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Fixture {
    async fn new() -> Self {
        let state = StateData {
            responses: Default::default(),
            requests: Default::default(),
        };
        let app = Router::new()
            .route("/{*path}", post(handler).get(file_handler))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = Client::loopback_fixture(
            BotToken::new("123456:fixture-token-only".into()).unwrap(),
            &format!("http://{address}"),
        )
        .unwrap();
        Self {
            client: Arc::new(client),
            state,
            task,
        }
    }
    fn response(&self, method: &str, status: u16, value: Value) {
        self.state
            .responses
            .lock()
            .unwrap()
            .insert(method.into(), (status, value));
    }
    fn calls(&self) -> usize {
        self.state.requests.lock().unwrap().len()
    }
}
async fn handler(
    State(state): State<StateData>,
    OriginalUri(uri): OriginalUri,
    Json(payload): Json<Value>,
) -> impl IntoResponse {
    let method = uri.path().rsplit('/').next().unwrap().to_owned();
    state
        .requests
        .lock()
        .unwrap()
        .push((method.clone(), payload));
    let (status, result) = state
        .responses
        .lock()
        .unwrap()
        .get(&method)
        .cloned()
        .unwrap_or((500, json!({"ok":false,"error_code":500})));
    (StatusCode::from_u16(status).unwrap(), Json(result))
}
async fn file_handler() -> impl IntoResponse {
    (StatusCode::OK, b"fixture file".to_vec())
}
fn private_message() -> Value {
    json!({"message_id":8,"from":{"id":42,"is_bot":false},"chat":{"id":42,"type":"private"},"text":"hello"})
}

#[tokio::test]
async fn identify_and_long_poll_use_official_shapes_without_deleting_webhooks() {
    let fixture = Fixture::new().await;
    fixture.response(
        "getMe",
        200,
        json!({"ok":true,"result":{"id":123456,"is_bot":true,"username":"fixture"}}),
    );
    fixture.response(
        "getWebhookInfo",
        200,
        json!({"ok":true,"result":{"url":""}}),
    );
    assert_eq!(
        fixture.client.identify_for_polling().await.unwrap().id,
        123456
    );
    fixture.response(
        "getUpdates",
        200,
        json!({"ok":true,"result":[{"update_id":17,"message":private_message()}]}),
    );
    let updates = fixture.client.get_updates(Some(17), 25).await.unwrap();
    assert_eq!(updates.len(), 1);
    let calls = fixture.state.requests.lock().unwrap();
    assert_eq!(calls[2].0, "getUpdates");
    assert_eq!(calls[2].1["offset"], 17);
    assert_eq!(calls[2].1["timeout"], 25);
    assert!(!calls.iter().any(|(method, _)| method == "deleteWebhook"));
}
#[tokio::test]
async fn existing_webhook_and_conflicting_poller_are_explicit_errors() {
    let fixture = Fixture::new().await;
    fixture.response(
        "getMe",
        200,
        json!({"ok":true,"result":{"id":123456,"is_bot":true}}),
    );
    fixture.response(
        "getWebhookInfo",
        200,
        json!({"ok":true,"result":{"url":"https://example.invalid/existing"}}),
    );
    assert_eq!(
        fixture.client.identify_for_polling().await.unwrap_err(),
        Error::Conflict
    );
    fixture.response(
        "getUpdates",
        409,
        json!({"ok":false,"error_code":409,"description":"do not echo provider details"}),
    );
    assert_eq!(
        fixture.client.get_updates(None, 0).await.unwrap_err(),
        Error::Conflict
    );
}
#[tokio::test]
async fn malformed_failed_or_wrong_target_send_is_ambiguous_and_never_auto_retried() {
    let fixture = Fixture::new().await;
    fixture.response(
        "sendMessage",
        200,
        json!({"ok":true,"result":{"message_id":12,"chat":{"id":99,"type":"private"}}}),
    );
    assert_eq!(
        fixture
            .client
            .send_message(42, "hello", vec![])
            .await
            .unwrap_err(),
        Error::AmbiguousSend
    );
    assert_eq!(fixture.calls(), 1);
    fixture.response("sendMessage", 500, json!({"ok":false,"error_code":500}));
    assert_eq!(
        fixture
            .client
            .send_message(42, "hello", vec![])
            .await
            .unwrap_err(),
        Error::AmbiguousSend
    );
    assert_eq!(fixture.calls(), 2);
    fixture.response(
        "sendMessage",
        200,
        json!({"ok":"true","result":{"message_id":13}}),
    );
    assert_eq!(
        fixture
            .client
            .send_message(42, "hello", vec![])
            .await
            .unwrap_err(),
        Error::AmbiguousSend
    );
}
#[tokio::test]
async fn rate_limit_and_invalid_credentials_have_closed_sanitized_errors() {
    let fixture = Fixture::new().await;
    fixture.response("getUpdates",429,json!({"ok":false,"error_code":429,"description":"secret-credential-bait","parameters":{"retry_after":7}}));
    let error = fixture.client.get_updates(None, 0).await.unwrap_err();
    assert_eq!(error, Error::RateLimited { retry_after: 7 });
    assert!(!format!("{error:?} {error}").contains("secret-credential-bait"));
    fixture.response("getUpdates", 401, json!({"ok":false,"error_code":401}));
    assert_eq!(
        fixture.client.get_updates(None, 0).await.unwrap_err(),
        Error::Unauthorized
    );
    assert!(!format!(
        "{:?}",
        BotToken::new("123456:secret-credential-bait".into()).unwrap()
    )
    .contains("secret-credential-bait"));
}
#[tokio::test]
async fn known_message_edit_and_buttons_validate_identity_and_size() {
    let fixture = Fixture::new().await;
    fixture.response(
        "sendMessage",
        200,
        json!({"ok":true,"result":{"message_id":12,"chat":{"id":42,"type":"private"}}}),
    );
    assert_eq!(
        fixture
            .client
            .send_message(
                42,
                "hello",
                vec![vec![InlineButton {
                    text: "Allow once".into(),
                    callback_data: "scoped-ticket:allow".into()
                }]]
            )
            .await
            .unwrap()
            .message_id,
        12
    );
    fixture.response(
        "editMessageText",
        200,
        json!({"ok":true,"result":{"message_id":12,"chat":{"id":42,"type":"private"}}}),
    );
    fixture
        .client
        .edit_message(42, 12, "stream update")
        .await
        .unwrap();
    let before = fixture.calls();
    assert_eq!(
        fixture
            .client
            .send_message(42, &"🚀".repeat(3000), vec![])
            .await
            .unwrap_err(),
        Error::Configuration
    );
    assert_eq!(
        fixture
            .client
            .send_message(
                42,
                "hello",
                vec![vec![InlineButton {
                    text: "x".into(),
                    callback_data: "x".repeat(65)
                }]]
            )
            .await
            .unwrap_err(),
        Error::Configuration
    );
    assert_eq!(fixture.calls(), before);
}
#[tokio::test]
async fn attachment_download_is_bounded_and_cannot_escape_official_file_namespace() {
    let fixture = Fixture::new().await;
    fixture.response(
        "getFile",
        200,
        json!({"ok":true,"result":{"file_path":"documents/file_1.txt","file_size":12}}),
    );
    assert_eq!(
        fixture.client.download_file("file-id").await.unwrap(),
        b"fixture file"
    );
    for path in [
        "../secret",
        "/etc/passwd",
        "https://evil.invalid/file",
        "documents/%2e%2e/file",
        "documents/../../file",
    ] {
        fixture.response(
            "getFile",
            200,
            json!({"ok":true,"result":{"file_path":path}}),
        );
        assert_eq!(
            fixture.client.download_file("file-id").await.unwrap_err(),
            Error::InvalidAttachment
        );
    }
    fixture.response(
        "getFile",
        200,
        json!({"ok":true,"result":{"file_path":"documents/a","file_size":MAX_ATTACHMENT_BYTES+1}}),
    );
    assert_eq!(
        fixture.client.download_file("file-id").await.unwrap_err(),
        Error::AttachmentTooLarge
    );
}
#[test]
fn normalization_uses_private_platform_sender_and_preserves_image_only_updates() {
    let mut message = private_message();
    message.as_object_mut().unwrap().remove("text");
    message["photo"] = json!([{"file_id":"photo-id","width":300,"height":200,"file_size":100}]);
    assert!(matches!(
        decode(&json!({"update_id":17,"message":message}))
            .unwrap()
            .event,
        Event::Message(_)
    ));
    let mut message = private_message();
    message["chat"]["type"] = json!("group");
    assert_eq!(
        decode(&json!({"update_id":17,"message":message}))
            .unwrap()
            .event,
        Event::Rejected(RejectionCode::Forbidden)
    );
    let mut message = private_message();
    message["from"]["id"] = json!(43);
    assert_eq!(
        decode(&json!({"update_id":17,"message":message}))
            .unwrap()
            .event,
        Event::Rejected(RejectionCode::Forbidden)
    );
    assert_eq!(
        decode(&json!({"update_id":18,"edited_message":private_message()}))
            .unwrap()
            .event,
        Event::Rejected(RejectionCode::Unsupported)
    );
    assert_eq!(
        decode(&json!({"update_id":19,"message":{}})).unwrap().event,
        Event::Rejected(RejectionCode::Malformed)
    );
    assert_eq!(
        decode(&json!({"message":private_message()})).unwrap_err(),
        Error::MalformedResponse
    );
}
#[test]
fn callback_is_bound_to_platform_sender_and_not_any_arbitrary_chat_or_rpc() {
    let callback = json!({"id":"callback","from":{"id":42,"is_bot":false},"message":private_message(),"data":"opaque-ticket:allow"});
    assert!(matches!(
        decode(&json!({"update_id":1,"callback_query":callback}))
            .unwrap()
            .event,
        Event::Callback(_)
    ));
    let callback = json!({"id":"callback","from":{"id":43,"is_bot":false},"message":private_message(),"data":"opaque-ticket:allow"});
    assert_eq!(
        decode(&json!({"update_id":1,"callback_query":callback}))
            .unwrap()
            .event,
        Event::Rejected(RejectionCode::Forbidden)
    );
}
#[test]
fn production_token_cannot_be_redirected_to_an_arbitrary_fixture_endpoint() {
    assert!(Client::loopback_fixture(
        BotToken::new("123456:fixture-token-only".into()).unwrap(),
        "http://evil.invalid"
    )
    .is_err());
    assert!(Client::loopback_fixture(
        BotToken::new("123456:fixture-token-only".into()).unwrap(),
        "http://127.0.0.1/path"
    )
    .is_err());
    assert!(BotToken::new("123456:token/with/path".into()).is_err());
}

#[tokio::test]
async fn redirects_never_forward_bot_token_to_another_origin() {
    use axum::http::header::LOCATION;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let forwarded = Arc::new(AtomicUsize::new(0));
    let count = forwarded.clone();
    let destination = Router::new().route(
        "/{*path}",
        post(move || {
            let count = count.clone();
            async move {
                count.fetch_add(1, Ordering::SeqCst);
                Json(json!({"ok":true,"result":[]}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let destination_task = tokio::spawn(async move {
        axum::serve(listener, destination).await.unwrap();
    });
    let target = format!("http://{addr}/unexpected");
    let source = Router::new().route(
        "/{*path}",
        post(move || {
            let target = target.clone();
            async move {
                (
                    StatusCode::TEMPORARY_REDIRECT,
                    [(LOCATION, target)],
                    "redirect",
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let source_task = tokio::spawn(async move {
        axum::serve(listener, source).await.unwrap();
    });
    let client = Client::loopback_fixture(
        BotToken::new("123456:fixture-redirect-only".into()).unwrap(),
        &format!("http://{addr}"),
    )
    .unwrap();
    assert_eq!(
        client.get_updates(None, 0).await.unwrap_err(),
        Error::MalformedResponse
    );
    assert_eq!(
        client
            .send_message(42, "fixture", vec![])
            .await
            .unwrap_err(),
        Error::AmbiguousSend
    );
    assert_eq!(forwarded.load(Ordering::SeqCst), 0);
    source_task.abort();
    destination_task.abort();
}

#[tokio::test]
async fn disconnect_after_request_is_read_failure_or_ambiguous_send_not_an_auto_retry() {
    use tokio::io::AsyncReadExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut data = [0u8; 2048];
            assert!(socket.read(&mut data).await.unwrap() > 0);
            // Close after request bytes arrived, before a receipt can be read.
        }
    });
    let client = Client::loopback_fixture(
        BotToken::new("123456:fixture-disconnect-only".into()).unwrap(),
        &format!("http://{addr}"),
    )
    .unwrap();
    assert_eq!(
        client.get_updates(None, 0).await.unwrap_err(),
        Error::Transport
    );
    assert_eq!(
        client
            .send_message(42, "fixture", vec![])
            .await
            .unwrap_err(),
        Error::AmbiguousSend
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn actual_request_deadline_classifies_read_timeout_separately_from_uncertain_send() {
    use std::{
        sync::atomic::{AtomicUsize, Ordering},
        time::{Duration, Instant},
    };
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let app = Router::new().route(
        "/{*path}",
        post(move || {
            let count = count.clone();
            async move {
                count.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_secs(65)).await;
                Json(json!({"ok":true,"result":[]}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let client = Client::loopback_fixture(
        BotToken::new("123456:fixture-timeout-only".into()).unwrap(),
        &format!("http://{addr}"),
    )
    .unwrap();
    let started = Instant::now();
    let (read, send) = tokio::join!(
        client.get_updates(None, 0),
        client.send_message(42, "fixture", vec![])
    );
    assert_eq!(read.unwrap_err(), Error::Timeout);
    assert_eq!(send.unwrap_err(), Error::AmbiguousSend);
    assert!(started.elapsed() >= Duration::from_secs(44));
    assert!(started.elapsed() < Duration::from_secs(64));
    assert_eq!(requests.load(Ordering::SeqCst), 2);
    task.abort();
}

fn outgoing_request() -> xharness_remote::SendRequest {
    use xharness_remote::*;
    SendRequest {
        account: Account {
            channel: Channel::Telegram,
            id: "123456".into(),
        },
        sender: Sender {
            channel: Channel::Telegram,
            account: "123456".into(),
            user: "42".into(),
        },
        conversation: "42".into(),
        body: ReplyBody {
            attachment: None,
            text: "fixture output".into(),
            buttons: vec![],
        },
        replace_message: None,
        attachment: None,
    }
}
async fn replies(fixture: &Fixture) -> Replies {
    fixture.response(
        "getMe",
        200,
        json!({"ok":true,"result":{"id":123456,"is_bot":true}}),
    );
    fixture.response(
        "getWebhookInfo",
        200,
        json!({"ok":true,"result":{"url":""}}),
    );
    Replies::connect(fixture.client.clone(), 123456)
        .await
        .unwrap()
}
#[tokio::test]
async fn outgoing_transport_has_verified_account_plain_buttons_and_known_edit_receipt() {
    use xharness_remote::{ProviderReceipt, ReplyButton, ReplyTransport, SendOutcome};
    let fixture = Fixture::new().await;
    let transport = replies(&fixture).await;
    fixture.response(
        "sendMessage",
        200,
        json!({"ok":true,"result":{"message_id":99,"chat":{"id":42,"type":"private"}}}),
    );
    let mut request = outgoing_request();
    request.body.buttons = vec![vec![ReplyButton {
        label: "fixture ticket".into(),
        ticket: "opaque-test-ticket".into(),
    }]];
    assert_eq!(
        transport.send(request.clone()).await,
        SendOutcome::Delivered(ProviderReceipt {
            message_id: "99".into()
        })
    );
    request.replace_message = Some("99".into());
    fixture.response(
        "editMessageText",
        200,
        json!({"ok":true,"result":{"message_id":99,"chat":{"id":42,"type":"private"}}}),
    );
    assert!(matches!(
        transport.send(request).await,
        SendOutcome::Delivered(_)
    ));
    let calls = fixture.state.requests.lock().unwrap();
    assert_eq!(
        calls[2].1["reply_markup"]["inline_keyboard"][0][0]["callback_data"],
        "opaque-test-ticket"
    );
    assert_eq!(calls[3].1["message_id"], 99);
    assert_eq!(
        calls[3].1["reply_markup"]["inline_keyboard"][0][0]["text"],
        "fixture ticket"
    );
    assert!(calls[2].1.get("parse_mode").is_none());
}
#[tokio::test]
async fn outgoing_transport_rejects_forged_account_or_recipient_before_network() {
    use xharness_remote::{ReplyFailure, ReplyTransport, SendOutcome};
    let fixture = Fixture::new().await;
    let transport = replies(&fixture).await;
    let count = fixture.calls();
    let mut request = outgoing_request();
    request.conversation = "43".into();
    assert_eq!(
        transport.send(request).await,
        SendOutcome::Rejected(ReplyFailure::Forbidden)
    );
    for noncanonical in ["+42", "042", " 42"] {
        let mut request = outgoing_request();
        request.conversation = noncanonical.into();
        assert_eq!(
            transport.send(request).await,
            SendOutcome::Rejected(ReplyFailure::Forbidden)
        );
    }
    let mut request = outgoing_request();
    request.account.id = "654321".into();
    assert_eq!(
        transport.send(request).await,
        SendOutcome::Rejected(ReplyFailure::Forbidden)
    );
    assert_eq!(fixture.calls(), count);
    assert!(matches!(
        Replies::connect(fixture.client.clone(), 654321).await,
        Err(Error::Configuration)
    ));
}
#[tokio::test]
async fn outgoing_transport_only_retries_definite_rate_limit_not_uncertain_send() {
    use xharness_remote::{ReplyFailure, ReplyTransport, SendOutcome};
    let fixture = Fixture::new().await;
    let transport = replies(&fixture).await;
    fixture.response(
        "sendMessage",
        429,
        json!({"ok":false,"error_code":429,"parameters":{"retry_after":7}}),
    );
    assert_eq!(
        transport.send(outgoing_request()).await,
        SendOutcome::RetryAfter { seconds: 7 }
    );
    fixture.response("sendMessage", 503, json!({"ok":false,"error_code":503}));
    assert_eq!(
        transport.send(outgoing_request()).await,
        SendOutcome::Uncertain
    );
    fixture.response(
        "sendMessage",
        200,
        json!({"ok":true,"result":{"message_id":99,"chat":{"id":43,"type":"private"}}}),
    );
    assert_eq!(
        transport.send(outgoing_request()).await,
        SendOutcome::Uncertain
    );
    fixture.response("sendMessage", 401, json!({"ok":false,"error_code":401}));
    assert_eq!(
        transport.send(outgoing_request()).await,
        SendOutcome::Rejected(ReplyFailure::InvalidCredentials)
    );
    assert_eq!(
        fixture
            .state
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| m == "sendMessage")
            .count(),
        4
    );
}

struct ReplyHost;
#[async_trait::async_trait]
impl xharness_api::ApiBackend for ReplyHost {
    async fn call(
        &self,
        _: xharness_api::RpcId,
        _: xharness_api::RpcMethod,
        _: Value,
        _: tokio_util::sync::CancellationToken,
    ) -> xharness_api::RpcResult {
        panic!("outgoing HTTP must not rerun Agent")
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, xharness_api::RpcError> {
        Ok(w == "w" && s == "s")
    }
    async fn respond(&self, _: xharness_api::ClientResponse) -> xharness_api::RpcReceipt {
        panic!("no approval forwarding")
    }
    fn mux_events(&self) -> xharness_api::EventStream {
        panic!("no global mux")
    }
    fn host_events(&self) -> xharness_api::EventStream {
        panic!("no global events")
    }
}
#[tokio::test]
async fn actual_http_send_failure_is_durable_and_never_reruns_host_or_resends_on_restart() {
    use std::collections::BTreeSet;
    use tokio_util::sync::CancellationToken;
    use xharness_remote::*;
    let fixture = Fixture::new().await;
    let transport = Arc::new(replies(&fixture).await);
    let dir = tempfile::tempdir().unwrap();
    let host = Arc::new(ReplyHost);
    let gateway = Gateway::open(dir.path(), "host".into(), host.clone()).unwrap();
    gateway
        .set_principal(Principal {
            id: "p".into(),
            host: "host".into(),
            sender: outgoing_request().sender,
            workspaces: BTreeSet::from(["w".into()]),
            sessions: BTreeSet::from(["s".into()]),
            revision: 1,
            revoked: false,
        })
        .await
        .unwrap();
    gateway
        .bind(Binding {
            id: "b".into(),
            principal: "p".into(),
            conversation: "42".into(),
            workspace: "w".into(),
            session: "s".into(),
            generation: 1,
        })
        .await
        .unwrap();
    let scope = Subscription {
        principal: "p".into(),
        sender: outgoing_request().sender,
        conversation: "42".into(),
        binding: "b".into(),
        generation: 1,
    };
    let text = format!("{}{}", "输出".repeat(2100), "😀".repeat(10));
    let records = enqueue_text(&gateway, scope, "stable-projection-21", &text)
        .await
        .unwrap();
    assert!(records.len() > 1);
    assert_eq!(
        records
            .iter()
            .map(|r| r.plan.body.text.as_str())
            .collect::<String>(),
        text
    );
    let lease = gateway
        .acquire_account(transport.account().clone())
        .await
        .unwrap();
    fixture.response("sendMessage", 503, json!({"ok":false,"error_code":503}));
    let failed = gateway
        .deliver_reply(
            lease,
            &records[0].key,
            transport.clone(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(failed.state, ReplyState::Uncertain);
    let calls = fixture.calls();
    gateway.close().await.unwrap();
    drop(gateway);
    let restored = Gateway::open(dir.path(), "host".into(), host).unwrap();
    let lease = restored
        .acquire_account(transport.account().clone())
        .await
        .unwrap();
    restored
        .deliver_reply(lease, &records[0].key, transport, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(fixture.calls(), calls);
    assert_eq!(
        restored
            .inspect_reply(&records[0].key)
            .await
            .unwrap()
            .unwrap()
            .state,
        ReplyState::Uncertain
    );
}

#[test]
fn callback_debug_omits_handle_and_embedded_message_body_without_changing_wire() {
    let raw = "f".repeat(48);
    let value = json!({"update_id":9,"callback_query":{"id":"callback","from":{"id":42,"is_bot":false},"message":{"message_id":8,"chat":{"id":42,"type":"private"},"text":format!("private-body {raw}")},"data":format!("a:{raw}")}});
    let decoded = decode(&value).unwrap();
    assert!(!format!("{decoded:?}").contains(&raw));
    assert!(!format!("{decoded:?}").contains("private-body"));
    let Event::Callback(c) = decoded.event else {
        panic!("callback");
    };
    assert_eq!(c.data.as_deref(), Some(format!("a:{raw}").as_str()));
}

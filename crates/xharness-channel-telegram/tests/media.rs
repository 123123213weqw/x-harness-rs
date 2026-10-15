//! Multipart HTTP fixture, not a live Telegram account.
use axum::{
    body::Bytes,
    extract::{OriginalUri, State},
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use xharness_channel_telegram::{BotToken, Client, Error};
use xharness_remote::{ScopedAttachment, ScopedAttachmentKind};
type RecordedRequests = Arc<Mutex<Vec<(String, HeaderMap, Vec<u8>)>>>;
#[derive(Clone)]
struct Fixture {
    response: Arc<Mutex<(u16, Value)>>,
    requests: RecordedRequests,
}
async fn handler(
    State(f): State<Fixture>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    bytes: Bytes,
) -> (StatusCode, Json<Value>) {
    f.requests.lock().unwrap().push((
        uri.path().rsplit('/').next().unwrap().into(),
        headers,
        bytes.to_vec(),
    ));
    let method = uri.path().rsplit('/').next().unwrap();
    if method == "getMe" {
        return (
            StatusCode::OK,
            Json(json!({"ok":true,"result":{"id":123456,"is_bot":true}})),
        );
    }
    if method == "getWebhookInfo" {
        return (StatusCode::OK, Json(json!({"ok":true,"result":{"url":""}})));
    }
    let (status, value) = f.response.lock().unwrap().clone();
    (StatusCode::from_u16(status).unwrap(), Json(value))
}
fn file() -> ScopedAttachment {
    ScopedAttachment {
        id: "fixture-only".into(),
        kind: ScopedAttachmentKind::File,
        media_type: "text/plain".into(),
        width: 0,
        height: 0,
        data: b"fixture binary payload".to_vec(),
    }
}
async fn fixture() -> (Client, Fixture, tokio::task::JoinHandle<()>) {
    let f = Fixture {
        response: Arc::new(Mutex::new((
            200,
            json!({"ok":true,"result":{"message_id":91,"chat":{"id":42,"type":"private"}}}),
        ))),
        requests: Default::default(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = Router::new()
        .route("/{*path}", post(handler))
        .with_state(f.clone());
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let client = Client::loopback_fixture(
        BotToken::new("123456:fixture-only".into()).unwrap(),
        &format!("http://{addr}"),
    )
    .unwrap();
    (client, f, task)
}
#[tokio::test]
async fn byte_uploads_have_plain_captions_generated_names_and_closed_photo_or_document_selection() {
    let (c, f, t) = fixture().await;
    assert_eq!(
        c.send_attachment(42, "plain <b>中文</b>", file())
            .await
            .unwrap()
            .message_id,
        91
    );
    let mut photo = file();
    photo.kind = ScopedAttachmentKind::Image;
    photo.media_type = "image/png".into();
    photo.width = 32;
    photo.height = 32;
    c.send_attachment(42, "image", photo.clone()).await.unwrap();
    photo.width = 9000;
    photo.height = 1;
    c.send_attachment(42, "wide image document", photo)
        .await
        .unwrap();
    let requests = f.requests.lock().unwrap();
    assert_eq!(
        requests.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(),
        vec!["sendDocument", "sendPhoto", "sendDocument"]
    );
    for (_, headers, raw) in &*requests {
        assert!(headers["content-type"]
            .to_str()
            .unwrap()
            .starts_with("multipart/form-data; boundary="));
        let text = std::str::from_utf8(raw).unwrap();
        assert!(text.contains("fixture binary payload"));
        assert!(text.contains("name=\"chat_id\"\r\n\r\n42"));
        assert!(!text.contains("parse_mode"));
        assert!(!text.contains("fixture-only"));
        assert!(!text.contains("attachmentId"));
    }
    assert!(std::str::from_utf8(&requests[0].2)
        .unwrap()
        .contains("filename=\"attachment.txt\""));
    drop(requests);
    t.abort();
}
#[tokio::test]
async fn media_ambiguous_responses_and_limits_never_guess_success_or_retry() {
    let (c, f, t) = fixture().await;
    for (status, value, expected) in [
        (
            500,
            json!({"ok":false,"error_code":500}),
            Error::AmbiguousSend,
        ),
        (
            200,
            json!({"ok":true,"result":{"message_id":91,"chat":{"id":43,"type":"private"}}}),
            Error::AmbiguousSend,
        ),
        (
            429,
            json!({"ok":false,"error_code":429,"parameters":{"retry_after":7}}),
            Error::RateLimited { retry_after: 7 },
        ),
    ] {
        *f.response.lock().unwrap() = (status, value);
        assert_eq!(
            c.send_attachment(42, "caption", file()).await.unwrap_err(),
            expected
        );
    }
    let before = f.requests.lock().unwrap().len();
    {
        let mut bad = file();
        bad.media_type = "text/plain\r\nPRIVATE_HEADER".into();
        assert_eq!(
            c.send_attachment(42, "caption", bad).await.unwrap_err(),
            Error::InvalidAttachment
        );
    }
    assert_eq!(
        c.send_attachment(42, &"x".repeat(1025), file())
            .await
            .unwrap_err(),
        Error::InvalidAttachment
    );
    let mut large = file();
    large.data = vec![0; xharness_remote::MAX_SCOPED_ATTACHMENT_BYTES + 1];
    assert_eq!(
        c.send_attachment(42, "caption", large).await.unwrap_err(),
        Error::InvalidAttachment
    );
    assert_eq!(f.requests.lock().unwrap().len(), before);
    t.abort();
}

struct ScopedHost;
#[async_trait::async_trait]
impl xharness_api::ApiBackend for ScopedHost {
    async fn call(
        &self,
        _: xharness_api::RpcId,
        _: xharness_api::RpcMethod,
        _: Value,
        _: tokio_util::sync::CancellationToken,
    ) -> xharness_api::RpcResult {
        panic!("media reply must never replay native command");
    }
    async fn respond(&self, _: xharness_api::ClientResponse) -> xharness_api::RpcReceipt {
        panic!("no native decisions");
    }
    fn mux_events(&self) -> xharness_api::EventStream {
        panic!("no global mux");
    }
    fn host_events(&self) -> xharness_api::EventStream {
        panic!("no global events");
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, xharness_api::RpcError> {
        Ok(w == "w" && s == "s")
    }
    async fn session_event_attachment(
        &self,
        w: &str,
        s: &str,
        seq: u64,
        id: &str,
    ) -> Result<ScopedAttachment, xharness_api::RpcError> {
        assert_eq!((w, s, seq), ("w", "s", 7));
        let mut f = file();
        f.id = id.into();
        Ok(f)
    }
}
#[tokio::test]
async fn actual_multipart_gateway_unknown_receipt_persists_and_never_resends_after_reopen() {
    use sha2::{Digest, Sha256};
    use tokio_util::sync::CancellationToken;
    use xharness_remote::*;
    let (client, fixture, server) = fixture().await;
    let transport = Arc::new(
        xharness_channel_telegram::Replies::connect(Arc::new(client), 123456)
            .await
            .unwrap(),
    );
    let root = tempfile::tempdir().unwrap();
    let g = Gateway::open(root.path(), "h".into(), Arc::new(ScopedHost)).unwrap();
    let sender = Sender {
        channel: Channel::Telegram,
        account: "123456".into(),
        user: "42".into(),
    };
    g.set_principal(Principal {
        id: "p".into(),
        host: "h".into(),
        sender: sender.clone(),
        workspaces: ["w".into()].into(),
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
        workspace: "w".into(),
        session: "s".into(),
        generation: 1,
    })
    .await
    .unwrap();
    let lease = g
        .acquire_account(transport.account().clone())
        .await
        .unwrap();
    let scope = Subscription {
        principal: "p".into(),
        sender,
        conversation: "42".into(),
        binding: "b".into(),
        generation: 1,
    };
    let mut hash = Sha256::new();
    hash.update(b"xharness-file-v1\0");
    hash.update(b"text/plain");
    hash.update([0]);
    hash.update(b"fixture binary payload");
    let id = format!("{:x}", hash.finalize());
    let plan = ReplyPlan {
        id: "actual-multipart-uncertainty".into(),
        body: ReplyBody {
            text: "fixture caption".into(),
            buttons: vec![],
            attachment: Some(ReplyAttachment { event_seq: 7, id }),
        },
        replace_of: None,
    };
    let record = g
        .enqueue_replies(scope, vec![plan])
        .await
        .unwrap()
        .remove(0);
    *fixture.response.lock().unwrap() = (500, json!({"ok":false,"error_code":500}));
    let sent = g
        .deliver_reply(
            lease,
            &record.key,
            transport.clone(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(sent.state, ReplyState::Uncertain);
    g.close().await.unwrap();
    let g = Gateway::open(root.path(), "h".into(), Arc::new(ScopedHost)).unwrap();
    let lease = g
        .acquire_account(transport.account().clone())
        .await
        .unwrap();
    *fixture.response.lock().unwrap() = (
        200,
        json!({"ok":true,"result":{"message_id":92,"chat":{"id":42,"type":"private"}}}),
    );
    assert_eq!(
        g.deliver_reply(lease, &record.key, transport, CancellationToken::new())
            .await
            .unwrap()
            .state,
        ReplyState::Uncertain
    );
    assert_eq!(
        fixture
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.0 == "sendDocument")
            .count(),
        1
    );
    g.close().await.unwrap();
    server.abort();
}

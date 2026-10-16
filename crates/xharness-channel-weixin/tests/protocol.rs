//! Loopback protocol fixtures only. No real account, credential store or model.
use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{Request, Response},
    routing::any,
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use xharness_channel_weixin::*;
use xharness_remote::{Content, RejectionCode};

#[derive(Clone)]
struct Reply {
    status: u16,
    body: Vec<u8>,
    headers: Vec<(String, String)>,
    delay: Duration,
}
#[derive(Clone)]
struct Recorded {
    method: String,
    path: String,
    query: String,
    headers: axum::http::HeaderMap,
    body: Vec<u8>,
}
#[derive(Clone, Default)]
struct Data {
    replies: Arc<Mutex<BTreeMap<String, Reply>>>,
    requests: Arc<Mutex<Vec<Recorded>>>,
}
struct Fixture {
    base: String,
    data: Data,
    task: JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Fixture {
    async fn new() -> Self {
        let data = Data::default();
        let router = Router::new()
            .route("/{*path}", any(handler))
            .with_state(data.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self { base, data, task }
    }
    fn json(&self, path: &str, status: u16, value: Value) {
        self.bytes(path, status, serde_json::to_vec(&value).unwrap(), vec![]);
    }
    fn bytes(&self, path: &str, status: u16, body: Vec<u8>, headers: Vec<(String, String)>) {
        self.data.replies.lock().unwrap().insert(
            path.into(),
            Reply {
                status,
                body,
                headers,
                delay: Duration::ZERO,
            },
        );
    }
    fn client(&self) -> Client {
        Client::loopback_fixture(
            BotToken::new("fixture-bearer-only".into()).unwrap(),
            "fixture@im.bot".into(),
            &self.base,
        )
        .unwrap()
    }
    fn pairing(&self) -> PairingClient {
        PairingClient::loopback_fixture(&self.base).unwrap()
    }
    fn requests(&self) -> Vec<Recorded> {
        self.data.requests.lock().unwrap().clone()
    }
    fn qr(&self) {
        self.json("/ilink/bot/get_bot_qrcode",200,json!({"qrcode":"fixture-qr-nonce","qrcode_img_content":"https://weixin.qq.com/x/fixture"}));
    }
}
async fn handler(State(data): State<Data>, request: Request<Body>) -> Response<Body> {
    let method = request.method().to_string();
    let path = request.uri().path().to_owned();
    let query = request.uri().query().unwrap_or("").to_owned();
    let headers = request.headers().clone();
    let body = to_bytes(request.into_body(), MAX_JSON_BYTES)
        .await
        .unwrap()
        .to_vec();
    data.requests.lock().unwrap().push(Recorded {
        method,
        path: path.clone(),
        query,
        headers,
        body,
    });
    let reply = data
        .replies
        .lock()
        .unwrap()
        .get(&path)
        .cloned()
        .unwrap_or(Reply {
            status: 404,
            body: b"{}".to_vec(),
            headers: vec![],
            delay: Duration::ZERO,
        });
    tokio::time::sleep(reply.delay).await;
    let mut response = Response::builder().status(reply.status);
    for (key, value) in reply.headers {
        response = response.header(key, value);
    }
    response.body(Body::from(reply.body)).unwrap()
}
fn message() -> Value {
    json!({"message_id":17,"message_type":1,"from_user_id":"fixture-user","to_user_id":"fixture@im.bot","context_token":"fixture-context-secret","item_list":[{"type":1,"text_item":{"text":"hello"}}]})
}

#[tokio::test]
async fn qr_post_status_get_and_confirmation_use_current_official_shapes() {
    let fixture = Fixture::new().await;
    fixture.qr();
    let pairing = fixture.pairing();
    let cancel = CancellationToken::new();
    let mut login = pairing.start(&cancel).await.unwrap();
    assert_eq!(login.display_content(), "https://weixin.qq.com/x/fixture");
    assert!(!format!("{login:?}").contains("fixture-qr"));
    fixture.json(
        "/ilink/bot/get_qrcode_status",
        200,
        json!({"status":"need_verifycode"}),
    );
    assert!(matches!(
        pairing.poll(&mut login, None, &cancel).await.unwrap(),
        PairingStatus::NeedsVerification
    ));
    fixture.json("/ilink/bot/get_qrcode_status",200,json!({"status":"confirmed","bot_token":"fixture-result-token","ilink_bot_id":"fixture@im.bot","ilink_user_id":"fixture-user","baseurl":fixture.base}));
    let PairingStatus::Confirmed(credentials) = pairing
        .poll(&mut login, Some("123456"), &cancel)
        .await
        .unwrap()
    else {
        panic!("confirmation missing")
    };
    assert_eq!(credentials.bot_id(), "fixture@im.bot");
    assert_eq!(credentials.owner_id(), "fixture-user");
    assert!(!format!("{credentials:?}").contains("fixture-result-token"));
    assert_eq!(
        pairing.poll(&mut login, None, &cancel).await.unwrap_err(),
        Error::PairingExpired
    );
    let requests = fixture.requests();
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].path, "/ilink/bot/get_bot_qrcode");
    assert_eq!(requests[0].query, "bot_type=3");
    assert_eq!(
        serde_json::from_slice::<Value>(&requests[0].body).unwrap(),
        json!({"local_token_list":[]})
    );
    assert!(!requests[0].headers.contains_key("authorization"));
    assert!(requests[0].headers.contains_key("authorizationtype"));
    assert_eq!(requests[1].method, "GET");
    assert_eq!(requests[1].path, "/ilink/bot/get_qrcode_status");
    assert!(!requests[1].headers.contains_key("authorizationtype"));
    assert!(!requests[1].headers.contains_key("x-wechat-uin"));
    assert!(requests[2].query.contains("verify_code=123456"));
}

#[tokio::test]
async fn qr_terminal_and_transient_statuses_are_explicit_not_success() {
    let fixture = Fixture::new().await;
    fixture.qr();
    let pairing = fixture.pairing();
    let cancel = CancellationToken::new();
    for status in [
        "wait",
        "scaned",
        "expired",
        "verify_code_blocked",
        "binded_redirect",
    ] {
        let mut session = pairing.start(&cancel).await.unwrap();
        fixture.json(
            "/ilink/bot/get_qrcode_status",
            200,
            json!({"status":status}),
        );
        let actual = pairing.poll(&mut session, None, &cancel).await.unwrap();
        assert!(matches!(
            (status, actual),
            ("wait", PairingStatus::Waiting)
                | ("scaned", PairingStatus::Scanned)
                | ("expired", PairingStatus::Expired)
                | ("verify_code_blocked", PairingStatus::VerificationBlocked)
                | ("binded_redirect", PairingStatus::AlreadyBound)
        ));
    }
}

#[tokio::test]
async fn qr_rejects_unknown_status_wrong_origin_and_missing_confirmed_identity() {
    let fixture = Fixture::new().await;
    fixture.qr();
    let pairing = fixture.pairing();
    let cancel = CancellationToken::new();
    let mut login = pairing.start(&cancel).await.unwrap();
    for value in [
        json!({"status":"future-new-status"}),
        json!({"status":"scaned_but_redirect","redirect_host":"127.0.0.1:9999"}),
        json!({"status":"confirmed","bot_token":"fixture-token","ilink_bot_id":"fixture@im.bot","ilink_user_id":"fixture-user","baseurl":"http://127.0.0.1:9999/"}),
        json!({"status":"confirmed","bot_token":"fixture-token"}),
    ] {
        fixture.json("/ilink/bot/get_qrcode_status", 200, value);
        assert_eq!(
            pairing.poll(&mut login, None, &cancel).await.unwrap_err(),
            Error::MalformedResponse
        );
    }
    let calls = fixture.requests().len();
    assert_eq!(
        pairing
            .poll(&mut login, Some("code\n"), &cancel)
            .await
            .unwrap_err(),
        Error::Configuration
    );
    assert_eq!(fixture.requests().len(), calls);
}

#[tokio::test]
async fn updates_echo_only_supplied_opaque_cursor_and_do_not_advance_it() {
    let fixture = Fixture::new().await;
    let client = fixture.client();
    let cancel = CancellationToken::new();
    fixture.json("/ilink/bot/getupdates",200,json!({"ret":0,"msgs":[message()],"get_updates_buf":"opaque-next/==","longpolling_timeout_ms":35000}));
    for _ in 0..2 {
        let updates = client.get_updates("opaque-old/==", &cancel).await.unwrap();
        assert_eq!(updates.next_cursor, "opaque-next/==");
        assert_eq!(updates.messages.len(), 1);
        assert_eq!(updates.suggested_timeout_ms, Some(35000));
    }
    for request in fixture.requests() {
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["get_updates_buf"], "opaque-old/==");
        assert_eq!(body["base_info"]["bot_agent"], "XHarness/0.1.0");
        assert_eq!(
            request.headers.get("authorization").unwrap(),
            "Bearer fixture-bearer-only"
        );
        let uin = STANDARD
            .decode(
                request
                    .headers
                    .get("x-wechat-uin")
                    .unwrap()
                    .to_str()
                    .unwrap(),
            )
            .unwrap();
        assert!(std::str::from_utf8(&uin).unwrap().parse::<u32>().is_ok());
    }
}

#[tokio::test]
async fn updates_session_expiry_missing_fields_and_limits_fail_closed() {
    let fixture = Fixture::new().await;
    let client = fixture.client();
    let cancel = CancellationToken::new();
    for value in [
        json!({"ret":-14,"errmsg":"private provider detail"}),
        json!({"ret":0,"errcode":-14}),
    ] {
        fixture.json("/ilink/bot/getupdates", 200, value);
        assert_eq!(
            client.get_updates("", &cancel).await.err().unwrap(),
            Error::SessionExpired
        );
    }
    for value in [
        json!({"ret":0}),
        json!({"ret":"0","msgs":[],"get_updates_buf":"next"}),
        json!({"ret":0,"msgs":[message()],"get_updates_buf":""}),
        json!({"ret":0,"msgs":vec![message();257],"get_updates_buf":"next"}),
    ] {
        fixture.json("/ilink/bot/getupdates", 200, value);
        assert_eq!(
            client.get_updates("", &cancel).await.err().unwrap(),
            Error::MalformedResponse
        );
    }
    assert_eq!(
        client
            .get_updates(&"c".repeat(MAX_CURSOR_BYTES + 1), &cancel)
            .await
            .err()
            .unwrap(),
        Error::Configuration
    );
}

#[tokio::test]
async fn text_requires_context_keeps_client_id_and_has_no_retry() {
    let fixture = Fixture::new().await;
    let client = fixture.client();
    let cancel = CancellationToken::new();
    fixture.json("/ilink/bot/sendmessage", 200, json!({"ret":0}));
    client
        .send_text(
            "fixture-user",
            "fixture-context-secret",
            "intent-17",
            "hello\nworld",
            &cancel,
        )
        .await
        .unwrap();
    let recorded = fixture.requests();
    let body: Value = serde_json::from_slice(&recorded[0].body).unwrap();
    assert_eq!(body["msg"]["client_id"], "intent-17");
    assert_eq!(body["msg"]["context_token"], "fixture-context-secret");
    assert_eq!(body["msg"]["message_state"], 2);
    assert_eq!(
        client
            .send_text("fixture-user", "", "intent-18", "bad", &cancel)
            .await
            .unwrap_err(),
        Error::Configuration
    );
    assert_eq!(fixture.requests().len(), 1);
    for value in [json!({}), json!({"ret":0,"unknown":"shape"})] {
        fixture.json("/ilink/bot/sendmessage", 200, value.clone());
        let result = client
            .send_text(
                "fixture-user",
                "fixture-context-secret",
                "intent-19",
                "hello",
                &cancel,
            )
            .await;
        if value.get("ret") == Some(&json!(0)) {
            assert!(result.is_ok());
        } else {
            assert_eq!(result.unwrap_err(), Error::AmbiguousSend);
        }
    }
    fixture.bytes("/ilink/bot/sendmessage", 500, b"{}".to_vec(), vec![]);
    assert_eq!(
        client
            .send_text(
                "fixture-user",
                "fixture-context-secret",
                "intent-20",
                "hello",
                &cancel
            )
            .await
            .unwrap_err(),
        Error::AmbiguousSend
    );
    assert_eq!(fixture.requests().len(), 4);
}

#[tokio::test]
async fn redirects_do_not_forward_credentials_and_errors_are_redacted() {
    let fixture = Fixture::new().await;
    let client = fixture.client();
    let cancel = CancellationToken::new();
    fixture.bytes(
        "/ilink/bot/getupdates",
        302,
        b"fixture-token-private-body".to_vec(),
        vec![("location".into(), format!("{}other", fixture.base))],
    );
    assert_eq!(
        client.get_updates("", &cancel).await.err().unwrap(),
        Error::Rejected { code: 302 }
    );
    assert_eq!(fixture.requests().len(), 1);
    fixture.bytes(
        "/ilink/bot/sendmessage",
        200,
        b"fixture-context-secret malformed".to_vec(),
        vec![],
    );
    let error = client
        .send_text(
            "fixture-user",
            "fixture-context-secret",
            "intent-1",
            "hi",
            &cancel,
        )
        .await
        .unwrap_err();
    assert_eq!(error, Error::AmbiguousSend);
    assert!(!format!("{error:?} {error}").contains("fixture-context-secret"));
}

#[tokio::test]
async fn cancelled_poll_stops_promptly_and_pre_cancelled_send_is_not_submitted() {
    let fixture = Fixture::new().await;
    let client = fixture.client();
    fixture.json(
        "/ilink/bot/getupdates",
        200,
        json!({"ret":0,"msgs":[],"get_updates_buf":"next"}),
    );
    fixture
        .data
        .replies
        .lock()
        .unwrap()
        .get_mut("/ilink/bot/getupdates")
        .unwrap()
        .delay = Duration::from_secs(30);
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        stop.cancel();
    });
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), client.get_updates("", &cancel))
            .await
            .unwrap()
            .err()
            .unwrap(),
        Error::Cancelled
    );
    let calls = fixture.requests().len();
    assert_eq!(
        client
            .send_text(
                "fixture-user",
                "fixture-context-secret",
                "intent-1",
                "hi",
                &cancel
            )
            .await
            .unwrap_err(),
        Error::Cancelled
    );
    assert_eq!(fixture.requests().len(), calls);
}

#[tokio::test]
async fn upload_encrypts_media_without_bearer_on_cdn_and_sends_separate_intent() {
    let fixture = Fixture::new().await;
    let client = fixture.client();
    let cancel = CancellationToken::new();
    fixture.json(
        "/ilink/bot/getuploadurl",
        200,
        json!({"upload_param":"fixture-upload-param"}),
    );
    fixture.bytes(
        "/c2c/upload",
        200,
        vec![],
        vec![("x-encrypted-param".into(), "fixture-download-param".into())],
    );
    fixture.json("/ilink/bot/sendmessage", 200, json!({"ret":0}));
    let plain = b"test attachment bytes";
    let media = client
        .upload_media("fixture-user", MediaKind::File, plain, &cancel)
        .await
        .unwrap();
    assert_eq!(media.plaintext_bytes, plain.len());
    assert_eq!(media.ciphertext_bytes, 32);
    assert_eq!(fixture.requests().len(), 2);
    client
        .send_media(
            "fixture-user",
            "fixture-context-secret",
            "durable-send-17",
            &media,
            Some("result.txt"),
            &cancel,
        )
        .await
        .unwrap();
    let requests = fixture.requests();
    let upload: Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(upload["rawsize"], plain.len());
    assert_eq!(upload["filesize"], 32);
    assert_eq!(upload["media_type"], 3);
    assert!(!requests[1].headers.contains_key("authorization"));
    assert_ne!(requests[1].body, plain);
    let key = upload["aeskey"].as_str().unwrap();
    fixture.bytes("/c2c/download", 200, requests[1].body.clone(), vec![]);
    let reference=MediaReference::from_json(json!({"encrypt_query_param":"fixture-download-param","aes_key":STANDARD.encode(key),"encrypt_type":1})).unwrap();
    assert_eq!(
        client
            .download_media(&reference, None, &cancel)
            .await
            .unwrap(),
        plain
    );
    assert!(!fixture.requests()[3].headers.contains_key("authorization"));
    let sent: Value = serde_json::from_slice(&requests[2].body).unwrap();
    assert_eq!(sent["msg"]["client_id"], "durable-send-17");
    assert_eq!(
        sent["msg"]["item_list"][0]["file_item"]["len"],
        plain.len().to_string()
    );
    assert_eq!(
        client
            .send_media(
                "fixture-user",
                "fixture-context-secret",
                "bad-name",
                &media,
                Some("../escape"),
                &cancel
            )
            .await
            .unwrap_err(),
        Error::InvalidMedia
    );
}

#[tokio::test]
async fn media_signed_urls_cannot_escape_origin_and_missing_upload_proof_fails() {
    let fixture = Fixture::new().await;
    let client = fixture.client();
    let cancel = CancellationToken::new();
    fixture.json(
        "/ilink/bot/getuploadurl",
        200,
        json!({"upload_full_url":"http://127.0.0.1:9999/upload"}),
    );
    assert_eq!(
        client
            .upload_media("fixture-user", MediaKind::File, b"hello", &cancel)
            .await
            .err()
            .unwrap(),
        Error::InvalidMedia
    );
    assert_eq!(fixture.requests().len(), 1);
    fixture.json(
        "/ilink/bot/getuploadurl",
        200,
        json!({"upload_param":"fixture"}),
    );
    fixture.bytes("/c2c/upload", 200, vec![], vec![]);
    assert_eq!(
        client
            .upload_media("fixture-user", MediaKind::File, b"hello", &cancel)
            .await
            .err()
            .unwrap(),
        Error::MalformedResponse
    );
    let reference=MediaReference::from_json(json!({"full_url":"http://127.0.0.1:9999/download","aes_key":STANDARD.encode([0u8;16]),"encrypt_type":1})).unwrap();
    let calls = fixture.requests().len();
    assert_eq!(
        client
            .download_media(&reference, None, &cancel)
            .await
            .err()
            .unwrap(),
        Error::InvalidMedia
    );
    assert_eq!(fixture.requests().len(), calls);
    assert!(client
        .upload_media(
            "fixture-user",
            MediaKind::File,
            &vec![0; MAX_ATTACHMENT_BYTES + 1],
            &cancel
        )
        .await
        .is_err());
}

#[tokio::test]
async fn pure_image_is_materialized_without_placeholder_text() {
    let fixture = Fixture::new().await;
    let client = fixture.client();
    let cancel = CancellationToken::new();
    fixture.json(
        "/ilink/bot/getuploadurl",
        200,
        json!({"upload_param":"fixture"}),
    );
    fixture.bytes(
        "/c2c/upload",
        200,
        vec![],
        vec![("x-encrypted-param".into(), "fixture-download".into())],
    );
    let plain = b"\x89PNG\r\n\x1a\nfixture";
    client
        .upload_media("fixture-user", MediaKind::Image, plain, &cancel)
        .await
        .unwrap();
    let requests = fixture.requests();
    let upload: Value = serde_json::from_slice(&requests[0].body).unwrap();
    fixture.bytes("/c2c/download", 200, requests[1].body.clone(), vec![]);
    let mut raw = message();
    raw["item_list"] = json!([{"type":2,"image_item":{"aeskey":upload["aeskey"],"media":{"encrypt_query_param":"fixture-download","encrypt_type":1}}}]);
    let decoded = decode_private_message(&raw, "fixture@im.bot").unwrap();
    let content = client
        .materialize_parts(&decoded.parts, &cancel)
        .await
        .unwrap();
    assert_eq!(content.len(), 1);
    assert!(
        matches!(&content[0],Content::Image{media_type,data,..}if media_type=="image/png"&&STANDARD.decode(data).unwrap()==plain)
    );
}

#[test]
fn normalization_rejects_groups_identity_spoofing_unknown_items_and_file_paths() {
    let parsed = decode_private_message(&message(), "fixture@im.bot").unwrap();
    assert_eq!(parsed.conversation, "fixture-user");
    assert_eq!(parsed.message_id, "17");
    for (key, value, code) in [
        ("group_id", json!("group-1"), RejectionCode::Unsupported),
        (
            "to_user_id",
            json!("other@im.bot"),
            RejectionCode::Malformed,
        ),
        ("message_id", json!(0), RejectionCode::Malformed),
        ("context_token", json!(""), RejectionCode::Malformed),
        (
            "item_list",
            json!([{"type":11}]),
            RejectionCode::Unsupported,
        ),
    ] {
        let mut raw = message();
        raw[key] = value;
        assert_eq!(
            decode_private_message(&raw, "fixture@im.bot")
                .err()
                .unwrap(),
            code
        );
    }
    let mut raw = message();
    raw["item_list"] = json!([{"type":4,"file_item":{"file_name":"../../secret","media":{"encrypt_query_param":"fixture","aes_key":STANDARD.encode([0u8;16])}}}]);
    assert_eq!(
        decode_private_message(&raw, "fixture@im.bot")
            .err()
            .unwrap(),
        RejectionCode::Malformed
    );
}

#[test]
fn production_endpoints_tokens_and_media_keys_are_strict_and_redacted() {
    for base in [
        "http://ilinkai.weixin.qq.com/",
        "https://evilweixin.qq.com/",
        "https://ilinkai.weixin.qq.com.evil.example/",
        "https://user@ilinkai.weixin.qq.com/",
        "https://ilinkai.weixin.qq.com/?secret=1",
        "https://ilinkai.weixin.qq.com:444/",
    ] {
        assert!(Credentials::new(
            BotToken::new("fixture-token".into()).unwrap(),
            base,
            "fixture@im.bot".into(),
            "fixture-user".into()
        )
        .is_err());
    }
    assert!(Credentials::new(
        BotToken::new("fixture-token".into()).unwrap(),
        API_BASE,
        "fixture@im.bot".into(),
        "fixture-user".into()
    )
    .is_ok());
    assert!(BotToken::new("header\r\ninjection".into()).is_err());
    assert!(
        !format!("{:?}", BotToken::new("fixture-token".into()).unwrap()).contains("fixture-token")
    );
    assert!(
        MediaReference::from_json(json!({"encrypt_query_param":"fixture","encrypt_type":99}))
            .is_err()
    );
    assert!(MediaKey::from_hex("not a valid AES key").is_err());
    assert!(Client::loopback_fixture(
        BotToken::new("fixture-token".into()).unwrap(),
        "fixture@im.bot".into(),
        "http://example.com/"
    )
    .is_err());
}

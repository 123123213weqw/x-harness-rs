use super::*;
use futures::{SinkExt, StreamExt};
use reqwest::Client;
use serde_json::{json, Value};
use tokio_tungstenite::{
    connect_async, tungstenite::Message as WsMessage, MaybeTlsStream, WebSocketStream,
};

const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SECRET: &str = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const HOST: &str = "test-host";
type MockSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

struct Fixture {
    origin: String,
    public_origin: String,
    cancellation: CancellationToken,
    task: tokio::task::JoinHandle<Result<(), RelayError>>,
    _root: tempfile::TempDir,
}
impl Fixture {
    async fn start() -> Self {
        Self::start_with_origin(None).await
    }
    async fn start_with_origin(public: Option<&str>) -> Self {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("index.html"),
            "<html>mobile fixture</html>",
        )
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let bind = listener.local_addr().unwrap();
        let origin = format!("http://{bind}");
        let public_origin = public.unwrap_or(&origin).to_owned();
        let config = test_config(root.path(), bind, &public_origin);
        let cancellation = CancellationToken::new();
        let task = tokio::spawn(serve(listener, config, cancellation.clone()));
        Self {
            origin,
            public_origin,
            cancellation,
            task,
            _root: root,
        }
    }
    async fn host(&self, key: &str) -> MockSocket {
        let (mut socket, _) = connect_async(format!(
            "{}/api/mobile/host",
            self.origin.replace("http://", "ws://")
        ))
        .await
        .unwrap();
        socket
            .send(WsMessage::Text(
                serde_json::to_string(&HostFrame::Hello {
                    host: HOST.into(),
                    key: Secret::try_from(key.to_owned()).unwrap(),
                })
                .unwrap()
                .into(),
            ))
            .await
            .unwrap();
        socket
    }
    async fn connected_host(&self) -> MockSocket {
        let mut socket = self.host(KEY).await;
        let frame = socket.next().await.unwrap().unwrap();
        assert!(matches!(
            serde_json::from_str::<RelayFrame>(&frame.into_text().unwrap()).unwrap(),
            RelayFrame::Ready
        ));
        socket
    }
    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        Client::new()
            .post(format!("{}{path}", self.origin))
            .header("origin", &self.public_origin)
    }
    async fn stop(self) {
        self.cancellation.cancel();
        tokio::time::timeout(Duration::from_secs(5), self.task)
            .await
            .expect("relay drains")
            .unwrap()
            .unwrap();
    }
}
fn test_config(root: &Path, bind: SocketAddr, origin: &str) -> Config {
    Config {
        bind,
        static_dir: root.into(),
        public_origin: origin.into(),
        allow_loopback_http: true,
        registered: RegisteredHosts {
            hosts: HashMap::from([(
                HOST.into(),
                RegisteredHost {
                    key_sha256: hex::encode(Sha256::digest(KEY.as_bytes())),
                },
            )]),
        },
    }
}
async fn next_request(socket: &mut MockSocket) -> (String, MobileRequest) {
    let frame = tokio::time::timeout(Duration::from_secs(3), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    match serde_json::from_str::<RelayFrame>(&frame.into_text().unwrap()).unwrap() {
        RelayFrame::Request { id, request } => (id, request),
        _ => panic!("expected request"),
    }
}
async fn respond(socket: &mut MockSocket, id: String, response: MobileResponse) {
    socket
        .send(WsMessage::Text(
            serde_json::to_string(&HostFrame::Response { id, response })
                .unwrap()
                .into(),
        ))
        .await
        .unwrap();
}
fn cookie_fixture(origin: &str) -> String {
    let config = test_config(Path::new("."), "127.0.0.1:1".parse().unwrap(), origin);
    let cookie = DeviceCookie {
        host: HOST.into(),
        device: "device-1".into(),
        secret: Secret::try_from(SECRET.to_owned()).unwrap(),
    };
    format!(
        "{}={}",
        config.cookie_name(),
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cookie).unwrap())
    )
}

#[test]
fn requires_exact_https_origin_or_explicit_loopback() {
    let root = tempfile::tempdir().unwrap();
    let mut config = test_config(
        root.path(),
        "127.0.0.1:31368".parse().unwrap(),
        "http://127.0.0.1:31368",
    );
    assert!(config.validate().is_ok());
    config.allow_loopback_http = false;
    assert!(config.validate().is_err());
    config.public_origin = "https://mobile.example".into();
    assert!(config.validate().is_ok());
    assert!(config.secure());
    assert!(config.cookie_name().starts_with("__Host-"));
    for invalid in [
        "https://mobile.example/",
        "https://user@mobile.example",
        "https://mobile.example/path",
        "https://mobile.example?x=1",
        "https://mobile.example#token",
        "http://192.168.1.1:31368",
    ] {
        config.public_origin = invalid.into();
        config.allow_loopback_http = true;
        assert!(config.validate().is_err(), "invalid origin: {invalid}");
    }
    config.public_origin = "http://127.0.0.1:31368".into();
    config.bind = "0.0.0.0:31368".parse().unwrap();
    assert!(config.validate().is_err());
}

#[test]
fn host_registry_rejects_invalid_hashes_and_names() {
    let mut registered = RegisteredHosts {
        hosts: HashMap::new(),
    };
    assert!(validate_registered(&registered).is_err());
    registered.hosts.insert(
        "../path".into(),
        RegisteredHost {
            key_sha256: "a".repeat(64),
        },
    );
    assert!(validate_registered(&registered).is_err());
    registered.hosts.clear();
    registered.hosts.insert(
        HOST.into(),
        RegisteredHost {
            key_sha256: "A".repeat(64),
        },
    );
    assert!(validate_registered(&registered).is_err());
    registered.hosts.get_mut(HOST).unwrap().key_sha256 = "a".repeat(64);
    assert!(validate_registered(&registered).is_ok());
}

#[test]
fn rates_refill_and_remain_bounded() {
    let now = Instant::now();
    let mut rate = PeerRate::new(now);
    for _ in 0..6 {
        assert!(rate.take(RateKind::Pair, now));
    }
    assert!(!rate.take(RateKind::Pair, now));
    assert!(rate.take(RateKind::Pair, now + Duration::from_secs(10)));
    assert!(!rate.take(RateKind::Pair, now + Duration::from_secs(10)));
    for _ in 0..120 {
        assert!(rate.take(RateKind::Action, now + Duration::from_secs(10)));
    }
    assert!(!rate.take(RateKind::Action, now + Duration::from_secs(10)));
}

#[test]
fn cookie_parser_rejects_duplicates_malformed_and_unknown_hosts() {
    let config = test_config(
        Path::new("."),
        "127.0.0.1:1".parse().unwrap(),
        "http://127.0.0.1:1",
    );
    let valid = cookie_fixture(&config.public_origin);
    let mut headers = HeaderMap::new();
    headers.insert(header::COOKIE, HeaderValue::from_str(&valid).unwrap());
    assert!(read_cookie(&headers, &config).is_some());
    headers.append(header::COOKIE, HeaderValue::from_str(&valid).unwrap());
    assert!(read_cookie(&headers, &config).is_none());
    for malformed in [
        "xharness_mobile_loopback=!!!",
        "xharness_mobile_loopback=e30",
        "unrelated",
    ] {
        headers.insert(header::COOKIE, HeaderValue::from_str(malformed).unwrap());
        assert!(read_cookie(&headers, &config).is_none());
    }
}

#[cfg(unix)]
#[test]
fn registry_requires_private_regular_file_not_symlink() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("hosts.json");
    std::fs::write(
        &file,
        json!({"hosts": {HOST: {"key_sha256": "a".repeat(64)}}}).to_string(),
    )
    .unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(load_registered_hosts(&file).is_ok());
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(load_registered_hosts(&file).is_err());
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    let link = root.path().join("link.json");
    symlink(&file, &link).unwrap();
    assert!(load_registered_hosts(&link).is_err());
}

#[tokio::test]
async fn pair_hides_device_secret_then_action_authenticates_from_cookie_only() {
    let fixture = Fixture::start().await;
    let mut host = fixture.connected_host().await;
    let pending = tokio::spawn(
        fixture
            .post("/api/mobile/pair")
            .json(&json!({"host": HOST, "code": KEY, "name": "test phone"}))
            .send(),
    );
    let (id, request) = next_request(&mut host).await;
    assert!(matches!(request, MobileRequest::Pair { .. }));
    respond(
        &mut host,
        id,
        MobileResponse::success(
            serde_json::to_value(PairedDevice {
                host: HOST.into(),
                device: "device-1".into(),
                secret: Secret::try_from(SECRET.to_owned()).unwrap(),
            })
            .unwrap(),
        ),
    )
    .await;
    let paired = pending.await.unwrap().unwrap();
    assert_eq!(paired.status(), StatusCode::OK);
    let cookie = paired
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("SameSite=Strict"));
    assert!(!cookie.contains("Secure"));
    assert_eq!(paired.headers()[header::CACHE_CONTROL], "no-store");
    let paired_body = paired.text().await.unwrap();
    assert!(!paired_body.contains(SECRET));
    assert!(!paired_body.contains("secret"));
    let cookie = cookie.split(';').next().unwrap().to_owned();
    let pending = tokio::spawn(
        fixture
            .post("/api/mobile/action")
            .header("cookie", &cookie)
            .json(&json!({"type": "status"}))
            .send(),
    );
    let (id, request) = next_request(&mut host).await;
    match request {
        MobileRequest::Authenticated {
            device,
            secret,
            action: MobileAction::Status,
        } => {
            assert_eq!(device, "device-1");
            assert_eq!(secret.expose(), SECRET);
        }
        _ => panic!("cookie-derived identity required"),
    }
    respond(
        &mut host,
        id,
        MobileResponse::success(json!({"online": true})),
    )
    .await;
    assert!(
        pending
            .await
            .unwrap()
            .unwrap()
            .json::<MobileResponse>()
            .await
            .unwrap()
            .ok
    );
    let forged = fixture
        .post("/api/mobile/action")
        .header("cookie", &cookie)
        .json(&json!({"type": "status", "device": "forged"}))
        .send()
        .await
        .unwrap();
    assert_eq!(forged.status(), StatusCode::BAD_REQUEST);
    let arbitrary = fixture
        .post("/api/mobile/action")
        .header("cookie", &cookie)
        .json(&json!({"type": "desktop_rpc", "method": "exec"}))
        .send()
        .await
        .unwrap();
    assert_eq!(arbitrary.status(), StatusCode::BAD_REQUEST);
    let logout = fixture
        .post("/api/mobile/logout")
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert!(logout.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .contains("Max-Age=0"));
    fixture.stop().await;
}

#[tokio::test]
async fn missing_origin_cross_origin_json_and_desktop_paths_are_closed() {
    let fixture = Fixture::start().await;
    let client = Client::new();
    let missing = client
        .post(format!("{}/api/mobile/pair", fixture.origin))
        .json(&json!({"host": HOST, "code": KEY, "name": "phone"}))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::FORBIDDEN);
    // A naked client constructs a true single cross-origin request. The
    // fixture helper already adds trusted Origin; builder.header appends.
    let cross = client
        .post(format!("{}/api/mobile/action", fixture.origin))
        .header("origin", "https://evil.example")
        .json(&json!({"type":"status"}))
        .send()
        .await
        .unwrap();
    assert_eq!(cross.status(), StatusCode::FORBIDDEN);
    let nonjson = fixture
        .post("/api/mobile/logout")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(nonjson.status(), StatusCode::FORBIDDEN);
    let unauthenticated = fixture
        .post("/api/mobile/action")
        .json(&json!({"type":"status"}))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
    for path in [
        "/api/respond",
        "/api/remote-control/manage",
        "/api/mux/events",
        "/api/mobile/does-not-exist",
    ] {
        let response = client
            .get(format!("{}{path}", fixture.origin))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(!response.text().await.unwrap().contains("mobile fixture"));
    }
    let home = client.get(&fixture.origin).send().await.unwrap();
    assert_eq!(home.status(), StatusCode::OK);
    assert_eq!(home.headers()[header::X_FRAME_OPTIONS], "DENY");
    assert!(home.headers().contains_key(header::CONTENT_SECURITY_POLICY));
    assert!(home.text().await.unwrap().contains("mobile fixture"));
    fixture.stop().await;
}

#[tokio::test]
async fn duplicate_security_headers_reject_all_orders_before_cookie_or_host() {
    let fixture = Fixture::start().await;
    let client = Client::new();
    for (first, second) in [
        (fixture.origin.as_str(), "https://evil.example"),
        ("https://evil.example", fixture.origin.as_str()),
        (fixture.origin.as_str(), fixture.origin.as_str()),
    ] {
        let request = client
            .post(format!("{}/api/mobile/action", fixture.origin))
            .header(header::ORIGIN, first)
            .header(header::ORIGIN, second)
            .json(&json!({"type": "status"}))
            .build()
            .unwrap();
        assert_eq!(request.headers().get_all(header::ORIGIN).iter().count(), 2);
        let response = client.execute(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            response.json::<MobileResponse>().await.unwrap().error,
            Some(ErrorCode::Unauthorized)
        );
    }
    for (first, second) in [
        ("application/json", "text/plain"),
        ("text/plain", "application/json"),
        ("application/json", "application/json"),
    ] {
        let request = client
            .post(format!("{}/api/mobile/action", fixture.origin))
            .header(header::ORIGIN, &fixture.origin)
            .header(header::CONTENT_TYPE, first)
            .header(header::CONTENT_TYPE, second)
            .body("{\"type\":\"status\"}")
            .build()
            .unwrap();
        assert_eq!(
            request
                .headers()
                .get_all(header::CONTENT_TYPE)
                .iter()
                .count(),
            2
        );
        assert_eq!(
            client.execute(request).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
    fixture.stop().await;
}

#[tokio::test]
async fn unknown_offline_host_wrong_hello_and_browser_host_handshake_fail_closed() {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let fixture = Fixture::start().await;
    let offline = fixture
        .post("/api/mobile/pair")
        .json(&json!({"host": HOST, "code": KEY, "name": "phone"}))
        .send()
        .await
        .unwrap();
    assert_eq!(offline.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        offline.json::<MobileResponse>().await.unwrap().error,
        Some(ErrorCode::HostOffline)
    );
    let mut wrong = fixture.host(SECRET).await;
    let closed = tokio::time::timeout(Duration::from_secs(3), wrong.next())
        .await
        .unwrap();
    assert!(!matches!(closed, Some(Ok(WsMessage::Text(_)))));
    let mut request = format!(
        "{}/api/mobile/host",
        fixture.origin.replace("http://", "ws://")
    )
    .into_client_request()
    .unwrap();
    request
        .headers_mut()
        .insert("origin", fixture.origin.parse().unwrap());
    assert!(connect_async(request).await.is_err());
    fixture.stop().await;
}

#[tokio::test]
async fn duplicate_host_replaces_and_fences_old_connection_and_waiters() {
    let fixture = Fixture::start().await;
    let mut old = fixture.connected_host().await;
    let pending = tokio::spawn(
        fixture
            .post("/api/mobile/action")
            .header("cookie", cookie_fixture(&fixture.origin))
            .json(&json!({"type":"status"}))
            .send(),
    );
    let (_old_id, _) = next_request(&mut old).await;
    let mut replacement = fixture.connected_host().await;
    let interrupted = pending
        .await
        .unwrap()
        .unwrap()
        .json::<MobileResponse>()
        .await
        .unwrap();
    assert_eq!(interrupted.error, Some(ErrorCode::HostOffline));
    let closed = tokio::time::timeout(Duration::from_secs(3), old.next())
        .await
        .unwrap();
    assert!(!matches!(closed, Some(Ok(WsMessage::Text(_)))));
    let pending = tokio::spawn(
        fixture
            .post("/api/mobile/action")
            .header("cookie", cookie_fixture(&fixture.origin))
            .json(&json!({"type":"status"}))
            .send(),
    );
    let (id, _) = next_request(&mut replacement).await;
    respond(
        &mut replacement,
        id,
        MobileResponse::success(json!({"replacement":true})),
    )
    .await;
    assert!(
        pending
            .await
            .unwrap()
            .unwrap()
            .json::<MobileResponse>()
            .await
            .unwrap()
            .ok
    );
    fixture.stop().await;
}

#[tokio::test]
async fn host_disconnect_resolves_pending_without_retry() {
    let fixture = Fixture::start().await;
    let mut host = fixture.connected_host().await;
    let pending = tokio::spawn(
        fixture
            .post("/api/mobile/action")
            .header("cookie", cookie_fixture(&fixture.origin))
            .json(&json!({"type":"snapshot"}))
            .send(),
    );
    let (_, request) = next_request(&mut host).await;
    assert!(matches!(
        request,
        MobileRequest::Authenticated {
            action: MobileAction::Snapshot,
            ..
        }
    ));
    host.close(None).await.unwrap();
    let response = pending
        .await
        .unwrap()
        .unwrap()
        .json::<MobileResponse>()
        .await
        .unwrap();
    assert_eq!(response.error, Some(ErrorCode::HostOffline));
    let _replacement = fixture.connected_host().await;
    fixture.stop().await;
}

#[tokio::test]
async fn pending_capacity_and_cancel_guard_cleanup_are_exact() {
    let root = tempfile::tempdir().unwrap();
    let state = RelayState::new(
        test_config(
            root.path(),
            "127.0.0.1:1".parse().unwrap(),
            "http://127.0.0.1:1",
        ),
        CancellationToken::new(),
    );
    let (sender, mut receiver) = mpsc::channel(MAX_PENDING_REQUESTS);
    let connection = Arc::new(HostConnection {
        generation: 1,
        ready: AtomicBool::new(true),
        outgoing: sender,
        pending: Mutex::new(HashMap::new()),
        cancellation: CancellationToken::new(),
    });
    state
        .0
        .connections
        .lock()
        .unwrap()
        .insert(HOST.into(), connection.clone());
    let mut tasks = Vec::new();
    for _ in 0..MAX_PENDING_REQUESTS {
        let state = state.clone();
        tasks.push(tokio::spawn(async move {
            state
                .forward(
                    HOST,
                    MobileRequest::Pair {
                        code: Secret::try_from(KEY.to_owned()).unwrap(),
                        name: "phone".into(),
                    },
                )
                .await
        }));
        assert!(receiver.recv().await.is_some());
    }
    let response = state
        .forward(
            HOST,
            MobileRequest::Pair {
                code: Secret::try_from(KEY.to_owned()).unwrap(),
                name: "phone".into(),
            },
        )
        .await;
    assert_eq!(response.error, Some(ErrorCode::Capacity));
    assert_eq!(
        connection.pending.lock().unwrap().len(),
        MAX_PENDING_REQUESTS
    );
    for task in tasks {
        task.abort();
        let _ = task.await;
    }
    assert_eq!(connection.pending.lock().unwrap().len(), 0);
    state.shutdown();
    assert!(state.0.connections.lock().unwrap().is_empty());
}

#[tokio::test]
async fn mismatch_pair_result_does_not_set_cookie_or_echo_secret() {
    let fixture = Fixture::start().await;
    let mut host = fixture.connected_host().await;
    let pending = tokio::spawn(
        fixture
            .post("/api/mobile/pair")
            .json(&json!({"host":HOST,"code":KEY,"name":"phone"}))
            .send(),
    );
    let (id, _) = next_request(&mut host).await;
    respond(
        &mut host,
        id,
        MobileResponse::success(json!({"host":"other-host","device":"device-1","secret":SECRET})),
    )
    .await;
    let response = pending.await.unwrap().unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert!(!response.headers().contains_key(header::SET_COOKIE));
    assert!(!response.text().await.unwrap().contains(SECRET));
    fixture.stop().await;
}

#[tokio::test]
async fn oversized_http_request_is_rejected_before_forwarding() {
    let fixture = Fixture::start().await;
    let response = fixture
        .post("/api/mobile/pair")
        .header("content-type", "application/json")
        .body(" ".repeat(MAX_FRAME_BYTES + 1))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    fixture.stop().await;
}

#[test]
fn credentials_are_redacted_and_cookie_never_contains_url_credentials() {
    assert!(!format!("{:?}", Secret::try_from(KEY.to_owned()).unwrap()).contains(KEY));
    let cookie = cookie_fixture("http://127.0.0.1:31368");
    assert!(!cookie.contains(KEY));
    assert!(!cookie.contains(SECRET));
    let _closed_protocol_example: Value = json!({"type":"status"});
}

#[tokio::test]
async fn public_https_pair_uses_secure_host_cookie_and_hsts() {
    let fixture = Fixture::start_with_origin(Some("https://mobile.example")).await;
    let mut host = fixture.connected_host().await;
    let pending = tokio::spawn(
        fixture
            .post("/api/mobile/pair")
            .json(&json!({"host":HOST,"code":KEY,"name":"phone"}))
            .send(),
    );
    let (id, _) = next_request(&mut host).await;
    respond(
        &mut host,
        id,
        MobileResponse::success(json!({"host":HOST,"device":"device-1","secret":SECRET})),
    )
    .await;
    let response = pending.await.unwrap().unwrap();
    let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap();
    assert!(cookie.starts_with("__Host-xharness_mobile="));
    assert!(cookie.contains("; Secure"));
    assert!(cookie.contains("; Path=/"));
    assert!(!cookie.contains("Domain="));
    assert!(response
        .headers()
        .contains_key(header::STRICT_TRANSPORT_SECURITY));
    fixture.stop().await;
}

#[tokio::test]
async fn malformed_host_second_hello_closes_owner_and_waiters() {
    let fixture = Fixture::start().await;
    let mut host = fixture.connected_host().await;
    let pending = tokio::spawn(
        fixture
            .post("/api/mobile/action")
            .header("cookie", cookie_fixture(&fixture.origin))
            .json(&json!({"type":"status"}))
            .send(),
    );
    let (_, _) = next_request(&mut host).await;
    host.send(WsMessage::Text(
        serde_json::to_string(&HostFrame::Hello {
            host: HOST.into(),
            key: Secret::try_from(KEY.to_owned()).unwrap(),
        })
        .unwrap()
        .into(),
    ))
    .await
    .unwrap();
    let response = pending
        .await
        .unwrap()
        .unwrap()
        .json::<MobileResponse>()
        .await
        .unwrap();
    assert_eq!(response.error, Some(ErrorCode::HostOffline));
    fixture.stop().await;
}

#[tokio::test]
async fn health_counts_only_authenticated_ready_owners_without_identity() {
    let fixture = Fixture::start().await;
    let before = Client::new()
        .get(format!("{}/healthz", fixture.origin))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(before, json!({"ok": true, "connected_hosts": 0}));
    let mut wrong = fixture.host(SECRET).await;
    let _ = tokio::time::timeout(Duration::from_secs(3), wrong.next())
        .await
        .unwrap();
    let rejected = Client::new()
        .get(format!("{}/healthz", fixture.origin))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(rejected["connected_hosts"], 0);
    let _host = fixture.connected_host().await;
    let connected = Client::new()
        .get(format!("{}/healthz", fixture.origin))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(connected, json!({"ok": true, "connected_hosts": 1}));
    assert!(!connected.to_string().contains(HOST));
    assert!(!connected.to_string().contains(KEY));
    fixture.stop().await;
}

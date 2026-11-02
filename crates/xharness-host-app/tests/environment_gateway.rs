//! Real Unix HTTP/WebSocket carrier tests; no model/OS credential or production Host.
#![cfg(unix)]
use async_trait::async_trait;
use axum::{http::StatusCode, routing::post, Router};
use futures::{stream, StreamExt};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};
use tokio_util::sync::CancellationToken;
use xharness_api::*;
use xharness_debug::DebugRecorder;
use xharness_host_app::environment_gateway::{EnvironmentGateway, GatewayConfig};
use xharness_server::{serve, web_router_full, StartupReadiness};
const GATEWAY: &str = "gateway-fixture-only-0000000000000000";
const HOST: &str = "upstream-fixture-only-000000000000000";
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        static N: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "xh-env-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn private(&self, name: &str, text: &str) -> PathBuf {
        let p = self.0.join(name);
        std::fs::write(&p, text).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        p
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct Peer {
    name: &'static str,
    calls: AtomicUsize,
}
#[async_trait]
impl ApiBackend for Peer {
    async fn call(
        &self,
        _: RpcId,
        _: RpcMethod,
        payload: Value,
        _: CancellationToken,
    ) -> RpcResult {
        self.calls.fetch_add(1, Ordering::SeqCst);
        RpcResult::success(json!({"peer":self.name,"echo":payload}))
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        RpcReceipt::Accepted
    }
    fn mux_events(&self) -> EventStream {
        Box::pin(
            stream::iter([ServerRequest {
                rpc_id: RpcId::new(self.name),
                payload: json!({"peer":self.name}),
                kind: ServerRequestKind::ServerRequest,
                method: "events.mux".into(),
            }])
            .chain(stream::pending()),
        )
    }
    fn host_events(&self) -> EventStream {
        self.mux_events()
    }
    async fn export_session(
        &self,
        _: &str,
        _: CancellationToken,
    ) -> Result<SessionExport, RpcError> {
        Ok(SessionExport::json(
            "native.json",
            self.name.as_bytes().to_vec(),
        ))
    }
}
struct Host {
    address: std::net::SocketAddr,
    task: JoinHandle<std::io::Result<()>>,
    stop: CancellationToken,
    peer: Arc<Peer>,
}
impl Host {
    async fn start(name: &'static str) -> Self {
        let peer = Arc::new(Peer {
            name,
            calls: AtomicUsize::new(0),
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let stop = CancellationToken::new();
        let extension = Router::new().route(
            "/api/uncertain",
            post(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
        );
        let router = web_router_full(
            peer.clone(),
            None,
            DebugRecorder::disabled(),
            Some(HOST.into()),
            StartupReadiness::ready(),
            extension,
        );
        let task = tokio::spawn(serve(listener, router, stop.clone().cancelled_owned()));
        Self {
            address,
            task,
            stop,
            peer,
        }
    }
    async fn stop(self) {
        self.stop.cancel();
        self.task.abort();
        let joined = self.task.await;
        assert!(matches!(joined, Ok(Ok(()))) || matches!(joined, Err(ref e) if e.is_cancelled()));
    }
}
async fn free() -> std::net::SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    l.local_addr().unwrap()
}
fn configuration(
    d: &Directory,
    local: &Host,
    cloud: &Host,
    a: std::net::SocketAddr,
    b: std::net::SocketAddr,
) -> Value {
    let launch = d.private("gateway.secret", GATEWAY);
    let host = d.private("host.secret", HOST);
    json!({"version":1,"launchTokenFile":launch,"environments":[
 {"id":"local","label":"Local","kind":"local","listen":a.to_string(),"upstream":format!("http://{}/",local.address),"tokenFile":host},
 {"id":"cloud","label":"Cloud","kind":"cloud","listen":b.to_string(),"upstream":format!("http://{}/",cloud.address),"tokenFile":host}]})
}
#[tokio::test]
async fn separate_origins_route_real_http_events_and_exports_without_fallback_or_secret_leaks() {
    let d = Directory::new();
    std::fs::write(d.0.join("index.html"), "fixture-assets").unwrap();
    let local = Host::start("local-peer").await;
    let cloud = Host::start("cloud-peer").await;
    let a = free().await;
    let b = free().await;
    let config: GatewayConfig =
        serde_json::from_value(configuration(&d, &local, &cloud, a, b)).unwrap();
    let gateway = EnvironmentGateway::start(config, d.0.clone())
        .await
        .unwrap();
    let http = reqwest::Client::builder().no_proxy().build().unwrap();
    assert_eq!(
        http.get(format!("http://{a}/api/environments"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let no_redirect = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let bootstrap = no_redirect
        .get(format!("http://{a}/environment/bootstrap?token={GATEWAY}"))
        .send()
        .await
        .unwrap();
    assert_eq!(bootstrap.status(), 303);
    let rebinding = no_redirect
        .get(format!("http://{a}/environment/bootstrap?token={GATEWAY}"))
        .header("host", "other.invalid")
        .send()
        .await
        .unwrap();
    assert_eq!(rebinding.status(), 403);
    assert!(rebinding.headers().get("set-cookie").is_none());
    let cookie = bootstrap.headers()["set-cookie"].to_str().unwrap();
    assert!(cookie.starts_with("xharness_environment="));
    assert!(cookie.contains("HttpOnly; SameSite=Strict"));
    assert!(!cookie.contains("xharness_desktop="));
    assert_eq!(bootstrap.headers()["referrer-policy"], "no-referrer");
    assert_eq!(
        http.get(format!("http://{b}/"))
            .header("cookie", format!("xharness_environment={GATEWAY}"))
            .header("sec-fetch-site", "same-site")
            .header("sec-fetch-mode", "navigate")
            .header("sec-fetch-dest", "document")
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        http.get(format!("http://{b}/api/environments"))
            .header("cookie", format!("xharness_environment={GATEWAY}"))
            .header("sec-fetch-site", "same-site")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let catalog = http
        .get(format!("http://{b}/api/environments"))
        .header("x-xharness-environment-token", GATEWAY)
        .send()
        .await
        .unwrap();
    assert_eq!(catalog.status(), 200);
    let text = catalog.text().await.unwrap();
    assert!(!text.contains(HOST));
    assert!(!text.contains(GATEWAY));
    assert!(!text.contains("tokenFile"));
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["current"], "cloud");
    assert_eq!(value["workspaceSync"], false);
    assert_eq!(value["sessionMigration"], false);
    for (address, name) in [(a, "local-peer"), (b, "cloud-peer")] {
        let body = json!({"type":"client-request","rpcId":"same-original-identity","method":"host.describe","payload":{"marker":"unchanged"}});
        let response = http
            .post(format!("http://{address}/api/host.describe"))
            .header("x-xharness-environment-token", GATEWAY)
            .header("cookie", "xharness_desktop=must-not-forward")
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let wire: Value = response.json().await.unwrap();
        assert_eq!(wire["rpcId"], "same-original-identity");
        assert_eq!(wire["result"]["value"]["peer"], name);
        assert_eq!(wire["result"]["value"]["echo"]["marker"], "unchanged");
        for stream in ["mux", "host"] {
            let mut request = format!("ws://{address}/api/events.{stream}")
                .into_client_request()
                .unwrap();
            request
                .headers_mut()
                .insert("x-xharness-environment-token", GATEWAY.parse().unwrap());
            let (mut socket, _) = connect_async(request).await.unwrap();
            let message = tokio::time::timeout(std::time::Duration::from_secs(2), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let Message::Text(text) = message else {
                panic!("expected downlink")
            };
            assert!(text.contains(name));
            socket.close(None).await.unwrap();
        }
    }
    assert_eq!(local.peer.calls.load(Ordering::SeqCst), 1);
    assert_eq!(cloud.peer.calls.load(Ordering::SeqCst), 1);
    let export = http
        .get(format!("http://{b}/api/session.export?sessionId=s"))
        .header("x-xharness-environment-token", GATEWAY)
        .send()
        .await
        .unwrap();
    assert_eq!(export.status(), 200);
    assert!(export.headers().get("content-disposition").is_some());
    assert_eq!(export.text().await.unwrap(), "cloud-peer");
    // Malformed/cross-origin attempts never reach either upstream.
    for header in ["http://evil.invalid", &format!("http://{a}")] {
        assert_eq!(
            http.get(format!("http://{b}/api/environments"))
                .header("x-xharness-environment-token", GATEWAY)
                .header("origin", header)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
    }
    let status = http
        .post(format!("http://{b}/api/uncertain"))
        .header("x-xharness-environment-token", GATEWAY)
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 500);
    cloud.stop().await;
    let failed = http
        .post(format!("http://{b}/api/session.prompt"))
        .header("x-xharness-environment-token", GATEWAY)
        .json(&json!({"rpcId":"uncertain-original"}))
        .send()
        .await
        .unwrap();
    assert_eq!(failed.status(), 502);
    let value: Value = failed.json().await.unwrap();
    assert_eq!(value["error"]["retried"], false);
    assert_eq!(value["error"]["outcome"], "unknown");
    assert_eq!(local.peer.calls.load(Ordering::SeqCst), 1);
    gateway.shutdown().await.unwrap();
    local.stop().await;
}
#[tokio::test]
async fn config_rejects_public_urls_duplicates_secrets_permissions_and_partial_startup() {
    let d = Directory::new();
    let local = Host::start("local").await;
    let cloud = Host::start("cloud").await;
    let a = free().await;
    let b = free().await;
    let base = configuration(&d, &local, &cloud, a, b);
    for bad in [
        "https://example.com/",
        "http://localhost:3080/",
        "http://user:secret@127.0.0.1:3080/",
        "http://127.0.0.1:3080/secret",
        "http://127.0.0.1:3080/?token=secret",
        "http://127.0.0.1:3080/#secret",
    ] {
        let mut v = base.clone();
        v["environments"][1]["upstream"] = json!(bad);
        assert!(serde_json::from_value::<GatewayConfig>(v)
            .map(|c| c.validate().is_err())
            .unwrap_or(true));
    }
    for (field, value) in [
        ("listen", json!(a.to_string())),
        ("id", json!("local")),
        ("tokenFile", json!("relative")),
        ("label", json!("\nsecret")),
    ] {
        let mut v = base.clone();
        v["environments"][1][field] = value;
        assert!(serde_json::from_value::<GatewayConfig>(v)
            .unwrap()
            .validate()
            .is_err());
    }
    let oversized = d.private("oversized.json", &" ".repeat(64 * 1024 + 1));
    assert!(GatewayConfig::read(&oversized).is_err());
    let private = d.private("config.json", &base.to_string());
    assert!(GatewayConfig::read(&private).is_ok());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(GatewayConfig::read(&private).is_err());
    }
    std::fs::write(d.0.join("index.html"), "assets").unwrap();
    let held = TcpListener::bind(b).await.unwrap();
    assert!(
        EnvironmentGateway::start(serde_json::from_value(base).unwrap(), d.0.clone())
            .await
            .is_err()
    );
    assert!(
        TcpListener::bind(a).await.is_ok(),
        "first listener must be released on partial startup failure"
    );
    drop(held);
    local.stop().await;
    cloud.stop().await;
}

#[tokio::test]
async fn identity_mismatch_is_not_permission_to_send_a_bearer_or_rpc() {
    let d = Directory::new();
    std::fs::write(d.0.join("index.html"), "assets").unwrap();
    let local = Host::start("local").await;
    let cloud = Host::start("cloud").await;
    let a = free().await;
    let b = free().await;
    let config = configuration(&d, &local, &cloud, a, b);
    d.private("host.secret", "wrong-upstream-credential-00000000000000");
    let gateway = EnvironmentGateway::start(serde_json::from_value(config).unwrap(), d.0.clone())
        .await
        .unwrap();
    let response=reqwest::Client::new().post(format!("http://{b}/api/host.describe")).header("x-xharness-environment-token",GATEWAY)
     .json(&json!({"type":"client-request","rpcId":"no-dispatch","method":"host.describe","payload":{}})).send().await.unwrap();
    assert_eq!(response.status(), 502);
    let failure: Value = response.json().await.unwrap();
    assert_eq!(failure["error"]["stage"], "identity_mismatch");
    assert_eq!(local.peer.calls.load(Ordering::SeqCst), 0);
    assert_eq!(cloud.peer.calls.load(Ordering::SeqCst), 0);
    gateway.shutdown().await.unwrap();
    local.stop().await;
    cloud.stop().await;
}

#[tokio::test]
async fn carrier_shutdown_closes_live_downlinks_but_never_stops_their_hosts() {
    let d = Directory::new();
    std::fs::write(d.0.join("index.html"), "assets").unwrap();
    let local = Host::start("local").await;
    let cloud = Host::start("cloud").await;
    let a = free().await;
    let b = free().await;
    let gateway = EnvironmentGateway::start(
        serde_json::from_value(configuration(&d, &local, &cloud, a, b)).unwrap(),
        d.0.clone(),
    )
    .await
    .unwrap();
    let mut request = format!("ws://{b}/api/events.mux")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("x-xharness-environment-token", GATEWAY.parse().unwrap());
    let (mut socket, _) = connect_async(request).await.unwrap();
    assert!(matches!(socket.next().await, Some(Ok(Message::Text(_)))));
    tokio::time::timeout(std::time::Duration::from_secs(3), gateway.shutdown())
        .await
        .unwrap()
        .unwrap();
    let closed = tokio::time::timeout(std::time::Duration::from_secs(2), socket.next())
        .await
        .unwrap();
    assert!(matches!(closed, Some(Ok(Message::Close(_))) | None));
    for address in [local.address, cloud.address] {
        assert_eq!(
            reqwest::get(format!("http://{address}/health/ready"))
                .await
                .unwrap()
                .status(),
            200
        );
    }
    assert_eq!(local.peer.calls.load(Ordering::SeqCst), 0);
    assert_eq!(cloud.peer.calls.load(Ordering::SeqCst), 0);
    local.stop().await;
    cloud.stop().await;
}

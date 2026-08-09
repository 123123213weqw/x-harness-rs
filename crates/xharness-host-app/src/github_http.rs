//! Credential acquisition is local and once per RPC; HTTP connections are pooled
//! across RPCs. Secrets never enter Debug, logs, RPC, model context or disk here.
use crate::github_service::{bounded_read_limit, failure, invalid, GitHubReader};
use async_trait::async_trait;
use reqwest::{header::HeaderValue, Client, Url};
use serde_json::Value;
use std::{process::Stdio, sync::Arc, time::Duration};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use xharness_api::RpcError;
const MAX_BYTES: usize = 4 * 1024 * 1024;

#[async_trait]
trait Credentials: Send + Sync {
    async fn token(
        &self,
        account: Option<&str>,
        cancel: CancellationToken,
    ) -> Result<HeaderValue, RpcError>;
}
struct GhCredentials;
fn valid_account(account: &str) -> bool {
    !account.is_empty()
        && account.len() <= 100
        && account
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
fn bearer(bytes: &[u8]) -> Result<HeaderValue, RpcError> {
    let text = std::str::from_utf8(bytes).map_err(|_| invalid())?.trim();
    if text.is_empty() || text.len() > 4096 || !text.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(failure(
            "authentication",
            "GitHub credential is invalid; reconnect",
        ));
    }
    let mut header = HeaderValue::from_str(&format!("Bearer {text}")).map_err(|_| invalid())?;
    header.set_sensitive(true);
    Ok(header)
}
#[async_trait]
impl Credentials for GhCredentials {
    async fn token(
        &self,
        account: Option<&str>,
        cancel: CancellationToken,
    ) -> Result<HeaderValue, RpcError> {
        if cancel.is_cancelled() {
            return Err(failure("cancelled", "GitHub request cancelled"));
        }
        if account.is_some_and(|a| !valid_account(a)) {
            return Err(failure("authentication", "Invalid GitHub account"));
        }
        #[cfg(target_os = "macos")]
        let executable = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]
            .into_iter()
            .find(|p| std::path::Path::new(p).is_file())
            .unwrap_or("gh");
        #[cfg(not(target_os = "macos"))]
        let executable = "gh";
        let mut command = Command::new(executable);
        command.args(["auth", "token", "--hostname", "github.com"]);
        if let Some(account) = account {
            command.args(["--user", account]);
        }
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let mut child = command
            .env("GH_PROMPT_DISABLED", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    failure(
                        "missing_cli",
                        "Install GitHub CLI on the Host computer, then run gh auth login",
                    )
                } else {
                    failure("transport", "Could not read GitHub credentials")
                }
            })?;
        let stdout = child.stdout.take().ok_or_else(invalid)?;
        let stderr = child.stderr.take().ok_or_else(invalid)?;
        let run = async {
            let (status, token, _diagnostics) = tokio::try_join!(
                async {
                    child
                        .wait()
                        .await
                        .map_err(|_| failure("transport", "Credential helper failed"))
                },
                bounded_read_limit(stdout, 4096),
                bounded_read_limit(stderr, 16384)
            )?;
            if !status.success() {
                return Err(failure(
                    "authentication",
                    "GitHub credential unavailable; run gh auth login or reconnect",
                ));
            }
            bearer(&token)
        };
        let result = tokio::select! {
            _ = cancel.cancelled() => Err(failure("cancelled", "GitHub request cancelled")),
            value = tokio::time::timeout(Duration::from_secs(10), run) => value.unwrap_or_else(|_| Err(failure("timeout", "GitHub credential helper timed out"))),
        };
        if result.is_err() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        result
    }
}

pub(super) struct GhHttpReader {
    client: Result<Client, ()>,
    credentials: Arc<dyn Credentials>,
    origin: Url,
}
impl Default for GhHttpReader {
    fn default() -> Self {
        Self {
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(35))
                .pool_max_idle_per_host(4)
                .user_agent("XHarness-CodeReview")
                .build()
                .map_err(|_| ()),
            credentials: Arc::new(GhCredentials),
            origin: Url::parse("https://api.github.com/").expect("constant GitHub URL"),
        }
    }
}
fn route_url(origin: &Url, route: &str) -> Result<Url, RpcError> {
    if !route.starts_with('/') || route.starts_with("//") || route.contains(['\\', '#', '\r', '\n'])
    {
        return Err(invalid());
    }
    let url = origin.join(route).map_err(|_| invalid())?;
    if url.origin() != origin.origin() || !url.username().is_empty() || url.password().is_some() {
        return Err(invalid());
    }
    Ok(url)
}
async fn http_value(
    client: &Client,
    url: Url,
    token: &HeaderValue,
    cancel: CancellationToken,
    body: Option<Value>,
) -> Result<Value, RpcError> {
    if cancel.is_cancelled() {
        return Err(failure("cancelled", "GitHub request cancelled"));
    }
    let run = async {
        let request = if let Some(body) = body {
            client.post(url).json(&body)
        } else {
            client.get(url)
        };
        let mut response = request
            .header(reqwest::header::AUTHORIZATION, token.clone())
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    failure("timeout", "GitHub request timed out")
                } else {
                    failure("transport", "GitHub network request failed")
                }
            })?;
        let status = response.status();
        if !status.is_success() {
            // Do not parse/log remote error bodies or request headers.
            return Err(match status.as_u16() {
                401 => failure(
                    "authentication",
                    "GitHub credential expired or invalid; reconnect",
                ),
                403 if response
                    .headers()
                    .get("x-ratelimit-remaining")
                    .is_some_and(|v| v == "0")
                    || response.headers().contains_key("retry-after") =>
                {
                    failure("rate_limit", "GitHub rate limit reached; retry later")
                }
                403 => failure("permission", "GitHub access denied for this account"),
                404 => failure(
                    "not_found",
                    "Repository or pull request is missing or inaccessible",
                ),
                429 => failure("rate_limit", "GitHub rate limit reached; retry later"),
                _ => failure("transport", "GitHub returned an unsuccessful response"),
            });
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_BYTES as u64)
        {
            return Err(failure(
                "response_too_large",
                "GitHub response exceeded 4 MiB",
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| {
            if e.is_timeout() {
                failure("timeout", "GitHub response timed out")
            } else {
                failure("transport", "GitHub response interrupted")
            }
        })? {
            if chunk.len() > MAX_BYTES - bytes.len() {
                return Err(failure(
                    "response_too_large",
                    "GitHub response exceeded 4 MiB",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| invalid())
    };
    tokio::select! { _ = cancel.cancelled() => Err(failure("cancelled", "GitHub request cancelled")), value = run => value }
}
async fn http_json(
    client: &Client,
    url: Url,
    token: &HeaderValue,
    cancel: CancellationToken,
) -> Result<Value, RpcError> {
    http_value(client, url, token, cancel, None).await
}
fn log_destination(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.host_str().is_some_and(|h| {
            h.ends_with(".blob.core.windows.net")
                || h == "results-receiver.actions.githubusercontent.com"
                || h == "productionresultssa0.blob.core.windows.net"
        })
}
fn public_address(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v) => {
            !(v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_multicast()
                || v.is_broadcast()
                || v.octets()[0] == 0
                || v.octets()[0] >= 240)
        }
        std::net::IpAddr::V6(v) => v
            .to_ipv4_mapped()
            .map(|v| public_address(v.into()))
            .unwrap_or_else(|| {
                !v.is_loopback()
                    && !v.is_unspecified()
                    && !v.is_multicast()
                    && (v.segments()[0] & 0xfe00) != 0xfc00
                    && (v.segments()[0] & 0xffc0) != 0xfe80
            }),
    }
}
async fn http_logs(
    session: &HttpSession,
    route: &str,
    cancel: CancellationToken,
) -> Result<Value, RpcError> {
    let work = async {
        let response = session
            .client
            .get(route_url(&session.origin, route)?)
            .header(reqwest::header::AUTHORIZATION, session.token.clone())
            .send()
            .await
            .map_err(|_| failure("transport", "GitHub log request failed"))?;
        if response.status() != reqwest::StatusCode::FOUND {
            return Err(failure(
                "logs_unavailable",
                "Job logs are not available or access was denied",
            ));
        }
        let destination = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| Url::parse(v).ok())
            .filter(log_destination)
            .ok_or_else(|| failure("logs_unavailable", "GitHub log destination is unsupported"))?;
        let host = destination.host_str().ok_or_else(invalid)?;
        let addresses: Vec<_> = tokio::net::lookup_host((host, 443))
            .await
            .map_err(|_| failure("transport", "Log host resolution failed"))?
            .collect();
        if addresses.is_empty() || addresses.iter().any(|a| !public_address(a.ip())) {
            return Err(failure("logs_unavailable", "Log destination is not public"));
        }
        // Pin the vetted DNS result and never send GitHub Authorization to a second host.
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .resolve_to_addrs(host, &addresses)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(45))
            .build()
            .map_err(|_| invalid())?;
        let mut response = client
            .get(destination)
            .send()
            .await
            .map_err(|_| failure("transport", "Job log download failed"))?;
        if !response.status().is_success() {
            return Err(failure(
                "logs_unavailable",
                "Job log download expired or failed",
            ));
        }
        const LIMIT: usize = 2 * 1024 * 1024;
        let mut bytes = Vec::new();
        let mut truncated = false;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| failure("transport", "Job log stream interrupted"))?
        {
            let room = LIMIT - bytes.len();
            if chunk.len() > room {
                bytes.extend_from_slice(&chunk[..room]);
                truncated = true;
                break;
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(serde_json::json!({"text":String::from_utf8_lossy(&bytes),"truncated":truncated}))
    };
    tokio::select! {_=cancel.cancelled()=>Err(failure("cancelled","Log request cancelled")), r=tokio::time::timeout(Duration::from_secs(60),work)=>r.unwrap_or_else(|_|Err(failure("timeout","Job log request timed out")))}
}
struct HttpSession {
    client: Client,
    origin: Url,
    token: HeaderValue,
    user: Value,
}
#[async_trait]
impl GitHubReader for HttpSession {
    async fn graphql(
        &self,
        query: &str,
        variables: Value,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        http_value(
            &self.client,
            route_url(&self.origin, "/graphql")?,
            &self.token,
            cancel,
            Some(serde_json::json!({"query":query,"variables":variables})),
        )
        .await
    }
    async fn logs(&self, route: &str, cancel: CancellationToken) -> Result<Value, RpcError> {
        http_logs(self, route, cancel).await
    }
    async fn get(&self, route: &str, cancel: CancellationToken) -> Result<Value, RpcError> {
        if cancel.is_cancelled() {
            return Err(failure("cancelled", "GitHub request cancelled"));
        }
        // Identity was verified with these immutable credentials at session start.
        if route == "/user" {
            return Ok(self.user.clone());
        }
        http_json(
            &self.client,
            route_url(&self.origin, route)?,
            &self.token,
            cancel,
        )
        .await
    }
}
#[async_trait]
impl GitHubReader for GhHttpReader {
    async fn session(
        &self,
        account: Option<&str>,
        cancel: CancellationToken,
    ) -> Result<Option<Arc<dyn GitHubReader>>, RpcError> {
        let client = self
            .client
            .as_ref()
            .map_err(|_| failure("transport", "Could not initialize GitHub HTTP client"))?;
        let token = self.credentials.token(account, cancel.clone()).await?;
        let user = http_json(client, route_url(&self.origin, "/user")?, &token, cancel).await?;
        let login = user
            .get("login")
            .and_then(Value::as_str)
            .filter(|v| valid_account(v))
            .ok_or_else(invalid)?;
        if account.is_some_and(|a| a != login) {
            return Err(failure(
                "account_changed",
                "GitHub credentials do not match the selected account; reconnect",
            ));
        }
        Ok(Some(Arc::new(HttpSession {
            client: client.clone(),
            origin: self.origin.clone(),
            token,
            user: serde_json::json!({"login":login}),
        })))
    }
    async fn get(&self, route: &str, cancel: CancellationToken) -> Result<Value, RpcError> {
        self.session(None, cancel.clone())
            .await?
            .ok_or_else(invalid)?
            .get(route, cancel)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    use xharness_host::GitHubBackend;
    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    struct TestCredentials {
        calls: AtomicUsize,
        selected: std::sync::Mutex<Vec<Option<String>>>,
    }
    #[async_trait]
    impl Credentials for TestCredentials {
        async fn token(
            &self,
            account: Option<&str>,
            _: CancellationToken,
        ) -> Result<HeaderValue, RpcError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.selected
                .lock()
                .unwrap()
                .push(account.map(str::to_owned));
            bearer(b"test-only-secret")
        }
    }
    fn creds() -> Arc<TestCredentials> {
        Arc::new(TestCredentials {
            calls: AtomicUsize::new(0),
            selected: std::sync::Mutex::new(Vec::new()),
        })
    }
    struct Server {
        origin: Url,
        task: tokio::task::JoinHandle<()>,
        requests: Arc<std::sync::Mutex<Vec<String>>>,
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    async fn server(reply: fn(&str) -> String) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = requests.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let seen = seen.clone();
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut buf = [0u8; 2048];
                    loop {
                        let n = socket.read(&mut buf).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        raw.extend_from_slice(&buf[..n]);
                        if raw.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                        assert!(raw.len() < 16384);
                    }
                    let request = String::from_utf8(raw).unwrap();
                    let route = request.split_whitespace().nth(1).unwrap();
                    assert!(request
                        .to_lowercase()
                        .contains("authorization: bearer test-only-secret"));
                    seen.lock().unwrap().push(route.to_owned());
                    let _ = socket.write_all(reply(route).as_bytes()).await;
                });
            }
        });
        Server {
            origin,
            task,
            requests,
        }
    }
    fn response(status: &str, headers: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n{body}",
            body.len()
        )
    }
    fn fixture(route: &str) -> String {
        let body = if route == "/user" {
            serde_json::json!({"login":"alice"})
        } else if route.contains("/check-runs?") {
            serde_json::json!({"total_count":0,"check_runs":[]})
        } else if route.contains("/status?") {
            serde_json::json!({"sha":SHA,"total_count":0,"statuses":[]})
        } else if route == "/repos/alice/project/pulls/7" {
            serde_json::json!({"number":7,"title":"HTTP PR","body":"body","user":{"login":"alice"},"updated_at":"2026-10-04T00:00:00Z","state":"open","draft":false,"head":{"ref":"topic","sha":SHA},"base":{"ref":"main","sha":SHA},"additions":1,"deletions":0,"changed_files":0,"mergeable":null,"mergeable_state":"unknown","comments":0,"review_comments":0})
        } else {
            serde_json::json!([])
        };
        response(
            "200 OK",
            "Content-Type: application/json\r\n",
            &body.to_string(),
        )
    }
    fn reader(server: &Server, credentials: Arc<dyn Credentials>) -> GhHttpReader {
        GhHttpReader {
            client: Ok(Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_millis(500))
                .no_proxy()
                .build()
                .unwrap()),
            credentials,
            origin: server.origin.clone(),
        }
    }
    #[test]
    fn credentials_are_sensitive_and_routes_cannot_redirect_authority() {
        let token = bearer(b"test-only-secret\n").unwrap();
        assert!(token.is_sensitive());
        assert!(!format!("{token:?}").contains("test-only-secret"));
        for v in [b"".as_slice(), b"hello\nsecret", b"abc def", b"\xff"] {
            assert!(bearer(v).is_err());
        }
        let base = Url::parse("https://api.github.com/").unwrap();
        for route in [
            "https://evil.test",
            "//evil.test/user",
            "/\\evil.test",
            "/user#secret",
            "/user\r\nx:y",
        ] {
            assert!(route_url(&base, route).is_err());
        }
        assert_eq!(
            route_url(&base, "/repos/alice/project/pulls?per_page=50")
                .unwrap()
                .host_str(),
            Some("api.github.com")
        );
    }
    #[tokio::test]
    async fn real_http_detail_resolves_credentials_once_and_checks_user_once() {
        let server = server(fixture).await;
        let credentials = creds();
        let service = crate::github_service::NativeGitHub::new(Arc::new(reader(
            &server,
            credentials.clone(),
        )));
        let detail = service.read("github/detail",&serde_json::json!({"args":{"account":"alice","repository":"alice/project","number":7}}),CancellationToken::new()).await.unwrap();
        assert_eq!(detail["headSha"], SHA);
        assert_eq!(credentials.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            credentials.selected.lock().unwrap().as_slice(),
            &[Some("alice".into())]
        );
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.iter().filter(|r| r.as_str() == "/user").count(), 1);
        assert_eq!(requests.len(), 8);
    }
    #[tokio::test]
    async fn pinned_session_reuses_identity_and_reconnect_reloads_credentials() {
        let server = server(fixture).await;
        let credentials = creds();
        let reader = reader(&server, credentials.clone());
        let session = reader
            .session(Some("alice"), CancellationToken::new())
            .await
            .unwrap()
            .unwrap();
        for _ in 0..4 {
            assert_eq!(
                session
                    .get("/user", CancellationToken::new())
                    .await
                    .unwrap()["login"],
                "alice"
            );
        }
        assert_eq!(server.requests.lock().unwrap().len(), 1);
        assert!(reader
            .session(Some("bob"), CancellationToken::new())
            .await
            .is_err());
        assert_eq!(
            session
                .get("/user", CancellationToken::new())
                .await
                .unwrap()["login"],
            "alice"
        );
        reader
            .session(None, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(credentials.calls.load(Ordering::SeqCst), 3);
    }
    #[tokio::test]
    async fn errors_redirects_and_rate_limits_never_expose_remote_secret_body() {
        fn errors(route: &str) -> String {
            match route {
                "/user" => fixture(route),
                "/unauthorized" => response("401 Unauthorized", "", "secret credential"),
                "/forbidden" => response("403 Forbidden", "", "secret credential"),
                "/rate" => response(
                    "403 Forbidden",
                    "X-RateLimit-Remaining: 0\r\n",
                    "secret credential",
                ),
                "/retry" => response(
                    "429 Too Many Requests",
                    "Retry-After: 1\r\n",
                    "secret credential",
                ),
                "/missing" => response("404 Not Found", "", "secret credential"),
                "/redirect" => response(
                    "302 Found",
                    "Location: https://evil.test/\r\n",
                    "secret credential",
                ),
                "/chunked" => {
                    let body = "x".repeat(MAX_BYTES + 1);
                    format!("HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",body.len(),body)
                }
                "/large" => {
                    "HTTP/1.1 200 OK\r\nContent-Length: 4194305\r\nConnection: close\r\n\r\n".into()
                }
                _ => response("200 OK", "", "not JSON secret credential"),
            }
        }
        let server = server(errors).await;
        let session = reader(&server, creds())
            .session(None, CancellationToken::new())
            .await
            .unwrap()
            .unwrap();
        for (route, kind) in [
            ("/unauthorized", "authentication"),
            ("/forbidden", "permission"),
            ("/rate", "rate_limit"),
            ("/retry", "rate_limit"),
            ("/missing", "not_found"),
            ("/redirect", "transport"),
            ("/large", "response_too_large"),
            ("/chunked", "response_too_large"),
            ("/invalid", "invalid_response"),
        ] {
            let error = session
                .get(route, CancellationToken::new())
                .await
                .unwrap_err();
            assert_eq!(error.details["kind"], kind);
            assert!(!error.message.contains("secret"));
        }
        assert_eq!(server.requests.lock().unwrap().len(), 10);
    }
    #[tokio::test]
    async fn cancellation_and_partial_body_timeout_release_http_read() {
        fn stall(route: &str) -> String {
            if route == "/user" {
                fixture(route)
            } else {
                "HTTP/1.1 200 OK\r\nContent-Length: 200\r\n\r\n{".into()
            }
        }
        // Keep a partial response open instead of silently completing its body.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let tx = tx.clone();
                tokio::spawn(async move {
                    let mut buf = [0; 4096];
                    let n = stream.read(&mut buf).await.unwrap();
                    let request = std::str::from_utf8(&buf[..n]).unwrap();
                    let route = request.split_whitespace().nth(1).unwrap();
                    stream.write_all(stall(route).as_bytes()).await.unwrap();
                    if route != "/user" {
                        tx.send(()).unwrap();
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    }
                });
            }
        });
        let server = Server {
            origin,
            task,
            requests: Arc::new(std::sync::Mutex::new(Vec::new())),
        };
        let session = reader(&server, creds())
            .session(None, CancellationToken::new())
            .await
            .unwrap()
            .unwrap();
        let cancel = CancellationToken::new();
        let future = session.get("/stall", cancel.clone());
        tokio::pin!(future);
        tokio::select! { _=rx.recv()=>{}, result=&mut future=>panic!("unexpected early result: {}",result.is_ok()) }
        cancel.cancel();
        assert_eq!(future.await.unwrap_err().details["kind"], "cancelled");
        let error = session
            .get("/stall", CancellationToken::new())
            .await
            .unwrap_err();
        assert!(matches!(
            error.details["kind"].as_str(),
            Some("timeout" | "transport")
        ));
    }
}
#[cfg(test)]
mod log_validation_tests {
    use super::*;
    #[test]
    fn log_destination_is_https_vetted_and_credential_free() {
        assert!(log_destination(
            &Url::parse("https://abc.blob.core.windows.net/job?signature=x").unwrap()
        ));
        for url in [
            "http://abc.blob.core.windows.net/job",
            "https://abc.blob.core.windows.net:444/job",
            "https://user@abc.blob.core.windows.net/job",
            "https://abc.blob.core.windows.net.evil.test/job",
            "https://127.0.0.1/job",
            "https://api.github.com/job",
        ] {
            assert!(!log_destination(&Url::parse(url).unwrap()), "{url}");
        }
    }
    #[test]
    fn logs_reject_local_resolutions_and_ipv4_mapped_local() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.0.1",
            "192.168.1.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!public_address(ip.parse().unwrap()));
        }
        assert!(public_address("1.1.1.1".parse().unwrap()));
    }
}

//! Bounded relay for the closed mobile protocol. This process has no desktop
//! credentials, workspace access, Agent, arbitrary RPC proxy or mutation retry.
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, DefaultBodyLimit, Request, State,
    },
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot},
};
use tokio_util::sync::CancellationToken;
use tower_http::services::ServeDir;
use url::Url;
use xharness_mobile::protocol::{
    ErrorCode, HostFrame, MobileAction, MobileRequest, MobileResponse, PairedDevice, RelayFrame,
    Secret, MAX_FRAME_BYTES, MAX_PENDING_REQUESTS,
};

const HELLO_TIMEOUT: Duration = Duration::from_secs(8);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const SEND_TIMEOUT: Duration = Duration::from_secs(5);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
const HOST_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const COOKIE_TTL_SECONDS: u32 = 30 * 24 * 60 * 60;
const MAX_HOSTS: usize = 4096;
const MAX_RATE_PEERS: usize = 4096;

#[derive(Debug, thiserror::Error)]
pub enum RelayError {
    #[error("invalid relay configuration: {0}")]
    Configuration(&'static str),
    #[error("relay IO failed")]
    Io(#[from] std::io::Error),
    #[error("invalid registered-host file")]
    HostFile,
}

/// The registry contains SHA-256 digests, never the plaintext Host key.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisteredHost {
    pub key_sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisteredHosts {
    pub hosts: HashMap<String, RegisteredHost>,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: SocketAddr,
    pub static_dir: PathBuf,
    pub public_origin: String,
    pub allow_loopback_http: bool,
    pub registered: RegisteredHosts,
}

impl Config {
    pub fn validate(&self) -> Result<(), RelayError> {
        let origin = Url::parse(&self.public_origin)
            .map_err(|_| RelayError::Configuration("public origin URL"))?;
        if !origin.username().is_empty()
            || origin.password().is_some()
            || origin.query().is_some()
            || origin.fragment().is_some()
            || origin.path() != "/"
            || origin.host_str().is_none()
            || origin.origin().ascii_serialization() != self.public_origin
        {
            return Err(RelayError::Configuration(
                "public origin must be an exact origin, without a trailing slash",
            ));
        }
        if origin.scheme() != "https" {
            let loopback_origin = origin.host_str().is_some_and(|host| {
                host == "localhost"
                    || host
                        .trim_start_matches('[')
                        .trim_end_matches(']')
                        .parse::<IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback())
            });
            if origin.scheme() != "http"
                || !self.allow_loopback_http
                || !self.bind.ip().is_loopback()
                || !loopback_origin
            {
                return Err(RelayError::Configuration(
                    "HTTPS required except explicit loopback experiment",
                ));
            }
        }
        if !self.static_dir.is_dir() {
            return Err(RelayError::Configuration("static directory must exist"));
        }
        validate_registered(&self.registered)
    }
    fn secure(&self) -> bool {
        self.public_origin.starts_with("https://")
    }
    fn cookie_name(&self) -> &'static str {
        if self.secure() {
            "__Host-xharness_mobile"
        } else {
            "xharness_mobile_loopback"
        }
    }
}

fn valid_identifier(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

fn validate_registered(value: &RegisteredHosts) -> Result<(), RelayError> {
    if value.hosts.is_empty() || value.hosts.len() > MAX_HOSTS {
        return Err(RelayError::Configuration("registered host count"));
    }
    for (host, registered) in &value.hosts {
        if !valid_identifier(host)
            || registered.key_sha256.len() != 64
            || !registered
                .key_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(RelayError::Configuration(
                "host identifier or SHA-256 shape",
            ));
        }
    }
    Ok(())
}

/// Private regular file only. Environment values and key material are not logged.
pub fn load_registered_hosts(path: &Path) -> Result<RegisteredHosts, RelayError> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 1024 * 1024 {
        return Err(RelayError::HostFile);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(RelayError::HostFile);
        }
    }
    let bytes = std::fs::read(path)?;
    let registered: RegisteredHosts =
        serde_json::from_slice(&bytes).map_err(|_| RelayError::HostFile)?;
    validate_registered(&registered)?;
    Ok(registered)
}

#[derive(Clone)]
struct RelayState(Arc<Inner>);
struct Inner {
    config: Config,
    connections: Mutex<HashMap<String, Arc<HostConnection>>>,
    next_id: AtomicU64,
    shutdown: CancellationToken,
    draining: AtomicBool,
    rates: Mutex<HashMap<IpAddr, PeerRate>>,
}
struct HostConnection {
    generation: u64,
    ready: AtomicBool,
    outgoing: mpsc::Sender<RelayFrame>,
    pending: Mutex<HashMap<String, oneshot::Sender<MobileResponse>>>,
    cancellation: CancellationToken,
}

impl HostConnection {
    fn close(&self) {
        self.cancellation.cancel();
        let pending = std::mem::take(&mut *self.pending.lock().unwrap_or_else(|e| e.into_inner()));
        for (_, waiter) in pending {
            let _ = waiter.send(MobileResponse::failure(ErrorCode::HostOffline));
        }
    }
}

impl RelayState {
    fn new(config: Config, shutdown: CancellationToken) -> Self {
        Self(Arc::new(Inner {
            config,
            connections: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            shutdown,
            draining: AtomicBool::new(false),
            rates: Mutex::new(HashMap::new()),
        }))
    }
    fn shutdown(&self) {
        self.0.draining.store(true, Ordering::Release);
        let connections =
            std::mem::take(&mut *self.0.connections.lock().unwrap_or_else(|e| e.into_inner()));
        for (_, connection) in connections {
            connection.close();
        }
    }
    async fn forward(&self, host: &str, request: MobileRequest) -> MobileResponse {
        if self.0.draining.load(Ordering::Acquire) {
            return MobileResponse::failure(ErrorCode::HostOffline);
        }
        let connection = self
            .0
            .connections
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(host)
            .cloned();
        let Some(connection) = connection else {
            return MobileResponse::failure(ErrorCode::HostOffline);
        };
        let id = self.0.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        let frame = RelayFrame::Request {
            id: id.clone(),
            request,
        };
        // The authenticated envelope adds fields to an action body. Reject an
        // oversized envelope without disconnecting the Host or accepting work.
        if !serde_json::to_vec(&frame).is_ok_and(|bytes| bytes.len() <= MAX_FRAME_BYTES) {
            return MobileResponse::failure(ErrorCode::InvalidRequest);
        }
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = connection.pending.lock().unwrap_or_else(|e| e.into_inner());
            if connection.cancellation.is_cancelled() {
                return MobileResponse::failure(ErrorCode::HostOffline);
            }
            if !connection.ready.load(Ordering::Acquire) {
                return MobileResponse::failure(ErrorCode::HostOffline);
            }
            if pending.len() >= MAX_PENDING_REQUESTS {
                return MobileResponse::failure(ErrorCode::Capacity);
            }
            pending.insert(id.clone(), sender);
        }
        // Cancellation of an HTTP future also removes its waiter. A late response
        // is discarded; timed-out mutations are never replayed by the relay.
        let _guard = PendingGuard {
            connection: connection.clone(),
            id: id.clone(),
        };
        if let Err(error) = connection.outgoing.try_send(frame) {
            return MobileResponse::failure(match error {
                mpsc::error::TrySendError::Full(_) => ErrorCode::Capacity,
                mpsc::error::TrySendError::Closed(_) => ErrorCode::HostOffline,
            });
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => MobileResponse::failure(ErrorCode::HostOffline),
            Err(_) => MobileResponse::failure(ErrorCode::Timeout),
        }
    }
    fn allowed(&self, ip: IpAddr, kind: RateKind) -> bool {
        let now = Instant::now();
        let mut rates = self.0.rates.lock().unwrap_or_else(|e| e.into_inner());
        if rates.len() >= MAX_RATE_PEERS {
            rates.retain(|_, rate| now.duration_since(rate.touched) < Duration::from_secs(120));
            if rates.len() >= MAX_RATE_PEERS && !rates.contains_key(&ip) {
                return false;
            }
        }
        rates
            .entry(ip)
            .or_insert_with(|| PeerRate::new(now))
            .take(kind, now)
    }
}

struct PendingGuard {
    connection: Arc<HostConnection>,
    id: String,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.connection
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }
}

#[derive(Clone, Copy)]
enum RateKind {
    Pair,
    Action,
    Host,
}
struct Bucket {
    tokens: f64,
    last: Instant,
    capacity: f64,
    per_second: f64,
}
impl Bucket {
    fn new(capacity: f64, per_minute: f64, now: Instant) -> Self {
        Self {
            tokens: capacity,
            last: now,
            capacity,
            per_second: per_minute / 60.0,
        }
    }
    fn take(&mut self, now: Instant) -> bool {
        self.tokens = (self.tokens + now.duration_since(self.last).as_secs_f64() * self.per_second)
            .min(self.capacity);
        self.last = now;
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}
struct PeerRate {
    pair: Bucket,
    action: Bucket,
    host: Bucket,
    touched: Instant,
}
impl PeerRate {
    fn new(now: Instant) -> Self {
        Self {
            pair: Bucket::new(6.0, 6.0, now),
            action: Bucket::new(120.0, 240.0, now),
            host: Bucket::new(20.0, 20.0, now),
            touched: now,
        }
    }
    fn take(&mut self, kind: RateKind, now: Instant) -> bool {
        self.touched = now;
        match kind {
            RateKind::Pair => self.pair.take(now),
            RateKind::Action => self.action.take(now),
            RateKind::Host => self.host.take(now),
        }
    }
}

fn build_router(state: RelayState) -> Router {
    let static_files =
        ServeDir::new(&state.0.config.static_dir).append_index_html_on_directories(true);
    Router::new()
        .route("/healthz", get(health))
        .route("/api/mobile/host", get(host_upgrade))
        .route("/api/mobile/pair", post(pair))
        .route("/api/mobile/action", post(action))
        .route("/api/mobile/logout", post(logout))
        // /api is never sent to the frontend fallback, even for an unknown path.
        .route("/api", get(api_not_found).post(api_not_found))
        .route("/api/{*path}", get(api_not_found).post(api_not_found))
        .fallback_service(static_files)
        .layer(DefaultBodyLimit::max(MAX_FRAME_BYTES))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            transport_boundary,
        ))
        .with_state(state)
}

/// Runs a relay until cancellation, closing WS owners and resolving pending
/// HTTP waiters before axum drains. The caller owns signal policy and listener.
pub async fn serve(
    listener: TcpListener,
    config: Config,
    shutdown: CancellationToken,
) -> Result<(), RelayError> {
    config.validate()?;
    let state = RelayState::new(config, shutdown.clone());
    let draining_state = state.clone();
    axum::serve(
        listener,
        build_router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown.cancelled().await;
        draining_state.shutdown();
    })
    .await?;
    Ok(())
}

async fn health(State(state): State<RelayState>) -> Response {
    if state.0.draining.load(Ordering::Acquire) {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, ErrorCode::HostOffline);
    }
    let connected_hosts = state
        .0
        .connections
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .filter(|connection| {
            connection.ready.load(Ordering::Acquire) && !connection.cancellation.is_cancelled()
        })
        .count();
    // Aggregate authenticated-ready owners only. No Host identity, device,
    // credential or model metadata is exposed by deployment readiness.
    Json(serde_json::json!({"ok": true, "connected_hosts": connected_hosts})).into_response()
}
async fn api_not_found() -> Response {
    error_response(StatusCode::NOT_FOUND, ErrorCode::InvalidRequest)
}
fn error_response(status: StatusCode, error: ErrorCode) -> Response {
    (status, Json(MobileResponse::failure(error))).into_response()
}
fn response_status(response: &MobileResponse) -> StatusCode {
    match response.error {
        None => StatusCode::OK,
        Some(ErrorCode::Unauthorized) => StatusCode::UNAUTHORIZED,
        Some(ErrorCode::HostOffline | ErrorCode::HostUnavailable) => {
            StatusCode::SERVICE_UNAVAILABLE
        }
        Some(ErrorCode::Timeout) => StatusCode::GATEWAY_TIMEOUT,
        Some(ErrorCode::Capacity) => StatusCode::TOO_MANY_REQUESTS,
        Some(
            ErrorCode::PairExpired
            | ErrorCode::PairConsumed
            | ErrorCode::Conflict
            | ErrorCode::StreamGap,
        ) => StatusCode::CONFLICT,
        Some(ErrorCode::InvalidRequest) => StatusCode::BAD_REQUEST,
        Some(ErrorCode::StorageUnavailable) => StatusCode::SERVICE_UNAVAILABLE,
    }
}

async fn transport_boundary(
    State(state): State<RelayState>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    let is_host = path == "/api/mobile/host";
    let is_mutation = request.method() == Method::POST && path.starts_with("/api/");
    let headers = request.headers();
    let rejected = if is_host {
        headers.contains_key(header::ORIGIN)
    } else if is_mutation {
        // These are singleton security headers. Picking the first value could
        // accept an ambiguous request that another hop interprets differently.
        let singleton_origin = headers.get_all(header::ORIGIN).iter().count() == 1;
        let singleton_content_type = headers.get_all(header::CONTENT_TYPE).iter().count() == 1;
        let origin = headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok());
        let json = headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(';')
                    .next()
                    .is_some_and(|part| part.trim().eq_ignore_ascii_case("application/json"))
            });
        !singleton_origin
            || !singleton_content_type
            || origin != Some(state.0.config.public_origin.as_str())
            || !json
    } else {
        false
    };
    let mut response = if rejected {
        error_response(StatusCode::FORBIDDEN, ErrorCode::Unauthorized)
    } else if is_host || is_mutation {
        let ip = request
            .extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map_or(IpAddr::from([127, 0, 0, 1]), |info| info.0.ip());
        let kind = if is_host {
            RateKind::Host
        } else if path == "/api/mobile/pair" {
            RateKind::Pair
        } else {
            RateKind::Action
        };
        if state.allowed(ip, kind) {
            next.run(request).await
        } else {
            error_response(StatusCode::TOO_MANY_REQUESTS, ErrorCode::Capacity)
        }
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"));
    if state.0.config.secure() {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000"),
        );
    }
    response
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairInput {
    host: String,
    code: Secret,
    name: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceCookie {
    host: String,
    device: String,
    secret: Secret,
}

async fn pair(
    State(state): State<RelayState>,
    input: Result<Json<PairInput>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return error_response(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest);
    };
    if !valid_identifier(&input.host)
        || !state.0.config.registered.hosts.contains_key(&input.host)
        || input.name.trim().is_empty()
        || input.name.len() > 128
        || input.name.chars().any(char::is_control)
    {
        return error_response(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest);
    }
    let response = state
        .forward(
            &input.host,
            MobileRequest::Pair {
                code: input.code,
                name: input.name,
            },
        )
        .await;
    if !response.ok {
        return (response_status(&response), Json(response)).into_response();
    }
    let Some(result) = response.result else {
        return error_response(StatusCode::BAD_GATEWAY, ErrorCode::InvalidRequest);
    };
    let Ok(paired) = serde_json::from_value::<PairedDevice>(result) else {
        return error_response(StatusCode::BAD_GATEWAY, ErrorCode::InvalidRequest);
    };
    if paired.host != input.host || !valid_identifier(&paired.device) {
        return error_response(StatusCode::BAD_GATEWAY, ErrorCode::InvalidRequest);
    }
    let public_result = serde_json::json!({"host": &paired.host, "device": &paired.device});
    let cookie = DeviceCookie {
        host: paired.host,
        device: paired.device,
        secret: paired.secret,
    };
    let Ok(encoded) = serde_json::to_vec(&cookie) else {
        return error_response(StatusCode::BAD_GATEWAY, ErrorCode::InvalidRequest);
    };
    let secure = if state.0.config.secure() {
        "; Secure"
    } else {
        ""
    };
    let cookie_value = format!(
        "{}={}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}{}",
        state.0.config.cookie_name(),
        URL_SAFE_NO_PAD.encode(encoded),
        COOKIE_TTL_SECONDS,
        secure
    );
    let Ok(cookie_header) = HeaderValue::from_str(&cookie_value) else {
        return error_response(StatusCode::BAD_GATEWAY, ErrorCode::InvalidRequest);
    };
    let mut result = Json(MobileResponse::success(public_result)).into_response();
    result
        .headers_mut()
        .insert(header::SET_COOKIE, cookie_header);
    result
}

fn read_cookie(headers: &HeaderMap, config: &Config) -> Option<DeviceCookie> {
    let mut found = None;
    for raw in headers.get_all(header::COOKIE) {
        for part in raw.to_str().ok()?.split(';') {
            let (name, value) = part.trim().split_once('=')?;
            if name == config.cookie_name() {
                if found.is_some() || value.len() > 2048 {
                    return None;
                }
                let bytes = URL_SAFE_NO_PAD.decode(value).ok()?;
                let cookie: DeviceCookie = serde_json::from_slice(&bytes).ok()?;
                if !valid_identifier(&cookie.host)
                    || !valid_identifier(&cookie.device)
                    || !config.registered.hosts.contains_key(&cookie.host)
                {
                    return None;
                }
                found = Some(cookie);
            }
        }
    }
    found
}

async fn action(
    State(state): State<RelayState>,
    headers: HeaderMap,
    input: Result<Json<MobileAction>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Some(cookie) = read_cookie(&headers, &state.0.config) else {
        return error_response(StatusCode::UNAUTHORIZED, ErrorCode::Unauthorized);
    };
    let Ok(Json(action)) = input else {
        return error_response(StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest);
    };
    let response = state
        .forward(
            &cookie.host,
            MobileRequest::Authenticated {
                device: cookie.device,
                secret: cookie.secret,
                action,
            },
        )
        .await;
    (response_status(&response), Json(response)).into_response()
}

async fn logout(State(state): State<RelayState>) -> Response {
    let secure = if state.0.config.secure() {
        "; Secure"
    } else {
        ""
    };
    let value = format!(
        "{}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0{}",
        state.0.config.cookie_name(),
        secure
    );
    let mut response = Json(serde_json::json!({"ok": true})).into_response();
    if let Ok(value) = HeaderValue::from_str(&value) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

async fn host_upgrade(State(state): State<RelayState>, ws: WebSocketUpgrade) -> Response {
    if state.0.draining.load(Ordering::Acquire) {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, ErrorCode::HostOffline);
    }
    ws.max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| host_socket(socket, state))
        .into_response()
}

fn authenticate_host(state: &RelayState, host: &str, key: &Secret) -> bool {
    let Some(registered) = state.0.config.registered.hosts.get(host) else {
        return false;
    };
    let actual = format!("{:x}", Sha256::digest(key.expose().as_bytes()));
    registered
        .key_sha256
        .as_bytes()
        .iter()
        .zip(actual.as_bytes())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

async fn host_socket(mut socket: WebSocket, state: RelayState) {
    let hello = tokio::select! {
        _ = state.0.shutdown.cancelled() => return,
        result = tokio::time::timeout(HELLO_TIMEOUT, socket.next()) => result,
    };
    let Ok(Some(Ok(Message::Text(text)))) = hello else {
        let _ = tokio::time::timeout(SEND_TIMEOUT, socket.close()).await;
        return;
    };
    let Ok(HostFrame::Hello { host, key }) = serde_json::from_str::<HostFrame>(&text) else {
        let _ = tokio::time::timeout(SEND_TIMEOUT, socket.close()).await;
        return;
    };
    if !authenticate_host(&state, &host, &key) || state.0.draining.load(Ordering::Acquire) {
        let _ = tokio::time::timeout(SEND_TIMEOUT, socket.close()).await;
        return;
    }
    drop(key);
    let (sender, mut receiver) = mpsc::channel(MAX_PENDING_REQUESTS);
    let connection = Arc::new(HostConnection {
        generation: state.0.next_id.fetch_add(1, Ordering::Relaxed),
        ready: AtomicBool::new(false),
        outgoing: sender,
        pending: Mutex::new(HashMap::new()),
        cancellation: CancellationToken::new(),
    });
    {
        let mut connections = state
            .0
            .connections
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if state.0.draining.load(Ordering::Acquire) {
            connection.close();
            return;
        }
        if let Some(previous) = connections.insert(host.clone(), connection.clone()) {
            previous.close();
        }
    }
    let ready = serde_json::to_string(&RelayFrame::Ready).expect("ready serialization");
    let (mut sink, mut stream) = socket.split();
    if matches!(
        tokio::time::timeout(SEND_TIMEOUT, sink.send(Message::Text(ready.into()))).await,
        Ok(Ok(()))
    ) {
        connection.ready.store(true, Ordering::Release);
        let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        heartbeat.tick().await;
        let mut last_incoming = Instant::now();
        loop {
            tokio::select! {
                biased;
                _ = connection.cancellation.cancelled() => break,
                _ = state.0.shutdown.cancelled() => break,
                outgoing = receiver.recv() => {
                    let Some(outgoing) = outgoing else { break; };
                    let Ok(text) = serde_json::to_string(&outgoing) else { break; };
                    if text.len() > MAX_FRAME_BYTES || !matches!(tokio::time::timeout(SEND_TIMEOUT, sink.send(Message::Text(text.into()))).await, Ok(Ok(()))) { break; }
                },
                incoming = stream.next() => {
                    last_incoming = Instant::now();
                    match incoming {
                        Some(Ok(Message::Text(text))) => {
                            let Ok(HostFrame::Response { id, response }) = serde_json::from_str::<HostFrame>(&text) else { break; };
                            if id.len() > 32 || response.ok == response.error.is_some() || (!response.ok && response.result.is_some()) { break; }
                            let waiter = connection.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                            if let Some(waiter) = waiter { let _ = waiter.send(response); }
                        },
                        Some(Ok(Message::Ping(bytes))) => { if !matches!(tokio::time::timeout(SEND_TIMEOUT, sink.send(Message::Pong(bytes))).await, Ok(Ok(()))) { break; } },
                        Some(Ok(Message::Pong(_))) => {},
                        _ => break,
                    }
                },
                _ = heartbeat.tick() => {
                    if last_incoming.elapsed() >= HOST_IDLE_TIMEOUT { break; }
                    if !matches!(tokio::time::timeout(SEND_TIMEOUT, sink.send(Message::Ping(Vec::new().into()))).await, Ok(Ok(()))) { break; }
                }
            }
        }
    }
    connection.close();
    {
        let mut connections = state
            .0
            .connections
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if connections
            .get(&host)
            .is_some_and(|current| current.generation == connection.generation)
        {
            connections.remove(&host);
        }
    }
    let _ = tokio::time::timeout(SEND_TIMEOUT, sink.send(Message::Close(None))).await;
}

#[cfg(test)]
mod tests;

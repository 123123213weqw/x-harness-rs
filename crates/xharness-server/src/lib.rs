//! DeepSeek Harness Web-compatible physical carrier.
//!
//! Unary RPC travels upstream through JSON POST requests. Mux and Host events
//! use two downlink-only WebSockets. The server owns transport validation only;
//! business behavior is supplied by [`xharness_api::ApiBackend`].

use std::{future::Future, path::PathBuf, str::FromStr, sync::Arc};

use axum::{
    body::Bytes,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Path, Query, Request, State,
    },
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tower_http::services::{ServeDir, ServeFile};
use xharness_api::{
    ApiBackend, ClientRequest, ClientResponse, EventStream, ReceiptRejection, RpcError, RpcId,
    RpcMethod, RpcReceipt, RpcResult, ServerRequest, ServerResponse, HOST_EVENTS_PATH,
    MUX_EVENTS_PATH, RESPOND_PATH, SESSION_EXPORT_PATH,
};
use xharness_debug::{DebugEvent, DebugRecorder};

pub const DEFAULT_REQUEST_BODY_LIMIT_BYTES: usize = 160 * 1024 * 1024;
const DESKTOP_COOKIE_NAME: &str = "xharness_desktop";

#[derive(Clone)]
struct ServerState {
    backend: Arc<dyn ApiBackend>,
    debug: DebugRecorder,
}

/// Build the complete `/api` transport surface without static-file fallback.
pub fn api_router(backend: Arc<dyn ApiBackend>) -> Router {
    api_router_with_debug(backend, DebugRecorder::disabled())
}

pub fn api_router_with_debug(backend: Arc<dyn ApiBackend>, debug: DebugRecorder) -> Router {
    let state = ServerState { backend, debug };
    Router::new()
        .route(RESPOND_PATH, post(respond))
        .route(MUX_EVENTS_PATH, get(mux_events))
        .route(HOST_EVENTS_PATH, get(host_events))
        .route(
            SESSION_EXPORT_PATH,
            get(session_export).head(session_export),
        )
        .route("/api/{namespace}/{method}", post(dynamic_unary))
        .route("/api/{method}", post(unary))
        .layer(DefaultBodyLimit::max(DEFAULT_REQUEST_BODY_LIMIT_BYTES))
        .with_state(state)
}

#[derive(Deserialize)]
struct SessionExportQuery {
    #[serde(rename = "sessionId")]
    session_id: String,
}

async fn session_export(
    State(state): State<ServerState>,
    method: Method,
    Query(query): Query<SessionExportQuery>,
) -> Response {
    state
        .debug
        .record_lossy(DebugEvent::new(
            "server",
            "session_export.request",
            json!({"method": method.as_str(), "sessionId": &query.session_id}),
        ))
        .await;
    if query.session_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            "missing or invalid sessionId query parameter",
        )
            .into_response();
    }
    let cancellation = CancellationToken::new();
    let _cancel_on_drop = CancelOnDrop(cancellation.clone());
    match state
        .backend
        .export_session(&query.session_id, cancellation)
        .await
    {
        Ok(export) => {
            state
                .debug
                .record_lossy(DebugEvent::new(
                    "server",
                    "session_export.response",
                    json!({
                        "sessionId": &query.session_id,
                        "filename": &export.filename,
                        "contentType": &export.content_type,
                        "bytes": export.bytes.len(),
                        "content": String::from_utf8_lossy(&export.bytes),
                    }),
                ))
                .await;
            let mut response = if method == Method::HEAD {
                ().into_response()
            } else {
                export.bytes.into_response()
            };
            let Ok(content_type) = export.content_type.parse() else {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            };
            let disposition = format!(
                "attachment; filename=\"{}\"",
                export.filename.replace(['\\', '"'], "_")
            );
            let Ok(disposition) = disposition.parse() else {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            };
            response
                .headers_mut()
                .insert(header::CONTENT_TYPE, content_type);
            response
                .headers_mut()
                .insert(header::CONTENT_DISPOSITION, disposition);
            response
        }
        Err(error) if error.code == xharness_api::RpcErrorCode::SessionNotFound => {
            state
                .debug
                .record_lossy(DebugEvent::new(
                    "server",
                    "session_export.error",
                    json!({"sessionId": &query.session_id, "error": &error}),
                ))
                .await;
            (StatusCode::NOT_FOUND, error.message).into_response()
        }
        Err(error) => {
            state
                .debug
                .record_lossy(DebugEvent::new(
                    "server",
                    "session_export.error",
                    json!({"sessionId": &query.session_id, "error": &error}),
                ))
                .await;
            (StatusCode::INTERNAL_SERVER_ERROR, error.message).into_response()
        }
    }
}

/// Add an optional SPA fallback. Unknown paths first try the dist directory,
/// then return its `index.html` so client-side routes remain reloadable.
pub fn web_router(backend: Arc<dyn ApiBackend>, static_dir: Option<PathBuf>) -> Router {
    web_router_with_debug(backend, static_dir, DebugRecorder::disabled())
}

pub fn web_router_with_debug(
    backend: Arc<dyn ApiBackend>,
    static_dir: Option<PathBuf>,
    debug: DebugRecorder,
) -> Router {
    web_router_with_debug_and_desktop_token(backend, static_dir, debug, None)
}

/// Build the Web product carrier and optionally protect every `/api` route
/// with a per-launch desktop token.
///
/// The static shell and readiness endpoint intentionally remain public on the
/// caller-owned listener. A Tauri desktop shell starts the Host on a random
/// loopback port, opens the one-time bootstrap URL, and receives an HttpOnly,
/// same-site cookie before the SPA loads. Browser/server deployments pass
/// `None` and keep their existing authentication boundary (for example a
/// reverse proxy in front of this router).
pub fn web_router_with_debug_and_desktop_token(
    backend: Arc<dyn ApiBackend>,
    static_dir: Option<PathBuf>,
    debug: DebugRecorder,
    desktop_token: Option<String>,
) -> Router {
    let mut router = api_router_with_debug(backend, debug);
    if let Some(token) = desktop_token {
        let auth = DesktopAuth::new(token);
        router = router
            .route_layer(middleware::from_fn_with_state(
                auth.clone(),
                require_desktop_auth,
            ))
            .route(
                "/desktop/bootstrap",
                get(desktop_bootstrap).with_state(auth),
            );
    }
    router = router.route("/health/ready", get(health_ready));
    match static_dir {
        Some(root) => {
            let index = root.join("index.html");
            router.fallback_service(ServeDir::new(root).fallback(ServeFile::new(index)))
        }
        None => router,
    }
}

#[derive(Clone)]
struct DesktopAuth {
    token: Arc<str>,
}

impl DesktopAuth {
    fn new(token: String) -> Self {
        Self {
            token: Arc::from(token),
        }
    }

    fn accepts(&self, candidate: &str) -> bool {
        // Keep comparison work independent of the first mismatching byte. The
        // token is local-only, but avoiding an early-return comparison costs
        // almost nothing and prevents this boundary from becoming weaker when
        // desktop transports evolve.
        if candidate.len() != self.token.len() {
            return false;
        }
        candidate
            .as_bytes()
            .iter()
            .zip(self.token.as_bytes())
            .fold(0_u8, |difference, (left, right)| {
                difference | (left ^ right)
            })
            == 0
    }
}

#[derive(Deserialize)]
struct DesktopBootstrapQuery {
    token: String,
}

async fn desktop_bootstrap(
    State(auth): State<DesktopAuth>,
    Query(query): Query<DesktopBootstrapQuery>,
) -> Response {
    if !auth.accepts(&query.token) {
        return (StatusCode::UNAUTHORIZED, "invalid desktop bootstrap token").into_response();
    }
    let cookie = format!(
        "{DESKTOP_COOKIE_NAME}={}; HttpOnly; SameSite=Strict; Path=/",
        query.token
    );
    let Ok(cookie) = HeaderValue::from_str(&cookie) else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let mut response = Redirect::to("/").into_response();
    response.headers_mut().insert(header::SET_COOKIE, cookie);
    response
}

async fn require_desktop_auth(
    State(auth): State<DesktopAuth>,
    request: Request,
    next: Next,
) -> Response {
    let header_token = request
        .headers()
        .get("x-xharness-desktop-token")
        .and_then(|value| value.to_str().ok());
    let cookie_token = request
        .headers()
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(desktop_cookie);
    if header_token
        .or(cookie_token)
        .is_some_and(|candidate| auth.accepts(candidate))
    {
        next.run(request).await
    } else {
        (StatusCode::UNAUTHORIZED, "desktop authentication required").into_response()
    }
}

fn desktop_cookie(cookies: &str) -> Option<&str> {
    cookies.split(';').find_map(|cookie| {
        let (name, value) = cookie.trim().split_once('=')?;
        (name == DESKTOP_COOKIE_NAME).then_some(value)
    })
}

async fn health_ready() -> Json<Value> {
    Json(json!({
        "ok": true,
        "service": "xharness-host",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

/// Serve a prebuilt Router on a caller-owned listener until shutdown resolves.
pub async fn serve<F>(listener: TcpListener, router: Router, shutdown: F) -> std::io::Result<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown)
        .await
}

async fn unary(
    State(state): State<ServerState>,
    Path(path_method): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    unary_endpoint(state, path_method, headers, body).await
}

async fn dynamic_unary(
    State(state): State<ServerState>,
    Path((namespace, method)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    unary_endpoint(state, format!("{namespace}/{method}"), headers, body).await
}

fn rpc_debug_body(method: &str, body: &[u8]) -> Value {
    let Ok(mut value) = serde_json::from_slice::<Value>(body) else {
        return json!("[unparsed request body omitted]");
    };
    if method == "credentials.set" || value["method"] == "credentials.set" {
        value["payload"] = json!("[credential payload omitted]");
    }
    // Keep JSON structured so the shared redactor sees nested apiKey fields.
    value
}

#[test]
fn credential_rpc_debug_body_does_not_contain_key() {
    let value = rpc_debug_body("credentials.set", br#"{"method":"credentials.set","payload":{"ref":"TEST_KEY","value":"test-sensitive-value"}}"#);
    assert!(!value.to_string().contains("test-sensitive-value"));
    assert_eq!(
        rpc_debug_body("settings.mutate", b"invalid sensitive JSON"),
        json!("[unparsed request body omitted]")
    );
}

async fn unary_endpoint(
    state: ServerState,
    path_method: String,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    state
        .debug
        .record_lossy(DebugEvent::new(
            "server",
            "rpc.request",
            json!({
                "method": &path_method,
                "bytes": body.len(),
                "body": rpc_debug_body(&path_method, &body),
            }),
        ))
        .await;
    if !is_json(&headers) {
        state
            .debug
            .record_lossy(DebugEvent::new(
                "server",
                "rpc.rejected",
                json!({"method": &path_method, "reason": "unsupported_media_type"}),
            ))
            .await;
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "content type must be application/json",
        )
            .into_response();
    }
    let value: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => {
            state.debug.record_lossy(DebugEvent::new(
                "server",
                "rpc.rejected",
                json!({"method": &path_method, "reason": "invalid_json", "error": error.to_string()}),
            )).await;
            return (StatusCode::BAD_REQUEST, "body is not JSON").into_response();
        }
    };
    let request: ClientRequest = match serde_json::from_value(value.clone()) {
        Ok(request) => request,
        Err(error) => {
            let rpc_id = salvage_rpc_id(&value);
            state.debug.record_lossy(DebugEvent::new(
                "server",
                "rpc.rejected",
                json!({"method": &path_method, "rpcId": &rpc_id, "reason": "invalid_envelope", "error": error.to_string()}),
            )).await;
            return Json(ServerResponse::new(
                rpc_id,
                RpcResult::failure(RpcError::bad_request(
                    format!("invalid payload for {path_method}"),
                    json!([{ "message": error.to_string() }]),
                )),
            ))
            .into_response();
        }
    };
    if request.method != path_method {
        state.debug.record_lossy(DebugEvent::new(
            "server",
            "rpc.rejected",
            json!({"method": &path_method, "rpcId": &request.rpc_id, "reason": "path_method_mismatch", "envelopeMethod": &request.method}),
        )).await;
        return Json(ServerResponse::new(
            request.rpc_id,
            RpcResult::failure(RpcError::bad_request(
                format!(
                    "method {:?} does not match path {:?}",
                    request.method, path_method
                ),
                json!([]),
            )),
        ))
        .into_response();
    }

    let cancellation = CancellationToken::new();
    let _cancel_on_drop = CancelOnDrop(cancellation.clone());
    let rpc_id = request.rpc_id;
    let result =
        match RpcMethod::from_str(&path_method) {
            Ok(method) => {
                state
                    .backend
                    .call(rpc_id.clone(), method, request.payload, cancellation)
                    .await
            }
            Err(_) => {
                let Some(result) = state
                    .backend
                    .call_dynamic(rpc_id.clone(), &path_method, request.payload, cancellation)
                    .await
                else {
                    state.debug.record_lossy(DebugEvent::new(
                    "server",
                    "rpc.rejected",
                    json!({"method": &path_method, "rpcId": &rpc_id, "reason": "not_found"}),
                )).await;
                    return (StatusCode::NOT_FOUND, "not found").into_response();
                };
                result
            }
        };
    state
        .debug
        .record_lossy(DebugEvent::new(
            "server",
            "rpc.response",
            json!({"method": &path_method, "rpcId": &rpc_id, "result": &result}),
        ))
        .await;
    Json(ServerResponse::new(rpc_id, result)).into_response()
}

async fn respond(State(state): State<ServerState>, headers: HeaderMap, body: Bytes) -> Response {
    state
        .debug
        .record_lossy(DebugEvent::new(
            "server",
            "respond.request",
            json!({"bytes": body.len(), "body": String::from_utf8_lossy(&body)}),
        ))
        .await;
    if !is_json(&headers) {
        state
            .debug
            .record_lossy(DebugEvent::new(
                "server",
                "respond.rejected",
                json!({"reason": "unsupported_media_type"}),
            ))
            .await;
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "content type must be application/json",
        )
            .into_response();
    }
    let value: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(error) => {
            state
                .debug
                .record_lossy(DebugEvent::new(
                    "server",
                    "respond.rejected",
                    json!({"reason": "invalid_json", "error": error.to_string()}),
                ))
                .await;
            return (StatusCode::BAD_REQUEST, "body is not JSON").into_response();
        }
    };
    let response: ClientResponse = match serde_json::from_value(value) {
        Ok(response) => response,
        Err(_) => {
            state
                .debug
                .record_lossy(DebugEvent::new(
                    "server",
                    "respond.rejected",
                    json!({"reason": "invalid_envelope"}),
                ))
                .await;
            return Json(RpcReceipt::Rejected {
                reason: ReceiptRejection::BadResponse,
            })
            .into_response();
        }
    };
    let receipt = state.backend.respond(response).await;
    state
        .debug
        .record_lossy(DebugEvent::new(
            "server",
            "respond.response",
            json!({"receipt": &receipt}),
        ))
        .await;
    Json(receipt).into_response()
}

async fn mux_events(
    State(state): State<ServerState>,
    upgrade: WebSocketUpgrade,
) -> impl IntoResponse {
    upgrade.on_upgrade(move |socket| {
        pump_downlink(socket, state.backend.mux_events(), state.debug, "mux")
    })
}

async fn host_events(
    State(state): State<ServerState>,
    upgrade: WebSocketUpgrade,
) -> impl IntoResponse {
    upgrade.on_upgrade(move |socket| {
        pump_downlink(socket, state.backend.host_events(), state.debug, "host")
    })
}

async fn pump_downlink(
    socket: WebSocket,
    mut events: EventStream,
    debug: DebugRecorder,
    channel: &'static str,
) {
    debug
        .record_lossy(DebugEvent::new(
            "server",
            "websocket.opened",
            json!({"channel": channel}),
        ))
        .await;
    let (mut sender, mut receiver) = socket.split();
    loop {
        tokio::select! {
            frame = events.next() => match frame {
                Some(frame) => {
                    debug.record_lossy(DebugEvent::new(
                        "server",
                        "websocket.frame",
                        json!({"channel": channel, "frame": &frame}),
                    )).await;
                    let Ok(text) = serde_json::to_string(&frame) else { break };
                    if sender.send(Message::Text(text.into())).await.is_err() { break; }
                }
                None => {
                    let _ = sender.send(Message::Close(None)).await;
                    break;
                }
            },
            incoming = receiver.next() => match incoming {
                Some(Ok(Message::Ping(payload))) => {
                    if sender.send(Message::Pong(payload)).await.is_err() { break; }
                }
                Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(Message::Text(_) | Message::Binary(_))) => {
                    // The browser uses HTTP for every upstream message.
                    let _ = sender.send(Message::Close(None)).await;
                    break;
                }
            }
        }
    }
    debug
        .record_lossy(DebugEvent::new(
            "server",
            "websocket.closed",
            json!({"channel": channel}),
        ))
        .await;
}

fn is_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
}

fn salvage_rpc_id(value: &Value) -> RpcId {
    value
        .get("rpcId")
        .and_then(Value::as_str)
        .map(RpcId::new)
        .unwrap_or_else(RpcId::invalid_request)
}

struct CancelOnDrop(CancellationToken);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

/// Utility for backends: create a correctly correlated push frame from a
/// payload whose `type` field is the stream method.
pub fn stream_frame(rpc_id: RpcId, payload: Value) -> Result<ServerRequest, RpcError> {
    ServerRequest::frame(rpc_id, payload)
}

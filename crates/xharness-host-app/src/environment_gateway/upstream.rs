use axum::{
    body::{to_bytes, Body},
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Request, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get},
    Json, Router,
};
use futures::{SinkExt, StreamExt};
use reqwest::{Client, Url};
use serde::Deserialize;
use serde_json::json;
use std::{error::Error, fmt, io, sync::Arc, time::Duration};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    protocol::{frame::coding::CloseCode, CloseFrame, WebSocketConfig},
    Message as PeerMessage,
};
const LIMIT: usize = 160 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(10);

/// Not Debug/Serialize: neither a launch credential nor a remote token may be
/// captured by an RPC recorder, response, panic or diagnostic message.
pub(super) struct Upstream {
    client: Client,
    url: Url,
    token: String,
    stop: tokio_util::sync::CancellationToken,
}
impl Upstream {
    pub(super) fn new(
        client: Client,
        url: Url,
        token: String,
        stop: tokio_util::sync::CancellationToken,
    ) -> Self {
        Self {
            client,
            url,
            token,
            stop,
        }
    }
    fn credential(&self) -> io::Result<axum::http::HeaderValue> {
        let mut value: axum::http::HeaderValue = self
            .token
            .parse()
            .map_err(|error| caused("credential_header", error))?;
        value.set_sensitive(true);
        Ok(value)
    }
    async fn identity(&self) -> io::Result<()> {
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|error| caused("entropy", error))?;
        let nonce: String = random.iter().map(|v| format!("{v:02x}")).collect();
        let mut url = self
            .url
            .join("desktop/identity")
            .map_err(|error| caused("identity_target", error))?;
        url.query_pairs_mut().append_pair("nonce", &nonce);
        let response = self
            .client
            .get(url)
            .timeout(DEADLINE)
            .send()
            .await
            .map_err(|error| caused("identity_transport", error))?;
        if !response.status().is_success() {
            return Err(named("identity_status"));
        }
        let body = bounded(response, 4096).await?;
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Proof {
            proof: String,
        }
        let proof: Proof =
            serde_json::from_slice(&body).map_err(|error| caused("identity_payload", error))?;
        if !xharness_server::verify_desktop_identity(&self.token, &nonce, &proof.proof) {
            return Err(named("identity_mismatch"));
        }
        Ok(())
    }
    pub(super) async fn ready(&self) -> io::Result<()> {
        self.identity().await?;
        let response = self
            .client
            .get(
                self.url
                    .join("health/ready")
                    .map_err(|error| caused("transport", error))?,
            )
            .timeout(DEADLINE)
            .send()
            .await
            .map_err(|error| caused("transport", error))?;
        if !response.status().is_success() {
            return Err(unavailable());
        }
        let body = bounded(response, 4096).await?;
        let value: serde_json::Value =
            serde_json::from_slice(&body).map_err(|error| caused("transport", error))?;
        if value["ok"] != true || value["service"] != "xharness-host" || value["state"] != "ready" {
            return Err(unavailable());
        }
        Ok(())
    }
}
// Keep the original typed cause available to the owning caller, while both
// Display and Debug deliberately redact URLs, headers and response bodies.
struct CarrierFailure {
    stage: &'static str,
    cause: Option<Box<dyn Error + Send + Sync>>,
}
impl fmt::Debug for CarrierFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CarrierFailure")
            .field("stage", &self.stage)
            .finish_non_exhaustive()
    }
}
impl fmt::Display for CarrierFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.stage)
    }
}
impl Error for CarrierFailure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.cause
            .as_ref()
            .map(|cause| cause.as_ref() as &(dyn Error + 'static))
    }
}
fn named(stage: &'static str) -> io::Error {
    io::Error::other(CarrierFailure { stage, cause: None })
}
fn caused(stage: &'static str, cause: impl Error + Send + Sync + 'static) -> io::Error {
    io::Error::other(CarrierFailure {
        stage,
        cause: Some(Box::new(cause)),
    })
}
fn unavailable() -> io::Error {
    named("protocol")
}
fn stage(error: &io::Error) -> &'static str {
    error
        .get_ref()
        .and_then(|source| source.downcast_ref::<CarrierFailure>())
        .map_or("carrier", |failure| failure.stage)
}
fn failure(error: &io::Error) -> Response {
    // Transport failure, NOT a fabricated RPC rejection/absence receipt. An
    // upstream may already have committed a timed-out mutation. Never retry or
    // route it to another Host here; preserve the client's original identity.
    (StatusCode::BAD_GATEWAY, Json(json!({"error":{
        "code":"environment_unavailable","stage":stage(error),"outcome":"unknown","retried":false,
    }}))).into_response()
}
fn record_failure(error: &io::Error) {
    xharness_diagnostics::record_failure(xharness_diagnostics::FailureCode::Rpc);
    xharness_diagnostics::diagnostic_stderr!(
        "personal environment carrier failure: {}",
        stage(error)
    );
}
async fn bounded(mut response: reqwest::Response, limit: usize) -> io::Result<Vec<u8>> {
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(named("payload_limit"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| caused("transport", error))?
    {
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err(named("payload_limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
pub(super) fn routes(upstream: Arc<Upstream>) -> Router {
    Router::new()
        .route("/api/events.mux", get(mux))
        .route("/api/events.host", get(host))
        .route("/api/{*endpoint}", any(forward))
        .route("/health/ready", get(health))
        .with_state(upstream)
        .layer(DefaultBodyLimit::max(LIMIT))
}
async fn health(State(upstream): State<Arc<Upstream>>) -> Response {
    if upstream.ready().await.is_ok() {
        (StatusCode::OK, Json(json!({"ok":true,"state":"ready"}))).into_response()
    } else {
        StatusCode::SERVICE_UNAVAILABLE.into_response()
    }
}
async fn forward(State(upstream): State<Arc<Upstream>>, request: Request) -> Response {
    match forward_once(&upstream, request).await {
        Ok(response) => response,
        Err(error) => {
            record_failure(&error);
            failure(&error)
        }
    }
}
async fn forward_once(upstream: &Upstream, request: Request) -> io::Result<Response> {
    let (parts, body) = request.into_parts();
    if parts.method != axum::http::Method::POST
        && parts.method != axum::http::Method::GET
        && parts.method != axum::http::Method::HEAD
    {
        return Ok(StatusCode::METHOD_NOT_ALLOWED.into_response());
    }
    let path = parts.uri.path_and_query().ok_or_else(unavailable)?.as_str();
    let target = upstream
        .url
        .join(path)
        .map_err(|error| caused("transport", error))?;
    // Browser-supplied paths cannot change scheme/authority or escape /api/.
    if target.origin() != upstream.url.origin() || !target.path().starts_with("/api/") {
        return Err(unavailable());
    }
    let bytes = to_bytes(body, LIMIT)
        .await
        .map_err(|error| caused("transport", error))?;
    upstream.identity().await?;
    let mut builder = upstream
        .client
        .request(parts.method, target)
        .header("x-xharness-desktop-token", upstream.credential()?)
        .body(bytes);
    if let Some(content_type) = parts.headers.get(header::CONTENT_TYPE) {
        builder = builder.header(header::CONTENT_TYPE, content_type);
    }
    let response = builder
        .send()
        .await
        .map_err(|error| caused("transport", error))?;
    let status = response.status();
    let mut headers = HeaderMap::new();
    for name in [header::CONTENT_TYPE, header::CONTENT_DISPOSITION] {
        if let Some(value) = response.headers().get(&name) {
            headers.insert(name, value.clone());
        }
    }
    let bytes = bounded(response, LIMIT).await?;
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    Ok(response)
}
async fn mux(State(upstream): State<Arc<Upstream>>, ws: WebSocketUpgrade) -> Response {
    upgrade(upstream, ws, "/api/events.mux").await
}
async fn host(State(upstream): State<Arc<Upstream>>, ws: WebSocketUpgrade) -> Response {
    upgrade(upstream, ws, "/api/events.host").await
}
async fn upgrade(upstream: Arc<Upstream>, ws: WebSocketUpgrade, path: &'static str) -> Response {
    // Authenticate/connect the exact target BEFORE acknowledging this downlink.
    let result = async {
        upstream.identity().await?;
        let mut url = upstream
            .url
            .join(path)
            .map_err(|error| caused("transport", error))?;
        url.set_scheme("ws").map_err(|()| named("stream_target"))?;
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|error| caused("transport", error))?;
        request
            .headers_mut()
            .insert("x-xharness-desktop-token", upstream.credential()?);
        let config = WebSocketConfig::default()
            .max_message_size(Some(LIMIT))
            .max_frame_size(Some(LIMIT));
        let (peer, _) = tokio::time::timeout(
            DEADLINE,
            tokio_tungstenite::connect_async_with_config(request, Some(config), true),
        )
        .await
        .map_err(|error| caused("transport", error))?
        .map_err(|error| caused("transport", error))?;
        Ok::<_, io::Error>(peer)
    }
    .await;
    match result {
        Ok(peer) => ws
            .max_message_size(LIMIT)
            .on_upgrade(move |socket| bridge(socket, peer, upstream.stop.clone())),
        Err(error) => {
            record_failure(&error);
            failure(&error)
        }
    }
}
async fn bridge(
    mut browser: WebSocket,
    mut peer: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    stop: tokio_util::sync::CancellationToken,
) {
    #[derive(PartialEq, Eq)]
    enum Ended {
        Browser,
        Peer,
        Cancelled,
    }
    let pump = async {
        loop {
            tokio::select! {
                item = peer.next() => match item {
                    Some(Ok(PeerMessage::Text(text))) => browser.send(Message::Text(text.to_string().into())).await.map_err(|error|caused("browser_write",error))?,
                    Some(Ok(PeerMessage::Ping(bytes))) => peer.send(PeerMessage::Pong(bytes)).await.map_err(|error|caused("stream_write",error))?,
                    Some(Ok(PeerMessage::Pong(_))) => {},
                    Some(Ok(PeerMessage::Close(_))) | None => return Ok::<_,io::Error>(Ended::Peer),
                    Some(Err(error)) => return Err(caused("stream_read",error)),
                    _ => return Err(named("stream_frame")),
                },
                item = browser.recv() => match item {
                    Some(Ok(Message::Close(_))) | None => return Ok(Ended::Browser),
                    Some(Ok(Message::Ping(bytes))) => browser.send(Message::Pong(bytes)).await.map_err(|error|caused("browser_write",error))?,
                    Some(Ok(Message::Pong(_))) => {},
                    Some(Err(error)) => return Err(caused("browser_read",error)),
                    // Strictly downlink-only: no undocumented command channel.
                    _ => return Err(named("browser_frame")),
                },
            }
        }
    };
    // Cancellation covers blocked writes too, not only waiting for the next frame.
    let result =
        tokio::select! { () = stop.cancelled() => Ok(Ended::Cancelled), result = pump => result };
    let mut failures = Vec::new();
    let ended = match result {
        Ok(ended) => Some(ended),
        Err(error) => {
            failures.push(error);
            None
        }
    };
    let close_peer = async {
        if ended == Some(Ended::Peer) {
            peer.flush().await
        } else {
            peer.close(Some(CloseFrame {
                code: CloseCode::Normal,
                reason: "carrier closed".into(),
            }))
            .await
        }
    };
    match tokio::time::timeout(Duration::from_secs(1), close_peer).await {
        Ok(Ok(()))
        | Ok(Err(
            tokio_tungstenite::tungstenite::Error::ConnectionClosed
            | tokio_tungstenite::tungstenite::Error::AlreadyClosed,
        )) => {}
        Ok(Err(error)) => failures.push(caused("stream_close", error)),
        Err(error) => failures.push(caused("stream_close_timeout", error)),
    }
    // An acknowledged browser close is not an error or a second failed close.
    if ended != Some(Ended::Browser) {
        match tokio::time::timeout(Duration::from_secs(1), browser.send(Message::Close(None))).await
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => failures.push(caused("browser_close", error)),
            Err(error) => failures.push(caused("browser_close_timeout", error)),
        }
    }
    // One owning boundary observes every outcome, without duplicate failure
    // events, payload logging, or inventing an Agent operation receipt.
    if let Some(error) = failures.first() {
        record_failure(error);
    }
}

#[cfg(test)]
mod error_tests {
    use super::*;
    #[test]
    fn original_typed_cause_survives_but_display_and_debug_do_not_log_it() {
        let error = caused(
            "identity_transport",
            io::Error::other("fixture-private-payload-or-url"),
        );
        assert_eq!(stage(&error), "identity_transport");
        assert!(!format!("{error} {error:?}").contains("fixture-private"));
        assert!(error
            .get_ref()
            .unwrap()
            .source()
            .unwrap()
            .downcast_ref::<io::Error>()
            .is_some());
    }
}

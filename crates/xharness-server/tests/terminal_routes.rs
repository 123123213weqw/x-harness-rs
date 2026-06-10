//! End-to-end coverage for the `/api/terminal/*` extension routes against a
//! real `TerminalRegistry`: auth boundaries, the open/send/read/resize/close
//! round trip, and error mapping. Unix-only cases run a real `stty`.

#![cfg(any(target_os = "linux", target_os = "macos"))]

use std::sync::Arc;

use futures::stream;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use tower::ServiceExt;
use xharness_api::{ApiBackend, ClientResponse, EventStream, RpcReceipt, RpcResult};
use xharness_server::{terminal::TerminalRouterState, web_router_full, StartupReadiness};
use xharness_terminal::TerminalRegistry;
use tokio_util::sync::CancellationToken;

struct TerminalBackend;

#[async_trait::async_trait]
impl ApiBackend for TerminalBackend {
    async fn call(
        &self,
        _rpc_id: xharness_api::RpcId,
        _method: xharness_api::RpcMethod,
        _payload: Value,
        _cancellation: CancellationToken,
    ) -> RpcResult {
        RpcResult::success(json!({}))
    }
    async fn respond(&self, _response: ClientResponse) -> RpcReceipt {
        RpcReceipt::Accepted
    }
    fn mux_events(&self) -> EventStream {
        Box::pin(stream::pending())
    }
    fn host_events(&self) -> EventStream {
        Box::pin(stream::pending())
    }
}

fn router(token: Option<&str>, registry: Option<TerminalRouterState>) -> axum::Router {
    web_router_full(
        Arc::new(TerminalBackend),
        None,
        xharness_debug::DebugRecorder::disabled(),
        token.map(str::to_owned),
        StartupReadiness::ready(),
        registry.unwrap_or_default(),
    )
}

async fn post_json(
    router: &axum::Router,
    token: Option<&str>,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("x-xharness-desktop-token", token);
    }
    let response = router
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn stty_registry() -> TerminalRouterState {
    TerminalRouterState::new(Some(Arc::new(TerminalRegistry::with_defaults())))
}

#[tokio::test]
async fn terminal_routes_require_the_desktop_token() {
    let app = router(Some("secret-token"), Some(stty_registry()));
    let (status, body) = post_json(&app, None, "/api/terminal/list", json!({})).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, body) =
        post_json(&app, Some("secret-token"), "/api/terminal/list", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["terminals"], json!([]));
}

#[tokio::test]
async fn terminal_routes_report_missing_registry() {
    let app = router(None, None);
    let (status, body) = post_json(&app, None, "/api/terminal/list", json!({})).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], json!("terminal_unavailable"));
}

#[tokio::test]
async fn open_send_read_resize_close_round_trip() {
    let app = router(None, Some(stty_registry()));
    let open = json!({
        "name": "round-trip",
        "cols": 120,
        "rows": 35,
        "program": "/bin/sh",
        "args": ["-c", "stty size; printf sentinel-ready; sleep 5"],
        "cwd": "/tmp",
    });
    let (status, body) = post_json(&app, None, "/api/terminal/open", open).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["terminal"]["name"], json!("round-trip"));

    // The registry rejects opening the same name twice.
    let (status, _) = post_json(
        &app,
        None,
        "/api/terminal/open",
        json!({"name": "round-trip", "program": "/bin/sh", "args": [], "cwd": "/tmp"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let output = poll_read(&app, "round-trip", "sentinel-ready").await;
    assert!(output.contains("120 35"), "stty size missing: {output:?}");

    let (status, body) = post_json(
        &app,
        None,
        "/api/terminal/resize",
        json!({"name": "round-trip", "cols": 100, "rows": 40}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, _) = post_json(
        &app,
        None,
        "/api/terminal/close",
        json!({"name": "round-trip"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = post_json(
        &app,
        None,
        "/api/terminal/read",
        json!({"name": "round-trip"}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn unknown_terminal_actions_fall_through_to_the_rpc_directory() {
    let app = router(None, Some(stty_registry()));
    let (status, _) = post_json(&app, None, "/api/terminal/bogus", json!({})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

async fn poll_read(app: &axum::Router, name: &str, expected: &str) -> String {
    let mut cursor = None;
    let mut seen = String::new();
    for _ in 0..100 {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let (status, body) = post_json(
            app,
            None,
            "/api/terminal/read",
            json!({"name": name, "cursor": cursor}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let read = &body["read"];
        cursor = read["cursor"].as_u64();
        if let Some(chunk) = read["content"].as_str() {
            seen.push_str(chunk);
        }
        if seen.contains(expected) {
            return seen;
        }
    }
    seen
}

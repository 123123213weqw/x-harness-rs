//! Route-level coverage for `/api/terminal/*` against a real registry. Auth
//! layering for extension routers is covered by `xharness-server`'s
//! extension-router tests; here the routes are exercised directly.

#![cfg(any(target_os = "linux", target_os = "macos"))]

use std::sync::Arc;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use tower::ServiceExt;
use xharness_terminal::TerminalRegistry;
use xharness_web_terminal::{terminal_routes, TerminalRouterState};

fn app(registry: Option<TerminalRouterState>) -> axum::Router {
    terminal_routes(registry.unwrap_or_default())
}

async fn post_json(router: &axum::Router, path: &str, body: Value) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn terminal_routes_report_missing_registry() {
    let (status, body) = post_json(&app(None), "/api/terminal/list", json!({})).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], json!("terminal_unavailable"));
}

#[tokio::test]
async fn open_send_read_resize_close_round_trip() {
    let registry = Arc::new(TerminalRegistry::with_defaults());
    let router = app(Some(TerminalRouterState::new(Some(registry.clone()))));
    let open = json!({
        "name": "round-trip",
        "cols": 120,
        "rows": 35,
        "program": "/bin/sh",
        "args": ["-c", "stty size; printf sentinel-ready; sleep 5"],
        "cwd": "/tmp",
    });
    let (status, body) = post_json(&router, "/api/terminal/open", open).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["terminal"]["name"], json!("round-trip"));
    assert_eq!(body["terminal"]["running"], json!(true));

    let (status, _) = post_json(
        &router,
        "/api/terminal/open",
        json!({"name": "round-trip", "program": "/bin/sh", "args": [], "cwd": "/tmp"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let output = poll_read(&router, "round-trip", "sentinel-ready").await;
    assert!(output.contains("35 120"), "stty size missing: {output:?}");

    let (status, body) = post_json(
        &router,
        "/api/terminal/resize",
        json!({"name": "round-trip", "cols": 100, "rows": 40}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, body) = post_json(
        &router,
        "/api/terminal/signal",
        json!({"name": "round-trip", "signal": "terminate"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, _) = post_json(
        &router,
        "/api/terminal/close",
        json!({"name": "round-trip"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = post_json(&router, "/api/terminal/read", json!({"name": "round-trip"})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let report = registry.shutdown().await;
    assert!(report.is_graceful(), "{report:?}");
}

async fn poll_read(router: &axum::Router, name: &str, expected: &str) -> String {
    let mut cursor = None;
    let mut seen = String::new();
    for _ in 0..100 {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let (status, body) = post_json(
            router,
            "/api/terminal/read",
            json!({"name": name, "cursor": cursor}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let read = &body["read"];
        cursor = read["cursor"].as_u64();
        if let Some(encoded) = read["content_base64"].as_str() {
            let chunk = STANDARD.decode(encoded).unwrap();
            seen.push_str(&String::from_utf8_lossy(&chunk));
        }
        if seen.contains(expected) {
            return seen;
        }
    }
    seen
}

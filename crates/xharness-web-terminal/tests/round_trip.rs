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

#[tokio::test]
async fn repeated_terminate_then_immediate_close_is_safe() {
    let registry = Arc::new(TerminalRegistry::with_defaults());
    let router = app(Some(TerminalRouterState::new(Some(registry.clone()))));
    for iteration in 0..32 {
        let name = format!("signal-close-{iteration}");
        let (status, body) = post_json(
            &router,
            "/api/terminal/open",
            json!({
                "name": name,
                "program": "/bin/sh",
                "args": ["-c", "printf signal-close-ready; exec sleep 10"],
                "cwd": "/tmp",
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "iteration {iteration}: {body}");
        let output = poll_read(&router, &name, "signal-close-ready").await;
        assert!(output.contains("signal-close-ready"), "{output:?}");

        let (status, body) = post_json(
            &router,
            "/api/terminal/signal",
            json!({"name": name, "signal": "terminate"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "iteration {iteration}: {body}");
        // Do not yield intentionally between signalling the live child and
        // closing it: close resolves the PTY group again as the child exits.
        let (status, body) = post_json(&router, "/api/terminal/close", json!({"name": name})).await;
        assert_eq!(status, StatusCode::OK, "iteration {iteration}: {body}");
        assert_eq!(body["read"]["running"], json!(false), "{body}");
        let (status, body) = post_json(&router, "/api/terminal/read", json!({"name": name})).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        let (status, body) = post_json(&router, "/api/terminal/list", json!({})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["terminals"], json!([]), "{body}");
    }
    let report = registry.shutdown().await;
    assert!(report.is_graceful(), "{report:?}");
    assert_eq!(report.sessions, 0);
}

#[tokio::test]
async fn terminal_sessions_are_isolated_across_conversations() {
    let registry = Arc::new(TerminalRegistry::with_defaults());
    let router = app(Some(TerminalRouterState::new(Some(registry.clone()))));
    for session_id in ["chat-a", "chat-b"] {
        let (status, body) = post_json(
            &router,
            "/api/terminal/open",
            json!({
                "session_id": session_id,
                "name": "t1",
                "program": "/bin/sh",
                "args": ["-c", "sleep 10"],
                "cwd": "/tmp",
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    for session_id in ["chat-a", "chat-b"] {
        let (status, body) = post_json(
            &router,
            "/api/terminal/list",
            json!({"session_id": session_id}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["terminals"].as_array().unwrap().len(), 1);
        assert_eq!(body["terminals"][0]["name"], "t1");
    }
    let (status, body) = post_json(&router, "/api/terminal/list", json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["terminals"].as_array().unwrap().len(), 0);

    let (status, body) = post_json(
        &router,
        "/api/terminal/close",
        json!({"session_id": "chat-a", "name": "t1"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = post_json(
        &router,
        "/api/terminal/read",
        json!({"session_id": "chat-b", "name": "t1"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["read"]["running"].as_bool().unwrap());

    let (status, body) = post_json(&router, "/api/terminal/list", json!({"session_id": ""})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["code"], "invalid_session_id");
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

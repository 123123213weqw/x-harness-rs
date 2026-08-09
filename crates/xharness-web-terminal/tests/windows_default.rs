#![cfg(windows)]

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tower::ServiceExt;
use xharness_terminal::TerminalRegistry;
use xharness_web_terminal::{terminal_routes, TerminalRouterState};

async fn post(app: &axum::Router, path: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

/// The second Windows CI pass pins XHARNESS_SHELL to the built-in 5.1 executable.
/// This is a real ConPTY/HTTP route, not a fake terminal or native-input test.
#[tokio::test]
async fn default_windows_terminal_opens_accepts_input_and_closes() {
    let registry = Arc::new(TerminalRegistry::with_defaults());
    let app = terminal_routes(TerminalRouterState::new(Some(registry.clone())));
    let (status, body) = post(
        &app,
        "/api/terminal/open",
        json!({"name":"default","session_id":"shell-test","cwd":std::env::temp_dir()}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = post(&app, "/api/terminal/send", json!({"name":"default","session_id":"shell-test","input":"[Console]::Out.Write(('terminal-51-' + 'ready')); [Console]::Out.Flush()\r\n"})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut output = String::new();
    let observed = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let (status, body) = post(
                &app,
                "/api/terminal/read",
                json!({"name":"default","session_id":"shell-test"}),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{body}");
            let bytes = STANDARD
                .decode(body["read"]["content_base64"].as_str().unwrap())
                .unwrap();
            output.push_str(&String::from_utf8_lossy(&bytes));
            // The input constructs the marker from two strings, so echo alone
            // cannot satisfy this assertion.
            if output.contains("terminal-51-ready") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    let (status, body) = post(
        &app,
        "/api/terminal/close",
        json!({"name":"default","session_id":"shell-test"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let report = registry.shutdown().await;
    assert!(report.is_graceful(), "{report:?}");
    assert!(
        observed.is_ok(),
        "terminal did not execute input: {output:?}"
    );
}

//! Explicit, short-lived server acceptance endpoint. No production Host or keys.
use super::*;
use std::sync::Arc;
use xharness_tools::{ToolExecutor, ToolRegistry, ToolRequest};

#[tokio::test]
#[ignore = "explicit isolated server browser contract A/B; requires owned fixture bridge"]
async fn serve_browser_contract_evaluation() {
    assert_eq!(
        std::env::var("XHARNESS_BROWSER_TEST_SERVER").as_deref(),
        Ok("1")
    );
    let address = std::env::var("XHARNESS_BROWSER_EVAL_BRIDGE").unwrap();
    let token = std::env::var("XHARNESS_BROWSER_EVAL_AUTH").unwrap();
    assert!(token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()));
    let native = Arc::new(
        NativeBrowser::configuration(Some(address), Some(token.clone()))
            .unwrap()
            .unwrap(),
    );
    let owner = std::env::var("XHARNESS_BROWSER_EVAL_OWNER").unwrap();
    let binding = crate::plugin_mcp::bind(None, None, Some(native), None, owner, true, None);
    let registry = Arc::new(ToolRegistry::new());
    registry.register(binding.spec).await.unwrap();
    for spec in binding.native_specs {
        registry.register(spec).await.unwrap();
    } // candidate-only registrations
    let executor = ToolExecutor::new(registry.clone()).with_guards(vec![binding.guard]);
    let stop = CancellationToken::new();
    let (auth_a, auth_b, auth_c) = (token.clone(), token.clone(), token.clone());
    let shutdown = stop.clone();
    let routes = axum::Router::new()
        .route(
            "/definitions",
            axum::routing::get(move |headers: axum::http::HeaderMap| {
                let registry = registry.clone();
                let auth = auth_a.clone();
                async move {
                    if headers.get("x-eval-token").and_then(|v| v.to_str().ok())
                        != Some(auth.as_str())
                    {
                        return (
                            axum::http::StatusCode::UNAUTHORIZED,
                            axum::Json(json!({"error":"unauthorized"})),
                        );
                    }
                    (
                        axum::http::StatusCode::OK,
                        axum::Json(json!(registry.definitions().await)),
                    )
                }
            }),
        )
        .route(
            "/call",
            axum::routing::post(
                move |headers: axum::http::HeaderMap, axum::Json(request): axum::Json<Value>| {
                    let executor = executor.clone();
                    let auth = auth_b.clone();
                    async move {
                        if headers.get("x-eval-token").and_then(|v| v.to_str().ok())
                            != Some(auth.as_str())
                        {
                            return (
                                axum::http::StatusCode::UNAUTHORIZED,
                                axum::Json(json!({"error":"unauthorized"})),
                            );
                        }
                        let name = request["name"].as_str().unwrap_or_default();
                        let args = request["arguments"].to_string();
                        let result = executor.execute(ToolRequest::new(name, args)).await;
                        (axum::http::StatusCode::OK, axum::Json(json!(result)))
                    }
                },
            ),
        )
        .route(
            "/shutdown",
            axum::routing::post(move |headers: axum::http::HeaderMap| {
                let stop = shutdown.clone();
                let auth = auth_c.clone();
                async move {
                    if headers.get("x-eval-token").and_then(|v| v.to_str().ok())
                        != Some(auth.as_str())
                    {
                        return axum::http::StatusCode::UNAUTHORIZED;
                    }
                    stop.cancel();
                    axum::http::StatusCode::OK
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    std::fs::write(
        std::env::var("XHARNESS_BROWSER_EVAL_PORT_FILE").unwrap(),
        listener.local_addr().unwrap().port().to_string(),
    )
    .unwrap();
    axum::serve(listener,routes).with_graceful_shutdown(async move{tokio::select!{_=stop.cancelled()=>{},_=tokio::time::sleep(Duration::from_secs(1800))=>{}}}).await.unwrap();
}

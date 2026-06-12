//! Extension routers merged via `web_router_full` must sit inside the same
//! desktop-token boundary as the frozen `/api` surface, while unknown
//! extension paths still fall through to the RPC directory's 404.

use std::sync::Arc;

use axum::{
    body::Body,
    http::{Request, StatusCode},
    routing::post,
    Json, Router,
};
use futures::stream;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;
use xharness_api::{
    ApiBackend, ClientResponse, EventStream, RpcId, RpcMethod, RpcReceipt, RpcResult,
};
use xharness_server::{web_router_full, StartupReadiness};

struct FixtureBackend;

#[async_trait::async_trait]
impl ApiBackend for FixtureBackend {
    async fn call(
        &self,
        _rpc_id: RpcId,
        _method: RpcMethod,
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

fn extension() -> Router {
    Router::new().route(
        "/api/extension/echo",
        post(|| async { Json(json!({"ok": true, "surface": "extension"})) }),
    )
}

#[tokio::test]
async fn extension_router_shares_the_desktop_token_boundary() {
    let app = web_router_full(
        Arc::new(FixtureBackend),
        None,
        xharness_debug::DebugRecorder::disabled(),
        Some("secret-token".to_owned()),
        StartupReadiness::ready(),
        extension(),
    );
    let request = Request::builder()
        .method("POST")
        .uri("/api/extension/echo")
        .header("content-type", "application/json")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let request = Request::builder()
        .method("POST")
        .uri("/api/extension/echo")
        .header("content-type", "application/json")
        .header("x-xharness-desktop-token", "secret-token")
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn unknown_extension_paths_stay_at_the_transport_404() {
    let app = web_router_full(
        Arc::new(FixtureBackend),
        None,
        xharness_debug::DebugRecorder::disabled(),
        None,
        StartupReadiness::ready(),
        extension(),
    );
    let request = Request::builder()
        .method("POST")
        .uri("/api/extension/bogus")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "type": "client-request",
                "rpcId": "missing-extension",
                "method": "extension/bogus",
                "payload": {},
            })
            .to_string(),
        ))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

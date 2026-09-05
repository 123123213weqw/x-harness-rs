use std::sync::Arc;

use async_trait::async_trait;
use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use futures::{stream, SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::{net::TcpListener, sync::oneshot};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Error as WebSocketError, Message},
};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;
use xharness_api::{
    ApiBackend, ClientResponse, EventStream, MuxFrame, ReceiptRejection, RpcError, RpcErrorCode,
    RpcId, RpcMethod, RpcReceipt, RpcResult, SessionExport,
};
use xharness_debug::{DebugRecorder, MemoryDebugSink};
use xharness_server::{
    api_router, api_router_with_debug, serve, web_router_with_debug_and_desktop_token,
};

struct FixtureBackend;

#[async_trait]
impl ApiBackend for FixtureBackend {
    async fn call(
        &self,
        _rpc_id: RpcId,
        method: RpcMethod,
        payload: Value,
        _cancellation: CancellationToken,
    ) -> RpcResult {
        RpcResult::success(json!({"method": method.as_str(), "payload": payload}))
    }

    async fn call_dynamic(
        &self,
        _rpc_id: RpcId,
        endpoint: &str,
        payload: Value,
        _cancellation: CancellationToken,
    ) -> Option<RpcResult> {
        (endpoint == "commands/list")
            .then(|| RpcResult::success(json!({"endpoint": endpoint, "payload": payload})))
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

    async fn export_session(
        &self,
        session_id: &str,
        _cancellation: CancellationToken,
    ) -> Result<SessionExport, RpcError> {
        if session_id == "s" {
            Ok(SessionExport::json(
                "s.json",
                br#"{"sessionId":"s"}"#.to_vec(),
            ))
        } else {
            Err(RpcError {
                code: RpcErrorCode::SessionNotFound,
                message: "missing session".to_owned(),
                details: json!({"sessionId": session_id}),
            })
        }
    }
}

fn post(path: &str, value: Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .body(Body::from(serde_json::to_vec(&value).unwrap()))
        .unwrap()
}

async fn json_body(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn every_upstream_method_has_one_post_route() {
    for method in RpcMethod::ALL {
        let response = api_router(Arc::new(FixtureBackend))
            .oneshot(post(
                &format!("/api/{}", method.as_str()),
                json!({
                    "type": "client-request",
                    "rpcId": format!("id-{}", method.as_str()),
                    "method": method.as_str(),
                    "payload": {}
                }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{}", method.as_str());
        let body = json_body(response).await;
        assert_eq!(body["type"], "server-response");
        assert_eq!(body["result"]["ok"], true);
        assert_eq!(body["result"]["value"]["method"], method.as_str());
    }
}

#[tokio::test]
async fn generated_remote_endpoint_uses_two_segment_route_without_widening_rpc_directory() {
    let response = api_router(Arc::new(FixtureBackend))
        .oneshot(post(
            "/api/commands/list",
            json!({
                "type": "client-request",
                "rpcId": "dynamic-1",
                "method": "commands/list",
                "payload": {"args": {"agentId": "session"}}
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = json_body(response).await;
    assert_eq!(body["result"]["ok"], true);
    assert_eq!(body["result"]["value"]["endpoint"], "commands/list");
}

#[tokio::test]
async fn carrier_status_and_business_error_boundaries_match() {
    let router = api_router(Arc::new(FixtureBackend));
    let unknown = router
        .clone()
        .oneshot(post(
            "/api/not.real",
            json!({"type":"client-request","rpcId":"1","method":"not.real","payload":{}}),
        ))
        .await
        .unwrap();
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);

    let wrong_media = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/session.list")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(wrong_media.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);

    let mismatch = router
        .clone()
        .oneshot(post(
            "/api/session.list",
            json!({"type":"client-request","rpcId":"same","method":"session.create","payload":{}}),
        ))
        .await
        .unwrap();
    assert_eq!(mismatch.status(), StatusCode::OK);
    let body = json_body(mismatch).await;
    assert_eq!(body["rpcId"], "same");
    assert_eq!(body["result"]["ok"], false);
    assert_eq!(body["result"]["error"]["code"], "bad-request");
}

#[tokio::test]
async fn full_debug_records_rpc_request_and_response_envelopes() {
    let sink = Arc::new(MemoryDebugSink::default());
    let router = api_router_with_debug(Arc::new(FixtureBackend), DebugRecorder::new(sink.clone()));
    let response = router
        .oneshot(post(
            "/api/session.list",
            json!({
                "type": "client-request",
                "rpcId": "debug-rpc",
                "method": "session.list",
                "payload": {"visible": true}
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let events = sink.events().await;
    assert!(events.iter().any(|event| {
        event.event == "rpc.request" && event.payload["body"]["rpcId"] == "debug-rpc"
    }));
    assert!(events
        .iter()
        .any(|event| { event.event == "rpc.response" && event.payload["rpcId"] == "debug-rpc" }));
}

#[tokio::test]
async fn desktop_token_bootstrap_protects_api_but_not_readiness() {
    let router = web_router_with_debug_and_desktop_token(
        Arc::new(FixtureBackend),
        None,
        DebugRecorder::disabled(),
        Some("launch-secret".to_owned()),
    );

    let readiness = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/health/ready")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(readiness.status(), StatusCode::OK);

    let denied = router
        .clone()
        .oneshot(post(
            "/api/session.list",
            json!({
                "type": "client-request",
                "rpcId": "desktop-denied",
                "method": "session.list",
                "payload": {}
            }),
        ))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

    let bad_bootstrap = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/desktop/bootstrap?token=wrong")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(bad_bootstrap.status(), StatusCode::UNAUTHORIZED);

    let bootstrap = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/desktop/bootstrap?token=launch-secret")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(bootstrap.status(), StatusCode::SEE_OTHER);
    assert_eq!(bootstrap.headers()[header::LOCATION], "/");
    let cookie = bootstrap.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();

    let mut authorized = post(
        "/api/session.list",
        json!({
            "type": "client-request",
            "rpcId": "desktop-authorized",
            "method": "session.list",
            "payload": {}
        }),
    );
    authorized
        .headers_mut()
        .insert(header::COOKIE, cookie.parse().unwrap());
    let accepted = router.clone().oneshot(authorized).await.unwrap();
    assert_eq!(accepted.status(), StatusCode::OK);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let server = tokio::spawn(serve(listener, router, async move {
        let _ = stop_rx.await;
    }));
    let denied_socket = connect_async(format!("ws://{address}/api/events.host"))
        .await
        .unwrap_err();
    assert!(matches!(
        denied_socket,
        WebSocketError::Http(response) if response.status() == StatusCode::UNAUTHORIZED
    ));

    let mut socket_request = format!("ws://{address}/api/events.host")
        .into_client_request()
        .unwrap();
    socket_request
        .headers_mut()
        .insert(header::COOKIE, cookie.parse().unwrap());
    let (socket, _) = connect_async(socket_request).await.unwrap();
    drop(socket);
    let _ = stop_tx.send(());
    server.await.unwrap().unwrap();
}

#[tokio::test]
async fn respond_and_websocket_paths_match_the_upstream_carrier() {
    let router = api_router(Arc::new(FixtureBackend));
    let receipt = router
        .clone()
        .oneshot(post(
            "/api/respond",
            json!({
                "type": "client-response", "rpcId": "approval-1",
                "result": {"ok": true, "value": {"approved": true}}
            }),
        ))
        .await
        .unwrap();
    assert_eq!(json_body(receipt).await, json!({"accepted": true}));

    let bad = router
        .clone()
        .oneshot(post("/api/respond", json!({"no": "envelope"})))
        .await
        .unwrap();
    assert_eq!(
        json_body(bad).await,
        serde_json::to_value(RpcReceipt::Rejected {
            reason: ReceiptRejection::BadResponse
        })
        .unwrap()
    );

    for path in ["/api/events.mux", "/api/events.host"] {
        let response = router
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_ne!(response.status(), StatusCode::NOT_FOUND);
    }

    let export = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/session.export?sessionId=s")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(export.status(), StatusCode::OK);
    assert!(export.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .starts_with("application/json"));
    assert_eq!(
        to_bytes(export.into_body(), 1024).await.unwrap(),
        br#"{"sessionId":"s"}"#.as_slice()
    );

    let missing = router
        .oneshot(
            Request::builder()
                .uri("/api/session.export?sessionId=missing")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
}

struct WebSocketBackend;

#[async_trait]
impl ApiBackend for WebSocketBackend {
    async fn call(
        &self,
        _rpc_id: RpcId,
        method: RpcMethod,
        _payload: Value,
        _cancellation: CancellationToken,
    ) -> RpcResult {
        RpcResult::unavailable(method)
    }

    async fn respond(&self, _response: ClientResponse) -> RpcReceipt {
        RpcReceipt::Rejected {
            reason: ReceiptRejection::NotPending,
        }
    }

    fn mux_events(&self) -> EventStream {
        let frame = MuxFrame::SessionSubscribed {
            session_id: "live".into(),
            last_seq: 7,
        }
        .into_server_request(RpcId::new("push-1"));
        Box::pin(stream::iter([frame]).chain(stream::pending()))
    }

    fn host_events(&self) -> EventStream {
        Box::pin(stream::pending())
    }
}

#[tokio::test]
async fn mux_websocket_is_a_real_downlink_only_server_request_stream() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let server = tokio::spawn(serve(
        listener,
        api_router(Arc::new(WebSocketBackend)),
        async move {
            let _ = shutdown_rx.await;
        },
    ));

    let (mut socket, _) = connect_async(format!("ws://{address}/api/events.mux"))
        .await
        .unwrap();
    let message = socket.next().await.unwrap().unwrap();
    let Message::Text(text) = message else {
        panic!("expected text frame")
    };
    let frame: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(frame["type"], "server-request");
    assert_eq!(frame["rpcId"], "push-1");
    assert_eq!(frame["method"], "session/subscribed");
    assert_eq!(frame["payload"]["lastSeq"], 7);

    socket
        .send(Message::Text("upstream-forbidden".into()))
        .await
        .unwrap();
    assert!(matches!(
        socket.next().await,
        Some(Ok(Message::Close(_))) | None
    ));

    let _ = shutdown_tx.send(());
    server.await.unwrap().unwrap();
}

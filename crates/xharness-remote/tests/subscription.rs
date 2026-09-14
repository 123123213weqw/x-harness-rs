use async_trait::async_trait;
use futures::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use xharness_api::{
    ApiBackend, ClientResponse, EventStream, RpcError, RpcId, RpcMethod, RpcReceipt, RpcResult,
    ServerRequest,
};
use xharness_remote::*;
struct Host {
    frames: broadcast::Sender<ServerRequest>,
    scope: AtomicBool,
    unavailable: bool,
}
impl Host {
    fn new(unavailable: bool) -> Self {
        Self {
            frames: broadcast::channel(4).0,
            scope: AtomicBool::new(true),
            unavailable,
        }
    }
}
#[async_trait]
impl ApiBackend for Host {
    async fn call(&self, _: RpcId, _: RpcMethod, _: Value, _: CancellationToken) -> RpcResult {
        panic!("stream must not dispatch a task")
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("stream must not respond")
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
        Ok(w == "w" && s == "s" && self.scope.load(Ordering::SeqCst))
    }
    async fn session_events(&self, w: &str, s: &str) -> Result<EventStream, RpcError> {
        assert_eq!((w, s), ("w", "s"));
        if self.unavailable {
            return Err(RpcError::internal("unavailable"));
        }
        let mut receiver = self.frames.subscribe();
        Ok(Box::pin(async_stream::stream! {
            yield frame("session/subscribed","s");
            loop { match receiver.recv().await {
                Ok(frame) => yield frame,
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    yield ServerRequest::new(RpcId::new("gap"),"stream/error",json!({"type":"stream/error","error":{"code":"internal","message":"other-session-secret","details":{"private":"diagnostics"}}}));
                },
                Err(_) => break,
            }}
        }))
    }
    fn mux_events(&self) -> EventStream {
        panic!("must never use all-session fallback")
    }
    fn host_events(&self) -> EventStream {
        panic!("must never use host events fallback")
    }
}
fn frame(kind: &str, s: &str) -> ServerRequest {
    ServerRequest::new(
        RpcId::new("frame"),
        kind,
        json!({"type":kind,"sessionId":s,"lastSeq":0,"items":[],"unexpected":"must-drop"}),
    )
}
fn principal() -> Principal {
    Principal {
        id: "p".into(),
        host: "h".into(),
        sender: sender(),
        workspaces: BTreeSet::from(["w".into()]),
        sessions: BTreeSet::from(["s".into()]),
        revision: 1,
        revoked: false,
    }
}
fn sender() -> Sender {
    Sender {
        channel: Channel::MobileWeb,
        account: "relay".into(),
        user: "controller".into(),
    }
}
fn binding() -> Binding {
    Binding {
        id: "b".into(),
        principal: "p".into(),
        conversation: "c".into(),
        workspace: "w".into(),
        session: "s".into(),
        generation: 1,
    }
}
fn request() -> Subscription {
    Subscription {
        principal: "p".into(),
        sender: sender(),
        conversation: "c".into(),
        binding: "b".into(),
        generation: 1,
    }
}
async fn setup(host: Arc<Host>) -> (tempfile::TempDir, Arc<Gateway>) {
    let temp = tempfile::tempdir().unwrap();
    let g = Gateway::open(temp.path(), "h".into(), host).unwrap();
    g.set_principal(principal()).await.unwrap();
    g.bind(binding()).await.unwrap();
    (temp, g)
}
async fn next(stream: &mut RemoteEventStream) -> Option<Result<ServerRequest, Error>> {
    tokio::time::timeout(Duration::from_secs(3), stream.next())
        .await
        .unwrap()
}
#[tokio::test]
async fn scoped_stream_preserves_correlation_and_drops_unknown_outer_payload_fields() {
    let host = Arc::new(Host::new(false));
    let (_temp, g) = setup(host.clone()).await;
    let mut stream = g
        .subscribe(request(), CancellationToken::new())
        .await
        .unwrap();
    let baseline = next(&mut stream).await.unwrap().unwrap();
    assert_eq!(baseline.payload["sessionId"], "s");
    assert!(baseline.payload.get("unexpected").is_none());
    host.frames.send(frame("session/queue", "s")).unwrap();
    let received = next(&mut stream).await.unwrap().unwrap();
    assert_eq!(received.rpc_id.as_str(), "frame");
    assert_eq!(received.method, "session/queue");
    host.frames.send(ServerRequest::new(RpcId::new("question-id"), "question/requested",
        json!({"type":"question/requested","sessionId":"s","questions":[],"deferred":true,"waitTimeoutSeconds":60,"unexpected":"drop"}))).unwrap();
    let question = next(&mut stream).await.unwrap().unwrap();
    assert_eq!(question.rpc_id.as_str(), "question-id");
    assert_eq!(question.payload["deferred"], true);
    assert_eq!(question.payload["waitTimeoutSeconds"], 60);
    assert!(question.payload.get("unexpected").is_none());
}
#[tokio::test]
async fn idle_revoke_closes_stream_without_waiting_for_host_event() {
    let host = Arc::new(Host::new(false));
    let (_temp, g) = setup(host).await;
    let mut stream = g
        .subscribe(request(), CancellationToken::new())
        .await
        .unwrap();
    next(&mut stream).await.unwrap().unwrap();
    g.revoke("p").await.unwrap();
    assert!(matches!(
        next(&mut stream).await,
        Some(Err(Error::Unauthorized))
    ));
    assert!(next(&mut stream).await.is_none());
}
#[tokio::test]
async fn rebind_and_permission_revision_fence_existing_streams() {
    let host = Arc::new(Host::new(false));
    let (_temp, g) = setup(host).await;
    let mut stream = g
        .subscribe(request(), CancellationToken::new())
        .await
        .unwrap();
    next(&mut stream).await.unwrap().unwrap();
    let mut b = binding();
    b.generation = 2;
    g.bind(b).await.unwrap();
    assert!(matches!(
        next(&mut stream).await,
        Some(Err(Error::Unauthorized))
    ));
    let mut input = request();
    input.generation = 2;
    let mut stream = g.subscribe(input, CancellationToken::new()).await.unwrap();
    next(&mut stream).await.unwrap().unwrap();
    let mut p = principal();
    p.revision = 2;
    g.set_principal(p).await.unwrap();
    assert!(matches!(
        next(&mut stream).await,
        Some(Err(Error::Unauthorized))
    ));
}
#[tokio::test]
async fn wrong_sender_scope_and_unavailable_backend_never_fall_back() {
    let host = Arc::new(Host::new(true));
    let (_temp, g) = setup(host).await;
    let mut input = request();
    input.sender.user = "other".into();
    assert!(matches!(
        g.subscribe(input, CancellationToken::new()).await,
        Err(Error::Unauthorized)
    ));
    assert!(matches!(
        g.subscribe(request(), CancellationToken::new()).await,
        Err(Error::HostUnavailable)
    ));
}
#[tokio::test]
async fn host_scope_loss_closes_stream_and_cross_session_frame_is_never_emitted() {
    let host = Arc::new(Host::new(false));
    let (_temp, g) = setup(host.clone()).await;
    let mut stream = g
        .subscribe(request(), CancellationToken::new())
        .await
        .unwrap();
    next(&mut stream).await.unwrap().unwrap();
    host.frames.send(frame("session/queue", "other")).unwrap();
    assert!(matches!(
        next(&mut stream).await,
        Some(Err(Error::Invalid(_)))
    ));
    let mut stream = g
        .subscribe(request(), CancellationToken::new())
        .await
        .unwrap();
    next(&mut stream).await.unwrap().unwrap();
    host.scope.store(false, Ordering::SeqCst);
    assert!(matches!(
        next(&mut stream).await,
        Some(Err(Error::Unauthorized))
    ));
}
#[tokio::test]
async fn slow_consumer_reports_sanitized_gap_and_requires_history_restore() {
    let host = Arc::new(Host::new(false));
    let (_temp, g) = setup(host.clone()).await;
    let mut stream = g
        .subscribe(request(), CancellationToken::new())
        .await
        .unwrap();
    next(&mut stream).await.unwrap().unwrap();
    for _ in 0..20 {
        host.frames.send(frame("session/queue", "s")).unwrap();
    }
    let error = next(&mut stream).await.unwrap().unwrap_err();
    assert!(matches!(error, Error::StreamGap));
    assert!(!format!("{error:?}").contains("secret"));
    assert!(next(&mut stream).await.is_none());
}
#[tokio::test]
async fn subscription_capacity_and_disconnect_release_permit_without_host_calls() {
    let host = Arc::new(Host::new(false));
    let (_temp, g) = setup(host).await;
    let mut streams = Vec::new();
    for _ in 0..32 {
        streams.push(
            g.subscribe(request(), CancellationToken::new())
                .await
                .unwrap(),
        );
    }
    assert!(matches!(
        g.subscribe(request(), CancellationToken::new()).await,
        Err(Error::Capacity)
    ));
    streams.pop();
    let stop = CancellationToken::new();
    let mut stream = g.subscribe(request(), stop.clone()).await.unwrap();
    stop.cancel();
    assert!(next(&mut stream).await.is_none());
    assert!(g
        .subscribe(request(), CancellationToken::new())
        .await
        .is_ok());
}
#[tokio::test]
async fn oversized_or_mismatched_frame_never_reaches_controller() {
    let host = Arc::new(Host::new(false));
    let (_temp, g) = setup(host.clone()).await;
    let mut stream = g
        .subscribe(request(), CancellationToken::new())
        .await
        .unwrap();
    next(&mut stream).await.unwrap().unwrap();
    let mut huge = frame("session/queue", "s");
    huge.payload["items"] = json!(["x".repeat(MAX_RESULT_BYTES)]);
    host.frames.send(huge).unwrap();
    assert!(matches!(
        next(&mut stream).await,
        Some(Err(Error::Invalid(_)))
    ));
    let mut stream = g
        .subscribe(request(), CancellationToken::new())
        .await
        .unwrap();
    next(&mut stream).await.unwrap().unwrap();
    let mut bad = frame("session/queue", "s");
    bad.method = "credentials/describe".into();
    host.frames.send(bad).unwrap();
    assert!(matches!(
        next(&mut stream).await,
        Some(Err(Error::Invalid(_)))
    ));
}

use super::*;
use axum::http::Request;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use tower::ServiceExt;
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        static N: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "xh-gh-hook-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap()
    }
}
fn try_receiver(root: &Temp) -> std::io::Result<Receiver> {
    Receiver::open(
        root.0.join("revisions.json"),
        vec![
            Hook {
                route: "route-aaaaaaaaaaaa".into(),
                repository_id: 7,
                secret: vec![b'a'; 64],
            },
            Hook {
                route: "route-bbbbbbbbbbbb".into(),
                repository_id: 8,
                secret: vec![b'b'; 64],
            },
        ],
        vec![
            Subscriber {
                token: vec![b'c'; 64],
                repository_ids: BTreeSet::from([7]),
            },
            Subscriber {
                token: vec![b'd'; 64],
                repository_ids: BTreeSet::from([8]),
            },
        ],
    )
}
fn receiver(root: &Temp) -> Receiver {
    try_receiver(root).unwrap()
}
fn payload() -> Vec<u8> {
    json!({"action":"completed","repository":{"id":7,"node_id":"R_project7"},"workflow_run":{"conclusion":"success","head_sha":"untrusted-old-sha"},"prompt":"DO_NOT_PERSIST_RAW_BODY"}).to_string().into_bytes()
}
fn headers(bytes: &[u8], id: u64) -> HeaderMap {
    let mut mac = Hmac::<Sha256>::new_from_slice(&[b'a'; 64]).unwrap();
    mac.update(bytes);
    let sig = mac.finalize().into_bytes();
    let signature = format!(
        "sha256={}",
        sig.iter().map(|b| format!("{b:02x}")).collect::<String>()
    );
    let mut h = HeaderMap::new();
    h.insert("x-hub-signature-256", signature.parse().unwrap());
    h.insert(
        "x-github-delivery",
        format!("00000000-0000-4000-8000-{id:012x}")
            .parse()
            .unwrap(),
    );
    h.insert("x-github-event", "workflow_run".parse().unwrap());
    h.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    h
}
#[test]
fn hmac_rfc4231_vector_and_tampering() {
    let sig = "sha256=b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7";
    assert!(verify(&[0x0b; 20], b"Hi There", sig));
    assert!(!verify(&[0x0b; 20], b"hi There", sig));
    assert!(!verify(b"wrong", b"Hi There", sig));
    assert!(!verify(b"secret", b"x", "sha1=bad"));
    assert!(!verify(
        b"secret",
        b"x",
        &format!("sha256={}", "z".repeat(64))
    ));
}
#[test]
fn authenticated_metadata_only_delivery_dedup_and_restart() {
    let root = Temp::new();
    let r = receiver(&root);
    let body = payload();
    let h = headers(&body, 1);
    r.ingest("route-aaaaaaaaaaaa", &h, &body).unwrap();
    r.ingest("route-aaaaaaaaaaaa", &h, &body).unwrap();
    assert_eq!(
        r.0.changes.borrow().as_ref().unwrap().repositories[0].revision,
        1
    );
    let bytes = std::fs::read(root.0.join("revisions.json")).unwrap();
    let text = String::from_utf8(bytes).unwrap();
    for secret in [
        "DO_NOT_PERSIST_RAW_BODY",
        "success",
        "head_sha",
        "prompt",
        &"a".repeat(64),
        &"c".repeat(64),
    ] {
        assert!(!text.contains(secret))
    }
    assert!(
        Receiver::open(
            root.0.join("revisions.json"),
            vec![Hook {
                route: "route-aaaaaaaaaaaa".into(),
                repository_id: 7,
                secret: vec![b'a'; 64]
            }],
            vec![Subscriber {
                token: vec![b'c'; 64],
                repository_ids: BTreeSet::from([7])
            }]
        )
        .is_err(),
        "exclusive state ownership"
    );
    drop(r);
    let r = receiver(&root);
    r.ingest("route-aaaaaaaaaaaa", &h, &body).unwrap();
    assert_eq!(
        r.0.changes.borrow().as_ref().unwrap().repositories[0].revision,
        1
    );
    r.ingest("route-aaaaaaaaaaaa", &headers(&body, 2), &body)
        .unwrap();
    assert_eq!(
        r.0.changes.borrow().as_ref().unwrap().repositories[0].revision,
        2
    );
}
#[test]
fn bad_signature_wrong_repository_unknown_event_and_missing_headers_do_not_dirty() {
    let root = Temp::new();
    let r = receiver(&root);
    let body = payload();
    let mut h = headers(&body, 1);
    assert_eq!(
        r.ingest("route-aaaaaaaaaaaa", &h, b"{}"),
        Err(StatusCode::UNAUTHORIZED)
    );
    assert_eq!(
        r.ingest("route-bbbbbbbbbbbb", &h, &body),
        Err(StatusCode::UNAUTHORIZED)
    );
    let wrong = json!({"action":"completed","repository":{"id":8,"node_id":"R_project8"}})
        .to_string()
        .into_bytes();
    assert_eq!(
        r.ingest("route-aaaaaaaaaaaa", &headers(&wrong, 1), &wrong),
        Err(StatusCode::FORBIDDEN)
    );
    h.insert("x-github-event", "issue_comment".parse().unwrap());
    r.ingest("route-aaaaaaaaaaaa", &h, &body).unwrap();
    assert!(r
        .0
        .changes
        .borrow()
        .as_ref()
        .unwrap()
        .repositories
        .is_empty());
    h = headers(&body, 2);
    h.remove("x-github-delivery");
    assert_eq!(
        r.ingest("route-aaaaaaaaaaaa", &h, &body),
        Err(StatusCode::BAD_REQUEST)
    );
    h = headers(&body, 2);
    h.insert("x-github-delivery", "../not-a-guid".parse().unwrap());
    assert_eq!(
        r.ingest("route-aaaaaaaaaaaa", &h, &body),
        Err(StatusCode::BAD_REQUEST)
    );
}
#[test]
fn out_of_order_success_is_only_an_invalidation_and_dedup_window_is_bounded() {
    let root = Temp::new();
    let r = receiver(&root);
    let body = payload();
    r.ingest("route-aaaaaaaaaaaa", &headers(&body, 1), &body)
        .unwrap();
    {
        let mut s = r.0.state.lock().unwrap();
        let row = s.ledger.repositories.get_mut(&7).unwrap();
        row.deliveries = (0..DELIVERY_WINDOW)
            .map(|i| format!("00000000-0000-4000-8000-{i:012x}"))
            .collect();
    }
    r.ingest("route-aaaaaaaaaaaa", &headers(&body, 999), &body)
        .unwrap();
    let state = r.0.state.lock().unwrap();
    assert_eq!(
        state.ledger.repositories[&7].deliveries.len(),
        DELIVERY_WINDOW
    );
    assert_eq!(state.ledger.repositories[&7].revision, 2);
}
#[test]
fn write_failure_never_acknowledges_and_closes_stream_state() {
    let root = Temp::new();
    let r = receiver(&root);
    let body = payload();
    r.ingest("route-aaaaaaaaaaaa", &headers(&body, 1), &body)
        .unwrap();
    std::fs::create_dir(root.0.join("revisions.pending")).unwrap();
    assert_eq!(
        r.ingest("route-aaaaaaaaaaaa", &headers(&body, 2), &body),
        Err(StatusCode::SERVICE_UNAVAILABLE)
    );
    assert!(r.0.changes.borrow().is_none());
    assert_eq!(
        r.ingest("route-aaaaaaaaaaaa", &headers(&body, 3), &body),
        Err(StatusCode::SERVICE_UNAVAILABLE)
    );
    let disk: Ledger =
        serde_json::from_slice(&std::fs::read(root.0.join("revisions.json")).unwrap()).unwrap();
    assert_eq!(disk.repositories[&7].revision, 1);
}
#[tokio::test]
async fn http_limits_and_subscriber_scoping() {
    use futures::StreamExt;
    let root = Temp::new();
    let r = receiver(&root);
    let body = payload();
    let app = r.clone().router();
    let mut request = Request::post("/github/hooks/route-aaaaaaaaaaaa")
        .body(Body::from(body.clone()))
        .unwrap();
    *request.headers_mut() = headers(&body, 1);
    assert_eq!(
        app.clone().oneshot(request).await.unwrap().status(),
        StatusCode::NO_CONTENT
    );
    let response = app
        .clone()
        .oneshot(Request::get("/github/events").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let auth = format!("Bearer {}", "c".repeat(64));
    let response = app
        .clone()
        .oneshot(
            Request::get("/github/events")
                .header(header::AUTHORIZATION, &auth)
                .header(header::ORIGIN, "https://evil.test")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    for (token, want) in [("c", 1), ("d", 0)] {
        let response = app
            .clone()
            .oneshot(
                Request::get("/github/events")
                    .header(
                        header::AUTHORIZATION,
                        format!("Bearer {}", token.repeat(64)),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response
            .into_body()
            .into_data_stream()
            .next()
            .await
            .unwrap()
            .unwrap();
        let value: Snapshot = serde_json::from_slice(&bytes).unwrap();
        assert!(value.validate());
        assert_eq!(value.repositories.len(), want);
    }
    let response = app
        .oneshot(
            Request::post("/github/hooks/route-aaaaaaaaaaaa")
                .body(Body::from(vec![b'x'; MAX_BYTES + 1]))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}
#[test]
fn configuration_and_corrupt_state_fail_closed() {
    let root = Temp::new();
    std::fs::write(root.0.join("revisions.json"), b"{}").unwrap();
    assert!(try_receiver(&root).is_err());
    assert!(!Snapshot {
        schema: 1,
        repositories: vec![Revision {
            repository_id: 1,
            node_id: "bad".into(),
            revision: 1
        }]
    }
    .validate());
}

#[tokio::test]
async fn concurrent_delivery_burst_has_bounded_admission_and_no_false_ack() {
    let root = Temp::new();
    let receiver = receiver(&root);
    let app = receiver.clone().router();
    let calls = (1..=8).map(|id| {
        let app = app.clone();
        async move {
            let body = payload();
            let mut request = Request::post("/github/hooks/route-aaaaaaaaaaaa")
                .body(Body::from(body.clone()))
                .unwrap();
            *request.headers_mut() = headers(&body, id);
            app.oneshot(request).await.unwrap().status()
        }
    });
    for status in futures::future::join_all(calls).await {
        assert_eq!(status, StatusCode::NO_CONTENT)
    }
    assert_eq!(
        receiver.0.changes.borrow().as_ref().unwrap().repositories[0].revision,
        8
    );
    let permits = receiver
        .0
        .ingress
        .clone()
        .acquire_many_owned(16)
        .await
        .unwrap();
    assert_eq!(
        app.oneshot(Request::get("/github/events").body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    drop(permits);
}

#[test]
fn a_signed_node_id_collision_cannot_corrupt_the_durable_snapshot() {
    let root = Temp::new();
    let r = receiver(&root);
    let first = payload();
    r.ingest("route-aaaaaaaaaaaa", &headers(&first, 1), &first)
        .unwrap();
    let body = json!({"action":"completed","repository":{"id":8,"node_id":"R_project7"}})
        .to_string()
        .into_bytes();
    let mut header = headers(&body, 2);
    let mut mac = Hmac::<Sha256>::new_from_slice(&[b'b'; 64]).unwrap();
    mac.update(&body);
    let signature = format!(
        "sha256={}",
        mac.finalize()
            .into_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
    header.insert("x-hub-signature-256", signature.parse().unwrap());
    assert_eq!(
        r.ingest("route-bbbbbbbbbbbb", &header, &body),
        Err(StatusCode::CONFLICT)
    );
    assert_eq!(r.0.changes.borrow().as_ref().unwrap().repositories.len(), 1);
    drop(r);
    assert!(try_receiver(&root).is_ok());
}

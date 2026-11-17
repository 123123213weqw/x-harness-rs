use super::*;
use serde_json::json;
use tokio_util::sync::CancellationToken;
fn snapshot(revision: u64) -> Snapshot {
    Snapshot {
        schema: 1,
        repositories: vec![xharness_server::github_webhook::Revision {
            repository_id: 7,
            node_id: "R_project7".into(),
            revision,
        }],
    }
}
#[test]
fn framing_handles_fragmented_utf8_heartbeats_and_multiple_documents() {
    let mut parser = Parser::default();
    let bytes = serde_json::to_vec(&snapshot(1)).unwrap();
    let half = bytes.len() / 2;
    assert!(parser.push(&bytes[..half]).unwrap().is_empty());
    let mut rest = bytes[half..].to_vec();
    rest.extend_from_slice(b"\n\n");
    assert_eq!(parser.push(&rest).unwrap(), vec![snapshot(1)]);
    let mut all = serde_json::to_vec(&snapshot(2)).unwrap();
    all.push(b'\n');
    all.extend_from_slice(&serde_json::to_vec(&snapshot(3)).unwrap());
    all.push(b'\n');
    assert_eq!(parser.push(&all).unwrap(), vec![snapshot(3)]);
}
#[test]
fn framing_rejects_commands_malformed_oversized_and_duplicate_repositories() {
    for bytes in [
        b"{\"task\":\"run\"}\n".to_vec(),
        b"invalid\n".to_vec(),
        vec![b'x'; MAX_FRAME_BYTES + 1],
    ] {
        assert!(Parser::default().push(&bytes).is_err())
    }
    let mut duplicate = snapshot(1);
    duplicate
        .repositories
        .push(duplicate.repositories[0].clone());
    let mut data = serde_json::to_vec(&duplicate).unwrap();
    data.push(b'\n');
    assert!(Parser::default().push(&data).is_err());
}
#[test]
fn url_and_authentication_never_allow_redirect_credentials_or_insecure_remote_http() {
    for url in [
        "http://example.com/github/events",
        "http://localhost/github/events",
        "https://u:secret@example.com/github/events",
        "https://example.com/github/events?token=x",
        "https://example.com/github/events#x",
        "file:///github/events",
        "https://example.com/api",
    ] {
        assert!(Client::new(url, &[b'c'; 64]).is_err(), "{url}")
    }
    assert!(Client::new("http://127.0.0.1:1234/github/events", &[b'c'; 64]).is_ok());
    assert!(Client::new("https://example.com/github/events", &[b'c'; 64]).is_ok());
    assert!(Client::new("https://example.com/github/events", b"short").is_err());
}
#[test]
fn revision_diff_handles_duplicates_out_of_order_and_node_id_replacement() {
    let one = BTreeMap::from([(7, ("R_project7".into(), 2))]);
    assert!(changed_nodes(&one, &one).is_empty());
    let older = BTreeMap::from([(7, ("R_project7".into(), 1))]);
    assert_eq!(changed_nodes(&one, &older), vec!["R_project7"]);
    let renamed = BTreeMap::from([(7, ("R_renamed7".into(), 3))]);
    assert_eq!(
        changed_nodes(&one, &renamed),
        vec!["R_project7", "R_renamed7"]
    );
}
#[tokio::test]
async fn actual_http_receiver_reconnect_and_host_downlink_without_model_work() {
    use futures::StreamExt;
    use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};
    use xharness_host::{GitHubBackend, HostConfig, NoTools};
    struct Backend(std::sync::atomic::AtomicUsize);
    #[async_trait::async_trait]
    impl GitHubBackend for Backend {
        async fn read(
            &self,
            _: &str,
            _: &serde_json::Value,
            _: CancellationToken,
        ) -> Result<serde_json::Value, xharness_api::RpcError> {
            panic!("no generic backend")
        }
        async fn project_status(
            &self,
            _: &str,
            _: CancellationToken,
        ) -> Result<serde_json::Value, xharness_api::RpcError> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(json!({"kind":"no_pr","ci":"none","repositoryId":"R_project7"}))
        }
    }
    let root = crate::tests::TempWorkspace::new();
    let receiver = Receiver::open(
        root.0.join("receiver/revisions.json"),
        vec![Hook {
            route: "route-aaaaaaaaaaaa".into(),
            repository_id: 7,
            secret: vec![b'a'; 64],
        }],
        vec![Subscriber {
            token: vec![b'c'; 64],
            repository_ids: BTreeSet::from([7]),
        }],
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, receiver.router())
            .with_graceful_shutdown(async { stopped.await.unwrap() })
            .await
            .unwrap()
    });
    let host = BasicHost::new(HostConfig::new(&root.0), None, Arc::new(NoTools));
    let backend = Arc::new(Backend(std::sync::atomic::AtomicUsize::new(0)));
    host.install_github(backend.clone()).unwrap();
    let created = host
        .call(
            RpcId::new("register"),
            RpcMethod::WorkspaceCreate,
            json!({"path":root.0}),
            CancellationToken::new(),
        )
        .await;
    let id = match created {
        RpcResult::Success { value: Some(value) } => value["workspace"]["workspaceId"]
            .as_str()
            .unwrap()
            .to_owned(),
        other => panic!("{other:?}"),
    };
    let mut frames = host.host_events();
    let url = format!("http://{address}/github/events");
    let bridge = {
        let host = host.clone();
        let url = url.clone();
        tokio::spawn(async move {
            Client::new(&url, &[b'c'; 64])
                .unwrap()
                .connect(|ids, reset| {
                    host.publish_github_project_signal(&ids, reset, true)
                        .unwrap()
                })
                .await
        })
    };
    let baseline = tokio::time::timeout(Duration::from_secs(3), frames.next())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        baseline.payload["event"],
        "github/project-status-invalidated"
    );
    assert_eq!(baseline.payload["args"][0]["reset"], true);
    assert_eq!(
        backend.0.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "signal cannot invoke model or even gh by itself"
    );
    // Real signed HTTP delivery, independently generated with Python's HMAC
    // rather than the receiver implementation under test.
    let bytes = br#"{"action":"completed","repository":{"id":7,"node_id":"R_project7"}}"#;
    let signature = "sha256=0fa65588783de61db0b8b71ca7dbce92a4a5a850dc9ee167e2a9776721a99278";
    let response = reqwest::Client::new()
        .post(format!("http://{address}/github/hooks/route-aaaaaaaaaaaa"))
        .header("content-type", "application/json")
        .header("x-github-event", "workflow_run")
        .header("x-github-delivery", "00000000-0000-4000-8000-000000000001")
        .header("x-hub-signature-256", signature)
        .body(bytes.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 204);
    let frame = tokio::time::timeout(Duration::from_secs(3), frames.next())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frame.payload["args"][0]["repositoryIds"][0], "R_project7");
    // The UI uses the existing readonly query after invalidation. The raw
    // webhook conclusion/sha never becomes the badge's status.
    let value = host
        .call_dynamic(
            RpcId::new("refresh"),
            "github/project-status",
            json!({"workspaceId":id}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(matches!(value, RpcResult::Success { .. }));
    assert_eq!(backend.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    match host
        .call(
            RpcId::new("list"),
            RpcMethod::SessionList,
            json!({}),
            CancellationToken::new(),
        )
        .await
    {
        RpcResult::Success { value: Some(value) } => assert_eq!(
            value["items"],
            json!([]),
            "webhook cannot create or resume a session"
        ),
        other => panic!("{other:?}"),
    }

    bridge.abort();
    assert!(bridge.await.unwrap_err().is_cancelled());
    // An offline Host reconnects to the durable snapshot, not an event replay.
    let response = reqwest::Client::new()
        .get(&url)
        .bearer_auth("c".repeat(64))
        .send()
        .await
        .unwrap();
    let mut body = response;
    let chunk = body.chunk().await.unwrap().unwrap();
    let snapshot: Snapshot = serde_json::from_slice(&chunk).unwrap();
    assert_eq!(snapshot.repositories[0].revision, 1);
    drop(body);
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
}
#[tokio::test]
async fn redirect_does_not_forward_the_transport_token() {
    use axum::{routing::get, Router};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                "/github/events",
                get(|| async {
                    axum::response::Redirect::temporary("https://example.com/github/events")
                }),
            ),
        )
        .await
        .unwrap()
    });
    let result = Client::new(&format!("http://{addr}/github/events"), &[b'c'; 64])
        .unwrap()
        .connect(|_, _| panic!("redirect must not publish"))
        .await;
    assert_eq!(result, Err(Failure::Transport));
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

#[test]
fn huge_valid_burst_is_coalesced_to_the_latest_snapshot() {
    let mut bytes = Vec::new();
    for revision in 1..=500 {
        bytes.extend_from_slice(&serde_json::to_vec(&snapshot(revision)).unwrap());
        bytes.push(b'\n');
    }
    assert_eq!(Parser::default().push(&bytes).unwrap(), vec![snapshot(500)]);
}
#[test]
fn secret_files_require_absolute_private_regular_paths() {
    let root = crate::tests::TempWorkspace::new();
    let file = root.0.join("transport-token");
    std::fs::write(&file, vec![b'c'; 64]).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(secret(&file).err(), Some(Failure::Configuration));
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert_eq!(secret(&file).unwrap(), vec![b'c'; 64]);
    assert!(secret(Path::new("relative-token")).is_err());
}

use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tokio_util::sync::CancellationToken;
use xharness_api::{
    ApiBackend, ClientResponse, EventStream, MuxFrame, RpcError, RpcId, RpcMethod, RpcReceipt,
    RpcResult, ScopedCatalogueQuery, ScopedInteraction, ScopedInteractionAnswer,
    ScopedInteractionReceipt,
};
use xharness_mobile::{
    protocol::{ErrorCode, MobileAction, MobileRequest, PairedDevice, Secret},
    MobileHost, PairingScopes,
};
use xharness_remote::{
    CatalogueSession, CatalogueWorkspace, Command, Content, Gateway, PromptMode,
    ScopedCataloguePage, ScopedEventPage, SessionSelection,
};

#[derive(Default)]
struct Native {
    effects: AtomicUsize,
    answers: AtomicUsize,
    receipts: Mutex<BTreeMap<String, (Value, RpcResult)>>,
    pending: AtomicBool,
    catalogue_unavailable: AtomicBool,
}
fn approval(session: &str) -> xharness_api::ServerRequest {
    MuxFrame::ApprovalRequested {
        session_id: session.into(),
        approval_id: "approval-original".into(),
        tool_name: "test_tool".into(),
        call_id: Some("call-original".into()),
        reason: Some("test approval".into()),
        reviewing: None,
    }
    .into_server_request(RpcId::new("approval-original"))
}
#[async_trait]
impl ApiBackend for Native {
    async fn call(
        &self,
        id: RpcId,
        method: RpcMethod,
        payload: Value,
        _: CancellationToken,
    ) -> RpcResult {
        assert!(matches!(payload["sessionId"].as_str(), Some("s1" | "s2")));
        match method {
            RpcMethod::SessionPrompt => {
                self.effects.fetch_add(1, Ordering::SeqCst);
                let result =
                    RpcResult::success(json!({"accepted":true,"messageId":"native-message"}));
                self.receipts
                    .lock()
                    .unwrap()
                    .insert(id.as_str().into(), (payload, result.clone()));
                result
            }
            RpcMethod::SessionCancel => {
                self.effects.fetch_add(1, Ordering::SeqCst);
                RpcResult::success_void()
            }
            RpcMethod::SessionHistory => RpcResult::success(json!({"messages":[],"hasMore":false})),
            _ => panic!("mobile must not expose generic methods"),
        }
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
        Ok(w == "w" && matches!(s, "s1" | "s2"))
    }
    async fn scoped_catalogue(
        &self,
        q: ScopedCatalogueQuery,
    ) -> Result<ScopedCataloguePage, RpcError> {
        if self.catalogue_unavailable.load(Ordering::SeqCst) {
            return Err(RpcError::internal("must be sanitized"));
        }
        let mut sessions = Vec::new();
        for s in ["s1", "s2"] {
            let current = CatalogueSession {
                workspace: "w".into(),
                id: s.into(),
                title: Some(s.into()),
                running: false,
                restoring: false,
            };
            if q.workspaces.contains("w")
                && q.sessions.contains(s)
                && q.after.as_ref().is_none_or(|after| {
                    ("w", s) > (after.workspace.as_str(), after.session.as_str())
                })
            {
                sessions.push(current);
            }
        }
        Ok(ScopedCataloguePage {
            workspaces: if q.workspaces.contains("w") {
                vec![CatalogueWorkspace {
                    id: "w".into(),
                    title: "Native workspace".into(),
                }]
            } else {
                vec![]
            },
            sessions,
            next: None,
        })
    }
    async fn prompt_receipt(
        &self,
        _: &str,
        id: &RpcId,
        payload: &Value,
    ) -> Result<Option<RpcResult>, RpcError> {
        match self.receipts.lock().unwrap().get(id.as_str()) {
            Some((original, result)) if original == payload => Ok(Some(result.clone())),
            Some(_) => Err(RpcError::internal("identity conflict")),
            None => Ok(None),
        }
    }
    async fn session_event_page(
        &self,
        w: &str,
        s: &str,
        after: Option<u64>,
    ) -> Result<ScopedEventPage, RpcError> {
        assert!(w == "w" && matches!(s, "s1" | "s2"));
        match after {
            None => Ok(ScopedEventPage {
                start_seq: 1,
                next_seq: 1,
                head_seq: 1,
                events: vec![],
            }),
            Some(0) => Ok(ScopedEventPage {
                start_seq: 0,
                next_seq: 1,
                head_seq: 1,
                events: vec![MuxFrame::SessionEvent {
                    session_id: s.into(),
                    event: json!({"seq":0,"data":{"type":"test","text":"native-output"}}),
                    view: None,
                }
                .into_server_request(RpcId::new("native-event"))],
            }),
            Some(1) => Ok(ScopedEventPage {
                start_seq: 1,
                next_seq: 1,
                head_seq: 1,
                events: vec![],
            }),
            _ => Err(RpcError::internal("gap")),
        }
    }
    async fn session_events(&self, w: &str, s: &str) -> Result<EventStream, RpcError> {
        assert!(w == "w" && matches!(s, "s1" | "s2"));
        let mut frames = vec![MuxFrame::SessionSubscribed {
            session_id: s.into(),
            last_seq: 0,
        }
        .into_server_request(RpcId::new("subscribed"))];
        if self.pending.load(Ordering::SeqCst) {
            frames.push(approval(s));
        }
        Ok(Box::pin(futures::stream::iter(frames)))
    }
    async fn session_interaction(
        &self,
        w: &str,
        s: &str,
        id: &RpcId,
    ) -> Result<Option<ScopedInteraction>, RpcError> {
        assert!(w == "w" && matches!(s, "s1" | "s2"));
        Ok(
            (self.pending.load(Ordering::SeqCst) && id.as_str() == "approval-original").then(
                || ScopedInteraction {
                    nonce: "original-native-nonce".into(),
                    frame: approval(s),
                },
            ),
        )
    }
    async fn answer_session_interaction(
        &self,
        w: &str,
        s: &str,
        expected: ScopedInteraction,
        answer: ScopedInteractionAnswer,
    ) -> Result<ScopedInteractionReceipt, RpcError> {
        assert!(w == "w" && matches!(s, "s1" | "s2"));
        assert_eq!(expected.nonce, "original-native-nonce");
        assert!(matches!(
            answer,
            ScopedInteractionAnswer::Approval { allowed: true }
        ));
        if self.pending.swap(false, Ordering::SeqCst) {
            self.answers.fetch_add(1, Ordering::SeqCst);
            Ok(ScopedInteractionReceipt::Accepted)
        } else {
            Ok(ScopedInteractionReceipt::Stale)
        }
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("no raw respond")
    }
    fn mux_events(&self) -> EventStream {
        panic!("no global mux")
    }
    fn host_events(&self) -> EventStream {
        panic!("no Host events")
    }
}
fn scopes() -> PairingScopes {
    PairingScopes {
        workspaces: ["w".into()].into(),
        sessions: ["s1".into(), "s2".into()].into(),
        workspace: "w".into(),
        session: "s1".into(),
        create_workspaces: BTreeSet::new(),
    }
}
fn authenticated(p: &PairedDevice, action: MobileAction) -> MobileRequest {
    MobileRequest::Authenticated {
        device: p.device.clone(),
        secret: p.secret.clone(),
        action,
    }
}
async fn setup() -> (
    tempfile::TempDir,
    Arc<Native>,
    Arc<Gateway>,
    Arc<MobileHost>,
) {
    let root = tempfile::tempdir().unwrap();
    let native = Arc::new(Native::default());
    let gateway = Gateway::open(
        &root.path().join("gateway"),
        "host-test".into(),
        native.clone(),
    )
    .unwrap();
    let mobile = MobileHost::open(gateway.clone(), &root.path().join("mobile")).unwrap();
    (root, native, gateway, mobile)
}
async fn pair(mobile: &Arc<MobileHost>) -> PairedDevice {
    let offer = mobile.create_pairing(scopes(), 300).await.unwrap();
    let response = mobile
        .handle(MobileRequest::Pair {
            code: offer.code,
            name: "Test phone".into(),
        })
        .await;
    assert!(response.ok);
    serde_json::from_value(response.result.unwrap()).unwrap()
}
fn prompt() -> Command {
    Command::Prompt {
        mode: PromptMode::Queue,
        content: vec![Content::Text {
            text: "do one test".into(),
        }],
        client_time_zone: None,
    }
}

#[tokio::test]
async fn pairing_is_single_use_hash_only_and_restart_keeps_independent_authority() {
    let (root, _, gateway, mobile) = setup().await;
    let offer = mobile.create_pairing(scopes(), 300).await.unwrap();
    let code = offer.code.clone();
    let response = mobile
        .handle(MobileRequest::Pair {
            code: code.clone(),
            name: "Test phone".into(),
        })
        .await;
    let p: PairedDevice = serde_json::from_value(response.result.unwrap()).unwrap();
    assert!(
        mobile
            .handle(authenticated(&p, MobileAction::Status))
            .await
            .ok
    );
    assert_eq!(
        mobile
            .handle(MobileRequest::Pair {
                code: code.clone(),
                name: "Other phone".into()
            })
            .await
            .error,
        Some(ErrorCode::PairConsumed)
    );
    let wrong = PairedDevice {
        host: p.host.clone(),
        device: p.device.clone(),
        secret: "f".repeat(64).try_into().unwrap(),
    };
    assert_eq!(
        mobile
            .handle(authenticated(&wrong, MobileAction::Status))
            .await
            .error,
        Some(ErrorCode::Unauthorized)
    );
    for name in ["mobile.sqlite", "mobile.sqlite-wal"] {
        let bytes = std::fs::read(root.path().join("mobile").join(name)).unwrap();
        assert!(!bytes
            .windows(code.expose().len())
            .any(|w| w == code.expose().as_bytes()));
        assert!(!bytes
            .windows(p.secret.expose().len())
            .any(|w| w == p.secret.expose().as_bytes()));
    }
    assert_ne!(p.secret, code);
    assert_eq!(mobile.devices().await.unwrap().len(), 1);
    drop(mobile);
    let mobile = MobileHost::open(gateway, &root.path().join("mobile")).unwrap();
    assert!(
        mobile
            .handle(authenticated(&p, MobileAction::Status))
            .await
            .ok
    );
    mobile.revoke(&p.device).await.unwrap();
    assert_eq!(
        mobile
            .handle(authenticated(&p, MobileAction::Status))
            .await
            .error,
        Some(ErrorCode::Unauthorized)
    );
    assert!(mobile.devices().await.unwrap()[0].revoked);
    assert!(mobile.revoke(&p.device).await.is_ok());
    let p2 = pair(&mobile).await;
    assert_ne!(p.device, p2.device);
    assert!(
        mobile
            .handle(authenticated(&p2, MobileAction::Status))
            .await
            .ok
    );
}
#[tokio::test]
async fn duplicate_prompt_has_one_effect_and_foreign_device_cannot_read_its_receipt() {
    let (_root, native, gateway, mobile) = setup().await;
    let p = pair(&mobile).await;
    let p2 = pair(&mobile).await;
    let command = MobileAction::Command {
        request_id: "request-one".into(),
        generation: 1,
        command: prompt(),
    };
    let first = mobile.handle(authenticated(&p, command.clone())).await;
    assert!(first.ok);
    assert_eq!(first.result.as_ref().unwrap()["state"], "queued");
    let key = first.result.as_ref().unwrap()["key"]
        .as_str()
        .unwrap()
        .to_owned();
    gateway.dispatch(&key).await.unwrap();
    assert!(mobile.handle(authenticated(&p, command)).await.ok);
    assert_eq!(native.effects.load(Ordering::SeqCst), 1);
    let receipt = mobile
        .handle(authenticated(
            &p,
            MobileAction::Delivery {
                key: "request:request-one".into(),
            },
        ))
        .await;
    assert_eq!(receipt.result.as_ref().unwrap()["state"], "completed");
    assert_eq!(
        receipt.result.as_ref().unwrap()["result"]["value"]["messageId"],
        "native-message"
    );
    assert_eq!(
        mobile
            .handle(authenticated(&p2, MobileAction::Delivery { key }))
            .await
            .error,
        Some(ErrorCode::Unauthorized)
    );
    let changed = MobileAction::Command {
        request_id: "request-one".into(),
        generation: 1,
        command: Command::Cancel,
    };
    assert_eq!(
        mobile.handle(authenticated(&p, changed)).await.error,
        Some(ErrorCode::Conflict)
    );
    assert_eq!(native.effects.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn selection_fences_old_window_generation_and_receipt_lookup_survives_rebind() {
    let (_root, native, gateway, mobile) = setup().await;
    let p = pair(&mobile).await;
    let accepted = mobile
        .handle(authenticated(
            &p,
            MobileAction::Command {
                request_id: "select-one".into(),
                generation: 1,
                command: Command::Select {
                    target: SessionSelection {
                        workspace: "w".into(),
                        session: "s2".into(),
                    },
                },
            },
        ))
        .await;
    let key = accepted.result.unwrap()["key"].as_str().unwrap().to_owned();
    gateway.dispatch(&key).await.unwrap();
    let status = mobile.handle(authenticated(&p, MobileAction::Status)).await;
    assert_eq!(status.result.unwrap()["binding"]["session"], "s2");
    let old = mobile
        .handle(authenticated(
            &p,
            MobileAction::Command {
                request_id: "old-window".into(),
                generation: 1,
                command: prompt(),
            },
        ))
        .await;
    assert_eq!(old.error, Some(ErrorCode::Conflict));
    let receipt = mobile
        .handle(authenticated(
            &p,
            MobileAction::Delivery {
                key: "request:select-one".into(),
            },
        ))
        .await;
    assert_eq!(receipt.result.unwrap()["state"], "completed");
    assert_eq!(native.effects.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn native_pending_interaction_becomes_scoped_ticket_and_consumes_once() {
    let (_root, native, gateway, mobile) = setup().await;
    let p = pair(&mobile).await;
    native.pending.store(true, Ordering::SeqCst);
    let snapshot = mobile
        .handle(authenticated(&p, MobileAction::Snapshot))
        .await;
    assert!(snapshot.ok);
    let result = snapshot.result.unwrap();
    assert_eq!(result["interactions"].as_array().unwrap().len(), 1);
    let ticket: xharness_remote::InteractionTicket =
        serde_json::from_value(result["interactions"][0].clone()).unwrap();
    let command = MobileAction::Command {
        request_id: "answer-one".into(),
        generation: 1,
        command: Command::AnswerInteraction {
            ticket: ticket.token,
            answer: ScopedInteractionAnswer::Approval { allowed: true },
        },
    };
    let admitted = mobile.handle(authenticated(&p, command.clone())).await;
    let key = admitted.result.unwrap()["key"].as_str().unwrap().to_owned();
    gateway.dispatch(&key).await.unwrap();
    assert!(mobile.handle(authenticated(&p, command)).await.ok);
    assert_eq!(native.answers.load(Ordering::SeqCst), 1);
    assert!(mobile
        .handle(authenticated(&p, MobileAction::Snapshot))
        .await
        .result
        .unwrap()["interactions"]
        .as_array()
        .unwrap()
        .is_empty());
}
#[tokio::test]
async fn bounded_durable_events_and_catalogue_are_only_for_the_verified_device_scope() {
    let (_root, _, _, mobile) = setup().await;
    let p = pair(&mobile).await;
    let catalogue = mobile
        .handle(authenticated(&p, MobileAction::Catalogue { after: None }))
        .await;
    assert_eq!(
        catalogue.result.unwrap()["catalogue"]["sessions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let first = mobile
        .handle(authenticated(&p, MobileAction::Events { after: None }))
        .await;
    assert_eq!(first.result.unwrap()["page"]["head_seq"], 1);
    let page = mobile
        .handle(authenticated(&p, MobileAction::Events { after: Some(0) }))
        .await;
    assert_eq!(
        page.result.unwrap()["page"]["events"][0]["payload"]["sessionId"],
        "s1"
    );
    mobile.revoke(&p.device).await.unwrap();
    assert_eq!(
        mobile
            .handle(authenticated(&p, MobileAction::Events { after: Some(0) }))
            .await
            .error,
        Some(ErrorCode::Unauthorized)
    );
}
#[tokio::test]
async fn failed_grant_stays_non_authenticating_and_pair_code_is_not_replayed() {
    let (_root, native, _, mobile) = setup().await;
    let offer = mobile.create_pairing(scopes(), 300).await.unwrap();
    native.catalogue_unavailable.store(true, Ordering::SeqCst);
    let first = mobile
        .handle(MobileRequest::Pair {
            code: offer.code.clone(),
            name: "Test phone".into(),
        })
        .await;
    assert!(!first.ok);
    assert!(!mobile.devices().await.unwrap()[0].active);
    native.catalogue_unavailable.store(false, Ordering::SeqCst);
    assert_eq!(
        mobile
            .handle(MobileRequest::Pair {
                code: offer.code,
                name: "Test phone".into()
            })
            .await
            .error,
        Some(ErrorCode::PairConsumed)
    );
}
#[test]
fn inbound_protocol_is_closed_and_redacts_secret_debug() {
    let raw = "a".repeat(64);
    let secret: Secret = raw.clone().try_into().unwrap();
    assert!(!format!("{secret:?}").contains(&raw));
    assert!(serde_json::from_value::<MobileRequest>(json!({"type":"authenticated","device":"d","secret":raw,"principal":"p","action":{"type":"status"}})).is_err());
    assert!(serde_json::from_value::<MobileAction>(
        json!({"type":"rpc","method":"credentials/set","payload":{}})
    )
    .is_err());
    assert!(
        serde_json::from_value::<MobileAction>(json!({"type":"status","session":"foreign"}))
            .is_err()
    );
}

#[tokio::test]
async fn outbound_loopback_handshake_ping_and_drop_never_replays_a_mutation() {
    use futures::{SinkExt, StreamExt};
    use std::time::Duration;
    use tokio_tungstenite::{accept_async, tungstenite::Message};
    use xharness_mobile::{
        protocol::{HostFrame, RelayFrame},
        run_outbound, OutboundConfig,
    };
    let (_root, native, gateway, mobile) = setup().await;
    let p = pair(&mobile).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let host_key: Secret = "c".repeat(64).try_into().unwrap();
    let expected_key = host_key.clone();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(socket).await.unwrap();
        let hello = socket.next().await.unwrap().unwrap();
        let Message::Text(hello) = hello else {
            panic!("expected hello")
        };
        assert!(
            matches!(serde_json::from_str::<HostFrame>(hello.as_ref()).unwrap(),HostFrame::Hello{host,key} if host=="host-test" && key==expected_key)
        );
        socket
            .send(Message::Text(
                serde_json::to_string(&RelayFrame::Ready).unwrap().into(),
            ))
            .await
            .unwrap();
        socket
            .send(Message::Ping(b"health".to_vec().into()))
            .await
            .unwrap();
        socket
            .send(Message::Text(
                serde_json::to_string(&RelayFrame::Request {
                    id: "transport-one".into(),
                    request: authenticated(
                        &p,
                        MobileAction::Command {
                            request_id: "outbound-once".into(),
                            generation: 1,
                            command: prompt(),
                        },
                    ),
                })
                .unwrap()
                .into(),
            ))
            .await
            .unwrap();
        let mut pong = false;
        let mut key = None;
        for _ in 0..5 {
            let frame = tokio::time::timeout(Duration::from_secs(3), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            match frame {
                Message::Pong(payload) => {
                    assert_eq!(payload.as_ref(), b"health");
                    pong = true;
                }
                Message::Ping(payload) => socket.send(Message::Pong(payload)).await.unwrap(),
                Message::Text(text) => {
                    let HostFrame::Response { id, response } =
                        serde_json::from_str::<HostFrame>(text.as_ref()).unwrap()
                    else {
                        panic!("no second hello")
                    };
                    assert_eq!(id, "transport-one");
                    assert!(response.ok);
                    key = Some(response.result.unwrap()["key"].as_str().unwrap().to_owned());
                }
                _ => panic!("unexpected relay frame"),
            }
            if pong && key.is_some() {
                break;
            }
        }
        assert!(pong);
        let key = key.unwrap();
        socket.close(None).await.unwrap();
        // Reconnect has no automatic request replay. Only this explicit read is sent.
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(socket).await.unwrap();
        let _ = socket.next().await.unwrap().unwrap();
        socket
            .send(Message::Text(
                serde_json::to_string(&RelayFrame::Ready).unwrap().into(),
            ))
            .await
            .unwrap();
        socket
            .send(Message::Text(
                serde_json::to_string(&RelayFrame::Request {
                    id: "transport-query".into(),
                    request: authenticated(&p, MobileAction::Delivery { key: key.clone() }),
                })
                .unwrap()
                .into(),
            ))
            .await
            .unwrap();
        loop {
            match tokio::time::timeout(Duration::from_secs(3), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
            {
                Message::Text(text) => {
                    let HostFrame::Response { id, response } =
                        serde_json::from_str::<HostFrame>(text.as_ref()).unwrap()
                    else {
                        panic!("response")
                    };
                    assert_eq!(id, "transport-query");
                    assert!(response.ok);
                    assert_eq!(response.result.unwrap()["key"], key);
                    break;
                }
                Message::Ping(payload) => socket.send(Message::Pong(payload)).await.unwrap(),
                _ => {}
            }
        }
        key
    });
    let stop = CancellationToken::new();
    let worker = tokio::spawn(run_outbound(
        mobile.clone(),
        OutboundConfig {
            url: format!("ws://{address}/api/mobile/host"),
            key: host_key,
            allow_loopback_ws: true,
        },
        stop.clone(),
    ));
    let key = tokio::time::timeout(Duration::from_secs(10), server)
        .await
        .unwrap()
        .unwrap();
    gateway.dispatch(&key).await.unwrap();
    assert_eq!(native.effects.load(Ordering::SeqCst), 1);
    stop.cancel();
    tokio::time::timeout(Duration::from_secs(5), worker)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(native.effects.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn expiry_invalid_scope_and_private_store_owner_fail_closed() {
    let (root, _, gateway, mobile) = setup().await;
    assert!(MobileHost::open(gateway.clone(), &root.path().join("mobile")).is_err());
    assert!(MobileHost::open(
        Gateway::open(
            &root.path().join("other-gateway"),
            "other-host".into(),
            Arc::new(Native::default())
        )
        .unwrap(),
        &root.path().join("mobile")
    )
    .is_err());
    let mut invalid = scopes();
    invalid.sessions.clear();
    assert_eq!(
        mobile.create_pairing(invalid, 300).await.err(),
        Some(ErrorCode::InvalidRequest)
    );
    assert_eq!(
        mobile.create_pairing(scopes(), 301).await.err(),
        Some(ErrorCode::InvalidRequest)
    );
    let offer = mobile.create_pairing(scopes(), 1).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    assert_eq!(
        mobile
            .handle(MobileRequest::Pair {
                code: offer.code,
                name: "Expired phone".into()
            })
            .await
            .error,
        Some(ErrorCode::PairExpired)
    );
    assert!(mobile.devices().await.unwrap().is_empty());
    // A rejected expired code still advances the durable clock watermark.
    let journal = rusqlite::Connection::open(root.path().join("mobile/mobile.sqlite")).unwrap();
    let watermark: String = journal
        .query_row("SELECT value FROM meta WHERE key='clock'", [], |r| r.get(0))
        .unwrap();
    assert!(watermark.parse::<u64>().unwrap() >= offer.expires_at_ms);
    journal
        .execute(
            "UPDATE meta SET value=?1 WHERE key='clock'",
            [u64::MAX.to_string()],
        )
        .unwrap();
    assert_eq!(
        mobile.create_pairing(scopes(), 300).await.err(),
        Some(ErrorCode::StorageUnavailable)
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(root.path().join("mobile"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        for name in [
            "consumer.lock",
            "mobile.sqlite",
            "mobile.sqlite-wal",
            "mobile.sqlite-shm",
        ] {
            assert_eq!(
                std::fs::metadata(root.path().join("mobile").join(name))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
#[cfg(unix)]
#[tokio::test]
async fn journal_root_and_leaf_symlinks_never_touch_external_targets() {
    use std::os::unix::fs::symlink;
    let (root, _, gateway, mobile) = setup().await;
    drop(mobile);
    let external = root.path().join("external");
    std::fs::write(&external, b"UNTOUCHED").unwrap();
    let alias = root.path().join("alias");
    symlink(root.path().join("mobile"), &alias).unwrap();
    assert!(MobileHost::open(gateway.clone(), &alias).is_err());
    for leaf in [
        "consumer.lock",
        "mobile.sqlite",
        "mobile.sqlite-wal",
        "mobile.sqlite-shm",
    ] {
        let child = root.path().join(format!("leaf-{}", leaf.replace('.', "-")));
        std::fs::create_dir(&child).unwrap();
        symlink(&external, child.join(leaf)).unwrap();
        assert!(MobileHost::open(gateway.clone(), &child).is_err());
        assert_eq!(std::fs::read(&external).unwrap(), b"UNTOUCHED");
    }
}

#[tokio::test]
async fn duplicate_command_never_discloses_a_result_from_a_removed_permission_scope() {
    let (_root, native, gateway, mobile) = setup().await;
    let p = pair(&mobile).await;
    let action = MobileAction::Command {
        request_id: "catalogue-before-scope-change".into(),
        generation: 1,
        command: Command::Catalogue { after: None },
    };
    let accepted = mobile.handle(authenticated(&p, action.clone())).await;
    let key = accepted.result.unwrap()["key"].as_str().unwrap().to_owned();
    gateway.dispatch(&key).await.unwrap();
    let first = mobile.handle(authenticated(&p, action.clone())).await;
    assert_eq!(
        first.result.unwrap()["result"]["value"]["catalogue"]["sessions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    // Trusted composition may revise a Principal independently of its binding.
    // Current bound s1 remains valid; the old catalogue's s2 is no longer granted.
    let mut principal = gateway
        .grant_page(None)
        .await
        .unwrap()
        .items
        .remove(0)
        .principal;
    principal.revision += 1;
    principal.sessions.remove("s2");
    gateway.set_principal(principal).await.unwrap();
    let repeated = mobile.handle(authenticated(&p, action)).await;
    assert!(repeated.ok);
    let receipt = repeated.result.unwrap();
    assert_eq!(receipt["state"], "completed");
    assert_eq!(receipt["result_withheld"], true);
    assert!(receipt["result"].is_null());
    let queried = mobile
        .handle(authenticated(&p, MobileAction::Delivery { key }))
        .await;
    assert!(queried.result.unwrap()["result"].is_null());
    assert_eq!(native.effects.load(Ordering::SeqCst), 0);
}

#[test]
fn tagged_unit_variants_remain_wire_compatible_but_reject_extra_and_duplicate_fields() {
    use xharness_mobile::protocol::RelayFrame;
    for action in [MobileAction::Status, MobileAction::Snapshot] {
        let wire = serde_json::to_string(&action).unwrap();
        let decoded: MobileAction = serde_json::from_str(&wire).unwrap();
        assert_eq!(serde_json::to_string(&decoded).unwrap(), wire);
        let mut forged: Value = serde_json::from_str(&wire).unwrap();
        forged["device"] = json!("forged");
        assert!(serde_json::from_value::<MobileAction>(forged).is_err());
    }
    let ready = serde_json::to_string(&RelayFrame::Ready).unwrap();
    assert!(matches!(
        serde_json::from_str::<RelayFrame>(&ready).unwrap(),
        RelayFrame::Ready
    ));
    assert!(serde_json::from_value::<RelayFrame>(
        json!({"type":"ready","request":{"type":"status"}})
    )
    .is_err());
    for command in [
        json!({"type":"cancel","session":"foreign"}),
        json!({"type":"answer_interaction","ticket":"a".repeat(48),"answer":{"type":"cancel_question","native_rpc":"foreign"}}),
    ] {
        assert!(serde_json::from_value::<MobileAction>(
            json!({"type":"command","request_id":"original","generation":1,"command":command})
        )
        .is_err());
    }
    for command in [
        json!({"type":"cancel"}),
        json!({"type":"answer_interaction","ticket":"a".repeat(48),"answer":{"type":"cancel_question"}}),
    ] {
        let action: MobileAction = serde_json::from_value(
            json!({"type":"command","request_id":"original","generation":1,"command":command}),
        )
        .unwrap();
        let wire = serde_json::to_string(&action).unwrap();
        assert_eq!(
            serde_json::to_string(&serde_json::from_str::<MobileAction>(&wire).unwrap()).unwrap(),
            wire
        );
    }
    for duplicate in [
        r#"{"type":"status","type":"status"}"#,
        r#"{"type":"catalogue","after":null,"after":null}"#,
        r#"{"type":"command","request_id":"one","request_id":"two","generation":1,"command":{"type":"cancel"}}"#,
        r#"{"type":"command","request_id":"one","generation":1,"command":{"type":"cancel","type":"cancel"}}"#,
        r#"{"type":"command","request_id":"one","generation":1,"command":{"type":"prompt","mode":"queue","content":[{"type":"text","text":"first","text":"second"}]}}"#,
    ] {
        assert!(serde_json::from_str::<MobileAction>(duplicate).is_err());
    }
    assert!(serde_json::from_str::<RelayFrame>(r#"{"type":"ready","type":"ready"}"#).is_err());
}

#[tokio::test]
async fn shared_request_lookup_keeps_legacy_key_exact_and_never_has_native_effects() {
    use sha2::{Digest, Sha256};
    use xharness_remote::{Channel, Sender};
    let (_root, native, gateway, mobile) = setup().await;
    let p = pair(&mobile).await;
    let request_id = "canonical-key-compatibility";
    let action = MobileAction::Command {
        request_id: request_id.into(),
        generation: 1,
        command: prompt(),
    };
    let admitted = mobile.handle(authenticated(&p, action)).await;
    assert!(admitted.ok);
    let key = admitted.result.unwrap()["key"].as_str().unwrap().to_owned();
    let sender = Sender {
        channel: Channel::MobileWeb,
        account: "mobile".into(),
        user: p.device.clone(),
    };
    let legacy = format!(
        "remote-v1-{}",
        hex::encode(Sha256::digest(
            serde_json::to_vec(&json!([1, gateway.host_id(), sender, p.device, request_id]))
                .unwrap()
        ))
    );
    assert_eq!(key, legacy);
    let recovered = gateway
        .inspect_request(sender.clone(), p.device.clone(), request_id.into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovered.key, key);
    assert!(gateway
        .inspect_request(
            sender.clone(),
            "different-conversation".into(),
            request_id.into()
        )
        .await
        .unwrap()
        .is_none());
    let foreign = Sender {
        user: "different-device".into(),
        ..sender
    };
    assert!(gateway
        .inspect_request(foreign, p.device.clone(), request_id.into())
        .await
        .unwrap()
        .is_none());
    assert_eq!(native.effects.load(Ordering::SeqCst), 0);
}

use async_trait::async_trait;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use xharness_api::{
    ApiBackend, ClientResponse, EventStream, RpcError, RpcId, RpcMethod, RpcReceipt, RpcResult,
    ScopedCatalogueQuery, ScopedSessionCreate, ScopedSessionCreated,
};
use xharness_remote::*;
#[derive(Clone, Copy)]
enum Mode {
    Normal,
    LostAck,
    AbsentError,
    Forged,
    ForeignOwned,
    Wait,
}
struct Host {
    mode: Mode,
    calls: AtomicUsize,
    receipts: Mutex<BTreeMap<String, ScopedSessionCreated>>,
    entered: Notify,
    release: Notify,
}
impl Host {
    fn new(mode: Mode) -> Arc<Self> {
        Arc::new(Self {
            mode,
            calls: AtomicUsize::new(0),
            receipts: Mutex::new(BTreeMap::new()),
            entered: Notify::new(),
            release: Notify::new(),
        })
    }
}
#[async_trait]
impl ApiBackend for Host {
    async fn call(&self, _: RpcId, _: RpcMethod, _: Value, _: CancellationToken) -> RpcResult {
        panic!("no generic RPC, prompt, cwd or model");
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("no interaction");
    }
    fn mux_events(&self) -> EventStream {
        panic!("no global stream");
    }
    fn host_events(&self) -> EventStream {
        panic!("no global stream");
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
        Ok(w == "w"
            && (s == "s"
                || (!matches!(self.mode, Mode::ForeignOwned)
                    && self
                        .receipts
                        .lock()
                        .unwrap()
                        .values()
                        .any(|r| r.session == s))))
    }
    async fn scoped_catalogue(
        &self,
        q: ScopedCatalogueQuery,
    ) -> Result<ScopedCataloguePage, RpcError> {
        Ok(ScopedCataloguePage {
            workspaces: vec![CatalogueWorkspace {
                id: "w".into(),
                title: "Native".into(),
            }],
            sessions: q
                .sessions
                .iter()
                .map(|s| CatalogueSession {
                    workspace: "w".into(),
                    id: s.clone(),
                    title: None,
                    running: false,
                    restoring: false,
                })
                .collect(),
            next: None,
        })
    }
    async fn create_scoped_session(
        &self,
        request: ScopedSessionCreate,
    ) -> Result<ScopedSessionCreated, RpcError> {
        assert!(request.is_bounded());
        self.calls.fetch_add(1, Ordering::SeqCst);
        if matches!(self.mode, Mode::Wait) {
            self.entered.notify_one();
            self.release.notified().await;
        }
        if !matches!(self.mode, Mode::AbsentError) {
            self.receipts
                .lock()
                .unwrap()
                .insert(request.request_key.clone(), request.receipt());
        }
        if matches!(self.mode, Mode::LostAck | Mode::AbsentError) {
            return Err(RpcError::internal("lost native acknowledgement"));
        }
        Ok(request.receipt())
    }
    async fn scoped_session_creation_receipt(
        &self,
        request: ScopedSessionCreate,
    ) -> Result<Option<ScopedSessionCreated>, RpcError> {
        if matches!(self.mode, Mode::Forged) {
            let mut r = request.receipt();
            r.session = "foreign".into();
            return Ok(Some(r));
        }
        Ok(self
            .receipts
            .lock()
            .unwrap()
            .get(&request.request_key)
            .cloned())
    }
}
async fn setup(g: &Gateway) -> Subscription {
    let sender = Sender {
        channel: Channel::MobileWeb,
        account: "paired".into(),
        user: "u".into(),
    };
    g.set_principal(Principal {
        id: "p".into(),
        host: "h".into(),
        sender: sender.clone(),
        workspaces: ["w".into()].into(),
        sessions: ["s".into()].into(),
        revision: 1,
        revoked: false,
    })
    .await
    .unwrap();
    g.bind(Binding {
        id: "b".into(),
        principal: "p".into(),
        conversation: "c".into(),
        workspace: "w".into(),
        session: "s".into(),
        generation: 1,
    })
    .await
    .unwrap();
    Subscription {
        principal: "p".into(),
        sender,
        conversation: "c".into(),
        binding: "b".into(),
        generation: 1,
    }
}
async fn allow(g: &Gateway, revision: u64, generation: u64) {
    g.set_creation_policy(CreationPolicy {
        principal: "p".into(),
        principal_revision: revision,
        generation,
        workspaces: ["w".into()].into(),
    })
    .await
    .unwrap();
}
fn request(id: &str) -> SessionCreationRequest {
    SessionCreationRequest {
        request_id: id.into(),
        workspace: "w".into(),
    }
}
#[tokio::test]
async fn create_requires_explicit_capability_preserves_binding_rotates_revision_and_is_durable() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new(Mode::Normal);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let scope = setup(&g).await;
    assert!(matches!(
        g.controller_create(scope.clone(), request("create")).await,
        Err(Error::Unauthorized)
    ));
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    let bad = CreationPolicy {
        principal: "p".into(),
        principal_revision: 1,
        generation: 1,
        workspaces: ["foreign".into()].into(),
    };
    assert!(matches!(
        g.set_creation_policy(bad).await,
        Err(Error::Unauthorized)
    ));
    allow(&g, 1, 1).await;
    let a = g
        .controller_create(scope.clone(), request("create"))
        .await
        .unwrap();
    assert_eq!(a.state, SessionCreationState::Granted);
    assert_eq!(a.granted_revision, Some(2));
    assert_eq!(a.principal_revision, 1);
    assert_eq!(a.binding.session, "s");
    let page = g.controller_catalogue(scope.clone(), None).await.unwrap();
    assert_eq!(page.principal_revision, 2);
    assert_eq!(page.binding_generation, 1);
    assert_eq!(page.catalogue.sessions.len(), 2);
    assert_eq!(
        g.controller_create(scope.clone(), request("create"))
            .await
            .unwrap(),
        a
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    let b = g
        .controller_create(scope.clone(), request("next"))
        .await
        .unwrap();
    assert_eq!(b.granted_revision, Some(3));
    assert_ne!(a.created, b.created);
    let changed = SessionCreationRequest {
        request_id: "create".into(),
        workspace: "foreign".into(),
    };
    assert!(matches!(
        g.controller_create(scope.clone(), changed).await,
        Err(Error::IdentityConflict)
    ));
    g.close().await.unwrap();
    drop(g);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    assert_eq!(
        g.controller_create(scope.clone(), request("create"))
            .await
            .unwrap(),
        a
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 2);
    let selected = g
        .controller_select(
            scope.clone(),
            SessionSelection {
                workspace: "w".into(),
                session: a.created.unwrap().session,
            },
        )
        .await
        .unwrap();
    assert_eq!(selected.generation, 2);
    assert!(matches!(
        g.controller_create(scope.clone(), request("create")).await,
        Err(Error::Unauthorized)
    ));
    let mut current = scope;
    current.generation = 2;
    assert_eq!(
        g.controller_create(current.clone(), request("create"))
            .await
            .unwrap()
            .state,
        SessionCreationState::Granted
    );
    g.bind(Binding {
        id: "replacement".into(),
        principal: "p".into(),
        conversation: "c".into(),
        workspace: "w".into(),
        session: "s".into(),
        generation: 1,
    })
    .await
    .unwrap();
    let mut replacement = current.clone();
    replacement.binding = "replacement".into();
    replacement.generation = 1;
    assert_eq!(
        g.controller_create(replacement, request("create"))
            .await
            .unwrap()
            .key,
        a.key
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 2);
    g.revoke("p").await.unwrap();
    assert!(matches!(
        g.controller_create(current, request("create")).await,
        Err(Error::Unauthorized)
    ));
    assert_eq!(h.calls.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn lost_native_ack_reconciles_original_receipt_after_reopen_without_second_create() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new(Mode::LostAck);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let scope = setup(&g).await;
    allow(&g, 1, 1).await;
    let a = g
        .controller_create(scope.clone(), request("lost"))
        .await
        .unwrap();
    assert_eq!(a.state, SessionCreationState::Uncertain);
    assert!(a.created.is_none());
    assert_eq!(
        g.controller_catalogue(scope.clone(), None)
            .await
            .unwrap()
            .principal_revision,
        1
    );
    g.close().await.unwrap();
    drop(g);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let b = g
        .controller_create(scope.clone(), request("lost"))
        .await
        .unwrap();
    assert_eq!(b.state, SessionCreationState::Granted);
    assert_eq!(a.key, b.key);
    assert_eq!(a.scope, b.scope);
    assert_eq!(b.granted_revision, Some(2));
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        g.controller_create(scope, request("lost")).await.unwrap(),
        b
    );
}
#[tokio::test]
async fn missing_or_forged_proof_never_grants_or_replays_uncertain_effect() {
    for mode in [Mode::AbsentError, Mode::Forged, Mode::ForeignOwned] {
        let root = tempfile::tempdir().unwrap();
        let h = Host::new(mode);
        let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
        let scope = setup(&g).await;
        allow(&g, 1, 1).await;
        for _ in 0..3 {
            let a = g
                .controller_create(scope.clone(), request("unknown"))
                .await
                .unwrap();
            assert_eq!(a.state, SessionCreationState::Uncertain);
            assert!(a.created.is_none());
        }
        assert_eq!(
            g.controller_catalogue(scope, None)
                .await
                .unwrap()
                .principal_revision,
            1
        );
        assert_eq!(
            h.calls.load(Ordering::SeqCst),
            usize::from(matches!(mode, Mode::AbsentError | Mode::ForeignOwned))
        );
    }
}
#[tokio::test]
async fn caller_disconnect_does_not_cancel_creation_and_revoke_waits_for_atomic_grant() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new(Mode::Wait);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let scope = setup(&g).await;
    allow(&g, 1, 1).await;
    let caller = tokio::spawn({
        let g = g.clone();
        let s = scope.clone();
        async move { g.controller_create(s, request("disconnect")).await }
    });
    h.entered.notified().await;
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    let revoked = tokio::spawn({
        let g = g.clone();
        async move { g.revoke("p").await }
    });
    tokio::task::yield_now().await;
    assert!(!revoked.is_finished());
    h.release.notify_one();
    revoked.await.unwrap().unwrap();
    assert!(matches!(
        g.controller_create(scope, request("disconnect")).await,
        Err(Error::Unauthorized)
    ));
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    let connection = rusqlite::Connection::open(root.path().join("remote.sqlite")).unwrap();
    let body: String = connection
        .query_row(
            "SELECT body FROM entities WHERE kind='session-creation'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let record: SessionCreation = serde_json::from_str(&body).unwrap();
    assert_eq!(record.state, SessionCreationState::Granted);
    assert_eq!(record.granted_revision, Some(2));
}
#[tokio::test]
async fn policy_cas_principal_edits_and_exact_transport_identity_fail_closed() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new(Mode::Normal);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let scope = setup(&g).await;
    allow(&g, 1, 1).await;
    assert!(matches!(
        g.set_creation_policy(CreationPolicy {
            principal: "p".into(),
            principal_revision: 1,
            generation: 1,
            workspaces: ["w".into()].into()
        })
        .await,
        Err(Error::IdentityConflict)
    ));
    for dimension in 0..6 {
        let mut bad = scope.clone();
        match dimension {
            0 => bad.principal = "foreign".into(),
            1 => bad.sender.account = "foreign".into(),
            2 => bad.sender.user = "foreign".into(),
            3 => bad.sender.channel = Channel::Telegram,
            4 => bad.conversation = "foreign".into(),
            _ => bad.generation = 2,
        };
        assert!(matches!(
            g.controller_create(bad, request("bad")).await,
            Err(Error::Unauthorized)
        ));
    }
    g.set_principal(Principal {
        id: "p".into(),
        host: "h".into(),
        sender: scope.sender.clone(),
        workspaces: ["w".into()].into(),
        sessions: ["s".into()].into(),
        revision: 2,
        revoked: false,
    })
    .await
    .unwrap();
    assert!(matches!(
        g.controller_create(scope.clone(), request("stale-policy"))
            .await,
        Err(Error::Unauthorized)
    ));
    allow(&g, 2, 2).await;
    g.set_creation_policy(CreationPolicy {
        principal: "p".into(),
        principal_revision: 2,
        generation: 3,
        workspaces: Default::default(),
    })
    .await
    .unwrap();
    assert!(matches!(
        g.controller_create(scope, request("disabled")).await,
        Err(Error::Unauthorized)
    ));
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn gateway_close_drains_owned_creations_and_rejects_new_attempts_before_wal_release() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new(Mode::Wait);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let scope = setup(&g).await;
    allow(&g, 1, 1).await;
    let caller = tokio::spawn({
        let g = g.clone();
        let s = scope.clone();
        async move { g.controller_create(s, request("shutdown")).await }
    });
    h.entered.notified().await;
    let mut a = Box::pin(g.close());
    let mut b = Box::pin(g.close());
    assert!(futures::poll!(&mut a).is_pending());
    assert!(futures::poll!(&mut b).is_pending());
    assert!(matches!(
        g.controller_create(scope.clone(), request("too-late"))
            .await,
        Err(Error::Closed)
    ));
    assert!(matches!(
        Gateway::open(root.path(), "h".into(), h.clone()),
        Err(Error::ConsumerBusy)
    ));
    h.release.notify_one();
    let original = caller.await.unwrap().unwrap();
    assert_eq!(original.state, SessionCreationState::Granted);
    a.await.unwrap();
    b.await.unwrap();
    assert!(matches!(
        g.controller_create(scope.clone(), request("shutdown"))
            .await,
        Err(Error::Closed)
    ));
    let reopened = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    assert_eq!(
        reopened
            .controller_create(scope, request("shutdown"))
            .await
            .unwrap(),
        original
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn native_wait_timeout_does_not_cancel_writer_or_release_drain_slot_and_recovers_without_replay(
) {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new(Mode::Wait);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let scope = setup(&g).await;
    allow(&g, 1, 1).await;
    let caller = tokio::spawn({
        let g = g.clone();
        let s = scope.clone();
        async move { g.controller_create(s, request("timeout")).await }
    });
    h.entered.notified().await;
    let uncertain = caller.await.unwrap().unwrap();
    assert_eq!(uncertain.state, SessionCreationState::Uncertain);
    assert!(h.receipts.lock().unwrap().is_empty());
    let mut closing = Box::pin(g.close());
    assert!(futures::poll!(&mut closing).is_pending());
    assert!(matches!(
        Gateway::open(root.path(), "h".into(), h.clone()),
        Err(Error::ConsumerBusy)
    ));
    h.release.notify_one();
    closing.await.unwrap();
    let reopened = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let granted = reopened
        .controller_create(scope, request("timeout"))
        .await
        .unwrap();
    assert_eq!(granted.state, SessionCreationState::Granted);
    assert_eq!(granted.key, uncertain.key);
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
}

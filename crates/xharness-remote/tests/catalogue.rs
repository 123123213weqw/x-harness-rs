//! Authenticated exact-scope catalogue: no global RPC, path or native effects.
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use xharness_api::{
    ApiBackend, ClientResponse, EventStream, RpcError, RpcId, RpcMethod, RpcReceipt, RpcResult,
    ScopedCatalogueQuery,
};
use xharness_remote::*;
struct Host {
    calls: AtomicUsize,
    forged: bool,
    slow: bool,
}
#[async_trait]
impl ApiBackend for Host {
    async fn call(&self, _: RpcId, _: RpcMethod, _: Value, _: CancellationToken) -> RpcResult {
        panic!("no catalogue generic RPC");
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("no native effect");
    }
    fn mux_events(&self) -> EventStream {
        panic!("no global stream");
    }
    fn host_events(&self) -> EventStream {
        panic!("no global stream");
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
        Ok(w == "w" && s == "s")
    }
    async fn scoped_catalogue(
        &self,
        q: ScopedCatalogueQuery,
    ) -> Result<ScopedCataloguePage, RpcError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(q.workspaces, ["w".into()].into());
        assert_eq!(q.sessions, ["s".into()].into());
        if self.slow {
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
        Ok(ScopedCataloguePage {
            workspaces: vec![CatalogueWorkspace {
                id: "w".into(),
                title: "Native".into(),
            }],
            sessions: vec![CatalogueSession {
                workspace: "w".into(),
                id: if self.forged { "foreign" } else { "s" }.into(),
                title: Some("Title".into()),
                running: false,
                restoring: false,
            }],
            next: None,
        })
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
#[tokio::test]
async fn controller_catalogue_checks_sender_binding_cursor_revoke_reopen_and_closed_handles() {
    let d = tempfile::tempdir().unwrap();
    let h = Arc::new(Host {
        calls: AtomicUsize::new(0),
        forged: false,
        slow: false,
    });
    let g = Gateway::open(d.path(), "h".into(), h.clone()).unwrap();
    let scope = setup(&g).await;
    let page = g.controller_catalogue(scope.clone(), None).await.unwrap();
    assert_eq!(page.principal_revision, 1);
    assert_eq!(page.binding_generation, 1);
    let mut wrong_sender = scope.clone();
    wrong_sender.sender.user = "attacker".into();
    let mut wrong_account = scope.clone();
    wrong_account.sender.account = "foreign".into();
    let mut wrong_channel = scope.clone();
    wrong_channel.sender.channel = Channel::Telegram;
    let mut wrong_binding = scope.clone();
    wrong_binding.binding = "foreign".into();
    for bad in [wrong_sender, wrong_account, wrong_channel, wrong_binding] {
        assert!(matches!(
            g.controller_catalogue(bad, None).await,
            Err(Error::Unauthorized)
        ));
    }
    let mut bad = scope.clone();
    bad.conversation = "other".into();
    assert!(matches!(
        g.controller_catalogue(bad, None).await,
        Err(Error::Unauthorized)
    ));
    bad = scope.clone();
    bad.generation = 2;
    assert!(matches!(
        g.controller_catalogue(bad, None).await,
        Err(Error::Unauthorized)
    ));
    bad = scope.clone();
    bad.principal = "other".into();
    assert!(matches!(
        g.controller_catalogue(bad, None).await,
        Err(Error::Unauthorized)
    ));
    assert!(g
        .controller_catalogue(
            scope.clone(),
            Some(CatalogueCursor {
                workspace: "w".into(),
                session: "not-authorized".into()
            })
        )
        .await
        .is_err());
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    g.close().await.unwrap();
    assert!(matches!(
        g.controller_catalogue(scope.clone(), None).await,
        Err(Error::Closed)
    ));
    let g = Gateway::open(d.path(), "h".into(), h.clone()).unwrap();
    g.controller_catalogue(scope.clone(), None).await.unwrap();
    g.revoke("p").await.unwrap();
    assert!(matches!(
        g.controller_catalogue(scope, None).await,
        Err(Error::Unauthorized)
    ));
    assert_eq!(h.calls.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn forged_native_catalogue_cannot_leak_foreign_metadata() {
    let d = tempfile::tempdir().unwrap();
    let g = Gateway::open(
        d.path(),
        "h".into(),
        Arc::new(Host {
            calls: AtomicUsize::new(0),
            forged: true,
            slow: false,
        }),
    )
    .unwrap();
    let s = setup(&g).await;
    assert!(matches!(
        g.controller_catalogue(s, None).await,
        Err(Error::Invalid("unscoped catalogue response"))
    ));
}
#[tokio::test]
async fn bounded_catalogue_read_cannot_hold_revoke_indefinitely() {
    let d = tempfile::tempdir().unwrap();
    let h = Arc::new(Host {
        calls: AtomicUsize::new(0),
        forged: false,
        slow: true,
    });
    let g = Gateway::open(d.path(), "h".into(), h.clone()).unwrap();
    let s = setup(&g).await;
    let read = tokio::spawn({
        let g = g.clone();
        async move { g.controller_catalogue(s, None).await }
    });
    tokio::time::timeout(Duration::from_secs(1), async {
        while h.calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(3), g.revoke("p"))
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(read.await.unwrap(), Err(Error::HostUnavailable)));
}
#[tokio::test]
async fn genuine_native_gateway_catalogue_filters_unauthorized_archived_and_cwd_without_model() {
    use xharness_host::{BasicHost, HostConfig, NoTools};
    let d = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let h = BasicHost::new(HostConfig::new(root.path()), None, Arc::new(NoTools));
    for (id, cwd) in [
        ("s", root.path()),
        ("private", root.path()),
        ("outside", outside.path()),
    ] {
        let r = h
            .call(
                RpcId::new(id),
                RpcMethod::SessionCreate,
                json!({"sessionId":id,"cwd":cwd}),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(r, RpcResult::Success { .. }), "{r:?}");
    }
    let g = Gateway::open(d.path(), "h".into(), h.clone()).unwrap();
    let sender = Sender {
        channel: Channel::MobileWeb,
        account: "paired".into(),
        user: "u".into(),
    };
    g.set_principal(Principal {
        id: "p".into(),
        host: "h".into(),
        sender: sender.clone(),
        workspaces: ["workspace-default".into()].into(),
        sessions: ["s".into(), "outside".into()].into(),
        revision: 1,
        revoked: false,
    })
    .await
    .unwrap();
    g.bind(Binding {
        id: "b".into(),
        principal: "p".into(),
        conversation: "c".into(),
        workspace: "workspace-default".into(),
        session: "s".into(),
        generation: 1,
    })
    .await
    .unwrap();
    let scope = Subscription {
        principal: "p".into(),
        sender,
        conversation: "c".into(),
        binding: "b".into(),
        generation: 1,
    };
    let page = g.controller_catalogue(scope.clone(), None).await.unwrap();
    assert_eq!(page.catalogue.sessions.len(), 1);
    assert_eq!(page.catalogue.sessions[0].id, "s");
    let wire = serde_json::to_value(&page).unwrap();
    assert!(wire["catalogue"]["sessions"][0].get("cwd").is_none());
    let r = h
        .call(
            RpcId::new("archive"),
            RpcMethod::WorkspaceArchiveSession,
            json!({"sessionId":"s"}),
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(r, RpcResult::Success { .. }), "{r:?}");
    assert!(g
        .controller_catalogue(scope, None)
        .await
        .unwrap()
        .catalogue
        .sessions
        .is_empty());
}

#[tokio::test]
async fn controller_selection_is_exact_granted_native_cas_and_invalidates_old_handles() {
    use xharness_host::{BasicHost, HostConfig, NoTools};
    let d = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let h = BasicHost::new(HostConfig::new(root.path()), None, Arc::new(NoTools));
    for id in ["s", "new", "private"] {
        let r = h
            .call(
                RpcId::new(id),
                RpcMethod::SessionCreate,
                json!({"workspaceId":"workspace-default","sessionId":id}),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(r, RpcResult::Success { .. }), "{r:?}");
    }
    let g = Gateway::open(d.path(), "h".into(), h.clone()).unwrap();
    let sender = Sender {
        channel: Channel::MobileWeb,
        account: "paired".into(),
        user: "u".into(),
    };
    g.set_principal(Principal {
        id: "p".into(),
        host: "h".into(),
        sender: sender.clone(),
        workspaces: ["workspace-default".into()].into(),
        sessions: ["s".into(), "new".into()].into(),
        revision: 1,
        revoked: false,
    })
    .await
    .unwrap();
    g.bind(Binding {
        id: "b".into(),
        principal: "p".into(),
        conversation: "c".into(),
        workspace: "workspace-default".into(),
        session: "s".into(),
        generation: 1,
    })
    .await
    .unwrap();
    let old = Subscription {
        principal: "p".into(),
        sender,
        conversation: "c".into(),
        binding: "b".into(),
        generation: 1,
    };
    for (workspace, session) in [("unregistered", "new"), ("workspace-default", "private")] {
        assert!(matches!(
            g.controller_select(
                old.clone(),
                SessionSelection {
                    workspace: workspace.into(),
                    session: session.into()
                }
            )
            .await,
            Err(Error::Unauthorized)
        ));
        assert_eq!(
            g.grant_page(None).await.unwrap().items[0].bindings[0].generation,
            1
        );
    }
    assert!(serde_json::from_value::<SessionSelection>(
        json!({"workspace":"workspace-default","session":"new","cwd":"/other"})
    )
    .is_err());
    let target = SessionSelection {
        workspace: "workspace-default".into(),
        session: "new".into(),
    };
    let (first, second) = tokio::join!(
        g.controller_select(old.clone(), target.clone()),
        g.controller_select(old.clone(), target.clone())
    );
    let selected = match (first, second) {
        (Ok(selected), Err(Error::Unauthorized)) | (Err(Error::Unauthorized), Ok(selected)) => {
            selected
        }
        unexpected => panic!("selection must commit exactly one generation: {unexpected:?}"),
    };
    assert_eq!(selected.generation, 2);
    assert_eq!(selected.session, "new");
    assert!(matches!(
        g.controller_catalogue(old.clone(), None).await,
        Err(Error::Unauthorized)
    ));
    assert!(matches!(
        g.controller_select(old.clone(), target.clone()).await,
        Err(Error::Unauthorized)
    ));
    let current = Subscription {
        generation: 2,
        ..old
    };
    assert_eq!(
        g.controller_select(current.clone(), target.clone())
            .await
            .unwrap(),
        selected
    ); // actual no-op, not a new generation
    let page = g.controller_catalogue(current.clone(), None).await.unwrap();
    assert_eq!(page.principal_revision, 1);
    assert_eq!(page.binding_generation, 2);
    g.close().await.unwrap();
    let g = Gateway::open(d.path(), "h".into(), h.clone()).unwrap();
    let r = h
        .call(
            RpcId::new("archive-selection"),
            RpcMethod::WorkspaceArchiveSession,
            json!({"sessionId":"s"}),
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(r, RpcResult::Success { .. }), "{r:?}");
    assert!(matches!(
        g.controller_select(
            current.clone(),
            SessionSelection {
                workspace: "workspace-default".into(),
                session: "s".into()
            }
        )
        .await,
        Err(Error::Unauthorized)
    ));
    assert_eq!(
        g.controller_catalogue(current.clone(), None)
            .await
            .unwrap()
            .binding_generation,
        2
    );
    g.revoke("p").await.unwrap();
    assert!(matches!(
        g.controller_select(current, target).await,
        Err(Error::Unauthorized)
    ));
}

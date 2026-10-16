//! Durable typed metadata commands: no generic directory RPC or Agent effects.
mod support;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use xharness_api::{
    ApiBackend, ClientResponse, EventStream, RpcError, RpcId, RpcMethod, RpcReceipt, RpcResult,
    ScopedCatalogueQuery,
};
use xharness_remote::*;
#[derive(Clone, Copy)]
enum Mode {
    Normal,
    Forged,
    Error,
    SlowRead,
    SlowScope,
    Wait,
}
struct Host {
    mode: Mode,
    reads: AtomicUsize,
    scope_pause: AtomicBool,
    scope_entered: Notify,
    scope_release: Notify,
    entered: Notify,
    release: Notify,
}
impl Host {
    fn new(mode: Mode) -> Arc<Self> {
        Arc::new(Self {
            mode,
            reads: AtomicUsize::new(0),
            scope_pause: AtomicBool::new(false),
            scope_entered: Notify::new(),
            scope_release: Notify::new(),
            entered: Notify::new(),
            release: Notify::new(),
        })
    }
}
#[async_trait]
impl ApiBackend for Host {
    async fn call(&self, _: RpcId, _: RpcMethod, _: Value, _: CancellationToken) -> RpcResult {
        panic!("metadata commands cannot use generic RPC or Agent");
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("no interaction response");
    }
    fn mux_events(&self) -> EventStream {
        panic!("no global stream");
    }
    fn host_events(&self) -> EventStream {
        panic!("no global stream");
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
        if self.scope_pause.load(Ordering::SeqCst) {
            self.scope_entered.notify_one();
            self.scope_release.notified().await;
        }
        if matches!(self.mode, Mode::SlowScope) {
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
        Ok(w == "w" && s == "s")
    }
    async fn scoped_catalogue(
        &self,
        q: ScopedCatalogueQuery,
    ) -> Result<ScopedCataloguePage, RpcError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        match self.mode {
            Mode::Wait => self.release.notified().await,
            Mode::SlowRead => tokio::time::sleep(Duration::from_secs(60)).await,
            Mode::Error => return Err(RpcError::internal("PRIVATE_NATIVE_ERROR")),
            _ => {}
        }
        let workspaces = ["w", "w2"]
            .into_iter()
            .filter(|w| q.workspaces.contains(*w))
            .map(|w| CatalogueWorkspace {
                id: w.into(),
                title: "Native workspace".into(),
            })
            .collect();
        let sessions = if matches!(self.mode, Mode::Forged) {
            vec![CatalogueSession {
                workspace: "w".into(),
                id: "PRIVATE_FOREIGN".into(),
                title: None,
                running: false,
                restoring: false,
            }]
        } else {
            [("w", "s"), ("w", "s2"), ("w2", "t")]
                .into_iter()
                .filter(|(w, s)| q.workspaces.contains(*w) && q.sessions.contains(*s))
                .map(|(w, s)| CatalogueSession {
                    workspace: w.into(),
                    id: s.into(),
                    title: Some("Native title".into()),
                    running: false,
                    restoring: false,
                })
                .filter(|s| q.after.as_ref().is_none_or(|after| s.cursor() > *after))
                .collect()
        };
        Ok(ScopedCataloguePage {
            workspaces,
            sessions,
            next: None,
        })
    }
}
async fn setup(g: &Gateway) -> Subscription {
    support::install_scope(
        g,
        Sender {
            channel: Channel::Telegram,
            account: "123".into(),
            user: "42".into(),
        },
        &["w", "w2"],
        &["s", "s2", "t"],
        ("w", "s"),
    )
    .await
}
async fn admit(
    g: &Gateway,
    s: &Subscription,
    id: &str,
    after: Option<CatalogueCursor>,
) -> Delivery {
    g.accept(
        "p",
        s.sender.clone(),
        s.conversation.clone(),
        Inbound {
            request_id: id.into(),
            binding: "b".into(),
            generation: 1,
            command: Command::Catalogue { after },
        },
    )
    .await
    .unwrap()
}
#[tokio::test]
async fn durable_catalogue_result_is_versioned_cached_and_reopened_without_native_reread() {
    let root = tempfile::tempdir().unwrap();
    let host = Host::new(Mode::Normal);
    let g = Gateway::open(root.path(), "h".into(), host.clone()).unwrap();
    let scope = setup(&g).await;
    let d = admit(&g, &scope, "catalogue", None).await;
    assert_eq!(d.state, DeliveryState::Queued);
    let done = g.dispatch(&d.key).await.unwrap();
    assert_eq!(done.state, DeliveryState::Completed);
    let Some(NativeCommandResult::Success { value: Some(value) }) = &done.result else {
        panic!("typed catalogue receipt");
    };
    let page: ControllerCatalogue = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(page.catalogue.sessions.len(), 3);
    assert!(page.is_bounded_after(None));
    assert_eq!(page.principal_revision, 1);
    assert_eq!(page.binding_generation, 1);
    assert_eq!(g.dispatch(&d.key).await.unwrap(), done);
    assert_eq!(host.reads.load(Ordering::SeqCst), 1);
    let lease = g
        .acquire_account(Account {
            channel: Channel::Telegram,
            id: "123".into(),
        })
        .await
        .unwrap();
    assert_eq!(
        g.command_reply_candidate(&lease, scope.clone())
            .await
            .unwrap(),
        Some(done.clone())
    );
    let plans = vec![ReplyPlan {
        id: "catalogue-result".into(),
        body: ReplyBody {
            text: "typed scoped catalogue".into(),
            buttons: vec![],
            attachment: None,
        },
        replace_of: None,
    }];
    let out = g
        .enqueue_command_replies(&lease, scope.clone(), done.clone(), plans.clone())
        .await
        .unwrap();
    assert!(g
        .command_reply_candidate(&lease, scope.clone())
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        g.enqueue_command_replies(&lease, scope.clone(), done.clone(), plans.clone())
            .await
            .unwrap(),
        out
    );
    g.close().await.unwrap();
    let host = Host::new(Mode::Normal);
    let g = Gateway::open(root.path(), "h".into(), host.clone()).unwrap();
    assert_eq!(g.dispatch(&d.key).await.unwrap(), done);
    assert_eq!(host.reads.load(Ordering::SeqCst), 0);
    assert!(g
        .command_reply_candidate(&lease, scope.clone())
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        g.enqueue_command_replies(&lease, scope, done, plans)
            .await
            .unwrap(),
        out
    );
    g.close().await.unwrap();
}
#[tokio::test]
async fn cursor_is_closed_and_cannot_grant_foreign_scope_or_change_permissions() {
    let root = tempfile::tempdir().unwrap();
    let host = Host::new(Mode::Normal);
    let g = Gateway::open(root.path(), "h".into(), host.clone()).unwrap();
    let scope = setup(&g).await;
    let before = g.grant_page(None).await.unwrap();
    for cursor in [
        CatalogueCursor {
            workspace: "foreign".into(),
            session: "s".into(),
        },
        CatalogueCursor {
            workspace: "w".into(),
            session: "foreign".into(),
        },
    ] {
        let d = admit(
            &g,
            &scope,
            &format!("bad-{}-{}", cursor.workspace, cursor.session),
            Some(cursor),
        )
        .await;
        let d = g.dispatch(&d.key).await.unwrap();
        assert_eq!(d.state, DeliveryState::Rejected);
        assert!(d.result.is_none());
    }
    assert_eq!(host.reads.load(Ordering::SeqCst), 0);
    assert!(serde_json::from_value::<Command>(
        json!({"type":"catalogue","after":{"workspace":"w","session":"s","cwd":"PRIVATE_PATH"}})
    )
    .is_err());
    let bad = Inbound {
        request_id: "invalid".into(),
        binding: "b".into(),
        generation: 1,
        command: Command::Catalogue {
            after: Some(CatalogueCursor {
                workspace: "w".into(),
                session: "\0".into(),
            }),
        },
    };
    assert!(matches!(
        g.accept("p", scope.sender.clone(), scope.conversation.clone(), bad)
            .await,
        Err(Error::Invalid(_))
    ));
    let d = admit(
        &g,
        &scope,
        "next",
        Some(CatalogueCursor {
            workspace: "w".into(),
            session: "s".into(),
        }),
    )
    .await;
    let d = g.dispatch(&d.key).await.unwrap();
    let Some(NativeCommandResult::Success { value: Some(value) }) = d.result else {
        panic!("page");
    };
    assert_eq!(value["catalogue"]["sessions"].as_array().unwrap().len(), 2);
    assert_eq!(g.grant_page(None).await.unwrap(), before);
    g.close().await.unwrap();
}
#[tokio::test]
async fn forged_unavailable_and_timed_out_reads_are_closed_cached_failures() {
    for mode in [Mode::Forged, Mode::Error, Mode::SlowRead] {
        let root = tempfile::tempdir().unwrap();
        let host = Host::new(mode);
        let g = Gateway::open(root.path(), "h".into(), host.clone()).unwrap();
        let scope = setup(&g).await;
        let d = admit(&g, &scope, "failure", None).await;
        let done = tokio::time::timeout(Duration::from_secs(5), g.dispatch(&d.key))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(done.state, DeliveryState::Completed);
        assert!(matches!(
            done.result,
            Some(NativeCommandResult::Failure { .. })
        ));
        assert!(!serde_json::to_string(&done).unwrap().contains("PRIVATE_"));
        assert_eq!(g.dispatch(&d.key).await.unwrap(), done);
        assert_eq!(host.reads.load(Ordering::SeqCst), 1);
        g.close().await.unwrap();
    }
    let root = tempfile::tempdir().unwrap();
    let host = Host::new(Mode::SlowScope);
    // A normal backend initializes the durable grant before testing scope timeout.
    let g = Gateway::open(root.path(), "h".into(), Host::new(Mode::Normal)).unwrap();
    let scope = setup(&g).await;
    g.close().await.unwrap();
    let g = Gateway::open(root.path(), "h".into(), host.clone()).unwrap();
    let d = admit(&g, &scope, "scope-timeout", None).await;
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(5), g.dispatch(&d.key))
            .await
            .unwrap(),
        Err(Error::HostUnavailable)
    ));
    assert_eq!(host.reads.load(Ordering::SeqCst), 0);
    assert_eq!(
        g.inspect(&d.key).await.unwrap().unwrap().state,
        DeliveryState::Queued
    );
    g.close().await.unwrap();
}
#[tokio::test]
async fn interrupted_durable_read_retries_the_scoped_cut_after_reopen_not_agent_admission() {
    let root = tempfile::tempdir().unwrap();
    let host = Host::new(Mode::Wait);
    let g = Gateway::open(root.path(), "h".into(), host.clone()).unwrap();
    let scope = setup(&g).await;
    let d = admit(&g, &scope, "interrupt", None).await;
    let work = g.clone();
    let key = d.key.clone();
    let task = tokio::spawn(async move { work.dispatch(&key).await });
    host.entered.notified().await;
    assert_eq!(
        g.inspect(&d.key).await.unwrap().unwrap().state,
        DeliveryState::Dispatching
    );
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    g.close().await.unwrap();
    drop(g);
    let host = Host::new(Mode::Normal);
    let g = Gateway::open(root.path(), "h".into(), host.clone()).unwrap();
    let done = g.dispatch(&d.key).await.unwrap();
    assert_eq!(done.state, DeliveryState::Completed);
    assert_eq!(host.reads.load(Ordering::SeqCst), 1);
    assert_eq!(g.dispatch(&d.key).await.unwrap(), done);
    assert_eq!(host.reads.load(Ordering::SeqCst), 1);
    g.close().await.unwrap();
}
#[tokio::test]
async fn queued_writer_cannot_deadlock_a_scoped_catalogue_read_or_deliver_after_revoke() {
    let root = tempfile::tempdir().unwrap();
    let host = Host::new(Mode::Normal);
    let g = Gateway::open(root.path(), "h".into(), host.clone()).unwrap();
    let scope = setup(&g).await;
    host.scope_pause.store(true, Ordering::SeqCst);
    let d = admit(&g, &scope, "writer", None).await;
    let work = g.clone();
    let key = d.key.clone();
    let task = tokio::spawn(async move { work.dispatch(&key).await });
    host.scope_entered.notified().await;
    let owner = g.clone();
    let (queued, ready) = tokio::sync::oneshot::channel();
    let revoke = tokio::spawn(async move {
        let mut write = Box::pin(owner.revoke("p"));
        futures::future::poll_fn(|cx| match std::future::Future::poll(write.as_mut(), cx) {
            std::task::Poll::Pending => std::task::Poll::Ready(()),
            std::task::Poll::Ready(result) => {
                panic!("writer must wait for original read: {result:?}")
            }
        })
        .await;
        queued.send(()).unwrap();
        write.await
    });
    ready.await.unwrap();
    assert!(!revoke.is_finished());
    host.scope_release.notify_one();
    let done = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(done.state, DeliveryState::Completed);
    tokio::time::timeout(Duration::from_secs(5), revoke)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let lease = g
        .acquire_account(Account {
            channel: Channel::Telegram,
            id: "123".into(),
        })
        .await
        .unwrap();
    assert!(matches!(
        g.command_reply_candidate(&lease, scope).await,
        Err(Error::Unauthorized)
    ));
    assert_eq!(host.reads.load(Ordering::SeqCst), 1);
    g.close().await.unwrap();
}
#[tokio::test]
async fn catalogue_keeps_the_existing_session_fifo_and_queued_revocation_fence() {
    let root = tempfile::tempdir().unwrap();
    let host = Host::new(Mode::Normal);
    let g = Gateway::open(root.path(), "h".into(), host.clone()).unwrap();
    let scope = setup(&g).await;
    let earlier = g
        .accept(
            "p",
            scope.sender.clone(),
            scope.conversation.clone(),
            Inbound {
                request_id: "earlier".into(),
                binding: "b".into(),
                generation: 1,
                command: Command::Cancel,
            },
        )
        .await
        .unwrap();
    let catalogue = admit(&g, &scope, "behind", None).await;
    assert!(matches!(
        g.dispatch(&catalogue.key).await,
        Err(Error::SessionBlocked)
    ));
    assert_eq!(host.reads.load(Ordering::SeqCst), 0);
    g.revoke("p").await.unwrap();
    assert_eq!(
        g.dispatch(&earlier.key).await.unwrap().state,
        DeliveryState::Rejected
    );
    assert_eq!(
        g.dispatch(&catalogue.key).await.unwrap().state,
        DeliveryState::Rejected
    );
    assert_eq!(host.reads.load(Ordering::SeqCst), 0);
    g.close().await.unwrap();
}

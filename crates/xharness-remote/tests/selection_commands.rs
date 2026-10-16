//! Durable authority transitions: SQLite effects, no Agent or global RPC.
mod support;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    future::Future,
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
    Empty,
    Forged,
    Slow,
    Error,
}
struct Host {
    mode: Mode,
    reads: AtomicUsize,
    wait: AtomicBool,
    entered: Notify,
    release: Notify,
    cancel_wait: AtomicBool,
    cancel_entered: Notify,
}
impl Host {
    fn new(mode: Mode) -> Arc<Self> {
        Arc::new(Self {
            mode,
            reads: AtomicUsize::new(0),
            wait: AtomicBool::new(false),
            entered: Notify::new(),
            release: Notify::new(),
            cancel_wait: AtomicBool::new(false),
            cancel_entered: Notify::new(),
        })
    }
}
#[async_trait]
impl ApiBackend for Host {
    async fn call(&self, _: RpcId, m: RpcMethod, _: Value, _: CancellationToken) -> RpcResult {
        assert_eq!(m, RpcMethod::SessionCancel);
        self.cancel_entered.notify_one();
        if self.cancel_wait.load(Ordering::SeqCst) {
            std::future::pending::<()>().await;
        }
        RpcResult::success(json!({"accepted":true}))
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("no response");
    }
    fn host_events(&self) -> EventStream {
        panic!("no global events");
    }
    fn mux_events(&self) -> EventStream {
        panic!("no global mux");
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
        Ok(matches!((w, s), ("w", "s") | ("w2", "t")))
    }
    async fn session_event_page(
        &self,
        _: &str,
        _: &str,
        after: Option<u64>,
    ) -> Result<ScopedEventPage, RpcError> {
        let n = after.unwrap_or(9);
        Ok(ScopedEventPage {
            start_seq: n,
            next_seq: n,
            head_seq: n,
            events: vec![],
        })
    }
    async fn scoped_catalogue(
        &self,
        q: ScopedCatalogueQuery,
    ) -> Result<ScopedCataloguePage, RpcError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        if self.wait.load(Ordering::SeqCst) {
            self.release.notified().await;
        }
        match self.mode {
            Mode::Slow => tokio::time::sleep(Duration::from_secs(60)).await,
            Mode::Error => return Err(RpcError::internal("PRIVATE_NATIVE_ERROR")),
            _ => {}
        }
        Ok(ScopedCataloguePage {
            workspaces: q
                .workspaces
                .iter()
                .map(|w| CatalogueWorkspace {
                    id: w.clone(),
                    title: "Native".into(),
                })
                .collect(),
            sessions: if matches!(self.mode, Mode::Empty) {
                vec![]
            } else if matches!(self.mode, Mode::Forged) {
                vec![CatalogueSession {
                    workspace: "w".into(),
                    id: "PRIVATE_FOREIGN".into(),
                    title: None,
                    running: false,
                    restoring: false,
                }]
            } else {
                [("w", "s"), ("w2", "t")]
                    .into_iter()
                    .filter(|(w, s)| q.workspaces.contains(*w) && q.sessions.contains(*s))
                    .map(|(w, s)| CatalogueSession {
                        workspace: w.into(),
                        id: s.into(),
                        title: None,
                        running: false,
                        restoring: false,
                    })
                    .collect()
            },
            next: None,
        })
    }
}
fn sender() -> Sender {
    Sender {
        channel: Channel::Telegram,
        account: "123".into(),
        user: "42".into(),
    }
}
fn scope(n: u64) -> Subscription {
    Subscription {
        principal: "p".into(),
        sender: sender(),
        conversation: "42".into(),
        binding: "b".into(),
        generation: n,
    }
}
fn principal(revision: u64) -> Principal {
    Principal {
        id: "p".into(),
        host: "h".into(),
        sender: sender(),
        workspaces: ["w".into(), "w2".into()].into(),
        sessions: ["s".into(), "t".into()].into(),
        revision,
        revoked: false,
    }
}
async fn setup(g: &Gateway) {
    support::install_scope(g, sender(), &["w", "w2"], &["s", "t"], ("w", "s")).await;
}
async fn admit(g: &Gateway, n: u64, id: &str, w: &str, s: &str) -> Delivery {
    g.accept(
        "p",
        sender(),
        "42".into(),
        Inbound {
            request_id: id.into(),
            binding: "b".into(),
            generation: n,
            command: Command::Select {
                target: SessionSelection {
                    workspace: w.into(),
                    session: s.into(),
                },
            },
        },
    )
    .await
    .unwrap()
}
async fn lease(g: &Gateway) -> AccountLease {
    g.acquire_account(Account {
        channel: Channel::Telegram,
        id: "123".into(),
    })
    .await
    .unwrap()
}
fn plan(d: &Delivery) -> Vec<ReplyPlan> {
    vec![ReplyPlan {
        id: format!("selection:{}", d.key),
        body: ReplyBody {
            text: "Selected".into(),
            buttons: vec![],
            attachment: None,
        },
        replace_of: None,
    }]
}
fn selection(d: &Delivery) -> ControllerSelection {
    let Some(NativeCommandResult::Success { value: Some(v) }) = &d.result else {
        panic!("selection receipt");
    };
    serde_json::from_value(v.clone()).unwrap()
}
#[tokio::test]
async fn atomic_selection_keeps_original_delivery_and_replies_only_under_committed_target_after_reopen(
) {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new(Mode::Normal);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    setup(&g).await;
    let l = lease(&g).await;
    let d = admit(&g, 1, "select", "w2", "t").await;
    let done = g.dispatch(&d.key).await.unwrap();
    let receipt = selection(&done);
    assert!(receipt.is_for_delivery(&done));
    assert_eq!(done.binding, d.binding);
    assert_eq!(done.inbound, d.inbound);
    assert_eq!(done.principal_revision, 1);
    assert_eq!(receipt.binding.generation, 2);
    assert_eq!(receipt.binding.session, "t");
    assert_eq!(g.dispatch(&d.key).await.unwrap(), done);
    assert_eq!(h.reads.load(Ordering::SeqCst), 1);
    assert!(matches!(
        g.command_reply_candidate(&l, scope(1)).await,
        Err(Error::Unauthorized)
    ));
    assert_eq!(
        g.command_reply_candidate(&l, scope(2)).await.unwrap(),
        Some(done.clone())
    );
    let mut forged = done.clone();
    forged.binding.session = "t".into();
    assert!(g
        .enqueue_command_replies(&l, scope(2), forged, plan(&done))
        .await
        .is_err());
    let replies = g
        .enqueue_command_replies(&l, scope(2), done.clone(), plan(&done))
        .await
        .unwrap();
    assert_eq!(replies[0].binding, receipt.binding);
    assert_eq!(replies[0].principal_revision, 1);
    assert_eq!(
        g.enqueue_command_replies(&l, scope(2), done.clone(), plan(&done))
            .await
            .unwrap(),
        replies
    );
    assert!(g
        .command_reply_candidate(&l, scope(2))
        .await
        .unwrap()
        .is_none());
    g.close().await.unwrap();
    drop(g);
    let fresh = Host::new(Mode::Normal);
    let g = Gateway::open(root.path(), "h".into(), fresh.clone()).unwrap();
    let l2 = lease(&g).await;
    assert_eq!(g.dispatch(&d.key).await.unwrap(), done);
    assert_eq!(fresh.reads.load(Ordering::SeqCst), 0);
    assert_eq!(
        g.enqueue_command_replies(&l2, scope(2), done.clone(), plan(&done))
            .await
            .unwrap(),
        replies
    );
    assert!(matches!(
        g.enqueue_command_replies(&l, scope(2), done.clone(), plan(&done))
            .await,
        Err(Error::StaleLease)
    ));
    assert!(matches!(
        g.accept("p", sender(), "42".into(), d.inbound).await,
        Err(Error::Unauthorized)
    ));
    // A newer selection must not carry the earlier selection's reply authority.
    let back = admit(&g, 2, "back", "w", "s").await;
    g.dispatch(&back.key).await.unwrap();
    assert!(g
        .enqueue_command_replies(&l2, scope(3), done.clone(), plan(&done))
        .await
        .is_err());
    assert_eq!(g.inspect(&done.key).await.unwrap(), Some(done));
}
#[tokio::test]
async fn same_target_is_a_durable_noop_without_generation_or_grant_expansion() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new(Mode::Normal);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    setup(&g).await;
    let l = lease(&g).await;
    for id in ["same", "again"] {
        let d = admit(&g, 1, id, "w", "s").await;
        let done = g.dispatch(&d.key).await.unwrap();
        let r = selection(&done);
        assert_eq!(r.binding, d.binding);
        g.enqueue_command_replies(&l, scope(1), done.clone(), plan(&done))
            .await
            .unwrap();
    }
    let p = g.controller_catalogue(scope(1), None).await.unwrap();
    assert_eq!(p.principal_revision, 1);
    assert_eq!(p.catalogue.sessions.len(), 2);
    assert_eq!(p.binding_generation, 1);
}
#[tokio::test]
async fn unauthorized_absent_forged_and_unavailable_targets_never_change_route() {
    for mode in [
        Mode::Normal,
        Mode::Empty,
        Mode::Forged,
        Mode::Slow,
        Mode::Error,
    ] {
        let root = tempfile::tempdir().unwrap();
        let h = Host::new(mode);
        let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
        setup(&g).await;
        let foreign = admit(&g, 1, "foreign", "w2", "foreign").await;
        assert_eq!(
            g.dispatch(&foreign.key).await.unwrap().state,
            DeliveryState::Rejected
        );
        assert_eq!(h.reads.load(Ordering::SeqCst), 0);
        let d = admit(&g, 1, "target", "w2", "t").await;
        match mode {
            Mode::Normal => assert_eq!(
                g.dispatch(&d.key).await.unwrap().state,
                DeliveryState::Completed
            ),
            Mode::Empty => assert_eq!(
                g.dispatch(&d.key).await.unwrap().state,
                DeliveryState::Rejected
            ),
            _ => {
                let failed = g.dispatch(&d.key).await.unwrap();
                assert_eq!(failed.state, DeliveryState::Completed);
                assert!(matches!(
                    failed.result,
                    Some(NativeCommandResult::Failure { .. })
                ));
                assert!(!format!("{failed:?}").contains("PRIVATE_"));
                assert_eq!(g.dispatch(&d.key).await.unwrap(), failed);
                let l = lease(&g).await;
                g.enqueue_command_replies(&l, scope(1), failed.clone(), plan(&failed))
                    .await
                    .unwrap();
            }
        }
        if !matches!(mode, Mode::Normal) {
            let b = g
                .resolve_sender(sender(), "42".into())
                .await
                .unwrap()
                .unwrap()
                .binding;
            assert_eq!(b.generation, 1);
            assert_eq!(b.session, "s");
            g.revoke("p").await.unwrap();
            let after = g.dispatch(&d.key).await.unwrap();
            assert!(matches!(
                after.state,
                DeliveryState::Rejected | DeliveryState::Completed
            ));
            assert!(!format!("{after:?}").contains("PRIVATE_"));
        }
    }
    let root = tempfile::tempdir().unwrap();
    let g = Gateway::open(root.path(), "h".into(), Host::new(Mode::Normal)).unwrap();
    setup(&g).await;
    for (w, s) in [("", "t"), ("w2", "\0"), ("w2", &"s".repeat(513))] {
        assert!(matches!(
            g.accept(
                "p",
                sender(),
                "42".into(),
                Inbound {
                    request_id: "invalid".into(),
                    binding: "b".into(),
                    generation: 1,
                    command: Command::Select {
                        target: SessionSelection {
                            workspace: w.into(),
                            session: s.into()
                        }
                    }
                }
            )
            .await,
            Err(Error::Invalid(_))
        ));
    }
    let crossed = admit(&g, 1, "crossed", "w", "t").await;
    assert_eq!(
        g.dispatch(&crossed.key).await.unwrap().state,
        DeliveryState::Rejected
    );
}
#[tokio::test]
async fn selection_cannot_escape_an_uncertain_original_session_fifo() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new(Mode::Normal);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    setup(&g).await;
    let earlier = g
        .accept(
            "p",
            sender(),
            "42".into(),
            Inbound {
                request_id: "cancel".into(),
                binding: "b".into(),
                generation: 1,
                command: Command::Cancel,
            },
        )
        .await
        .unwrap();
    let d = admit(&g, 1, "select", "w2", "t").await;
    assert!(matches!(
        g.dispatch(&d.key).await,
        Err(Error::SessionBlocked)
    ));
    h.cancel_wait.store(true, Ordering::SeqCst);
    let run = {
        let g = g.clone();
        let k = earlier.key.clone();
        tokio::spawn(async move { g.dispatch(&k).await })
    };
    h.cancel_entered.notified().await;
    run.abort();
    assert!(run.await.unwrap_err().is_cancelled());
    assert_eq!(
        g.dispatch(&earlier.key).await.unwrap().state,
        DeliveryState::Uncertain
    );
    assert!(matches!(
        g.dispatch(&d.key).await,
        Err(Error::SessionBlocked)
    ));
    assert!(g.pending().await.unwrap().is_empty());
    assert_eq!(h.reads.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn cancelled_metadata_preflight_is_still_queued_and_reopen_can_select_once() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new(Mode::Normal);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    setup(&g).await;
    h.wait.store(true, Ordering::SeqCst);
    let d = admit(&g, 1, "select", "w2", "t").await;
    let run = {
        let g = g.clone();
        let k = d.key.clone();
        tokio::spawn(async move { g.dispatch(&k).await })
    };
    h.entered.notified().await;
    run.abort();
    assert!(run.await.unwrap_err().is_cancelled());
    assert_eq!(g.inspect(&d.key).await.unwrap(), Some(d.clone()));
    g.close().await.unwrap();
    drop(g);
    let fresh = Host::new(Mode::Normal);
    let g = Gateway::open(root.path(), "h".into(), fresh.clone()).unwrap();
    let done = g.dispatch(&d.key).await.unwrap();
    assert_eq!(selection(&done).binding.generation, 2);
    assert_eq!(g.dispatch(&d.key).await.unwrap(), done);
    assert_eq!(fresh.reads.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn queued_revoke_waits_for_atomic_selection_then_prevents_transition_reply() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new(Mode::Normal);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    setup(&g).await;
    let l = lease(&g).await;
    h.wait.store(true, Ordering::SeqCst);
    let d = admit(&g, 1, "select", "w2", "t").await;
    let run = {
        let g = g.clone();
        let k = d.key.clone();
        tokio::spawn(async move { g.dispatch(&k).await })
    };
    h.entered.notified().await;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let revoke = {
        let g = g.clone();
        tokio::spawn(async move {
            let mut future = Box::pin(g.revoke("p"));
            std::future::poll_fn(|cx| {
                assert!(future.as_mut().poll(cx).is_pending());
                std::task::Poll::Ready(())
            })
            .await;
            tx.send(()).unwrap();
            future.await
        })
    };
    rx.await.unwrap();
    h.release.notify_one();
    let done = tokio::time::timeout(Duration::from_secs(3), run)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(selection(&done).binding.generation, 2);
    revoke.await.unwrap().unwrap();
    assert!(matches!(
        g.command_reply_candidate(&l, scope(2)).await,
        Err(Error::Unauthorized)
    ));
    assert!(g
        .enqueue_command_replies(&l, scope(2), done.clone(), plan(&done))
        .await
        .is_err());
}
struct Unknown(Account);
#[async_trait]
impl ReplyTransport for Unknown {
    fn account(&self) -> &Account {
        &self.0
    }
    async fn send(&self, _: SendRequest) -> SendOutcome {
        SendOutcome::Uncertain
    }
}
#[tokio::test]
async fn revisiting_restores_only_proven_cursor_state_not_edit_targets_or_ambiguous_sends() {
    let root = tempfile::tempdir().unwrap();
    let g = Gateway::open(root.path(), "h".into(), Host::new(Mode::Normal)).unwrap();
    setup(&g).await;
    let l = lease(&g).await;
    let cp = g.projection_checkpoint(&l, scope(1)).await.unwrap();
    assert_eq!(cp.next_seq, 0);
    g.advance_projection(
        &l,
        scope(1),
        cp,
        ProjectionUpdate {
            next_seq: 7,
            state: json!({"fixture":"original-state"}),
            retain: ["slot".into()].into(),
            replies: vec![ProjectedReply {
                slot: Some("slot".into()),
                plan: ReplyPlan {
                    id: "streamed".into(),
                    body: ReplyBody {
                        text: "original text".into(),
                        buttons: vec![],
                        attachment: None,
                    },
                    replace_of: None,
                },
            }],
        },
    )
    .await
    .unwrap();
    let old = g.projection_checkpoint(&l, scope(1)).await.unwrap();
    assert_eq!(old.links.len(), 1);
    let old_reply = old.pending[0].clone();
    let transport = Arc::new(Unknown(l.account.clone()));
    assert_eq!(
        g.deliver_reply(l.clone(), &old_reply, transport, CancellationToken::new())
            .await
            .unwrap()
            .state,
        ReplyState::Uncertain
    );
    let d = admit(&g, 1, "away", "w2", "t").await;
    g.dispatch(&d.key).await.unwrap();
    let target = g.projection_checkpoint(&l, scope(2)).await.unwrap();
    assert_eq!(target.next_seq, 0);
    g.advance_projection(
        &l,
        scope(2),
        target,
        ProjectionUpdate {
            next_seq: 4,
            state: json!({"fixture":"second-state"}),
            retain: Default::default(),
            replies: vec![],
        },
    )
    .await
    .unwrap();
    let back = admit(&g, 2, "back", "w", "s").await;
    g.dispatch(&back.key).await.unwrap();
    let resumed = g.projection_checkpoint(&l, scope(3)).await.unwrap();
    assert_eq!(resumed.next_seq, 7);
    assert_eq!(resumed.state, old.state);
    assert!(resumed.links.is_empty() && resumed.pending.is_empty());
    assert_ne!(resumed.key, old.key);
    assert_eq!(
        g.inspect_reply(&old_reply).await.unwrap().unwrap().state,
        ReplyState::Uncertain
    );
    g.close().await.unwrap();
    drop(g);
    let g = Gateway::open(root.path(), "h".into(), Host::new(Mode::Normal)).unwrap();
    let l = lease(&g).await;
    assert_eq!(
        g.projection_checkpoint(&l, scope(3)).await.unwrap(),
        resumed
    );
    let again = admit(&g, 3, "again", "w2", "t").await;
    g.dispatch(&again.key).await.unwrap();
    assert_eq!(
        g.projection_checkpoint(&l, scope(4))
            .await
            .unwrap()
            .next_seq,
        4
    );
    // An independently revised grant does not certify old projection continuity.
    g.set_principal(principal(2)).await.unwrap();
    let after = admit(&g, 4, "revision", "w", "s").await;
    g.dispatch(&after.key).await.unwrap();
    assert_eq!(
        g.projection_checkpoint(&l, scope(5))
            .await
            .unwrap()
            .next_seq,
        0
    );
}

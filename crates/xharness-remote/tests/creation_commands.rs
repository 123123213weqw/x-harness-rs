//! Inbox/native proof/revision/output integration, not real-platform acceptance.
mod support;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
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
    Absent,
    Forged,
    ForeignOwned,
    Wait,
}
struct Host {
    mode: Mode,
    calls: AtomicUsize,
    reads: AtomicUsize,
    receipts: Mutex<BTreeMap<String, ScopedSessionCreated>>,
    visible: AtomicBool,
    entered: Notify,
    release: Notify,
}
impl Host {
    fn new(mode: Mode) -> Arc<Self> {
        Arc::new(Self {
            mode,
            calls: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            receipts: Mutex::new(BTreeMap::new()),
            visible: AtomicBool::new(true),
            entered: Notify::new(),
            release: Notify::new(),
        })
    }
}
#[async_trait]
impl ApiBackend for Host {
    async fn call(&self, _: RpcId, m: RpcMethod, _: Value, _: CancellationToken) -> RpcResult {
        assert_eq!(m, RpcMethod::SessionCancel);
        RpcResult::success(json!({"accepted":true}))
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("no interaction");
    }
    fn host_events(&self) -> EventStream {
        panic!("no global events");
    }
    fn mux_events(&self) -> EventStream {
        panic!("no global mux");
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
        Ok(w == "w"
            && ((matches!(s, "s" | "t") || s.starts_with("lane-"))
                || (!matches!(self.mode, Mode::ForeignOwned)
                    && self
                        .receipts
                        .lock()
                        .unwrap()
                        .values()
                        .any(|r| r.session == s))))
    }
    async fn session_event_page(
        &self,
        _: &str,
        _: &str,
        after: Option<u64>,
    ) -> Result<ScopedEventPage, RpcError> {
        let n = after.unwrap_or(8);
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
        Ok(ScopedCataloguePage {
            workspaces: q
                .workspaces
                .iter()
                .map(|w| CatalogueWorkspace {
                    id: w.clone(),
                    title: "Native".into(),
                })
                .collect(),
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
                .filter(|s| q.after.as_ref().is_none_or(|after| s.cursor() > *after))
                .collect(),
            next: None,
        })
    }
    async fn create_scoped_session(
        &self,
        r: ScopedSessionCreate,
    ) -> Result<ScopedSessionCreated, RpcError> {
        assert!(r.is_bounded());
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        if matches!(self.mode, Mode::Wait) {
            self.release.notified().await;
        }
        if !matches!(self.mode, Mode::Absent) {
            self.receipts
                .lock()
                .unwrap()
                .insert(r.request_key.clone(), r.receipt());
        }
        if matches!(self.mode, Mode::LostAck | Mode::Absent) {
            return Err(RpcError::internal("PRIVATE_NATIVE_ERROR"));
        }
        Ok(r.receipt())
    }
    async fn scoped_session_creation_receipt(
        &self,
        r: ScopedSessionCreate,
    ) -> Result<Option<ScopedSessionCreated>, RpcError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if matches!(self.mode, Mode::Forged) {
            let mut proof = r.receipt();
            proof.session = "PRIVATE_FOREIGN".into();
            return Ok(Some(proof));
        }
        if !self.visible.load(Ordering::SeqCst) {
            return Ok(None);
        }
        Ok(self.receipts.lock().unwrap().get(&r.request_key).cloned())
    }
}
fn sender() -> Sender {
    Sender {
        channel: Channel::Telegram,
        account: "123".into(),
        user: "42".into(),
    }
}
fn scope(gen: u64) -> Subscription {
    Subscription {
        principal: "p".into(),
        sender: sender(),
        conversation: "42".into(),
        binding: "b".into(),
        generation: gen,
    }
}
fn principal(rev: u64) -> Principal {
    Principal {
        id: "p".into(),
        host: "h".into(),
        sender: sender(),
        workspaces: ["w".into()].into(),
        sessions: ["s".into(), "t".into()].into(),
        revision: rev,
        revoked: false,
    }
}
async fn setup(g: &Gateway, allow: bool) {
    support::install_scope(g, sender(), &["w"], &["s", "t"], ("w", "s")).await;
    if allow {
        g.set_creation_policy(CreationPolicy {
            principal: "p".into(),
            principal_revision: 1,
            generation: 1,
            workspaces: ["w".into()].into(),
        })
        .await
        .unwrap();
    }
}
async fn admit(g: &Gateway, id: &str, workspace: &str) -> Delivery {
    g.accept(
        "p",
        sender(),
        "42".into(),
        Inbound {
            request_id: id.into(),
            binding: "b".into(),
            generation: 1,
            command: Command::CreateSession {
                workspace: workspace.into(),
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
        id: format!("create-result:{}:{:?}", d.key, d.state),
        body: ReplyBody {
            text: "Created or unknown".into(),
            buttons: vec![],
            attachment: None,
        },
        replace_of: None,
    }]
}
fn receipt(d: &Delivery) -> ControllerCreated {
    let Some(NativeCommandResult::Success { value: Some(v) }) = &d.result else {
        panic!("creation result");
    };
    serde_json::from_value(v.clone()).unwrap()
}
#[tokio::test]
async fn default_off_and_foreign_workspace_are_rejected_before_native_lookup() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new(Mode::Normal);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    setup(&g, false).await;
    let d = admit(&g, "denied", "w").await;
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Rejected
    );
    let foreign = admit(&g, "foreign", "PRIVATE_PATH").await;
    assert_eq!(
        g.dispatch(&foreign.key).await.unwrap().state,
        DeliveryState::Rejected
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    assert_eq!(h.reads.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn creation_grant_result_and_reply_proof_survive_reopen_without_native_reread() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new(Mode::Normal);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    setup(&g, true).await;
    let l = lease(&g).await;
    let d = admit(&g, "new", "w").await;
    let done = g.dispatch(&d.key).await.unwrap();
    let r = receipt(&done);
    assert!(r.is_for_delivery(&done));
    assert_eq!(r.principal_revision, 2);
    assert_eq!(done.principal_revision, 1);
    assert_eq!(done.binding, d.binding);
    assert_eq!(done.inbound, d.inbound);
    assert_eq!(r.binding, d.binding);
    assert_eq!(
        g.controller_catalogue(scope(1), None)
            .await
            .unwrap()
            .catalogue
            .sessions
            .len(),
        3
    );
    assert_eq!(
        g.command_reply_candidate(&l, scope(1)).await.unwrap(),
        Some(done.clone())
    );
    let reads = h.reads.load(Ordering::SeqCst);
    assert_eq!(g.dispatch(&d.key).await.unwrap(), done);
    assert_eq!(h.reads.load(Ordering::SeqCst), reads);
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    let out = g
        .enqueue_command_replies(&l, scope(1), done.clone(), plan(&done))
        .await
        .unwrap();
    assert_eq!(out[0].principal_revision, 2);
    assert_eq!(out[0].binding, d.binding);
    assert_eq!(
        g.enqueue_command_replies(&l, scope(1), done.clone(), plan(&done))
            .await
            .unwrap(),
        out
    );
    g.close().await.unwrap();
    drop(g);
    let fresh = Host::new(Mode::Normal);
    let g = Gateway::open(root.path(), "h".into(), fresh.clone()).unwrap();
    let l = lease(&g).await;
    assert_eq!(g.dispatch(&d.key).await.unwrap(), done);
    assert_eq!(fresh.reads.load(Ordering::SeqCst), 0);
    assert_eq!(fresh.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        g.enqueue_command_replies(&l, scope(1), done.clone(), plan(&done))
            .await
            .unwrap(),
        out
    );
    let mut p = principal(3);
    p.sessions.insert(r.created.session);
    g.set_principal(p).await.unwrap();
    assert!(g
        .enqueue_command_replies(&l, scope(1), done.clone(), plan(&done))
        .await
        .is_err());
    assert_eq!(g.inspect(&d.key).await.unwrap(), Some(done));
}
#[tokio::test]
async fn lost_ack_is_receipt_only_recovery_not_second_native_creation() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new(Mode::LostAck);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    setup(&g, true).await;
    let d = admit(&g, "lost", "w").await;
    let u = g.dispatch(&d.key).await.unwrap();
    assert_eq!(u.state, DeliveryState::Uncertain);
    assert!(!format!("{u:?}").contains("PRIVATE_"));
    assert_eq!(
        g.creation_recovery_candidates(None).await.unwrap(),
        vec![u.clone()]
    );
    assert!(g.pending().await.unwrap().is_empty());
    g.close().await.unwrap();
    drop(g);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let done = g.dispatch(&d.key).await.unwrap();
    assert_eq!(receipt(&done).principal_revision, 2);
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    assert!(g
        .creation_recovery_candidates(None)
        .await
        .unwrap()
        .is_empty());
}
#[tokio::test]
async fn absent_forged_or_foreign_proof_stays_uncertain_without_replay_or_grant() {
    for mode in [Mode::Absent, Mode::Forged, Mode::ForeignOwned] {
        let root = tempfile::tempdir().unwrap();
        let h = Host::new(mode);
        let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
        setup(&g, true).await;
        let d = admit(&g, "unknown", "w").await;
        for _ in 0..3 {
            let u = g.dispatch(&d.key).await.unwrap();
            assert_eq!(u.state, DeliveryState::Uncertain);
            assert!(u.result.is_none());
            assert_eq!(
                g.controller_catalogue(scope(1), None)
                    .await
                    .unwrap()
                    .principal_revision,
                1
            );
        }
        assert_eq!(
            h.calls.load(Ordering::SeqCst),
            if matches!(mode, Mode::Forged) { 0 } else { 1 }
        );
    }
}
#[tokio::test]
async fn cancelled_waiter_does_not_cancel_owned_creation_or_grant_commit() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new(Mode::Wait);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    setup(&g, true).await;
    let d = admit(&g, "owned", "w").await;
    let run = {
        let g = g.clone();
        let key = d.key.clone();
        tokio::spawn(async move { g.dispatch(&key).await })
    };
    h.entered.notified().await;
    run.abort();
    assert!(run.await.unwrap_err().is_cancelled());
    assert_eq!(
        g.inspect(&d.key).await.unwrap().unwrap().state,
        DeliveryState::Dispatching
    );
    h.release.notify_one();
    let done = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let d = g.inspect(&d.key).await.unwrap().unwrap();
            if d.state == DeliveryState::Completed {
                break d;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(receipt(&done).principal_revision, 2);
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    g.close().await.unwrap();
}
#[tokio::test]
async fn actual_deadline_keeps_native_writer_drained_and_reopens_to_original_receipt() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new(Mode::Wait);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    setup(&g, true).await;
    let d = admit(&g, "deadline", "w").await;
    let u = g.dispatch(&d.key).await.unwrap();
    assert_eq!(u.state, DeliveryState::Uncertain);
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Uncertain
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    let close = {
        let g = g.clone();
        tokio::spawn(async move { g.close().await })
    };
    assert!(tokio::time::timeout(Duration::from_millis(50), async {
        while !close.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_err());
    h.release.notify_one();
    close.await.unwrap().unwrap();
    drop(g);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let done = g.dispatch(&d.key).await.unwrap();
    assert_eq!(receipt(&done).principal_revision, 2);
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn supervisor_recovers_only_proof_and_does_not_starve_independent_queued_work() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new(Mode::LostAck);
    h.visible.store(false, Ordering::SeqCst);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    setup(&g, true).await;
    let d = admit(&g, "unknown", "w").await;
    g.dispatch(&d.key).await.unwrap();
    let next = admit(&g, "later", "w").await;
    assert!(matches!(
        g.dispatch(&next.key).await,
        Err(Error::SessionBlocked)
    ));
    let other = Sender {
        user: "99".into(),
        ..sender()
    };
    g.set_principal(Principal {
        id: "other".into(),
        sender: other.clone(),
        ..principal(1)
    })
    .await
    .unwrap();
    g.bind(Binding {
        id: "other-b".into(),
        principal: "other".into(),
        conversation: "99".into(),
        workspace: "w".into(),
        session: "t".into(),
        generation: 1,
    })
    .await
    .unwrap();
    let cancel = g
        .accept(
            "other",
            other,
            "99".into(),
            Inbound {
                request_id: "cancel".into(),
                binding: "other-b".into(),
                generation: 1,
                command: Command::Cancel,
            },
        )
        .await
        .unwrap();
    let stop = CancellationToken::new();
    let run = tokio::spawn(g.clone().run(stop.clone()));
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if g.inspect(&cancel.key).await.unwrap().unwrap().state == DeliveryState::Completed {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        g.inspect(&d.key).await.unwrap().unwrap().state,
        DeliveryState::Uncertain
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    h.visible.store(true, Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            if g.inspect(&d.key).await.unwrap().unwrap().state == DeliveryState::Completed {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    stop.cancel();
    run.await.unwrap().unwrap();
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        g.dispatch(&next.key).await.unwrap().state,
        DeliveryState::Rejected
    );
}
#[tokio::test]
async fn manual_accepted_is_not_creation_proof_and_abandon_does_not_retry() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new(Mode::Absent);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    setup(&g, true).await;
    let d = admit(&g, "abandon", "w").await;
    g.dispatch(&d.key).await.unwrap();
    let review = RecoveryReview {
        delivery_key: d.key.clone(),
        resolution: RecoveryResolution::ObservedAccepted,
        actor: "desktop-owner".into(),
        evidence_sha256: "e".repeat(64),
    };
    assert!(matches!(
        g.resolve_uncertain(review.clone()).await,
        Err(Error::Invalid(_))
    ));
    assert!(g.recovery_audit(&d.key).await.unwrap().is_empty());
    let review = RecoveryReview {
        resolution: RecoveryResolution::AbandonWithoutReplay,
        ..review
    };
    g.resolve_uncertain(review).await.unwrap();
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Abandoned
    );
    assert!(g
        .creation_recovery_candidates(None)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn certified_additive_revision_preserves_current_and_prior_target_output_cursors() {
    let root = tempfile::tempdir().unwrap();
    let g = Gateway::open(root.path(), "h".into(), Host::new(Mode::Normal)).unwrap();
    setup(&g, true).await;
    let l = lease(&g).await;
    let cp = g.projection_checkpoint(&l, scope(1)).await.unwrap();
    g.advance_projection(
        &l,
        scope(1),
        cp,
        ProjectionUpdate {
            next_seq: 7,
            state: json!({"fixture":"first"}),
            retain: Default::default(),
            replies: vec![],
        },
    )
    .await
    .unwrap();
    let b = g
        .controller_select(
            scope(1),
            SessionSelection {
                workspace: "w".into(),
                session: "t".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(b.generation, 2);
    let cp = g.projection_checkpoint(&l, scope(2)).await.unwrap();
    g.advance_projection(
        &l,
        scope(2),
        cp,
        ProjectionUpdate {
            next_seq: 4,
            state: json!({"fixture":"second"}),
            retain: Default::default(),
            replies: vec![],
        },
    )
    .await
    .unwrap();
    let d = g
        .accept(
            "p",
            sender(),
            "42".into(),
            Inbound {
                request_id: "create-on-t".into(),
                binding: "b".into(),
                generation: 2,
                command: Command::CreateSession {
                    workspace: "w".into(),
                },
            },
        )
        .await
        .unwrap();
    let done = g.dispatch(&d.key).await.unwrap();
    assert_eq!(receipt(&done).binding.session, "t");
    let second = g
        .accept(
            "p",
            sender(),
            "42".into(),
            Inbound {
                request_id: "second-create".into(),
                binding: "b".into(),
                generation: 2,
                command: Command::CreateSession {
                    workspace: "w".into(),
                },
            },
        )
        .await
        .unwrap();
    let second = g.dispatch(&second.key).await.unwrap();
    assert_eq!(receipt(&second).principal_revision, 3);
    assert!(g
        .enqueue_command_replies(&l, scope(2), done.clone(), plan(&done))
        .await
        .is_err());
    let current = g.projection_checkpoint(&l, scope(2)).await.unwrap();
    assert_eq!(current.next_seq, 4);
    assert_eq!(current.state, json!({"fixture":"second"}));
    assert!(current.links.is_empty() && current.pending.is_empty());
    let selected = g
        .accept(
            "p",
            sender(),
            "42".into(),
            Inbound {
                request_id: "select-back".into(),
                binding: "b".into(),
                generation: 2,
                command: Command::Select {
                    target: SessionSelection {
                        workspace: "w".into(),
                        session: "s".into(),
                    },
                },
            },
        )
        .await
        .unwrap();
    g.dispatch(&selected.key).await.unwrap();
    let resumed = g.projection_checkpoint(&l, scope(3)).await.unwrap();
    assert_eq!(resumed.next_seq, 7);
    assert_eq!(resumed.state, json!({"fixture":"first"}));
    let new = receipt(&done).created.session;
    let selected = g
        .accept(
            "p",
            sender(),
            "42".into(),
            Inbound {
                request_id: "select-new".into(),
                binding: "b".into(),
                generation: 3,
                command: Command::Select {
                    target: SessionSelection {
                        workspace: "w".into(),
                        session: new.clone(),
                    },
                },
            },
        )
        .await
        .unwrap();
    g.dispatch(&selected.key).await.unwrap();
    assert_eq!(
        g.projection_checkpoint(&l, scope(4))
            .await
            .unwrap()
            .next_seq,
        0
    );
    let cp = g.projection_checkpoint(&l, scope(4)).await.unwrap();
    g.advance_projection(
        &l,
        scope(4),
        cp,
        ProjectionUpdate {
            next_seq: 6,
            state: json!({"fixture":"new"}),
            retain: Default::default(),
            replies: vec![],
        },
    )
    .await
    .unwrap();
    let mut p = principal(4);
    p.sessions.insert(new);
    g.set_principal(p).await.unwrap();
    assert_eq!(
        g.projection_checkpoint(&l, scope(4))
            .await
            .unwrap()
            .next_seq,
        0
    );
}

#[tokio::test]
async fn uncertain_recovery_pages_are_bounded_and_round_robin_cursor_reaches_every_lane() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new(Mode::Absent);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    for n in 0..33 {
        let id = format!("p-{n}");
        let binding = format!("b-{n}");
        let session = format!("lane-{n}");
        let sender = Sender {
            channel: Channel::Telegram,
            account: "123".into(),
            user: (1000 + n).to_string(),
        };
        let conversation = sender.user.clone();
        g.set_principal(Principal {
            id: id.clone(),
            host: "h".into(),
            sender: sender.clone(),
            workspaces: ["w".into()].into(),
            sessions: [session.clone()].into(),
            revision: 1,
            revoked: false,
        })
        .await
        .unwrap();
        g.bind(Binding {
            id: binding.clone(),
            principal: id.clone(),
            conversation: conversation.clone(),
            workspace: "w".into(),
            session,
            generation: 1,
        })
        .await
        .unwrap();
        g.set_creation_policy(CreationPolicy {
            principal: id.clone(),
            principal_revision: 1,
            generation: 1,
            workspaces: ["w".into()].into(),
        })
        .await
        .unwrap();
        let d = g
            .accept(
                &id,
                sender,
                conversation,
                Inbound {
                    request_id: "new".into(),
                    binding,
                    generation: 1,
                    command: Command::CreateSession {
                        workspace: "w".into(),
                    },
                },
            )
            .await
            .unwrap();
        assert_eq!(
            g.dispatch(&d.key).await.unwrap().state,
            DeliveryState::Uncertain
        );
    }
    let first = g.creation_recovery_candidates(None).await.unwrap();
    assert_eq!(first.len(), 32);
    let second = g
        .creation_recovery_candidates(Some(first.last().unwrap().sequence))
        .await
        .unwrap();
    assert_eq!(second.len(), 1);
    assert!(g
        .creation_recovery_candidates(Some(second[0].sequence))
        .await
        .unwrap()
        .is_empty());
    assert!(g.pending().await.unwrap().is_empty());
    assert_eq!(h.calls.load(Ordering::SeqCst), 33);
}

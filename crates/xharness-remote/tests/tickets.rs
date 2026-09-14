//! Scoped ticket/journal fixtures, NOT real platform/model acceptance.
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tokio_util::sync::CancellationToken;
use xharness_api::*;
use xharness_remote::*;
struct Host {
    pending: Mutex<Option<ScopedInteraction>>,
    receipt: Mutex<ScopedInteractionReceipt>,
    calls: AtomicUsize,
    crash: Option<std::path::PathBuf>,
    entered: tokio::sync::Semaphore,
    blocked: bool,
    unknown: bool,
}
impl Host {
    fn new() -> Self {
        Self {
            pending: Mutex::new(Some(snapshot())),
            receipt: Mutex::new(ScopedInteractionReceipt::Accepted),
            calls: AtomicUsize::new(0),
            crash: None,
            entered: tokio::sync::Semaphore::new(0),
            blocked: false,
            unknown: false,
        }
    }
}
#[async_trait]
impl ApiBackend for Host {
    async fn call(&self, _: RpcId, _: RpcMethod, _: Value, _: CancellationToken) -> RpcResult {
        panic!("no generic interaction RPC");
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
        Ok(w == "w" && (s == "s" || s == "s2"))
    }
    async fn session_interaction(
        &self,
        _: &str,
        _: &str,
        _: &RpcId,
    ) -> Result<Option<ScopedInteraction>, RpcError> {
        Ok(self.pending.lock().unwrap().clone())
    }
    async fn answer_session_interaction(
        &self,
        _: &str,
        _: &str,
        expected: ScopedInteraction,
        _: ScopedInteractionAnswer,
    ) -> Result<ScopedInteractionReceipt, RpcError> {
        assert_eq!(self.pending.lock().unwrap().as_ref(), Some(&expected));
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(path) = &self.crash {
            let file = std::fs::File::create(path).unwrap();
            use std::io::Write;
            (&file).write_all(b"applied").unwrap();
            file.sync_all().unwrap();
            std::process::exit(79);
        }
        self.entered.add_permits(1);
        if self.blocked {
            std::future::pending::<()>().await;
        }
        if self.unknown {
            return Err(RpcError::internal("PRIVATE_RESPONSE_ERROR"));
        }
        Ok(*self.receipt.lock().unwrap())
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("no raw /api/respond");
    }
    fn mux_events(&self) -> EventStream {
        panic!("no global mux");
    }
    fn host_events(&self) -> EventStream {
        panic!("no global Host stream");
    }
}
fn snapshot() -> ScopedInteraction {
    ScopedInteraction {
        nonce: "native-pending-instance".into(),
        frame: ServerRequest::new(
            RpcId::new("approval"),
            "approval/requested",
            json!({"type":"approval/requested","sessionId":"s","approvalId":"appr","toolName":"fixture","callId":"call","reviewing":false}),
        ),
    }
}
fn scope() -> Subscription {
    Subscription {
        principal: "p".into(),
        sender: Sender {
            channel: Channel::Telegram,
            account: "bot".into(),
            user: "42".into(),
        },
        conversation: "42".into(),
        binding: "b".into(),
        generation: 1,
    }
}
fn principal() -> Principal {
    Principal {
        id: "p".into(),
        host: "h".into(),
        sender: scope().sender,
        workspaces: BTreeSet::from(["w".into()]),
        sessions: BTreeSet::from(["s".into(), "s2".into()]),
        revision: 1,
        revoked: false,
    }
}
fn binding() -> Binding {
    Binding {
        id: "b".into(),
        principal: "p".into(),
        conversation: "42".into(),
        workspace: "w".into(),
        session: "s".into(),
        generation: 1,
    }
}
async fn setup(host: Arc<Host>) -> (tempfile::TempDir, Arc<Gateway>) {
    let dir = tempfile::tempdir().unwrap();
    let g = Gateway::open(dir.path(), "h".into(), host).unwrap();
    g.set_principal(principal()).await.unwrap();
    g.bind(binding()).await.unwrap();
    (dir, g)
}
async fn mint(g: &Gateway, ttl: u16) -> InteractionTicket {
    g.mint_interaction_ticket(scope(), RpcId::new("approval"), ttl)
        .await
        .unwrap()
}
async fn accept(g: &Gateway, id: &str, ticket: TicketToken) -> Delivery {
    g.accept(
        "p",
        scope().sender,
        "42".into(),
        Inbound {
            request_id: id.into(),
            binding: "b".into(),
            generation: 1,
            command: Command::AnswerInteraction {
                ticket,
                answer: ScopedInteractionAnswer::Approval { allowed: true },
            },
        },
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn once_only_owner_survives_restart_and_duplicate_click_cannot_change_operation() {
    let h = Arc::new(Host::new());
    let (dir, g) = setup(h.clone()).await;
    let ticket = mint(&g, 60).await;
    assert_eq!(mint(&g, 60).await.token, ticket.token);
    assert!(!format!("{ticket:?}").contains(ticket.token.as_str()));
    let d = accept(&g, "click", ticket.token.clone()).await;
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Completed
    );
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Completed
    );
    let other = accept(&g, "click-2", ticket.token.clone()).await;
    assert_eq!(
        g.dispatch(&other.key).await.unwrap().state,
        DeliveryState::Rejected
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    assert!(g
        .mint_interaction_ticket(scope(), RpcId::new("approval"), 60)
        .await
        .is_err());
    g.close().await.unwrap();
    drop(g);
    let g = Gateway::open(dir.path(), "h".into(), h.clone()).unwrap();
    let duplicate = accept(&g, "click", ticket.token).await;
    assert_eq!(duplicate.key, d.key);
    assert_eq!(
        g.dispatch(&duplicate.key).await.unwrap().state,
        DeliveryState::Completed
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn scope_revision_binding_and_expiry_fence_old_handles_before_native_response() {
    let h = Arc::new(Host::new());
    let (_dir, g) = setup(h.clone()).await;
    let old = mint(&g, 60).await;
    let mut p = principal();
    p.revision = 2;
    g.set_principal(p).await.unwrap();
    let d = accept(&g, "old-revision", old.token).await;
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Rejected
    );
    let current = mint(&g, 60).await;
    let mut b = binding();
    b.generation = 2;
    b.session = "s2".into();
    g.bind(b.clone()).await.unwrap();
    let d = g
        .accept(
            "p",
            scope().sender,
            "42".into(),
            Inbound {
                request_id: "rebound".into(),
                binding: "b".into(),
                generation: 2,
                command: Command::AnswerInteraction {
                    ticket: current.token,
                    answer: ScopedInteractionAnswer::Approval { allowed: true },
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Rejected
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    let (_dir, g) = setup(h.clone()).await;
    let expired = mint(&g, 1).await;
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    let d = accept(&g, "expired", expired.token.clone()).await;
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Rejected
    );
    assert_ne!(mint(&g, 60).await.token, expired.token);
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    g.revoke("p").await.unwrap();
    assert!(g
        .mint_interaction_ticket(scope(), RpcId::new("approval"), 60)
        .await
        .is_err());
}
#[tokio::test]
async fn native_pending_nonce_and_frame_must_match_even_when_rpc_strings_are_reused() {
    let h = Arc::new(Host::new());
    let (_dir, g) = setup(h.clone()).await;
    let old = mint(&g, 60).await;
    h.pending.lock().unwrap().as_mut().unwrap().nonce = "next-native-instance".into();
    let d = accept(&g, "old-instance", old.token).await;
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Rejected
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    let fresh = mint(&g, 60).await;
    h.pending.lock().unwrap().as_mut().unwrap().frame.payload["callId"] = json!("other-call");
    let d = accept(&g, "changed-call", fresh.token).await;
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Rejected
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn distinct_authorized_controllers_share_one_native_instance_consumption_fence() {
    let h = Arc::new(Host::new());
    let (_dir, g) = setup(h.clone()).await;
    let first = mint(&g, 60).await;
    let mut p = principal();
    p.id = "p2".into();
    p.sender.user = "43".into();
    g.set_principal(p.clone()).await.unwrap();
    let mut b = binding();
    b.id = "b2".into();
    b.principal = "p2".into();
    b.conversation = "43".into();
    g.bind(b.clone()).await.unwrap();
    let scope2 = Subscription {
        principal: p.id.clone(),
        sender: p.sender.clone(),
        conversation: b.conversation.clone(),
        binding: b.id.clone(),
        generation: 1,
    };
    let second = g
        .mint_interaction_ticket(scope2, RpcId::new("approval"), 60)
        .await
        .unwrap();
    let one = accept(&g, "one", first.token).await;
    let two = g
        .accept(
            "p2",
            p.sender,
            "43".into(),
            Inbound {
                request_id: "two".into(),
                binding: "b2".into(),
                generation: 1,
                command: Command::AnswerInteraction {
                    ticket: second.token,
                    answer: ScopedInteractionAnswer::Approval { allowed: false },
                },
            },
        )
        .await
        .unwrap();
    let (one, two) = tokio::join!(g.dispatch(&one.key), g.dispatch(&two.key));
    assert!(matches!(
        (one.unwrap().state, two.unwrap().state),
        (DeliveryState::Completed, DeliveryState::Rejected)
            | (DeliveryState::Rejected, DeliveryState::Completed)
    ));
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn invalid_native_answer_can_only_be_replaced_by_fresh_manual_handle_not_same_click() {
    let h = Arc::new(Host::new());
    *h.receipt.lock().unwrap() = ScopedInteractionReceipt::Invalid;
    let (_dir, g) = setup(h.clone()).await;
    let first = mint(&g, 60).await;
    let one = accept(&g, "invalid", first.token.clone()).await;
    assert_eq!(
        g.dispatch(&one.key).await.unwrap().state,
        DeliveryState::Rejected
    );
    *h.receipt.lock().unwrap() = ScopedInteractionReceipt::Accepted;
    let repeat = accept(&g, "invalid-repeat", first.token.clone()).await;
    assert_eq!(
        g.dispatch(&repeat.key).await.unwrap().state,
        DeliveryState::Rejected
    );
    let fresh = mint(&g, 60).await;
    assert_ne!(fresh.token, first.token);
    let two = accept(&g, "fresh", fresh.token).await;
    assert_eq!(
        g.dispatch(&two.key).await.unwrap().state,
        DeliveryState::Completed
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 2); // Invalid pre-effect + explicit new answer.
}
#[tokio::test]
async fn uncertain_native_receipt_and_cancelled_response_future_never_replay() {
    for cancel in [false, true] {
        let mut h = Host::new();
        h.blocked = cancel;
        *h.receipt.lock().unwrap() = ScopedInteractionReceipt::Uncertain;
        let h = Arc::new(h);
        let (_dir, g) = setup(h.clone()).await;
        let ticket = mint(&g, 60).await;
        let d = accept(&g, "uncertain", ticket.token).await;
        if cancel {
            let worker = tokio::spawn({
                let g = g.clone();
                let key = d.key.clone();
                async move { g.dispatch(&key).await }
            });
            h.entered.acquire().await.unwrap().forget();
            worker.abort();
            assert!(worker.await.unwrap_err().is_cancelled());
        }
        assert_eq!(
            g.dispatch(&d.key).await.unwrap().state,
            DeliveryState::Uncertain
        );
        assert_eq!(
            g.dispatch(&d.key).await.unwrap().state,
            DeliveryState::Uncertain
        );
        assert!(g
            .mint_interaction_ticket(scope(), RpcId::new("approval"), 60)
            .await
            .is_err());
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    }
}
#[tokio::test]
async fn snapshot_shape_budget_authority_and_handle_schema_fail_closed() {
    let h = Arc::new(Host::new());
    let (_dir, g) = setup(h.clone()).await;
    let mut wrong = scope();
    wrong.sender.user = "other".into();
    assert!(g
        .mint_interaction_ticket(wrong, RpcId::new("approval"), 60)
        .await
        .is_err());
    for kind in 0..6 {
        let mut s = snapshot();
        match kind {
            0 => s.frame.payload["sessionId"] = json!("other"),
            1 => s.frame.method = "session/cancel".into(),
            2 => s.frame.payload["reviewing"] = json!(true),
            3 => s.nonce.clear(),
            4 => s.frame.payload["reason"] = json!("x".repeat(128 * 1024)),
            _ => s.frame.payload["privateUnexpectedField"] = json!("must-not-leak"),
        }
        *h.pending.lock().unwrap() = Some(s);
        assert!(g
            .mint_interaction_ticket(scope(), RpcId::new("approval"), 60)
            .await
            .is_err());
    }
    for raw in ["", "short", &"x".repeat(48), &"A".repeat(48)] {
        assert!(TicketToken::try_from(raw.to_string()).is_err());
    }
    assert!(serde_json::from_value::<Command>(json!({"type":"answer_interaction","ticket":"a".repeat(48),"answer":{"type":"approval","allowed":true,"rpc_id":"forged"}})).is_err());
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn tickets_crash_child() {
    let Some(root) = std::env::var_os("XH_TICKET_CRASH_ROOT") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    let mut host = Host::new();
    host.crash = Some(root.join("effect"));
    let g = Gateway::open(&root, "h".into(), Arc::new(host)).unwrap();
    g.set_principal(principal()).await.unwrap();
    g.bind(binding()).await.unwrap();
    let ticket = mint(&g, 60).await;
    let d = accept(&g, "crash", ticket.token).await;
    g.dispatch(&d.key).await.unwrap();
    panic!("child must die after effect");
}
#[tokio::test]
async fn actual_process_death_after_native_effect_is_uncertain_on_restart_not_reanswered() {
    let dir = tempfile::tempdir().unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "tickets_crash_child", "--nocapture"])
        .env("XH_TICKET_CRASH_ROOT", dir.path())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(79));
    assert_eq!(
        std::fs::read(dir.path().join("effect")).unwrap(),
        b"applied"
    );
    let h = Arc::new(Host::new());
    let g = Gateway::open(dir.path(), "h".into(), h.clone()).unwrap();
    let pending = g.pending().await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(
        g.dispatch(&pending[0].key).await.unwrap().state,
        DeliveryState::Uncertain
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    assert!(g
        .mint_interaction_ticket(scope(), RpcId::new("approval"), 60)
        .await
        .is_err());
    let entry = g.uncertain_inbox(0).await.unwrap().items.remove(0);
    let review = RecoveryReview {
        delivery_key: pending[0].key.clone(),
        actor: "authenticated-desktop".into(),
        evidence_sha256: "e".repeat(64),
        resolution: RecoveryResolution::ObservedAccepted,
    };
    let receipt = g
        .resolve_inbox(entry.identity.clone(), review.clone())
        .await
        .unwrap();
    assert_eq!(receipt.audit.current, DeliveryState::Completed);
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    g.close().await.unwrap();
    let g = Gateway::open(dir.path(), "h".into(), h.clone()).unwrap();
    assert_eq!(
        g.resolve_inbox(entry.identity, review).await.unwrap(),
        receipt
    );
    assert!(g
        .mint_interaction_ticket(scope(), RpcId::new("approval"), 60)
        .await
        .is_err());
    assert_eq!(
        std::fs::read(dir.path().join("effect")).unwrap(),
        b"applied"
    );
    assert_eq!(g.recovery_audit(&pending[0].key).await.unwrap().len(), 1);
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    g.close().await.unwrap();
}

#[tokio::test]
async fn account_observer_catalog_and_output_fence_current_lease_scope_and_ambiguous_routes() {
    let h = Arc::new(Host::new());
    let (_dir, g) = setup(h).await;
    let account = Account {
        channel: Channel::Telegram,
        id: "bot".into(),
    };
    let one = g.acquire_account(account.clone()).await.unwrap();
    assert_eq!(g.account_subscriptions(&one).await.unwrap(), vec![scope()]);
    let unrelated = g
        .acquire_account(Account {
            id: "other-bot".into(),
            ..account.clone()
        })
        .await
        .unwrap();
    assert!(g
        .account_subscriptions(&unrelated)
        .await
        .unwrap()
        .is_empty());
    let plan = ReplyPlan {
        id: "observer-lease".into(),
        body: ReplyBody {
            attachment: None,
            text: "fixture".into(),
            buttons: vec![],
        },
        replace_of: None,
    };
    assert!(matches!(
        g.enqueue_account_replies(&unrelated, scope(), vec![plan.clone()])
            .await,
        Err(Error::Unauthorized)
    ));
    let two = g.acquire_account(account).await.unwrap();
    assert!(matches!(
        g.account_subscriptions(&one).await,
        Err(Error::StaleLease)
    ));
    assert!(matches!(
        g.enqueue_account_replies(&one, scope(), vec![plan.clone()])
            .await,
        Err(Error::StaleLease)
    ));
    assert!(g.pending_replies(&two).await.unwrap().is_empty());
    g.enqueue_account_replies(&two, scope(), vec![plan])
        .await
        .unwrap();
    let mut duplicate = principal();
    duplicate.id = "p2".into();
    g.set_principal(duplicate.clone()).await.unwrap();
    let mut duplicate_binding = binding();
    duplicate_binding.id = "b2".into();
    duplicate_binding.principal = "p2".into();
    g.bind(duplicate_binding).await.unwrap();
    assert!(matches!(
        g.account_subscriptions(&two).await,
        Err(Error::IdentityConflict)
    ));
    duplicate.revision = 2;
    duplicate.revoked = true;
    g.set_principal(duplicate).await.unwrap();
    assert_eq!(g.account_subscriptions(&two).await.unwrap(), vec![scope()]);
}
#[tokio::test]
async fn account_observer_catalog_does_not_silently_truncate_subscription_capacity() {
    let h = Arc::new(Host::new());
    let (_dir, g) = setup(h).await;
    let lease = g
        .acquire_account(Account {
            channel: Channel::Telegram,
            id: "bot".into(),
        })
        .await
        .unwrap();
    for index in 0..32 {
        let mut p = principal();
        p.id = format!("p-{index}");
        p.sender.user = (100 + index).to_string();
        let mut b = binding();
        b.id = format!("b-{index}");
        b.principal = p.id.clone();
        b.conversation = p.sender.user.clone();
        g.set_principal(p).await.unwrap();
        g.bind(b).await.unwrap();
    }
    assert!(matches!(
        g.account_subscriptions(&lease).await,
        Err(Error::Capacity)
    ));
}
#[test]
fn structured_reply_button_debug_does_not_print_callback_handles() {
    let raw = "f".repeat(48);
    let body = ReplyBody {
        attachment: None,
        text: "fixture".into(),
        buttons: vec![vec![ReplyButton {
            label: "Approve".into(),
            ticket: format!("a:{raw}"),
        }]],
    };
    assert!(!format!("{body:?}").contains(&raw));
    assert_eq!(
        serde_json::to_value(body).unwrap()["buttons"][0][0]["ticket"],
        format!("a:{raw}")
    );
}

#[tokio::test]
async fn expired_ticket_read_commits_terminal_state_before_returning_forbidden() {
    let h = Arc::new(Host::new());
    let (dir, g) = setup(h.clone()).await;
    let old = mint(&g, 1).await;
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    assert!(matches!(
        g.interaction_ticket_for(scope(), old.token.clone()).await,
        Err(Error::Unauthorized)
    ));
    let database = rusqlite::Connection::open_with_flags(
        dir.path().join("remote.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let state: String = database
        .query_row(
            "SELECT state FROM interaction_tickets WHERE json_extract(body,'$.token')=?1",
            [old.token.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "expired");
    drop(database);
    let fresh = mint(&g, 60).await;
    assert_ne!(fresh.token, old.token);
    let old_delivery = accept(&g, "old-expired", old.token).await;
    assert_eq!(
        g.dispatch(&old_delivery.key).await.unwrap().state,
        DeliveryState::Rejected
    );
    let fresh_delivery = accept(&g, "fresh-manual", fresh.token).await;
    assert_eq!(
        g.dispatch(&fresh_delivery.key).await.unwrap().state,
        DeliveryState::Completed
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn desktop_reviews_atomically_seal_uncertain_interactions_without_answer_or_handle_reuse() {
    for resolution in [
        RecoveryResolution::ObservedAccepted,
        RecoveryResolution::VerifiedNotApplied,
        RecoveryResolution::AbandonWithoutReplay,
    ] {
        let h = Arc::new(Host {
            unknown: true,
            ..Host::new()
        });
        let (dir, g) = setup(h.clone()).await;
        let ticket = mint(&g, 60).await;
        let d = accept(&g, "unknown", ticket.token.clone()).await;
        assert_eq!(
            g.dispatch(&d.key).await.unwrap().state,
            DeliveryState::Uncertain
        );
        let entry = g.uncertain_inbox(0).await.unwrap().items.remove(0);
        assert_eq!(entry.interaction, Some(InboxInteractionKind::Approval));
        let raw = serde_json::to_string(&entry).unwrap();
        assert!(!raw.contains(ticket.token.as_str()));
        assert!(!raw.contains("native-pending-instance"));
        assert!(!raw.contains("PRIVATE_RESPONSE_ERROR"));
        let r = RecoveryReview {
            delivery_key: d.key.clone(),
            actor: "authenticated-desktop".into(),
            evidence_sha256: "a".repeat(64),
            resolution,
        };
        let receipt = g
            .resolve_inbox(entry.identity.clone(), r.clone())
            .await
            .unwrap();
        assert_eq!(
            g.resolve_inbox(entry.identity.clone(), r.clone())
                .await
                .unwrap(),
            receipt
        );
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
        assert!(g
            .mint_interaction_ticket(scope(), RpcId::new("approval"), 60)
            .await
            .is_err());
        let db = rusqlite::Connection::open(dir.path().join("remote.sqlite")).unwrap();
        let states:(String,String)=db.query_row("SELECT t.state,f.state FROM interaction_tickets AS t JOIN interaction_fences AS f ON f.instance=t.instance",[],|row|Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(states, ("reviewed".into(), "reviewed".into()));
        drop(db);
        g.close().await.unwrap();
        let g = Gateway::open(dir.path(), "h".into(), h.clone()).unwrap();
        assert_eq!(g.resolve_inbox(entry.identity, r).await.unwrap(), receipt);
        let duplicate = accept(&g, "late-old-handle", ticket.token).await;
        assert_eq!(
            g.dispatch(&duplicate.key).await.unwrap().state,
            DeliveryState::Rejected
        );
        assert_eq!(h.calls.load(Ordering::SeqCst), 1);
        assert_eq!(g.recovery_audit(&d.key).await.unwrap().len(), 1);
        g.close().await.unwrap();
    }
}
#[tokio::test]
async fn interaction_owner_corruption_rolls_back_review_and_never_releases_the_fence() {
    let h = Arc::new(Host {
        unknown: true,
        ..Host::new()
    });
    let (dir, g) = setup(h.clone()).await;
    let ticket = mint(&g, 60).await;
    let d = accept(&g, "corrupt", ticket.token).await;
    let unknown = g.dispatch(&d.key).await.unwrap();
    let e = g.uncertain_inbox(0).await.unwrap().items.remove(0).identity;
    let db = rusqlite::Connection::open(dir.path().join("remote.sqlite")).unwrap();
    db.execute("UPDATE interaction_fences SET delivery='foreign'", [])
        .unwrap();
    drop(db);
    assert!(matches!(
        g.resolve_inbox(
            e,
            RecoveryReview {
                delivery_key: d.key.clone(),
                actor: "authenticated-desktop".into(),
                evidence_sha256: "a".repeat(64),
                resolution: RecoveryResolution::VerifiedNotApplied
            }
        )
        .await,
        Err(Error::IdentityConflict)
    ));
    assert!(g.recovery_audit(&d.key).await.unwrap().is_empty());
    assert_eq!(g.inspect(&d.key).await.unwrap().unwrap(), unknown);
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    g.close().await.unwrap();
}

#[tokio::test]
async fn question_cancel_review_omits_question_content_and_seals_only_the_original_instance() {
    let h = Arc::new(Host {
        unknown: true,
        ..Host::new()
    });
    *h.pending.lock().unwrap() = Some(ScopedInteraction {
        nonce: "question-instance-one".into(),
        frame: ServerRequest::new(
            RpcId::new("question"),
            "question/requested",
            json!({"type":"question/requested","sessionId":"s","questions":[{"id":"target","header":"PRIVATE_HEADER","question":"PRIVATE_QUESTION","options":[{"label":"PRIVATE_OPTION"}],"multiSelect":false}]}),
        ),
    });
    let (dir, g) = setup(h.clone()).await;
    let ticket = g
        .mint_interaction_ticket(scope(), RpcId::new("question"), 60)
        .await
        .unwrap();
    let d = g
        .accept(
            "p",
            scope().sender,
            "42".into(),
            Inbound {
                request_id: "cancel-question".into(),
                binding: "b".into(),
                generation: 1,
                command: Command::AnswerInteraction {
                    ticket: ticket.token.clone(),
                    answer: ScopedInteractionAnswer::CancelQuestion,
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Uncertain
    );
    let e = g.uncertain_inbox(0).await.unwrap().items.remove(0);
    assert_eq!(e.interaction, Some(InboxInteractionKind::Question));
    assert!(!serde_json::to_string(&e).unwrap().contains("PRIVATE_"));
    g.resolve_inbox(
        e.identity,
        RecoveryReview {
            delivery_key: d.key,
            actor: "authenticated-desktop".into(),
            evidence_sha256: "a".repeat(64),
            resolution: RecoveryResolution::AbandonWithoutReplay,
        },
    )
    .await
    .unwrap();
    assert!(g
        .mint_interaction_ticket(scope(), RpcId::new("question"), 60)
        .await
        .is_err());
    h.pending.lock().unwrap().as_mut().unwrap().nonce = "question-instance-two".into();
    let fresh = g
        .mint_interaction_ticket(scope(), RpcId::new("question"), 60)
        .await
        .unwrap();
    assert_ne!(fresh.token, ticket.token);
    let old = accept(&g, "old-question-click", ticket.token).await;
    assert_eq!(
        g.dispatch(&old.key).await.unwrap().state,
        DeliveryState::Rejected
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    let db = rusqlite::Connection::open(dir.path().join("remote.sqlite")).unwrap();
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM interaction_fences WHERE state='reviewed'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    drop(db);
    g.close().await.unwrap();
}

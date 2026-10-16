//! Durable provider-effect fixtures; no paid model or real platform account.
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use xharness_api::{
    ApiBackend, ClientResponse, EventStream, RpcError, RpcId, RpcMethod, RpcReceipt, RpcResult,
};
use xharness_remote::*;
struct Host {
    scope: AtomicBool,
    hung_scope: AtomicBool,
}
#[async_trait]
impl ApiBackend for Host {
    async fn call(&self, _: RpcId, _: RpcMethod, _: Value, _: CancellationToken) -> RpcResult {
        panic!("reply must never run Agent again")
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
        if self.hung_scope.load(Ordering::SeqCst) {
            std::future::pending::<()>().await;
        }
        Ok(w == "w" && s == "s" && self.scope.load(Ordering::SeqCst))
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("reply must never answer Host approval")
    }
    fn mux_events(&self) -> EventStream {
        panic!("reply must never use global mux")
    }
    fn host_events(&self) -> EventStream {
        panic!("reply must never use global events")
    }
}
struct Transport {
    account: Account,
    calls: AtomicUsize,
    requests: Mutex<Vec<SendRequest>>,
    outcome: Mutex<SendOutcome>,
    entered: Semaphore,
    release: Semaphore,
    crash: Option<std::path::PathBuf>,
}
impl Transport {
    fn new(outcome: SendOutcome) -> Self {
        Self {
            account: account(),
            calls: AtomicUsize::new(0),
            requests: Mutex::new(vec![]),
            outcome: Mutex::new(outcome),
            entered: Semaphore::new(0),
            release: Semaphore::new(100),
            crash: None,
        }
    }
    fn delivered() -> Self {
        Self::new(SendOutcome::Delivered(ProviderReceipt {
            message_id: "99".into(),
        }))
    }
}
#[async_trait]
impl ReplyTransport for Transport {
    fn account(&self) -> &Account {
        &self.account
    }
    async fn send(&self, request: SendRequest) -> SendOutcome {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.requests.lock().unwrap().push(request);
        self.entered.add_permits(1);
        self.release.acquire().await.unwrap().forget();
        if let Some(path) = &self.crash {
            let file = std::fs::File::create(path.join("provider-effect.json")).unwrap();
            serde_json::to_writer(&file, &json!({"message_id":"99","fixture":true})).unwrap();
            file.sync_all().unwrap();
            std::process::exit(79);
        }
        self.outcome.lock().unwrap().clone()
    }
}
fn account() -> Account {
    Account {
        channel: Channel::Telegram,
        id: "bot".into(),
    }
}
fn sender(user: &str) -> Sender {
    Sender {
        channel: Channel::Telegram,
        account: "bot".into(),
        user: user.into(),
    }
}
fn principal(id: &str, user: &str) -> Principal {
    Principal {
        id: id.into(),
        host: "h".into(),
        sender: sender(user),
        workspaces: BTreeSet::from(["w".into()]),
        sessions: BTreeSet::from(["s".into()]),
        revision: 1,
        revoked: false,
    }
}
fn binding(id: &str, p: &str, user: &str) -> Binding {
    Binding {
        id: id.into(),
        principal: p.into(),
        conversation: user.into(),
        workspace: "w".into(),
        session: "s".into(),
        generation: 1,
    }
}
fn scope() -> Subscription {
    Subscription {
        principal: "p".into(),
        sender: sender("42"),
        conversation: "42".into(),
        binding: "b".into(),
        generation: 1,
    }
}
fn plan(id: &str) -> ReplyPlan {
    ReplyPlan {
        id: id.into(),
        body: ReplyBody {
            attachment: None,
            text: "real projection fixture, not Agent completion".into(),
            buttons: vec![],
        },
        replace_of: None,
    }
}
async fn configure(g: &Gateway) {
    g.set_principal(principal("p", "42")).await.unwrap();
    g.bind(binding("b", "p", "42")).await.unwrap();
}
async fn setup() -> (tempfile::TempDir, Arc<Gateway>, Arc<Host>, AccountLease) {
    let dir = tempfile::tempdir().unwrap();
    let host = Arc::new(Host {
        scope: AtomicBool::new(true),
        hung_scope: AtomicBool::new(false),
    });
    let g = Gateway::open(dir.path(), "h".into(), host.clone()).unwrap();
    configure(&g).await;
    let lease = g.acquire_account(account()).await.unwrap();
    (dir, g, host, lease)
}
async fn enqueue(g: &Gateway, id: &str) -> Outgoing {
    g.enqueue_replies(scope(), vec![plan(id)])
        .await
        .unwrap()
        .remove(0)
}
async fn deliver(g: &Gateway, lease: &AccountLease, r: &Outgoing, t: Arc<Transport>) -> Outgoing {
    g.deliver_reply(lease.clone(), &r.key, t, CancellationToken::new())
        .await
        .unwrap()
}
#[tokio::test]
async fn enqueue_deduplicates_and_survives_restart_without_provider_or_host_calls() {
    let (dir, g, host, _lease) = setup().await;
    let r = enqueue(&g, "reply").await;
    assert_eq!(enqueue(&g, "reply").await, r);
    let mut changed = plan("reply");
    changed.body.text = "changed".into();
    assert!(matches!(
        g.enqueue_replies(scope(), vec![changed]).await,
        Err(Error::IdentityConflict)
    ));
    g.close().await.unwrap();
    drop(g);
    let g = Gateway::open(dir.path(), "h".into(), host).unwrap();
    let lease = g.acquire_account(account()).await.unwrap();
    assert_eq!(g.pending_replies(&lease).await.unwrap(), vec![r.clone()]);
    let t = Arc::new(Transport::delivered());
    assert_eq!(
        deliver(&g, &lease, &r, t.clone()).await.state,
        ReplyState::Delivered
    );
    assert_eq!(
        deliver(&g, &lease, &r, t.clone()).await.state,
        ReplyState::Delivered
    );
    assert_eq!(t.calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn uncertain_send_never_replays_and_blocks_only_that_recipient_not_agent_or_others() {
    let (_dir, g, _host, lease) = setup().await;
    let r = enqueue(&g, "first").await;
    let next = enqueue(&g, "second").await;
    let t = Arc::new(Transport::new(SendOutcome::Uncertain));
    assert_eq!(
        deliver(&g, &lease, &r, t.clone()).await.state,
        ReplyState::Uncertain
    );
    deliver(&g, &lease, &r, t.clone()).await;
    assert_eq!(t.calls.load(Ordering::SeqCst), 1);
    assert!(matches!(
        g.deliver_reply(
            lease.clone(),
            &next.key,
            t.clone(),
            CancellationToken::new()
        )
        .await,
        Err(Error::ReplyBlocked)
    ));
    g.set_principal(principal("other", "43")).await.unwrap();
    g.bind(binding("other-b", "other", "43")).await.unwrap();
    let mut other = scope();
    other.principal = "other".into();
    other.binding = "other-b".into();
    other.sender = sender("43");
    other.conversation = "43".into();
    let independent = g
        .enqueue_replies(other, vec![plan("independent")])
        .await
        .unwrap()
        .remove(0);
    *t.outcome.lock().unwrap() = SendOutcome::Delivered(ProviderReceipt {
        message_id: "100".into(),
    });
    assert_eq!(
        deliver(&g, &lease, &independent, t).await.state,
        ReplyState::Delivered
    );
    // Inbox admission is still allowed; outbox ambiguity is not a session gate.
    g.accept(
        "p",
        sender("42"),
        "42".into(),
        Inbound {
            request_id: "next-input".into(),
            binding: "b".into(),
            generation: 1,
            command: Command::Cancel,
        },
    )
    .await
    .unwrap();
}
#[tokio::test]
async fn shutdown_during_send_is_uncertain_but_pre_cancelled_send_remains_pending() {
    let (_dir, g, _host, lease) = setup().await;
    let r = enqueue(&g, "reply").await;
    let t = Arc::new(Transport::delivered());
    let stop = CancellationToken::new();
    stop.cancel();
    assert_eq!(
        g.deliver_reply(lease.clone(), &r.key, t.clone(), stop)
            .await
            .unwrap()
            .state,
        ReplyState::Pending
    );
    assert_eq!(t.calls.load(Ordering::SeqCst), 0);
    t.release.forget_permits(100);
    let stop = CancellationToken::new();
    let run_stop = stop.clone();
    let gateway = g.clone();
    let worker = t.clone();
    let active_lease = lease.clone();
    let key = r.key.clone();
    let task = tokio::spawn(async move {
        gateway
            .deliver_reply(active_lease, &key, worker, run_stop)
            .await
    });
    t.entered.acquire().await.unwrap().forget();
    stop.cancel();
    assert_eq!(task.await.unwrap().unwrap().state, ReplyState::Uncertain);
    assert_eq!(g.inspect_reply(&r.key).await.unwrap().unwrap().attempts, 1);
}
#[tokio::test]
async fn revoke_and_account_takeover_linearize_after_bounded_inflight_send() {
    let (_dir, g, _host, lease) = setup().await;
    let r = enqueue(&g, "reply").await;
    let t = Arc::new(Transport::delivered());
    t.release.forget_permits(100);
    let gateway = g.clone();
    let worker = t.clone();
    let active_lease = lease.clone();
    let key = r.key.clone();
    let task = tokio::spawn(async move {
        gateway
            .deliver_reply(active_lease, &key, worker, CancellationToken::new())
            .await
    });
    t.entered.acquire().await.unwrap().forget();
    let gateway = g.clone();
    let revoke = tokio::spawn(async move { gateway.revoke("p").await });
    let gateway = g.clone();
    let takeover = tokio::spawn(async move { gateway.acquire_account(account()).await });
    tokio::task::yield_now().await;
    assert!(!revoke.is_finished());
    assert!(!takeover.is_finished());
    t.release.add_permits(1);
    assert_eq!(task.await.unwrap().unwrap().state, ReplyState::Delivered);
    revoke.await.unwrap().unwrap();
    let new = takeover.await.unwrap().unwrap();
    assert!(new.generation > lease.generation);
    assert!(matches!(
        g.deliver_reply(lease, &r.key, t.clone(), CancellationToken::new())
            .await,
        Err(Error::StaleLease)
    ));
    assert_eq!(t.calls.load(Ordering::SeqCst), 1);
    assert!(matches!(
        g.enqueue_replies(scope(), vec![plan("after-revoke")]).await,
        Err(Error::Unauthorized)
    ));
}
#[tokio::test]
async fn queued_reply_scope_changes_and_missing_host_scope_cannot_send() {
    let (_dir, g, host, lease) = setup().await;
    let r = enqueue(&g, "reply").await;
    let t = Arc::new(Transport::delivered());
    let mut b = binding("b", "p", "42");
    b.generation = 2;
    g.bind(b).await.unwrap();
    assert_eq!(
        deliver(&g, &lease, &r, t.clone()).await.failure,
        Some(ReplyFailure::ScopeChanged)
    );
    let mut changed = scope();
    changed.generation = 2;
    let r = g
        .enqueue_replies(changed, vec![plan("later")])
        .await
        .unwrap()
        .remove(0);
    host.scope.store(false, Ordering::SeqCst);
    assert_eq!(
        deliver(&g, &lease, &r, t.clone()).await.state,
        ReplyState::Rejected
    );
    assert_eq!(t.calls.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn provider_rate_limit_is_the_only_automatic_retry_and_fifo_waits_for_backoff() {
    let (_dir, g, _host, lease) = setup().await;
    let r = enqueue(&g, "first").await;
    let later = enqueue(&g, "later").await;
    let t = Arc::new(Transport::new(SendOutcome::RetryAfter { seconds: 1 }));
    let pending = deliver(&g, &lease, &r, t.clone()).await;
    assert_eq!(pending.state, ReplyState::Pending);
    assert_eq!(pending.attempts, 1);
    assert!(g.pending_replies(&lease).await.unwrap().is_empty());
    assert!(matches!(
        g.deliver_reply(
            lease.clone(),
            &later.key,
            t.clone(),
            CancellationToken::new()
        )
        .await,
        Err(Error::ReplyBlocked)
    ));
    assert!(matches!(
        g.deliver_reply(lease.clone(), &r.key, t.clone(), CancellationToken::new())
            .await,
        Err(Error::ReplyDeferred)
    ));
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    *t.outcome.lock().unwrap() = SendOutcome::Delivered(ProviderReceipt {
        message_id: "99".into(),
    });
    assert_eq!(deliver(&g, &lease, &r, t.clone()).await.attempts, 2);
    assert_eq!(t.calls.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn edits_require_same_scope_delivered_record_and_wrong_receipt_is_uncertain() {
    let (_dir, g, _host, lease) = setup().await;
    let original = enqueue(&g, "original").await;
    let mut edit = plan("edit");
    edit.replace_of = Some(original.key.clone());
    assert!(matches!(
        g.enqueue_replies(scope(), vec![edit.clone()]).await,
        Err(Error::Unauthorized)
    ));
    let t = Arc::new(Transport::delivered());
    deliver(&g, &lease, &original, t.clone()).await;
    let edited = g
        .enqueue_replies(scope(), vec![edit])
        .await
        .unwrap()
        .remove(0);
    assert_eq!(
        deliver(&g, &lease, &edited, t.clone())
            .await
            .receipt
            .unwrap()
            .message_id,
        "99"
    );
    assert_eq!(
        t.requests.lock().unwrap()[1].replace_message.as_deref(),
        Some("99")
    );
    let mut edit = plan("bad-receipt");
    edit.replace_of = Some(original.key);
    let edited = g
        .enqueue_replies(scope(), vec![edit])
        .await
        .unwrap()
        .remove(0);
    *t.outcome.lock().unwrap() = SendOutcome::Delivered(ProviderReceipt {
        message_id: "different".into(),
    });
    assert_eq!(
        deliver(&g, &lease, &edited, t).await.state,
        ReplyState::Uncertain
    );
}
#[tokio::test]
async fn batch_is_atomic_and_invalid_rejection_classification_is_not_false_certainty() {
    let (_dir, g, _host, lease) = setup().await;
    assert!(matches!(
        g.enqueue_replies(scope(), vec![plan("same"), plan("same")])
            .await,
        Err(Error::IdentityConflict)
    ));
    assert!(g.pending_replies(&lease).await.unwrap().is_empty());
    let mut invalid = plan("invalid");
    invalid.body.text = "\0".into();
    assert!(g
        .enqueue_replies(scope(), vec![plan("valid"), invalid])
        .await
        .is_err());
    assert!(g.pending_replies(&lease).await.unwrap().is_empty());
    let r = enqueue(&g, "reply").await;
    let t = Arc::new(Transport::new(SendOutcome::Rejected(
        ReplyFailure::ProviderUncertain,
    )));
    assert_eq!(
        deliver(&g, &lease, &r, t).await.state,
        ReplyState::Uncertain
    );
}
#[tokio::test]
async fn manual_reply_resolution_is_audited_idempotent_and_never_resends() {
    let (_dir, g, _host, lease) = setup().await;
    let r = enqueue(&g, "first").await;
    let next = enqueue(&g, "next").await;
    let t = Arc::new(Transport::new(SendOutcome::Uncertain));
    deliver(&g, &lease, &r, t.clone()).await;
    let review = ReplyReview {
        key: r.key.clone(),
        actor: "desktop-owner".into(),
        evidence_sha256: "a".repeat(64),
        resolution: ReplyResolution::AbandonWithoutReplay,
    };
    let audit = g.resolve_reply(review.clone()).await.unwrap();
    assert_eq!(audit.current, ReplyState::Abandoned);
    assert_eq!(g.resolve_reply(review.clone()).await.unwrap(), audit);
    assert_eq!(g.reply_audit(&r.key).await.unwrap(), vec![audit]);
    assert!(g.reply_audit("missing").await.unwrap().is_empty());
    let mut changed = review;
    changed.resolution = ReplyResolution::VerifiedNotSent;
    assert!(matches!(
        g.resolve_reply(changed).await,
        Err(Error::IdentityConflict)
    ));
    assert_eq!(t.calls.load(Ordering::SeqCst), 1);
    assert_eq!(g.pending_replies(&lease).await.unwrap()[0].key, next.key);
}
#[tokio::test]
async fn simultaneous_duplicate_sender_calls_have_one_provider_effect() {
    let (_dir, g, _host, lease) = setup().await;
    let r = enqueue(&g, "reply").await;
    let t = Arc::new(Transport::delivered());
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..32 {
        let g = g.clone();
        let lease = lease.clone();
        let r = r.clone();
        let t = t.clone();
        tasks.spawn(async move { deliver(&g, &lease, &r, t).await });
    }
    while let Some(r) = tasks.join_next().await {
        assert_eq!(r.unwrap().state, ReplyState::Delivered);
    }
    assert_eq!(t.calls.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn crash_reply_child() {
    let Some(path) = std::env::var_os("XHARNESS_REPLY_CRASH_FIXTURE") else {
        return;
    };
    let path = std::path::PathBuf::from(path);
    let host = Arc::new(Host {
        scope: AtomicBool::new(true),
        hung_scope: AtomicBool::new(false),
    });
    let g = Gateway::open(&path, "h".into(), host).unwrap();
    configure(&g).await;
    let lease = g.acquire_account(account()).await.unwrap();
    let r = enqueue(&g, "crash").await;
    let mut t = Transport::delivered();
    t.crash = Some(path);
    deliver(&g, &lease, &r, Arc::new(t)).await;
    panic!("crash fixture must exit after provider effect")
}
#[tokio::test]
async fn process_death_after_provider_effect_does_not_blindly_send_again() {
    let dir = tempfile::tempdir().unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "crash_reply_child", "--nocapture"])
        .env("XHARNESS_REPLY_CRASH_FIXTURE", dir.path())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(79));
    assert!(dir.path().join("provider-effect.json").is_file());
    let host = Arc::new(Host {
        scope: AtomicBool::new(true),
        hung_scope: AtomicBool::new(false),
    });
    let g = Gateway::open(dir.path(), "h".into(), host).unwrap();
    let lease = g.acquire_account(account()).await.unwrap();
    let r = g.pending_replies(&lease).await.unwrap().remove(0);
    assert_eq!(r.state, ReplyState::Sending);
    let t = Arc::new(Transport::delivered());
    assert_eq!(
        deliver(&g, &lease, &r, t.clone()).await.state,
        ReplyState::Uncertain
    );
    assert_eq!(t.calls.load(Ordering::SeqCst), 0);
    let review = ReplyReview {
        key: r.key,
        actor: "owner".into(),
        evidence_sha256: "b".repeat(64),
        resolution: ReplyResolution::ObservedDelivered {
            receipt: ProviderReceipt {
                message_id: "99".into(),
            },
        },
    };
    assert_eq!(
        g.resolve_reply(review).await.unwrap().current,
        ReplyState::Delivered
    );
}

#[tokio::test]
async fn capacity_exhaustion_rolls_back_entire_batch_without_partial_outgoing_ack() {
    let (_dir, g, _host, _lease) = setup().await;
    for batch in 0..16 {
        let count = if batch == 15 { 63 } else { 64 };
        let plans = (0..count)
            .map(|i| plan(&format!("fill-{batch}-{i}")))
            .collect();
        g.enqueue_replies(scope(), plans).await.unwrap();
    }
    assert!(matches!(
        g.enqueue_replies(scope(), vec![plan("overflow-a"), plan("overflow-b")])
            .await,
        Err(Error::Capacity)
    ));
    let remaining = enqueue(&g, "overflow-a").await;
    assert_eq!(remaining.sequence, 1024);
    assert!(matches!(
        g.enqueue_replies(scope(), vec![plan("overflow-b")]).await,
        Err(Error::Capacity)
    ));
}

#[tokio::test]
async fn hung_host_scope_is_bounded_without_claiming_send_and_releases_takeover() {
    let (_dir, g, host, lease) = setup().await;
    let r = enqueue(&g, "reply").await;
    host.hung_scope.store(true, Ordering::SeqCst);
    let t = Arc::new(Transport::delivered());
    let operation = {
        let g = g.clone();
        let lease = lease.clone();
        let t = t.clone();
        let key = r.key.clone();
        tokio::spawn(async move {
            g.deliver_reply(lease, &key, t, CancellationToken::new())
                .await
        })
    };
    assert!(matches!(
        tokio::time::timeout(std::time::Duration::from_secs(4), operation)
            .await
            .unwrap()
            .unwrap(),
        Err(Error::HostUnavailable)
    ));
    assert_eq!(t.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        g.inspect_reply(&r.key).await.unwrap().unwrap().state,
        ReplyState::Pending
    );
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        g.acquire_account(account()),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(matches!(
        g.enqueue_replies(scope(), vec![plan("other")]).await,
        Err(Error::HostUnavailable)
    ));
    let mut revoked = principal("p", "42");
    revoked.revision = 2;
    revoked.revoked = true;
    tokio::time::timeout(std::time::Duration::from_secs(1), g.set_principal(revoked))
        .await
        .unwrap()
        .unwrap();
}
#[tokio::test]
async fn independent_sender_worker_drains_fifo_then_stops_without_agent_dispatch() {
    let (_dir, g, _host, lease) = setup().await;
    let first = enqueue(&g, "one").await;
    let second = enqueue(&g, "two").await;
    let t = Arc::new(Transport::delivered());
    let shutdown = CancellationToken::new();
    let worker = tokio::spawn(
        g.clone()
            .run_replies(lease.clone(), t.clone(), shutdown.clone()),
    );
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if g.inspect_reply(&second.key).await.unwrap().unwrap().state == ReplyState::Delivered {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    shutdown.cancel();
    worker.await.unwrap().unwrap();
    assert_eq!(
        g.inspect_reply(&first.key).await.unwrap().unwrap().state,
        ReplyState::Delivered
    );
    assert_eq!(t.calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        t.requests
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.body.text.clone())
            .collect::<Vec<_>>(),
        vec![first.plan.body.text, second.plan.body.text]
    );
    let stale_worker = tokio::spawn(g.clone().run_replies(
        lease,
        t.clone(),
        CancellationToken::new(),
    ));
    g.acquire_account(account()).await.unwrap();
    assert!(matches!(
        tokio::time::timeout(std::time::Duration::from_secs(2), stale_worker)
            .await
            .unwrap()
            .unwrap(),
        Err(Error::StaleLease)
    ));
    assert_eq!(t.calls.load(Ordering::SeqCst), 2);
}

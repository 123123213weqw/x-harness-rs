//! Actual SQLite scope/atomic-result fixtures, no platform or model work.
mod support;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use xharness_api::{
    ApiBackend, ClientResponse, EventStream, RpcError, RpcId, RpcMethod, RpcReceipt, RpcResult,
};
use xharness_remote::*;
struct Host {
    calls: AtomicUsize,
    hold: AtomicBool,
    entered: Semaphore,
}
#[async_trait]
impl ApiBackend for Host {
    async fn call(&self, _: RpcId, _: RpcMethod, _: Value, _: CancellationToken) -> RpcResult {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.add_permits(1);
        if self.hold.load(Ordering::SeqCst) {
            std::future::pending::<()>().await;
        }
        RpcResult::success(json!({"events":[],"hasMore":false}))
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
        Ok(w == "w" && s == "s")
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("no arbitrary response")
    }
    fn mux_events(&self) -> EventStream {
        panic!("no global stream")
    }
    fn host_events(&self) -> EventStream {
        panic!("no global stream")
    }
}
fn host() -> Arc<Host> {
    Arc::new(Host {
        calls: AtomicUsize::new(0),
        hold: AtomicBool::new(false),
        entered: Semaphore::new(0),
    })
}
fn sender() -> Sender {
    Sender {
        channel: Channel::Telegram,
        account: "bot".into(),
        user: "42".into(),
    }
}
fn scope() -> Subscription {
    Subscription {
        principal: "p".into(),
        sender: sender(),
        conversation: "42".into(),
        binding: "b".into(),
        generation: 1,
    }
}
async fn setup_at(root: &std::path::Path) -> (Arc<Gateway>, Arc<Host>, AccountLease) {
    let h = host();
    let g = Gateway::open(root, "h".into(), h.clone()).unwrap();
    support::install_scope(&g, sender(), &["w"], &["s"], ("w", "s")).await;
    let l = g
        .acquire_account(Account {
            channel: Channel::Telegram,
            id: "bot".into(),
        })
        .await
        .unwrap();
    (g, h, l)
}
async fn admit(g: &Gateway, id: &str, command: Command) -> Delivery {
    g.accept(
        "p",
        sender(),
        "42".into(),
        Inbound {
            request_id: id.into(),
            binding: "b".into(),
            generation: 1,
            command,
        },
    )
    .await
    .unwrap()
}
async fn complete(g: &Arc<Gateway>, id: &str) -> Delivery {
    let d = admit(
        g,
        id,
        Command::History {
            before_seq: None,
            max_messages: 25,
        },
    )
    .await;
    g.dispatch(&d.key).await.unwrap()
}
fn plan(d: &Delivery, text: &str) -> ReplyPlan {
    ReplyPlan {
        id: format!("command:{}:{:?}", d.key, d.state),
        body: ReplyBody {
            attachment: None,
            text: text.into(),
            buttons: vec![],
        },
        replace_of: None,
    }
}
#[tokio::test]
async fn command_receipt_and_batch_are_atomic_idempotent_and_persist_across_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let (g, h, l) = setup_at(dir.path()).await;
    let queued = admit(
        &g,
        "one",
        Command::History {
            before_seq: None,
            max_messages: 25,
        },
    )
    .await;
    assert!(g
        .command_reply_candidate(&l, scope())
        .await
        .unwrap()
        .is_none());
    let d = g.dispatch(&queued.key).await.unwrap();
    assert_eq!(
        g.command_reply_candidate(&l, scope()).await.unwrap(),
        Some(d.clone())
    );
    let plans = vec![plan(&d, "history")];
    let batch = g
        .enqueue_command_replies(&l, scope(), d.clone(), plans.clone())
        .await
        .unwrap();
    assert!(g
        .command_reply_candidate(&l, scope())
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        g.enqueue_command_replies(&l, scope(), d.clone(), plans)
            .await
            .unwrap(),
        batch
    );
    assert!(matches!(
        g.enqueue_command_replies(&l, scope(), d.clone(), vec![plan(&d, "different")])
            .await,
        Err(Error::IdentityConflict)
    ));
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    g.close().await.unwrap();
    let g = Gateway::open(dir.path(), "h".into(), h.clone()).unwrap();
    let l = g.acquire_account(l.account).await.unwrap();
    assert!(g
        .command_reply_candidate(&l, scope())
        .await
        .unwrap()
        .is_none());
    assert_eq!(g.pending_replies(&l).await.unwrap().len(), 1);
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    g.close().await.unwrap();
}
#[tokio::test]
async fn conflicting_batch_rolls_back_consumption_and_all_outgoing_parts() {
    let dir = tempfile::tempdir().unwrap();
    let (g, _h, l) = setup_at(dir.path()).await;
    let d = complete(&g, "one").await;
    let plans = vec![plan(&d, "first"), plan(&d, "different")];
    assert!(matches!(
        g.enqueue_command_replies(&l, scope(), d.clone(), plans)
            .await,
        Err(Error::IdentityConflict)
    ));
    assert_eq!(
        g.command_reply_candidate(&l, scope()).await.unwrap(),
        Some(d.clone())
    );
    assert!(g.pending_replies(&l).await.unwrap().is_empty());
    let mut forged = d.clone();
    forged.result = Some(RpcResult::success(json!({"private":"forged"})));
    assert!(matches!(
        g.enqueue_command_replies(&l, scope(), forged, vec![plan(&d, "forged")])
            .await,
        Err(Error::IdentityConflict)
    ));
    assert!(g.pending_replies(&l).await.unwrap().is_empty());
    g.close().await.unwrap();
}
#[tokio::test]
async fn foreign_sender_revoked_scope_rebind_and_stale_account_never_consume_results() {
    let dir = tempfile::tempdir().unwrap();
    let (g, h, l) = setup_at(dir.path()).await;
    let d = complete(&g, "one").await;
    let mut bad = scope();
    bad.sender.user = "attacker".into();
    assert!(matches!(
        g.command_reply_candidate(&l, bad).await,
        Err(Error::Unauthorized)
    ));
    let fresh = g.acquire_account(l.account.clone()).await.unwrap();
    assert!(matches!(
        g.command_reply_candidate(&l, scope()).await,
        Err(Error::StaleLease)
    ));
    assert!(matches!(
        g.enqueue_command_replies(&l, scope(), d.clone(), vec![plan(&d, "old")])
            .await,
        Err(Error::StaleLease)
    ));
    let mut b = d.binding.clone();
    b.generation = 2;
    g.bind(b).await.unwrap();
    assert!(matches!(
        g.command_reply_candidate(&fresh, scope()).await,
        Err(Error::Unauthorized)
    ));
    let mut s = scope();
    s.generation = 2;
    assert!(g
        .command_reply_candidate(&fresh, s.clone())
        .await
        .unwrap()
        .is_none());
    assert!(matches!(
        g.enqueue_command_replies(&fresh, s.clone(), d.clone(), vec![plan(&d, "old")])
            .await,
        Err(Error::IdentityConflict)
    ));
    g.revoke("p").await.unwrap();
    assert!(matches!(
        g.command_reply_candidate(&fresh, s).await,
        Err(Error::Unauthorized)
    ));
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    g.close().await.unwrap();
}
#[tokio::test]
async fn manual_terminal_reconciliation_notifies_new_state_without_replaying_command() {
    let dir = tempfile::tempdir().unwrap();
    let (g, h, l) = setup_at(dir.path()).await;
    h.hold.store(true, Ordering::SeqCst);
    let queued = admit(&g, "cancel", Command::Cancel).await;
    let g2 = g.clone();
    let key = queued.key.clone();
    let task = tokio::spawn(async move { g2.dispatch(&key).await });
    h.entered.acquire().await.unwrap().forget();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    let d = g.dispatch(&queued.key).await.unwrap();
    assert_eq!(d.state, DeliveryState::Uncertain);
    g.enqueue_command_replies(&l, scope(), d.clone(), vec![plan(&d, "unknown")])
        .await
        .unwrap();
    assert!(g
        .command_reply_candidate(&l, scope())
        .await
        .unwrap()
        .is_none());
    g.resolve_uncertain(RecoveryReview {
        delivery_key: d.key.clone(),
        actor: "desktop".into(),
        evidence_sha256: "a".repeat(64),
        resolution: RecoveryResolution::ObservedAccepted,
    })
    .await
    .unwrap();
    let next = g
        .command_reply_candidate(&l, scope())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(next.state, DeliveryState::Completed);
    g.enqueue_command_replies(&l, scope(), next.clone(), vec![plan(&next, "reconciled")])
        .await
        .unwrap();
    assert!(g
        .command_reply_candidate(&l, scope())
        .await
        .unwrap()
        .is_none());
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    assert_eq!(g.pending_replies(&l).await.unwrap().len(), 1); // route FIFO: second is behind first pending
    g.close().await.unwrap();
}
#[tokio::test]
async fn command_receipt_crash_child() {
    let Some(root) = std::env::var_os("XHARNESS_COMMAND_REPLY_CRASH_FIXTURE") else {
        return;
    };
    let (g, _h, l) = setup_at(std::path::Path::new(&root)).await;
    let d = complete(&g, "one").await;
    g.enqueue_command_replies(&l, scope(), d.clone(), vec![plan(&d, "history")])
        .await
        .unwrap();
    std::process::exit(77);
}
#[tokio::test]
async fn abrupt_exit_after_commit_preserves_result_consumption_and_unsent_reply() {
    let dir = tempfile::tempdir().unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "command_receipt_crash_child", "--nocapture"])
        .env("XHARNESS_COMMAND_REPLY_CRASH_FIXTURE", dir.path())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(77));
    let h = host();
    let g = Gateway::open(dir.path(), "h".into(), h.clone()).unwrap();
    let l = g
        .acquire_account(Account {
            channel: Channel::Telegram,
            id: "bot".into(),
        })
        .await
        .unwrap();
    assert!(g
        .command_reply_candidate(&l, scope())
        .await
        .unwrap()
        .is_none());
    let records = g.pending_replies(&l).await.unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].state, ReplyState::Pending);
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    g.close().await.unwrap();
}

#[tokio::test]
async fn native_u64_scope_versions_are_compared_as_exact_json_numbers_not_lossy_sql_integers() {
    let dir = tempfile::tempdir().unwrap();
    let (g, h, _) = setup_at(dir.path()).await;
    g.close().await.unwrap();
    // Simulate a journal that reached the end of its valid monotonic u64
    // counters. Administrative APIs correctly forbid jumping directly there.
    let connection = rusqlite::Connection::open(dir.path().join("remote.sqlite")).unwrap();
    let p = Principal {
        id: "p".into(),
        host: "h".into(),
        sender: sender(),
        workspaces: ["w".into()].into(),
        sessions: ["s".into()].into(),
        revision: u64::MAX,
        revoked: false,
    };
    let b = Binding {
        id: "b".into(),
        principal: "p".into(),
        conversation: "42".into(),
        workspace: "w".into(),
        session: "s".into(),
        generation: u64::MAX,
    };
    for (kind, body) in [
        ("principal", serde_json::to_string(&p).unwrap()),
        ("binding", serde_json::to_string(&b).unwrap()),
    ] {
        connection
            .execute(
                "UPDATE entities SET body=?1 WHERE kind=?2",
                rusqlite::params![body, kind],
            )
            .unwrap();
    }
    drop(connection);
    let g = Gateway::open(dir.path(), "h".into(), h).unwrap();
    let l = g
        .acquire_account(Account {
            channel: Channel::Telegram,
            id: "bot".into(),
        })
        .await
        .unwrap();
    let mut s = scope();
    s.generation = u64::MAX;
    let d = g
        .accept(
            "p",
            sender(),
            "42".into(),
            Inbound {
                request_id: "large-scope".into(),
                binding: "b".into(),
                generation: u64::MAX,
                command: Command::History {
                    before_seq: None,
                    max_messages: 25,
                },
            },
        )
        .await
        .unwrap();
    let d = g.dispatch(&d.key).await.unwrap();
    assert_eq!(
        g.command_reply_candidate(&l, s.clone()).await.unwrap(),
        Some(d.clone())
    );
    g.enqueue_command_replies(&l, s.clone(), d.clone(), vec![plan(&d, "exact")])
        .await
        .unwrap();
    assert!(g.command_reply_candidate(&l, s).await.unwrap().is_none());
    g.close().await.unwrap();
}

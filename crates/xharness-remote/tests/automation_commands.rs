//! Durable controller composition: fixture backend has no Agent/global RPC fallback.
mod support;
use async_trait::async_trait;
use serde_json::Value;
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
    ScopedAutomationMutation, ScopedAutomationRead,
};
use xharness_remote::*;
struct Host {
    reads: AtomicUsize,
    controls: AtomicUsize,
    receipts: AtomicUsize,
    scopes: AtomicUsize,
    originals: Mutex<BTreeMap<String, ScopedAutomationApplied>>,
    lost_ack: AtomicBool,
    absent: AtomicBool,
    forged: AtomicBool,
    inactive: AtomicBool,
    wait: AtomicBool,
    entered: Notify,
    release: Notify,
}
impl Host {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            reads: AtomicUsize::new(0),
            controls: AtomicUsize::new(0),
            receipts: AtomicUsize::new(0),
            scopes: AtomicUsize::new(0),
            originals: Mutex::new(BTreeMap::new()),
            lost_ack: AtomicBool::new(false),
            absent: AtomicBool::new(false),
            forged: AtomicBool::new(false),
            inactive: AtomicBool::new(false),
            wait: AtomicBool::new(false),
            entered: Notify::new(),
            release: Notify::new(),
        })
    }
    fn page(&self, q: ScopedAutomationRead) -> ScopedAutomationPage {
        let list = matches!(q.read, AutomationRead::List { .. });
        let id = match &q.read {
            AutomationRead::View { id } => id.clone(),
            _ => "saved-1".into(),
        };
        ScopedAutomationPage {
            workspace: q.workspace,
            session: q.session,
            read: q.read,
            entries: vec![AutomationEntry {
                id,
                prompt: "原生提醒 🧪".into(),
                prompt_is_preview: list,
                kind: AutomationKind::After,
                mode: AutomationMode::Reminder,
                target: AutomationTarget::CurrentChat,
                state: if self.inactive.load(Ordering::SeqCst) {
                    AutomationState::Deleted
                } else {
                    AutomationState::Scheduled
                },
                scheduled_at: "2026-10-10T00:00:00.000Z".into(),
                after_seconds: Some(3600),
                every_seconds: None,
            }],
            next: None,
            detail: (!list).then_some(AutomationDetail {
                runs: vec![],
                run_count: 0,
                admitted_run_count: 0,
            }),
        }
    }
}
#[async_trait]
impl ApiBackend for Host {
    async fn call(&self, _: RpcId, _: RpcMethod, _: Value, _: CancellationToken) -> RpcResult {
        panic!("no generic RPC/Agent")
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("no interaction response")
    }
    fn mux_events(&self) -> EventStream {
        panic!("no global events")
    }
    fn host_events(&self) -> EventStream {
        panic!("no global events")
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
        self.scopes.fetch_add(1, Ordering::SeqCst);
        Ok(w == "w" && s == "s")
    }
    async fn scoped_automation_read(
        &self,
        q: ScopedAutomationRead,
    ) -> Result<ScopedAutomationPage, RpcError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let mut p = self.page(q);
        if self.forged.load(Ordering::SeqCst) {
            p.session = "PRIVATE_FOREIGN".into();
        }
        Ok(p)
    }
    async fn scoped_automation_control(
        &self,
        q: ScopedAutomationMutation,
    ) -> Result<ScopedAutomationApplied, RpcError> {
        assert!(q.is_bounded());
        self.controls.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        if self.wait.load(Ordering::SeqCst) {
            self.release.notified().await;
        }
        let applied = ScopedAutomationApplied {
            workspace: q.workspace,
            session: q.session,
            request_key: q.request_key,
            state: q.control.expected_state(),
            control: q.control,
        };
        if !self.absent.load(Ordering::SeqCst) {
            self.originals
                .lock()
                .unwrap()
                .insert(applied.request_key.clone(), applied.clone());
        }
        if self.lost_ack.load(Ordering::SeqCst) {
            return Err(RpcError::internal("PRIVATE_NATIVE_ERROR"));
        }
        Ok(applied)
    }
    async fn scoped_automation_receipt(
        &self,
        q: ScopedAutomationMutation,
    ) -> Result<Option<ScopedAutomationApplied>, RpcError> {
        self.receipts.fetch_add(1, Ordering::SeqCst);
        Ok(self.originals.lock().unwrap().get(&q.request_key).cloned())
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
        &["w"],
        &["s"],
        ("w", "s"),
    )
    .await
}
async fn admit(g: &Gateway, s: &Subscription, id: &str, c: Command) -> Delivery {
    g.accept(
        "p",
        s.sender.clone(),
        s.conversation.clone(),
        Inbound {
            request_id: id.into(),
            binding: "b".into(),
            generation: 1,
            command: c,
        },
    )
    .await
    .unwrap()
}
fn pause() -> Command {
    Command::AutomationControl {
        control: AutomationControl::Pause {
            id: "saved-1".into(),
        },
    }
}
fn result(d: &Delivery) -> Value {
    let Some(NativeCommandResult::Success { value: Some(v) }) = &d.result else {
        panic!("typed result")
    };
    v.clone()
}
async fn lease(g: &Gateway) -> AccountLease {
    g.acquire_account(Account {
        channel: Channel::Telegram,
        id: "123".into(),
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn read_result_is_exact_cached_and_reopened_without_native_reread() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new();
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let s = setup(&g).await;
    let d = admit(
        &g,
        &s,
        "list",
        Command::AutomationRead {
            read: AutomationRead::List { after: None },
        },
    )
    .await;
    let done = g.dispatch(&d.key).await.unwrap();
    let p: ControllerAutomationRead = serde_json::from_value(result(&done)).unwrap();
    assert!(p.is_for_delivery(&done));
    assert_eq!(p.page.entries[0].prompt, "原生提醒 🧪");
    assert_eq!(g.dispatch(&d.key).await.unwrap(), done);
    assert_eq!(h.reads.load(Ordering::SeqCst), 1);
    assert_eq!(h.controls.load(Ordering::SeqCst), 0);
    g.close().await.unwrap();
    let h = Host::new();
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    assert_eq!(g.dispatch(&d.key).await.unwrap(), done);
    assert_eq!(h.reads.load(Ordering::SeqCst), 0);
    g.close().await.unwrap();
}
#[tokio::test]
async fn original_control_proof_and_consumed_outbox_commit_survive_reopen() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new();
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let s = setup(&g).await;
    let before = g.grant_page(None).await.unwrap();
    let d = admit(&g, &s, "pause", pause()).await;
    let done = g.dispatch(&d.key).await.unwrap();
    let p: ControllerAutomationControl = serde_json::from_value(result(&done)).unwrap();
    assert!(p.is_for_delivery(&done));
    assert_eq!(p.applied.state, AutomationControlState::Paused);
    assert_eq!(g.grant_page(None).await.unwrap(), before);
    let l = lease(&g).await;
    assert_eq!(
        g.command_reply_candidate(&l, s.clone()).await.unwrap(),
        Some(done.clone())
    );
    let plans = vec![ReplyPlan {
        id: "pause-result".into(),
        body: ReplyBody {
            text: "Original receipt".into(),
            buttons: vec![],
            attachment: None,
        },
        replace_of: None,
    }];
    let out = g
        .enqueue_command_replies(&l, s.clone(), done.clone(), plans.clone())
        .await
        .unwrap();
    assert_eq!(out.len(), 1);
    assert!(g
        .command_reply_candidate(&l, s.clone())
        .await
        .unwrap()
        .is_none());
    g.close().await.unwrap();
    let h = Host::new();
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    assert_eq!(g.dispatch(&d.key).await.unwrap(), done);
    assert_eq!(h.controls.load(Ordering::SeqCst), 0);
    assert_eq!(h.receipts.load(Ordering::SeqCst), 0);
    assert_eq!(
        g.enqueue_command_replies(&l, s.clone(), done, plans)
            .await
            .unwrap(),
        out
    );
    assert!(g.command_reply_candidate(&l, s).await.unwrap().is_none());
    g.close().await.unwrap();
}
#[tokio::test]
async fn lost_ack_recovers_only_original_receipt_without_current_state_or_second_control() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new();
    h.lost_ack.store(true, Ordering::SeqCst);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let s = setup(&g).await;
    let d = admit(&g, &s, "lost", pause()).await;
    let unknown = g.dispatch(&d.key).await.unwrap();
    assert_eq!(unknown.state, DeliveryState::Uncertain);
    assert!(unknown.result.is_none());
    assert_eq!(
        g.native_effect_recovery_candidates(None).await.unwrap(),
        vec![unknown]
    );
    // Current state is deleted; original pause receipt remains the only authority.
    h.inactive.store(true, Ordering::SeqCst);
    g.close().await.unwrap();
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let done = g.dispatch(&d.key).await.unwrap();
    assert_eq!(done.state, DeliveryState::Completed);
    assert_eq!(h.controls.load(Ordering::SeqCst), 1);
    assert_eq!(h.reads.load(Ordering::SeqCst), 1);
    assert!(!result(&done).to_string().contains("PRIVATE_NATIVE_ERROR"));
    g.close().await.unwrap();
}
#[tokio::test]
async fn absent_original_never_replays_and_manual_accepted_is_not_proof() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new();
    h.absent.store(true, Ordering::SeqCst);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let s = setup(&g).await;
    let d = admit(&g, &s, "absent", pause()).await;
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Uncertain
    );
    for _ in 0..3 {
        assert_eq!(
            g.dispatch(&d.key).await.unwrap().state,
            DeliveryState::Uncertain
        );
    }
    assert_eq!(h.controls.load(Ordering::SeqCst), 1);
    assert_eq!(h.reads.load(Ordering::SeqCst), 1);
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
    g.resolve_uncertain(RecoveryReview {
        resolution: RecoveryResolution::AbandonWithoutReplay,
        ..review
    })
    .await
    .unwrap();
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Abandoned
    );
    assert!(g
        .native_effect_recovery_candidates(None)
        .await
        .unwrap()
        .is_empty());
    g.close().await.unwrap();
}
#[tokio::test]
async fn inactive_or_forged_preflight_is_closed_before_native_effect() {
    for forged in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let h = Host::new();
        h.inactive.store(!forged, Ordering::SeqCst);
        h.forged.store(forged, Ordering::SeqCst);
        let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
        let s = setup(&g).await;
        let d = admit(&g, &s, "preflight", pause()).await;
        let done = g.dispatch(&d.key).await.unwrap();
        assert_eq!(done.state, DeliveryState::Completed);
        assert!(matches!(
            done.result,
            Some(NativeCommandResult::Failure { .. })
        ));
        assert!(!serde_json::to_string(&done)
            .unwrap()
            .contains("PRIVATE_FOREIGN"));
        assert_eq!(h.controls.load(Ordering::SeqCst), 0);
        g.close().await.unwrap();
    }
}
#[tokio::test]
async fn revoked_uncertain_authority_has_no_native_scope_or_receipt_lookup() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new();
    h.lost_ack.store(true, Ordering::SeqCst);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let s = setup(&g).await;
    let d = admit(&g, &s, "revoke", pause()).await;
    g.dispatch(&d.key).await.unwrap();
    g.revoke("p").await.unwrap();
    let calls = (
        h.scopes.load(Ordering::SeqCst),
        h.receipts.load(Ordering::SeqCst),
    );
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Uncertain
    );
    assert_eq!(
        calls,
        (
            h.scopes.load(Ordering::SeqCst),
            h.receipts.load(Ordering::SeqCst)
        )
    );
    g.close().await.unwrap();
}
#[tokio::test]
async fn missing_private_proof_cannot_emit_forged_completed_success() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new();
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let s = setup(&g).await;
    let d = admit(&g, &s, "proof", pause()).await;
    let done = g.dispatch(&d.key).await.unwrap();
    let l = lease(&g).await;
    g.close().await.unwrap();
    let db = rusqlite::Connection::open(root.path().join("remote.sqlite")).unwrap();
    assert_eq!(
        db.execute(
            "DELETE FROM entities WHERE kind='automation-proof' AND id=?1",
            [&d.key]
        )
        .unwrap(),
        1
    );
    drop(db);
    let h = Host::new();
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    assert_eq!(g.dispatch(&d.key).await.unwrap(), done);
    assert!(matches!(
        g.command_reply_candidate(&l, s).await,
        Err(Error::Unauthorized)
    ));
    assert_eq!(h.controls.load(Ordering::SeqCst), 0);
    g.close().await.unwrap();
}
#[tokio::test]
async fn native_deadline_retains_owned_writer_fence_and_close_drains() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new();
    h.wait.store(true, Ordering::SeqCst);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let s = setup(&g).await;
    let d = admit(&g, &s, "deadline", pause()).await;
    let run = tokio::spawn({
        let g = g.clone();
        let key = d.key.clone();
        async move { g.dispatch(&key).await }
    });
    h.entered.notified().await;
    let done = run.await.unwrap().unwrap();
    assert_eq!(done.state, DeliveryState::Uncertain);
    let closing = tokio::spawn({
        let g = g.clone();
        async move { g.close().await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!closing.is_finished());
    h.release.notify_one();
    tokio::time::timeout(Duration::from_secs(5), closing)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Completed
    );
    assert_eq!(h.controls.load(Ordering::SeqCst), 1);
    g.close().await.unwrap();
}
#[tokio::test]
async fn caller_abort_does_not_cancel_admitted_writer_or_sql_proof() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new();
    h.wait.store(true, Ordering::SeqCst);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let s = setup(&g).await;
    let d = admit(&g, &s, "abort", pause()).await;
    let run = tokio::spawn({
        let g = g.clone();
        let key = d.key.clone();
        async move { g.dispatch(&key).await }
    });
    h.entered.notified().await;
    let db = rusqlite::Connection::open(root.path().join("remote.sqlite")).unwrap();
    let replay: bool = db.query_row("SELECT json_extract(body,'$.may_dispatch') FROM entities WHERE kind='automation-attempt' AND id=?1", [&d.key], |r|r.get(0)).unwrap();
    assert!(
        !replay,
        "replay must be sealed before entering the native writer"
    );
    drop(db);
    run.abort();
    h.release.notify_one();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if g.inspect(&d.key).await.unwrap().unwrap().state == DeliveryState::Completed {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(h.controls.load(Ordering::SeqCst), 1);
    assert!(g
        .command_reply_candidate(&lease(&g).await, s)
        .await
        .unwrap()
        .is_some());
    g.close().await.unwrap();
}
#[tokio::test]
async fn dispatching_cut_with_sealed_attempt_and_no_receipt_is_never_reissued() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new();
    h.absent.store(true, Ordering::SeqCst);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let s = setup(&g).await;
    let d = admit(&g, &s, "cut", pause()).await;
    let unknown = g.dispatch(&d.key).await.unwrap();
    g.close().await.unwrap();
    // Durable fixture represents a process cut before final uncertainty commit.
    let mut cut = unknown;
    cut.state = DeliveryState::Dispatching;
    cut.reason = None;
    let db = rusqlite::Connection::open(root.path().join("remote.sqlite")).unwrap();
    db.execute(
        "UPDATE inbox SET state='dispatching',body=?1 WHERE key=?2",
        rusqlite::params![serde_json::to_string(&cut).unwrap(), d.key],
    )
    .unwrap();
    drop(db);
    let h = Host::new();
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Uncertain
    );
    assert_eq!(h.controls.load(Ordering::SeqCst), 0);
    assert_eq!(h.reads.load(Ordering::SeqCst), 0);
    assert_eq!(h.receipts.load(Ordering::SeqCst), 1);
    g.close().await.unwrap();
}

#[tokio::test]
async fn forged_original_receipt_is_not_current_state_proof_and_never_reissues() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new();
    h.lost_ack.store(true, Ordering::SeqCst);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let s = setup(&g).await;
    let d = admit(&g, &s, "forged", pause()).await;
    g.dispatch(&d.key).await.unwrap();
    h.originals
        .lock()
        .unwrap()
        .values_mut()
        .next()
        .unwrap()
        .state = AutomationControlState::Enabled;
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Uncertain
    );
    assert_eq!(h.controls.load(Ordering::SeqCst), 1);
    assert_eq!(h.reads.load(Ordering::SeqCst), 1);
    g.close().await.unwrap();
}
#[tokio::test]
async fn uncertainty_blocks_later_same_session_until_original_receipt_recovery() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new();
    h.lost_ack.store(true, Ordering::SeqCst);
    h.absent.store(true, Ordering::SeqCst);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let s = setup(&g).await;
    let d = admit(&g, &s, "first", pause()).await;
    g.dispatch(&d.key).await.unwrap();
    let next = admit(
        &g,
        &s,
        "later",
        Command::AutomationRead {
            read: AutomationRead::List { after: None },
        },
    )
    .await;
    assert!(matches!(
        g.dispatch(&next.key).await,
        Err(Error::SessionBlocked)
    ));
    assert_eq!(h.reads.load(Ordering::SeqCst), 1);
    assert_eq!(
        g.native_effect_recovery_candidates(Some(d.sequence))
            .await
            .unwrap()
            .len(),
        0
    );
    g.resolve_uncertain(RecoveryReview {
        delivery_key: d.key,
        resolution: RecoveryResolution::AbandonWithoutReplay,
        actor: "desktop-owner".into(),
        evidence_sha256: "e".repeat(64),
    })
    .await
    .unwrap();
    assert_eq!(
        g.dispatch(&next.key).await.unwrap().state,
        DeliveryState::Completed
    );
    assert_eq!(h.controls.load(Ordering::SeqCst), 1);
    g.close().await.unwrap();
}
#[tokio::test]
async fn supervisor_recovers_original_without_replaying_control_or_view() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new();
    h.lost_ack.store(true, Ordering::SeqCst);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let s = setup(&g).await;
    let d = admit(&g, &s, "supervisor", pause()).await;
    g.dispatch(&d.key).await.unwrap();
    let stop = CancellationToken::new();
    let run = tokio::spawn(g.clone().run(stop.clone()));
    tokio::time::timeout(Duration::from_secs(5), async {
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
    assert_eq!(h.controls.load(Ordering::SeqCst), 1);
    assert_eq!(h.reads.load(Ordering::SeqCst), 1);
    g.close().await.unwrap();
}
#[tokio::test]
async fn revoke_waits_for_actual_deadline_writer_then_fences_original_receipt_recovery() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new();
    h.wait.store(true, Ordering::SeqCst);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let s = setup(&g).await;
    let d = admit(&g, &s, "revoke-writer", pause()).await;
    let run = tokio::spawn({
        let g = g.clone();
        let key = d.key.clone();
        async move { g.dispatch(&key).await }
    });
    h.entered.notified().await;
    let revoke = tokio::spawn({
        let g = g.clone();
        async move { g.revoke("p").await }
    });
    assert_eq!(run.await.unwrap().unwrap().state, DeliveryState::Uncertain);
    assert!(!revoke.is_finished());
    h.release.notify_one();
    tokio::time::timeout(Duration::from_secs(5), revoke)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let receipts = h.receipts.load(Ordering::SeqCst);
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Uncertain
    );
    assert_eq!(h.receipts.load(Ordering::SeqCst), receipts);
    assert!(matches!(
        g.command_reply_candidate(&lease(&g).await, s).await,
        Err(Error::Unauthorized)
    ));
    g.close().await.unwrap();
}
#[tokio::test]
async fn exhausted_private_attempt_history_rejects_before_effect_instead_of_retrying_forever() {
    let root = tempfile::tempdir().unwrap();
    let h = Host::new();
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let s = setup(&g).await;
    let d = admit(&g, &s, "capacity", pause()).await;
    g.close().await.unwrap();
    let db = rusqlite::Connection::open(root.path().join("remote.sqlite")).unwrap();
    db.execute("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100000) INSERT INTO entities(kind,id,body) SELECT 'automation-attempt','fixture-'||x,'{}' FROM n",[]).unwrap();
    drop(db);
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let rejected = g.dispatch(&d.key).await.unwrap();
    assert_eq!(rejected.state, DeliveryState::Rejected);
    assert_eq!(
        rejected.reason.as_deref(),
        Some("automation-attempt-capacity")
    );
    assert_eq!(g.dispatch(&d.key).await.unwrap(), rejected);
    assert_eq!(h.controls.load(Ordering::SeqCst), 0);
    assert_eq!(h.receipts.load(Ordering::SeqCst), 0);
    g.close().await.unwrap();
}

mod support;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tokio_util::sync::CancellationToken;
use xharness_api::{
    ApiBackend, ClientResponse, EventStream, MuxFrame, RpcError, RpcId, RpcMethod, RpcReceipt,
    RpcResult,
};
use xharness_remote::*;
struct Host {
    forged: AtomicBool,
    calls: AtomicUsize,
    events: Mutex<Vec<Value>>,
}
#[async_trait]
impl ApiBackend for Host {
    async fn call(&self, _: RpcId, _: RpcMethod, _: Value, _: CancellationToken) -> RpcResult {
        panic!("projection cannot replay Agent");
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("no response forwarding");
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
    async fn session_event_page(
        &self,
        _: &str,
        _: &str,
        after: Option<u64>,
    ) -> Result<ScopedEventPage, RpcError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let events = self.events.lock().unwrap();
        let head = events.len() as u64;
        let start = after.unwrap_or(head);
        if start > head {
            return Err(RpcError::internal("cursor regression"));
        }
        let frames = events
            .iter()
            .enumerate()
            .skip(start as usize)
            .take(128)
            .map(|(i, v)| {
                let mut v = v.clone();
                v["seq"] = json!(if self.forged.load(Ordering::SeqCst) {
                    999
                } else {
                    i
                });
                MuxFrame::SessionEvent {
                    session_id: "s".into(),
                    event: v,
                    view: None,
                }
                .into_server_request(RpcId::new(format!("e-{i}")))
            })
            .collect::<Vec<_>>();
        Ok(ScopedEventPage {
            start_seq: start,
            next_seq: start + frames.len() as u64,
            head_seq: head,
            events: frames,
        })
    }
}
async fn setup() -> (
    tempfile::TempDir,
    Arc<Gateway>,
    Arc<Host>,
    AccountLease,
    Subscription,
) {
    let root = tempfile::tempdir().unwrap();
    let (g, host, lease, scope) = setup_at(root.path()).await;
    (root, g, host, lease, scope)
}
async fn setup_at(root: &std::path::Path) -> (Arc<Gateway>, Arc<Host>, AccountLease, Subscription) {
    let host = Arc::new(Host {
        forged: AtomicBool::new(false),
        calls: AtomicUsize::new(0),
        events: Mutex::new(vec![json!({"type":"assistant/message","data":{}})]),
    });
    let g = Gateway::open(root, "h".into(), host.clone()).unwrap();
    let sender = Sender {
        channel: Channel::Telegram,
        account: "bot".into(),
        user: "42".into(),
    };
    let scope = support::install_scope(&g, sender, &["w"], &["s"], ("w", "s")).await;
    let lease = g
        .acquire_account(Account {
            channel: Channel::Telegram,
            id: "bot".into(),
        })
        .await
        .unwrap();

    (g, host, lease, scope)
}
fn update(next_seq: u64, id: &str, text: &str) -> ProjectionUpdate {
    ProjectionUpdate {
        next_seq,
        state: json!({"text":text}),
        retain: BTreeSet::from(["part".into()]),
        replies: vec![ProjectedReply {
            slot: Some("part".into()),
            plan: ReplyPlan {
                id: id.into(),
                body: ReplyBody {
                    attachment: None,
                    text: text.into(),
                    buttons: vec![],
                },
                replace_of: None,
            },
        }],
    }
}
#[tokio::test]
async fn projection_cursor_state_and_outbox_commit_atomically_and_reopen_without_reenqueue() {
    let (root, g, h, l, s) = setup().await;
    let cp = g.projection_checkpoint(&l, s.clone()).await.unwrap();
    assert_eq!(cp.next_seq, 0); // includes a first prompt racing observer startup
    let page = g.read_event_page(&l, s.clone(), Some(0)).await.unwrap();
    assert_eq!(page.events.len(), 1);
    g.advance_projection(&l, s.clone(), cp.clone(), update(1, "one", "first"))
        .await
        .unwrap();
    let next = g.projection_checkpoint(&l, s.clone()).await.unwrap();
    assert_eq!(next.next_seq, 1);
    assert_eq!(next.state, json!({"text":"first"}));
    assert_eq!(next.pending.len(), 1);
    assert_eq!(next.links["part"], next.pending[0]);
    assert!(matches!(
        g.advance_projection(&l, s.clone(), cp, update(1, "second", "different"))
            .await,
        Err(Error::IdentityConflict)
    ));
    assert_eq!(g.projection_checkpoint(&l, s.clone()).await.unwrap(), next);
    assert_eq!(g.pending_replies(&l).await.unwrap().len(), 1);
    g.close().await.unwrap();
    let g = Gateway::open(root.path(), "h".into(), h).unwrap();
    let l = g.acquire_account(l.account.clone()).await.unwrap();
    assert_eq!(g.projection_checkpoint(&l, s.clone()).await.unwrap(), next);
    assert!(g
        .read_event_page(&l, s, Some(next.next_seq))
        .await
        .unwrap()
        .events
        .is_empty());
    assert_eq!(g.pending_replies(&l).await.unwrap().len(), 1);
}
#[tokio::test]
async fn projection_conflicting_batch_rolls_back_all_cursor_state_and_new_output() {
    let (_root, g, _h, l, s) = setup().await;
    let cp = g.projection_checkpoint(&l, s.clone()).await.unwrap();
    let mut u = update(1, "same", "one");
    u.replies.push(ProjectedReply {
        slot: None,
        plan: ReplyPlan {
            id: "same".into(),
            body: ReplyBody {
                attachment: None,
                text: "different".into(),
                buttons: vec![],
            },
            replace_of: None,
        },
    });
    assert!(matches!(
        g.advance_projection(&l, s.clone(), cp.clone(), u).await,
        Err(Error::IdentityConflict)
    ));
    assert_eq!(g.projection_checkpoint(&l, s).await.unwrap(), cp);
    assert!(g.pending_replies(&l).await.unwrap().is_empty());
}
#[tokio::test]
async fn projection_native_pages_reject_gaps_foreign_sender_and_stale_leases() {
    let (_root, g, h, l, s) = setup().await;
    g.projection_checkpoint(&l, s.clone()).await.unwrap();
    h.forged.store(true, Ordering::SeqCst);
    assert!(matches!(
        g.read_event_page(&l, s.clone(), Some(0)).await,
        Err(Error::Invalid(_))
    ));
    let mut bad = s.clone();
    bad.sender.user = "attacker".into();
    let calls = h.calls.load(Ordering::SeqCst);
    assert!(matches!(
        g.read_event_page(&l, bad, Some(0)).await,
        Err(Error::Unauthorized)
    ));
    assert_eq!(h.calls.load(Ordering::SeqCst), calls);
    let fresh = g.acquire_account(l.account.clone()).await.unwrap();
    assert!(matches!(
        g.read_event_page(&l, s.clone(), Some(0)).await,
        Err(Error::StaleLease)
    ));
    let cp = g.projection_checkpoint(&fresh, s.clone()).await.unwrap();
    g.revoke("p").await.unwrap();
    assert!(matches!(
        g.advance_projection(&fresh, s, cp, update(1, "one", "first"))
            .await,
        Err(Error::Unauthorized)
    ));
}
#[tokio::test]
async fn projection_state_and_cursor_bounds_fail_before_any_output_commit() {
    let (_root, g, _h, l, s) = setup().await;
    let cp = g.projection_checkpoint(&l, s.clone()).await.unwrap();
    let mut u = update(1, "one", "first");
    u.state = json!("x".repeat(1024 * 1024));
    assert!(matches!(
        g.advance_projection(&l, s.clone(), cp.clone(), u).await,
        Err(Error::Capacity)
    ));
    assert_eq!(g.projection_checkpoint(&l, s).await.unwrap(), cp);
    assert!(g.pending_replies(&l).await.unwrap().is_empty());
}

#[tokio::test]
async fn projection_commit_crash_child() {
    let Some(root) = std::env::var_os("XHARNESS_PROJECTION_CRASH_FIXTURE") else {
        return;
    };
    let (g, _h, l, s) = setup_at(std::path::Path::new(&root)).await;
    let cp = g.projection_checkpoint(&l, s.clone()).await.unwrap();
    g.advance_projection(&l, s, cp, update(1, "one", "first"))
        .await
        .unwrap();
    std::process::exit(76);
}
#[tokio::test]
async fn abrupt_death_after_projection_commit_preserves_cursor_state_and_pending_batch_together() {
    let root = tempfile::tempdir().unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "projection_commit_crash_child", "--nocapture"])
        .env("XHARNESS_PROJECTION_CRASH_FIXTURE", root.path())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(76));
    let host = Arc::new(Host {
        forged: AtomicBool::new(false),
        calls: AtomicUsize::new(0),
        events: Mutex::new(vec![json!({"type":"assistant/message","data":{}})]),
    });
    let g = Gateway::open(root.path(), "h".into(), host).unwrap();
    let sender = Sender {
        channel: Channel::Telegram,
        account: "bot".into(),
        user: "42".into(),
    };
    let lease = g
        .acquire_account(Account {
            channel: Channel::Telegram,
            id: "bot".into(),
        })
        .await
        .unwrap();
    let scope = Subscription {
        principal: "p".into(),
        sender,
        conversation: "42".into(),
        binding: "b".into(),
        generation: 1,
    };
    let cp = g
        .projection_checkpoint(&lease, scope.clone())
        .await
        .unwrap();
    assert_eq!(cp.revision, 2);
    assert_eq!(cp.next_seq, 1);
    assert_eq!(cp.state, json!({"text":"first"}));
    assert_eq!(cp.pending.len(), 1);
    assert_eq!(cp.links["part"], cp.pending[0]);
    let records = g.pending_replies(&lease).await.unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].key, cp.pending[0]);
    assert_eq!(records[0].state, ReplyState::Pending);
    assert!(g
        .read_event_page(&lease, scope, Some(cp.next_seq))
        .await
        .unwrap()
        .events
        .is_empty());
    g.close().await.unwrap();
}

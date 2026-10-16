//! Scoped outgoing bytes and durable uncertainty, no model/platform account.
mod support;
use async_trait::async_trait;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use tokio_util::sync::CancellationToken;
use xharness_api::{ApiBackend, RpcError, RpcId, RpcMethod, RpcResult};
use xharness_remote::*;
struct Host {
    owned: AtomicBool,
    corrupt: AtomicBool,
    reads: AtomicUsize,
}
#[async_trait]
impl ApiBackend for Host {
    async fn respond(&self, _: xharness_api::ClientResponse) -> xharness_api::RpcReceipt {
        panic!("no native decision from media");
    }
    fn mux_events(&self) -> xharness_api::EventStream {
        panic!("no global mux");
    }
    fn host_events(&self) -> xharness_api::EventStream {
        panic!("no global events");
    }

    async fn call(&self, _: RpcId, _: RpcMethod, _: Value, _: CancellationToken) -> RpcResult {
        panic!("media must never run native command");
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
        Ok(w == "w" && s == "s" && self.owned.load(Ordering::SeqCst))
    }
    async fn session_event_attachment(
        &self,
        w: &str,
        s: &str,
        seq: u64,
        id: &str,
    ) -> Result<ScopedAttachment, RpcError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        assert_eq!((w, s, seq, id), ("w", "s", 7, digest().as_str()));
        Ok(ScopedAttachment {
            id: id.into(),
            kind: ScopedAttachmentKind::File,
            media_type: "text/plain".into(),
            width: 0,
            height: 0,
            data: if self.corrupt.load(Ordering::SeqCst) {
                b"WRONG_PRIVATE_BYTES".to_vec()
            } else {
                bytes()
            },
        })
    }
}
fn bytes() -> Vec<u8> {
    b"PRIVATE_ATTACHMENT_BYTES".to_vec()
}
fn digest() -> String {
    let mut hash = Sha256::new();
    hash.update(b"xharness-file-v1\0");
    hash.update(b"text/plain");
    hash.update([0]);
    hash.update(bytes());
    hex::encode(hash.finalize())
}
fn account() -> Account {
    Account {
        channel: Channel::Telegram,
        id: "123456".into(),
    }
}
fn sender() -> Sender {
    Sender {
        channel: Channel::Telegram,
        account: "123456".into(),
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
fn plan() -> ReplyPlan {
    ReplyPlan {
        id: "media-fixture".into(),
        body: ReplyBody {
            text: "Attachment".into(),
            buttons: vec![],
            attachment: Some(ReplyAttachment {
                event_seq: 7,
                id: digest(),
            }),
        },
        replace_of: None,
    }
}
async fn configured(path: &std::path::Path, host: Arc<Host>) -> Arc<Gateway> {
    let g = Gateway::open(path, "h".into(), host).unwrap();
    support::install_scope(&g, sender(), &["w"], &["s"], ("w", "s")).await;
    g
}
struct Transport {
    calls: AtomicUsize,
    request: Mutex<Option<SendRequest>>,
    outcome: SendOutcome,
}
#[async_trait]
impl ReplyTransport for Transport {
    fn account(&self) -> &Account {
        static A: std::sync::OnceLock<Account> = std::sync::OnceLock::new();
        A.get_or_init(account)
    }
    async fn send(&self, r: SendRequest) -> SendOutcome {
        self.calls.fetch_add(1, Ordering::SeqCst);
        *self.request.lock().unwrap() = Some(r);
        self.outcome.clone()
    }
}
fn host() -> Arc<Host> {
    Arc::new(Host {
        owned: AtomicBool::new(true),
        corrupt: AtomicBool::new(false),
        reads: AtomicUsize::new(0),
    })
}
fn transport(outcome: SendOutcome) -> Arc<Transport> {
    Arc::new(Transport {
        calls: AtomicUsize::new(0),
        request: Mutex::new(None),
        outcome,
    })
}
#[tokio::test]
async fn outgoing_media_resolves_event_owned_hash_and_unknown_send_survives_reopen_without_replay()
{
    let root = tempfile::tempdir().unwrap();
    let h = host();
    let g = configured(root.path(), h.clone()).await;
    let l = g.acquire_account(account()).await.unwrap();
    let r = g
        .enqueue_replies(scope(), vec![plan()])
        .await
        .unwrap()
        .remove(0);
    assert!(!serde_json::to_string(&r)
        .unwrap()
        .contains("PRIVATE_ATTACHMENT_BYTES"));
    let t = transport(SendOutcome::Uncertain);
    let sent = g
        .deliver_reply(l.clone(), &r.key, t.clone(), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(sent.state, ReplyState::Uncertain);
    assert_eq!(
        t.request
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .attachment
            .as_ref()
            .unwrap()
            .data,
        bytes()
    );
    assert!(!format!("{:?}", t.request.lock().unwrap()).contains("PRIVATE_ATTACHMENT_BYTES"));
    g.close().await.unwrap();
    let g = Gateway::open(root.path(), "h".into(), h.clone()).unwrap();
    let l = g.acquire_account(account()).await.unwrap();
    assert_eq!(
        g.deliver_reply(l, &r.key, t.clone(), CancellationToken::new())
            .await
            .unwrap()
            .state,
        ReplyState::Uncertain
    );
    assert_eq!(t.calls.load(Ordering::SeqCst), 1);
    assert_eq!(h.reads.load(Ordering::SeqCst), 1);
    g.close().await.unwrap();
}
#[tokio::test]
async fn malformed_media_and_revoked_scope_have_no_effect_and_legacy_bodies_keep_wire_shape() {
    let root = tempfile::tempdir().unwrap();
    let h = host();
    let g = configured(root.path(), h.clone()).await;
    let l = g.acquire_account(account()).await.unwrap();
    let t = transport(SendOutcome::Delivered(ProviderReceipt {
        message_id: "9".into(),
    }));
    let body: ReplyBody = serde_json::from_str(r#"{"text":"legacy","buttons":[]}"#).unwrap();
    assert!(body.attachment.is_none());
    assert_eq!(
        serde_json::to_string(&body).unwrap(),
        r#"{"text":"legacy","buttons":[]}"#
    );
    let mut bad = plan();
    bad.body.text = "x".repeat(1025);
    assert!(g.enqueue_replies(scope(), vec![bad]).await.is_err());
    let mut bad = plan();
    bad.body.buttons = vec![vec![ReplyButton {
        label: "x".into(),
        ticket: "x".into(),
    }]];
    assert!(g.enqueue_replies(scope(), vec![bad]).await.is_err());
    let mut bad = plan();
    bad.body.attachment.as_mut().unwrap().id = "../PRIVATE_PATH".into();
    assert!(g.enqueue_replies(scope(), vec![bad]).await.is_err());
    let mut bad = plan();
    bad.replace_of = Some(format!("remote-v1-{}", "a".repeat(64)));
    assert!(g.enqueue_replies(scope(), vec![bad]).await.is_err());
    let r = g
        .enqueue_replies(scope(), vec![plan()])
        .await
        .unwrap()
        .remove(0);
    h.corrupt.store(true, Ordering::SeqCst);
    assert!(g
        .deliver_reply(l.clone(), &r.key, t.clone(), CancellationToken::new())
        .await
        .is_err());
    assert_eq!(
        g.inspect_reply(&r.key).await.unwrap().unwrap().state,
        ReplyState::Pending
    );
    assert_eq!(t.calls.load(Ordering::SeqCst), 0);
    h.corrupt.store(false, Ordering::SeqCst);
    g.revoke("p").await.unwrap();
    assert_eq!(
        g.deliver_reply(l, &r.key, t.clone(), CancellationToken::new())
            .await
            .unwrap()
            .state,
        ReplyState::Rejected
    );
    assert_eq!(t.calls.load(Ordering::SeqCst), 0);
    g.close().await.unwrap();
}

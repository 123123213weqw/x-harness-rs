//! Zero-fee native composition fixtures, not a live keychain/platform trial.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::Semaphore;
const SECRET: &str = "123456:fixture_token_SECRET123";
struct Keys {
    values: Mutex<BTreeMap<String, String>>,
    reads: AtomicUsize,
    writes: AtomicUsize,
    deletes: AtomicUsize,
    locked: AtomicBool,
    delete_failed: AtomicBool,
    hang_after_set: AtomicBool,
    staged: Semaphore,
}
impl Keys {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            values: Mutex::new(BTreeMap::new()),
            reads: AtomicUsize::new(0),
            writes: AtomicUsize::new(0),
            deletes: AtomicUsize::new(0),
            locked: AtomicBool::new(false),
            delete_failed: AtomicBool::new(false),
            hang_after_set: AtomicBool::new(false),
            staged: Semaphore::new(0),
        })
    }
}
#[async_trait]
impl CredentialStore for Keys {
    async fn get(&self, r: &str) -> Result<Option<String>, String> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if self.locked.load(Ordering::SeqCst) {
            return Err(format!("injected secret-bearing keychain error {SECRET}"));
        }
        Ok(self.values.lock().await.get(r).cloned())
    }
    async fn set(&self, r: &str, v: &str) -> Result<(), String> {
        if self.locked.load(Ordering::SeqCst) {
            return Err(SECRET.into());
        }
        self.writes.fetch_add(1, Ordering::SeqCst);
        self.values.lock().await.insert(r.into(), v.into());
        if self.hang_after_set.load(Ordering::SeqCst) {
            self.staged.add_permits(1);
            std::future::pending::<()>().await;
        }
        Ok(())
    }
    async fn delete(&self, r: &str) -> Result<(), String> {
        self.deletes.fetch_add(1, Ordering::SeqCst);
        if self.delete_failed.load(Ordering::SeqCst) {
            return Err(SECRET.into());
        }
        self.values.lock().await.remove(r);
        Ok(())
    }
}
struct Connector {
    calls: AtomicUsize,
    running: Arc<AtomicUsize>,
    stopped: Arc<AtomicUsize>,
    fail: AtomicBool,
    panic_worker: AtomicBool,
    connecting: Semaphore,
    release: Semaphore,
}
impl Connector {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            calls: AtomicUsize::new(0),
            running: Arc::new(AtomicUsize::new(0)),
            stopped: Arc::new(AtomicUsize::new(0)),
            fail: AtomicBool::new(false),
            panic_worker: AtomicBool::new(false),
            connecting: Semaphore::new(0),
            release: Semaphore::new(100),
        })
    }
}
struct Connection {
    running: Arc<AtomicUsize>,
    stopped: Arc<AtomicUsize>,
    panic: bool,
}
#[async_trait]
impl AccountConnection for Connection {
    async fn run(self: Box<Self>, stop: CancellationToken) -> Result<(), ChannelFailure> {
        self.running.fetch_add(1, Ordering::SeqCst);
        if self.panic {
            panic!("disposable account worker failure");
        }
        stop.cancelled().await;
        // Deliberate drain barrier: returning before this observable completion
        // would permit the old connection to outlive journal close/rotation.
        tokio::time::sleep(Duration::from_millis(30)).await;
        self.running.fetch_sub(1, Ordering::SeqCst);
        self.stopped.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
#[async_trait]
impl AccountConnector for Connector {
    async fn connect(
        &self,
        s: AccountSettings,
        g: Arc<Gateway>,
        secret: String,
    ) -> Result<Box<dyn AccountConnection>, ChannelFailure> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(secret, SECRET);
        self.connecting.add_permits(1);
        self.release.acquire().await.unwrap().forget();
        if self.fail.load(Ordering::SeqCst) {
            return Err(ChannelFailure::ProviderConflict);
        }
        g.acquire_configured_account(s.account, s.revision)
            .await
            .map_err(|_| ChannelFailure::Journal)?;
        Ok(Box::new(Connection {
            running: self.running.clone(),
            stopped: self.stopped.clone(),
            panic: self.panic_worker.load(Ordering::SeqCst),
        }))
    }
}
struct Temp(std::path::PathBuf);
impl Temp {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "xh-channel-accounts-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn setup() -> (
    Temp,
    Arc<Gateway>,
    Arc<Keys>,
    Arc<Connector>,
    Arc<AccountManager>,
) {
    let d = Temp::new();
    let g = Gateway::open(
        &d.0,
        "host".into(),
        Arc::new(xharness_api::UnavailableBackend),
    )
    .unwrap();
    let k = Keys::new();
    let c = Connector::new();
    let m = AccountManager::new(g.clone(), k.clone(), c.clone());
    (d, g, k, c, m)
}
async fn state(m: &AccountManager, expected: ConnectionState) {
    // Observe real journal/HTTP worker startup under native-runner contention.
    // A finite wait is not permission to retry a configuration or outgoing send.
    let settled = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if m.status().await.iter().any(|s| s.connection == expected) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(
        settled.is_ok(),
        "account did not reach {expected:?}; observed statuses: {:?}",
        m.status().await,
    );
}
#[tokio::test]
async fn disabled_configuration_persists_only_refs_and_does_not_read_keys_or_connect() {
    let (d, g, k, c, m) = setup();
    let saved = m
        .configure_telegram(123456, 0, false, SECRET.into())
        .await
        .unwrap();
    assert!(!serde_json::to_string(&saved).unwrap().contains(SECRET));
    let stop = CancellationToken::new();
    let runner = tokio::spawn(m.clone().run(stop.clone()));
    state(&m, ConnectionState::Disabled).await;
    assert_eq!(k.reads.load(Ordering::SeqCst), 0);
    assert_eq!(c.calls.load(Ordering::SeqCst), 0);
    stop.cancel();
    runner.await.unwrap().unwrap();
    g.close().await.unwrap();
    for f in ["remote.sqlite", "remote.sqlite-wal"] {
        if let Ok(bytes) = std::fs::read(d.0.join(f)) {
            assert!(!bytes.windows(SECRET.len()).any(|w| w == SECRET.as_bytes()));
        }
    }
    let reopened = Gateway::open(
        &d.0,
        "host".into(),
        Arc::new(xharness_api::UnavailableBackend),
    )
    .unwrap();
    assert_eq!(
        reopened.account_settings().await.unwrap(),
        vec![saved.settings]
    );
}
#[tokio::test]
async fn rotation_and_disable_fence_old_leases_and_drain_connections_without_agent_calls() {
    let (_d, g, _k, c, m) = setup();
    let one = m
        .configure_telegram(123456, 0, true, SECRET.into())
        .await
        .unwrap();
    let stop = CancellationToken::new();
    let runner = tokio::spawn(m.clone().run(stop.clone()));
    state(&m, ConnectionState::Online).await;
    let lease = g
        .acquire_configured_account(one.settings.account.clone(), 1)
        .await
        .unwrap();
    let two = m
        .configure_telegram(123456, 1, true, SECRET.into())
        .await
        .unwrap();
    assert_ne!(one.settings.credentials, two.settings.credentials);
    assert!(matches!(
        g.account_checkpoint(&lease).await,
        Err(xharness_remote::Error::StaleLease)
    ));
    state(&m, ConnectionState::Online).await;
    assert_eq!(c.stopped.load(Ordering::SeqCst), 1);
    assert_eq!(c.running.load(Ordering::SeqCst), 1);
    m.set_enabled(two.settings.account.clone(), 2, false)
        .await
        .unwrap();
    state(&m, ConnectionState::Disabled).await;
    stop.cancel();
    runner.await.unwrap().unwrap();
    assert_eq!(c.running.load(Ordering::SeqCst), 0);
    assert_eq!(c.stopped.load(Ordering::SeqCst), 2);
    assert!(g
        .acquire_configured_account(two.settings.account, 2)
        .await
        .is_err());
}
#[tokio::test]
async fn keychain_errors_and_provider_conflicts_are_observable_closed_and_not_hot_retried() {
    let (_d, _g, k, c, m) = setup();
    m.configure_telegram(123456, 0, true, SECRET.into())
        .await
        .unwrap();
    k.locked.store(true, Ordering::SeqCst);
    let stop = CancellationToken::new();
    let runner = tokio::spawn(m.clone().run(stop.clone()));
    state(
        &m,
        ConnectionState::Failed {
            reason: ChannelFailure::NativeCredentialUnavailable,
        },
    )
    .await;
    tokio::time::sleep(Duration::from_millis(450)).await;
    assert_eq!(k.reads.load(Ordering::SeqCst), 1);
    assert_eq!(c.calls.load(Ordering::SeqCst), 0);
    assert!(!serde_json::to_string(&m.status().await)
        .unwrap()
        .contains(SECRET));
    k.locked.store(false, Ordering::SeqCst);
    c.fail.store(true, Ordering::SeqCst);
    m.set_enabled(
        Account {
            channel: Channel::Telegram,
            id: "123456".into(),
        },
        1,
        true,
    )
    .await
    .unwrap();
    state(
        &m,
        ConnectionState::Failed {
            reason: ChannelFailure::ProviderConflict,
        },
    )
    .await;
    tokio::time::sleep(Duration::from_millis(450)).await;
    assert_eq!(c.calls.load(Ordering::SeqCst), 1);
    stop.cancel();
    runner.await.unwrap().unwrap();
}
#[tokio::test]
async fn stale_configuration_does_not_overwrite_active_secret_and_cleanup_survives_restart() {
    let (d, g, k, c, m) = setup();
    let first = m
        .configure_telegram(123456, 0, false, SECRET.into())
        .await
        .unwrap();
    assert_eq!(
        m.configure_telegram(123456, 0, true, SECRET.into())
            .await
            .unwrap_err(),
        ChannelFailure::SettingConflict
    );
    assert_eq!(k.writes.load(Ordering::SeqCst), 1);
    k.delete_failed.store(true, Ordering::SeqCst);
    let second = m
        .configure_telegram(123456, 1, false, SECRET.into())
        .await
        .unwrap();
    assert!(second.credential_cleanup_pending);
    assert_eq!(
        g.pending_credential_cleanup().await.unwrap(),
        first
            .settings
            .credentials
            .values()
            .cloned()
            .collect::<Vec<_>>()
    );
    g.close().await.unwrap();
    let reopened = Gateway::open(
        &d.0,
        "host".into(),
        Arc::new(xharness_api::UnavailableBackend),
    )
    .unwrap();
    k.delete_failed.store(false, Ordering::SeqCst);
    let m = AccountManager::new(reopened.clone(), k.clone(), c);
    assert!(!m.cleanup_credentials().await);
    assert!(reopened
        .pending_credential_cleanup()
        .await
        .unwrap()
        .is_empty());
    assert_eq!(k.values.lock().await.len(), 1);
    assert!(k
        .values
        .lock()
        .await
        .contains_key(&second.settings.credentials["bot_token"]));
}
#[tokio::test]
async fn cancellation_during_slow_connect_does_not_resurrect_a_disabled_account() {
    let (_d, g, _k, c, m) = setup();
    c.release.forget_permits(100);
    let s = m
        .configure_telegram(123456, 0, true, SECRET.into())
        .await
        .unwrap();
    let stop = CancellationToken::new();
    let runner = tokio::spawn(m.clone().run(stop.clone()));
    c.connecting.acquire().await.unwrap().forget();
    m.set_enabled(s.settings.account.clone(), 1, false)
        .await
        .unwrap();
    state(&m, ConnectionState::Disabled).await;
    c.release.add_permits(1);
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(c.running.load(Ordering::SeqCst), 0);
    assert!(g
        .acquire_configured_account(s.settings.account, 1)
        .await
        .is_err());
    stop.cancel();
    runner.await.unwrap().unwrap();
}
#[tokio::test]
async fn panicked_connection_is_failed_not_forever_online_or_automatically_restarted() {
    let (_d, _g, _k, c, m) = setup();
    c.panic_worker.store(true, Ordering::SeqCst);
    m.configure_telegram(123456, 0, true, SECRET.into())
        .await
        .unwrap();
    let stop = CancellationToken::new();
    let runner = tokio::spawn(m.clone().run(stop.clone()));
    state(
        &m,
        ConnectionState::Failed {
            reason: ChannelFailure::WorkerFailed,
        },
    )
    .await;
    tokio::time::sleep(Duration::from_millis(450)).await;
    assert_eq!(c.calls.load(Ordering::SeqCst), 1);
    stop.cancel();
    runner.await.unwrap().unwrap();
}
#[tokio::test]
async fn journal_failure_drains_all_connections_and_surfaces_manager_failure() {
    let (_d, g, _k, c, m) = setup();
    m.configure_telegram(123456, 0, true, SECRET.into())
        .await
        .unwrap();
    let runner = tokio::spawn(m.clone().run(CancellationToken::new()));
    state(&m, ConnectionState::Online).await;
    g.close().await.unwrap();
    assert_eq!(runner.await.unwrap(), Err(ChannelFailure::Journal));
    assert_eq!(
        m.health().await,
        ManagerHealth::Failed {
            reason: ChannelFailure::Journal
        }
    );
    assert_eq!(c.stopped.load(Ordering::SeqCst), 1);
}

// The same TelegramConnection used by the native factory, with loopback-only
// HTTP fixtures; no substitute account loop or provider send implementation.
struct WireConnector {
    base: String,
}
#[async_trait]
impl AccountConnector for WireConnector {
    async fn connect(
        &self,
        s: AccountSettings,
        g: Arc<Gateway>,
        secret: String,
    ) -> Result<Box<dyn AccountConnection>, ChannelFailure> {
        let c =
            Arc::new(Client::loopback_fixture(BotToken::new(secret).unwrap(), &self.base).unwrap());
        TelegramConnector::connect_client(s, g, c).await
    }
}
struct ScopeHost;
#[async_trait]
impl xharness_api::ApiBackend for ScopeHost {
    async fn call(
        &self,
        _: xharness_api::RpcId,
        _: xharness_api::RpcMethod,
        _: serde_json::Value,
        _: CancellationToken,
    ) -> xharness_api::RpcResult {
        panic!("reply shutdown must not dispatch Agent");
    }
    async fn respond(&self, _: xharness_api::ClientResponse) -> xharness_api::RpcReceipt {
        panic!("native account must not answer arbitrary interactions");
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, xharness_api::RpcError> {
        Ok(w == "w" && s == "s")
    }
    async fn session_event_page(
        &self,
        _: &str,
        _: &str,
        after: Option<u64>,
    ) -> Result<xharness_api::ScopedEventPage, xharness_api::RpcError> {
        let start = after.unwrap_or(0);
        Ok(xharness_api::ScopedEventPage {
            start_seq: start,
            next_seq: start,
            head_seq: start,
            events: vec![],
        })
    }
    async fn session_events(
        &self,
        w: &str,
        s: &str,
    ) -> Result<xharness_api::EventStream, xharness_api::RpcError> {
        assert_eq!((w, s), ("w", "s"));
        Ok(Box::pin(futures::stream::pending()))
    }
    fn mux_events(&self) -> xharness_api::EventStream {
        panic!("no global stream");
    }
    fn host_events(&self) -> xharness_api::EventStream {
        panic!("no global stream");
    }
}
#[tokio::test]
async fn actual_native_account_composes_wire_intake_outbox_and_drains_uncertain_send_before_close()
{
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    use xharness_remote::*;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let entered = Arc::new(Semaphore::new(0));
    let sends = Arc::new(AtomicUsize::new(0));
    let wire_stop = CancellationToken::new();
    let server = {
        let entered = entered.clone();
        let sends = sends.clone();
        let wire_stop = wire_stop.clone();
        tokio::spawn(async move {
            let mut handlers = JoinSet::new();
            loop {
                let (mut socket, _) = tokio::select! {biased;_=wire_stop.cancelled()=>break,result=listener.accept()=>result.unwrap()};
                let entered = entered.clone();
                let sends = sends.clone();
                let stop = wire_stop.clone();
                handlers.spawn(async move {
                let mut buffer=Vec::new();let mut chunk=[0;4096];
                loop {let n=socket.read(&mut chunk).await.unwrap();if n==0 {return;}buffer.extend_from_slice(&chunk[..n]);
                    if let Some(end)=buffer.windows(4).position(|w|w==b"\r\n\r\n") {
                        let header=String::from_utf8_lossy(&buffer[..end]);
                        let length=header.lines().find_map(|l|l.to_lowercase().strip_prefix("content-length:").and_then(|v|v.trim().parse::<usize>().ok())).unwrap_or(0);
                        if buffer.len()>=end+4+length {break;}
                    }
                }
                let request=String::from_utf8_lossy(&buffer);let path=request.lines().next().unwrap().split_whitespace().nth(1).unwrap();
                let result=if path.ends_with("/getMe") {serde_json::json!({"id":123456,"is_bot":true,"first_name":"Fixture"})}
                    else if path.ends_with("/getWebhookInfo") {serde_json::json!({"url":""})}
                    else if path.ends_with("/getUpdates") {serde_json::json!([])}
                    else if path.ends_with("/sendMessage") {sends.fetch_add(1,Ordering::SeqCst);entered.add_permits(1);stop.cancelled().await;return;}
                    else {panic!("unexpected fixture method");};
                let body=serde_json::json!({"ok":true,"result":result}).to_string();let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);let _=socket.write_all(response.as_bytes()).await;
            });
            }
            while handlers.join_next().await.is_some() {}
        })
    };
    let d = Temp::new();
    let keys = Keys::new();
    let service = crate::remote_control::RemoteControl::start_with_accounts(
        &d.0,
        Arc::new(ScopeHost),
        keys,
        Arc::new(WireConnector { base }),
    )
    .unwrap();
    let g = service.gateway();
    let manager = service.accounts();
    manager
        .configure_telegram(123456, 0, true, SECRET.into())
        .await
        .unwrap();
    state(&manager, ConnectionState::Online).await;
    let sender = Sender {
        channel: Channel::Telegram,
        account: "123456".into(),
        user: "42".into(),
    };
    g.set_principal(Principal {
        id: "p".into(),
        host: g.host_id().into(),
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
        conversation: "42".into(),
        workspace: "w".into(),
        session: "s".into(),
        generation: 1,
    })
    .await
    .unwrap();
    let reply = g
        .enqueue_replies(
            Subscription {
                principal: "p".into(),
                sender,
                conversation: "42".into(),
                binding: "b".into(),
                generation: 1,
            },
            vec![ReplyPlan {
                id: "reply".into(),
                body: ReplyBody {
                    attachment: None,
                    text: "fixture output".into(),
                    buttons: vec![],
                },
                replace_of: None,
            }],
        )
        .await
        .unwrap()
        .remove(0);
    tokio::time::timeout(Duration::from_secs(3), entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    service.stop().await.unwrap();
    assert!(g.inspect_reply(&reply.key).await.is_err());
    let reopened = Gateway::open(
        &d.0.join("remote-control"),
        g.host_id().into(),
        Arc::new(ScopeHost),
    )
    .unwrap();
    assert_eq!(
        reopened
            .inspect_reply(&reply.key)
            .await
            .unwrap()
            .unwrap()
            .state,
        ReplyState::Uncertain
    );
    assert_eq!(sends.load(Ordering::SeqCst), 1);
    wire_stop.cancel();
    server.await.unwrap();
}

#[tokio::test]
async fn cancelled_setup_cannot_orphan_an_untracked_native_secret() {
    let (_d, g, k, _c, m) = setup();
    k.hang_after_set.store(true, Ordering::SeqCst);
    let task = {
        let m = m.clone();
        tokio::spawn(async move { m.configure_telegram(123456, 0, false, SECRET.into()).await })
    };
    k.staged.acquire().await.unwrap().forget();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(g.account_settings().await.unwrap().is_empty());
    assert_eq!(g.pending_credential_cleanup().await.unwrap().len(), 1);
    assert_eq!(k.values.lock().await.len(), 1);
    assert!(!m.cleanup_credentials().await);
    assert!(k.values.lock().await.is_empty());
    assert!(g.pending_credential_cleanup().await.unwrap().is_empty());
}

struct InteractionHost {
    pending: AtomicBool,
    answers: AtomicUsize,
}
impl InteractionHost {
    fn snapshot() -> xharness_api::ScopedInteraction {
        xharness_api::ScopedInteraction {
            nonce: "native-composition-instance".into(),
            frame: xharness_api::MuxFrame::ApprovalRequested {
                session_id: "s".into(),
                approval_id: "a".into(),
                call_id: Some("call".into()),
                tool_name: "fixture".into(),
                reason: Some("manual".into()),
                reviewing: Some(false),
            }
            .into_server_request(xharness_api::RpcId::new("approval")),
        }
    }
}
#[async_trait]
impl xharness_api::ApiBackend for InteractionHost {
    async fn call(
        &self,
        _: xharness_api::RpcId,
        _: xharness_api::RpcMethod,
        _: serde_json::Value,
        _: CancellationToken,
    ) -> xharness_api::RpcResult {
        panic!("no Agent/model or generic dispatch");
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, xharness_api::RpcError> {
        Ok(w == "w" && s == "s")
    }
    async fn session_event_page(
        &self,
        _: &str,
        _: &str,
        after: Option<u64>,
    ) -> Result<xharness_api::ScopedEventPage, xharness_api::RpcError> {
        let start = after.unwrap_or(0);
        Ok(xharness_api::ScopedEventPage {
            start_seq: start,
            next_seq: start,
            head_seq: start,
            events: vec![],
        })
    }
    async fn session_events(
        &self,
        w: &str,
        s: &str,
    ) -> Result<xharness_api::EventStream, xharness_api::RpcError> {
        use futures::StreamExt;
        assert_eq!((w, s), ("w", "s"));
        let frames = self
            .pending
            .load(Ordering::SeqCst)
            .then(|| Self::snapshot().frame);
        Ok(Box::pin(
            futures::stream::iter(frames).chain(futures::stream::pending()),
        ))
    }
    async fn session_interaction(
        &self,
        w: &str,
        s: &str,
        id: &xharness_api::RpcId,
    ) -> Result<Option<xharness_api::ScopedInteraction>, xharness_api::RpcError> {
        assert_eq!((w, s, id.as_str()), ("w", "s", "approval"));
        Ok(self.pending.load(Ordering::SeqCst).then(Self::snapshot))
    }
    async fn answer_session_interaction(
        &self,
        w: &str,
        s: &str,
        snapshot: xharness_api::ScopedInteraction,
        answer: xharness_api::ScopedInteractionAnswer,
    ) -> Result<xharness_api::ScopedInteractionReceipt, xharness_api::RpcError> {
        assert_eq!((w, s), ("w", "s"));
        assert_eq!(snapshot, Self::snapshot());
        assert_eq!(
            answer,
            xharness_api::ScopedInteractionAnswer::Approval { allowed: true }
        );
        assert!(self.pending.swap(false, Ordering::SeqCst));
        self.answers.fetch_add(1, Ordering::SeqCst);
        Ok(xharness_api::ScopedInteractionReceipt::Accepted)
    }
    async fn respond(&self, _: xharness_api::ClientResponse) -> xharness_api::RpcReceipt {
        panic!("no generic respond");
    }
    fn mux_events(&self) -> xharness_api::EventStream {
        panic!("no global mux");
    }
    fn host_events(&self) -> xharness_api::EventStream {
        panic!("no global Host events");
    }
}
#[derive(Clone, Default)]
struct InteractionWire {
    sends: Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    updates: Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    acks: Arc<AtomicUsize>,
}
async fn interaction_wire(
    axum::extract::State(w): axum::extract::State<InteractionWire>,
    axum::extract::OriginalUri(uri): axum::extract::OriginalUri,
    axum::Json(payload): axum::Json<serde_json::Value>,
) -> axum::Json<serde_json::Value> {
    use serde_json::json;
    let result = match uri.path().rsplit('/').next().unwrap() {
        "getMe" => json!({"id":123456,"is_bot":true}),
        "getWebhookInfo" => json!({"url":""}),
        "getUpdates" => json!(w
            .updates
            .lock()
            .unwrap()
            .iter()
            .filter(|u| u["update_id"].as_u64().unwrap() >= payload["offset"].as_u64().unwrap_or(0))
            .cloned()
            .collect::<Vec<_>>()),
        "sendMessage" => {
            w.sends.lock().unwrap().push(payload.clone());
            json!({"message_id":200,"chat":{"id":payload["chat_id"],"type":"private"}})
        }
        "answerCallbackQuery" => {
            w.acks.fetch_add(1, Ordering::SeqCst);
            json!(true)
        }
        _ => panic!("unexpected wire method"),
    };
    axum::Json(json!({"ok":true,"result":result}))
}
async fn wait_interaction(mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn native_account_three_workers_notify_receive_decide_then_restart_without_reapproval_or_resend(
) {
    use serde_json::json;
    use xharness_remote::*;
    let wire = InteractionWire::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = axum::Router::new()
        .route("/{*path}", axum::routing::post(interaction_wire))
        .with_state(wire.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let dir = Temp::new();
    let keys = Keys::new();
    let host = Arc::new(InteractionHost {
        pending: AtomicBool::new(true),
        answers: AtomicUsize::new(0),
    });
    let service = crate::remote_control::RemoteControl::start_with_accounts(
        &dir.0,
        host.clone(),
        keys.clone(),
        Arc::new(WireConnector { base: base.clone() }),
    )
    .unwrap();
    let gateway = service.gateway();
    let manager = service.accounts();
    let sender = Sender {
        channel: Channel::Telegram,
        account: "123456".into(),
        user: "42".into(),
    };
    gateway
        .set_principal(Principal {
            id: "p".into(),
            host: gateway.host_id().into(),
            sender: sender.clone(),
            workspaces: ["w".into()].into(),
            sessions: ["s".into()].into(),
            revision: 1,
            revoked: false,
        })
        .await
        .unwrap();
    gateway
        .bind(Binding {
            id: "b".into(),
            principal: "p".into(),
            conversation: "42".into(),
            workspace: "w".into(),
            session: "s".into(),
            generation: 1,
        })
        .await
        .unwrap();
    manager
        .configure_telegram(123456, 0, true, SECRET.into())
        .await
        .unwrap();
    state(&manager, ConnectionState::Online).await;
    wait_interaction(|| wire.sends.lock().unwrap().len() == 1).await;
    assert_eq!(host.answers.load(Ordering::SeqCst), 0);
    let callback = wire.sends.lock().unwrap()[0]["reply_markup"]["inline_keyboard"][0][0]
        ["callback_data"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(callback.starts_with("a:") && callback.len() == 50);
    let update = |id| json!({"update_id":id,"callback_query":{"id":format!("callback-{id}"),"from":{"id":42,"is_bot":false},"message":{"message_id":200,"from":{"id":123456,"is_bot":true},"chat":{"id":42,"type":"private"}},"data":callback}});
    wire.updates.lock().unwrap().push(update(17));
    wait_interaction(|| host.answers.load(Ordering::SeqCst) == 1).await;
    wait_interaction(|| wire.acks.load(Ordering::SeqCst) == 1).await;
    wait_interaction(|| wire.sends.lock().unwrap().len() == 2).await;
    assert_eq!(
        wire.sends.lock().unwrap()[1]["text"],
        "Native response recorded."
    );
    let old = gateway
        .accept(
            "p",
            sender.clone(),
            "42".into(),
            Inbound {
                request_id: "17".into(),
                binding: "b".into(),
                generation: 1,
                command: Command::AnswerInteraction {
                    ticket: TicketToken::try_from(callback[2..].to_owned()).unwrap(),
                    answer: ScopedInteractionAnswer::Approval { allowed: true },
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(
        gateway.dispatch(&old.key).await.unwrap().state,
        DeliveryState::Completed
    );
    service.stop().await.unwrap();
    // Saved enabled configuration, cursor and account references survive the
    // actual service reopen. The same wire update is not reaccepted.
    let service = crate::remote_control::RemoteControl::start_with_accounts(
        &dir.0,
        host.clone(),
        keys,
        Arc::new(WireConnector { base }),
    )
    .unwrap();
    state(&service.accounts(), ConnectionState::Online).await;
    wire.updates.lock().unwrap().push(update(18));
    wait_interaction(|| wire.acks.load(Ordering::SeqCst) == 2).await;
    assert_eq!(host.answers.load(Ordering::SeqCst), 1);
    assert_eq!(wire.sends.lock().unwrap().len(), 2);
    assert_eq!(
        service
            .gateway()
            .inspect(&old.key)
            .await
            .unwrap()
            .unwrap()
            .state,
        DeliveryState::Completed
    );
    service.stop().await.unwrap();
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}

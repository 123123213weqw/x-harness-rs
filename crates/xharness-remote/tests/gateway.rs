use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap},
    sync::{
        atomic::{AtomicUsize, Ordering},
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
    receipts: Mutex<HashMap<String, (Value, RpcResult)>>,
    calls: AtomicUsize,
    order: Mutex<Vec<String>>,
    block: Semaphore,
    entered: Semaphore,
    unavailable: bool,
    large_response: bool,
    failure: bool,
    crash: Option<std::path::PathBuf>,
}
impl Host {
    fn new() -> Self {
        Self {
            receipts: Mutex::new(HashMap::new()),
            calls: AtomicUsize::new(0),
            order: Mutex::new(vec![]),
            block: Semaphore::new(100),
            entered: Semaphore::new(0),
            unavailable: false,
            large_response: false,
            failure: false,
            crash: None,
        }
    }
}
#[async_trait]
impl ApiBackend for Host {
    async fn call(
        &self,
        id: RpcId,
        method: RpcMethod,
        payload: Value,
        cancellation: CancellationToken,
    ) -> RpcResult {
        assert!(!cancellation.is_cancelled());
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.order
            .lock()
            .unwrap()
            .push(payload["sessionId"].as_str().unwrap().to_owned());
        self.entered.add_permits(1);
        self.block.acquire().await.unwrap().forget();
        let result = if self.large_response {
            RpcResult::success(json!({"events":["x".repeat(MAX_RESULT_BYTES+1)]}))
        } else if self.failure {
            RpcResult::failure(RpcError::internal("fixture business failure"))
        } else {
            RpcResult::success(json!({"accepted":true}))
        };
        if method == RpcMethod::SessionPrompt {
            self.receipts
                .lock()
                .unwrap()
                .insert(id.as_str().into(), (payload.clone(), result.clone()));
        }
        if let Some(path) = &self.crash {
            // Durable fixture receipt and process death after effect, before the
            // gateway can save its result. This is a protocol fixture, not a model.
            let file = std::fs::File::create(path.join("host-receipt.json")).unwrap();
            serde_json::to_writer(
                &file,
                &json!({"id":id.as_str(),"payload":payload,"result":result}),
            )
            .unwrap();
            file.sync_all().unwrap();
            std::process::exit(79);
        }
        result
    }
    async fn session_in_workspace(&self, workspace: &str, session: &str) -> Result<bool, RpcError> {
        Ok(workspace == "w" && matches!(session, "s" | "s2"))
    }
    async fn prompt_receipt(
        &self,
        _: &str,
        id: &RpcId,
        payload: &Value,
    ) -> Result<Option<RpcResult>, RpcError> {
        if self.unavailable {
            return Err(RpcError::internal("no journal"));
        }
        match self.receipts.lock().unwrap().get(id.as_str()) {
            Some((old, result)) if old == payload => Ok(Some(result.clone())),
            Some(_) => Err(RpcError::internal("identity conflict")),
            None => Ok(None),
        }
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("untyped response must not reach Host")
    }
    fn mux_events(&self) -> EventStream {
        Box::pin(futures::stream::empty())
    }
    fn host_events(&self) -> EventStream {
        Box::pin(futures::stream::empty())
    }
}
fn sender() -> Sender {
    Sender {
        channel: Channel::Telegram,
        account: "bot".into(),
        user: "42".into(),
    }
}
fn principal() -> Principal {
    Principal {
        id: "p".into(),
        host: "h".into(),
        sender: sender(),
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
        conversation: "private:42".into(),
        workspace: "w".into(),
        session: "s".into(),
        generation: 1,
    }
}
fn prompt(id: &str) -> Inbound {
    Inbound {
        request_id: id.into(),
        binding: "b".into(),
        generation: 1,
        command: Command::Prompt {
            mode: PromptMode::Queue,
            content: vec![Content::Text {
                text: "hello".into(),
            }],
            client_time_zone: None,
        },
    }
}
async fn setup(host: Arc<Host>) -> (tempfile::TempDir, Arc<Gateway>) {
    let temp = tempfile::tempdir().unwrap();
    let g = Gateway::open(temp.path(), "h".into(), host).unwrap();
    g.set_principal(principal()).await.unwrap();
    g.bind(binding()).await.unwrap();
    (temp, g)
}
async fn accept(g: &Gateway, input: Inbound) -> Delivery {
    g.accept("p", sender(), "private:42".into(), input)
        .await
        .unwrap()
}

#[tokio::test]
async fn duplicate_survives_restart_and_payload_conflict_fails() {
    let host = Arc::new(Host::new());
    let (temp, g) = setup(host.clone()).await;
    let d = accept(&g, prompt("1")).await;
    assert_eq!(accept(&g, prompt("1")).await, d);
    let mut changed = prompt("1");
    changed.command = Command::Cancel;
    assert!(matches!(
        g.accept("p", sender(), "private:42".into(), changed).await,
        Err(Error::IdentityConflict)
    ));
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Completed
    );
    // Graceful restart uses the production shutdown fence; a completed
    // blocking transaction can briefly retain its task-owned Store Arc.
    g.close().await.unwrap();
    drop(g);
    let g = Gateway::open(temp.path(), "h".into(), host.clone()).unwrap();
    let replay = accept(&g, prompt("1")).await;
    g.dispatch(&replay.key).await.unwrap();
    assert_eq!(host.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn wrong_sender_conversation_generation_and_scope_fail_closed() {
    let (_temp, g) = setup(Arc::new(Host::new())).await;
    let mut fake = sender();
    fake.user = "43".into();
    assert!(matches!(
        g.accept("p", fake, "private:42".into(), prompt("1")).await,
        Err(Error::Unauthorized)
    ));
    assert!(matches!(
        g.accept("p", sender(), "group:42".into(), prompt("1"))
            .await,
        Err(Error::Unauthorized)
    ));
    let mut stale = prompt("1");
    stale.generation = 2;
    assert!(matches!(
        g.accept("p", sender(), "private:42".into(), stale).await,
        Err(Error::Unauthorized)
    ));
    let mut wrong = binding();
    wrong.session = "outside".into();
    wrong.generation = 2;
    assert!(matches!(g.bind(wrong).await, Err(Error::Unauthorized)));
}

#[tokio::test]
async fn revoke_rejects_queued_and_new_and_cannot_resurrect() {
    let host = Arc::new(Host::new());
    let (_temp, g) = setup(host.clone()).await;
    let d = accept(&g, prompt("1")).await;
    g.revoke("p").await.unwrap();
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Rejected
    );
    assert!(matches!(
        g.accept("p", sender(), "private:42".into(), prompt("2"))
            .await,
        Err(Error::Unauthorized)
    ));
    let mut p = principal();
    p.revision = 3;
    assert!(matches!(
        g.set_principal(p).await,
        Err(Error::IdentityConflict)
    ));
    assert_eq!(host.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn rebind_fences_queued_and_duplicate_cannot_move_to_new_session() {
    let host = Arc::new(Host::new());
    let (_temp, g) = setup(host.clone()).await;
    let d = accept(&g, prompt("1")).await;
    let mut b = binding();
    b.session = "s2".into();
    b.generation = 2;
    g.bind(b).await.unwrap();
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Rejected
    );
    let mut moved = prompt("1");
    moved.generation = 2;
    assert!(matches!(
        g.accept("p", sender(), "private:42".into(), moved).await,
        Err(Error::IdentityConflict)
    ));
    assert_eq!(host.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn session_fifo_and_independent_session_can_proceed() {
    let mut fake = Host::new();
    fake.block = Semaphore::new(0);
    let host = Arc::new(fake);
    let (_temp, g) = setup(host.clone()).await;
    let mut b = binding();
    b.id = "b2".into();
    b.session = "s2".into();
    g.bind(b).await.unwrap();
    let first = accept(&g, prompt("1")).await;
    let second = accept(&g, prompt("2")).await;
    assert!(matches!(
        g.dispatch(&second.key).await,
        Err(Error::SessionBlocked)
    ));
    let g1 = g.clone();
    let k1 = first.key.clone();
    let worker = tokio::spawn(async move { g1.dispatch(&k1).await });
    host.entered.acquire().await.unwrap().forget();
    let mut input = prompt("3");
    input.binding = "b2".into();
    let independent = accept(&g, input).await;
    let g2 = g.clone();
    let k2 = independent.key;
    let other = tokio::spawn(async move { g2.dispatch(&k2).await });
    tokio::time::timeout(std::time::Duration::from_secs(2), host.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    host.block.add_permits(2);
    worker.await.unwrap().unwrap();
    other.await.unwrap().unwrap();
    host.block.add_permits(1);
    g.dispatch(&second.key).await.unwrap();
    assert_eq!(*host.order.lock().unwrap(), vec!["s", "s2", "s"]);
}

#[tokio::test]
async fn dropping_controller_does_not_cancel_supervisor_admission() {
    let mut fake = Host::new();
    fake.block = Semaphore::new(0);
    let host = Arc::new(fake);
    let (_temp, g) = setup(host.clone()).await;
    let d = accept(&g, prompt("1")).await;
    let shutdown = CancellationToken::new();
    let run = g.clone();
    let stop = shutdown.clone();
    let worker = tokio::spawn(async move { run.run(stop).await });
    host.entered.acquire().await.unwrap().forget();
    shutdown.cancel();
    tokio::task::yield_now().await;
    assert!(!worker.is_finished());
    host.block.add_permits(1);
    worker.await.unwrap().unwrap();
    assert_eq!(
        g.inspect(&d.key).await.unwrap().unwrap().state,
        DeliveryState::Completed
    );
}

#[tokio::test]
async fn exclusive_consumer_and_wrong_host_restart() {
    let host = Arc::new(Host::new());
    let (temp, g) = setup(host.clone()).await;
    assert!(matches!(
        Gateway::open(temp.path(), "h".into(), host.clone()),
        Err(Error::ConsumerBusy)
    ));
    g.close().await.unwrap();
    drop(g);
    assert!(matches!(
        Gateway::open(temp.path(), "another-host".into(), host),
        Err(Error::Unauthorized)
    ));
}

#[tokio::test]
async fn backend_without_durable_receipts_never_receives_prompt() {
    let mut fake = Host::new();
    fake.unavailable = true;
    let host = Arc::new(fake);
    let (_temp, g) = setup(host.clone()).await;
    let d = accept(&g, prompt("1")).await;
    assert!(matches!(
        g.dispatch(&d.key).await,
        Err(Error::HostUnavailable)
    ));
    assert_eq!(host.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn business_failure_is_persisted_not_rerun() {
    let mut fake = Host::new();
    fake.failure = true;
    let host = Arc::new(fake);
    let (_temp, g) = setup(host.clone()).await;
    let d = accept(&g, prompt("1")).await;
    let done = g.dispatch(&d.key).await.unwrap();
    assert!(matches!(done.result, Some(RpcResult::Failure { .. })));
    g.dispatch(&d.key).await.unwrap();
    assert_eq!(host.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn rejects_unbounded_or_path_based_content_and_unknown_rpc() {
    let (_temp, g) = setup(Arc::new(Host::new())).await;
    assert!(serde_json::from_value::<Inbound>(
        json!({"request_id":"1","binding":"b","generation":1,
        "command":{"type":"rpc","method":"host.openPath","payload":{"path":"/etc/passwd"}}})
    )
    .is_err());
    assert!(
        serde_json::from_value::<Content>(json!({"type":"file","path":"/etc/passwd"})).is_err()
    );
    let mut i = prompt("1");
    i.command = Command::History {
        before_seq: None,
        max_messages: 501,
    };
    assert!(matches!(
        g.accept("p", sender(), "private:42".into(), i).await,
        Err(Error::Invalid(_))
    ));
    let mut i = prompt("2");
    i.command = Command::Prompt {
        mode: PromptMode::Queue,
        client_time_zone: None,
        content: vec![Content::File {
            media_type: "text/plain".into(),
            data: "YQ==".into(),
            name: Some("../secret".into()),
        }],
    };
    assert!(matches!(
        g.accept("p", sender(), "private:42".into(), i).await,
        Err(Error::Invalid(_))
    ));
}

// The parent launches this exact test as a separate process to exercise actual
// ungraceful death with no Gateway destructor / SQLite close / worker cleanup.
#[test]
fn crash_child() {
    let Some(root) = std::env::var_os("XHARNESS_GATEWAY_CRASH_ROOT") else {
        return;
    };
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let mut fake = Host::new();
        fake.crash = Some(root.clone().into());
        let g = Gateway::open(std::path::Path::new(&root), "h".into(), Arc::new(fake)).unwrap();
        g.set_principal(principal()).await.unwrap();
        g.bind(binding()).await.unwrap();
        let mut i = prompt("crash");
        if std::env::var_os("XHARNESS_GATEWAY_CRASH_CANCEL").is_some() {
            i.command = Command::Cancel;
        }
        let d = accept(&g, i).await;
        g.dispatch(&d.key).await.unwrap();
    });
    panic!("child should exit at effect boundary");
}
fn killed(root: &std::path::Path, cancel: bool) {
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", "crash_child", "--nocapture"])
        .env("XHARNESS_GATEWAY_CRASH_ROOT", root);
    if cancel {
        command.env("XHARNESS_GATEWAY_CRASH_CANCEL", "1");
    }
    let output = command.output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(79),
        "child: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
#[tokio::test]
async fn process_death_after_host_acceptance_reconciles_without_replay() {
    let temp = tempfile::tempdir().unwrap();
    killed(temp.path(), false);
    let receipt: Value =
        serde_json::from_slice(&std::fs::read(temp.path().join("host-receipt.json")).unwrap())
            .unwrap();
    let host = Arc::new(Host::new());
    host.receipts.lock().unwrap().insert(
        receipt["id"].as_str().unwrap().into(),
        (
            receipt["payload"].clone(),
            serde_json::from_value(receipt["result"].clone()).unwrap(),
        ),
    );
    let g = Gateway::open(temp.path(), "h".into(), host.clone()).unwrap();
    let pending = g.pending().await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].state, DeliveryState::Dispatching);
    assert_eq!(
        g.dispatch(&pending[0].key).await.unwrap().state,
        DeliveryState::Completed
    );
    assert_eq!(host.calls.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn process_death_after_cancel_does_not_cancel_newer_work() {
    let temp = tempfile::tempdir().unwrap();
    killed(temp.path(), true);
    let host = Arc::new(Host::new());
    let g = Gateway::open(temp.path(), "h".into(), host.clone()).unwrap();
    let pending = g.pending().await.unwrap();
    assert_eq!(
        g.dispatch(&pending[0].key).await.unwrap().state,
        DeliveryState::Uncertain
    );
    let next = accept(&g, prompt("next")).await;
    assert!(matches!(
        g.dispatch(&next.key).await,
        Err(Error::SessionBlocked)
    ));
    assert!(g.pending().await.unwrap().is_empty());
    assert_eq!(host.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn simultaneous_duplicate_intake_has_one_durable_sequence() {
    let host = Arc::new(Host::new());
    let (_temp, g) = setup(host.clone()).await;
    let mut clients = tokio::task::JoinSet::new();
    for _ in 0..32 {
        let g = g.clone();
        clients.spawn(async move { accept(&g, prompt("same-update")).await });
    }
    let mut identities = BTreeSet::new();
    while let Some(result) = clients.join_next().await {
        let d = result.unwrap();
        identities.insert((d.sequence, d.key));
    }
    assert_eq!(identities.len(), 1);
    let (_, key) = identities.pop_first().unwrap();
    g.dispatch(&key).await.unwrap();
    assert_eq!(host.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn queued_intake_survives_restart_before_any_host_call() {
    let host = Arc::new(Host::new());
    let (temp, g) = setup(host.clone()).await;
    let d = accept(&g, prompt("before-dispatch")).await;
    g.close().await.unwrap();
    drop(g);
    let g = Gateway::open(temp.path(), "h".into(), host.clone()).unwrap();
    assert_eq!(g.pending().await.unwrap()[0].key, d.key);
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Completed
    );
    assert_eq!(host.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn lost_receipt_capability_after_crash_is_uncertain_not_replayed() {
    let temp = tempfile::tempdir().unwrap();
    killed(temp.path(), false);
    let mut fake = Host::new();
    fake.unavailable = true;
    let host = Arc::new(fake);
    let g = Gateway::open(temp.path(), "h".into(), host.clone()).unwrap();
    let d = g.pending().await.unwrap().remove(0);
    let result = g.dispatch(&d.key).await.unwrap();
    assert_eq!(result.state, DeliveryState::Uncertain);
    assert_eq!(result.reason.as_deref(), Some("host-receipt-unavailable"));
    assert_eq!(host.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn revoke_linearizes_after_inflight_admission_then_denies_every_new_call() {
    let mut fake = Host::new();
    fake.block = Semaphore::new(0);
    let host = Arc::new(fake);
    let (_temp, g) = setup(host.clone()).await;
    let d = accept(&g, prompt("before-revoke")).await;
    let worker = g.clone();
    let dispatch = tokio::spawn(async move { worker.dispatch(&d.key).await });
    host.entered.acquire().await.unwrap().forget();
    let admin = g.clone();
    let revoke = tokio::spawn(async move { admin.revoke("p").await });
    tokio::task::yield_now().await;
    assert!(!revoke.is_finished());
    host.block.add_permits(1);
    dispatch.await.unwrap().unwrap();
    revoke.await.unwrap().unwrap();
    assert!(matches!(
        g.accept("p", sender(), "private:42".into(), prompt("after-revoke"))
            .await,
        Err(Error::Unauthorized)
    ));
    assert_eq!(host.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn narrower_scope_invalidates_already_queued_permission_revision() {
    let host = Arc::new(Host::new());
    let (_temp, g) = setup(host.clone()).await;
    let d = accept(&g, prompt("scope-change")).await;
    let mut p = principal();
    p.revision = 2;
    p.sessions = BTreeSet::from(["s2".into()]);
    g.set_principal(p).await.unwrap();
    assert_eq!(
        g.dispatch(&d.key).await.unwrap().state,
        DeliveryState::Rejected
    );
    assert_eq!(host.calls.load(Ordering::SeqCst), 0);
}

#[cfg(unix)]
#[test]
fn rejects_dangling_journal_symlinks() {
    let root = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root.path().join("missing"),
        root.path().join("consumer.lock"),
    )
    .unwrap();
    assert!(matches!(
        Gateway::open(root.path(), "h".into(), Arc::new(Host::new())),
        Err(Error::Invalid(_))
    ));
}

#[tokio::test]
async fn oversized_result_is_bounded_durable_and_never_reruns_operation() {
    let mut fake = Host::new();
    fake.large_response = true;
    let host = Arc::new(fake);
    let (_temp, g) = setup(host.clone()).await;
    let mut input = prompt("large-history");
    input.command = Command::History {
        before_seq: None,
        max_messages: 1,
    };
    let delivery = accept(&g, input).await;
    let done = g.dispatch(&delivery.key).await.unwrap();
    assert_eq!(done.state, DeliveryState::Completed);
    assert_eq!(done.reason.as_deref(), Some("result-budget-exceeded"));
    assert!(matches!(done.result, Some(RpcResult::Failure { .. })));
    assert!(
        serde_json::to_vec(&g.inspect(&delivery.key).await.unwrap())
            .unwrap()
            .len()
            < 4096
    );
    g.dispatch(&delivery.key).await.unwrap();
    assert_eq!(host.calls.load(Ordering::SeqCst), 1);
}

fn account() -> Account {
    Account {
        channel: Channel::Telegram,
        id: "bot".into(),
    }
}
fn digest_payload() -> String {
    "a".repeat(64)
}
fn receive_prompt(id: &str) -> ReceiveInput {
    ReceiveInput::Command {
        principal: "p".into(),
        sender: sender(),
        conversation: "private:42".into(),
        inbound: Box::new(prompt(id)),
    }
}

#[tokio::test]
async fn receive_atomically_checkpoints_durable_intake_and_never_regresses_on_duplicate() {
    let host = Arc::new(Host::new());
    let (temp, g) = setup(host.clone()).await;
    let lease = g.acquire_account(account()).await.unwrap();
    let accepted = g
        .receive(
            lease.clone(),
            "update:1".into(),
            digest_payload(),
            "2".into(),
            receive_prompt("1"),
        )
        .await
        .unwrap();
    let ReceiveOutcome::Accepted { delivery_key } = accepted.outcome.clone() else {
        panic!("not admitted")
    };
    assert_eq!(
        g.inspect(&delivery_key).await.unwrap().unwrap().state,
        DeliveryState::Queued
    );
    assert_eq!(g.account_checkpoint(&lease).await.unwrap().cursor, "2");
    assert_eq!(
        g.receive(
            lease.clone(),
            "update:1".into(),
            digest_payload(),
            "0".into(),
            receive_prompt("1")
        )
        .await
        .unwrap(),
        accepted
    );
    assert_eq!(g.account_checkpoint(&lease).await.unwrap().cursor, "2");
    assert!(matches!(
        g.receive(
            lease,
            "update:2".into(),
            digest_payload(),
            "3".into(),
            receive_prompt("2")
        )
        .await,
        Err(Error::CursorConflict)
    ));
    g.close().await.unwrap();
    drop(g);
    let g = Gateway::open(temp.path(), "h".into(), host.clone()).unwrap();
    let restored = g.acquire_account(account()).await.unwrap();
    assert_eq!(restored.cursor, "2");
    g.dispatch(&delivery_key).await.unwrap();
    assert_eq!(host.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn poison_platform_payload_has_durable_rejection_before_cursor_advance() {
    let (_temp, g) = setup(Arc::new(Host::new())).await;
    let lease = g.acquire_account(account()).await.unwrap();
    let rejected = g
        .receive(
            lease.clone(),
            "bad:1".into(),
            digest_payload(),
            "2".into(),
            ReceiveInput::Reject {
                code: RejectionCode::Malformed,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        rejected.outcome,
        ReceiveOutcome::Rejected {
            code: RejectionCode::Malformed
        }
    );
    assert_eq!(g.account_checkpoint(&lease).await.unwrap().cursor, "2");
    assert!(g.pending().await.unwrap().is_empty());
    // A payload identity conflict cannot become a second disposition or move the cursor.
    assert!(matches!(
        g.receive(
            lease.clone(),
            "bad:1".into(),
            "b".repeat(64),
            "3".into(),
            ReceiveInput::Reject {
                code: RejectionCode::Unsupported
            }
        )
        .await,
        Err(Error::IdentityConflict)
    ));
    assert_eq!(g.account_checkpoint(&lease).await.unwrap().cursor, "2");
}

#[tokio::test]
async fn account_takeover_fences_late_input_and_checkpoints() {
    let (_temp, g) = setup(Arc::new(Host::new())).await;
    let old = g.acquire_account(account()).await.unwrap();
    let new = g.acquire_account(account()).await.unwrap();
    assert_eq!(new.generation, old.generation + 1);
    assert!(matches!(
        g.account_checkpoint(&old).await,
        Err(Error::StaleLease)
    ));
    assert!(matches!(
        g.receive(
            old,
            "late".into(),
            digest_payload(),
            "2".into(),
            receive_prompt("1")
        )
        .await,
        Err(Error::StaleLease)
    ));
    assert!(g.pending().await.unwrap().is_empty());
    assert_eq!(g.account_checkpoint(&new).await.unwrap().cursor, "");
}

#[tokio::test]
async fn terminal_permission_and_validation_rejection_are_distinct_from_backpressure() {
    let (_temp, g) = setup(Arc::new(Host::new())).await;
    let lease = g.acquire_account(account()).await.unwrap();
    g.revoke("p").await.unwrap();
    let forbidden = g
        .receive(
            lease.clone(),
            "1".into(),
            digest_payload(),
            "2".into(),
            receive_prompt("1"),
        )
        .await
        .unwrap();
    assert_eq!(
        forbidden.outcome,
        ReceiveOutcome::Rejected {
            code: RejectionCode::Forbidden
        }
    );
    let lease = g.account_checkpoint(&lease).await.unwrap();
    let mut invalid = prompt("2");
    invalid.command = Command::History {
        before_seq: None,
        max_messages: 0,
    };
    let result = g
        .receive(
            lease.clone(),
            "2".into(),
            digest_payload(),
            "3".into(),
            ReceiveInput::Command {
                principal: "p".into(),
                sender: sender(),
                conversation: "private:42".into(),
                inbound: Box::new(invalid),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        result.outcome,
        ReceiveOutcome::Rejected {
            code: RejectionCode::InvalidCommand
        }
    );
    let lease = g.account_checkpoint(&lease).await.unwrap();
    let mut oversize = prompt("3");
    oversize.command = Command::Prompt {
        mode: PromptMode::Queue,
        client_time_zone: None,
        content: vec![Content::File {
            media_type: "text/plain".into(),
            data: "A".repeat(6 * 1024 * 1024 + 1),
            name: None,
        }],
    };
    assert!(matches!(
        g.receive(
            lease.clone(),
            "3".into(),
            digest_payload(),
            "4".into(),
            ReceiveInput::Command {
                principal: "p".into(),
                sender: sender(),
                conversation: "private:42".into(),
                inbound: Box::new(oversize)
            }
        )
        .await,
        Err(Error::Capacity)
    ));
    assert_eq!(g.account_checkpoint(&lease).await.unwrap().cursor, "3");
}

#[tokio::test]
async fn uncertainty_resolution_is_audited_idempotent_terminal_and_never_replays() {
    let temp = tempfile::tempdir().unwrap();
    killed(temp.path(), true);
    let host = Arc::new(Host::new());
    let g = Gateway::open(temp.path(), "h".into(), host.clone()).unwrap();
    let d = g.pending().await.unwrap().remove(0);
    g.dispatch(&d.key).await.unwrap();
    let next = accept(&g, prompt("new-authorized-request")).await;
    let review = RecoveryReview {
        delivery_key: d.key.clone(),
        actor: "desktop-owner".into(),
        evidence_sha256: digest_payload(),
        resolution: RecoveryResolution::AbandonWithoutReplay,
    };
    let audit = g.resolve_uncertain(review.clone()).await.unwrap();
    assert_eq!(audit.current, DeliveryState::Abandoned);
    assert_eq!(g.resolve_uncertain(review.clone()).await.unwrap(), audit);
    assert_eq!(g.recovery_audit(&d.key).await.unwrap(), vec![audit]);
    let mut conflict = review;
    conflict.resolution = RecoveryResolution::ObservedAccepted;
    assert!(matches!(
        g.resolve_uncertain(conflict).await,
        Err(Error::IdentityConflict)
    ));
    g.dispatch(&d.key).await.unwrap();
    assert_eq!(host.calls.load(Ordering::SeqCst), 0);
    g.dispatch(&next.key).await.unwrap();
    assert_eq!(host.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn completed_delivery_cannot_be_rewritten_by_recovery_review() {
    let host = Arc::new(Host::new());
    let (_temp, g) = setup(host.clone()).await;
    let d = accept(&g, prompt("normal")).await;
    g.dispatch(&d.key).await.unwrap();
    let review = RecoveryReview {
        delivery_key: d.key.clone(),
        actor: "desktop-owner".into(),
        evidence_sha256: digest_payload(),
        resolution: RecoveryResolution::VerifiedNotApplied,
    };
    assert!(matches!(
        g.resolve_uncertain(review).await,
        Err(Error::Invalid(_))
    ));
    assert!(g.recovery_audit(&d.key).await.unwrap().is_empty());
}

#[tokio::test]
async fn explicit_close_fences_old_handles_and_cannot_unlock_a_new_consumer() {
    let host = Arc::new(Host::new());
    let (temp, g) = setup(host.clone()).await;
    let d = accept(&g, prompt("close")).await;
    let old = g.clone();
    g.close().await.unwrap();
    g.close().await.unwrap();
    assert!(matches!(old.inspect(&d.key).await, Err(Error::Closed)));
    assert!(matches!(
        old.set_principal(principal()).await,
        Err(Error::Closed)
    ));
    let new = Gateway::open(temp.path(), "h".into(), host.clone()).unwrap();
    assert_eq!(
        new.inspect(&d.key).await.unwrap().unwrap().state,
        DeliveryState::Queued
    );
    drop(g);
    drop(old);
    assert!(matches!(
        Gateway::open(temp.path(), "h".into(), host),
        Err(Error::ConsumerBusy)
    ));
    new.dispatch(&d.key).await.unwrap();
}

#[tokio::test]
async fn optional_native_fields_are_omitted_not_null_and_present_values_are_preserved() {
    let host = Arc::new(Host::new());
    let (_dir, g) = setup(host.clone()).await;
    for (id, zone, name) in [
        ("missing", None, None),
        ("present", Some("Asia/Shanghai"), Some("sample.txt")),
    ] {
        let mut inbound = prompt(id);
        inbound.command = Command::Prompt {
            mode: PromptMode::Queue,
            client_time_zone: zone.map(str::to_owned),
            content: vec![Content::File {
                media_type: "text/plain".into(),
                data: "Zml4dHVyZQ==".into(),
                name: name.map(str::to_owned),
            }],
        };
        let accepted = accept(&g, inbound).await;
        g.dispatch(&accepted.key).await.unwrap();
        let receipts = host.receipts.lock().unwrap();
        let payload = &receipts[&accepted.key].0;
        assert_eq!(
            payload.get("clientTimeZone"),
            zone.map(|z| json!(z)).as_ref()
        );
        assert_eq!(
            payload["content"][0].get("name"),
            name.map(|n| json!(n)).as_ref()
        );
    }
}

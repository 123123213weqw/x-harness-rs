//! Real native initial-policy journal + original creation proof + gateway WAL.
//! Disk reopen uses fresh Host/runtime/Store objects; no model or tool is called.
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tokio_util::sync::CancellationToken;
use xharness_api::{
    ApiBackend, ClientResponse, EventStream, RpcError, RpcId, RpcMethod, RpcReceipt, RpcResult,
    ScopedCataloguePage, ScopedCatalogueQuery, ScopedSessionCreate, ScopedSessionCreated,
};
use xharness_core::{
    IdentityContextPolicy, ModelProvider, ProviderError, ProviderRequest, ProviderStream,
};
use xharness_host::{AgentRuntime, BasicHost, DurableLoopAgentRuntime, HostConfig, NoTools};
use xharness_remote::*;
use xharness_session::{EventData, SessionHeader, Store};
use xharness_session_jsonl::JsonlSessionStore;
struct Root(PathBuf);
impl Root {
    fn new(name: &str) -> Self {
        let p =
            std::env::temp_dir().join(format!("xh-remote-creation-{name}-{}", std::process::id()));
        std::fs::create_dir_all(p.join("workspace")).unwrap();
        Self(p)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct Provider(AtomicUsize);
#[async_trait]
impl ModelProvider for Provider {
    fn provider_name(&self) -> &str {
        "fixture"
    }
    fn model_name(&self) -> Option<&str> {
        Some("fixture")
    }
    async fn stream(
        &self,
        _: ProviderRequest,
        _: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        panic!("creation must never call a model");
    }
}
fn native(root: &Root, store: Arc<dyn Store>, provider: Arc<Provider>) -> Arc<BasicHost> {
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "fixture",
        "fixture",
        Some(provider),
        Arc::new(NoTools),
        Arc::new(IdentityContextPolicy),
        store,
        Arc::new(xharness_agent::MemoryLeaseManager::default()),
        64,
    ));
    let mut config = HostConfig::new(root.0.join("workspace"));
    config.provider_id = "fixture".into();
    config.model_id = "fixture".into();
    config.auto_titles = false;
    BasicHost::with_agent_runtime(config, runtime)
}
struct LostAck {
    host: Arc<BasicHost>,
    calls: Arc<AtomicUsize>,
}
#[async_trait]
impl ApiBackend for LostAck {
    async fn call(&self, _: RpcId, _: RpcMethod, _: Value, _: CancellationToken) -> RpcResult {
        panic!("gateway cannot use generic native RPC for creation");
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("creation cannot answer native interaction");
    }
    fn mux_events(&self) -> EventStream {
        panic!("no global stream");
    }
    fn host_events(&self) -> EventStream {
        panic!("no global stream");
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
        self.host.session_in_workspace(w, s).await
    }
    async fn scoped_catalogue(
        &self,
        q: ScopedCatalogueQuery,
    ) -> Result<ScopedCataloguePage, RpcError> {
        self.host.scoped_catalogue(q).await
    }
    async fn create_scoped_session(
        &self,
        r: ScopedSessionCreate,
    ) -> Result<ScopedSessionCreated, RpcError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.host.create_scoped_session(r).await?;
        Err(RpcError::internal(
            "fixture lost acknowledgement after native flush",
        ))
    }
    async fn scoped_session_creation_receipt(
        &self,
        r: ScopedSessionCreate,
    ) -> Result<Option<ScopedSessionCreated>, RpcError> {
        self.host.scoped_session_creation_receipt(r).await
    }
}
#[tokio::test]
async fn disk_native_creation_lost_ack_and_full_host_gateway_reopen_preserve_original_proof_without_model(
) {
    let root = Root::new("restart");
    let store = Arc::new(JsonlSessionStore::new(root.0.join("sessions")).unwrap());
    let provider = Arc::new(Provider(AtomicUsize::new(0)));
    let host = native(&root, store.clone(), provider.clone());
    assert!(matches!(
        host.call(
            RpcId::new("baseline"),
            RpcMethod::SessionCreate,
            json!({"workspaceId":"workspace-default","sessionId":"baseline"}),
            CancellationToken::new()
        )
        .await,
        RpcResult::Success { .. }
    ));
    let calls = Arc::new(AtomicUsize::new(0));
    let adapter = Arc::new(LostAck {
        host: host.clone(),
        calls: calls.clone(),
    });
    let gateway = Gateway::open(&root.0.join("remote"), "host".into(), adapter.clone()).unwrap();
    let sender = Sender {
        channel: Channel::MobileWeb,
        account: "paired".into(),
        user: "user".into(),
    };
    gateway
        .set_principal(Principal {
            id: "p".into(),
            host: "host".into(),
            sender: sender.clone(),
            workspaces: ["workspace-default".into()].into(),
            sessions: ["baseline".into()].into(),
            revision: 1,
            revoked: false,
        })
        .await
        .unwrap();
    gateway
        .bind(Binding {
            id: "b".into(),
            principal: "p".into(),
            conversation: "user".into(),
            workspace: "workspace-default".into(),
            session: "baseline".into(),
            generation: 1,
        })
        .await
        .unwrap();
    gateway
        .set_creation_policy(CreationPolicy {
            principal: "p".into(),
            principal_revision: 1,
            generation: 1,
            workspaces: ["workspace-default".into()].into(),
        })
        .await
        .unwrap();
    let scope = Subscription {
        principal: "p".into(),
        sender,
        conversation: "user".into(),
        binding: "b".into(),
        generation: 1,
    };
    let request = SessionCreationRequest {
        request_id: "native-lost-ack".into(),
        workspace: "workspace-default".into(),
    };
    let uncertain = gateway
        .controller_create(scope.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(uncertain.state, SessionCreationState::Uncertain);
    assert!(uncertain.created.is_none());
    assert_eq!(
        gateway
            .controller_catalogue(scope.clone(), None)
            .await
            .unwrap()
            .catalogue
            .sessions
            .len(),
        1
    );
    let session_id = format!("remote-{}", uncertain.key);
    let durable = store.load(&session_id).await.unwrap().unwrap();
    assert!(durable.events().iter().any(|e|matches!(e.data(),EventData::SessionMutationCommitted {receipt} if receipt.rpc_id==format!("remote-create-{}",uncertain.key))));
    assert!(!durable
        .events()
        .iter()
        .any(|e| matches!(e.data(), EventData::UserMessage { .. })));
    let original = durable.inspect();
    gateway.close().await.unwrap();
    drop(gateway);
    drop(adapter);
    drop(host);
    drop(store);
    let store = Arc::new(JsonlSessionStore::new(root.0.join("sessions")).unwrap());
    let host = native(&root, store.clone(), provider.clone());
    host.restore_from_store(store.clone()).await.unwrap();
    let adapter = Arc::new(LostAck {
        host: host.clone(),
        calls: calls.clone(),
    });
    let gateway = Gateway::open(&root.0.join("remote"), "host".into(), adapter).unwrap();
    let granted = gateway
        .controller_create(scope.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(granted.state, SessionCreationState::Granted);
    assert_eq!(granted.key, uncertain.key);
    assert_eq!(granted.granted_revision, Some(2));
    assert_eq!(granted.principal_revision, 1);
    assert_eq!(granted.binding.session, "baseline");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        store.load(&session_id).await.unwrap().unwrap().inspect(),
        original
    );
    for _ in 0..5 {
        assert_eq!(
            gateway
                .controller_create(scope.clone(), request.clone())
                .await
                .unwrap(),
            granted
        );
    }
    let selected = gateway
        .controller_select(
            scope.clone(),
            SessionSelection {
                workspace: "workspace-default".into(),
                session: session_id.clone(),
            },
        )
        .await
        .unwrap();
    assert_eq!(selected.generation, 2);
    assert_eq!(provider.0.load(Ordering::SeqCst), 0);
    gateway.close().await.unwrap();
}
#[tokio::test]
async fn native_scoped_create_never_adopts_collision_partial_header_or_foreign_workspace() {
    let root = Root::new("collision");
    let store = Arc::new(JsonlSessionStore::new(root.0.join("sessions")).unwrap());
    let provider = Arc::new(Provider(AtomicUsize::new(0)));
    let host = native(&root, store.clone(), provider.clone());
    let request = |c: char| ScopedSessionCreate {
        workspace: "workspace-default".into(),
        request_key: c.to_string().repeat(64),
    };
    let collision = request('a');
    assert!(matches!(
        host.call(
            RpcId::new("desktop"),
            RpcMethod::SessionCreate,
            json!({"workspaceId":"workspace-default","sessionId":collision.session_id()}),
            CancellationToken::new()
        )
        .await,
        RpcResult::Success { .. }
    ));
    let before = store
        .load(&collision.session_id())
        .await
        .unwrap()
        .unwrap()
        .inspect();
    assert!(host
        .scoped_session_creation_receipt(collision.clone())
        .await
        .is_err());
    assert!(host.create_scoped_session(collision.clone()).await.is_err());
    assert_eq!(
        store
            .load(&collision.session_id())
            .await
            .unwrap()
            .unwrap()
            .inspect(),
        before
    );
    let partial = request('b');
    let mut header = SessionHeader::new(partial.session_id());
    header.cwd = Some(root.0.join("workspace").to_string_lossy().into_owned());
    store.create(header).await.unwrap();
    store.flush(&partial.session_id()).await.unwrap();
    assert!(host
        .scoped_session_creation_receipt(partial.clone())
        .await
        .is_err());
    assert!(host.create_scoped_session(partial.clone()).await.is_err());
    assert!(store
        .load(&partial.session_id())
        .await
        .unwrap()
        .unwrap()
        .events()
        .is_empty());
    let fresh = request('c');
    assert!(host
        .scoped_session_creation_receipt(fresh.clone())
        .await
        .unwrap()
        .is_none());
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..20 {
        let h = host.clone();
        let r = fresh.clone();
        tasks.spawn(async move { h.create_scoped_session(r).await.unwrap() });
    }
    while let Some(r) = tasks.join_next().await {
        assert_eq!(r.unwrap(), fresh.receipt());
    }
    let durable = store.load(&fresh.session_id()).await.unwrap().unwrap();
    assert_eq!(
        durable
            .events()
            .iter()
            .filter(|e| matches!(e.data(), EventData::SessionMutationCommitted { .. }))
            .count(),
        1
    );
    let mut wrong = fresh.clone();
    wrong.workspace = "unregistered".into();
    assert!(host
        .scoped_session_creation_receipt(wrong.clone())
        .await
        .is_err());
    assert!(host.create_scoped_session(wrong).await.is_err());
    let mut invalid = fresh.clone();
    invalid.request_key = "C".repeat(64);
    assert!(host.create_scoped_session(invalid).await.is_err());
    assert!(matches!(
        host.call(
            RpcId::new("archive"),
            RpcMethod::WorkspaceArchiveSession,
            json!({"sessionId":fresh.session_id()}),
            CancellationToken::new()
        )
        .await,
        RpcResult::Success { .. }
    ));
    assert!(host
        .scoped_session_creation_receipt(fresh.clone())
        .await
        .is_err());
    assert!(host.create_scoped_session(fresh).await.is_err());
    assert_eq!(provider.0.load(Ordering::SeqCst), 0);
}

struct FlushStore {
    inner: JsonlSessionStore,
    mode: AtomicUsize,
}
#[async_trait]
impl Store for FlushStore {
    async fn list_headers(&self) -> Result<Vec<SessionHeader>, xharness_session::StoreError> {
        self.inner.list_headers().await
    }
    async fn create(
        &self,
        h: SessionHeader,
    ) -> Result<xharness_session::Session, xharness_session::StoreError> {
        self.inner.create(h).await
    }
    async fn load(
        &self,
        id: &str,
    ) -> Result<Option<xharness_session::Session>, xharness_session::StoreError> {
        self.inner.load(id).await
    }
    async fn append(
        &self,
        id: &str,
        revision: xharness_session::Revision,
        events: Vec<xharness_session::SessionEvent>,
    ) -> Result<xharness_session::AppendReceipt, xharness_session::StoreError> {
        self.inner.append(id, revision, events).await
    }
    async fn flush(
        &self,
        id: &str,
    ) -> Result<xharness_session::Revision, xharness_session::StoreError> {
        match self.mode.load(Ordering::SeqCst) {
            1 => Err(xharness_session::StoreError::Backend {
                message: "fixture durability barrier failed".into(),
            }),
            2 => Ok(xharness_session::Revision::ZERO),
            _ => self.inner.flush(id).await,
        }
    }
    async fn inspect(
        &self,
        id: &str,
    ) -> Result<Option<xharness_session::SessionInspection>, xharness_session::StoreError> {
        self.inner.inspect(id).await
    }
}
#[tokio::test]
async fn native_creation_visible_receipt_is_not_certified_until_flush_covers_its_revision() {
    let root = Root::new("flush");
    let store = Arc::new(FlushStore {
        inner: JsonlSessionStore::new(root.0.join("sessions")).unwrap(),
        mode: AtomicUsize::new(0),
    });
    let provider = Arc::new(Provider(AtomicUsize::new(0)));
    let host = native(&root, store.clone(), provider.clone());
    let request = ScopedSessionCreate {
        workspace: "workspace-default".into(),
        request_key: "d".repeat(64),
    };
    assert_eq!(
        host.create_scoped_session(request.clone()).await.unwrap(),
        request.receipt()
    );
    let original = store
        .load(&request.session_id())
        .await
        .unwrap()
        .unwrap()
        .inspect();
    for mode in [1, 2] {
        store.mode.store(mode, Ordering::SeqCst);
        assert!(host
            .scoped_session_creation_receipt(request.clone())
            .await
            .is_err());
        assert!(host.create_scoped_session(request.clone()).await.is_err());
        assert_eq!(
            store
                .load(&request.session_id())
                .await
                .unwrap()
                .unwrap()
                .inspect(),
            original
        );
    }
    store.mode.store(0, Ordering::SeqCst);
    assert_eq!(
        host.scoped_session_creation_receipt(request.clone())
            .await
            .unwrap(),
        Some(request.receipt())
    );
    assert_eq!(
        host.create_scoped_session(request.clone()).await.unwrap(),
        request.receipt()
    );
    assert_eq!(
        store
            .load(&request.session_id())
            .await
            .unwrap()
            .unwrap()
            .inspect(),
        original
    );
    let failed = ScopedSessionCreate {
        workspace: "workspace-default".into(),
        request_key: "e".repeat(64),
    };
    store.mode.store(1, Ordering::SeqCst);
    assert!(host.create_scoped_session(failed.clone()).await.is_err());
    let visible = store
        .load(&failed.session_id())
        .await
        .unwrap()
        .unwrap()
        .inspect();
    assert!(visible
        .events
        .iter()
        .any(|e| matches!(e.data(), EventData::SessionMutationCommitted { .. })));
    assert!(host
        .scoped_session_creation_receipt(failed.clone())
        .await
        .is_err());
    store.mode.store(2, Ordering::SeqCst);
    assert!(host
        .scoped_session_creation_receipt(failed.clone())
        .await
        .is_err());
    store.mode.store(0, Ordering::SeqCst);
    assert_eq!(
        host.scoped_session_creation_receipt(failed.clone())
            .await
            .unwrap(),
        Some(failed.receipt())
    );
    // A repaired durable proof is not itself registered target ownership.
    assert!(!host
        .session_in_workspace(&failed.workspace, &failed.session_id())
        .await
        .unwrap());
    drop(host);
    let host = native(&root, store.clone(), provider.clone());
    host.restore_from_store(store.clone()).await.unwrap();
    assert!(host
        .session_in_workspace(&failed.workspace, &failed.session_id())
        .await
        .unwrap());
    assert_eq!(
        host.create_scoped_session(failed.clone()).await.unwrap(),
        failed.receipt()
    );
    assert_eq!(
        store
            .load(&failed.session_id())
            .await
            .unwrap()
            .unwrap()
            .inspect(),
        visible
    );
    assert_eq!(provider.0.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn complete_desktop_grant_native_catalogue_creation_and_disk_reopen_need_no_model() {
    let root = Root::new("complete-grant");
    let store = Arc::new(JsonlSessionStore::new(root.0.join("sessions")).unwrap());
    let provider = Arc::new(Provider(AtomicUsize::new(0)));
    let host = native(&root, store.clone(), provider.clone());
    for n in 0..32 {
        assert!(matches!(
            host.call(
                RpcId::new(format!("baseline-{n}")),
                RpcMethod::SessionCreate,
                json!({"workspaceId":"workspace-default","sessionId":format!("s-{n:02}")}),
                CancellationToken::new()
            )
            .await,
            RpcResult::Success { .. }
        ));
    }
    let calls = Arc::new(AtomicUsize::new(0));
    let adapter = Arc::new(LostAck {
        host: host.clone(),
        calls: calls.clone(),
    });
    let g = Gateway::open(&root.0.join("remote"), "host".into(), adapter.clone()).unwrap();
    let sender = Sender {
        channel: Channel::Telegram,
        account: "123".into(),
        user: "42".into(),
    };
    let mut p = Principal {
        id: "p".into(),
        host: "host".into(),
        sender: sender.clone(),
        workspaces: ["workspace-default".into()].into(),
        sessions: (0..32).map(|n| format!("s-{n:02}")).collect(),
        revision: 1,
        revoked: false,
    };
    let mut b = Binding {
        id: "b".into(),
        principal: "p".into(),
        conversation: "42".into(),
        workspace: "workspace-default".into(),
        session: "s-00".into(),
        generation: 1,
    };
    let mut policy = CreationPolicy {
        principal: "p".into(),
        principal_revision: 1,
        generation: 1,
        workspaces: Default::default(),
    };
    let first = g
        .configure_private_scopes(p.clone(), b.clone(), Some(policy.clone()))
        .await
        .unwrap();
    assert_eq!(first.principal.sessions.len(), 32);
    let mut scope = Subscription {
        principal: "p".into(),
        sender,
        conversation: "42".into(),
        binding: "b".into(),
        generation: 1,
    };
    let request = SessionCreationRequest {
        request_id: "complete-grant-create".into(),
        workspace: "workspace-default".into(),
    };
    assert!(matches!(
        g.controller_create(scope.clone(), request.clone()).await,
        Err(Error::Unauthorized)
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    p.revision = 2;
    b.generation = 2;
    policy.principal_revision = 2;
    policy.generation = 2;
    policy.workspaces = p.workspaces.clone();
    g.configure_private_scopes(p, b, Some(policy))
        .await
        .unwrap();
    scope.generation = 2;
    let uncertain = g
        .controller_create(scope.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(uncertain.state, SessionCreationState::Uncertain);
    let granted = g
        .controller_create(scope.clone(), request.clone())
        .await
        .unwrap();
    assert_eq!(granted.state, SessionCreationState::Granted);
    assert_eq!(granted.granted_revision, Some(3));
    let entry = g.grant_page(None).await.unwrap().items.remove(0);
    assert_eq!(entry.principal.sessions.len(), 33);
    assert_eq!(entry.bindings[0].session, "s-00");
    assert_eq!(entry.bindings[0].generation, 2);
    assert_eq!(
        entry.creation_policy.as_ref().unwrap().principal_revision,
        3
    );
    assert_eq!(entry.creation_policy.as_ref().unwrap().generation, 2);
    // A now-archived allowed ID cannot pass a complete authoritative edit.
    assert!(matches!(
        host.call(
            RpcId::new("archive-grant"),
            RpcMethod::WorkspaceArchiveSession,
            json!({"workspaceId":"workspace-default","sessionId":"s-31"}),
            CancellationToken::new()
        )
        .await,
        RpcResult::Success { .. }
    ));
    let mut next_p = entry.principal.clone();
    next_p.revision = 4;
    let mut next_b = entry.bindings[0].clone();
    next_b.generation = 3;
    let mut next_policy = entry.creation_policy.clone().unwrap();
    next_policy.principal_revision = 4;
    next_policy.generation = 3;
    assert!(matches!(
        g.configure_private_scopes(next_p, next_b, Some(next_policy))
            .await,
        Err(Error::Unauthorized)
    ));
    assert_eq!(
        g.grant_page(None).await.unwrap().items.as_slice(),
        std::slice::from_ref(&entry)
    );
    g.close().await.unwrap();
    drop(g);
    drop(adapter);
    drop(host);
    drop(store);
    let store = Arc::new(JsonlSessionStore::new(root.0.join("sessions")).unwrap());
    let host = native(&root, store.clone(), provider.clone());
    host.restore_from_store(store).await.unwrap();
    let g = Gateway::open(
        &root.0.join("remote"),
        "host".into(),
        Arc::new(LostAck {
            host,
            calls: calls.clone(),
        }),
    )
    .unwrap();
    assert_eq!(g.grant_page(None).await.unwrap().items, [entry]);
    assert_eq!(g.controller_create(scope, request).await.unwrap(), granted);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(provider.0.load(Ordering::SeqCst), 0);
    g.close().await.unwrap();
}

struct CatalogueBackend {
    host: Arc<BasicHost>,
    reads: Arc<AtomicUsize>,
}
#[async_trait]
impl ApiBackend for CatalogueBackend {
    async fn call(&self, _: RpcId, _: RpcMethod, _: Value, _: CancellationToken) -> RpcResult {
        panic!("normalized catalogue cannot use generic native RPC");
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("no catalogue interaction");
    }
    fn mux_events(&self) -> EventStream {
        panic!("no global catalogue stream");
    }
    fn host_events(&self) -> EventStream {
        panic!("no global catalogue stream");
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
        self.host.session_in_workspace(w, s).await
    }
    async fn session_event_page(
        &self,
        w: &str,
        s: &str,
        after: Option<u64>,
    ) -> Result<xharness_api::ScopedEventPage, RpcError> {
        self.host.session_event_page(w, s, after).await
    }
    async fn scoped_catalogue(
        &self,
        q: ScopedCatalogueQuery,
    ) -> Result<ScopedCataloguePage, RpcError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.host.scoped_catalogue(q).await
    }
}
#[derive(Clone, Default)]
struct CatalogueHttp {
    updates: Arc<std::sync::Mutex<Vec<Value>>>,
    requests: Arc<std::sync::Mutex<Vec<(String, Value)>>>,
    fail_send: Arc<std::sync::atomic::AtomicBool>,
}
impl CatalogueHttp {
    fn count(&self, method: &str) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| m == method)
            .count()
    }
}
async fn catalogue_http(
    axum::extract::State(data): axum::extract::State<CatalogueHttp>,
    axum::extract::OriginalUri(uri): axum::extract::OriginalUri,
    axum::Json(payload): axum::Json<Value>,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    let method = uri.path().rsplit('/').next().unwrap();
    data.requests
        .lock()
        .unwrap()
        .push((method.into(), payload.clone()));
    let value = match method {
        "getMe" => json!({"ok":true,"result":{"id":123456,"is_bot":true}}),
        "getWebhookInfo" => json!({"ok":true,"result":{"url":""}}),
        "getUpdates" => {
            json!({"ok":true,"result":data.updates.lock().unwrap().iter().filter(|u|payload["offset"].as_u64().is_none_or(|offset|u["update_id"].as_u64().unwrap()>=offset)).cloned().collect::<Vec<_>>()})
        }
        "sendMessage" if data.fail_send.load(Ordering::SeqCst) => {
            return (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(json!({"ok":false,"error_code":500})),
            )
        }
        "sendMessage" => {
            json!({"ok":true,"result":{"message_id":199+data.count("sendMessage"),"chat":{"id":payload["chat_id"],"type":"private"}}})
        }
        _ => panic!("unexpected catalogue provider method"),
    };
    (axum::http::StatusCode::OK, axum::Json(value))
}
struct CatalogueServer(tokio::task::JoinHandle<()>);
impl Drop for CatalogueServer {
    fn drop(&mut self) {
        self.0.abort();
    }
}
#[tokio::test]
async fn native_catalogue_telegram_intake_reply_failure_reopen_and_next_page_never_call_model() {
    use xharness_channel_telegram::{format_command_reply, BotToken, Client, Intake, Replies};
    let root = Root::new("catalogue-command");
    let store = Arc::new(JsonlSessionStore::new(root.0.join("sessions")).unwrap());
    let provider = Arc::new(Provider(AtomicUsize::new(0)));
    let host = native(&root, store.clone(), provider.clone());
    let ids: std::collections::BTreeSet<String> = (0..30).map(|n| format!("s-{n:02}")).collect();
    for id in &ids {
        assert!(matches!(
            host.call(
                RpcId::new(format!("baseline-{id}")),
                RpcMethod::SessionCreate,
                json!({"workspaceId":"workspace-default","sessionId":id}),
                CancellationToken::new()
            )
            .await,
            RpcResult::Success { .. }
        ));
    }
    let mut journals = vec![];
    for id in &ids {
        journals.push((id.clone(), store.load(id).await.unwrap().unwrap().inspect()));
    }
    let reads = Arc::new(AtomicUsize::new(0));
    let backend = Arc::new(CatalogueBackend {
        host: host.clone(),
        reads: reads.clone(),
    });
    let g = Gateway::open(&root.0.join("remote"), "host".into(), backend.clone()).unwrap();
    let sender = Sender {
        channel: Channel::Telegram,
        account: "123456".into(),
        user: "42".into(),
    };
    g.configure_private_scopes(
        Principal {
            id: "p".into(),
            host: "host".into(),
            sender: sender.clone(),
            workspaces: ["workspace-default".into()].into(),
            sessions: ids,
            revision: 1,
            revoked: false,
        },
        Binding {
            id: "b".into(),
            principal: "p".into(),
            conversation: "42".into(),
            workspace: "workspace-default".into(),
            session: "s-00".into(),
            generation: 1,
        },
        Some(CreationPolicy {
            principal: "p".into(),
            principal_revision: 1,
            generation: 1,
            workspaces: Default::default(),
        }),
    )
    .await
    .unwrap();
    reads.store(0, Ordering::SeqCst);
    let scope = Subscription {
        principal: "p".into(),
        sender,
        conversation: "42".into(),
        binding: "b".into(),
        generation: 1,
    };
    let message = |id: u64, text: &str| json!({"update_id":id,"message":{"message_id":id,"from":{"id":42,"is_bot":false},"chat":{"id":42,"type":"private"},"text":text}});
    let data = CatalogueHttp::default();
    data.updates.lock().unwrap().push(message(10, "/sessions"));
    data.fail_send.store(true, Ordering::SeqCst);
    let app = axum::Router::new()
        .route("/{*path}", axum::routing::post(catalogue_http))
        .with_state(data.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let _server = CatalogueServer(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    }));
    let client = Arc::new(
        Client::loopback_fixture(
            BotToken::new("123456:fixture-catalogue-native-only".into()).unwrap(),
            &format!("http://{addr}"),
        )
        .unwrap(),
    );
    let mut intake = Intake::connect(client.clone(), g.clone(), 123456)
        .await
        .unwrap();
    let receipts = intake.poll_once(0).await.unwrap();
    assert_eq!(receipts.len(), 1);
    let ReceiveOutcome::Accepted { delivery_key } = &receipts[0].outcome else {
        panic!("durable acceptance");
    };
    let key = delivery_key.clone();
    assert_eq!(intake.lease().cursor, "11");
    assert_eq!(reads.load(Ordering::SeqCst), 0);
    let done = g.dispatch(&key).await.unwrap();
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    let plans = format_command_reply(&done).unwrap();
    assert_eq!(plans.len(), 1);
    let text = &plans[0].body.text;
    assert!(text.contains("Session ID: s-00"));
    assert!(text.contains("Session ID: s-24"));
    assert!(!text.contains("Session ID: s-25"));
    assert!(text.ends_with(
        "Next page: /sessions {\"workspace\":\"workspace-default\",\"session\":\"s-24\"}"
    ));
    assert!(!text.contains(root.0.to_str().unwrap()));
    let lease = intake.lease();
    let records = g
        .enqueue_command_replies(&lease, scope.clone(), done.clone(), plans.clone())
        .await
        .unwrap();
    let transport = Arc::new(Replies::connect(client.clone(), 123456).await.unwrap());
    let failed = g
        .deliver_reply(
            lease,
            &records[0].key,
            transport.clone(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(failed.state, ReplyState::Uncertain);
    assert_eq!(data.count("sendMessage"), 1);
    assert!(g
        .command_reply_candidate(&intake.lease(), scope.clone())
        .await
        .unwrap()
        .is_none());
    for (id, original) in &journals {
        assert_eq!(store.load(id).await.unwrap().unwrap().inspect(), *original);
    }
    g.close().await.unwrap();
    drop(intake);
    drop(g);
    drop(backend);
    drop(host);
    drop(store);
    let store = Arc::new(JsonlSessionStore::new(root.0.join("sessions")).unwrap());
    let host = native(&root, store.clone(), provider.clone());
    host.restore_from_store(store.clone()).await.unwrap();
    let g = Gateway::open(
        &root.0.join("remote"),
        "host".into(),
        Arc::new(CatalogueBackend {
            host,
            reads: reads.clone(),
        }),
    )
    .unwrap();
    let mut intake = Intake::connect(client, g.clone(), 123456).await.unwrap();
    assert_eq!(intake.lease().cursor, "11");
    assert!(intake.poll_once(0).await.unwrap().is_empty());
    assert_eq!(g.dispatch(&key).await.unwrap(), done);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert!(g
        .command_reply_candidate(&intake.lease(), scope.clone())
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        g.enqueue_command_replies(&intake.lease(), scope.clone(), done, plans)
            .await
            .unwrap(),
        vec![failed.clone()]
    );
    assert_eq!(
        g.deliver_reply(
            intake.lease(),
            &failed.key,
            transport.clone(),
            CancellationToken::new()
        )
        .await
        .unwrap()
        .state,
        ReplyState::Uncertain
    );
    assert_eq!(data.count("sendMessage"), 1);
    data.updates.lock().unwrap().extend([message(11,"/sessions {\"workspace\":\"workspace-default\",\"session\":\"s-24\"}"),message(12,"/sessions {\"workspace\":\"workspace-default\",\"session\":\"s-24\",\"cwd\":\"PRIVATE_PATH\"}")]);
    let receipts = intake.poll_once(0).await.unwrap();
    assert_eq!(receipts.len(), 2);
    assert_eq!(intake.lease().cursor, "13");
    assert_eq!(
        receipts[1].outcome,
        ReceiveOutcome::Rejected {
            code: RejectionCode::InvalidCommand
        }
    );
    let ReceiveOutcome::Accepted { delivery_key } = &receipts[0].outcome else {
        panic!("next page");
    };
    let next = g.dispatch(delivery_key).await.unwrap();
    let plans = format_command_reply(&next).unwrap();
    assert_eq!(plans.len(), 1);
    assert!(plans[0].body.text.contains("Session ID: s-25"));
    assert!(plans[0].body.text.contains("Session ID: s-29"));
    assert!(!plans[0].body.text.contains("Session ID: s-24"));
    assert!(plans[0].body.text.ends_with("End of this session listing."));
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    let records = g
        .enqueue_command_replies(&intake.lease(), scope, next, plans)
        .await
        .unwrap();
    assert!(matches!(
        g.deliver_reply(
            intake.lease(),
            &records[0].key,
            transport.clone(),
            CancellationToken::new()
        )
        .await,
        Err(Error::ReplyBlocked)
    ));
    assert_eq!(data.count("sendMessage"), 1);
    g.resolve_reply(ReplyReview {
        key: failed.key,
        actor: "authenticated-desktop".into(),
        evidence_sha256: "a".repeat(64),
        resolution: ReplyResolution::AbandonWithoutReplay,
    })
    .await
    .unwrap();
    data.fail_send.store(false, Ordering::SeqCst);
    assert_eq!(
        g.deliver_reply(
            intake.lease(),
            &records[0].key,
            transport,
            CancellationToken::new()
        )
        .await
        .unwrap()
        .state,
        ReplyState::Delivered
    );
    assert_eq!(data.count("sendMessage"), 2);
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    assert_eq!(provider.0.load(Ordering::SeqCst), 0);
    for (id, original) in &journals {
        assert_eq!(store.load(id).await.unwrap().unwrap().inspect(), *original);
    }
    g.close().await.unwrap();
}

#[tokio::test]
async fn native_telegram_selection_atomic_route_receipt_output_resume_and_reopen_never_call_model()
{
    use xharness_channel_telegram::{
        format_command_reply, format_output, BotToken, Client, Intake, Replies,
    };
    let root = Root::new("selection-command");
    let store = Arc::new(JsonlSessionStore::new(root.0.join("sessions")).unwrap());
    let provider = Arc::new(Provider(AtomicUsize::new(0)));
    let host = native(&root, store.clone(), provider.clone());
    for id in ["first", "second"] {
        assert!(matches!(
            host.call(
                RpcId::new(format!("initialize-{id}")),
                RpcMethod::SessionCreate,
                json!({"workspaceId":"workspace-default","sessionId":id}),
                CancellationToken::new()
            )
            .await,
            RpcResult::Success { .. }
        ));
    }
    let journals = [
        (
            "first",
            store.load("first").await.unwrap().unwrap().inspect(),
        ),
        (
            "second",
            store.load("second").await.unwrap().unwrap().inspect(),
        ),
    ];
    let reads = Arc::new(AtomicUsize::new(0));
    let backend = Arc::new(CatalogueBackend {
        host: host.clone(),
        reads: reads.clone(),
    });
    let g = Gateway::open(&root.0.join("remote"), "host".into(), backend.clone()).unwrap();
    let sender = Sender {
        channel: Channel::Telegram,
        account: "123456".into(),
        user: "42".into(),
    };
    g.configure_private_scopes(
        Principal {
            id: "p".into(),
            host: "host".into(),
            sender: sender.clone(),
            workspaces: ["workspace-default".into()].into(),
            sessions: ["first".into(), "second".into()].into(),
            revision: 1,
            revoked: false,
        },
        Binding {
            id: "b".into(),
            principal: "p".into(),
            conversation: "42".into(),
            workspace: "workspace-default".into(),
            session: "first".into(),
            generation: 1,
        },
        Some(CreationPolicy {
            principal: "p".into(),
            principal_revision: 1,
            generation: 1,
            workspaces: Default::default(),
        }),
    )
    .await
    .unwrap();
    reads.store(0, Ordering::SeqCst);
    let scope = Subscription {
        principal: "p".into(),
        sender,
        conversation: "42".into(),
        binding: "b".into(),
        generation: 1,
    };
    let message = |id: u64, text: &str| json!({"update_id":id,"message":{"message_id":id,"from":{"id":42,"is_bot":false},"chat":{"id":42,"type":"private"},"text":text}});
    let data = CatalogueHttp::default();
    data.updates.lock().unwrap().push(message(
        10,
        "/select {\"workspace\":\"workspace-default\",\"session\":\"second\"}",
    ));
    let app = axum::Router::new()
        .route("/{*path}", axum::routing::post(catalogue_http))
        .with_state(data.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let _server = CatalogueServer(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    }));
    let client = Arc::new(
        Client::loopback_fixture(
            BotToken::new("123456:fixture-native-selection-only".into()).unwrap(),
            &format!("http://{addr}"),
        )
        .unwrap(),
    );
    let mut intake = Intake::connect(client.clone(), g.clone(), 123456)
        .await
        .unwrap();
    let lease = intake.lease();
    // Consume the actual native metadata events once before leaving first.
    let cp = g
        .projection_checkpoint(&lease, scope.clone())
        .await
        .unwrap();
    let page = g
        .read_event_page(&lease, scope.clone(), Some(cp.next_seq))
        .await
        .unwrap();
    let first_end = page.next_seq;
    assert!(first_end > 0);
    g.advance_projection(
        &lease,
        scope.clone(),
        cp,
        format_output(
            &g.projection_checkpoint(&lease, scope.clone())
                .await
                .unwrap(),
            &page,
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let receipts = intake.poll_once(0).await.unwrap();
    let ReceiveOutcome::Accepted { delivery_key } = &receipts[0].outcome else {
        panic!("selection admission");
    };
    let key = delivery_key.clone();
    let original = g.inspect(&key).await.unwrap().unwrap();
    let done = g.dispatch(&key).await.unwrap();
    assert_eq!(done.binding, original.binding);
    assert_eq!(done.inbound, original.inbound);
    assert_eq!(done.state, DeliveryState::Completed);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    let target_scope = Subscription {
        generation: 2,
        ..scope.clone()
    };
    assert_eq!(
        g.command_reply_candidate(&intake.lease(), target_scope.clone())
            .await
            .unwrap(),
        Some(done.clone())
    );
    assert!(matches!(
        g.command_reply_candidate(&intake.lease(), scope.clone())
            .await,
        Err(Error::Unauthorized)
    ));
    // Restart before result consumption: commit proof alone carries reply scope.
    g.close().await.unwrap();
    drop(intake);
    drop(g);
    drop(backend);
    drop(host);
    drop(store);
    let store = Arc::new(JsonlSessionStore::new(root.0.join("sessions")).unwrap());
    let host = native(&root, store.clone(), provider.clone());
    host.restore_from_store(store.clone()).await.unwrap();
    let backend = Arc::new(CatalogueBackend {
        host: host.clone(),
        reads: reads.clone(),
    });
    let g = Gateway::open(&root.0.join("remote"), "host".into(), backend).unwrap();
    let mut intake = Intake::connect(client.clone(), g.clone(), 123456)
        .await
        .unwrap();
    assert!(intake.poll_once(0).await.unwrap().is_empty());
    assert_eq!(intake.lease().cursor, "11");
    assert_eq!(g.dispatch(&key).await.unwrap(), done);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    let lease = intake.lease();
    let plans = format_command_reply(&done).unwrap();
    assert!(plans[0].body.text.contains("Session ID: second"));
    assert!(!plans[0].body.text.contains(root.0.to_str().unwrap()));
    let outgoing = g
        .enqueue_command_replies(&lease, target_scope.clone(), done.clone(), plans.clone())
        .await
        .unwrap();
    assert_eq!(outgoing[0].binding.session, "second");
    assert_eq!(outgoing[0].binding.generation, 2);
    let transport = Arc::new(Replies::connect(client.clone(), 123456).await.unwrap());
    data.fail_send.store(true, Ordering::SeqCst);
    assert_eq!(
        g.deliver_reply(
            lease.clone(),
            &outgoing[0].key,
            transport.clone(),
            CancellationToken::new()
        )
        .await
        .unwrap()
        .state,
        ReplyState::Uncertain
    );
    assert_eq!(
        g.enqueue_command_replies(&lease, target_scope.clone(), done.clone(), plans)
            .await
            .unwrap(),
        vec![g.inspect_reply(&outgoing[0].key).await.unwrap().unwrap()]
    );
    data.updates.lock().unwrap().push(message(
        11,
        "/select {\"workspace\":\"workspace-default\",\"session\":\"first\"}",
    ));
    let receipts = intake.poll_once(0).await.unwrap();
    let ReceiveOutcome::Accepted { delivery_key } = &receipts[0].outcome else {
        panic!("back selection");
    };
    let back = g.dispatch(delivery_key).await.unwrap();
    let back_scope = Subscription {
        generation: 3,
        ..scope
    };
    let resumed = g
        .projection_checkpoint(&intake.lease(), back_scope.clone())
        .await
        .unwrap();
    assert_eq!(resumed.next_seq, first_end);
    assert!(resumed.links.is_empty() && resumed.pending.is_empty());
    assert!(g
        .read_event_page(&intake.lease(), back_scope.clone(), Some(resumed.next_seq))
        .await
        .unwrap()
        .events
        .is_empty());
    let batch = g
        .enqueue_command_replies(
            &intake.lease(),
            back_scope.clone(),
            back.clone(),
            format_command_reply(&back).unwrap(),
        )
        .await
        .unwrap();
    assert!(matches!(
        g.deliver_reply(
            intake.lease(),
            &batch[0].key,
            transport,
            CancellationToken::new()
        )
        .await,
        Err(Error::ReplyBlocked)
    ));
    assert!(g
        .enqueue_command_replies(
            &intake.lease(),
            back_scope,
            done.clone(),
            format_command_reply(&done).unwrap()
        )
        .await
        .is_err());
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    assert_eq!(data.count("sendMessage"), 1);
    assert_eq!(intake.lease().cursor, "12");
    assert_eq!(provider.0.load(Ordering::SeqCst), 0);
    for (id, original) in &journals {
        assert_eq!(store.load(id).await.unwrap().unwrap().inspect(), *original);
    }
    g.close().await.unwrap();
}

struct CommandCreateBackend {
    host: Arc<BasicHost>,
    creates: Arc<AtomicUsize>,
    proofs: Arc<AtomicUsize>,
    abrupt_cut: Option<(PathBuf, Arc<Provider>)>,
}
#[async_trait]
impl ApiBackend for CommandCreateBackend {
    async fn call(&self, _: RpcId, _: RpcMethod, _: Value, _: CancellationToken) -> RpcResult {
        panic!("creation cannot use generic RPC or Agent");
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("no creation response");
    }
    fn mux_events(&self) -> EventStream {
        panic!("no global mux");
    }
    fn host_events(&self) -> EventStream {
        panic!("no global events");
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
        self.host.session_in_workspace(w, s).await
    }
    async fn session_event_page(
        &self,
        w: &str,
        s: &str,
        after: Option<u64>,
    ) -> Result<xharness_api::ScopedEventPage, RpcError> {
        self.host.session_event_page(w, s, after).await
    }
    async fn scoped_catalogue(
        &self,
        q: ScopedCatalogueQuery,
    ) -> Result<ScopedCataloguePage, RpcError> {
        self.host.scoped_catalogue(q).await
    }
    async fn scoped_session_creation_receipt(
        &self,
        r: ScopedSessionCreate,
    ) -> Result<Option<ScopedSessionCreated>, RpcError> {
        self.proofs.fetch_add(1, Ordering::SeqCst);
        self.host.scoped_session_creation_receipt(r).await
    }
    async fn create_scoped_session(
        &self,
        r: ScopedSessionCreate,
    ) -> Result<ScopedSessionCreated, RpcError> {
        self.creates.fetch_add(1, Ordering::SeqCst);
        let created = self.host.create_scoped_session(r).await?;
        if let Some((root, provider)) = &self.abrupt_cut {
            assert_eq!(provider.0.load(Ordering::SeqCst), 0);
            std::fs::write(root.join("cut-evidence.json"),serde_json::to_vec(&json!({"nativeCreates":self.creates.load(Ordering::SeqCst),"modelCalls":0,"created":created})).unwrap()).unwrap();
            // Whole fixture process exits after the original native policy +
            // receipt durability barrier, before remote grant/result commit.
            // No destructors/shutdown run; this is not claimed as SIGKILL.
            std::process::exit(87);
        }
        Ok(created)
    }
}
#[tokio::test]
#[ignore = "subprocess helper invoked by native creation command abrupt-cut acceptance"]
async fn native_creation_command_abrupt_cut_worker() {
    let root = Root(PathBuf::from(
        std::env::var("XH_CREATION_COMMAND_CUT_ROOT").unwrap(),
    ));
    let store = Arc::new(JsonlSessionStore::new(root.0.join("sessions")).unwrap());
    let provider = Arc::new(Provider(AtomicUsize::new(0)));
    let host = native(&root, store.clone(), provider.clone());
    assert!(matches!(
        host.call(
            RpcId::new("initialize-first"),
            RpcMethod::SessionCreate,
            json!({"workspaceId":"workspace-default","sessionId":"first"}),
            CancellationToken::new()
        )
        .await,
        RpcResult::Success { .. }
    ));
    let backend = Arc::new(CommandCreateBackend {
        host,
        creates: Arc::new(AtomicUsize::new(0)),
        proofs: Arc::new(AtomicUsize::new(0)),
        abrupt_cut: Some((root.0.clone(), provider)),
    });
    let g = Gateway::open(&root.0.join("remote"), "host".into(), backend).unwrap();
    let sender = Sender {
        channel: Channel::Telegram,
        account: "123456".into(),
        user: "42".into(),
    };
    g.configure_private_scopes(
        Principal {
            id: "p".into(),
            host: "host".into(),
            sender: sender.clone(),
            workspaces: ["workspace-default".into()].into(),
            sessions: ["first".into()].into(),
            revision: 1,
            revoked: false,
        },
        Binding {
            id: "b".into(),
            principal: "p".into(),
            conversation: "42".into(),
            workspace: "workspace-default".into(),
            session: "first".into(),
            generation: 1,
        },
        Some(CreationPolicy {
            principal: "p".into(),
            principal_revision: 1,
            generation: 1,
            workspaces: ["workspace-default".into()].into(),
        }),
    )
    .await
    .unwrap();
    // Genuine loopback intake in the child commits update identity and offset.
    let data = CatalogueHttp::default();
    data.updates.lock().unwrap().push(json!({"update_id":10,"message":{"message_id":10,"from":{"id":42,"is_bot":false},"chat":{"id":42,"type":"private"},"text":"/new {\"workspace\":\"workspace-default\"}"}}));
    let app = axum::Router::new()
        .route("/{*path}", axum::routing::post(catalogue_http))
        .with_state(data);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let _server = CatalogueServer(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    }));
    let client = Arc::new(
        xharness_channel_telegram::Client::loopback_fixture(
            xharness_channel_telegram::BotToken::new("123456:fixture-abrupt-creation-only".into())
                .unwrap(),
            &format!("http://{addr}"),
        )
        .unwrap(),
    );
    let mut intake = xharness_channel_telegram::Intake::connect(client, g.clone(), 123456)
        .await
        .unwrap();
    let receipts = intake.poll_once(0).await.unwrap();
    let ReceiveOutcome::Accepted { delivery_key } = &receipts[0].outcome else {
        panic!("creation admission");
    };
    assert_eq!(intake.lease().cursor, "11");
    let scope = g
        .account_subscriptions(&intake.lease())
        .await
        .unwrap()
        .remove(0);
    let cp = g
        .projection_checkpoint(&intake.lease(), scope.clone())
        .await
        .unwrap();
    let page = g
        .read_event_page(&intake.lease(), scope.clone(), Some(cp.next_seq))
        .await
        .unwrap();
    let next = page.next_seq;
    let update = xharness_channel_telegram::format_output(&cp, &page).unwrap();
    g.advance_projection(&intake.lease(), scope, cp, update)
        .await
        .unwrap();
    std::fs::write(root.0.join("cut-cursor.txt"), next.to_string()).unwrap();
    g.dispatch(delivery_key).await.unwrap();
    panic!("abrupt native cut was not reached");
}
#[tokio::test]
async fn native_creation_command_abrupt_exit_recovers_original_proof_http_reply_and_projection_without_model(
) {
    use xharness_channel_telegram::{format_command_reply, BotToken, Client, Intake, Replies};
    let root = Root::new("creation-command-abrupt");
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "native_creation_command_abrupt_cut_worker",
            "--nocapture",
        ])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &root.0)
        .env("XH_CREATION_COMMAND_CUT_ROOT", &root.0)
        .status()
        .unwrap();
    assert_eq!(child.code(), Some(87));
    let cut: Value =
        serde_json::from_slice(&std::fs::read(root.0.join("cut-evidence.json")).unwrap()).unwrap();
    assert_eq!(cut["nativeCreates"], 1);
    assert_eq!(cut["modelCalls"], 0);
    let created: ScopedSessionCreated = serde_json::from_value(cut["created"].clone()).unwrap();
    let first_end: u64 = std::fs::read_to_string(root.0.join("cut-cursor.txt"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(first_end > 0);
    let provider = Arc::new(Provider(AtomicUsize::new(0)));
    let creates = Arc::new(AtomicUsize::new(0));
    let proofs = Arc::new(AtomicUsize::new(0));
    let store = Arc::new(JsonlSessionStore::new(root.0.join("sessions")).unwrap());
    let first_journal = store.load("first").await.unwrap().unwrap().inspect();
    let created_journal = store
        .load(&created.session)
        .await
        .unwrap()
        .unwrap()
        .inspect();
    let host = native(&root, store.clone(), provider.clone());
    host.restore_from_store(store.clone()).await.unwrap();
    let backend = Arc::new(CommandCreateBackend {
        host: host.clone(),
        creates: creates.clone(),
        proofs: proofs.clone(),
        abrupt_cut: None,
    });
    let g = Gateway::open(&root.0.join("remote"), "host".into(), backend.clone()).unwrap();
    let pending = g.pending().await.unwrap();
    assert_eq!(pending.len(), 1);
    let original = pending[0].clone();
    assert_eq!(original.state, DeliveryState::Dispatching);
    assert_eq!(original.principal_revision, 1);
    let data = CatalogueHttp::default();
    data.updates.lock().unwrap().push(json!({"update_id":10,"message":{"message_id":10,"from":{"id":42,"is_bot":false},"chat":{"id":42,"type":"private"},"text":"/new {\"workspace\":\"workspace-default\"}"}}));
    let app = axum::Router::new()
        .route("/{*path}", axum::routing::post(catalogue_http))
        .with_state(data.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let _server = CatalogueServer(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    }));
    let client = Arc::new(
        Client::loopback_fixture(
            BotToken::new("123456:fixture-creation-reopen-only".into()).unwrap(),
            &format!("http://{addr}"),
        )
        .unwrap(),
    );
    let mut intake = Intake::connect(client.clone(), g.clone(), 123456)
        .await
        .unwrap();
    assert!(intake.poll_once(0).await.unwrap().is_empty());
    assert_eq!(intake.lease().cursor, "11");
    let stop = CancellationToken::new();
    let run = tokio::spawn(g.clone().run(stop.clone()));
    let done = tokio::time::timeout(std::time::Duration::from_secs(4), async {
        loop {
            let d = g.inspect(&original.key).await.unwrap().unwrap();
            if d.state == DeliveryState::Completed {
                break d;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    stop.cancel();
    run.await.unwrap().unwrap();
    assert_eq!(done.binding, original.binding);
    assert_eq!(done.inbound, original.inbound);
    assert_eq!(done.principal_revision, 1);
    assert_eq!(creates.load(Ordering::SeqCst), 0);
    assert_eq!(proofs.load(Ordering::SeqCst), 1);
    let Some(NativeCommandResult::Success { value: Some(v) }) = &done.result else {
        panic!("created receipt");
    };
    let receipt: ControllerCreated = serde_json::from_value(v.clone()).unwrap();
    assert_eq!(receipt.created, created);
    assert_eq!(receipt.principal_revision, 2);
    assert_eq!(receipt.binding, original.binding);
    let lease = intake.lease();
    let scope = g.account_subscriptions(&lease).await.unwrap().remove(0);
    assert_eq!(scope.generation, 1);
    let cp = g
        .projection_checkpoint(&lease, scope.clone())
        .await
        .unwrap();
    assert_eq!(cp.next_seq, first_end);
    assert!(g
        .read_event_page(&lease, scope.clone(), Some(cp.next_seq))
        .await
        .unwrap()
        .events
        .is_empty());
    assert_eq!(
        g.command_reply_candidate(&lease, scope.clone())
            .await
            .unwrap(),
        Some(done.clone())
    );
    let plans = format_command_reply(&done).unwrap();
    assert!(plans[0]
        .body
        .text
        .starts_with("Session created and granted."));
    assert!(plans[0].body.text.contains(&created.session));
    assert!(!plans[0].body.text.contains(root.0.to_str().unwrap()));
    let out = g
        .enqueue_command_replies(&lease, scope.clone(), done.clone(), plans.clone())
        .await
        .unwrap();
    assert_eq!(out[0].principal_revision, 2);
    let transport = Arc::new(Replies::connect(client.clone(), 123456).await.unwrap());
    data.fail_send.store(true, Ordering::SeqCst);
    assert_eq!(
        g.deliver_reply(lease, &out[0].key, transport, CancellationToken::new())
            .await
            .unwrap()
            .state,
        ReplyState::Uncertain
    );
    assert_eq!(data.count("sendMessage"), 1);
    g.close().await.unwrap();
    drop(intake);
    drop(g);
    drop(backend);
    drop(host);
    drop(store);
    let store = Arc::new(JsonlSessionStore::new(root.0.join("sessions")).unwrap());
    let host = native(&root, store.clone(), provider.clone());
    host.restore_from_store(store.clone()).await.unwrap();
    let g = Gateway::open(
        &root.0.join("remote"),
        "host".into(),
        Arc::new(CommandCreateBackend {
            host,
            creates: creates.clone(),
            proofs: proofs.clone(),
            abrupt_cut: None,
        }),
    )
    .unwrap();
    let mut intake = Intake::connect(client.clone(), g.clone(), 123456)
        .await
        .unwrap();
    assert!(intake.poll_once(0).await.unwrap().is_empty());
    assert_eq!(g.dispatch(&done.key).await.unwrap(), done);
    assert_eq!(proofs.load(Ordering::SeqCst), 1);
    assert_eq!(creates.load(Ordering::SeqCst), 0);
    let retried = g
        .enqueue_command_replies(&intake.lease(), scope.clone(), done.clone(), plans)
        .await
        .unwrap();
    assert_eq!(retried[0].key, out[0].key);
    assert_eq!(retried[0].state, ReplyState::Uncertain);
    assert!(g
        .command_reply_candidate(&intake.lease(), scope.clone())
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        g.projection_checkpoint(&intake.lease(), scope)
            .await
            .unwrap()
            .next_seq,
        first_end
    );
    data.updates.lock().unwrap().push(json!({"update_id":11,"message":{"message_id":11,"from":{"id":42,"is_bot":false},"chat":{"id":42,"type":"private"},"text":format!("/select {}",serde_json::to_string(&SessionSelection{workspace:created.workspace.clone(),session:created.session.clone()}).unwrap())}}));
    let rs = intake.poll_once(0).await.unwrap();
    let ReceiveOutcome::Accepted { delivery_key } = &rs[0].outcome else {
        panic!("select created");
    };
    let selected = g.dispatch(delivery_key).await.unwrap();
    let current = g
        .account_subscriptions(&intake.lease())
        .await
        .unwrap()
        .remove(0);
    assert_eq!(current.generation, 2);
    assert_eq!(
        g.projection_checkpoint(&intake.lease(), current.clone())
            .await
            .unwrap()
            .next_seq,
        0
    );
    assert!(g
        .enqueue_command_replies(
            &intake.lease(),
            current.clone(),
            done.clone(),
            format_command_reply(&done).unwrap()
        )
        .await
        .is_err());
    let replies = g
        .enqueue_command_replies(
            &intake.lease(),
            current,
            selected.clone(),
            format_command_reply(&selected).unwrap(),
        )
        .await
        .unwrap();
    let transport = Arc::new(Replies::connect(client, 123456).await.unwrap());
    assert!(matches!(
        g.deliver_reply(
            intake.lease(),
            &replies[0].key,
            transport,
            CancellationToken::new()
        )
        .await,
        Err(Error::ReplyBlocked)
    ));
    assert_eq!(data.count("sendMessage"), 1);
    assert_eq!(creates.load(Ordering::SeqCst), 0);
    assert_eq!(provider.0.load(Ordering::SeqCst), 0);
    assert_eq!(
        store.load("first").await.unwrap().unwrap().inspect(),
        first_journal
    );
    assert_eq!(
        store
            .load(&created.session)
            .await
            .unwrap()
            .unwrap()
            .inspect(),
        created_journal
    );
    g.close().await.unwrap();
}

// Real saved Schedule composition is kept alongside existing native channel
// fixtures, so the same loopback HTTP contract is exercised without live tokens.
fn automation_native(
    root: &Root,
    store: Arc<dyn Store>,
    provider: Arc<Provider>,
) -> (
    Arc<BasicHost>,
    Arc<DurableLoopAgentRuntime>,
    Arc<xharness_schedule::ScheduleManager>,
) {
    let schedules = xharness_schedule::ScheduleManager::new(store.clone());
    let runtime = Arc::new(
        DurableLoopAgentRuntime::new(
            "fixture",
            "fixture",
            Some(provider),
            Arc::new(NoTools),
            Arc::new(IdentityContextPolicy),
            store,
            Arc::new(xharness_agent::MemoryLeaseManager::default()),
            64,
        )
        .with_schedules(schedules.clone()),
    );
    let mut config = HostConfig::new(root.0.join("workspace"));
    config.provider_id = "fixture".into();
    config.model_id = "fixture".into();
    config.auto_titles = false;
    (
        BasicHost::with_agent_runtime(config, runtime.clone()),
        runtime,
        schedules,
    )
}
struct AutomationBackend {
    host: Arc<BasicHost>,
    reads: Arc<AtomicUsize>,
    controls: Arc<AtomicUsize>,
    proofs: Arc<AtomicUsize>,
    cut: Option<(PathBuf, Arc<Provider>)>,
}
#[async_trait]
impl ApiBackend for AutomationBackend {
    async fn call(&self, _: RpcId, _: RpcMethod, _: Value, _: CancellationToken) -> RpcResult {
        panic!("no generic automation RPC/Agent")
    }
    async fn respond(&self, _: ClientResponse) -> RpcReceipt {
        panic!("no global interaction")
    }
    fn mux_events(&self) -> EventStream {
        panic!("no global mux")
    }
    fn host_events(&self) -> EventStream {
        panic!("no global events")
    }
    async fn session_in_workspace(&self, w: &str, s: &str) -> Result<bool, RpcError> {
        self.host.session_in_workspace(w, s).await
    }
    async fn scoped_automation_read(
        &self,
        q: xharness_api::ScopedAutomationRead,
    ) -> Result<ScopedAutomationPage, RpcError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.host.scoped_automation_read(q).await
    }
    async fn scoped_automation_receipt(
        &self,
        q: xharness_api::ScopedAutomationMutation,
    ) -> Result<Option<ScopedAutomationApplied>, RpcError> {
        self.proofs.fetch_add(1, Ordering::SeqCst);
        self.host.scoped_automation_receipt(q).await
    }
    async fn scoped_automation_control(
        &self,
        q: xharness_api::ScopedAutomationMutation,
    ) -> Result<ScopedAutomationApplied, RpcError> {
        self.controls.fetch_add(1, Ordering::SeqCst);
        let applied = self.host.scoped_automation_control(q).await?;
        if let Some((root, provider)) = &self.cut {
            assert_eq!(provider.0.load(Ordering::SeqCst), 0);
            std::fs::write(root.join("automation-cut.json"),serde_json::to_vec(&json!({"applied":applied,"controls":1,"reads":self.reads.load(Ordering::SeqCst),"model_calls":0})).unwrap()).unwrap();
            std::process::exit(88);
        }
        Ok(applied)
    }
}
async fn automation_http(
    data: CatalogueHttp,
) -> (CatalogueServer, Arc<xharness_channel_telegram::Client>) {
    let app = axum::Router::new()
        .route("/{*path}", axum::routing::post(catalogue_http))
        .with_state(data);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = CatalogueServer(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    }));
    (
        server,
        Arc::new(
            xharness_channel_telegram::Client::loopback_fixture(
                xharness_channel_telegram::BotToken::new(
                    "123456:fixture-saved-automation-only".into(),
                )
                .unwrap(),
                &format!("http://{addr}"),
            )
            .unwrap(),
        ),
    )
}
#[tokio::test]
#[ignore = "subprocess helper invoked by genuine native automation abrupt-cut acceptance"]
async fn native_automation_command_abrupt_cut_worker() {
    let root = Root(PathBuf::from(
        std::env::var("XH_AUTOMATION_COMMAND_CUT_ROOT").unwrap(),
    ));
    let store: Arc<dyn Store> = Arc::new(
        JsonlSessionStore::new(root.0.join("sessions"))
            .unwrap()
            .for_runtime(),
    );
    let provider = Arc::new(Provider(AtomicUsize::new(0)));
    let (host, _, schedules) = automation_native(&root, store, provider.clone());
    assert!(matches!(
        host.call(
            RpcId::new("create"),
            RpcMethod::SessionCreate,
            json!({"workspaceId":"workspace-default","sessionId":"s"}),
            CancellationToken::new()
        )
        .await,
        RpcResult::Success { .. }
    ));
    let id = schedules
        .execute(
            "s",
            "fixture-initial-schedule",
            serde_json::from_value(
                json!({"action":"create","prompt":"原生提醒 🧪","after_seconds":3600}),
            )
            .unwrap(),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let backend = Arc::new(AutomationBackend {
        host,
        reads: Arc::new(AtomicUsize::new(0)),
        controls: Arc::new(AtomicUsize::new(0)),
        proofs: Arc::new(AtomicUsize::new(0)),
        cut: Some((root.0.clone(), provider)),
    });
    let g = Gateway::open(&root.0.join("remote"), "host".into(), backend).unwrap();
    let sender = Sender {
        channel: Channel::Telegram,
        account: "123456".into(),
        user: "42".into(),
    };
    g.configure_private_scopes(
        Principal {
            id: "p".into(),
            host: "host".into(),
            sender: sender.clone(),
            workspaces: ["workspace-default".into()].into(),
            sessions: ["s".into()].into(),
            revision: 1,
            revoked: false,
        },
        Binding {
            id: "b".into(),
            principal: "p".into(),
            conversation: "42".into(),
            workspace: "workspace-default".into(),
            session: "s".into(),
            generation: 1,
        },
        None,
    )
    .await
    .unwrap();
    let data = CatalogueHttp::default();
    data.updates.lock().unwrap().push(json!({"update_id":10,"message":{"message_id":10,"from":{"id":42,"is_bot":false},"chat":{"id":42,"type":"private"},"text":format!("/automation {}",serde_json::to_string(&json!({"action":"pause","id":id})).unwrap())}}));
    let (_server, client) = automation_http(data).await;
    let mut intake = xharness_channel_telegram::Intake::connect(client, g.clone(), 123456)
        .await
        .unwrap();
    let receipts = intake.poll_once(0).await.unwrap();
    assert_eq!(intake.lease().cursor, "11");
    let ReceiveOutcome::Accepted { delivery_key } = &receipts[0].outcome else {
        panic!("automation durable admission")
    };
    g.dispatch(delivery_key).await.unwrap();
    panic!("native abrupt cut not reached");
}
#[tokio::test]
async fn native_automation_abrupt_exit_original_proof_http_uncertainty_and_fresh_reopen_without_model(
) {
    use xharness_channel_telegram::{format_command_reply, Intake, Replies};
    let root = Root::new("automation-command-abrupt");
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "native_automation_command_abrupt_cut_worker",
            "--nocapture",
        ])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &root.0)
        .env("XH_AUTOMATION_COMMAND_CUT_ROOT", &root.0)
        .status()
        .unwrap();
    assert_eq!(child.code(), Some(88));
    let evidence: Value =
        serde_json::from_slice(&std::fs::read(root.0.join("automation-cut.json")).unwrap())
            .unwrap();
    assert_eq!(evidence["controls"], 1);
    assert_eq!(evidence["reads"], 1);
    assert_eq!(evidence["model_calls"], 0);
    let applied: ScopedAutomationApplied =
        serde_json::from_value(evidence["applied"].clone()).unwrap();
    assert_eq!(applied.state, AutomationControlState::Paused);
    let data = CatalogueHttp::default();
    data.fail_send.store(true, Ordering::SeqCst);
    let (_server, client) = automation_http(data.clone()).await;
    let provider = Arc::new(Provider(AtomicUsize::new(0)));
    let reads = Arc::new(AtomicUsize::new(0));
    let controls = Arc::new(AtomicUsize::new(0));
    let proofs = Arc::new(AtomicUsize::new(0));
    let store: Arc<dyn Store> = Arc::new(
        JsonlSessionStore::new(root.0.join("sessions"))
            .unwrap()
            .for_runtime(),
    );
    let original_journal = store.load("s").await.unwrap().unwrap().inspect();
    let (host, runtime, _) = automation_native(&root, store.clone(), provider.clone());
    host.restore_from_store(store.clone()).await.unwrap();
    let backend = Arc::new(AutomationBackend {
        host: host.clone(),
        reads: reads.clone(),
        controls: controls.clone(),
        proofs: proofs.clone(),
        cut: None,
    });
    let g = Gateway::open(&root.0.join("remote"), "host".into(), backend).unwrap();
    let original = g.pending().await.unwrap().remove(0);
    assert_eq!(original.state, DeliveryState::Dispatching);
    let before = g.grant_page(None).await.unwrap();
    let mut intake = Intake::connect(client.clone(), g.clone(), 123456)
        .await
        .unwrap();
    assert_eq!(intake.lease().cursor, "11");
    assert!(intake.poll_once(0).await.unwrap().is_empty());
    let scope = g
        .account_subscriptions(&intake.lease())
        .await
        .unwrap()
        .remove(0);
    let done = g.dispatch(&original.key).await.unwrap();
    assert_eq!(done.state, DeliveryState::Completed);
    assert_eq!(g.grant_page(None).await.unwrap(), before);
    assert_eq!(reads.load(Ordering::SeqCst), 0);
    assert_eq!(controls.load(Ordering::SeqCst), 0);
    assert_eq!(proofs.load(Ordering::SeqCst), 1);
    assert_eq!(
        store.load("s").await.unwrap().unwrap().inspect(),
        original_journal
    );
    let Some(NativeCommandResult::Success { value: Some(v) }) = &done.result else {
        panic!("typed original")
    };
    let receipt: ControllerAutomationControl = serde_json::from_value(v.clone()).unwrap();
    assert_eq!(receipt.applied, applied);
    assert!(receipt.is_for_delivery(&done));
    let plans = format_command_reply(&done).unwrap();
    assert_eq!(plans.len(), 1);
    assert!(plans[0].body.text.contains("original operation receipt"));
    assert!(!plans[0].body.text.contains(root.0.to_str().unwrap()));
    let outgoing = g
        .enqueue_command_replies(&intake.lease(), scope.clone(), done.clone(), plans.clone())
        .await
        .unwrap();
    let transport = Arc::new(Replies::connect(client.clone(), 123456).await.unwrap());
    let unknown = g
        .deliver_reply(
            intake.lease(),
            &outgoing[0].key,
            transport.clone(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(unknown.state, ReplyState::Uncertain);
    assert_eq!(data.count("sendMessage"), 1);
    assert!(g
        .command_reply_candidate(&intake.lease(), scope.clone())
        .await
        .unwrap()
        .is_none());
    g.close().await.unwrap();
    drop(intake);
    drop(g);
    runtime.shutdown(std::time::Duration::from_secs(2)).await;
    drop(runtime);
    drop(host);
    drop(store);
    let store: Arc<dyn Store> = Arc::new(
        JsonlSessionStore::new(root.0.join("sessions"))
            .unwrap()
            .for_runtime(),
    );
    let (host, runtime, _) = automation_native(&root, store.clone(), provider.clone());
    host.restore_from_store(store.clone()).await.unwrap();
    let g = Gateway::open(
        &root.0.join("remote"),
        "host".into(),
        Arc::new(AutomationBackend {
            host,
            reads: reads.clone(),
            controls: controls.clone(),
            proofs: proofs.clone(),
            cut: None,
        }),
    )
    .unwrap();
    let mut intake = Intake::connect(client, g.clone(), 123456).await.unwrap();
    assert_eq!(intake.lease().cursor, "11");
    assert!(intake.poll_once(0).await.unwrap().is_empty());
    assert_eq!(g.dispatch(&original.key).await.unwrap(), done);
    assert_eq!(
        g.enqueue_command_replies(&intake.lease(), scope.clone(), done, plans)
            .await
            .unwrap(),
        vec![unknown.clone()]
    );
    assert!(g
        .command_reply_candidate(&intake.lease(), scope)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        g.deliver_reply(
            intake.lease(),
            &unknown.key,
            transport,
            CancellationToken::new()
        )
        .await
        .unwrap(),
        unknown
    );
    assert_eq!(data.count("sendMessage"), 1);
    assert_eq!(reads.load(Ordering::SeqCst), 0);
    assert_eq!(controls.load(Ordering::SeqCst), 0);
    assert_eq!(proofs.load(Ordering::SeqCst), 1);
    assert_eq!(provider.0.load(Ordering::SeqCst), 0);
    assert_eq!(
        store.load("s").await.unwrap().unwrap().inspect(),
        original_journal
    );
    g.close().await.unwrap();
    runtime.shutdown(std::time::Duration::from_secs(2)).await;
}

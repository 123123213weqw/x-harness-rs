#![cfg(unix)]

use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use futures::{stream, StreamExt};
use serde_json::json;
use tokio::{process::Command, time};
use tokio_util::sync::CancellationToken;
use xharness_agent::{DurableInbox, FileLeaseManager, InboxMessage, InboxTarget};
use xharness_api::{ApiBackend, ClientResponse, ClientResponseKind, RpcResult};
use xharness_core::{
    AgentMessage, FinishReason, LoopEngine, LoopRequest, LoopStatus, ModelProvider, ProviderError,
    ProviderEvent, ProviderRequest, ProviderStream, ToolResult, ToolSpec,
};
use xharness_host::{
    BasicHost, DurableLoopAgentRuntime, HostConfig, NoTools, PermissionPreset, SessionToolFactory,
};
use xharness_session::{
    AppendReceipt, EventData, Revision, Session, SessionEvent, SessionHeader, SessionInspection,
    Store, StoreError, ToolOutcome, TurnEndReason,
};
use xharness_session_jsonl::JsonlSessionStore;

const SESSION_ID: &str = "sigkill-session";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CrashCut {
    Admission,
    Claim,
    Request,
    ToolCall,
    ApprovalAsked,
    ToolResult,
    StepEnd,
    TurnEnd,
}

impl CrashCut {
    const ALL: [Self; 8] = [
        Self::Admission,
        Self::Claim,
        Self::Request,
        Self::ToolCall,
        Self::ApprovalAsked,
        Self::ToolResult,
        Self::StepEnd,
        Self::TurnEnd,
    ];

    const fn as_str(self) -> &'static str {
        match self {
            Self::Admission => "admission",
            Self::Claim => "claim",
            Self::Request => "request",
            Self::ToolCall => "tool-call",
            Self::ApprovalAsked => "approval-asked",
            Self::ToolResult => "tool-result",
            Self::StepEnd => "step-end",
            Self::TurnEnd => "turn-end",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|cut| cut.as_str() == value)
    }
}

struct TempState(PathBuf);

impl TempState {
    fn new(cut: CrashCut) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = env::temp_dir().join(format!(
            "xharness-sigkill-{}-{}-{nonce}",
            std::process::id(),
            cut.as_str()
        ));
        fs::create_dir_all(path.join("workspace")).unwrap();
        Self(path)
    }
}

impl Drop for TempState {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Clone)]
struct CrashStore {
    inner: JsonlSessionStore,
    cut: CrashCut,
    root: PathBuf,
    armed: Arc<AtomicBool>,
}

impl CrashStore {
    fn new(inner: JsonlSessionStore, cut: CrashCut, root: PathBuf) -> Self {
        Self {
            inner,
            cut,
            root,
            armed: Arc::new(AtomicBool::new(false)),
        }
    }

    fn matches(&self, event: &SessionEvent) -> bool {
        matches!(
            (self.cut, event.data()),
            (CrashCut::Claim, EventData::TurnStart { .. })
                | (CrashCut::Request, EventData::RequestHeader { .. })
                | (CrashCut::ToolCall, EventData::ToolCall { .. })
                | (CrashCut::ApprovalAsked, EventData::ApprovalAsked { .. })
                | (CrashCut::ToolResult, EventData::ToolResult { .. })
                | (CrashCut::StepEnd, EventData::StepEnd { .. })
                | (CrashCut::TurnEnd, EventData::TurnEnd { .. })
        )
    }
}

#[async_trait]
impl Store for CrashStore {
    async fn list_headers(&self) -> Result<Vec<SessionHeader>, StoreError> {
        self.inner.list_headers().await
    }

    async fn create(&self, header: SessionHeader) -> Result<Session, StoreError> {
        self.inner.create(header).await
    }

    async fn load(&self, session_id: &str) -> Result<Option<Session>, StoreError> {
        self.inner.load(session_id).await
    }

    async fn append(
        &self,
        session_id: &str,
        expected_revision: Revision,
        events: Vec<SessionEvent>,
    ) -> Result<AppendReceipt, StoreError> {
        let matched = events.iter().any(|event| self.matches(event));
        let receipt = self
            .inner
            .append(session_id, expected_revision, events)
            .await?;
        if matched && self.cut == CrashCut::StepEnd {
            signal_ready_and_park(&self.root);
        }
        if matched {
            self.armed.store(true, Ordering::SeqCst);
        }
        Ok(receipt)
    }

    async fn flush(&self, session_id: &str) -> Result<Revision, StoreError> {
        let revision = self.inner.flush(session_id).await?;
        if self.armed.swap(false, Ordering::SeqCst) {
            signal_ready_and_park(&self.root);
        }
        Ok(revision)
    }

    async fn inspect(&self, session_id: &str) -> Result<Option<SessionInspection>, StoreError> {
        self.inner.inspect(session_id).await
    }
}

fn signal_ready_and_park(root: &Path) -> ! {
    fs::write(root.join("ready"), b"durable-cut-reached").unwrap();
    loop {
        std::thread::park();
    }
}

struct CrashProvider {
    cut: CrashCut,
}

#[async_trait]
impl ModelProvider for CrashProvider {
    fn provider_name(&self) -> &str {
        "crash-provider"
    }

    fn model_name(&self) -> Option<&str> {
        Some("crash-model")
    }

    async fn stream(
        &self,
        _request: ProviderRequest,
        _cancellation: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        let events = if matches!(
            self.cut,
            CrashCut::ToolCall | CrashCut::ApprovalAsked | CrashCut::ToolResult
        ) {
            vec![
                Ok(ProviderEvent::ToolCallDelta {
                    index: 0,
                    id: "provider-call".to_owned(),
                    name: "dangerous".to_owned(),
                    arguments_delta: "{}".to_owned(),
                }),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::ToolCalls),
                    usage: None,
                    provider_items: Vec::new(),
                }),
            ]
        } else {
            vec![
                Ok(ProviderEvent::TextDelta("durable answer".to_owned())),
                Ok(ProviderEvent::Completed {
                    finish_reason: Some(FinishReason::Stop),
                    usage: None,
                    provider_items: Vec::new(),
                }),
            ]
        };
        Ok(Box::pin(stream::iter(events)))
    }
}

struct RecoveryProvider;

#[async_trait]
impl ModelProvider for RecoveryProvider {
    fn provider_name(&self) -> &str {
        "crash-provider"
    }

    fn model_name(&self) -> Option<&str> {
        Some("crash-model")
    }

    async fn stream(
        &self,
        _request: ProviderRequest,
        _cancellation: CancellationToken,
    ) -> Result<ProviderStream, ProviderError> {
        Ok(Box::pin(stream::iter([
            Ok(ProviderEvent::TextDelta("recovered".to_owned())),
            Ok(ProviderEvent::Completed {
                finish_reason: Some(FinishReason::Stop),
                usage: None,
                provider_items: Vec::new(),
            }),
        ])))
    }
}

#[tokio::test]
#[ignore = "subprocess helper; invoked by durable_sigkill_matrix_recovers_exactly_once"]
async fn crash_cut_worker() {
    let Ok(cut) = env::var("XHARNESS_CRASH_CUT") else {
        return;
    };
    let cut = CrashCut::parse(&cut).expect("valid crash cut");
    let root = PathBuf::from(env::var_os("XHARNESS_CRASH_ROOT").expect("crash root"));
    let inner = JsonlSessionStore::new(root.join("sessions")).unwrap();

    if cut == CrashCut::Admission {
        let mut header = SessionHeader::new(SESSION_ID);
        header.cwd = Some(root.join("workspace").to_string_lossy().into_owned());
        let inbox = DurableInbox::open(Arc::new(inner), header).await.unwrap();
        inbox
            .append(
                InboxTarget::NextTurn,
                InboxMessage::user("admission-input", "durable original"),
            )
            .await
            .unwrap();
        signal_ready_and_park(&root);
    }

    let crash_store = Arc::new(CrashStore::new(inner, cut, root.clone()));
    let executions = Arc::new(AtomicUsize::new(0));
    let mut tool = ToolSpec::new("dangerous", "dangerous", json!({"type": "object"}), {
        let executions = Arc::clone(&executions);
        move |_, _| {
            executions.fetch_add(1, Ordering::SeqCst);
            async { ToolResult::success("side effect completed") }
        }
    });
    if cut == CrashCut::ApprovalAsked {
        tool = tool.requires_approval();
    }
    let mut request = LoopRequest::new(
        Arc::new(CrashProvider { cut }),
        vec![AgentMessage::user("durable original").with_id("claimed-input")],
    );
    request.session_id = Some(SESSION_ID.to_owned());
    request.journal_store = Some(crash_store);
    request.tools.push(tool);
    let mut run = LoopEngine.start(request);
    while run.next().await.is_some() {}
    panic!("worker completed without reaching crash cut {cut:?}");
}

#[tokio::test]
async fn durable_sigkill_matrix_recovers_exactly_once() {
    for cut in CrashCut::ALL {
        let state = TempState::new(cut);
        let mut child = Command::new(env::current_exe().unwrap())
            .args(["--ignored", "--exact", "crash_cut_worker", "--nocapture"])
            .env("XHARNESS_CRASH_CUT", cut.as_str())
            .env("XHARNESS_CRASH_ROOT", &state.0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let deadline = time::Instant::now() + Duration::from_secs(15);
        loop {
            if state.0.join("ready").exists() {
                break;
            }
            if let Some(status) = child.try_wait().unwrap() {
                panic!("worker exited before cut {cut:?}: {status}");
            }
            assert!(time::Instant::now() < deadline, "worker missed cut {cut:?}");
            time::sleep(Duration::from_millis(10)).await;
        }
        child.start_kill().unwrap();
        let status = time::timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("SIGKILL settles")
            .unwrap();
        assert!(!status.success(), "worker must be killed at {cut:?}");

        let store = Arc::new(JsonlSessionStore::new(state.0.join("sessions")).unwrap());
        if cut == CrashCut::Admission {
            recover_admission(&state.0, store).await;
        } else if cut == CrashCut::ApprovalAsked {
            recover_approval(&state.0, store).await;
        } else {
            recover_core_cut(cut, store).await;
        }
    }
}

async fn recover_admission(root: &Path, store: Arc<JsonlSessionStore>) {
    let provider: Arc<dyn ModelProvider> = Arc::new(RecoveryProvider);
    let store_trait: Arc<dyn Store> = store.clone();
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "crash-provider",
        "crash-model",
        Some(provider),
        Arc::new(NoTools),
        Arc::new(xharness_core::IdentityContextPolicy),
        Arc::clone(&store_trait),
        Arc::new(FileLeaseManager::new(root.join("leases")).unwrap()),
        64,
    ));
    let mut config = HostConfig::new(root.join("workspace"));
    config.provider_id = "crash-provider".to_owned();
    config.model_id = "crash-model".to_owned();
    let host = BasicHost::with_agent_runtime(config, runtime);
    let report = host.restore_from_store(store_trait).await.unwrap();
    assert_eq!(report.resumed_pending_turns, 1);
    let deadline = time::Instant::now() + Duration::from_secs(5);
    loop {
        let session = store.load(SESSION_ID).await.unwrap().unwrap();
        if session.events().iter().any(|event| {
            matches!(
                event.data(),
                EventData::TurnEnd {
                    reason: TurnEndReason::Completed,
                    ..
                }
            )
        }) {
            assert_eq!(
                session
                    .events()
                    .iter()
                    .filter_map(|event| match event.data() {
                        EventData::AgentInboxSpliced { inserted, .. } => Some(
                            inserted
                                .iter()
                                .filter(|message| message.id == "admission-input")
                                .count(),
                        ),
                        _ => None,
                    })
                    .sum::<usize>(),
                1
            );
            return;
        }
        assert!(time::Instant::now() < deadline, "admission did not resume");
        time::sleep(Duration::from_millis(10)).await;
    }
}

struct RecoveryToolFactory {
    executions: Arc<AtomicUsize>,
}

#[async_trait]
impl SessionToolFactory for RecoveryToolFactory {
    async fn tools(
        &self,
        _session_id: &str,
        _cwd: &str,
        _permission: PermissionPreset,
    ) -> Result<Vec<ToolSpec>, String> {
        let executions = Arc::clone(&self.executions);
        Ok(vec![ToolSpec::new(
            "dangerous",
            "dangerous",
            json!({"type": "object"}),
            move |_, _| {
                executions.fetch_add(1, Ordering::SeqCst);
                async { ToolResult::success("recovered approved side effect") }
            },
        )
        .requires_approval()])
    }
}

async fn recover_approval(root: &Path, store: Arc<JsonlSessionStore>) {
    let executions = Arc::new(AtomicUsize::new(0));
    let provider: Arc<dyn ModelProvider> = Arc::new(RecoveryProvider);
    let store_trait: Arc<dyn Store> = store.clone();
    let runtime = Arc::new(DurableLoopAgentRuntime::new(
        "crash-provider",
        "crash-model",
        Some(provider),
        Arc::new(RecoveryToolFactory {
            executions: Arc::clone(&executions),
        }),
        Arc::new(xharness_core::IdentityContextPolicy),
        Arc::clone(&store_trait),
        Arc::new(FileLeaseManager::new(root.join("leases")).unwrap()),
        64,
    ));
    let mut config = HostConfig::new(root.join("workspace"));
    config.provider_id = "crash-provider".to_owned();
    config.model_id = "crash-model".to_owned();
    let host = BasicHost::with_agent_runtime(config, runtime);
    let mut mux = host.mux_events();
    let report = host.restore_from_store(store_trait).await.unwrap();
    assert_eq!(report.resumed_pending_approvals, 1);

    let request = time::timeout(Duration::from_secs(5), async {
        loop {
            let frame = mux.next().await.expect("mux remains open");
            if frame.payload["type"] == "approval/requested" {
                break frame;
            }
        }
    })
    .await
    .expect("approval was not restored after SIGKILL");
    assert_eq!(executions.load(Ordering::SeqCst), 0);
    let approval_id = request.payload["approvalId"].clone();
    let receipt = host
        .respond(ClientResponse {
            kind: ClientResponseKind::ClientResponse,
            rpc_id: request.rpc_id,
            result: RpcResult::success(json!({
                "sessionId": SESSION_ID,
                "approvalId": approval_id,
                "outcome": "allowed-once",
            })),
        })
        .await;
    assert_eq!(receipt, xharness_api::RpcReceipt::Accepted);

    let deadline = time::Instant::now() + Duration::from_secs(5);
    loop {
        let session = store.load(SESSION_ID).await.unwrap().unwrap();
        if session.events().iter().any(|event| {
            matches!(
                event.data(),
                EventData::TurnEnd {
                    reason: TurnEndReason::Completed,
                    ..
                }
            )
        }) {
            assert_eq!(executions.load(Ordering::SeqCst), 1);
            assert_eq!(session.pending_tool_approvals().len(), 0);
            assert_eq!(
                session
                    .events()
                    .iter()
                    .filter(|event| matches!(event.data(), EventData::ApprovalAsked { .. }))
                    .count(),
                1
            );
            assert!(session.events().iter().any(|event| matches!(
                event.data(),
                EventData::ToolResult { result, .. }
                    if result.outcome == ToolOutcome::Success
            )));
            assert!(!session.events().iter().any(|event| matches!(
                event.data(),
                EventData::ToolResult { result, .. }
                    if result.outcome == ToolOutcome::OutcomeUnknown
            )));
            return;
        }
        assert!(time::Instant::now() < deadline, "approval did not resume");
        time::sleep(Duration::from_millis(10)).await;
    }
}

async fn recover_core_cut(cut: CrashCut, store: Arc<JsonlSessionStore>) {
    let executions = Arc::new(AtomicUsize::new(0));
    let tool = ToolSpec::new("dangerous", "dangerous", json!({"type": "object"}), {
        let executions = Arc::clone(&executions);
        move |_, _| {
            executions.fetch_add(1, Ordering::SeqCst);
            async { ToolResult::success("must not replay") }
        }
    });
    let store_trait: Arc<dyn Store> = store.clone();
    let mut request = LoopRequest::new(
        Arc::new(RecoveryProvider),
        vec![AgentMessage::user("recovery probe")],
    );
    request.session_id = Some(SESSION_ID.to_owned());
    request.journal_store = Some(store_trait);
    request.tools.push(tool);
    let mut run = LoopEngine.start(request);
    while run.next().await.is_some() {}
    let result = run.result().await;
    assert_eq!(result.status, LoopStatus::Completed, "cut={cut:?}");
    assert_eq!(executions.load(Ordering::SeqCst), 0, "cut={cut:?}");

    let session = store.load(SESSION_ID).await.unwrap().unwrap();
    assert_eq!(
        session
            .derive_messages()
            .iter()
            .filter(|message| message.content == "durable original")
            .count(),
        1,
        "cut={cut:?}"
    );
    let first_end = session
        .events()
        .iter()
        .find_map(|event| match event.data() {
            EventData::TurnEnd { turn: 1, reason } => Some(reason),
            _ => None,
        });
    if cut == CrashCut::TurnEnd {
        assert_eq!(first_end, Some(&TurnEndReason::Completed));
    } else {
        assert_eq!(first_end, Some(&TurnEndReason::Interrupted));
    }

    let outcomes = session
        .events()
        .iter()
        .filter_map(|event| match event.data() {
            EventData::ToolResult { result, .. } => Some(result.outcome),
            _ => None,
        })
        .collect::<Vec<_>>();
    match cut {
        CrashCut::ToolCall => assert_eq!(outcomes, [ToolOutcome::OutcomeUnknown]),
        CrashCut::ToolResult => assert_eq!(outcomes, [ToolOutcome::Success]),
        CrashCut::ApprovalAsked => unreachable!("approval cut has a dedicated recovery path"),
        _ => assert!(outcomes.is_empty(), "cut={cut:?}"),
    }
}

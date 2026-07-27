//! Opt-in native hosted launch. Local application behavior is unchanged.
#![forbid(unsafe_code)]
use async_trait::async_trait;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use xharness_agent::AgentShutdownReport;
use xharness_api::{
    ApiBackend, ClientResponse, EventStream, ReceiptRejection, RpcError, RpcId, RpcMethod,
    RpcReceipt, RpcResult, SessionExport,
};
use xharness_cloud::{Counter, ExecutionPermit, PermitRecord};
use xharness_cloud_app::{
    NativePermitBinding, NativePermitJournal, NativePermitSnapshot, NativeShutdownOutcome,
};
use xharness_host::ExecutionGate;

fn denied() -> io::Error {
    io::Error::other("hosted execution authority is unavailable, changed or sealed")
}
pub struct HostedExecution {
    journal: Arc<NativePermitJournal>,
    specification: NativePermitBinding,
    observed_permit: Mutex<PermitRecord>,
    generation: OnceLock<Counter>,
    fenced: AtomicBool,
    boot_finished: AtomicBool,
    prepared_bootstrap: AtomicBool,
    activated_ready: AtomicBool,
}
impl HostedExecution {
    /// Called after the original state-directory ownership lease, before
    /// models, tools, control/session replay or network listeners are opened.
    pub fn open(directory: &Path, workspace: &Path, state_dir: &Path) -> io::Result<Arc<Self>> {
        if !cfg!(target_os = "linux") {
            return Err(io::Error::other(
                "hosted native execution currently requires Linux",
            ));
        }
        let journal = Arc::new(NativePermitJournal::open(directory).map_err(|_| denied())?);
        let snapshot = journal.snapshot().map_err(|_| denied())?;
        if snapshot.permit.permit == ExecutionPermit::Sealed {
            return Err(denied());
        }
        let workspace = std::fs::canonicalize(workspace)?;
        let state = std::fs::canonicalize(state_dir)?;
        let root = std::fs::canonicalize(directory)?;
        if workspace.to_str() != Some(snapshot.specification.workspace.as_str())
            || state.to_str() != Some(snapshot.specification.state_dir.as_str())
            || root.starts_with(&workspace)
        {
            return Err(denied());
        }
        let mut file = File::open(std::env::current_exe()?)?;
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let n = file.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            digest.update(&buffer[..n]);
        }
        if format!("{:x}", digest.finalize())
            != snapshot
                .specification
                .binding
                .host_build_ref
                .version
                .as_str()
        {
            return Err(denied());
        }
        Ok(Arc::new(Self {
            journal,
            specification: snapshot.specification,
            observed_permit: Mutex::new(snapshot.permit),
            generation: OnceLock::new(),
            fenced: AtomicBool::new(false),
            boot_finished: AtomicBool::new(false),
            prepared_bootstrap: AtomicBool::new(false),
            activated_ready: AtomicBool::new(false),
        }))
    }
    fn observe(&self) -> io::Result<NativePermitSnapshot> {
        if self.fenced.load(Ordering::Acquire) {
            return Err(denied());
        }
        let result = (|| {
            let snapshot = self.journal.snapshot().map_err(|_| denied())?;
            let mut seen = self.observed_permit.lock().map_err(|_| denied())?;
            if snapshot.specification != self.specification
                || snapshot.permit.revision < seen.revision
                || self
                    .generation
                    .get()
                    .is_some_and(|generation| *generation != snapshot.launch_generation)
            {
                return Err(denied());
            }
            // Validate direction even if the poll skipped an intermediate phase.
            let legal = seen
                .transition(&seen.scope, seen.revision, snapshot.permit.permit)
                .map_err(|_| denied())?;
            if snapshot.permit.revision < legal.revision
                || (snapshot.permit.revision == seen.revision && snapshot.permit != *seen)
            {
                return Err(denied());
            }
            *seen = snapshot.permit.clone();
            Ok(snapshot)
        })();
        if result.is_err() {
            self.fenced.store(true, Ordering::Release);
        }
        result
    }
    pub fn journal(&self) -> &NativePermitJournal {
        &self.journal
    }
    /// Opt-in complete Prepared boot. The reserved Goal identity, ownership
    /// lease and executable binding are established before calling this.
    pub fn begin_prepared_bootstrap(&self) -> io::Result<()> {
        self.prepared_bootstrap.store(true, Ordering::Release);
        let phase = self.observe()?.permit.permit;
        let receipt = match phase {
            ExecutionPermit::Prepared => self.journal.claim_prepared_launch(),
            ExecutionPermit::Active => self.journal.claim_launch(),
            ExecutionPermit::Sealed => return Err(denied()),
        }
        .map_err(|_| denied())?;
        self.generation
            .set(receipt.generation)
            .map_err(|_| denied())?;
        Ok(())
    }
    pub fn record_prepared_ready(&self) -> io::Result<()> {
        if self.observe()?.permit.permit == ExecutionPermit::Prepared {
            self.journal
                .record_prepared_ready(*self.generation.get().ok_or_else(denied)?)
                .map_err(|_| denied())?;
        }
        self.boot_finished.store(true, Ordering::Release);
        Ok(())
    }
    /// Activation keeps the SAME launch generation: no second initial task.
    pub async fn wait_prepared_activation(&self) -> io::Result<()> {
        loop {
            match self.observe()?.permit.permit {
                ExecutionPermit::Active => return Ok(()),
                ExecutionPermit::Sealed => return Err(denied()),
                ExecutionPermit::Prepared => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
    }
    /// Prepared launches stay dormant: no original Host boot or readiness claim.
    /// Sealed cannot be reopened by a later restart or replayed activate ack.
    pub async fn await_activation(&self) -> io::Result<()> {
        loop {
            match self.observe()?.permit.permit {
                ExecutionPermit::Sealed => return Err(denied()),
                ExecutionPermit::Active => {
                    let receipt = self.journal.claim_launch().map_err(|_| denied())?;
                    self.generation
                        .set(receipt.generation)
                        .map_err(|_| denied())?;
                    return Ok(());
                }
                ExecutionPermit::Prepared => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
    }
    /// During bootstrap a seal aborts boot, without inventing a cleanup
    /// receipt. After Ready the original Runtime shutdown path takes over.
    pub async fn boot_revoked(&self) -> io::Result<()> {
        loop {
            if self.boot_finished.load(Ordering::Acquire) {
                return std::future::pending().await;
            }
            let phase = self.observe()?.permit.permit;
            if phase == ExecutionPermit::Sealed
                || (!self.prepared_bootstrap.load(Ordering::Acquire)
                    && phase != ExecutionPermit::Active)
            {
                return Err(denied());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    pub async fn until_revoked(&self) -> io::Result<()> {
        loop {
            if self.observe()?.permit.permit != ExecutionPermit::Active {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    pub fn record_ready(&self) -> io::Result<()> {
        if self.observe()?.permit.permit != ExecutionPermit::Active {
            return Err(denied());
        }
        self.journal
            .record_ready(*self.generation.get().ok_or_else(denied)?)
            .map_err(|_| denied())?;
        self.boot_finished.store(true, Ordering::Release);
        self.activated_ready.store(true, Ordering::Release);
        Ok(())
    }
    pub fn record_shutdown(&self, report: &AgentShutdownReport) -> io::Result<()> {
        self.observe()?;
        // Stop NEW admission even for a temporary, unsealed shutdown. The
        // next original Host must claim a new durable launch generation.
        self.fenced.store(true, Ordering::Release);
        let generation = *self.generation.get().ok_or_else(denied)?;
        for _ in 0..2 {
            let snapshot = self.journal.snapshot().map_err(|_| denied())?;
            if snapshot.specification != self.specification
                || snapshot.launch_generation != generation
            {
                return Err(denied());
            }
            let result = self.journal.record_shutdown(
                generation,
                NativeShutdownOutcome {
                    sealed: snapshot.permit.permit == ExecutionPermit::Sealed,
                    runtime_graceful: report.is_graceful(),
                    forced_workers: report.forced_cleanup,
                    cleanup_errors: report.cleanup_errors.len(),
                },
            );
            match result {
                Ok(_) => return Ok(()),
                // A concurrent one-way seal can race the preceding read.
                // Retry metadata commit only, NEVER replay runtime work.
                Err(error) if error.code == xharness_cloud::ErrorCode::InvalidRequest => {}
                Err(_) => return Err(denied()),
            }
        }
        Err(denied())
    }
}
impl ExecutionGate for HostedExecution {
    fn require_active(&self) -> Result<(), String> {
        if self.generation.get().is_some()
            && (!self.prepared_bootstrap.load(Ordering::Acquire)
                || self.activated_ready.load(Ordering::Acquire))
            && self
                .observe()
                .is_ok_and(|s| s.permit.permit == ExecutionPermit::Active)
        {
            Ok(())
        } else {
            Err("hosted execution permit is not active".into())
        }
    }
}

/// Fence transport BEFORE BasicHost's lazy hydrate can activate old sessions.
/// Terminal routes are disabled separately by the hosted composition. This is
/// not the future owner/session-scoped authenticated Gateway.
pub struct HostedBackend {
    inner: Arc<dyn ApiBackend>,
    execution: Arc<HostedExecution>,
}
impl HostedBackend {
    pub fn new(inner: Arc<dyn ApiBackend>, execution: Arc<HostedExecution>) -> Arc<Self> {
        Arc::new(Self { inner, execution })
    }
    fn check(&self) -> Result<(), RpcError> {
        self.execution
            .require_active()
            .map_err(|_| RpcError::internal("hosted execution permit is not active"))
    }
}
#[async_trait]
impl ApiBackend for HostedBackend {
    async fn call(
        &self,
        id: RpcId,
        method: RpcMethod,
        payload: serde_json::Value,
        cancellation: CancellationToken,
    ) -> RpcResult {
        if let Err(error) = self.check() {
            return RpcResult::failure(error);
        }
        self.inner.call(id, method, payload, cancellation).await
    }
    async fn call_dynamic(
        &self,
        id: RpcId,
        endpoint: &str,
        payload: serde_json::Value,
        cancellation: CancellationToken,
    ) -> Option<RpcResult> {
        if let Err(error) = self.check() {
            return Some(RpcResult::failure(error));
        }
        self.inner
            .call_dynamic(id, endpoint, payload, cancellation)
            .await
    }
    async fn respond(&self, response: ClientResponse) -> RpcReceipt {
        if self.check().is_err() {
            return RpcReceipt::Rejected {
                reason: ReceiptRejection::NotPending,
            };
        }
        self.inner.respond(response).await
    }
    fn mux_events(&self) -> EventStream {
        self.inner.mux_events()
    }
    fn host_events(&self) -> EventStream {
        self.inner.host_events()
    }
    async fn export_session(
        &self,
        id: &str,
        cancellation: CancellationToken,
    ) -> Result<SessionExport, RpcError> {
        self.check()?;
        self.inner.export_session(id, cancellation).await
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use xharness_cloud::{Binding, BindingScope, Id, Support, VersionedRef};
    use xharness_cloud_app::{NativeLaunchPhase, NativePermitCommand};
    struct Fixture(PathBuf, Arc<NativePermitJournal>, Arc<HostedExecution>);
    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "xh-hosted-unit-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let journal = Arc::new(NativePermitJournal::open(&root).unwrap());
            let id = |s: &str| Id::new(s).unwrap();
            let specification = NativePermitBinding {
                binding: Binding {
                    scope: BindingScope {
                        task_id: id("task"),
                        binding_id: id("binding"),
                        environment_instance_id: id("vm"),
                        volume_id: id("volume"),
                        execution_epoch: Counter(1),
                    },
                    root_session_id: id("root"),
                    host_build_ref: VersionedRef {
                        id: id("host"),
                        version: id(&"a".repeat(64)),
                    },
                    external_stop_authorized: false,
                    external_stop_support: Support::Unknown,
                },
                workspace: root.join("workspace").to_str().unwrap().into(),
                state_dir: root.join("state").to_str().unwrap().into(),
            };
            let snapshot = journal.initialize(specification.clone()).unwrap();
            let execution = Arc::new(HostedExecution {
                journal: journal.clone(),
                specification,
                observed_permit: Mutex::new(snapshot.permit),
                generation: OnceLock::new(),
                fenced: AtomicBool::new(false),
                boot_finished: AtomicBool::new(false),
                prepared_bootstrap: AtomicBool::new(false),
                activated_ready: AtomicBool::new(false),
            });
            Self(root, journal, execution)
        }
        fn transition(&self, op: &str, to: ExecutionPermit) {
            let s = self.1.snapshot().unwrap();
            self.1
                .transition(&NativePermitCommand {
                    operation_id: Id::new(op).unwrap(),
                    scope: s.permit.scope,
                    expected_revision: s.permit.revision,
                    to,
                })
                .unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[tokio::test]
    async fn native_gate_requires_claim_not_just_active_storage() {
        let f = Fixture::new();
        assert!(f.2.require_active().is_err());
        f.transition("activate", ExecutionPermit::Active);
        assert!(f.2.require_active().is_err());
        f.2.await_activation().await.unwrap();
        assert!(f.2.require_active().is_ok());
        f.transition("seal", ExecutionPermit::Sealed);
        assert!(f.2.require_active().is_err());
        assert!(f.2.record_ready().is_err());
    }
    #[tokio::test]
    async fn seal_during_boot_does_not_fake_ready_or_stop_proof() {
        let f = Fixture::new();
        f.transition("activate", ExecutionPermit::Active);
        f.2.await_activation().await.unwrap();
        f.transition("seal", ExecutionPermit::Sealed);
        assert!(f.2.boot_revoked().await.is_err());
        let receipt = f.1.launch(Counter(1)).unwrap();
        assert_eq!(receipt.phase, NativeLaunchPhase::Starting);
        assert!(receipt.shutdown.is_none());
    }
    #[tokio::test]
    async fn sealed_gate_blocks_transport_before_any_inner_hydration() {
        struct Backend(std::sync::atomic::AtomicUsize);
        #[async_trait]
        impl ApiBackend for Backend {
            async fn call(
                &self,
                _: RpcId,
                method: RpcMethod,
                _: serde_json::Value,
                _: CancellationToken,
            ) -> RpcResult {
                self.0.fetch_add(1, Ordering::Relaxed);
                RpcResult::unavailable(method)
            }
            async fn call_dynamic(
                &self,
                _: RpcId,
                _: &str,
                _: serde_json::Value,
                _: CancellationToken,
            ) -> Option<RpcResult> {
                self.0.fetch_add(1, Ordering::Relaxed);
                None
            }
            async fn respond(&self, _: ClientResponse) -> RpcReceipt {
                self.0.fetch_add(1, Ordering::Relaxed);
                RpcReceipt::Rejected {
                    reason: ReceiptRejection::NotPending,
                }
            }
            fn mux_events(&self) -> EventStream {
                Box::pin(futures::stream::empty())
            }
            fn host_events(&self) -> EventStream {
                Box::pin(futures::stream::empty())
            }
            async fn export_session(
                &self,
                _: &str,
                _: CancellationToken,
            ) -> Result<SessionExport, RpcError> {
                self.0.fetch_add(1, Ordering::Relaxed);
                Err(RpcError::internal("fixture"))
            }
        }
        let f = Fixture::new();
        f.transition("activate", ExecutionPermit::Active);
        f.2.await_activation().await.unwrap();
        let inner = Arc::new(Backend(std::sync::atomic::AtomicUsize::new(0)));
        let backend = HostedBackend::new(inner.clone(), f.2.clone());
        f.transition("seal", ExecutionPermit::Sealed);
        let method: RpcMethod = "session.list".parse().unwrap();
        let rpc = RpcId::new("fenced");
        backend
            .call(
                rpc.clone(),
                method,
                serde_json::json!({}),
                CancellationToken::new(),
            )
            .await;
        backend
            .call_dynamic(
                rpc,
                "commands/execute",
                serde_json::json!({}),
                CancellationToken::new(),
            )
            .await;
        assert!(backend
            .export_session("root", CancellationToken::new())
            .await
            .is_err());
        assert_eq!(inner.0.load(Ordering::Relaxed), 0);
    }
}

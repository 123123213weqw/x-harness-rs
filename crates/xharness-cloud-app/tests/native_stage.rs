#[path = "../../xharness-cloud/tests/common/mod.rs"]
mod common;
use async_trait::async_trait;
use common::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use xharness_cloud::*;
use xharness_cloud_app::*;
struct Port {
    calls: AtomicUsize,
}
#[async_trait]
impl NativeHostLifecycle for Port {
    async fn ensure_prepared(&self, _: &StageOperation) -> CloudResult<()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn settle(&self, _: &StageOperation) -> CloudResult<StageObservation> {
        Err(CloudError::new(
            ErrorCode::RuntimeUnavailable,
            "external stop proof unavailable",
        ))
    }
    async fn inspect_settlement(
        &self,
        _: &StageOperation,
    ) -> CloudResult<Option<StageObservation>> {
        Ok(None)
    }
}
fn fixture() -> (
    tempfile::TempDir,
    Arc<NativePermitJournal>,
    Arc<Port>,
    NativeStageExecutor,
    StageOperation,
) {
    let dir = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let mut task = accepted(&store());
    task.binding.host_build_ref.version = id(&"a".repeat(64));
    let journal = Arc::new(NativePermitJournal::open(dir.path()).unwrap());
    journal
        .initialize(NativePermitBinding {
            binding: task.binding.clone(),
            workspace: dir.path().join("workspace").to_str().unwrap().into(),
            state_dir: dir.path().join("state").to_str().unwrap().into(),
        })
        .unwrap();
    let port = Arc::new(Port {
        calls: AtomicUsize::new(0),
    });
    let executor = NativeStageExecutor::new(journal.clone(), port.clone());
    let intent = StageIntent {
        operation_id: task.prepare_operation_id.clone(),
        scope: task.binding.scope.clone(),
        kind: IntentKind::Prepare,
        status: IntentStatus::Running,
    };
    (
        dir,
        journal,
        port,
        executor,
        StageOperation {
            task,
            intent,
            prior_intents: vec![],
        },
    )
}
fn prepare(j: &NativePermitJournal, op: &StageOperation) {
    let intent = NativeBootstrapIntent {
        operation_id: op.task.prepare_operation_id.clone(),
        scope: op.intent.scope.clone(),
        root_session_id: op.task.binding.root_session_id.clone(),
        fingerprint: "b".repeat(64),
        task_spec_fingerprint: op.task.spec.fingerprint().unwrap().as_str().into(),
    };
    j.reserve_bootstrap(intent.clone()).unwrap();
    let l = j.claim_prepared_launch().unwrap();
    j.record_bootstrap_applied(&intent).unwrap();
    j.record_prepared_ready(l.generation).unwrap();
}
#[tokio::test]
async fn inspect_is_read_only_and_requires_prepared_bootstrap_not_a_dormant_vm() {
    let (_dir, j, port, e, op) = fixture();
    assert!(e.inspect(&op).await.unwrap().is_none());
    prepare(&j, &op);
    assert_eq!(
        e.inspect(&op).await.unwrap().unwrap().outcome,
        StageOutcome::Prepared {
            ready: true,
            bootstrap_prepared: true
        }
    );
    assert_eq!(port.calls.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn activation_waits_for_original_ready_and_timeout_is_queryable_without_relaunch() {
    let (_dir, j, port, e, mut op) = fixture();
    prepare(&j, &op);
    op.intent.operation_id = op.task.activate_operation_id.clone();
    op.intent.kind = IntentKind::Activate;
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(90), e.execute(&op))
            .await
            .is_err()
    );
    assert_eq!(j.snapshot().unwrap().permit.permit, ExecutionPermit::Active);
    assert!(e.inspect(&op).await.unwrap().is_none());
    j.record_ready(Counter(1)).unwrap();
    assert_eq!(
        e.inspect(&op).await.unwrap().unwrap().outcome,
        StageOutcome::Activated
    );
    assert_eq!(port.calls.load(Ordering::SeqCst), 0);
    assert_eq!(j.snapshot().unwrap().launch_generation, Counter(1));
}
#[tokio::test]
async fn different_task_scope_or_spec_cannot_receive_prepared_proof() {
    let (_dir, j, _port, e, op) = fixture();
    prepare(&j, &op);
    let mut bad = op.clone();
    bad.task.spec.objective = "unrelated".into();
    assert!(e.inspect(&bad).await.is_err());
    let mut bad = op.clone();
    bad.intent.scope.execution_epoch = Counter(2);
    assert!(e.inspect(&bad).await.is_err());
    let mut bad = op;
    bad.task.binding.root_session_id = id("other");
    assert!(e.inspect(&bad).await.is_err());
}
#[tokio::test]
async fn sealed_current_authority_beats_historical_ready_and_no_native_only_settle_proof() {
    let (_dir, j, _port, e, mut op) = fixture();
    prepare(&j, &op);
    j.transition(&NativePermitCommand {
        operation_id: id("cancel"),
        scope: op.intent.scope.clone(),
        expected_revision: Counter(1),
        to: ExecutionPermit::Sealed,
    })
    .unwrap();
    assert!(e.inspect(&op).await.unwrap().is_none());
    op.intent.kind = IntentKind::Settle;
    assert!(e.inspect(&op).await.unwrap().is_none());
    assert!(e.execute(&op).await.is_err());
}

struct SimulatedPreparedHost {
    journal: Arc<NativePermitJournal>,
    starts: AtomicUsize,
}
#[async_trait]
impl NativeHostLifecycle for SimulatedPreparedHost {
    async fn ensure_prepared(&self, op: &StageOperation) -> CloudResult<()> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        prepare(&self.journal, op);
        let journal = self.journal.clone();
        tokio::spawn(async move {
            loop {
                if journal.snapshot().unwrap().permit.permit == ExecutionPermit::Active {
                    journal.record_ready(Counter(1)).unwrap();
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        });
        Ok(())
    }
    async fn settle(&self, _: &StageOperation) -> CloudResult<StageObservation> {
        Err(CloudError::new(
            ErrorCode::RuntimeUnavailable,
            "fixture has no external VM stop proof",
        ))
    }
    async fn inspect_settlement(
        &self,
        _: &StageOperation,
    ) -> CloudResult<Option<StageObservation>> {
        Ok(None)
    }
}
#[tokio::test]
async fn persistent_controller_consumes_native_stages_once_and_does_not_fake_external_settlement() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(
        SqliteCloudTaskStore::open(&dir.path().join("control"), AdmissionLimits::default())
            .unwrap(),
    );
    let mut environment = common::environment("owner1");
    environment.host_build_ref.version = id(&"a".repeat(64));
    store.register_environment(environment).unwrap();
    let receipt = store
        .admit(&id("owner1"), &envelope(), Counter(100))
        .unwrap();
    let task = store.get(&id("owner1"), &receipt.task_id).unwrap();
    let journal = Arc::new(NativePermitJournal::open(&dir.path().join("native")).unwrap());
    journal
        .initialize(NativePermitBinding {
            binding: task.binding.clone(),
            workspace: dir.path().join("workspace").to_str().unwrap().into(),
            state_dir: dir.path().join("state").to_str().unwrap().into(),
        })
        .unwrap();
    let port = Arc::new(SimulatedPreparedHost {
        journal: journal.clone(),
        starts: AtomicUsize::new(0),
    });
    let executor = Arc::new(NativeStageExecutor::new(journal, port.clone()));
    let controller = CloudController::new(
        store.clone(),
        executor.clone(),
        1,
        std::time::Duration::from_secs(1),
    )
    .unwrap();
    let report = controller
        .reconcile_task(&id("owner1"), &task.task_id, Counter(200))
        .await
        .unwrap();
    assert_eq!(report.dispatched, 2);
    let active = store.get(&id("owner1"), &task.task_id).unwrap();
    assert_eq!(active.phase, TaskPhase::Attached);
    assert!(active.activated);
    drop(controller);
    drop(store);
    let store = Arc::new(
        SqliteCloudTaskStore::open(&dir.path().join("control"), AdmissionLimits::default())
            .unwrap(),
    );
    let controller = CloudController::new(
        store.clone(),
        executor,
        1,
        std::time::Duration::from_secs(1),
    )
    .unwrap();
    controller
        .reconcile_task(&id("owner1"), &task.task_id, Counter(300))
        .await
        .unwrap();
    assert_eq!(port.starts.load(Ordering::SeqCst), 1);
    store
        .admit(
            &id("owner1"),
            &cancel(&active, "cancel-native"),
            Counter(400),
        )
        .unwrap();
    let report = controller
        .reconcile_task(&id("owner1"), &task.task_id, Counter(400))
        .await
        .unwrap();
    assert!(!report.unknown_operations.is_empty());
    assert_eq!(
        store.get(&id("owner1"), &task.task_id).unwrap().phase,
        TaskPhase::Settling
    );
}

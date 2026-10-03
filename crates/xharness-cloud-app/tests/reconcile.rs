#[path = "../../xharness-cloud/tests/common/mod.rs"]
mod common;
use async_trait::async_trait;
use common::*;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use xharness_cloud::*;
use xharness_cloud_app::*;

#[derive(Default)]
struct Executor {
    calls: Mutex<Vec<(Id, IntentKind)>>,
    queries: Mutex<Vec<Id>>,
    receipts: Mutex<BTreeMap<Id, StageObservation>>,
    lost: bool,
    no_receipt: bool,
    fail: bool,
    invalid_scope: bool,
    hang: bool,
}
#[async_trait]
impl StageExecutor for Executor {
    async fn execute(&self, op: &StageOperation) -> CloudResult<StageObservation> {
        self.calls
            .lock()
            .unwrap()
            .push((op.intent.operation_id.clone(), op.intent.kind));
        if self.hang {
            std::future::pending::<()>().await;
        }
        let outcome = if self.fail {
            StageOutcome::Failed {
                code: ErrorCode::RuntimeUnavailable,
            }
        } else {
            match op.intent.kind {
                IntentKind::Prepare => StageOutcome::Prepared {
                    ready: true,
                    bootstrap_prepared: true,
                },
                IntentKind::Activate => StageOutcome::Activated,
                IntentKind::Settle => StageOutcome::Settled {
                    sealed: true,
                    stop_proof: if op.task.activated {
                        StopProof::Graceful {
                            native_shutdown_verified: true,
                            execution_scope_quiet: true,
                            cleanup_errors: 0,
                        }
                    } else {
                        StopProof::NotStarted {
                            prepare_quiesced: true,
                            no_executor_verified: true,
                        }
                    },
                    retention: retention(),
                },
            }
        };
        let mut receipt = StageObservation {
            operation_id: op.intent.operation_id.clone(),
            scope: op.intent.scope.clone(),
            outcome,
        };
        if self.invalid_scope {
            receipt.scope.execution_epoch = Counter(99);
        }
        if !self.no_receipt {
            self.receipts
                .lock()
                .unwrap()
                .insert(op.intent.operation_id.clone(), receipt.clone());
        }
        if self.lost || self.no_receipt {
            return Err(CloudError::new(
                ErrorCode::OutcomeUnknown,
                "injected lost reply",
            ));
        }
        Ok(receipt)
    }
    async fn inspect(&self, op: &StageOperation) -> CloudResult<Option<StageObservation>> {
        self.queries
            .lock()
            .unwrap()
            .push(op.intent.operation_id.clone());
        Ok(self
            .receipts
            .lock()
            .unwrap()
            .get(&op.intent.operation_id)
            .cloned())
    }
}
fn init(dir: &std::path::Path) -> (Arc<SqliteCloudTaskStore>, TaskRecord) {
    let store = Arc::new(SqliteCloudTaskStore::open(dir, AdmissionLimits::default()).unwrap());
    store.register_environment(environment("owner1")).unwrap();
    let task = accepted(&store);
    (store, task)
}
fn controller(store: Arc<SqliteCloudTaskStore>, executor: Arc<Executor>) -> CloudController {
    CloudController::new(store, executor, 4, Duration::from_millis(30)).unwrap()
}
#[tokio::test]
async fn normal_lifecycle_uses_one_prepare_activate_and_settle() {
    let dir = private_dir();
    let (store, task) = init(dir.path());
    let executor = Arc::new(Executor::default());
    let driver = controller(store.clone(), executor.clone());
    assert_eq!(
        driver
            .reconcile_task(&id("owner1"), &task.task_id, Counter(100))
            .await
            .unwrap()
            .dispatched,
        2
    );
    let task = store.get(&id("owner1"), &task.task_id).unwrap();
    assert!(task.activated);
    store
        .admit(&id("owner1"), &cancel(&task, "cancel1"), Counter(200))
        .unwrap();
    driver
        .reconcile_task(&id("owner1"), &task.task_id, Counter(200))
        .await
        .unwrap();
    assert_eq!(
        store.get(&id("owner1"), &task.task_id).unwrap().phase,
        TaskPhase::Cancelled
    );
    driver
        .reconcile_task(&id("owner1"), &task.task_id, Counter(300))
        .await
        .unwrap();
    assert_eq!(executor.calls.lock().unwrap().len(), 3);
}
#[tokio::test]
async fn applied_then_lost_reply_is_queried_after_process_restart_not_executed_twice() {
    let dir = private_dir();
    let executor = Arc::new(Executor {
        lost: true,
        ..Executor::default()
    });
    let task_id = {
        let (store, task) = init(dir.path());
        let driver = controller(store, executor.clone());
        let report = driver
            .reconcile_task(&id("owner1"), &task.task_id, Counter(100))
            .await
            .unwrap();
        assert_eq!(report.unknown_operations, vec![task.prepare_operation_id]);
        task.task_id
    };
    let store =
        Arc::new(SqliteCloudTaskStore::open(dir.path(), AdmissionLimits::default()).unwrap());
    let driver = controller(store.clone(), executor.clone());
    driver
        .reconcile_task(&id("owner1"), &task_id, Counter(200))
        .await
        .unwrap();
    driver
        .reconcile_task(&id("owner1"), &task_id, Counter(300))
        .await
        .unwrap();
    assert!(store.get(&id("owner1"), &task_id).unwrap().activated);
    assert_eq!(executor.calls.lock().unwrap().len(), 2);
    assert_eq!(executor.queries.lock().unwrap().len(), 2);
}
#[tokio::test]
async fn missing_external_receipt_does_not_become_safe_to_retry() {
    let dir = private_dir();
    let (store, task) = init(dir.path());
    let executor = Arc::new(Executor {
        no_receipt: true,
        ..Executor::default()
    });
    let driver = controller(store, executor.clone());
    for time in 1..10 {
        let report = driver
            .reconcile_task(&id("owner1"), &task.task_id, Counter(time))
            .await
            .unwrap();
        assert_eq!(report.unknown_operations.len(), 1);
    }
    assert_eq!(executor.calls.lock().unwrap().len(), 1);
    assert_eq!(executor.queries.lock().unwrap().len(), 8);
}
#[tokio::test]
async fn cancelled_before_dispatch_never_activates_and_terminal_reopen_is_inert() {
    let dir = private_dir();
    let (store, task) = init(dir.path());
    store
        .admit(&id("owner1"), &cancel(&task, "cancel1"), Counter(100))
        .unwrap();
    let executor = Arc::new(Executor::default());
    let driver = controller(store.clone(), executor.clone());
    driver
        .reconcile_task(&id("owner1"), &task.task_id, Counter(200))
        .await
        .unwrap();
    assert!(executor
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|(_, kind)| *kind == IntentKind::Settle));
    drop(driver);
    drop(store);
    let store =
        Arc::new(SqliteCloudTaskStore::open(dir.path(), AdmissionLimits::default()).unwrap());
    assert_eq!(
        store.get(&id("owner1"), &task.task_id).unwrap().phase,
        TaskPhase::Cancelled
    );
    controller(store, executor.clone())
        .reconcile_task(&id("owner1"), &task.task_id, Counter(300))
        .await
        .unwrap();
    assert_eq!(executor.calls.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn durable_receipt_before_fact_is_replayed_without_network() {
    let dir = private_dir();
    let task = {
        let (store, task) = init(dir.path());
        store
            .record_dispatch(
                &id("owner1"),
                &task.task_id,
                &task.prepare_operation_id,
                IntentStatus::Running,
                Counter(100),
            )
            .unwrap();
        let task = fact(
            &store,
            &task,
            TaskFact::PrepareAdmitted {
                operation_id: task.prepare_operation_id.clone(),
            },
        );
        store
            .save_observation(&StageObservation {
                operation_id: task.prepare_operation_id.clone(),
                scope: task.binding.scope.clone(),
                outcome: StageOutcome::Prepared {
                    ready: true,
                    bootstrap_prepared: true,
                },
            })
            .unwrap();
        task
    };
    let store =
        Arc::new(SqliteCloudTaskStore::open(dir.path(), AdmissionLimits::default()).unwrap());
    let executor = Arc::new(Executor::default());
    controller(store.clone(), executor.clone())
        .reconcile_task(&id("owner1"), &task.task_id, Counter(300))
        .await
        .unwrap();
    assert!(store.get(&id("owner1"), &task.task_id).unwrap().activated);
    assert_eq!(executor.calls.lock().unwrap().len(), 1);
    assert!(executor.queries.lock().unwrap().is_empty());
}
#[tokio::test]
async fn timeout_stays_unknown_and_does_not_report_failed_task() {
    let dir = private_dir();
    let (store, task) = init(dir.path());
    let executor = Arc::new(Executor {
        hang: true,
        ..Executor::default()
    });
    let report = controller(store.clone(), executor)
        .reconcile_task(&id("owner1"), &task.task_id, Counter(100))
        .await
        .unwrap();
    assert_eq!(report.unknown_operations.len(), 1);
    assert_eq!(
        store.get(&id("owner1"), &task.task_id).unwrap().phase,
        TaskPhase::Provisioning
    );
}
#[tokio::test]
async fn bad_epoch_receipt_never_attaches_task() {
    let dir = private_dir();
    let (store, task) = init(dir.path());
    let executor = Arc::new(Executor {
        invalid_scope: true,
        ..Executor::default()
    });
    assert_eq!(
        controller(store.clone(), executor)
            .reconcile_task(&id("owner1"), &task.task_id, Counter(100))
            .await
            .unwrap_err()
            .code,
        ErrorCode::OwnershipUnverified
    );
    assert_eq!(
        store.get(&id("owner1"), &task.task_id).unwrap().phase,
        TaskPhase::Provisioning
    );
    assert!(store
        .observation(&task.prepare_operation_id)
        .unwrap()
        .is_none());
}
#[tokio::test]
async fn same_task_concurrent_ticks_do_not_duplicate_dispatch() {
    let dir = private_dir();
    let (store, task) = init(dir.path());
    let executor = Arc::new(Executor::default());
    let driver = controller(store, executor.clone());
    let owner = id("owner1");
    let (a, b, c) = tokio::join!(
        driver.reconcile_task(&owner, &task.task_id, Counter(100)),
        driver.reconcile_task(&owner, &task.task_id, Counter(100)),
        driver.reconcile_task(&owner, &task.task_id, Counter(100))
    );
    a.unwrap();
    b.unwrap();
    c.unwrap();
    assert_eq!(executor.calls.lock().unwrap().len(), 2);
}
#[tokio::test]
async fn failed_settlement_never_falsely_commits_terminal() {
    let dir = private_dir();
    let (store, task) = init(dir.path());
    store
        .admit(&id("owner1"), &cancel(&task, "cancel1"), Counter(100))
        .unwrap();
    let executor = Arc::new(Executor {
        fail: true,
        ..Executor::default()
    });
    controller(store.clone(), executor)
        .reconcile_task(&id("owner1"), &task.task_id, Counter(200))
        .await
        .unwrap();
    let task = store.get(&id("owner1"), &task.task_id).unwrap();
    assert_eq!(task.phase, TaskPhase::Settling);
    assert!(task.settlement.unwrap().blocked_reason.is_some());
}

fn private_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    dir
}

struct PausedExecutor {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
    pause_kind: IntentKind,
    executor: Executor,
}
#[async_trait]
impl StageExecutor for PausedExecutor {
    async fn execute(&self, op: &StageOperation) -> CloudResult<StageObservation> {
        if op.intent.kind == self.pause_kind {
            self.entered.notify_one();
            self.release.notified().await;
        }
        self.executor.execute(op).await
    }
    async fn inspect(&self, op: &StageOperation) -> CloudResult<Option<StageObservation>> {
        self.executor.inspect(op).await
    }
}
#[tokio::test]
async fn cancel_during_prepare_does_not_create_activate_after_late_reply() {
    let dir = private_dir();
    let (store, task) = init(dir.path());
    let executor = Arc::new(PausedExecutor {
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        pause_kind: IntentKind::Prepare,
        executor: Executor::default(),
    });
    let driver = Arc::new(
        CloudController::new(store.clone(), executor.clone(), 4, Duration::from_secs(5)).unwrap(),
    );
    let worker = {
        let driver = driver.clone();
        let id = task.task_id.clone();
        tokio::spawn(async move {
            driver
                .reconcile_task(&common::id("owner1"), &id, Counter(300))
                .await
        })
    };
    executor.entered.notified().await;
    let current = store.get(&id("owner1"), &task.task_id).unwrap();
    store
        .admit(
            &id("owner1"),
            &cancel(&current, "cancel_inflight"),
            Counter(300),
        )
        .unwrap();
    executor.release.notify_one();
    worker.await.unwrap().unwrap();
    let current = store.get(&id("owner1"), &task.task_id).unwrap();
    assert_eq!(current.phase, TaskPhase::Cancelled);
    assert!(!current.activated);
    assert!(executor
        .executor
        .calls
        .lock()
        .unwrap()
        .iter()
        .all(|(_, kind)| *kind != IntentKind::Activate));
}
#[tokio::test]
async fn cancel_during_activate_keeps_late_execution_fact_and_requires_real_shutdown() {
    let dir = private_dir();
    let (store, task) = init(dir.path());
    let executor = Arc::new(PausedExecutor {
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        pause_kind: IntentKind::Activate,
        executor: Executor::default(),
    });
    let driver = Arc::new(
        CloudController::new(store.clone(), executor.clone(), 4, Duration::from_secs(5)).unwrap(),
    );
    let worker = {
        let driver = driver.clone();
        let id = task.task_id.clone();
        tokio::spawn(async move {
            driver
                .reconcile_task(&common::id("owner1"), &id, Counter(300))
                .await
        })
    };
    executor.entered.notified().await;
    let current = store.get(&id("owner1"), &task.task_id).unwrap();
    store
        .admit(
            &id("owner1"),
            &cancel(&current, "cancel_inflight"),
            Counter(300),
        )
        .unwrap();
    executor.release.notify_one();
    worker.await.unwrap().unwrap();
    let current = store.get(&id("owner1"), &task.task_id).unwrap();
    assert_eq!(current.phase, TaskPhase::Cancelled);
    assert!(current.activated);
    assert!(matches!(
        current.settlement.unwrap().stop_proof,
        Some(StopProof::Graceful { .. })
    ));
}
#[tokio::test]
async fn another_environment_keeps_working_while_one_task_is_blocked_on_io() {
    let dir = private_dir();
    let (store, first) = init(dir.path());
    let mut env = environment("owner1");
    env.environment_ref = reference("vm2");
    env.instance_id = id("vm-instance-2");
    env.volume_id = id("volume-2");
    store.register_environment(env.clone()).unwrap();
    let mut request = envelope();
    request.request_id = id("submit2");
    if let Command::Submit(ref mut payload) = request.command {
        payload.spec.environment_ref = env.environment_ref;
    }
    let second = store.admit(&id("owner1"), &request, Counter(100)).unwrap();
    struct TwoExecutor {
        blocked: Id,
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
        normal: Executor,
    }
    #[async_trait]
    impl StageExecutor for TwoExecutor {
        async fn execute(&self, op: &StageOperation) -> CloudResult<StageObservation> {
            if op.task.task_id == self.blocked && op.intent.kind == IntentKind::Prepare {
                self.entered.notify_one();
                self.release.notified().await;
            }
            self.normal.execute(op).await
        }
        async fn inspect(&self, op: &StageOperation) -> CloudResult<Option<StageObservation>> {
            self.normal.inspect(op).await
        }
    }
    let executor = Arc::new(TwoExecutor {
        blocked: first.task_id.clone(),
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        normal: Executor::default(),
    });
    let driver = Arc::new(
        CloudController::new(store.clone(), executor.clone(), 4, Duration::from_secs(5)).unwrap(),
    );
    let worker = {
        let driver = driver.clone();
        let id = first.task_id.clone();
        tokio::spawn(async move {
            driver
                .reconcile_task(&common::id("owner1"), &id, Counter(100))
                .await
        })
    };
    executor.entered.notified().await;
    tokio::time::timeout(
        Duration::from_secs(1),
        driver.reconcile_task(&id("owner1"), &second.task_id, Counter(200)),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(store.get(&id("owner1"), &second.task_id).unwrap().activated);
    executor.release.notify_one();
    worker.await.unwrap().unwrap();
}
#[tokio::test]
async fn partial_settlement_replays_the_same_saved_proof_after_restart() {
    let dir = private_dir();
    let task = {
        let (store, _) = init(dir.path());
        let task = active(&store);
        store
            .admit(&id("owner1"), &cancel(&task, "cancel"), Counter(100))
            .unwrap();
        let task = store.get(&id("owner1"), &task.task_id).unwrap();
        let op = task.settlement.as_ref().unwrap().operation_id.clone();
        store
            .record_dispatch(
                &id("owner1"),
                &task.task_id,
                &op,
                IntentStatus::Running,
                Counter(100),
            )
            .unwrap();
        store
            .save_observation(&StageObservation {
                operation_id: op.clone(),
                scope: task.binding.scope.clone(),
                outcome: StageOutcome::Settled {
                    sealed: true,
                    stop_proof: StopProof::Graceful {
                        native_shutdown_verified: true,
                        execution_scope_quiet: true,
                        cleanup_errors: 0,
                    },
                    retention: retention(),
                },
            })
            .unwrap();
        fact(&store, &task, TaskFact::Sealed { operation_id: op })
    };
    let store =
        Arc::new(SqliteCloudTaskStore::open(dir.path(), AdmissionLimits::default()).unwrap());
    let executor = Arc::new(Executor::default());
    controller(store.clone(), executor.clone())
        .reconcile_task(&id("owner1"), &task.task_id, Counter(300))
        .await
        .unwrap();
    assert_eq!(
        store.get(&id("owner1"), &task.task_id).unwrap().phase,
        TaskPhase::Cancelled
    );
    assert!(executor.calls.lock().unwrap().is_empty());
    assert!(executor.queries.lock().unwrap().is_empty());
}

#[tokio::test]
async fn lost_activation_then_cancel_queries_prior_effect_before_stop_proof() {
    let dir = private_dir();
    let (store, task) = init(dir.path());
    let executor = Arc::new(Executor {
        lost: true,
        ..Executor::default()
    });
    let driver = controller(store.clone(), executor.clone());
    driver
        .reconcile_task(&id("owner1"), &task.task_id, Counter(100))
        .await
        .unwrap(); // lost Prepare
    driver
        .reconcile_task(&id("owner1"), &task.task_id, Counter(200))
        .await
        .unwrap(); // query Prepare, lost Activate
    let current = store.get(&id("owner1"), &task.task_id).unwrap();
    assert!(!current.activated);
    store
        .admit(&id("owner1"), &cancel(&current, "cancel"), Counter(300))
        .unwrap();
    drop(driver);
    drop(store);
    let store =
        Arc::new(SqliteCloudTaskStore::open(dir.path(), AdmissionLimits::default()).unwrap());
    let driver = controller(store.clone(), executor.clone());
    driver
        .reconcile_task(&id("owner1"), &task.task_id, Counter(400))
        .await
        .unwrap();
    driver
        .reconcile_task(&id("owner1"), &task.task_id, Counter(500))
        .await
        .unwrap();
    let current = store.get(&id("owner1"), &task.task_id).unwrap();
    assert!(current.activated);
    assert_eq!(current.phase, TaskPhase::Cancelled);
    assert!(matches!(
        current.settlement.unwrap().stop_proof,
        Some(StopProof::Graceful { .. })
    ));
    assert_eq!(executor.calls.lock().unwrap().len(), 3);
    assert!(executor
        .queries
        .lock()
        .unwrap()
        .contains(&task.activate_operation_id));
}

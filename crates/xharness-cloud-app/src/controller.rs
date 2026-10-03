use crate::SqliteCloudTaskStore;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};
use xharness_cloud::*;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StageObservation {
    pub operation_id: Id,
    pub scope: BindingScope,
    pub outcome: StageOutcome,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum StageOutcome {
    Prepared {
        ready: bool,
        bootstrap_prepared: bool,
    },
    Activated,
    Settled {
        sealed: bool,
        stop_proof: StopProof,
        retention: VersionedRetentionReceipt,
    },
    /// Verified rejection / complete failure, not a timeout or missing query.
    Failed {
        code: ErrorCode,
    },
}
impl StageObservation {
    fn validate(&self, operation: &StageOperation) -> CloudResult<()> {
        if self.operation_id != operation.intent.operation_id
            || self.scope != operation.intent.scope
        {
            return Err(CloudError::new(
                ErrorCode::OwnershipUnverified,
                "external receipt belongs to a different operation or epoch",
            ));
        }
        let matches = matches!(
            (&self.outcome, operation.intent.kind),
            (
                StageOutcome::Prepared {
                    ready: true,
                    bootstrap_prepared: true
                },
                IntentKind::Prepare
            ) | (StageOutcome::Activated, IntentKind::Activate)
                | (StageOutcome::Settled { .. }, IntentKind::Settle)
                | (StageOutcome::Failed { .. }, _)
        );
        if !matches {
            return Err(CloudError::new(
                ErrorCode::InvalidRequest,
                "external receipt does not prove the requested stage",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct StageOperation {
    pub task: TaskRecord,
    pub intent: StageIntent,
    /// A settle adapter must reconcile earlier in-flight operations before
    /// claiming no executor. Missing receipts are not proof of no execution.
    pub prior_intents: Vec<StageIntent>,
}

/// Adapter owns the external/native idempotency journal and verifies proofs.
/// This controller never interprets model text as success or executes tools.
#[async_trait]
pub trait StageExecutor: Send + Sync {
    async fn execute(&self, operation: &StageOperation) -> CloudResult<StageObservation>;
    async fn inspect(&self, operation: &StageOperation) -> CloudResult<Option<StageObservation>>;
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReconcileReport {
    pub dispatched: usize,
    pub queried: usize,
    pub verified: usize,
    pub unknown_operations: Vec<Id>,
}

pub struct CloudController {
    store: Arc<SqliteCloudTaskStore>,
    executor: Arc<dyn StageExecutor>,
    locks: Mutex<BTreeMap<Id, Weak<AsyncMutex<()>>>>,
    concurrency: Semaphore,
    stage_timeout: Duration,
}
impl CloudController {
    pub fn new(
        store: Arc<SqliteCloudTaskStore>,
        executor: Arc<dyn StageExecutor>,
        concurrency: usize,
        stage_timeout: Duration,
    ) -> CloudResult<Self> {
        if !(1..=64).contains(&concurrency) || stage_timeout.is_zero() {
            return Err(CloudError::new(
                ErrorCode::InvalidRequest,
                "invalid controller limits",
            ));
        }
        Ok(Self {
            store,
            executor,
            locks: Mutex::new(BTreeMap::new()),
            concurrency: Semaphore::new(concurrency),
            stage_timeout,
        })
    }
    pub fn store(&self) -> &Arc<SqliteCloudTaskStore> {
        &self.store
    }

    /// Explicit control service tick. No spawned self-owning tasks and no
    /// observer connection ownership: disconnecting a client does not cancel it.
    pub async fn reconcile_task(
        &self,
        owner: &Id,
        task_id: &Id,
        now_ms: Counter,
    ) -> CloudResult<ReconcileReport> {
        let lock = {
            let mut locks = self.locks.lock().map_err(|_| {
                CloudError::new(ErrorCode::Internal, "controller task lock poisoned")
            })?;
            locks.retain(|_, weak| weak.strong_count() != 0);
            let lock = locks
                .get(task_id)
                .and_then(Weak::upgrade)
                .unwrap_or_else(|| Arc::new(AsyncMutex::new(())));
            locks.insert(task_id.clone(), Arc::downgrade(&lock));
            lock
        };
        let _task_guard = lock.lock().await;
        let _capacity =
            self.concurrency.acquire().await.map_err(|_| {
                CloudError::new(ErrorCode::RuntimeUnavailable, "controller stopped")
            })?;
        let mut report = ReconcileReport::default();
        let mut seen = Vec::new();
        // Prepare -> Activate, or Settle. Finite tick, no busy retry on unknown.
        for _ in 0..4 {
            let task = self.store.get(owner, task_id)?;
            if task.phase.is_terminal() {
                break;
            }
            let all = self.store.stage_intents(owner, task_id)?;
            // Replay saved external proofs first, even if a cancel superseded
            // their original phase. No network dispatch occurs on this path.
            let mut cached = None;
            for intent in &all {
                if !seen.contains(&intent.operation_id)
                    && !matches!(
                        intent.status,
                        IntentStatus::Verified | IntentStatus::Quiesced
                    )
                {
                    if let Some(observation) = self.store.observation(&intent.operation_id)? {
                        cached = Some((intent.clone(), observation));
                        break;
                    }
                }
            }
            let (intent, cached) = if let Some((intent, observation)) = cached {
                (intent, Some(observation))
            } else {
                // Cancellation supersedes a stage, not its possible effects.
                // Query retained in-flight Prepare/Activate first so a known
                // late activation is recorded before selecting a stop proof.
                let superseded = all
                    .iter()
                    .find(|i| {
                        !seen.contains(&i.operation_id)
                            && matches!(
                                i.status,
                                IntentStatus::Running | IntentStatus::NeedsReconcile
                            )
                            && !in_phase(i.kind, task.phase)
                    })
                    .cloned();
                let candidate = match superseded {
                    Some(intent) => Some(intent),
                    None => self
                        .store
                        .pending_intents(owner, task_id)?
                        .into_iter()
                        .find(|i| !seen.contains(&i.operation_id)),
                };
                let Some(intent) = candidate else {
                    break;
                };
                (intent, None)
            };
            seen.push(intent.operation_id.clone());
            let mut operation = StageOperation {
                task,
                intent,
                prior_intents: all,
            };
            let observation = if let Some(observation) = cached {
                Some(observation)
            } else {
                let result = if operation.intent.status == IntentStatus::Pending {
                    self.store.record_dispatch(
                        owner,
                        task_id,
                        &operation.intent.operation_id,
                        IntentStatus::Running,
                        now_ms,
                    )?;
                    operation.intent.status = IntentStatus::Running;
                    if operation.intent.kind == IntentKind::Prepare {
                        self.fact(
                            owner,
                            task_id,
                            &operation.intent.scope,
                            TaskFact::PrepareAdmitted {
                                operation_id: operation.intent.operation_id.clone(),
                            },
                            now_ms,
                        )?;
                    }
                    // Cancellation may have committed while dispatch was planned.
                    operation.task = self.store.get(owner, task_id)?;
                    if !in_phase(operation.intent.kind, operation.task.phase) {
                        report
                            .unknown_operations
                            .push(operation.intent.operation_id.clone());
                        continue;
                    }
                    report.dispatched += 1;
                    tokio::time::timeout(self.stage_timeout, self.executor.execute(&operation))
                        .await
                } else {
                    report.queried += 1;
                    tokio::time::timeout(self.stage_timeout, async {
                        self.executor.inspect(&operation).await?.ok_or_else(|| {
                            CloudError::new(
                                ErrorCode::OutcomeUnknown,
                                "external stage has no authoritative receipt",
                            )
                        })
                    })
                    .await
                };
                match result {
                    Ok(Ok(observation)) => Some(observation),
                    Ok(Err(_)) | Err(_) => {
                        if operation.intent.status == IntentStatus::Running {
                            self.store.record_dispatch(
                                owner,
                                task_id,
                                &operation.intent.operation_id,
                                IntentStatus::NeedsReconcile,
                                now_ms,
                            )?;
                        }
                        report
                            .unknown_operations
                            .push(operation.intent.operation_id.clone());
                        None
                    }
                }
            };
            if let Some(observation) = observation {
                observation.validate(&operation)?;
                // Never durably freeze an incomplete stop proof as a receipt.
                // Preview is pure; the real commit still rechecks latest CAS.
                if let StageOutcome::Settled {
                    sealed,
                    stop_proof,
                    retention,
                } = &observation.outcome
                {
                    let mut preview = self.store.get(owner, task_id)?;
                    if *sealed {
                        preview = reduce_task(
                            &preview,
                            &observation.scope,
                            &TaskFact::Sealed {
                                operation_id: observation.operation_id.clone(),
                            },
                        )?;
                    }
                    preview = reduce_task(
                        &preview,
                        &observation.scope,
                        &TaskFact::StopVerified {
                            operation_id: observation.operation_id.clone(),
                            proof: stop_proof.clone(),
                        },
                    )?;
                    preview = reduce_task(
                        &preview,
                        &observation.scope,
                        &TaskFact::RetentionVerified {
                            operation_id: observation.operation_id.clone(),
                            receipt: retention.clone(),
                        },
                    )?;
                    reduce_task(&preview, &observation.scope, &TaskFact::CommitTerminal)?;
                }
                self.store.save_observation(&observation)?;
                self.apply(owner, task_id, &operation, &observation, now_ms)?;
                report.verified += 1;
            }
        }
        Ok(report)
    }

    fn fact(
        &self,
        owner: &Id,
        task_id: &Id,
        scope: &BindingScope,
        fact: TaskFact,
        now_ms: Counter,
    ) -> CloudResult<TaskRecord> {
        for _ in 0..8 {
            let task = self.store.get(owner, task_id)?;
            match self
                .store
                .apply_fact(owner, task_id, task.revision, scope, &fact, now_ms)
            {
                Err(e) if e.code == ErrorCode::RevisionConflict => continue,
                result => return result,
            }
        }
        Err(CloudError::new(
            ErrorCode::RevisionConflict,
            "concurrent task change requires another reconcile tick",
        ))
    }
    fn apply(
        &self,
        owner: &Id,
        task_id: &Id,
        operation: &StageOperation,
        observation: &StageObservation,
        now_ms: Counter,
    ) -> CloudResult<()> {
        let scope = &observation.scope;
        match &observation.outcome {
            StageOutcome::Prepared {
                ready,
                bootstrap_prepared,
            } => {
                let task = self.store.get(owner, task_id)?;
                if task.phase == TaskPhase::Provisioning {
                    match self.fact(
                        owner,
                        task_id,
                        scope,
                        TaskFact::Prepared {
                            operation_id: observation.operation_id.clone(),
                            ready: *ready,
                            bootstrap_prepared: *bootstrap_prepared,
                            grant_committed: true,
                        },
                        now_ms,
                    ) {
                        Err(e)
                            if e.code == ErrorCode::InvalidRequest
                                && self.store.get(owner, task_id)?.phase == TaskPhase::Settling => {
                        }
                        result => {
                            result?;
                        }
                    }
                }
                self.store
                    .verify_intent(owner, task_id, &observation.operation_id)?;
            }
            StageOutcome::Activated => {
                self.fact(
                    owner,
                    task_id,
                    scope,
                    TaskFact::Activated {
                        operation_id: observation.operation_id.clone(),
                    },
                    now_ms,
                )?;
            }
            StageOutcome::Settled {
                sealed,
                stop_proof,
                retention,
            } => {
                if *sealed {
                    self.fact(
                        owner,
                        task_id,
                        scope,
                        TaskFact::Sealed {
                            operation_id: observation.operation_id.clone(),
                        },
                        now_ms,
                    )?;
                }
                self.fact(
                    owner,
                    task_id,
                    scope,
                    TaskFact::StopVerified {
                        operation_id: observation.operation_id.clone(),
                        proof: stop_proof.clone(),
                    },
                    now_ms,
                )?;
                self.fact(
                    owner,
                    task_id,
                    scope,
                    TaskFact::RetentionVerified {
                        operation_id: observation.operation_id.clone(),
                        receipt: retention.clone(),
                    },
                    now_ms,
                )?;
                self.fact(owner, task_id, scope, TaskFact::CommitTerminal, now_ms)?;
            }
            StageOutcome::Failed { .. } => {
                if operation.intent.status != IntentStatus::KnownFailed {
                    self.store.record_dispatch(
                        owner,
                        task_id,
                        &observation.operation_id,
                        IntentStatus::KnownFailed,
                        now_ms,
                    )?;
                }
                if operation.intent.kind == IntentKind::Settle {
                    self.fact(
                        owner,
                        task_id,
                        scope,
                        TaskFact::CleanupBlocked {
                            operation_id: observation.operation_id.clone(),
                            reason: "verified settlement failure; manual reconciliation required"
                                .into(),
                        },
                        now_ms,
                    )?;
                } else {
                    // Deterministic, stable identity; never rotate on restart.
                    let settlement_id =
                        Id::new(format!("settle_{}", observation.operation_id.as_str()))?;
                    self.fact(
                        owner,
                        task_id,
                        scope,
                        TaskFact::FailureRequested {
                            operation_id: settlement_id,
                            reason: "verified environment stage failure".into(),
                        },
                        now_ms,
                    )?;
                }
            }
        }
        Ok(())
    }
}
fn in_phase(kind: IntentKind, phase: TaskPhase) -> bool {
    matches!(
        (kind, phase),
        (
            IntentKind::Prepare,
            TaskPhase::Accepted | TaskPhase::Provisioning
        ) | (IntentKind::Activate, TaskPhase::Attached)
            | (IntentKind::Settle, TaskPhase::Settling)
    )
}

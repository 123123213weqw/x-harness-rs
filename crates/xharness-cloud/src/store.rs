use crate::*;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptStatus {
    Accepted,
    Running,
    NeedsReconcile,
    Applied,
    Rejected,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OperationReceipt {
    pub request_id: Id,
    pub operation_id: Id,
    pub task_id: Id,
    pub method: String,
    pub payload_fingerprint: PayloadFingerprint,
    pub status: ReceiptStatus,
    pub accepted_revision: Counter,
    pub result_ref: Option<VersionedRef>,
    pub error: Option<CloudError>,
    pub created_at_ms: Counter,
    pub updated_at_ms: Counter,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntentKind {
    Prepare,
    Activate,
    Settle,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntentStatus {
    Pending,
    Running,
    NeedsReconcile,
    Verified,
    KnownFailed,
    Quiesced,
}

/// Settle is orchestration (seal -> native shutdown -> stop -> retention), not
/// a direct VM kill. Stable IDs are committed together with admission state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StageIntent {
    pub operation_id: Id,
    pub scope: BindingScope,
    pub kind: IntentKind,
    pub status: IntentStatus,
}

pub trait CloudTaskStore: Send + Sync {
    fn admit(
        &self,
        owner: &Id,
        command: &CommandEnvelope,
        now_ms: Counter,
    ) -> CloudResult<OperationReceipt>;
    fn get(&self, owner: &Id, task_id: &Id) -> CloudResult<TaskRecord>;
    fn receipt(&self, owner: &Id, request_id: &Id) -> CloudResult<Option<OperationReceipt>>;
    /// Internal verified fact commit, not exposed to untrusted client payloads.
    fn apply_fact(
        &self,
        owner: &Id,
        task_id: &Id,
        expected: Counter,
        scope: &BindingScope,
        fact: &TaskFact,
        now_ms: Counter,
    ) -> CloudResult<TaskRecord>;
}

/// Persistence port: a mutation contains only changed rows, never a whole history.
/// An error may mean COMMIT succeeded but its acknowledgement was lost. The state
/// store fences itself after *any* sink error and requires reopening from disk.
pub trait CloudCommitSink: Send + Sync {
    fn commit(&self, mutation: &CloudMutation) -> CloudResult<()>;
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnedReceipt {
    pub owner_id: Id,
    pub receipt: OperationReceipt,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CloudSnapshot {
    pub generation: Counter,
    pub next_id: Counter,
    pub environments: Vec<RegisteredEnvironment>,
    pub tasks: Vec<TaskRecord>,
    pub receipts: Vec<OwnedReceipt>,
    pub intents: Vec<StageIntent>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CloudMutation {
    pub expected_generation: Counter,
    pub generation: Counter,
    pub next_id: Option<Counter>,
    pub environments: Vec<RegisteredEnvironment>,
    pub tasks: Vec<TaskRecord>,
    pub receipts: Vec<OwnedReceipt>,
    pub intents: Vec<StageIntent>,
}

#[derive(Default)]
struct MemoryState {
    generation: Counter,
    next_id: Counter,
    environments: BTreeMap<(Id, Id), RegisteredEnvironment>,
    tasks: BTreeMap<Id, TaskRecord>,
    receipts: BTreeMap<(Id, Id), OperationReceipt>,
    intents: BTreeMap<Id, StageIntent>,
    bound_instances: BTreeMap<Id, Id>,
    bound_volumes: BTreeMap<Id, Id>,
}

/// One set of admission/reducer rules for ephemeral tests and durable adapters.
/// The mutex covers planning -> durable commit -> publishing. It is never held
/// during VM/Host I/O. Local writer ownership is supplied by the sink, not this
/// mutex and not a substitute for VM execution fencing.
#[derive(Default)]
pub struct MemoryCloudTaskStore {
    state: Mutex<MemoryState>,
    limits: AdmissionLimits,
    sink: Option<Arc<dyn CloudCommitSink>>,
    fenced: AtomicBool,
}

impl MemoryCloudTaskStore {
    pub fn new(limits: AdmissionLimits) -> Self {
        Self {
            limits,
            ..Self::default()
        }
    }

    pub fn restore(
        snapshot: CloudSnapshot,
        limits: AdmissionLimits,
        sink: Arc<dyn CloudCommitSink>,
    ) -> CloudResult<Self> {
        let state = restore_state(snapshot, &limits)?;
        Ok(Self {
            state: Mutex::new(state),
            limits,
            sink: Some(sink),
            fenced: AtomicBool::new(false),
        })
    }

    /// Startup/explicit diagnostics only, not called on every write.
    pub fn snapshot(&self) -> CloudResult<CloudSnapshot> {
        let state = self.lock()?;
        Ok(CloudSnapshot {
            generation: state.generation,
            next_id: state.next_id,
            environments: state.environments.values().cloned().collect(),
            tasks: state.tasks.values().cloned().collect(),
            receipts: state
                .receipts
                .iter()
                .map(|((owner, _), receipt)| OwnedReceipt {
                    owner_id: owner.clone(),
                    receipt: receipt.clone(),
                })
                .collect(),
            intents: state.intents.values().cloned().collect(),
        })
    }

    pub fn tasks(&self, owner: &Id) -> CloudResult<Vec<TaskRecord>> {
        Ok(self
            .lock()?
            .tasks
            .values()
            .filter(|t| &t.owner_id == owner)
            .cloned()
            .collect())
    }

    pub fn environments(&self, owner: &Id) -> CloudResult<Vec<RegisteredEnvironment>> {
        Ok(self
            .lock()?
            .environments
            .values()
            .filter(|e| &e.owner_id == owner)
            .cloned()
            .collect())
    }

    pub fn register_environment(&self, environment: RegisteredEnvironment) -> CloudResult<()> {
        let mut state = self.lock()?;
        let key = (
            environment.environment_ref.id.clone(),
            environment.environment_ref.version.clone(),
        );
        if let Some(existing) = state.environments.get(&key) {
            return if existing == &environment {
                Ok(())
            } else {
                Err(CloudError::new(
                    ErrorCode::IdempotencyConflict,
                    "registered environment version is immutable",
                ))
            };
        }
        if state.bound_instances.contains_key(&environment.instance_id)
            || state.bound_volumes.contains_key(&environment.volume_id)
        {
            return Err(CloudError::new(
                ErrorCode::EnvironmentBusy,
                "cannot change a reserved environment",
            ));
        }
        if environment.execution_epoch.0 == 0 {
            return Err(crate::contract::invalid(
                "environment epoch must be nonzero",
            ));
        }
        let mut mutation = mutation(&state)?;
        mutation.environments.push(environment);
        self.commit(&mut state, mutation)
    }

    pub fn pending_intents(&self, owner: &Id, task_id: &Id) -> CloudResult<Vec<StageIntent>> {
        let state = self.lock()?;
        let task = owned_task(&state, owner, task_id)?;
        Ok(state
            .intents
            .values()
            .filter(|i| {
                &i.scope.task_id == task_id
                    && matches!(
                        i.status,
                        IntentStatus::Pending
                            | IntentStatus::Running
                            | IntentStatus::NeedsReconcile
                    )
                    && matches!(
                        (i.kind, task.phase),
                        (
                            IntentKind::Prepare,
                            TaskPhase::Accepted | TaskPhase::Provisioning
                        ) | (IntentKind::Activate, TaskPhase::Attached)
                            | (IntentKind::Settle, TaskPhase::Settling)
                    )
            })
            .cloned()
            .collect())
    }

    /// Retained stage identities, including superseded/uncertain preparation.
    /// A settle driver must inspect these rather than assuming preparation never ran.
    pub fn stage_intents(&self, owner: &Id, task_id: &Id) -> CloudResult<Vec<StageIntent>> {
        let state = self.lock()?;
        owned_task(&state, owner, task_id)?;
        Ok(state
            .intents
            .values()
            .filter(|i| &i.scope.task_id == task_id)
            .cloned()
            .collect())
    }

    /// Record dispatch/unknown facts only. Success is applied through verified
    /// lifecycle facts, not this bookkeeping method. NeedsReconcile cannot be
    /// reset to Pending/Running and blindly dispatched again.
    pub fn record_dispatch(
        &self,
        owner: &Id,
        task_id: &Id,
        operation_id: &Id,
        status: IntentStatus,
        now_ms: Counter,
    ) -> CloudResult<()> {
        let mut state = self.lock()?;
        let task = owned_task(&state, owner, task_id)?;
        let intent = state
            .intents
            .get(operation_id)
            .filter(|i| &i.scope.task_id == task_id)
            .ok_or_else(|| CloudError::new(ErrorCode::NotFound, "stage intent not found"))?;
        let in_phase = matches!(
            (intent.kind, task.phase),
            (
                IntentKind::Prepare,
                TaskPhase::Accepted | TaskPhase::Provisioning
            ) | (IntentKind::Activate, TaskPhase::Attached)
                | (IntentKind::Settle, TaskPhase::Settling)
        );
        if (status == IntentStatus::Running && !in_phase)
            || !matches!(
                (intent.status, status),
                (IntentStatus::Pending, IntentStatus::Running)
                    | (
                        IntentStatus::Running,
                        IntentStatus::NeedsReconcile | IntentStatus::KnownFailed
                    )
                    | (IntentStatus::NeedsReconcile, IntentStatus::KnownFailed)
            )
        {
            return Err(crate::contract::invalid(
                "invalid stage dispatch transition",
            ));
        }
        let kind = intent.kind;
        let mut changed = intent.clone();
        changed.status = status;
        let mut mutation = mutation(&state)?;
        mutation.intents.push(changed);
        for ((receipt_owner, _), old) in state.receipts.iter().filter(|(_, r)| {
            &r.task_id == task_id
                && ((kind == IntentKind::Prepare || kind == IntentKind::Activate)
                    && r.method == "task.submit"
                    || kind == IntentKind::Settle && r.method == "task.cancel")
        }) {
            if old.status == ReceiptStatus::Applied {
                continue;
            }
            let mut receipt = old.clone();
            receipt.status = match status {
                IntentStatus::NeedsReconcile => ReceiptStatus::NeedsReconcile,
                IntentStatus::KnownFailed => ReceiptStatus::Failed,
                _ => ReceiptStatus::Running,
            };
            if status == IntentStatus::KnownFailed {
                receipt.error = Some(CloudError::new(
                    ErrorCode::RuntimeUnavailable,
                    "environment stage failed; task settlement is still required",
                ));
            }
            receipt.updated_at_ms = receipt.updated_at_ms.max(now_ms);
            mutation.receipts.push(OwnedReceipt {
                owner_id: receipt_owner.clone(),
                receipt,
            });
        }
        self.commit(&mut state, mutation)
    }

    /// Called only after a trusted adapter's immutable receipt has been saved.
    /// A late Prepare receipt may be verified after cancellation without
    /// producing Attached or an Activate intent.
    pub fn verify_intent(&self, owner: &Id, task_id: &Id, operation_id: &Id) -> CloudResult<()> {
        let mut state = self.lock()?;
        owned_task(&state, owner, task_id)?;
        let old = state
            .intents
            .get(operation_id)
            .filter(|i| &i.scope.task_id == task_id)
            .ok_or_else(|| CloudError::new(ErrorCode::NotFound, "stage intent not found"))?;
        if old.status == IntentStatus::Verified {
            return Ok(());
        }
        if !matches!(
            old.status,
            IntentStatus::Running | IntentStatus::NeedsReconcile | IntentStatus::KnownFailed
        ) {
            return Err(crate::contract::invalid(
                "undispatched or quiesced intent cannot be verified",
            ));
        }
        let mut change = mutation(&state)?;
        let mut intent = old.clone();
        intent.status = IntentStatus::Verified;
        change.intents.push(intent);
        self.commit(&mut state, change)
    }

    fn commit(&self, state: &mut MemoryState, mutation: CloudMutation) -> CloudResult<()> {
        if let Some(sink) = &self.sink {
            if let Err(error) = sink.commit(&mutation) {
                self.fenced.store(true, Ordering::Release);
                return Err(error);
            }
        }
        publish(state, mutation);
        Ok(())
    }

    fn lock(&self) -> CloudResult<MutexGuard<'_, MemoryState>> {
        if self.fenced.load(Ordering::Acquire) {
            return Err(CloudError::new(
                ErrorCode::StorageFailure,
                "store requires reopening after uncertain persistence",
            ));
        }
        let guard = self.state.lock().map_err(|_| {
            CloudError::new(ErrorCode::StorageFailure, "memory store lock is poisoned")
        })?;
        // A waiter may have passed the first check before another writer fenced.
        if self.fenced.load(Ordering::Acquire) {
            return Err(CloudError::new(
                ErrorCode::StorageFailure,
                "store requires reopening after uncertain persistence",
            ));
        }
        Ok(guard)
    }
}

impl CloudTaskStore for MemoryCloudTaskStore {
    fn admit(
        &self,
        owner: &Id,
        envelope: &CommandEnvelope,
        now_ms: Counter,
    ) -> CloudResult<OperationReceipt> {
        envelope.validate(&self.limits)?;
        let fingerprint = envelope.command.fingerprint()?;
        let mut state = self.lock()?;
        // Access checks precede receipt replay; capability/CAS checks follow it.
        // Replay must still work after the first command changed the revision or
        // reserved the VM. Method changes under the same ID always conflict.
        match &envelope.command {
            Command::Submit(request) => {
                authorized_environment(&state, owner, &request.spec.environment_ref)?;
            }
            Command::Cancel(request) => {
                owned_task(&state, owner, &request.task_id)?;
            }
        }
        let receipt_key = (owner.clone(), envelope.request_id.clone());
        if let Some(receipt) = state.receipts.get(&receipt_key) {
            if receipt.method != envelope.command.method()
                || receipt.payload_fingerprint != fingerprint
            {
                return Err(CloudError::new(
                    ErrorCode::IdempotencyConflict,
                    "request ID was already used with different content",
                ));
            }
            return Ok(receipt.clone());
        }

        let serial = state.next_id.next()?;
        let operation_id = Id::new(format!("op_{}", serial.0))?;
        let (record, intent) = match &envelope.command {
            Command::Submit(request) => {
                let env = authorized_environment(&state, owner, &request.spec.environment_ref)?;
                env.validate_submission(&request.spec)?;
                if state.bound_instances.contains_key(&env.instance_id)
                    || state.bound_volumes.contains_key(&env.volume_id)
                {
                    return Err(CloudError::new(
                        ErrorCode::EnvironmentBusy,
                        "environment or persistent volume is already reserved",
                    ));
                }
                let task_id = Id::new(format!("task_{}", serial.0))?;
                let scope = BindingScope {
                    task_id: task_id.clone(),
                    binding_id: Id::new(format!("binding_{}", serial.0))?,
                    environment_instance_id: env.instance_id.clone(),
                    volume_id: env.volume_id.clone(),
                    execution_epoch: env.execution_epoch,
                };
                let prepare_operation_id = Id::new(format!("prepare_{}", serial.0))?;
                let record = TaskRecord {
                    task_id,
                    owner_id: owner.clone(),
                    spec: request.spec.clone(),
                    revision: Counter(1),
                    phase: TaskPhase::Accepted,
                    binding: Binding {
                        scope: scope.clone(),
                        root_session_id: Id::new(format!("session_{}", serial.0))?,
                        host_build_ref: env.host_build_ref.clone(),
                        external_stop_authorized: env.external_stop_authorized,
                        external_stop_support: env.capabilities.support(Capability::ExternalStop),
                    },
                    prepare_operation_id: prepare_operation_id.clone(),
                    activate_operation_id: Id::new(format!("activate_{}", serial.0))?,
                    activated: false,
                    settlement: None,
                    completion_evidence: None,
                    failure_reasons: Vec::new(),
                };
                (
                    record,
                    Some(StageIntent {
                        operation_id: prepare_operation_id,
                        scope,
                        kind: IntentKind::Prepare,
                        status: IntentStatus::Pending,
                    }),
                )
            }
            Command::Cancel(request) => {
                let current = owned_task(&state, owner, &request.task_id)?;
                // A terminal cancellation is a read/no-op, not a Task mutation.
                // A cancel racing behind terminal CAS returns that terminal fact,
                // even when its originally observed revision is now stale.
                if !current.phase.is_terminal() && current.revision != request.expected_revision {
                    return Err(revision_conflict());
                }
                let record = reduce_task(
                    current,
                    &current.binding.scope,
                    &TaskFact::CancelRequested {
                        operation_id: operation_id.clone(),
                    },
                )?;
                let intent = if current.settlement.is_none() && !current.phase.is_terminal() {
                    Some(StageIntent {
                        operation_id: operation_id.clone(),
                        scope: current.binding.scope.clone(),
                        kind: IntentKind::Settle,
                        status: IntentStatus::Pending,
                    })
                } else {
                    None
                };
                (record, intent)
            }
        };
        let receipt = OperationReceipt {
            request_id: envelope.request_id.clone(),
            operation_id,
            task_id: record.task_id.clone(),
            method: envelope.command.method().into(),
            payload_fingerprint: fingerprint,
            status: if record.phase.is_terminal()
                || matches!(&envelope.command, Command::Cancel(_))
                    && record.settlement.as_ref().is_some_and(|s| s.sealed)
            {
                ReceiptStatus::Applied
            } else {
                ReceiptStatus::Accepted
            },
            accepted_revision: record.revision,
            result_ref: None,
            error: None,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
        };
        let mut mutation = mutation(&state)?;
        mutation.next_id = Some(serial);
        mutation.tasks.push(record);
        if let Some(intent) = intent {
            mutation.intents.push(intent);
        }
        mutation.receipts.push(OwnedReceipt {
            owner_id: owner.clone(),
            receipt: receipt.clone(),
        });
        self.commit(&mut state, mutation)?;
        Ok(receipt)
    }

    fn get(&self, owner: &Id, task_id: &Id) -> CloudResult<TaskRecord> {
        let state = self.lock()?;
        Ok(owned_task(&state, owner, task_id)?.clone())
    }

    fn receipt(&self, owner: &Id, request_id: &Id) -> CloudResult<Option<OperationReceipt>> {
        Ok(self
            .lock()?
            .receipts
            .get(&(owner.clone(), request_id.clone()))
            .cloned())
    }

    fn apply_fact(
        &self,
        owner: &Id,
        task_id: &Id,
        expected: Counter,
        scope: &BindingScope,
        fact: &TaskFact,
        now_ms: Counter,
    ) -> CloudResult<TaskRecord> {
        let mut state = self.lock()?;
        let current = owned_task(&state, owner, task_id)?;
        if current.revision != expected {
            return Err(revision_conflict());
        }
        let next = reduce_task(current, scope, fact)?;
        let new_intent = match fact {
            TaskFact::Prepared { .. } => Some(StageIntent {
                operation_id: next.activate_operation_id.clone(),
                scope: scope.clone(),
                kind: IntentKind::Activate,
                status: IntentStatus::Pending,
            }),
            TaskFact::FinishRequested { .. } | TaskFact::FailureRequested { .. }
                if current.settlement.is_none() =>
            {
                next.settlement.as_ref().map(|s| StageIntent {
                    operation_id: s.operation_id.clone(),
                    scope: scope.clone(),
                    kind: IntentKind::Settle,
                    status: IntentStatus::Pending,
                })
            }
            _ => None,
        };
        if let Some(intent) = &new_intent {
            if state
                .intents
                .get(&intent.operation_id)
                .is_some_and(|old| old.scope != intent.scope || old.kind != intent.kind)
            {
                return Err(CloudError::new(
                    ErrorCode::IdempotencyConflict,
                    "stage identity conflicts with an existing intent",
                ));
            }
        }
        let mut mutation = mutation(&state)?;
        for ((receipt_owner, _), old) in
            state.receipts.iter().filter(|(_, r)| &r.task_id == task_id)
        {
            let mut receipt = old.clone();
            match fact {
                TaskFact::Activated { .. } if receipt.method == "task.submit" => {
                    receipt.status = ReceiptStatus::Applied;
                    receipt.error = None;
                }
                TaskFact::PrepareAdmitted { .. }
                    if receipt.method == "task.submit"
                        && receipt.status == ReceiptStatus::Accepted =>
                {
                    receipt.status = ReceiptStatus::Running;
                }
                TaskFact::Sealed { .. } | TaskFact::CommitTerminal
                    if receipt.method == "task.cancel" =>
                {
                    receipt.status = ReceiptStatus::Applied;
                }
                TaskFact::CommitTerminal if receipt.method == "task.submit" && !next.activated => {
                    receipt.status = ReceiptStatus::Failed;
                    receipt.error = Some(CloudError::new(
                        ErrorCode::CleanupIncomplete,
                        "task settled without activation",
                    ));
                }
                _ => continue,
            }
            receipt.updated_at_ms = receipt.updated_at_ms.max(now_ms);
            if receipt != *old {
                mutation.receipts.push(OwnedReceipt {
                    owner_id: receipt_owner.clone(),
                    receipt,
                });
            }
        }
        match fact {
            TaskFact::Prepared { operation_id, .. } | TaskFact::Activated { operation_id } => {
                if let Some(old) = state.intents.get(operation_id) {
                    let mut changed = old.clone();
                    changed.status = IntentStatus::Verified;
                    if changed != *old {
                        mutation.intents.push(changed);
                    }
                }
            }
            TaskFact::CommitTerminal => {
                for old in state
                    .intents
                    .values()
                    .filter(|i| &i.scope.task_id == task_id)
                {
                    let mut changed = old.clone();
                    changed.status = if changed.kind == IntentKind::Settle
                        || changed.status == IntentStatus::Verified
                    {
                        IntentStatus::Verified
                    } else {
                        IntentStatus::Quiesced
                    };
                    if changed != *old {
                        mutation.intents.push(changed);
                    }
                }
            }
            _ => {}
        }
        if let Some(intent) = new_intent {
            // Idempotent Prepared must not reset a verified/running Activate.
            if !state.intents.contains_key(&intent.operation_id) {
                mutation.intents.push(intent);
            }
        }
        if next != *current {
            mutation.tasks.push(next.clone());
        }
        if !mutation.tasks.is_empty()
            || !mutation.receipts.is_empty()
            || !mutation.intents.is_empty()
        {
            self.commit(&mut state, mutation)?;
        }
        Ok(next)
    }
}

fn owned_task<'a>(state: &'a MemoryState, owner: &Id, task_id: &Id) -> CloudResult<&'a TaskRecord> {
    state
        .tasks
        .get(task_id)
        .filter(|t| &t.owner_id == owner)
        .ok_or_else(|| CloudError::new(ErrorCode::NotFound, "task not found"))
}

fn authorized_environment<'a>(
    state: &'a MemoryState,
    owner: &Id,
    reference: &VersionedRef,
) -> CloudResult<&'a RegisteredEnvironment> {
    state
        .environments
        .get(&(reference.id.clone(), reference.version.clone()))
        .filter(|e| &e.owner_id == owner)
        .ok_or_else(|| CloudError::new(ErrorCode::NotFound, "environment not found"))
}

fn revision_conflict() -> CloudError {
    CloudError::new(ErrorCode::RevisionConflict, "task revision conflict")
}

fn mutation(state: &MemoryState) -> CloudResult<CloudMutation> {
    Ok(CloudMutation {
        expected_generation: state.generation,
        generation: state.generation.next()?,
        next_id: None,
        environments: vec![],
        tasks: vec![],
        receipts: vec![],
        intents: vec![],
    })
}

fn publish(state: &mut MemoryState, change: CloudMutation) {
    state.generation = change.generation;
    if let Some(next_id) = change.next_id {
        state.next_id = next_id;
    }
    for env in change.environments {
        state.environments.insert(
            (
                env.environment_ref.id.clone(),
                env.environment_ref.version.clone(),
            ),
            env,
        );
    }
    for task in change.tasks {
        state.bound_instances.insert(
            task.binding.scope.environment_instance_id.clone(),
            task.task_id.clone(),
        );
        state
            .bound_volumes
            .insert(task.binding.scope.volume_id.clone(), task.task_id.clone());
        state.tasks.insert(task.task_id.clone(), task);
    }
    for row in change.receipts {
        state
            .receipts
            .insert((row.owner_id, row.receipt.request_id.clone()), row.receipt);
    }
    for intent in change.intents {
        state.intents.insert(intent.operation_id.clone(), intent);
    }
}

fn restore_state(snapshot: CloudSnapshot, limits: &AdmissionLimits) -> CloudResult<MemoryState> {
    let bad = || {
        CloudError::new(
            ErrorCode::StorageFailure,
            "persisted control state is inconsistent",
        )
    };
    let mut state = MemoryState {
        generation: snapshot.generation,
        next_id: snapshot.next_id,
        ..MemoryState::default()
    };
    for env in snapshot.environments {
        if env.execution_epoch.0 == 0
            || state
                .environments
                .insert(
                    (
                        env.environment_ref.id.clone(),
                        env.environment_ref.version.clone(),
                    ),
                    env,
                )
                .is_some()
        {
            return Err(bad());
        }
    }
    for task in snapshot.tasks {
        task.spec.validate(limits).map_err(|_| bad())?;
        let env = authorized_environment(&state, &task.owner_id, &task.spec.environment_ref)
            .map_err(|_| bad())?;
        env.validate_submission(&task.spec).map_err(|_| bad())?;
        let scope = &task.binding.scope;
        if task.revision.0 == 0
            || scope.task_id != task.task_id
            || scope.execution_epoch != env.execution_epoch
            || scope.environment_instance_id != env.instance_id
            || scope.volume_id != env.volume_id
            || task.binding.host_build_ref != env.host_build_ref
            || task.binding.external_stop_authorized != env.external_stop_authorized
            || task.binding.external_stop_support
                != env.capabilities.support(Capability::ExternalStop)
            || (task.phase == TaskPhase::Settling || task.phase.is_terminal())
                != task.settlement.is_some()
            || (task.activated
                && matches!(task.phase, TaskPhase::Accepted | TaskPhase::Provisioning))
        {
            return Err(bad());
        }
        // Validate strong proof fields, not just their presence in a terminal row.
        if let Some(settlement) = &task.settlement {
            let mut checking = task.clone();
            checking.phase = TaskPhase::Settling;
            if let Some(proof) = &settlement.stop_proof {
                reduce_task(
                    &checking,
                    scope,
                    &TaskFact::StopVerified {
                        operation_id: settlement.operation_id.clone(),
                        proof: proof.clone(),
                    },
                )
                .map_err(|_| bad())?;
            }
            if settlement.retention_receipt_ref.is_some() && settlement.stop_proof.is_none() {
                return Err(bad());
            }
            if settlement.requested_outcome == RequestedOutcome::Finished
                && (!task.activated
                    || !task.completion_evidence.as_ref().is_some_and(|e| {
                        e.goal_accepted && e.admission_sealed && !e.admitted_work_remaining
                    }))
            {
                return Err(bad());
            }
        }
        if task.phase.is_terminal() {
            let mut prior = task.clone();
            prior.phase = TaskPhase::Settling;
            let checked =
                reduce_task(&prior, scope, &TaskFact::CommitTerminal).map_err(|_| bad())?;
            if checked.phase != task.phase {
                return Err(bad());
            }
        }
        let serial = task
            .task_id
            .as_str()
            .strip_prefix("task_")
            .and_then(|s| s.parse::<u64>().ok())
            .ok_or_else(bad)?;
        if serial == 0
            || serial > state.next_id.0
            || task.task_id.as_str() != format!("task_{serial}")
            || task.binding.scope.binding_id.as_str() != format!("binding_{serial}")
            || task.binding.root_session_id.as_str() != format!("session_{serial}")
            || task.prepare_operation_id.as_str() != format!("prepare_{serial}")
            || task.activate_operation_id.as_str() != format!("activate_{serial}")
            || state
                .bound_instances
                .insert(scope.environment_instance_id.clone(), task.task_id.clone())
                .is_some()
            || state
                .bound_volumes
                .insert(scope.volume_id.clone(), task.task_id.clone())
                .is_some()
            || state.tasks.insert(task.task_id.clone(), task).is_some()
        {
            return Err(bad());
        }
    }
    let mut operation_ids = BTreeSet::new();
    for row in snapshot.receipts {
        let serial = row
            .receipt
            .operation_id
            .as_str()
            .strip_prefix("op_")
            .and_then(|s| s.parse::<u64>().ok())
            .ok_or_else(bad)?;
        if serial == 0
            || serial > state.next_id.0
            || row.receipt.operation_id.as_str() != format!("op_{serial}")
            || !operation_ids.insert(row.receipt.operation_id.clone())
        {
            return Err(bad());
        }
        let task = owned_task(&state, &row.owner_id, &row.receipt.task_id).map_err(|_| bad())?;
        if row.receipt.accepted_revision.0 == 0
            || row.receipt.accepted_revision > task.revision
            || !matches!(row.receipt.method.as_str(), "task.submit" | "task.cancel")
            || row.receipt.updated_at_ms < row.receipt.created_at_ms
            || state
                .receipts
                .insert((row.owner_id, row.receipt.request_id.clone()), row.receipt)
                .is_some()
        {
            return Err(bad());
        }
    }
    for intent in snapshot.intents {
        let task = state.tasks.get(&intent.scope.task_id).ok_or_else(bad)?;
        let expected_id = match intent.kind {
            IntentKind::Prepare => Some(&task.prepare_operation_id),
            IntentKind::Activate => Some(&task.activate_operation_id),
            IntentKind::Settle => task.settlement.as_ref().map(|s| &s.operation_id),
        };
        if expected_id != Some(&intent.operation_id)
            || intent.scope != task.binding.scope
            || (task.phase.is_terminal()
                && !matches!(
                    intent.status,
                    IntentStatus::Verified | IntentStatus::Quiesced
                ))
            || state
                .intents
                .insert(intent.operation_id.clone(), intent)
                .is_some()
        {
            return Err(bad());
        }
    }
    for task in state.tasks.values() {
        if !state.intents.contains_key(&task.prepare_operation_id)
            || (task.activated || task.phase == TaskPhase::Attached)
                && !state.intents.contains_key(&task.activate_operation_id)
            || task
                .settlement
                .as_ref()
                .is_some_and(|s| !state.intents.contains_key(&s.operation_id))
            || !state
                .receipts
                .values()
                .any(|r| r.task_id == task.task_id && r.method == "task.submit")
        {
            return Err(bad());
        }
    }
    Ok(state)
}

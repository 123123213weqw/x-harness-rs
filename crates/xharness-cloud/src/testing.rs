//! Deterministic contract fixtures. No SSH, VM, disk durability or process stop.
use crate::*;
use async_trait::async_trait;
use std::{
    collections::BTreeMap,
    sync::{Mutex, MutexGuard},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FakeFault {
    ApplyThenLoseReply,
    UnknownBeforeApply,
    KnownFailure,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FakePhase {
    Bound,
    Prepared,
    Stopped,
    Released,
}

#[derive(Default)]
struct FakeState {
    bindings: BTreeMap<Id, (BindingScope, FakePhase)>,
    volumes: BTreeMap<Id, BindingScope>,
    operations: BTreeMap<Id, (EnvironmentOperation, Option<EnvironmentOperationResult>)>,
    faults: BTreeMap<Id, FakeFault>,
    effects: BTreeMap<Id, usize>,
}

#[derive(Default)]
pub struct FakeEnvironment {
    state: Mutex<FakeState>,
}

impl FakeEnvironment {
    pub fn bind(&self, scope: BindingScope) -> CloudResult<()> {
        let mut state = self.lock()?;
        if let Some((old, phase)) = state.bindings.get(&scope.environment_instance_id) {
            if old == &scope && *phase != FakePhase::Released {
                return Ok(());
            }
            return Err(CloudError::new(
                ErrorCode::EnvironmentBusy,
                "fake environment is reserved or has a retained binding",
            ));
        }
        if state.volumes.contains_key(&scope.volume_id) {
            return Err(CloudError::new(
                ErrorCode::EnvironmentBusy,
                "fake volume is reserved",
            ));
        }
        state.volumes.insert(scope.volume_id.clone(), scope.clone());
        state.bindings.insert(
            scope.environment_instance_id.clone(),
            (scope, FakePhase::Bound),
        );
        Ok(())
    }

    pub fn inject_fault(&self, operation_id: Id, fault: FakeFault) -> CloudResult<()> {
        self.lock()?.faults.insert(operation_id, fault);
        Ok(())
    }

    pub fn effect_count(&self, operation_id: &Id) -> CloudResult<usize> {
        Ok(*self.lock()?.effects.get(operation_id).unwrap_or(&0))
    }

    fn lock(&self) -> CloudResult<MutexGuard<'_, FakeState>> {
        self.state.lock().map_err(|_| {
            CloudError::new(
                ErrorCode::StorageFailure,
                "fake environment lock is poisoned",
            )
        })
    }
}

#[async_trait]
impl EnvironmentBackend for FakeEnvironment {
    async fn execute(
        &self,
        operation: EnvironmentOperation,
    ) -> CloudResult<EnvironmentOperationResult> {
        let mut state = self.lock()?;
        let phase = verify_binding(&state, &operation.scope)?;
        if let Some((old, result)) = state.operations.get(&operation.operation_id) {
            if old != &operation {
                return Err(operation_conflict());
            }
            return result.clone().ok_or_else(unknown);
        }
        if state.operations.values().any(|(old, result)| {
            old.scope == operation.scope && old.kind == operation.kind && result.is_none()
        }) {
            // Choosing another ID cannot erase an unresolved prior attempt.
            return Err(unknown());
        }
        // Unknown outcomes are retained as tombstones, not treated as absence.
        let fault = state.faults.remove(&operation.operation_id);
        if fault == Some(FakeFault::UnknownBeforeApply) {
            state
                .operations
                .insert(operation.operation_id.clone(), (operation, None));
            return Err(unknown());
        }
        let result = if fault == Some(FakeFault::KnownFailure) {
            EnvironmentOperationResult::Failed {
                operation: operation.clone(),
                error: CloudError::new(
                    ErrorCode::CleanupIncomplete,
                    "injected known environment failure",
                ),
            }
        } else {
            let next_phase = match (operation.kind, phase) {
                (EnvironmentOperationKind::Prepare, FakePhase::Bound) => FakePhase::Prepared,
                (
                    EnvironmentOperationKind::Stop,
                    FakePhase::Bound | FakePhase::Prepared | FakePhase::Stopped,
                ) => FakePhase::Stopped,
                (EnvironmentOperationKind::Collect, FakePhase::Stopped) => FakePhase::Stopped,
                (EnvironmentOperationKind::Release, FakePhase::Stopped) => FakePhase::Released,
                _ => {
                    return Err(CloudError::new(
                        ErrorCode::CleanupIncomplete,
                        "fake lifecycle operation is out of phase",
                    ))
                }
            };
            state
                .bindings
                .get_mut(&operation.scope.environment_instance_id)
                .expect("binding verified")
                .1 = next_phase;
            *state
                .effects
                .entry(operation.operation_id.clone())
                .or_default() += 1;
            EnvironmentOperationResult::Applied {
                operation: operation.clone(),
            }
        };
        state.operations.insert(
            operation.operation_id.clone(),
            (operation, Some(result.clone())),
        );
        if fault == Some(FakeFault::ApplyThenLoseReply) {
            Err(unknown())
        } else {
            Ok(result)
        }
    }

    async fn inspect(
        &self,
        operation: &EnvironmentOperation,
    ) -> CloudResult<Option<EnvironmentOperationResult>> {
        let state = self.lock()?;
        verify_binding(&state, &operation.scope)?;
        match state.operations.get(&operation.operation_id) {
            Some((old, result)) if old == operation => Ok(result.clone()),
            Some(_) => Err(operation_conflict()),
            None => Ok(None),
        }
    }
}

fn verify_binding(state: &FakeState, scope: &BindingScope) -> CloudResult<FakePhase> {
    match state.bindings.get(&scope.environment_instance_id) {
        Some((current, phase))
            if current == scope && state.volumes.get(&scope.volume_id) == Some(scope) =>
        {
            Ok(*phase)
        }
        _ => Err(CloudError::new(
            ErrorCode::OwnershipUnverified,
            "fake operation has stale or unowned binding",
        )),
    }
}

fn unknown() -> CloudError {
    CloudError::new(
        ErrorCode::OutcomeUnknown,
        "environment operation outcome requires inspection",
    )
}
fn operation_conflict() -> CloudError {
    CloudError::new(
        ErrorCode::IdempotencyConflict,
        "stage operation ID was reused with different content",
    )
}

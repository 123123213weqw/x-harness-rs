mod common;
use common::*;
use xharness_cloud::{
    testing::{FakeEnvironment, FakeFault},
    *,
};

fn operation(
    scope: &BindingScope,
    operation_id: &str,
    kind: EnvironmentOperationKind,
) -> EnvironmentOperation {
    EnvironmentOperation {
        operation_id: id(operation_id),
        scope: scope.clone(),
        kind,
    }
}
#[tokio::test]
async fn applied_prepare_lost_reply_reconciles_same_identity_without_second_effect() {
    let store = store();
    let record = accepted(&store);
    let backend = FakeEnvironment::default();
    backend.bind(record.binding.scope.clone()).unwrap();
    let op = operation(
        &record.binding.scope,
        record.prepare_operation_id.as_str(),
        EnvironmentOperationKind::Prepare,
    );
    backend
        .inject_fault(op.operation_id.clone(), FakeFault::ApplyThenLoseReply)
        .unwrap();
    code(backend.execute(op.clone()).await, ErrorCode::OutcomeUnknown);
    assert_eq!(backend.effect_count(&op.operation_id).unwrap(), 1);
    let receipt = backend.inspect(&op).await.unwrap().unwrap();
    assert_eq!(
        receipt,
        EnvironmentOperationResult::Applied {
            operation: op.clone()
        }
    );
    assert_eq!(backend.execute(op.clone()).await.unwrap(), receipt);
    assert_eq!(backend.effect_count(&op.operation_id).unwrap(), 1);
}
#[tokio::test]
async fn unknown_before_apply_is_not_blindly_replayed_when_inspection_is_empty() {
    let store = store();
    let record = accepted(&store);
    let backend = FakeEnvironment::default();
    backend.bind(record.binding.scope.clone()).unwrap();
    let op = operation(
        &record.binding.scope,
        "prepare",
        EnvironmentOperationKind::Prepare,
    );
    backend
        .inject_fault(op.operation_id.clone(), FakeFault::UnknownBeforeApply)
        .unwrap();
    code(backend.execute(op.clone()).await, ErrorCode::OutcomeUnknown);
    assert!(backend.inspect(&op).await.unwrap().is_none());
    code(backend.execute(op.clone()).await, ErrorCode::OutcomeUnknown);
    assert_eq!(backend.effect_count(&op.operation_id).unwrap(), 0);
}
#[tokio::test]
async fn known_failure_is_queryable_and_does_not_claim_success_or_zero_unknown_outcome() {
    let store = store();
    let record = accepted(&store);
    let backend = FakeEnvironment::default();
    backend.bind(record.binding.scope.clone()).unwrap();
    let op = operation(
        &record.binding.scope,
        "stop",
        EnvironmentOperationKind::Stop,
    );
    backend
        .inject_fault(op.operation_id.clone(), FakeFault::KnownFailure)
        .unwrap();
    let receipt = backend.execute(op.clone()).await.unwrap();
    assert!(matches!(receipt, EnvironmentOperationResult::Failed { .. }));
    assert_eq!(backend.inspect(&op).await.unwrap(), Some(receipt.clone()));
    assert_eq!(backend.execute(op.clone()).await.unwrap(), receipt);
    assert_eq!(backend.effect_count(&op.operation_id).unwrap(), 0);
}
#[tokio::test]
async fn stage_id_conflict_and_old_epoch_cannot_mutate_binding() {
    let store = store();
    let record = accepted(&store);
    let backend = FakeEnvironment::default();
    backend.bind(record.binding.scope.clone()).unwrap();
    let op = operation(
        &record.binding.scope,
        "prepare",
        EnvironmentOperationKind::Prepare,
    );
    backend.execute(op.clone()).await.unwrap();
    let mut changed = op.clone();
    changed.kind = EnvironmentOperationKind::Stop;
    code(
        backend.execute(changed.clone()).await,
        ErrorCode::IdempotencyConflict,
    );
    code(
        backend.inspect(&changed).await,
        ErrorCode::IdempotencyConflict,
    );
    let mut stale = op.clone();
    stale.scope.execution_epoch = Counter(2);
    code(
        backend.execute(stale.clone()).await,
        ErrorCode::OwnershipUnverified,
    );
    code(
        backend.inspect(&stale).await,
        ErrorCode::OwnershipUnverified,
    );
    assert_eq!(backend.effect_count(&op.operation_id).unwrap(), 1);
}
#[tokio::test]
async fn collect_release_require_stopped_and_release_does_not_restart_execution() {
    let store = store();
    let record = accepted(&store);
    let backend = FakeEnvironment::default();
    backend.bind(record.binding.scope.clone()).unwrap();
    let scope = &record.binding.scope;
    backend
        .execute(operation(
            scope,
            "prepare",
            EnvironmentOperationKind::Prepare,
        ))
        .await
        .unwrap();
    for kind in [
        EnvironmentOperationKind::Collect,
        EnvironmentOperationKind::Release,
    ] {
        code(
            backend.execute(operation(scope, "too-early", kind)).await,
            ErrorCode::CleanupIncomplete,
        );
    }
    let stop = operation(scope, "stop", EnvironmentOperationKind::Stop);
    backend
        .inject_fault(stop.operation_id.clone(), FakeFault::ApplyThenLoseReply)
        .unwrap();
    code(
        backend.execute(stop.clone()).await,
        ErrorCode::OutcomeUnknown,
    );
    assert!(matches!(
        backend.inspect(&stop).await.unwrap(),
        Some(EnvironmentOperationResult::Applied { .. })
    ));
    backend
        .execute(operation(
            scope,
            "collect",
            EnvironmentOperationKind::Collect,
        ))
        .await
        .unwrap();
    let release = operation(scope, "release", EnvironmentOperationKind::Release);
    let receipt = backend.execute(release.clone()).await.unwrap();
    assert_eq!(backend.execute(release).await.unwrap(), receipt);
    code(
        backend
            .execute(operation(
                scope,
                "late-prepare",
                EnvironmentOperationKind::Prepare,
            ))
            .await,
        ErrorCode::CleanupIncomplete,
    );
}
#[test]
fn dual_vm_same_volume_and_rebinding_without_fencing_proof_are_rejected() {
    let store = store();
    let record = accepted(&store);
    let backend = FakeEnvironment::default();
    backend.bind(record.binding.scope.clone()).unwrap();
    backend.bind(record.binding.scope.clone()).unwrap();
    let mut other = record.binding.scope.clone();
    other.environment_instance_id = id("vm-other");
    code(backend.bind(other), ErrorCode::EnvironmentBusy);
    let mut other = record.binding.scope.clone();
    other.execution_epoch = Counter(2);
    other.volume_id = id("volume-other");
    code(backend.bind(other), ErrorCode::EnvironmentBusy);
}

#[tokio::test]
async fn new_stage_identity_cannot_hide_unresolved_prior_prepare() {
    let store = store();
    let record = accepted(&store);
    let backend = FakeEnvironment::default();
    backend.bind(record.binding.scope.clone()).unwrap();
    let original = operation(
        &record.binding.scope,
        "original",
        EnvironmentOperationKind::Prepare,
    );
    backend
        .inject_fault(original.operation_id.clone(), FakeFault::UnknownBeforeApply)
        .unwrap();
    code(backend.execute(original).await, ErrorCode::OutcomeUnknown);
    let replacement = operation(
        &record.binding.scope,
        "replacement",
        EnvironmentOperationKind::Prepare,
    );
    code(
        backend.execute(replacement.clone()).await,
        ErrorCode::OutcomeUnknown,
    );
    assert_eq!(backend.effect_count(&replacement.operation_id).unwrap(), 0);
}

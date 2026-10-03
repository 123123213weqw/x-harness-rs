#![allow(dead_code)]
use xharness_cloud::*;

pub fn id(value: &str) -> Id {
    Id::new(value).unwrap()
}
pub fn reference(value: &str) -> VersionedRef {
    VersionedRef {
        id: id(value),
        version: id("v1"),
    }
}
pub fn envelope() -> CommandEnvelope {
    CommandEnvelope::decode(
        include_bytes!("../fixtures/submit-v1.json"),
        &AdmissionLimits::default(),
    )
    .unwrap()
}
pub fn spec() -> CloudTaskSpec {
    match envelope().command {
        Command::Submit(request) => request.spec,
        _ => unreachable!(),
    }
}
pub fn environment(owner: &str) -> RegisteredEnvironment {
    let spec = spec();
    let capabilities = EnvironmentCapabilities(
        [
            Capability::DedicatedLinux,
            Capability::PersistentVolume,
            Capability::SingleWriter,
            Capability::FullAccess,
            Capability::ManagedCleanup,
            Capability::Deployment,
            Capability::ModelReachable,
            Capability::MaterialReachable,
            Capability::Retention,
            Capability::Sudo,
            Capability::ExternalStop,
        ]
        .into_iter()
        .map(|c| {
            (
                c,
                CapabilityObservation {
                    support: Support::Supported,
                    observed_at_ms: Counter(100),
                    constraints: vec![],
                },
            )
        })
        .collect(),
    );
    RegisteredEnvironment {
        owner_id: id(owner),
        environment_ref: spec.environment_ref,
        instance_id: id("vm-instance-1"),
        volume_id: id("volume-1"),
        host_build_ref: reference("host-build"),
        execution_epoch: Counter(1),
        capabilities,
        resource_policy_ref: spec.resource_policy_ref,
        stop_policy_ref: spec.stop_policy_ref,
        retention_policy_ref: spec.retention_policy_ref,
        required_resource_capabilities: vec![],
        external_stop_authorized: true,
    }
}
pub fn store() -> MemoryCloudTaskStore {
    let store = MemoryCloudTaskStore::default();
    store.register_environment(environment("owner1")).unwrap();
    store
}
pub fn accepted(store: &MemoryCloudTaskStore) -> TaskRecord {
    let receipt = store
        .admit(&id("owner1"), &envelope(), Counter(100))
        .unwrap();
    store.get(&id("owner1"), &receipt.task_id).unwrap()
}
pub fn fact(store: &MemoryCloudTaskStore, record: &TaskRecord, fact: TaskFact) -> TaskRecord {
    store
        .apply_fact(
            &record.owner_id,
            &record.task_id,
            record.revision,
            &record.binding.scope,
            &fact,
            Counter(200),
        )
        .unwrap()
}
pub fn attached(store: &MemoryCloudTaskStore) -> TaskRecord {
    let record = accepted(store);
    let record = fact(
        store,
        &record,
        TaskFact::PrepareAdmitted {
            operation_id: record.prepare_operation_id.clone(),
        },
    );
    fact(
        store,
        &record,
        TaskFact::Prepared {
            operation_id: record.prepare_operation_id.clone(),
            ready: true,
            bootstrap_prepared: true,
            grant_committed: true,
        },
    )
}
pub fn active(store: &MemoryCloudTaskStore) -> TaskRecord {
    let record = attached(store);
    fact(
        store,
        &record,
        TaskFact::Activated {
            operation_id: record.activate_operation_id.clone(),
        },
    )
}
pub fn completion() -> CompletionEvidence {
    CompletionEvidence {
        goal_receipt_id: id("goal-verified"),
        session_revision: Counter(99),
        goal_accepted: true,
        admission_sealed: true,
        admitted_work_remaining: false,
    }
}
pub fn retention() -> VersionedRetentionReceipt {
    VersionedRetentionReceipt {
        receipt_id: id("retention-verified"),
        retained_manifest_sha256: Sha256Digest::new("0".repeat(64)).unwrap(),
    }
}
pub fn cancel(record: &TaskRecord, request_id: &str) -> CommandEnvelope {
    CommandEnvelope::new(
        id(request_id),
        Command::Cancel(CancelTask {
            task_id: record.task_id.clone(),
            expected_revision: record.revision,
        }),
    )
}
pub fn stop_and_commit(
    store: &MemoryCloudTaskStore,
    record: &TaskRecord,
    proof: StopProof,
) -> TaskRecord {
    let operation_id = record.settlement.as_ref().unwrap().operation_id.clone();
    let record = fact(
        store,
        record,
        TaskFact::Sealed {
            operation_id: operation_id.clone(),
        },
    );
    let record = fact(
        store,
        &record,
        TaskFact::StopVerified {
            operation_id: operation_id.clone(),
            proof,
        },
    );
    let record = fact(
        store,
        &record,
        TaskFact::RetentionVerified {
            operation_id,
            receipt: retention(),
        },
    );
    fact(store, &record, TaskFact::CommitTerminal)
}
pub fn graceful() -> StopProof {
    StopProof::Graceful {
        native_shutdown_verified: true,
        execution_scope_quiet: true,
        cleanup_errors: 0,
    }
}
pub fn code<T: std::fmt::Debug>(result: CloudResult<T>, expected: ErrorCode) {
    assert_eq!(result.unwrap_err().code, expected);
}

mod common;
use common::*;
use std::sync::{Arc, Barrier};
use xharness_cloud::*;

#[test]
fn duplicate_submit_returns_receipt_and_one_atomic_prepare_intent() {
    let store = store();
    let first = store
        .admit(&id("owner1"), &envelope(), Counter(100))
        .unwrap();
    let replay = store
        .admit(&id("owner1"), &envelope(), Counter(999))
        .unwrap();
    assert_eq!(first, replay);
    let record = store.get(&id("owner1"), &first.task_id).unwrap();
    assert_eq!(record.phase, TaskPhase::Accepted);
    assert_eq!(record.revision, Counter(1));
    let intents = store
        .pending_intents(&id("owner1"), &first.task_id)
        .unwrap();
    assert_eq!(intents.len(), 1);
    assert_eq!(intents[0].operation_id, record.prepare_operation_id);
}
#[test]
fn concurrent_duplicate_submissions_admit_once() {
    let store = Arc::new(store());
    let barrier = Arc::new(Barrier::new(16));
    let threads: Vec<_> = (0..16)
        .map(|_| {
            let store = store.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store
                    .admit(&id("owner1"), &envelope(), Counter(100))
                    .unwrap()
            })
        })
        .collect();
    let receipts: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert!(receipts.iter().all(|r| r == &receipts[0]));
    assert_eq!(
        store
            .pending_intents(&id("owner1"), &receipts[0].task_id)
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn same_id_conflicts_across_content_and_methods() {
    let store = store();
    let record = accepted(&store);
    let mut changed = envelope();
    if let Command::Submit(ref mut request) = changed.command {
        request.spec.objective.push_str("新增要求");
    }
    code(
        store.admit(&id("owner1"), &changed, Counter(101)),
        ErrorCode::IdempotencyConflict,
    );
    code(
        store.admit(
            &id("owner1"),
            &cancel(&record, envelope().request_id.as_str()),
            Counter(101),
        ),
        ErrorCode::IdempotencyConflict,
    );
    assert_eq!(store.get(&id("owner1"), &record.task_id).unwrap(), record);
}
#[test]
fn distinct_owners_have_independent_ids_and_no_object_existence_leak() {
    let store = store();
    let record = accepted(&store);
    code(
        store.get(&id("owner2"), &record.task_id),
        ErrorCode::NotFound,
    );
    code(
        store.admit(
            &id("owner2"),
            &cancel(&record, "cancel-other"),
            Counter(101),
        ),
        ErrorCode::NotFound,
    );
    code(
        store.admit(&id("owner2"), &envelope(), Counter(101)),
        ErrorCode::NotFound,
    );
    assert!(store
        .receipt(&id("owner2"), &envelope().request_id)
        .unwrap()
        .is_none());
    let mut env = environment("owner2");
    env.environment_ref = reference("vm-other");
    env.instance_id = id("vm-instance-2");
    env.volume_id = id("volume-2");
    store.register_environment(env.clone()).unwrap();
    let mut command = envelope();
    if let Command::Submit(ref mut request) = command.command {
        request.spec.environment_ref = env.environment_ref;
    }
    let other = store.admit(&id("owner2"), &command, Counter(102)).unwrap();
    assert_ne!(other.task_id, record.task_id);
}
#[test]
fn cancel_receipt_replay_precedes_stale_cas() {
    let store = store();
    let record = active(&store);
    let command = cancel(&record, "cancel1");
    let receipt = store.admit(&id("owner1"), &command, Counter(101)).unwrap();
    let next = store.get(&id("owner1"), &record.task_id).unwrap();
    assert!(next.revision > record.revision);
    assert_eq!(
        store.admit(&id("owner1"), &command, Counter(102)).unwrap(),
        receipt
    );
    let intents = store
        .pending_intents(&id("owner1"), &record.task_id)
        .unwrap();
    assert_eq!(intents.len(), 1);
    assert_eq!(intents[0].kind, IntentKind::Settle);
}
#[test]
fn competing_cancel_commands_only_one_cas_wins_and_loser_leaves_no_receipt() {
    let store = Arc::new(store());
    let record = active(&store);
    let barrier = Arc::new(Barrier::new(2));
    let threads: Vec<_> = ["cancel-a", "cancel-b"]
        .into_iter()
        .map(|request_id| {
            let store = store.clone();
            let barrier = barrier.clone();
            let command = cancel(&record, request_id);
            std::thread::spawn(move || {
                barrier.wait();
                (
                    command.request_id.clone(),
                    store.admit(&id("owner1"), &command, Counter(300)),
                )
            })
        })
        .collect();
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|(_, r)| r.is_ok()).count(), 1);
    let (loser, error) = results.into_iter().find(|(_, r)| r.is_err()).unwrap();
    code(error, ErrorCode::RevisionConflict);
    assert!(store.receipt(&id("owner1"), &loser).unwrap().is_none());
    assert_eq!(
        store
            .pending_intents(&id("owner1"), &record.task_id)
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn reservation_covers_vm_and_volume_across_config_aliases() {
    let store = store();
    accepted(&store);
    let mut second = envelope();
    second.request_id = id("second-task");
    code(
        store.admit(&id("owner1"), &second, Counter(200)),
        ErrorCode::EnvironmentBusy,
    );
    assert!(store
        .receipt(&id("owner1"), &second.request_id)
        .unwrap()
        .is_none());
    for shared_volume in [true, false] {
        let mut env = environment("owner1");
        env.environment_ref = reference("alias");
        if shared_volume {
            env.instance_id = id("different-vm");
        } else {
            env.volume_id = id("different-volume");
        }
        code(store.register_environment(env), ErrorCode::EnvironmentBusy);
    }
}
#[test]
fn unknown_unsupported_and_hard_resource_capabilities_deny_before_effects() {
    for support in [Support::Unknown, Support::Unsupported] {
        let store = MemoryCloudTaskStore::default();
        let mut env = environment("owner1");
        env.capabilities
            .0
            .get_mut(&Capability::ManagedCleanup)
            .unwrap()
            .support = support;
        store.register_environment(env).unwrap();
        code(
            store.admit(&id("owner1"), &envelope(), Counter(1)),
            ErrorCode::CapabilityUnavailable,
        );
        assert!(store
            .receipt(&id("owner1"), &envelope().request_id)
            .unwrap()
            .is_none());
    }
    let store = MemoryCloudTaskStore::default();
    let mut env = environment("owner1");
    env.required_resource_capabilities = vec![Capability::MemoryHardLimit];
    store.register_environment(env).unwrap();
    code(
        store.admit(&id("owner1"), &envelope(), Counter(1)),
        ErrorCode::CapabilityUnavailable,
    );
}
#[test]
fn sudo_requires_separate_external_stop_capability_and_authorization() {
    for authorized in [true, false] {
        let store = MemoryCloudTaskStore::default();
        let mut env = environment("owner1");
        env.external_stop_authorized = authorized;
        if authorized {
            env.capabilities.0.remove(&Capability::ExternalStop);
        }
        store.register_environment(env).unwrap();
        let mut command = envelope();
        if let Command::Submit(ref mut request) = command.command {
            request.spec.system_privilege = SystemPrivilege::Sudo;
        }
        code(
            store.admit(&id("owner1"), &command, Counter(1)),
            if authorized {
                ErrorCode::CapabilityUnavailable
            } else {
                ErrorCode::Forbidden
            },
        );
    }
}
#[test]
fn registered_versions_and_bound_initial_spec_cannot_drift() {
    let store = store();
    let mut env = environment("owner1");
    env.host_build_ref.version = id("v2");
    code(
        store.register_environment(env),
        ErrorCode::IdempotencyConflict,
    );
    let record = accepted(&store);
    assert_eq!(
        store.get(&record.owner_id, &record.task_id).unwrap().spec,
        spec()
    );
    // Reopening the controller re-registers the identical version; no mutation.
    store.register_environment(environment("owner1")).unwrap();
    let mut different_version = environment("owner1");
    different_version.environment_ref.version = id("v2");
    code(
        store.register_environment(different_version),
        ErrorCode::EnvironmentBusy,
    );
    let mut command = envelope();
    if let Command::Submit(ref mut request) = command.command {
        request.spec.environment_ref.version = id("latest");
    }
    code(
        store.admit(&id("owner1"), &command, Counter(1)),
        ErrorCode::NotFound,
    );
}
#[test]
fn attached_is_not_applied_until_activation_receipt() {
    let store = store();
    let record = attached(&store);
    assert!(!record.activated);
    assert_eq!(
        store
            .receipt(&id("owner1"), &envelope().request_id)
            .unwrap()
            .unwrap()
            .status,
        ReceiptStatus::Running
    );
    let intents = store
        .pending_intents(&record.owner_id, &record.task_id)
        .unwrap();
    assert_eq!(intents.len(), 1);
    assert_eq!(intents[0].kind, IntentKind::Activate);
    let next = fact(
        &store,
        &record,
        TaskFact::Activated {
            operation_id: record.activate_operation_id.clone(),
        },
    );
    assert!(next.activated);
    assert_eq!(
        store
            .receipt(&id("owner1"), &envelope().request_id)
            .unwrap()
            .unwrap()
            .status,
        ReceiptStatus::Applied
    );
}

#[test]
fn uncertain_dispatch_preserves_identity_and_cannot_reset_to_pending() {
    let store = store();
    let record = accepted(&store);
    let op = &record.prepare_operation_id;
    store
        .record_dispatch(
            &record.owner_id,
            &record.task_id,
            op,
            IntentStatus::Running,
            Counter(200),
        )
        .unwrap();
    store
        .record_dispatch(
            &record.owner_id,
            &record.task_id,
            op,
            IntentStatus::NeedsReconcile,
            Counter(300),
        )
        .unwrap();
    let intent = store
        .pending_intents(&record.owner_id, &record.task_id)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(intent.status, IntentStatus::NeedsReconcile);
    assert_eq!(&intent.operation_id, op);
    code(
        store.record_dispatch(
            &record.owner_id,
            &record.task_id,
            op,
            IntentStatus::Running,
            Counter(400),
        ),
        ErrorCode::InvalidRequest,
    );
    let receipt = store
        .receipt(&record.owner_id, &envelope().request_id)
        .unwrap()
        .unwrap();
    assert_eq!(receipt.status, ReceiptStatus::NeedsReconcile);
    assert_eq!(
        store
            .admit(&record.owner_id, &envelope(), Counter(999))
            .unwrap(),
        receipt
    );
}
#[test]
fn cancellation_suppresses_prepare_or_activate_but_retains_uncertain_identities() {
    for is_attached in [false, true] {
        let store = store();
        let record = if is_attached {
            attached(&store)
        } else {
            accepted(&store)
        };
        let stage = if is_attached {
            record.activate_operation_id.clone()
        } else {
            record.prepare_operation_id.clone()
        };
        store
            .record_dispatch(
                &record.owner_id,
                &record.task_id,
                &stage,
                IntentStatus::Running,
                Counter(200),
            )
            .unwrap();
        store
            .record_dispatch(
                &record.owner_id,
                &record.task_id,
                &stage,
                IntentStatus::NeedsReconcile,
                Counter(300),
            )
            .unwrap();
        store
            .admit(&record.owner_id, &cancel(&record, "cancel"), Counter(400))
            .unwrap();
        let pending = store
            .pending_intents(&record.owner_id, &record.task_id)
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].kind, IntentKind::Settle);
        let retained = store
            .stage_intents(&record.owner_id, &record.task_id)
            .unwrap();
        assert!(retained
            .iter()
            .any(|i| i.operation_id == stage && i.status == IntentStatus::NeedsReconcile));
        code(
            store.record_dispatch(
                &record.owner_id,
                &record.task_id,
                &stage,
                IntentStatus::Running,
                Counter(500),
            ),
            ErrorCode::InvalidRequest,
        );
    }
}

#[test]
fn a_second_cancel_request_reuses_existing_settlement_instead_of_a_second_stop() {
    let store = store();
    let record = active(&store);
    let first = store
        .admit(&record.owner_id, &cancel(&record, "cancel-a"), Counter(300))
        .unwrap();
    let record = store.get(&record.owner_id, &record.task_id).unwrap();
    let second = store
        .admit(&record.owner_id, &cancel(&record, "cancel-b"), Counter(400))
        .unwrap();
    assert_ne!(first.operation_id, second.operation_id);
    assert_eq!(second.accepted_revision, record.revision);
    let stages = store
        .pending_intents(&record.owner_id, &record.task_id)
        .unwrap();
    assert_eq!(stages.len(), 1);
    assert_eq!(stages[0].operation_id, first.operation_id);
    let record = fact(
        &store,
        &record,
        TaskFact::Sealed {
            operation_id: first.operation_id,
        },
    );
    for request_id in ["cancel-a", "cancel-b"] {
        assert_eq!(
            store
                .receipt(&record.owner_id, &id(request_id))
                .unwrap()
                .unwrap()
                .status,
            ReceiptStatus::Applied
        );
    }
}

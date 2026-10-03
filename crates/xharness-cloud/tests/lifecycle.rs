mod common;
use common::*;
use std::sync::{Arc, Barrier};
use xharness_cloud::*;

#[test]
fn live_port_is_not_ready_and_grant_must_be_committed() {
    for (ready, bootstrap_prepared, grant_committed) in [
        (false, true, true),
        (true, false, true),
        (true, true, false),
    ] {
        let store = store();
        let record = accepted(&store);
        let record = fact(
            &store,
            &record,
            TaskFact::PrepareAdmitted {
                operation_id: record.prepare_operation_id.clone(),
            },
        );
        code(
            store.apply_fact(
                &record.owner_id,
                &record.task_id,
                record.revision,
                &record.binding.scope,
                &TaskFact::Prepared {
                    operation_id: record.prepare_operation_id.clone(),
                    ready,
                    bootstrap_prepared,
                    grant_committed,
                },
                Counter(1),
            ),
            ErrorCode::InvalidRequest,
        );
        assert_eq!(
            store.get(&record.owner_id, &record.task_id).unwrap(),
            record
        );
    }
}
#[test]
fn old_epoch_binding_volume_or_environment_facts_do_not_change_state() {
    let store = store();
    let record = active(&store);
    for field in ["epoch", "binding", "volume", "environment", "task"] {
        let mut scope = record.binding.scope.clone();
        match field {
            "epoch" => scope.execution_epoch = Counter(2),
            "binding" => scope.binding_id = id("old-binding"),
            "volume" => scope.volume_id = id("old-volume"),
            "environment" => scope.environment_instance_id = id("old-instance"),
            _ => scope.task_id = id("old-task"),
        }
        code(
            store.apply_fact(
                &record.owner_id,
                &record.task_id,
                record.revision,
                &scope,
                &TaskFact::CancelRequested {
                    operation_id: id("stop"),
                },
                Counter(1),
            ),
            ErrorCode::OwnershipUnverified,
        );
        assert_eq!(
            store.get(&record.owner_id, &record.task_id).unwrap(),
            record
        );
    }
}
#[test]
fn activation_requires_expected_phase_and_stable_stage_identity() {
    let store = store();
    let record = accepted(&store);
    code(
        reduce_task(
            &record,
            &record.binding.scope,
            &TaskFact::Activated {
                operation_id: record.activate_operation_id.clone(),
            },
        ),
        ErrorCode::InvalidRequest,
    );
    let store = common::store();
    let record = attached(&store);
    code(
        reduce_task(
            &record,
            &record.binding.scope,
            &TaskFact::Activated {
                operation_id: id("wrong-op"),
            },
        ),
        ErrorCode::InvalidRequest,
    );
}
#[test]
fn authoritative_goal_and_native_admission_are_both_required() {
    let store = store();
    let record = active(&store);
    for field in ["goal", "seal", "remaining"] {
        let mut evidence = completion();
        match field {
            "goal" => evidence.goal_accepted = false,
            "seal" => evidence.admission_sealed = false,
            _ => evidence.admitted_work_remaining = true,
        }
        code(
            reduce_task(
                &record,
                &record.binding.scope,
                &TaskFact::FinishRequested {
                    operation_id: id("settle"),
                    evidence,
                },
            ),
            ErrorCode::InvalidRequest,
        );
    }
}
#[test]
fn cancellation_during_completion_keeps_evidence_and_original_stop_identity() {
    let store = store();
    let record = active(&store);
    let record = fact(
        &store,
        &record,
        TaskFact::FinishRequested {
            operation_id: id("settle-finish"),
            evidence: completion(),
        },
    );
    store
        .admit(
            &record.owner_id,
            &cancel(&record, "cancel-during-finish"),
            Counter(300),
        )
        .unwrap();
    let record = store.get(&record.owner_id, &record.task_id).unwrap();
    let settlement = record.settlement.as_ref().unwrap();
    assert_eq!(settlement.operation_id, id("settle-finish"));
    assert_eq!(settlement.requested_outcome, RequestedOutcome::Cancelled);
    assert_eq!(record.completion_evidence, Some(completion()));
    let record = stop_and_commit(&store, &record, graceful());
    assert_eq!(record.phase, TaskPhase::Cancelled);
    assert_eq!(record.completion_evidence, Some(completion()));
}
#[test]
fn cancel_and_terminal_cas_race_has_exactly_one_winner() {
    let store = Arc::new(store());
    let record = active(&store);
    let record = fact(
        &store,
        &record,
        TaskFact::FinishRequested {
            operation_id: id("settle"),
            evidence: completion(),
        },
    );
    let record = fact(
        &store,
        &record,
        TaskFact::StopVerified {
            operation_id: id("settle"),
            proof: graceful(),
        },
    );
    let record = fact(
        &store,
        &record,
        TaskFact::RetentionVerified {
            operation_id: id("settle"),
            receipt: retention(),
        },
    );
    let barrier = Arc::new(Barrier::new(2));
    let cancel_thread = {
        let store = store.clone();
        let barrier = barrier.clone();
        let record = record.clone();
        std::thread::spawn(move || {
            barrier.wait();
            store
                .admit(
                    &record.owner_id,
                    &cancel(&record, "racing-cancel"),
                    Counter(300),
                )
                .map(|_| ())
        })
    };
    let finish_thread = {
        let store = store.clone();
        let barrier = barrier.clone();
        let record = record.clone();
        std::thread::spawn(move || {
            barrier.wait();
            store
                .apply_fact(
                    &record.owner_id,
                    &record.task_id,
                    record.revision,
                    &record.binding.scope,
                    &TaskFact::CommitTerminal,
                    Counter(300),
                )
                .map(|_| ())
        })
    };
    let cancel_result = cancel_thread.join().unwrap();
    let finish_result = finish_thread.join().unwrap();
    assert!(cancel_result.is_ok());
    let latest = store.get(&record.owner_id, &record.task_id).unwrap();
    if finish_result.is_err() {
        code(finish_result, ErrorCode::RevisionConflict);
        let terminal = fact(&store, &latest, TaskFact::CommitTerminal);
        assert_eq!(terminal.phase, TaskPhase::Cancelled);
    } else {
        assert_eq!(latest.phase, TaskPhase::Finished);
        assert_eq!(
            store
                .receipt(&record.owner_id, &id("racing-cancel"))
                .unwrap()
                .unwrap()
                .status,
            ReceiptStatus::Applied
        );
    }
}
#[test]
fn terminal_first_makes_later_cancel_a_noop_and_does_not_reuse_vm() {
    let store = store();
    let record = active(&store);
    let record = fact(
        &store,
        &record,
        TaskFact::FinishRequested {
            operation_id: id("settle"),
            evidence: completion(),
        },
    );
    let terminal = stop_and_commit(&store, &record, graceful());
    // A client may have observed an older active revision before terminal CAS.
    let command = cancel(&record, "cancel-after-terminal");
    let receipt = store
        .admit(&terminal.owner_id, &command, Counter(300))
        .unwrap();
    assert_eq!(receipt.status, ReceiptStatus::Applied);
    assert_eq!(
        store.get(&terminal.owner_id, &terminal.task_id).unwrap(),
        terminal
    );
    assert!(store
        .pending_intents(&terminal.owner_id, &terminal.task_id)
        .unwrap()
        .is_empty());
    let mut second = envelope();
    second.request_id = id("new-task");
    code(
        store.admit(&terminal.owner_id, &second, Counter(400)),
        ErrorCode::EnvironmentBusy,
    );
    for fact in [
        TaskFact::Activated {
            operation_id: terminal.activate_operation_id.clone(),
        },
        TaskFact::PrepareAdmitted {
            operation_id: terminal.prepare_operation_id.clone(),
        },
    ] {
        code(
            reduce_task(&terminal, &terminal.binding.scope, &fact),
            ErrorCode::InvalidRequest,
        );
    }
}
#[test]
fn cancellation_does_not_mean_execution_has_stopped() {
    let store = store();
    let record = active(&store);
    let receipt = store
        .admit(&record.owner_id, &cancel(&record, "cancel"), Counter(1))
        .unwrap();
    assert_eq!(receipt.status, ReceiptStatus::Accepted);
    let record = store.get(&record.owner_id, &record.task_id).unwrap();
    assert_eq!(record.phase, TaskPhase::Settling);
    assert!(!record.settlement.as_ref().unwrap().sealed);
    code(
        reduce_task(&record, &record.binding.scope, &TaskFact::CommitTerminal),
        ErrorCode::CleanupIncomplete,
    );
    code(
        reduce_task(
            &record,
            &record.binding.scope,
            &TaskFact::StopVerified {
                operation_id: receipt.operation_id.clone(),
                proof: graceful(),
            },
        ),
        ErrorCode::CleanupIncomplete,
    );
}
#[test]
fn stop_timeout_stays_settling_and_a_verified_retry_clears_blocker() {
    let store = store();
    let record = active(&store);
    store
        .admit(&record.owner_id, &cancel(&record, "cancel"), Counter(1))
        .unwrap();
    let record = store.get(&record.owner_id, &record.task_id).unwrap();
    let op = record.settlement.as_ref().unwrap().operation_id.clone();
    let record = fact(
        &store,
        &record,
        TaskFact::CleanupBlocked {
            operation_id: op,
            reason: "stop outcome unknown".into(),
        },
    );
    code(
        reduce_task(&record, &record.binding.scope, &TaskFact::CommitTerminal),
        ErrorCode::CleanupIncomplete,
    );
    assert_eq!(record.phase, TaskPhase::Settling);
    assert_eq!(
        stop_and_commit(&store, &record, graceful()).phase,
        TaskPhase::Cancelled
    );
}
#[test]
fn incomplete_stop_or_missing_retention_cannot_be_terminal() {
    let store = store();
    let record = active(&store);
    store
        .admit(&record.owner_id, &cancel(&record, "cancel"), Counter(1))
        .unwrap();
    let record = store.get(&record.owner_id, &record.task_id).unwrap();
    let op = record.settlement.as_ref().unwrap().operation_id.clone();
    let record = fact(
        &store,
        &record,
        TaskFact::Sealed {
            operation_id: op.clone(),
        },
    );
    for proof in [
        StopProof::Graceful {
            native_shutdown_verified: false,
            execution_scope_quiet: true,
            cleanup_errors: 0,
        },
        StopProof::Graceful {
            native_shutdown_verified: true,
            execution_scope_quiet: false,
            cleanup_errors: 0,
        },
        StopProof::Graceful {
            native_shutdown_verified: true,
            execution_scope_quiet: true,
            cleanup_errors: 1,
        },
        StopProof::NotStarted {
            prepare_quiesced: true,
            no_executor_verified: true,
        },
    ] {
        code(
            reduce_task(
                &record,
                &record.binding.scope,
                &TaskFact::StopVerified {
                    operation_id: op.clone(),
                    proof,
                },
            ),
            ErrorCode::CleanupIncomplete,
        );
    }
    let record = fact(
        &store,
        &record,
        TaskFact::StopVerified {
            operation_id: op,
            proof: graceful(),
        },
    );
    code(
        reduce_task(&record, &record.binding.scope, &TaskFact::CommitTerminal),
        ErrorCode::CleanupIncomplete,
    );
}
#[test]
fn verified_not_started_can_settle_early_cancellation() {
    let store = store();
    let record = accepted(&store);
    store
        .admit(&record.owner_id, &cancel(&record, "cancel"), Counter(1))
        .unwrap();
    let record = store.get(&record.owner_id, &record.task_id).unwrap();
    let op = record.settlement.as_ref().unwrap().operation_id.clone();
    for proof in [
        StopProof::NotStarted {
            prepare_quiesced: false,
            no_executor_verified: true,
        },
        StopProof::NotStarted {
            prepare_quiesced: true,
            no_executor_verified: false,
        },
    ] {
        code(
            reduce_task(
                &record,
                &record.binding.scope,
                &TaskFact::StopVerified {
                    operation_id: op.clone(),
                    proof,
                },
            ),
            ErrorCode::CleanupIncomplete,
        );
    }
    let record = fact(
        &store,
        &record,
        TaskFact::StopVerified {
            operation_id: op.clone(),
            proof: StopProof::NotStarted {
                prepare_quiesced: true,
                no_executor_verified: true,
            },
        },
    );
    let record = fact(
        &store,
        &record,
        TaskFact::RetentionVerified {
            operation_id: op,
            receipt: retention(),
        },
    );
    let record = fact(&store, &record, TaskFact::CommitTerminal);
    assert_eq!(record.phase, TaskPhase::Cancelled);
    assert_eq!(
        store
            .receipt(&record.owner_id, &envelope().request_id)
            .unwrap()
            .unwrap()
            .status,
        ReceiptStatus::Failed
    );
}
#[test]
fn forced_stop_requires_authorization_supported_probe_and_recorded_unknown_effects() {
    let store = store();
    let record = active(&store);
    store
        .admit(&record.owner_id, &cancel(&record, "cancel"), Counter(1))
        .unwrap();
    let record = store.get(&record.owner_id, &record.task_id).unwrap();
    let op = record.settlement.as_ref().unwrap().operation_id.clone();
    let sealed = fact(
        &store,
        &record,
        TaskFact::Sealed {
            operation_id: op.clone(),
        },
    );
    for field in ["authorization", "support", "verified", "unknown"] {
        let mut record = sealed.clone();
        let mut proof = StopProof::Forced {
            outside_vm_stop_verified: true,
            unknown_effects_recorded: true,
        };
        match field {
            "authorization" => record.binding.external_stop_authorized = false,
            "support" => record.binding.external_stop_support = Support::Unknown,
            "verified" => {
                proof = StopProof::Forced {
                    outside_vm_stop_verified: false,
                    unknown_effects_recorded: true,
                }
            }
            _ => {
                proof = StopProof::Forced {
                    outside_vm_stop_verified: true,
                    unknown_effects_recorded: true,
                }
            }
        }
        if field == "unknown" {
            proof = StopProof::Forced {
                outside_vm_stop_verified: true,
                unknown_effects_recorded: false,
            };
        }
        code(
            reduce_task(
                &record,
                &record.binding.scope,
                &TaskFact::StopVerified {
                    operation_id: op.clone(),
                    proof,
                },
            ),
            ErrorCode::CleanupIncomplete,
        );
    }
    let record = stop_and_commit(
        &store,
        &sealed,
        StopProof::Forced {
            outside_vm_stop_verified: true,
            unknown_effects_recorded: true,
        },
    );
    assert_eq!(record.phase, TaskPhase::Cancelled);
}
#[test]
fn settlement_proofs_have_stable_identity_and_immutable_cut() {
    let store = store();
    let record = active(&store);
    store
        .admit(&record.owner_id, &cancel(&record, "cancel"), Counter(1))
        .unwrap();
    let record = store.get(&record.owner_id, &record.task_id).unwrap();
    let op = record.settlement.as_ref().unwrap().operation_id.clone();
    code(
        reduce_task(
            &record,
            &record.binding.scope,
            &TaskFact::Sealed {
                operation_id: id("other-op"),
            },
        ),
        ErrorCode::InvalidRequest,
    );
    code(
        reduce_task(
            &record,
            &record.binding.scope,
            &TaskFact::RetentionVerified {
                operation_id: op.clone(),
                receipt: retention(),
            },
        ),
        ErrorCode::InvalidRequest,
    );
    let record = fact(
        &store,
        &record,
        TaskFact::Sealed {
            operation_id: op.clone(),
        },
    );
    let record = fact(
        &store,
        &record,
        TaskFact::StopVerified {
            operation_id: op.clone(),
            proof: graceful(),
        },
    );
    assert_eq!(
        reduce_task(
            &record,
            &record.binding.scope,
            &TaskFact::StopVerified {
                operation_id: op.clone(),
                proof: graceful()
            }
        )
        .unwrap(),
        record
    );
    code(
        reduce_task(
            &record,
            &record.binding.scope,
            &TaskFact::StopVerified {
                operation_id: op.clone(),
                proof: StopProof::Forced {
                    outside_vm_stop_verified: true,
                    unknown_effects_recorded: true,
                },
            },
        ),
        ErrorCode::InvalidRequest,
    );
    let record = fact(
        &store,
        &record,
        TaskFact::RetentionVerified {
            operation_id: op.clone(),
            receipt: retention(),
        },
    );
    let mut changed = retention();
    changed.receipt_id = id("changed-cut");
    code(
        reduce_task(
            &record,
            &record.binding.scope,
            &TaskFact::RetentionVerified {
                operation_id: op,
                receipt: changed,
            },
        ),
        ErrorCode::InvalidRequest,
    );
}
#[test]
fn failure_does_not_override_cancellation_and_preserves_failure_facts() {
    let store = store();
    let record = active(&store);
    store
        .admit(&record.owner_id, &cancel(&record, "cancel"), Counter(1))
        .unwrap();
    let record = store.get(&record.owner_id, &record.task_id).unwrap();
    let record = fact(
        &store,
        &record,
        TaskFact::FailureRequested {
            operation_id: id("failure"),
            reason: "permanent failure".into(),
        },
    );
    assert_eq!(
        record.settlement.as_ref().unwrap().requested_outcome,
        RequestedOutcome::Cancelled
    );
    assert_eq!(record.failure_reasons, vec!["permanent failure"]);
    assert_eq!(
        stop_and_commit(&store, &record, graceful()).phase,
        TaskPhase::Cancelled
    );
}
#[test]
fn all_permit_transitions_are_monotonic_and_sealed_never_reactivates() {
    let store = store();
    let record = accepted(&store);
    let scope = record.binding.scope;
    let permits = [
        ExecutionPermit::Prepared,
        ExecutionPermit::Active,
        ExecutionPermit::Sealed,
    ];
    for from in permits {
        for to in permits {
            let current = PermitRecord {
                scope: scope.clone(),
                revision: Counter(1),
                permit: from,
            };
            let result = current.transition(&scope, Counter(1), to);
            let allowed = from == to
                || matches!(
                    (from, to),
                    (
                        ExecutionPermit::Prepared,
                        ExecutionPermit::Active | ExecutionPermit::Sealed
                    ) | (ExecutionPermit::Active, ExecutionPermit::Sealed)
                );
            assert_eq!(result.is_ok(), allowed, "{from:?} -> {to:?}");
            if let Ok(next) = result {
                assert_eq!(next.revision, Counter(if from == to { 1 } else { 2 }));
            }
        }
    }
}
#[test]
fn permit_cas_epoch_and_corrupt_journal_fail_closed() {
    let store = store();
    let record = accepted(&store);
    let scope = record.binding.scope;
    let current = PermitRecord {
        scope: scope.clone(),
        revision: Counter(1),
        permit: ExecutionPermit::Prepared,
    };
    let sealed = current
        .transition(&scope, Counter(1), ExecutionPermit::Sealed)
        .unwrap();
    code(
        sealed.transition(&scope, Counter(1), ExecutionPermit::Active),
        ErrorCode::RevisionConflict,
    );
    code(
        sealed.transition(&scope, Counter(2), ExecutionPermit::Active),
        ErrorCode::InvalidRequest,
    );
    let mut old = scope.clone();
    old.execution_epoch = Counter(99);
    code(
        sealed.transition(&old, Counter(2), ExecutionPermit::Active),
        ErrorCode::OwnershipUnverified,
    );
    for json in ["{}", "null", "{", "{\"permit\":\"active\"}"] {
        assert!(serde_json::from_str::<PermitRecord>(json).is_err());
    }
}
#[test]
fn revision_overflow_rejects_transition_without_mutation() {
    let store = store();
    let mut record = accepted(&store);
    record.revision = Counter(u64::MAX);
    code(
        reduce_task(
            &record,
            &record.binding.scope,
            &TaskFact::CancelRequested {
                operation_id: id("cancel"),
            },
        ),
        ErrorCode::InvalidRequest,
    );
    assert_eq!(record.phase, TaskPhase::Accepted);
}

#[test]
fn inconsistent_records_and_unestablished_epochs_cannot_advance() {
    let store = store();
    let record = accepted(&store);
    for field in ["revision", "epoch", "task", "settlement"] {
        let mut current = record.clone();
        match field {
            "revision" => current.revision = Counter(0),
            "epoch" => current.binding.scope.execution_epoch = Counter(0),
            "task" => current.binding.scope.task_id = id("wrong-task"),
            _ => current.phase = TaskPhase::Settling,
        }
        code(
            reduce_task(
                &current,
                &current.binding.scope,
                &TaskFact::CancelRequested {
                    operation_id: id("cancel"),
                },
            ),
            ErrorCode::InvalidRequest,
        );
    }
    let mut permit = PermitRecord {
        scope: record.binding.scope,
        revision: Counter(0),
        permit: ExecutionPermit::Prepared,
    };
    code(
        permit.transition(&permit.scope, Counter(0), ExecutionPermit::Active),
        ErrorCode::InvalidRequest,
    );
    permit.revision = Counter(1);
    permit.scope.execution_epoch = Counter(0);
    code(
        permit.transition(&permit.scope, Counter(1), ExecutionPermit::Active),
        ErrorCode::InvalidRequest,
    );
}

#[test]
fn permanent_failure_requires_the_same_stop_and_retention_gates() {
    let store = store();
    let record = active(&store);
    let record = fact(
        &store,
        &record,
        TaskFact::FailureRequested {
            operation_id: id("failure-settle"),
            reason: "verified deployment failure".into(),
        },
    );
    assert_eq!(record.phase, TaskPhase::Settling);
    code(
        reduce_task(&record, &record.binding.scope, &TaskFact::CommitTerminal),
        ErrorCode::CleanupIncomplete,
    );
    let terminal = stop_and_commit(&store, &record, graceful());
    assert_eq!(terminal.phase, TaskPhase::Failed);
    assert_eq!(
        terminal.failure_reasons,
        vec!["verified deployment failure"]
    );
    code(
        reduce_task(
            &terminal,
            &terminal.binding.scope,
            &TaskFact::Activated {
                operation_id: terminal.activate_operation_id.clone(),
            },
        ),
        ErrorCode::InvalidRequest,
    );
}
#[test]
fn failure_can_replace_uncommitted_completion_without_discarding_goal_evidence() {
    let store = store();
    let record = active(&store);
    let record = fact(
        &store,
        &record,
        TaskFact::FinishRequested {
            operation_id: id("settle"),
            evidence: completion(),
        },
    );
    let record = fact(
        &store,
        &record,
        TaskFact::FailureRequested {
            operation_id: id("late-failure"),
            reason: "retention failed".into(),
        },
    );
    assert_eq!(
        record.settlement.as_ref().unwrap().operation_id,
        id("settle")
    );
    assert_eq!(
        record.settlement.as_ref().unwrap().requested_outcome,
        RequestedOutcome::Failed
    );
    assert_eq!(record.completion_evidence, Some(completion()));
    assert_eq!(
        stop_and_commit(&store, &record, graceful()).phase,
        TaskPhase::Failed
    );
}

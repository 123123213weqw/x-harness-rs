#[path = "../../xharness-cloud/tests/common/mod.rs"]
mod common;
use common::*;
use std::{
    fs,
    sync::{Arc, Mutex},
};
use xharness_cloud::*;
use xharness_cloud_app::*;

fn open(path: &std::path::Path) -> SqliteCloudTaskStore {
    SqliteCloudTaskStore::open(path, AdmissionLimits::default()).unwrap()
}
#[test]
fn admission_and_outbox_survive_reopen_without_duplicate_ids() {
    let dir = private_dir();
    let (receipt, task, snapshot) = {
        let store = open(dir.path());
        store.register_environment(environment("owner1")).unwrap();
        let receipt = store
            .admit(&id("owner1"), &envelope(), Counter(100))
            .unwrap();
        let task = store.get(&id("owner1"), &receipt.task_id).unwrap();
        (receipt, task, store.snapshot().unwrap())
    };
    let store = open(dir.path());
    assert_eq!(store.snapshot().unwrap(), snapshot);
    assert_eq!(
        store
            .admit(&id("owner1"), &envelope(), Counter(999))
            .unwrap(),
        receipt
    );
    assert_eq!(store.get(&id("owner1"), &receipt.task_id).unwrap(), task);
    // Replay exact trusted registration before checking occupied VM.
    store.register_environment(environment("owner1")).unwrap();
    assert_eq!(
        store
            .pending_intents(&id("owner1"), &task.task_id)
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn writer_lives_until_all_state_clones_are_dropped() {
    let dir = private_dir();
    let store = open(dir.path());
    let state = store.state();
    drop(store);
    assert!(
        matches!(SqliteCloudTaskStore::open(dir.path(), AdmissionLimits::default()), Err(e) if e.code == ErrorCode::EnvironmentBusy)
    );
    drop(state);
    let _reopened = open(dir.path());
}
#[test]
fn cancel_replay_precedes_stale_revision_check_after_restart() {
    let dir = private_dir();
    let (command, receipt, task) = {
        let store = open(dir.path());
        store.register_environment(environment("owner1")).unwrap();
        let task = accepted(&store);
        let command = cancel(&task, "cancel1");
        let receipt = store.admit(&id("owner1"), &command, Counter(100)).unwrap();
        let task = store.get(&id("owner1"), &task.task_id).unwrap();
        (command, receipt, task)
    };
    let store = open(dir.path());
    assert_eq!(
        store.admit(&id("owner1"), &command, Counter(200)).unwrap(),
        receipt
    );
    assert_eq!(store.get(&id("owner1"), &task.task_id).unwrap(), task);
    assert_eq!(
        store
            .stage_intents(&id("owner1"), &task.task_id)
            .unwrap()
            .len(),
        2
    );
}
#[test]
fn verified_fact_task_receipt_and_next_stage_are_atomic() {
    let dir = private_dir();
    let task = {
        let store = open(dir.path());
        store.register_environment(environment("owner1")).unwrap();
        attached(&store)
    };
    let store = open(dir.path());
    assert_eq!(
        store.get(&id("owner1"), &task.task_id).unwrap().phase,
        TaskPhase::Attached
    );
    let intents = store.stage_intents(&id("owner1"), &task.task_id).unwrap();
    assert!(intents
        .iter()
        .any(|i| i.kind == IntentKind::Prepare && i.status == IntentStatus::Verified));
    assert!(intents
        .iter()
        .any(|i| i.kind == IntentKind::Activate && i.status == IntentStatus::Pending));
    assert_ne!(
        store
            .receipt(&id("owner1"), &envelope().request_id)
            .unwrap()
            .unwrap()
            .status,
        ReceiptStatus::Applied
    );
}
#[test]
fn corrupt_existing_databases_are_not_reset_to_empty() {
    for bytes in [&b""[..], &b"not a sqlite database"[..]] {
        let dir = private_dir();
        fs::write(dir.path().join("control.sqlite3"), bytes).unwrap();
        assert!(SqliteCloudTaskStore::open(dir.path(), AdmissionLimits::default()).is_err());
        assert_eq!(fs::read(dir.path().join("control.sqlite3")).unwrap(), bytes);
    }
}
#[test]
fn schema_mismatch_and_tampered_row_identity_fail_closed() {
    for sql in [
        "PRAGMA user_version=99;",
        "UPDATE tasks SET id='different';",
        "UPDATE metadata SET value='\"0\"' WHERE key='next_id';",
    ] {
        let dir = private_dir();
        {
            let store = open(dir.path());
            store.register_environment(environment("owner1")).unwrap();
            accepted(&store);
        }
        let connection = rusqlite::Connection::open(dir.path().join("control.sqlite3")).unwrap();
        connection.execute_batch(sql).unwrap();
        drop(connection);
        assert!(SqliteCloudTaskStore::open(dir.path(), AdmissionLimits::default()).is_err());
    }
}
#[test]
fn observations_are_immutable_and_scope_is_validated_by_controller() {
    let dir = private_dir();
    let store = open(dir.path());
    store.register_environment(environment("owner1")).unwrap();
    let task = accepted(&store);
    let observation = StageObservation {
        operation_id: task.prepare_operation_id.clone(),
        scope: task.binding.scope.clone(),
        outcome: StageOutcome::Prepared {
            ready: true,
            bootstrap_prepared: true,
        },
    };
    store.save_observation(&observation).unwrap();
    store.save_observation(&observation).unwrap();
    let mut different = observation.clone();
    different.outcome = StageOutcome::Activated;
    assert_eq!(
        store.save_observation(&different).unwrap_err().code,
        ErrorCode::IdempotencyConflict
    );
    drop(store);
    assert_eq!(
        open(dir.path())
            .observation(&observation.operation_id)
            .unwrap(),
        Some(observation)
    );
}
#[derive(Default)]
struct Sink {
    changes: Mutex<Vec<CloudMutation>>,
    fail: bool,
}
impl CloudCommitSink for Sink {
    fn commit(&self, change: &CloudMutation) -> CloudResult<()> {
        self.changes.lock().unwrap().push(change.clone());
        if self.fail {
            Err(CloudError::new(
                ErrorCode::StorageFailure,
                "injected ambiguous commit",
            ))
        } else {
            Ok(())
        }
    }
}
#[test]
fn ambiguous_commit_acknowledgement_fences_all_reads_and_writes() {
    let initial = store().snapshot().unwrap();
    let sink = Arc::new(Sink {
        fail: true,
        ..Sink::default()
    });
    let state =
        MemoryCloudTaskStore::restore(initial, AdmissionLimits::default(), sink.clone()).unwrap();
    assert_eq!(
        state
            .admit(&id("owner1"), &envelope(), Counter(1))
            .unwrap_err()
            .code,
        ErrorCode::StorageFailure
    );
    assert_eq!(
        state.snapshot().unwrap_err().code,
        ErrorCode::StorageFailure
    );
    assert_eq!(
        state
            .receipt(&id("owner1"), &envelope().request_id)
            .unwrap_err()
            .code,
        ErrorCode::StorageFailure
    );
    assert_eq!(sink.changes.lock().unwrap().len(), 1);
}
#[test]
fn writes_emit_only_changed_rows_not_repeated_global_snapshots() {
    let sink = Arc::new(Sink::default());
    let state = MemoryCloudTaskStore::restore(
        store().snapshot().unwrap(),
        AdmissionLimits::default(),
        sink.clone(),
    )
    .unwrap();
    let task = accepted(&state);
    let task = fact(
        &state,
        &task,
        TaskFact::PrepareAdmitted {
            operation_id: task.prepare_operation_id.clone(),
        },
    );
    fact(
        &state,
        &task,
        TaskFact::Prepared {
            operation_id: task.prepare_operation_id.clone(),
            ready: true,
            bootstrap_prepared: true,
            grant_committed: true,
        },
    );
    let changes = sink.changes.lock().unwrap();
    assert!(changes.iter().all(|c| c.environments.is_empty()
        && c.tasks.len() <= 1
        && c.receipts.len() <= 1
        && c.intents.len() <= 2));
}
#[test]
fn restored_state_rejects_cross_task_epoch_and_conflicting_reservations() {
    let source = store();
    let task = accepted(&source);
    for case in 0..5 {
        let mut snapshot = source.snapshot().unwrap();
        match case {
            0 => snapshot.intents[0].scope.execution_epoch = Counter(2),
            1 => snapshot.tasks[0].binding.scope.volume_id = id("other-volume"),
            2 => snapshot.tasks.push(task.clone()),
            3 => snapshot.receipts[0].owner_id = id("owner2"),
            _ => snapshot.intents.clear(),
        }
        assert!(MemoryCloudTaskStore::restore(
            snapshot,
            AdmissionLimits::default(),
            Arc::new(Sink::default())
        )
        .is_err());
    }
}
#[test]
fn late_activation_records_history_without_resurrecting_cancelled_scope() {
    let store = store();
    let task = attached(&store);
    store
        .admit(&id("owner1"), &cancel(&task, "cancel"), Counter(200))
        .unwrap();
    let current = store.get(&id("owner1"), &task.task_id).unwrap();
    let next = fact(
        &store,
        &current,
        TaskFact::Activated {
            operation_id: current.activate_operation_id.clone(),
        },
    );
    assert_eq!(next.phase, TaskPhase::Settling);
    assert!(next.activated);
    let outcome = next.settlement.unwrap().requested_outcome;
    assert_eq!(outcome, RequestedOutcome::Cancelled);
}
#[cfg(unix)]
#[test]
fn symlink_and_non_private_directory_are_rejected() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let dir = private_dir();
    let target = private_dir();
    symlink(target.path(), dir.path().join("linked")).unwrap();
    assert!(
        SqliteCloudTaskStore::open(&dir.path().join("linked"), AdmissionLimits::default()).is_err()
    );
    fs::set_permissions(target.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(SqliteCloudTaskStore::open(target.path(), AdmissionLimits::default()).is_err());
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

#[test]
fn sqlite_wal_survives_real_process_exit_without_rust_destructors() {
    let dir = private_dir();
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "abrupt_exit_fixture", "--ignored"])
        .env("XHARNESS_CLOUD_CRASH_TEST_DIRECTORY", dir.path())
        .status()
        .unwrap();
    assert!(child.success());
    let store = open(dir.path());
    let receipt = store
        .receipt(&id("owner1"), &envelope().request_id)
        .unwrap()
        .unwrap();
    let task = store.get(&id("owner1"), &receipt.task_id).unwrap();
    assert_eq!(task.phase, TaskPhase::Accepted);
    assert_eq!(
        store
            .stage_intents(&id("owner1"), &task.task_id)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store
            .admit(&id("owner1"), &envelope(), Counter(999))
            .unwrap(),
        receipt
    );
}
#[test]
#[ignore = "subprocess-only fixture; parent supplies private directory"]
fn abrupt_exit_fixture() {
    let Some(dir) = std::env::var_os("XHARNESS_CLOUD_CRASH_TEST_DIRECTORY") else {
        return;
    };
    let store = open(std::path::Path::new(&dir));
    store.register_environment(environment("owner1")).unwrap();
    accepted(&store);
    // No Drop/checkpoint runs. SQLite WAL and OS lock release must suffice.
    std::process::exit(0);
}

#[test]
fn recovery_rejects_lost_serial_and_incomplete_terminal_proof() {
    let source = store();
    let task = active(&source);
    source
        .admit(&id("owner1"), &cancel(&task, "cancel"), Counter(100))
        .unwrap();
    let task = source.get(&id("owner1"), &task.task_id).unwrap();
    stop_and_commit(
        &source,
        &task,
        StopProof::Graceful {
            native_shutdown_verified: true,
            execution_scope_quiet: true,
            cleanup_errors: 0,
        },
    );
    for case in 0..4 {
        let mut snapshot = source.snapshot().unwrap();
        match case {
            0 => snapshot.next_id = Counter(1),
            1 => {
                snapshot.tasks[0].settlement.as_mut().unwrap().stop_proof =
                    Some(StopProof::Graceful {
                        native_shutdown_verified: false,
                        execution_scope_quiet: true,
                        cleanup_errors: 0,
                    })
            }
            2 => snapshot.tasks[0].binding.root_session_id = id("another-session"),
            _ => snapshot.tasks[0].spec.retention_policy_ref = reference("wrong-policy"),
        }
        assert!(MemoryCloudTaskStore::restore(
            snapshot,
            AdmissionLimits::default(),
            Arc::new(Sink::default())
        )
        .is_err());
    }
}

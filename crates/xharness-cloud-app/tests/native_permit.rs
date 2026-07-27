#[path = "../../xharness-cloud/tests/common/mod.rs"]
mod common;
use common::*;
use xharness_cloud::*;
use xharness_cloud_app::*;
fn fixture() -> (tempfile::TempDir, NativePermitBinding) {
    let dir = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let mut binding = accepted(&store()).binding;
    binding.host_build_ref.version = id(&"a".repeat(64));
    let workspace = dir.path().join("workspace").to_str().unwrap().to_owned();
    let state_dir = dir.path().join("state").to_str().unwrap().to_owned();
    (
        dir,
        NativePermitBinding {
            binding,
            workspace,
            state_dir,
        },
    )
}
fn command(s: &NativePermitSnapshot, op: &str, to: ExecutionPermit) -> NativePermitCommand {
    NativePermitCommand {
        operation_id: id(op),
        scope: s.permit.scope.clone(),
        expected_revision: s.permit.revision,
        to,
    }
}
fn active(j: &NativePermitJournal) {
    let s = j.snapshot().unwrap();
    j.transition(&command(&s, "activate", ExecutionPermit::Active))
        .unwrap();
}
fn stopped(sealed: bool) -> NativeShutdownOutcome {
    NativeShutdownOutcome {
        sealed,
        runtime_graceful: true,
        forced_workers: 0,
        cleanup_errors: 0,
    }
}
#[test]
fn binding_replay_after_restart_never_resets_authority() {
    let (dir, spec) = fixture();
    let j = NativePermitJournal::open(dir.path()).unwrap();
    j.initialize(spec.clone()).unwrap();
    active(&j);
    let before = j.snapshot().unwrap();
    j.transition(&command(&before, "seal", ExecutionPermit::Sealed))
        .unwrap();
    drop(j);
    let j = NativePermitJournal::open(dir.path()).unwrap();
    assert_eq!(
        j.initialize(spec).unwrap().permit.permit,
        ExecutionPermit::Sealed
    );
}
#[test]
fn lost_activate_ack_replays_receipt_without_unsealing() {
    let (dir, spec) = fixture();
    let j = NativePermitJournal::open(dir.path()).unwrap();
    let prepared = j.initialize(spec).unwrap();
    let cmd = command(&prepared, "activate", ExecutionPermit::Active);
    let ack = j.transition(&cmd).unwrap();
    let current = j.snapshot().unwrap();
    j.transition(&command(&current, "seal", ExecutionPermit::Sealed))
        .unwrap();
    drop(j);
    let j = NativePermitJournal::open(dir.path()).unwrap();
    assert_eq!(j.transition(&cmd).unwrap(), ack);
    assert_eq!(j.snapshot().unwrap().permit.permit, ExecutionPermit::Sealed);
}
#[test]
fn activate_cancel_race_cannot_restore_cancelled_work() {
    let (dir, spec) = fixture();
    let a = NativePermitJournal::open(dir.path()).unwrap();
    let s = a.initialize(spec).unwrap();
    let b = NativePermitJournal::open(dir.path()).unwrap();
    a.transition(&command(&s, "cancel", ExecutionPermit::Sealed))
        .unwrap();
    assert_eq!(
        b.transition(&command(&s, "activate", ExecutionPermit::Active))
            .unwrap_err()
            .code,
        ErrorCode::RevisionConflict
    );
    assert!(b.claim_launch().is_err());
}
#[test]
fn command_identity_conflict_does_not_change_authority() {
    let (dir, spec) = fixture();
    let j = NativePermitJournal::open(dir.path()).unwrap();
    let s = j.initialize(spec).unwrap();
    let cmd = command(&s, "command", ExecutionPermit::Active);
    j.transition(&cmd).unwrap();
    let mut changed = cmd;
    changed.to = ExecutionPermit::Sealed;
    assert_eq!(
        j.transition(&changed).unwrap_err().code,
        ErrorCode::IdempotencyConflict
    );
    assert_eq!(j.snapshot().unwrap().permit.permit, ExecutionPermit::Active);
}
#[test]
fn scope_and_specification_are_fenced() {
    let (dir, spec) = fixture();
    let j = NativePermitJournal::open(dir.path()).unwrap();
    let s = j.initialize(spec.clone()).unwrap();
    let mut wrong = command(&s, "wrong", ExecutionPermit::Active);
    wrong.scope.execution_epoch = Counter(2);
    assert!(j.transition(&wrong).is_err());
    let mut changed = spec;
    changed.state_dir = "/other".into();
    assert!(j.initialize(changed).is_err());
    assert_eq!(j.snapshot().unwrap(), s);
}
#[test]
fn prepared_cannot_launch_and_sealed_cannot_become_ready() {
    let (dir, spec) = fixture();
    let j = NativePermitJournal::open(dir.path()).unwrap();
    j.initialize(spec).unwrap();
    assert!(j.claim_launch().is_err());
    active(&j);
    let launch = j.claim_launch().unwrap();
    assert_eq!(launch.phase, NativeLaunchPhase::Starting);
    let s = j.snapshot().unwrap();
    j.transition(&command(&s, "seal", ExecutionPermit::Sealed))
        .unwrap();
    assert!(j.record_ready(launch.generation).is_err());
    assert!(j.claim_launch().is_err());
    let stop = j.record_shutdown(launch.generation, stopped(true)).unwrap();
    assert_eq!(stop.phase, NativeLaunchPhase::Stopped);
}
#[test]
fn graceful_temporary_shutdown_keeps_active_and_advances_launch_generation() {
    let (dir, spec) = fixture();
    let j = NativePermitJournal::open(dir.path()).unwrap();
    j.initialize(spec).unwrap();
    active(&j);
    let one = j.claim_launch().unwrap();
    j.record_ready(one.generation).unwrap();
    j.record_shutdown(one.generation, stopped(false)).unwrap();
    drop(j);
    let j = NativePermitJournal::open(dir.path()).unwrap();
    let two = j.claim_launch().unwrap();
    assert_eq!(two.generation, Counter(2));
    assert_eq!(j.snapshot().unwrap().permit.permit, ExecutionPermit::Active);
    assert_eq!(
        j.launch(one.generation).unwrap().phase,
        NativeLaunchPhase::Stopped
    );
    assert!(j.record_shutdown(one.generation, stopped(false)).is_err());
    assert_eq!(
        j.launch(two.generation).unwrap().phase,
        NativeLaunchPhase::Starting
    );
}
#[test]
fn absent_crash_stop_receipt_requires_external_reconciliation() {
    let (dir, spec) = fixture();
    let j = NativePermitJournal::open(dir.path()).unwrap();
    j.initialize(spec).unwrap();
    active(&j);
    let one = j.claim_launch().unwrap();
    drop(j);
    let j = NativePermitJournal::open(dir.path()).unwrap();
    assert_eq!(
        j.launch(one.generation).unwrap().phase,
        NativeLaunchPhase::Starting
    );
    assert!(j.claim_launch().is_err());
    assert_eq!(j.snapshot().unwrap().launch_generation, one.generation);
}
#[test]
fn failed_cleanup_is_not_graceful_proof_and_cannot_restart() {
    let (dir, spec) = fixture();
    let j = NativePermitJournal::open(dir.path()).unwrap();
    j.initialize(spec).unwrap();
    active(&j);
    let one = j.claim_launch().unwrap();
    let mut outcome = stopped(false);
    outcome.cleanup_errors = 1;
    assert!(j.record_shutdown(one.generation, outcome.clone()).is_err());
    outcome.runtime_graceful = false;
    j.record_shutdown(one.generation, outcome.clone()).unwrap();
    assert!(j.claim_launch().is_err());
    assert_eq!(
        j.record_shutdown(one.generation, outcome).unwrap().phase,
        NativeLaunchPhase::Stopped
    );
    assert!(j.record_shutdown(one.generation, stopped(false)).is_err());
}
#[test]
fn stop_sealed_flag_is_authoritative_not_caller_claim() {
    let (dir, spec) = fixture();
    let j = NativePermitJournal::open(dir.path()).unwrap();
    j.initialize(spec).unwrap();
    active(&j);
    let one = j.claim_launch().unwrap();
    assert!(j.record_shutdown(one.generation, stopped(true)).is_err());
    assert_eq!(
        j.launch(one.generation).unwrap().phase,
        NativeLaunchPhase::Starting
    );
}
#[test]
fn corrupt_or_empty_existing_journal_fails_closed() {
    for content in [b"".as_slice(), b"not sqlite"] {
        let (dir, _) = fixture();
        std::fs::write(dir.path().join("native-permit.sqlite3"), content).unwrap();
        assert!(NativePermitJournal::open(dir.path()).is_err());
    }
}
#[cfg(unix)]
#[test]
fn journal_symlink_and_public_directory_are_rejected() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let (dir, _) = fixture();
    let elsewhere = tempfile::NamedTempFile::new().unwrap();
    symlink(elsewhere.path(), dir.path().join("native-permit.sqlite3")).unwrap();
    assert!(NativePermitJournal::open(dir.path()).is_err());
    std::fs::remove_file(dir.path().join("native-permit.sqlite3")).unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(NativePermitJournal::open(dir.path()).is_err());
}
#[test]
fn corrupted_authority_or_missing_launch_head_is_not_reinitialized() {
    let (dir, spec) = fixture();
    let j = NativePermitJournal::open(dir.path()).unwrap();
    j.initialize(spec.clone()).unwrap();
    active(&j);
    j.claim_launch().unwrap();
    let c = rusqlite::Connection::open(dir.path().join("native-permit.sqlite3")).unwrap();
    c.execute("DELETE FROM launches", []).unwrap();
    assert!(j.snapshot().is_err());
    assert!(j.claim_launch().is_err());
    // Idempotent initialize must validate the head as well, never repair loss.
    assert!(j.initialize(spec).is_err());
}
#[test]
fn same_phase_transition_is_idempotent_without_revision_growth() {
    let (dir, spec) = fixture();
    let j = NativePermitJournal::open(dir.path()).unwrap();
    let s = j.initialize(spec).unwrap();
    let receipt = j
        .transition(&command(&s, "prepared-ack", ExecutionPermit::Prepared))
        .unwrap();
    assert_eq!(receipt, s.permit);
    active(&j);
    let s = j.snapshot().unwrap();
    assert_eq!(
        j.transition(&command(&s, "active-ack", ExecutionPermit::Active))
            .unwrap(),
        s.permit
    );
}
#[test]
fn native_cli_rejects_credentials_and_unknown_fields_without_echo() {
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    let (dir, spec) = fixture();
    let mut value = serde_json::to_value(spec).unwrap();
    value["api_key"] = serde_json::json!("fixture-secret-not-real");
    let mut child = Command::new(env!("CARGO_BIN_EXE_xharness-native-permit"))
        .args(["--journal-dir", dir.path().to_str().unwrap(), "initialize"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(value.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stderr).contains("fixture-secret"));
    assert!(output.stdout.is_empty());
}

#[cfg(unix)]
#[test]
fn replaced_journal_does_not_leave_running_reader_on_old_active_inode() {
    let (dir, spec) = fixture();
    let j = NativePermitJournal::open(dir.path()).unwrap();
    j.initialize(spec).unwrap();
    active(&j);
    std::fs::rename(
        dir.path().join("native-permit.sqlite3"),
        dir.path().join("old.sqlite3"),
    )
    .unwrap();
    std::fs::write(dir.path().join("native-permit.sqlite3"), b"replacement").unwrap();
    assert!(j.snapshot().is_err());
    assert!(j.claim_launch().is_err());
}
#[test]
fn damaged_authority_counters_are_not_accepted() {
    let (dir, spec) = fixture();
    let j = NativePermitJournal::open(dir.path()).unwrap();
    j.initialize(spec).unwrap();
    active(&j);
    let mut snapshot = serde_json::to_value(j.snapshot().unwrap()).unwrap();
    snapshot["permit"]["revision"] = serde_json::json!("999");
    let c = rusqlite::Connection::open(dir.path().join("native-permit.sqlite3")).unwrap();
    c.execute("UPDATE authority SET payload=?1", [snapshot.to_string()])
        .unwrap();
    assert!(j.snapshot().is_err());
    assert!(j.claim_launch().is_err());
}

#[test]
fn missing_authority_with_residual_receipts_cannot_reset_a_sealed_binding() {
    for with_launch in [false, true] {
        let (dir, spec) = fixture();
        let j = NativePermitJournal::open(dir.path()).unwrap();
        j.initialize(spec.clone()).unwrap();
        active(&j);
        if with_launch {
            j.claim_launch().unwrap();
        }
        j.transition(&command(
            &j.snapshot().unwrap(),
            "seal",
            ExecutionPermit::Sealed,
        ))
        .unwrap();
        let c = rusqlite::Connection::open(dir.path().join("native-permit.sqlite3")).unwrap();
        c.execute("DELETE FROM authority", []).unwrap();
        assert!(j.snapshot().is_err());
        assert!(
            j.initialize(spec).is_err(),
            "must not reset a damaged binding"
        );
        let rows: u64 = c
            .query_row("SELECT COUNT(*) FROM authority", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "failed recovery must not write a new authority");
    }
}

#[test]
fn corrupted_historical_ack_is_not_accepted_even_after_seal() {
    let (dir, spec) = fixture();
    let j = NativePermitJournal::open(dir.path()).unwrap();
    let s = j.initialize(spec).unwrap();
    let cmd = command(&s, "activate", ExecutionPermit::Active);
    let ack = j.transition(&cmd).unwrap();
    j.transition(&command(
        &j.snapshot().unwrap(),
        "seal",
        ExecutionPermit::Sealed,
    ))
    .unwrap();
    let mut damaged = serde_json::to_value(ack).unwrap();
    damaged["revision"] = serde_json::json!("0");
    let c = rusqlite::Connection::open(dir.path().join("native-permit.sqlite3")).unwrap();
    c.execute(
        "UPDATE commands SET payload=?1 WHERE id=?2",
        rusqlite::params![damaged.to_string(), cmd.operation_id.as_str()],
    )
    .unwrap();
    assert!(
        j.transition(&cmd).is_err(),
        "corrupted acknowledgement must fail closed"
    );
    assert_eq!(j.snapshot().unwrap().permit.permit, ExecutionPermit::Sealed);
}

#[test]
fn launch_cannot_have_started_from_prepared_revision() {
    let (dir, spec) = fixture();
    let j = NativePermitJournal::open(dir.path()).unwrap();
    j.initialize(spec.clone()).unwrap();
    active(&j);
    let launch = j.claim_launch().unwrap();
    let mut damaged = serde_json::to_value(launch).unwrap();
    damaged["permit_revision_at_start"] = serde_json::json!("1");
    let c = rusqlite::Connection::open(dir.path().join("native-permit.sqlite3")).unwrap();
    c.execute("UPDATE launches SET payload=?1", [damaged.to_string()])
        .unwrap();
    assert!(
        j.snapshot().is_err(),
        "native launch requires the Active revision"
    );
    assert!(j.initialize(spec).is_err());
    assert!(j.claim_launch().is_err());
}

#[test]
fn untouched_uninitialized_database_can_be_reopened_and_initialized() {
    let (dir, spec) = fixture();
    drop(NativePermitJournal::open(dir.path()).unwrap());
    let j = NativePermitJournal::open(dir.path()).unwrap();
    assert_eq!(
        j.initialize(spec).unwrap().permit.permit,
        ExecutionPermit::Prepared
    );
}

fn bootstrap_intent(spec: &NativePermitBinding) -> NativeBootstrapIntent {
    NativeBootstrapIntent {
        operation_id: id("prepare-bootstrap"),
        scope: spec.binding.scope.clone(),
        root_session_id: spec.binding.root_session_id.clone(),
        fingerprint: "b".repeat(64),
        task_spec_fingerprint: "d".repeat(64),
    }
}
#[test]
fn prepared_goal_receipt_precedes_activation_in_the_same_launch() {
    let (dir, spec) = fixture();
    let j = NativePermitJournal::open(dir.path()).unwrap();
    j.initialize(spec.clone()).unwrap();
    assert!(j.claim_prepared_launch().is_err());
    let intent = bootstrap_intent(&spec);
    let first = j.reserve_bootstrap(intent.clone()).unwrap();
    assert!(!first.applied);
    let launch = j.claim_prepared_launch().unwrap();
    assert_eq!(launch.permit_revision_at_start, Counter(1));
    assert!(j.record_prepared_ready(launch.generation).is_err());
    j.record_bootstrap_applied(&intent).unwrap();
    j.record_prepared_ready(launch.generation).unwrap();
    assert_eq!(
        j.launch(launch.generation).unwrap().phase,
        NativeLaunchPhase::PreparedReady
    );
    assert!(j.record_ready(launch.generation).is_err());
    active(&j);
    j.record_ready(launch.generation).unwrap();
    assert_eq!(j.snapshot().unwrap().launch_generation, launch.generation);
    assert!(j.reserve_bootstrap(intent).unwrap().applied);
}
#[test]
fn bootstrap_scope_conflicts_and_seal_are_not_reinitialization() {
    let (dir, spec) = fixture();
    let j = NativePermitJournal::open(dir.path()).unwrap();
    j.initialize(spec.clone()).unwrap();
    let intent = bootstrap_intent(&spec);
    j.reserve_bootstrap(intent.clone()).unwrap();
    for change in 0..3 {
        let mut bad = intent.clone();
        match change {
            0 => bad.operation_id = id("other"),
            1 => bad.fingerprint = "c".repeat(64),
            _ => bad.scope.execution_epoch = Counter(2),
        };
        assert!(j.reserve_bootstrap(bad).is_err());
    }
    let s = j.snapshot().unwrap();
    j.transition(&command(&s, "seal-before-boot", ExecutionPermit::Sealed))
        .unwrap();
    assert!(j.claim_prepared_launch().is_err());
    assert!(j.record_bootstrap_applied(&intent).is_err());
    drop(j);
    let j = NativePermitJournal::open(dir.path()).unwrap();
    assert_eq!(
        j.initialize(spec).unwrap().permit.permit,
        ExecutionPermit::Sealed
    );
}
#[test]
fn graceful_prepared_restart_preserves_applied_identity_without_regranting_execution() {
    let (dir, spec) = fixture();
    let j = NativePermitJournal::open(dir.path()).unwrap();
    j.initialize(spec.clone()).unwrap();
    let intent = bootstrap_intent(&spec);
    j.reserve_bootstrap(intent.clone()).unwrap();
    let first = j.claim_prepared_launch().unwrap();
    j.record_bootstrap_applied(&intent).unwrap();
    j.record_prepared_ready(first.generation).unwrap();
    j.record_shutdown(first.generation, stopped(false)).unwrap();
    drop(j);
    let j = NativePermitJournal::open(dir.path()).unwrap();
    let second = j.claim_prepared_launch().unwrap();
    assert_eq!(second.generation, Counter(2));
    assert!(j.bootstrap().unwrap().unwrap().applied);
    j.record_prepared_ready(second.generation).unwrap();
    assert_eq!(
        j.snapshot().unwrap().permit.permit,
        ExecutionPermit::Prepared
    );
}

#[test]
fn additive_v1_migration_preserves_seal_launch_and_historical_activation_ack() {
    let (dir, spec) = fixture();
    let j = NativePermitJournal::open(dir.path()).unwrap();
    let initial = j.initialize(spec.clone()).unwrap();
    let activate = command(&initial, "activate-v1", ExecutionPermit::Active);
    let ack = j.transition(&activate).unwrap();
    let launch = j.claim_launch().unwrap();
    j.record_ready(launch.generation).unwrap();
    j.transition(&command(
        &j.snapshot().unwrap(),
        "seal-v1",
        ExecutionPermit::Sealed,
    ))
    .unwrap();
    let stop = j.record_shutdown(launch.generation, stopped(true)).unwrap();
    let sealed = j.snapshot().unwrap();
    drop(j);
    // Real schema-1 shape: no bootstrap table, authority/commands/launches
    // retained exactly. Opening schema 2 must not reinitialize execution.
    let c = rusqlite::Connection::open(dir.path().join("native-permit.sqlite3")).unwrap();
    c.execute_batch("DROP TABLE bootstrap; PRAGMA user_version=1;")
        .unwrap();
    drop(c);
    let j = NativePermitJournal::open(dir.path()).unwrap();
    assert_eq!(j.initialize(spec).unwrap(), sealed);
    assert_eq!(j.launch(launch.generation).unwrap(), stop);
    assert_eq!(j.transition(&activate).unwrap(), ack);
    assert_eq!(j.snapshot().unwrap(), sealed);
    assert!(j.bootstrap().unwrap().is_none());
    assert!(j.claim_launch().is_err());
    assert!(j.claim_prepared_launch().is_err());
    let c = rusqlite::Connection::open(dir.path().join("native-permit.sqlite3")).unwrap();
    assert_eq!(
        c.pragma_query_value(None, "user_version", |row| row.get::<_, u64>(0))
            .unwrap(),
        2
    );
}

use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use xharness_jobs::{
    JobCancel, JobConfigError, JobError, JobEventKind, JobOutcome, JobRegistry, JobRegistryConfig,
    JobStatus, KillResult,
};

fn noop_cancel() -> JobCancel {
    Arc::new(|_| Ok(()))
}

fn start(
    registry: &JobRegistry,
    owner: &str,
    kind: &str,
    label: &str,
) -> (String, xharness_jobs::JobLease) {
    let reservation = registry
        .reserve(owner, kind, label, None)
        .expect("reserve job");
    let (id, lease) = reservation
        .commit(Some(1234), noop_cancel())
        .expect("commit job");
    (id.to_string(), lease)
}

#[test]
fn dynamic_configuration_rejects_every_zero_limit_without_panicking() {
    let config = JobRegistryConfig {
        max_concurrent_jobs_per_owner: 0,
        ..JobRegistryConfig::default()
    };
    assert!(matches!(
        JobRegistry::try_new(config),
        Err(JobConfigError::InvalidConcurrentLimit)
    ));

    let config = JobRegistryConfig {
        default_output_limit_bytes: 0,
        ..JobRegistryConfig::default()
    };
    assert!(matches!(
        JobRegistry::try_new(config),
        Err(JobConfigError::InvalidOutputLimit)
    ));

    let config = JobRegistryConfig {
        max_retained_jobs_per_owner: 0,
        ..JobRegistryConfig::default()
    };
    assert!(matches!(
        JobRegistry::try_new(config),
        Err(JobConfigError::InvalidRetentionLimit)
    ));

    let config = JobRegistryConfig {
        event_capacity: 0,
        ..JobRegistryConfig::default()
    };
    assert!(matches!(
        JobRegistry::try_new(config),
        Err(JobConfigError::InvalidEventCapacity)
    ));
}

#[test]
fn reservation_preflights_capacity_and_failed_start_does_not_consume_an_id() {
    let registry = JobRegistry::new(JobRegistryConfig {
        max_concurrent_jobs_per_owner: 1,
        ..JobRegistryConfig::default()
    });
    let abandoned = registry
        .reserve("owner", "bash", "will not start", None)
        .unwrap();
    assert!(matches!(
        registry.reserve("owner", "bash", "blocked", None),
        Err(JobError::Capacity { limit: 1 })
    ));
    drop(abandoned);

    let (id, lease) = start(&registry, "owner", "bash", "first actual process");
    assert_eq!(id, "bash-1");
    lease.finish(JobOutcome::completed("exit code: 0"));
    let (next, next_lease) = start(&registry, "owner", "bash", "second process");
    assert_eq!(next, "bash-2");
    next_lease.finish(JobOutcome::completed("exit code: 0"));
}

#[test]
fn validates_identity_and_hides_foreign_predictable_ids() {
    let registry = JobRegistry::default();
    assert!(matches!(
        registry.reserve("", "bash", "x", None),
        Err(JobError::EmptyOwner)
    ));
    assert!(matches!(
        registry.reserve("owner", "", "x", None),
        Err(JobError::EmptyKind)
    ));
    assert!(matches!(
        registry.reserve("owner", "bash", "", None),
        Err(JobError::EmptyLabel)
    ));
    assert!(matches!(
        registry.reserve("owner", "bash", "x", Some(0)),
        Err(JobError::InvalidOutputLimit)
    ));

    let (id, lease) = start(&registry, "alice", "bash", "secret label");
    assert_eq!(registry.list("bob"), Vec::new());
    assert_eq!(
        registry.get("bob", &id).unwrap_err(),
        JobError::NotFound { id: id.clone() }
    );
    assert_eq!(
        registry.get("bob", "bash-99").unwrap_err(),
        JobError::NotFound {
            id: "bash-99".to_owned()
        }
    );
    lease.finish(JobOutcome::completed("exit code: 0"));
}

#[test]
fn stream_reads_are_consuming_bounded_and_preserve_split_unicode() {
    let registry = JobRegistry::default();
    let reservation = registry
        .reserve("owner", "bash", "stream", Some(5))
        .unwrap();
    let (id, lease) = reservation.commit(None, noop_cancel()).unwrap();

    lease.publish_stdout([0xc3]);
    let partial = registry.read("owner", id.as_str()).unwrap();
    assert_eq!(partial.stdout, "");
    assert!(!partial.stdout_truncated);
    lease.publish_stdout([0xa9]);
    lease.publish_stderr("abcdef");
    let complete = registry.read("owner", id.as_str()).unwrap();
    assert_eq!(complete.stdout, "é");
    assert_eq!(complete.stderr, "bcdef");
    assert!(complete.stderr_truncated);
    let consumed = registry.read("owner", id.as_str()).unwrap();
    assert_eq!(consumed.stdout, "");
    assert_eq!(consumed.stderr, "");
    assert!(!consumed.stderr_truncated);
    lease.finish(JobOutcome::completed("exit code: 0"));
    assert!(
        registry
            .read("owner", id.as_str())
            .unwrap()
            .snapshot
            .reported
    );
}

#[test]
fn all_terminal_states_are_first_wins_and_release_capacity() {
    for outcome in [
        JobOutcome::completed("exit code: 7"),
        JobOutcome::killed("cancelled"),
        JobOutcome::failed("transport failed"),
    ] {
        let registry = JobRegistry::new(JobRegistryConfig {
            max_concurrent_jobs_per_owner: 1,
            ..JobRegistryConfig::default()
        });
        let (id, lease) = start(&registry, "owner", "bash", "one");
        let expected = match outcome.status {
            xharness_jobs::TerminalJobStatus::Completed => JobStatus::Completed,
            xharness_jobs::TerminalJobStatus::Killed => JobStatus::Killed,
            xharness_jobs::TerminalJobStatus::Failed => JobStatus::Failed,
        };
        lease.finish(outcome);
        assert_eq!(registry.get("owner", &id).unwrap().status, expected);
        let (_, replacement) = start(&registry, "owner", "bash", "replacement");
        replacement.finish(JobOutcome::completed("exit code: 0"));
    }
}

#[test]
fn retention_prunes_only_old_terminal_records_for_the_same_owner() {
    let registry = JobRegistry::new(JobRegistryConfig {
        max_concurrent_jobs_per_owner: 3,
        max_retained_jobs_per_owner: 2,
        ..JobRegistryConfig::default()
    });
    let (first, first_lease) = start(&registry, "alice", "bash", "first");
    first_lease.finish(JobOutcome::completed("exit code: 0"));
    let (second, second_lease) = start(&registry, "alice", "bash", "second");
    second_lease.finish(JobOutcome::completed("exit code: 0"));
    let (foreign, foreign_lease) = start(&registry, "bob", "bash", "foreign");
    foreign_lease.finish(JobOutcome::completed("exit code: 0"));

    let (third, third_lease) = start(&registry, "alice", "bash", "third");
    assert_eq!(
        registry
            .list("alice")
            .into_iter()
            .map(|job| job.id.to_string())
            .collect::<Vec<_>>(),
        [second, third.clone()]
    );
    assert!(matches!(
        registry.get("alice", &first),
        Err(JobError::NotFound { .. })
    ));
    assert_eq!(registry.list("bob")[0].id.to_string(), foreign);
    third_lease.finish(JobOutcome::completed("exit code: 0"));

    let active_registry = JobRegistry::new(JobRegistryConfig {
        max_concurrent_jobs_per_owner: 2,
        max_retained_jobs_per_owner: 1,
        ..JobRegistryConfig::default()
    });
    let (_, active_one) = start(&active_registry, "owner", "bash", "active one");
    let (_, active_two) = start(&active_registry, "owner", "bash", "active two");
    assert_eq!(active_registry.list("owner").len(), 2);
    active_one.finish(JobOutcome::completed("exit code: 0"));
    active_two.finish(JobOutcome::completed("exit code: 0"));
}

#[test]
fn dropping_a_producer_lease_force_fails_instead_of_hanging() {
    let registry = JobRegistry::default();
    let (id, lease) = start(&registry, "owner", "bash", "broken producer");
    drop(lease);
    let snapshot = registry.get("owner", &id).unwrap();
    assert_eq!(snapshot.status, JobStatus::Failed);
    assert!(snapshot
        .detail
        .unwrap()
        .contains("producer stopped before publishing"));
}

#[test]
fn kill_is_idempotent_and_a_throwing_cancel_mutates_nothing() {
    let registry = JobRegistry::default();
    let failing = registry
        .reserve("owner", "bash", "bad cancel", None)
        .unwrap();
    let (bad_id, bad_lease) = failing
        .commit(None, Arc::new(|_| Err("cancel boom".to_owned())))
        .unwrap();
    assert!(matches!(
        registry.kill("owner", bad_id.as_str(), Some("stop")),
        Err(JobError::CancelFailed { .. })
    ));
    let untouched = registry.get("owner", bad_id.as_str()).unwrap();
    assert_eq!(untouched.status, JobStatus::Running);
    assert!(!untouched.reported);
    bad_lease.finish(JobOutcome::completed("exit code: 0"));
    assert_eq!(
        registry.kill("owner", bad_id.as_str(), None).unwrap(),
        KillResult::AlreadyFinished
    );

    let cancellations = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&cancellations);
    let reservation = registry.reserve("owner", "bash", "killable", None).unwrap();
    let (id, lease) = reservation
        .commit(
            None,
            Arc::new(move |_| {
                count.fetch_add(1, Ordering::Relaxed);
                Ok(())
            }),
        )
        .unwrap();
    assert_eq!(
        registry
            .kill("owner", id.as_str(), Some("obsolete"))
            .unwrap(),
        KillResult::Requested
    );
    assert_eq!(
        registry.get("owner", id.as_str()).unwrap().status,
        JobStatus::Stopping
    );
    assert!(registry.get("owner", id.as_str()).unwrap().reported);
    assert_eq!(
        registry.kill("owner", id.as_str(), None).unwrap(),
        KillResult::Requested
    );
    assert_eq!(cancellations.load(Ordering::Relaxed), 2);
    lease.finish(JobOutcome::killed("cancelled"));
}

#[tokio::test]
async fn wait_timeout_is_live_and_settlement_is_reported() {
    let registry = JobRegistry::default();
    let (id, lease) = start(&registry, "owner", "bash", "wait");
    let timed_out = registry
        .wait("owner", &id, Duration::from_millis(5))
        .await
        .unwrap();
    assert_eq!(timed_out.status, JobStatus::Running);
    assert!(!timed_out.reported);

    let waiter_registry = registry.clone();
    let waiter_id = id.clone();
    let waiter = tokio::spawn(async move {
        waiter_registry
            .wait("owner", &waiter_id, Duration::from_secs(2))
            .await
            .unwrap()
    });
    tokio::task::yield_now().await;
    lease.finish(JobOutcome::completed("exit code: 0"));
    let settled = waiter.await.unwrap();
    assert_eq!(settled.status, JobStatus::Completed);
    assert!(settled.reported);
    assert!(matches!(
        registry.wait("owner", &id, Duration::ZERO).await,
        Err(JobError::InvalidWaitTimeout)
    ));
}

#[tokio::test]
async fn lifecycle_events_are_ordered_and_contained_by_broadcast_lag() {
    let registry = JobRegistry::default();
    let mut events = registry.subscribe();
    let (id, lease) = start(&registry, "owner", "bash", "events");
    assert_eq!(events.recv().await.unwrap().kind, JobEventKind::Started);
    registry.kill("owner", &id, None).unwrap();
    assert_eq!(events.recv().await.unwrap().kind, JobEventKind::Stopping);
    lease.finish(JobOutcome::killed("cancelled"));
    let finished = events.recv().await.unwrap();
    assert_eq!(finished.kind, JobEventKind::Finished);
    assert_eq!(finished.job.status, JobStatus::Killed);
}

#[tokio::test]
async fn shutdown_cancels_jobs_and_bounds_noncompliant_producers() {
    let registry = JobRegistry::default();
    let cancellations = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&cancellations);
    let reservation = registry.reserve("owner", "bash", "hang", None).unwrap();
    let (id, lease) = reservation
        .commit(
            None,
            Arc::new(move |_| {
                count.fetch_add(1, Ordering::Relaxed);
                Ok(())
            }),
        )
        .unwrap();

    let report = registry.shutdown(Duration::from_millis(5)).await;
    assert_eq!(report.jobs, 1);
    assert_eq!(report.timed_out, 1);
    assert_eq!(cancellations.load(Ordering::Relaxed), 1);
    assert_eq!(
        registry.get("owner", id.as_str()).unwrap().status,
        JobStatus::Failed
    );
    assert!(matches!(
        registry.reserve("owner", "bash", "late", None),
        Err(JobError::ShuttingDown)
    ));
    // Late producer settlement cannot replace the shutdown first-wins state.
    lease.finish(JobOutcome::killed("late"));
    assert_eq!(
        registry.get("owner", id.as_str()).unwrap().status,
        JobStatus::Failed
    );
}

#[tokio::test]
async fn shutdown_contains_cancel_hook_failures_and_preserves_first_terminal_state() {
    let registry = JobRegistry::default();
    let reservation = registry
        .reserve("owner", "bash", "uncancellable", None)
        .unwrap();
    let (id, lease) = reservation
        .commit(None, Arc::new(|_| Err("producer refused".to_owned())))
        .unwrap();

    let report = registry.shutdown(Duration::from_secs(1)).await;
    assert_eq!(report.jobs, 1);
    assert_eq!(report.cancellation_failures, 1);
    assert_eq!(report.timed_out, 0);
    let forced = registry.get("owner", id.as_str()).unwrap();
    assert_eq!(forced.status, JobStatus::Failed);
    assert!(forced.detail.unwrap().contains("may be orphaned"));

    lease.finish(JobOutcome::completed("late success"));
    assert_eq!(
        registry.get("owner", id.as_str()).unwrap().status,
        JobStatus::Failed
    );
}

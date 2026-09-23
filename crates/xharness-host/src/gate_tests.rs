use crate::{BasicHost, HostConfig, NoTools};
use std::sync::Arc;

/// Expired session gates must be reclaimed even when callers supplied IDs for
/// sessions that never existed.
#[tokio::test]
async fn gate_tables_do_not_grow_for_sessions_that_do_not_exist() {
    let mut config = HostConfig::new(std::env::temp_dir());
    config.provider_id = "test".into();
    config.model_id = "test".into();
    let host = BasicHost::new(config, None, Arc::new(NoTools));

    for index in 0..64 {
        let session_id = format!("never-created-{index}");
        let _admission = host.lock_admission(&session_id).await;
        let _projection = host.lock_projection(&session_id).await;
    }

    let admission = host.admission_gates.lock().await.len();
    let projection = host.projection_gates.lock().await.len();
    assert!(
        admission <= 1 && projection <= 1,
        "gate tables grew to admission={admission} projection={projection} \
         for sessions that do not exist"
    );
}

#[tokio::test]
async fn live_gate_waiters_share_one_lock_until_the_last_guard_is_dropped() {
    let host = BasicHost::new(
        HostConfig::new(std::env::temp_dir()),
        None,
        Arc::new(NoTools),
    );
    let first = host.lock_admission("shared").await;
    let second_host = host.clone();
    let waiter = tokio::spawn(async move { second_host.lock_admission("shared").await });
    tokio::task::yield_now().await;
    assert!(
        !waiter.is_finished(),
        "a same-key waiter bypassed the active guard"
    );
    // Unrelated keys still proceed even with a waiter on `shared`.
    let other = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        host.lock_admission("independent"),
    )
    .await
    .expect("different keys must not block each other");
    drop(other);
    drop(first);
    let second = tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
        .await
        .expect("same-key waiter did not acquire after release")
        .unwrap();
    drop(second);
    let _cleanup = host.lock_admission("cleanup").await;
    assert!(host.admission_gates.lock().await.len() <= 1);
}

//! Opt-in dispatch exercises the real claim service, inbox and disk recovery.
use super::*;
use xharness_control::SwarmTaskState;

async fn fixture() -> (
    Disk,
    Arc<BasicHost>,
    Arc<DurableLoopAgentRuntime>,
    Arc<dyn Store>,
    String,
    String,
) {
    let disk = Disk::new();
    let (host, runtime, store) = setup(&disk, Arc::new(Provider::default()));
    host.stop_background_listeners();
    host.restore_from_store_with_policy(store.clone(), RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    let (team, worker) = board_team(&host).await;
    (disk, host, runtime, store, team, worker)
}
async fn enabled(host: &BasicHost, team: &str, enabled: bool, key: &str) -> Value {
    let revision = board_list(host, team).await["revision"].as_u64().unwrap();
    success(manage(host, key, "owner", json!({"action":"set_dispatch","swarmId":team,"expectedRevision":revision,"enabled":enabled})).await)
}
async fn routed(
    host: &BasicHost,
    team: &str,
    name: &str,
    workers: Vec<String>,
    dependencies: Vec<String>,
) -> String {
    let revision = board_list(host, team).await["revision"].as_u64().unwrap();
    success(board(host,&format!("routed:{name}"),"owner",json!({"action":"add","swarmId":team,"expectedRevision":revision,"title":name,"instructions":format!("Collect evidence for {name}"),"dependencies":dependencies,"eligibleWorkerSessionIds":workers})).await)["taskId"].as_str().unwrap().into()
}
async fn message(host: &BasicHost, team: &str, task: &str) -> Option<String> {
    let state = host.state.read().await;
    match &state.swarms[team].tasks[task].state {
        SwarmTaskState::Assigned { message_id, .. } => Some(message_id.clone()),
        _ => None,
    }
}
async fn review(host: &BasicHost, team: &str, task: &str, outcome: &str) {
    let snapshot = host.state.read().await.swarms[team].clone();
    let attempt = crate::swarm_tasks::evidence::attempt(host, &snapshot.tasks[task])
        .await
        .unwrap()
        .unwrap();
    success(board(host,&format!("review:{task}"),"owner",json!({"action":"review","swarmId":team,"expectedRevision":snapshot.revision,"taskId":task,"executionRef":attempt.execution_ref,"outcome":outcome,"summary":"Coordinator checked the evidence"})).await);
}

#[tokio::test]
async fn swarm_auto_dispatch_requires_human_opt_in_and_explicit_routing() {
    let (_disk, host, runtime, _store, team, worker) = fixture().await;
    let manual = board_add(&host, &team, "manual-only", vec![]).await;
    let auto = routed(&host, &team, "routed", vec![worker.clone()], vec![]).await;
    assert!(!host.state.read().await.swarms[&team].auto_dispatch);
    host.reconcile_swarm_dispatch().await.unwrap();
    assert!(message(&host, &team, &auto).await.is_none());
    let revision = board_list(&host, &team).await["revision"].as_u64().unwrap();
    assert!(manage(
        &host,
        "foreign-enable",
        "someone-else",
        json!({"action":"set_dispatch","swarmId":team,"expectedRevision":revision,"enabled":true})
    )
    .await
    .is_failure());
    let receipt = enabled(&host, &team, true, "enable").await;
    // Exact settings retry returns the receipt even after later board changes.
    host.reconcile_swarm_dispatch().await.unwrap();
    assert_eq!(success(manage(&host,"enable","owner",json!({"action":"set_dispatch","swarmId":team,"expectedRevision":revision,"enabled":true})).await),receipt);
    assert!(message(&host, &team, &auto).await.is_some());
    assert!(message(&host, &team, &manual).await.is_none());
    let snapshot = host.state.read().await.swarms[&team].clone();
    assert!(board(&host,"outsider-route","owner",json!({"action":"add","swarmId":team,"expectedRevision":snapshot.revision,"title":"bad","instructions":"x","eligibleWorkerSessionIds":["outsider"]})).await.is_failure());
    assert!(board(&host,"duplicate-route","owner",json!({"action":"add","swarmId":team,"expectedRevision":snapshot.revision,"title":"bad","instructions":"x","eligibleWorkerSessionIds":[worker,worker]})).await.is_failure());
    stop_host(host, runtime).await;
}

#[tokio::test]
async fn swarm_auto_dispatch_races_claim_once_and_reserves_worker_until_review() {
    let (_disk, host, runtime, store, team, worker) = fixture().await;
    let first = routed(&host, &team, "first", vec![worker.clone()], vec![]).await;
    let other = routed(&host, &team, "other", vec![worker.clone()], vec![]).await;
    enabled(&host, &team, true, "enable").await;
    let revision = board_list(&host, &team).await["revision"].as_u64().unwrap();
    let (a, b, manual) = tokio::join!(
        host.reconcile_swarm_dispatch(),
        host.reconcile_swarm_dispatch(),
        board(
            &host,
            "racing-manual",
            "owner",
            json!({"action":"claim","swarmId":team,"expectedRevision":revision,"taskId":first,"workerSessionId":worker})
        )
    );
    a.unwrap();
    b.unwrap();
    let _manual_result = manual; // Either winner is valid; the durable count below is authoritative.
    let snapshot = host.state.read().await.swarms[&team].clone();
    let assigned = snapshot
        .tasks
        .values()
        .filter(|task| matches!(task.state, SwarmTaskState::Assigned { .. }))
        .collect::<Vec<_>>();
    assert_eq!(assigned.len(), 1);
    let task = assigned[0].id.clone();
    let delivery = message(&host, &team, &task).await.unwrap();
    board_wait_delivery(&host, &worker, &delivery).await;
    host.reconcile_swarm_dispatch().await.unwrap();
    assert_eq!(
        host.state.read().await.swarms[&team]
            .tasks
            .values()
            .filter(|task| matches!(task.state, SwarmTaskState::Assigned { .. }))
            .count(),
        1,
        "turn end alone is not task acceptance"
    );
    let pending = if task == first { other } else { first };
    assert!(message(&host, &team, &pending).await.is_none());
    review(&host, &team, &task, "completed").await;
    host.reconcile_swarm_dispatch().await.unwrap();
    assert!(message(&host, &team, &pending).await.is_some());
    assert_eq!(store.load(&worker).await.unwrap().unwrap().events().iter().filter(|event|matches!(event.data(),EventData::UserMessage {message,..} if message.id.as_deref()==Some(delivery.as_str()))).count(),1);
    stop_host(host, runtime).await;
}

#[tokio::test]
async fn swarm_auto_dispatch_parks_paused_stopped_and_unknown_workers_and_owner() {
    let (_disk, host, runtime, _store, team, worker) = fixture().await;
    let task = routed(&host, &team, "park", vec![worker.clone()], vec![]).await;
    enabled(&host, &team, true, "enable").await;
    for id in ["owner", worker.as_str()] {
        host.set_dispatch_paused(id, true).await.unwrap();
        host.reconcile_swarm_dispatch().await.unwrap();
        assert!(message(&host, &team, &task).await.is_none());
        host.set_dispatch_paused(id, false).await.unwrap();
    }
    let revision = board_list(&host, &team).await["revision"].as_u64().unwrap();
    success(manage(&host,"pause","owner",json!({"action":"set_status","swarmId":team,"expectedRevision":revision,"status":"paused"})).await);
    host.reconcile_swarm_dispatch().await.unwrap();
    assert!(message(&host, &team, &task).await.is_none());
    // Disabling is allowed while paused and does not discard the board.
    enabled(&host, &team, false, "disable-paused").await;
    let revision = board_list(&host, &team).await["revision"].as_u64().unwrap();
    assert!(manage(
        &host,
        "enable-paused",
        "owner",
        json!({"action":"set_dispatch","swarmId":team,"expectedRevision":revision,"enabled":true})
    )
    .await
    .is_failure());
    success(manage(&host,"resume","owner",json!({"action":"set_status","swarmId":team,"expectedRevision":revision,"status":"active"})).await);
    enabled(&host, &team, true, "reenable").await;
    // An interrupted open turn is not idle even if the Host running flag is false.
    let next_turn = host
        .agent_runtime
        .authoritative_session(&worker)
        .await
        .unwrap()
        .unwrap()
        .events()
        .iter()
        .filter_map(|event| match event.data() {
            EventData::TurnStart { turn } => Some(*turn),
            _ => None,
        })
        .max()
        .unwrap_or(0)
        + 1;
    host.commit_session_events(
        &worker,
        vec![EventData::TurnStart { turn: next_turn }.into()],
    )
    .await
    .unwrap();
    host.reconcile_swarm_dispatch().await.unwrap();
    assert!(message(&host, &team, &task).await.is_none());
    stop_host(host, runtime).await;
}

#[tokio::test]
async fn swarm_auto_dispatch_disable_does_not_cancel_claim_and_owner_stop_parks_delivery() {
    let (_disk, host, runtime, store, team, worker) = fixture().await;
    let task = routed(&host, &team, "claimed", vec![worker.clone()], vec![]).await;
    enabled(&host, &team, true, "enable").await;
    host.reconcile_swarm_dispatch().await.unwrap();
    let delivery = message(&host, &team, &task).await.unwrap();
    enabled(&host, &team, false, "disable").await;
    host.set_dispatch_paused("owner", true).await.unwrap();
    host.reconcile_swarm_task_deliveries().await.unwrap();
    assert!(!store.load(&worker).await.unwrap().unwrap().events().iter().any(|event|matches!(event.data(),EventData::UserMessage {message,..} if message.id.as_deref()==Some(delivery.as_str()))));
    host.set_dispatch_paused("owner", false).await.unwrap();
    board_wait_delivery(&host, &worker, &delivery).await;
    assert!(
        message(&host, &team, &task).await.is_some(),
        "disabling affects new claims only"
    );
    stop_host(host, runtime).await;
}

#[tokio::test]
async fn swarm_auto_dispatch_cold_recovery_keeps_opt_in_and_exact_claim_without_duplicate_execution(
) {
    let (disk, host, runtime, store, team, worker) = fixture().await;
    let task = routed(&host, &team, "crash-cut", vec![worker.clone()], vec![]).await;
    let dependent = routed(
        &host,
        &team,
        "dependent",
        vec![worker.clone()],
        vec![task.clone()],
    )
    .await;
    enabled(&host, &team, true, "enable").await;
    host.reconcile_swarm_dispatch().await.unwrap();
    let delivery = message(&host, &team, &task).await.unwrap();
    stop_host(host, runtime).await;
    drop(store);
    let (cold, runtime, store) = setup(&disk, Arc::new(Provider::default()));
    cold.stop_background_listeners();
    cold.restore_from_store_with_policy(store.clone(), RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    assert!(cold.state.read().await.swarms[&team].auto_dispatch);
    for _ in 0..3 {
        cold.reconcile_swarm_dispatch().await.unwrap();
    }
    assert_eq!(
        message(&cold, &team, &task).await.as_deref(),
        Some(delivery.as_str())
    );
    board_wait_delivery(&cold, &worker, &delivery).await;
    cold.reconcile_swarm_dispatch().await.unwrap();
    assert!(message(&cold, &team, &dependent).await.is_none());
    review(&cold, &team, &task, "completed").await;
    cold.reconcile_swarm_dispatch().await.unwrap();
    let second = message(&cold, &team, &dependent).await.unwrap();
    board_wait_delivery(&cold, &worker, &second).await;
    for _ in 0..3 {
        cold.reconcile_swarm_dispatch().await.unwrap();
        cold.reconcile_swarm_task_deliveries().await.unwrap();
    }
    let history = store.load(&worker).await.unwrap().unwrap();
    for id in [delivery, second] {
        assert_eq!(history.events().iter().filter(|event|matches!(event.data(),EventData::UserMessage {message,..} if message.id.as_deref()==Some(id.as_str()))).count(),1);
    }
    stop_host(cold, runtime).await;
}

#[tokio::test]
async fn swarm_auto_dispatch_real_listener_progresses_dependencies_only_after_acceptance() {
    let disk = Disk::new();
    let (host, runtime, store) = setup(&disk, Arc::new(Provider::default()));
    host.restore_from_store_with_policy(store, RecoveryPolicy::PauseIncompleteTools)
        .await
        .unwrap();
    let (team, worker) = board_team(&host).await;
    let task = routed(&host, &team, "first", vec![worker.clone()], vec![]).await;
    let next = routed(
        &host,
        &team,
        "next",
        vec![worker.clone()],
        vec![task.clone()],
    )
    .await;
    let blocked = routed(
        &host,
        &team,
        "blocked-by-rejection",
        vec![worker.clone()],
        vec![next.clone()],
    )
    .await;
    enabled(&host, &team, true, "enable").await;
    async fn settled_attempt(host: &BasicHost, team: &str, task: &str) {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let snapshot = host.state.read().await.swarms[team].clone();
                if crate::swarm_tasks::evidence::attempt(host, &snapshot.tasks[task])
                    .await
                    .unwrap()
                    .is_some()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("listener did not deliver and settle task");
    }
    settled_attempt(&host, &team, &task).await;
    assert!(message(&host, &team, &next).await.is_none());
    review(&host, &team, &task, "completed").await;
    settled_attempt(&host, &team, &next).await;
    review(&host, &team, &next, "failed").await;
    host.reconcile_swarm_dispatch().await.unwrap();
    assert!(message(&host, &team, &blocked).await.is_none());
    assert_eq!(host.state.read().await.swarms[&team].tasks.len(), 3);
    settle(&host, "owner").await;
    stop_host(host, runtime).await;
}

#[tokio::test]
async fn swarm_auto_dispatch_waits_for_native_lineage_fence_before_taking_parent_lane() {
    let (_disk, host, runtime, _store, team, worker) = fixture().await;
    let task = routed(&host, &team, "lineage-race", vec![worker.clone()], vec![]).await;
    enabled(&host, &team, true, "enable").await;
    // Deletion/revert use this fence before acquiring parent and child lanes.
    let lineage = host.lock_admission("agent-creation").await;
    let child = host.lock_admission(&worker).await;
    let dispatch_host = host.clone();
    let dispatch = tokio::spawn(async move { dispatch_host.reconcile_swarm_dispatch().await });
    tokio::task::yield_now().await;
    let parent = tokio::time::timeout(Duration::from_secs(2), host.lock_admission("owner"))
        .await
        .expect("scheduler must not hold parent while waiting for lineage fence");
    drop(parent);
    drop(child);
    drop(lineage);
    tokio::time::timeout(Duration::from_secs(5), dispatch)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(message(&host, &team, &task).await.is_some());
    stop_host(host, runtime).await;
}

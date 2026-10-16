use super::*;

#[tokio::test]
async fn parent_revert_is_managed_idempotent_and_preserves_original_history() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let host = setup(store.clone(), Arc::new(Probe::default())).await;
    parent(&host, "main").await;
    parent(&host, "other").await;
    let original = host
        .execute_agent("main", "start", start("original task context"))
        .await
        .unwrap();
    let source = original["agent_id"].as_str().unwrap();
    settled(&host, source).await;
    let frozen = store.load(source).await.unwrap().unwrap();
    let point = frozen
        .events()
        .iter()
        .find(|e| matches!(e.data(), EventData::StepEnd { .. }))
        .unwrap()
        .seq;
    let operation = AgentOperation::Revert {
        agent_id: source.into(),
        checkpoint_seq: point,
        message: "correct the direction; do not redo completed effects".into(),
    };
    assert!(host
        .execute_agent("other", "forbidden", operation.clone())
        .await
        .is_err());
    assert!(host
        .execute_agent(source, "forbidden", operation.clone())
        .await
        .is_err());
    let result = host
        .execute_agent("main", "revert", operation.clone())
        .await
        .unwrap();
    let branch = result["agent_id"].as_str().unwrap();
    assert_ne!(branch, source);
    assert_eq!(result["filesystem_rollback"], false);
    settled(&host, branch).await;
    let first = store.load(branch).await.unwrap().unwrap();
    assert_eq!(restored_delegation(&first).as_deref(), Some("main"));
    assert!(host.state.read().await.sessions[branch].delegated);
    assert_eq!(
        store.load(source).await.unwrap().unwrap().events(),
        frozen.events()
    );
    assert!(
        first.derive_messages()[..frozen.derive_messages().len() - 1]
            .iter()
            .any(|m| m.content.contains("original task context"))
    );
    let replay = host
        .execute_agent("main", "revert", operation)
        .await
        .unwrap();
    assert_eq!(result, replay);
    settled(&host, branch).await;
    assert_eq!(
        store.load(branch).await.unwrap().unwrap().events(),
        first.events()
    );
    assert!(host
        .execute_agent(
            "main",
            "revert",
            AgentOperation::Revert {
                agent_id: source.into(),
                checkpoint_seq: point,
                message: "changed".into()
            }
        )
        .await
        .is_err());
    // Historical interrupted/completed turns are context, never fresh outbox work.
    host.deliver_child_settlements(branch).await.unwrap();
    let after = store.load(branch).await.unwrap().unwrap();
    let owned = owned_events(&after);
    let deliveries: Vec<_> = owned
        .iter()
        .filter_map(|e| match e.data() {
            EventData::AgentSettlementDelivered { turn } => Some(*turn),
            _ => None,
        })
        .collect();
    assert_eq!(deliveries.len(), 1);
    assert!(!deliveries.contains(&1));
    host.execute_agent(
        "main",
        "followup",
        AgentOperation::Send {
            agent_id: branch.into(),
            message: "followup".into(),
        },
    )
    .await
    .unwrap();
    settled(&host, branch).await;
    host.execute_agent(
        "main",
        "stop",
        AgentOperation::Stop {
            agent_id: branch.into(),
        },
    )
    .await
    .unwrap();
    assert!(host.state.read().await.sessions[branch].dispatch_paused);
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
    // Cold restoration still preserves the direct-child ownership and pause.
    let cold = setup(store.clone(), Arc::new(Probe::default())).await;
    cold.prepare_startup_catalog(store).await.unwrap();
    cold.hydrate_session(branch).await.unwrap();
    assert!(cold.state.read().await.sessions[branch].delegated);
    assert!(cold.state.read().await.sessions[branch].dispatch_paused);
    cold.agent_runtime.shutdown(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn rejects_running_paused_invalid_checkpoint_and_policy_changes() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let gate = CancellationToken::new();
    let probe = Arc::new(Probe {
        gate: Some(gate.clone()),
        ..Default::default()
    });
    let host = setup(store.clone(), probe.clone()).await;
    parent(&host, "main").await;
    let original = host
        .execute_agent("main", "start", start("task"))
        .await
        .unwrap();
    let source = original["agent_id"].as_str().unwrap();
    wait_for_calls(&probe, 1).await;
    let op = |seq| AgentOperation::Revert {
        agent_id: source.into(),
        checkpoint_seq: seq,
        message: "correct".into(),
    };
    assert!(host
        .execute_agent("main", "running", op(0))
        .await
        .unwrap_err()
        .contains("idle"));
    gate.cancel();
    settled(&host, source).await;
    let session = store.load(source).await.unwrap().unwrap();
    assert!(host
        .execute_agent("main", "invalid", op(u64::MAX))
        .await
        .is_err());
    for event in session.events().iter().filter(|e| {
        !matches!(
            e.data(),
            EventData::StepEnd { .. } | EventData::TurnEnd { .. }
        )
    }) {
        assert!(revert::checkpoint(&session, event.seq).is_err());
    }
    let point = session
        .events()
        .iter()
        .find(|e| matches!(e.data(), EventData::StepEnd { .. }))
        .unwrap()
        .seq;
    host.set_dispatch_paused(source, true).await.unwrap();
    assert!(host
        .execute_agent("main", "paused", op(point))
        .await
        .is_err());
    host.set_dispatch_paused(source, false).await.unwrap();
    host.commit_session_events(source, vec![EventData::PlanMode { active: true }.into()])
        .await
        .unwrap();
    assert!(host
        .execute_agent("main", "changed-policy", op(point))
        .await
        .unwrap_err()
        .contains("settings differ"));
    assert!(!host
        .state
        .read()
        .await
        .sessions
        .contains_key(&identity("main", "changed-policy")));
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn committed_branch_before_initial_inbox_delivery_recovers_only_correction() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let host = setup(store.clone(), Arc::new(Probe::default())).await;
    parent(&host, "main").await;
    let original = host
        .execute_agent(
            "main",
            "source",
            start("ORIGINAL_TASK_MUST_NOT_BE_REDELIVERED"),
        )
        .await
        .unwrap();
    let source = original["agent_id"].as_str().unwrap();
    settled(&host, source).await;
    let original = store.load(source).await.unwrap().unwrap();
    let point = original
        .events()
        .iter()
        .find(|e| matches!(e.data(), EventData::StepEnd { .. }))
        .unwrap()
        .seq;
    let reverted = host
        .execute_agent(
            "main",
            "branch",
            AgentOperation::Revert {
                agent_id: source.into(),
                checkpoint_seq: point,
                message: "CORRECTION_REDELIVERY_ONLY".into(),
            },
        )
        .await
        .unwrap();
    let branch = reverted["agent_id"].as_str().unwrap();
    settled(&host, branch).await;
    let full = store.load(branch).await.unwrap().unwrap();
    let ownership = full
        .events()
        .iter()
        .rposition(|e| matches!(e.data(), EventData::AgentDelegated { .. }))
        .unwrap();
    let crash_store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    for (id, session, end) in [
        ("main", store.load("main").await.unwrap().unwrap(), None),
        (branch, full, Some(ownership + 1)),
    ] {
        let fresh = crash_store.create(session.header().clone()).await.unwrap();
        crash_store
            .append(
                id,
                fresh.revision(),
                session.events()[..end.unwrap_or(session.events().len())]
                    .iter()
                    .map(|e| e.event.clone())
                    .collect(),
            )
            .await
            .unwrap();
    }
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
    let probe = Arc::new(Probe::default());
    let cold = setup(crash_store.clone(), probe.clone()).await;
    cold.prepare_startup_catalog(crash_store.clone())
        .await
        .unwrap();
    cold.hydrate_session("main").await.unwrap();
    cold.hydrate_session(branch).await.unwrap();
    cold.deliver_child_settlements(branch).await.unwrap();
    settled(&cold, branch).await;
    cold.deliver_child_settlements(branch).await.unwrap();
    settled(&cold, branch).await;
    let journal = crash_store.load(branch).await.unwrap().unwrap();
    let inserted: Vec<_> = owned_events(&journal)
        .iter()
        .filter_map(|e| match e.data() {
            EventData::AgentInboxSpliced { inserted, .. } => Some(inserted),
            _ => None,
        })
        .flatten()
        .collect();
    assert_eq!(inserted.len(), 1);
    assert!(inserted[0]
        .message
        .content
        .contains("CORRECTION_REDELIVERY_ONLY"));
    assert!(!inserted[0]
        .message
        .content
        .contains("ORIGINAL_TASK_MUST_NOT_BE_REDELIVERED"));
    assert_eq!(probe.calls.load(Ordering::SeqCst), 1);
    let deliveries: Vec<_> = owned_events(&journal)
        .iter()
        .filter_map(|e| match e.data() {
            EventData::AgentSettlementDelivered { turn } => Some(*turn),
            _ => None,
        })
        .collect();
    assert_eq!(deliveries.len(), 1);
    assert!(!deliveries.contains(&1));
    cold.agent_runtime.shutdown(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn queued_input_and_abandoned_turn_cannot_be_hidden_by_revert() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let host = setup(store.clone(), Arc::new(Probe::default())).await;
    parent(&host, "main").await;
    let started = host
        .execute_agent("main", "source", start("task"))
        .await
        .unwrap();
    let source = started["agent_id"].as_str().unwrap();
    settled(&host, source).await;
    let original = store.load(source).await.unwrap().unwrap();
    let point = original
        .events()
        .iter()
        .find(|e| matches!(e.data(), EventData::StepEnd { .. }))
        .unwrap()
        .seq;
    // A durable pending item can precede the Host attachment queue after a crash.
    host.commit_session_events(
        source,
        vec![EventData::AgentInboxSpliced {
            target: xharness_session::InboxTarget::NextTurn,
            start: 0,
            removed_count: 0,
            inserted: vec![xharness_session::InboxMessage::user(
                "pending",
                "must not disappear",
            )],
            outcome: None,
        }
        .into()],
    )
    .await
    .unwrap();
    assert!(host
        .execute_agent(
            "main",
            "queued",
            AgentOperation::Revert {
                agent_id: source.into(),
                checkpoint_seq: point,
                message: "correct".into()
            }
        )
        .await
        .is_err());
    host.commit_session_events(
        source,
        vec![
            EventData::AgentInboxSpliced {
                target: xharness_session::InboxTarget::NextTurn,
                start: 0,
                removed_count: 1,
                inserted: vec![],
                outcome: Some(xharness_session::InboxSpliceOutcome::Cancelled),
            }
            .into(),
            EventData::TurnStart { turn: 2 }.into(),
        ],
    )
    .await
    .unwrap();
    assert!(host
        .execute_agent(
            "main",
            "abandoned",
            AgentOperation::Revert {
                agent_id: source.into(),
                checkpoint_seq: point,
                message: "correct".into()
            }
        )
        .await
        .unwrap_err()
        .contains("unsettled"));
    host.agent_runtime.shutdown(Duration::from_secs(2)).await;
}

#[tokio::test]
async fn reverted_child_restores_the_working_plan_at_its_checkpoint() {
    let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
    let host = setup(store.clone(), Arc::new(Probe::default())).await;
    parent(&host, "main").await;
    let original = host
        .execute_agent("main", "start", start("original task"))
        .await
        .unwrap();
    let source = original["agent_id"].as_str().unwrap();
    settled(&host, source).await;
    let plan = xharness_session::SessionPlan {
        revision: 1,
        items: vec![xharness_session::PlanItem {
            id: "verify".into(),
            title: "Verify checkpoint context".into(),
            status: xharness_session::PlanItemStatus::InProgress,
        }],
    };
    let current = store.load(source).await.unwrap().unwrap();
    store
        .append(
            source,
            current.revision(),
            vec![EventData::SessionPlanUpdated { plan: plan.clone() }.into()],
        )
        .await
        .unwrap();
    host.execute_agent(
        "main",
        "followup-with-plan",
        AgentOperation::Send {
            agent_id: source.into(),
            message: "continue with the working plan".into(),
        },
    )
    .await
    .unwrap();
    settled(&host, source).await;
    let frozen = store.load(source).await.unwrap().unwrap();
    let point = frozen
        .events()
        .iter()
        .rev()
        .find(|e| matches!(e.data(), EventData::StepEnd { .. }))
        .unwrap()
        .seq;
    let result = host
        .execute_agent(
            "main",
            "revert-with-plan",
            AgentOperation::Revert {
                agent_id: source.into(),
                checkpoint_seq: point,
                message: "correct direction".into(),
            },
        )
        .await
        .unwrap();
    let branch = result["agent_id"].as_str().unwrap();
    settled(&host, branch).await;
    assert_eq!(
        host.state.read().await.sessions[branch].task_plan,
        Some(plan.clone())
    );
    assert_eq!(
        xharness_session::session_plan(&store.load(branch).await.unwrap().unwrap()),
        Some(plan)
    );
    assert_eq!(
        store.load(source).await.unwrap().unwrap().events(),
        frozen.events()
    );
}

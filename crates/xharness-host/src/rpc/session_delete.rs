//! Permanent deletion of an archived conversation and its owned subagents.
//! The entire closure is validated before a single durable control batch;
//! independent forks are never implicitly deleted.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};
use xharness_api::{RpcError, RpcErrorCode, RpcId, RpcMethod};
use xharness_control::ControlEvent;

use crate::{driver::agent_runtime_error, state::HostState, BasicHost};

use super::{bad_request, required_string, rpc_error, session_not_found};

type Lineage = BTreeMap<String, (Option<String>, Option<String>)>;

fn memory_lineage(state: &HostState) -> Lineage {
    state
        .sessions
        .values()
        .map(|record| {
            (
                record.session_id.clone(),
                (record.parent_session_id.clone(), record.origin.clone()),
            )
        })
        .collect()
}

fn deletion_ids(lineage: &Lineage, root: &str) -> Result<BTreeSet<String>, RpcError> {
    let mut ids = BTreeSet::from([root.to_owned()]);
    let mut pending = vec![root.to_owned()];
    while let Some(parent) = pending.pop() {
        for (child, (_, origin)) in lineage
            .iter()
            .filter(|(_, (candidate, _))| candidate.as_deref() == Some(parent.as_str()))
        {
            if origin.as_deref() != Some("subagent") {
                return Err(rpc_error(
                    RpcErrorCode::SessionConflict,
                    "delete independent fork sessions before deleting their parent",
                    json!({"sessionId": root, "childSessionId": child}),
                ));
            }
            if ids.insert(child.clone()) {
                pending.push(child.clone());
            } else {
                return Err(RpcError::internal("cycle in owned subagent lineage"));
            }
        }
    }
    Ok(ids)
}

// A metadata-only record with no parent is not proof of being independent.
// Discover durable ids as well: startup streaming may not have published them
// yet. Fingerprint-checked indexes avoid replaying healthy unrelated histories;
// only missing/stale indexes need one read-only journal load, never activation.
async fn durable_lineage(host: &BasicHost) -> Result<Lineage, RpcError> {
    let (mut lineage, warm, deleted) = {
        let state = host.state.read().await;
        (
            memory_lineage(&state),
            state
                .sessions
                .values()
                .filter(|record| !record.restoring)
                .map(|record| record.session_id.clone())
                .collect::<BTreeSet<_>>(),
            state.deleted_sessions.clone(),
        )
    };
    let Some(store) = host.lazy_store.get() else {
        return Ok(lineage);
    };
    let (headers, unreadable) = store
        .scan_startup_candidates()
        .await
        .map_err(|error| RpcError::internal(format!("cannot verify session lineage: {error}")))?;
    if let Some(entry) = unreadable
        .iter()
        .find(|entry| !deleted.contains(&entry.session_id))
    {
        return Err(RpcError::internal(format!(
            "cannot verify session lineage for unreadable session {:?}",
            entry.session_id
        )));
    }
    for header in headers {
        if warm.contains(&header.id) || deleted.contains(&header.id) {
            continue;
        }
        let identity = if let Some(index) = store
            .catalog_entry(&header.id)
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?
        {
            (index.parent_session_id, index.origin)
        } else {
            let session = store
                .load(&header.id)
                .await
                .map_err(|error| RpcError::internal(error.to_string()))?
                .ok_or_else(|| session_not_found(&header.id))?;
            let delegation = crate::delegation::restored_delegation(&session);
            let fork = session
                .events()
                .iter()
                .rev()
                .find_map(|event| match event.data() {
                    xharness_session::EventData::SessionForkOrigin {
                        parent_session_id, ..
                    } => Some(parent_session_id.clone()),
                    _ => None,
                });
            let origin = if delegation.is_some() {
                Some("subagent".to_owned())
            } else if fork.is_some() {
                Some("fork".to_owned())
            } else {
                None
            };
            (delegation.or(fork), origin)
        };
        lineage.insert(header.id.clone(), identity);
        host.lazy_headers
            .write()
            .await
            .insert(header.id.clone(), header);
    }
    Ok(lineage)
}

async fn reject_pending_cold_work(host: &BasicHost, id: &str, root: &str) -> Result<(), RpcError> {
    if host
        .state
        .read()
        .await
        .sessions
        .get(id)
        .is_some_and(|record| !record.restoring)
    {
        return Ok(());
    }
    let Some(store) = host.lazy_store.get() else {
        return Ok(());
    };
    let session = store
        .load(id)
        .await
        .map_err(|error| RpcError::internal(error.to_string()))?
        .ok_or_else(|| session_not_found(id))?;
    let inbox = xharness_agent::InboxProjection::from_session(&session)
        .map_err(|error| RpcError::internal(error.to_string()))?;
    let schedules = xharness_schedule::active_schedules(&session).map_err(RpcError::internal)?;
    let background = host
        .agent_runtime
        .needs_session_resume(&session)
        .map_err(agent_runtime_error)?;
    if inbox.has_pending()
        || background
        || !session.pending_tool_approvals().is_empty()
        || !session.recoverable_user_questions().is_empty()
        || !xharness_session::incomplete_tool_calls(session.events()).is_empty()
        || crate::restore::restored_goal(&session)
            .is_some_and(|goal| goal.phase == xharness_session::GoalPhase::Active)
        || !schedules.is_empty()
    {
        return Err(rpc_error(
            RpcErrorCode::SessionConflict,
            "session still has running or scheduled work",
            json!({"sessionId":id,"rootSessionId":root,"phase":"cold-validation"}),
        ));
    }
    Ok(())
}

pub(super) async fn delete(
    host: &BasicHost,
    rpc_id: RpcId,
    payload: &Value,
) -> Result<Value, RpcError> {
    let root = required_string(payload, "sessionId")?;
    // Delegation creation uses this fence before creating its child record.
    // Keep the closure stable, without acquiring control_gate before admission.
    let _creation = host.lock_admission("agent-creation").await;
    let already_deleted = host.state.read().await.deleted_sessions.contains(&root);
    let ids = if already_deleted {
        BTreeSet::from([root.clone()])
    } else {
        let lineage = durable_lineage(host).await?;
        if !lineage.contains_key(&root) {
            return Err(session_not_found(&root));
        }
        deletion_ids(&lineage, &root)?
    };
    // Check cold durable work before hydration can reattach/activate it.
    // Unknown lineage or recovery failure rejects before any tombstone.
    for id in &ids {
        if !already_deleted {
            reject_pending_cold_work(host, id, &root).await?;
        }
        host.hydrate_session(id)
            .await
            .map_err(|error| RpcError::internal(format!("session recovery failed: {error}")))?;
    }
    let mut admissions = Vec::new();
    for id in &ids {
        // Explicitly named sessions may share the creation fence's key.
        // The guard above already owns that admission lane; never lock it twice.
        if id != "agent-creation" {
            admissions.push(host.lock_admission(id).await);
        }
    }
    let _control = host.control_gate.lock().await;
    let replayed = host
        .replay_control_receipt(&rpc_id, RpcMethod::SessionDelete, payload)
        .await?;
    let (already_deleted, response) = {
        let state = host.state.read().await;
        if state.deleted_sessions.contains(&root) {
            // A retry with a new RPC id must also finish any prior descendant
            // cleanup. Receipt-bound ids survive even after records disappear.
            let response = replayed
                .clone()
                .or_else(|| {
                    state.mutation_receipts.values().find_map(|receipt| {
                        (receipt.method == RpcMethod::SessionDelete.as_str()
                            && receipt.response["deletedSessionIds"]
                                .as_array()
                                .is_some_and(|ids| {
                                    ids.iter().any(|id| id.as_str() == Some(root.as_str()))
                                }))
                        .then(|| receipt.response.clone())
                    })
                })
                .unwrap_or_else(|| json!({"deleted": true, "deletedSessionIds": [root]}));
            (true, response)
        } else {
            if replayed.is_some() {
                return Err(RpcError::internal(
                    "session deletion receipt exists without a deletion tombstone",
                ));
            }
            if deletion_ids(&memory_lineage(&state), &root)? != ids {
                return Err(rpc_error(
                    RpcErrorCode::SessionConflict,
                    "session descendants changed during deletion; retry",
                    json!({"sessionId":root}),
                ));
            }
            if !state.archived_sessions.contains(&root) {
                return Err(bad_request("archive the session before permanent deletion"));
            }
            for id in &ids {
                let record = state
                    .sessions
                    .get(id)
                    .ok_or_else(|| session_not_found(id))?;
                // admissions is an idempotency receipt history, not in-flight
                // work. Admission guards fence concurrent requests; only the
                // actual queues/runtime state decide whether deletion is safe.
                if record.running
                    || record.restoring
                    || !record.queue.is_empty()
                    || !record.projected_queue.is_empty()
                    || record
                        .goal
                        .as_ref()
                        .is_some_and(|goal| goal.phase == xharness_session::GoalPhase::Active)
                    || !record.schedules.is_empty()
                {
                    return Err(rpc_error(
                        RpcErrorCode::SessionConflict,
                        "session still has running or scheduled work",
                        json!({"sessionId":id,"rootSessionId":root}),
                    ));
                }
            }
            (false, json!({"deleted":true,"deletedSessionIds":ids}))
        }
    };
    let deleted_ids: Vec<String> = response
        .get("deletedSessionIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_else(|| vec![root.clone()]);
    if !already_deleted {
        host.commit_control_mutation(
            &rpc_id,
            RpcMethod::SessionDelete,
            payload,
            deleted_ids
                .iter()
                .map(|id| ControlEvent::SessionDeleted {
                    session_id: id.clone(),
                })
                .collect(),
            response.clone(),
        )
        .await?;
    }
    // Publish even on receipt replay: a missed delivery can be repaired without
    // writing another tombstone. Temporary Activation detach frames omit true.
    for id in &deleted_ids {
        host.push_host(json!({"type":"host/session-removed","sessionId":id,"permanent":true}));
    }
    host.push_host(json!({"type":"host/archived-sessions-changed",
        "archivedSessionIds":host.state.read().await.archived_sessions}));
    drop(_control);
    // Tombstones precede filesystem cleanup. Retry/restart can finish interrupted
    // cleanup, and cannot resurrect any partially removed descendant.
    for id in &deleted_ids {
        host.agent_runtime
            .delete_session_data(id)
            .await
            .map_err(agent_runtime_error)?;
        if let Some(store) = host.lazy_store.get() {
            store
                .delete_session_data(id)
                .await
                .map_err(|error| RpcError::internal(error.to_string()))?;
        }
        host.config
            .attachment_store
            .delete_session_data(id)
            .await
            .map_err(|error| RpcError::internal(error.to_string()))?;
        host.lazy_headers.write().await.remove(id);
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{rpc::session_lifecycle, HostConfig};
    use std::sync::Arc;

    async fn fixture() -> Arc<BasicHost> {
        BasicHost::without_provider(HostConfig::new(std::env::current_dir().unwrap()))
    }
    async fn create(host: &BasicHost, id: &str) {
        session_lifecycle::create(host, &json!({"sessionId":id}))
            .await
            .unwrap();
    }
    async fn child(host: &BasicHost, parent: &str, owned: bool) -> String {
        let result = session_lifecycle::fork(host, &json!({"sessionId":parent}))
            .await
            .unwrap();
        let id = result["sessionId"].as_str().unwrap().to_owned();
        if owned {
            let mut state = host.state.write().await;
            let record = state.sessions.get_mut(&id).unwrap();
            record.origin = Some("subagent".into());
            record.delegated = true;
        }
        id
    }
    fn queued() -> crate::state::QueuedPrompt {
        crate::state::QueuedPrompt {
            id: "pending".into(),
            text: "work".into(),
            content: vec![],
            source: json!({"kind":"user"}),
            fingerprint: None,
            placement: crate::state::QueuePlacement::Queued,
        }
    }
    async fn archive(host: &BasicHost, id: &str) {
        host.state.write().await.archived_sessions.insert(id.into());
    }

    #[tokio::test]
    async fn delete_owned_tree_in_one_receipt_and_replay_after_records_disappear() {
        let host = fixture().await;
        create(&host, "parent").await;
        let first = child(&host, "parent", true).await;
        let nested = child(&host, &first, true).await;
        archive(&host, "parent").await;
        let mut frames = host.event_gateway.subscribe_host();
        let payload = json!({"sessionId":"parent"});
        let result = delete(&host, RpcId::new("delete-tree"), &payload)
            .await
            .unwrap();
        let ids: BTreeSet<_> = result["deletedSessionIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| id.as_str().unwrap().to_owned())
            .collect();
        assert_eq!(ids, BTreeSet::from(["parent".into(), first, nested]));
        let revision = {
            let state = host.state.read().await;
            assert!(state.sessions.is_empty());
            assert!(state.archived_sessions.is_empty());
            assert_eq!(state.deleted_sessions, ids);
            state.control_revision
        };
        let mut removed = BTreeSet::new();
        while let Ok(frame) = frames.try_recv() {
            if frame.method == "host/session-removed" {
                assert_eq!(frame.payload["permanent"], true);
                removed.insert(frame.payload["sessionId"].as_str().unwrap().to_owned());
            }
        }
        assert_eq!(removed, ids);
        assert_eq!(
            delete(&host, RpcId::new("delete-tree"), &payload)
                .await
                .unwrap(),
            result
        );
        assert_eq!(
            delete(&host, RpcId::new("new-retry"), &payload)
                .await
                .unwrap(),
            result
        );
        assert_eq!(host.state.read().await.control_revision, revision);
    }

    #[tokio::test]
    async fn owned_tree_with_active_or_queued_child_is_rejected_atomically() {
        for busy in [
            "running",
            "queue",
            "projected-queue",
            "restoring",
            "schedule",
            "goal",
        ] {
            let host = fixture().await;
            create(&host, "parent").await;
            let child = child(&host, "parent", true).await;
            archive(&host, "parent").await;
            {
                let mut state = host.state.write().await;
                let record = state.sessions.get_mut(&child).unwrap();
                match busy {
                    "running" => record.running = true,
                    "queue" => record.queue.push_back(queued()),
                    "projected-queue" => record.projected_queue.push(queued()),
                    "restoring" => record.restoring = true,
                    "schedule" => record.schedules.push(xharness_session::ScheduleRecord {
                        automation: None,
                        id: "reminder".into(),
                        kind: xharness_session::ScheduleKind::Every,
                        prompt: "inspect".into(),
                        after_seconds: None,
                        every_seconds: Some(300),
                        scheduled_at: "2099-01-01T00:00:00.000Z".into(),
                    }),
                    _ => {
                        record.goal = Some(crate::state::GoalState {
                            execution: None,
                            id: "goal".into(),
                            revision: 1,
                            objective: "work".into(),
                            phase: xharness_session::GoalPhase::Active,
                            blocked_reason: None,
                            max_goal_rounds: 100,
                            rounds_started: 0,
                            created_at: 1,
                            updated_at: 1,
                        })
                    }
                }
            }
            let revision = host.state.read().await.control_revision;
            assert!(delete(
                &host,
                RpcId::new(format!("reject-{busy}")),
                &json!({"sessionId":"parent"})
            )
            .await
            .is_err());
            let state = host.state.read().await;
            assert_eq!(state.sessions.len(), 2);
            assert!(state.deleted_sessions.is_empty());
            assert_eq!(state.control_revision, revision);
        }
    }

    #[tokio::test]
    async fn historical_admission_receipts_do_not_block_idle_deletion() {
        let host = fixture().await;
        create(&host, "parent").await;
        let child = child(&host, "parent", true).await;
        archive(&host, "parent").await;
        for id in ["parent", child.as_str()] {
            host.state
                .write()
                .await
                .sessions
                .get_mut(id)
                .unwrap()
                .admissions
                .insert("already-finished".into(), queued());
        }
        let response = delete(
            &host,
            RpcId::new("delete-finished"),
            &json!({"sessionId":"parent"}),
        )
        .await
        .unwrap();
        assert_eq!(response["deletedSessionIds"].as_array().unwrap().len(), 2);
        assert!(host.state.read().await.sessions.is_empty());
    }

    #[tokio::test]
    async fn named_session_matching_creation_fence_does_not_deadlock() {
        let host = fixture().await;
        create(&host, "agent-creation").await;
        archive(&host, "agent-creation").await;
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            delete(
                &host,
                RpcId::new("named-fence"),
                &json!({"sessionId":"agent-creation"}),
            ),
        )
        .await
        .expect("recursive admission lock")
        .unwrap();
    }

    #[tokio::test]
    async fn independent_forks_and_non_archived_roots_are_preserved() {
        let host = fixture().await;
        create(&host, "parent").await;
        let owned = child(&host, "parent", true).await;
        let fork = child(&host, &owned, false).await;
        archive(&host, "parent").await;
        let error = delete(
            &host,
            RpcId::new("fork-protection"),
            &json!({"sessionId":"parent"}),
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("independent fork"));
        assert!(host.state.read().await.sessions.contains_key(&fork));
        assert!(host.state.read().await.deleted_sessions.is_empty());
        let other = fixture().await;
        create(&other, "live").await;
        assert!(delete(
            &other,
            RpcId::new("live-protection"),
            &json!({"sessionId":"live"})
        )
        .await
        .is_err());
    }
}

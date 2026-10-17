//! Task-claim outbox adapter. Reuses existing inbox admission and replay receipts.
//! Opt-in claim reconciliation shares this listener; no new model loop or tool replay.
#![forbid(unsafe_code)]
pub(crate) mod access;
mod dispatch;
pub(crate) mod evidence;
pub(crate) mod service;

use crate::{swarm_processor::SwarmProcessor, BasicHost};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use xharness_api::RpcId;
use xharness_control::{ControlEvent, SwarmStatus, SwarmTaskChange, SwarmTaskState};

impl BasicHost {
    /// Outbox I/O is independent of ordinary child-settlement notifications.
    /// Called only after the existing delegation-listener singleton is acquired.
    pub(crate) fn start_swarm_task_listener(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        let stop = self.background_listener_cancellation();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            let mut last_errors = (None, None);
            loop {
                tokio::select! {_ = stop.cancelled()=>break,_=tick.tick()=>{}}
                let Some(host) = weak.upgrade() else { break };
                let errors = (
                    host.reconcile_swarm_dispatch().await.err(),
                    host.reconcile_swarm_task_deliveries().await.err(),
                );
                for (phase, error, previous) in [
                    ("dispatch", &errors.0, &last_errors.0),
                    ("delivery", &errors.1, &last_errors.1),
                ] {
                    if error != previous {
                        if let Some(message) = error {
                            host.push_host(json!({"type":"host/swarm-delivery-error","phase":phase,"message":message}));
                        }
                    }
                }
                last_errors = errors;
            }
        });
    }
    pub(crate) async fn reconcile_swarm_task_deliveries(&self) -> Result<(), String> {
        let pending = {
            let state = self.state.read().await;
            state
                .swarms
                .values()
                .filter(|s| s.status == SwarmStatus::Active)
                .flat_map(|s| {
                    s.tasks.values().filter_map(|t| match &t.state {
                        SwarmTaskState::Assigned {
                            delivered: false, ..
                        } => Some((s.id.clone(), t.id.clone())),
                        _ => None,
                    })
                })
                .collect::<Vec<_>>()
        };
        let mut last_error = None;
        for (swarm_id, task_id) in pending {
            if let Err(error) = self.deliver_swarm_task(&swarm_id, &task_id).await {
                last_error = Some(error)
            }
        }
        match last_error {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
    async fn deliver_swarm_task(&self, swarm_id: &str, task_id: &str) -> Result<(), String> {
        // Serialize only this team's admission against pause/close. Never hold
        // the global Control gate while executing or waiting for a model.
        let _team = self
            .lock_admission(&format!("swarm-admission:{swarm_id}"))
            .await;
        let team = {
            let state = self.state.read().await;
            let Some(team) = state.swarms.get(swarm_id) else {
                return Ok(());
            };
            if team.status != SwarmStatus::Active
                || state.deleted_sessions.contains(&team.owner_session_id)
            {
                return Ok(());
            }
            team.clone()
        };
        // Match the native deletion/revert fence before taking parent + child lanes.
        let _lineage = self.lock_admission("agent-creation").await;
        let _owner_admission = if team.owner_session_id == "agent-creation" {
            None
        } else {
            Some(self.lock_admission(&team.owner_session_id).await)
        };
        if !access::owner_dispatch_allowed(self, &team.owner_session_id)
            .await
            .map_err(|e| e.message)?
        {
            return Ok(());
        }
        let Some(task) = team.tasks.get(task_id) else {
            return Ok(());
        };
        let SwarmTaskState::Assigned {
            worker_session_id,
            message_id,
            delivered: false,
        } = &task.state
        else {
            return Ok(());
        };
        {
            let state = self.state.read().await;
            if state.deleted_sessions.contains(worker_session_id) {
                return Err("Swarm task worker was deleted; claim remains parked".into());
            }
            let Some(worker) = state.sessions.get(worker_session_id) else {
                return Err("Swarm task worker is unavailable; claim remains parked".into());
            };
            if worker.dispatch_paused {
                return Ok(());
            }
        }
        let history = self
            .agent_runtime
            .authoritative_session(worker_session_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Swarm task worker journal is unavailable")?;
        if crate::delegation::restored_delegation(&history).as_deref()
            != Some(team.owner_session_id.as_str())
        {
            return Err("Swarm task worker ownership changed".into());
        }
        // Preserve the ordinary native recovery boundary. An unknown effect is
        // not a failed task and never authorizes rerunning it on another worker.
        let mut open = false;
        for event in history.events() {
            match event.data() {
                xharness_session::EventData::TurnStart { .. } => open = true,
                xharness_session::EventData::TurnEnd { .. } => open = false,
                _ => {}
            }
        }
        if open
            || history.dispatch_paused()
            || !history.pending_tool_approvals().is_empty()
            || !history.pending_user_questions().is_empty()
            || !xharness_session::incomplete_tool_calls(history.events()).is_empty()
        {
            return Ok(());
        }
        let dependencies = task
            .dependencies
            .iter()
            .filter_map(|id| team.tasks.get(id))
            .map(|task| json!({"taskId":task.id,"result":task.state}))
            .collect::<Vec<_>>();
        let text=json!({"swarmId":swarm_id,"taskId":task_id,"title":task.title,"instructions":task.instructions,"dependencies":dependencies}).to_string();
        self.deliver_agent_message(
            &team.owner_session_id,
            worker_session_id,
            message_id,
            text,
            "swarm-task",
            false,
        )
        .await?;
        // A crash here is safe: retry the same inbox identity and fingerprint,
        // including when the worker already consumed or completed that message.
        let _control = self.control_gate.lock().await;
        let state = self.state.read().await;
        let current = state.swarms.get(swarm_id).ok_or("Swarm disappeared")?;
        if !matches!(
            current.tasks.get(task_id).map(|t| &t.state),
            Some(SwarmTaskState::Assigned {
                delivered: false,
                ..
            })
        ) {
            return Ok(());
        }
        let change = SwarmProcessor::task(
            swarm_id.into(),
            current.revision,
            SwarmTaskChange::Delivered {
                task_id: task_id.into(),
                message_id: message_id.clone(),
            },
        );
        SwarmProcessor::validate(&state.swarms, &change)?;
        drop(state);
        let payload = json!({"swarmId":swarm_id,"taskId":task_id,"messageId":message_id});
        self.commit_control_mutation_named(
            &RpcId::new(format!("{message_id}:delivered")),
            "swarm.task-delivered/v1",
            &payload,
            vec![ControlEvent::SwarmChanged { change }],
            json!({"delivered":true}),
        )
        .await
        .map_err(|e| e.message)?;
        Ok(())
    }
}

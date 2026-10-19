//! Swarm-only Agent adapter. Caller identity is Host-bound; execution stays in the shared service.
#![forbid(unsafe_code)]
use super::identity;
use crate::{
    swarm_tasks::{access, evidence, service},
    BasicHost,
};
use serde_json::{json, Value};
use xharness_agent::{AgentTaskCommand, TaskReviewOutcome};
use xharness_api::RpcId;
use xharness_control::{SwarmStatus, SwarmTaskOutcome};

impl BasicHost {
    /// A durable, explicitly created team makes its root chat a coordinator.
    /// Closing a panel is presentation only; closing the team removes this scope.
    pub(crate) async fn coordinator_swarms(&self, caller: &str) -> Vec<String> {
        let ids = {
            let state = self.state.read().await;
            if state.deleted_sessions.contains(caller)
                || state.sessions.get(caller).is_none_or(|s| s.dispatch_paused)
            {
                return Vec::new();
            }
            state
                .swarms
                .values()
                .filter(|s| s.owner_session_id == caller && s.status != SwarmStatus::Closed)
                .map(|s| s.id.clone())
                .collect::<Vec<_>>()
        };
        if ids.is_empty() {
            return ids;
        }
        match access::journal(self, caller).await {
            Ok(Some(cut))
                if super::restored_delegation(&cut).is_none() && !cut.dispatch_paused() =>
            {
                ids
            }
            _ => Vec::new(),
        }
    }
    pub(super) async fn execute_agent_tasks(
        &self,
        caller: &str,
        invocation: &str,
        swarm_id: String,
        command: AgentTaskCommand,
    ) -> Result<Value, String> {
        // Always recheck: an executor may retain a schema from before team close.
        if !self.coordinator_swarms(caller).await.contains(&swarm_id) {
            return Err(
                "task commands require this chat's non-closed Swarm coordinator scope".into(),
            );
        }
        let read = matches!(command, AgentTaskCommand::List { .. });
        let command = match command {
            AgentTaskCommand::List {
                include_settled,
                after_task_id,
                limit,
            } => service::Command::List {
                swarm_id: swarm_id.clone(),
                include_settled,
                after_task_id,
                limit,
            },
            AgentTaskCommand::Add {
                expected_revision,
                title,
                instructions,
                dependencies,
                eligible_worker_session_ids,
            } => service::Command::Add {
                swarm_id: swarm_id.clone(),
                expected_revision,
                title,
                instructions,
                dependencies,
                eligible_worker_session_ids,
            },
            AgentTaskCommand::Assign {
                expected_revision,
                task_id,
                worker_session_id,
            } => service::Command::Claim {
                swarm_id: swarm_id.clone(),
                expected_revision,
                task_id,
                worker_session_id,
            },
            AgentTaskCommand::Review {
                expected_revision,
                task_id,
                execution_ref,
                outcome,
                summary,
            } => service::Command::Review {
                swarm_id: swarm_id.clone(),
                expected_revision,
                task_id,
                execution_ref,
                outcome: match outcome {
                    TaskReviewOutcome::Completed => SwarmTaskOutcome::Completed,
                    TaskReviewOutcome::Failed => SwarmTaskOutcome::Failed,
                },
                summary,
            },
        };
        let request = service::Request {
            owner_session_id: caller.into(),
            command,
        };
        let payload = serde_json::to_value(&request).map_err(|e| e.to_string())?;
        // Separate namespace from Agent child receipts and UI request IDs.
        let id = RpcId::new(format!("{}:swarm-tasks", identity(caller, invocation)));
        let mut value = service::execute(self, id, request, &payload)
            .await
            .map_err(|e| e.message)?;
        if read {
            let team = access::owned(self, &swarm_id, caller)
                .await
                .map_err(|e| e.message)?;
            if value["revision"].as_u64() != Some(team.revision) {
                return Err(
                    "task board changed during evidence read; list again before a mutation".into(),
                );
            }
            let mut workers = Vec::new();
            for member in team.members.values() {
                let label = self
                    .state
                    .read()
                    .await
                    .sessions
                    .get(&member.session_id)
                    .and_then(|record| {
                        record
                            .title
                            .as_deref()
                            .map(|title| super::bounded(title, 160).to_owned())
                    });
                workers.push(json!({
                    "worker_session_id":member.session_id,
                    "label":label,
                    "observation":access::observe(self,&member.session_id).await.map_err(|e|e.message)?,
                }));
            }
            value["workers"] = json!(workers);
            value["auto_dispatch"] = json!(team.auto_dispatch);
            if let Some(rows) = value["tasks"].as_array_mut() {
                for row in rows {
                    let id = row["task"]["id"].as_str().ok_or("task identity missing")?;
                    let task = team
                        .tasks
                        .get(id)
                        .ok_or("task disappeared during evidence read")?;
                    row["attempt"] = serde_json::to_value(
                        evidence::attempt(self, task).await.map_err(|e| e.message)?,
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(value)
    }
}

pub(super) fn command_schema() -> Value {
    json!({"type":"object","properties":{
        "action":{"type":"string","enum":["list","add","assign","review"]},
        "include_settled":{"type":"boolean"},"after_task_id":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":50},
        "expected_revision":{"type":"integer","minimum":1,"description":"Latest revision from tasks/list. Never invent or blindly retry a conflict."},
        "title":{"type":"string"},"instructions":{"type":"string"},"dependencies":{"type":"array","items":{"type":"string"}},
        "eligible_worker_session_ids":{"type":"array","maxItems":64,"items":{"type":"string"},"description":"Optional add-only automatic routing. Copy linked worker IDs qualified for this task. Empty means manual assignment only."},
        "task_id":{"type":"string"},"worker_session_id":{"type":"string","description":"Copy a linked workers[].worker_session_id from tasks/list; observation must be idle and reconciled."},
        "execution_ref":{"type":"string","description":"Exact attempt.execution_ref from tasks/list for this assignment; review only."},
        "outcome":{"type":"string","enum":["completed","failed"]},"summary":{"type":"string"}
    },"required":["action"],"additionalProperties":false})
}

pub(super) const INSTRUCTIONS: &str = " Swarm coordinator scope only: action=tasks requires swarm_id from the schema and command. command.action=list reads the durable board, revision, dependencies, assignment and attempt evidence (default 20, max 50; include_settled and after_task_id are list-only). Do not poll repeatedly; existing worker settlements notify you. command.action=add requires expected_revision,title,instructions (optional dependencies of existing task IDs). command.action=assign requires expected_revision,task_id,worker_session_id of a linked idle worker; this persists ONE claim and queues its inbox delivery, not completion. Do NOT also start/send the same task. command.action=review requires expected_revision,task_id,execution_ref,outcome=completed|failed,summary. Copy attempt.execution_ref from list, inspect the actual evidence and judge quality; a completed turn is not semantic success. Never fabricate evidence or a reference. Only accepted completion unlocks dependencies; failed is terminal in this first slice. Review is not human approval. Do not retry or reassign uncertain external operations. Fields cannot be mixed between commands. tasks/list includes linked workers and their read-only observations; use existing inspect for further worker details. Workers cannot manage the board. tasks/list reports auto_dispatch. Only the user can enable it. When enabled, runtime claims ready tasks for their explicit eligible_worker_session_ids; empty means manual-only. Never guess specialist routing. Concurrent dispatch may change the revision; read again after a conflict, do not blindly retry.";

//! Shared task-board application service. No transport dispatch or model loop.
use super::access as swarm;
fn bad_request(message: impl Into<String>) -> RpcError {
    RpcError::bad_request(message, json!([]))
}
use crate::{swarm_processor::SwarmProcessor, BasicHost};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use xharness_api::{RpcError, RpcId};
use xharness_control::{ControlEvent, SwarmTaskChange, SwarmTaskOutcome, SwarmTaskState};
use xharness_session::{EventData, TurnEndReason};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub(crate) owner_session_id: String,
    pub(crate) command: Command,
}
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Command {
    List {
        swarm_id: String,
        #[serde(default)]
        include_settled: bool,
        #[serde(default)]
        after_task_id: Option<String>,
        #[serde(default = "default_page_size")]
        limit: usize,
    },
    Add {
        swarm_id: String,
        expected_revision: u64,
        title: String,
        instructions: String,
        #[serde(default)]
        dependencies: Vec<String>,
        #[serde(default)]
        eligible_worker_session_ids: Vec<String>,
    },
    Claim {
        swarm_id: String,
        expected_revision: u64,
        task_id: String,
        worker_session_id: String,
    },
    Review {
        swarm_id: String,
        expected_revision: u64,
        task_id: String,
        execution_ref: String,
        outcome: SwarmTaskOutcome,
        summary: String,
    },
    Settle {
        swarm_id: String,
        expected_revision: u64,
        task_id: String,
        message_id: String,
        turn: Option<u32>,
        outcome: SwarmTaskOutcome,
        summary: String,
    },
}
fn default_page_size() -> usize {
    50
}
impl Command {
    fn swarm(&self) -> &str {
        match self {
            Self::List { swarm_id, .. }
            | Self::Add { swarm_id, .. }
            | Self::Claim { swarm_id, .. }
            | Self::Settle { swarm_id, .. }
            | Self::Review { swarm_id, .. } => swarm_id,
        }
    }
}

pub(crate) async fn execute(
    host: &BasicHost,
    rpc_id: RpcId,
    request: Request,
    payload: &Value,
) -> Result<Value, RpcError> {
    execute_inner(host, rpc_id, request, payload, false).await
}

/// Internal scheduler entry; never exposed as a client-supplied privilege flag.
pub(super) async fn execute_automatic(
    host: &BasicHost,
    rpc_id: RpcId,
    request: Request,
    payload: &Value,
) -> Result<Value, RpcError> {
    if !matches!(request.command, Command::Claim { .. }) {
        return Err(bad_request("automatic dispatch only admits claims"));
    }
    execute_inner(host, rpc_id, request, payload, true).await
}

async fn execute_inner(
    host: &BasicHost,
    rpc_id: RpcId,
    request: Request,
    payload: &Value,
    automatic: bool,
) -> Result<Value, RpcError> {
    let owner = &request.owner_session_id;
    let mutation = !matches!(request.command, Command::List { .. });
    let _team_gate = if mutation {
        Some(
            host.lock_admission(&format!("swarm-admission:{}", request.command.swarm()))
                .await,
        )
    } else {
        None
    };
    // Existing deletion/revert paths own this fence before multiple session lanes.
    let _lineage = if automatic {
        Some(host.lock_admission("agent-creation").await)
    } else {
        None
    };
    let _owner_admission = if automatic && owner != "agent-creation" {
        Some(host.lock_admission(owner).await)
    } else {
        None
    };
    if mutation {
        if let Some(value) = host
            .replay_control_receipt_named(&rpc_id, "swarm/tasks", payload)
            .await?
        {
            return Ok(value);
        }
    }
    if host.state.read().await.deleted_sessions.contains(owner) {
        return Err(bad_request("Swarm owner was deleted"));
    }
    let owner_cut = swarm::journal(host, owner)
        .await?
        .ok_or_else(|| bad_request("Swarm owner has no durable session"))?;
    if crate::delegation::restored_delegation(&owner_cut).is_some() {
        return Err(bad_request("only the team owner can manage its task board"));
    }
    let team = swarm::owned(host, request.command.swarm(), owner).await?;
    if automatic && (!team.auto_dispatch || !swarm::owner_dispatch_allowed(host, owner).await?) {
        return Err(bad_request(
            "automatic dispatch is disabled or coordinator is parked",
        ));
    }
    let command = match request.command {
        Command::Review {
            swarm_id,
            expected_revision,
            task_id,
            execution_ref,
            outcome,
            summary,
        } => {
            let task = team
                .tasks
                .get(&task_id)
                .ok_or_else(|| bad_request("task not found"))?;
            let attempt = super::evidence::attempt(host, task)
                .await?
                .filter(|attempt| attempt.execution_ref == execution_ref)
                .ok_or_else(|| {
                    bad_request("execution reference does not match this task assignment")
                })?;
            Command::Settle {
                swarm_id,
                expected_revision,
                task_id,
                message_id: attempt.message_id,
                turn: attempt.turn,
                outcome,
                summary,
            }
        }
        command => command,
    };
    // Serialize the idle observation with ordinary send/start/stop admission.
    let _worker_admission = if let Command::Claim {
        worker_session_id, ..
    } = &command
    {
        if automatic && worker_session_id == "agent-creation" {
            None
        } else {
            Some(host.lock_admission(worker_session_id).await)
        }
    } else {
        None
    };
    let (revision, change, task_id) = match command {
        Command::List {
            include_settled,
            after_task_id,
            limit,
            ..
        } => {
            if !(1..=200).contains(&limit) {
                return Err(bad_request("task page limit must be between 1 and 200"));
            }
            let mut rows = team
                .tasks
                .values()
                .filter(|t| {
                    after_task_id.as_ref().is_none_or(|id| t.id > *id)
                        && (include_settled || !matches!(t.state, SwarmTaskState::Settled { .. }))
                })
                .take(limit + 1)
                .collect::<Vec<_>>();
            let more = rows.len() > limit;
            if more {
                rows.pop();
            }
            let next = if more {
                rows.last().map(|t| t.id.as_str())
            } else {
                None
            };
            return Ok(
                json!({"swarmId":team.id,"revision":team.revision,"tasks":rows.iter().map(|t|json!({"task":t,"ready":t.ready(&team)})).collect::<Vec<_>>(),"hasMore":more,"nextCursor":next}),
            );
        }
        Command::Add {
            expected_revision,
            title,
            instructions,
            dependencies,
            eligible_worker_session_ids,
            ..
        } => {
            let id = host.mint_id("swarm-task");
            (
                expected_revision,
                SwarmTaskChange::Added {
                    task_id: id.clone(),
                    title,
                    instructions,
                    dependencies,
                    eligible_worker_session_ids,
                },
                id,
            )
        }
        Command::Claim {
            expected_revision,
            task_id,
            worker_session_id,
            ..
        } => {
            if automatic
                && !team.tasks.get(&task_id).is_some_and(|task| {
                    task.eligible_worker_session_ids
                        .contains(&worker_session_id)
                })
            {
                return Err(bad_request(
                    "worker is not eligible for automatic dispatch of this task",
                ));
            }
            if !team.members.contains_key(&worker_session_id) {
                return Err(bad_request("task worker is not a team member"));
            }
            let cut = swarm::journal(host, &worker_session_id)
                .await?
                .ok_or_else(|| bad_request("task worker is unavailable"))?;
            if crate::delegation::restored_delegation(&cut).as_deref() != Some(owner.as_str()) {
                return Err(bad_request("task worker is not a direct delegated child"));
            }
            swarm::require_idle_worker(host, &worker_session_id).await?;
            let message_id = host.mint_id("swarm-work");
            (
                expected_revision,
                SwarmTaskChange::Claimed {
                    task_id: task_id.clone(),
                    worker_session_id,
                    message_id,
                },
                task_id,
            )
        }
        Command::Settle {
            expected_revision,
            task_id,
            message_id,
            turn,
            outcome,
            summary,
            ..
        } => {
            let task = team
                .tasks
                .get(&task_id)
                .ok_or_else(|| bad_request("task not found"))?;
            let worker = match &task.state {
                SwarmTaskState::Assigned {
                    worker_session_id,
                    message_id: id,
                    ..
                } if id == &message_id => worker_session_id,
                _ => return Err(bad_request("result does not match an active claim")),
            };
            let cut = swarm::journal(host, worker)
                .await?
                .ok_or_else(|| bad_request("worker result is unavailable"))?;
            // A coordinator acceptance must reference the actual turn consuming this claim.
            // A final answer, idle status or an unrelated completed turn is insufficient.
            let mut started = false;
            let mut consumed = false;
            let mut reason = None;
            for event in cut.events() {
                match event.data() {
                    EventData::TurnStart { turn: t } => started = Some(*t) == turn,
                    EventData::UserMessage { message, .. }
                        if started && message.id.as_deref() == Some(message_id.as_str()) =>
                    {
                        consumed = true
                    }
                    EventData::TurnEnd { turn: t, reason: r } if started && Some(*t) == turn => {
                        reason = Some(r);
                        break;
                    }
                    _ => {}
                }
            }
            let failed_without_turn=turn.is_none() && outcome==SwarmTaskOutcome::Failed && cut.events().iter().any(|e|matches!(e.data(),EventData::AgentDelegationFailure{message_id:id,..} if id==&message_id));
            if !failed_without_turn && (!consumed || reason.is_none()) {
                return Err(bad_request(
                    "task claim has no matching settled worker turn",
                ));
            }
            let success = matches!(reason, Some(TurnEndReason::Completed));
            if outcome == SwarmTaskOutcome::Completed && !success {
                return Err(bad_request(
                    "task completion requires a successful matching worker turn",
                ));
            }
            let mut open = false;
            for event in cut.events() {
                match event.data() {
                    EventData::TurnStart { .. } => open = true,
                    EventData::TurnEnd { .. } => open = false,
                    _ => {}
                }
            }
            if open || !xharness_session::incomplete_tool_calls(cut.events()).is_empty() {
                return Err(bad_request(
                    "worker has unresolved tool outcomes; reconcile before acceptance",
                ));
            }
            (
                expected_revision,
                SwarmTaskChange::Settled {
                    task_id: task_id.clone(),
                    message_id,
                    turn,
                    outcome,
                    summary,
                },
                task_id,
            )
        }
        Command::Review { .. } => return Err(bad_request("unresolved task review")),
    };
    // Journal inspection is outside the global commit gate. Revalidate the
    // receipt and projection only for the short durable Control transaction.
    let _control = host.control_gate.lock().await;
    if let Some(value) = host
        .replay_control_receipt_named(&rpc_id, "swarm/tasks", payload)
        .await?
    {
        return Ok(value);
    }
    if host.state.read().await.deleted_sessions.contains(owner) {
        return Err(bad_request("Swarm owner was deleted"));
    }
    let delivery_id = match &change {
        SwarmTaskChange::Claimed { message_id, .. } => Some(message_id.clone()),
        _ => None,
    };
    let change = SwarmProcessor::task(team.id.clone(), revision, change);
    SwarmProcessor::validate(&host.state.read().await.swarms, &change).map_err(bad_request)?;
    host.commit_control_mutation_named(
        &rpc_id,
        "swarm/tasks",
        payload,
        vec![ControlEvent::SwarmChanged { change }],
        json!({"swarmId":team.id,"taskId":task_id,"revision":revision+1,"deliveryId":delivery_id}),
    )
    .await
}

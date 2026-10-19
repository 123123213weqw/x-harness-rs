//! Opt-in metadata RPC. Never hydrates actors, submits prompts or resumes workers.
use super::bad_request;
use crate::swarm_tasks::access::{journal, observe, owned};
use crate::{swarm_processor::SwarmProcessor, BasicHost};
use serde::Deserialize;
use serde_json::{json, Value};
use xharness_api::{RpcError, RpcId};
use xharness_control::{ControlEvent, SwarmStatus};
use xharness_session::EventData;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    owner_session_id: String,
    command: Command,
}
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Command {
    Create {
        objective: String,
    },
    List,
    Inspect {
        swarm_id: String,
    },
    AttachMember {
        swarm_id: String,
        expected_revision: u64,
        child_session_id: String,
    },
    SetDispatch {
        swarm_id: String,
        expected_revision: u64,
        enabled: bool,
    },
    SetStatus {
        swarm_id: String,
        expected_revision: u64,
        status: SwarmStatus,
    },
}

pub(super) async fn manage(
    host: &BasicHost,
    rpc_id: RpcId,
    payload: &Value,
) -> Result<Value, RpcError> {
    let request: Request = serde_json::from_value(payload.clone())
        .map_err(|e| bad_request(format!("invalid Swarm request: {e}")))?;
    let owner = &request.owner_session_id;
    // Same order as task delivery: team admission, then the short Control commit.
    let _team_gate = match &request.command {
        Command::SetStatus { swarm_id, .. } | Command::SetDispatch { swarm_id, .. } => Some(
            host.lock_admission(&format!("swarm-admission:{swarm_id}"))
                .await,
        ),
        _ => None,
    };
    // Match the existing Control mutation protocol: one durable batch + receipt.
    let mutation = !matches!(request.command, Command::List | Command::Inspect { .. });
    let control_guard = if mutation {
        Some(host.control_gate.lock().await)
    } else {
        None
    };
    if mutation {
        if let Some(response) = host
            .replay_control_receipt_named(&rpc_id, "swarm/manage", payload)
            .await?
        {
            return Ok(response);
        }
    }
    if host.state.read().await.deleted_sessions.contains(owner) {
        return Err(bad_request("Swarm owner was deleted"));
    }
    let owner_session = journal(host, owner)
        .await?
        .ok_or_else(|| bad_request("Swarm owner has no durable session"))?;
    if crate::delegation::restored_delegation(&owner_session).is_some() {
        return Err(bad_request("a delegated worker cannot own a Swarm"));
    }
    let (change, id) = match request.command {
        Command::List => {
            let state = host.state.read().await;
            let teams: Vec<_> = state
                .swarms
                .values()
                .filter(|s| s.owner_session_id == *owner)
                .collect();
            return Ok(json!({"swarms":teams}));
        }
        Command::Inspect { swarm_id } => {
            let swarm = owned(host, &swarm_id, owner).await?;
            // Read-only inspection never owns the global mutation gate.
            drop(control_guard);
            let mut observations = Vec::new();
            for member in swarm.members.values() {
                observations.push(observe(host, &member.session_id).await?);
            }
            return Ok(json!({"swarm":swarm,"workers":observations}));
        }
        Command::Create { objective } => {
            let workspace = owner_session
                .header()
                .cwd
                .clone()
                .ok_or_else(|| bad_request("Swarm owner has no workspace"))?;
            let id = host.mint_id("swarm");
            (
                SwarmProcessor::create(id.clone(), owner.clone(), workspace, objective),
                id,
            )
        }
        Command::SetDispatch {
            swarm_id,
            expected_revision,
            enabled,
        } => {
            owned(host, &swarm_id, owner).await?;
            (
                SwarmProcessor::dispatch(swarm_id.clone(), expected_revision, enabled),
                swarm_id,
            )
        }
        Command::SetStatus {
            swarm_id,
            expected_revision,
            status,
        } => {
            owned(host, &swarm_id, owner).await?;
            (
                SwarmProcessor::transition(swarm_id.clone(), expected_revision, status),
                swarm_id,
            )
        }
        Command::AttachMember {
            swarm_id,
            expected_revision,
            child_session_id,
        } => {
            owned(host, &swarm_id, owner).await?;
            if host
                .state
                .read()
                .await
                .deleted_sessions
                .contains(&child_session_id)
            {
                return Err(bad_request("Swarm worker was deleted"));
            }
            let child = journal(host, &child_session_id)
                .await?
                .ok_or_else(|| bad_request("Swarm worker has no durable session"))?;
            if crate::delegation::restored_delegation(&child).as_deref() != Some(owner.as_str()) {
                return Err(bad_request(
                    "Swarm member must be a direct delegated child of the owner",
                ));
            }
            let assignment = child
                .events()
                .iter()
                .rev()
                .find_map(|e| match e.data() {
                    EventData::AgentDelegated {
                        parent_session_id,
                        task,
                        ..
                    } if parent_session_id == owner => Some(task.clone()),
                    _ => None,
                })
                .ok_or_else(|| {
                    bad_request("Swarm member must be a direct delegated child of the owner")
                })?;
            (
                SwarmProcessor::attach(
                    swarm_id.clone(),
                    expected_revision,
                    child_session_id,
                    assignment,
                ),
                swarm_id,
            )
        }
    };
    {
        let state = host.state.read().await;
        SwarmProcessor::validate(&state.swarms, &change).map_err(bad_request)?;
    }
    let revision = match &change {
        xharness_control::SwarmChange::Created { .. } => 1,
        xharness_control::SwarmChange::StatusChanged {
            expected_revision, ..
        }
        | xharness_control::SwarmChange::DispatchChanged {
            expected_revision, ..
        }
        | xharness_control::SwarmChange::TaskChanged {
            expected_revision, ..
        }
        | xharness_control::SwarmChange::MemberAttached {
            expected_revision, ..
        } => expected_revision + 1,
    };
    let response = json!({"swarmId":id,"revision":revision});
    host.commit_control_mutation_named(
        &rpc_id,
        "swarm/manage",
        payload,
        vec![ControlEvent::SwarmChanged { change }],
        response,
    )
    .await
}

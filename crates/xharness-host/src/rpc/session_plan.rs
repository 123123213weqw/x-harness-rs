//! Thin plan admission adapter. Deliberately never calls Goal activation or runtime wakeup.
#![forbid(unsafe_code)]
use super::{bad_request, rpc_error, session_not_found};
use crate::{control::SessionMutationResponse, BasicHost};
use serde::Deserialize;
use serde_json::{json, Value};
use xharness_api::{RpcError, RpcErrorCode, RpcId, RpcMethod};
use xharness_session::{EventData, PlanItem, SessionPlan};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    session_id: String,
    plan_revision: u64,
    items: Vec<PlanItem>,
}

pub(super) async fn update(
    host: &BasicHost,
    rpc_id: RpcId,
    payload: &Value,
) -> Result<Value, RpcError> {
    let request: Update =
        serde_json::from_value(payload.clone()).map_err(|e| bad_request(e.to_string()))?;
    let id = &request.session_id;
    let _guard = host.lock_admission(id).await;
    if let Some(reply) = host
        .replay_session_mutation_receipt(id, &rpc_id, RpcMethod::GoalUpdatePlan, payload)
        .await?
    {
        return Ok(reply);
    }
    let previous = host
        .state
        .read()
        .await
        .sessions
        .get(id)
        .ok_or_else(|| session_not_found(id))?
        .task_plan
        .clone();
    let revision = previous.as_ref().map_or(0, |p| p.revision);
    if request.plan_revision != revision {
        return Err(rpc_error(
            RpcErrorCode::SessionConflict,
            "working plan changed; read the latest plan and retry",
            json!({"planRevision":revision}),
        ));
    }
    let plan = SessionPlan {
        revision: revision
            .checked_add(1)
            .ok_or_else(|| bad_request("plan revision exhausted"))?,
        items: request.items,
    };
    plan.validate().map_err(bad_request)?;
    let reply = json!({"plan":plan});
    let result = host
        .commit_session_mutation(
            id,
            &rpc_id,
            RpcMethod::GoalUpdatePlan,
            payload,
            vec![EventData::SessionPlanUpdated { plan: plan.clone() }.into()],
            SessionMutationResponse::fixed(reply),
        )
        .await?;
    if !host.agent_runtime.has_authoritative_sessions() {
        host.state
            .write()
            .await
            .sessions
            .get_mut(id)
            .ok_or_else(|| session_not_found(id))?
            .task_plan = Some(plan.clone());
        host.push_projection(id, "taskPlan", json!(plan)).await;
    }
    Ok(result)
}

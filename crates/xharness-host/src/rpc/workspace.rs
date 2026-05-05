//! Workspace RPC compatibility adapter.
//!
//! This module preserves the existing wire validation, exactly-once receipt,
//! durability and host-event ordering. Workspace business decisions live in
//! `WorkspaceProcessor`, which has no dependency on `BasicHost` or transport.

use std::collections::BTreeSet;

use serde_json::{json, Value};
use xharness_api::{RpcError, RpcErrorCode, RpcId, RpcMethod};

use crate::{
    state::iso_now,
    workspace_processor::{WorkspaceMutation, WorkspaceProcessor, WorkspaceStateView},
    BasicHost,
};

use super::{
    bad_request, canonical_directory, optional_string, require_object, required_string, rpc_error,
};

pub(super) async fn call(
    host: &BasicHost,
    rpc_id: RpcId,
    method: RpcMethod,
    payload: &Value,
) -> Result<Value, RpcError> {
    match method {
        RpcMethod::WorkspaceList => list(host, payload).await,
        RpcMethod::WorkspaceCreate => create(host, rpc_id, payload).await,
        RpcMethod::WorkspaceRename => rename(host, rpc_id, payload).await,
        RpcMethod::WorkspaceDelete => delete(host, rpc_id, payload).await,
        RpcMethod::WorkspaceInsertBefore => insert_before(host, rpc_id, payload).await,
        RpcMethod::WorkspaceInsertSessionBefore => {
            insert_session_before(host, rpc_id, payload).await
        }
        RpcMethod::WorkspaceArchiveSession => archive_session(host, rpc_id, payload).await,
        _ => unreachable!("workspace adapter received non-workspace method {method}"),
    }
}

async fn list(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    require_object(payload)?;
    Ok(WorkspaceProcessor::new(snapshot(host).await).list())
}

async fn create(host: &BasicHost, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
    let _control_guard = host.control_gate.lock().await;
    if let Some(response) = host
        .replay_control_receipt(&rpc_id, RpcMethod::WorkspaceCreate, payload)
        .await?
    {
        return Ok(response);
    }
    let raw_path = required_string(payload, "path")?;
    let path = canonical_directory(&raw_path).map_err(|message| {
        rpc_error(
            RpcErrorCode::WorkspaceInvalidPath,
            message,
            json!({"path": raw_path}),
        )
    })?;
    let processor = WorkspaceProcessor::new(snapshot(host).await);
    let mutation = processor.create(path, || host.mint_id("workspace"), iso_now);
    commit(host, rpc_id, RpcMethod::WorkspaceCreate, payload, mutation).await
}

async fn rename(host: &BasicHost, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
    let _control_guard = host.control_gate.lock().await;
    if let Some(response) = host
        .replay_control_receipt(&rpc_id, RpcMethod::WorkspaceRename, payload)
        .await?
    {
        return Ok(response);
    }
    let workspace_id = required_string(payload, "workspaceId")?;
    let title = required_string(payload, "title")?.trim().to_owned();
    if title.is_empty() {
        return Err(bad_request("workspace title must not be blank"));
    }
    let mutation =
        WorkspaceProcessor::new(snapshot(host).await).rename(&workspace_id, title, iso_now)?;
    commit(host, rpc_id, RpcMethod::WorkspaceRename, payload, mutation).await
}

async fn delete(host: &BasicHost, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
    let _control_guard = host.control_gate.lock().await;
    if let Some(response) = host
        .replay_control_receipt(&rpc_id, RpcMethod::WorkspaceDelete, payload)
        .await?
    {
        return Ok(response);
    }
    let workspace_id = required_string(payload, "workspaceId")?;
    let mutation = WorkspaceProcessor::new(snapshot(host).await).delete(&workspace_id)?;
    commit(host, rpc_id, RpcMethod::WorkspaceDelete, payload, mutation).await
}

async fn insert_before(
    host: &BasicHost,
    rpc_id: RpcId,
    payload: &Value,
) -> Result<Value, RpcError> {
    let _control_guard = host.control_gate.lock().await;
    if let Some(response) = host
        .replay_control_receipt(&rpc_id, RpcMethod::WorkspaceInsertBefore, payload)
        .await?
    {
        return Ok(response);
    }
    let workspace_id = required_string(payload, "workspaceId")?;
    let before = optional_string(payload, "beforeWorkspaceId")?;
    let mutation = WorkspaceProcessor::new(snapshot(host).await)
        .insert_before(&workspace_id, before.as_deref())?;
    commit(
        host,
        rpc_id,
        RpcMethod::WorkspaceInsertBefore,
        payload,
        mutation,
    )
    .await
}

async fn insert_session_before(
    host: &BasicHost,
    rpc_id: RpcId,
    payload: &Value,
) -> Result<Value, RpcError> {
    let _control_guard = host.control_gate.lock().await;
    if let Some(response) = host
        .replay_control_receipt(&rpc_id, RpcMethod::WorkspaceInsertSessionBefore, payload)
        .await?
    {
        return Ok(response);
    }
    let workspace_id = required_string(payload, "workspaceId")?;
    let session_id = required_string(payload, "sessionId")?;
    let before = optional_string(payload, "beforeSessionId")?;
    let mutation = WorkspaceProcessor::new(snapshot(host).await).insert_session_before(
        &workspace_id,
        &session_id,
        before.as_deref(),
        iso_now,
    )?;
    commit(
        host,
        rpc_id,
        RpcMethod::WorkspaceInsertSessionBefore,
        payload,
        mutation,
    )
    .await
}

async fn archive_session(
    host: &BasicHost,
    rpc_id: RpcId,
    payload: &Value,
) -> Result<Value, RpcError> {
    let _control_guard = host.control_gate.lock().await;
    if let Some(response) = host
        .replay_control_receipt(&rpc_id, RpcMethod::WorkspaceArchiveSession, payload)
        .await?
    {
        return Ok(response);
    }
    let session_id = required_string(payload, "sessionId")?;
    let mutation = WorkspaceProcessor::new(snapshot(host).await).archive_session(&session_id)?;
    commit(
        host,
        rpc_id,
        RpcMethod::WorkspaceArchiveSession,
        payload,
        mutation,
    )
    .await
}

async fn snapshot(host: &BasicHost) -> WorkspaceStateView {
    let state = host.state.read().await;
    WorkspaceStateView {
        workspaces: state.workspaces.clone(),
        workspace_order: state.workspace_order.clone(),
        archived_sessions: state.archived_sessions.clone(),
        session_ids: state.sessions.keys().cloned().collect::<BTreeSet<_>>(),
    }
}

async fn commit(
    host: &BasicHost,
    rpc_id: RpcId,
    method: RpcMethod,
    payload: &Value,
    mutation: WorkspaceMutation,
) -> Result<Value, RpcError> {
    let response = host
        .commit_control_mutation(
            &rpc_id,
            method,
            payload,
            mutation.control_events,
            mutation.response,
        )
        .await?;
    for event in mutation.host_events {
        host.push_host(event);
    }
    Ok(response)
}

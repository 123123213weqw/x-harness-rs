//! Workspace RPC command service.
//! The parent module owns transport dispatch while this module owns durable
//! workspace mutations and their host-event publication.

use std::path::Path;

use serde_json::{json, Value};
use xharness_api::{RpcError, RpcErrorCode, RpcId, RpcMethod};
use xharness_control::ControlEvent;

use crate::{
    control::workspace_snapshot,
    state::{iso_now, WorkspaceRecord},
    BasicHost,
};

use super::{
    bad_request, canonical_directory, optional_string, require_object, required_string, rpc_error,
    session_not_found, workspace_not_found,
};

impl BasicHost {
    pub(super) async fn workspace_list(&self, payload: &Value) -> Result<Value, RpcError> {
        require_object(payload)?;
        let state = self.state.read().await;
        let items = state
            .workspace_order
            .iter()
            .filter_map(|id| state.workspaces.get(id))
            .collect::<Vec<_>>();
        Ok(json!({
            "items": items,
            "archivedSessionIds": state.archived_sessions,
        }))
    }

    pub(super) async fn workspace_create(
        &self,
        rpc_id: RpcId,
        payload: &Value,
    ) -> Result<Value, RpcError> {
        let _control_guard = self.control_gate.lock().await;
        if let Some(response) = self
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
        let state = self.state.read().await;
        if let Some(existing) = state
            .workspaces
            .values()
            .find(|workspace| workspace.path == path)
        {
            let response = json!({"workspace": existing, "created": false});
            drop(state);
            return self
                .commit_control_mutation(
                    &rpc_id,
                    RpcMethod::WorkspaceCreate,
                    payload,
                    Vec::new(),
                    response,
                )
                .await;
        }
        let id = self.mint_id("workspace");
        let now = iso_now();
        let title = Path::new(&path)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or(&path)
            .to_owned();
        let workspace = WorkspaceRecord {
            workspace_id: id.clone(),
            path,
            title,
            session_ids: Vec::new(),
            created_at: now.clone(),
            updated_at: now,
        };
        let mut order = state.workspace_order.clone();
        order.push(id);
        drop(state);
        let response = json!({"workspace": workspace, "created": true});
        let response = self
            .commit_control_mutation(
                &rpc_id,
                RpcMethod::WorkspaceCreate,
                payload,
                vec![
                    ControlEvent::WorkspaceDefined {
                        workspace: workspace_snapshot(&workspace),
                    },
                    ControlEvent::WorkspaceOrderSet {
                        workspace_ids: order,
                    },
                ],
                response,
            )
            .await?;
        self.push_host(json!({"type": "host/workspace-changed", "workspace": workspace}));
        Ok(response)
    }

    pub(super) async fn workspace_rename(
        &self,
        rpc_id: RpcId,
        payload: &Value,
    ) -> Result<Value, RpcError> {
        let _control_guard = self.control_gate.lock().await;
        if let Some(response) = self
            .replay_control_receipt(&rpc_id, RpcMethod::WorkspaceRename, payload)
            .await?
        {
            return Ok(response);
        }
        let id = required_string(payload, "workspaceId")?;
        let title = required_string(payload, "title")?.trim().to_owned();
        if title.is_empty() {
            return Err(bad_request("workspace title must not be blank"));
        }
        let state = self.state.read().await;
        let mut workspace = state
            .workspaces
            .get(&id)
            .cloned()
            .ok_or_else(|| workspace_not_found(&id))?;
        workspace.title = title;
        workspace.updated_at = iso_now();
        let value = serde_json::to_value(&workspace)
            .map_err(|error| RpcError::internal(error.to_string()))?;
        drop(state);
        let response = self
            .commit_control_mutation(
                &rpc_id,
                RpcMethod::WorkspaceRename,
                payload,
                vec![ControlEvent::WorkspaceDefined {
                    workspace: workspace_snapshot(&workspace),
                }],
                json!({"workspace": value}),
            )
            .await?;
        self.push_host(json!({"type": "host/workspace-changed", "workspace": value}));
        Ok(response)
    }

    pub(super) async fn workspace_delete(
        &self,
        rpc_id: RpcId,
        payload: &Value,
    ) -> Result<Value, RpcError> {
        let _control_guard = self.control_gate.lock().await;
        if let Some(response) = self
            .replay_control_receipt(&rpc_id, RpcMethod::WorkspaceDelete, payload)
            .await?
        {
            return Ok(response);
        }
        let id = required_string(payload, "workspaceId")?;
        let state = self.state.read().await;
        if !state.workspaces.contains_key(&id) {
            return Err(workspace_not_found(&id));
        }
        let order = state
            .workspace_order
            .iter()
            .filter(|candidate| *candidate != &id)
            .cloned()
            .collect::<Vec<_>>();
        drop(state);
        let response = self
            .commit_control_mutation(
                &rpc_id,
                RpcMethod::WorkspaceDelete,
                payload,
                vec![
                    ControlEvent::WorkspaceRemoved {
                        workspace_id: id.clone(),
                    },
                    ControlEvent::WorkspaceOrderSet {
                        workspace_ids: order.clone(),
                    },
                ],
                json!({"deleted": true}),
            )
            .await?;
        self.push_host(json!({"type": "host/workspace-removed", "workspaceId": id}));
        self.push_host(json!({
            "type": "host/workspace-order-changed",
            "workspaceIds": order,
        }));
        Ok(response)
    }

    pub(super) async fn workspace_insert_before(
        &self,
        rpc_id: RpcId,
        payload: &Value,
    ) -> Result<Value, RpcError> {
        let _control_guard = self.control_gate.lock().await;
        if let Some(response) = self
            .replay_control_receipt(&rpc_id, RpcMethod::WorkspaceInsertBefore, payload)
            .await?
        {
            return Ok(response);
        }
        let id = required_string(payload, "workspaceId")?;
        let before = optional_string(payload, "beforeWorkspaceId")?;
        let state = self.state.read().await;
        if !state.workspaces.contains_key(&id) {
            return Err(workspace_not_found(&id));
        }
        if let Some(before) = &before {
            if before == &id || !state.workspaces.contains_key(before) {
                return Err(rpc_error(
                    RpcErrorCode::WorkspaceMoveInvalid,
                    "workspace move anchor is invalid",
                    json!({"workspaceId": id, "beforeWorkspaceId": before}),
                ));
            }
        }
        let mut order = state
            .workspace_order
            .iter()
            .filter(|candidate| *candidate != &id)
            .cloned()
            .collect::<Vec<_>>();
        let index = before
            .as_ref()
            .and_then(|anchor| order.iter().position(|candidate| candidate == anchor))
            .unwrap_or(order.len());
        order.insert(index, id);
        drop(state);
        let response = self
            .commit_control_mutation(
                &rpc_id,
                RpcMethod::WorkspaceInsertBefore,
                payload,
                vec![ControlEvent::WorkspaceOrderSet {
                    workspace_ids: order.clone(),
                }],
                json!({"workspaceIds": order}),
            )
            .await?;
        self.push_host(json!({
            "type": "host/workspace-order-changed",
            "workspaceIds": order,
        }));
        Ok(response)
    }

    pub(super) async fn workspace_insert_session_before(
        &self,
        rpc_id: RpcId,
        payload: &Value,
    ) -> Result<Value, RpcError> {
        let _control_guard = self.control_gate.lock().await;
        if let Some(response) = self
            .replay_control_receipt(&rpc_id, RpcMethod::WorkspaceInsertSessionBefore, payload)
            .await?
        {
            return Ok(response);
        }
        let workspace_id = required_string(payload, "workspaceId")?;
        let session_id = required_string(payload, "sessionId")?;
        let before = optional_string(payload, "beforeSessionId")?;
        let state = self.state.read().await;
        if !state.sessions.contains_key(&session_id) {
            return Err(session_not_found(&session_id));
        }
        let mut workspace = state
            .workspaces
            .get(&workspace_id)
            .cloned()
            .ok_or_else(|| workspace_not_found(&workspace_id))?;
        if let Some(before) = &before {
            if before == &session_id || !workspace.session_ids.contains(before) {
                return Err(rpc_error(
                    RpcErrorCode::WorkspaceMoveInvalid,
                    "session move anchor is invalid",
                    json!({"workspaceId": workspace_id, "sessionId": session_id}),
                ));
            }
        }
        workspace
            .session_ids
            .retain(|candidate| candidate != &session_id);
        let index = before
            .as_ref()
            .and_then(|anchor| {
                workspace
                    .session_ids
                    .iter()
                    .position(|candidate| candidate == anchor)
            })
            .unwrap_or(workspace.session_ids.len());
        workspace.session_ids.insert(index, session_id);
        workspace.updated_at = iso_now();
        let value = serde_json::to_value(&workspace)
            .map_err(|error| RpcError::internal(error.to_string()))?;
        drop(state);
        let response = self
            .commit_control_mutation(
                &rpc_id,
                RpcMethod::WorkspaceInsertSessionBefore,
                payload,
                vec![ControlEvent::WorkspaceDefined {
                    workspace: workspace_snapshot(&workspace),
                }],
                json!({"workspace": value}),
            )
            .await?;
        self.push_host(json!({"type": "host/workspace-changed", "workspace": value}));
        Ok(response)
    }

    pub(super) async fn workspace_archive_session(
        &self,
        rpc_id: RpcId,
        payload: &Value,
    ) -> Result<Value, RpcError> {
        let _control_guard = self.control_gate.lock().await;
        if let Some(response) = self
            .replay_control_receipt(&rpc_id, RpcMethod::WorkspaceArchiveSession, payload)
            .await?
        {
            return Ok(response);
        }
        let session_id = required_string(payload, "sessionId")?;
        let state = self.state.read().await;
        if !state.sessions.contains_key(&session_id) {
            return Err(session_not_found(&session_id));
        }
        let mut archived = state.archived_sessions.clone();
        archived.insert(session_id);
        drop(state);
        let archived_ids = archived.iter().cloned().collect::<Vec<_>>();
        let response = self
            .commit_control_mutation(
                &rpc_id,
                RpcMethod::WorkspaceArchiveSession,
                payload,
                vec![ControlEvent::ArchivedSessionsSet {
                    session_ids: archived_ids,
                }],
                json!({"archivedSessionIds": archived}),
            )
            .await?;
        self.push_host(json!({
            "type": "host/archived-sessions-changed",
            "archivedSessionIds": archived,
        }));
        Ok(response)
    }
}

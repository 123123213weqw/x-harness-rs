//! Pure Workspace application decisions.
//!
//! This module deliberately knows nothing about the Host aggregate, HTTP, locks or
//! the control store. The RPC compatibility adapter supplies a read snapshot,
//! commits the returned control events atomically and publishes the returned
//! host events only after durability succeeds.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde_json::{json, Value};
use xharness_api::{RpcError, RpcErrorCode};
use xharness_control::ControlEvent;

use crate::{control::workspace_snapshot, state::WorkspaceRecord};

#[derive(Clone, Debug)]
pub(crate) struct WorkspaceStateView {
    pub(crate) workspaces: BTreeMap<String, WorkspaceRecord>,
    pub(crate) workspace_order: Vec<String>,
    pub(crate) archived_sessions: BTreeSet<String>,
    pub(crate) session_ids: BTreeSet<String>,
}

#[derive(Debug)]
pub(crate) struct WorkspaceMutation {
    pub(crate) control_events: Vec<ControlEvent>,
    pub(crate) response: Value,
    pub(crate) host_events: Vec<Value>,
}

impl WorkspaceMutation {
    fn new(control_events: Vec<ControlEvent>, response: Value, host_events: Vec<Value>) -> Self {
        Self {
            control_events,
            response,
            host_events,
        }
    }
}

pub(crate) struct WorkspaceProcessor {
    state: WorkspaceStateView,
}

impl WorkspaceProcessor {
    pub(crate) fn new(state: WorkspaceStateView) -> Self {
        Self { state }
    }

    pub(crate) fn list(&self) -> Value {
        let items = self
            .state
            .workspace_order
            .iter()
            .filter_map(|id| self.state.workspaces.get(id))
            .collect::<Vec<_>>();
        json!({
            "items": items,
            "archivedSessionIds": self.state.archived_sessions,
        })
    }

    pub(crate) fn create(
        &self,
        path: String,
        mint_id: impl FnOnce() -> String,
        now: impl FnOnce() -> String,
    ) -> WorkspaceMutation {
        if let Some(existing) = self
            .state
            .workspaces
            .values()
            .find(|workspace| workspace.path == path)
        {
            return WorkspaceMutation::new(
                Vec::new(),
                json!({"workspace": existing, "created": false}),
                Vec::new(),
            );
        }

        let id = mint_id();
        let now = now();
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
        let mut order = self.state.workspace_order.clone();
        order.push(id);
        WorkspaceMutation::new(
            vec![
                ControlEvent::WorkspaceDefined {
                    workspace: workspace_snapshot(&workspace),
                },
                ControlEvent::WorkspaceOrderSet {
                    workspace_ids: order,
                },
            ],
            json!({"workspace": workspace, "created": true}),
            vec![json!({"type": "host/workspace-changed", "workspace": workspace})],
        )
    }

    pub(crate) fn rename(
        &self,
        workspace_id: &str,
        title: String,
        now: impl FnOnce() -> String,
    ) -> Result<WorkspaceMutation, RpcError> {
        let mut workspace = self.workspace(workspace_id)?.clone();
        workspace.title = title;
        workspace.updated_at = now();
        let value = serde_json::to_value(&workspace)
            .map_err(|error| RpcError::internal(error.to_string()))?;
        Ok(WorkspaceMutation::new(
            vec![ControlEvent::WorkspaceDefined {
                workspace: workspace_snapshot(&workspace),
            }],
            json!({"workspace": value}),
            vec![json!({"type": "host/workspace-changed", "workspace": value})],
        ))
    }

    pub(crate) fn delete(&self, workspace_id: &str) -> Result<WorkspaceMutation, RpcError> {
        self.workspace(workspace_id)?;
        let order = self
            .state
            .workspace_order
            .iter()
            .filter(|candidate| candidate.as_str() != workspace_id)
            .cloned()
            .collect::<Vec<_>>();
        Ok(WorkspaceMutation::new(
            vec![
                ControlEvent::WorkspaceRemoved {
                    workspace_id: workspace_id.to_owned(),
                },
                ControlEvent::WorkspaceOrderSet {
                    workspace_ids: order.clone(),
                },
            ],
            json!({"deleted": true}),
            vec![
                json!({"type": "host/workspace-removed", "workspaceId": workspace_id}),
                json!({
                    "type": "host/workspace-order-changed",
                    "workspaceIds": order,
                }),
            ],
        ))
    }

    pub(crate) fn insert_before(
        &self,
        workspace_id: &str,
        before_workspace_id: Option<&str>,
    ) -> Result<WorkspaceMutation, RpcError> {
        self.workspace(workspace_id)?;
        if let Some(before) = before_workspace_id {
            if before == workspace_id || !self.state.workspaces.contains_key(before) {
                return Err(rpc_error(
                    RpcErrorCode::WorkspaceMoveInvalid,
                    "workspace move anchor is invalid",
                    json!({
                        "workspaceId": workspace_id,
                        "beforeWorkspaceId": before,
                    }),
                ));
            }
        }
        let mut order = self
            .state
            .workspace_order
            .iter()
            .filter(|candidate| candidate.as_str() != workspace_id)
            .cloned()
            .collect::<Vec<_>>();
        let index = before_workspace_id
            .and_then(|anchor| order.iter().position(|candidate| candidate == anchor))
            .unwrap_or(order.len());
        order.insert(index, workspace_id.to_owned());
        Ok(WorkspaceMutation::new(
            vec![ControlEvent::WorkspaceOrderSet {
                workspace_ids: order.clone(),
            }],
            json!({"workspaceIds": order}),
            vec![json!({
                "type": "host/workspace-order-changed",
                "workspaceIds": order,
            })],
        ))
    }

    pub(crate) fn insert_session_before(
        &self,
        workspace_id: &str,
        session_id: &str,
        before_session_id: Option<&str>,
        now: impl FnOnce() -> String,
    ) -> Result<WorkspaceMutation, RpcError> {
        if !self.state.session_ids.contains(session_id) {
            return Err(session_not_found(session_id));
        }
        let mut workspace = self.workspace(workspace_id)?.clone();
        if let Some(before) = before_session_id {
            if before == session_id || !workspace.session_ids.iter().any(|id| id == before) {
                return Err(rpc_error(
                    RpcErrorCode::WorkspaceMoveInvalid,
                    "session move anchor is invalid",
                    json!({"workspaceId": workspace_id, "sessionId": session_id}),
                ));
            }
        }
        workspace
            .session_ids
            .retain(|candidate| candidate != session_id);
        let index = before_session_id
            .and_then(|anchor| {
                workspace
                    .session_ids
                    .iter()
                    .position(|candidate| candidate == anchor)
            })
            .unwrap_or(workspace.session_ids.len());
        workspace.session_ids.insert(index, session_id.to_owned());
        workspace.updated_at = now();
        let value = serde_json::to_value(&workspace)
            .map_err(|error| RpcError::internal(error.to_string()))?;
        Ok(WorkspaceMutation::new(
            vec![ControlEvent::WorkspaceDefined {
                workspace: workspace_snapshot(&workspace),
            }],
            json!({"workspace": value}),
            vec![json!({"type": "host/workspace-changed", "workspace": value})],
        ))
    }

    pub(crate) fn archive_session(&self, session_id: &str) -> Result<WorkspaceMutation, RpcError> {
        if !self.state.session_ids.contains(session_id) {
            return Err(session_not_found(session_id));
        }
        let mut archived = self.state.archived_sessions.clone();
        archived.insert(session_id.to_owned());
        let archived_ids = archived.iter().cloned().collect::<Vec<_>>();
        Ok(WorkspaceMutation::new(
            vec![ControlEvent::ArchivedSessionsSet {
                session_ids: archived_ids,
            }],
            json!({"archivedSessionIds": archived}),
            vec![json!({
                "type": "host/archived-sessions-changed",
                "archivedSessionIds": archived,
            })],
        ))
    }

    fn workspace(&self, workspace_id: &str) -> Result<&WorkspaceRecord, RpcError> {
        self.state
            .workspaces
            .get(workspace_id)
            .ok_or_else(|| workspace_not_found(workspace_id))
    }
}

fn workspace_not_found(workspace_id: &str) -> RpcError {
    rpc_error(
        RpcErrorCode::WorkspaceNotFound,
        format!("workspace {workspace_id:?} was not found"),
        json!({"workspaceId": workspace_id}),
    )
}

fn session_not_found(session_id: &str) -> RpcError {
    rpc_error(
        RpcErrorCode::SessionNotFound,
        format!("session {session_id:?} was not found"),
        json!({"sessionId": session_id}),
    )
}

fn rpc_error(code: RpcErrorCode, message: impl Into<String>, details: Value) -> RpcError {
    RpcError {
        code,
        message: message.into(),
        details,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(id: &str, sessions: &[&str]) -> WorkspaceRecord {
        WorkspaceRecord {
            workspace_id: id.to_owned(),
            path: format!("/tmp/{id}"),
            title: id.to_owned(),
            session_ids: sessions.iter().map(|id| (*id).to_owned()).collect(),
            created_at: "created".to_owned(),
            updated_at: "updated".to_owned(),
        }
    }

    fn processor() -> WorkspaceProcessor {
        WorkspaceProcessor::new(WorkspaceStateView {
            workspaces: BTreeMap::from([
                ("a".to_owned(), workspace("a", &["s1", "s2"])),
                ("b".to_owned(), workspace("b", &[])),
            ]),
            workspace_order: vec!["a".to_owned(), "b".to_owned()],
            archived_sessions: BTreeSet::new(),
            session_ids: BTreeSet::from(["s1".to_owned(), "s2".to_owned()]),
        })
    }

    #[test]
    fn create_duplicate_is_a_receipted_noop_without_consuming_identity_or_time() {
        let mutation = processor().create(
            "/tmp/a".to_owned(),
            || panic!("duplicate create must not mint an id"),
            || panic!("duplicate create must not read the clock"),
        );
        assert!(mutation.control_events.is_empty());
        assert!(mutation.host_events.is_empty());
        assert_eq!(mutation.response["created"], false);
        assert_eq!(mutation.response["workspace"]["workspaceId"], "a");
    }

    #[test]
    fn reorder_plan_is_deterministic_and_does_not_mutate_the_input_snapshot() {
        let processor = processor();
        let mutation = processor.insert_before("b", Some("a")).unwrap();
        assert_eq!(mutation.response, json!({"workspaceIds":["b","a"]}));
        assert_eq!(processor.state.workspace_order, ["a", "b"]);
        assert_eq!(mutation.host_events.len(), 1);
    }

    #[test]
    fn session_move_validates_before_producing_durable_or_host_events() {
        let error = processor()
            .insert_session_before("a", "missing", None, || "now".to_owned())
            .unwrap_err();
        assert_eq!(error.code, RpcErrorCode::SessionNotFound);

        let error = processor()
            .insert_session_before("a", "s1", Some("missing"), || "now".to_owned())
            .unwrap_err();
        assert_eq!(error.code, RpcErrorCode::WorkspaceMoveInvalid);
    }
}

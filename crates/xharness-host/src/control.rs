use std::collections::BTreeSet;

use serde_json::Value;
use xharness_api::{RpcError, RpcErrorCode, RpcId, RpcMethod};
use xharness_control::{
    mutation_fingerprint, ControlError, ControlEvent, ControlProjection, MutationReceipt,
    SettingsSnapshot, WorkspaceSnapshot,
};
use xharness_session::{EventData as SessionEventData, SessionEvent, SessionMutationReceipt};

use crate::{state::WorkspaceRecord, BasicHost};

pub(crate) struct SessionMutationResponse {
    pub(crate) value: Value,
    pub(crate) event_seq_field: Option<String>,
}

impl SessionMutationResponse {
    pub(crate) fn fixed(value: Value) -> Self {
        Self {
            value,
            event_seq_field: None,
        }
    }

    pub(crate) fn with_event_seq(value: Value, field: impl Into<String>) -> Self {
        Self {
            value,
            event_seq_field: Some(field.into()),
        }
    }
}

impl BasicHost {
    /// Restore Host-global state before Session replay. Session-derived
    /// workspace membership is applied later and then reordered by the same
    /// projection once more.
    pub(crate) async fn restore_control_state(&self) -> Result<(), ControlError> {
        self.reload_control_projection().await
    }

    pub(crate) async fn reload_control_projection(&self) -> Result<(), ControlError> {
        let log = self.control_store.load().await?;
        let projection = log.projection()?;
        self.apply_control_projection(log.revision(), projection)
            .await
    }

    async fn apply_control_projection(
        &self,
        revision: xharness_control::ControlRevision,
        projection: ControlProjection,
    ) -> Result<(), ControlError> {
        let mut state = self.state.write().await;
        if let Some(settings) = projection
            .settings
            .values()
            .find(|settings| !state.settings.contains_key(&settings.namespace))
        {
            return Err(ControlError::InvalidLog {
                message: format!(
                    "control log references unknown settings namespace {:?}",
                    settings.namespace
                ),
            });
        }
        for workspace_id in &projection.removed_workspaces {
            state.workspaces.remove(workspace_id);
            state
                .workspace_order
                .retain(|candidate| candidate != workspace_id);
        }
        for workspace in projection.workspaces.values() {
            let known_sessions = state.sessions.keys().cloned().collect::<BTreeSet<_>>();
            match state.workspaces.get_mut(&workspace.workspace_id) {
                Some(existing) => {
                    let mut ordered = workspace
                        .session_order
                        .iter()
                        .filter(|session_id| {
                            known_sessions.contains(*session_id)
                                && existing.session_ids.contains(*session_id)
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    for session_id in &existing.session_ids {
                        if !ordered.contains(session_id) {
                            ordered.push(session_id.clone());
                        }
                    }
                    existing.path = workspace.path.clone();
                    existing.title = workspace.title.clone();
                    existing.session_ids = ordered;
                    existing.created_at = workspace.created_at.clone();
                    existing.updated_at = workspace.updated_at.clone();
                }
                None => {
                    state.workspaces.insert(
                        workspace.workspace_id.clone(),
                        WorkspaceRecord {
                            workspace_id: workspace.workspace_id.clone(),
                            path: workspace.path.clone(),
                            title: workspace.title.clone(),
                            session_ids: workspace
                                .session_order
                                .iter()
                                .filter(|session_id| known_sessions.contains(*session_id))
                                .cloned()
                                .collect(),
                            created_at: workspace.created_at.clone(),
                            updated_at: workspace.updated_at.clone(),
                        },
                    );
                }
            }
        }
        if let Some(order) = projection.workspace_order {
            let mut merged = order
                .into_iter()
                .filter(|workspace_id| state.workspaces.contains_key(workspace_id))
                .collect::<Vec<_>>();
            for workspace_id in &state.workspace_order {
                if state.workspaces.contains_key(workspace_id) && !merged.contains(workspace_id) {
                    merged.push(workspace_id.clone());
                }
            }
            let mut remaining = state
                .workspaces
                .keys()
                .filter(|workspace_id| !merged.contains(workspace_id))
                .cloned()
                .collect::<Vec<_>>();
            remaining.sort();
            merged.extend(remaining);
            state.workspace_order = merged;
        }
        if let Some(archived) = projection.archived_sessions {
            state.archived_sessions = archived.into_iter().collect();
        }
        for settings in projection.settings.values() {
            let namespace = state
                .settings
                .get_mut(&settings.namespace)
                .expect("settings namespaces were validated before projection");
            namespace.user = settings.user.clone();
            namespace.value = settings.value.clone();
            namespace.revision = settings.revision;
        }
        state.control_revision = revision;
        state.mutation_receipts = projection.receipts;
        Ok(())
    }

    /// Must be called while `control_gate` is held. A matching receipt returns
    /// the original response without repeating validation or side effects;
    /// reusing the ID with any other method or payload fails closed.
    pub(crate) async fn replay_control_receipt(
        &self,
        rpc_id: &RpcId,
        method: RpcMethod,
        payload: &Value,
    ) -> Result<Option<Value>, RpcError> {
        let fingerprint = mutation_fingerprint(method.as_str(), payload);
        let state = self.state.read().await;
        let Some(receipt) = state.mutation_receipts.get(rpc_id.as_str()) else {
            return Ok(None);
        };
        if receipt.method == method.as_str() && receipt.fingerprint == fingerprint {
            let mut response = receipt.response.clone();
            if response["ns"] == crate::MODEL_SETTINGS_NAMESPACE && response.get("schema").is_none()
            {
                response["schema"] = crate::model_settings_schema();
            }
            return Ok(Some(response));
        }
        Err(control_conflict(
            rpc_id,
            "RPC id already committed with another method or payload",
        ))
    }

    /// Append state changes and the generic receipt in one revision, execute a
    /// durability barrier, and rebuild the in-memory projection from the log
    /// before the caller emits Web events or returns success.
    pub(crate) async fn commit_control_mutation(
        &self,
        rpc_id: &RpcId,
        method: RpcMethod,
        payload: &Value,
        mut events: Vec<ControlEvent>,
        response: Value,
    ) -> Result<Value, RpcError> {
        let fingerprint = mutation_fingerprint(method.as_str(), payload);
        let revision = self.state.read().await.control_revision;
        let mut receipt_response = response.clone();
        if receipt_response["ns"] == crate::MODEL_SETTINGS_NAMESPACE {
            // The schema is executable-version metadata, not user state. Its
            // apiKeyEnv dictionary key maps to a schema node ID, which must not
            // be confused with a persisted credential reference/value. Rebuild
            // this static field on replay instead of weakening secret checks.
            receipt_response
                .as_object_mut()
                .expect("namespace response")
                .remove("schema");
        }
        events.push(ControlEvent::MutationCommitted {
            receipt: MutationReceipt {
                rpc_id: rpc_id.as_str().to_owned(),
                method: method.as_str().to_owned(),
                fingerprint,
                response: receipt_response,
            },
        });
        match self.control_store.append(revision, events).await {
            Ok(receipt) => {
                let flushed = self.control_store.flush().await.map_err(control_error)?;
                if flushed != receipt.revision {
                    return Err(RpcError::internal(format!(
                        "control flush returned {flushed:?}, expected {:?}",
                        receipt.revision
                    )));
                }
                self.reload_control_projection()
                    .await
                    .map_err(control_error)?;
                Ok(response)
            }
            Err(ControlError::RevisionConflict { .. }) => {
                self.reload_control_projection()
                    .await
                    .map_err(control_error)?;
                self.replay_control_receipt(rpc_id, method, payload)
                    .await?
                    .ok_or_else(|| {
                        control_conflict(
                            rpc_id,
                            "another Host changed control state; retry with a new RPC request",
                        )
                    })
            }
            Err(error) => Err(control_error(error)),
        }
    }

    /// Replay one session-scoped mutation after a lost HTTP response. The
    /// receipt lives in the same Session revision as its state event rather
    /// than in the Host-global control log.
    pub(crate) async fn replay_session_mutation_receipt(
        &self,
        session_id: &str,
        rpc_id: &RpcId,
        method: RpcMethod,
        payload: &Value,
    ) -> Result<Option<Value>, RpcError> {
        if self.agent_runtime.has_authoritative_sessions() {
            self.sync_authoritative_session(session_id).await?;
        }
        let fingerprint = mutation_fingerprint(method.as_str(), payload);
        let state = self.state.read().await;
        let session = state.sessions.get(session_id).ok_or_else(|| {
            crate::driver::rpc_error(
                RpcErrorCode::SessionNotFound,
                format!("session {session_id:?} was not found"),
                serde_json::json!({"sessionId": session_id}),
            )
        })?;
        let Some(receipt) = session.mutation_receipts.get(rpc_id.as_str()) else {
            return Ok(None);
        };
        if receipt.receipt.method == method.as_str() && receipt.receipt.fingerprint == fingerprint {
            return Ok(Some(receipt.response()));
        }
        Err(control_conflict(
            rpc_id,
            "RPC id already committed in this session with another method or payload",
        ))
    }

    /// Atomically append session state events and their exactly-once receipt,
    /// flush the authoritative Session, then refresh the Host projection.
    pub(crate) async fn commit_session_mutation(
        &self,
        session_id: &str,
        rpc_id: &RpcId,
        method: RpcMethod,
        payload: &Value,
        mut events: Vec<SessionEvent>,
        response: SessionMutationResponse,
    ) -> Result<Value, RpcError> {
        if events.is_empty() {
            return Err(RpcError::internal(
                "session mutation must contain at least one state event",
            ));
        }
        let receipt = SessionMutationReceipt {
            rpc_id: rpc_id.as_str().to_owned(),
            method: method.as_str().to_owned(),
            fingerprint: mutation_fingerprint(method.as_str(), payload),
            response: response.value.clone(),
            response_event_seq_field: response.event_seq_field,
        };
        events.push(
            SessionEventData::SessionMutationCommitted {
                receipt: receipt.clone(),
            }
            .into(),
        );
        self.commit_session_events(session_id, events).await?;
        let projected = {
            let mut state = self.state.write().await;
            let session = state.sessions.get_mut(session_id).ok_or_else(|| {
                crate::driver::rpc_error(
                    RpcErrorCode::SessionNotFound,
                    format!("session {session_id:?} was not found"),
                    serde_json::json!({"sessionId": session_id}),
                )
            })?;
            let projected = crate::state::ProjectedSessionMutationReceipt {
                receipt: receipt.clone(),
                state_event_seq: session.next_event_seq().saturating_sub(2),
            };
            session
                .mutation_receipts
                .insert(receipt.rpc_id.clone(), projected.clone());
            projected
        };
        Ok(projected.response())
    }
}

pub(crate) fn workspace_snapshot(workspace: &WorkspaceRecord) -> WorkspaceSnapshot {
    WorkspaceSnapshot {
        workspace_id: workspace.workspace_id.clone(),
        path: workspace.path.clone(),
        title: workspace.title.clone(),
        session_order: workspace.session_ids.clone(),
        created_at: workspace.created_at.clone(),
        updated_at: workspace.updated_at.clone(),
    }
}

pub(crate) fn settings_snapshot(namespace: &crate::state::SettingsNamespace) -> SettingsSnapshot {
    SettingsSnapshot {
        namespace: namespace.ns.clone(),
        user: namespace.user.clone(),
        value: namespace.value.clone(),
        revision: namespace.revision,
    }
}

pub(crate) fn control_error(error: ControlError) -> RpcError {
    RpcError::internal(format!("host control persistence failed: {error}"))
}

fn control_conflict(rpc_id: &RpcId, message: &str) -> RpcError {
    crate::driver::rpc_error(
        RpcErrorCode::SessionConflict,
        message,
        serde_json::json!({"rpcId": rpc_id.as_str()}),
    )
}

//! Session export adapter.

use serde_json::json;
use xharness_api::{RpcError, RpcErrorCode, SessionExport};

use crate::{
    driver::{agent_runtime_error, rpc_error},
    BasicHost,
};

pub(super) async fn session(host: &BasicHost, session_id: &str) -> Result<SessionExport, RpcError> {
    let state = host.state.read().await;
    let session = state.sessions.get(session_id).ok_or_else(|| {
        rpc_error(
            RpcErrorCode::SessionNotFound,
            format!("session {session_id:?} was not found"),
            json!({"sessionId": session_id}),
        )
    })?;
    let mut exported =
        serde_json::to_value(session).map_err(|error| RpcError::internal(error.to_string()))?;
    drop(state);
    if let Some(source) = host
        .agent_runtime
        .authoritative_session(session_id)
        .await
        .map_err(agent_runtime_error)?
    {
        exported["messages"] = serde_json::to_value(source.derive_messages())
            .map_err(|error| RpcError::internal(error.to_string()))?;
    }
    let bytes = serde_json::to_vec_pretty(&json!({
        "format": "xharness-session-export",
        "version": 1,
        "session": exported,
        "requestAudit": "full request snapshots remain in the state-directory audit archive",
    }))
    .map_err(|error| RpcError::internal(format!("could not encode session: {error}")))?;
    Ok(SessionExport::json(format!("{session_id}.json"), bytes))
}

//! UI-only workspace memory adapter; no model tool or arbitrary disk path.
use super::{bad_request, require_object, required_string};
use crate::BasicHost;
use serde_json::Value;
use xharness_api::{RpcError, RpcId};

pub(super) async fn call(host: &BasicHost, id: RpcId, payload: &Value) -> Result<Value, RpcError> {
    let object = require_object(payload)?;
    let action = required_string(payload, "action")?;
    let scopes = ["sessionId", "workspaceId"]
        .into_iter()
        .filter(|key| object.contains_key(*key))
        .collect::<Vec<_>>();
    let global = match object.get("scope") {
        Some(Value::String(scope)) if scope == "global" => true,
        None => false,
        Some(Value::String(scope)) if scope == "workspace" => false,
        _ => return Err(bad_request("scope must be global or workspace")),
    };
    if global {
        if !scopes.is_empty() {
            return Err(bad_request(
                "global memory must not include workspace/session selectors",
            ));
        }
    } else if scopes.len() != 1 || object[scopes[0]].as_str().is_none_or(str::is_empty) {
        return Err(bad_request(
            "select exactly one nonempty sessionId or workspaceId",
        ));
    }

    let fields: &[&str] = match action.as_str() {
        "view" => &[],
        "save" => &["content", "version"],
        "clear" => &["version"],
        "configure" => &["mode", "settingsVersion"],
        _ => return Err(bad_request("unknown memory action")),
    };
    if object.keys().any(|key| {
        !["action", "scope", "sessionId", "workspaceId"].contains(&key.as_str())
            && !fields.contains(&key.as_str())
    }) {
        return Err(bad_request("unknown memory field"));
    }
    // Serialize Settings mutations/read versions, not the Host state lock. The
    // model uses FsService CAS independently. Receipts store hashes, not notes.
    let _guard = host.control_gate.lock().await;
    if action != "view" {
        if let Some(value) = host
            .replay_control_receipt_named(&id, "workspace/memory", payload)
            .await?
        {
            return Ok(value);
        }
    }
    let scope = if global {
        crate::memory::MemoryScope::Global
    } else {
        crate::memory::MemoryScope::Workspace(host.memory_cwd(payload).await.map_err(bad_request)?)
    };
    if action == "view" {
        return host.memory_view(scope).await.map_err(RpcError::internal);
    }
    let response = host
        .memory_update(scope, &action, payload)
        .await
        .map_err(bad_request)?;
    // Files and the control log are separate stores. A response lost between
    // write and receipt is recoverable only for identical desired content; a
    // changed document is rejected rather than overwritten on retry.
    host.commit_control_mutation_named(&id, "workspace/memory", payload, vec![], response)
        .await
}

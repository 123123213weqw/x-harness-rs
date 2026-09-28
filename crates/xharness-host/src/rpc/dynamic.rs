//! Explicit compatibility boundary for non-catalogued dynamic RPC endpoints.

use serde_json::Value;
use xharness_api::{RpcError, RpcId};

use crate::BasicHost;

use super::{commands, goal, host};

pub(super) async fn call(
    host_backend: &BasicHost,
    rpc_id: RpcId,
    endpoint: &str,
    payload: &Value,
) -> Option<Result<Option<Value>, RpcError>> {
    let result = match endpoint {
        "session.requestSnapshot" => host::request_snapshot(host_backend, payload)
            .await
            .map(Some),
        "commands/list" => commands::list(host_backend, payload).await.map(Some),
        "commands/execute" => commands::execute(host_backend, payload).await,
        name if name.starts_with("plugins/") => {
            let backend = host_backend.plugins.get();
            match backend {
                Some(backend) => backend
                    .call(name, payload)
                    .await
                    .map(Some)
                    .map_err(|message| RpcError::bad_request(message, serde_json::json!([]))),
                None => Err(RpcError::internal("plugin backend is not installed")),
            }
        }
        // The shipped Web client mutates Goals through namespaced remotes.
        // Every other upstream namespace stays unmounted on purpose.
        "goals/create" | "goals/edit" | "goals/pause" | "goals/resume" | "goals/complete"
        | "goals/clear" => goal::remote(host_backend, rpc_id, endpoint, payload)
            .await
            .map(Some),
        _ => return None,
    };
    Some(result)
}

//! Thin existing-transport adapter; UI and Agent tool share the application service.
use crate::{swarm_tasks::service, BasicHost};
use serde_json::Value;
use xharness_api::{RpcError, RpcId};

pub(super) async fn call(
    host: &BasicHost,
    rpc_id: RpcId,
    payload: &Value,
) -> Result<Value, RpcError> {
    let request = serde_json::from_value(payload.clone())
        .map_err(|e| super::bad_request(format!("invalid task-board request: {e}")))?;
    service::execute(host, rpc_id, request, payload).await
}

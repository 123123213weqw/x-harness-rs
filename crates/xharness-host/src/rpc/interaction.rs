//! Client-response routing for approvals and deferred questions.

use serde_json::Value;
use tokio::sync::oneshot;
use xharness_api::{ClientResponse, ReceiptRejection, RpcReceipt, RpcResult};
use xharness_core::LoopCommand;

use crate::{
    state::{DriverCommand, PendingResponse},
    BasicHost,
};

pub(super) async fn respond(host: &BasicHost, response: ClientResponse) -> RpcReceipt {
    let rpc_id = response.rpc_id.as_str().to_owned();
    let pending = host.state.read().await.pending.get(&rpc_id).cloned();
    let Some(pending) = pending else {
        return host.questions.respond(response).await;
    };
    match pending {
        PendingResponse::Approval {
            session_id,
            approval_id,
            call_id,
            tool_name: _,
            control,
        } => {
            let value = match response.result {
                RpcResult::Success { value: Some(value) } => value,
                _ => {
                    return RpcReceipt::Rejected {
                        reason: ReceiptRejection::BadResponse,
                    };
                }
            };
            if value.get("sessionId").and_then(Value::as_str) != Some(&session_id)
                || value.get("approvalId").and_then(Value::as_str) != Some(&approval_id)
            {
                return RpcReceipt::Rejected {
                    reason: ReceiptRejection::BadResponse,
                };
            }
            let command = match value.get("outcome").and_then(Value::as_str) {
                Some("allowed-once") => LoopCommand::ApproveTool {
                    call_id: call_id.clone(),
                },
                Some("rejected") => LoopCommand::RejectTool {
                    call_id: call_id.clone(),
                    reason: "rejected by user".to_owned(),
                },
                _ => {
                    return RpcReceipt::Rejected {
                        reason: ReceiptRejection::BadResponse,
                    };
                }
            };
            let (acknowledgement, accepted) = oneshot::channel();
            if control
                .send(DriverCommand {
                    command,
                    input_metadata: None,
                    acknowledgement,
                })
                .await
                .is_err()
                || !matches!(accepted.await, Ok(Ok(())))
            {
                return RpcReceipt::Rejected {
                    reason: ReceiptRejection::NotPending,
                };
            }
            host.state.write().await.pending.remove(&rpc_id);
            RpcReceipt::Accepted
        }
    }
}

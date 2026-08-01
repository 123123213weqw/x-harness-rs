//! Client-response routing for approvals and deferred questions.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use serde_json::Value;
use tokio::sync::oneshot;
use xharness_api::{ClientResponse, ReceiptRejection, RpcReceipt, RpcResult};
use xharness_core::LoopCommand;

use crate::{
    state::{DriverCommand, PendingResponse},
    BasicHost,
};

pub(super) async fn respond(host: &BasicHost, response: ClientResponse) -> RpcReceipt {
    let pending = host
        .state
        .read()
        .await
        .pending
        .get(response.rpc_id.as_str())
        .cloned();
    match pending {
        Some(pending) => respond_approval(host, response, pending, None).await,
        None => host.questions.respond(response).await,
    }
}

pub(crate) async fn respond_review(
    host: &BasicHost,
    response: ClientResponse,
    user_request_sha256: String,
) -> RpcReceipt {
    let pending = host
        .state
        .read()
        .await
        .pending
        .get(response.rpc_id.as_str())
        .cloned();
    let Some(pending) = pending else {
        return RpcReceipt::Rejected {
            reason: ReceiptRejection::NotPending,
        };
    };
    respond_approval(host, response, pending, Some(user_request_sha256)).await
}

async fn respond_approval(
    host: &BasicHost,
    response: ClientResponse,
    pending: PendingResponse,
    reviewed_scope: Option<String>,
) -> RpcReceipt {
    let rpc_id = response.rpc_id.as_str().to_owned();
    match pending {
        PendingResponse::Approval {
            session_id,
            approval_id,
            call_id,
            tool_name: _,
            control,
            deciding,
            ..
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
            let command = if let Some(user_request_sha256) = reviewed_scope {
                LoopCommand::ReviewToolDecision {
                    call_id: call_id.clone(),
                    approved: value.get("outcome").and_then(Value::as_str) == Some("allowed-once"),
                    user_request_sha256,
                }
            } else {
                command
            };
            // Shared across cloned pending records. RAII releases even when a response
            // future is cancelled while awaiting the driver acknowledgement.
            let Some(mut claim) = DecisionClaim::acquire(deciding) else {
                return RpcReceipt::Rejected {
                    reason: ReceiptRejection::NotPending,
                };
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
            claim.commit();
            host.state.write().await.pending.remove(&rpc_id);
            RpcReceipt::Accepted
        }
    }
}

struct DecisionClaim {
    deciding: Arc<AtomicBool>,
    committed: bool,
}
impl DecisionClaim {
    fn acquire(deciding: Arc<AtomicBool>) -> Option<Self> {
        deciding
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| Self {
                deciding,
                committed: false,
            })
    }
    fn commit(&mut self) {
        self.committed = true;
    }
}
impl Drop for DecisionClaim {
    fn drop(&mut self) {
        if !self.committed {
            self.deciding.store(false, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepted_decision_stays_claimed_for_stale_pending_clones() {
        let deciding = Arc::new(AtomicBool::new(false));
        let mut claim = DecisionClaim::acquire(deciding.clone()).unwrap();
        claim.commit();
        drop(claim);
        assert!(DecisionClaim::acquire(deciding).is_none());
    }

    #[tokio::test]
    async fn cancelled_response_does_not_lock_out_a_later_manual_answer() {
        use tokio::sync::mpsc;
        use xharness_api::{ClientResponseKind, RpcId};
        let host = BasicHost::new(
            crate::HostConfig::new(std::env::temp_dir()),
            None,
            Arc::new(crate::NoTools),
        );
        let (control, mut commands) = mpsc::channel(2);
        let deciding = Arc::new(AtomicBool::new(false));
        host.state.write().await.pending.insert(
            "approval".into(),
            PendingResponse::Approval {
                session_id: "session".into(),
                approval_id: "appr".into(),
                call_id: "call".into(),
                tool_name: "bash".into(),
                control,
                reviewing: false,
                reason: "manual".into(),
                deciding: deciding.clone(),
            },
        );
        let response = ClientResponse {
            kind: ClientResponseKind::ClientResponse,
            rpc_id: RpcId::new("approval"),
            result: RpcResult::success(
                serde_json::json!({"sessionId":"session","approvalId":"appr","outcome":"rejected"}),
            ),
        };
        let first = tokio::spawn({
            let host = host.clone();
            let response = response.clone();
            async move { respond(&host, response).await }
        });
        let first_command = commands.recv().await.unwrap();
        assert!(deciding.load(Ordering::SeqCst));
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        drop(first_command); // Simulate an acknowledgement lost with the worker.
        assert!(!deciding.load(Ordering::SeqCst));
        let second = tokio::spawn({
            let host = host.clone();
            async move { respond(&host, response).await }
        });
        let command = commands.recv().await.unwrap();
        command.acknowledgement.send(Ok(())).unwrap();
        assert!(matches!(second.await.unwrap(), RpcReceipt::Accepted));
        assert!(host.state.read().await.pending.is_empty());
        assert!(deciding.load(Ordering::SeqCst)); // Stale clones remain claimed after success.
    }

    #[tokio::test]
    async fn cancelled_ack_wait_releases_decision_claim() {
        let deciding = Arc::new(AtomicBool::new(false));
        let (started, ready) = oneshot::channel();
        let task = tokio::spawn({
            let deciding = deciding.clone();
            async move {
                let _claim = DecisionClaim::acquire(deciding).unwrap();
                started.send(()).unwrap();
                std::future::pending::<()>().await;
            }
        });
        ready.await.unwrap();
        assert!(DecisionClaim::acquire(deciding.clone()).is_none());
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(DecisionClaim::acquire(deciding).is_some());
    }
}

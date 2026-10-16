//! Exact pending-instance responses. Does not expose the desktop /api/respond.
use crate::{state::PendingResponse, BasicHost};
use std::sync::OnceLock;
use xharness_api::{
    ClientResponse, ClientResponseKind, MuxFrame, RpcError, RpcId, RpcReceipt, RpcResult,
    ScopedInteraction, ScopedInteractionAnswer, ScopedInteractionReceipt,
};
pub(crate) fn nonce(cell: &OnceLock<String>) -> Result<String, RpcError> {
    if let Some(value) = cell.get() {
        return Ok(value.clone());
    }
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes)
        .map_err(|_| RpcError::internal("interaction identity unavailable"))?;
    let fresh = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let _ = cell.set(fresh);
    cell.get()
        .cloned()
        .ok_or_else(|| RpcError::internal("interaction identity unavailable"))
}
fn approval(id: &RpcId, p: &PendingResponse) -> Result<Option<ScopedInteraction>, RpcError> {
    let PendingResponse::Approval {
        session_id,
        approval_id,
        call_id,
        tool_name,
        reviewing,
        reason,
        scoped_nonce,
        deciding,
        ..
    } = p;
    // AI review policy stays unchanged: only the native manual/fallback state is answerable.
    if *reviewing || deciding.load(std::sync::atomic::Ordering::Acquire) {
        return Ok(None);
    }
    Ok(Some(ScopedInteraction {
        nonce: nonce(scoped_nonce)?,
        frame: MuxFrame::ApprovalRequested {
            session_id: session_id.clone(),
            approval_id: approval_id.clone(),
            call_id: Some(call_id.clone()),
            tool_name: tool_name.clone(),
            reason: Some(reason.clone()),
            reviewing: Some(false),
        }
        .into_server_request(id.clone()),
    }))
}
pub(super) async fn snapshot(
    host: &BasicHost,
    session: &str,
    id: &RpcId,
) -> Result<Option<ScopedInteraction>, RpcError> {
    let pending = host.state.read().await.pending.get(id.as_str()).cloned();
    if let Some(pending) = pending {
        let PendingResponse::Approval { session_id, .. } = &pending;
        if session_id != session {
            return Ok(None);
        }
        return approval(id, &pending);
    }
    host.questions.scoped_snapshot(session, id).await
}
pub(super) async fn answer(
    host: &BasicHost,
    session: &str,
    expected: ScopedInteraction,
    answer: ScopedInteractionAnswer,
) -> Result<ScopedInteractionReceipt, RpcError> {
    if !answer.is_bounded() {
        return Ok(ScopedInteractionReceipt::Invalid);
    }
    let pending = host
        .state
        .read()
        .await
        .pending
        .get(expected.frame.rpc_id.as_str())
        .cloned();
    if let Some(pending) = pending {
        let PendingResponse::Approval {
            session_id,
            approval_id,
            ..
        } = &pending;
        if session_id != session
            || approval(&expected.frame.rpc_id, &pending)?.as_ref() != Some(&expected)
        {
            return Ok(ScopedInteractionReceipt::Stale);
        }
        let ScopedInteractionAnswer::Approval { allowed } = answer else {
            return Ok(ScopedInteractionReceipt::Invalid);
        };
        let response = ClientResponse {
            kind: ClientResponseKind::ClientResponse,
            rpc_id: expected.frame.rpc_id,
            result: RpcResult::success(
                serde_json::json!({"sessionId":session,"approvalId":approval_id,
                "outcome":if allowed {"allowed-once"}else{"rejected"}}),
            ),
        };
        // Native DecisionClaim / driver call-id fencing remain the actual owner.
        return Ok(
            match super::interaction::respond_approval(host, response, pending, None).await {
                RpcReceipt::Accepted => ScopedInteractionReceipt::Accepted,
                _ => ScopedInteractionReceipt::Uncertain, // Lost acknowledgement cannot certify non-effect.
            },
        );
    }
    host.questions
        .respond_scoped(session, expected, answer)
        .await
}

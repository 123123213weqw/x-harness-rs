//! Subagent navigation and control RPC command service.
//! Delegation execution remains in the agent runtime; this module only adapts
//! the parent/child RPC contract onto durable session admission and control.

use serde_json::{json, Value};
use xharness_api::{RpcError, RpcErrorCode, RpcId};
use xharness_core::LoopCommand;

use crate::{driver::PromptAdmission, BasicHost};

use super::{prompt_fingerprint, required_array, required_string, rpc_error, visible_text};

impl BasicHost {
    pub(super) async fn subagent_list(&self, payload: &Value) -> Result<Value, RpcError> {
        let parent = required_string(payload, "parentSessionId")?;
        let state = self.state.read().await;
        let parent_available = state.sessions.contains_key(&parent);
        let entries = state
            .sessions
            .values()
            .filter(|session| session.parent_session_id.as_deref() == Some(&parent))
            .map(|session| {
                json!({
                    "kind": "child",
                    "id": session.session_id,
                    "mode": "continuable",
                    "activity": if session.running { "running" } else { "inactive" },
                    "hasChildren": state.sessions.values().any(|candidate| candidate.parent_session_id.as_deref() == Some(&session.session_id)),
                    "label": session.title.clone().unwrap_or_else(|| session.session_id.clone()),
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({"entries": entries, "parentAvailable": parent_available}))
    }

    pub(super) async fn subagent_history(&self, payload: &Value) -> Result<Value, RpcError> {
        self.authorize_child(payload).await?;
        let mut ordinary = payload.clone();
        ordinary.as_object_mut().expect("validated object").insert(
            "sessionId".to_owned(),
            json!(required_string(payload, "childSessionId")?),
        );
        self.session_history(&ordinary).await
    }

    pub(super) async fn subagent_prompt(
        &self,
        rpc_id: RpcId,
        payload: &Value,
    ) -> Result<Value, RpcError> {
        self.authorize_child(payload).await?;
        if required_string(payload, "mode")? != "continuable" {
            return Err(rpc_error(
                RpcErrorCode::SubagentNotResumable,
                "only continuable children accept prompts",
                json!({"childSessionId": required_string(payload, "childSessionId")?}),
            ));
        }
        let child = required_string(payload, "childSessionId")?;
        let content = required_array(payload, "content")?.clone();
        let fingerprint = prompt_fingerprint("continuable", &content, None);
        let _admission_guard = self.lock_admission(&child).await;
        if self
            .is_duplicate_admission(&child, rpc_id.as_str(), &fingerprint)
            .await?
        {
            return Ok(json!({"messageId": rpc_id.as_str()}));
        }
        let text = visible_text(&content);
        self.enqueue_prompt(PromptAdmission {
            rpc_id: rpc_id.clone(),
            session_id: child,
            mode: "queue".to_owned(),
            text,
            content,
            source: json!({"kind": "user", "rpcId": rpc_id.as_str()}),
            fingerprint: Some(fingerprint),
        })
        .await?;
        Ok(json!({"messageId": rpc_id.as_str()}))
    }

    pub(super) async fn subagent_interrupt(&self, payload: &Value) -> Result<Value, RpcError> {
        self.authorize_child(payload).await?;
        self.send_control(
            &required_string(payload, "childSessionId")?,
            LoopCommand::Cancel,
        )
        .await?;
        Ok(json!({"accepted": true}))
    }

    async fn authorize_child(&self, payload: &Value) -> Result<(), RpcError> {
        let parent = required_string(payload, "parentSessionId")?;
        let child = required_string(payload, "childSessionId")?;
        let state = self.state.read().await;
        if !state.sessions.contains_key(&parent) {
            return Err(rpc_error(
                RpcErrorCode::SubagentParentUnavailable,
                "parent session was not found",
                json!({"parentSessionId": parent}),
            ));
        }
        let record = state.sessions.get(&child).ok_or_else(|| {
            rpc_error(
                RpcErrorCode::SubagentNotFound,
                "child session was not found",
                json!({"parentSessionId": parent, "childSessionId": child}),
            )
        })?;
        if record.parent_session_id.as_deref() != Some(&parent) {
            return Err(rpc_error(
                RpcErrorCode::SubagentUnauthorized,
                "session is not a direct child of this parent",
                json!({"childSessionId": child}),
            ));
        }
        Ok(())
    }
}

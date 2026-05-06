//! Subagent navigation and control RPC adapter.
//!
//! Delegation execution remains in the runtime. Direct-child authorization and
//! navigation projection are pure decisions in `SubagentProcessor`.

use serde_json::{json, Value};
use xharness_api::{RpcError, RpcErrorCode, RpcId, RpcMethod};
use xharness_core::LoopCommand;

use crate::{
    driver::PromptAdmission,
    subagent_processor::{
        ChildAuthorizationError, SubagentProcessor, SubagentRecord, SubagentSnapshot,
    },
    BasicHost,
};

use super::{prompt_fingerprint, required_array, required_string, rpc_error, visible_text};

pub(super) async fn call(
    host: &BasicHost,
    rpc_id: RpcId,
    method: RpcMethod,
    payload: &Value,
) -> Result<Value, RpcError> {
    match method {
        RpcMethod::SubagentList => list(host, payload).await,
        RpcMethod::SubagentHistory => history(host, payload).await,
        RpcMethod::SubagentPrompt => prompt(host, rpc_id, payload).await,
        RpcMethod::SubagentInterrupt => interrupt(host, payload).await,
        _ => unreachable!("subagent adapter received non-subagent method {method}"),
    }
}

async fn list(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    let parent = required_string(payload, "parentSessionId")?;
    Ok(SubagentProcessor::list(&snapshot(host).await, &parent))
}

async fn history(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    authorize_child(host, payload).await?;
    let mut ordinary = payload.clone();
    ordinary.as_object_mut().expect("validated object").insert(
        "sessionId".to_owned(),
        json!(required_string(payload, "childSessionId")?),
    );
    super::session::history(host, &ordinary).await
}

async fn prompt(host: &BasicHost, rpc_id: RpcId, payload: &Value) -> Result<Value, RpcError> {
    authorize_child(host, payload).await?;
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
    let _admission_guard = host.lock_admission(&child).await;
    if super::turn::duplicate_admission(host, &child, rpc_id.as_str(), &fingerprint).await? {
        return Ok(json!({"messageId": rpc_id.as_str()}));
    }
    let text = visible_text(&content);
    host.enqueue_prompt(PromptAdmission {
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

async fn interrupt(host: &BasicHost, payload: &Value) -> Result<Value, RpcError> {
    authorize_child(host, payload).await?;
    super::turn::send_control(
        host,
        &required_string(payload, "childSessionId")?,
        LoopCommand::Cancel,
    )
    .await?;
    Ok(json!({"accepted": true}))
}

async fn authorize_child(host: &BasicHost, payload: &Value) -> Result<(), RpcError> {
    let parent = required_string(payload, "parentSessionId")?;
    let child = required_string(payload, "childSessionId")?;
    SubagentProcessor::authorize(&snapshot(host).await, &parent, &child).map_err(
        |error| match error {
            ChildAuthorizationError::ParentUnavailable => rpc_error(
                RpcErrorCode::SubagentParentUnavailable,
                "parent session was not found",
                json!({"parentSessionId": parent}),
            ),
            ChildAuthorizationError::ChildNotFound => rpc_error(
                RpcErrorCode::SubagentNotFound,
                "child session was not found",
                json!({"parentSessionId": parent, "childSessionId": child}),
            ),
            ChildAuthorizationError::Unauthorized => rpc_error(
                RpcErrorCode::SubagentUnauthorized,
                "session is not a direct child of this parent",
                json!({"childSessionId": child}),
            ),
        },
    )
}

async fn snapshot(host: &BasicHost) -> SubagentSnapshot {
    let state = host.state.read().await;
    SubagentSnapshot {
        sessions: state
            .sessions
            .values()
            .map(|session| {
                (
                    session.session_id.clone(),
                    SubagentRecord {
                        id: session.session_id.clone(),
                        parent_id: session.parent_session_id.clone(),
                        title: session.title.clone(),
                        running: session.running,
                    },
                )
            })
            .collect(),
    }
}

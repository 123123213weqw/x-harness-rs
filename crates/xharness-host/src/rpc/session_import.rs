//! External history admission only. The pure adapter owns source formats; the
//! regular create path owns publication, storage and recovery. No model call.
use super::{bad_request, session_lifecycle};
use crate::driver::rpc_error;
use crate::BasicHost;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;
use xharness_api::{protocol::SessionImportParams, RpcError, RpcErrorCode};
static PARSERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
use xharness_session_import::{parse, Source};

pub(super) async fn import(
    host: &BasicHost,
    payload: &Value,
    cancellation: &CancellationToken,
) -> Result<Value, RpcError> {
    let permit = PARSERS
        .try_acquire()
        .map_err(|_| bad_request("session import is busy; retry shortly"))?;
    let request: SessionImportParams = serde_json::from_value(payload.clone())
        .map_err(|_| bad_request("invalid session.import request"))?;
    if request.cwd.is_some() && request.workspace_id.is_some() {
        return Err(bad_request("choose cwd or workspaceId, not both"));
    }
    let source = match request.source.as_str() {
        "claude-code" => Source::ClaudeCode,
        "codex" => Source::Codex,
        _ => return Err(bad_request("unsupported session import source")),
    };
    let data = request.jsonl.clone();
    let transcript = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        parse(source, &data)
    })
    .await
    .map_err(|e| RpcError::internal(e.to_string()))?
    .map_err(|e| bad_request(e.to_string()))?;
    if cancellation.is_cancelled() {
        return Err(rpc_error(
            RpcErrorCode::Cancelled,
            "session import cancelled",
            json!({}),
        ));
    }
    let mut response = json!({"title":transcript.title,"messages":transcript.messages.len(),"tools":transcript.tools,"warnings":transcript.warnings,"preview":transcript.messages.iter().take(6).map(|m| json!({"role":m.role.as_str(),"content":m.content.chars().take(1200).collect::<String>()})).collect::<Vec<_>>()});
    if request.preview {
        return Ok(response);
    }
    // Exact-content retry dedupe, including the chosen destination. No source
    // session ID can impersonate an existing native session or select a cwd.
    let identity = json!([
        request.source,
        request.jsonl,
        request.cwd,
        request.workspace_id
    ]);
    let hash = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&identity).map_err(|e| RpcError::internal(e.to_string()))?
        )
    );
    let mut create = json!({"sessionId":format!("import-{hash}")});
    if let Some(cwd) = request.cwd {
        create["cwd"] = json!(cwd);
    }
    if let Some(workspace) = request.workspace_id {
        create["workspaceId"] = json!(workspace);
    }
    let result = session_lifecycle::create_seeded(host, &create, true, Some(&transcript)).await?;
    response["sessionId"] = result["sessionId"].clone();
    Ok(response)
}

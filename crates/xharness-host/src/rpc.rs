use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use async_trait::async_trait;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;
use xharness_api::{
    ApiBackend, ClientResponse, EventStream, RpcError, RpcErrorCode, RpcId, RpcMethod, RpcReceipt,
    RpcResult, ServerRequest, SessionExport,
};
use xharness_session::{
    ApprovalPolicy, EventData as SessionEventData, SessionEvent, SessionSandboxMode,
};

use crate::{
    driver::rpc_error,
    runtime::AgentRuntimeError,
    state::{now_ms, PendingResponse},
    BasicHost,
};

mod commands;
mod credentials;
mod dynamic;
mod export;
mod goal;
mod host;
mod interaction;
mod model;
mod preset;
mod session;
pub(crate) mod session_lifecycle;
mod settings;
mod subagent;
pub(crate) mod turn;
mod workspace;

const DEFAULT_HISTORY_MESSAGES: usize = 50;
const MAX_HISTORY_MESSAGES: usize = 500;

#[async_trait]
impl ApiBackend for BasicHost {
    async fn call(
        &self,
        rpc_id: RpcId,
        method: RpcMethod,
        payload: Value,
        cancellation: CancellationToken,
    ) -> RpcResult {
        let result = match method {
            method @ (RpcMethod::SessionList
            | RpcMethod::SessionSearch
            | RpcMethod::SessionHistory
            | RpcMethod::SessionModels) => {
                session::call_read(self, method, &payload, &cancellation).await
            }
            RpcMethod::SessionCreate => session_lifecycle::create(self, &payload).await,
            RpcMethod::SessionSelectModel => {
                session_lifecycle::select_model(self, rpc_id, &payload).await
            }
            RpcMethod::SessionRename => session_lifecycle::rename(self, rpc_id, &payload).await,
            RpcMethod::SessionFork => session_lifecycle::fork(self, &payload).await,
            RpcMethod::SessionPrompt => turn::prompt(self, rpc_id, &payload).await,
            RpcMethod::SessionAttachment => turn::attachment(self, &payload).await,
            RpcMethod::SessionUpdateQueue => turn::update_queue(self, &payload).await,
            RpcMethod::SessionCancel => turn::cancel(self, &payload).await,
            method @ (RpcMethod::SubagentList
            | RpcMethod::SubagentHistory
            | RpcMethod::SubagentPrompt
            | RpcMethod::SubagentInterrupt) => subagent::call(self, rpc_id, method, &payload).await,
            RpcMethod::HostDescribe => host::describe(self, &payload).await,
            RpcMethod::HostPickDirectory => host::pick_directory(self, &payload).await,
            RpcMethod::HostListDirectory => host::list_directory(self, &payload).await,
            RpcMethod::HostCreateDirectory => host::create_directory(self, &payload).await,
            RpcMethod::HostOpenPath => host::open_path(self, &payload).await,
            method @ (RpcMethod::WorkspaceList
            | RpcMethod::WorkspaceCreate
            | RpcMethod::WorkspaceRename
            | RpcMethod::WorkspaceDelete
            | RpcMethod::WorkspaceInsertBefore
            | RpcMethod::WorkspaceInsertSessionBefore
            | RpcMethod::WorkspaceArchiveSession) => {
                workspace::call(self, rpc_id, method, &payload).await
            }
            RpcMethod::SkillList => host::skill_list(self, &payload).await,
            method @ (RpcMethod::AgentPresetList
            | RpcMethod::AgentPresetSelect
            | RpcMethod::AgentPresetRead
            | RpcMethod::AgentPresetCopy
            | RpcMethod::AgentPresetOpenDocument
            | RpcMethod::AgentPresetRemove) => preset::call(self, rpc_id, method, &payload).await,
            method @ (RpcMethod::GoalCreate
            | RpcMethod::GoalEdit
            | RpcMethod::GoalPause
            | RpcMethod::GoalResume
            | RpcMethod::GoalComplete
            | RpcMethod::GoalClear) => goal::call(self, rpc_id, method, &payload).await,
            method @ (RpcMethod::SettingsDescribe
            | RpcMethod::SettingsOpenDocument
            | RpcMethod::SettingsUpdate
            | RpcMethod::SettingsReplace
            | RpcMethod::SettingsMutate) => settings::call(self, rpc_id, method, &payload).await,
            method @ (RpcMethod::CredentialsDescribe
            | RpcMethod::CredentialsSet
            | RpcMethod::CredentialsUnset) => credentials::call(self, method, &payload).await,
            method @ (RpcMethod::LlmProviders
            | RpcMethod::LlmModels
            | RpcMethod::LlmDiscoverModels) => model::call(self, method, &payload).await,
        };
        match result {
            Ok(value) => RpcResult::success(value),
            Err(error) => RpcResult::failure(error),
        }
    }

    async fn call_dynamic(
        &self,
        rpc_id: RpcId,
        endpoint: &str,
        payload: Value,
        _cancellation: CancellationToken,
    ) -> Option<RpcResult> {
        let result = dynamic::call(self, rpc_id, endpoint, &payload).await?;
        Some(match result {
            Ok(Some(value)) => RpcResult::success(value),
            Ok(None) => RpcResult::Success { value: None },
            Err(error) => RpcResult::failure(error),
        })
    }

    async fn respond(&self, response: ClientResponse) -> RpcReceipt {
        interaction::respond(self, response).await
    }

    fn mux_events(&self) -> EventStream {
        let mut receiver = self.event_gateway.subscribe_mux();
        let mut question_receiver = self.questions.subscribe();
        let state = Arc::clone(&self.state);
        let next_id = Arc::clone(&self.next_id);
        let questions = Arc::clone(&self.questions);
        Box::pin(async_stream::stream! {
            let mut baseline = {
            let state = state.read().await;
            let mut frames = Vec::new();
            for session in state.sessions.values() {
                frames.push(ServerRequest::new(
                    RpcId::new(mint_stream_id(&next_id, "subscribed")),
                    "session/subscribed",
                    json!({
                        "type": "session/subscribed",
                        "sessionId": session.session_id,
                        "lastSeq": session.last_event_seq_i64(),
                    }),
                ));
                for (key, value) in session
                    .projection_values()
                    .as_object()
                    .expect("projection values are an object")
                {
                    frames.push(ServerRequest::new(
                        RpcId::new(mint_stream_id(&next_id, "projection")),
                        "session/projection",
                        json!({
                            "type": "session/projection",
                            "sessionId": session.session_id,
                            "key": key,
                            "value": value,
                            "seq": session.last_event_seq_i64(),
                        }),
                    ));
                }
                let items = session.queue_view();
                if !items.is_empty() {
                    frames.push(ServerRequest::new(
                        RpcId::new(mint_stream_id(&next_id, "queue")),
                        "session/queue",
                        json!({
                            "type": "session/queue",
                            "sessionId": session.session_id,
                            "items": items,
                        }),
                    ));
                }
            }
            for (rpc_id, pending) in &state.pending {
                match pending {
                    PendingResponse::Approval {
                        session_id,
                        approval_id,
                        call_id,
                        tool_name,
                        ..
                    } => frames.push(ServerRequest::new(
                        RpcId::new(rpc_id),
                        "approval/requested",
                        json!({
                            "type": "approval/requested",
                            "sessionId": session_id,
                            "approvalId": approval_id,
                            "toolName": tool_name,
                            "callId": call_id,
                            "reason": "This tool requires explicit approval.",
                        }),
                    )),
                }
            }
            frames
            };
            baseline.extend(questions.baseline().await);
            for frame in baseline {
                yield frame;
            }
            loop {
                let received = tokio::select! {
                    frame = receiver.recv() => frame,
                    frame = question_receiver.recv() => frame,
                };
                match received {
                    Ok(frame) => yield frame,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        yield ServerRequest::new(
                            RpcId::new("stream-lagged"),
                            "stream/error",
                            json!({
                                "type": "stream/error",
                                "error": {
                                    "code": "internal",
                                    "message": format!("mux stream lagged by {skipped} frames; refetch history"),
                                    "details": {},
                                },
                            }),
                        );
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        })
    }

    fn host_events(&self) -> EventStream {
        let mut receiver = self.event_gateway.subscribe_host();
        Box::pin(async_stream::stream! {
            loop {
                match receiver.recv().await {
                    Ok(frame) => yield frame,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        yield ServerRequest::new(
                            RpcId::new("host-stream-lagged"),
                            "stream/error",
                            json!({
                                "type": "stream/error",
                                "error": {
                                    "code": "internal",
                                    "message": format!("host stream lagged by {skipped} frames; refetch host state"),
                                    "details": {},
                                },
                            }),
                        );
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        })
    }

    async fn export_session(
        &self,
        session_id: &str,
        _cancellation: CancellationToken,
    ) -> Result<SessionExport, RpcError> {
        export::session(self, session_id).await
    }
}

pub(crate) fn prompt_fingerprint(
    mode: &str,
    content: &[Value],
    client_time_zone: Option<&str>,
) -> String {
    let canonical = json!({
        "version": 1,
        "mode": mode,
        "content": content,
        "clientTimeZone": client_time_zone,
    });
    let encoded = serde_json::to_vec(&canonical).expect("JSON value serialization cannot fail");
    let digest = Sha256::digest(encoded);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(64);
    for byte in digest {
        output.push(HEX[usize::from(byte >> 4)] as char);
        output.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    output
}

fn require_object(value: &Value) -> Result<&Map<String, Value>, RpcError> {
    value
        .as_object()
        .ok_or_else(|| bad_request("payload must be a JSON object"))
}

fn required_string(value: &Value, field: &str) -> Result<String, RpcError> {
    require_object(value)?
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| bad_request(format!("{field} must be a non-empty string")))
}

fn optional_string(value: &Value, field: &str) -> Result<Option<String>, RpcError> {
    match require_object(value)?.get(field) {
        None => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
        Some(_) => Err(bad_request(format!(
            "{field}, when present, must be a non-empty string"
        ))),
    }
}

fn optional_u64(value: &Value, field: &str) -> Result<Option<u64>, RpcError> {
    match require_object(value)?.get(field) {
        None => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| bad_request(format!("{field} must be a non-negative integer"))),
    }
}

fn required_array<'a>(value: &'a Value, field: &str) -> Result<&'a Vec<Value>, RpcError> {
    require_object(value)?
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| bad_request(format!("{field} must be an array")))
}

fn nonempty(value: String, field: &str) -> Result<String, RpcError> {
    if value.trim().is_empty() {
        Err(bad_request(format!("{field} must not be blank")))
    } else {
        Ok(value)
    }
}

fn bad_request(message: impl Into<String>) -> RpcError {
    RpcError::bad_request(message, json!([]))
}

fn session_not_found(session_id: &str) -> RpcError {
    rpc_error(
        RpcErrorCode::SessionNotFound,
        format!("session {session_id:?} was not found"),
        json!({"sessionId": session_id}),
    )
}

fn canonical_directory(path: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("select a filesystem directory, not the location overview".to_owned());
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| format!("could not resolve directory {path:?}: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("path {path:?} is not a directory"));
    }
    Ok(canonical.to_string_lossy().into_owned())
}

fn directory_roots() -> Result<Vec<std::path::PathBuf>, String> {
    #[cfg(windows)]
    {
        // Do not stat every drive: disconnected mapped drives and empty media
        // should not delay the overview. Read errors belong to the chosen path.
        xharness_win32::logical_drive_roots().map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        Ok(vec![
            std::path::PathBuf::from("/"),
            #[cfg(target_os = "macos")]
            std::path::PathBuf::from("/Volumes"),
        ])
    }
}

fn valid_directory_name(name: &str) -> bool {
    // Path::join replaces the parent for absolute/prefixed paths on Windows.
    // Validate a component, not just the absence of slash characters.
    if name.trim().is_empty() || name.contains(['/', '\\', '\0']) {
        return false;
    }
    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(std::path::Component::Normal(_)))
        || components.next().is_some()
    {
        return false;
    }
    #[cfg(windows)]
    {
        // Reject Win32 aliases even with a verbatim canonical parent path:
        // folders must remain accessible to Explorer and ordinary tools.
        if name.ends_with(['.', ' ']) || name.chars().any(|c| c < ' ' || "<>:\"|?*".contains(c)) {
            return false;
        }
        let stem = name
            .split('.')
            .next()
            .unwrap_or(name)
            .trim_end()
            .to_uppercase();
        if matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) {
            return false;
        }
        if let Some(suffix) = stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
        {
            if matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            ) {
                return false;
            }
        }
    }
    true
}

fn breadcrumb_entries(path: &Path) -> Vec<Value> {
    let mut current = PathBuf::new();
    path.components()
        .filter_map(|component| {
            current.push(component.as_os_str());
            // A Windows drive prefix (e.g. C: or \\?\C:) is not a complete
            // absolute directory. Emit it together with the following root.
            if matches!(component, std::path::Component::Prefix(_)) {
                return None;
            }
            let display = current.to_string_lossy().into_owned();
            let name = component.as_os_str().to_string_lossy();
            Some(json!({
                "name": if matches!(component, std::path::Component::RootDir) || name.is_empty() { display.clone() } else { name.into_owned() },
                "path": display,
                "hidden": false,
            }))
        })
        .collect()
}

fn visible_text(content: &[Value]) -> String {
    content
        .iter()
        .filter_map(|block| {
            (block.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| block.get("text").and_then(Value::as_str))
                .flatten()
        })
        .collect::<String>()
}

fn permission_command_input(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("/permission")?;
    if rest.is_empty() || matches!(rest.chars().next(), Some(' ' | '\t' | '\n' | '\r')) {
        Some(rest)
    } else {
        None
    }
}

fn plan_command_input(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("/plan")?;
    if rest.is_empty() || matches!(rest.chars().next(), Some(' ' | '\t' | '\n' | '\r')) {
        Some(rest)
    } else {
        None
    }
}

pub(crate) fn permission_events(preset: crate::PermissionPreset) -> Vec<SessionEvent> {
    vec![
        SessionEventData::PermissionPreset {
            preset: preset.as_str().to_owned(),
        }
        .into(),
        SessionEventData::SandboxMode {
            mode: match preset {
                crate::PermissionPreset::WorkspaceWrite => SessionSandboxMode::WorkspaceWrite,
                crate::PermissionPreset::DangerFullAccess => SessionSandboxMode::DangerFullAccess,
            },
            source: None,
        }
        .into(),
        SessionEventData::ApprovalPolicy {
            policy: match preset {
                crate::PermissionPreset::WorkspaceWrite => ApprovalPolicy::Ask,
                crate::PermissionPreset::DangerFullAccess => ApprovalPolicy::Never,
            },
            source: None,
        }
        .into(),
    ]
}

fn queue_item_not_found(item_id: &str, error: AgentRuntimeError) -> RpcError {
    rpc_error(
        RpcErrorCode::QueueItemNotFound,
        "queued item is no longer pending",
        json!({"itemId": item_id, "reason": error.to_string()}),
    )
}

fn mint_stream_id(next_id: &AtomicU64, prefix: &str) -> String {
    let ordinal = next_id.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{ordinal}", now_ms())
}

#[cfg(test)]
mod edit_admission_tests {
    use super::*;
    use crate::{HostConfig, NoTools};

    #[tokio::test]
    async fn edit_admission_rejects_running_invalid_flags_and_text_only_models() {
        let root = std::env::temp_dir().join(format!("xh-edit-admission-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let host = BasicHost::new(HostConfig::new(&root), None, Arc::new(NoTools));
        let created = session_lifecycle::create(&host, &json!({"cwd":root}))
            .await
            .unwrap();
        let id = created["sessionId"].as_str().unwrap();
        host.state
            .write()
            .await
            .sessions
            .get_mut(id)
            .unwrap()
            .running = true;
        let error = turn::prompt(
            &host,
            RpcId::new("edit-running"),
            &json!({
                "sessionId":id,"mode":"queue","requireIdle":true,
                "content":[{"type":"text","text":"draft"}]
            }),
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("started running"));
        assert!(host.state.read().await.sessions[id].queue.is_empty());
        let error = turn::prompt(
            &host,
            RpcId::new("edit-invalid"),
            &json!({
                "sessionId":id,"mode":"queue","requireIdle":"true","content":[]
            }),
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("boolean"));
        {
            let mut state = host.state.write().await;
            let session = state.sessions.get_mut(id).unwrap();
            session.running = false;
            let provider = session.model.provider.clone();
            let model = session.model.model.clone();
            state
                .settings
                .get_mut(crate::MODEL_SETTINGS_NAMESPACE)
                .unwrap()
                .value = json!({
                "providers":{provider:{"models":[{"id":model,"imageInput":false}]}}
            });
        }
        let error = turn::prompt(
            &host,
            RpcId::new("edit-no-vision"),
            &json!({
                "sessionId":id,"mode":"queue","requireIdle":true,
                "content":[{"type":"image_ref","attachmentId":"missing"}]
            }),
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("does not support images"));
        assert!(host.state.read().await.sessions[id].queue.is_empty());
        let _ = std::fs::remove_dir_all(root);
    }
}

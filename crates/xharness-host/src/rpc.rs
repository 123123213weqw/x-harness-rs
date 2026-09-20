use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use xharness_api::{
    ApiBackend, ClientResponse, EventStream, RpcError, RpcId, RpcMethod, RpcReceipt, RpcResult,
    ServerRequest, SessionExport,
};

use crate::{driver::rpc_error, state::PendingResponse, BasicHost};

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
mod wire;
mod workspace;

use wire::*;
pub(crate) use wire::{permission_events, prompt_fingerprint};

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

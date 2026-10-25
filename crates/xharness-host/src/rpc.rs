use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use xharness_api::{
    ApiBackend, ClientResponse, EventStream, RpcError, RpcId, RpcMethod, RpcReceipt, RpcResult,
    ServerRequest, SessionExport,
};

use crate::{driver::rpc_error, state::PendingResponse, BasicHost};

mod automation;
mod commands;
mod credentials;
mod dynamic;
mod export;
mod goal;
mod host;
mod interaction;
mod jobs;
mod scoped_attachment;
mod scoped_automation;
mod scoped_catalogue;
mod scoped_events;
pub(crate) mod scoped_interaction;
mod session_plan;
pub(crate) use interaction::respond_review;
mod memory;
mod model;
mod preset;
mod session;
mod session_delete;
mod session_import;
pub(crate) mod session_lifecycle;
mod settings;
mod subagent;
mod swarm;
mod swarm_tasks;
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
        // A catalogue entry is not a recovered Agent. Hydrate exactly once
        // before mutations or runtime reads. Presentation-only reads own a
        // source-validated fast path and fall back to this same recovery gate.
        let target = if matches!(
            method,
            RpcMethod::SubagentHistory | RpcMethod::SubagentPrompt | RpcMethod::SubagentInterrupt
        ) {
            payload.get("childSessionId").and_then(Value::as_str)
        } else {
            payload.get("sessionId").and_then(Value::as_str)
        };
        // Permanent deletion verifies cold work read-only before recovery can
        // activate it; its owner hydrates only the verified idle closure.
        let display_read = matches!(method, RpcMethod::SessionHistory | RpcMethod::SkillList)
            || (method == RpcMethod::SessionModels
                && payload.get("refreshCapabilities").and_then(Value::as_bool) != Some(true));
        if let Some(session_id) =
            target.filter(|_| method != RpcMethod::SessionDelete && !display_read)
        {
            if let Err(error) = self.hydrate_session(session_id).await {
                return RpcResult::failure(rpc_error(
                    xharness_api::RpcErrorCode::Internal,
                    format!("session recovery failed: {error}"),
                    json!({"sessionId": session_id}),
                ));
            }
        }
        let result = match method {
            method @ (RpcMethod::SessionList
            | RpcMethod::SessionSearch
            | RpcMethod::SessionHistory
            | RpcMethod::SessionModels) => {
                session::call_read(self, method, &payload, &cancellation).await
            }
            RpcMethod::SessionImport => session_import::import(self, &payload, &cancellation).await,
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
            RpcMethod::SessionDelete => session_delete::delete(self, rpc_id, &payload).await,
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
            | RpcMethod::WorkspaceArchiveSession
            | RpcMethod::WorkspaceUnarchiveSession) => {
                workspace::call(self, rpc_id, method, &payload).await
            }
            RpcMethod::SkillList => host::skill_list(self, &payload).await,
            method @ (RpcMethod::AgentPresetList
            | RpcMethod::AgentPresetSelect
            | RpcMethod::AgentPresetRead
            | RpcMethod::AgentPresetCopy
            | RpcMethod::AgentPresetOpenDocument
            | RpcMethod::AgentPresetRemove) => preset::call(self, rpc_id, method, &payload).await,
            method @ (RpcMethod::GoalUpdatePlan
            | RpcMethod::GoalCreate
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
        if endpoint == "swarm/tasks" {
            return Some(match swarm_tasks::call(self, rpc_id, &payload).await {
                Ok(value) => RpcResult::success(value),
                Err(error) => RpcResult::failure(error),
            });
        }
        if endpoint == "swarm/manage" {
            return Some(match swarm::manage(self, rpc_id, &payload).await {
                Ok(value) => RpcResult::success(value),
                Err(error) => RpcResult::failure(error),
            });
        }
        if endpoint == "workspace/memory" {
            // Settings must remain repairable even if session hydration fails.
            return Some(match memory::call(self, rpc_id, &payload).await {
                Ok(v) => RpcResult::success(v),
                Err(e) => RpcResult::failure(e),
            });
        }
        if endpoint == "display/inspect" {
            let result = crate::display::inspect_rpc(self, &payload, _cancellation).await;
            return Some(match result {
                Ok(v) => RpcResult::success(v),
                Err(e) => RpcResult::failure(e),
            });
        }
        if endpoint == "display/read" {
            let result = crate::display::read_rpc(self, &payload, _cancellation).await;
            return Some(match result {
                Ok(v) => RpcResult::success(v),
                Err(e) => RpcResult::failure(e),
            });
        }
        if endpoint.starts_with("github/review-") {
            let result = crate::github_review::call(self, endpoint, &payload, _cancellation).await;
            return Some(match result {
                Ok(v) => RpcResult::success(v),
                Err(e) => RpcResult::failure(e),
            });
        }
        // Retired product surface: fail closed without reading or mutating old
        // PR/chat metadata. Existing normal conversations are unaffected.
        if matches!(endpoint, "github/chat-get" | "github/chat-set") {
            return Some(RpcResult::failure(RpcError::bad_request(
                "PR chat binding has been retired; use the global assistant",
                json!([]),
            )));
        }
        if endpoint.starts_with("github/") {
            let result = match self.github.get() {
                Some(backend) => backend.read(endpoint, &payload, _cancellation).await,
                None => Err(RpcError::internal(
                    "GitHub integration is unavailable in this Host build",
                )),
            };
            return Some(match result {
                Ok(value) => RpcResult::success(value),
                Err(error) => RpcResult::failure(error),
            });
        }
        // Namespaced mutations carry the session under args.agentId rather
        // than sessionId. Viewing a cold page must not bypass their recovery.
        let nested_mutation = matches!(
            endpoint,
            "commands/execute"
                | "goals/create"
                | "goals/edit"
                | "goals/pause"
                | "goals/resume"
                | "goals/complete"
                | "goals/clear"
        );
        let target = if nested_mutation {
            payload
                .get("args")
                .and_then(|args| args.get("agentId"))
                .and_then(Value::as_str)
        } else {
            payload.get("sessionId").and_then(Value::as_str)
        };
        if let Some(session_id) = target {
            if let Err(error) = self.hydrate_session(session_id).await {
                return Some(RpcResult::failure(rpc_error(
                    xharness_api::RpcErrorCode::Internal,
                    format!("session recovery failed: {error}"),
                    json!({"sessionId": session_id}),
                )));
            }
        }
        let result = dynamic::call(self, rpc_id, endpoint, &payload).await?;
        Some(match result {
            Ok(Some(value)) => RpcResult::success(value),
            Ok(None) => RpcResult::Success { value: None },
            Err(error) => RpcResult::failure(error),
        })
    }

    async fn session_in_workspace(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<bool, RpcError> {
        // Reject mismatched scope from metadata BEFORE replay/recovery. Merely
        // probing a cold session outside this workspace must not activate it.
        {
            let state = self.state.read().await;
            if state.deleted_sessions.contains(session_id) {
                return Ok(false);
            }
            let Some(workspace) = state.workspaces.get(workspace_id) else {
                return Ok(false);
            };
            let cwd = match state.sessions.get(session_id) {
                Some(session) => Some(session.cwd.clone()),
                None => self
                    .lazy_headers
                    .read()
                    .await
                    .get(session_id)
                    .map(|header| {
                        header
                            .cwd
                            .clone()
                            .unwrap_or_else(|| self.config.cwd.to_string_lossy().into_owned())
                    }),
            };
            if cwd.as_deref() != Some(workspace.path.as_str()) {
                return Ok(false);
            }
        }
        self.hydrate_session(session_id)
            .await
            .map_err(|_| RpcError::internal("session recovery failed"))?;
        let state = self.state.read().await;
        if state.deleted_sessions.contains(session_id) {
            return Ok(false);
        }
        Ok(state
            .workspaces
            .get(workspace_id)
            .zip(state.sessions.get(session_id))
            .is_some_and(|(workspace, session)| workspace.path == session.cwd))
    }

    async fn scoped_catalogue(
        &self,
        query: xharness_api::ScopedCatalogueQuery,
    ) -> Result<xharness_api::ScopedCataloguePage, RpcError> {
        scoped_catalogue::read(self, query).await
    }

    async fn scoped_automation_read(
        &self,
        request: xharness_api::ScopedAutomationRead,
    ) -> Result<xharness_api::ScopedAutomationPage, RpcError> {
        scoped_automation::read(self, request).await
    }
    async fn scoped_automation_control(
        &self,
        request: xharness_api::ScopedAutomationMutation,
    ) -> Result<xharness_api::ScopedAutomationApplied, RpcError> {
        scoped_automation::control(self, request).await
    }
    async fn scoped_automation_receipt(
        &self,
        request: xharness_api::ScopedAutomationMutation,
    ) -> Result<Option<xharness_api::ScopedAutomationApplied>, RpcError> {
        scoped_automation::receipt(self, request).await
    }

    async fn create_scoped_session(
        &self,
        request: xharness_api::ScopedSessionCreate,
    ) -> Result<xharness_api::ScopedSessionCreated, RpcError> {
        session_lifecycle::create_scoped(self, request).await
    }

    async fn scoped_session_creation_receipt(
        &self,
        request: xharness_api::ScopedSessionCreate,
    ) -> Result<Option<xharness_api::ScopedSessionCreated>, RpcError> {
        session_lifecycle::creation_receipt(self, &request).await
    }

    async fn session_event_attachment(
        &self,
        workspace: &str,
        session: &str,
        seq: u64,
        id: &str,
    ) -> Result<xharness_api::ScopedAttachment, RpcError> {
        scoped_attachment::read(self, workspace, session, seq, id).await
    }

    async fn session_event_page(
        &self,
        workspace: &str,
        session: &str,
        after: Option<u64>,
    ) -> Result<xharness_api::ScopedEventPage, RpcError> {
        scoped_events::page(self, workspace, session, after).await
    }

    async fn prompt_receipt(
        &self,
        session_id: &str,
        rpc_id: &RpcId,
        payload: &Value,
    ) -> Result<Option<RpcResult>, RpcError> {
        if !self.agent_runtime.has_authoritative_sessions() {
            return Err(RpcError::internal(
                "durable prompt receipts require authoritative sessions",
            ));
        }
        if payload.get("sessionId").and_then(Value::as_str) != Some(session_id) {
            return Err(wire::bad_request("prompt receipt session mismatch"));
        }
        self.hydrate_session(session_id)
            .await
            .map_err(|_| RpcError::internal("session recovery failed"))?;
        let _guard = self.lock_admission(session_id).await;
        let mode = required_string(payload, "mode")?;
        let content = required_array(payload, "content")?;
        let zone = optional_string(payload, "clientTimeZone")?;
        let fingerprint = prompt_fingerprint(&mode, content, zone.as_deref());
        let durable = self
            .agent_runtime
            .authoritative_session(session_id)
            .await
            .map_err(crate::driver::agent_runtime_error)?
            .ok_or_else(|| RpcError::internal("authoritative receipt journal unavailable"))?;
        let receipt = crate::restore::restored_admission(&durable, rpc_id.as_str());
        match receipt.as_ref() {
            Some(previous) if previous.fingerprint.as_deref() == Some(&fingerprint) => {
                Ok(Some(RpcResult::success(json!({"accepted": true}))))
            }
            Some(_) => Err(wire::bad_request("prompt receipt identity conflict")),
            None => Ok(None),
        }
    }

    async fn session_interaction(
        &self,
        workspace: &str,
        session: &str,
        id: &RpcId,
    ) -> Result<Option<xharness_api::ScopedInteraction>, RpcError> {
        if !self.session_in_workspace(workspace, session).await? {
            return Err(RpcError::internal("session scope is unavailable"));
        }
        scoped_interaction::snapshot(self, session, id).await
    }
    async fn answer_session_interaction(
        &self,
        workspace: &str,
        session: &str,
        expected: xharness_api::ScopedInteraction,
        answer: xharness_api::ScopedInteractionAnswer,
    ) -> Result<xharness_api::ScopedInteractionReceipt, RpcError> {
        if !self.session_in_workspace(workspace, session).await? {
            return Err(RpcError::internal("session scope is unavailable"));
        }
        scoped_interaction::answer(self, session, expected, answer).await
    }

    async fn respond(&self, response: ClientResponse) -> RpcReceipt {
        interaction::respond(self, response).await
    }

    async fn session_events(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<EventStream, RpcError> {
        if !self.session_in_workspace(workspace_id, session_id).await? {
            return Err(RpcError::internal("session scope is unavailable"));
        }
        Ok(mux_events_filtered(self, Some(session_id.to_owned())))
    }

    fn mux_events(&self) -> EventStream {
        mux_events_filtered(self, None)
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

fn mux_events_filtered(host: &BasicHost, scope: Option<String>) -> EventStream {
    let mut receiver = host.event_gateway.subscribe_mux();
    let mut question_receiver = host.questions.subscribe();
    let state = Arc::clone(&host.state);
    let next_id = Arc::clone(&host.next_id);
    let questions = Arc::clone(&host.questions);
    Box::pin(async_stream::stream! {
        let mut baseline = {
        let state = state.read().await;
        let mut frames = Vec::new();
        for session in state.sessions.values() {
            if scope.as_deref().is_some_and(|id| session.session_id != id) { continue; }
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
                    reviewing,
                    reason,
                    ..
                } if scope.as_deref().is_none_or(|id| session_id == id) => frames.push(ServerRequest::new(
                    RpcId::new(rpc_id),
                    "approval/requested",
                    json!({
                        "type": "approval/requested",
                        "sessionId": session_id,
                        "approvalId": approval_id,
                        "toolName": tool_name,
                        "callId": call_id,
                        "reason": reason,
                        "reviewing": reviewing,
                    }),
                )),
                _ => {},
            }
        }
        frames
        };
        baseline.extend(match scope.as_deref() {
            Some(id) => questions.baseline_for(Some(id)).await,
            None => questions.baseline().await,
        });
        for frame in baseline {
            yield frame;
        }
        loop {
            let received = tokio::select! {
                frame = receiver.recv() => frame,
                frame = question_receiver.recv() => frame,
            };
            match received {
                Ok(frame) => {
                    if scope.as_deref().is_none_or(|id| frame.payload["sessionId"].as_str() == Some(id)) { yield frame; }
                },
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    yield ServerRequest::new(
                        RpcId::new("stream-lagged"),
                        "stream/error",
                        json!({
                            "type": "stream/error",
                            "error": {
                                "code": "internal",
                                "message": if scope.is_some() { "session stream lagged; refetch history".to_owned() } else { format!("mux stream lagged by {skipped} frames; refetch history") },
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

#[cfg(test)]
mod edit_admission_tests {
    use super::*;
    use crate::{HostConfig, NoTools};

    struct ImageRuntime(Option<bool>);
    #[async_trait::async_trait]
    impl crate::AgentRuntime for ImageRuntime {
        fn has_available_route(&self) -> bool {
            true
        }
        fn can_route(&self, _: &crate::ModelRoute) -> bool {
            true
        }
        fn model_catalog(&self) -> Vec<crate::ModelDescriptor> {
            vec![crate::ModelDescriptor::new("p", "Provider", "m", "Model")
                .with_image_input(self.0, json!({"source":"documented"}))]
        }
        async fn start_turn(
            &self,
            _: crate::AgentTurnRequest,
        ) -> Result<Box<dyn crate::RunningTurn>, crate::AgentRuntimeError> {
            panic!("image admission test must not call a model")
        }
    }
    #[tokio::test]
    async fn image_admission_and_tool_gate_use_active_route_not_raw_settings() {
        for supported in [None, Some(false), Some(true)] {
            let root = std::env::temp_dir()
                .join(format!("xh-images-{}-{supported:?}", std::process::id()));
            std::fs::create_dir_all(&root).unwrap();
            let mut config = HostConfig::new(&root);
            config.provider_id = "p".into();
            config.model_id = "m".into();
            let host = BasicHost::with_agent_runtime(config, Arc::new(ImageRuntime(supported)));
            let created = session_lifecycle::create(&host, &json!({"cwd":root}))
                .await
                .unwrap();
            let id = created["sessionId"].as_str().unwrap();
            // Contradictory, unactivated settings must not override active metadata.
            host.state
                .write()
                .await
                .settings
                .get_mut(crate::MODEL_SETTINGS_NAMESPACE)
                .unwrap()
                .value = json!({"providers":{"p":{"models":[{"id":"m","imageInput":supported != Some(true)}]}}});
            assert_eq!(
                host.session_accepts_images(id).await,
                supported == Some(true)
            );
            if supported != Some(true) {
                let error = turn::prompt(&host, RpcId::new("no-image"), &json!({
                    "sessionId":id,"mode":"queue","content":[{"type":"image_ref","attachmentId":"missing"}]
                })).await.unwrap_err();
                assert!(error.message.contains("image capability is unknown"));
                assert!(host.state.read().await.sessions[id].queue.is_empty());
            }
            assert!(!host.session_accepts_images("missing-session").await);
            let _ = std::fs::remove_dir_all(root);
        }
    }

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

#[cfg(test)]
mod scoped_stream_tests {
    use super::*;
    use crate::{HostConfig, NoTools};
    use futures::StreamExt;
    use std::collections::BTreeSet;
    use std::time::Duration;

    async fn host() -> (std::path::PathBuf, Arc<BasicHost>) {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "xh-scoped-stream-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        let host = BasicHost::new(HostConfig::new(&root), None, Arc::new(NoTools));
        for id in ["s", "other"] {
            let result = host
                .call(
                    RpcId::new(id),
                    RpcMethod::SessionCreate,
                    json!({"workspaceId":"workspace-default","sessionId":id}),
                    CancellationToken::new(),
                )
                .await;
            assert!(matches!(result, RpcResult::Success { .. }), "{result:?}");
        }
        (root, host)
    }
    async fn next(stream: &mut EventStream) -> ServerRequest {
        tokio::time::timeout(Duration::from_secs(2), stream.next())
            .await
            .unwrap()
            .unwrap()
    }
    #[tokio::test]
    async fn mismatched_cold_scope_is_rejected_before_recovery_can_activate_it() {
        let (root, host) = host().await;
        assert!(host
            .lazy_store
            .set(Arc::new(xharness_session::MemorySessionStore::default()))
            .is_ok());
        {
            let mut state = host.state.write().await;
            let record = state.sessions.get_mut("other").unwrap();
            record.restoring = true;
            record.cwd = "/outside-scoped-workspace".into();
        }
        assert!(!host
            .session_in_workspace("workspace-default", "other")
            .await
            .unwrap());
        assert!(!host
            .session_in_workspace("unregistered", "other")
            .await
            .unwrap());
        assert!(host.state.read().await.sessions["other"].restoring);
        // Correct metadata permits recovery; the intentionally empty journal
        // then fails. Wrong scope above must return false, not this error.
        let workspace_cwd = host.state.read().await.workspaces["workspace-default"]
            .path
            .clone();
        host.state
            .write()
            .await
            .sessions
            .get_mut("other")
            .unwrap()
            .cwd = workspace_cwd;
        assert!(host
            .session_in_workspace("workspace-default", "other")
            .await
            .is_err());
        drop(host);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn genuine_host_scoped_baseline_and_live_frames_exclude_other_session() {
        let (root, host) = host().await;
        assert!(host.session_events("unregistered", "s").await.is_err());
        assert!(host
            .session_events("workspace-default", "missing")
            .await
            .is_err());
        for session_id in ["s", "other"] {
            host.state.write().await.pending.insert(
                format!("approval-{session_id}"),
                PendingResponse::Approval {
                    session_id: session_id.into(),
                    approval_id: format!("approval-{session_id}"),
                    call_id: "call".into(),
                    tool_name: "fixture-tool".into(),
                    control: tokio::sync::mpsc::channel(1).0,
                    reviewing: false,
                    reason: "fixture".into(),
                    scoped_nonce: Arc::new(std::sync::OnceLock::new()),
                    deciding: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                },
            );
        }
        let mut scoped = host.session_events("workspace-default", "s").await.unwrap();
        host.event_gateway.publish_mux(
            RpcId::new("private"),
            json!({"type":"session/queue","sessionId":"other","items":["must-not-leak"]}),
        );
        host.event_gateway.publish_mux(
            RpcId::new("wanted"),
            json!({"type":"session/queue","sessionId":"s","items":[]}),
        );
        let mut subscribed = 0;
        let mut approvals = 0;
        loop {
            let frame = next(&mut scoped).await;
            assert_eq!(frame.payload["sessionId"], "s");
            assert!(!frame.payload.to_string().contains("must-not-leak"));
            if frame.method == "session/subscribed" {
                subscribed += 1;
            }
            if frame.method == "approval/requested" {
                approvals += 1;
                assert_eq!(frame.rpc_id.as_str(), "approval-s");
            }
            if frame.rpc_id.as_str() == "wanted" {
                break;
            }
        }
        assert_eq!(subscribed, 1);
        assert_eq!(approvals, 1);
        // Existing desktop mux retains both sessions; narrowing is not global.
        let mut global = host.mux_events();
        let mut seen = BTreeSet::new();
        while seen.len() < 2 {
            let frame = next(&mut global).await;
            if frame.method == "session/subscribed" {
                seen.insert(frame.payload["sessionId"].as_str().unwrap().to_owned());
            }
        }
        assert_eq!(seen, BTreeSet::from(["s".to_owned(), "other".to_owned()]));
        drop(global);
        drop(scoped);
        drop(host);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn genuine_host_scoped_lag_marker_does_not_reveal_global_skipped_count() {
        let (root, host) = host().await;
        let mut stream = host.session_events("workspace-default", "s").await.unwrap();
        for _ in 0..5000 {
            host.event_gateway.publish_mux(
                RpcId::new("noise"),
                json!({"type":"session/queue","sessionId":"other","items":[]}),
            );
        }
        loop {
            let frame = next(&mut stream).await;
            if frame.method == "stream/error" {
                assert_eq!(
                    frame.payload["error"]["message"],
                    "session stream lagged; refetch history"
                );
                break;
            }
            assert_eq!(frame.payload["sessionId"], "s");
        }
        drop(stream);
        drop(host);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn scoped_interaction_validates_workspace_session_nonce_and_native_decision() {
        use xharness_api::{ScopedInteractionAnswer as A, ScopedInteractionReceipt as R};
        let (root, host) = host().await;
        let (control, mut commands) = tokio::sync::mpsc::channel(2);
        let insert = |reviewing| PendingResponse::Approval {
            session_id: "s".into(),
            approval_id: "a".into(),
            call_id: "call".into(),
            tool_name: "fixture".into(),
            control: control.clone(),
            reviewing,
            reason: "manual".into(),
            scoped_nonce: Arc::new(std::sync::OnceLock::new()),
            deciding: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        host.state
            .write()
            .await
            .pending
            .insert("r".into(), insert(true));
        let id = RpcId::new("r");
        assert!(host
            .session_interaction("workspace-default", "s", &id)
            .await
            .unwrap()
            .is_none());
        host.state
            .write()
            .await
            .pending
            .insert("r".into(), insert(false));
        assert!(host
            .session_interaction("unregistered", "s", &id)
            .await
            .is_err());
        assert!(host
            .session_interaction("workspace-default", "other", &id)
            .await
            .unwrap()
            .is_none());
        let old = host
            .session_interaction("workspace-default", "s", &id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_value::<xharness_api::MuxFrame>(old.frame.payload.clone())
                .unwrap()
                .into_server_request(old.frame.rpc_id.clone()),
            old.frame,
        );
        assert_eq!(
            host.answer_session_interaction(
                "workspace-default",
                "other",
                old.clone(),
                A::Approval { allowed: true }
            )
            .await
            .unwrap(),
            R::Stale
        );
        assert_eq!(
            host.answer_session_interaction(
                "workspace-default",
                "s",
                old.clone(),
                A::CancelQuestion
            )
            .await
            .unwrap(),
            R::Invalid
        );
        host.state
            .write()
            .await
            .pending
            .insert("r".into(), insert(false));
        let new = host
            .session_interaction("workspace-default", "s", &id)
            .await
            .unwrap()
            .unwrap();
        assert_ne!(old.nonce, new.nonce);
        assert_eq!(
            host.answer_session_interaction(
                "workspace-default",
                "s",
                old,
                A::Approval { allowed: true }
            )
            .await
            .unwrap(),
            R::Stale
        );
        assert!(commands.try_recv().is_err());
        let worker = tokio::spawn({
            let host = host.clone();
            let new = new.clone();
            async move {
                host.answer_session_interaction(
                    "workspace-default",
                    "s",
                    new,
                    A::Approval { allowed: true },
                )
                .await
            }
        });
        let command = commands.recv().await.unwrap();
        assert!(
            matches!(command.command,xharness_core::LoopCommand::ApproveTool {call_id} if call_id=="call")
        );
        command.acknowledgement.send(Ok(())).unwrap();
        assert_eq!(worker.await.unwrap().unwrap(), R::Accepted);
        assert_eq!(
            host.answer_session_interaction(
                "workspace-default",
                "s",
                new,
                A::Approval { allowed: true }
            )
            .await
            .unwrap(),
            R::Stale
        );
        drop(host);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn scoped_interaction_lost_native_acknowledgement_is_uncertain_not_false_rejection() {
        use xharness_api::{ScopedInteractionAnswer as A, ScopedInteractionReceipt as R};
        let (root, host) = host().await;
        let (control, mut commands) = tokio::sync::mpsc::channel(1);
        host.state.write().await.pending.insert(
            "r".into(),
            PendingResponse::Approval {
                session_id: "s".into(),
                approval_id: "a".into(),
                call_id: "call".into(),
                tool_name: "fixture".into(),
                control,
                reviewing: false,
                reason: "manual".into(),
                scoped_nonce: Arc::new(std::sync::OnceLock::new()),
                deciding: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            },
        );
        let expected = host
            .session_interaction("workspace-default", "s", &RpcId::new("r"))
            .await
            .unwrap()
            .unwrap();
        let worker = tokio::spawn({
            let host = host.clone();
            async move {
                host.answer_session_interaction(
                    "workspace-default",
                    "s",
                    expected,
                    A::Approval { allowed: false },
                )
                .await
            }
        });
        drop(commands.recv().await.unwrap());
        assert_eq!(worker.await.unwrap().unwrap(), R::Uncertain);
        drop(host);
        std::fs::remove_dir_all(root).unwrap();
    }
}

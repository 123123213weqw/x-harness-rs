//! Thin UI adapter. Timer semantics, CAS and run receipts remain in Schedule.
use serde::Deserialize;
use serde_json::Value;
use xharness_api::{RpcError, RpcId};
use xharness_schedule::AutomationCommand;

use super::{bad_request, session_not_found};
use crate::BasicHost;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    session_id: String,
    command: AutomationCommand,
}

pub(super) async fn manage(
    host: &BasicHost,
    rpc_id: RpcId,
    payload: &Value,
) -> Result<Value, RpcError> {
    let request: Request = serde_json::from_value(payload.clone())
        .map_err(|_| bad_request("Invalid automation management request"))?;
    // Chat creates/edits through the tool. Cards only inspect or control saved tasks.
    if matches!(
        request.command,
        AutomationCommand::Create { .. } | AutomationCommand::Update { .. }
    ) {
        return Err(bad_request("Automation cards cannot create or edit tasks"));
    }
    let _guard = host.lock_admission(&request.session_id).await;
    {
        let state = host.state.read().await;
        if state.deleted_sessions.contains(&request.session_id)
            || !state.sessions.contains_key(&request.session_id)
        {
            return Err(session_not_found(&request.session_id));
        }
        if state.archived_sessions.contains(&request.session_id)
            && matches!(request.command, AutomationCommand::Resume { .. })
        {
            return Err(bad_request(
                "Unarchive this chat before resuming its automation",
            ));
        }
    }
    let mutation = matches!(
        request.command,
        AutomationCommand::Pause { .. }
            | AutomationCommand::Resume { .. }
            | AutomationCommand::Delete { .. }
    );
    let value = host
        .agent_runtime
        .automation_command(
            &request.session_id,
            &format!("ui:{}", rpc_id.as_str()),
            request.command,
        )
        .await
        .map_err(|error| RpcError::internal(error.to_string()))?;
    if mutation {
        host.sync_authoritative_session(&request.session_id).await?;
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AgentRuntime, AgentRuntimeError, AgentTurnRequest, HostConfig, ModelRoute, RunningTurn,
    };
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::Arc;
    use tokio_util::sync::CancellationToken;
    use xharness_api::{ApiBackend, RpcResult};
    use xharness_schedule::ScheduleManager;
    use xharness_session::{MemorySessionStore, Session, SessionHeader, Store};

    struct Runtime(Arc<dyn Store>, Arc<ScheduleManager>);
    #[async_trait]
    impl AgentRuntime for Runtime {
        fn has_available_route(&self) -> bool {
            false
        }
        fn can_route(&self, _: &ModelRoute) -> bool {
            false
        }
        fn has_authoritative_sessions(&self) -> bool {
            true
        }
        async fn authoritative_session(
            &self,
            id: &str,
        ) -> Result<Option<Session>, AgentRuntimeError> {
            self.0
                .load(id)
                .await
                .map_err(|e| AgentRuntimeError::Preparation {
                    message: e.to_string(),
                })
        }
        async fn automation_command(
            &self,
            id: &str,
            invocation: &str,
            command: AutomationCommand,
        ) -> Result<Value, AgentRuntimeError> {
            Ok(self.1.execute(id, invocation, command).await)
        }
        async fn start_turn(
            &self,
            _: AgentTurnRequest,
        ) -> Result<Box<dyn RunningTurn>, AgentRuntimeError> {
            panic!("cards cannot start model turns")
        }
    }
    async fn setup(store: Arc<dyn Store>) -> (Arc<BasicHost>, Arc<ScheduleManager>) {
        let schedules = ScheduleManager::new(store.clone());
        let host = BasicHost::with_agent_runtime(
            HostConfig::new(std::env::temp_dir()),
            Arc::new(Runtime(store.clone(), schedules.clone())),
        );
        host.restore_from_store(store).await.unwrap();
        (host, schedules)
    }
    async fn rpc(host: &BasicHost, payload: Value) -> RpcResult {
        host.call_dynamic(
            RpcId::new("test-card"),
            "automation/manage",
            payload,
            CancellationToken::new(),
        )
        .await
        .expect("mounted endpoint")
    }
    fn value(result: RpcResult) -> Value {
        match result {
            RpcResult::Success { value } => value.unwrap(),
            other => panic!("{other:?}"),
        }
    }
    async fn fixture() -> (Arc<BasicHost>, Arc<ScheduleManager>, Arc<dyn Store>, String) {
        let store: Arc<dyn Store> = Arc::new(MemorySessionStore::default());
        store.create(SessionHeader::new("a")).await.unwrap();
        store.create(SessionHeader::new("b")).await.unwrap();
        let (host, schedules) = setup(store.clone()).await;
        let created = schedules
            .execute(
                "a",
                "create",
                serde_json::from_value(
                    json!({"action":"create","prompt":"Card task","after_seconds":3600}),
                )
                .unwrap(),
            )
            .await;
        (
            host,
            schedules,
            store,
            created["id"].as_str().unwrap().to_owned(),
        )
    }
    #[tokio::test]
    async fn automation_cards_share_tool_state_and_publish_projection() {
        let (host, schedules, _, id) = fixture().await;
        let pause = json!({"sessionId":"a","command":{"action":"pause","id":id}});
        for _ in 0..2 {
            assert_eq!(value(rpc(&host, pause.clone()).await)["state"], "paused");
        }
        assert!(
            host.state.read().await.sessions["a"].schedules[0]
                .automation
                .as_ref()
                .unwrap()
                .paused
        );
        let tool = schedules
            .execute("a", "tool-view", AutomationCommand::View { id: id.clone() })
            .await;
        assert_eq!(tool["state"], "paused");
        assert_eq!(
            value(
                rpc(
                    &host,
                    json!({"sessionId":"a","command":{"action":"resume","id":id}})
                )
                .await
            )["state"],
            "scheduled"
        );
        assert!(
            !host.state.read().await.sessions["a"].schedules[0]
                .automation
                .as_ref()
                .unwrap()
                .paused
        );
    }
    #[tokio::test]
    async fn automation_cards_cannot_control_another_chat_or_fabricate_sessions() {
        let (host, _, store, id) = fixture().await;
        let denied = value(
            rpc(
                &host,
                json!({"sessionId":"b","command":{"action":"pause","id":id}}),
            )
            .await,
        );
        assert_eq!(denied["code"], "not_active");
        assert!(!rpc(
            &host,
            json!({"sessionId":"absent","command":{"action":"view","id":id}})
        )
        .await
        .is_ok());
        assert!(store.load("absent").await.unwrap().is_none());
        assert!(!rpc(
            &host,
            json!({"sessionId":"b","ownerSessionId":"a","command":{"action":"pause","id":id}})
        )
        .await
        .is_ok());
    }
    #[tokio::test]
    async fn automation_cards_reject_creation_and_extra_command_fields() {
        let (host, _, _, id) = fixture().await;
        assert!(!rpc(&host, json!({"sessionId":"a","command":{"action":"create","prompt":"no","after_seconds":3600}})).await.is_ok());
        assert!(!rpc(
            &host,
            json!({"sessionId":"a","command":{"action":"pause","id":id,"sessionId":"b"}})
        )
        .await
        .is_ok());
    }
    #[tokio::test]
    async fn automation_cards_restore_deleted_truth_after_host_restart() {
        let (host, _, store, id) = fixture().await;
        value(
            rpc(
                &host,
                json!({"sessionId":"a","command":{"action":"delete","id":id}}),
            )
            .await,
        );
        assert!(host.state.read().await.sessions["a"].schedules.is_empty());
        let (cold, _) = setup(store).await;
        let view = value(
            rpc(
                &cold,
                json!({"sessionId":"a","command":{"action":"view","id":id}}),
            )
            .await,
        );
        assert_eq!(view["state"], "deleted");
        assert_eq!(view["runCount"], 0);
    }
    #[tokio::test]
    async fn automation_cards_archived_chat_can_pause_but_cannot_resume() {
        let (host, _, _, id) = fixture().await;
        host.state
            .write()
            .await
            .archived_sessions
            .insert("a".into());
        assert!(rpc(
            &host,
            json!({"sessionId":"a","command":{"action":"pause","id":id}})
        )
        .await
        .is_ok());
        assert!(!rpc(
            &host,
            json!({"sessionId":"a","command":{"action":"resume","id":id}})
        )
        .await
        .is_ok());
    }
}

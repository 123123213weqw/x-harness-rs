//! Explicit idle-session recovery; no prompt replay or Host restart.
#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::let_underscore_must_use,
    unused_must_use
)]
#![cfg_attr(
    not(test),
    forbid(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::let_underscore_must_use,
        unused_must_use
    )
)]

use crate::{runtime::SessionObservation, BasicHost};
use serde_json::json;
use std::time::Duration;
use xharness_api::RpcError;

impl BasicHost {
    pub(crate) async fn recover_idle_session(&self, id: &str) -> Result<(), RpcError> {
        // Read-side repair may take the same admission gate. Finish it first.
        self.reconcile_closed_drivers(Some(id)).await;
        let _admission = self.lock_admission(id).await;
        {
            let state = self.state.read().await;
            let record = state
                .sessions
                .get(id)
                .ok_or_else(|| RpcError::internal("session is unavailable"))?;
            if record.running || !record.queue.is_empty() {
                return Err(RpcError::bad_request("Stop the current task and resolve queued input before recovering. Nothing was restarted.", json!([])));
            }
        }
        if !matches!(
            self.agent_runtime.observe_session(id).await,
            Ok(SessionObservation::Idle)
        ) {
            return Err(RpcError::bad_request("Session is active or its execution outcome is unknown. No task was replayed or restarted.", json!([])));
        }
        tokio::time::timeout(
            Duration::from_secs(10),
            self.agent_runtime.restart_idle_session(id),
        )
        .await
        .map_err(|_| {
            RpcError::internal("Session restart timed out; refresh state before retrying.")
        })?
        .map_err(|_| {
            RpcError::internal(
                "Session restart failed; no input was replayed. Other sessions were not restarted.",
            )
        })?;
        self.sync_authoritative_session(id).await?;
        // Existing journal/driver publishers own running state. A new turn
        // can already follow Ready; never overwrite it with fabricated idle.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentRuntime, AgentRuntimeError, AgentTurnRequest, HostConfig, RunningTurn};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use tokio::sync::{Mutex, Notify};
    use tokio_util::sync::CancellationToken;
    use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};

    #[derive(Default)]
    struct RecoveryRuntime {
        calls: Mutex<Vec<String>>,
        unknown: AtomicBool,
        fail: AtomicBool,
        block: AtomicBool,
        entered: Notify,
        release: Notify,
    }
    #[async_trait::async_trait]
    impl AgentRuntime for RecoveryRuntime {
        fn has_available_route(&self) -> bool {
            true
        }
        fn can_route(&self, _: &crate::ModelRoute) -> bool {
            true
        }
        async fn observe_session(&self, _: &str) -> Result<SessionObservation, AgentRuntimeError> {
            Ok(if self.unknown.load(Ordering::Acquire) {
                SessionObservation::Unsupported
            } else {
                SessionObservation::Idle
            })
        }
        async fn restart_idle_session(&self, id: &str) -> Result<(), AgentRuntimeError> {
            self.calls.lock().await.push(id.into());
            self.entered.notify_one();
            if self.block.load(Ordering::Acquire) {
                self.release.notified().await;
            }
            if self.fail.load(Ordering::Acquire) {
                return Err(AgentRuntimeError::Preparation {
                    message: "failed ready".into(),
                });
            }
            Ok(())
        }
        async fn start_turn(
            &self,
            _: AgentTurnRequest,
        ) -> Result<Box<dyn RunningTurn>, AgentRuntimeError> {
            Err(AgentRuntimeError::Preparation {
                message: "recovery must not submit a prompt".into(),
            })
        }
    }
    async fn create(host: &BasicHost) -> String {
        let result = host
            .call(
                RpcId::new("create"),
                RpcMethod::SessionCreate,
                json!({}),
                CancellationToken::new(),
            )
            .await;
        match result {
            RpcResult::Success { value: Some(value) } => {
                value["sessionId"].as_str().unwrap().to_owned()
            }
            other => panic!("{other:?}"),
        }
    }
    async fn reload(host: &BasicHost, id: &str, line: &str) -> RpcResult {
        host.call_dynamic(
            RpcId::new("recover"),
            "commands/execute",
            json!({"args":{"agentId":id,"line":line,"images":[]}}),
            CancellationToken::new(),
        )
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn recovery_rejects_busy_unknown_invalid_and_failed_ready_without_success_receipts() {
        let runtime = Arc::new(RecoveryRuntime::default());
        let host =
            BasicHost::with_agent_runtime(HostConfig::new(std::env::temp_dir()), runtime.clone());
        let id = create(&host).await;
        assert!(matches!(
            reload(&host, &id, "/reload extra").await,
            RpcResult::Failure { .. }
        ));
        host.state
            .write()
            .await
            .sessions
            .get_mut(&id)
            .unwrap()
            .running = true;
        assert!(matches!(
            reload(&host, &id, "/reload").await,
            RpcResult::Failure { .. }
        ));
        host.state
            .write()
            .await
            .sessions
            .get_mut(&id)
            .unwrap()
            .running = false;
        runtime.unknown.store(true, Ordering::Release);
        assert!(matches!(
            reload(&host, &id, "/reload").await,
            RpcResult::Failure { .. }
        ));
        assert!(runtime.calls.lock().await.is_empty());
        runtime.unknown.store(false, Ordering::Release);
        runtime.fail.store(true, Ordering::Release);
        let before = host.state.read().await.sessions[&id].events.len();
        assert!(matches!(
            reload(&host, &id, "/reload").await,
            RpcResult::Failure { .. }
        ));
        assert_eq!(host.state.read().await.sessions[&id].events.len(), before);
    }
    #[tokio::test]
    async fn recovery_acknowledges_ready_before_success_and_does_not_block_other_sessions() {
        let runtime = Arc::new(RecoveryRuntime::default());
        runtime.block.store(true, Ordering::Release);
        let host =
            BasicHost::with_agent_runtime(HostConfig::new(std::env::temp_dir()), runtime.clone());
        let id = create(&host).await;
        let other = create(&host).await;
        let mut notifications = host.event_gateway.subscribe_host();
        let work = {
            let host = host.clone();
            let id = id.clone();
            tokio::spawn(async move { reload(&host, &id, "/reload").await })
        };
        runtime.entered.notified().await;
        assert!(!work.is_finished());
        let observed = host
            .call(
                RpcId::new("other-read"),
                RpcMethod::SessionHistory,
                json!({"sessionId":other}),
                CancellationToken::new(),
            )
            .await;
        assert!(matches!(observed, RpcResult::Success { .. }));
        runtime.release.notify_one();
        let receipt = work.await.unwrap();
        assert!(
            matches!(receipt,RpcResult::Success {value:Some(value)} if value["result"]["kind"]=="success")
        );
        assert_eq!(runtime.calls.lock().await.as_slice(), &[id]);
        assert!(!host.state.read().await.sessions[&other].running);
        while let Ok(frame) = notifications.try_recv() {
            assert_ne!(frame.payload["type"], "host/session-status");
        }
    }
}

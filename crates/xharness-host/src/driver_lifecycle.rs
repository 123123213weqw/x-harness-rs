//! Driver ownership and read-only reattachment, never task replay.
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

use crate::{error_boundary::TaskOperation, runtime::SessionObservation, BasicHost};
use serde_json::json;
use std::{future::Future, pin::Pin, sync::Arc};
use tokio::sync::mpsc;

#[derive(Debug, Default)]
pub(crate) struct DriverEpoch {
    pub(crate) repair_attempt: u8,
}
impl DriverEpoch {
    pub(crate) fn matches(a: &Option<Arc<Self>>, b: &Option<Arc<Self>>) -> bool {
        match (a, b) {
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        }
    }
}

impl BasicHost {
    /// Only dead receiver ownership is repaired on reads. A live receiver with
    /// an in-flight command is not evidence of a dead worker.
    pub(crate) async fn reconcile_closed_drivers(&self, only: Option<&str>) {
        let closed: Vec<_> = self
            .state
            .read()
            .await
            .sessions
            .iter()
            .filter_map(|(id, s)| {
                (only.is_none_or(|wanted| wanted == id)
                    && s.running
                    && s.control.as_ref().is_none_or(|c| c.is_closed()))
                .then(|| s.driver_epoch.clone().map(|epoch| (id.clone(), epoch)))
                .flatten()
            })
            .collect();
        for (id, epoch) in closed {
            self.repair_session_driver(id, epoch).await;
        }
    }

    /// Box the supervised recovery boundary to avoid recursive spawn/future
    /// types. One automatic replacement per driver generation is the bound.
    pub(crate) fn repair_session_driver(
        &self,
        id: String,
        epoch: Arc<DriverEpoch>,
    ) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        let host = self.clone();
        Box::pin(async move {
            let _admission = host.lock_admission(&id).await;
            let owns = host.state.read().await.sessions.get(&id).is_some_and(|s| {
                s.running && DriverEpoch::matches(&s.driver_epoch, &Some(epoch.clone()))
            });
            if !owns {
                return;
            }
            let observation = match host.sync_authoritative_session(&id).await {
                Ok(_) => host.agent_runtime.observe_session(&id).await,
                Err(_) => Err(crate::AgentRuntimeError::Preparation {
                    message: "driver synchronization failed".into(),
                }),
            };
            let mut state = host.state.write().await;
            let Some(record) = state.sessions.get_mut(&id) else {
                return;
            };
            if !DriverEpoch::matches(&record.driver_epoch, &Some(epoch.clone())) {
                return;
            }
            match observation {
                Ok(SessionObservation::Idle) if record.queue.is_empty() => {
                    record.running = false;
                    record.control = None;
                    record.driver_epoch = None;
                    drop(state);
                    host.push_host(
                        json!({"type":"host/session-status","sessionId":id,"running":false}),
                    );
                    host.push_permission_projection(&id).await;
                }
                Ok(observation @ (SessionObservation::Idle | SessionObservation::Active(_)))
                    if epoch.repair_attempt == 0 =>
                {
                    let (tx, rx) = mpsc::channel(64);
                    record.control = Some(tx);
                    record.driver_epoch = Some(Arc::new(DriverEpoch {
                        repair_attempt: epoch.repair_attempt.saturating_add(1),
                    }));
                    drop(state);
                    let runner = host.clone();
                    let session = id.clone();
                    host.spawn_session_task(id, TaskOperation::RecoveredTurn, async move {
                        match observation {
                            SessionObservation::Active(run) => {
                                runner.drive_recovered_turn(session, run, rx).await
                            }
                            _ => runner.drive_session(session, rx).await,
                        }
                    })
                    .await;
                }
                _ => {
                    // Unknown is NOT idle, and never permission to replay. A
                    // missing control makes subsequent stop fail visibly rather
                    // than acknowledging a non-existent worker forever.
                    let first_failure = record.control.take().is_some();
                    drop(state);
                    if !first_failure {
                        return;
                    }
                    xharness_diagnostics::record_failure(
                        xharness_diagnostics::FailureCode::DriverUnavailable,
                    );
                    host.push_host(json!({"type":"host/agent-error","sessionId":id,
                        "message":"Conversation driver is unavailable; execution outcome is unknown. No task was replayed. Reload before retrying."}));
                }
            }
        })
    }
}

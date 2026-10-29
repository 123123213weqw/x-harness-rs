//! Failure observation at the RPC/task boundary, never a second business policy.
//! Preserve errors on the wire; logs contain only closed categories and a
//! correlation digest, never error text, payloads, prompts or credentials.
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

use serde_json::{json, Value};
use std::hash::{DefaultHasher, Hash, Hasher};
use xharness_api::{RpcId, RpcResult};

pub(crate) struct RpcObservation {
    request_tag: String,
    operation: &'static str,
}

impl RpcObservation {
    pub(crate) fn new(id: &RpcId, operation: &'static str) -> Self {
        // Correlation only, not authentication. Do not put even caller-chosen
        // request identifiers into logs as plaintext.
        let mut digest = DefaultHasher::new();
        id.as_str().hash(&mut digest);
        Self {
            request_tag: format!("{:016x}", digest.finish()),
            operation,
        }
    }

    fn failure_record(&self, result: &RpcResult) -> Option<Value> {
        let RpcResult::Failure { error } = result else {
            return None;
        };
        Some(json!({
            "event": "rpc_failure", "request_tag": self.request_tag,
            "operation": self.operation, "code": error.code,
        }))
    }

    pub(crate) fn finish(&self, result: &RpcResult) {
        if let Some(record) = self.failure_record(result) {
            xharness_diagnostics::record_failure(xharness_diagnostics::FailureCode::Rpc);
            xharness_diagnostics::diagnostic_stderr!("XHARNESS_FAILURE {record}");
        }
    }
}

/// Dynamic endpoint input is not a safe log label. Classify into a closed set;
/// unknown endpoints still return the original unsupported-method result.
pub(crate) fn dynamic_operation(endpoint: &str) -> &'static str {
    match endpoint.split('/').next() {
        Some("github") => "github",
        Some("display") => "display",
        Some("swarm") => "swarm",
        Some("workspace") => "workspace",
        Some("commands") => "commands",
        Some("goals") => "goals",
        _ => "dynamic",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use xharness_api::{RpcError, RpcErrorCode};

    #[test]
    fn failure_is_observable_without_logging_sensitive_error_or_payload() {
        let result = RpcResult::failure(RpcError {
            code: RpcErrorCode::BadRequest,
            message: "secret credential and prompt".into(),
            details: json!({"token":"private", "path":"sensitive"}),
        });
        let observation = RpcObservation::new(&RpcId::new("private-request-id"), "settings/update");
        let record = observation
            .failure_record(&result)
            .expect("failure has evidence");
        assert_eq!(record["code"], "bad-request");
        assert_eq!(record["operation"], "settings/update");
        assert_eq!(record["request_tag"].as_str().unwrap().len(), 16);
        for secret in ["private", "credential", "prompt", "token", "sensitive"] {
            assert!(!record.to_string().contains(secret));
        }
        // Observation borrows the original error; the caller still receives it.
        assert!(
            matches!(result, RpcResult::Failure {error} if error.message == "secret credential and prompt")
        );
    }

    #[test]
    fn success_is_not_reported_as_failure_and_request_correlation_is_stable() {
        let a = RpcObservation::new(&RpcId::new("a"), "rpc");
        let same = RpcObservation::new(&RpcId::new("a"), "rpc");
        let other = RpcObservation::new(&RpcId::new("b"), "rpc");
        assert_eq!(a.request_tag, same.request_tag);
        assert_ne!(a.request_tag, other.request_tag);
        assert!(a.failure_record(&RpcResult::success(json!({}))).is_none());
        assert_eq!(dynamic_operation("api-key-secret/anything"), "dynamic");
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TaskOperation {
    SessionDriver,
    RecoveredTurn,
    BackgroundProjection,
}
impl TaskOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::SessionDriver => "session_driver",
            Self::RecoveredTurn => "recovered_turn",
            Self::BackgroundProjection => "background_projection",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TaskFailure {
    Panicked,
    Cancelled,
}

/// The monitor owns the child. Aborting the monitor must not silently detach
/// work. Dropping the returned JoinHandle only detaches the *monitor*, which
/// still awaits and reports the child; it is never an operation-success receipt.
pub(crate) fn spawn_observed<F, C, R>(
    operation: TaskOperation,
    work: F,
    on_failure: C,
) -> tokio::task::JoinHandle<()>
where
    F: std::future::Future<Output = ()> + Send + 'static,
    C: FnOnce(TaskFailure) -> R + Send + 'static,
    R: std::future::Future<Output = ()> + Send + 'static,
{
    struct OwnedTask(tokio::task::JoinHandle<()>);
    impl Drop for OwnedTask {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    tokio::spawn(async move {
        let mut child = OwnedTask(tokio::spawn(work));
        if let Err(error) = (&mut child.0).await {
            let failure = if error.is_panic() {
                TaskFailure::Panicked
            } else {
                TaskFailure::Cancelled
            };
            // Never format JoinError: its panic payload may contain user data.
            let code = match failure {
                TaskFailure::Panicked => "task_panicked",
                TaskFailure::Cancelled => "task_cancelled",
            };
            xharness_diagnostics::record_failure(match failure {
                TaskFailure::Panicked => xharness_diagnostics::FailureCode::TaskPanicked,
                TaskFailure::Cancelled => xharness_diagnostics::FailureCode::TaskCancelled,
            });
            xharness_diagnostics::diagnostic_stderr!(
                "XHARNESS_FAILURE {}",
                json!({"event":"background_task_failure", "operation":operation.as_str(), "code":code})
            );
            on_failure(failure).await;
        }
    })
}

impl crate::BasicHost {
    #[cfg(test)]
    pub(crate) async fn test_activity_snapshot(&self, id: &str) -> String {
        let host = {
            let state = self.state.read().await;
            let r = &state.sessions[id];
            format!(
                "running={}, control_closed={:?}, epoch={:?}, queued={}, paused={}, cursor={:?}",
                r.running,
                r.control.as_ref().map(|c| c.is_closed()),
                r.driver_epoch,
                r.queue.len(),
                r.dispatch_paused,
                r.authoritative_seq
            )
        };
        let durable = self.agent_runtime.authoritative_session(id).await;
        let facts = durable.as_ref().ok().and_then(|s| s.as_ref()).map(|s| {
            s.events()
                .iter()
                .filter_map(|e| match e.data() {
                    xharness_session::EventData::TurnStart { turn } => {
                        Some(format!("start:{turn}"))
                    }
                    xharness_session::EventData::TurnEnd { turn, reason } => {
                        Some(format!("end:{turn}:{reason:?}"))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>()
        });
        let observed = match self.agent_runtime.observe_session(id).await {
            Ok(crate::runtime::SessionObservation::Idle) => "idle",
            Ok(crate::runtime::SessionObservation::Active(_)) => "active",
            Ok(crate::runtime::SessionObservation::Unsupported) => "unsupported",
            Err(_) => "read_error",
        };
        format!("{host}, observation={observed}, durable_turns={facts:?}")
    }

    pub(crate) async fn spawn_session_task<F>(
        &self,
        session_id: String,
        operation: TaskOperation,
        work: F,
    ) where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        let epoch = if operation == TaskOperation::BackgroundProjection {
            None
        } else {
            self.state
                .read()
                .await
                .sessions
                .get(&session_id)
                .and_then(|s| s.driver_epoch.clone())
        };
        let host = self.clone();
        let completed_host = host.clone();
        let completed_id = session_id.clone();
        let completed_epoch = epoch.clone();
        let observed_work = async move {
            work.await;
            if let Some(epoch) = completed_epoch {
                completed_host
                    .repair_session_driver(completed_id, epoch)
                    .await;
            }
        };
        let _supervisor = spawn_observed(operation, observed_work, move |_failure| async move {
            // Notify independently of the diagnostic sink. Replacement is
            // epoch-fenced and observes existing work; it never replays input.
            host.push_host(json!({
                "type":"host/agent-error", "sessionId":session_id,
                "message":"Conversation worker stopped unexpectedly; the task outcome is unknown. Reload this session before retrying.",
            }));
            if let Some(epoch) = epoch {
                host.repair_session_driver(session_id, epoch).await;
            }
        });
    }
}

#[cfg(test)]
mod task_tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::Duration;

    #[tokio::test]
    async fn broken_stderr_child() {
        let Some(root) = std::env::var_os("XHARNESS_BOUNDARY_TEST_ROOT") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        xharness_diagnostics::install_failure_recorder(&root).unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        let reached = Arc::new(AtomicBool::new(false));
        let callback = reached.clone();
        spawn_observed(
            TaskOperation::SessionDriver,
            async {
                panic!("private fixture panic");
            },
            move |_| async move {
                callback.store(true, Ordering::SeqCst);
            },
        )
        .await
        .unwrap();
        assert!(reached.load(Ordering::SeqCst));
        assert!(xharness_diagnostics::failure_status().stderr_write_failures > 0);
        let records = xharness_diagnostics::Recorder::open(root)
            .unwrap()
            .snapshot()
            .unwrap();
        let encoded = serde_json::to_string(&records).unwrap();
        assert!(encoded.contains("task_panicked"));
        assert!(encoded.contains("stderr_write"));
        assert!(!encoded.contains("private fixture panic"));
        println!("BOUNDARY_REPRO callback_reached=true monitor_panicked=false durable_closed_metadata=true");
    }
    #[test]
    fn broken_stderr_cannot_panic_the_monitor_or_skip_its_callback() {
        use std::process::{Command, Stdio};
        let root = std::env::temp_dir().join(format!(
            "xharness-broken-stderr-{}-{}",
            std::process::id(),
            crate::state::now_ms()
        ));
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "error_boundary::task_tests::broken_stderr_child",
                "--nocapture",
            ])
            .env("XHARNESS_BOUNDARY_TEST_ROOT", &root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        drop(child.stderr.take().unwrap());
        let output = child.wait_with_output().unwrap();
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(output.status.success(), "{stdout}");
        assert!(
            stdout.contains("callback_reached=true monitor_panicked=false"),
            "{stdout}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn child_panic_is_observed_even_when_the_monitor_handle_is_dropped() {
        let (send, receive) = tokio::sync::oneshot::channel();
        drop(spawn_observed(
            TaskOperation::SessionDriver,
            async { panic!("fixture panic") },
            move |failure| async move {
                send.send(failure).expect("receiver alive");
            },
        ));
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), receive)
                .await
                .unwrap()
                .unwrap(),
            TaskFailure::Panicked
        );
    }

    #[tokio::test]
    async fn successful_work_does_not_emit_a_failure() {
        let failed = Arc::new(AtomicBool::new(false));
        let observed = failed.clone();
        spawn_observed(
            TaskOperation::SessionDriver,
            async {},
            move |_| async move {
                observed.store(true, Ordering::SeqCst);
            },
        )
        .await
        .unwrap();
        assert!(!failed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn aborting_the_monitor_also_aborts_its_owned_child() {
        struct Dropped(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                if let Some(send) = self.0.take() {
                    assert!(send.send(()).is_ok());
                }
            }
        }
        let (started, ready) = tokio::sync::oneshot::channel();
        let (dropped, stopped) = tokio::sync::oneshot::channel();
        let task = spawn_observed(
            TaskOperation::SessionDriver,
            async move {
                let _guard = Dropped(Some(dropped));
                started.send(()).unwrap();
                std::future::pending::<()>().await;
            },
            |_| async { panic!("shutdown cancellation must not create a false failure callback") },
        );
        ready.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_secs(2), stopped)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn session_worker_failure_reaches_existing_ui_error_channel_without_fake_idle() {
        use xharness_api::ApiBackend;
        let host = crate::BasicHost::new(
            crate::HostConfig::new(std::env::temp_dir()),
            None,
            Arc::new(crate::NoTools),
        );
        let result = host
            .call(
                RpcId::new("create"),
                xharness_api::RpcMethod::SessionCreate,
                json!({"sessionId":"observed-failure"}),
                tokio_util::sync::CancellationToken::new(),
            )
            .await;
        assert!(matches!(result, RpcResult::Success { .. }));
        let mut frames = host.event_gateway.subscribe_host();
        host.spawn_session_task(
            "observed-failure".into(),
            TaskOperation::SessionDriver,
            async { panic!("fixture panic") },
        )
        .await;
        let frame = tokio::time::timeout(Duration::from_secs(2), frames.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(frame.payload["type"], "host/agent-error");
        assert_eq!(frame.payload["sessionId"], "observed-failure");
        assert!(frame.payload["message"]
            .as_str()
            .unwrap()
            .contains("unknown"));
        assert!(!frame.payload.to_string().contains("fixture panic"));
        assert!(frames.try_recv().is_err()); // no fake host/session-status idle
    }
}

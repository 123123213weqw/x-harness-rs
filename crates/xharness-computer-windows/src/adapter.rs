//! Safe Host side. Each request owns one suspended, Job-contained worker.
use crate::state::State;
use crate::wire::{self, Reply, Request};
use async_trait::async_trait;
use std::{
    path::PathBuf,
    process::Stdio,
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;
use xharness_computer::{
    ComputerAction, ComputerDriver, ComputerError, ComputerOutput, ComputerRequest, Screenshot,
};
use xharness_win32::{
    resume_suspended_process, Job, WINDOWS_CREATE_NO_WINDOW, WINDOWS_CREATE_SUSPENDED,
};

static SERIAL: OnceLock<Mutex<()>> = OnceLock::new();
static NEXT_FRAME: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
const WORKER_LIMIT: Duration = Duration::from_secs(45);

pub struct WindowsComputer {
    executable: PathBuf,
    state: Mutex<State>,
    #[cfg(feature = "native-acceptance")]
    visible_view_experiment: bool,
}
impl WindowsComputer {
    pub fn new() -> Result<Self, ComputerError> {
        Ok(Self::with_worker_executable(
            std::env::current_exe().map_err(|_| {
                ComputerError::unavailable("cannot locate the packaged Host worker")
            })?,
        ))
    }
    /// Dependency injection for a controlled native acceptance fixture; never
    /// exposed in a model schema, RPC or plugin argument.
    pub fn with_worker_executable(executable: PathBuf) -> Self {
        Self {
            executable,
            state: Mutex::new(State::default()),
            #[cfg(feature = "native-acceptance")]
            visible_view_experiment: wire::visible_view_experiment(
                std::env::var("XHARNESS_UIA_VISIBLE_EXPERIMENT")
                    .ok()
                    .as_deref(),
                std::env::var("XHARNESS_DISPOSABLE_COMPUTER_VM")
                    .ok()
                    .as_deref(),
            ),
        }
    }
    async fn exchange(
        &self,
        request: Request,
        token: &CancellationToken,
    ) -> Result<(Reply, Vec<u8>), ComputerError> {
        let may_have_sent_input = !matches!(
            request.request.action,
            ComputerAction::Observe | ComputerAction::Wait
        ) && !(request.request.action == ComputerAction::Window
            && request.request.operation.as_deref() == Some("list"));
        let bytes = serde_json::to_vec(&request)
            .map_err(|_| ComputerError::invalid("cannot encode computer request"))?;
        if bytes.len() > wire::MAX_REQUEST {
            return Err(ComputerError::invalid(
                "computer request exceeds transport budget",
            ));
        }
        let job = Job::new_kill_on_close().map_err(|_| {
            ComputerError::unavailable("cannot create computer worker ownership Job")
        })?;
        let mut command = Command::new(&self.executable);
        command
            .arg("--computer-worker")
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(WINDOWS_CREATE_NO_WINDOW | WINDOWS_CREATE_SUSPENDED)
            .kill_on_drop(true);
        // Freeze the lab-only view in this driver for both observations and
        // input resolution. Never read a mutable view option from tool args.
        #[cfg(feature = "native-acceptance")]
        if self.visible_view_experiment {
            command.arg("--uia-visible-view-experiment");
        }
        for name in [
            "SystemRoot",
            "WINDIR",
            "USERPROFILE",
            "TEMP",
            "TMP",
            "LOCALAPPDATA",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let mut child = command.spawn().map_err(|_| {
            ComputerError::unavailable("cannot launch the packaged computer worker")
        })?;
        let pid = child
            .id()
            .ok_or_else(|| ComputerError::unavailable("computer worker has no process identity"))?;
        if job
            .assign_pid(pid)
            .and_then(|_| resume_suspended_process(pid))
            .is_err()
        {
            let _ = child.kill().await;
            return Err(ComputerError::unavailable(
                "cannot establish computer worker ownership",
            ));
        }
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| ComputerError::unavailable("computer worker input pipe is missing"))?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| ComputerError::unavailable("computer worker output pipe is missing"))?;
        let operation = async {
            stdin.write_all(&(bytes.len() as u32).to_le_bytes()).await?;
            stdin.write_all(&bytes).await?;
            stdin.flush().await?;
            let length = stdout.read_u32_le().await? as usize;
            if length == 0 || length > wire::MAX_METADATA {
                return Err(std::io::Error::other("invalid computer metadata length"));
            }
            let mut metadata = vec![0; length];
            stdout.read_exact(&mut metadata).await?;
            let reply: Reply = serde_json::from_slice(&metadata).map_err(std::io::Error::other)?;
            if reply.schema != 1
                || reply.png_len > wire::MAX_PNG
                || (reply.error.is_some() && reply.png_len != 0)
            {
                return Err(std::io::Error::other("invalid computer reply contract"));
            }
            let mut png = vec![0; reply.png_len];
            stdout.read_exact(&mut png).await?;
            let mut extra = [0];
            if stdout.read(&mut extra).await? != 0 {
                return Err(std::io::Error::other("trailing computer reply data"));
            }
            Ok((reply, png))
        };
        let result = tokio::select! {
            biased;
            _ = token.cancelled() => None,
            _ = tokio::time::sleep(WORKER_LIMIT) => None,
            result = operation => Some(result),
        };
        // EOF tells the native input guard to release held input cooperatively.
        // Hung COM is then killed as a whole process, not an abandoned thread.
        drop(stdin);
        let status = match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
            Ok(status) => status,
            Err(_) => {
                let _ = job.terminate(1);
                let _ = child.start_kill();
                tokio::time::timeout(Duration::from_secs(2), child.wait())
                    .await
                    .unwrap_or_else(|_| {
                        Err(std::io::Error::other(
                            "computer worker did not exit after termination",
                        ))
                    })
            }
        };
        match result {
            Some(Ok(value)) if status.is_ok_and(|s| s.success()) => Ok(value),
            _ => Err(lost_worker_error(may_have_sent_input, token.is_cancelled())),
        }
    }
}

fn lost_worker_error(may_have_sent_input: bool, cancelled: bool) -> ComputerError {
    if may_have_sent_input {
        ComputerError { code: "outcome_unknown".into(), message: "computer worker was cancelled, timed out or lost; observe actual UI state before deciding what to do next; do not automatically replay input".into(), retryable: false }
    } else {
        ComputerError { code: if cancelled { "cancelled" } else { "worker_unavailable" }.into(), message: "read-only computer worker was cancelled, timed out or lost; no input action was dispatched".into(), retryable: !cancelled }
    }
}

#[async_trait]
impl ComputerDriver for WindowsComputer {
    async fn execute(
        &self,
        request: ComputerRequest,
        token: CancellationToken,
    ) -> Result<ComputerOutput, ComputerError> {
        request.validate()?;
        let _serial = tokio::select! {
            biased;
            _ = token.cancelled() => return Err(ComputerError::retryable("cancelled", "computer request cancelled before dispatch")),
            guard = SERIAL.get_or_init(|| Mutex::new(())).lock() => guard,
        };
        let mut state = self.state.lock().await;
        let wire = Request {
            schema: 1,
            request,
            frame: None,
            node: None,
            surface: None,
        };
        // Model/transport latency does not invalidate an observation. Bind only
        // references owned by this driver; the native worker rechecks actual
        // desktop/window geometry and UIA identity immediately before input.
        let wire = state.bind(wire)?;
        let result = self.exchange(wire, &token).await;
        // Any native dispatch consumes the old frame, even if the worker fails.
        *state = State::default();
        let (mut reply, png) = result?;
        if let Some(error) = reply.error {
            return Err(error.into());
        }
        if let Some(frame) = reply.frame.take() {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let id = format!(
                "win:{}:{stamp}:{}",
                std::process::id(),
                NEXT_FRAME.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            );
            reply.value["frame_id"] = serde_json::Value::String(id.clone());
            state.id = Some(id);
            state.frame = Some(frame);
            state.nodes = reply.nodes.into_iter().collect();
            state.surfaces = reply.surfaces.into_iter().collect();
        }
        Ok(ComputerOutput {
            value: reply.value,
            screenshot: (!png.is_empty()).then(|| Screenshot {
                png,
                label: "Windows desktop observation".into(),
            }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lost_input_is_never_automatically_replayed() {
        for cancelled in [false, true] {
            let error = lost_worker_error(true, cancelled);
            assert_eq!(error.code, "outcome_unknown");
            assert!(!error.retryable);
        }
    }
    #[test]
    fn read_only_loss_is_not_a_side_effect_uncertainty() {
        let error = lost_worker_error(false, false);
        assert_eq!(error.code, "worker_unavailable");
        assert!(error.retryable);
        let error = lost_worker_error(false, true);
        assert_eq!(error.code, "cancelled");
        assert!(!error.retryable);
    }
    fn request(value: serde_json::Value) -> ComputerRequest {
        serde_json::from_value(value).unwrap()
    }
    #[tokio::test]
    async fn no_input_before_observation() {
        let driver = WindowsComputer::with_worker_executable(PathBuf::from("does-not-exist.exe"));
        for value in [
            serde_json::json!({"action":"type","text":"must not send"}),
            serde_json::json!({"action":"keypress","keys":["a"]}),
            serde_json::json!({"action":"click","frame_id":"foreign","x":0,"y":0}),
        ] {
            let error = driver
                .execute(request(value), CancellationToken::new())
                .await
                .unwrap_err();
            assert_eq!(error.code, "stale_frame");
        }
    }
    #[tokio::test]
    async fn cancelled_wait_never_starts_a_worker() {
        let driver = WindowsComputer::with_worker_executable(PathBuf::from("does-not-exist.exe"));
        let token = CancellationToken::new();
        token.cancel();
        let error = driver
            .execute(
                request(serde_json::json!({"action":"wait","duration_ms":1})),
                token,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "cancelled");
    }
    #[tokio::test]
    async fn foreign_frame_fails_before_spawn() {
        let driver = WindowsComputer::with_worker_executable(PathBuf::from("does-not-exist.exe"));
        {
            let mut state = driver.state.lock().await;
            state.id = Some("owned".into());
            state.frame = Some(crate::wire::Frame {
                desktop: xharness_computer::Region {
                    x: 0.0,
                    y: 0.0,
                    width: 100.0,
                    height: 100.0,
                },
                foreground: None,
            });
        }
        let error = driver
            .execute(
                request(serde_json::json!({"action":"click","frame_id":"foreign","x":1,"y":1})),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "stale_frame");
        // A pre-dispatch rejection must not consume a valid observation.
        assert_eq!(driver.state.lock().await.id.as_deref(), Some("owned"));
    }
}
